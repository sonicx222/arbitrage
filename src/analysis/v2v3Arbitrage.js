import { EventEmitter } from 'events';
import log from '../utils/logger.js';
import v3PriceFetcher from '../data/v3PriceFetcher.js';

/**
 * V2/V3 Cross-Arbitrage Detector
 *
 * Detects arbitrage opportunities between Uniswap V2 and V3 pools
 * for the same token pair. This exploits:
 *
 * 1. Price discrepancies due to different liquidity distributions
 * 2. Different fee tiers in V3 vs fixed fees in V2
 * 3. Concentrated liquidity creating tighter spreads in V3
 *
 * Key insight: V3 pools often have better prices for certain size trades
 * due to concentrated liquidity, while V2 can be better for others.
 */
class V2V3Arbitrage extends EventEmitter {
    constructor(config = {}) {
        super();

        // Minimum spread to consider (after fees)
        this.minSpreadPercent = config.minSpreadPercent || 0.15; // 0.15%

        // V2 standard fee (0.3% for most Uniswap V2 forks)
        this.v2Fee = config.v2Fee || 0.003;

        // V3 fee tiers to check
        this.v3FeeTiers = config.v3FeeTiers || [100, 500, 3000, 10000];

        // Minimum liquidity to consider
        this.minLiquidityUSD = config.minLiquidityUSD || 5000;

        // Trade size to optimize for (USD)
        this.targetTradeSizeUSD = config.targetTradeSizeUSD || 1000;

        // Supported chains with both V2 and V3
        this.supportedChains = {
            56: { name: 'BSC', v2: ['pancakeswap', 'biswap'], v3: ['pancakeswap-v3'] },
            1: { name: 'Ethereum', v2: ['uniswap', 'sushiswap'], v3: ['uniswap-v3'] },
            137: { name: 'Polygon', v2: ['quickswap', 'sushiswap'], v3: ['uniswap-v3'] },
            42161: { name: 'Arbitrum', v2: ['sushiswap', 'camelot'], v3: ['uniswap-v3'] },
            8453: { name: 'Base', v2: ['baseswap', 'aerodrome'], v3: ['uniswap-v3'] },
            43114: { name: 'Avalanche', v2: ['traderjoe', 'pangolin'], v3: ['uniswap-v3'] },
        };

        // Stats tracking
        this.stats = {
            pairsAnalyzed: 0,
            opportunitiesFound: 0,
            v2ToBetter: 0,
            v3ToV2Better: 0,
        };

        log.info('V2/V3 Arbitrage detector initialized', {
            minSpreadPercent: this.minSpreadPercent,
            v2Fee: this.v2Fee,
            v3FeeTiers: this.v3FeeTiers,
        });
    }

    /**
     * Analyze V2 and V3 prices for arbitrage opportunities
     *
     * @param {number} chainId - Chain ID
     * @param {Object} v2Prices - V2 price data from priceFetcher
     * @param {Object} v3Prices - V3 price data from v3PriceFetcher (optional)
     * @param {number} blockNumber - Current block number
     * @returns {Array} Array of V2/V3 arbitrage opportunities
     */
    analyzeOpportunities(chainId, v2Prices, v3Prices, blockNumber) {
        if (!this.supportedChains[chainId]) {
            log.debug(`Chain ${chainId} not supported for V2/V3 arbitrage`);
            return [];
        }

        const opportunities = [];
        const chainConfig = this.supportedChains[chainId];

        // Iterate through all pairs with V2 prices
        for (const [pairKey, v2DexPrices] of Object.entries(v2Prices)) {
            // Check if we have V3 prices for this pair
            const v3PairPrices = v3Prices?.[pairKey];
            if (!v3PairPrices) continue;

            this.stats.pairsAnalyzed++;

            // Get best V2 price (lowest for buying)
            const v2Analysis = this._analyzeV2Prices(v2DexPrices, chainConfig.v2);
            if (!v2Analysis) continue;

            // Get best V3 price for each fee tier
            const v3Analysis = this._analyzeV3Prices(v3PairPrices);
            if (!v3Analysis) continue;

            // Check for V2 -> V3 arbitrage (buy on V2, sell on V3)
            const v2ToV3Opp = this._checkV2ToV3Opportunity(
                pairKey, v2Analysis, v3Analysis, blockNumber
            );
            if (v2ToV3Opp) {
                opportunities.push(v2ToV3Opp);
                this.stats.v2ToBetter++;
            }

            // Check for V3 -> V2 arbitrage (buy on V3, sell on V2)
            const v3ToV2Opp = this._checkV3ToV2Opportunity(
                pairKey, v2Analysis, v3Analysis, blockNumber
            );
            if (v3ToV2Opp) {
                opportunities.push(v3ToV2Opp);
                this.stats.v3ToV2Better++;
            }
        }

        if (opportunities.length > 0) {
            this.stats.opportunitiesFound += opportunities.length;
            this.emit('opportunitiesFound', { count: opportunities.length, chainId });

            log.info(`V2/V3 arbitrage opportunities found`, {
                chain: chainConfig.name,
                count: opportunities.length,
                blockNumber,
            });
        }

        return opportunities;
    }

