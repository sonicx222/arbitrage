import { EventEmitter } from 'events';
import log from '../utils/logger.js';
import { crossChainTokens, chainNames } from '../config/index.js';

/**
 * CrossChainDetector - Detects arbitrage opportunities across different blockchains
 *
 * Monitors the same asset across multiple chains and identifies when price
 * discrepancies exceed bridge costs, creating profitable arbitrage opportunities.
 *
 * Types of cross-chain arbitrage detected:
 * 1. Same token price discrepancy (USDC on ETH vs USDC on Polygon)
 * 2. Wrapped asset premium/discount (WETH on BSC vs ETH on Ethereum)
 */
export default class CrossChainDetector extends EventEmitter {
    constructor(config = {}) {
        super();

        // Token mappings across chains
        this.tokenMappings = config.tokenMappings || crossChainTokens;

        // Latest prices per chain: chainId -> { tokenSymbol -> { priceUSD, dex, timestamp } }
        this.chainPrices = new Map();

        // Bridge costs and times: "fromChain-toChain" -> { costUSD, estimatedTimeMinutes }
        this.bridgeCosts = config.bridgeCosts || this._getDefaultBridgeCosts();

        // Configuration
        this.minProfitUSD = config.minProfitUSD || 10;
        this.maxPriceAgeMs = config.maxPriceAgeMs || 15000; // 15 seconds
        this.minSpreadPercent = config.minSpreadPercent || 0.5;

        // Statistics
        this.stats = {
            opportunitiesFound: 0,
            priceUpdates: 0,
            lastOpportunityTime: null,
        };

        log.info('CrossChainDetector initialized', {
            tokens: Object.keys(this.tokenMappings).length,
            minProfitUSD: this.minProfitUSD,
        });
    }

    /**
     * Update prices for a specific chain
     * Called by WorkerCoordinator when a chain worker reports prices
     *
     * @param {number} chainId - Chain ID
     * @param {Object} prices - Price data: { "TOKEN/BASE": { dexName: { price, priceUSD, ... } } }
     * @param {number} blockNumber - Block number
     */
    updateChainPrices(chainId, prices, blockNumber) {
        const timestamp = Date.now();
        const chainPriceData = {};

        // Extract token prices from pair data
        for (const [pairKey, dexPrices] of Object.entries(prices)) {
            const [tokenA] = pairKey.split('/');

            // Get best price across DEXes for this token
            let bestPrice = null;
            let bestDex = null;

            for (const [dexName, priceData] of Object.entries(dexPrices)) {
                const priceUSD = priceData.priceUSD || priceData.price;
                if (priceUSD && (!bestPrice || priceUSD > bestPrice)) {
                    bestPrice = priceUSD;
                    bestDex = dexName;
                }
            }

            if (bestPrice && this._isTrackedToken(tokenA)) {
                chainPriceData[tokenA] = {
                    priceUSD: bestPrice,
                    dex: bestDex,
                    pairKey,
                    blockNumber,
                    timestamp,
                };
            }
        }

        this.chainPrices.set(chainId, {
            prices: chainPriceData,
            timestamp,
            blockNumber,
        });

        this.stats.priceUpdates++;

        // Check for cross-chain opportunities
        const opportunities = this.detectCrossChainOpportunities();

        if (opportunities.length > 0) {
            this.emit('opportunities', opportunities);
        }

        return opportunities;
    }

