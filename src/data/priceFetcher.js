import { ethers } from 'ethers';
import { PAIR_ABI, FACTORY_ABI, ERC20_ABI, MULTICALL_ABI, MULTICALL_ADDRESS } from '../contracts/abis.js';
import rpcManager from '../utils/rpcManager.js';
import cacheManager from './cacheManager.js';
import config from '../config.js';
import log from '../utils/logger.js';
import { NATIVE_TOKEN_PRICES, STABLECOINS, getFallbackPrice } from '../constants/tokenPrices.js';

/**
 * Price Fetcher - Fetches token prices from DEX pairs via smart contract calls
 *
 * Optimizations:
 * - Cache-aware: Skips RPC calls for pairs with fresh event-driven data
 * - Priority-aware: Respects AdaptivePrioritizer tier frequencies
 * - Batch fetching: Uses Multicall for efficient RPC usage
 *
 * v2.1 Improvements for 24/7 Operation:
 * - Reduced batch sizes to prevent rate limit hits
 * - Inter-batch delays to spread RPC load
 * - Configurable batch parameters via environment variables
 */
class PriceFetcher {
    constructor() {
        this.dexes = Object.entries(config.dex).filter(([_, dexConfig]) => dexConfig.enabled);

        // v2.1: Configurable batch settings for rate limit management
        // Smaller batches = more requests but better load distribution
        this.batchSize = parseInt(process.env.MULTICALL_BATCH_SIZE || '50'); // Reduced from 200
        this.interBatchDelayMs = parseInt(process.env.MULTICALL_BATCH_DELAY || '100'); // Add delay between batches

        // FIX v3.6: Configurable sync event freshness tolerance
        // Sync events from block N are considered fresh up to block N + maxBlockAge
        // Higher values reduce RPC calls but may use slightly stale data
        // Default: 2 blocks (suitable for BSC 3s blocks, adjust for slower chains)
        this.maxBlockAge = parseInt(process.env.SYNC_EVENT_MAX_BLOCK_AGE || '2');

        // Statistics for cache-aware fetching
        this.stats = {
            totalFetches: 0,
            cacheHits: 0,
            rpcCalls: 0,
            skippedByPriority: 0,
            batchesExecuted: 0,
        };

        // Lazy-loaded prioritizer reference (avoid circular dependency)
        this._prioritizer = null;
        // FIX v3.2: Add loading promise to prevent race condition during concurrent initialization
        this._prioritizerLoadPromise = null;

        // FIX v3.3: Changed to debug - logs for each worker in multi-chain mode
        log.debug(`Price Fetcher initialized for ${this.dexes.length} DEXs`, {
            batchSize: this.batchSize,
            interBatchDelayMs: this.interBatchDelayMs,
            maxBlockAge: this.maxBlockAge,
        });
    }

    /**
     * Get the adaptive prioritizer (lazy load to avoid circular deps)
     * Uses dynamic import for ESM compatibility
     *
     * FIX v3.2: Added race condition protection using a loading promise
     * to prevent concurrent module imports
     *
     * @private
     * @returns {Promise<Object|null>} Prioritizer instance or null if unavailable
     */
    async _getPrioritizer() {
        // Fast path: already loaded
        if (this._prioritizer !== null) {
            return this._prioritizer;
        }

        // FIX v3.2: Check if another call is already loading the module
        if (this._prioritizerLoadPromise) {
            return this._prioritizerLoadPromise;
        }

        // Start loading and store the promise to prevent concurrent loads
        this._prioritizerLoadPromise = (async () => {
            try {
                // Dynamic import for ESM compatibility (avoids circular dependency)
                const module = await import('../analysis/adaptivePrioritizer.js');
                this._prioritizer = module.default || module;
            } catch {
                this._prioritizer = null;
            }
            return this._prioritizer;
        })();

        return this._prioritizerLoadPromise;
    }

