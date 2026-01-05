import config from '../config.js';
import log from '../utils/logger.js';

/**
 * Triangular Arbitrage Detector
 *
 * Detects profitable triangular arbitrage opportunities within a single DEX.
 * Triangular arbitrage: A -> B -> C -> A where the product of exchange rates > 1
 *
 * Example: WBNB -> CAKE -> USDT -> WBNB
 * If 1 WBNB buys 100 CAKE, 100 CAKE buys 251 USDT, and 251 USDT buys 1.02 WBNB,
 * then profit = 2% (minus fees and gas)
 *
 * Algorithm Complexity: O(DEX * BaseTokens * Tokens^2)
 * With 7 DEXs, 6 base tokens, 100 tokens = ~420,000 path checks per block
 */
class TriangularDetector {
    constructor() {
        // Base tokens to use as cycle start/end (high liquidity)
        this.baseTokens = config.baseTokens || ['WBNB', 'USDT', 'BUSD', 'USDC', 'ETH', 'BTCB'];

        // All tokens available for intermediate hops
        this.allTokens = Object.keys(config.tokens);

        // Minimum profit threshold after fees (percentage)
        this.minProfitPercentage = config.trading.minProfitPercentage || 0.5;

        // Minimum liquidity required per pool (USD)
        this.minLiquidityUSD = config.triangular?.minLiquidityUSD || 5000;

        // Cache for discovered paths (to avoid recalculating)
        this.pathCache = new Map();

        log.info('Triangular Detector initialized', {
            baseTokens: this.baseTokens.length,
            totalTokens: this.allTokens.length,
            minProfit: `${this.minProfitPercentage}%`,
            minLiquidity: `$${this.minLiquidityUSD}`,
        });
    }

    /**
     * Find all triangular arbitrage opportunities from price data
     *
     * @param {Object} prices - Price data from priceFetcher { 'A/B': { dexName: { price, reserves, ... } } }
     * @param {number} blockNumber - Current block number
     * @returns {Array} Array of triangular opportunities
     */
    findTriangularOpportunities(prices, blockNumber) {
        const opportunities = [];
        const startTime = Date.now();

        // Build graph for each DEX
        const dexGraphs = this._buildDexGraphs(prices);

        // For each DEX, find triangular paths
        for (const [dexName, graph] of dexGraphs.entries()) {
            const dexOpps = this._findProfitableCycles(dexName, graph, blockNumber);
            opportunities.push(...dexOpps);
        }

        // Sort by estimated profit (descending)
        opportunities.sort((a, b) => b.estimatedProfitPercent - a.estimatedProfitPercent);

        if (opportunities.length > 0) {
            log.info(`Found ${opportunities.length} triangular opportunities in ${Date.now() - startTime}ms`);
        }

        return opportunities;
    }

    /**
     * Build directed graphs for each DEX from price data
     *
     * @private
     * @param {Object} prices - Price data
     * @returns {Map} Map of dexName -> graph
     */
    _buildDexGraphs(prices) {
        const dexGraphs = new Map();

        for (const [pairKey, dexPrices] of Object.entries(prices)) {
            const [tokenA, tokenB] = pairKey.split('/');

            for (const [dexName, priceData] of Object.entries(dexPrices)) {
                if (!dexGraphs.has(dexName)) {
                    dexGraphs.set(dexName, new Map());
                }

                const graph = dexGraphs.get(dexName);

                // Add edge A -> B (price = how much B you get for 1 A)
                if (!graph.has(tokenA)) {
                    graph.set(tokenA, new Map());
                }
                graph.get(tokenA).set(tokenB, {
                    price: priceData.price,
                    reserveIn: priceData.reserveA,
                    reserveOut: priceData.reserveB,
                    liquidityUSD: priceData.liquidityUSD || 0,
                    pairAddress: priceData.pairAddress,
                });

                // Add reverse edge B -> A (price = 1 / original price)
                if (!graph.has(tokenB)) {
                    graph.set(tokenB, new Map());
                }
                graph.get(tokenB).set(tokenA, {
                    price: priceData.price > 0 ? 1 / priceData.price : 0,
                    reserveIn: priceData.reserveB,
                    reserveOut: priceData.reserveA,
                    liquidityUSD: priceData.liquidityUSD || 0,
                    pairAddress: priceData.pairAddress,
                });
            }
        }

        return dexGraphs;
    }

