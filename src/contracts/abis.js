/**
 * Minimal ABIs for interacting with DEX smart contracts
 * These are human-readable format strings used by ethers.js
 */

// ============ Core DEX ABIs ============

// Uniswap V2 Pair ABI (PancakeSwap and Biswap use the same interface)
export const PAIR_ABI = [
    'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
    'function token0() external view returns (address)',
    'function token1() external view returns (address)',
    'function totalSupply() external view returns (uint256)',
];

// Extended Pair ABI with flash swap support
export const PAIR_FLASH_ABI = [
    ...PAIR_ABI,
    'function swap(uint amount0Out, uint amount1Out, address to, bytes calldata data) external',
    'function factory() external view returns (address)',
];

// Uniswap V2 Factory ABI
export const FACTORY_ABI = [
    'function getPair(address tokenA, address tokenB) external view returns (address pair)',
    'function allPairs(uint) external view returns (address pair)',
    'function allPairsLength() external view returns (uint)',
];

// Uniswap V2 Router ABI (for future trade execution)
export const ROUTER_ABI = [
    'function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)',
    'function getAmountsIn(uint amountOut, address[] memory path) public view returns (uint[] memory amounts)',
    'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
];

// Extended Router ABI with additional functions
export const ROUTER_FULL_ABI = [
    ...ROUTER_ABI,
    'function factory() external pure returns (address)',
    'function WETH() external pure returns (address)',
    'function swapTokensForExactTokens(uint amountOut, uint amountInMax, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
    'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
    'function swapTokensForExactETH(uint amountOut, uint amountInMax, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
    'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
    'function swapETHForExactTokens(uint amountOut, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
];

// ERC20 Token ABI
export const ERC20_ABI = [
    'function decimals() external view returns (uint8)',
    'function symbol() external view returns (string)',
    'function name() external view returns (string)',
    'function balanceOf(address account) external view returns (uint256)',
    'function approve(address spender, uint256 amount) external returns (bool)',
    'function allowance(address owner, address spender) external view returns (uint256)',
    'function transfer(address to, uint256 amount) external returns (bool)',
    'function transferFrom(address from, address to, uint256 amount) external returns (bool)',
];

// Multicall ABI (for batching multiple calls)
export const MULTICALL_ABI = [
    'function aggregate(tuple(address target, bytes callData)[] calls) view returns (uint256 blockNumber, bytes[] returnData)',
    'function tryAggregate(bool requireSuccess, tuple(address target, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)'
];

// ============ Flash Arbitrage Contract ABI ============

export const FLASH_ARBITRAGE_ABI = [
    // Execution functions
    'function executeCrossDexArbitrage(address flashPair, uint256 borrowAmount, address tokenBorrow, address[] calldata path, address[] calldata routers, uint256 minProfit) external',
    'function executeTriangularArbitrage(address flashPair, uint256 borrowAmount, address tokenBorrow, address[] calldata path, address router, uint256 minProfit) external',

    // View functions
    'function simulateArbitrage(address[] calldata path, address[] calldata routers, uint256 amountIn) external view returns (uint256 expectedOut, uint256 flashFee, int256 netProfit)',
    'function isRouterWhitelisted(address router) external view returns (bool)',
    'function owner() external view returns (address)',
    'function paused() external view returns (bool)',
    'function whitelistedRouters(address) external view returns (bool)',

    // Admin functions
    'function setRouterWhitelist(address router, bool status) external',
    'function batchSetRouterWhitelist(address[] calldata routers, bool[] calldata statuses) external',
    'function setPaused(bool _paused) external',
    'function emergencyWithdraw(address token) external',

    // Events
    'event ArbitrageExecuted(address indexed token, uint256 borrowAmount, uint256 profit, string arbitrageType)',
    'event RouterWhitelisted(address indexed router, bool status)',
    'event EmergencyWithdraw(address indexed token, uint256 amount)',
    'event Paused(bool status)',
];

// ============ Contract Addresses ============

// Multicall3 Contract (same address on all EVM chains)
export const MULTICALL_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

// Wrapped Native Token Addresses by Chain ID
export const WRAPPED_NATIVE_ADDRESSES = {
    1: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',     // Ethereum - WETH
    56: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',    // BSC - WBNB
    137: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',   // Polygon - WMATIC
    42161: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // Arbitrum - WETH
    8453: '0x4200000000000000000000000000000000000006',  // Base - WETH
    43114: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', // Avalanche - WAVAX
};

