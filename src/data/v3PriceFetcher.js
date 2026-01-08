import { ethers } from 'ethers';
import {
    V3_POOL_ABI,
    V3_FACTORY_ABI,
    V3_FEE_TIERS,
    V3_FACTORY_ADDRESSES,
    MULTICALL_ABI,
    MULTICALL_ADDRESS,
} from '../contracts/abis.js';
import rpcManager from '../utils/rpcManager.js';
import cacheManager from './cacheManager.js';
import log from '../utils/logger.js';

/**
 * Uniswap V3 Price Fetcher
 *
 * Fetches prices from Uniswap V3 (and forks like PancakeSwap V3) pools.
 * V3 uses concentrated liquidity with tick-based pricing (sqrtPriceX96).
 *
 * Key differences from V2:
 * - Price is stored as sqrtPriceX96 (sqrt of price * 2^96)
 * - Multiple fee tiers per pair (0.01%, 0.05%, 0.30%, 1.00%)
 * - Liquidity is concentrated around current price
 * - More gas efficient for swaps within range
 */
class V3PriceFetcher {
    constructor() {
        // Fee tiers to check for each pair
        this.feeTiers = [
            V3_FEE_TIERS.LOW,      // 0.05% - Most common for major pairs
            V3_FEE_TIERS.MEDIUM,   // 0.30% - Standard pairs
            V3_FEE_TIERS.LOWEST,   // 0.01% - Stablecoin pairs
            V3_FEE_TIERS.HIGH,     // 1.00% - Exotic pairs (check last)
        ];

        // V3 pool address cache: "chainId:tokenA:tokenB:fee" -> address
        this.poolCache = new Map();

        // Constants for price calculation
        this.Q96 = 2n ** 96n;
        this.Q192 = 2n ** 192n;

        // FIX v3.3: Changed to debug - logs for each worker in multi-chain mode
        log.debug('V3 Price Fetcher initialized');
    }

    /**
     * Fetch V3 prices for all configured token pairs
     *
     * @param {number} chainId - Chain ID
     * @param {Object} tokens - Token configurations { symbol: { address, decimals } }
     * @param {Array} baseTokens - Base token symbols to pair against
     * @param {number} blockNumber - Current block number
     * @returns {Object} Price data: { "TOKEN/BASE": { "dexName-v3": { price, liquidity, ... } } }
     */
    async fetchAllPrices(chainId, tokens, baseTokens, blockNumber) {
        const startTime = Date.now();
        const factoryAddress = V3_FACTORY_ADDRESSES[chainId];

        if (!factoryAddress) {
            log.debug(`V3 not supported on chain ${chainId}`);
            return {};
        }

        try {
            // Generate token pairs
            const tokenPairs = this._generateTokenPairs(tokens, baseTokens);

            // Resolve pool addresses for all pairs and fee tiers
            const pools = await this._resolvePools(chainId, factoryAddress, tokenPairs);

            if (pools.length === 0) {
                log.debug(`No V3 pools found on chain ${chainId}`);
                return {};
            }

            // Fetch slot0 and liquidity for all pools via multicall
            const poolData = await this._fetchPoolData(pools);

            // Parse results into price format
            const prices = this._parsePoolData(pools, poolData, blockNumber);

            log.debug(`V3: Fetched ${Object.keys(prices).length} pairs in ${Date.now() - startTime}ms`, {
                chainId,
                poolsChecked: pools.length,
            });

            return prices;
        } catch (error) {
            log.error('V3 price fetch error', { chainId, error: error.message });
            return {};
        }
    }

