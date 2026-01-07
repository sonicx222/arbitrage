import { EventEmitter } from 'events';
import log from '../utils/logger.js';

/**
 * Stablecoin Depeg Detector
 *
 * Monitors stablecoin pairs for price deviations from their pegs.
 * Stablecoin arbitrage opportunities are particularly valuable because:
 *
 * 1. Higher liquidity = larger trade sizes possible
 * 2. Lower volatility = more predictable execution
 * 3. Depeg events create significant spreads (0.5-5%+)
 * 4. Multiple stablecoins per chain = many pair combinations
 *
 * Detected opportunity types:
 * - Cross-DEX stable arbitrage: Same stable pair, different DEX prices
 * - Stable-to-stable arbitrage: USDC->USDT->DAI->USDC cycles
 * - Depeg recovery trades: Buy depegged stable, sell when recovered
 */
export default class StablecoinDetector extends EventEmitter {
    constructor(config = {}) {
        super();

        // Known stablecoins by chain
        this.stablecoinsByChain = config.stablecoinsByChain || this._getDefaultStablecoins();

        // Detection thresholds
        this.depegThreshold = config.depegThreshold || 0.002;      // 0.2% deviation = potential depeg
        this.arbitrageThreshold = config.arbitrageThreshold || 0.003; // 0.3% spread = profitable
        this.severeDepegThreshold = config.severeDepegThreshold || 0.01; // 1% = severe depeg alert

        // Stablecoin pairs should be close to 1.0
        this.expectedPegPrice = 1.0;
        this.pegTolerance = 0.0001; // 0.01% tolerance for "perfect" peg

        // Trade size limits (stables can handle larger sizes)
        this.minTradeSize = config.minTradeSize || 1000;   // $1,000 minimum
        this.maxTradeSize = config.maxTradeSize || 100000; // $100,000 maximum

        // Statistics
        this.stats = {
            depegEvents: 0,
            arbitrageOpportunities: 0,
            severeDepegs: 0,
            lastDepegTime: null,
        };

        // Historical depeg tracking (for pattern analysis)
        this.depegHistory = [];
        this.maxHistorySize = 1000;

        log.info('Stablecoin Detector initialized', {
            stablecoins: Object.keys(this.stablecoinsByChain).length + ' chains',
            depegThreshold: `${this.depegThreshold * 100}%`,
            arbitrageThreshold: `${this.arbitrageThreshold * 100}%`,
        });
    }

    /**
     * Analyze prices for stablecoin arbitrage opportunities
     *
     * @param {number} chainId - Chain ID
     * @param {Object} prices - Price data from priceFetcher
     * @param {number} blockNumber - Current block number
     * @returns {Array} Array of stablecoin opportunities
     */
    analyzeStablecoins(chainId, prices, blockNumber) {
        const opportunities = [];
        const stables = this.stablecoinsByChain[chainId];

        if (!stables || stables.length < 2) {
            return opportunities;
        }

        // 1. Check stable/stable pair prices for depeg
        const depegStatus = this._checkDepegStatus(stables, prices, chainId);

        // 2. Find cross-DEX arbitrage on stable pairs
        const crossDexOpps = this._findCrossDexStableArbitrage(stables, prices, blockNumber);
        opportunities.push(...crossDexOpps);

        // 3. Find triangular stable arbitrage (USDC -> USDT -> DAI -> USDC)
        const triangularOpps = this._findTriangularStableArbitrage(stables, prices, blockNumber);
        opportunities.push(...triangularOpps);

        // 4. Emit depeg alerts if detected
        for (const depeg of depegStatus) {
            if (depeg.severity === 'severe') {
                this.stats.severeDepegs++;
                this.emit('severeDepeg', depeg);
                log.warn(`SEVERE DEPEG DETECTED: ${depeg.stablecoin}`, {
                    deviation: `${(depeg.deviation * 100).toFixed(3)}%`,
                    chainId,
                });
            }
            this._recordDepegEvent(depeg);
        }

        // Sort by estimated profit
        opportunities.sort((a, b) => b.estimatedProfitUSD - a.estimatedProfitUSD);

        if (opportunities.length > 0) {
            this.stats.arbitrageOpportunities += opportunities.length;
            log.debug(`Stablecoin: Found ${opportunities.length} opportunities`, {
                chainId,
                topProfit: `$${opportunities[0].estimatedProfitUSD.toFixed(2)}`,
            });
        }

        return opportunities;
    }