// Helper function to get wrapped native token address for a chain
export function getWrappedNativeAddress(chainId) {
    return WRAPPED_NATIVE_ADDRESSES[chainId] || WRAPPED_NATIVE_ADDRESSES[56];
}

// WBNB Address (DEPRECATED: Use WRAPPED_NATIVE_ADDRESSES[56] or getWrappedNativeAddress(chainId) instead)
export const WBNB_ADDRESS = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';

// PancakeSwap V2 Factory (BSC only)
export const PANCAKE_FACTORY_ADDRESS = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73';

// Flash loan fee constants
export const FLASH_LOAN_FEE = {
    PANCAKE_V2: 0.0025, // 0.25%
    PANCAKE_V3: 0.0001, // 0.01%
};

// ============ Uniswap V3 ABIs ============

// Uniswap V3 Pool ABI for price fetching
export const V3_POOL_ABI = [
    'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
    'function liquidity() external view returns (uint128)',
    'function token0() external view returns (address)',
    'function token1() external view returns (address)',
    'function fee() external view returns (uint24)',
    'function tickSpacing() external view returns (int24)',
];

// Uniswap V3 Factory ABI
export const V3_FACTORY_ABI = [
    'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
    'function feeAmountTickSpacing(uint24 fee) external view returns (int24)',
];

// Uniswap V3 Quoter ABI (for accurate output quotes)
export const V3_QUOTER_ABI = [
    'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)',
    'function quoteExactInput(bytes memory path, uint256 amountIn) external returns (uint256 amountOut)',
];

// V3 Fee tiers (in basis points / 100)
export const V3_FEE_TIERS = {
    LOWEST: 100,   // 0.01% - Stablecoin pairs
    LOW: 500,      // 0.05% - Stable pairs
    MEDIUM: 3000,  // 0.30% - Most pairs
    HIGH: 10000,   // 1.00% - Exotic pairs
};

// V3 Factory addresses by chain
export const V3_FACTORY_ADDRESSES = {
    1: '0x1F98431c8aD98523631AE4a59f267346ea31F984',      // Ethereum - Uniswap V3
    56: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',     // BSC - PancakeSwap V3
    137: '0x1F98431c8aD98523631AE4a59f267346ea31F984',    // Polygon - Uniswap V3
    42161: '0x1F98431c8aD98523631AE4a59f267346ea31F984',  // Arbitrum - Uniswap V3
    8453: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',   // Base - Uniswap V3
    43114: '0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD',  // Avalanche - Uniswap V3
};

// ============ Flash Loan Provider ABIs ============

/**
 * Balancer V2 Vault ABI for flash loans
 * 0% fee flash loans across multiple chains
 * Vault address is the same on all supported chains: 0xBA12222222228d8Ba445958a75a0704d566BF2C8
 */
export const BALANCER_VAULT_ABI = [
    // Flash loan function - borrows tokens and calls receiveFlashLoan on recipient
    'function flashLoan(address recipient, address[] memory tokens, uint256[] memory amounts, bytes memory userData) external',

    // View functions for pool information
    'function getPool(bytes32 poolId) external view returns (address, uint8)',
    'function getPoolTokens(bytes32 poolId) external view returns (address[] memory tokens, uint256[] memory balances, uint256 lastChangeBlock)',

    // Protocol fees
    'function getProtocolFeesCollector() external view returns (address)',

    // Events
    'event FlashLoan(address indexed recipient, address indexed token, uint256 amount, uint256 feeAmount)',
];

/**
 * Balancer Flash Loan Recipient interface
 * Your contract must implement this to receive flash loans
 */
export const BALANCER_FLASH_LOAN_RECIPIENT_ABI = [
    'function receiveFlashLoan(address[] memory tokens, uint256[] memory amounts, uint256[] memory feeAmounts, bytes memory userData) external',
];

/**
 * Balancer Vault addresses by chain
 * Same address on all supported chains (canonical deployment)
 */
export const BALANCER_VAULT_ADDRESSES = {
    1: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',      // Ethereum
    137: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',    // Polygon
    42161: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',  // Arbitrum
    10: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',     // Optimism
    8453: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',   // Base
    43114: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',  // Avalanche
    100: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',    // Gnosis
};

/**
 * dYdX SoloMargin ABI for flash loans (Ethereum mainnet only)
 * 0% fee flash loans but limited to WETH, USDC, DAI
 *
 * dYdX uses a unique "operate" pattern where you:
 * 1. Withdraw (borrow) tokens
 * 2. Execute your callback
 * 3. Deposit (repay) tokens
 * All in a single atomic transaction
 */
