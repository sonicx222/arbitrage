import { EventEmitter } from 'events';
import log from '../utils/logger.js';
import config from '../config.js';

/**
 * Cross-Pool Correlation Analyzer
 *
 * Builds and maintains a correlation matrix of price movements between pools.
 * When Pool A's reserves change, this module identifies which correlated pools
 * are likely to have arbitrage opportunities BEFORE their reserves update.
 *
 * How it works:
 * 1. Track historical price changes for each pool
 * 2. Calculate correlation coefficients between pools
 * 3. When a Sync event is received, immediately check correlated pools
 * 4. First detector wins - the lag window is when arbitrage is most profitable
 *
 * Correlation Types:
 * - Same-pair correlation: WBNB/USDT on PancakeSwap correlates with WBNB/USDT on Biswap
 * - Token correlation: WBNB pairs correlate with each other (WBNB/USDT, WBNB/BUSD)
 * - Market correlation: Major tokens move together during market events
 *
 * Expected Impact: +20-30% more opportunities from predictive detection
 */
class CrossPoolCorrelation extends EventEmitter {
    constructor(options = {}) {
        super();

        // Correlation matrix: pool -> { correlatedPool -> correlationScore }
        this.correlationMatrix = new Map();

        // Price history for correlation calculation
        // pool -> Array<{ price, timestamp, blockNumber }>
        this.priceHistory = new Map();

        // Configuration
        this.historyLength = options.historyLength || 100; // Keep last N price points
        this.minHistoryForCorrelation = options.minHistoryForCorrelation || 20;
        this.correlationThreshold = options.correlationThreshold || 0.7; // Min correlation to consider
        this.priceChangeThreshold = options.priceChangeThreshold || 0.1; // 0.1% min change to record
        this.correlationUpdateInterval = options.correlationUpdateInterval || 60000; // Recalculate every minute

        // Pool groupings for implicit correlation
        this.poolGroups = {
            // Same base token pools are naturally correlated
            baseTokenPools: new Map(), // baseToken -> Set<poolKey>
            // Same pair across DEXs
            pairDexPools: new Map(), // pairKey -> Set<poolKey>
        };

        // Statistics
        this.stats = {
            priceUpdatesProcessed: 0,
            correlationChecks: 0,
            correlatedOpportunities: 0,
            matrixSize: 0,
            lastCorrelationUpdate: null,
        };

        // Correlation update timer
        this.updateTimer = null;

        log.info('CrossPoolCorrelation initialized', {
            historyLength: this.historyLength,
            correlationThreshold: this.correlationThreshold,
        });
    }

    /**
     * Start the correlation analyzer
     */
    start() {
        if (this.updateTimer) return;

        // Periodically recalculate correlation matrix
        this.updateTimer = setInterval(() => {
            this.updateCorrelationMatrix();
        }, this.correlationUpdateInterval);

        this.updateTimer.unref();
        log.debug('CrossPoolCorrelation started');
    }

    /**
     * Stop the correlation analyzer
     */
    stop() {
        if (this.updateTimer) {
            clearInterval(this.updateTimer);
            this.updateTimer = null;
        }
        log.debug('CrossPoolCorrelation stopped');
    }

    /**
     * Record a price update for a pool
     *
     * @param {Object} data - Price update data
     * @param {string} data.pairKey - Pair identifier (e.g., "WBNB/USDT")
     * @param {string} data.dexName - DEX name
     * @param {number} data.price - Current price
     * @param {number} data.blockNumber - Block number
     * @param {number} data.timestamp - Timestamp (optional)
     */
    recordPriceUpdate(data) {
        const { pairKey, dexName, price, blockNumber, timestamp = Date.now() } = data;
        const poolKey = `${pairKey}:${dexName}`;

        this.stats.priceUpdatesProcessed++;

        // Get or create history
        if (!this.priceHistory.has(poolKey)) {
            this.priceHistory.set(poolKey, []);
        }

        const history = this.priceHistory.get(poolKey);

        // Check if price changed significantly
        if (history.length > 0) {
            const lastPrice = history[history.length - 1].price;
            const changePercent = Math.abs((price - lastPrice) / lastPrice) * 100;

            if (changePercent < this.priceChangeThreshold) {
                return; // Price didn't change enough
            }
        }

        // Add to history
        history.push({ price, timestamp, blockNumber });

        // Trim history if too long
        while (history.length > this.historyLength) {
            history.shift();
        }

        // Update pool groupings
        this._updatePoolGroups(poolKey, pairKey, dexName);
    }

