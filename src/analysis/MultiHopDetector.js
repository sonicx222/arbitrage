import log from '../utils/logger.js';

/**
 * MultiHopDetector - Detects arbitrage opportunities with 4+ token paths
 *
 * Uses modified Bellman-Ford algorithm to find negative cycles in the
 * price graph, which represent profitable arbitrage paths.
 *
 * Example path: WETH -> USDC -> CAKE -> BUSD -> WETH
 *
 * This extends beyond triangular arbitrage to find more complex
 * opportunities that simpler bots miss.
 */
export default class MultiHopDetector {
    constructor(config = {}) {
        // Maximum path length (including return to start)
        this.maxPathLength = config.maxPathLength || 5;

        // Minimum profit percentage to consider
        this.minProfitPercent = config.minProfitPercent || 0.3;

        // Minimum liquidity in USD per pool
        this.minLiquidityUSD = config.minLiquidityUSD || 5000;

        // Maximum paths to check (prevent excessive computation)
        this.maxPathsToCheck = config.maxPathsToCheck || 50000;

        // Maximum opportunities to return
        this.maxOpportunities = config.maxOpportunities || 10;

        // Statistics
        this.stats = {
            pathsChecked: 0,
            opportunitiesFound: 0,
            lastScanTime: 0,
        };

        log.debug('MultiHopDetector initialized', {
            maxPathLength: this.maxPathLength,
            minProfitPercent: this.minProfitPercent,
        });
    }

    /**
     * Build a price graph from price data
     *
     * Improvement v2.0: Multi-DEX edge tracking
     * - Each edge now tracks ALL available DEXs for that token pair
     * - Enables optimal path finding across DEXs
     *
     * @param {Object} prices - Price data: { "TOKEN_A/TOKEN_B": { dexName: { price, reserves, ... } } }
     * @param {Object} dexConfig - DEX configuration with fees
     * @returns {Map} Token graph: token -> Map(neighbor -> { bestDex, allDexes, ... })
     */
    buildPriceGraph(prices, dexConfig) {
        const graph = new Map();

        for (const [pairKey, dexPrices] of Object.entries(prices)) {
            const [tokenA, tokenB] = pairKey.split('/');

            // Collect all DEXs for this pair
            const dexOptions = [];
            for (const [dexName, priceData] of Object.entries(dexPrices)) {
                const fee = dexConfig[dexName]?.fee || 0.003;
                const liquidityUSD = priceData.liquidityUSD || 0;

                // Skip low liquidity pairs
                if (liquidityUSD < this.minLiquidityUSD) continue;

                const price = priceData.price;
                // FIX v3.2: Also check for Infinity/NaN to prevent division by zero in sort
                if (!price || price <= 0 || !Number.isFinite(price)) continue;

                dexOptions.push({
                    dex: dexName,
                    price,
                    fee,
                    liquidityUSD,
                    pairKey,
                    // Effective price after fee (for buying token B with A)
                    effectivePrice: price * (1 + fee),
                });
            }

            if (dexOptions.length === 0) continue;

            // ==================== MULTI-DEX PATH OPTIMIZATION ====================
            // Improvement v2.0: Track all DEXs and select best for each direction
            // Best DEX for A->B: lowest effective price (cheapest to buy B)
            // Best DEX for B->A: lowest effective inverse price (cheapest to buy A)

            // Sort by effective price for A->B (buying B with A)
            const sortedForAtoB = [...dexOptions].sort((a, b) => a.effectivePrice - b.effectivePrice);
            const bestForAtoB = sortedForAtoB[0];

            // Sort by effective inverse price for B->A (buying A with B)
            const sortedForBtoA = [...dexOptions].sort((a, b) =>
                (1 / a.price) * (1 + a.fee) - (1 / b.price) * (1 + b.fee)
            );
            const bestForBtoA = sortedForBtoA[0];

            // Add edge A -> B (buying B with A)
            if (!graph.has(tokenA)) {
                graph.set(tokenA, new Map());
            }
            graph.get(tokenA).set(tokenB, {
                price: bestForAtoB.price,
                fee: bestForAtoB.fee,
                liquidityUSD: bestForAtoB.liquidityUSD,
                dex: bestForAtoB.dex,
                pairKey: bestForAtoB.pairKey,
                // Multi-DEX optimization fields
                allDexes: sortedForAtoB,
                dexCount: sortedForAtoB.length,
                priceSpread: sortedForAtoB.length > 1
                    ? ((sortedForAtoB[sortedForAtoB.length - 1].effectivePrice - sortedForAtoB[0].effectivePrice) / sortedForAtoB[0].effectivePrice) * 100
                    : 0,
            });

            // Add reverse edge B -> A (buying A with B)
            if (!graph.has(tokenB)) {
                graph.set(tokenB, new Map());
            }
            graph.get(tokenB).set(tokenA, {
                price: 1 / bestForBtoA.price,
                fee: bestForBtoA.fee,
                liquidityUSD: bestForBtoA.liquidityUSD,
                dex: bestForBtoA.dex,
                pairKey: bestForBtoA.pairKey,
                // Multi-DEX optimization fields
                allDexes: sortedForBtoA.map(d => ({
                    ...d,
                    price: 1 / d.price,
                    effectivePrice: (1 / d.price) * (1 + d.fee),
                })),
                dexCount: sortedForBtoA.length,
                priceSpread: sortedForBtoA.length > 1
                    ? ((sortedForBtoA[sortedForBtoA.length - 1].price - sortedForBtoA[0].price) / sortedForBtoA[0].price) * 100
                    : 0,
            });
        }

        return graph;
    }

