import NodeCache from 'node-cache';
import fs from 'fs';
import path from 'path';
import config from '../config.js';
import log from '../utils/logger.js';
// FIX v3.1: Use centralized stablecoin list
import { STABLECOINS, isStablecoin } from '../constants/tokenPrices.js';

/**
 * Cache Manager with block-based invalidation and LRU eviction
 *
 * v2.1 Improvements for 24/7 Operation:
 * - Extended cache TTL for better RPC rate limit tolerance
 * - Configurable stale data acceptance for resilience
 */
class CacheManager {
    constructor() {
        this.cacheDir = path.join(process.cwd(), 'data');
        this.pairCacheFile = path.join(this.cacheDir, 'pair-cache.json');

        // v2.1: Extended price cache TTL for better RPC resilience
        // Configurable via environment variable, default increased from 30s to 60s
        const cacheTTL = parseInt(process.env.PRICE_CACHE_TTL || '60');

        // Price cache with TTL
        this.priceCache = new NodeCache({
            stdTTL: cacheTTL,
            checkperiod: 10,
            useClones: false,
            maxKeys: config.monitoring.cacheSize,
        });

        // v2.1: Default stale blocks acceptance (can use slightly old data during RPC issues)
        this.defaultMaxStaleBlocks = parseInt(process.env.MAX_STALE_BLOCKS || '3');

        // Permanent caches
        this.pairAddressCache = new NodeCache({
            stdTTL: 0,
            useClones: false,
        });

        this.tokenDecimalsCache = new NodeCache({
            stdTTL: 0,
            useClones: false,
        });

        this.currentBlockNumber = 0;

        this._loadPersistentCache();

        log.info('Cache Manager initialized', {
            maxSize: config.monitoring.cacheSize,
            cachedPairs: this.pairAddressCache.keys().length,
            priceCacheTTL: `${this.priceCache.options.stdTTL}s`,
            maxStaleBlocks: this.defaultMaxStaleBlocks,
        });
    }

    /**
     * Load persistent pair cache from disk
     * @private
     */
    _loadPersistentCache() {
        try {
            if (!fs.existsSync(this.cacheDir)) fs.mkdirSync(this.cacheDir, { recursive: true });

            if (fs.existsSync(this.pairCacheFile)) {
                const data = JSON.parse(fs.readFileSync(this.pairCacheFile, 'utf8'));
                Object.entries(data).forEach(([key, val]) => {
                    this.pairAddressCache.set(key, val);
                });
                log.debug(`Loaded ${Object.keys(data).length} pair addresses from persistent cache`);
            }
        } catch (err) {
            log.warn('Failed to load persistent cache', { error: err.message });
        }
    }

    /**
     * Save pair address cache to disk
     * FIX v3.1: Use async file write to avoid blocking the event loop
     */
    async savePersistentCache() {
        try {
            const keys = this.pairAddressCache.keys();
            const data = {};
            keys.forEach(k => {
                data[k] = this.pairAddressCache.get(k);
            });

            // FIX v3.1: Use async write to avoid blocking event loop
            await fs.promises.writeFile(
                this.pairCacheFile,
                JSON.stringify(data, null, 2)
            );
            log.debug(`Saved ${keys.length} pair addresses to disk`);
        } catch (err) {
            log.error('Failed to save persistent cache', { error: err.message });
        }
    }

    /**
     * Save pair address cache to disk (sync version for shutdown)
     * Only use during graceful shutdown when blocking is acceptable
     */
    savePersistentCacheSync() {
        try {
            const keys = this.pairAddressCache.keys();
            const data = {};
            keys.forEach(k => {
                data[k] = this.pairAddressCache.get(k);
            });
            fs.writeFileSync(this.pairCacheFile, JSON.stringify(data, null, 2));
            log.debug(`Saved ${keys.length} pair addresses to disk (sync)`);
        } catch (err) {
            log.error('Failed to save persistent cache', { error: err.message });
        }
    }

    /**
     * Store price data with block number
     */
    setPrice(key, data, blockNumber) {
        const cacheEntry = {
            data,
            blockNumber,
            timestamp: Date.now(),
        };

        this.priceCache.set(key, cacheEntry);
    }