    /**
     * Analyze V2 prices to find best buy/sell prices
     *
     * @private
     */
    _analyzeV2Prices(v2DexPrices, v2Dexes) {
        let bestBuyPrice = Infinity;
        let bestSellPrice = 0;
        let bestBuyDex = null;
        let bestSellDex = null;
        let bestBuyLiquidity = 0;
        let bestSellLiquidity = 0;

        for (const [dexName, priceData] of Object.entries(v2DexPrices)) {
            // Skip non-V2 DEXes
            if (!v2Dexes.some(d => dexName.toLowerCase().includes(d.toLowerCase()))) {
                continue;
            }

            const liquidity = priceData.liquidityUSD || 0;
            if (liquidity < this.minLiquidityUSD) continue;

            if (priceData.price < bestBuyPrice) {
                bestBuyPrice = priceData.price;
                bestBuyDex = dexName;
                bestBuyLiquidity = liquidity;
            }

            if (priceData.price > bestSellPrice) {
                bestSellPrice = priceData.price;
                bestSellDex = dexName;
                bestSellLiquidity = liquidity;
            }
        }

        if (!bestBuyDex || !bestSellDex) return null;

        return {
            buyPrice: bestBuyPrice,
            sellPrice: bestSellPrice,
            buyDex: bestBuyDex,
            sellDex: bestSellDex,
            buyLiquidity: bestBuyLiquidity,
            sellLiquidity: bestSellLiquidity,
            fee: this.v2Fee,
        };
    }

    /**
     * Analyze V3 prices across fee tiers
     *
     * @private
     */
    _analyzeV3Prices(v3PairPrices) {
        let bestBuyPrice = Infinity;
        let bestSellPrice = 0;
        let bestBuyTier = null;
        let bestSellTier = null;
        let bestBuyLiquidity = 0;
        let bestSellLiquidity = 0;

        for (const [tierKey, priceData] of Object.entries(v3PairPrices)) {
            if (!priceData.isV3) continue;

            const liquidity = priceData.liquidityUSD || 0;
            if (liquidity < this.minLiquidityUSD) continue;

            // V3 prices from sqrtPriceX96
            const price = priceData.price;
            const fee = this._getFeeFromTierKey(tierKey);

            if (price < bestBuyPrice) {
                bestBuyPrice = price;
                bestBuyTier = tierKey;
                bestBuyLiquidity = liquidity;
            }

            if (price > bestSellPrice) {
                bestSellPrice = price;
                bestSellTier = tierKey;
                bestSellLiquidity = liquidity;
            }
        }

        if (!bestBuyTier || !bestSellTier) return null;

        return {
            buyPrice: bestBuyPrice,
            sellPrice: bestSellPrice,
            buyTier: bestBuyTier,
            sellTier: bestSellTier,
            buyLiquidity: bestBuyLiquidity,
            sellLiquidity: bestSellLiquidity,
            buyFee: this._getFeeFromTierKey(bestBuyTier),
            sellFee: this._getFeeFromTierKey(bestSellTier),
        };
    }

    /**
     * Extract fee tier from tier key string
     *
     * @private
     */
    _getFeeFromTierKey(tierKey) {
        // Extract number from string like "v3-500" or "pancakeswap-v3-2500"
        const match = tierKey.match(/(\d+)$/);
        if (match) {
            return parseInt(match[1]) / 1000000; // Convert bps to decimal
        }
        return 0.003; // Default to 0.3%
    }

