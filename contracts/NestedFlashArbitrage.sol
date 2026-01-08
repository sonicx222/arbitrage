// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./interfaces/IPancakeV2Pair.sol";
import "./interfaces/IERC20.sol";
import "./interfaces/IFlashLoanProviders.sol";

/**
 * @title NestedFlashArbitrage
 * @author Multi-Chain Arbitrage Bot
 * @notice Executes nested flash loan arbitrage across multiple protocols
 * @dev Supports: Balancer (0%), dYdX (0%), Aave V3 (0.09%), PancakeSwap (0.25%)
 *
 * NESTED FLASH LOAN STRATEGY:
 * 1. Borrow asset A from Provider 1 (e.g., Balancer - 0% fee)
 * 2. Swap A for B on DEX
 * 3. Use B to borrow more C from Provider 2 (nested loan)
 * 4. Execute arbitrage with C
 * 5. Repay nested loan (Provider 2)
 * 6. Repay initial loan (Provider 1)
 *
 * SECURITY FEATURES:
 * - Immutable owner (no admin key theft)
 * - Whitelist-only DEX routers and flash loan providers
 * - On-chain profit validation before repayment
 * - Emergency pause and withdraw
 * - Reentrancy protection via callback validation
 * - Nested callback depth tracking
 *
 * MULTI-CHAIN SUPPORT:
 * - Ethereum: dYdX (0%), Balancer (0%), Aave V3 (0.09%)
 * - Polygon/Arbitrum/Base/Optimism: Balancer (0%), Aave V3 (0.09%)
 * - BSC: Aave V3 (0.09%), PancakeSwap (0.25%)
 */