    /**
     * Get correlated pools that should be checked when a pool updates
     *
     * @param {string} pairKey - Pair identifier
     * @param {string} dexName - DEX name
     * @param {Object} options - Options
     * @returns {Array} Correlated pools with scores
     */
    getCorrelatedPools(pairKey, dexName, options = {}) {
        const { minScore = this.correlationThreshold, limit = 10 } = options;
        const poolKey = `${pairKey}:${dexName}`;

        this.stats.correlationChecks++;

        const correlated = [];

        // 1. Get from correlation matrix (statistical correlation)
        const matrixCorrelations = this.correlationMatrix.get(poolKey);
        if (matrixCorrelations) {
            for (const [correlatedPool, score] of matrixCorrelations) {
                if (score >= minScore && correlatedPool !== poolKey) {
                    correlated.push({
                        poolKey: correlatedPool,
                        score,
                        type: 'statistical',
                    });
                }
            }
        }

        // 2. Add implicit correlations (same pair on different DEXs)
        const pairPools = this.poolGroups.pairDexPools.get(pairKey);
        if (pairPools) {
            for (const otherPool of pairPools) {
                if (otherPool !== poolKey) {
                    // Same pair on different DEX has high implicit correlation
                    const existing = correlated.find(c => c.poolKey === otherPool);
                    if (!existing) {
                        correlated.push({
                            poolKey: otherPool,
                            score: 0.95, // High implicit correlation
                            type: 'same-pair',
                        });
                    } else {
                        existing.score = Math.max(existing.score, 0.95);
                    }
                }
            }
        }

        // 3. Add base token correlations
        const [tokenA, tokenB] = pairKey.split('/');
        for (const baseToken of [tokenA, tokenB]) {
            const basePools = this.poolGroups.baseTokenPools.get(baseToken);
            if (basePools) {
                for (const otherPool of basePools) {
                    if (otherPool !== poolKey) {
                        const existing = correlated.find(c => c.poolKey === otherPool);
                        if (!existing) {
                            correlated.push({
                                poolKey: otherPool,
                                score: 0.6, // Moderate correlation
                                type: 'base-token',
                            });
                        }
                    }
                }
            }
        }

        // Sort by score and limit
        return correlated
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
    }

    /**
     * Process a reserve update and emit correlated opportunity signals
     *
     * @param {Object} data - Reserve update data
     * @returns {Array} Correlated pools to check
     */
    processReserveUpdate(data) {
        const { pairKey, dexName, price, blockNumber } = data;

        // Record the price update
        this.recordPriceUpdate(data);

        // Get correlated pools
        const correlated = this.getCorrelatedPools(pairKey, dexName);

        if (correlated.length > 0) {
            // Emit event for each highly correlated pool
            for (const pool of correlated) {
                if (pool.score >= this.correlationThreshold) {
                    this.emit('checkCorrelated', {
                        sourcePool: `${pairKey}:${dexName}`,
                        targetPool: pool.poolKey,
                        correlationScore: pool.score,
                        correlationType: pool.type,
                        sourcePrice: price,
                        blockNumber,
                        timestamp: Date.now(),
                    });
                }
            }
        }

        return correlated;
    }

    /**
     * Update pool groupings for implicit correlation
     * @private
     */
    _updatePoolGroups(poolKey, pairKey, dexName) {
        // Group by pair (same pair across DEXs)
        if (!this.poolGroups.pairDexPools.has(pairKey)) {
            this.poolGroups.pairDexPools.set(pairKey, new Set());
        }
        this.poolGroups.pairDexPools.get(pairKey).add(poolKey);

        // Group by base token
        const [tokenA, tokenB] = pairKey.split('/');
        for (const token of [tokenA, tokenB]) {
            if (!this.poolGroups.baseTokenPools.has(token)) {
                this.poolGroups.baseTokenPools.set(token, new Set());
            }
            this.poolGroups.baseTokenPools.get(token).add(poolKey);
        }
    }

