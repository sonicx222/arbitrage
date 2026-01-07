import { EventEmitter } from 'events';
import log from '../utils/logger.js';

/**
 * Adaptive Poller - Dynamic polling interval based on market volatility
 *
 * During high volatility, arbitrage opportunities appear and disappear quickly.
 * Fixed polling intervals miss many opportunities. This module adjusts the
 * polling frequency based on:
 *
 * 1. Price volatility (standard deviation of recent changes)
 * 2. Number of recent opportunities detected
 * 3. Time since last opportunity
 * 4. Gas price volatility (affects profitability)
 *
 * Benefits:
 * - Catch fast-moving opportunities during volatility spikes
 * - Save RPC calls during quiet periods
 * - Better balance between detection speed and resource usage
 */
export default class AdaptivePoller extends EventEmitter {
    constructor(config = {}) {
        super();

        // Polling interval bounds (milliseconds)
        this.minInterval = config.minInterval || 500;       // 0.5 seconds (max speed)
        this.maxInterval = config.maxInterval || 5000;      // 5 seconds (idle speed)
        this.defaultInterval = config.defaultInterval || 2500; // 2.5 seconds (normal)

        // Current state
        this.currentInterval = this.defaultInterval;
        this.lastPollTime = Date.now();

        // Volatility tracking
        this.priceChanges = [];        // Recent price change percentages
        this.windowSize = config.windowSize || 30;  // Track last 30 samples
        this.volatilityThresholds = {
            high: config.highVolatility || 0.02,     // 2% std dev = high volatility
            medium: config.mediumVolatility || 0.01, // 1% std dev = medium
            low: config.lowVolatility || 0.005,      // 0.5% std dev = low
        };

        // Opportunity tracking
        this.recentOpportunities = [];
        this.opportunityWindow = config.opportunityWindow || 60000; // Last 60 seconds

        // RPC usage tracking (to stay within limits)
        this.rpcCallsPerMinute = 0;
        this.maxRpcPerMinute = config.maxRpcPerMinute || 250;
        this.lastRpcReset = Date.now();

        // Chain-specific adjustments
        this.chainBlockTimes = {
            56: 3000,     // BSC: 3 seconds
            1: 12000,     // Ethereum: 12 seconds
            137: 2000,    // Polygon: 2 seconds
            42161: 250,   // Arbitrum: 0.25 seconds
            8453: 2000,   // Base: 2 seconds
            43114: 2000,  // Avalanche: 2 seconds
        };

        // Intensity modes
        this.intensityModes = {
            AGGRESSIVE: { multiplier: 0.5, minInterval: this.minInterval },
            NORMAL: { multiplier: 1.0, minInterval: this.defaultInterval / 2 },
            CONSERVATIVE: { multiplier: 2.0, minInterval: this.defaultInterval },
        };
        this.currentMode = 'NORMAL';

        // Statistics
        this.stats = {
            intervalChanges: 0,
            volatilitySpikes: 0,
            opportunityBursts: 0,
            avgInterval: this.defaultInterval,
            totalPolls: 0,
        };

        log.info('Adaptive Poller initialized', {
            minInterval: `${this.minInterval}ms`,
            maxInterval: `${this.maxInterval}ms`,
            defaultInterval: `${this.defaultInterval}ms`,
        });
    }

    /**
     * Record a price update and calculate if interval should change
     *
     * @param {string} pair - Trading pair (e.g., "WBNB/USDT")
     * @param {number} oldPrice - Previous price
     * @param {number} newPrice - Current price
     */
    recordPriceChange(pair, oldPrice, newPrice) {
        if (!oldPrice || !newPrice || oldPrice === 0) return;

        const changePercent = Math.abs((newPrice - oldPrice) / oldPrice);
        this.priceChanges.push({
            pair,
            change: changePercent,
            timestamp: Date.now(),
        });

        // Trim to window size
        while (this.priceChanges.length > this.windowSize) {
            this.priceChanges.shift();
        }

        // Recalculate optimal interval
        this._updateInterval();
    }