export const DYDX_SOLO_MARGIN_ABI = [
    // Main operation function for flash loans
    'function operate(tuple(address owner, uint256 number)[] memory accounts, tuple(uint8 actionType, uint256 accountId, tuple(bool sign, uint8 denomination, uint8 ref, uint256 value) amount, uint256 primaryMarketId, uint256 secondaryMarketId, address otherAddress, uint256 otherAccountId, bytes data)[] memory actions) external',

    // View functions
    'function getMarketTokenAddress(uint256 marketId) external view returns (address)',
    'function getNumMarkets() external view returns (uint256)',
    'function getMarketTotalPar(uint256 marketId) external view returns (tuple(uint128 borrow, uint128 supply))',
    'function getAccountWei(tuple(address owner, uint256 number) memory account, uint256 marketId) external view returns (tuple(bool sign, uint256 value))',

    // Events
    'event LogOperation(address indexed sender)',
];

/**
 * dYdX Callee interface for flash loan callback
 */
export const DYDX_CALLEE_ABI = [
    'function callFunction(address sender, tuple(address owner, uint256 number) memory account, bytes memory data) external',
];

/**
 * dYdX contract addresses (Ethereum mainnet only)
 */
export const DYDX_ADDRESSES = {
    soloMargin: '0x1E0447b19BB6EcFdAe1e4AE1694b0C3659614e4e',
    // Market IDs for supported tokens
    markets: {
        WETH: 0,
        USDC: 2,
        DAI: 3,
    },
};

/**
 * dYdX Action Types for operate() function
 */
export const DYDX_ACTION_TYPES = {
    Deposit: 0,
    Withdraw: 1,
    Transfer: 2,
    Buy: 3,
    Sell: 4,
    Trade: 5,
    Liquidate: 6,
    Vaporize: 7,
    Call: 8,  // Used for flash loan callback
};

/**
 * Aave V3 Pool ABI for flash loans
 * 0.09% fee (was 0.09%, reduced in some deployments)
 */
export const AAVE_V3_POOL_ABI = [
    // Simple flash loan (single asset)
    'function flashLoanSimple(address receiverAddress, address asset, uint256 amount, bytes calldata params, uint16 referralCode) external',

    // Multi-asset flash loan
    'function flashLoan(address receiverAddress, address[] calldata assets, uint256[] calldata amounts, uint256[] calldata interestRateModes, address onBehalfOf, bytes calldata params, uint16 referralCode) external',

    // View functions
    'function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128)',
    'function getReserveData(address asset) external view returns (tuple(uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))',

    // Events
    'event FlashLoan(address indexed target, address initiator, address indexed asset, uint256 amount, uint8 interestRateMode, uint256 premium, uint16 indexed referralCode)',
];

/**
 * Aave Flash Loan Receiver interface
 */
export const AAVE_FLASH_LOAN_RECEIVER_ABI = [
    'function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params) external returns (bool)',
    'function executeOperation(address[] calldata assets, uint256[] calldata amounts, uint256[] calldata premiums, address initiator, bytes calldata params) external returns (bool)',
];

/**
 * Aave V3 Pool addresses by chain
 */
export const AAVE_V3_POOL_ADDRESSES = {
    1: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',      // Ethereum
    137: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',    // Polygon
    42161: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',  // Arbitrum
    10: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',     // Optimism
    8453: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',   // Base
    43114: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',  // Avalanche
    56: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB',     // BSC
};

/**
 * Flash loan fee constants by provider
 */
export const FLASH_LOAN_FEES = {
    DYDX: 0,           // 0% (Ethereum only)
    BALANCER: 0,       // 0% (multi-chain)
    AAVE_V3: 0.0009,   // 0.09%
    PANCAKE_V2: 0.0025, // 0.25%
    UNISWAP_V2: 0.003,  // 0.3%
};

// ============ Curve Finance ABIs ============

/**
 * Curve StableSwap Pool ABI (3pool, stETH, etc.)
 * Used for stable-to-stable and LSD swaps with very low slippage
 *
 * Key concept: Curve uses an "A" amplification coefficient that determines
 * how concentrated liquidity is around the peg (higher A = tighter curve)
 */
