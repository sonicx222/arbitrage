import EventEmitter from 'events';
import log from '../utils/logger.js';

/**
 * Just-In-Time (JIT) Liquidity Detector
 *
 * Detects JIT liquidity events where liquidity providers add concentrated
 * liquidity immediately before large trades to capture fees, then remove it.
 *
 * JIT liquidity creates opportunities:
 * 1. Better execution prices during JIT (lower slippage)
 * 2. Arbitrage between JIT-affected and unaffected pools
 * 3. Following JIT patterns for predictive trading
 *
 * Detection signals:
 * - Mint event followed by Burn event within 1-2 blocks
 * - Large liquidity additions in concentrated range
 * - Correlation with pending mempool transactions
 */
class JITLiquidityDetector extends EventEmitter {
    constructor(config = {}) {
        super();

        // Detection parameters
        this.jitWindowBlocks = config.jitWindowBlocks || 2;
        this.minLiquidityUSD = config.minLiquidityUSD || 10000;
        this.minAddRemoveRatio = config.minAddRemoveRatio || 0.8;

        // V3 tick range thresholds
        this.maxTickRange = config.maxTickRange || 200;
        this.concentratedThreshold = config.concentratedThreshold || 0.01;

        // Tracking state
        this.pendingMints = new Map();
        this.recentJITEvents = [];
        this.maxRecentEvents = config.maxRecentEvents || 100;

        // Per-pool JIT statistics
        this.poolStats = new Map();

        // Statistics
        this.stats = {
            mintsTracked: 0,
            jitDetected: 0,
            falsePositives: 0,
            avgJITDurationBlocks: 0,
            avgJITSizeUSD: 0,
        };

        log.info('JIT Liquidity Detector initialized', {
            jitWindowBlocks: this.jitWindowBlocks,
            minLiquidityUSD: this.minLiquidityUSD,
        });
    }

    /**
     * Record a liquidity addition (Mint event)
     *
     * @param {Object} event - Mint event data
     */
    recordMint(event) {
        const {
            chainId,
            poolAddress,
            sender,
            owner,
            tickLower,
            tickUpper,
            amount,
            amount0,
            amount1,
            blockNumber,
            transactionHash,
            liquidityUSD,
        } = event;

        // Calculate tick range
        const tickRange = tickUpper - tickLower;
        const isConcentrated = tickRange <= this.maxTickRange;

        // Check if significant liquidity
        const valueUSD = liquidityUSD || this._estimateLiquidityUSD(amount0, amount1);
        if (valueUSD < this.minLiquidityUSD) {
            return null;
        }

        const mintKey = `${chainId}:${poolAddress}:${owner}:${blockNumber}`;

        const mintRecord = {
            chainId,
            poolAddress,
            sender,
            owner,
            tickLower,
            tickUpper,
            tickRange,
            isConcentrated,
            amount,
            amount0,
            amount1,
            blockNumber,
            transactionHash,
            timestamp: Date.now(),
            liquidityUSD: valueUSD,
        };

        this.pendingMints.set(mintKey, mintRecord);
        this.stats.mintsTracked++;

        // Emit potential JIT signal if concentrated
        if (isConcentrated && valueUSD >= this.minLiquidityUSD * 2) {
            this.emit('potentialJIT', {
                type: 'mint',
                ...mintRecord,
                confidence: 'medium',
                reason: 'Concentrated liquidity added',
            });
        }

        // Cleanup old mints
        this._cleanupOldMints(blockNumber);

        return mintRecord;
    }