    /**
     * Record that an opportunity was detected
     *
     * @param {Object} opportunity - The detected opportunity
     */
    recordOpportunity(opportunity) {
        this.recentOpportunities.push({
            type: opportunity.type,
            profitPercent: opportunity.profitPercent || opportunity.spreadPercent,
            timestamp: Date.now(),
        });

        // Clean old opportunities
        const cutoff = Date.now() - this.opportunityWindow;
        this.recentOpportunities = this.recentOpportunities.filter(o => o.timestamp > cutoff);

        // If we see many opportunities, speed up polling
        if (this.recentOpportunities.length >= 3) {
            this.stats.opportunityBursts++;
            this._triggerHighIntensity('opportunity_burst');
        }

        this._updateInterval();
    }

    /**
     * Get the current recommended polling interval
     *
     * @param {number} chainId - Chain ID for chain-specific adjustment
     * @returns {number} Recommended interval in milliseconds
     */
    getInterval(chainId = 56) {
        // Adjust for chain block time
        const blockTime = this.chainBlockTimes[chainId] || 3000;
        const chainAdjustedInterval = Math.max(
            this.currentInterval,
            blockTime / 2 // Don't poll faster than 2x per block
        );

        // Check RPC rate limiting
        const now = Date.now();
        if (now - this.lastRpcReset > 60000) {
            this.rpcCallsPerMinute = 0;
            this.lastRpcReset = now;
        }

        // If approaching rate limit, slow down
        if (this.rpcCallsPerMinute > this.maxRpcPerMinute * 0.8) {
            return Math.max(chainAdjustedInterval, this.defaultInterval);
        }

        return Math.round(chainAdjustedInterval);
    }

    /**
     * Record that an RPC call was made
     */
    recordRpcCall() {
        this.rpcCallsPerMinute++;
    }

    /**
     * Manually set intensity mode
     *
     * @param {string} mode - 'AGGRESSIVE', 'NORMAL', or 'CONSERVATIVE'
     */
    setIntensityMode(mode) {
        if (this.intensityModes[mode]) {
            this.currentMode = mode;
            this._updateInterval();
            log.info(`Adaptive poller mode changed to ${mode}`);
        }
    }

    /**
     * Get recommended intensity based on time of day
     * (Opportunities often cluster at certain times)
     *
     * @returns {string} Recommended intensity mode
     */
    getTimeBasedIntensity() {
        const hour = new Date().getUTCHours();

        // High activity times (US/EU market overlap)
        if (hour >= 13 && hour <= 21) {
            return 'AGGRESSIVE';
        }

        // Medium activity (Asian markets)
        if (hour >= 0 && hour <= 8) {
            return 'NORMAL';
        }

        // Lower activity
        return 'NORMAL';
    }

    /**
     * Calculate current volatility level
     *
     * @returns {Object} { volatility: number, level: string }
     */
    calculateVolatility() {
        if (this.priceChanges.length < 5) {
            return { volatility: 0, level: 'unknown' };
        }

        const changes = this.priceChanges.map(p => p.change);
        const mean = changes.reduce((a, b) => a + b, 0) / changes.length;
        const variance = changes.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / changes.length;
        const volatility = Math.sqrt(variance);

        let level = 'low';
        if (volatility >= this.volatilityThresholds.high) {
            level = 'high';
        } else if (volatility >= this.volatilityThresholds.medium) {
            level = 'medium';
        }

        return { volatility, level };
    }

