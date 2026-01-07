import EventEmitter from 'events';
import log from '../utils/logger.js';

/**
 * Block Time Predictor
 *
 * Tracks block times and predicts optimal transaction submission windows.
 * Transactions submitted at the wrong time can:
 * - Get front-run if submitted too early
 * - Miss the block if submitted too late
 * - Face higher competition during predictable windows
 *
 * Optimal submission is typically 200-500ms before expected block.
 */
class BlockTimePredictor extends EventEmitter {
    constructor(config = {}) {
        super();

        // Default expected block times (ms) by chain
        this.expectedBlockTimes = config.expectedBlockTimes || {
            1: 12000,      // Ethereum - 12s
            56: 3000,      // BSC - 3s
            137: 2000,     // Polygon - 2s
            42161: 250,    // Arbitrum - 0.25s
            8453: 2000,    // Base - 2s
            43114: 2000,   // Avalanche - 2s
        };

        // Number of blocks to track for averaging
        this.sampleSize = config.sampleSize || 50;

        // Block time history per chain
        this.blockHistory = new Map();

        // Current chain being tracked
        this.activeChainId = config.chainId || 56;

        // Submission timing parameters
        this.optimalLeadTime = config.optimalLeadTime || 400; // ms before block
        this.minLeadTime = config.minLeadTime || 100; // minimum ms before block
        this.maxLeadTime = config.maxLeadTime || 800; // maximum ms before block

        // Statistics
        this.stats = {
            blocksRecorded: 0,
            predictionsRequested: 0,
            avgBlockTime: 0,
            blockTimeVariance: 0,
        };

        log.info('Block Time Predictor initialized', {
            sampleSize: this.sampleSize,
            optimalLeadTime: `${this.optimalLeadTime}ms`,
        });
    }

    /**
     * Record a new block time
     *
     * @param {number} blockNumber - Block number
     * @param {number} timestamp - Block timestamp (ms or seconds)
     * @param {number} chainId - Chain ID (optional, uses active chain)
     */
    recordBlock(blockNumber, timestamp, chainId = this.activeChainId) {
        // Convert to ms if in seconds
        const timestampMs = timestamp > 1e12 ? timestamp : timestamp * 1000;

        if (!this.blockHistory.has(chainId)) {
            this.blockHistory.set(chainId, []);
        }

        const history = this.blockHistory.get(chainId);

        // Add new block
        history.push({
            blockNumber,
            timestamp: timestampMs,
            recordedAt: Date.now(),
        });

        // Maintain sample size
        while (history.length > this.sampleSize) {
            history.shift();
        }

        this.stats.blocksRecorded++;

        // Update stats
        this._updateStats(chainId);

        // Emit event for monitoring
        if (history.length >= 2) {
            const lastTwo = history.slice(-2);
            const blockTime = lastTwo[1].timestamp - lastTwo[0].timestamp;
            this.emit('blockRecorded', {
                chainId,
                blockNumber,
                blockTime,
                avgBlockTime: this.getAverageBlockTime(chainId),
            });
        }
    }

    /**
     * Update statistics for a chain
     *
     * @private
     */
    _updateStats(chainId) {
        const history = this.blockHistory.get(chainId);
        if (!history || history.length < 2) return;

        const blockTimes = [];
        for (let i = 1; i < history.length; i++) {
            blockTimes.push(history[i].timestamp - history[i - 1].timestamp);
        }

        const avg = blockTimes.reduce((a, b) => a + b, 0) / blockTimes.length;
        const variance = blockTimes.reduce((sum, t) => sum + Math.pow(t - avg, 2), 0) / blockTimes.length;

        this.stats.avgBlockTime = avg;
        this.stats.blockTimeVariance = variance;
    }

    /**
     * Get average block time for a chain
     *
     * @param {number} chainId - Chain ID
     * @returns {number} Average block time in ms
     */
    getAverageBlockTime(chainId = this.activeChainId) {
        const history = this.blockHistory.get(chainId);

        if (!history || history.length < 2) {
            return this.expectedBlockTimes[chainId] || 3000;
        }

        const blockTimes = [];
        for (let i = 1; i < history.length; i++) {
            blockTimes.push(history[i].timestamp - history[i - 1].timestamp);
        }

        return blockTimes.reduce((a, b) => a + b, 0) / blockTimes.length;
    }

    /**
     * Get block time variance (stability measure)
     *
     * @param {number} chainId - Chain ID
     * @returns {number} Standard deviation of block times in ms
     */
    getBlockTimeStdDev(chainId = this.activeChainId) {
        const history = this.blockHistory.get(chainId);

        if (!history || history.length < 3) {
            return 0;
        }

        const blockTimes = [];
        for (let i = 1; i < history.length; i++) {
            blockTimes.push(history[i].timestamp - history[i - 1].timestamp);
        }

        const avg = blockTimes.reduce((a, b) => a + b, 0) / blockTimes.length;
        const variance = blockTimes.reduce((sum, t) => sum + Math.pow(t - avg, 2), 0) / blockTimes.length;

        return Math.sqrt(variance);
    }