export const CURVE_POOL_ABI = [
    // View functions for price and reserves
    'function get_dy(int128 i, int128 j, uint256 dx) external view returns (uint256)',
    'function get_dy_underlying(int128 i, int128 j, uint256 dx) external view returns (uint256)',
    'function get_virtual_price() external view returns (uint256)',
    'function balances(uint256 i) external view returns (uint256)',
    'function coins(uint256 i) external view returns (address)',
    'function A() external view returns (uint256)',
    'function fee() external view returns (uint256)', // Fee in 1e10 (0.04% = 4000000)
    'function admin_fee() external view returns (uint256)',

    // Swap functions
    'function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) external returns (uint256)',
    'function exchange_underlying(int128 i, int128 j, uint256 dx, uint256 min_dy) external returns (uint256)',

    // Pool info
    'function N_COINS() external view returns (uint256)',

    // Events
    'event TokenExchange(address indexed buyer, int128 sold_id, uint256 tokens_sold, int128 bought_id, uint256 tokens_bought)',
    'event TokenExchangeUnderlying(address indexed buyer, int128 sold_id, uint256 tokens_sold, int128 bought_id, uint256 tokens_bought)',
];

/**
 * Curve Meta Pool ABI (pools that use another pool as base)
 * Example: FRAX/3CRV where 3CRV is the base pool token
 */
export const CURVE_META_POOL_ABI = [
    ...CURVE_POOL_ABI,
    'function base_pool() external view returns (address)',
    'function base_virtual_price() external view returns (uint256)',
    'function base_coins(uint256 i) external view returns (address)',
];

/**
 * Curve Registry ABI - For discovering pools
 */
export const CURVE_REGISTRY_ABI = [
    'function pool_count() external view returns (uint256)',
    'function pool_list(uint256 i) external view returns (address)',
    'function get_pool_from_lp_token(address lp) external view returns (address)',
    'function get_lp_token(address pool) external view returns (address)',
    'function get_coins(address pool) external view returns (address[8])',
    'function get_underlying_coins(address pool) external view returns (address[8])',
    'function get_decimals(address pool) external view returns (uint256[8])',
    'function get_balances(address pool) external view returns (uint256[8])',
    'function get_virtual_price_from_lp_token(address lp) external view returns (uint256)',
    'function get_A(address pool) external view returns (uint256)',
    'function get_fees(address pool) external view returns (uint256[2])',
    'function find_pool_for_coins(address from, address to) external view returns (address)',
    'function find_pool_for_coins(address from, address to, uint256 i) external view returns (address)',
];

/**
 * Curve Address Provider - Entry point to find other Curve contracts
 */
export const CURVE_ADDRESS_PROVIDER_ABI = [
    'function get_registry() external view returns (address)',
    'function get_address(uint256 id) external view returns (address)',
    'function max_id() external view returns (uint256)',
];

/**
 * Curve Pool Addresses by chain
 * Key pools for arbitrage: 3pool (stables), stETH (ETH/stETH), tricrypto (ETH/BTC/USDT)
 */
export const CURVE_POOL_ADDRESSES = {
    // Ethereum Mainnet
    1: {
        // Main StableSwap pools
        '3pool': '0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7',        // DAI/USDC/USDT
        'steth': '0xDC24316b9AE028F1497c275EB9192a3Ea0f67022',        // ETH/stETH
        'frax': '0xd632f22692FaC7611d2AA1C0D552930D43CAEd3B',         // FRAX/3CRV
        'lusd': '0xEd279fDD11cA84bEef15AF5D39BB4d4bEE23F0cA',         // LUSD/3CRV
        'susd': '0xA5407eAE9Ba41422680e2e00537571bcC53efBfD',         // sUSD/DAI/USDC/USDT
        'tricrypto2': '0xD51a44d3FaE010294C616388b506AcdA1bfAAE46',   // USDT/WBTC/WETH
        'reth': '0x0f3159811670c117c372428D4E69AC32325e4D0F',         // rETH/wstETH
        'cbeth': '0x5FAE7E604FC3e24fd43A72867ceBaC94c65b404A',        // cbETH/ETH
        'frxeth': '0xa1F8A6807c402E4A15ef4EBa36528A3FED24E577',       // frxETH/ETH
    },
    // Arbitrum
    42161: {
        '2pool': '0x7f90122BF0700F9E7e1F688fe926940E8839F353',        // USDC/USDT
        'tricrypto': '0x960ea3e3C7FB317332d990873d354E18d7645590',    // USDT/WBTC/WETH
        'frax': '0xC9B8a3FDECB9D5b218d02555a8Baf332E5B740d5',         // FRAX/2CRV
        'wsteth': '0x6eB2dc694eB516B16Dc9FBc678C60052BbD7d8eF',       // wstETH/ETH
    },
    // Polygon
    137: {
        'aave': '0x445FE580eF8d70FF569aB36e80c647af338db351',         // DAI/USDC/USDT (aave tokens)
        'atricrypto3': '0x92215849c439E1f8612b6646060B4E3E5ef822cC',  // USDT/WBTC/WETH
        'stmatic': '0xFb6FE7802bA9290ef8b00CA16Af4Bc26eb663a28',      // stMATIC/WMATIC
    },
    // Optimism
    10: {
        '3pool': '0x1337BedC9D22ecbe766dF105c9623922A27963EC',        // DAI/USDC/USDT
        'wsteth': '0xB90B9B1F91a01Ea22A182CD84C1E22222e39B415',       // wstETH/ETH
    },
    // Base
    8453: {
        '4pool': '0xf6C5F01C7F3148891ad0e19DF78743D31E390D1f',        // DAI/USDC/USDT/USDbC
        'cbeth': '0x11C1fBd4b3De66bC0565779b35171a6CF3E71f59',        // cbETH/ETH
    },
};

