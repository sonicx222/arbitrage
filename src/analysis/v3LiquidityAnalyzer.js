import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import log from '../utils/logger.js';
import rpcManager from '../utils/rpcManager.js';
import {
    V3_POOL_ABI,
    MULTICALL_ABI,
    MULTICALL_ADDRESS,
} from '../contracts/abis.js';

/**
 * V3 Liquidity Analyzer
 *
 * Deep integration with Uniswap V3 concentrated liquidity:
 *
 * 1. Tick-level liquidity analysis for accurate price impact
 * 2. Fee tier arbitrage detection (same pair, different tiers)
 * 3. Active liquidity tracking around current price
 * 4. Accurate output calculation considering tick crossing
 *
 * Key Concept: V3 concentrated liquidity means liquidity is distributed
 * across "ticks". As price moves through ticks, available liquidity changes.
 * Large trades may cross multiple ticks, dramatically affecting slippage.
 *
 * Expected impact: +25-50% more opportunities via better execution paths
 */
class V3LiquidityAnalyzer extends EventEmitter {
    constructor(config = {}) {
        super();

        // V3 Swap event topic (different from V2 Sync)
        this.SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';

        // Configuration
        this.tickWindow = config.tickWindow || 100; // Ticks to analyze around current price
        this.minLiquidityUSD = config.minLiquidityUSD || 1000;
        this.feeTierSpreadThreshold = config.feeTierSpreadThreshold || 0.1; // 0.1%

        // V3 constants
        this.Q96 = 2n ** 96n;
        this.Q128 = 2n ** 128n;

        // Fee tiers (in basis points)
        this.feeTiers = [100, 500, 3000, 10000]; // 0.01%, 0.05%, 0.3%, 1%

        // Tick spacing per fee tier
        this.tickSpacing = {
            100: 1,     // 0.01% fee
            500: 10,    // 0.05% fee
            3000: 60,   // 0.3% fee
            10000: 200, // 1% fee
        };

        // Cache for tick data: poolAddress -> { ticks, timestamp }
        this.tickCache = new Map();
        this.cacheMaxAge = config.cacheMaxAge || 30000; // 30 seconds

        // Statistics
        this.stats = {
            tickAnalyses: 0,
            feeTierOpportunities: 0,
            crossTickCalculations: 0,
            cacheHits: 0,
            cacheMisses: 0,
            // v3.1 Enhanced stats
            tickCrossingsDetected: 0,
            jitLiquidityEvents: 0,
            depthAnalyses: 0,
            optimalRouteCalculations: 0,
        };

        // v3.1 Enhancement: Tick crossing tracking for real-time detection
        // Maps poolAddress -> { lastTick, lastLiquidity, lastUpdate }
        this.tickCrossingTracker = new Map();
        this.tickCrossingThreshold = config.tickCrossingThreshold || 10; // Ticks crossed to trigger event

        // v3.1 Enhancement: JIT liquidity tracking
        // Maps poolAddress -> { liquidityChanges: [{timestamp, delta, tick}], window: 60000 }
        this.jitTracker = new Map();
        this.jitWindow = config.jitWindow || 60000; // 60 seconds
        this.jitThreshold = config.jitThreshold || 0.1; // 10% liquidity change

        // v3.1 Enhancement: Liquidity depth profiling
        this.depthCache = new Map();
        this.depthCacheMaxAge = config.depthCacheMaxAge || 15000; // 15 seconds

        log.info('V3LiquidityAnalyzer initialized', {
            tickWindow: this.tickWindow,
            feeTiers: this.feeTiers,
        });
    }

    /**
     * Analyze liquidity concentration around current price
     *
     * @param {string} poolAddress - V3 pool address
     * @param {Object} slot0 - Current pool state { sqrtPriceX96, tick }
     * @param {BigInt} currentLiquidity - Current tick's liquidity
     * @param {number} feeTier - Pool fee tier
     * @returns {Object} Liquidity analysis result
     */
    async analyzeLiquidityConcentration(poolAddress, slot0, currentLiquidity, feeTier) {
        this.stats.tickAnalyses++;

        const currentTick = Number(slot0.tick);
        const tickSpace = this.tickSpacing[feeTier] || 60;

        try {
            // Get tick data around current price
            const ticks = await this._fetchTickData(poolAddress, currentTick, tickSpace, feeTier);

            if (!ticks || ticks.length === 0) {
                return this._createEmptyAnalysis(currentTick, currentLiquidity, feeTier);
            }

            // Calculate liquidity distribution
            const analysis = this._calculateLiquidityDistribution(
                ticks, currentTick, currentLiquidity, slot0.sqrtPriceX96, feeTier
            );

            return analysis;
        } catch (error) {
            log.debug('Liquidity analysis failed', { poolAddress, error: error.message });
            return this._createEmptyAnalysis(currentTick, currentLiquidity, feeTier);
        }
    }