    /**
     * Check depeg status of all stablecoins on a chain
     * @private
     */
    _checkDepegStatus(stables, prices, chainId) {
        const depegStatus = [];

        // Build a price matrix for stables
        for (let i = 0; i < stables.length; i++) {
            for (let j = i + 1; j < stables.length; j++) {
                const stableA = stables[i];
                const stableB = stables[j];

                const pairKey = `${stableA}/${stableB}`;
                const reversePairKey = `${stableB}/${stableA}`;

                // Get price from any DEX
                const pairData = prices[pairKey] || prices[reversePairKey];
                if (!pairData) continue;

                for (const [dexName, data] of Object.entries(pairData)) {
                    let price = data.price;
                    let baseStable = stableA;
                    let quoteStable = stableB;

                    // Normalize to stableA/stableB
                    if (prices[reversePairKey] && !prices[pairKey]) {
                        price = 1 / price;
                        baseStable = stableB;
                        quoteStable = stableA;
                    }

                    // Calculate deviation from 1.0 peg
                    const deviation = Math.abs(price - this.expectedPegPrice);

                    if (deviation >= this.depegThreshold) {
                        const severity = deviation >= this.severeDepegThreshold ? 'severe' :
                                        deviation >= this.depegThreshold * 2 ? 'moderate' : 'minor';

                        // Determine which stable is depegged
                        const depeggedStable = price > 1 ? quoteStable : baseStable;

                        depegStatus.push({
                            stablecoin: depeggedStable,
                            otherStable: price > 1 ? baseStable : quoteStable,
                            price,
                            deviation,
                            severity,
                            direction: price > 1 ? 'premium' : 'discount',
                            dex: dexName,
                            chainId,
                            timestamp: Date.now(),
                        });
                    }
                }
            }
        }

        return depegStatus;
    }

    /**
     * Find cross-DEX arbitrage opportunities on stablecoin pairs
     * @private
     */
    _findCrossDexStableArbitrage(stables, prices, blockNumber) {
        const opportunities = [];

        for (let i = 0; i < stables.length; i++) {
            for (let j = i + 1; j < stables.length; j++) {
                const stableA = stables[i];
                const stableB = stables[j];

                const pairKey = `${stableA}/${stableB}`;
                const reversePairKey = `${stableB}/${stableA}`;

                const pairData = prices[pairKey] || prices[reversePairKey];
                if (!pairData) continue;

                // Get all DEX prices for this pair
                const dexPrices = [];
                for (const [dexName, data] of Object.entries(pairData)) {
                    if (data.price && data.price > 0) {
                        let normalizedPrice = data.price;
                        if (prices[reversePairKey] && !prices[pairKey]) {
                            normalizedPrice = 1 / data.price;
                        }
                        dexPrices.push({
                            dex: dexName,
                            price: normalizedPrice,
                            liquidityUSD: data.liquidityUSD || 0,
                            fee: data.fee || 0.003,
                        });
                    }
                }

                if (dexPrices.length < 2) continue;

                // Sort by price to find best buy (lowest) and sell (highest)
                dexPrices.sort((a, b) => a.price - b.price);
                const buyDex = dexPrices[0];
                const sellDex = dexPrices[dexPrices.length - 1];

                // Calculate spread
                const spread = (sellDex.price - buyDex.price) / buyDex.price;
                const totalFees = buyDex.fee + sellDex.fee;
                const netSpread = spread - totalFees;

                if (netSpread >= this.arbitrageThreshold) {
                    // Calculate optimal trade size based on liquidity
                    const minLiquidity = Math.min(
                        buyDex.liquidityUSD || this.maxTradeSize,
                        sellDex.liquidityUSD || this.maxTradeSize
                    );
                    const optimalSize = Math.min(
                        Math.max(minLiquidity * 0.02, this.minTradeSize), // 2% of min liquidity
                        this.maxTradeSize
                    );

                    const estimatedProfitUSD = optimalSize * netSpread;

                    if (estimatedProfitUSD >= 1) { // Minimum $1 profit
                        opportunities.push({
                            type: 'stable-cross-dex',
                            pairKey: `${stableA}/${stableB}`,
                            tokenA: stableA,
                            tokenB: stableB,
                            buyDex: buyDex.dex,
                            sellDex: sellDex.dex,
                            buyPrice: buyDex.price,
                            sellPrice: sellDex.price,
                            spreadPercent: parseFloat((spread * 100).toFixed(4)),
                            netSpreadPercent: parseFloat((netSpread * 100).toFixed(4)),
                            optimalSizeUSD: parseFloat(optimalSize.toFixed(2)),
                            estimatedProfitUSD: parseFloat(estimatedProfitUSD.toFixed(2)),
                            minLiquidityUSD: minLiquidity,
                            isStablecoin: true,
                            blockNumber,
                            timestamp: Date.now(),
                        });
                    }
                }
            }
        }

        return opportunities;
    }

