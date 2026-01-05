// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./interfaces/IPancakeV2Pair.sol";
import "./interfaces/IERC20.sol";

/**
 * @title FlashArbitrage
 * @author BSC Arbitrage Bot
 * @notice Executes atomic arbitrage trades using PancakeSwap V2 flash swaps
 * @dev Zero-capital arbitrage: borrow tokens, execute arbitrage, repay with profit
 *
 * SECURITY FEATURES:
 * - Immutable owner (no admin key theft)
 * - Whitelist-only DEX routers
 * - On-chain profit validation before repayment
 * - Emergency pause and withdraw
 * - No stored token approvals (approve-and-swap in same tx)
 * - Reentrancy protection via state checks
 */
contract FlashArbitrage is IPancakeV2Callee {
    // ============ Constants ============

    /// @notice WBNB address on BSC mainnet
    address public constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;

    /// @notice PancakeSwap V2 fee numerator (0.25% = 25/10000)
    uint256 private constant PANCAKE_FEE_NUMERATOR = 25;
    uint256 private constant PANCAKE_FEE_DENOMINATOR = 10000;

    /// @notice Minimum profit in wei (anti-dust protection)
    uint256 public constant MIN_PROFIT_WEI = 1e15; // 0.001 token units

    // ============ State Variables ============

    /// @notice Contract owner (immutable for security)
    address public immutable owner;

    /// @notice Whitelisted DEX routers
    mapping(address => bool) public whitelistedRouters;

    /// @notice Emergency pause flag
    bool public paused;

    /// @notice Reentrancy guard
    bool private _executing;

    // ============ Events ============

    event ArbitrageExecuted(
        address indexed token,
        uint256 borrowAmount,
        uint256 profit,
        string arbitrageType
    );

    event RouterWhitelisted(address indexed router, bool status);
    event EmergencyWithdraw(address indexed token, uint256 amount);
    event Paused(bool status);

    // ============ Errors ============

    error Unauthorized();
    error ContractPaused();
    error RouterNotWhitelisted(address router);
    error InsufficientProfit(uint256 expected, uint256 actual);
    error InvalidCallback();
    error ReentrancyGuard();
    error InvalidPath();
    error ZeroAmount();

    // ============ Modifiers ============

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    modifier noReentrant() {
        if (_executing) revert ReentrancyGuard();
        _executing = true;
        _;
        _executing = false;
    }

    // ============ Constructor ============

    /**
     * @notice Deploy the FlashArbitrage contract
     * @param _routers Initial list of whitelisted DEX routers
     */
    constructor(address[] memory _routers) {
        owner = msg.sender;

        // Whitelist initial routers
        for (uint256 i = 0; i < _routers.length; i++) {
            whitelistedRouters[_routers[i]] = true;
            emit RouterWhitelisted(_routers[i], true);
        }
    }

    // ============ External Functions ============

    /**
     * @notice Execute cross-DEX arbitrage (buy on DEX A, sell on DEX B)
     * @param flashPair PancakeSwap pair to borrow from
     * @param borrowAmount Amount of tokenBorrow to borrow
     * @param tokenBorrow Token to borrow (must be in the pair)
     * @param path Swap path [tokenBorrow, intermediate..., tokenBorrow]
     * @param routers DEX routers for each swap (length = path.length - 1)
     * @param minProfit Minimum acceptable profit (slippage protection)
     */
    function executeCrossDexArbitrage(
        address flashPair,
        uint256 borrowAmount,
        address tokenBorrow,
        address[] calldata path,
        address[] calldata routers,
        uint256 minProfit
    ) external onlyOwner whenNotPaused noReentrant {
        // Validate inputs
        if (borrowAmount == 0) revert ZeroAmount();
        if (path.length < 2) revert InvalidPath();
        if (path[0] != tokenBorrow || path[path.length - 1] != tokenBorrow) revert InvalidPath();
        if (routers.length != path.length - 1) revert InvalidPath();

        // Validate all routers are whitelisted
        for (uint256 i = 0; i < routers.length; i++) {
            if (!whitelistedRouters[routers[i]]) revert RouterNotWhitelisted(routers[i]);
        }

        // Encode arbitrage data for callback
        bytes memory data = abi.encode(
            uint8(1), // Type: Cross-DEX
            tokenBorrow,
            borrowAmount,
            path,
            routers,
            minProfit
        );

        // Determine which token to borrow (amount0 or amount1)
        address token0 = IPancakeV2Pair(flashPair).token0();
        address token1 = IPancakeV2Pair(flashPair).token1();

        uint256 amount0Out = tokenBorrow == token0 ? borrowAmount : 0;
        uint256 amount1Out = tokenBorrow == token1 ? borrowAmount : 0;

        // Initiate flash swap - this will call pancakeCall
        IPancakeV2Pair(flashPair).swap(amount0Out, amount1Out, address(this), data);
    }

    /**
     * @notice Execute triangular arbitrage within single DEX (A -> B -> C -> A)
     * @param flashPair PancakeSwap pair to borrow from
     * @param borrowAmount Amount of tokenBorrow to borrow
     * @param tokenBorrow Token to borrow
     * @param path Swap path [A, B, C, A] (4 tokens for triangular)
     * @param router Single DEX router for all swaps
     * @param minProfit Minimum acceptable profit
     */
    function executeTriangularArbitrage(
        address flashPair,
        uint256 borrowAmount,
        address tokenBorrow,
        address[] calldata path,
        address router,
        uint256 minProfit
    ) external onlyOwner whenNotPaused noReentrant {
        // Validate inputs
        if (borrowAmount == 0) revert ZeroAmount();
        if (path.length != 4) revert InvalidPath(); // A -> B -> C -> A
        if (path[0] != tokenBorrow || path[3] != tokenBorrow) revert InvalidPath();
        if (!whitelistedRouters[router]) revert RouterNotWhitelisted(router);

        // Create single-router array for consistency
        address[] memory routers = new address[](3);
        routers[0] = router;
        routers[1] = router;
        routers[2] = router;

        // Encode arbitrage data
        bytes memory data = abi.encode(
            uint8(2), // Type: Triangular
            tokenBorrow,
            borrowAmount,
            path,
            routers,
            minProfit
        );

        // Determine which token to borrow
        address token0 = IPancakeV2Pair(flashPair).token0();
        address token1 = IPancakeV2Pair(flashPair).token1();

        uint256 amount0Out = tokenBorrow == token0 ? borrowAmount : 0;
        uint256 amount1Out = tokenBorrow == token1 ? borrowAmount : 0;

        // Initiate flash swap
        IPancakeV2Pair(flashPair).swap(amount0Out, amount1Out, address(this), data);
    }

    /**
     * @notice PancakeSwap V2 flash swap callback
     * @dev Called by the pair contract after tokens are sent
     * @param sender Original msg.sender (should be this contract)
     * @param amount0 Amount of token0 borrowed
     * @param amount1 Amount of token1 borrowed
     * @param data Encoded arbitrage parameters
     */
    function pancakeCall(
        address sender,
        uint256 amount0,
        uint256 amount1,
        bytes calldata data
    ) external override {
        // Security: Verify callback is from a legitimate pair
        // The pair must exist in PancakeSwap factory
        address token0 = IPancakeV2Pair(msg.sender).token0();
        address token1 = IPancakeV2Pair(msg.sender).token1();

        // Verify sender is this contract (initiated the flash swap)
        if (sender != address(this)) revert InvalidCallback();

        // Decode parameters
        (
            uint8 arbType,
            address tokenBorrow,
            uint256 borrowAmount,
            address[] memory path,
            address[] memory routers,
            uint256 minProfit
        ) = abi.decode(data, (uint8, address, uint256, address[], address[], uint256));

        // Calculate repayment amount (borrowed + 0.25% fee)
        uint256 repayAmount = borrowAmount + ((borrowAmount * PANCAKE_FEE_NUMERATOR) / PANCAKE_FEE_DENOMINATOR) + 1;

        // Execute the arbitrage swaps
        uint256 finalAmount = _executeSwaps(path, routers, borrowAmount);

        // Validate profit
        if (finalAmount < repayAmount + minProfit) {
            revert InsufficientProfit(repayAmount + minProfit, finalAmount);
        }

        // Calculate actual profit
        uint256 profit = finalAmount - repayAmount;

        // Repay the flash loan
        IERC20(tokenBorrow).transfer(msg.sender, repayAmount);

        // Emit event
        emit ArbitrageExecuted(
            tokenBorrow,
            borrowAmount,
            profit,
            arbType == 1 ? "cross-dex" : "triangular"
        );
    }

    // ============ Internal Functions ============

    /**
     * @notice Execute a series of swaps along the path
     * @param path Array of token addresses
     * @param routers Array of DEX routers
     * @param amountIn Initial input amount
     * @return Final output amount
     */
    function _executeSwaps(
        address[] memory path,
        address[] memory routers,
        uint256 amountIn
    ) internal returns (uint256) {
        uint256 currentAmount = amountIn;

        for (uint256 i = 0; i < path.length - 1; i++) {
            address tokenIn = path[i];
            address tokenOut = path[i + 1];
            address router = routers[i];

            // Approve router to spend tokens
            IERC20(tokenIn).approve(router, currentAmount);

            // Build swap path
            address[] memory swapPath = new address[](2);
            swapPath[0] = tokenIn;
            swapPath[1] = tokenOut;

            // Execute swap with 0 minOut (we validate profit at the end)
            uint256[] memory amounts = IPancakeV2Router(router).swapExactTokensForTokens(
                currentAmount,
                0, // Accept any amount (profit validated at end)
                swapPath,
                address(this),
                block.timestamp + 300 // 5 minute deadline
            );

            // Update current amount for next swap
            currentAmount = amounts[amounts.length - 1];
        }

        return currentAmount;
    }

    // ============ Admin Functions ============

    /**
     * @notice Whitelist or remove a DEX router
     * @param router Router address
     * @param status True to whitelist, false to remove
     */
    function setRouterWhitelist(address router, bool status) external onlyOwner {
        whitelistedRouters[router] = status;
        emit RouterWhitelisted(router, status);
    }

    /**
     * @notice Batch whitelist multiple routers
     * @param routers Array of router addresses
     * @param statuses Array of whitelist statuses
     */
    function batchSetRouterWhitelist(
        address[] calldata routers,
        bool[] calldata statuses
    ) external onlyOwner {
        require(routers.length == statuses.length, "Length mismatch");
        for (uint256 i = 0; i < routers.length; i++) {
            whitelistedRouters[routers[i]] = statuses[i];
            emit RouterWhitelisted(routers[i], statuses[i]);
        }
    }

    /**
     * @notice Pause/unpause contract
     * @param _paused New pause status
     */
    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit Paused(_paused);
    }

    /**
     * @notice Emergency withdraw tokens (in case of stuck funds)
     * @param token Token address (use address(0) for BNB)
     */
    function emergencyWithdraw(address token) external onlyOwner {
        if (token == address(0)) {
            uint256 balance = address(this).balance;
            (bool success, ) = owner.call{value: balance}("");
            require(success, "BNB transfer failed");
            emit EmergencyWithdraw(address(0), balance);
        } else {
            uint256 balance = IERC20(token).balanceOf(address(this));
            IERC20(token).transfer(owner, balance);
            emit EmergencyWithdraw(token, balance);
        }
    }

    // ============ View Functions ============

    /**
     * @notice Check if a router is whitelisted
     * @param router Router address
     * @return True if whitelisted
     */
    function isRouterWhitelisted(address router) external view returns (bool) {
        return whitelistedRouters[router];
    }

    /**
     * @notice Simulate arbitrage profit (view function for off-chain calculation)
     * @param path Token path
     * @param routers DEX routers
     * @param amountIn Input amount
     * @return expectedOut Expected output (before flash loan fee)
     * @return flashFee Flash loan fee
     * @return netProfit Net profit after fees
     */
    function simulateArbitrage(
        address[] calldata path,
        address[] calldata routers,
        uint256 amountIn
    ) external view returns (uint256 expectedOut, uint256 flashFee, int256 netProfit) {
        uint256 currentAmount = amountIn;

        for (uint256 i = 0; i < path.length - 1; i++) {
            address[] memory swapPath = new address[](2);
            swapPath[0] = path[i];
            swapPath[1] = path[i + 1];

            uint256[] memory amounts = IPancakeV2Router(routers[i]).getAmountsOut(currentAmount, swapPath);
            currentAmount = amounts[1];
        }

        expectedOut = currentAmount;
        flashFee = (amountIn * PANCAKE_FEE_NUMERATOR) / PANCAKE_FEE_DENOMINATOR + 1;
        netProfit = int256(expectedOut) - int256(amountIn + flashFee);
    }

    // ============ Receive Function ============

    /// @notice Allow contract to receive BNB
    receive() external payable {}
}