    /**
     * Detect cross-chain arbitrage opportunities
     * Compares prices of the same token across all chains
     *
     * @returns {Array} Array of opportunity objects
     */
    detectCrossChainOpportunities() {
        const opportunities = [];
        const now = Date.now();

        // Get fresh chain data (filter out stale)
        const freshChains = [];
        for (const [chainId, data] of this.chainPrices) {
            if (now - data.timestamp < this.maxPriceAgeMs) {
                freshChains.push({ chainId, ...data });
            }
        }

        // Need at least 2 chains with fresh data
        if (freshChains.length < 2) {
            return opportunities;
        }

        // For each tracked token, compare prices across chains
        for (const tokenSymbol of Object.keys(this.tokenMappings)) {
            const tokenPrices = this._getTokenPricesAcrossChains(tokenSymbol, freshChains);

            if (tokenPrices.length < 2) continue;

            // Sort by price to find best buy (lowest) and sell (highest)
            tokenPrices.sort((a, b) => a.priceUSD - b.priceUSD);

            const buyChain = tokenPrices[0];
            const sellChain = tokenPrices[tokenPrices.length - 1];

            // Skip if same chain
            if (buyChain.chainId === sellChain.chainId) continue;

            // Calculate spread
            const spreadPercent = ((sellChain.priceUSD - buyChain.priceUSD) / buyChain.priceUSD) * 100;

            // Skip if spread too small
            if (spreadPercent < this.minSpreadPercent) continue;

            // Get bridge cost
            const bridgeCost = this._getBridgeCost(buyChain.chainId, sellChain.chainId);

            // Estimate profit for a standard trade size
            const tradeSizeUSD = 10000; // Base calculation on $10k trade
            const grossProfitUSD = tradeSizeUSD * (spreadPercent / 100);
            const netProfitUSD = grossProfitUSD - bridgeCost.costUSD;

            // Check if profitable after bridge costs
            if (netProfitUSD >= this.minProfitUSD) {
                const opportunity = {
                    type: 'cross-chain',
                    token: tokenSymbol,
                    buyChain: {
                        chainId: buyChain.chainId,
                        chainName: chainNames[buyChain.chainId] || `Chain ${buyChain.chainId}`,
                        priceUSD: buyChain.priceUSD,
                        dex: buyChain.dex,
                        blockNumber: buyChain.blockNumber,
                    },
                    sellChain: {
                        chainId: sellChain.chainId,
                        chainName: chainNames[sellChain.chainId] || `Chain ${sellChain.chainId}`,
                        priceUSD: sellChain.priceUSD,
                        dex: sellChain.dex,
                        blockNumber: sellChain.blockNumber,
                    },
                    spreadPercent: parseFloat(spreadPercent.toFixed(4)),
                    bridgeCostUSD: bridgeCost.costUSD,
                    bridgeTimeMinutes: bridgeCost.estimatedTimeMinutes,
                    estimatedProfitUSD: parseFloat(netProfitUSD.toFixed(2)),
                    tradeSizeUSD,
                    timestamp: now,
                };

                opportunities.push(opportunity);
                this.stats.opportunitiesFound++;
                this.stats.lastOpportunityTime = now;

                log.info(`Cross-chain opportunity: ${tokenSymbol}`, {
                    buy: `${opportunity.buyChain.chainName} @ $${buyChain.priceUSD.toFixed(4)}`,
                    sell: `${opportunity.sellChain.chainName} @ $${sellChain.priceUSD.toFixed(4)}`,
                    spread: `${spreadPercent.toFixed(2)}%`,
                    netProfit: `$${netProfitUSD.toFixed(2)}`,
                });
            }
        }

        // Sort by profit
        opportunities.sort((a, b) => b.estimatedProfitUSD - a.estimatedProfitUSD);

        return opportunities;
    }

    /**
     * Get prices for a specific token across all fresh chains
     * @private
     */
    _getTokenPricesAcrossChains(tokenSymbol, freshChains) {
        const prices = [];
        const tokenAddresses = this.tokenMappings[tokenSymbol];

        if (!tokenAddresses) return prices;

        for (const chain of freshChains) {
            // Check if this token exists on this chain
            if (!tokenAddresses[chain.chainId]) continue;

            // Get price data for this token
            const priceData = chain.prices[tokenSymbol];

            if (priceData && priceData.priceUSD > 0) {
                prices.push({
                    chainId: chain.chainId,
                    priceUSD: priceData.priceUSD,
                    dex: priceData.dex,
                    blockNumber: priceData.blockNumber,
                    timestamp: priceData.timestamp,
                });
            }
        }

        return prices;
    }