    /**
     * Calculate accurate output amount considering tick crossing
     *
     * This is more accurate than the simplified calculation in v3PriceFetcher
     * because it accounts for liquidity changes at tick boundaries.
     *
     * @param {BigInt} amountIn - Input amount
     * @param {BigInt} sqrtPriceX96 - Current sqrt price
     * @param {BigInt} currentLiquidity - Current liquidity
     * @param {number} currentTick - Current tick
     * @param {Array} ticks - Tick data for the pool
     * @param {number} feeTier - Fee tier
     * @param {boolean} zeroForOne - Direction (true = token0 -> token1)
     * @returns {Object} { amountOut, priceImpact, ticksCrossed }
     */
    calculateSwapOutputWithTicks(
        amountIn,
        sqrtPriceX96,
        currentLiquidity,
        currentTick,
        ticks,
        feeTier,
        zeroForOne
    ) {
        this.stats.crossTickCalculations++;

        const fee = BigInt(feeTier);
        let remainingIn = amountIn;
        let totalOut = 0n;
        let liquidity = currentLiquidity;
        let sqrtPrice = sqrtPriceX96;
        let tick = currentTick;
        let ticksCrossed = 0;

        // Apply fee upfront
        const amountInAfterFee = (remainingIn * (1000000n - fee)) / 1000000n;
        remainingIn = amountInAfterFee;

        // Find relevant ticks in the direction of the swap
        const relevantTicks = this._getRelevantTicks(ticks, tick, zeroForOne);

        // Process swap through ticks
        while (remainingIn > 0n && ticksCrossed < 10) { // Safety limit
            // Find next tick boundary
            const nextTick = this._findNextTick(relevantTicks, tick, zeroForOne);

            if (nextTick === null) {
                // No more ticks - process remaining at current liquidity
                const output = this._calculateOutputInRange(
                    remainingIn, sqrtPrice, liquidity, zeroForOne
                );
                totalOut += output.amountOut;
                break;
            }

            // Calculate output up to next tick
            const sqrtPriceNextTick = this._tickToSqrtPrice(nextTick);
            const output = this._calculateOutputToTick(
                remainingIn, sqrtPrice, sqrtPriceNextTick, liquidity, zeroForOne
            );

            totalOut += output.amountOut;
            remainingIn -= output.amountUsed;

            if (remainingIn > 0n) {
                // Cross the tick
                tick = nextTick;
                sqrtPrice = sqrtPriceNextTick;
                liquidity = this._updateLiquidity(liquidity, nextTick, relevantTicks, zeroForOne);
                ticksCrossed++;
            }
        }

        // Calculate price impact
        const startPrice = this._sqrtPriceToPrice(sqrtPriceX96);
        const endPrice = this._sqrtPriceToPrice(sqrtPrice);

        // FIX v3.2: Validate divisors to prevent division by zero
        let priceImpact = 0;
        if (Number.isFinite(startPrice) && startPrice > 0) {
            priceImpact = Math.abs((endPrice - startPrice) / startPrice) * 100;
        }

        let effectivePrice = 0;
        const amountInNum = Number(amountIn);
        if (Number.isFinite(amountInNum) && amountInNum > 0) {
            effectivePrice = Number(totalOut) / amountInNum;
        }

        return {
            amountOut: totalOut,
            priceImpact,
            ticksCrossed,
            effectivePrice,
        };
    }

    /**
     * Detect fee tier arbitrage opportunities
     *
     * Same token pair can exist in multiple fee tiers with different prices.
     * Buy on lower-fee tier (often tighter spread), sell on higher-fee tier.
     *
     * @param {Object} v3Prices - V3 prices for all fee tiers of a pair
     * @returns {Object|null} Fee tier arbitrage opportunity
     */
    detectFeeTierArbitrage(v3Prices) {
        const tiers = Object.entries(v3Prices).filter(([_, data]) => data.isV3);

        if (tiers.length < 2) return null;

        // Sort by price
        tiers.sort((a, b) => a[1].price - b[1].price);

        const lowest = tiers[0];
        const highest = tiers[tiers.length - 1];

        // Calculate spread
        const buyPrice = lowest[1].price;
        const sellPrice = highest[1].price;
        const buyFee = this._extractFee(lowest[0]);
        const sellFee = this._extractFee(highest[0]);

        const effectiveBuy = buyPrice * (1 + buyFee);
        const effectiveSell = sellPrice * (1 - sellFee);

        // FIX v3.2: Validate divisor to prevent division by zero
        if (!Number.isFinite(effectiveBuy) || effectiveBuy <= 0) return null;

        const spreadPercent = ((effectiveSell - effectiveBuy) / effectiveBuy) * 100;

        if (spreadPercent < this.feeTierSpreadThreshold) return null;

        this.stats.feeTierOpportunities++;

        return {
            type: 'v3-fee-tier-arb',
            buyTier: lowest[0],
            sellTier: highest[0],
            buyPrice,
            sellPrice,
            buyFee,
            sellFee,
            spreadPercent,
            buyLiquidity: lowest[1].liquidityUSD,
            sellLiquidity: highest[1].liquidityUSD,
            minLiquidity: Math.min(lowest[1].liquidityUSD, highest[1].liquidityUSD),
        };
    }