    /**
     * Find triangular arbitrage opportunities using only stablecoins
     * These are lower risk due to stable prices but also lower margins
     * @private
     */
    _findTriangularStableArbitrage(stables, prices, blockNumber) {
        const opportunities = [];

        if (stables.length < 3) return opportunities;

        // Try all combinations of 3 stables
        for (let i = 0; i < stables.length; i++) {
            for (let j = i + 1; j < stables.length; j++) {
                for (let k = j + 1; k < stables.length; k++) {
                    const stableA = stables[i];
                    const stableB = stables[j];
                    const stableC = stables[k];

                    // Try path: A -> B -> C -> A
                    const result = this._calculateTriangularProfit(
                        [stableA, stableB, stableC, stableA],
                        prices
                    );

                    if (result && result.netProfitPercent >= this.arbitrageThreshold) {
                        const optimalSize = Math.min(
                            result.minLiquidity * 0.02,
                            this.maxTradeSize
                        );
                        const estimatedProfitUSD = optimalSize * result.netProfitPercent;

                        if (estimatedProfitUSD >= 1) {
                            opportunities.push({
                                type: 'stable-triangular',
                                path: result.path,
                                dexes: result.dexes,
                                profitPercent: parseFloat((result.grossProfitPercent * 100).toFixed(4)),
                                netProfitPercent: parseFloat((result.netProfitPercent * 100).toFixed(4)),
                                totalFees: result.totalFees,
                                optimalSizeUSD: parseFloat(optimalSize.toFixed(2)),
                                estimatedProfitUSD: parseFloat(estimatedProfitUSD.toFixed(2)),
                                minLiquidityUSD: result.minLiquidity,
                                isStablecoin: true,
                                blockNumber,
                                timestamp: Date.now(),
                            });
                        }
                    }

                    // Also try reverse: A -> C -> B -> A
                    const reverseResult = this._calculateTriangularProfit(
                        [stableA, stableC, stableB, stableA],
                        prices
                    );

                    if (reverseResult && reverseResult.netProfitPercent >= this.arbitrageThreshold) {
                        const optimalSize = Math.min(
                            reverseResult.minLiquidity * 0.02,
                            this.maxTradeSize
                        );
                        const estimatedProfitUSD = optimalSize * reverseResult.netProfitPercent;

                        if (estimatedProfitUSD >= 1) {
                            opportunities.push({
                                type: 'stable-triangular',
                                path: reverseResult.path,
                                dexes: reverseResult.dexes,
                                profitPercent: parseFloat((reverseResult.grossProfitPercent * 100).toFixed(4)),
                                netProfitPercent: parseFloat((reverseResult.netProfitPercent * 100).toFixed(4)),
                                totalFees: reverseResult.totalFees,
                                optimalSizeUSD: parseFloat(optimalSize.toFixed(2)),
                                estimatedProfitUSD: parseFloat(estimatedProfitUSD.toFixed(2)),
                                minLiquidityUSD: reverseResult.minLiquidity,
                                isStablecoin: true,
                                blockNumber,
                                timestamp: Date.now(),
                            });
                        }
                    }
                }
            }
        }

        return opportunities;
    }

