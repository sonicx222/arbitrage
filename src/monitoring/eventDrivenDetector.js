import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import rpcManager from '../utils/rpcManager.js';
import cacheManager from '../data/cacheManager.js';
import config from '../config.js';
import log from '../utils/logger.js';
import { getFallbackPrice } from '../constants/tokenPrices.js';

/**
 * Event-Driven Detector - Subscribes to DEX Sync events for real-time price updates
 *
 * This provides ~10-50x faster opportunity detection compared to block-based polling.
 *
 * How it works:
 * 1. Subscribes to Sync events on high-priority pair addresses
 * 2. When reserves change, immediately updates cache and emits event
 * 3. Arbitrage detection runs on affected pairs without waiting for next block
 *
 * Sync event signature: event Sync(uint112 reserve0, uint112 reserve1)
 * Topic: 0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1
 */
class EventDrivenDetector extends EventEmitter {
    constructor() {
        super();

        // Sync event topic (Uniswap V2 style - used by PancakeSwap, Biswap, etc.)
        this.SYNC_TOPIC = '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1';

        // Provider for event subscriptions
        this.wsProvider = null;

        // Map pair address -> pair info (tokens, dex, etc.)
        this.pairRegistry = new Map();

        // Reverse map: pair address -> { tokenA, tokenB, dexName, pairKey }
        this.addressToPairInfo = new Map();

        // Event processing state
        this.isRunning = false;
        this.eventQueue = [];
        this.processingQueue = false;

        // Debounce settings (prevent processing same pair multiple times per block)
        this.recentlyProcessed = new Map(); // pairAddress -> timestamp
        this.debounceMs = 100; // Minimum time between processing same pair

        // Statistics
        this.stats = {
            eventsReceived: 0,
            eventsProcessed: 0,
            eventsDebounced: 0,
            reserveUpdates: 0,
            errors: 0,
            lastEventTime: null,
        };

        // Configuration
        this.enabled = config.eventDriven?.enabled !== false; // Enabled by default
        this.maxPairsToSubscribe = config.eventDriven?.maxPairs || 100;
        this.batchSize = config.eventDriven?.batchSize || 50;

        log.info('EventDrivenDetector initialized', {
            enabled: this.enabled,
            maxPairs: this.maxPairsToSubscribe,
        });
    }

    /**
     * Start event-driven detection
     * @param {Map} pairAddresses - Map of pair addresses to monitor
     */
    async start(pairAddresses = null) {
        if (!this.enabled) {
            log.info('Event-driven detection disabled');
            return false;
        }

        if (this.isRunning) {
            log.warn('EventDrivenDetector already running');
            return true;
        }

        try {
            // Get WebSocket provider
            const wsData = rpcManager.getWsProvider();
            if (!wsData) {
                log.warn('No WebSocket provider available for event-driven detection');
                return false;
            }

            this.wsProvider = wsData.provider;

            // Build pair registry from cache if not provided
            if (!pairAddresses) {
                await this.buildPairRegistry();
            } else {
                this.pairRegistry = pairAddresses;
                this.buildAddressLookup();
            }

            if (this.pairRegistry.size === 0) {
                log.warn('No pairs to subscribe to for event-driven detection');
                return false;
            }

            // Subscribe to Sync events
            await this.subscribeToSyncEvents();

            this.isRunning = true;
            log.info('EventDrivenDetector started', {
                pairsSubscribed: this.addressToPairInfo.size,
            });

            return true;

        } catch (error) {
            log.error('Failed to start EventDrivenDetector', { error: error.message });
            this.stats.errors++;
            return false;
        }
    }