    /**
     * Record a liquidity removal (Burn event) and detect JIT pattern
     *
     * @param {Object} event - Burn event data
     */
    recordBurn(event) {
        const {
            chainId,
            poolAddress,
            owner,
            tickLower,
            tickUpper,
            amount,
            amount0,
            amount1,
            blockNumber,
            transactionHash,
        } = event;

        // Find matching mint within JIT window
        const jitEvent = this._findMatchingMint({
            chainId,
            poolAddress,
            owner,
            tickLower,
            tickUpper,
            blockNumber,
        });

        if (!jitEvent) {
            return null;
        }

        // Calculate JIT metrics
        const blockDuration = blockNumber - jitEvent.mintBlockNumber;
        const liquidityRatio = Number(amount) / Number(jitEvent.amount);

        // Validate JIT pattern
        if (blockDuration > this.jitWindowBlocks) {
            return null;
        }

        if (liquidityRatio < this.minAddRemoveRatio) {
            return null;
        }

        // Confirmed JIT event
        const jitRecord = {
            chainId,
            poolAddress,
            owner,
            tickLower,
            tickUpper,
            tickRange: jitEvent.tickRange,

            mintBlockNumber: jitEvent.mintBlockNumber,
            burnBlockNumber: blockNumber,
            blockDuration,

            mintTxHash: jitEvent.transactionHash,
            burnTxHash: transactionHash,

            liquidityAdded: jitEvent.amount,
            liquidityRemoved: amount,
            liquidityRatio,

            amount0Added: jitEvent.amount0,
            amount1Added: jitEvent.amount1,
            amount0Removed: amount0,
            amount1Removed: amount1,

            liquidityUSD: jitEvent.liquidityUSD,

            detectedAt: Date.now(),
        };

        // Calculate fees captured
        jitRecord.feesEarned = this._calculateFeesEarned(jitRecord);

        // Update statistics
        this._updateStats(jitRecord);
        this._updatePoolStats(poolAddress, jitRecord);

        // Store in recent events
        this.recentJITEvents.push(jitRecord);
        if (this.recentJITEvents.length > this.maxRecentEvents) {
            this.recentJITEvents.shift();
        }

        this.stats.jitDetected++;

        // Emit JIT detected event
        this.emit('jitDetected', jitRecord);

        log.info('JIT liquidity detected', {
            pool: poolAddress.slice(0, 10) + '...',
            blocks: blockDuration,
            liquidityUSD: jitRecord.liquidityUSD.toFixed(2),
            feesEstimated: jitRecord.feesEarned?.estimated || 'unknown',
        });

        return jitRecord;
    }

    /**
     * Find matching mint for a burn event
     *
     * @private
     */
    _findMatchingMint({ chainId, poolAddress, owner, tickLower, tickUpper, blockNumber }) {
        const maxBlocksBack = this.jitWindowBlocks + 1;

        for (let blockOffset = 0; blockOffset <= maxBlocksBack; blockOffset++) {
            const searchBlock = blockNumber - blockOffset;
            const mintKey = `${chainId}:${poolAddress}:${owner}:${searchBlock}`;

            const mint = this.pendingMints.get(mintKey);
            if (mint && mint.tickLower === tickLower && mint.tickUpper === tickUpper) {
                // Remove from pending
                this.pendingMints.delete(mintKey);

                return {
                    ...mint,
                    mintBlockNumber: searchBlock,
                };
            }
        }

        return null;
    }

    /**
     * Estimate liquidity value in USD
     *
     * @private
     */
    _estimateLiquidityUSD(amount0, amount1) {
        // This would integrate with price feeds in production
        // For now, return a reasonable estimate based on amounts
        const amt0 = Number(amount0 || 0n) / 1e18;
        const amt1 = Number(amount1 || 0n) / 1e18;

        // Assume ~$1 per unit for estimation (overridden by real prices)
        return (amt0 + amt1) * 1;
    }

    /**
     * Calculate fees earned by JIT provider
     *
     * @private
     */
    _calculateFeesEarned(jitRecord) {
        const { amount0Added, amount1Added, amount0Removed, amount1Removed } = jitRecord;

        // Fees = tokens removed - tokens added (should be positive for JIT profit)
        const fee0 = (Number(amount0Removed || 0n) - Number(amount0Added || 0n)) / 1e18;
        const fee1 = (Number(amount1Removed || 0n) - Number(amount1Added || 0n)) / 1e18;

        return {
            token0: fee0,
            token1: fee1,
            // Estimate USD value based on ratio
            estimated: Math.max(0, fee0 + fee1),
        };
    }

    /**
     * Clean up old mint records
     *
     * @private
     */
    _cleanupOldMints(currentBlock) {
        const minBlock = currentBlock - (this.jitWindowBlocks + 5);

        for (const [key, mint] of this.pendingMints.entries()) {
            if (mint.blockNumber < minBlock) {
                this.pendingMints.delete(key);
            }
        }
    }