    /**
     * Find optimal execution path across fee tiers
     *
     * For a given trade size, determine which fee tier provides best execution.
     *
     * @param {Object} v3Prices - V3 prices for all fee tiers
     * @param {number} tradeSizeUSD - Trade size in USD
     * @param {boolean} buying - True if buying token0
     * @returns {Object} Optimal tier analysis
     */
    findOptimalFeeTier(v3Prices, tradeSizeUSD, buying) {
        const tiers = Object.entries(v3Prices).filter(([_, data]) => data.isV3);

        if (tiers.length === 0) return null;

        let bestTier = null;
        let bestEffectivePrice = buying ? Infinity : 0;

        for (const [tierKey, data] of tiers) {
            const liquidity = data.liquidityUSD || 0;
            const fee = this._extractFee(tierKey);

            // Skip if insufficient liquidity
            // Trade should be at most 2% of liquidity for minimal impact
            if (liquidity < tradeSizeUSD * 50) continue;

            // Estimate price impact using constant product approximation
            const priceImpactPercent = this._estimatePriceImpact(tradeSizeUSD, liquidity);

            // Calculate effective price
            let effectivePrice;
            if (buying) {
                effectivePrice = data.price * (1 + fee + priceImpactPercent / 100);
            } else {
                effectivePrice = data.price * (1 - fee - priceImpactPercent / 100);
            }

            const isBetter = buying
                ? effectivePrice < bestEffectivePrice
                : effectivePrice > bestEffectivePrice;

            if (isBetter) {
                bestEffectivePrice = effectivePrice;
                bestTier = {
                    tierKey,
                    fee,
                    liquidity,
                    rawPrice: data.price,
                    effectivePrice,
                    priceImpactPercent,
                    poolAddress: data.poolAddress,
                };
            }
        }

        return bestTier;
    }

    /**
     * Get active liquidity (liquidity within current tick range)
     *
     * @param {Array} ticks - Tick data
     * @param {number} currentTick - Current tick
     * @param {number} rangePercent - Range as percentage of price (default 1%)
     * @returns {BigInt} Total active liquidity
     */
    getActiveLiquidity(ticks, currentTick, rangePercent = 1) {
        // 1% price change is approximately 100 ticks
        const tickRange = Math.floor(rangePercent * 100);
        const lowerTick = currentTick - tickRange;
        const upperTick = currentTick + tickRange;

        let activeLiquidity = 0n;

        for (const tick of ticks) {
            if (tick.index >= lowerTick && tick.index <= upperTick) {
                activeLiquidity += BigInt(tick.liquidityNet || 0);
            }
        }

        return activeLiquidity > 0n ? activeLiquidity : 0n;
    }

    /**
     * Estimate slippage for a given trade size
     *
     * @param {number} tradeSizeUSD - Trade size
     * @param {Object} analysis - Liquidity analysis from analyzeLiquidityConcentration
     * @returns {number} Estimated slippage percentage
     */
    estimateSlippage(tradeSizeUSD, analysis) {
        if (!analysis || analysis.activeLiquidityUSD <= 0) return 100; // 100% slippage = can't execute

        // Base slippage from constant product formula approximation
        const baseSlippage = (tradeSizeUSD / analysis.activeLiquidityUSD) * 100;

        // Adjust for liquidity concentration
        // Higher concentration = lower slippage for same liquidity
        const concentrationBonus = analysis.concentrationScore > 0.5
            ? (analysis.concentrationScore - 0.5) * 0.5 // Up to 25% reduction
            : 0;

        return Math.max(0, baseSlippage * (1 - concentrationBonus));
    }

    // ==================== Private Methods ====================

    /**
     * Fetch tick data around current price
     * @private
     */
    async _fetchTickData(poolAddress, currentTick, tickSpacing, feeTier) {
        const cacheKey = `${poolAddress}:${currentTick}`;
        const cached = this.tickCache.get(cacheKey);

        if (cached && Date.now() - cached.timestamp < this.cacheMaxAge) {
            this.stats.cacheHits++;
            return cached.ticks;
        }

        this.stats.cacheMisses++;

        try {
            // Calculate tick range to fetch
            const halfWindow = Math.floor(this.tickWindow / 2);
            const lowerTick = Math.floor((currentTick - halfWindow * tickSpacing) / tickSpacing) * tickSpacing;
            const upperTick = Math.ceil((currentTick + halfWindow * tickSpacing) / tickSpacing) * tickSpacing;

            // Fetch ticks via multicall
            const ticks = await this._fetchTicksMulticall(poolAddress, lowerTick, upperTick, tickSpacing);

            // Cache result
            this.tickCache.set(cacheKey, {
                ticks,
                timestamp: Date.now(),
            });

            return ticks;
        } catch (error) {
            log.debug('Tick fetch failed', { poolAddress, error: error.message });
            return [];
        }
    }