    /**
     * Convert sqrtPriceX96 to human-readable price
     *
     * V3 stores price as: sqrtPriceX96 = sqrt(price) * 2^96
     * To get price: price = (sqrtPriceX96 / 2^96)^2
     *
     * IMPORTANT: Uses BigInt arithmetic to avoid precision loss when converting
     * large sqrtPriceX96 values (up to 160 bits) that exceed Number.MAX_SAFE_INTEGER.
     *
     * @param {BigInt} sqrtPriceX96 - sqrt price from slot0
     * @param {number} decimals0 - Decimals of token0
     * @param {number} decimals1 - Decimals of token1
     * @returns {number} Price of token0 in terms of token1
     */
    sqrtPriceX96ToPrice(sqrtPriceX96, decimals0, decimals1) {
        if (sqrtPriceX96 === 0n) return 0;

        // price = (sqrtPriceX96)^2 / (2^192) * 10^(decimals0 - decimals1)
        //
        // Use BigInt arithmetic throughout to maintain precision for large values.
        // sqrtPriceX96 can be up to ~160 bits, exceeding Number.MAX_SAFE_INTEGER (53 bits).
        //
        // Algorithm:
        // 1. Compute numerator: sqrtPriceX96^2 * 10^PRECISION_DIGITS
        // 2. Apply decimal adjustment in BigInt
        // 3. Divide by Q192
        // 4. Convert final (smaller) result to Number

        const PRECISION_DIGITS = 18n;
        const precisionFactor = 10n ** PRECISION_DIGITS;

        // sqrtPriceX96^2 can be up to 320 bits - BigInt handles this
        const sqrtPriceSquared = sqrtPriceX96 * sqrtPriceX96;

        // Handle decimal adjustment with BigInt to avoid Number overflow
        const decimalDiff = decimals0 - decimals1;

        let numerator = sqrtPriceSquared * precisionFactor;
        let denominator = this.Q192;

        // Apply decimal adjustment
        if (decimalDiff > 0) {
            numerator *= 10n ** BigInt(decimalDiff);
        } else if (decimalDiff < 0) {
            denominator *= 10n ** BigInt(-decimalDiff);
        }

        // After division, result should be in reasonable range
        const priceScaled = numerator / denominator;

        // Convert to float - priceScaled should be reasonable (price * 10^18)
        return Number(priceScaled) / Number(precisionFactor);
    }

    /**
     * Convert price to sqrtPriceX96 (for limit orders/simulations)
     *
     * IMPORTANT: Uses BigInt arithmetic to avoid precision loss.
     * Number(Q96) exceeds MAX_SAFE_INTEGER and would cause precision errors.
     *
     * @param {number} price - Human-readable price
     * @param {number} decimals0 - Decimals of token0
     * @param {number} decimals1 - Decimals of token1
     * @returns {BigInt} sqrtPriceX96
     */
    priceToSqrtPriceX96(price, decimals0, decimals1) {
        if (price <= 0) return 0n;

        // sqrtPriceX96 = sqrt(price * 10^(decimals1 - decimals0)) * 2^96
        //
        // To maintain precision:
        // 1. Scale price to BigInt with precision factor
        // 2. Apply decimal adjustment
        // 3. Take square root (using Newton's method on BigInt)
        // 4. Scale by Q96

        const decimalDiff = decimals1 - decimals0;
        const PRECISION = 36; // High precision for sqrt calculation

        // Scale price to BigInt
        let scaledPrice = BigInt(Math.floor(price * Math.pow(10, PRECISION)));

        // Apply decimal adjustment
        if (decimalDiff > 0) {
            scaledPrice *= 10n ** BigInt(decimalDiff);
        } else if (decimalDiff < 0) {
            scaledPrice /= 10n ** BigInt(-decimalDiff);
        }

        // sqrt(scaledPrice) = sqrt(price * 10^PRECISION * 10^decimalDiff)
        // We need sqrt(price * 10^decimalDiff) * Q96
        // = sqrt(scaledPrice / 10^PRECISION) * Q96
        // = sqrt(scaledPrice) * Q96 / sqrt(10^PRECISION)
        // = sqrt(scaledPrice) * Q96 / 10^(PRECISION/2)

        const sqrtScaledPrice = this._bigIntSqrt(scaledPrice);
        const precisionDivisor = 10n ** BigInt(PRECISION / 2);

        return (sqrtScaledPrice * this.Q96) / precisionDivisor;
    }