    /**
     * Check for V2 -> V3 arbitrage opportunity
     * Buy on V2 (lower price), sell on V3 (higher price)
     *
     * @private
     */
    _checkV2ToV3Opportunity(pairKey, v2Analysis, v3Analysis, blockNumber) {
        // V2 buy price should be lower than V3 sell price
        if (v2Analysis.buyPrice >= v3Analysis.sellPrice) return null;

        // Calculate effective spread after fees
        const v2BuyCost = v2Analysis.buyPrice * (1 + v2Analysis.fee);
        const v3SellReturn = v3Analysis.sellPrice * (1 - v3Analysis.sellFee);

        const spreadPercent = ((v3SellReturn - v2BuyCost) / v2BuyCost) * 100;

        if (spreadPercent < this.minSpreadPercent) return null;

        // Calculate minimum liquidity
        const minLiquidity = Math.min(v2Analysis.buyLiquidity, v3Analysis.sellLiquidity);

        // Estimate profit at target trade size
        const tradeSize = Math.min(this.targetTradeSizeUSD, minLiquidity * 0.02);
        const estimatedProfitUSD = tradeSize * (spreadPercent / 100);

        const [tokenA, tokenB] = pairKey.split('/');

        return {
            type: 'v2-v3-arb',
            subType: 'v2-to-v3',
            pairKey,
            tokenA,
            tokenB,
            buyDex: v2Analysis.buyDex,
            buyDexType: 'V2',
            sellDex: v3Analysis.sellTier,
            sellDexType: 'V3',
            buyPrice: v2Analysis.buyPrice,
            sellPrice: v3Analysis.sellPrice,
            spreadPercent,
            estimatedProfitUSD,
            tradeSizeUSD: tradeSize,
            minLiquidityUSD: minLiquidity,
            fees: {
                v2: v2Analysis.fee,
                v3: v3Analysis.sellFee,
                total: v2Analysis.fee + v3Analysis.sellFee,
            },
            blockNumber,
            timestamp: Date.now(),
        };
    }

    /**
     * Check for V3 -> V2 arbitrage opportunity
     * Buy on V3 (lower price), sell on V2 (higher price)
     *
     * @private
     */
    _checkV3ToV2Opportunity(pairKey, v2Analysis, v3Analysis, blockNumber) {
        // V3 buy price should be lower than V2 sell price
        if (v3Analysis.buyPrice >= v2Analysis.sellPrice) return null;

        // Calculate effective spread after fees
        const v3BuyCost = v3Analysis.buyPrice * (1 + v3Analysis.buyFee);
        const v2SellReturn = v2Analysis.sellPrice * (1 - v2Analysis.fee);

        const spreadPercent = ((v2SellReturn - v3BuyCost) / v3BuyCost) * 100;

        if (spreadPercent < this.minSpreadPercent) return null;

        // Calculate minimum liquidity
        const minLiquidity = Math.min(v3Analysis.buyLiquidity, v2Analysis.sellLiquidity);

        // Estimate profit at target trade size
        const tradeSize = Math.min(this.targetTradeSizeUSD, minLiquidity * 0.02);
        const estimatedProfitUSD = tradeSize * (spreadPercent / 100);

        const [tokenA, tokenB] = pairKey.split('/');

        return {
            type: 'v2-v3-arb',
            subType: 'v3-to-v2',
            pairKey,
            tokenA,
            tokenB,
            buyDex: v3Analysis.buyTier,
            buyDexType: 'V3',
            sellDex: v2Analysis.sellDex,
            sellDexType: 'V2',
            buyPrice: v3Analysis.buyPrice,
            sellPrice: v2Analysis.sellPrice,
            spreadPercent,
            estimatedProfitUSD,
            tradeSizeUSD: tradeSize,
            minLiquidityUSD: minLiquidity,
            fees: {
                v2: v2Analysis.fee,
                v3: v3Analysis.buyFee,
                total: v2Analysis.fee + v3Analysis.buyFee,
            },
            blockNumber,
            timestamp: Date.now(),
        };
    }