/**
 * Curve Address Provider addresses (same on most chains)
 */
export const CURVE_ADDRESS_PROVIDER = {
    1: '0x0000000022D53366457F9d5E68Ec105046FC4383',
    10: '0x0000000022D53366457F9d5E68Ec105046FC4383',
    137: '0x0000000022D53366457F9d5E68Ec105046FC4383',
    42161: '0x0000000022D53366457F9d5E68Ec105046FC4383',
    8453: '0x0000000022D53366457F9d5E68Ec105046FC4383',
};

/**
 * Curve pool fee (standard is 0.04% = 4000000 in 1e10)
 */
export const CURVE_FEE = 0.0004; // 0.04%

// ============ Liquid Staking Derivatives (LSD) ABIs ============

/**
 * Lido stETH ABI - Rebasing token
 * stETH balance increases daily with staking rewards
 */
export const STETH_ABI = [
    // ERC20 standard
    'function balanceOf(address account) external view returns (uint256)',
    'function transfer(address to, uint256 amount) external returns (bool)',
    'function approve(address spender, uint256 amount) external returns (bool)',
    'function totalSupply() external view returns (uint256)',
    'function decimals() external view returns (uint8)',
    'function symbol() external view returns (string)',

    // Lido specific
    'function getSharesByPooledEth(uint256 ethAmount) external view returns (uint256)',
    'function getPooledEthByShares(uint256 sharesAmount) external view returns (uint256)',
    'function getTotalShares() external view returns (uint256)',
    'function getTotalPooledEther() external view returns (uint256)',

    // Events
    'event Transfer(address indexed from, address indexed to, uint256 value)',
    'event TokenRebased(uint256 indexed reportTimestamp, uint256 timeElapsed, uint256 preTotalShares, uint256 preTotalEther, uint256 postTotalShares, uint256 postTotalEther, uint256 sharesMintedAsFees)',
];

/**
 * Lido wstETH ABI - Non-rebasing wrapper for stETH
 * Value increases instead of balance (better for DeFi)
 */
export const WSTETH_ABI = [
    // ERC20 standard
    'function balanceOf(address account) external view returns (uint256)',
    'function transfer(address to, uint256 amount) external returns (bool)',
    'function approve(address spender, uint256 amount) external returns (bool)',
    'function totalSupply() external view returns (uint256)',
    'function decimals() external view returns (uint8)',

    // wstETH specific - conversion functions
    'function wrap(uint256 stETHAmount) external returns (uint256)',
    'function unwrap(uint256 wstETHAmount) external returns (uint256)',
    'function getWstETHByStETH(uint256 stETHAmount) external view returns (uint256)',
    'function getStETHByWstETH(uint256 wstETHAmount) external view returns (uint256)',
    'function stEthPerToken() external view returns (uint256)', // Returns stETH per 1 wstETH (in wei)
    'function tokensPerStEth() external view returns (uint256)', // Returns wstETH per 1 stETH (in wei)
    'function stETH() external view returns (address)',
];

/**
 * Rocket Pool rETH ABI
 * Exchange rate increases with staking rewards
 */
export const RETH_ABI = [
    // ERC20 standard
    'function balanceOf(address account) external view returns (uint256)',
    'function transfer(address to, uint256 amount) external returns (bool)',
    'function approve(address spender, uint256 amount) external returns (bool)',
    'function totalSupply() external view returns (uint256)',
    'function decimals() external view returns (uint8)',

    // rETH specific
    'function getExchangeRate() external view returns (uint256)', // ETH per rETH in wei
    'function getRethValue(uint256 ethAmount) external view returns (uint256)', // ETH -> rETH
    'function getEthValue(uint256 rethAmount) external view returns (uint256)', // rETH -> ETH
    'function getTotalCollateral() external view returns (uint256)',
];

