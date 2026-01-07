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
};