    /**
     * BigInt square root using Newton's method
     * @private
     * @param {BigInt} n - Value to take square root of
     * @returns {BigInt} Floor of square root
     */
    _bigIntSqrt(n) {
        if (n < 0n) throw new Error('Square root of negative number');
        if (n < 2n) return n;

        // Newton's method: x_{n+1} = (x_n + n/x_n) / 2
        let x = n;
        let y = (x + 1n) / 2n;

        while (y < x) {
            x = y;
            y = (x + n / x) / 2n;
        }

        return x;
    }

    /**
     * Calculate output amount for a V3 swap (simplified - no tick crossing)
     *
     * For more accurate quotes, use the Quoter contract.
     * This is an approximation assuming swap stays within current tick range.
     *
     * @param {BigInt} amountIn - Input amount
     * @param {BigInt} sqrtPriceX96 - Current sqrt price
     * @param {BigInt} liquidity - Current liquidity
     * @param {number} fee - Fee tier (e.g., 3000 for 0.3%)
     * @param {boolean} zeroForOne - Direction: true = token0 -> token1
     * @returns {BigInt} Estimated output amount
     */
    calculateSwapOutput(amountIn, sqrtPriceX96, liquidity, fee, zeroForOne) {
        if (liquidity === 0n) return 0n;

        // Apply fee
        const amountInAfterFee = (amountIn * BigInt(1000000 - fee)) / 1000000n;

        // Simplified calculation (assumes no tick crossing)
        if (zeroForOne) {
            // Selling token0 for token1
            // deltaY = L * (sqrt(P_new) - sqrt(P_old))
            // For small swaps: amountOut ≈ amountIn * price
            const price = this.sqrtPriceX96ToPrice(sqrtPriceX96, 18, 18);
            return BigInt(Math.floor(Number(amountInAfterFee) * price));
        } else {
            // Selling token1 for token0
            const price = this.sqrtPriceX96ToPrice(sqrtPriceX96, 18, 18);
            return BigInt(Math.floor(Number(amountInAfterFee) / price));
        }
    }

    /**
     * Estimate liquidity depth in USD
     *
     * @param {BigInt} liquidity - Pool liquidity
     * @param {BigInt} sqrtPriceX96 - Current sqrt price
     * @param {number} token0PriceUSD - Price of token0 in USD
     * @param {number} decimals0 - Token0 decimals
     * @param {number} decimals1 - Token1 decimals
     * @returns {number} Estimated TVL in USD
     */
    estimateLiquidityUSD(liquidity, sqrtPriceX96, token0PriceUSD, decimals0, decimals1) {
        if (liquidity === 0n || !token0PriceUSD) return 0;

        // Simplified: estimate based on liquidity and current price
        // Real TVL requires integrating across all ticks
        const price = this.sqrtPriceX96ToPrice(sqrtPriceX96, decimals0, decimals1);

        // Approximate TVL = 2 * L / sqrt(P) * token0Price
        // This is a rough estimate for concentrated liquidity
        const sqrtPrice = Number(sqrtPriceX96) / Number(this.Q96);
        const liquidityFloat = Number(liquidity) / Math.pow(10, 18); // Normalize

        // Rough TVL estimate (within 2x of actual for most pools)
        const tvl = liquidityFloat * sqrtPrice * token0PriceUSD * 2 / 1e6;

        return Math.max(0, tvl);
    }

    /**
     * Generate token pairs from config
     * @private
     */
    _generateTokenPairs(tokens, baseTokens) {
        const pairs = [];
        const seen = new Set();

        const tokenList = Object.values(tokens);
        const baseTokenList = tokenList.filter(t => baseTokens.includes(t.symbol));

        for (const token of tokenList) {
            for (const base of baseTokenList) {
                if (token.address.toLowerCase() === base.address.toLowerCase()) continue;

                // Normalize order (lower address first)
                const [t0, t1] = token.address.toLowerCase() < base.address.toLowerCase()
                    ? [token, base]
                    : [base, token];

                const key = `${t0.address}:${t1.address}`;
                if (seen.has(key)) continue;
                seen.add(key);

                pairs.push({
                    token0: t0,
                    token1: t1,
                    pairKey: `${t0.symbol}/${t1.symbol}`,
                });
            }
        }

        return pairs;
    }