/**
 * Coinbase cbETH ABI
 */
export const CBETH_ABI = [
    // ERC20 standard
    'function balanceOf(address account) external view returns (uint256)',
    'function transfer(address to, uint256 amount) external returns (bool)',
    'function approve(address spender, uint256 amount) external returns (bool)',
    'function totalSupply() external view returns (uint256)',
    'function decimals() external view returns (uint8)',

    // cbETH specific
    'function exchangeRate() external view returns (uint256)', // ETH per cbETH in wei (scaled by 1e18)
];

/**
 * Frax sfrxETH ABI (staked frxETH)
 */
export const SFRXETH_ABI = [
    // ERC20 standard
    'function balanceOf(address account) external view returns (uint256)',
    'function transfer(address to, uint256 amount) external returns (bool)',
    'function approve(address spender, uint256 amount) external returns (bool)',
    'function totalSupply() external view returns (uint256)',
    'function decimals() external view returns (uint8)',

    // sfrxETH specific (ERC4626 vault)
    'function convertToShares(uint256 assets) external view returns (uint256)',
    'function convertToAssets(uint256 shares) external view returns (uint256)',
    'function pricePerShare() external view returns (uint256)',
    'function asset() external view returns (address)', // Returns frxETH address
    'function totalAssets() external view returns (uint256)',
];

/**
 * LSD Token Addresses by chain
 */
export const LSD_ADDRESSES = {
    // Ethereum Mainnet
    1: {
        stETH: '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84',
        wstETH: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0',
        rETH: '0xae78736Cd615f374D3085123A210448E74Fc6393',
        cbETH: '0xBe9895146f7AF43049ca1c1AE358B0541Ea49704',
        frxETH: '0x5E8422345238F34275888049021821E8E08CAa1f',
        sfrxETH: '0xac3E018457B222d93114458476f3E3416Abbe38F',
        // Reference: WETH for comparison
        WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    },
    // Arbitrum
    42161: {
        wstETH: '0x5979D7b546E38E414F7E9822514be443A4800529',
        rETH: '0xEC70Dcb4A1EFa46b8F2D97C310C9c4790ba5ffA8',
        cbETH: '0x1DEBd73E752bEaF79865Fd6446b0c970EaE7732f',
        frxETH: '0x178412e79c25968a32e89b11f63B33F733770c2A',
        sfrxETH: '0x95aB45875cFFdba1E5f451B950bC2E42c0053f39',
        WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    },
    // Optimism
    10: {
        wstETH: '0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb',
        rETH: '0x9Bcef72be871e61ED4fBbc7630889beE758eb81D',
        cbETH: '0xadDb6A0412DE1BA0F936DCaeb8Aaa24578dcF3B2',
        frxETH: '0x6806411765Af15Bddd26f8f544A34cC40cb9838B',
        sfrxETH: '0x484c2D6e3cDd945a8B2DF735e079178C1036578c',
        WETH: '0x4200000000000000000000000000000000000006',
    },
    // Base
    8453: {
        wstETH: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452',
        cbETH: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22',
        rETH: '0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c',
        WETH: '0x4200000000000000000000000000000000000006',
    },
    // Polygon
    137: {
        wstETH: '0x03b54A6e9a984069379fae1a4fC4dBAE93B3bCCD',
        stMATIC: '0x3A58a54C066FdC0f2D55FC9C89F0415C92eBf3C4', // Lido staked MATIC
        MaticX: '0xfa68FB4628DFF1028CFEc22b4162FCcd0d45efb6', // Stader staked MATIC
        rETH: '0x0266F4F08D82372CF0FcbCCc0Ff74309089c74d1',
        WMATIC: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
    },
};

/**
 * Lido Oracle - Reports stETH rebase events
 * Rebases typically occur once per day around 12:00 UTC
 */
export const LIDO_ORACLE_ABI = [
    'function getLastCompletedReportDelta() external view returns (uint256 postTotalPooledEther, uint256 preTotalPooledEther, uint256 timeElapsed)',
    'function getBeaconSpec() external view returns (uint64 epochsPerFrame, uint64 slotsPerEpoch, uint64 secondsPerSlot, uint64 genesisTime)',
    'function getExpectedEpochId() external view returns (uint256)',
    'function getLastCompletedEpochId() external view returns (uint256)',

    // Events
    'event Completed(uint256 epochId, uint128 beaconBalance, uint128 beaconValidators)',
    'event PostTotalShares(uint256 postTotalPooledEther, uint256 preTotalPooledEther, uint256 timeElapsed, uint256 totalShares)',
];

