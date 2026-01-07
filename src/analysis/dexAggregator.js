import { EventEmitter } from 'events';
import config from '../config.js';
import log from '../utils/logger.js';

/**
 * DEX Aggregator Integration
 *
 * Integrates with 1inch and Paraswap routing APIs to find split-route
 * arbitrage opportunities that the direct DEX-to-DEX system might miss.
 *
 * How it works:
 * 1. Compare direct DEX price vs aggregator quote
 * 2. If aggregator finds better route, arbitrage exists
 * 3. Aggregator routes can include DEXs not in our config
 *
 * Supported Aggregators:
 * - 1inch Pathfinder API (free tier: 1 request/second)
 * - Paraswap API (free tier: 1 request/second)
 *
 * Expected Impact: +15-30% more opportunities via split-route detection
 */
class DexAggregator extends EventEmitter {
    constructor() {
        super();

        // Aggregator configurations
        this.aggregators = {
            '1inch': {
                name: '1inch',
                enabled: true,
                baseUrl: 'https://api.1inch.dev/swap/v6.0',
                apiKey: process.env.ONEINCH_API_KEY || null,
                rateLimit: 1000, // 1 request per second for free tier
                supportedChains: [1, 56, 137, 42161, 10, 8453, 43114],
                chainMapping: {
                    1: 1,       // Ethereum
                    56: 56,     // BSC
                    137: 137,   // Polygon
                    42161: 42161, // Arbitrum
                    10: 10,     // Optimism
                    8453: 8453, // Base
                    43114: 43114, // Avalanche
                },
            },
            paraswap: {
                name: 'Paraswap',
                enabled: true,
                baseUrl: 'https://apiv5.paraswap.io',
                apiKey: null, // Paraswap free tier doesn't require API key
                rateLimit: 1000,
                supportedChains: [1, 56, 137, 42161, 10, 43114],
                chainMapping: {
                    1: 1,
                    56: 56,
                    137: 137,
                    42161: 42161,
                    10: 10,
                    43114: 43114,
                },
            },
        };

        // Rate limiting state
        this.lastRequestTime = new Map();

        // Cache for quotes (short TTL due to price volatility)
        this.quoteCache = new Map();
        this.quoteCacheTTL = 3000; // 3 seconds

        // Statistics
        this.stats = {
            quotesRequested: 0,
            quotesReceived: 0,
            quoteErrors: 0,
            opportunitiesFound: 0,
            rateLimitHits: 0,
            cacheHits: 0,
        };

        // Current chain
        this.chainId = config.network?.chainId || 56;

        log.info('DexAggregator initialized', {
            chainId: this.chainId,
            aggregators: Object.keys(this.aggregators).filter(a => this.aggregators[a].enabled),
        });
    }

    /**
     * Initialize for a specific chain
     * @param {number} chainId - Chain ID
     */
    initialize(chainId = null) {
        if (chainId) {
            this.chainId = chainId;
        }

        log.info('DexAggregator ready', {
            chainId: this.chainId,
            supportedAggregators: this.getSupportedAggregators().map(a => a.name),
        });
    }

    /**
     * Get quote from an aggregator
     *
     * @param {string} aggregatorName - '1inch' or 'paraswap'
     * @param {string} fromToken - Source token address
     * @param {string} toToken - Destination token address
     * @param {string} amount - Amount in wei
     * @param {Object} options - Additional options
     * @returns {Promise<Object|null>} Quote result or null
     */
    async getQuote(aggregatorName, fromToken, toToken, amount, options = {}) {
        const aggregator = this.aggregators[aggregatorName];
        if (!aggregator || !aggregator.enabled) {
            return null;
        }

        if (!aggregator.supportedChains.includes(this.chainId)) {
            return null;
        }

        // Check cache
        const cacheKey = `${aggregatorName}:${fromToken}:${toToken}:${amount}`;
        const cached = this.quoteCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < this.quoteCacheTTL) {
            this.stats.cacheHits++;
            return cached.data;
        }

        // Rate limiting
        const now = Date.now();
        const lastRequest = this.lastRequestTime.get(aggregatorName) || 0;
        if (now - lastRequest < aggregator.rateLimit) {
            this.stats.rateLimitHits++;
            // Return cached data if available, even if slightly stale
            if (cached) {
                return cached.data;
            }
            return null;
        }