    /**
     * Fetch prices for all configured token pairs across all DEXs
     *
     * Optimizations applied:
     * 1. Cache-aware: Uses fresh event-driven data instead of re-fetching
     * 2. Priority-aware: Respects tier frequencies from AdaptivePrioritizer
     *
     * @param {number} blockNumber - Current block number
     * @param {Object} options - Fetch options
     * @param {Set<string>} options.excludePairs - Pair keys to exclude (already have fresh data)
     * @param {boolean} options.respectPriority - Whether to check prioritizer (default: true)
     */
    async fetchAllPrices(blockNumber, options = {}) {
        const startTime = Date.now();
        const { excludePairs = new Set(), respectPriority = true } = options;

        this.stats.totalFetches++;

        try {
            const tokenPairs = this._getTokenPairs();
            const validPairs = await this._resolvePairs(tokenPairs);

            // Load prioritizer upfront if needed (async for ESM compatibility)
            const prioritizer = respectPriority ? await this._getPrioritizer() : null;

            // Separate pairs into: fresh from cache vs need RPC fetch
            const { freshPrices, pairsToFetch } = this._separateFreshFromStale(
                validPairs,
                blockNumber,
                excludePairs,
                prioritizer
            );

            // Only fetch pairs that need RPC calls
            let fetchedPrices = {};
            if (pairsToFetch.length > 0) {
                const results = await this._fetchBatchedReserves(pairsToFetch);
                fetchedPrices = this._parseReserves(pairsToFetch, results, blockNumber);
                this.stats.rpcCalls += pairsToFetch.length;
            }

            // Merge fresh cache data with newly fetched data
            const allPrices = this._mergePrices(freshPrices, fetchedPrices);

            const cacheHitRate = validPairs.length > 0
                ? ((validPairs.length - pairsToFetch.length) / validPairs.length * 100).toFixed(1)
                : 0;

            log.debug(`Fetched ${Object.keys(allPrices).length} pair prices in ${Date.now() - startTime}ms`, {
                total: validPairs.length,
                fromCache: validPairs.length - pairsToFetch.length,
                fromRPC: pairsToFetch.length,
                cacheHitRate: `${cacheHitRate}%`,
            });

            return allPrices;
        } catch (error) {
            log.error('Error fetching prices (Multicall)', { error: error.message });
            return {};
        }
    }

    /**
     * Separate pairs into fresh (from cache/events) vs stale (need RPC)
     * @private
     * @param {Array} validPairs - Valid pairs to process
     * @param {number} blockNumber - Current block number
     * @param {Set} excludePairs - Pairs to exclude from fetching
     * @param {Object|null} prioritizer - AdaptivePrioritizer instance or null
     */
    _separateFreshFromStale(validPairs, blockNumber, excludePairs, prioritizer) {
        const freshPrices = {};
        const pairsToFetch = [];

        for (const pair of validPairs) {
            const pairKey = pair.pairKey;
            const fullPairKey = `${pairKey}:${pair.dexName}`;

            // Skip if explicitly excluded (e.g., already processed via event)
            if (excludePairs.has(pairKey) || excludePairs.has(fullPairKey)) {
                // Still include from cache if available
                const cacheKey = cacheManager.getPriceKey(pair.tokenA.address, pair.tokenB.address, pair.dexName);
                const cached = cacheManager.priceCache.get(cacheKey);
                if (cached && cached.data) {
                    if (!freshPrices[pairKey]) freshPrices[pairKey] = {};
                    freshPrices[pairKey][pair.dexName] = cached.data;
                    this.stats.cacheHits++;
                }
                continue;
            }

            // Check priority-based skipping
            if (prioritizer && !prioritizer.shouldCheckPair(fullPairKey, blockNumber)) {
                // Still include stale cache data if available
                const cacheKey = cacheManager.getPriceKey(pair.tokenA.address, pair.tokenB.address, pair.dexName);
                const cached = cacheManager.priceCache.get(cacheKey);
                if (cached && cached.data) {
                    if (!freshPrices[pairKey]) freshPrices[pairKey] = {};
                    freshPrices[pairKey][pair.dexName] = cached.data;
                }
                this.stats.skippedByPriority++;
                continue;
            }

            // Check if we have fresh event-driven data for this pair
            const cacheKey = cacheManager.getPriceKey(pair.tokenA.address, pair.tokenB.address, pair.dexName);
            const cached = cacheManager.priceCache.get(cacheKey);

            // FIX v3.5: Allow configurable block tolerance for sync event data freshness
            // FIX v3.6: Use configurable maxBlockAge instead of hardcoded value
            // Sync events from block N are still valid at block N+1 or N+2 (configurable)
            // This reduces unnecessary RPC calls while maintaining data quality
            const isFreshSyncEvent = cached &&
                cached.data?.source === 'sync-event' &&
                cached.blockNumber !== undefined &&
                (blockNumber - cached.blockNumber) <= this.maxBlockAge;

            if (isFreshSyncEvent) {
                // Fresh data from Sync event - no need to fetch
                if (!freshPrices[pairKey]) freshPrices[pairKey] = {};
                freshPrices[pairKey][pair.dexName] = cached.data;
                this.stats.cacheHits++;
            } else {
                // Need to fetch via RPC
                pairsToFetch.push(pair);
            }
        }

        return { freshPrices, pairsToFetch };
    }

