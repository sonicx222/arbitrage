import EventEmitter from 'events';
import { ethers } from 'ethers';
import log from '../utils/logger.js';
import { FACTORY_ABI } from '../contracts/abis.js';

/**
 * New Pair Monitor
 *
 * Monitors DEX factory contracts for new pair/pool creation events.
 * New pools often have price inefficiencies in the first hours due to:
 * 1. Initial liquidity providers setting prices manually
 * 2. Price discovery phase before arbitrageurs align prices
 * 3. Low liquidity creating high-impact opportunities
 *
 * BSC alone creates 50-100 new pairs per day.
 * This monitor catches these opportunities early.
 */
class NewPairMonitor extends EventEmitter {
    constructor(config = {}) {
        super();

        // Minimum liquidity to consider (USD)
        this.minLiquidityUSD = config.minLiquidityUSD || 1000;

        // Minimum spread to flag as opportunity
        this.minSpreadPercent = config.minSpreadPercent || 0.5;

        // How long to monitor new pairs (ms) - 24 hours default
        this.monitoringWindow = config.monitoringWindow || 24 * 60 * 60 * 1000;

        // Factory addresses by chain
        this.factoryAddresses = config.factoryAddresses || {};

        // Known tokens for price comparison
        this.knownTokens = config.knownTokens || {};

        // Track recent pairs
        this.recentPairs = new Map();
        this.maxRecentPairs = config.maxRecentPairs || 500;

        // Subscription cleanup handlers
        this.subscriptions = [];

        // Statistics
        this.stats = {
            pairsDetected: 0,
            opportunitiesFound: 0,
            pairsAnalyzed: 0,
            subscriptionErrors: 0,
        };

        // Cache for token info
        this.tokenInfoCache = new Map();

        log.info('New Pair Monitor initialized', {
            minLiquidityUSD: this.minLiquidityUSD,
            minSpreadPercent: `${this.minSpreadPercent}%`,
        });
    }

    /**
     * Configure factories for a specific chain
     *
     * @param {number} chainId - Chain ID
     * @param {Object} factories - Factory configurations
     */
    setFactories(chainId, factories) {
        this.factoryAddresses[chainId] = factories;
        log.info(`Factories configured for chain ${chainId}`, {
            count: Object.keys(factories).length,
        });
    }

    /**
     * Set known tokens for price comparison
     *
     * @param {number} chainId - Chain ID
     * @param {Object} tokens - Token configurations { symbol: { address, decimals } }
     */
    setKnownTokens(chainId, tokens) {
        this.knownTokens[chainId] = tokens;
    }

    /**
     * Subscribe to new pair events on a chain
     *
     * @param {number} chainId - Chain ID
     * @param {Object} provider - ethers.js provider (WebSocket preferred)
     */
    async subscribe(chainId, provider) {
        const factories = this.factoryAddresses[chainId];
        if (!factories || Object.keys(factories).length === 0) {
            log.warn(`No factories configured for chain ${chainId}`);
            return;
        }

        for (const [dexName, factoryAddress] of Object.entries(factories)) {
            try {
                await this._subscribeToFactory(chainId, dexName, factoryAddress, provider);
            } catch (error) {
                this.stats.subscriptionErrors++;
                log.error(`Failed to subscribe to ${dexName} factory`, {
                    chainId,
                    error: error.message,
                });
            }
        }
    }

    /**
     * Subscribe to a single factory
     *
     * @private
     */
    async _subscribeToFactory(chainId, dexName, factoryAddress, provider) {
        const factory = new ethers.Contract(factoryAddress, FACTORY_ABI, provider);

        // Listen for PairCreated events
        const filter = factory.filters.PairCreated();

        const listener = async (token0, token1, pairAddress, pairCount, event) => {
            await this._handleNewPair(chainId, dexName, {
                token0,
                token1,
                pairAddress,
                pairCount: Number(pairCount),
                blockNumber: event.blockNumber,
                transactionHash: event.transactionHash,
            });
        };

        factory.on(filter, listener);

        // Store for cleanup
        this.subscriptions.push({
            chainId,
            dexName,
            factory,
            filter,
            listener,
        });

        log.info(`Subscribed to ${dexName} factory on chain ${chainId}`, {
            factoryAddress,
        });
    }