contract NestedFlashArbitrage is
    IPancakeV2Callee,
    IFlashLoanRecipient,
    IFlashLoanSimpleReceiver,
    IFlashLoanReceiver,
    ICallee
{
    // ============ Constants ============

    uint256 private constant FEE_DENOMINATOR = 10000;
    uint256 private constant MAX_NESTED_DEPTH = 3;
    uint256 public constant MIN_PROFIT_WEI = 1e15;

    // ============ Immutable State Variables ============

    address public immutable owner;
    address public immutable wrappedNative;

    // ============ Provider Addresses ============

    address public balancerVault;
    address public aaveV3Pool;
    address public dydxSoloMargin;

    // ============ State Variables ============

    mapping(address => bool) public whitelistedRouters;
    mapping(address => bool) public whitelistedProviders;

    bool public paused;
    uint8 private _callbackDepth;
    address private _currentProvider;

    // Flash loan fee cache (in basis points)
    mapping(address => uint256) public providerFees;

    // ============ Structs ============

    /// @notice Flash loan configuration for a single loan
    struct FlashLoanConfig {
        address provider;      // Flash loan provider address
        address token;         // Token to borrow
        uint256 amount;        // Amount to borrow
        uint8 providerType;    // 0=Balancer, 1=AaveV3, 2=dYdX, 3=PancakeSwap
    }

    /// @notice Nested arbitrage parameters
    struct NestedArbParams {
        FlashLoanConfig[] loans;      // Array of flash loans (outer to inner)
        address[] path;               // Swap path
        address[] routers;            // DEX routers for each swap
        uint256 minProfit;            // Minimum acceptable profit
    }

    /// @notice Execution context passed through callbacks
    struct ExecutionContext {
        uint8 currentLoanIndex;       // Current loan being executed
        uint8 totalLoans;             // Total number of nested loans
        FlashLoanConfig[] loans;      // All loan configurations
        address[] path;               // Swap path
        address[] routers;            // DEX routers
        uint256 minProfit;            // Minimum profit
        uint256[] borrowedAmounts;    // Track borrowed amounts for repayment
    }

    // ============ Events ============

    event NestedArbitrageExecuted(
        address indexed initiator,
        uint8 loanDepth,
        address[] tokens,
        uint256[] amounts,
        uint256 profit
    );

    event ProviderConfigured(address indexed provider, uint8 providerType, uint256 feeBps);
    event RouterWhitelisted(address indexed router, bool status);
    event EmergencyWithdraw(address indexed token, uint256 amount);
    event Paused(bool status);

    // ============ Errors ============

    error Unauthorized();
    error ContractPaused();
    error RouterNotWhitelisted(address router);
    error ProviderNotWhitelisted(address provider);
    error InsufficientProfit(uint256 expected, uint256 actual);
    error InvalidCallback();
    error MaxNestingDepthExceeded();
    error InvalidLoanConfig();
    error InvalidPath();
    error ZeroAmount();
    error UnsupportedProvider(uint8 providerType);

    // ============ Modifiers ============

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    modifier validCallback(address expectedProvider) {
        if (msg.sender != expectedProvider) revert InvalidCallback();
        if (_currentProvider != expectedProvider) revert InvalidCallback();
        _;
    }

    // ============ Constructor ============

    /**
     * @notice Deploy the NestedFlashArbitrage contract
     * @param _routers Initial list of whitelisted DEX routers
     * @param _wrappedNative Wrapped native token address
     * @param _balancerVault Balancer Vault address (or address(0) if not available)
     * @param _aaveV3Pool Aave V3 Pool address (or address(0) if not available)
     * @param _dydxSoloMargin dYdX SoloMargin address (or address(0) if not available)
     */
    constructor(
        address[] memory _routers,
        address _wrappedNative,
        address _balancerVault,
        address _aaveV3Pool,
        address _dydxSoloMargin
    ) {
        require(_wrappedNative != address(0), "Invalid wrapped native");

        owner = msg.sender;
        wrappedNative = _wrappedNative;

        // Configure providers
        if (_balancerVault != address(0)) {
            balancerVault = _balancerVault;
            whitelistedProviders[_balancerVault] = true;
            providerFees[_balancerVault] = 0; // 0% fee
            emit ProviderConfigured(_balancerVault, 0, 0);
        }

        if (_aaveV3Pool != address(0)) {
            aaveV3Pool = _aaveV3Pool;
            whitelistedProviders[_aaveV3Pool] = true;
            providerFees[_aaveV3Pool] = 9; // 0.09% fee
            emit ProviderConfigured(_aaveV3Pool, 1, 9);
        }

        if (_dydxSoloMargin != address(0)) {
            dydxSoloMargin = _dydxSoloMargin;
            whitelistedProviders[_dydxSoloMargin] = true;
            providerFees[_dydxSoloMargin] = 0; // 0% fee
            emit ProviderConfigured(_dydxSoloMargin, 2, 0);
        }

        // Whitelist routers
        for (uint256 i = 0; i < _routers.length; i++) {
            whitelistedRouters[_routers[i]] = true;
            emit RouterWhitelisted(_routers[i], true);
        }
    }

    // ============ Main Entry Points ============

    /**
     * @notice Execute nested flash loan arbitrage
     * @param params Nested arbitrage parameters
     */
    function executeNestedArbitrage(
        NestedArbParams calldata params
    ) external onlyOwner whenNotPaused {
        // Validate inputs
        if (params.loans.length == 0) revert InvalidLoanConfig();
        if (params.loans.length > MAX_NESTED_DEPTH) revert MaxNestingDepthExceeded();
        if (params.path.length < 2) revert InvalidPath();
        if (params.routers.length != params.path.length - 1) revert InvalidPath();

        // Validate all routers
        for (uint256 i = 0; i < params.routers.length; i++) {
            if (!whitelistedRouters[params.routers[i]]) {
                revert RouterNotWhitelisted(params.routers[i]);
            }
        }

        // Validate all providers
        for (uint256 i = 0; i < params.loans.length; i++) {
            if (!whitelistedProviders[params.loans[i].provider]) {
                revert ProviderNotWhitelisted(params.loans[i].provider);
            }
            if (params.loans[i].amount == 0) revert ZeroAmount();
        }

        // Initialize execution context
        uint256[] memory borrowedAmounts = new uint256[](params.loans.length);

        ExecutionContext memory ctx = ExecutionContext({
            currentLoanIndex: 0,
            totalLoans: uint8(params.loans.length),
            loans: params.loans,
            path: params.path,
            routers: params.routers,
            minProfit: params.minProfit,
            borrowedAmounts: borrowedAmounts
        });

        // Encode context for callback
        bytes memory data = abi.encode(ctx);

        // Initiate first flash loan
        _initiateFlashLoan(params.loans[0], data);
    }

    /**
     * @notice Execute single-provider flash loan arbitrage
     * @dev Simplified version for non-nested arbitrage
     */
    function executeSingleFlashLoan(
        FlashLoanConfig calldata loan,
        address[] calldata path,
        address[] calldata routers,
        uint256 minProfit
    ) external onlyOwner whenNotPaused {
        if (!whitelistedProviders[loan.provider]) {
            revert ProviderNotWhitelisted(loan.provider);
        }
        if (loan.amount == 0) revert ZeroAmount();
        if (path.length < 2) revert InvalidPath();
        if (routers.length != path.length - 1) revert InvalidPath();

        for (uint256 i = 0; i < routers.length; i++) {
            if (!whitelistedRouters[routers[i]]) {
                revert RouterNotWhitelisted(routers[i]);
            }
        }

        FlashLoanConfig[] memory loans = new FlashLoanConfig[](1);
        loans[0] = loan;
        uint256[] memory borrowedAmounts = new uint256[](1);

        ExecutionContext memory ctx = ExecutionContext({
            currentLoanIndex: 0,
            totalLoans: 1,
            loans: loans,
            path: path,
            routers: routers,
            minProfit: minProfit,
            borrowedAmounts: borrowedAmounts
        });

        bytes memory data = abi.encode(ctx);
        _initiateFlashLoan(loan, data);
    }

    // ============ Flash Loan Initiation ============

    /**
     * @notice Initiate a flash loan from the specified provider
     * @param loan Flash loan configuration
     * @param data Encoded execution context
     */
    function _initiateFlashLoan(FlashLoanConfig memory loan, bytes memory data) internal {
        _callbackDepth++;
        _currentProvider = loan.provider;

        if (loan.providerType == 0) {
            // Balancer
            address[] memory tokens = new address[](1);
            tokens[0] = loan.token;
            uint256[] memory amounts = new uint256[](1);
            amounts[0] = loan.amount;
            IBalancerVault(loan.provider).flashLoan(address(this), tokens, amounts, data);
        } else if (loan.providerType == 1) {
            // Aave V3
            IAaveV3Pool(loan.provider).flashLoanSimple(
                address(this),
                loan.token,
                loan.amount,
                data,
                0 // referralCode
            );
        } else if (loan.providerType == 2) {
            // dYdX
            _initiateDydxFlashLoan(loan, data);
        } else if (loan.providerType == 3) {
            // PancakeSwap V2 (from pair)
            _initiatePancakeFlashLoan(loan, data);
        } else {
            revert UnsupportedProvider(loan.providerType);
        }
    }

    /**
     * @notice Initiate dYdX flash loan via operate()
     */
    function _initiateDydxFlashLoan(FlashLoanConfig memory loan, bytes memory data) internal {
        ISoloMargin solo = ISoloMargin(loan.provider);
        uint256 marketId = solo.getMarketIdByTokenAddress(loan.token);

        // Account info
        ISoloMargin.AccountInfo[] memory accounts = new ISoloMargin.AccountInfo[](1);
        accounts[0] = ISoloMargin.AccountInfo({
            owner: address(this),
            number: 1
        });

        // Actions: Withdraw → Call → Deposit
        ISoloMargin.ActionArgs[] memory actions = new ISoloMargin.ActionArgs[](3);

        // Action 1: Withdraw (borrow)
        actions[0] = ISoloMargin.ActionArgs({
            actionType: ISoloMargin.ActionType.Withdraw,
            accountId: 0,
            amount: ISoloMargin.AssetAmount({
                sign: false,
                denomination: ISoloMargin.AssetDenomination.Wei,
                ref: ISoloMargin.AssetReference.Delta,
                value: loan.amount
            }),
            primaryMarketId: marketId,
            secondaryMarketId: 0,
            otherAddress: address(this),
            otherAccountId: 0,
            data: ""
        });

        // Action 2: Call (execute callback)
        actions[1] = ISoloMargin.ActionArgs({
            actionType: ISoloMargin.ActionType.Call,
            accountId: 0,
            amount: ISoloMargin.AssetAmount({
                sign: false,
                denomination: ISoloMargin.AssetDenomination.Wei,
                ref: ISoloMargin.AssetReference.Delta,
                value: 0
            }),
            primaryMarketId: 0,
            secondaryMarketId: 0,
            otherAddress: address(this),
            otherAccountId: 0,
            data: data
        });

        // Action 3: Deposit (repay - dYdX requires +2 wei for rounding)
        actions[2] = ISoloMargin.ActionArgs({
            actionType: ISoloMargin.ActionType.Deposit,
            accountId: 0,
            amount: ISoloMargin.AssetAmount({
                sign: true,
                denomination: ISoloMargin.AssetDenomination.Wei,
                ref: ISoloMargin.AssetReference.Delta,
                value: loan.amount + 2
            }),
            primaryMarketId: marketId,
            secondaryMarketId: 0,
            otherAddress: address(this),
            otherAccountId: 0,
            data: ""
        });

        // Approve dYdX to pull repayment
        IERC20(loan.token).approve(loan.provider, loan.amount + 2);

        solo.operate(accounts, actions);
    }

    /**
     * @notice Initiate PancakeSwap V2 flash loan via swap()
     */
    function _initiatePancakeFlashLoan(FlashLoanConfig memory loan, bytes memory data) internal {
        IPancakeV2Pair pair = IPancakeV2Pair(loan.provider);
        address token0 = pair.token0();
        address token1 = pair.token1();

        uint256 amount0Out = loan.token == token0 ? loan.amount : 0;
        uint256 amount1Out = loan.token == token1 ? loan.amount : 0;

        pair.swap(amount0Out, amount1Out, address(this), data);
    }

    // ============ Flash Loan Callbacks ============

    /**
     * @notice Balancer flash loan callback
     */
    function receiveFlashLoan(
        address[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external override validCallback(balancerVault) {
        ExecutionContext memory ctx = abi.decode(userData, (ExecutionContext));
        ctx.borrowedAmounts[ctx.currentLoanIndex] = amounts[0];

        _processCallback(ctx, tokens[0], amounts[0], feeAmounts[0]);

        // Repay Balancer (transfer back to vault)
        uint256 repayAmount = amounts[0] + feeAmounts[0];
        IERC20(tokens[0]).transfer(msg.sender, repayAmount);

        _callbackDepth--;
    }

    /**
     * @notice Aave V3 simple flash loan callback
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override validCallback(aaveV3Pool) returns (bool) {
        if (initiator != address(this)) revert InvalidCallback();

        ExecutionContext memory ctx = abi.decode(params, (ExecutionContext));
        ctx.borrowedAmounts[ctx.currentLoanIndex] = amount;

        _processCallback(ctx, asset, amount, premium);

        // Approve Aave to pull repayment
        uint256 repayAmount = amount + premium;
        IERC20(asset).approve(msg.sender, repayAmount);

        _callbackDepth--;
        return true;
    }

    /**
     * @notice Aave V3 multi-asset flash loan callback (unused but required by interface)
     */
    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    ) external override validCallback(aaveV3Pool) returns (bool) {
        if (initiator != address(this)) revert InvalidCallback();

        ExecutionContext memory ctx = abi.decode(params, (ExecutionContext));

        // For multi-asset, we use the first asset
        ctx.borrowedAmounts[ctx.currentLoanIndex] = amounts[0];
        _processCallback(ctx, assets[0], amounts[0], premiums[0]);

        // Approve Aave to pull all repayments
        for (uint256 i = 0; i < assets.length; i++) {
            uint256 repayAmount = amounts[i] + premiums[i];
            IERC20(assets[i]).approve(msg.sender, repayAmount);
        }

        _callbackDepth--;
        return true;
    }

    /**
     * @notice dYdX flash loan callback
     */
    function callFunction(
        address sender,
        ISoloMargin.AccountInfo calldata accountInfo,
        bytes calldata data
    ) external override validCallback(dydxSoloMargin) {
        if (sender != address(this)) revert InvalidCallback();

        ExecutionContext memory ctx = abi.decode(data, (ExecutionContext));
        FlashLoanConfig memory loan = ctx.loans[ctx.currentLoanIndex];
        ctx.borrowedAmounts[ctx.currentLoanIndex] = loan.amount;

        // dYdX has no fee, repayment handled in operate() action
        _processCallback(ctx, loan.token, loan.amount, 0);

        _callbackDepth--;
    }

    /**
     * @notice PancakeSwap V2 flash loan callback
     */
    function pancakeCall(
        address sender,
        uint256 amount0,
        uint256 amount1,
        bytes calldata data
    ) external override {
        // Validate callback (PancakeSwap doesn't have a fixed provider address)
        if (sender != address(this)) revert InvalidCallback();

        ExecutionContext memory ctx = abi.decode(data, (ExecutionContext));
        FlashLoanConfig memory loan = ctx.loans[ctx.currentLoanIndex];

        // Validate the callback is from the expected pair
        if (msg.sender != loan.provider) revert InvalidCallback();

        uint256 borrowedAmount = amount0 > 0 ? amount0 : amount1;
        ctx.borrowedAmounts[ctx.currentLoanIndex] = borrowedAmount;

        // Calculate repayment with 0.25% fee
        uint256 fee = (borrowedAmount * 25) / FEE_DENOMINATOR + 1;
        _processCallback(ctx, loan.token, borrowedAmount, fee);

        // Repay PancakeSwap
        uint256 repayAmount = borrowedAmount + fee;
        IERC20(loan.token).transfer(msg.sender, repayAmount);

        _callbackDepth--;
    }

    // ============ Core Logic ============

    /**
     * @notice Process callback - execute nested loans or arbitrage
     */
    function _processCallback(
        ExecutionContext memory ctx,
        address borrowedToken,
        uint256 borrowedAmount,
        uint256 fee
    ) internal {
        uint8 nextIndex = ctx.currentLoanIndex + 1;

        if (nextIndex < ctx.totalLoans) {
            // More nested loans to execute
            ctx.currentLoanIndex = nextIndex;
            bytes memory nextData = abi.encode(ctx);
            _initiateFlashLoan(ctx.loans[nextIndex], nextData);
        } else {
            // All loans initiated - execute arbitrage
            _executeArbitrage(ctx);
        }
    }

    /**
     * @notice Execute the arbitrage swaps
     */
    function _executeArbitrage(ExecutionContext memory ctx) internal {
        uint256 currentAmount = IERC20(ctx.path[0]).balanceOf(address(this));

        // Execute all swaps
        for (uint256 i = 0; i < ctx.path.length - 1; i++) {
            currentAmount = _executeSwap(
                ctx.path[i],
                ctx.path[i + 1],
                ctx.routers[i],
                currentAmount
            );
        }

        // Calculate total repayment needed
        uint256 totalRepayment = 0;
        for (uint256 i = 0; i < ctx.totalLoans; i++) {
            FlashLoanConfig memory loan = ctx.loans[i];
            uint256 fee = _calculateFee(loan.provider, loan.amount);
            totalRepayment += loan.amount + fee;
        }

        // Validate profit
        uint256 finalBalance = IERC20(ctx.path[ctx.path.length - 1]).balanceOf(address(this));
        if (finalBalance < totalRepayment + ctx.minProfit) {
            revert InsufficientProfit(totalRepayment + ctx.minProfit, finalBalance);
        }

        // Emit success event
        address[] memory tokens = new address[](ctx.totalLoans);
        uint256[] memory amounts = new uint256[](ctx.totalLoans);
        for (uint256 i = 0; i < ctx.totalLoans; i++) {
            tokens[i] = ctx.loans[i].token;
            amounts[i] = ctx.loans[i].amount;
        }

        emit NestedArbitrageExecuted(
            owner,
            ctx.totalLoans,
            tokens,
            amounts,
            finalBalance - totalRepayment
        );
    }

    /**
     * @notice Execute a single swap
     */
    function _executeSwap(
        address tokenIn,
        address tokenOut,
        address router,
        uint256 amountIn
    ) internal returns (uint256) {
        IERC20(tokenIn).approve(router, amountIn);

        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;

        uint256[] memory amounts = IPancakeV2Router(router).swapExactTokensForTokens(
            amountIn,
            0, // Accept any amount (profit validated at end)
            path,
            address(this),
            block.timestamp + 300
        );

        return amounts[amounts.length - 1];
    }

    /**
     * @notice Calculate flash loan fee for a provider
     */
    function _calculateFee(address provider, uint256 amount) internal view returns (uint256) {
        uint256 feeBps = providerFees[provider];
        if (feeBps == 0) return 0;
        return (amount * feeBps) / FEE_DENOMINATOR + 1;
    }

    // ============ Admin Functions ============

    /**
     * @notice Configure a flash loan provider
     */
    function configureProvider(
        address provider,
        uint8 providerType,
        uint256 feeBps,
        bool whitelisted
    ) external onlyOwner {
        require(provider != address(0), "Invalid provider");
        require(feeBps <= 100, "Fee too high");

        if (providerType == 0) balancerVault = provider;
        else if (providerType == 1) aaveV3Pool = provider;
        else if (providerType == 2) dydxSoloMargin = provider;

        whitelistedProviders[provider] = whitelisted;
        providerFees[provider] = feeBps;
        emit ProviderConfigured(provider, providerType, feeBps);
    }

    /**
     * @notice Whitelist or remove a DEX router
     */
    function setRouterWhitelist(address router, bool status) external onlyOwner {
        whitelistedRouters[router] = status;
        emit RouterWhitelisted(router, status);
    }

    /**
     * @notice Batch whitelist routers
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
     */
    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit Paused(_paused);
    }

    /**
     * @notice Emergency withdraw
     */
    function emergencyWithdraw(address token) external onlyOwner {
        if (token == address(0)) {
            uint256 balance = address(this).balance;
            (bool success, ) = owner.call{value: balance}("");
            require(success, "ETH transfer failed");
            emit EmergencyWithdraw(address(0), balance);
        } else {
            uint256 balance = IERC20(token).balanceOf(address(this));
            IERC20(token).transfer(owner, balance);
            emit EmergencyWithdraw(token, balance);
        }
    }

    // ============ View Functions ============

    /**
     * @notice Check if a provider is whitelisted
     */
    function isProviderWhitelisted(address provider) external view returns (bool) {
        return whitelistedProviders[provider];
    }

    /**
     * @notice Check if a router is whitelisted
     */
    function isRouterWhitelisted(address router) external view returns (bool) {
        return whitelistedRouters[router];
    }

    /**
     * @notice Get provider fee
     */
    function getProviderFee(address provider) external view returns (uint256) {
        return providerFees[provider];
    }

    /**
     * @notice Get configured providers
     */
    function getProviders() external view returns (
        address _balancer,
        address _aaveV3,
        address _dydx
    ) {
        return (balancerVault, aaveV3Pool, dydxSoloMargin);
    }

    // ============ Receive Function ============

    receive() external payable {}
}