    /**
     * Build pair registry from cached pair addresses
     * @private
     */
    async buildPairRegistry() {
        const pairs = new Map();
        const tokens = Object.values(config.tokens);
        const baseSymbols = config.baseTokens || ['WBNB', 'USDT'];
        const baseTokens = tokens.filter(t => baseSymbols.includes(t.symbol));

        // Get enabled DEXes
        const enabledDexes = Object.entries(config.dex)
            .filter(([_, dexConfig]) => dexConfig.enabled)
            .map(([name, dexConfig]) => ({ name, ...dexConfig }));

        let pairCount = 0;

        // Build pairs from config tokens
        for (const token of tokens) {
            for (const base of baseTokens) {
                if (token.address === base.address) continue;

                for (const dex of enabledDexes) {
                    // Get pair address from cache
                    const pairAddress = cacheManager.getPairAddress(
                        token.address,
                        base.address,
                        dex.name
                    );

                    if (pairAddress && pairAddress !== ethers.ZeroAddress) {
                        const [t0, t1] = token.address.toLowerCase() < base.address.toLowerCase()
                            ? [token, base]
                            : [base, token];

                        const pairKey = `${t0.symbol}/${t1.symbol}`;

                        pairs.set(pairAddress.toLowerCase(), {
                            address: pairAddress,
                            tokenA: t0,
                            tokenB: t1,
                            pairKey,
                            dexName: dex.name,
                            fee: dex.fee || 0.003,
                        });

                        pairCount++;

                        // Limit to maxPairsToSubscribe
                        if (pairCount >= this.maxPairsToSubscribe) {
                            break;
                        }
                    }
                }

                if (pairCount >= this.maxPairsToSubscribe) break;
            }

            if (pairCount >= this.maxPairsToSubscribe) break;
        }

        this.pairRegistry = pairs;
        this.buildAddressLookup();

        log.debug(`Built pair registry with ${pairs.size} pairs for event subscription`);
    }

    /**
     * Build address -> pair info lookup
     * @private
     */
    buildAddressLookup() {
        this.addressToPairInfo.clear();
        for (const [address, pairInfo] of this.pairRegistry) {
            this.addressToPairInfo.set(address.toLowerCase(), pairInfo);
        }
    }

    /**
     * Subscribe to Sync events on all registered pairs
     * @private
     */
    async subscribeToSyncEvents() {
        const pairAddresses = Array.from(this.addressToPairInfo.keys());

        if (pairAddresses.length === 0) {
            log.warn('No pair addresses to subscribe to');
            return;
        }

        // Create filter for Sync events on our pairs
        // Note: We batch addresses to avoid filter size limits
        const batches = [];
        for (let i = 0; i < pairAddresses.length; i += this.batchSize) {
            batches.push(pairAddresses.slice(i, i + this.batchSize));
        }

        log.debug(`Subscribing to Sync events in ${batches.length} batches`);

        for (const batch of batches) {
            try {
                const filter = {
                    topics: [this.SYNC_TOPIC],
                    address: batch,
                };

                // Subscribe to events
                this.wsProvider.on(filter, (eventLog) => {
                    this.handleSyncEvent(eventLog);
                });

            } catch (error) {
                log.error('Failed to subscribe to batch', { error: error.message });
                this.stats.errors++;
            }
        }

        log.info(`Subscribed to Sync events on ${pairAddresses.length} pairs`);
    }

    /**
     * Handle incoming Sync event
     * @param {Object} eventLog - Event log from provider
     */
    handleSyncEvent(eventLog) {
        try {
            this.stats.eventsReceived++;
            this.stats.lastEventTime = Date.now();

            const pairAddress = eventLog.address.toLowerCase();
            const pairInfo = this.addressToPairInfo.get(pairAddress);

            if (!pairInfo) {
                // Unknown pair - shouldn't happen but handle gracefully
                return;
            }

            // Debounce: skip if we processed this pair very recently
            const lastProcessed = this.recentlyProcessed.get(pairAddress);
            if (lastProcessed && (Date.now() - lastProcessed) < this.debounceMs) {
                this.stats.eventsDebounced++;
                return;
            }

            // Decode reserves from event data
            // Sync event: event Sync(uint112 reserve0, uint112 reserve1)
            // Data is abi-encoded: reserve0 (uint112) + reserve1 (uint112)
            const reserves = this.decodeSyncEvent(eventLog.data);

            if (!reserves) {
                log.warn('Failed to decode Sync event', { pairAddress });
                return;
            }

            // Mark as recently processed
            this.recentlyProcessed.set(pairAddress, Date.now());

            // Update cache with new reserves
            this.updatePriceCache(pairInfo, reserves, eventLog.blockNumber);

            this.stats.eventsProcessed++;
            this.stats.reserveUpdates++;

            // Emit event for arbitrage detection
            this.emit('reserveUpdate', {
                pairAddress,
                pairKey: pairInfo.pairKey,
                dexName: pairInfo.dexName,
                tokenA: pairInfo.tokenA,
                tokenB: pairInfo.tokenB,
                reserves,
                blockNumber: eventLog.blockNumber,
                transactionHash: eventLog.transactionHash,
                timestamp: Date.now(),
            });

            // Also emit a more general event for batch processing
            this.emit('priceChange', {
                pairKey: pairInfo.pairKey,
                dexName: pairInfo.dexName,
                reserves,
                blockNumber: eventLog.blockNumber,
            });

        } catch (error) {
            log.error('Error handling Sync event', { error: error.message });
            this.stats.errors++;
        }
    }