    /**
     * Handle a new pair creation event
     *
     * @private
     */
    async _handleNewPair(chainId, dexName, pairInfo) {
        this.stats.pairsDetected++;

        const { token0, token1, pairAddress, blockNumber } = pairInfo;

        // Get token info
        const token0Info = await this._getTokenInfo(chainId, token0);
        const token1Info = await this._getTokenInfo(chainId, token1);

        const pairKey = `${chainId}:${pairAddress}`;

        // Create pair record
        const pairRecord = {
            chainId,
            dexName,
            pairAddress,
            token0: {
                address: token0,
                symbol: token0Info?.symbol || 'UNKNOWN',
                decimals: token0Info?.decimals || 18,
            },
            token1: {
                address: token1,
                symbol: token1Info?.symbol || 'UNKNOWN',
                decimals: token1Info?.decimals || 18,
            },
            blockNumber,
            detectedAt: Date.now(),
            analyzed: false,
            opportunities: [],
        };

        // Store in recent pairs
        this.recentPairs.set(pairKey, pairRecord);
        this._cleanupOldPairs();

        log.info('New pair detected', {
            chainId,
            dex: dexName,
            pair: `${pairRecord.token0.symbol}/${pairRecord.token1.symbol}`,
            address: pairAddress,
        });

        // Emit event for immediate analysis
        this.emit('newPairDetected', pairRecord);

        // Check for immediate opportunity
        await this._checkNewPairOpportunity(pairRecord);
    }

    /**
     * Check if new pair has arbitrage opportunity
     *
     * @private
     */
    async _checkNewPairOpportunity(pairRecord) {
        this.stats.pairsAnalyzed++;

        const { chainId, token0, token1, pairAddress, dexName } = pairRecord;

        // Check if either token is known (has existing price)
        const knownTokens = this.knownTokens[chainId] || {};

        const token0Known = this._findKnownToken(token0.address, knownTokens);
        const token1Known = this._findKnownToken(token1.address, knownTokens);

        if (!token0Known && !token1Known) {
            // Neither token is known - skip
            return;
        }

        // Try to get existing price from other DEXes
        const opportunity = {
            type: 'new-pair',
            chainId,
            dexName,
            pairAddress,
            token0: token0.symbol,
            token1: token1.symbol,
            token0Address: token0.address,
            token1Address: token1.address,
            detectedAt: Date.now(),
            blockNumber: pairRecord.blockNumber,
            knownToken: token0Known ? token0.symbol : token1.symbol,
            reason: 'New pair created - potential price inefficiency',
            priority: 'high',
        };

        // Record and emit
        pairRecord.opportunities.push(opportunity);
        pairRecord.analyzed = true;
        this.stats.opportunitiesFound++;

        log.info('New pair opportunity flagged', {
            chainId,
            dex: dexName,
            pair: `${token0.symbol}/${token1.symbol}`,
            knownToken: opportunity.knownToken,
        });

        this.emit('newPairOpportunity', opportunity);
    }

    /**
     * Find if token address matches a known token
     *
     * @private
     */
    _findKnownToken(address, knownTokens) {
        const addressLower = address.toLowerCase();
        for (const [symbol, config] of Object.entries(knownTokens)) {
            if (config.address?.toLowerCase() === addressLower) {
                return symbol;
            }
        }
        return null;
    }