    /**
     * Merge fresh prices with fetched prices
     * @private
     */
    _mergePrices(freshPrices, fetchedPrices) {
        const merged = { ...freshPrices };

        for (const [pairKey, dexPrices] of Object.entries(fetchedPrices)) {
            if (!merged[pairKey]) {
                merged[pairKey] = dexPrices;
            } else {
                // Merge DEX prices
                merged[pairKey] = { ...merged[pairKey], ...dexPrices };
            }
        }

        return merged;
    }

    /**
     * Get fetcher statistics
     */
    getStats() {
        const hitRate = this.stats.totalFetches > 0
            ? (this.stats.cacheHits / (this.stats.cacheHits + this.stats.rpcCalls) * 100).toFixed(1)
            : 0;

        return {
            ...this.stats,
            cacheHitRate: `${hitRate}%`,
        };
    }

    /**
     * Reset statistics
     * FIX v3.6: Include batchesExecuted in reset
     */
    resetStats() {
        this.stats = {
            totalFetches: 0,
            cacheHits: 0,
            rpcCalls: 0,
            skippedByPriority: 0,
            batchesExecuted: 0,
        };
    }

    /**
     * Resolve pair addresses (cached or batched RPC)
     * @private
     */
    async _resolvePairs(tokenPairs) {
        const combinations = this.dexes.flatMap(([dexName, dexConfig]) =>
            tokenPairs.map(pair => ({ ...pair, dexName, dexConfig }))
        );

        const found = [];
        const missing = [];

        for (const combo of combinations) {
            const cached = cacheManager.getPairAddress(combo.tokenA.address, combo.tokenB.address, combo.dexName);
            if (cached === null || cached === false) continue;
            if (cached) found.push({ ...combo, address: cached });
            else missing.push(combo);
        }

        if (missing.length > 0) {
            const fetched = await this._batchFetchAddresses(missing);
            found.push(...fetched);
        }

        return found.filter(p => p.address && p.address !== ethers.ZeroAddress);
    }

    /**
     * Batch fetch pair addresses via Multicall
     * v2.1: Uses configurable batch sizes and inter-batch delays
     * @private
     */
    async _batchFetchAddresses(pairs) {
        const fetched = [];
        const totalBatches = Math.ceil(pairs.length / this.batchSize);

        for (let i = 0; i < pairs.length; i += this.batchSize) {
            const batch = pairs.slice(i, i + this.batchSize);
            const batchNumber = Math.floor(i / this.batchSize) + 1;
            const calls = batch.map(c => ({
                target: c.dexConfig.factory,
                callData: new ethers.Interface(FACTORY_ABI).encodeFunctionData('getPair', [c.tokenA.address, c.tokenB.address])
            }));

            try {
                const results = await rpcManager.withRetry(async (p) => {
                    return await new ethers.Contract(MULTICALL_ADDRESS, MULTICALL_ABI, p).tryAggregate(false, calls);
                });

                batch.forEach((combo, idx) => {
                    const { success, returnData } = results[idx];
                    let address = ethers.ZeroAddress;
                    if (success && returnData !== '0x') {
                        address = new ethers.Interface(FACTORY_ABI).decodeFunctionResult('getPair', returnData)[0];
                    }

                    if (address !== ethers.ZeroAddress) {
                        cacheManager.setPairAddress(combo.tokenA.address, combo.tokenB.address, combo.dexName, address);
                        fetched.push({ ...combo, address });
                    } else {
                        cacheManager.setPairAddress(combo.tokenA.address, combo.tokenB.address, combo.dexName, null);
                    }
                });

                // v2.1: Inter-batch delay to spread RPC load
                if (i + this.batchSize < pairs.length && this.interBatchDelayMs > 0) {
                    await new Promise(resolve => setTimeout(resolve, this.interBatchDelayMs));
                }

            } catch (err) {
                log.warn(`Address batch fetch failed (batch ${batchNumber}/${totalBatches})`, {
                    error: err.message,
                    batchSize: batch.length,
                });

                // v2.1: Add extra delay after failure
                if (i + this.batchSize < pairs.length) {
                    await new Promise(resolve => setTimeout(resolve, this.interBatchDelayMs * 3));
                }
            }
        }

        if (fetched.length > 0) {
            // FIX v3.1: Properly await async cache save
            await cacheManager.savePersistentCache();
        }

        return fetched;
    }