    /**
     * Decode Sync event data
     * @param {string} data - Event data (hex string)
     * @returns {Object|null} { reserve0, reserve1 }
     */
    decodeSyncEvent(data) {
        try {
            // Sync event has two uint112 values packed in 256-bit slots
            // reserve0: bytes 0-32 (but only 14 bytes used for uint112)
            // reserve1: bytes 32-64 (but only 14 bytes used for uint112)

            // Remove 0x prefix if present
            const cleanData = data.startsWith('0x') ? data.slice(2) : data;

            if (cleanData.length < 128) {
                return null;
            }

            // Each value is padded to 32 bytes (64 hex chars)
            const reserve0Hex = cleanData.slice(0, 64);
            const reserve1Hex = cleanData.slice(64, 128);

            const reserve0 = BigInt('0x' + reserve0Hex);
            const reserve1 = BigInt('0x' + reserve1Hex);

            return { reserve0, reserve1 };

        } catch (error) {
            log.error('Failed to decode Sync event data', { error: error.message, data });
            return null;
        }
    }

    /**
     * Update price cache with new reserves
     * @param {Object} pairInfo - Pair information
     * @param {Object} reserves - { reserve0, reserve1 }
     * @param {number} blockNumber - Block number
     */
    updatePriceCache(pairInfo, reserves, blockNumber) {
        const { tokenA, tokenB, dexName, address: pairAddress } = pairInfo;

        // Determine which reserve belongs to which token
        // In Uniswap V2, token0 address < token1 address
        const isToken0 = tokenA.address.toLowerCase() < tokenB.address.toLowerCase();
        const reserveA = isToken0 ? reserves.reserve0 : reserves.reserve1;
        const reserveB = isToken0 ? reserves.reserve1 : reserves.reserve0;

        // Calculate price: amount of B for 1 unit of A
        const factorA = 10n ** BigInt(tokenA.decimals);
        const factorB = 10n ** BigInt(tokenB.decimals);
        const precision = 10n ** 18n;

        let price = 0;
        if (reserveA > 0n) {
            const priceBI = (reserveB * factorA * precision) / (reserveA * factorB);
            price = Number(priceBI) / 1e18;
        }

        // Estimate liquidity USD (simplified - would need token prices for accuracy)
        const liquidityUSD = this.estimateLiquidityUSD(reserveA, reserveB, tokenA, tokenB);

        // Create price data object
        const priceData = {
            price,
            reserveA: reserveA.toString(),
            reserveB: reserveB.toString(),
            liquidityUSD,
            pairAddress,
            timestamp: Date.now(),
            source: 'sync-event',
        };

        // Update cache
        const cacheKey = cacheManager.getPriceKey(tokenA.address, tokenB.address, dexName);
        cacheManager.setPrice(cacheKey, priceData, blockNumber);
    }

