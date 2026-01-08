import log from './logger.js';

/**
 * GasPriceCache - High-performance gas price caching for speed optimization
 *
 * Features:
 * 1. TTL-based caching (default 2s) to avoid redundant RPC calls
 * 2. Request coalescing - concurrent requests share a single RPC call
 * 3. Fallback to cached value on RPC failure
 * 4. Performance metrics tracking
 *
 * Performance Impact:
 * - Eliminates 100-200ms RPC call per detection cycle
 * - Shared across detection + execution phases
 */
class GasPriceCache {
    constructor(options = {}) {
        // Cache configuration
        this.ttlMs = options.ttlMs || 2000; // 2 seconds default
        this.staleTtlMs = options.staleTtlMs || 10000; // 10s stale fallback

        // Cache state
        this.cache = null;
        this.timestamp = 0;
        this.pendingFetch = null;

        // Metrics
        this.stats = {
            hits: 0,
            misses: 0,
            coalescedRequests: 0,
            staleFallbacks: 0,
            fetchErrors: 0,
            avgFetchTimeMs: 0,
            totalFetchTimeMs: 0,
            fetchCount: 0,
        };

        log.debug('GasPriceCache initialized', { ttlMs: this.ttlMs });
    }

    /**
     * Get gas price with caching
     *
     * @param {Function} fetchFn - Async function to fetch gas price (receives provider)
     * @param {Object} provider - ethers provider (optional, passed to fetchFn)
     * @returns {Object} Gas price data { gasPrice, maxFeePerGas, maxPriorityFeePerGas }
     */
    async getGasPrice(fetchFn, provider = null) {
        const now = Date.now();

        // 1. Return cached if fresh
        if (this.cache && (now - this.timestamp) < this.ttlMs) {
            this.stats.hits++;
            return this.cache;
        }

        // 2. Coalesce concurrent requests
        if (this.pendingFetch) {
            this.stats.coalescedRequests++;
            return this.pendingFetch;
        }

        // 3. Fetch new gas price
        this.stats.misses++;
        this.pendingFetch = this._fetchGasPrice(fetchFn, provider, now);

        try {
            const result = await this.pendingFetch;
            return result;
        } finally {
            this.pendingFetch = null;
        }
    }

    /**
     * Internal fetch with timing and error handling
     * @private
     */
    async _fetchGasPrice(fetchFn, provider, requestTime) {
        const fetchStart = performance.now();

        try {
            const feeData = await fetchFn(provider);

            // Update cache
            this.cache = {
                gasPrice: feeData.gasPrice,
                maxFeePerGas: feeData.maxFeePerGas,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
                timestamp: Date.now(),
                source: 'fresh',
            };
            this.timestamp = Date.now();

            // Update metrics
            const fetchTimeMs = performance.now() - fetchStart;
            this.stats.totalFetchTimeMs += fetchTimeMs;
            this.stats.fetchCount++;
            this.stats.avgFetchTimeMs = this.stats.totalFetchTimeMs / this.stats.fetchCount;

            return this.cache;

        } catch (error) {
            this.stats.fetchErrors++;

            // Return stale cache if available and not too old
            if (this.cache && (Date.now() - this.timestamp) < this.staleTtlMs) {
                this.stats.staleFallbacks++;
                log.warn('GasPriceCache: Using stale cache due to fetch error', {
                    error: error.message,
                    cacheAge: Date.now() - this.timestamp,
                });
                return { ...this.cache, source: 'stale' };
            }

            // Re-throw if no fallback available
            throw error;
        }
    }

    /**
     * Manually set gas price (useful for WebSocket updates)
     *
     * @param {Object} gasData - Gas price data
     */
    setGasPrice(gasData) {
        this.cache = {
            gasPrice: gasData.gasPrice,
            maxFeePerGas: gasData.maxFeePerGas,
            maxPriorityFeePerGas: gasData.maxPriorityFeePerGas,
            timestamp: Date.now(),
            source: 'manual',
        };
        this.timestamp = Date.now();
    }

    /**
     * Check if cache is fresh (for conditional fetching)
     */
    isFresh() {
        return this.cache && (Date.now() - this.timestamp) < this.ttlMs;
    }

    /**
     * Get cached value without fetching
     */
    getCached() {
        return this.cache;
    }

    /**
     * Get cache statistics
     */
    getStats() {
        const total = this.stats.hits + this.stats.misses;
        return {
            ...this.stats,
            hitRate: total > 0 ? ((this.stats.hits / total) * 100).toFixed(1) + '%' : '0%',
            cacheAge: this.cache ? Date.now() - this.timestamp : null,
            isFresh: this.isFresh(),
        };
    }

    /**
     * Reset statistics
     */
    resetStats() {
        this.stats = {
            hits: 0,
            misses: 0,
            coalescedRequests: 0,
            staleFallbacks: 0,
            fetchErrors: 0,
            avgFetchTimeMs: 0,
            totalFetchTimeMs: 0,
            fetchCount: 0,
        };
    }

    /**
     * Clear cache
     */
    clear() {
        this.cache = null;
        this.timestamp = 0;
        this.pendingFetch = null;
    }
}

// Export singleton instance (shared across detection + execution)
const gasPriceCache = new GasPriceCache();
export default gasPriceCache;

// Also export class for custom instances
export { GasPriceCache };