    /**
     * Check if a token is tracked for cross-chain arbitrage
     * @private
     */
    _isTrackedToken(tokenSymbol) {
        return this.tokenMappings.hasOwnProperty(tokenSymbol);
    }

    /**
     * Get bridge cost between two chains
     * @private
     */
    _getBridgeCost(fromChainId, toChainId) {
        const key = `${fromChainId}-${toChainId}`;
        const reverseKey = `${toChainId}-${fromChainId}`;

        // Check direct route
        if (this.bridgeCosts[key]) {
            return this.bridgeCosts[key];
        }

        // Check reverse route (usually similar cost)
        if (this.bridgeCosts[reverseKey]) {
            return this.bridgeCosts[reverseKey];
        }

        // Default conservative estimate for unknown routes
        return { costUSD: 25, estimatedTimeMinutes: 30 };
    }

    /**
     * Default bridge costs based on Stargate and native bridges
     * @private
     */
    _getDefaultBridgeCosts() {
        return {
            // Stargate routes (fast, ~5 min)
            '1-56': { costUSD: 8, estimatedTimeMinutes: 5 },      // ETH -> BSC
            '1-137': { costUSD: 5, estimatedTimeMinutes: 5 },     // ETH -> Polygon
            '1-42161': { costUSD: 3, estimatedTimeMinutes: 2 },   // ETH -> Arbitrum
            '1-8453': { costUSD: 3, estimatedTimeMinutes: 2 },    // ETH -> Base
            '1-43114': { costUSD: 5, estimatedTimeMinutes: 5 },   // ETH -> Avalanche

            '56-137': { costUSD: 3, estimatedTimeMinutes: 5 },    // BSC -> Polygon
            '56-42161': { costUSD: 4, estimatedTimeMinutes: 5 },  // BSC -> Arbitrum
            '56-43114': { costUSD: 3, estimatedTimeMinutes: 5 },  // BSC -> Avalanche

            '137-42161': { costUSD: 2, estimatedTimeMinutes: 3 }, // Polygon -> Arbitrum
            '137-43114': { costUSD: 3, estimatedTimeMinutes: 5 }, // Polygon -> Avalanche

            '42161-8453': { costUSD: 1, estimatedTimeMinutes: 2 }, // Arbitrum -> Base
            '42161-43114': { costUSD: 3, estimatedTimeMinutes: 5 }, // Arbitrum -> Avalanche

            // L2 to L2 (usually cheaper)
            '8453-42161': { costUSD: 1, estimatedTimeMinutes: 2 }, // Base -> Arbitrum
        };
    }

    /**
     * Add or update a token mapping
     * @param {string} tokenSymbol - Token symbol
     * @param {Object} chainAddresses - { chainId: address }
     */
    addTokenMapping(tokenSymbol, chainAddresses) {
        this.tokenMappings[tokenSymbol] = {
            ...this.tokenMappings[tokenSymbol],
            ...chainAddresses,
        };
    }

    /**
     * Update bridge cost for a route
     * @param {number} fromChainId - Source chain
     * @param {number} toChainId - Destination chain
     * @param {number} costUSD - Bridge cost in USD
     * @param {number} estimatedTimeMinutes - Estimated bridge time
     */
    updateBridgeCost(fromChainId, toChainId, costUSD, estimatedTimeMinutes) {
        const key = `${fromChainId}-${toChainId}`;
        this.bridgeCosts[key] = { costUSD, estimatedTimeMinutes };
    }

    /**
     * Get statistics
     */
    getStats() {
        return {
            ...this.stats,
            chainsTracked: this.chainPrices.size,
            tokensTracked: Object.keys(this.tokenMappings).length,
        };
    }

    /**
     * Clear all price data (useful for testing)
     */
    clearPrices() {
        this.chainPrices.clear();
    }
}