    /**
     * Fetch tick data via multicall
     * @private
     */
    async _fetchTicksMulticall(poolAddress, lowerTick, upperTick, tickSpacing) {
        const poolIface = new ethers.Interface(V3_POOL_ABI);
        const ticks = [];
        const calls = [];
        const tickIndices = [];

        // Build calls for each tick
        for (let tick = lowerTick; tick <= upperTick; tick += tickSpacing) {
            calls.push({
                target: poolAddress,
                callData: poolIface.encodeFunctionData('ticks', [tick]),
            });
            tickIndices.push(tick);
        }

        if (calls.length === 0) return [];

        // Batch into chunks of 50
        const BATCH_SIZE = 50;
        for (let i = 0; i < calls.length; i += BATCH_SIZE) {
            const batchCalls = calls.slice(i, i + BATCH_SIZE);
            const batchIndices = tickIndices.slice(i, i + BATCH_SIZE);

            try {
                const results = await rpcManager.withRetry(async (provider) => {
                    const multicall = new ethers.Contract(MULTICALL_ADDRESS, MULTICALL_ABI, provider);
                    return await multicall.tryAggregate(false, batchCalls);
                });

                results.forEach((result, idx) => {
                    if (result.success && result.returnData !== '0x') {
                        try {
                            const decoded = poolIface.decodeFunctionResult('ticks', result.returnData);
                            ticks.push({
                                index: batchIndices[idx],
                                liquidityGross: decoded[0],
                                liquidityNet: decoded[1],
                                initialized: decoded[7] || (decoded[0] > 0n),
                            });
                        } catch { /* ignore */ }
                    }
                });
            } catch (error) {
                log.debug('Tick batch failed', { error: error.message });
            }
        }

        return ticks.filter(t => t.initialized);
    }

    /**
     * Calculate liquidity distribution from tick data
     * @private
     */
    _calculateLiquidityDistribution(ticks, currentTick, currentLiquidity, sqrtPriceX96, feeTier) {
        // Count ticks above and below current price
        let ticksAbove = 0;
        let ticksBelow = 0;
        let liquidityAbove = 0n;
        let liquidityBelow = 0n;

        for (const tick of ticks) {
            if (tick.index > currentTick) {
                ticksAbove++;
                liquidityAbove += BigInt(Math.abs(Number(tick.liquidityNet)));
            } else if (tick.index < currentTick) {
                ticksBelow++;
                liquidityBelow += BigInt(Math.abs(Number(tick.liquidityNet)));
            }
        }

        // Calculate concentration score (0-1, higher = more concentrated around current price)
        const totalTicks = ticks.length;
        const centerTicks = ticks.filter(t =>
            Math.abs(t.index - currentTick) < this.tickWindow / 4
        ).length;
        const concentrationScore = totalTicks > 0 ? centerTicks / totalTicks : 0;

        // Estimate active liquidity in USD (very rough)
        // This would need token prices for accurate USD value
        const activeLiquidityUSD = Number(currentLiquidity) / 1e15;

        return {
            currentTick,
            currentLiquidity: currentLiquidity.toString(),
            ticksAnalyzed: totalTicks,
            ticksAbove,
            ticksBelow,
            liquidityAbove: liquidityAbove.toString(),
            liquidityBelow: liquidityBelow.toString(),
            concentrationScore,
            activeLiquidityUSD,
            feeTier,
            depthScore: Math.min(1, (ticksAbove + ticksBelow) / 20), // 0-1 based on tick depth
        };
    }

    /**
     * Create empty analysis for error cases
     * @private
     */
    _createEmptyAnalysis(currentTick, currentLiquidity, feeTier) {
        return {
            currentTick,
            currentLiquidity: currentLiquidity.toString(),
            ticksAnalyzed: 0,
            ticksAbove: 0,
            ticksBelow: 0,
            liquidityAbove: '0',
            liquidityBelow: '0',
            concentrationScore: 0,
            activeLiquidityUSD: 0,
            feeTier,
            depthScore: 0,
        };
    }

    /**
     * Get relevant ticks for swap direction
     * @private
     */
    _getRelevantTicks(ticks, currentTick, zeroForOne) {
        return ticks
            .filter(t => zeroForOne ? t.index < currentTick : t.index > currentTick)
            .sort((a, b) => zeroForOne ? b.index - a.index : a.index - b.index);
    }

    /**
     * Find next initialized tick in swap direction
     * @private
     */
    _findNextTick(relevantTicks, currentTick, zeroForOne) {
        for (const tick of relevantTicks) {
            if (zeroForOne && tick.index < currentTick) return tick.index;
            if (!zeroForOne && tick.index > currentTick) return tick.index;
        }
        return null;
    }

    /**
     * Convert tick to sqrt price
     * @private
     */
    _tickToSqrtPrice(tick) {
        // sqrtPrice = sqrt(1.0001^tick) * 2^96
        const sqrtRatio = Math.sqrt(Math.pow(1.0001, tick));
        return BigInt(Math.floor(sqrtRatio * Number(this.Q96)));
    }

    /**
     * Convert sqrt price to readable price
     * @private
     */
    _sqrtPriceToPrice(sqrtPriceX96) {
        const sqrtPrice = Number(sqrtPriceX96) / Number(this.Q96);
        return sqrtPrice * sqrtPrice;
    }