    /**
     * Predict when the next block will arrive
     *
     * @param {number} chainId - Chain ID
     * @returns {Object} Prediction with confidence
     */
    predictNextBlock(chainId = this.activeChainId) {
        this.stats.predictionsRequested++;

        const history = this.blockHistory.get(chainId);
        const avgBlockTime = this.getAverageBlockTime(chainId);

        if (!history || history.length < 2) {
            return {
                predictedTime: Date.now() + avgBlockTime,
                confidence: 'low',
                reason: 'Insufficient block history',
                avgBlockTime,
            };
        }

        const lastBlock = history[history.length - 1];
        const timeSinceLastBlock = Date.now() - lastBlock.timestamp;

        // Predict next block time
        const predictedTime = lastBlock.timestamp + avgBlockTime;

        // Calculate confidence based on variance
        const stdDev = this.getBlockTimeStdDev(chainId);
        const coefficientOfVariation = stdDev / avgBlockTime;

        let confidence;
        if (coefficientOfVariation < 0.1) {
            confidence = 'high';
        } else if (coefficientOfVariation < 0.25) {
            confidence = 'medium';
        } else {
            confidence = 'low';
        }

        return {
            predictedTime,
            timeUntilBlock: predictedTime - Date.now(),
            timeSinceLastBlock,
            lastBlockNumber: lastBlock.blockNumber,
            avgBlockTime,
            stdDev,
            confidence,
        };
    }

    /**
     * Get optimal submission window for a transaction
     *
     * @param {number} chainId - Chain ID
     * @returns {Object} Submission recommendation
     */
    getOptimalSubmissionWindow(chainId = this.activeChainId) {
        const prediction = this.predictNextBlock(chainId);
        const now = Date.now();
        const timeToNextBlock = prediction.predictedTime - now;

        // Already past predicted block time
        if (timeToNextBlock <= 0) {
            // Next block is imminent or late - submit immediately
            return {
                submit: true,
                delay: 0,
                reason: 'Block expected imminently',
                urgency: 'high',
                ...prediction,
            };
        }

        // Calculate optimal submission point
        // We want to submit optimalLeadTime ms before the block
        const optimalSubmitTime = prediction.predictedTime - this.optimalLeadTime;
        const delayUntilOptimal = optimalSubmitTime - now;

        // If we're already in the optimal window
        if (delayUntilOptimal <= 0 && timeToNextBlock > this.minLeadTime) {
            return {
                submit: true,
                delay: 0,
                reason: 'Currently in optimal submission window',
                urgency: 'normal',
                ...prediction,
            };
        }

        // If we need to wait for optimal window
        if (delayUntilOptimal > 0 && delayUntilOptimal < 5000) {
            return {
                submit: true,
                delay: Math.max(0, delayUntilOptimal),
                reason: `Wait ${delayUntilOptimal}ms for optimal window`,
                urgency: 'scheduled',
                ...prediction,
            };
        }

        // Block is too far away - might be stale data
        if (timeToNextBlock > prediction.avgBlockTime * 2) {
            return {
                submit: true,
                delay: 0,
                reason: 'Block timing uncertain - submit now',
                urgency: 'uncertain',
                ...prediction,
            };
        }

        // Default: submit with calculated delay
        return {
            submit: true,
            delay: Math.max(0, Math.min(delayUntilOptimal, 2000)),
            reason: 'Calculated submission delay',
            urgency: 'normal',
            ...prediction,
        };
    }

    /**
     * Check if now is a good time to submit
     *
     * @param {number} chainId - Chain ID
     * @returns {boolean} True if good time to submit
     */
    shouldSubmitNow(chainId = this.activeChainId) {
        const window = this.getOptimalSubmissionWindow(chainId);
        return window.submit && window.delay <= 50;
    }

    /**
     * Wait for optimal submission window
     *
     * @param {number} chainId - Chain ID
     * @param {number} maxWait - Maximum wait time in ms
     * @returns {Promise<Object>} Submission window info
     */
    async waitForOptimalWindow(chainId = this.activeChainId, maxWait = 3000) {
        const window = this.getOptimalSubmissionWindow(chainId);

        if (window.delay <= 0 || window.delay > maxWait) {
            return window;
        }

        // Wait for optimal window
        await new Promise(resolve => setTimeout(resolve, window.delay));

        // Return updated window
        return this.getOptimalSubmissionWindow(chainId);
    }

    /**
     * Set the active chain for default operations
     *
     * @param {number} chainId - Chain ID
     */
    setActiveChain(chainId) {
        this.activeChainId = chainId;
        log.debug(`Active chain set to ${chainId}`);
    }

    /**
     * Get statistics
     */
    getStats() {
        const chainStats = {};

        for (const [chainId, history] of this.blockHistory) {
            chainStats[chainId] = {
                samplesRecorded: history.length,
                avgBlockTime: this.getAverageBlockTime(chainId),
                stdDev: this.getBlockTimeStdDev(chainId),
            };
        }

        return {
            ...this.stats,
            chainStats,
            activeChainId: this.activeChainId,
        };
    }

    /**
     * Clear history for a chain
     *
     * @param {number} chainId - Chain ID (or all if not specified)
     */
    clearHistory(chainId = null) {
        if (chainId !== null) {
            this.blockHistory.delete(chainId);
        } else {
            this.blockHistory.clear();
        }

        this.stats = {
            blocksRecorded: 0,
            predictionsRequested: 0,
            avgBlockTime: 0,
            blockTimeVariance: 0,
        };

        log.info('Block history cleared', { chainId: chainId || 'all' });
    }

    /**
     * Get recent block times for analysis
     *
     * @param {number} chainId - Chain ID
     * @param {number} count - Number of recent blocks
     * @returns {Array} Recent block times
     */
    getRecentBlockTimes(chainId = this.activeChainId, count = 10) {
        const history = this.blockHistory.get(chainId);
        if (!history || history.length < 2) return [];

        const times = [];
        const recent = history.slice(-count - 1);

        for (let i = 1; i < recent.length; i++) {
            times.push({
                blockNumber: recent[i].blockNumber,
                blockTime: recent[i].timestamp - recent[i - 1].timestamp,
                timestamp: recent[i].timestamp,
            });
        }

        return times;
    }
}

// Export class for per-chain instances
export { BlockTimePredictor };

// Export default singleton
const blockTimePredictor = new BlockTimePredictor();
export default blockTimePredictor;