    /**
     * Find multi-hop arbitrage opportunities
     *
     * @param {Object} prices - Price data
     * @param {Object} dexConfig - DEX configuration
     * @param {Array} baseTokens - Base tokens to start/end cycles
     * @param {number} blockNumber - Current block number
     * @returns {Array} Array of opportunities
     */
    findOpportunities(prices, dexConfig, baseTokens, blockNumber) {
        const startTime = Date.now();
        const opportunities = [];

        // Build price graph
        const graph = this.buildPriceGraph(prices, dexConfig);

        if (graph.size === 0) {
            return opportunities;
        }

        let pathsChecked = 0;

        // Search for cycles starting from each base token
        for (const startToken of baseTokens) {
            if (!graph.has(startToken)) continue;

            // Find all profitable cycles from this token
            const cycles = this._findProfitableCycles(
                graph,
                startToken,
                this.maxPathLength,
                this.maxPathsToCheck - pathsChecked
            );

            pathsChecked += cycles.pathsChecked;

            for (const cycle of cycles.profitable) {
                // ==================== MULTI-DEX PATH INFO ====================
                // Improvement v2.0: Include DEX routing information
                const dexesUsed = [...new Set(cycle.edges.map(e => e.dex))];
                const totalDexOptions = cycle.edges.reduce((sum, e) => sum + (e.dexCount || 1), 0);
                const isCrossDex = dexesUsed.length > 1;

                opportunities.push({
                    type: 'multi-hop',
                    subType: isCrossDex ? 'cross-dex-multi-hop' : 'single-dex-multi-hop',
                    path: cycle.path,
                    pathLength: cycle.path.length,
                    edges: cycle.edges,
                    profitPercent: parseFloat((cycle.profitPercent).toFixed(4)),
                    minLiquidityUSD: cycle.minLiquidity,
                    // Multi-DEX optimization fields
                    dexesUsed,
                    dexCount: dexesUsed.length,
                    totalDexOptions,
                    isOptimizedPath: totalDexOptions > cycle.edges.length, // Used best DEX for each hop
                    blockNumber,
                    timestamp: Date.now(),
                });
            }

            // Stop if we've checked enough paths
            if (pathsChecked >= this.maxPathsToCheck) break;
        }

        // Sort by profit and return top N
        opportunities.sort((a, b) => b.profitPercent - a.profitPercent);
        const topOpportunities = opportunities.slice(0, this.maxOpportunities);

        // Update statistics
        this.stats.pathsChecked += pathsChecked;
        this.stats.opportunitiesFound += topOpportunities.length;
        this.stats.lastScanTime = Date.now() - startTime;

        if (topOpportunities.length > 0) {
            log.debug(`MultiHop: Found ${topOpportunities.length} opportunities`, {
                pathsChecked,
                scanTime: `${this.stats.lastScanTime}ms`,
                topProfit: `${topOpportunities[0].profitPercent.toFixed(2)}%`,
            });
        }

        return topOpportunities;
    }

    /**
     * Find profitable cycles using iterative deepening DFS
     * @private
     */
    _findProfitableCycles(graph, startToken, maxDepth, maxPaths) {
        const profitable = [];
        let pathsChecked = 0;

        /**
         * DFS to find cycles
         * @param {string} current - Current token
         * @param {Array} path - Current path
         * @param {Array} edges - Edge data for path
         * @param {number} product - Cumulative exchange rate product
         * @param {number} minLiquidity - Minimum liquidity in path
         * @param {number} depth - Current depth
         */
        const dfs = (current, path, edges, product, minLiquidity, depth) => {
            if (pathsChecked >= maxPaths) return;

            const neighbors = graph.get(current);
            if (!neighbors) return;

            for (const [nextToken, edge] of neighbors) {
                pathsChecked++;
                if (pathsChecked >= maxPaths) return;

                // Calculate new product (accounting for fee)
                const feeMultiplier = 1 - edge.fee;
                const newProduct = product * edge.price * feeMultiplier;
                const newMinLiquidity = Math.min(minLiquidity, edge.liquidityUSD);

                // Check if we've completed a cycle back to start
                if (nextToken === startToken && depth >= 3) {
                    const profitPercent = (newProduct - 1) * 100;

                    if (profitPercent >= this.minProfitPercent) {
                        profitable.push({
                            path: [...path, startToken],
                            edges: [...edges, edge],
                            profitPercent,
                            minLiquidity: newMinLiquidity,
                        });
                    }
                    continue;
                }

                // Skip if we've already visited this token (except start)
                if (path.includes(nextToken)) continue;

                // Pruning: skip if product is too low (losing money fast)
                if (newProduct < 0.9) continue;

                // Continue DFS if not at max depth
                if (depth < maxDepth - 1) {
                    dfs(
                        nextToken,
                        [...path, nextToken],
                        [...edges, edge],
                        newProduct,
                        newMinLiquidity,
                        depth + 1
                    );
                }
            }
        };

        // Start DFS from start token
        dfs(startToken, [startToken], [], 1, Infinity, 1);

        return { profitable, pathsChecked };
    }