    /**
     * Calculate output within a single tick range (no crossing)
     * @private
     */
    _calculateOutputInRange(amountIn, sqrtPrice, liquidity, zeroForOne) {
        if (liquidity === 0n) return { amountOut: 0n, amountUsed: amountIn };

        // Simplified constant product: amountOut ≈ amountIn * price * (1 - impact)
        const price = this._sqrtPriceToPrice(sqrtPrice);
        const amountInNum = Number(amountIn);

        let amountOut;
        if (zeroForOne) {
            amountOut = BigInt(Math.floor(amountInNum * price * 0.997));
        } else {
            amountOut = BigInt(Math.floor(amountInNum / price * 0.997));
        }

        return { amountOut, amountUsed: amountIn };
    }

    /**
     * Calculate output up to a specific tick
     * @private
     */
    _calculateOutputToTick(amountIn, sqrtPriceCurrent, sqrtPriceTarget, liquidity, zeroForOne) {
        // Simplified: calculate how much input would move price to target
        const priceCurrent = this._sqrtPriceToPrice(sqrtPriceCurrent);
        const priceTarget = this._sqrtPriceToPrice(sqrtPriceTarget);

        const priceChange = Math.abs(priceTarget - priceCurrent);
        const liquidityNum = Number(liquidity) / 1e18;

        // Amount to move price to target tick (approximation)
        const amountToTarget = liquidityNum * priceChange * 1e18;
        const amountUsed = BigInt(Math.min(Number(amountIn), amountToTarget));

        const avgPrice = (priceCurrent + priceTarget) / 2;
        let amountOut;
        if (zeroForOne) {
            amountOut = BigInt(Math.floor(Number(amountUsed) * avgPrice));
        } else {
            amountOut = BigInt(Math.floor(Number(amountUsed) / avgPrice));
        }

        return { amountOut, amountUsed };
    }

    /**
     * Update liquidity after crossing a tick
     * @private
     */
    _updateLiquidity(currentLiquidity, crossedTick, ticks, zeroForOne) {
        const tick = ticks.find(t => t.index === crossedTick);
        if (!tick) return currentLiquidity;

        const liquidityNet = BigInt(tick.liquidityNet || 0);

        // When crossing tick going down (zeroForOne), subtract liquidityNet
        // When crossing tick going up (!zeroForOne), add liquidityNet
        if (zeroForOne) {
            return currentLiquidity - liquidityNet;
        } else {
            return currentLiquidity + liquidityNet;
        }
    }

    /**
     * Extract fee from tier key string
     * @private
     */
    _extractFee(tierKey) {
        const match = tierKey.match(/(\d+)$/);
        if (match) {
            return parseInt(match[1]) / 1000000;
        }
        return 0.003;
    }

    /**
     * Estimate price impact for trade size
     * @private
     */
    _estimatePriceImpact(tradeSizeUSD, liquidityUSD) {
        if (liquidityUSD <= 0) return 100;
        // Simplified: 1% of liquidity = ~0.5% price impact
        return (tradeSizeUSD / liquidityUSD) * 50;
    }

    // ==================== v3.1 Enhanced Methods ====================

    /**
     * Track tick crossing for real-time detection
     *
     * Call this method when receiving Swap events from V3 pools.
     * Emits 'tickCrossing' event when significant ticks are crossed.
     *
     * @param {string} poolAddress - V3 pool address
     * @param {number} newTick - Current tick after swap
     * @param {BigInt} newLiquidity - Current liquidity after swap
     * @param {Object} metadata - Additional swap data { blockNumber, txHash, etc. }
     * @returns {Object|null} Tick crossing info if threshold exceeded
     */
    trackTickCrossing(poolAddress, newTick, newLiquidity, metadata = {}) {
        const tracker = this.tickCrossingTracker.get(poolAddress);
        const now = Date.now();

        if (!tracker) {
            // First observation - just store state
            this.tickCrossingTracker.set(poolAddress, {
                lastTick: newTick,
                lastLiquidity: newLiquidity,
                lastUpdate: now,
            });
            return null;
        }

        const ticksCrossed = Math.abs(newTick - tracker.lastTick);
        const liquidityDelta = newLiquidity - tracker.lastLiquidity;
        const timeDelta = now - tracker.lastUpdate;

        // Update tracker
        this.tickCrossingTracker.set(poolAddress, {
            lastTick: newTick,
            lastLiquidity: newLiquidity,
            lastUpdate: now,
        });

        // Check if significant ticks crossed
        if (ticksCrossed >= this.tickCrossingThreshold) {
            this.stats.tickCrossingsDetected++;

            const crossingEvent = {
                poolAddress,
                previousTick: tracker.lastTick,
                newTick,
                ticksCrossed,
                direction: newTick > tracker.lastTick ? 'up' : 'down',
                liquidityDelta: liquidityDelta.toString(),
                timeDeltaMs: timeDelta,
                priceChangePercent: this._ticksToPercent(ticksCrossed),
                ...metadata,
                timestamp: now,
            };

            this.emit('tickCrossing', crossingEvent);

            log.debug('V3 tick crossing detected', {
                pool: poolAddress.slice(0, 10) + '...',
                ticksCrossed,
                direction: crossingEvent.direction,
            });

            return crossingEvent;
        }

        return null;
    }

