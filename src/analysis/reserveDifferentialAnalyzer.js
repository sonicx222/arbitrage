import { EventEmitter } from 'events';
import log from '../utils/logger.js';
import config from '../config.js';

/**
 * Reserve Differential Analyzer
 *
 * Analyzes reserve changes between updates to detect arbitrage opportunities
 * before they're fully arbitraged away.
 *
 * Key insight: When Pool A's reserves change significantly, correlated Pool B
 * (same pair on different DEX) likely has an arbitrage opportunity BEFORE
 * its reserves update.
 *
 * Integrates with EventDrivenDetector for real-time analysis.
 *
 * Expected improvement: +20-40% opportunity detection
 */
class ReserveDifferentialAnalyzer extends EventEmitter {
    constructor(options = {}) {
        super();

        // Reserve history: pairKey -> { reserves, timestamp, blockNumber }
        this.reserveHistory = new Map();

        // Cross-DEX mapping: baseKey (token pair) -> [{ dexName, pairKey, lastReserves }]
        this.crossDexPairs = new Map();

        // Configuration
        this.significantChangeThreshold = options.significantChangeThreshold || 0.5; // 0.5% change
        this.largeChangeThreshold = options.largeChangeThreshold || 2.0; // 2% change (high priority)
        this.maxHistoryAge = options.maxHistoryAge || 30000; // 30 seconds
        this.correlationWindow = options.correlationWindow || 5000; // 5 second window for correlation

        // Statistics
        this.stats = {
            updatesProcessed: 0,
            significantChanges: 0,
            largeChanges: 0,
            correlatedOpportunities: 0,
            priceDisparities: 0,
        };

        log.info('ReserveDifferentialAnalyzer initialized', {
            significantChangeThreshold: `${this.significantChangeThreshold}%`,
            largeChangeThreshold: `${this.largeChangeThreshold}%`,
        });
    }

    /**
     * Process a reserve update from EventDrivenDetector
     * @param {Object} data - Reserve update data
     * @returns {Object|null} Analysis result with potential opportunities
     */
    processReserveUpdate(data) {
        const {
            pairAddress,
            pairKey,
            dexName,
            tokenA,
            tokenB,
            reserves,
            blockNumber,
            timestamp,
        } = data;

        this.stats.updatesProcessed++;

        // Create unique key for this specific pair on this DEX
        const fullPairKey = `${pairKey}:${dexName}`;

        // Create base key for cross-DEX correlation (just the token pair)
        const baseKey = pairKey;

        // Get previous reserves
        const previous = this.reserveHistory.get(fullPairKey);

        // Calculate change magnitude if we have history
        let changeMagnitude = null;
        let changeDirection = null;
        let priceChange = null;

        if (previous && previous.reserves) {
            const analysis = this.analyzeChange(previous.reserves, reserves, tokenA, tokenB);
            changeMagnitude = analysis.magnitude;
            changeDirection = analysis.direction;
            priceChange = analysis.priceChange;
        }

        // Store new reserves
        this.reserveHistory.set(fullPairKey, {
            reserves: {
                reserve0: reserves.reserve0.toString(),
                reserve1: reserves.reserve1.toString(),
            },
            timestamp,
            blockNumber,
            tokenA,
            tokenB,
            price: this.calculatePrice(reserves, tokenA, tokenB),
        });

        // Register in cross-DEX mapping
        this.registerCrossDexPair(baseKey, dexName, fullPairKey, reserves, tokenA, tokenB);

        // Check for significant changes
        const result = {
            fullPairKey,
            baseKey,
            dexName,
            changeMagnitude,
            changeDirection,
            priceChange,
            isSignificant: false,
            isLarge: false,
            correlatedPairs: [],
            potentialOpportunity: null,
        };

        if (changeMagnitude !== null) {
            if (changeMagnitude >= this.largeChangeThreshold) {
                result.isLarge = true;
                result.isSignificant = true;
                this.stats.largeChanges++;
                this.stats.significantChanges++;

                log.debug(`Large reserve change: ${pairKey} on ${dexName}`, {
                    change: `${changeMagnitude.toFixed(3)}%`,
                    direction: changeDirection,
                    priceChange: `${priceChange?.toFixed(4)}%`,
                });

            } else if (changeMagnitude >= this.significantChangeThreshold) {
                result.isSignificant = true;
                this.stats.significantChanges++;
            }

            // If significant change, check correlated pairs for arbitrage
            if (result.isSignificant) {
                const correlation = this.checkCorrelatedPairs(baseKey, dexName, reserves, tokenA, tokenB);
                result.correlatedPairs = correlation.pairs;
                result.potentialOpportunity = correlation.opportunity;

                if (correlation.opportunity) {
                    this.stats.correlatedOpportunities++;

                    this.emit('correlatedOpportunity', {
                        ...result,
                        opportunity: correlation.opportunity,
                        timestamp: Date.now(),
                    });
                }
            }
        }

        // Emit update event for tracking
        this.emit('reserveAnalyzed', result);

        return result;
    }

