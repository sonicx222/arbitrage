// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title IPancakeV2Pair
 * @notice Interface for PancakeSwap V2 Pair contract
 * @dev Used for flash swaps - borrow tokens and repay in same transaction
 */
interface IPancakeV2Pair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);

    /**
     * @notice Swap tokens - can be used for flash swaps
     * @param amount0Out Amount of token0 to receive
     * @param amount1Out Amount of token1 to receive
     * @param to Address to send tokens to
     * @param data If non-empty, triggers flash swap callback (pancakeCall)
     */
    function swap(uint amount0Out, uint amount1Out, address to, bytes calldata data) external;

    function factory() external view returns (address);
}

/**
 * @title IPancakeV2Factory
 * @notice Interface for PancakeSwap V2 Factory
 */
interface IPancakeV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
    function allPairs(uint) external view returns (address pair);
    function allPairsLength() external view returns (uint);
}

/**
 * @title IPancakeV2Router
 * @notice Interface for PancakeSwap V2 Router
 */
interface IPancakeV2Router {
    function factory() external pure returns (address);
    function WETH() external pure returns (address);

    function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts);
    function getAmountsIn(uint amountOut, address[] calldata path) external view returns (uint[] memory amounts);

    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);

    function swapTokensForExactTokens(
        uint amountOut,
        uint amountInMax,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);
}

/**
 * @title IPancakeV2Callee
 * @notice Interface that must be implemented to receive flash swap callbacks
 */
interface IPancakeV2Callee {
    /**
     * @notice Called by PancakeSwap pair during flash swap
     * @param sender The address that initiated the swap
     * @param amount0 Amount of token0 borrowed
     * @param amount1 Amount of token1 borrowed
     * @param data Arbitrary data passed to swap function
     */
    function pancakeCall(address sender, uint amount0, uint amount1, bytes calldata data) external;
}