    /**
     * Update the correlation matrix based on historical data
     */
    updateCorrelationMatrix() {
        const pools = Array.from(this.priceHistory.keys());

        // Only calculate for pools with enough history
        const eligiblePools = pools.filter(p =>
            this.priceHistory.get(p).length >= this.minHistoryForCorrelation
        );

        if (eligiblePools.length < 2) {
            return;
        }

        // Calculate correlations between all eligible pool pairs
        for (let i = 0; i < eligiblePools.length; i++) {
            const poolA = eligiblePools[i];
            const historyA = this.priceHistory.get(poolA);

            if (!this.correlationMatrix.has(poolA)) {
                this.correlationMatrix.set(poolA, new Map());
            }

            for (let j = i + 1; j < eligiblePools.length; j++) {
                const poolB = eligiblePools[j];
                const historyB = this.priceHistory.get(poolB);

                // Calculate correlation coefficient
                const correlation = this._calculateCorrelation(historyA, historyB);

                if (correlation !== null && Math.abs(correlation) >= this.correlationThreshold) {
                    // Store bidirectionally
                    this.correlationMatrix.get(poolA).set(poolB, correlation);

                    if (!this.correlationMatrix.has(poolB)) {
                        this.correlationMatrix.set(poolB, new Map());
                    }
                    this.correlationMatrix.get(poolB).set(poolA, correlation);
                }
            }
        }

        // Update stats
        this.stats.matrixSize = this.correlationMatrix.size;
        this.stats.lastCorrelationUpdate = Date.now();

        log.debug('Correlation matrix updated', {
            poolsAnalyzed: eligiblePools.length,
            correlationsFound: this._countCorrelations(),
        });
    }

    /**
     * Calculate Pearson correlation coefficient between two price histories
     * @private
     */
    _calculateCorrelation(historyA, historyB) {
        // Get price changes (returns) instead of absolute prices
        const returnsA = this._calculateReturns(historyA);
        const returnsB = this._calculateReturns(historyB);

        // Align by timestamp (use overlapping periods)
        const aligned = this._alignTimeSeries(returnsA, returnsB);

        if (aligned.a.length < this.minHistoryForCorrelation) {
            return null;
        }

        // Calculate Pearson correlation
        const n = aligned.a.length;
        const sumA = aligned.a.reduce((s, v) => s + v, 0);
        const sumB = aligned.b.reduce((s, v) => s + v, 0);
        const sumAB = aligned.a.reduce((s, v, i) => s + v * aligned.b[i], 0);
        const sumA2 = aligned.a.reduce((s, v) => s + v * v, 0);
        const sumB2 = aligned.b.reduce((s, v) => s + v * v, 0);

        const numerator = n * sumAB - sumA * sumB;
        const denominator = Math.sqrt(
            (n * sumA2 - sumA * sumA) * (n * sumB2 - sumB * sumB)
        );

        if (denominator === 0) {
            return 0;
        }

        return numerator / denominator;
    }

    /**
     * Calculate price returns from history
     * @private
     */
    _calculateReturns(history) {
        const returns = [];
        for (let i = 1; i < history.length; i++) {
            const prevPrice = history[i - 1].price;
            const currPrice = history[i].price;
            if (prevPrice !== 0) {
                returns.push({
                    return: (currPrice - prevPrice) / prevPrice,
                    timestamp: history[i].timestamp,
                    blockNumber: history[i].blockNumber,
                });
            }
        }
        return returns;
    }

    /**
     * Align two time series by timestamp
     * @private
     */
    _alignTimeSeries(seriesA, seriesB) {
        // Simple alignment: find overlapping block numbers
        const blockMapA = new Map(seriesA.map(s => [s.blockNumber, s.return]));
        const blockMapB = new Map(seriesB.map(s => [s.blockNumber, s.return]));

        const alignedA = [];
        const alignedB = [];

        for (const [block, returnA] of blockMapA) {
            const returnB = blockMapB.get(block);
            if (returnB !== undefined) {
                alignedA.push(returnA);
                alignedB.push(returnB);
            }
        }

        return { a: alignedA, b: alignedB };
    }