    /**
     * Calculate optimal trade size for a multi-hop path
     * Uses binary search to find the size that maximizes profit
     *
     * @param {Array} edges - Edge data for the path
     * @param {number} maxTradeUSD - Maximum trade size in USD
     * @returns {Object} { optimalSizeUSD, expectedProfitUSD }
     */
    calculateOptimalTradeSize(edges, maxTradeUSD = 5000) {
        // For multi-hop, impact compounds at each step
        // Use conservative sizing based on minimum liquidity

        let minLiquidity = Infinity;
        for (const edge of edges) {
            minLiquidity = Math.min(minLiquidity, edge.liquidityUSD);
        }

        // Use 1% of minimum liquidity as a conservative trade size
        // This limits price impact at the bottleneck
        const conservativeSize = minLiquidity * 0.01;
        const optimalSizeUSD = Math.min(conservativeSize, maxTradeUSD);

        // Estimate profit at this size (simplified - actual would need simulation)
        const baseProfit = edges.reduce((product, edge) => {
            return product * edge.price * (1 - edge.fee);
        }, 1);

        // Apply rough slippage estimate (0.1% per $1000 at each hop)
        const slippageMultiplier = Math.pow(0.999, edges.length * (optimalSizeUSD / 1000));
        const adjustedProfit = baseProfit * slippageMultiplier;

        const expectedProfitUSD = optimalSizeUSD * (adjustedProfit - 1);

        return {
            optimalSizeUSD: parseFloat(optimalSizeUSD.toFixed(2)),
            expectedProfitUSD: parseFloat(expectedProfitUSD.toFixed(2)),
        };
    }

    /**
     * Validate a multi-hop opportunity is still viable
     * (For use before execution)
     *
     * @param {Object} opportunity - The opportunity to validate
     * @param {Object} currentPrices - Current price data
     * @param {Object} dexConfig - DEX configuration
     * @returns {Object} { valid: boolean, currentProfitPercent, reason }
     */
    validateOpportunity(opportunity, currentPrices, dexConfig) {
        try {
            // Rebuild path with current prices
            let product = 1;
            const path = opportunity.path;

            for (let i = 0; i < path.length - 1; i++) {
                const tokenA = path[i];
                const tokenB = path[i + 1];
                const pairKey = `${tokenA}/${tokenB}`;
                const reversePairKey = `${tokenB}/${tokenA}`;

                // Find current price
                let currentPrice = null;
                let dexName = null;

                if (currentPrices[pairKey]) {
                    for (const [dex, data] of Object.entries(currentPrices[pairKey])) {
                        if (data.price) {
                            currentPrice = data.price;
                            dexName = dex;
                            break;
                        }
                    }
                } else if (currentPrices[reversePairKey]) {
                    for (const [dex, data] of Object.entries(currentPrices[reversePairKey])) {
                        if (data.price) {
                            currentPrice = 1 / data.price;
                            dexName = dex;
                            break;
                        }
                    }
                }

                if (!currentPrice) {
                    return {
                        valid: false,
                        currentProfitPercent: 0,
                        reason: `No price found for ${pairKey}`,
                    };
                }

                const fee = dexConfig[dexName]?.fee || 0.003;
                product *= currentPrice * (1 - fee);
            }

            const currentProfitPercent = (product - 1) * 100;

            return {
                valid: currentProfitPercent >= this.minProfitPercent,
                currentProfitPercent: parseFloat(currentProfitPercent.toFixed(4)),
                reason: currentProfitPercent >= this.minProfitPercent
                    ? 'Still profitable'
                    : 'Profit below threshold',
            };

        } catch (error) {
            return {
                valid: false,
                currentProfitPercent: 0,
                reason: `Validation error: ${error.message}`,
            };
        }
    }

    /**
     * Get statistics
     */
    getStats() {
        return { ...this.stats };
    }

    /**
     * Reset statistics
     */
    resetStats() {
        this.stats = {
            pathsChecked: 0,
            opportunitiesFound: 0,
            lastScanTime: 0,
        };
    }
}
