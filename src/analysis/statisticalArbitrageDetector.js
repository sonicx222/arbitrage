import { EventEmitter } from 'events';
import log from '../utils/logger.js';

/**
 * Statistical Arbitrage Detector
 *
 * Improvement v2.0: Statistical mean-reversion based arbitrage detection
 *
 * This module detects arbitrage opportunities based on statistical deviation
 * from historical price spread means. When the spread between two DEXs deviates
 * significantly from its historical average, it signals a potential opportunity
 * as prices tend to revert to the mean.
 *
 * Key concepts:
 * - Z-score: Measures how many standard deviations the current spread is from the mean
 * - Mean reversion: Prices that deviate significantly tend to return to average
 * - Bollinger-like bands: Define entry/exit thresholds based on volatility
 *
 * Expected impact: +5-15% opportunity detection through statistical signals
 */
class StatisticalArbitrageDetector extends EventEmitter {
    constructor(config = {}) {
        super();

        // Configuration
        this.windowSize = config.windowSize || 100; // Number of samples for rolling stats
        this.zScoreThreshold = config.zScoreThreshold || 2.0; // Standard deviations for signal
        this.minSamples = config.minSamples || 20; // Minimum samples before generating signals
        this.maxAge = config.maxAge || 60000; // Max age of samples in ms (1 minute)

        // Price spread history per pair
        // Structure: { "TOKEN_A/TOKEN_B": { spreads: [], timestamps: [], stats: {} } }
        this.spreadHistory = new Map();

        // Statistics
        this.stats = {
            samplesRecorded: 0,
            signalsGenerated: 0,
            meanReversionHits: 0,
            pairsTracked: 0,
        };

        // Cleanup interval
        this.cleanupInterval = null;

        log.info('Statistical Arbitrage Detector initialized', {
            windowSize: this.windowSize,
            zScoreThreshold: this.zScoreThreshold,
            minSamples: this.minSamples,
        });
    }

    /**
     * Start the statistical arbitrage detector
     */
    start() {
        // Clean old samples every 30 seconds
        this.cleanupInterval = setInterval(() => this._cleanupOldSamples(), 30000);
        log.info('Statistical arbitrage detector started');
    }