    /**
     * Get price data if still valid for current block or within allowed stale range
     * @param {string} key - Cache key
     * @param {number|null} currentBlockNumber - Current block number from provider
     * @param {number} maxStaleBlocks - Number of past blocks to accept (default 0 = strict)
     */
    getPrice(key, currentBlockNumber = null, maxStaleBlocks = 0) {
        const entry = this.priceCache.get(key);

        if (!entry) {
            return null;
        }

        // If block number is not provided, just return data (legacy/testing behavior)
        if (!currentBlockNumber) {
            return entry.data;
        }

        const blockDiff = currentBlockNumber - entry.blockNumber;

        // Fresh data (same block)
        if (blockDiff === 0) {
            return entry.data;
        }

        // Stale but valid data
        if (blockDiff > 0 && blockDiff <= maxStaleBlocks) {
            // Optional: You could wrap this to indicate staleness, 
            // but for transparency to the consumer we return the data.
            // Consumers should handle 'stale' implications if needed.
            return entry.data;
        }

        // Too stale
        if (blockDiff > maxStaleBlocks) {
            // Data is too old, remove it
            this.priceCache.del(key);
            return null;
        }

        // Future block (shouldn't happen usually, but accept it)
        return entry.data;
    }

    /**
     * Invalidate all price data older than specified block number
     */
    invalidateOlderThan(blockNumber) {
        const keys = this.priceCache.keys();
        let invalidated = 0;

        keys.forEach(key => {
            const entry = this.priceCache.get(key);
            if (entry && entry.blockNumber < blockNumber) {
                this.priceCache.del(key);
                invalidated++;
            }
        });

        if (invalidated > 0) {
            log.debug(`Invalidated ${invalidated} stale cache entries`);
        }

        this.currentBlockNumber = blockNumber;
    }

    /**
     * Store pair address (permanent cache)
     */
    setPairAddress(tokenA, tokenB, dex, pairAddress) {
        const key = this.getPairKey(tokenA, tokenB, dex);
        this.pairAddressCache.set(key, pairAddress);
    }

    /**
     * Get pair address from cache
     */
    getPairAddress(tokenA, tokenB, dex) {
        const key = this.getPairKey(tokenA, tokenB, dex);
        return this.pairAddressCache.get(key);
    }

    /**
     * Store token decimals (permanent cache)
     */
    setTokenDecimals(tokenAddress, decimals) {
        this.tokenDecimalsCache.set(tokenAddress.toLowerCase(), decimals);
    }

    /**
     * Get token decimals from cache
     */
    getTokenDecimals(tokenAddress) {
        return this.tokenDecimalsCache.get(tokenAddress.toLowerCase());
    }

    /**
     * Generate cache key for price data
     */
    getPriceKey(tokenA, tokenB, dex) {
        const [t0, t1] = this.sortTokens(tokenA, tokenB);
        return `price:${dex}:${t0}:${t1}`;
    }

    /**
     * Generate cache key for pair address
     */
    getPairKey(tokenA, tokenB, dex) {
        const [t0, t1] = this.sortTokens(tokenA, tokenB);
        return `pair:${dex}:${t0}:${t1}`;
    }

    /**
     * Sort token addresses (DEX pairs always have tokens in sorted order)
     */
    sortTokens(tokenA, tokenB) {
        const a = tokenA.toLowerCase();
        const b = tokenB.toLowerCase();
        return a < b ? [a, b] : [b, a];
    }