    /**
     * Fetch reserves for all pairs using multicall batches
     * v2.1: Uses configurable batch sizes and inter-batch delays
     * @private
     */
    async _fetchBatchedReserves(pairs) {
        const allResults = [];
        const iface = new ethers.Interface(PAIR_ABI);
        const totalBatches = Math.ceil(pairs.length / this.batchSize);

        for (let i = 0; i < pairs.length; i += this.batchSize) {
            const batch = pairs.slice(i, i + this.batchSize);
            const batchNumber = Math.floor(i / this.batchSize) + 1;
            const calls = batch.map(p => ({
                target: p.address,
                callData: iface.encodeFunctionData('getReserves')
            }));

            try {
                const results = await rpcManager.withRetry(async (provider) => {
                    const multicall = new ethers.Contract(MULTICALL_ADDRESS, MULTICALL_ABI, provider);
                    return await multicall.tryAggregate(false, calls);
                });
                allResults.push(...results);
                this.stats.batchesExecuted++;

                // Progress heartbeat for debug mode
                if (config.debugMode && batchNumber % 4 === 0) {
                    log.debug(`Price fetch progress: ${i + batch.length}/${pairs.length} pairs (batch ${batchNumber}/${totalBatches})`);
                }

                // v2.1: Inter-batch delay to spread RPC load and prevent rate limits
                if (i + this.batchSize < pairs.length && this.interBatchDelayMs > 0) {
                    await new Promise(resolve => setTimeout(resolve, this.interBatchDelayMs));
                }

            } catch (err) {
                // Log the error so it's not silently swallowed
                log.warn(`Multicall batch failed (batch ${batchNumber}/${totalBatches}, pairs ${i}-${i + batch.length})`, {
                    error: err.message,
                    batchSize: batch.length,
                });
                // Return failed results so indices stay aligned
                batch.forEach(() => allResults.push({ success: false, returnData: '0x' }));

                // v2.1: Add extra delay after failure to give RPC time to recover
                if (i + this.batchSize < pairs.length) {
                    await new Promise(resolve => setTimeout(resolve, this.interBatchDelayMs * 3));
                }
            }
        }
        return allResults;
    }

    /**
     * Parse raw reserves into price data
     * @private
     */
    _parseReserves(pairs, results, blockNumber) {
        const prices = {};
        const iface = new ethers.Interface(PAIR_ABI);

        pairs.forEach((pair, idx) => {
            const { success, returnData } = results[idx];
            let priceData = null;

            if (success && returnData !== '0x') {
                const reserves = iface.decodeFunctionResult('getReserves', returnData);
                priceData = this.calculatePrice(
                    { reserve0: reserves[0].toString(), reserve1: reserves[1].toString() },
                    pair.tokenA, pair.tokenB, pair.address
                );
            } else {
                // Fallback to stale cache if available
                priceData = cacheManager.getPrice(cacheManager.getPriceKey(pair.tokenA.address, pair.tokenB.address, pair.dexName), blockNumber, 1);
            }

            if (priceData) {
                if (!prices[pair.pairKey]) prices[pair.pairKey] = {};
                prices[pair.pairKey][pair.dexName] = priceData;
                cacheManager.setPrice(cacheManager.getPriceKey(pair.tokenA.address, pair.tokenB.address, pair.dexName), priceData, blockNumber);
            }
        });

        return prices;
    }