    /**
     * Track liquidity changes for JIT detection
     *
     * JIT (Just-In-Time) liquidity is when MEV searchers add liquidity
     * just before a large swap and remove it right after, capturing fees.
     *
     * @param {string} poolAddress - V3 pool address
     * @param {BigInt} liquidityDelta - Change in liquidity (+ for add, - for remove)
     * @param {number} tick - Tick where liquidity changed
     * @param {Object} metadata - { blockNumber, txHash, provider, etc. }
     */
    trackLiquidityChange(poolAddress, liquidityDelta, tick, metadata = {}) {
        const now = Date.now();

        if (!this.jitTracker.has(poolAddress)) {
            this.jitTracker.set(poolAddress, {
                liquidityChanges: [],
                baseLiquidity: 0n,
            });
        }

        const tracker = this.jitTracker.get(poolAddress);

        // Add new change
        tracker.liquidityChanges.push({
            timestamp: now,
            delta: liquidityDelta,
            tick,
            ...metadata,
        });

        // Clean old entries outside window
        const cutoff = now - this.jitWindow;
        tracker.liquidityChanges = tracker.liquidityChanges.filter(
            c => c.timestamp > cutoff
        );

        // Check for JIT pattern
        const jitPattern = this._detectJitPattern(tracker.liquidityChanges, tick);
        if (jitPattern) {
            this.stats.jitLiquidityEvents++;
            this.emit('jitLiquidity', {
                poolAddress,
                pattern: jitPattern,
                timestamp: now,
            });

            log.info('Potential JIT liquidity detected', {
                pool: poolAddress.slice(0, 10) + '...',
                pattern: jitPattern.type,
                magnitude: jitPattern.magnitude,
            });
        }
    }

    /**
     * Detect JIT liquidity pattern from recent changes
     * @private
     */
    _detectJitPattern(changes, currentTick) {
        if (changes.length < 2) return null;

        // Group by tick
        const byTick = new Map();
        for (const change of changes) {
            if (!byTick.has(change.tick)) {
                byTick.set(change.tick, []);
            }
            byTick.get(change.tick).push(change);
        }

        // Look for add-then-remove pattern at same tick
        for (const [tick, tickChanges] of byTick) {
            if (tickChanges.length < 2) continue;

            // Sort by timestamp
            tickChanges.sort((a, b) => a.timestamp - b.timestamp);

            // Look for large add followed by removal
            for (let i = 0; i < tickChanges.length - 1; i++) {
                const add = tickChanges[i];
                const remove = tickChanges[i + 1];

                if (add.delta > 0n && remove.delta < 0n) {
                    const addAmount = add.delta;
                    const removeAmount = -remove.delta;
                    const timeBetween = remove.timestamp - add.timestamp;

                    // JIT pattern: add and remove similar amounts within short window
                    const similarity = Number(removeAmount) / Number(addAmount);
                    if (similarity > 0.8 && similarity < 1.2 && timeBetween < 30000) {
                        return {
                            type: 'add-remove',
                            tick,
                            addedLiquidity: addAmount.toString(),
                            removedLiquidity: removeAmount.toString(),
                            timeBetweenMs: timeBetween,
                            magnitude: Number(addAmount) / 1e18, // Normalized
                            isNearCurrentTick: Math.abs(tick - currentTick) < 100,
                        };
                    }
                }
            }
        }

        return null;
    }

    /**
     * Calculate liquidity depth at various price levels
     *
     * Returns how much can be traded at each price deviation level.
     * Useful for optimal trade sizing.
     *
     * @param {string} poolAddress - V3 pool address
     * @param {Object} slot0 - Current pool state { sqrtPriceX96, tick }
     * @param {BigInt} currentLiquidity - Current tick's liquidity
     * @param {number} feeTier - Pool fee tier
     * @param {number} maxPriceDeviation - Maximum price deviation to analyze (default 5%)
     * @returns {Object} Liquidity depth profile
     */
    async calculateLiquidityDepth(poolAddress, slot0, currentLiquidity, feeTier, maxPriceDeviation = 5) {
        this.stats.depthAnalyses++;

        // Check cache first
        const cacheKey = `depth:${poolAddress}:${slot0.tick}`;
        const cached = this.depthCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < this.depthCacheMaxAge) {
            return cached.data;
        }

        const currentTick = Number(slot0.tick);
        const tickSpace = this.tickSpacing[feeTier] || 60;

        // Fetch tick data if not already cached
        const ticks = await this._fetchTickData(poolAddress, currentTick, tickSpace, feeTier);

        // Calculate depth at various levels (0.5%, 1%, 2%, 3%, 5%)
        const levels = [0.5, 1, 2, 3, 5].filter(l => l <= maxPriceDeviation);
        const depthProfile = {
            poolAddress,
            currentTick,
            currentLiquidity: currentLiquidity.toString(),
            feeTier,
            levels: {},
            timestamp: Date.now(),
        };