    /**
     * Analyze the change between previous and current reserves
     * @private
     */
    analyzeChange(previousReserves, currentReserves, tokenA, tokenB) {
        const prev0 = BigInt(previousReserves.reserve0);
        const prev1 = BigInt(previousReserves.reserve1);
        const curr0 = currentReserves.reserve0;
        const curr1 = currentReserves.reserve1;

        // Calculate reserve changes
        const change0 = prev0 > 0n
            ? Number((curr0 - prev0) * 10000n / prev0) / 100
            : 0;
        const change1 = prev1 > 0n
            ? Number((curr1 - prev1) * 10000n / prev1) / 100
            : 0;

        // Overall magnitude is the larger of the two changes
        const magnitude = Math.max(Math.abs(change0), Math.abs(change1));

        // Direction: 'buy' if reserve0 decreased (someone bought token0)
        // 'sell' if reserve0 increased (someone sold token0)
        const direction = change0 < 0 ? 'buy' : 'sell';

        // Calculate price change
        const prevPrice = this.calculatePriceFromRaw(prev0, prev1, tokenA, tokenB);
        const currPrice = this.calculatePriceFromRaw(curr0, curr1, tokenA, tokenB);
        const priceChange = prevPrice > 0
            ? ((currPrice - prevPrice) / prevPrice) * 100
            : 0;

        return {
            magnitude,
            direction,
            priceChange,
            reserve0Change: change0,
            reserve1Change: change1,
        };
    }

    /**
     * Calculate price from reserves
     * @private
     */
    calculatePrice(reserves, tokenA, tokenB) {
        return this.calculatePriceFromRaw(reserves.reserve0, reserves.reserve1, tokenA, tokenB);
    }

    /**
     * Calculate price from raw reserve values
     *
     * FIX v3.2: Added overflow protection when converting BigInt to Number
     * to prevent precision loss with very large reserves
     *
     * @private
     */
    calculatePriceFromRaw(reserve0, reserve1, tokenA, tokenB) {
        const r0 = typeof reserve0 === 'bigint' ? reserve0 : BigInt(reserve0);
        const r1 = typeof reserve1 === 'bigint' ? reserve1 : BigInt(reserve1);

        if (r0 === 0n) return 0;

        // FIX v3.2: Validate token decimals to prevent BigInt errors
        const decimalsA = Number.isInteger(tokenA?.decimals) && tokenA.decimals >= 0
            ? tokenA.decimals
            : 18;
        const decimalsB = Number.isInteger(tokenB?.decimals) && tokenB.decimals >= 0
            ? tokenB.decimals
            : 18;

        const factorA = 10n ** BigInt(decimalsA);
        const factorB = 10n ** BigInt(decimalsB);
        const precision = 10n ** 18n;

        const priceBI = (r1 * factorA * precision) / (r0 * factorB);

        // FIX v3.2: Check for overflow before converting to Number
        // Number.MAX_SAFE_INTEGER is 2^53 - 1 = 9007199254740991
        const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

        if (priceBI > MAX_SAFE) {
            // Scale down to prevent precision loss
            // Use a lower precision scaling factor
            const scaledPriceBI = priceBI / 10n ** 12n; // Reduce precision from 18 to 6 decimals
            if (scaledPriceBI > MAX_SAFE) {
                // Still too large - use floating point calculation as fallback
                // This has some precision loss but prevents complete failure
                log.debug('Price calculation overflow, using fallback', {
                    r0: r0.toString().slice(0, 10) + '...',
                    r1: r1.toString().slice(0, 10) + '...',
                });
                return Number(r1) / Number(r0) * Math.pow(10, decimalsA - decimalsB);
            }
            return Number(scaledPriceBI) / 1e6;
        }

        return Number(priceBI) / 1e18;
    }