    /**
     * Get token info from cache or chain
     *
     * @private
     */
    async _getTokenInfo(chainId, address) {
        const cacheKey = `${chainId}:${address}`;

        if (this.tokenInfoCache.has(cacheKey)) {
            return this.tokenInfoCache.get(cacheKey);
        }

        // Check known tokens first
        const knownTokens = this.knownTokens[chainId] || {};
        for (const [symbol, config] of Object.entries(knownTokens)) {
            if (config.address?.toLowerCase() === address.toLowerCase()) {
                const info = { symbol, decimals: config.decimals || 18 };
                this.tokenInfoCache.set(cacheKey, info);
                return info;
            }
        }

        // Return null for unknown tokens (would need provider to query)
        return null;
    }

    /**
     * Cleanup old pairs from tracking
     *
     * @private
     */
    _cleanupOldPairs() {
        const now = Date.now();
        const expiry = now - this.monitoringWindow;

        for (const [key, pair] of this.recentPairs) {
            if (pair.detectedAt < expiry) {
                this.recentPairs.delete(key);
            }
        }

        // Also limit by count
        if (this.recentPairs.size > this.maxRecentPairs) {
            const entries = [...this.recentPairs.entries()];
            entries.sort((a, b) => a[1].detectedAt - b[1].detectedAt);

            const toRemove = entries.slice(0, entries.length - this.maxRecentPairs);
            for (const [key] of toRemove) {
                this.recentPairs.delete(key);
            }
        }
    }

    /**
     * Get recently detected pairs
     *
     * @param {number} chainId - Optional chain ID filter
     * @param {number} limit - Max pairs to return
     * @returns {Array} Recent pairs
     */
    getRecentPairs(chainId = null, limit = 50) {
        let pairs = [...this.recentPairs.values()];

        if (chainId !== null) {
            pairs = pairs.filter(p => p.chainId === chainId);
        }

        // Sort by detection time (newest first)
        pairs.sort((a, b) => b.detectedAt - a.detectedAt);

        return pairs.slice(0, limit);
    }

    /**
     * Get pairs with detected opportunities
     *
     * @param {number} chainId - Optional chain ID filter
     * @returns {Array} Pairs with opportunities
     */
    getPairsWithOpportunities(chainId = null) {
        let pairs = [...this.recentPairs.values()];

        if (chainId !== null) {
            pairs = pairs.filter(p => p.chainId === chainId);
        }

        return pairs.filter(p => p.opportunities.length > 0);
    }

    /**
     * Manually check a pair for opportunity
     *
     * @param {string} pairAddress - Pair contract address
     * @param {number} chainId - Chain ID
     */
    async analyzePair(pairAddress, chainId) {
        const pairKey = `${chainId}:${pairAddress}`;
        const pair = this.recentPairs.get(pairKey);

        if (pair && !pair.analyzed) {
            await this._checkNewPairOpportunity(pair);
        }

        return pair;
    }

    /**
     * Get monitoring statistics
     */
    getStats() {
        return {
            ...this.stats,
            activePairs: this.recentPairs.size,
            activeSubscriptions: this.subscriptions.length,
            chainsMonitored: [...new Set(this.subscriptions.map(s => s.chainId))].length,
        };
    }

    /**
     * Unsubscribe from all factories
     */
    unsubscribe() {
        for (const sub of this.subscriptions) {
            try {
                sub.factory.off(sub.filter, sub.listener);
                log.debug(`Unsubscribed from ${sub.dexName} on chain ${sub.chainId}`);
            } catch (error) {
                log.error('Error unsubscribing', { error: error.message });
            }
        }
        this.subscriptions = [];
        log.info('All factory subscriptions removed');
    }

    /**
     * Reset the monitor
     */
    reset() {
        this.unsubscribe();
        this.recentPairs.clear();
        this.stats = {
            pairsDetected: 0,
            opportunitiesFound: 0,
            pairsAnalyzed: 0,
            subscriptionErrors: 0,
        };
        log.info('New Pair Monitor reset');
    }
}

// Export class for per-chain instances
export { NewPairMonitor };

// Export default singleton
const newPairMonitor = new NewPairMonitor();
export default newPairMonitor;