export const LIDO_ORACLE_ADDRESS = '0x442af784A788A5bd6F42A01Ebe9F287a871243fb'; // Ethereum mainnet

// ============ Liquidation Protocol ABIs ============

/**
 * Aave V3 Pool ABI - Liquidation functions
 * LiquidationCall is emitted when a position is liquidated
 *
 * Liquidation opportunity: When a borrower's health factor < 1, anyone can
 * liquidate up to 50% of their debt (or 100% if HF < 0.95).
 * Liquidator receives collateral + liquidation bonus (typically 5-10%).
 *
 * Backrun strategy: Monitor LiquidationCall events and buy the discounted
 * collateral on DEXes after liquidation occurs.
 */
export const AAVE_V3_LIQUIDATION_ABI = [
    // Liquidation function
    'function liquidationCall(address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool receiveAToken) external',

    // View functions for health factor
    'function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',

    // Get reserve data for liquidation bonus
    'function getReserveData(address asset) external view returns (tuple(uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))',

    // Events
    'event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)',
    'event ReserveDataUpdated(address indexed reserve, uint256 liquidityRate, uint256 stableBorrowRate, uint256 variableBorrowRate, uint256 liquidityIndex, uint256 variableBorrowIndex)',
];

/**
 * Compound V3 (Comet) ABI - Liquidation functions
 * Compound V3 uses "absorb" instead of traditional liquidation
 *
 * When positions become underwater, anyone can call absorb() to liquidate.
 * The absorbed collateral is sold via buyCollateral() at a discount.
 *
 * Backrun strategy: Monitor AbsorbCollateral events and participate in
 * buyCollateral auctions or arbitrage the price impact.
 */
export const COMPOUND_V3_ABI = [
    // Absorb (liquidate) underwater accounts
    'function absorb(address absorber, address[] memory accounts) external',

    // Buy discounted collateral after absorption
    'function buyCollateral(address asset, uint256 minAmount, uint256 baseAmount, address recipient) external',

    // Get collateral reserves available for purchase
    'function getCollateralReserves(address asset) external view returns (uint256)',

    // Check if account is liquidatable
    'function isLiquidatable(address account) external view returns (bool)',

    // Get account's borrow balance
    'function borrowBalanceOf(address account) external view returns (uint256)',

    // Get collateral balance
    'function collateralBalanceOf(address account, address asset) external view returns (uint128)',

    // Base token info
    'function baseToken() external view returns (address)',
    'function baseTokenPriceFeed() external view returns (address)',

    // Asset info
    'function getAssetInfo(uint8 i) external view returns (tuple(uint8 offset, address asset, address priceFeed, uint64 scale, uint64 borrowCollateralFactor, uint64 liquidateCollateralFactor, uint64 liquidationFactor, uint128 supplyCap))',
    'function numAssets() external view returns (uint8)',

    // Events
    'event AbsorbCollateral(address indexed absorber, address indexed borrower, address indexed asset, uint256 collateralAbsorbed, uint256 usdValue)',
    'event AbsorbDebt(address indexed absorber, address indexed borrower, uint256 basePaidOut, uint256 usdValue)',
    'event BuyCollateral(address indexed buyer, address indexed asset, uint256 baseAmount, uint256 collateralAmount)',
];

/**
 * Aave V3 Data Provider ABI - For querying user positions
 */
export const AAVE_V3_DATA_PROVIDER_ABI = [
    'function getUserReserveData(address asset, address user) external view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)',
    'function getReserveConfigurationData(address asset) external view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)',
    'function getAllReservesTokens() external view returns (tuple(string symbol, address tokenAddress)[] memory)',
    'function getReserveTokensAddresses(address asset) external view returns (address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress)',
];

/**
 * Chainlink Price Feed ABI - For accurate price data
 */
export const CHAINLINK_PRICE_FEED_ABI = [
    'function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
    'function decimals() external view returns (uint8)',
    'function description() external view returns (string memory)',
];

/**
 * Liquidation Protocol Addresses by Chain
 */