    /**
     * Register a pair for cross-DEX correlation tracking
     * @private
     */
    registerCrossDexPair(baseKey, dexName, fullPairKey, reserves, tokenA, tokenB) {
        if (!this.crossDexPairs.has(baseKey)) {
            this.crossDexPairs.set(baseKey, new Map());
        }

        const dexMap = this.crossDexPairs.get(baseKey);
        dexMap.set(dexName, {
            fullPairKey,
            price: this.calculatePrice(reserves, tokenA, tokenB),
            reserves: {
                reserve0: reserves.reserve0.toString(),
                reserve1: reserves.reserve1.toString(),
            },
            timestamp: Date.now(),
            tokenA,
            tokenB,
        });
    }

    /**
     * Check correlated pairs for potential arbitrage after a significant change
     * @private
     */
    checkCorrelatedPairs(baseKey, changedDex, newReserves, tokenA, tokenB) {
        const result = {
            pairs: [],
            opportunity: null,
        };

        const dexMap = this.crossDexPairs.get(baseKey);
        if (!dexMap || dexMap.size < 2) {
            return result; // Need at least 2 DEXs for arbitrage
        }

        const newPrice = this.calculatePrice(newReserves, tokenA, tokenB);
        const now = Date.now();

        let bestSpread = 0;
        let bestOpportunity = null;

        for (const [dexName, pairData] of dexMap) {
            if (dexName === changedDex) continue;

            // Check if the other DEX's data is recent enough
            const age = now - pairData.timestamp;
            if (age > this.maxHistoryAge) {
                continue; // Data too old
            }

            result.pairs.push({
                dexName,
                price: pairData.price,
                age,
            });

            // Calculate spread
            const otherPrice = pairData.price;
            if (otherPrice > 0 && newPrice > 0) {
                const spread = Math.abs(newPrice - otherPrice) / Math.min(newPrice, otherPrice) * 100;

                // Determine buy/sell direction
                const buyDex = newPrice < otherPrice ? changedDex : dexName;
                const sellDex = newPrice < otherPrice ? dexName : changedDex;
                const buyPrice = newPrice < otherPrice ? newPrice : otherPrice;
                const sellPrice = newPrice < otherPrice ? otherPrice : newPrice;

                if (spread > bestSpread) {
                    bestSpread = spread;
                    bestOpportunity = {
                        type: 'cross-dex-differential',
                        pairKey: baseKey,
                        buyDex,
                        sellDex,
                        buyPrice,
                        sellPrice,
                        spreadPercent: spread,
                        source: 'reserve-differential',
                        trigger: {
                            changedDex,
                            priceMovement: newPrice > otherPrice ? 'up' : 'down',
                            laggedDex: dexName,
                            lagMs: age,
                        },
                    };
                }
            }
        }

        // Only report if spread exceeds minimum profitable threshold
        const minProfitThreshold = config.trading?.minProfitPercentage || 0.5;
        if (bestOpportunity && bestSpread >= minProfitThreshold) {
            result.opportunity = bestOpportunity;
            this.stats.priceDisparities++;

            log.debug(`Price disparity detected: ${baseKey}`, {
                spread: `${bestSpread.toFixed(3)}%`,
                buyDex: bestOpportunity.buyDex,
                sellDex: bestOpportunity.sellDex,
                lagMs: bestOpportunity.trigger.lagMs,
            });
        }

        return result;
    }