        this.lastRequestTime.set(aggregatorName, now);
        this.stats.quotesRequested++;

        try {
            let quote;
            if (aggregatorName === '1inch') {
                quote = await this._get1inchQuote(fromToken, toToken, amount, options);
            } else if (aggregatorName === 'paraswap') {
                quote = await this._getParaswapQuote(fromToken, toToken, amount, options);
            }

            if (quote) {
                this.stats.quotesReceived++;
                this.quoteCache.set(cacheKey, { data: quote, timestamp: now });
            }

            return quote;
        } catch (error) {
            this.stats.quoteErrors++;
            log.warn(`${aggregatorName} quote failed`, { error: error.message });
            return null;
        }
    }

    /**
     * Get quote from 1inch API
     * @private
     */
    async _get1inchQuote(fromToken, toToken, amount, options = {}) {
        const chainId = this.aggregators['1inch'].chainMapping[this.chainId];
        const baseUrl = this.aggregators['1inch'].baseUrl;
        const apiKey = this.aggregators['1inch'].apiKey;

        const url = `${baseUrl}/${chainId}/quote?src=${fromToken}&dst=${toToken}&amount=${amount}`;

        const headers = {
            'Accept': 'application/json',
        };

        if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }

        const response = await this._fetch(url, { headers });

        if (!response.ok) {
            throw new Error(`1inch API error: ${response.status}`);
        }

        const data = await response.json();

        return {
            aggregator: '1inch',
            fromToken,
            toToken,
            fromAmount: amount,
            toAmount: data.toAmount || data.dstAmount,
            estimatedGas: data.gas || data.estimatedGas,
            protocols: data.protocols || [],
            timestamp: Date.now(),
        };
    }

    /**
     * Get quote from Paraswap API
     * @private
     */
    async _getParaswapQuote(fromToken, toToken, amount, options = {}) {
        const chainId = this.aggregators.paraswap.chainMapping[this.chainId];
        const baseUrl = this.aggregators.paraswap.baseUrl;

        const url = `${baseUrl}/prices?srcToken=${fromToken}&destToken=${toToken}&amount=${amount}&srcDecimals=18&destDecimals=18&network=${chainId}`;

        const response = await this._fetch(url);

        if (!response.ok) {
            throw new Error(`Paraswap API error: ${response.status}`);
        }

        const data = await response.json();

        if (!data.priceRoute) {
            return null;
        }

        return {
            aggregator: 'paraswap',
            fromToken,
            toToken,
            fromAmount: amount,
            toAmount: data.priceRoute.destAmount,
            estimatedGas: data.priceRoute.gasCost,
            protocols: this._parseParaswapRoute(data.priceRoute),
            timestamp: Date.now(),
        };
    }

    /**
     * Parse Paraswap route into standardized format
     * @private
     */
    _parseParaswapRoute(priceRoute) {
        if (!priceRoute.bestRoute) return [];

        return priceRoute.bestRoute.map(route => ({
            name: route.exchange,
            part: route.percent,
        }));
    }

    /**
     * Compare direct DEX price vs aggregator price
     *
     * @param {string} fromToken - Source token address
     * @param {string} toToken - Destination token address
     * @param {string} amount - Amount in wei
     * @param {number} directPrice - Direct DEX price (output amount)
     * @param {Object} options - Additional options
     * @returns {Promise<Object|null>} Arbitrage opportunity or null
     */
    async findAggregatorArbitrage(fromToken, toToken, amount, directPrice, options = {}) {
        const { minSpreadPercent = 0.5, maxGasCostUSD = 5 } = options;

        // Get quotes from both aggregators
        const quotes = await Promise.all([
            this.getQuote('1inch', fromToken, toToken, amount),
            this.getQuote('paraswap', fromToken, toToken, amount),
        ]);

        const validQuotes = quotes.filter(q => q !== null);

        if (validQuotes.length === 0) {
            return null;
        }

        // Find best aggregator quote
        const bestQuote = validQuotes.reduce((best, quote) => {
            if (!best || BigInt(quote.toAmount) > BigInt(best.toAmount)) {
                return quote;
            }
            return best;
        });

        // Calculate spread
        const aggregatorOutput = BigInt(bestQuote.toAmount);
        const directOutput = BigInt(directPrice);

        if (aggregatorOutput <= directOutput) {
            return null; // No arbitrage - direct is better or equal
        }

        const spreadBigInt = aggregatorOutput - directOutput;
        const spreadPercent = Number(spreadBigInt * 10000n / directOutput) / 100;

        if (spreadPercent < minSpreadPercent) {
            return null; // Spread too small
        }

        // Found opportunity
        this.stats.opportunitiesFound++;

        const opportunity = {
            type: 'aggregator-arbitrage',
            fromToken,
            toToken,
            amount,
            directOutput: directOutput.toString(),
            aggregatorOutput: aggregatorOutput.toString(),
            spreadPercent,
            bestAggregator: bestQuote.aggregator,
            route: bestQuote.protocols,
            estimatedGas: bestQuote.estimatedGas,
            timestamp: Date.now(),
        };

        this.emit('opportunity', opportunity);

        log.info('Aggregator arbitrage found', {
            spread: `${spreadPercent.toFixed(2)}%`,
            aggregator: bestQuote.aggregator,
            fromToken: fromToken.slice(0, 10) + '...',
            toToken: toToken.slice(0, 10) + '...',
        });

        return opportunity;
    }

    /**
     * Batch check multiple pairs for aggregator arbitrage
     *
     * @param {Array} pairs - Array of { fromToken, toToken, amount, directPrice }
     * @param {Object} options - Options
     * @returns {Promise<Array>} Array of opportunities found
     */
    async batchFindArbitrage(pairs, options = {}) {
        const opportunities = [];

        // Process sequentially to respect rate limits
        for (const pair of pairs) {
            const opportunity = await this.findAggregatorArbitrage(
                pair.fromToken,
                pair.toToken,
                pair.amount,
                pair.directPrice,
                options
            );

            if (opportunity) {
                opportunities.push(opportunity);
            }

            // Small delay between requests
            await this._delay(100);
        }

        return opportunities;
    }

    /**
     * Get the best price across all aggregators
     *
     * @param {string} fromToken - Source token
     * @param {string} toToken - Destination token
     * @param {string} amount - Amount in wei
     * @returns {Promise<Object|null>} Best quote
     */
    async getBestPrice(fromToken, toToken, amount) {
        const quotes = await Promise.all([
            this.getQuote('1inch', fromToken, toToken, amount),
            this.getQuote('paraswap', fromToken, toToken, amount),
        ]);

        const validQuotes = quotes.filter(q => q !== null);

        if (validQuotes.length === 0) {
            return null;
        }

        return validQuotes.reduce((best, quote) => {
            if (!best || BigInt(quote.toAmount) > BigInt(best.toAmount)) {
                return quote;
            }
            return best;
        });
    }

    /**
     * Get supported aggregators for current chain
     */
    getSupportedAggregators() {
        return Object.values(this.aggregators).filter(a =>
            a.enabled && a.supportedChains.includes(this.chainId)
        );
    }

    /**
     * Enable or disable an aggregator
     */
    setAggregatorEnabled(name, enabled) {
        if (this.aggregators[name]) {
            this.aggregators[name].enabled = enabled;
            log.info(`Aggregator ${name} ${enabled ? 'enabled' : 'disabled'}`);
        }
    }

    /**
     * Set API key for an aggregator
     */
    setApiKey(aggregatorName, apiKey) {
        if (this.aggregators[aggregatorName]) {
            this.aggregators[aggregatorName].apiKey = apiKey;
            log.info(`API key set for ${aggregatorName}`);
        }
    }

    /**
     * Fetch wrapper with timeout
     * @private
     */
    async _fetch(url, options = {}) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal,
            });
            return response;
        } finally {
            clearTimeout(timeout);
        }
    }

    /**
     * Delay helper
     * @private
     */
    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Clear quote cache
     */
    clearCache() {
        this.quoteCache.clear();
        log.debug('Aggregator quote cache cleared');
    }

    /**
     * Get statistics
     */
    getStats() {
        return {
            ...this.stats,
            chainId: this.chainId,
            cacheSize: this.quoteCache.size,
        };
    }

    /**
     * Reset statistics
     */
    resetStats() {
        this.stats = {
            quotesRequested: 0,
            quotesReceived: 0,
            quoteErrors: 0,
            opportunitiesFound: 0,
            rateLimitHits: 0,
            cacheHits: 0,
        };
    }
}

// Export singleton instance
const dexAggregator = new DexAggregator();
export default dexAggregator;
export { DexAggregator };