    /**
     * Find best fee tier for a given trade size
     *
     * For concentrated liquidity, different fee tiers have different
     * liquidity distributions. Lower fee tiers are better for larger trades
     * if they have sufficient liquidity.
     *
     * @param {Object} v3Prices - V3 prices for all fee tiers
     * @param {number} tradeSizeUSD - Trade size in USD
     * @returns {Object|null} Best tier analysis
     */
    findBestV3Tier(v3Prices, tradeSizeUSD) {
        if (!v3Prices || Object.keys(v3Prices).length === 0) return null;

        let bestTier = null;
        let bestEffectivePrice = Infinity;

        for (const [tierKey, priceData] of Object.entries(v3Prices)) {
            if (!priceData.isV3) continue;

            const liquidity = priceData.liquidityUSD || 0;
            const fee = this._getFeeFromTierKey(tierKey);

            // Skip tiers with insufficient liquidity
            // Trade should be at most 5% of pool liquidity for minimal impact
            if (liquidity < tradeSizeUSD * 20) continue;

            // Calculate effective price including fee
            const effectivePrice = priceData.price * (1 + fee);

            // Estimate price impact based on liquidity ratio
            const impactMultiplier = 1 + (tradeSizeUSD / liquidity) * 0.5;
            const effectivePriceWithImpact = effectivePrice * impactMultiplier;

            if (effectivePriceWithImpact < bestEffectivePrice) {
                bestEffectivePrice = effectivePriceWithImpact;
                bestTier = {
                    tierKey,
                    fee,
                    liquidity,
                    rawPrice: priceData.price,
                    effectivePrice: effectivePriceWithImpact,
                    priceImpact: (impactMultiplier - 1) * 100,
                };
            }
        }

        return bestTier;
    }

    /**
     * Calculate optimal trade size for V2/V3 arbitrage
     *
     * Considers:
     * - Liquidity depth on both sides
     * - Price impact at different sizes
     * - Fee costs
     *
     * @param {Object} opportunity - V2/V3 arbitrage opportunity
     * @returns {Object} Optimal trade analysis
     */
    calculateOptimalTradeSize(opportunity) {
        const minLiquidity = opportunity.minLiquidityUSD;

        // Start with 0.5% of liquidity, max 5%
        const testSizes = [
            minLiquidity * 0.005,
            minLiquidity * 0.01,
            minLiquidity * 0.02,
            minLiquidity * 0.03,
            minLiquidity * 0.05,
        ];

        let bestSize = testSizes[0];
        let bestProfit = 0;

        for (const size of testSizes) {
            // Estimate price impact (simplified model)
            // Real implementation would use reserve-based calculation
            const impactPercent = (size / minLiquidity) * 50; // 1% size = 0.5% impact

            // Adjust spread for impact
            const adjustedSpread = opportunity.spreadPercent - impactPercent;

            if (adjustedSpread <= 0) continue;

            const profit = size * (adjustedSpread / 100);

            if (profit > bestProfit) {
                bestProfit = profit;
                bestSize = size;
            }
        }

        return {
            optimalSize: bestSize,
            estimatedProfit: bestProfit,
            profitPercent: (bestProfit / bestSize) * 100,
            impactPercent: (bestSize / minLiquidity) * 50,
        };
    }

    /**
     * Get detector statistics
     *
     * @returns {Object} Statistics
     */
    getStats() {
        return {
            ...this.stats,
            v2ToV3Ratio: this.stats.v2ToBetter /
                        (this.stats.v2ToBetter + this.stats.v3ToV2Better + 1),
            supportedChains: Object.keys(this.supportedChains).length,
        };
    }

    /**
     * Reset statistics
     */
    resetStats() {
        this.stats = {
            pairsAnalyzed: 0,
            opportunitiesFound: 0,
            v2ToBetter: 0,
            v3ToV2Better: 0,
        };
    }

    /**
     * Update configuration
     *
     * @param {Object} config - New configuration
     */
    updateConfig(config) {
        if (config.minSpreadPercent !== undefined) {
            this.minSpreadPercent = config.minSpreadPercent;
        }
        if (config.v2Fee !== undefined) {
            this.v2Fee = config.v2Fee;
        }
        if (config.minLiquidityUSD !== undefined) {
            this.minLiquidityUSD = config.minLiquidityUSD;
        }
        if (config.targetTradeSizeUSD !== undefined) {
            this.targetTradeSizeUSD = config.targetTradeSizeUSD;
        }

        log.info('V2/V3 arbitrage config updated', {
            minSpreadPercent: this.minSpreadPercent,
            v2Fee: this.v2Fee,
            minLiquidityUSD: this.minLiquidityUSD,
        });
    }
}

// Export singleton instance
const v2v3Arbitrage = new V2V3Arbitrage();
export default v2v3Arbitrage;
