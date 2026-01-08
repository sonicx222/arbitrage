// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title IBalancerVault
 * @notice Interface for Balancer V2 Vault flash loans (0% fee)
 * @dev Balancer Vault address is the same on all chains: 0xBA12222222228d8Ba445958a75a0704d566BF2C8
 */
interface IBalancerVault {
    /**
     * @notice Execute a flash loan
     * @param recipient Contract receiving the tokens (must implement IFlashLoanRecipient)
     * @param tokens Array of token addresses to borrow
     * @param amounts Array of amounts to borrow
     * @param userData Arbitrary data passed to recipient
     */
    function flashLoan(
        address recipient,
        address[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external;
}

/**
 * @title IFlashLoanRecipient
 * @notice Interface that must be implemented to receive Balancer flash loans
 */
interface IFlashLoanRecipient {
    /**
     * @notice Called by Balancer Vault during flash loan
     * @param tokens Array of borrowed tokens
     * @param amounts Array of borrowed amounts
     * @param feeAmounts Array of fees (0 for Balancer)
     * @param userData User-provided data
     */
    function receiveFlashLoan(
        address[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external;
}

/**
 * @title IAaveV3Pool
 * @notice Interface for Aave V3 Pool flash loans (0.09% fee)
 */
interface IAaveV3Pool {
    /**
     * @notice Execute a simple flash loan (single asset)
     * @param receiverAddress Contract receiving the loan
     * @param asset Token to borrow
     * @param amount Amount to borrow
     * @param params Arbitrary data passed to receiver
     * @param referralCode Referral code (use 0)
     */
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;

    /**
     * @notice Execute a flash loan (multiple assets)
     * @param receiverAddress Contract receiving the loan
     * @param assets Array of tokens to borrow
     * @param amounts Array of amounts to borrow
     * @param interestRateModes Array of interest rate modes (0 = no debt)
     * @param onBehalfOf Address to receive debt (address(0) for flash loan)
     * @param params Arbitrary data passed to receiver
     * @param referralCode Referral code (use 0)
     */
    function flashLoan(
        address receiverAddress,
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata interestRateModes,
        address onBehalfOf,
        bytes calldata params,
        uint16 referralCode
    ) external;

    /// @notice Returns the fee percentage for flash loans (in basis points, 9 = 0.09%)
    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);
}

/**
 * @title IFlashLoanSimpleReceiver
 * @notice Interface for Aave V3 simple flash loan receiver
 */
interface IFlashLoanSimpleReceiver {
    /**
     * @notice Called by Aave V3 Pool during simple flash loan
     * @param asset Token borrowed
     * @param amount Amount borrowed
     * @param premium Fee amount
     * @param initiator Address that initiated the flash loan
     * @param params User-provided data
     * @return True if execution succeeded
     */
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

/**
 * @title IFlashLoanReceiver
 * @notice Interface for Aave V3 multi-asset flash loan receiver
 */
interface IFlashLoanReceiver {
    /**
     * @notice Called by Aave V3 Pool during multi-asset flash loan
     * @param assets Array of tokens borrowed
     * @param amounts Array of amounts borrowed
     * @param premiums Array of fee amounts
     * @param initiator Address that initiated the flash loan
     * @param params User-provided data
     * @return True if execution succeeded
     */
    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

/**
 * @title ISoloMargin
 * @notice Interface for dYdX SoloMargin flash loans (0% fee, Ethereum mainnet only)
 * @dev dYdX uses an operate() pattern with actions: Withdraw → Call → Deposit
 */
interface ISoloMargin {
    struct AccountInfo {
        address owner;
        uint256 number;
    }

    struct ActionArgs {
        ActionType actionType;
        uint256 accountId;
        AssetAmount amount;
        uint256 primaryMarketId;
        uint256 secondaryMarketId;
        address otherAddress;
        uint256 otherAccountId;
        bytes data;
    }

    struct AssetAmount {
        bool sign;
        AssetDenomination denomination;
        AssetReference ref;
        uint256 value;
    }

    enum ActionType {
        Deposit,    // 0
        Withdraw,   // 1
        Transfer,   // 2
        Buy,        // 3
        Sell,       // 4
        Trade,      // 5
        Liquidate,  // 6
        Vaporize,   // 7
        Call        // 8
    }

    enum AssetDenomination {
        Wei,
        Par
    }

    enum AssetReference {
        Delta,
        Target
    }

    /**
     * @notice Execute a series of actions on accounts
     * @param accounts Array of accounts to operate on
     * @param actions Array of actions to execute
     */
    function operate(
        AccountInfo[] calldata accounts,
        ActionArgs[] calldata actions
    ) external;

    /**
     * @notice Get market ID for a token
     * @param token Token address
     * @return Market ID (0 = WETH, 2 = USDC, 3 = DAI)
     */
    function getMarketIdByTokenAddress(address token) external view returns (uint256);

    /**
     * @notice Get token address for a market ID
     * @param marketId Market ID
     * @return Token address
     */
    function getMarketTokenAddress(uint256 marketId) external view returns (address);
}

/**
 * @title ICallee
 * @notice Interface for dYdX flash loan callback
 */
interface ICallee {
    /**
     * @notice Called by dYdX SoloMargin during flash loan
     * @param sender Address that initiated the flash loan
     * @param accountInfo Account information
     * @param data User-provided data
     */
    function callFunction(
        address sender,
        ISoloMargin.AccountInfo calldata accountInfo,
        bytes calldata data
    ) external;
}