    /**
     * Update the polling interval based on current conditions
     * @private
     */
    _updateInterval() {
        const { volatility, level } = this.calculateVolatility();
        const modeConfig = this.intensityModes[this.currentMode];
        const now = Date.now();

        // Base interval from volatility
        let newInterval;
        if (level === 'high') {
            newInterval = this.minInterval;
            if (volatility > this.volatilityThresholds.high * 2) {
                // Extreme volatility - minimum interval
                newInterval = this.minInterval;
            }
        } else if (level === 'medium') {
            newInterval = (this.minInterval + this.defaultInterval) / 2;
        } else {
            newInterval = this.defaultInterval;
        }

        // Apply mode multiplier
        newInterval = newInterval * modeConfig.multiplier;

        // Apply opportunity boost
        const recentOppCount = this.recentOpportunities.filter(
            o => now - o.timestamp < 10000 // Last 10 seconds
        ).length;

        if (recentOppCount >= 2) {
            newInterval = Math.min(newInterval, this.minInterval * 2);
        }

        // Clamp to bounds
        newInterval = Math.max(modeConfig.minInterval, Math.min(this.maxInterval, newInterval));

        // Only update if significant change (>20%)
        const changePercent = Math.abs(newInterval - this.currentInterval) / this.currentInterval;
        if (changePercent > 0.2 || newInterval !== this.currentInterval) {
            const oldInterval = this.currentInterval;
            this.currentInterval = newInterval;
            this.stats.intervalChanges++;

            // Update running average
            this.stats.totalPolls++;
            this.stats.avgInterval = (
                (this.stats.avgInterval * (this.stats.totalPolls - 1) + newInterval) /
                this.stats.totalPolls
            );

            if (changePercent > 0.5) { // Only log significant changes
                log.debug('Polling interval adjusted', {
                    oldInterval: `${Math.round(oldInterval)}ms`,
                    newInterval: `${Math.round(newInterval)}ms`,
                    volatilityLevel: level,
                    recentOpps: recentOppCount,
                    mode: this.currentMode,
                });
            }

            this.emit('intervalChanged', {
                oldInterval,
                newInterval,
                reason: level === 'high' ? 'high_volatility' :
                       recentOppCount >= 2 ? 'opportunity_burst' : 'normal_adjustment',
            });
        }
    }

    /**
     * Trigger high intensity mode temporarily
     * @private
     */
    _triggerHighIntensity(reason) {
        const previousMode = this.currentMode;
        this.currentMode = 'AGGRESSIVE';

        // Reset to normal after 30 seconds
        setTimeout(() => {
            if (this.currentMode === 'AGGRESSIVE') {
                this.currentMode = previousMode;
                this._updateInterval();
            }
        }, 30000);

        this.stats.volatilitySpikes++;
        this.emit('highIntensityTriggered', { reason });
    }

    /**
     * Check if we should poll now based on time elapsed
     *
     * @param {number} chainId - Chain ID
     * @returns {boolean} True if enough time has passed for next poll
     */
    shouldPollNow(chainId = 56) {
        const interval = this.getInterval(chainId);
        const elapsed = Date.now() - this.lastPollTime;
        return elapsed >= interval;
    }

    /**
     * Mark that a poll was completed
     */
    markPollComplete() {
        this.lastPollTime = Date.now();
        this.stats.totalPolls++;
    }

    /**
     * Get current poller statistics
     */
    getStats() {
        const { volatility, level } = this.calculateVolatility();

        return {
            ...this.stats,
            currentInterval: Math.round(this.currentInterval),
            currentMode: this.currentMode,
            volatility: parseFloat(volatility.toFixed(6)),
            volatilityLevel: level,
            recentOpportunities: this.recentOpportunities.length,
            rpcCallsThisMinute: this.rpcCallsPerMinute,
            priceChangeSamples: this.priceChanges.length,
        };
    }

    /**
     * Reset all tracking data
     */
    reset() {
        this.priceChanges = [];
        this.recentOpportunities = [];
        this.currentInterval = this.defaultInterval;
        this.currentMode = 'NORMAL';
        this.rpcCallsPerMinute = 0;
        this.lastPollTime = Date.now();

        log.debug('Adaptive poller reset');
    }
}
