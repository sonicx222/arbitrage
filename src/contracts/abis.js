/**
 * Minimal ABIs for interacting with DEX smart contracts
 * These are human-readable format strings used by ethers.js
 */

// Uniswap V2 Pair ABI (PancakeSwap and Biswap use the same interface)
export const PAIR_ABI = [
    'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
    'function token0() external view returns (address)',
    'function token1() external view returns (address)',
    'function totalSupply() external view returns (uint256)',
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

// ERC20 Token ABI
export const ERC20_ABI = [
    'function decimals() external view returns (uint8)',
    'function symbol() external view returns (string)',
    'function name() external view returns (string)',
    'function balanceOf(address account) external view returns (uint256)',
    'function approve(address spender, uint256 amount) external returns (bool)',
];

// Multicall ABI (for batching multiple calls)
export const MULTICALL_ABI = [
    'function aggregate(tuple(address target, bytes callData)[] calls) view returns (uint256 blockNumber, bytes[] returnData)',
    'function tryAggregate(bool requireSuccess, tuple(address target, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)'
];

// BSC Multicall3 Contract
export const MULTICALL_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11'; // Standard Multicall3 on BSC

export default {
    PAIR_ABI,
    FACTORY_ABI,
    ROUTER_ABI,
    ERC20_ABI,
    MULTICALL_ABI,
};