    /**
     * Get all pairs with recent significant changes
     * @param {number} withinMs - Time window in milliseconds
     * @returns {Array} Pairs with significant changes
     */
    getRecentSignificantChanges(withinMs = 5000) {
        const now = Date.now();
        const recent = [];

        for (const [fullPairKey, data] of this.reserveHistory) {
            if (now - data.timestamp <= withinMs) {
                recent.push({
                    fullPairKey,
                    ...data,
                });
            }
        }

        return recent;
    }

    /**
     * Get price disparity across DEXs for a token pair
     * @param {string} baseKey - Token pair key (e.g., "WBNB/USDT")
     * @returns {Object|null} Price disparity info
     */
    getPriceDisparity(baseKey) {
        const dexMap = this.crossDexPairs.get(baseKey);
        if (!dexMap || dexMap.size < 2) {
            return null;
        }

        const prices = [];
        for (const [dexName, data] of dexMap) {
            prices.push({
                dexName,
                price: data.price,
                timestamp: data.timestamp,
            });
        }

        // Sort by price
        prices.sort((a, b) => a.price - b.price);

        const lowest = prices[0];
        const highest = prices[prices.length - 1];

        const spread = highest.price > 0
            ? ((highest.price - lowest.price) / lowest.price) * 100
            : 0;

        return {
            baseKey,
            lowest,
            highest,
            spreadPercent: spread,
            allPrices: prices,
        };
    }

    /**
     * Get all current price disparities above threshold
     * @param {number} minSpread - Minimum spread percentage
     * @returns {Array} Price disparities
     */
    getAllPriceDisparities(minSpread = 0.3) {
        const disparities = [];

        for (const baseKey of this.crossDexPairs.keys()) {
            const disparity = this.getPriceDisparity(baseKey);
            if (disparity && disparity.spreadPercent >= minSpread) {
                disparities.push(disparity);
            }
        }

        // Sort by spread descending
        disparities.sort((a, b) => b.spreadPercent - a.spreadPercent);

        return disparities;
    }

    /**
     * Clean up old history entries
     */
    cleanup() {
        const now = Date.now();
        const maxAge = this.maxHistoryAge * 2; // Keep 2x the correlation window

        let cleaned = 0;

        for (const [key, data] of this.reserveHistory) {
            if (now - data.timestamp > maxAge) {
                this.reserveHistory.delete(key);
                cleaned++;
            }
        }

        // Also clean up cross-DEX mapping
        for (const [baseKey, dexMap] of this.crossDexPairs) {
            for (const [dexName, data] of dexMap) {
                if (now - data.timestamp > maxAge) {
                    dexMap.delete(dexName);
                }
            }
            if (dexMap.size === 0) {
                this.crossDexPairs.delete(baseKey);
            }
        }

        if (cleaned > 0) {
            log.debug(`Cleaned ${cleaned} old reserve history entries`);
        }
    }

    /**
     * Get statistics
     * @returns {Object} Statistics
     */
    getStats() {
        return {
            ...this.stats,
            trackedPairs: this.reserveHistory.size,
            crossDexPairs: this.crossDexPairs.size,
        };
    }

    /**
     * Reset statistics
     */
    resetStats() {
        this.stats = {
            updatesProcessed: 0,
            significantChanges: 0,
            largeChanges: 0,
            correlatedOpportunities: 0,
            priceDisparities: 0,
        };
    }

    /**
     * Clear all history
     */
    clear() {
        this.reserveHistory.clear();
        this.crossDexPairs.clear();
        this.resetStats();
        log.info('ReserveDifferentialAnalyzer cleared');
    }
}

// Export singleton instance
const reserveDifferentialAnalyzer = new ReserveDifferentialAnalyzer({
    significantChangeThreshold: parseFloat(process.env.RESERVE_CHANGE_THRESHOLD || '0.5'),
    largeChangeThreshold: parseFloat(process.env.RESERVE_LARGE_CHANGE_THRESHOLD || '2.0'),
    maxHistoryAge: parseInt(process.env.RESERVE_HISTORY_AGE || '30000'),
});

export default reserveDifferentialAnalyzer;
export { ReserveDifferentialAnalyzer };