    /**
     * Count total correlations in matrix
     * @private
     */
    _countCorrelations() {
        let count = 0;
        for (const correlations of this.correlationMatrix.values()) {
            count += correlations.size;
        }
        return count / 2; // Bidirectional, so divide by 2
    }

    /**
     * Get the correlation score between two pools
     *
     * @param {string} poolA - First pool key
     * @param {string} poolB - Second pool key
     * @returns {number|null} Correlation score or null
     */
    getCorrelation(poolA, poolB) {
        const correlations = this.correlationMatrix.get(poolA);
        if (!correlations) return null;
        return correlations.get(poolB) ?? null;
    }

    /**
     * Get top correlated pairs for a given pool
     *
     * @param {string} poolKey - Pool key
     * @param {number} limit - Max pairs to return
     * @returns {Array} Top correlated pools
     */
    getTopCorrelated(poolKey, limit = 5) {
        const correlations = this.correlationMatrix.get(poolKey);
        if (!correlations) return [];

        return Array.from(correlations.entries())
            .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
            .slice(0, limit)
            .map(([pool, score]) => ({ pool, score }));
    }

    /**
     * Get statistics
     */
    getStats() {
        return {
            ...this.stats,
            poolsTracked: this.priceHistory.size,
            pairGroups: this.poolGroups.pairDexPools.size,
            baseTokenGroups: this.poolGroups.baseTokenPools.size,
        };
    }

    /**
     * Export correlation data for persistence
     */
    export() {
        const data = {
            priceHistory: {},
            correlationMatrix: {},
        };

        // Export price history
        for (const [pool, history] of this.priceHistory) {
            data.priceHistory[pool] = history.slice(-50); // Keep last 50
        }

        // Export correlation matrix
        for (const [pool, correlations] of this.correlationMatrix) {
            data.correlationMatrix[pool] = Object.fromEntries(correlations);
        }

        return data;
    }

    /**
     * Import correlation data from persistence
     */
    import(data) {
        if (data.priceHistory) {
            for (const [pool, history] of Object.entries(data.priceHistory)) {
                this.priceHistory.set(pool, history);
            }
        }

        if (data.correlationMatrix) {
            for (const [pool, correlations] of Object.entries(data.correlationMatrix)) {
                this.correlationMatrix.set(pool, new Map(Object.entries(correlations)));
            }
        }

        // Rebuild pool groups
        for (const poolKey of this.priceHistory.keys()) {
            const [pairKey, dexName] = poolKey.split(':');
            if (pairKey && dexName) {
                this._updatePoolGroups(poolKey, pairKey, dexName);
            }
        }

        this.stats.matrixSize = this.correlationMatrix.size;
        log.info('Correlation data imported', {
            pools: this.priceHistory.size,
            correlations: this._countCorrelations(),
        });
    }

    /**
     * Reset all data
     */
    reset() {
        this.priceHistory.clear();
        this.correlationMatrix.clear();
        this.poolGroups.baseTokenPools.clear();
        this.poolGroups.pairDexPools.clear();
        this.stats.priceUpdatesProcessed = 0;
        this.stats.correlationChecks = 0;
        this.stats.correlatedOpportunities = 0;
        this.stats.matrixSize = 0;
        log.info('CrossPoolCorrelation reset');
    }
}

// Export singleton instance
const crossPoolCorrelation = new CrossPoolCorrelation({
    historyLength: parseInt(process.env.CORRELATION_HISTORY_LENGTH || '100'),
    correlationThreshold: parseFloat(process.env.CORRELATION_THRESHOLD || '0.7'),
    correlationUpdateInterval: parseInt(process.env.CORRELATION_UPDATE_INTERVAL || '60000'),
});

export default crossPoolCorrelation;
export { CrossPoolCorrelation };