    /**
     * Calculate price and liquidity from reserves
     */
    calculatePrice(reserves, tokenA, tokenB, pairAddress) {
        if (!reserves || reserves.reserve0 === '0' || reserves.reserve1 === '0') return null;

        const r0 = BigInt(reserves.reserve0);
        const r1 = BigInt(reserves.reserve1);

        // Determine which reserve belongs to which token
        // In Uniswap V2, token0 address < token1 address
        const isToken0 = tokenA.address.toLowerCase() < tokenB.address.toLowerCase();

        const reserveA = isToken0 ? r0 : r1;
        const reserveB = isToken0 ? r1 : r0;

        // Calculate price: amount of B for 1 unit of A
        // price = (reserveB / 10^decB) / (reserveA / 10^decA)
        // price = (reserveB * 10^decA) / (reserveA * 10^decB)

        const factorA = 10n ** BigInt(tokenA.decimals);
        const factorB = 10n ** BigInt(tokenB.decimals);

        // Use higher precision for calculation
        const precision = 10n ** 18n;
        const priceBI = (reserveB * factorA * precision) / (reserveA * factorB);
        const price = Number(priceBI) / 1e18;

        // Calculate liquidity in USD (approximate using reserve values)
        // For accurate USD value, we'd need external price feeds
        // This uses a heuristic: assume base tokens (WBNB, USDT, etc.) have known prices
        const liquidityUSD = this._estimateLiquidityUSD(reserveA, reserveB, tokenA, tokenB);

        return {
            price,
            reserveA: reserveA.toString(),
            reserveB: reserveB.toString(),
            liquidityUSD,
            pairAddress,
            timestamp: Date.now()
        };
    }

    /**
     * Get all token pairs to monitor - Dynamic generation from config.tokens against baseAssets
     * @private
     */
    _getTokenPairs() {
        const tokens = Object.values(config.tokens);
        const baseSymbols = config.baseTokens || ['WBNB', 'USDT'];
        const baseTokens = tokens.filter(t => baseSymbols.includes(t.symbol));

        const pairs = [];
        const seen = new Set();

        for (const token of tokens) {
            for (const base of baseTokens) {
                if (token.address === base.address) continue;

                const [t1, t2] = token.address.toLowerCase() < base.address.toLowerCase()
                    ? [token, base] : [base, token];

                const key = `${t1.symbol}/${t2.symbol}`;
                if (!seen.has(key)) {
                    pairs.push({ tokenA: t1, tokenB: t2, pairKey: key });
                    seen.add(key);
                }
            }
        }

        log.debug(`Generated ${pairs.length} unique pairs to monitor against ${baseSymbols.length} base assets`);
        return pairs;
    }

    /**
     * Estimate liquidity in USD for a pair
     * Uses centralized token prices for consistency
     * @private
     */
    _estimateLiquidityUSD(reserveA, reserveB, tokenA, tokenB) {
        // Use centralized price constants for consistency across the codebase
        const priceA = getFallbackPrice(tokenA.symbol, null);
        const priceB = getFallbackPrice(tokenB.symbol, null);

        // Convert reserves to float
        const resAFloat = Number(reserveA) / Math.pow(10, tokenA.decimals);
        const resBFloat = Number(reserveB) / Math.pow(10, tokenB.decimals);

        // Calculate liquidity based on known prices
        if (priceA !== null && priceB !== null) {
            // Both tokens have known prices - use average
            return (resAFloat * priceA) + (resBFloat * priceB);
        } else if (priceA !== null) {
            // Only tokenA has known price - double it (assume 50/50 pool)
            return resAFloat * priceA * 2;
        } else if (priceB !== null) {
            // Only tokenB has known price - double it
            return resBFloat * priceB * 2;
        }

        // Neither token has known price - return conservative estimate
        // Assume $1 per token unit as fallback
        return (resAFloat + resBFloat) * 0.5;
    }
}

// Export singleton instance
const priceFetcher = new PriceFetcher();
export default priceFetcher;