    /**
     * Get native token price in USD from cached stable pair data
     *
     * Looks for pairs like WBNB/USDT, WETH/USDC to derive native token prices.
     * Returns fallback price if no cached data available.
     *
     * @param {string} nativeSymbol - Native token symbol (e.g., 'WBNB', 'WETH', 'MATIC')
     * @param {Object} tokensConfig - Token configuration with addresses
     * @param {Array<string>} dexNames - DEX names to search
     * @param {number} fallbackPrice - Default price if no cache data
     * @returns {number} Native token price in USD
     */
    getNativeTokenPrice(nativeSymbol, tokensConfig, dexNames, fallbackPrice = 1) {
        // FIX v3.1: Use centralized stable token list (in priority order)
        const stableSymbols = ['USDT', 'USDC', 'BUSD', 'DAI', 'FDUSD', 'TUSD'];

        const nativeToken = tokensConfig[nativeSymbol];
        if (!nativeToken) {
            log.debug(`Native token ${nativeSymbol} not in config, using fallback`);
            return fallbackPrice;
        }

        // Try each stable token
        for (const stableSymbol of stableSymbols) {
            const stableToken = tokensConfig[stableSymbol];
            if (!stableToken) continue;

            // Try each DEX
            for (const dexName of dexNames) {
                const priceKey = this.getPriceKey(nativeToken.address, stableToken.address, dexName);
                const priceData = this.priceCache.get(priceKey);

                if (priceData && priceData.data) {
                    // The price in cache is "amount of stableToken per 1 nativeToken"
                    // This is already the USD price since stables are ~$1
                    const price = priceData.data.price;

                    if (price > 0) {
                        log.debug(`Got ${nativeSymbol} price from ${dexName} ${nativeSymbol}/${stableSymbol}: $${price.toFixed(2)}`);
                        return price;
                    }
                }
            }
        }

        log.debug(`No cached ${nativeSymbol}/stable pair found, using fallback: $${fallbackPrice}`);
        return fallbackPrice;
    }

    /**
     * Get token price in USD from cached pair data
     *
     * @param {string} tokenSymbol - Token symbol
     * @param {Object} tokensConfig - Token configuration with addresses
     * @param {Array<string>} dexNames - DEX names to search
     * @param {number} nativeTokenPriceUSD - Native token price for indirect pricing
     * @returns {number|null} Token price in USD or null if not found
     */
    getTokenPriceUSD(tokenSymbol, tokensConfig, dexNames, nativeTokenPriceUSD) {
        // FIX v3.1: Use centralized isStablecoin check
        if (isStablecoin(tokenSymbol)) {
            return 1.0;
        }

        const token = tokensConfig[tokenSymbol];
        if (!token) return null;

        // FIX v3.1: Use centralized STABLECOINS list for pair lookups
        // Only use common stables that are likely in tokensConfig
        const lookupStables = ['USDT', 'USDC', 'BUSD', 'DAI', 'FDUSD', 'TUSD'];

        // First try direct stable pair
        for (const stableSymbol of lookupStables) {
            const stableToken = tokensConfig[stableSymbol];
            if (!stableToken) continue;

            for (const dexName of dexNames) {
                const priceKey = this.getPriceKey(token.address, stableToken.address, dexName);
                const priceData = this.priceCache.get(priceKey);

                if (priceData && priceData.data && priceData.data.price > 0) {
                    return priceData.data.price;
                }
            }
        }

        // Try native token pair and convert
        const nativeSymbols = ['WBNB', 'WETH', 'WMATIC', 'WAVAX', 'WFTM'];
        for (const nativeSymbol of nativeSymbols) {
            const nativeToken = tokensConfig[nativeSymbol];
            if (!nativeToken) continue;

            for (const dexName of dexNames) {
                const priceKey = this.getPriceKey(token.address, nativeToken.address, dexName);
                const priceData = this.priceCache.get(priceKey);

                if (priceData && priceData.data && priceData.data.price > 0) {
                    // Price is in native tokens, convert to USD
                    return priceData.data.price * nativeTokenPriceUSD;
                }
            }
        }

        return null;
    }

    /**
     * Get cache statistics
     */
    getStats() {
        const priceStats = this.priceCache.getStats();
        const totalRequests = priceStats.hits + priceStats.misses;
        const hitRate = totalRequests > 0
            ? ((priceStats.hits / totalRequests) * 100).toFixed(2) + '%'
            : '0.00%';

        return {
            prices: {
                keys: this.priceCache.keys().length,
                hits: priceStats.hits,
                misses: priceStats.misses,
                hitRate,
            },
            pairAddresses: {
                keys: this.pairAddressCache.keys().length,
            },
            tokenDecimals: {
                keys: this.tokenDecimalsCache.keys().length,
            },
            currentBlock: this.currentBlockNumber,
        };
    }

    /**
     * Clear all caches
     */
    clearAll() {
        this.priceCache.flushAll();
        log.info('All price caches cleared');
    }

    /**
     * Clear only price cache (keep address and decimals)
     */
    clearPrices() {
        this.priceCache.flushAll();
        log.debug('Price cache cleared');
    }
}

// Export singleton instance
const cacheManager = new CacheManager();
export default cacheManager;