    /**
     * Find profitable triangular cycles within a single DEX
     *
     * @private
     * @param {string} dexName - Name of the DEX
     * @param {Map} graph - Token graph for this DEX
     * @param {number} blockNumber - Current block number
     * @returns {Array} Array of opportunities
     */
    _findProfitableCycles(dexName, graph, blockNumber) {
        const opportunities = [];
        const dexFee = config.dex[dexName]?.fee || 0.003;
        const feeMultiplier = 1 - dexFee; // What remains after fee

        // For each base token (cycle start/end)
        for (const baseToken of this.baseTokens) {
            if (!graph.has(baseToken)) continue;

            const baseNeighbors = graph.get(baseToken);

            // For each first hop: Base -> A
            for (const [tokenA, edgeBA] of baseNeighbors.entries()) {
                if (tokenA === baseToken) continue;
                if (!this._hasMinLiquidity(edgeBA)) continue;

                const neighborsA = graph.get(tokenA);
                if (!neighborsA) continue;

                // For each second hop: A -> B
                for (const [tokenB, edgeAB] of neighborsA.entries()) {
                    if (tokenB === baseToken || tokenB === tokenA) continue;
                    if (!this._hasMinLiquidity(edgeAB)) continue;

                    // Check third hop: B -> Base
                    const neighborsB = graph.get(tokenB);
                    if (!neighborsB || !neighborsB.has(baseToken)) continue;

                    const edgeBBase = neighborsB.get(baseToken);
                    if (!this._hasMinLiquidity(edgeBBase)) continue;

                    // Calculate cycle profit
                    // Start with 1 unit of Base token
                    // After 3 swaps with fees, how much Base do we have?
                    const rate1 = edgeBA.price * feeMultiplier;      // Base -> A
                    const rate2 = edgeAB.price * feeMultiplier;      // A -> B
                    const rate3 = edgeBBase.price * feeMultiplier;   // B -> Base

                    const cycleProduct = rate1 * rate2 * rate3;
                    const profitPercent = (cycleProduct - 1) * 100;

                    // Only include if profitable after fees
                    if (profitPercent >= this.minProfitPercentage) {
                        const minLiquidity = Math.min(
                            edgeBA.liquidityUSD,
                            edgeAB.liquidityUSD,
                            edgeBBase.liquidityUSD
                        );

                        opportunities.push({
                            type: 'triangular',
                            dexName,
                            path: [baseToken, tokenA, tokenB, baseToken],
                            pairAddresses: [
                                edgeBA.pairAddress,
                                edgeAB.pairAddress,
                                edgeBBase.pairAddress,
                            ],
                            rates: [edgeBA.price, edgeAB.price, edgeBBase.price],
                            reserves: [
                                { in: edgeBA.reserveIn, out: edgeBA.reserveOut },
                                { in: edgeAB.reserveIn, out: edgeAB.reserveOut },
                                { in: edgeBBase.reserveIn, out: edgeBBase.reserveOut },
                            ],
                            cycleProduct,
                            estimatedProfitPercent: profitPercent,
                            totalFeePercent: dexFee * 3 * 100,
                            minLiquidityUSD: minLiquidity,
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
     * Check if an edge has minimum required liquidity
     *
     * @private
     * @param {Object} edge - Graph edge data
     * @returns {boolean}
     */
    _hasMinLiquidity(edge) {
        return edge.liquidityUSD >= this.minLiquidityUSD;
    }

    /**
     * Calculate exact output amount for a triangular path using reserves
     * This accounts for price impact at each step
     *
     * @param {Object} opportunity - Triangular opportunity object
     * @param {BigInt} inputAmount - Amount of base token to trade
     * @param {number} tokenDecimals - Decimals of the base token
     * @returns {Object} { outputAmount, priceImpactPercent, effectiveRate }
     */
    calculateExactOutput(opportunity, inputAmount, tokenDecimals = 18) {
        const { reserves, dexName } = opportunity;
        const fee = config.dex[dexName]?.fee || 0.003;

        let currentAmount = inputAmount;

        // Execute each swap
        for (let i = 0; i < reserves.length; i++) {
            const { in: reserveIn, out: reserveOut } = reserves[i];
            currentAmount = this._getAmountOut(
                currentAmount,
                BigInt(reserveIn),
                BigInt(reserveOut),
                fee
            );
        }

        // Calculate effective rate
        const inputFloat = Number(inputAmount) / Math.pow(10, tokenDecimals);
        const outputFloat = Number(currentAmount) / Math.pow(10, tokenDecimals);
        const effectiveRate = outputFloat / inputFloat;
        const priceImpactPercent = (1 - effectiveRate / opportunity.cycleProduct) * 100;

        return {
            outputAmount: currentAmount,
            profitAmount: currentAmount - inputAmount,
            effectiveRate,
            priceImpactPercent,
        };
    }

    /**
     * Calculate output amount for a swap using Uniswap V2 formula
     *
     * @private
     * @param {BigInt} amountIn - Input amount
     * @param {BigInt} reserveIn - Reserve of input token
     * @param {BigInt} reserveOut - Reserve of output token
     * @param {number} fee - Fee as decimal (e.g., 0.003 for 0.3%)
     * @returns {BigInt} Output amount
     */
    _getAmountOut(amountIn, reserveIn, reserveOut, fee) {
        if (reserveIn === 0n || reserveOut === 0n) return 0n;

        const feeNumerator = BigInt(Math.floor((1 - fee) * 10000));
        const amountInWithFee = amountIn * feeNumerator;
        const numerator = amountInWithFee * reserveOut;
        const denominator = (reserveIn * 10000n) + amountInWithFee;

        return denominator > 0n ? numerator / denominator : 0n;
    }

    /**
     * Find the optimal input amount that maximizes profit
     * Uses binary search to find the sweet spot before price impact kills profit
     *
     * @param {Object} opportunity - Triangular opportunity
     * @param {number} tokenDecimals - Decimals of base token
     * @param {number} maxTradeUSD - Maximum trade size in USD
     * @param {number} baseTokenPriceUSD - Price of base token in USD
     * @returns {Object} { optimalAmount, maxProfitAmount, profitUSD }
     */
    findOptimalTradeSize(opportunity, tokenDecimals = 18, maxTradeUSD = 5000, baseTokenPriceUSD = 1) {
        const minAmount = BigInt(Math.floor((10 / baseTokenPriceUSD) * Math.pow(10, tokenDecimals)));
        const maxAmount = BigInt(Math.floor((maxTradeUSD / baseTokenPriceUSD) * Math.pow(10, tokenDecimals)));

        if (maxAmount <= minAmount) {
            return { optimalAmount: 0n, maxProfitAmount: 0n, profitUSD: 0 };
        }

        let bestProfit = 0n;
        let bestAmount = 0n;

        // Binary search with 20 check points
        const checkPoints = 20;
        const increment = (maxAmount - minAmount) / BigInt(checkPoints);

        if (increment <= 0n) {
            return { optimalAmount: 0n, maxProfitAmount: 0n, profitUSD: 0 };
        }

        for (let i = 0; i <= checkPoints; i++) {
            const testAmount = minAmount + (increment * BigInt(i));
            const result = this.calculateExactOutput(opportunity, testAmount, tokenDecimals);

            if (result.profitAmount > bestProfit) {
                bestProfit = result.profitAmount;
                bestAmount = testAmount;
            } else if (result.profitAmount < bestProfit && bestProfit > 0n) {
                // We've passed the peak, stop searching
                break;
            }
        }

        const profitFloat = Number(bestProfit) / Math.pow(10, tokenDecimals);
        const profitUSD = profitFloat * baseTokenPriceUSD;

        return {
            optimalAmount: bestAmount,
            maxProfitAmount: bestProfit,
            profitUSD,
        };
    }

    /**
     * Get statistics about detected opportunities
     */
    getStats() {
        return {
            baseTokens: this.baseTokens.length,
            totalTokens: this.allTokens.length,
            minProfitThreshold: this.minProfitPercentage,
            minLiquidity: this.minLiquidityUSD,
        };
    }
}

// Export singleton instance
const triangularDetector = new TriangularDetector();
export default triangularDetector;