    /**
     * Update global statistics
     *
     * @private
     */
    _updateStats(jitRecord) {
        const count = this.stats.jitDetected + 1;

        // Update average JIT duration
        this.stats.avgJITDurationBlocks =
            ((this.stats.avgJITDurationBlocks * this.stats.jitDetected) +
                jitRecord.blockDuration) / count;

        // Update average JIT size
        this.stats.avgJITSizeUSD =
            ((this.stats.avgJITSizeUSD * this.stats.jitDetected) +
                jitRecord.liquidityUSD) / count;
    }

    /**
     * Update per-pool statistics
     *
     * @private
     */
    _updatePoolStats(poolAddress, jitRecord) {
        if (!this.poolStats.has(poolAddress)) {
            this.poolStats.set(poolAddress, {
                jitCount: 0,
                totalLiquidityUSD: 0,
                avgDurationBlocks: 0,
                lastJIT: null,
                jitProviders: new Set(),
            });
        }

        const stats = this.poolStats.get(poolAddress);
        stats.jitCount++;
        stats.totalLiquidityUSD += jitRecord.liquidityUSD;
        stats.avgDurationBlocks =
            ((stats.avgDurationBlocks * (stats.jitCount - 1)) +
                jitRecord.blockDuration) / stats.jitCount;
        stats.lastJIT = jitRecord.detectedAt;
        stats.jitProviders.add(jitRecord.owner);
    }

    /**
     * Analyze a pool for JIT activity patterns
     *
     * @param {string} poolAddress - Pool to analyze
     * @returns {Object} JIT analysis for the pool
     */
    analyzePool(poolAddress) {
        const stats = this.poolStats.get(poolAddress);

        if (!stats) {
            return {
                hasJITActivity: false,
                jitCount: 0,
                recommendation: 'No JIT activity detected',
            };
        }

        const jitFrequency = stats.jitCount > 10 ? 'high' :
            stats.jitCount > 3 ? 'medium' : 'low';

        const uniqueProviders = stats.jitProviders.size;

        return {
            hasJITActivity: true,
            jitCount: stats.jitCount,
            totalLiquidityUSD: stats.totalLiquidityUSD,
            avgDurationBlocks: stats.avgDurationBlocks.toFixed(2),
            jitFrequency,
            uniqueProviders,
            lastJIT: stats.lastJIT,
            recommendation: this._getPoolRecommendation(stats, jitFrequency),
        };
    }

    /**
     * Get recommendation for trading based on JIT activity
     *
     * @private
     */
    _getPoolRecommendation(stats, frequency) {
        if (frequency === 'high') {
            return 'High JIT activity - expect better execution during JIT windows';
        }
        if (frequency === 'medium') {
            return 'Moderate JIT activity - monitor for JIT opportunities';
        }
        return 'Low JIT activity - standard execution expected';
    }

    /**
     * Predict if JIT is likely for a pending large trade
     *
     * @param {Object} trade - Pending trade details
     * @returns {Object} JIT prediction
     */
    predictJIT(trade) {
        const { poolAddress, tradeSizeUSD, direction } = trade;

        const poolAnalysis = this.analyzePool(poolAddress);

        // Calculate JIT likelihood based on historical data
        let likelihood = 0;

        if (poolAnalysis.hasJITActivity) {
            // Base likelihood from frequency
            likelihood = poolAnalysis.jitFrequency === 'high' ? 0.7 :
                poolAnalysis.jitFrequency === 'medium' ? 0.4 : 0.1;

            // Increase for larger trades
            if (tradeSizeUSD > 50000) likelihood += 0.2;
            else if (tradeSizeUSD > 10000) likelihood += 0.1;

            // Cap at 95%
            likelihood = Math.min(0.95, likelihood);
        }

        return {
            poolAddress,
            tradeSizeUSD,
            jitLikelihood: likelihood,
            likelihoodPercent: (likelihood * 100).toFixed(1) + '%',
            recommendation: likelihood > 0.5 ?
                'JIT likely - may get better execution' :
                'JIT unlikely - use standard slippage',
            expectedImpact: likelihood > 0.5 ? {
                slippageReduction: '10-30%',
                executionImprovement: 'Moderate',
            } : null,
        };
    }

