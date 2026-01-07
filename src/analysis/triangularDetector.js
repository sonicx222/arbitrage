import config from '../config.js';
import log from '../utils/logger.js';

/**
 * Triangular Arbitrage Detector
 *
 * Detects profitable triangular arbitrage opportunities.
 *
 * Key Features:
 * 1. Single-DEX triangular: A -> B -> C -> A on same DEX
 * 2. Cross-DEX triangular: A -> B -> C -> A across different DEXes
 * 3. Golden section search for optimal trade sizing
 * 4. Accurate AMM price calculations using reserves
 *
 * Example: WBNB -> CAKE -> USDT -> WBNB
 * If 1 WBNB buys 100 CAKE, 100 CAKE buys 251 USDT, and 251 USDT buys 1.02 WBNB,
 * then profit = 2% (minus fees and gas)
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

        log.debug('Triangular Detector ready');
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
            log.debug(`Triangular scan: ${opportunities.length} single-DEX paths in ${Date.now() - startTime}ms`);
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

                // Add reverse edge B -> A
                // For AMM pools, reverse price must be calculated from reserves
                // because the constant product formula k = x * y means:
                // - Forward: dy = (y * dx) / (x + dx) => price ≈ y/x
                // - Reverse: dx = (x * dy) / (y + dy) => price ≈ x/y
                if (!graph.has(tokenB)) {
                    graph.set(tokenB, new Map());
                }

                // Calculate reverse price from reserves for accuracy
                let reversePrice;
                const resA = priceData.reserveA ? BigInt(priceData.reserveA) : 0n;
                const resB = priceData.reserveB ? BigInt(priceData.reserveB) : 0n;

                if (resA > 0n && resB > 0n) {
                    // Reverse price (B->A) = reserveA / reserveB
                    reversePrice = Number(resA) / Number(resB);
                } else {
                    // Fallback to simple inverse if no reserves
                    reversePrice = priceData.price > 0 ? 1 / priceData.price : 0;
                }

                graph.get(tokenB).set(tokenA, {
                    price: reversePrice,
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
     * Uses Golden Section Search - converges faster than binary search for unimodal functions
     *
     * The profit function is unimodal: increases then decreases due to price impact.
     * Golden section search finds the maximum in O(log(n)) iterations with better precision.
     *
     * IMPORTANT: Accounts for flash loan fee (0.25%) which is deducted from the borrowed amount
     *
     * @param {Object} opportunity - Triangular opportunity
     * @param {number} tokenDecimals - Decimals of base token
     * @param {number} maxTradeUSD - Maximum trade size in USD
     * @param {number} baseTokenPriceUSD - Price of base token in USD
     * @returns {Object} { optimalAmount, maxProfitAmount, profitUSD }
     */
    findOptimalTradeSize(opportunity, tokenDecimals = 18, maxTradeUSD = null, baseTokenPriceUSD = 1) {
        // Use config values with fallbacks for backwards compatibility
        const MIN_TRADE_USD = config.trading?.minTradeSizeUSD || 10;
        const MAX_TRADE_USD = maxTradeUSD || config.trading?.maxTradeSizeUSD || 5000;

        const minAmount = BigInt(Math.floor((MIN_TRADE_USD / baseTokenPriceUSD) * Math.pow(10, tokenDecimals)));
        const maxAmount = BigInt(Math.floor((MAX_TRADE_USD / baseTokenPriceUSD) * Math.pow(10, tokenDecimals)));

        if (maxAmount <= minAmount) {
            return { optimalAmount: 0n, maxProfitAmount: 0n, profitUSD: 0 };
        }

        // Flash loan fee (0.25% = 0.0025) - must be accounted for in profit calculation
        const flashLoanFee = config.execution?.flashLoanFee || 0.0025;

        // Golden ratio for optimal convergence
        const PHI = 1.618033988749895;
        const RESPHI = 2 - PHI; // 0.382...

        // Convert to numbers for golden section (precision is fine for trade sizing)
        let a = Number(minAmount);
        let b = Number(maxAmount);

        // Initial interior points
        let c = b - RESPHI * (b - a);
        let d = a + RESPHI * (b - a);

        // Evaluate profit at interior points (accounting for flash loan fee)
        const evalProfit = (amount) => {
            const amountBigInt = BigInt(Math.floor(amount));
            const result = this.calculateExactOutput(opportunity, amountBigInt, tokenDecimals);

            // Deduct flash loan fee from profit
            // Flash loan fee is calculated on the borrowed (input) amount
            const flashFeeAmount = (amountBigInt * BigInt(Math.floor(flashLoanFee * 10000))) / 10000n;
            const netProfit = result.profitAmount - flashFeeAmount;

            return Number(netProfit);
        };

        let fc = evalProfit(c);
        let fd = evalProfit(d);

        // Golden section search iterations (15 iterations = ~0.001% precision)
        const MAX_ITERATIONS = 15;
        for (let i = 0; i < MAX_ITERATIONS; i++) {
            if (fc > fd) {
                // Maximum is in [a, d]
                b = d;
                d = c;
                fd = fc;
                c = b - RESPHI * (b - a);
                fc = evalProfit(c);
            } else {
                // Maximum is in [c, b]
                a = c;
                c = d;
                fc = fd;
                d = a + RESPHI * (b - a);
                fd = evalProfit(d);
            }

            // Early termination if interval is small enough
            if (b - a < Number(minAmount) * 0.01) break;
        }

        // Best amount is midpoint of final interval
        const bestAmountFloat = (a + b) / 2;
        const bestAmount = BigInt(Math.floor(bestAmountFloat));
        const result = this.calculateExactOutput(opportunity, bestAmount, tokenDecimals);

        // Calculate net profit after flash loan fee
        const flashFeeAmount = (bestAmount * BigInt(Math.floor(flashLoanFee * 10000))) / 10000n;
        const netProfitAmount = result.profitAmount - flashFeeAmount;

        const profitFloat = Number(netProfitAmount) / Math.pow(10, tokenDecimals);
        const profitUSD = profitFloat * baseTokenPriceUSD;

        return {
            optimalAmount: bestAmount,
            maxProfitAmount: netProfitAmount,
            profitUSD,
        };
    }

    /**
     * Find cross-DEX triangular arbitrage opportunities
     *
     * Unlike single-DEX triangular, this finds paths like:
     * WBNB (PancakeSwap) -> CAKE (BiSwap) -> USDT (SushiSwap) -> WBNB
     *
     * This often has higher profit potential due to price discrepancies
     * between DEXes for the same pair.
     *
     * @param {Object} prices - Price data from priceFetcher
     * @param {number} blockNumber - Current block number
     * @returns {Array} Array of cross-DEX triangular opportunities
     */
    findCrossDexTriangularOpportunities(prices, blockNumber) {
        const opportunities = [];
        const startTime = Date.now();

        // Build unified graph with all DEX edges
        const unifiedGraph = this._buildUnifiedGraph(prices);

        if (unifiedGraph.size === 0) return opportunities;

        // For each base token, find best cross-DEX triangular paths
        for (const baseToken of this.baseTokens) {
            if (!unifiedGraph.has(baseToken)) continue;

            const baseEdges = unifiedGraph.get(baseToken);

            // For each first hop: Base -> A (pick best DEX)
            for (const [tokenA, edgesBA] of baseEdges.entries()) {
                if (tokenA === baseToken) continue;

                // Find best price for Base -> A across all DEXes
                const bestBA = this._findBestEdge(edgesBA, 'buy'); // We're buying A
                if (!bestBA || !this._hasMinLiquidity(bestBA)) continue;

                const neighborsA = unifiedGraph.get(tokenA);
                if (!neighborsA) continue;

                // For each second hop: A -> B (pick best DEX)
                for (const [tokenB, edgesAB] of neighborsA.entries()) {
                    if (tokenB === baseToken || tokenB === tokenA) continue;

                    const bestAB = this._findBestEdge(edgesAB, 'buy');
                    if (!bestAB || !this._hasMinLiquidity(bestAB)) continue;

                    // Check third hop: B -> Base (pick best DEX)
                    const neighborsB = unifiedGraph.get(tokenB);
                    if (!neighborsB || !neighborsB.has(baseToken)) continue;

                    const edgesBBase = neighborsB.get(baseToken);
                    const bestBBase = this._findBestEdge(edgesBBase, 'buy');
                    if (!bestBBase || !this._hasMinLiquidity(bestBBase)) continue;

                    // Skip if all on same DEX (already handled by single-DEX detector)
                    if (bestBA.dex === bestAB.dex && bestAB.dex === bestBBase.dex) continue;

                    // Calculate cycle profit with individual DEX fees
                    const rate1 = bestBA.price * (1 - bestBA.fee);
                    const rate2 = bestAB.price * (1 - bestAB.fee);
                    const rate3 = bestBBase.price * (1 - bestBBase.fee);

                    const cycleProduct = rate1 * rate2 * rate3;
                    const profitPercent = (cycleProduct - 1) * 100;

                    if (profitPercent >= this.minProfitPercentage) {
                        const minLiquidity = Math.min(
                            bestBA.liquidityUSD,
                            bestAB.liquidityUSD,
                            bestBBase.liquidityUSD
                        );

                        const totalFeePercent = (bestBA.fee + bestAB.fee + bestBBase.fee) * 100;

                        opportunities.push({
                            type: 'cross-dex-triangular',
                            path: [baseToken, tokenA, tokenB, baseToken],
                            dexPath: [bestBA.dex, bestAB.dex, bestBBase.dex],
                            pairAddresses: [
                                bestBA.pairAddress,
                                bestAB.pairAddress,
                                bestBBase.pairAddress,
                            ],
                            rates: [bestBA.price, bestAB.price, bestBBase.price],
                            fees: [bestBA.fee, bestAB.fee, bestBBase.fee],
                            reserves: [
                                { in: bestBA.reserveIn, out: bestBA.reserveOut },
                                { in: bestAB.reserveIn, out: bestAB.reserveOut },
                                { in: bestBBase.reserveIn, out: bestBBase.reserveOut },
                            ],
                            cycleProduct,
                            estimatedProfitPercent: profitPercent,
                            totalFeePercent,
                            minLiquidityUSD: minLiquidity,
                            blockNumber,
                            timestamp: Date.now(),
                        });
                    }
                }
            }
        }

        // Sort by profit
        opportunities.sort((a, b) => b.estimatedProfitPercent - a.estimatedProfitPercent);

        if (opportunities.length > 0) {
            log.debug(`Triangular scan: ${opportunities.length} cross-DEX paths in ${Date.now() - startTime}ms`);
        }

        return opportunities;
    }

    /**
     * Build a unified graph with edges from all DEXes
     *
     * @private
     * @param {Object} prices - Price data
     * @returns {Map} token -> Map(neighbor -> Array of edges from different DEXes)
     */
    _buildUnifiedGraph(prices) {
        const graph = new Map();

        for (const [pairKey, dexPrices] of Object.entries(prices)) {
            const [tokenA, tokenB] = pairKey.split('/');

            for (const [dexName, priceData] of Object.entries(dexPrices)) {
                const fee = config.dex[dexName]?.fee || 0.003;

                // Initialize token maps if needed
                if (!graph.has(tokenA)) graph.set(tokenA, new Map());
                if (!graph.has(tokenB)) graph.set(tokenB, new Map());

                // Initialize edge arrays if needed
                const neighborsA = graph.get(tokenA);
                const neighborsB = graph.get(tokenB);
                if (!neighborsA.has(tokenB)) neighborsA.set(tokenB, []);
                if (!neighborsB.has(tokenA)) neighborsB.set(tokenA, []);

                // Calculate reverse price from reserves
                const resA = priceData.reserveA ? BigInt(priceData.reserveA) : 0n;
                const resB = priceData.reserveB ? BigInt(priceData.reserveB) : 0n;
                let reversePrice = priceData.price > 0 ? 1 / priceData.price : 0;
                if (resA > 0n && resB > 0n) {
                    reversePrice = Number(resA) / Number(resB);
                }

                // Add forward edge A -> B
                neighborsA.get(tokenB).push({
                    dex: dexName,
                    price: priceData.price,
                    fee,
                    reserveIn: priceData.reserveA,
                    reserveOut: priceData.reserveB,
                    liquidityUSD: priceData.liquidityUSD || 0,
                    pairAddress: priceData.pairAddress,
                });

                // Add reverse edge B -> A
                neighborsB.get(tokenA).push({
                    dex: dexName,
                    price: reversePrice,
                    fee,
                    reserveIn: priceData.reserveB,
                    reserveOut: priceData.reserveA,
                    liquidityUSD: priceData.liquidityUSD || 0,
                    pairAddress: priceData.pairAddress,
                });
            }
        }

        return graph;
    }

    /**
     * Find the best edge (highest price for buying, lowest for selling)
     *
     * @private
     * @param {Array} edges - Array of edges from different DEXes
     * @param {string} direction - 'buy' for highest price, 'sell' for lowest
     * @returns {Object|null} Best edge or null
     */
    _findBestEdge(edges, direction = 'buy') {
        if (!edges || edges.length === 0) return null;

        // Filter for minimum liquidity first
        const validEdges = edges.filter(e => e.liquidityUSD >= this.minLiquidityUSD);
        if (validEdges.length === 0) return null;

        if (direction === 'buy') {
            // For buying the next token, we want highest price (more output)
            return validEdges.reduce((best, current) =>
                (current.price * (1 - current.fee)) > (best.price * (1 - best.fee)) ? current : best
            );
        } else {
            // For selling, we want lowest price (cheaper input)
            return validEdges.reduce((best, current) =>
                (current.price * (1 - current.fee)) < (best.price * (1 - best.fee)) ? current : best
            );
        }
    }

    /**
     * Calculate exact output for cross-DEX triangular with variable fees
     *
     * @param {Object} opportunity - Cross-DEX triangular opportunity
     * @param {BigInt} inputAmount - Amount of base token to trade
     * @param {number} tokenDecimals - Decimals of the base token
     * @returns {Object} { outputAmount, profitAmount, effectiveRate }
     */
    calculateCrossDexOutput(opportunity, inputAmount, tokenDecimals = 18) {
        const { reserves, fees } = opportunity;

        let currentAmount = inputAmount;

        // Execute each swap with its specific DEX fee
        for (let i = 0; i < reserves.length; i++) {
            const { in: reserveIn, out: reserveOut } = reserves[i];
            const fee = fees[i] || 0.003;
            currentAmount = this._getAmountOut(
                currentAmount,
                BigInt(reserveIn),
                BigInt(reserveOut),
                fee
            );
        }

        const inputFloat = Number(inputAmount) / Math.pow(10, tokenDecimals);
        const outputFloat = Number(currentAmount) / Math.pow(10, tokenDecimals);
        const effectiveRate = outputFloat / inputFloat;

        return {
            outputAmount: currentAmount,
            profitAmount: currentAmount - inputAmount,
            effectiveRate,
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
            supportsCrossDexTriangular: true,
        };
    }
}

// Export singleton instance
const triangularDetector = new TriangularDetector();
export default triangularDetector;