    /**
     * Resolve pool addresses for all pairs and fee tiers
     * @private
     */
    async _resolvePools(chainId, factoryAddress, tokenPairs) {
        const pools = [];
        const toFetch = [];

        // Check cache first
        for (const pair of tokenPairs) {
            for (const fee of this.feeTiers) {
                const cacheKey = `${chainId}:${pair.token0.address}:${pair.token1.address}:${fee}`;
                const cachedPool = this.poolCache.get(cacheKey);

                if (cachedPool === null) {
                    // Known to not exist, skip
                    continue;
                } else if (cachedPool) {
                    pools.push({
                        ...pair,
                        fee,
                        poolAddress: cachedPool,
                        chainId,
                    });
                } else {
                    // Need to fetch
                    toFetch.push({ ...pair, fee, cacheKey, chainId });
                }
            }
        }

        // Batch fetch unknown pools via multicall
        if (toFetch.length > 0) {
            const BATCH_SIZE = 100;
            const iface = new ethers.Interface(V3_FACTORY_ABI);

            for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
                const batch = toFetch.slice(i, i + BATCH_SIZE);
                const calls = batch.map(p => ({
                    target: factoryAddress,
                    callData: iface.encodeFunctionData('getPool', [
                        p.token0.address,
                        p.token1.address,
                        p.fee,
                    ]),
                }));

                try {
                    const results = await rpcManager.withRetry(async (provider) => {
                        const multicall = new ethers.Contract(MULTICALL_ADDRESS, MULTICALL_ABI, provider);
                        return await multicall.tryAggregate(false, calls);
                    });

                    batch.forEach((poolInfo, idx) => {
                        const { success, returnData } = results[idx];
                        let poolAddress = ethers.ZeroAddress;

                        if (success && returnData !== '0x') {
                            try {
                                poolAddress = iface.decodeFunctionResult('getPool', returnData)[0];
                            } catch {
                                poolAddress = ethers.ZeroAddress;
                            }
                        }

                        // Cache result (null for non-existent)
                        if (poolAddress === ethers.ZeroAddress) {
                            this.poolCache.set(poolInfo.cacheKey, null);
                        } else {
                            this.poolCache.set(poolInfo.cacheKey, poolAddress);
                            pools.push({
                                token0: poolInfo.token0,
                                token1: poolInfo.token1,
                                pairKey: poolInfo.pairKey,
                                fee: poolInfo.fee,
                                poolAddress,
                                chainId: poolInfo.chainId,
                            });
                        }
                    });
                } catch (error) {
                    log.warn('V3 pool resolution batch failed', { error: error.message });
                }
            }
        }