    /**
     * Calculate profit for a triangular path
     * @private
     */
    _calculateTriangularProfit(path, prices) {
        let product = 1;
        let totalFees = 0;
        let minLiquidity = Infinity;
        const dexes = [];

        for (let i = 0; i < path.length - 1; i++) {
            const tokenA = path[i];
            const tokenB = path[i + 1];

            const pairKey = `${tokenA}/${tokenB}`;
            const reversePairKey = `${tokenB}/${tokenA}`;

            const pairData = prices[pairKey] || prices[reversePairKey];
            if (!pairData) return null;

            // Find best price across DEXes
            let bestPrice = null;
            let bestDex = null;
            let bestFee = 0.003;
            let bestLiquidity = 0;

            for (const [dexName, data] of Object.entries(pairData)) {
                if (!data.price || data.price <= 0) continue;

                let normalizedPrice = data.price;
                if (prices[reversePairKey] && !prices[pairKey]) {
                    normalizedPrice = 1 / data.price;
                }

                if (!bestPrice || normalizedPrice > bestPrice) {
                    bestPrice = normalizedPrice;
                    bestDex = dexName;
                    bestFee = data.fee || 0.003;
                    bestLiquidity = data.liquidityUSD || 0;
                }
            }

            if (!bestPrice) return null;

            product *= bestPrice * (1 - bestFee);
            totalFees += bestFee;
            minLiquidity = Math.min(minLiquidity, bestLiquidity);
            dexes.push(bestDex);
        }

        const grossProfitPercent = product - 1;
        const netProfitPercent = grossProfitPercent; // Fees already applied

        return {
            path,
            dexes,
            grossProfitPercent,
            netProfitPercent,
            totalFees,
            minLiquidity: minLiquidity === Infinity ? 0 : minLiquidity,
        };
    }

    /**
     * Record depeg event for historical analysis
     * @private
     */
    _recordDepegEvent(depeg) {
        this.stats.depegEvents++;
        this.stats.lastDepegTime = Date.now();

        this.depegHistory.push({
            ...depeg,
            recordedAt: Date.now(),
        });

        // Trim history
        if (this.depegHistory.length > this.maxHistorySize) {
            this.depegHistory.shift();
        }
    }

    /**
     * Get default stablecoins by chain
     * @private
     */
    _getDefaultStablecoins() {
        return {
            // BSC (56)
            56: ['USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'FDUSD'],

            // Ethereum (1)
            1: ['USDT', 'USDC', 'DAI', 'FRAX', 'TUSD', 'LUSD'],

            // Polygon (137)
            137: ['USDT', 'USDC', 'USDC.e', 'DAI', 'FRAX', 'miMATIC'],

            // Arbitrum (42161)
            42161: ['USDT', 'USDC', 'USDC.e', 'DAI', 'FRAX', 'MIM'],

            // Base (8453)
            8453: ['USDC', 'USDbC', 'DAI'],

            // Avalanche (43114)
            43114: ['USDT', 'USDC', 'USDT.e', 'USDC.e', 'DAI.e', 'FRAX'],
        };
    }

    /**
     * Add custom stablecoins for a chain
     */
    addStablecoins(chainId, stablecoins) {
        if (!this.stablecoinsByChain[chainId]) {
            this.stablecoinsByChain[chainId] = [];
        }
        this.stablecoinsByChain[chainId].push(...stablecoins);
        // Remove duplicates
        this.stablecoinsByChain[chainId] = [...new Set(this.stablecoinsByChain[chainId])];
    }

    /**
     * Check if a token is a known stablecoin
     */
    isStablecoin(chainId, tokenSymbol) {
        const stables = this.stablecoinsByChain[chainId] || [];
        return stables.includes(tokenSymbol);
    }

    /**
     * Get recent depeg events
     */
    getRecentDepegs(limit = 10) {
        return this.depegHistory.slice(-limit);
    }

    /**
     * Get depeg statistics
     */
    getStats() {
        return {
            ...this.stats,
            historySize: this.depegHistory.length,
            chainsMonitored: Object.keys(this.stablecoinsByChain).length,
        };
    }

    /**
     * Clear depeg history
     */
    clearHistory() {
        this.depegHistory = [];
    }
}