export const LIQUIDATION_PROTOCOL_ADDRESSES = {
    // Ethereum Mainnet
    1: {
        aaveV3Pool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
        aaveV3DataProvider: '0x7B4EB56E7CD4b454BA8ff71E4518426369a138a3',
        compoundV3USDC: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
        compoundV3WETH: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
    },
    // Arbitrum
    42161: {
        aaveV3Pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
        aaveV3DataProvider: '0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654',
        compoundV3USDC: '0xA5EDBDD9646f8dFF606d7448e414884C7d905dCA',
    },
    // Polygon
    137: {
        aaveV3Pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
        aaveV3DataProvider: '0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654',
    },
    // Optimism
    10: {
        aaveV3Pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
        aaveV3DataProvider: '0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654',
    },
    // Base
    8453: {
        aaveV3Pool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
        aaveV3DataProvider: '0x2d8A3C5677189723C4cB8873CfC9C8976FDF38Ac',
        compoundV3USDC: '0xb125E6687d4313864e53df431d5425969c15Eb2F',
        compoundV3WETH: '0x46e6b214b524310239732D51387075E0e70970bf',
    },
    // Avalanche
    43114: {
        aaveV3Pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
        aaveV3DataProvider: '0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654',
    },
};

/**
 * Liquidation bonus by protocol (percentage above collateral value)
 * Example: 5% bonus means liquidator receives $105 of collateral for covering $100 of debt
 */
export const LIQUIDATION_BONUSES = {
    AAVE_V3_DEFAULT: 0.05,      // 5% (varies by asset)
    AAVE_V3_ETH: 0.05,          // 5%
    AAVE_V3_STABLECOINS: 0.04,  // 4%
    COMPOUND_V3: 0.05,          // 5% (target factor)
};

/**
 * Event topics for liquidation monitoring
 */
export const LIQUIDATION_EVENT_TOPICS = {
    // Aave V3 LiquidationCall
    AAVE_V3_LIQUIDATION: '0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286',
    // Compound V3 AbsorbCollateral
    COMPOUND_V3_ABSORB: '0x9850ab1af75177e4a9201b0c63f48fc4c5e50c5a4b7cf4c9b2e82f3e7e41b1a3',
    // Compound V3 BuyCollateral
    COMPOUND_V3_BUY: '0x54787c404bb33c88e86f4baf88183a3b0141d0a848e6a9f7a13b66ae3a9b73d1',
};

export default {
    PAIR_ABI,
    PAIR_FLASH_ABI,
    FACTORY_ABI,
    ROUTER_ABI,
    ROUTER_FULL_ABI,
    ERC20_ABI,
    MULTICALL_ABI,
    FLASH_ARBITRAGE_ABI,
    MULTICALL_ADDRESS,
    WBNB_ADDRESS,
    WRAPPED_NATIVE_ADDRESSES,
    getWrappedNativeAddress,
    PANCAKE_FACTORY_ADDRESS,
    FLASH_LOAN_FEE,
    // V3 exports
    V3_POOL_ABI,
    V3_FACTORY_ABI,
    V3_QUOTER_ABI,
    V3_FEE_TIERS,
    V3_FACTORY_ADDRESSES,
    // Flash loan provider exports
    BALANCER_VAULT_ABI,
    BALANCER_FLASH_LOAN_RECIPIENT_ABI,
    BALANCER_VAULT_ADDRESSES,
    DYDX_SOLO_MARGIN_ABI,
    DYDX_CALLEE_ABI,
    DYDX_ADDRESSES,
    DYDX_ACTION_TYPES,
    AAVE_V3_POOL_ABI,
    AAVE_FLASH_LOAN_RECEIVER_ABI,
    AAVE_V3_POOL_ADDRESSES,
    FLASH_LOAN_FEES,
    // Curve Finance exports
    CURVE_POOL_ABI,
    CURVE_META_POOL_ABI,
    CURVE_REGISTRY_ABI,
    CURVE_ADDRESS_PROVIDER_ABI,
    CURVE_POOL_ADDRESSES,
    CURVE_ADDRESS_PROVIDER,
    CURVE_FEE,
    // LSD (Liquid Staking Derivative) exports
    STETH_ABI,
    WSTETH_ABI,
    RETH_ABI,
    CBETH_ABI,
    SFRXETH_ABI,
    LSD_ADDRESSES,
    LIDO_ORACLE_ABI,
    LIDO_ORACLE_ADDRESS,
    // Liquidation protocol exports
    AAVE_V3_LIQUIDATION_ABI,
    COMPOUND_V3_ABI,
    AAVE_V3_DATA_PROVIDER_ABI,
    CHAINLINK_PRICE_FEED_ABI,
    LIQUIDATION_PROTOCOL_ADDRESSES,
    LIQUIDATION_BONUSES,
    LIQUIDATION_EVENT_TOPICS,
};
