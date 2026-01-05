import NodeCache from 'node-cache';
import fs from 'fs';
import path from 'path';
import config from '../config.js';
import log from '../utils/logger.js';

/**
 * Cache Manager with block-based invalidation and LRU eviction
 */
class CacheManager {
    constructor() {
        this.cacheDir = path.join(process.cwd(), 'data');
        this.pairCacheFile = path.join(this.cacheDir, 'pair-cache.json');

        // Price cache with TTL
        this.priceCache = new NodeCache({
            stdTTL: 30,
            checkperiod: 10,
            useClones: false,
            maxKeys: config.monitoring.cacheSize,
        });

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
            cachedPairs: this.pairAddressCache.keys().length
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
     */
    savePersistentCache() {
        try {
            const keys = this.pairAddressCache.keys();
            const data = {};
            keys.forEach(k => {
                data[k] = this.pairAddressCache.get(k);
            });
            fs.writeFileSync(this.pairCacheFile, JSON.stringify(data, null, 2));
            log.debug(`Saved ${keys.length} pair addresses to disk`);
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
     * Get cache statistics
     */
    getStats() {
        return {
            prices: {
                keys: this.priceCache.keys().length,
                hits: this.priceCache.getStats().hits,
                misses: this.priceCache.getStats().misses,
                hitRate: (this.priceCache.getStats().hits /
                    (this.priceCache.getStats().hits + this.priceCache.getStats().misses) * 100).toFixed(2) + '%',
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