    /**
     * Stop the statistical arbitrage detector
     */
    stop() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        log.info('Statistical arbitrage detector stopped', { stats: this.getStats() });
    }

    /**
     * Record a price spread observation
     *
     * @param {string} pairKey - Token pair key (e.g., "WBNB/USDT")
     * @param {string} dexA - First DEX name
     * @param {string} dexB - Second DEX name
     * @param {number} priceA - Price on DEX A
     * @param {number} priceB - Price on DEX B
     * @param {number} blockNumber - Current block number
     * @returns {Object|null} Signal if statistical opportunity detected
     */
    recordSpread(pairKey, dexA, dexB, priceA, priceB, blockNumber) {
        if (!priceA || !priceB || priceA <= 0 || priceB <= 0) {
            return null;
        }

        const spreadKey = `${pairKey}:${dexA}:${dexB}`;
        const timestamp = Date.now();

        // Calculate spread percentage
        const spread = ((priceB - priceA) / priceA) * 100;

        // Initialize history if needed
        if (!this.spreadHistory.has(spreadKey)) {
            this.spreadHistory.set(spreadKey, {
                spreads: [],
                timestamps: [],
                stats: {
                    mean: 0,
                    stdDev: 0,
                    lastZScore: 0,
                },
                metadata: {
                    pairKey,
                    dexA,
                    dexB,
                },
            });
            this.stats.pairsTracked++;
        }

        const history = this.spreadHistory.get(spreadKey);

        // Add new sample
        history.spreads.push(spread);
        history.timestamps.push(timestamp);
        this.stats.samplesRecorded++;

        // Trim to window size
        while (history.spreads.length > this.windowSize) {
            history.spreads.shift();
            history.timestamps.shift();
        }

        // Calculate rolling statistics
        const stats = this._calculateStats(history.spreads);
        history.stats = stats;

        // Generate signal if we have enough data
        if (history.spreads.length >= this.minSamples) {
            const signal = this._generateSignal(spreadKey, spread, stats, {
                pairKey,
                dexA,
                dexB,
                priceA,
                priceB,
                blockNumber,
                timestamp,
            });

            if (signal) {
                this.stats.signalsGenerated++;
                this.emit('statisticalSignal', signal);
                return signal;
            }
        }

        return null;
    }

    /**
     * Calculate rolling statistics for a spread series
     *
     * @private
     */
    _calculateStats(spreads) {
        const n = spreads.length;
        if (n === 0) return { mean: 0, stdDev: 0, lastZScore: 0 };

        // Calculate mean
        const sum = spreads.reduce((a, b) => a + b, 0);
        const mean = sum / n;

        // Calculate standard deviation
        const squaredDiffs = spreads.map(s => Math.pow(s - mean, 2));
        const variance = squaredDiffs.reduce((a, b) => a + b, 0) / n;
        const stdDev = Math.sqrt(variance);

        // Calculate z-score for latest spread
        const lastSpread = spreads[spreads.length - 1];
        const lastZScore = stdDev > 0 ? (lastSpread - mean) / stdDev : 0;

        return {
            mean,
            stdDev,
            lastZScore,
            min: Math.min(...spreads),
            max: Math.max(...spreads),
            range: Math.max(...spreads) - Math.min(...spreads),
            count: n,
        };
    }

    /**
     * Generate a statistical arbitrage signal
     *
     * @private
     */
    _generateSignal(spreadKey, currentSpread, stats, context) {
        const { mean, stdDev, lastZScore } = stats;

        // Check if z-score exceeds threshold
        if (Math.abs(lastZScore) < this.zScoreThreshold) {
            return null;
        }

        // Determine signal direction
        // Positive z-score: spread is abnormally high -> expect it to decrease
        // Negative z-score: spread is abnormally low -> expect it to increase
        const direction = lastZScore > 0 ? 'short-spread' : 'long-spread';

        // Calculate expected reversion
        // Prices tend to revert to mean, so expected profit is proportional to deviation
        const expectedReversion = Math.abs(currentSpread - mean);
        const confidence = Math.min(1, Math.abs(lastZScore) / 3); // 0-1 scale

        // Signal strength based on z-score magnitude
        let strength = 'weak';
        if (Math.abs(lastZScore) >= 3) {
            strength = 'strong';
        } else if (Math.abs(lastZScore) >= 2.5) {
            strength = 'medium';
        }

        return {
            type: 'statistical-arbitrage',
            spreadKey,
            pairKey: context.pairKey,
            dexA: context.dexA,
            dexB: context.dexB,
            priceA: context.priceA,
            priceB: context.priceB,
            currentSpread,
            historicalMean: mean,
            historicalStdDev: stdDev,
            zScore: lastZScore,
            direction,
            strength,
            confidence,
            expectedReversionPercent: expectedReversion,
            // Trading recommendation
            action: lastZScore > 0
                ? { buy: context.dexA, sell: context.dexB, reason: 'Spread above mean, expect contraction' }
                : { buy: context.dexB, sell: context.dexA, reason: 'Spread below mean, expect expansion' },
            // Context
            blockNumber: context.blockNumber,
            timestamp: context.timestamp,
            sampleCount: stats.count,
        };
    }

    /**
     * Process price data from the main detection flow
     *
     * @param {Object} prices - Price data from priceFetcher
     * @param {number} blockNumber - Current block number
     * @returns {Array} Array of statistical signals
     */
    processAllPrices(prices, blockNumber) {
        const signals = [];

        for (const [pairKey, dexPrices] of Object.entries(prices)) {
            const dexNames = Object.keys(dexPrices);

            // Need at least 2 DEXs for spread calculation
            if (dexNames.length < 2) continue;

            // Check all DEX pairs
            for (let i = 0; i < dexNames.length; i++) {
                for (let j = i + 1; j < dexNames.length; j++) {
                    const dexA = dexNames[i];
                    const dexB = dexNames[j];
                    const priceA = dexPrices[dexA]?.price;
                    const priceB = dexPrices[dexB]?.price;

                    const signal = this.recordSpread(pairKey, dexA, dexB, priceA, priceB, blockNumber);
                    if (signal) {
                        signals.push(signal);
                    }
                }
            }
        }

        return signals;
    }

    /**
     * Get current statistics for a spread pair
     *
     * @param {string} spreadKey - Spread key
     * @returns {Object|null} Current statistics
     */
    getSpreadStats(spreadKey) {
        const history = this.spreadHistory.get(spreadKey);
        if (!history) return null;

        return {
            ...history.stats,
            metadata: history.metadata,
            sampleCount: history.spreads.length,
            oldestSample: history.timestamps[0],
            newestSample: history.timestamps[history.timestamps.length - 1],
        };
    }

    /**
     * Get all tracked spreads with their statistics
     *
     * @returns {Array} Array of spread statistics
     */
    getAllSpreadStats() {
        const stats = [];
        for (const [spreadKey, history] of this.spreadHistory.entries()) {
            stats.push({
                spreadKey,
                ...history.stats,
                metadata: history.metadata,
                sampleCount: history.spreads.length,
            });
        }
        return stats;
    }

    /**
     * Clean up old samples
     *
     * @private
     */
    _cleanupOldSamples() {
        const now = Date.now();
        let cleaned = 0;

        for (const [spreadKey, history] of this.spreadHistory.entries()) {
            // Remove samples older than maxAge
            while (history.timestamps.length > 0 && now - history.timestamps[0] > this.maxAge) {
                history.spreads.shift();
                history.timestamps.shift();
                cleaned++;
            }

            // Remove empty histories
            if (history.spreads.length === 0) {
                this.spreadHistory.delete(spreadKey);
                this.stats.pairsTracked--;
            } else {
                // Recalculate stats after cleanup
                history.stats = this._calculateStats(history.spreads);
            }
        }

        if (cleaned > 0) {
            log.debug('Statistical arbitrage cleanup', {
                samplesRemoved: cleaned,
                pairsTracked: this.stats.pairsTracked,
            });
        }
    }

    /**
     * Get detector statistics
     */
    getStats() {
        return {
            ...this.stats,
            spreadsTracked: this.spreadHistory.size,
            avgSamplesPerSpread: this.stats.pairsTracked > 0
                ? Math.round([...this.spreadHistory.values()].reduce((sum, h) => sum + h.spreads.length, 0) / this.stats.pairsTracked)
                : 0,
        };
    }

    /**
     * Reset all history and statistics
     */
    reset() {
        this.spreadHistory.clear();
        this.stats = {
            samplesRecorded: 0,
            signalsGenerated: 0,
            meanReversionHits: 0,
            pairsTracked: 0,
        };
        log.info('Statistical arbitrage detector reset');
    }
}

// Export singleton instance
const statisticalArbitrageDetector = new StatisticalArbitrageDetector();
export default statisticalArbitrageDetector;