    /**
     * Get recent JIT events
     *
     * @param {number} chainId - Optional chain filter
     * @param {number} limit - Max events to return
     * @returns {Array} Recent JIT events
     */
    getRecentJITEvents(chainId = null, limit = 20) {
        let events = this.recentJITEvents;

        if (chainId) {
            events = events.filter(e => e.chainId === chainId);
        }

        return events.slice(-limit).reverse();
    }

    /**
     * Get pools with highest JIT activity
     *
     * @param {number} limit - Max pools to return
     * @returns {Array} Top JIT pools
     */
    getTopJITPools(limit = 10) {
        const pools = [];

        for (const [address, stats] of this.poolStats.entries()) {
            pools.push({
                address,
                ...stats,
                jitProviders: stats.jitProviders.size,
            });
        }

        // Sort by JIT count descending
        pools.sort((a, b) => b.jitCount - a.jitCount);

        return pools.slice(0, limit);
    }

    /**
     * Identify JIT arbitrage opportunities
     *
     * @param {Object} jitEvent - Recent JIT event
     * @param {Object} marketPrices - Current market prices
     * @returns {Object|null} Arbitrage opportunity if found
     */
    findJITArbitrage(jitEvent, marketPrices) {
        const { poolAddress, tickLower, tickUpper, liquidityUSD } = jitEvent;

        // During JIT, the pool has significantly more liquidity
        // This can create price discrepancies with other pools

        // Calculate the temporary price range during JIT
        const jitPriceRange = this._tickRangeToPrice(tickLower, tickUpper);

        // Check if other pools have different prices
        if (!marketPrices || !marketPrices.pools) {
            return null;
        }

        const opportunities = [];

        for (const [otherPool, price] of Object.entries(marketPrices.pools)) {
            if (otherPool === poolAddress) continue;

            // Check for price discrepancy
            const midPrice = (jitPriceRange.lower + jitPriceRange.upper) / 2;
            const spread = Math.abs(price - midPrice) / midPrice;

            if (spread > 0.003) { // 0.3% minimum spread
                opportunities.push({
                    type: 'jit-arbitrage',
                    jitPool: poolAddress,
                    otherPool,
                    spread,
                    spreadPercent: (spread * 100).toFixed(3) + '%',
                    jitLiquidityUSD: liquidityUSD,
                    direction: price > midPrice ? 'buy-jit-sell-other' : 'buy-other-sell-jit',
                    confidence: spread > 0.01 ? 'high' : 'medium',
                });
            }
        }

        if (opportunities.length === 0) {
            return null;
        }

        // Return best opportunity
        opportunities.sort((a, b) => b.spread - a.spread);
        return opportunities[0];
    }

    /**
     * Convert tick range to price range
     *
     * @private
     */
    _tickRangeToPrice(tickLower, tickUpper) {
        // Price = 1.0001^tick
        const priceLower = Math.pow(1.0001, tickLower);
        const priceUpper = Math.pow(1.0001, tickUpper);

        return { lower: priceLower, upper: priceUpper };
    }

    /**
     * Get comprehensive statistics
     *
     * @returns {Object} Detector statistics
     */
    getStats() {
        return {
            ...this.stats,
            pendingMints: this.pendingMints.size,
            recentEvents: this.recentJITEvents.length,
            poolsTracked: this.poolStats.size,
            topPools: this.getTopJITPools(5),
        };
    }

    /**
     * Reset all tracking state
     */
    reset() {
        this.pendingMints.clear();
        this.recentJITEvents = [];
        this.poolStats.clear();
        this.stats = {
            mintsTracked: 0,
            jitDetected: 0,
            falsePositives: 0,
            avgJITDurationBlocks: 0,
            avgJITSizeUSD: 0,
        };

        log.info('JIT Liquidity Detector reset');
    }
}

// Export class
export { JITLiquidityDetector };

// Export default singleton for convenience
const jitLiquidityDetector = new JITLiquidityDetector();
export default jitLiquidityDetector;