        for (const level of levels) {
            const ticksForLevel = Math.floor(level * 100); // ~1% = 100 ticks

            // Calculate capacity in each direction
            const buyDepth = this._calculateDirectionalDepth(
                ticks, currentTick, currentLiquidity, ticksForLevel, true // zeroForOne
            );
            const sellDepth = this._calculateDirectionalDepth(
                ticks, currentTick, currentLiquidity, ticksForLevel, false
            );

            depthProfile.levels[`${level}%`] = {
                buyCapacity: buyDepth.capacity.toString(),
                sellCapacity: sellDepth.capacity.toString(),
                ticksTraversed: Math.max(buyDepth.ticks, sellDepth.ticks),
                liquidityUtilized: buyDepth.liquidityUsed.toString(),
            };
        }

        // Compute overall depth score (0-1)
        depthProfile.depthScore = this._computeDepthScore(depthProfile, ticks);

        // Cache result
        this.depthCache.set(cacheKey, {
            data: depthProfile,
            timestamp: Date.now(),
        });

        return depthProfile;
    }

    /**
     * Calculate directional depth (how much can be traded in one direction)
     * @private
     */
    _calculateDirectionalDepth(ticks, currentTick, currentLiquidity, maxTicks, zeroForOne) {
        let capacity = 0n;
        let liquidityUsed = 0n;
        let ticksTraversed = 0;
        let liquidity = currentLiquidity;

        const relevantTicks = this._getRelevantTicks(ticks, currentTick, zeroForOne);

        for (const tick of relevantTicks) {
            const tickDistance = Math.abs(tick.index - currentTick);
            if (tickDistance > maxTicks) break;

            // Simplified capacity calculation based on liquidity at this tick
            const tickCapacity = liquidity / 1000n; // Very rough estimate
            capacity += tickCapacity;
            liquidityUsed += liquidity;
            ticksTraversed++;

            // Update liquidity after crossing
            liquidity = this._updateLiquidity(liquidity, tick.index, relevantTicks, zeroForOne);
            if (liquidity <= 0n) break;
        }

        return { capacity, liquidityUsed, ticks: ticksTraversed };
    }

    /**
     * Compute overall depth score
     * @private
     */
    _computeDepthScore(profile, ticks) {
        // Score based on:
        // 1. Number of initialized ticks (depth)
        // 2. Liquidity concentration around current price
        // 3. Balance between buy and sell sides

        const tickScore = Math.min(1, ticks.length / 50); // 50+ ticks = perfect

        // Balance score
        const level1 = profile.levels['1%'];
        if (!level1) return tickScore * 0.5;

        const buyCapacity = BigInt(level1.buyCapacity);
        const sellCapacity = BigInt(level1.sellCapacity);
        const total = buyCapacity + sellCapacity;

        if (total === 0n) return 0;

        const buyRatio = Number(buyCapacity) / Number(total);
        const balanceScore = 1 - Math.abs(buyRatio - 0.5) * 2; // Perfect at 0.5

        return (tickScore * 0.6 + balanceScore * 0.4);
    }

    /**
     * Find optimal swap route through ticks
     *
     * For large trades that cross multiple ticks, find the optimal
     * execution strategy considering liquidity at each level.
     *
     * @param {BigInt} amountIn - Input amount
     * @param {Object} slot0 - Current pool state
     * @param {BigInt} currentLiquidity - Current liquidity
     * @param {Array} ticks - Tick data
     * @param {number} feeTier - Fee tier
     * @param {boolean} zeroForOne - Trade direction
     * @returns {Object} Optimal route analysis
     */
    findOptimalSwapRoute(amountIn, slot0, currentLiquidity, ticks, feeTier, zeroForOne) {
        this.stats.optimalRouteCalculations++;

        const currentTick = Number(slot0.tick);
        const sqrtPriceX96 = slot0.sqrtPriceX96;

        // Get relevant ticks in swap direction
        const relevantTicks = this._getRelevantTicks(ticks, currentTick, zeroForOne);

        // Simulate swap step by step
        const route = [];
        let remainingIn = amountIn;
        let totalOut = 0n;
        let liquidity = currentLiquidity;
        let sqrtPrice = sqrtPriceX96;
        let tick = currentTick;

        // Apply fee upfront
        const fee = BigInt(feeTier);
        remainingIn = (remainingIn * (1000000n - fee)) / 1000000n;

        let stepCount = 0;
        const maxSteps = 20; // Safety limit

        while (remainingIn > 0n && stepCount < maxSteps) {
            const nextTick = this._findNextTick(relevantTicks, tick, zeroForOne);

            let stepOutput;
            let amountUsed;

            if (nextTick === null) {
                // No more ticks - process all remaining
                stepOutput = this._calculateOutputInRange(remainingIn, sqrtPrice, liquidity, zeroForOne);
                amountUsed = remainingIn;
            } else {
                // Calculate output to next tick
                const sqrtPriceNext = this._tickToSqrtPrice(nextTick);
                const output = this._calculateOutputToTick(
                    remainingIn, sqrtPrice, sqrtPriceNext, liquidity, zeroForOne
                );
                stepOutput = output;
                amountUsed = output.amountUsed;
            }

            route.push({
                step: stepCount + 1,
                fromTick: tick,
                toTick: nextTick || tick,
                amountIn: amountUsed.toString(),
                amountOut: stepOutput.amountOut.toString(),
                liquidityUsed: liquidity.toString(),
            });

            totalOut += stepOutput.amountOut;
            remainingIn -= amountUsed;

            if (nextTick !== null && remainingIn > 0n) {
                tick = nextTick;
                sqrtPrice = this._tickToSqrtPrice(nextTick);
                liquidity = this._updateLiquidity(liquidity, nextTick, relevantTicks, zeroForOne);
            }

            stepCount++;
        }

        // Calculate effective metrics
        const startPrice = this._sqrtPriceToPrice(sqrtPriceX96);
        const avgPrice = Number(amountIn) > 0 ? Number(totalOut) / Number(amountIn) : 0;

        return {
            route,
            totalAmountIn: amountIn.toString(),
            totalAmountOut: totalOut.toString(),
            stepsRequired: stepCount,
            startPrice,
            avgExecutionPrice: avgPrice,
            priceImpactPercent: startPrice > 0 ? Math.abs((avgPrice - startPrice) / startPrice) * 100 : 0,
            ticksCrossed: stepCount > 1 ? route.length - 1 : 0,
            isComplete: remainingIn === 0n,
            unfilledAmount: remainingIn.toString(),
        };
    }

    /**
     * Convert tick distance to approximate price change percent
     * @private
     */
    _ticksToPercent(ticks) {
        // Each tick is ~0.01% price change (1.0001^tick)
        return (Math.pow(1.0001, ticks) - 1) * 100;
    }

    // ==================== Public API ====================

    /**
     * Get statistics
     */
    getStats() {
        const hitRate = this.stats.cacheHits + this.stats.cacheMisses > 0
            ? (this.stats.cacheHits / (this.stats.cacheHits + this.stats.cacheMisses) * 100).toFixed(1)
            : 0;

        return {
            ...this.stats,
            cacheHitRate: `${hitRate}%`,
            cachedPools: this.tickCache.size,
        };
    }

    /**
     * Reset statistics
     */
    resetStats() {
        this.stats = {
            tickAnalyses: 0,
            feeTierOpportunities: 0,
            crossTickCalculations: 0,
            cacheHits: 0,
            cacheMisses: 0,
            // v3.1 Enhanced stats
            tickCrossingsDetected: 0,
            jitLiquidityEvents: 0,
            depthAnalyses: 0,
            optimalRouteCalculations: 0,
        };
    }

    /**
     * Clear cache
     */
    clearCache() {
        this.tickCache.clear();
    }

    /**
     * Cleanup old cache entries
     */
    cleanup() {
        const now = Date.now();
        let cleaned = 0;

        // Clean tick cache
        for (const [key, data] of this.tickCache) {
            if (now - data.timestamp > this.cacheMaxAge * 2) {
                this.tickCache.delete(key);
                cleaned++;
            }
        }

        // v3.1: Clean depth cache
        for (const [key, data] of this.depthCache) {
            if (now - data.timestamp > this.depthCacheMaxAge * 2) {
                this.depthCache.delete(key);
                cleaned++;
            }
        }

        // v3.1: Clean old tick crossing trackers (inactive for > 5 minutes)
        const trackerCutoff = now - 300000;
        for (const [poolAddress, tracker] of this.tickCrossingTracker) {
            if (tracker.lastUpdate < trackerCutoff) {
                this.tickCrossingTracker.delete(poolAddress);
                cleaned++;
            }
        }

        // v3.1: Clean JIT tracker old entries
        for (const [poolAddress, tracker] of this.jitTracker) {
            const cutoff = now - this.jitWindow;
            tracker.liquidityChanges = tracker.liquidityChanges.filter(
                c => c.timestamp > cutoff
            );
            // Remove tracker if empty
            if (tracker.liquidityChanges.length === 0) {
                this.jitTracker.delete(poolAddress);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            log.debug(`Cleaned ${cleaned} old V3 cache/tracker entries`);
        }
    }

    /**
     * Clear all caches and trackers
     * v3.1: Extended to include new caches
     */
    clearAllTrackers() {
        this.tickCrossingTracker.clear();
        this.jitTracker.clear();
        this.depthCache.clear();
        log.debug('V3 trackers cleared');
    }
}

// Export singleton instance
const v3LiquidityAnalyzer = new V3LiquidityAnalyzer({
    tickWindow: parseInt(process.env.V3_TICK_WINDOW || '100'),
    minLiquidityUSD: parseInt(process.env.V3_MIN_LIQUIDITY_USD || '1000'),
    feeTierSpreadThreshold: parseFloat(process.env.V3_FEE_TIER_THRESHOLD || '0.1'),
    cacheMaxAge: parseInt(process.env.V3_CACHE_MAX_AGE || '30000'),
});

export default v3LiquidityAnalyzer;
export { V3LiquidityAnalyzer };
