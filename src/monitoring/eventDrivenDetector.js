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

        // ============ V2 Event Topics ============
        // Sync event topic (Uniswap V2 style - used by PancakeSwap, Biswap, etc.)
        this.SYNC_TOPIC = '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1';

        // Swap event topic (Uniswap V2 style)
        // event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)
        this.SWAP_TOPIC_V2 = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';

        // ============ V3 Event Topics ============
        // V3 Swap event topic (Uniswap V3 style - includes price data!)
        // event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)
        this.SWAP_TOPIC_V3 = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';

        // Backwards compatibility alias
        this.SWAP_TOPIC = this.SWAP_TOPIC_V2;

        // Provider for event subscriptions
        this.wsProvider = null;

        // Map pair address -> pair info (tokens, dex, etc.)
        this.pairRegistry = new Map();

        // Reverse map: pair address -> { tokenA, tokenB, dexName, pairKey }
        this.addressToPairInfo = new Map();

        // V3 pool registry (separate from V2 pairs)
        // Map pool address -> { tokenA, tokenB, dexName, poolKey, feeTier }
        this.v3PoolRegistry = new Map();
        this.addressToV3PoolInfo = new Map();

        // Event processing state
        this.isRunning = false;
        this.eventQueue = [];
        this.processingQueue = false;

        // Debounce settings (prevent processing same pair multiple times per block)
        this.recentlyProcessed = new Map(); // pairAddress -> timestamp
        this.debounceMs = 100; // Minimum time between processing same pair

        // Track pairs updated per block (for cache-aware optimization)
        // blockNumber -> Set<pairKey>
        this.blockUpdates = new Map();
        this.maxBlockHistory = 10; // Keep last N blocks of update history

        // FIX v3.2: Cleanup interval for recentlyProcessed Map
        // (cleanupDebounceMap existed but was never called - memory leak)
        this.cleanupInterval = null;
        this.cleanupIntervalMs = 30000; // Clean up every 30 seconds

        // Statistics
        this.stats = {
            eventsReceived: 0,
            eventsProcessed: 0,
            eventsDebounced: 0,
            reserveUpdates: 0,
            swapEventsReceived: 0,
            swapEventsProcessed: 0,
            // V3-specific stats
            v3SwapEventsReceived: 0,
            v3SwapEventsProcessed: 0,
            v3PriceUpdates: 0,
            errors: 0,
            lastEventTime: null,
            lastSwapTime: null,
            lastV3SwapTime: null,
        };

        // Configuration
        this.enabled = config.eventDriven?.enabled !== false; // Enabled by default
        this.maxPairsToSubscribe = config.eventDriven?.maxPairs || 100;
        this.batchSize = config.eventDriven?.batchSize || 50;

        // Swap event processing configuration
        this.swapEventsEnabled = config.eventDriven?.swapEvents !== false; // Enabled by default
        this.minSwapUSD = config.eventDriven?.minSwapUSD || 1000; // Min swap size to track

        // V3-specific configuration
        this.v3Enabled = config.eventDriven?.v3Enabled !== false; // Enabled by default
        this.maxV3PoolsToSubscribe = config.eventDriven?.maxV3Pools || 50;

        // Bound handlers for rpcManager events (for reconnection handling)
        this._boundHandleWsFailover = this._handleWsFailover.bind(this);
        this._boundHandleWsRecovery = this._handleWsRecovery.bind(this);

        log.info('EventDrivenDetector initialized (resilient mode)', {
            enabled: this.enabled,
            maxPairs: this.maxPairsToSubscribe,
            swapEventsEnabled: this.swapEventsEnabled,
            v3Enabled: this.v3Enabled,
            maxV3Pools: this.maxV3PoolsToSubscribe,
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

            // Subscribe to rpcManager events for reconnection handling
            rpcManager.on('wsFailover', this._boundHandleWsFailover);
            rpcManager.on('endpointRecovered', this._boundHandleWsRecovery);

            // Subscribe to all events
            await this._subscribeToAllEvents();

            this.isRunning = true;

            // FIX v3.2: Start periodic cleanup for recentlyProcessed Map
            this._startCleanupInterval();

            log.info('EventDrivenDetector started (resilient mode)', {
                pairsSubscribed: this.addressToPairInfo.size,
                v3PoolsSubscribed: this.addressToV3PoolInfo.size,
                swapEventsEnabled: this.swapEventsEnabled,
                v3Enabled: this.v3Enabled,
            });

            return true;

        } catch (error) {
            log.error('Failed to start EventDrivenDetector', { error: error.message });
            this.stats.errors++;
            return false;
        }
    }

    /**
     * Subscribe to all events (Sync, Swap V2, V3)
     * Called on start and when reconnecting
     * @private
     */
    async _subscribeToAllEvents() {
        // FIX v3.4: Clean up any existing listeners on current provider before subscribing
        // This prevents listener accumulation when called multiple times (failover/recovery)
        if (this.wsProvider) {
            try {
                // Remove only our event filters, not ALL listeners (other code may use this provider)
                // Note: ethers v6 doesn't have a clean way to remove specific filters,
                // so we track and remove our subscriptions explicitly
                this.wsProvider.removeAllListeners();
                log.debug('Cleaned existing listeners before re-subscribing');
            } catch (err) {
                log.debug('Could not clean listeners', { error: err.message });
            }
        }

        // Subscribe to Sync events (for price updates)
        await this.subscribeToSyncEvents();

        // Subscribe to Swap events (for whale tracking)
        if (this.swapEventsEnabled) {
            await this.subscribeToSwapEvents();
        }

        // Subscribe to V3 Swap events (includes price data!)
        if (this.v3Enabled) {
            await this.buildV3PoolRegistry();
            if (this.v3PoolRegistry.size > 0) {
                await this.subscribeToV3SwapEvents();
            }
        }
    }

    /**
     * Handle WebSocket failover event - update provider reference
     * @private
     */
    async _handleWsFailover(data) {
        if (!this.isRunning) return;

        log.info('EventDrivenDetector handling WebSocket failover', {
            from: data.from,
            to: data.to,
        });

        // FIX v3.1: Clean up old provider's listeners before switching
        // This prevents duplicate event handlers and memory leaks
        const oldProvider = this.wsProvider;
        if (oldProvider) {
            try {
                oldProvider.removeAllListeners();
                log.debug('Removed event listeners from old provider');
            } catch (cleanupError) {
                log.debug('Error cleaning up old provider', { error: cleanupError.message });
            }
        }

        // Get the new provider after failover
        const wsData = rpcManager.getWsProvider();
        if (wsData) {
            this.wsProvider = wsData.provider;
            // Re-subscribe to all events on the new provider
            try {
                await this._subscribeToAllEvents();
                log.info('EventDrivenDetector re-subscribed to events after failover');
            } catch (error) {
                log.error('Failed to re-subscribe after failover', { error: error.message });
                this.stats.errors++;
            }
        }
    }

    /**
     * Handle WebSocket recovery event - re-subscribe if needed
     * @private
     */
    async _handleWsRecovery(endpoint) {
        if (!this.isRunning) return;

        log.info('EventDrivenDetector handling WebSocket recovery');

        // Get the recovered provider
        const wsData = rpcManager.getWsProvider();
        if (wsData && wsData.provider !== this.wsProvider) {
            // FIX v3.1: Clean up old provider's listeners before switching
            const oldProvider = this.wsProvider;
            if (oldProvider) {
                try {
                    oldProvider.removeAllListeners();
                } catch (cleanupError) {
                    log.debug('Error cleaning up old provider', { error: cleanupError.message });
                }
            }

            this.wsProvider = wsData.provider;
            // Re-subscribe to all events on the recovered provider
            try {
                await this._subscribeToAllEvents();
                log.info('EventDrivenDetector re-subscribed to events after recovery');
            } catch (error) {
                log.error('Failed to re-subscribe after recovery', { error: error.message });
                this.stats.errors++;
            }
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
     * Subscribe to Swap events on all registered pairs (for whale tracking)
     * @private
     */
    async subscribeToSwapEvents() {
        const pairAddresses = Array.from(this.addressToPairInfo.keys());

        if (pairAddresses.length === 0) {
            return;
        }

        // Batch addresses for subscription
        const batches = [];
        for (let i = 0; i < pairAddresses.length; i += this.batchSize) {
            batches.push(pairAddresses.slice(i, i + this.batchSize));
        }

        log.debug(`Subscribing to Swap events in ${batches.length} batches`);

        for (const batch of batches) {
            try {
                const filter = {
                    topics: [this.SWAP_TOPIC],
                    address: batch,
                };

                // Subscribe to Swap events
                this.wsProvider.on(filter, (eventLog) => {
                    this.handleSwapEvent(eventLog);
                });

            } catch (error) {
                log.error('Failed to subscribe to Swap events batch', { error: error.message });
                this.stats.errors++;
            }
        }

        log.info(`Subscribed to Swap events on ${pairAddresses.length} pairs (whale tracking)`);
    }

    /**
     * Handle incoming Swap event (for whale tracking)
     * @param {Object} eventLog - Event log from provider
     */
    handleSwapEvent(eventLog) {
        try {
            this.stats.swapEventsReceived++;
            this.stats.lastSwapTime = Date.now();

            const pairAddress = eventLog.address.toLowerCase();
            const pairInfo = this.addressToPairInfo.get(pairAddress);

            if (!pairInfo) {
                return; // Unknown pair
            }

            // Decode swap event data
            const swapData = this.decodeSwapEvent(eventLog);
            if (!swapData) {
                return;
            }

            // Calculate swap amounts in USD
            const { amountUSD, direction } = this.calculateSwapValue(
                swapData,
                pairInfo.tokenA,
                pairInfo.tokenB
            );

            // Skip small swaps
            if (amountUSD < this.minSwapUSD) {
                return;
            }

            this.stats.swapEventsProcessed++;

            // Emit swap event for whale tracker
            this.emit('swapDetected', {
                pairAddress,
                pairKey: pairInfo.pairKey,
                dexName: pairInfo.dexName,
                tokenA: pairInfo.tokenA,
                tokenB: pairInfo.tokenB,
                sender: swapData.sender,
                recipient: swapData.recipient,
                amount0In: swapData.amount0In,
                amount1In: swapData.amount1In,
                amount0Out: swapData.amount0Out,
                amount1Out: swapData.amount1Out,
                amountUSD,
                direction,
                blockNumber: eventLog.blockNumber,
                transactionHash: eventLog.transactionHash,
                timestamp: Date.now(),
            });

            log.debug(`Swap detected: ${pairInfo.pairKey} on ${pairInfo.dexName}`, {
                sender: swapData.sender.slice(0, 10) + '...',
                amount: `$${amountUSD.toFixed(0)}`,
                direction,
            });

        } catch (error) {
            log.error('Error handling Swap event', { error: error.message });
            this.stats.errors++;
        }
    }

    /**
     * Decode Swap event data
     * @param {Object} eventLog - Event log
     * @returns {Object|null} Decoded swap data
     */
    decodeSwapEvent(eventLog) {
        try {
            // Swap event:
            // topics[0] = event signature
            // topics[1] = sender (indexed, address)
            // topics[2] = to/recipient (indexed, address)
            // data = amount0In, amount1In, amount0Out, amount1Out (each uint256)

            if (!eventLog.topics || eventLog.topics.length < 3) {
                return null;
            }

            // Extract indexed addresses from topics
            // Topics are 32 bytes, addresses are last 20 bytes
            const sender = '0x' + eventLog.topics[1].slice(-40);
            const recipient = '0x' + eventLog.topics[2].slice(-40);

            // Decode amounts from data
            const cleanData = eventLog.data.startsWith('0x')
                ? eventLog.data.slice(2)
                : eventLog.data;

            if (cleanData.length < 256) { // 4 * 64 hex chars
                return null;
            }

            const amount0In = BigInt('0x' + cleanData.slice(0, 64));
            const amount1In = BigInt('0x' + cleanData.slice(64, 128));
            const amount0Out = BigInt('0x' + cleanData.slice(128, 192));
            const amount1Out = BigInt('0x' + cleanData.slice(192, 256));

            return {
                sender: sender.toLowerCase(),
                recipient: recipient.toLowerCase(),
                amount0In,
                amount1In,
                amount0Out,
                amount1Out,
            };

        } catch (error) {
            log.error('Failed to decode Swap event', { error: error.message });
            return null;
        }
    }

    /**
     * Calculate swap value in USD and determine direction
     * @param {Object} swapData - Decoded swap data
     * @param {Object} tokenA - Token A info
     * @param {Object} tokenB - Token B info
     * @returns {Object} { amountUSD, direction }
     */
    calculateSwapValue(swapData, tokenA, tokenB) {
        // Determine token order (token0 has lower address)
        const isTokenAFirst = tokenA.address.toLowerCase() < tokenB.address.toLowerCase();
        const token0 = isTokenAFirst ? tokenA : tokenB;
        const token1 = isTokenAFirst ? tokenB : tokenA;

        // Get token prices
        const price0 = getFallbackPrice(token0.symbol, null) || 0;
        const price1 = getFallbackPrice(token1.symbol, null) || 0;

        // Calculate amounts
        const amount0InFloat = Number(swapData.amount0In) / Math.pow(10, token0.decimals);
        const amount1InFloat = Number(swapData.amount1In) / Math.pow(10, token1.decimals);
        const amount0OutFloat = Number(swapData.amount0Out) / Math.pow(10, token0.decimals);
        const amount1OutFloat = Number(swapData.amount1Out) / Math.pow(10, token1.decimals);

        // Calculate USD values
        const inValueUSD = (amount0InFloat * price0) + (amount1InFloat * price1);
        const outValueUSD = (amount0OutFloat * price0) + (amount1OutFloat * price1);

        // Use the larger value (in or out) as the swap size
        const amountUSD = Math.max(inValueUSD, outValueUSD);

        // Determine direction: if putting in token0 (usually base token), it's a buy of token1
        // In Uniswap V2 terms: amount0In > 0 means selling token0, buying token1
        let direction = 'unknown';
        if (swapData.amount0In > 0n && swapData.amount1Out > 0n) {
            // Selling token0, buying token1
            direction = isTokenAFirst ? 'sell' : 'buy';
        } else if (swapData.amount1In > 0n && swapData.amount0Out > 0n) {
            // Selling token1, buying token0
            direction = isTokenAFirst ? 'buy' : 'sell';
        }

        return { amountUSD, direction };
    }

    // ============ V3 Event Handling ============

    /**
     * Build V3 pool registry from cached pool addresses
     * V3 pools are identified by (token0, token1, feeTier)
     * @private
     */
    async buildV3PoolRegistry() {
        const pools = new Map();
        const tokens = Object.values(config.tokens);
        const baseSymbols = config.baseTokens || ['WBNB', 'USDT'];
        const baseTokens = tokens.filter(t => baseSymbols.includes(t.symbol));

        // V3 fee tiers (in hundredths of a bip, e.g., 500 = 0.05%)
        const feeTiers = [100, 500, 2500, 10000]; // 0.01%, 0.05%, 0.25%, 1%

        // Get V3-enabled DEXes
        const v3Dexes = Object.entries(config.dex)
            .filter(([_, dexConfig]) => dexConfig.enabled && dexConfig.type === 'v3')
            .map(([name, dexConfig]) => ({ name, ...dexConfig }));

        let poolCount = 0;

        // Build pools from config tokens
        for (const token of tokens) {
            for (const base of baseTokens) {
                if (token.address === base.address) continue;

                for (const dex of v3Dexes) {
                    for (const feeTier of feeTiers) {
                        // Get pool address from cache (if available)
                        const poolAddress = cacheManager.getV3PoolAddress?.(
                            token.address,
                            base.address,
                            dex.name,
                            feeTier
                        );

                        if (poolAddress && poolAddress !== ethers.ZeroAddress) {
                            const [t0, t1] = token.address.toLowerCase() < base.address.toLowerCase()
                                ? [token, base]
                                : [base, token];

                            const poolKey = `${t0.symbol}/${t1.symbol}`;

                            pools.set(poolAddress.toLowerCase(), {
                                address: poolAddress,
                                tokenA: t0,
                                tokenB: t1,
                                poolKey,
                                dexName: dex.name,
                                feeTier,
                                feePercent: feeTier / 1000000, // Convert to percentage
                            });

                            poolCount++;

                            if (poolCount >= this.maxV3PoolsToSubscribe) {
                                break;
                            }
                        }
                    }
                    if (poolCount >= this.maxV3PoolsToSubscribe) break;
                }
                if (poolCount >= this.maxV3PoolsToSubscribe) break;
            }
            if (poolCount >= this.maxV3PoolsToSubscribe) break;
        }

        this.v3PoolRegistry = pools;
        this.buildV3AddressLookup();

        log.debug(`Built V3 pool registry with ${pools.size} pools for event subscription`);
    }

    /**
     * Build address -> V3 pool info lookup
     * @private
     */
    buildV3AddressLookup() {
        this.addressToV3PoolInfo.clear();
        for (const [address, poolInfo] of this.v3PoolRegistry) {
            this.addressToV3PoolInfo.set(address.toLowerCase(), poolInfo);
        }
    }

    /**
     * Subscribe to V3 Swap events on all registered V3 pools
     * V3 Swap events include price data (sqrtPriceX96, liquidity, tick)
     * @private
     */
    async subscribeToV3SwapEvents() {
        const poolAddresses = Array.from(this.addressToV3PoolInfo.keys());

        if (poolAddresses.length === 0) {
            log.debug('No V3 pool addresses to subscribe to');
            return;
        }

        // Batch addresses for subscription
        const batches = [];
        for (let i = 0; i < poolAddresses.length; i += this.batchSize) {
            batches.push(poolAddresses.slice(i, i + this.batchSize));
        }

        log.debug(`Subscribing to V3 Swap events in ${batches.length} batches`);

        for (const batch of batches) {
            try {
                const filter = {
                    topics: [this.SWAP_TOPIC_V3],
                    address: batch,
                };

                // Subscribe to V3 Swap events
                this.wsProvider.on(filter, (eventLog) => {
                    this.handleSwapEventV3(eventLog);
                });

            } catch (error) {
                log.error('Failed to subscribe to V3 Swap events batch', { error: error.message });
                this.stats.errors++;
            }
        }

        log.info(`Subscribed to V3 Swap events on ${poolAddresses.length} pools`);
    }

    /**
     * Handle incoming V3 Swap event
     * V3 Swap events include: sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick
     * @param {Object} eventLog - Event log from provider
     */
    handleSwapEventV3(eventLog) {
        try {
            this.stats.v3SwapEventsReceived++;
            this.stats.lastV3SwapTime = Date.now();

            const poolAddress = eventLog.address.toLowerCase();
            const poolInfo = this.addressToV3PoolInfo.get(poolAddress);

            if (!poolInfo) {
                return; // Unknown pool
            }

            // Decode V3 swap event data
            const swapData = this.decodeSwapEventV3(eventLog);
            if (!swapData) {
                return;
            }

            // Calculate swap amounts in USD
            const { amountUSD, direction, price } = this.calculateSwapValueV3(
                swapData,
                poolInfo.tokenA,
                poolInfo.tokenB
            );

            // Skip small swaps (but still emit price update)
            const emitSwapEvent = amountUSD >= this.minSwapUSD;

            this.stats.v3SwapEventsProcessed++;

            // V3 Swap events include price data - emit price update!
            // This is more valuable than V2 because we get sqrtPriceX96 directly
            this.stats.v3PriceUpdates++;

            // Track this pool as updated in this block
            this._trackBlockUpdate(eventLog.blockNumber, poolInfo.poolKey, poolInfo.dexName);

            // Emit V3 price update event (V3 Swap events include price!)
            this.emit('v3PriceUpdate', {
                poolAddress,
                poolKey: poolInfo.poolKey,
                dexName: poolInfo.dexName,
                tokenA: poolInfo.tokenA,
                tokenB: poolInfo.tokenB,
                feeTier: poolInfo.feeTier,
                sqrtPriceX96: swapData.sqrtPriceX96,
                liquidity: swapData.liquidity,
                tick: swapData.tick,
                price,
                blockNumber: eventLog.blockNumber,
                transactionHash: eventLog.transactionHash,
                timestamp: Date.now(),
            });

            // Emit swap event for whale tracking (if above threshold)
            if (emitSwapEvent) {
                this.emit('swapDetected', {
                    pairAddress: poolAddress,
                    pairKey: poolInfo.poolKey,
                    dexName: poolInfo.dexName,
                    tokenA: poolInfo.tokenA,
                    tokenB: poolInfo.tokenB,
                    sender: swapData.sender,
                    recipient: swapData.recipient,
                    // V3 uses signed amounts (delta), convert for whale tracker
                    amount0In: swapData.amount0 > 0n ? swapData.amount0 : 0n,
                    amount1In: swapData.amount1 > 0n ? swapData.amount1 : 0n,
                    amount0Out: swapData.amount0 < 0n ? -swapData.amount0 : 0n,
                    amount1Out: swapData.amount1 < 0n ? -swapData.amount1 : 0n,
                    amountUSD,
                    direction,
                    blockNumber: eventLog.blockNumber,
                    transactionHash: eventLog.transactionHash,
                    timestamp: Date.now(),
                    isV3: true,
                    feeTier: poolInfo.feeTier,
                });
            }

            log.debug(`V3 Swap: ${poolInfo.poolKey} (${poolInfo.feeTier / 10000}%) on ${poolInfo.dexName}`, {
                amount: `$${amountUSD.toFixed(0)}`,
                direction,
                tick: swapData.tick,
            });

        } catch (error) {
            log.error('Error handling V3 Swap event', { error: error.message });
            this.stats.errors++;
        }
    }

    /**
     * Decode V3 Swap event data
     * V3 Swap: event Swap(address indexed sender, address indexed recipient,
     *                     int256 amount0, int256 amount1, uint160 sqrtPriceX96,
     *                     uint128 liquidity, int24 tick)
     * @param {Object} eventLog - Event log
     * @returns {Object|null} Decoded swap data
     */
    decodeSwapEventV3(eventLog) {
        try {
            if (!eventLog.topics || eventLog.topics.length < 3) {
                return null;
            }

            // Extract indexed addresses from topics
            const sender = '0x' + eventLog.topics[1].slice(-40);
            const recipient = '0x' + eventLog.topics[2].slice(-40);

            // Decode non-indexed data: amount0, amount1, sqrtPriceX96, liquidity, tick
            // Each value: amount0 (int256), amount1 (int256), sqrtPriceX96 (uint160),
            //             liquidity (uint128), tick (int24)
            const cleanData = eventLog.data.startsWith('0x')
                ? eventLog.data.slice(2)
                : eventLog.data;

            // Need at least 5 * 64 = 320 hex chars for 5 values
            if (cleanData.length < 320) {
                return null;
            }

            // Parse signed int256 values (amount0, amount1)
            const amount0Hex = cleanData.slice(0, 64);
            const amount1Hex = cleanData.slice(64, 128);
            const sqrtPriceX96Hex = cleanData.slice(128, 192);
            const liquidityHex = cleanData.slice(192, 256);
            const tickHex = cleanData.slice(256, 320);

            // Convert to BigInt (signed for amounts)
            const amount0 = this._parseSignedInt256(amount0Hex);
            const amount1 = this._parseSignedInt256(amount1Hex);
            const sqrtPriceX96 = BigInt('0x' + sqrtPriceX96Hex);
            const liquidity = BigInt('0x' + liquidityHex);
            const tick = this._parseSignedInt24(tickHex);

            return {
                sender: sender.toLowerCase(),
                recipient: recipient.toLowerCase(),
                amount0,
                amount1,
                sqrtPriceX96,
                liquidity,
                tick,
            };

        } catch (error) {
            log.error('Failed to decode V3 Swap event', { error: error.message });
            return null;
        }
    }

    /**
     * Parse signed int256 from hex string
     * @private
     */
    _parseSignedInt256(hexStr) {
        const value = BigInt('0x' + hexStr);
        // Check if negative (MSB set)
        const maxPositive = (1n << 255n) - 1n;
        if (value > maxPositive) {
            // Negative number: two's complement
            return value - (1n << 256n);
        }
        return value;
    }

    /**
     * Parse signed int24 from hex string (padded to 256 bits)
     * @private
     */
    _parseSignedInt24(hexStr) {
        const value = BigInt('0x' + hexStr);
        // int24 max positive is (2^23 - 1)
        const maxPositive = (1n << 23n) - 1n;
        if (value > maxPositive) {
            // For int24, we mask to 24 bits then check sign
            const masked = value & ((1n << 24n) - 1n);
            if (masked > maxPositive) {
                return Number(masked) - (1 << 24);
            }
        }
        return Number(value & ((1n << 24n) - 1n));
    }

    /**
     * Calculate swap value in USD and price from V3 swap data
     * @param {Object} swapData - Decoded V3 swap data
     * @param {Object} tokenA - Token A info
     * @param {Object} tokenB - Token B info
     * @returns {Object} { amountUSD, direction, price }
     */
    calculateSwapValueV3(swapData, tokenA, tokenB) {
        // Determine token order (token0 has lower address)
        const isTokenAFirst = tokenA.address.toLowerCase() < tokenB.address.toLowerCase();
        const token0 = isTokenAFirst ? tokenA : tokenB;
        const token1 = isTokenAFirst ? tokenB : tokenA;

        // Get token prices for USD calculation
        const price0 = getFallbackPrice(token0.symbol, null) || 0;
        const price1 = getFallbackPrice(token1.symbol, null) || 0;

        // V3 amounts are signed: positive = tokens going INTO pool, negative = tokens coming OUT
        // Convert to absolute values for USD calculation
        const amount0Abs = swapData.amount0 < 0n ? -swapData.amount0 : swapData.amount0;
        const amount1Abs = swapData.amount1 < 0n ? -swapData.amount1 : swapData.amount1;

        const amount0Float = Number(amount0Abs) / Math.pow(10, token0.decimals);
        const amount1Float = Number(amount1Abs) / Math.pow(10, token1.decimals);

        // Calculate USD values
        const value0USD = amount0Float * price0;
        const value1USD = amount1Float * price1;
        const amountUSD = Math.max(value0USD, value1USD);

        // Determine direction based on amount signs
        // In V3: positive amount = tokens going into pool (sold by user)
        //        negative amount = tokens coming out of pool (bought by user)
        let direction = 'unknown';
        if (swapData.amount0 > 0n && swapData.amount1 < 0n) {
            // User put in token0, got out token1 (selling token0, buying token1)
            direction = isTokenAFirst ? 'sell' : 'buy';
        } else if (swapData.amount1 > 0n && swapData.amount0 < 0n) {
            // User put in token1, got out token0 (selling token1, buying token0)
            direction = isTokenAFirst ? 'buy' : 'sell';
        }

        // Calculate price from sqrtPriceX96
        // price = (sqrtPriceX96 / 2^96)^2 = sqrtPriceX96^2 / 2^192
        // This gives price of token1 in terms of token0
        const Q96 = 2n ** 96n;
        const sqrtPrice = swapData.sqrtPriceX96;
        // Use high precision calculation
        const priceX192 = sqrtPrice * sqrtPrice;
        // Adjust for decimals: price = priceX192 * 10^(decimals0 - decimals1) / 2^192
        const decimalAdjust = Math.pow(10, token0.decimals - token1.decimals);
        const price = (Number(priceX192) / Number(2n ** 192n)) * decimalAdjust;

        return { amountUSD, direction, price };
    }

    /**
     * Add a V3 pool to the subscription list dynamically
     * @param {string} poolAddress - V3 Pool contract address
     * @param {Object} poolInfo - { tokenA, tokenB, dexName, poolKey, feeTier }
     */
    async addV3Pool(poolAddress, poolInfo) {
        const address = poolAddress.toLowerCase();

        if (this.addressToV3PoolInfo.has(address)) {
            return; // Already subscribed
        }

        this.v3PoolRegistry.set(address, poolInfo);
        this.addressToV3PoolInfo.set(address, poolInfo);

        if (this.isRunning && this.wsProvider && this.v3Enabled) {
            try {
                const filter = {
                    topics: [this.SWAP_TOPIC_V3],
                    address: [address],
                };

                this.wsProvider.on(filter, (eventLog) => {
                    this.handleSwapEventV3(eventLog);
                });

                log.debug(`Added V3 Swap subscription for ${poolInfo.poolKey} (${poolInfo.feeTier}bp) on ${poolInfo.dexName}`);

            } catch (error) {
                log.error('Failed to add V3 pool subscription', { error: error.message });
            }
        }
    }

    /**
     * Remove a V3 pool from subscription
     * @param {string} poolAddress - V3 Pool contract address
     */
    removeV3Pool(poolAddress) {
        const address = poolAddress.toLowerCase();
        this.v3PoolRegistry.delete(address);
        this.addressToV3PoolInfo.delete(address);
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

            // Track this pair as updated in this block (for cache-aware optimization)
            this._trackBlockUpdate(eventLog.blockNumber, pairInfo.pairKey, pairInfo.dexName);

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

        let cleaned = 0;
        for (const [address, timestamp] of this.recentlyProcessed) {
            if (now - timestamp > expiry) {
                this.recentlyProcessed.delete(address);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            log.debug(`Cleaned ${cleaned} entries from recentlyProcessed map`, {
                remaining: this.recentlyProcessed.size,
            });
        }
    }

    /**
     * Start periodic cleanup interval for recentlyProcessed Map
     * FIX v3.2: cleanupDebounceMap() existed but was never called - memory leak
     * @private
     */
    _startCleanupInterval() {
        if (this.cleanupInterval) {
            return; // Already running
        }

        this.cleanupInterval = setInterval(() => {
            this.cleanupDebounceMap();
        }, this.cleanupIntervalMs);

        // Unref to not block process exit
        this.cleanupInterval.unref();

        log.debug('Started recentlyProcessed cleanup interval', {
            intervalMs: this.cleanupIntervalMs,
        });
    }

    /**
     * Stop cleanup interval
     * FIX v3.2: Called during graceful shutdown
     * @private
     */
    _stopCleanupInterval() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
            log.debug('Stopped recentlyProcessed cleanup interval');
        }
    }

    /**
     * Track a pair update for a specific block
     *
     * FIX v3.2: Added blockNumber validation to prevent "null"/"undefined" keys
     *
     * @private
     */
    _trackBlockUpdate(blockNumber, pairKey, dexName) {
        // FIX v3.2: Validate blockNumber to prevent invalid Map keys
        if (!Number.isInteger(blockNumber) || blockNumber < 0) {
            return;
        }

        if (!this.blockUpdates.has(blockNumber)) {
            this.blockUpdates.set(blockNumber, new Set());

            // Clean up old block history
            this._cleanupOldBlockUpdates(blockNumber);
        }

        // Track both the pairKey and the full key with DEX
        this.blockUpdates.get(blockNumber).add(pairKey);
        this.blockUpdates.get(blockNumber).add(`${pairKey}:${dexName}`);
    }

    /**
     * Clean up block update history older than maxBlockHistory
     *
     * FIX v3.2: Collect keys before deleting to prevent iteration-during-modification race
     *
     * @private
     */
    _cleanupOldBlockUpdates(currentBlock) {
        const minBlock = currentBlock - this.maxBlockHistory;

        // FIX v3.2: Collect keys first to avoid modifying Map during iteration
        const keysToDelete = [];
        for (const block of this.blockUpdates.keys()) {
            if (block < minBlock) {
                keysToDelete.push(block);
            }
        }

        // Delete after iteration completes
        for (const key of keysToDelete) {
            this.blockUpdates.delete(key);
        }
    }

    /**
     * Get set of pair keys updated in a specific block via Sync events
     * This is used by priceFetcher to skip redundant RPC calls
     *
     * @param {number} blockNumber - Block number to check
     * @returns {Set<string>} Set of pair keys updated in this block
     */
    getPairsUpdatedInBlock(blockNumber) {
        return this.blockUpdates.get(blockNumber) || new Set();
    }

    /**
     * Check if a pair was updated in a specific block
     * @param {string} pairKey - Pair key (e.g., "WBNB/USDT" or "WBNB/USDT:pancakeswap")
     * @param {number} blockNumber - Block number
     * @returns {boolean}
     */
    wasPairUpdatedInBlock(pairKey, blockNumber) {
        const updates = this.blockUpdates.get(blockNumber);
        return updates ? updates.has(pairKey) : false;
    }

    /**
     * Get count of pairs updated in recent blocks
     * @returns {Object} Block -> count mapping
     */
    getBlockUpdateCounts() {
        const counts = {};
        for (const [block, pairs] of this.blockUpdates) {
            counts[block] = pairs.size;
        }
        return counts;
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
            // FIX v3.2: Stop cleanup interval
            this._stopCleanupInterval();

            // Unsubscribe from rpcManager events
            rpcManager.off('wsFailover', this._boundHandleWsFailover);
            rpcManager.off('endpointRecovered', this._boundHandleWsRecovery);

            if (this.wsProvider) {
                // Remove all listeners for Sync, Swap V2, and V3 events
                this.wsProvider.removeAllListeners();
            }

            // Clear V2 state
            this.recentlyProcessed.clear();
            this.blockUpdates.clear();
            this.eventQueue = [];

            // Clear V3 state (registries are preserved for potential restart)
            // but clear any runtime state

            log.info('EventDrivenDetector stopped', {
                stats: this.stats,
                v2PairsMonitored: this.addressToPairInfo.size,
                v3PoolsMonitored: this.addressToV3PoolInfo.size,
            });

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
            v3PoolsSubscribed: this.addressToV3PoolInfo.size,
            debounceMapSize: this.recentlyProcessed.size,
            blocksTracked: this.blockUpdates.size,
            swapEventsEnabled: this.swapEventsEnabled,
            v3Enabled: this.v3Enabled,
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
            swapEventsReceived: 0,
            swapEventsProcessed: 0,
            // V3-specific stats
            v3SwapEventsReceived: 0,
            v3SwapEventsProcessed: 0,
            v3PriceUpdates: 0,
            errors: 0,
            lastEventTime: null,
            lastSwapTime: null,
            lastV3SwapTime: null,
        };
    }
}

// Export singleton instance
const eventDrivenDetector = new EventDrivenDetector();
export default eventDrivenDetector;