        return pools;
    }

    /**
     * Fetch slot0 and liquidity for all pools
     * @private
     */
    async _fetchPoolData(pools) {
        const results = new Map();
        const BATCH_SIZE = 100;
        const poolIface = new ethers.Interface(V3_POOL_ABI);

        // Each pool needs 2 calls: slot0() and liquidity()
        for (let i = 0; i < pools.length; i += BATCH_SIZE) {
            const batch = pools.slice(i, i + BATCH_SIZE);
            const calls = [];

            // Build multicall for slot0 and liquidity
            for (const pool of batch) {
                calls.push({
                    target: pool.poolAddress,
                    callData: poolIface.encodeFunctionData('slot0'),
                });
                calls.push({
                    target: pool.poolAddress,
                    callData: poolIface.encodeFunctionData('liquidity'),
                });
            }

            try {
                const multicallResults = await rpcManager.withRetry(async (provider) => {
                    const multicall = new ethers.Contract(MULTICALL_ADDRESS, MULTICALL_ABI, provider);
                    return await multicall.tryAggregate(false, calls);
                });

                // Parse results - every 2 results belong to one pool
                batch.forEach((pool, idx) => {
                    const slot0Result = multicallResults[idx * 2];
                    const liquidityResult = multicallResults[idx * 2 + 1];

                    let slot0 = null;
                    let liquidity = 0n;

                    if (slot0Result.success && slot0Result.returnData !== '0x') {
                        try {
                            const decoded = poolIface.decodeFunctionResult('slot0', slot0Result.returnData);
                            slot0 = {
                                sqrtPriceX96: decoded[0],
                                tick: decoded[1],
                                unlocked: decoded[6],
                            };
                        } catch { /* ignore decode errors */ }
                    }

                    if (liquidityResult.success && liquidityResult.returnData !== '0x') {
                        try {
                            liquidity = poolIface.decodeFunctionResult('liquidity', liquidityResult.returnData)[0];
                        } catch { /* ignore decode errors */ }
                    }

                    if (slot0 && slot0.sqrtPriceX96 > 0n) {
                        results.set(pool.poolAddress, { slot0, liquidity });
                    }
                });
            } catch (error) {
                log.warn('V3 pool data batch failed', { error: error.message });
            }
        }

        return results;
    }

    /**
     * Parse pool data into standard price format
     * @private
     */
    _parsePoolData(pools, poolData, blockNumber) {
        const prices = {};

        for (const pool of pools) {
            const data = poolData.get(pool.poolAddress);
            if (!data || !data.slot0) continue;

            const { sqrtPriceX96, tick } = data.slot0;
            const { liquidity } = data;

            // Calculate price
            const price = this.sqrtPriceX96ToPrice(
                sqrtPriceX96,
                pool.token0.decimals,
                pool.token1.decimals
            );

            if (price <= 0 || !isFinite(price)) continue;

            // Fee as decimal
            const feeDecimal = pool.fee / 1000000;

            // Estimate liquidity USD (rough)
            // For now, use liquidity as a proxy (actual USD needs token prices)
            const liquidityUSD = Number(liquidity) / 1e12; // Very rough estimate

            // DEX name with fee tier
            const dexName = `v3-${pool.fee}`;

            // Initialize pair entry
            if (!prices[pool.pairKey]) {
                prices[pool.pairKey] = {};
            }

            prices[pool.pairKey][dexName] = {
                price,
                sqrtPriceX96: sqrtPriceX96.toString(),
                tick: Number(tick),
                liquidity: liquidity.toString(),
                liquidityUSD,
                fee: feeDecimal,
                poolAddress: pool.poolAddress,
                token0: pool.token0.address,
                token1: pool.token1.address,
                isV3: true,
                timestamp: Date.now(),
                blockNumber,
            };
        }

        return prices;
    }

    /**
     * Get best V3 pool for a token pair (highest liquidity)
     *
     * @param {Object} v3Prices - V3 price data for a pair
     * @returns {Object|null} Best pool data or null
     */
    getBestPool(v3Prices) {
        if (!v3Prices || Object.keys(v3Prices).length === 0) return null;

        let bestPool = null;
        let bestLiquidity = 0;

        for (const [dexName, data] of Object.entries(v3Prices)) {
            if (data.isV3 && data.liquidityUSD > bestLiquidity) {
                bestLiquidity = data.liquidityUSD;
                bestPool = { dexName, ...data };
            }
        }

        return bestPool;
    }

    /**
     * Clear pool cache
     */
    clearCache() {
        this.poolCache.clear();
    }

    /**
     * Get statistics
     */
    getStats() {
        return {
            cachedPools: this.poolCache.size,
            feeTiers: this.feeTiers,
        };
    }
}

// Export singleton instance
const v3PriceFetcher = new V3PriceFetcher();
export default v3PriceFetcher;