    /**
     * Estimate liquidity in USD
     * @private
     */
    estimateLiquidityUSD(reserveA, reserveB, tokenA, tokenB) {
        const priceA = getFallbackPrice(tokenA.symbol, null);
        const priceB = getFallbackPrice(tokenB.symbol, null);

        const resAFloat = Number(reserveA) / Math.pow(10, tokenA.decimals);
        const resBFloat = Number(reserveB) / Math.pow(10, tokenB.decimals);

        if (priceA !== null && priceB !== null) {
            return (resAFloat * priceA) + (resBFloat * priceB);
        } else if (priceA !== null) {
            return resAFloat * priceA * 2;
        } else if (priceB !== null) {
            return resBFloat * priceB * 2;
        }

        return (resAFloat + resBFloat) * 0.5;
    }

    /**
     * Add a pair to the subscription list dynamically
     * @param {string} pairAddress - Pair contract address
     * @param {Object} pairInfo - { tokenA, tokenB, dexName, pairKey }
     */
    async addPair(pairAddress, pairInfo) {
        const address = pairAddress.toLowerCase();

        if (this.addressToPairInfo.has(address)) {
            return; // Already subscribed
        }

        this.pairRegistry.set(address, pairInfo);
        this.addressToPairInfo.set(address, pairInfo);

        if (this.isRunning && this.wsProvider) {
            try {
                const filter = {
                    topics: [this.SYNC_TOPIC],
                    address: [address],
                };

                this.wsProvider.on(filter, (eventLog) => {
                    this.handleSyncEvent(eventLog);
                });

                log.debug(`Added Sync subscription for ${pairInfo.pairKey} on ${pairInfo.dexName}`);

            } catch (error) {
                log.error('Failed to add pair subscription', { error: error.message });
            }
        }
    }

    /**
     * Remove a pair from subscription
     * @param {string} pairAddress - Pair contract address
     */
    removePair(pairAddress) {
        const address = pairAddress.toLowerCase();
        this.pairRegistry.delete(address);
        this.addressToPairInfo.delete(address);
        this.recentlyProcessed.delete(address);
        // Note: Can't easily remove individual subscriptions in ethers.js
        // The filter will still fire but we won't have pairInfo to process it
    }

    /**
     * Get high-priority pairs (most recent opportunities)
     * @param {number} limit - Maximum pairs to return
     * @returns {Array} Array of pair addresses
     */
    getHighPriorityPairs(limit = 50) {
        // This would be enhanced with opportunity history tracking
        // For now, return first N pairs from registry
        return Array.from(this.addressToPairInfo.keys()).slice(0, limit);
    }

    /**
     * Clean up old debounce entries
     * @private
     */
    cleanupDebounceMap() {
        const now = Date.now();
        const expiry = this.debounceMs * 10; // Keep for 10x debounce time

        for (const [address, timestamp] of this.recentlyProcessed) {
            if (now - timestamp > expiry) {
                this.recentlyProcessed.delete(address);
            }
        }
    }

    /**
     * Stop event-driven detection
     */
    async stop() {
        if (!this.isRunning) {
            return;
        }

        this.isRunning = false;

        try {
            if (this.wsProvider) {
                // Remove all listeners for Sync events
                this.wsProvider.removeAllListeners();
            }

            // Clear state
            this.recentlyProcessed.clear();
            this.eventQueue = [];

            log.info('EventDrivenDetector stopped', { stats: this.stats });

        } catch (error) {
            log.error('Error stopping EventDrivenDetector', { error: error.message });
        }
    }

    /**
     * Get statistics
     * @returns {Object} Statistics object
     */
    getStats() {
        return {
            ...this.stats,
            isRunning: this.isRunning,
            pairsSubscribed: this.addressToPairInfo.size,
            debounceMapSize: this.recentlyProcessed.size,
        };
    }

    /**
     * Check if detector is active
     * @returns {boolean}
     */
    isActive() {
        return this.enabled && this.isRunning;
    }

    /**
     * Reset statistics
     */
    resetStats() {
        this.stats = {
            eventsReceived: 0,
            eventsProcessed: 0,
            eventsDebounced: 0,
            reserveUpdates: 0,
            errors: 0,
            lastEventTime: null,
        };
    }
}

// Export singleton instance
const eventDrivenDetector = new EventDrivenDetector();
export default eventDrivenDetector;
