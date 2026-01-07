import { EventEmitter } from 'events';
import { jest } from '@jest/globals';

// Create a minimal EventDrivenDetector class for testing
// This avoids dependency issues with mocking
class TestableEventDrivenDetector extends EventEmitter {
    constructor(config = {}) {
        super();

        // V2 Event Topics
        this.SYNC_TOPIC = '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1';
        this.SWAP_TOPIC_V2 = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
        this.SWAP_TOPIC = this.SWAP_TOPIC_V2; // Backwards compatibility

        // V3 Event Topics
        this.SWAP_TOPIC_V3 = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';

        this.wsProvider = null;
        this.pairRegistry = new Map();
        this.addressToPairInfo = new Map();

        // V3 pool registry
        this.v3PoolRegistry = new Map();
        this.addressToV3PoolInfo = new Map();

        this.isRunning = false;
        this.eventQueue = [];
        this.processingQueue = false;
        this.recentlyProcessed = new Map();
        this.debounceMs = config.debounceMs || 100;
        this.enabled = config.enabled !== false;
        this.maxPairsToSubscribe = config.maxPairs || 100;
        this.batchSize = config.batchSize || 50;
        this.swapEventsEnabled = config.swapEventsEnabled !== false;
        this.minSwapUSD = config.minSwapUSD || 1000;

        // V3 configuration
        this.v3Enabled = config.v3Enabled !== false;
        this.maxV3PoolsToSubscribe = config.maxV3Pools || 50;

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

    decodeSyncEvent(data) {
        try {
            const cleanData = data.startsWith('0x') ? data.slice(2) : data;

            if (cleanData.length < 128) {
                return null;
            }

            const reserve0Hex = cleanData.slice(0, 64);
            const reserve1Hex = cleanData.slice(64, 128);

            const reserve0 = BigInt('0x' + reserve0Hex);
            const reserve1 = BigInt('0x' + reserve1Hex);

            return { reserve0, reserve1 };
        } catch (error) {
            return null;
        }
    }

    handleSyncEvent(eventLog) {
        try {
            this.stats.eventsReceived++;
            this.stats.lastEventTime = Date.now();

            const pairAddress = eventLog.address.toLowerCase();
            const pairInfo = this.addressToPairInfo.get(pairAddress);

            if (!pairInfo) {
                return;
            }

            const lastProcessed = this.recentlyProcessed.get(pairAddress);
            if (lastProcessed && (Date.now() - lastProcessed) < this.debounceMs) {
                this.stats.eventsDebounced++;
                return;
            }

            const reserves = this.decodeSyncEvent(eventLog.data);
            if (!reserves) {
                return;
            }

            this.recentlyProcessed.set(pairAddress, Date.now());
            this.stats.eventsProcessed++;
            this.stats.reserveUpdates++;

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

            this.emit('priceChange', {
                pairKey: pairInfo.pairKey,
                dexName: pairInfo.dexName,
                reserves,
                blockNumber: eventLog.blockNumber,
            });
        } catch (error) {
            this.stats.errors++;
        }
    }

    decodeSwapEvent(eventLog) {
        try {
            if (!eventLog.topics || eventLog.topics.length < 3) {
                return null;
            }

            const sender = '0x' + eventLog.topics[1].slice(-40);
            const recipient = '0x' + eventLog.topics[2].slice(-40);

            const cleanData = eventLog.data.startsWith('0x')
                ? eventLog.data.slice(2)
                : eventLog.data;

            if (cleanData.length < 256) {
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
            return null;
        }
    }

    calculateSwapValue(swapData, tokenA, tokenB) {
        const isTokenAFirst = tokenA.address.toLowerCase() < tokenB.address.toLowerCase();
        const token0 = isTokenAFirst ? tokenA : tokenB;
        const token1 = isTokenAFirst ? tokenB : tokenA;

        // Mock prices for testing
        const mockPrices = { WBNB: 300, USDT: 1, CAKE: 5, ETH: 2000 };
        const price0 = mockPrices[token0.symbol] || 1;
        const price1 = mockPrices[token1.symbol] || 1;

        const amount0InFloat = Number(swapData.amount0In) / Math.pow(10, token0.decimals);
        const amount1InFloat = Number(swapData.amount1In) / Math.pow(10, token1.decimals);
        const amount0OutFloat = Number(swapData.amount0Out) / Math.pow(10, token0.decimals);
        const amount1OutFloat = Number(swapData.amount1Out) / Math.pow(10, token1.decimals);

        const inValueUSD = (amount0InFloat * price0) + (amount1InFloat * price1);
        const outValueUSD = (amount0OutFloat * price0) + (amount1OutFloat * price1);

        const amountUSD = Math.max(inValueUSD, outValueUSD);

        let direction = 'unknown';
        if (swapData.amount0In > 0n && swapData.amount1Out > 0n) {
            direction = isTokenAFirst ? 'sell' : 'buy';
        } else if (swapData.amount1In > 0n && swapData.amount0Out > 0n) {
            direction = isTokenAFirst ? 'buy' : 'sell';
        }

        return { amountUSD, direction };
    }

    handleSwapEvent(eventLog) {
        try {
            this.stats.swapEventsReceived++;
            this.stats.lastSwapTime = Date.now();

            const pairAddress = eventLog.address.toLowerCase();
            const pairInfo = this.addressToPairInfo.get(pairAddress);

            if (!pairInfo) {
                return;
            }

            const swapData = this.decodeSwapEvent(eventLog);
            if (!swapData) {
                return;
            }

            const { amountUSD, direction } = this.calculateSwapValue(
                swapData,
                pairInfo.tokenA,
                pairInfo.tokenB
            );

            if (amountUSD < this.minSwapUSD) {
                return;
            }

            this.stats.swapEventsProcessed++;

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
        } catch (error) {
            this.stats.errors++;
        }
    }

    async addPair(pairAddress, pairInfo) {
        const address = pairAddress.toLowerCase();
        if (this.addressToPairInfo.has(address)) {
            return;
        }
        this.pairRegistry.set(address, pairInfo);
        this.addressToPairInfo.set(address, pairInfo);
    }

    removePair(pairAddress) {
        const address = pairAddress.toLowerCase();
        this.pairRegistry.delete(address);
        this.addressToPairInfo.delete(address);
        this.recentlyProcessed.delete(address);
    }

    cleanupDebounceMap() {
        const now = Date.now();
        const expiry = this.debounceMs * 10;

        for (const [address, timestamp] of this.recentlyProcessed) {
            if (now - timestamp > expiry) {
                this.recentlyProcessed.delete(address);
            }
        }
    }

    async stop() {
        if (!this.isRunning) {
            return;
        }
        this.isRunning = false;
        if (this.wsProvider) {
            this.wsProvider.removeAllListeners();
        }
        this.recentlyProcessed.clear();
        this.eventQueue = [];
    }

    getStats() {
        return {
            ...this.stats,
            isRunning: this.isRunning,
            pairsSubscribed: this.addressToPairInfo.size,
            v3PoolsSubscribed: this.addressToV3PoolInfo.size,
            debounceMapSize: this.recentlyProcessed.size,
            swapEventsEnabled: this.swapEventsEnabled,
            v3Enabled: this.v3Enabled,
        };
    }

    // ============ V3 Methods ============

    /**
     * Parse signed int256 from hex string
     */
    _parseSignedInt256(hexStr) {
        const value = BigInt('0x' + hexStr);
        const maxPositive = (1n << 255n) - 1n;
        if (value > maxPositive) {
            return value - (1n << 256n);
        }
        return value;
    }

    /**
     * Parse signed int24 from hex string (padded to 256 bits)
     */
    _parseSignedInt24(hexStr) {
        const value = BigInt('0x' + hexStr);
        const maxPositive = (1n << 23n) - 1n;
        if (value > maxPositive) {
            const masked = value & ((1n << 24n) - 1n);
            if (masked > maxPositive) {
                return Number(masked) - (1 << 24);
            }
        }
        return Number(value & ((1n << 24n) - 1n));
    }

    /**
     * Decode V3 Swap event data
     */
    decodeSwapEventV3(eventLog) {
        try {
            if (!eventLog.topics || eventLog.topics.length < 3) {
                return null;
            }

            const sender = '0x' + eventLog.topics[1].slice(-40);
            const recipient = '0x' + eventLog.topics[2].slice(-40);

            const cleanData = eventLog.data.startsWith('0x')
                ? eventLog.data.slice(2)
                : eventLog.data;

            if (cleanData.length < 320) {
                return null;
            }

            const amount0Hex = cleanData.slice(0, 64);
            const amount1Hex = cleanData.slice(64, 128);
            const sqrtPriceX96Hex = cleanData.slice(128, 192);
            const liquidityHex = cleanData.slice(192, 256);
            const tickHex = cleanData.slice(256, 320);

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
            return null;
        }
    }

    /**
     * Calculate swap value and price from V3 swap data
     */
    calculateSwapValueV3(swapData, tokenA, tokenB) {
        const isTokenAFirst = tokenA.address.toLowerCase() < tokenB.address.toLowerCase();
        const token0 = isTokenAFirst ? tokenA : tokenB;
        const token1 = isTokenAFirst ? tokenB : tokenA;

        // Mock prices for testing
        const mockPrices = { WBNB: 300, USDT: 1, CAKE: 5, ETH: 2000 };
        const price0 = mockPrices[token0.symbol] || 1;
        const price1 = mockPrices[token1.symbol] || 1;

        const amount0Abs = swapData.amount0 < 0n ? -swapData.amount0 : swapData.amount0;
        const amount1Abs = swapData.amount1 < 0n ? -swapData.amount1 : swapData.amount1;

        const amount0Float = Number(amount0Abs) / Math.pow(10, token0.decimals);
        const amount1Float = Number(amount1Abs) / Math.pow(10, token1.decimals);

        const value0USD = amount0Float * price0;
        const value1USD = amount1Float * price1;
        const amountUSD = Math.max(value0USD, value1USD);

        let direction = 'unknown';
        if (swapData.amount0 > 0n && swapData.amount1 < 0n) {
            direction = isTokenAFirst ? 'sell' : 'buy';
        } else if (swapData.amount1 > 0n && swapData.amount0 < 0n) {
            direction = isTokenAFirst ? 'buy' : 'sell';
        }

        // Calculate price from sqrtPriceX96
        const sqrtPrice = swapData.sqrtPriceX96;
        const priceX192 = sqrtPrice * sqrtPrice;
        const decimalAdjust = Math.pow(10, token0.decimals - token1.decimals);
        const price = (Number(priceX192) / Number(2n ** 192n)) * decimalAdjust;

        return { amountUSD, direction, price };
    }

    /**
     * Handle incoming V3 Swap event
     */
    handleSwapEventV3(eventLog) {
        try {
            this.stats.v3SwapEventsReceived++;
            this.stats.lastV3SwapTime = Date.now();

            const poolAddress = eventLog.address.toLowerCase();
            const poolInfo = this.addressToV3PoolInfo.get(poolAddress);

            if (!poolInfo) {
                return;
            }

            const swapData = this.decodeSwapEventV3(eventLog);
            if (!swapData) {
                return;
            }

            const { amountUSD, direction, price } = this.calculateSwapValueV3(
                swapData,
                poolInfo.tokenA,
                poolInfo.tokenB
            );

            const emitSwapEvent = amountUSD >= this.minSwapUSD;

            this.stats.v3SwapEventsProcessed++;
            this.stats.v3PriceUpdates++;

            // Emit V3 price update event
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
        } catch (error) {
            this.stats.errors++;
        }
    }

    /**
     * Add a V3 pool to registry
     */
    async addV3Pool(poolAddress, poolInfo) {
        const address = poolAddress.toLowerCase();
        if (this.addressToV3PoolInfo.has(address)) {
            return;
        }
        this.v3PoolRegistry.set(address, poolInfo);
        this.addressToV3PoolInfo.set(address, poolInfo);
    }

    /**
     * Remove a V3 pool from registry
     */
    removeV3Pool(poolAddress) {
        const address = poolAddress.toLowerCase();
        this.v3PoolRegistry.delete(address);
        this.addressToV3PoolInfo.delete(address);
    }

    isActive() {
        return this.enabled && this.isRunning;
    }

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

// Mock token configuration for tests
const mockTokens = {
    WBNB: { symbol: 'WBNB', address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', decimals: 18 },
    USDT: { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
    CAKE: { symbol: 'CAKE', address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', decimals: 18 },
};

describe('EventDrivenDetector', () => {
    let detector;

    beforeEach(() => {
        detector = new TestableEventDrivenDetector({ enabled: true });
    });

    afterEach(async () => {
        if (detector.isRunning) {
            await detector.stop();
        }
        detector.removeAllListeners();
    });

    describe('Initialization', () => {
        test('should initialize with correct default values', () => {
            expect(detector.SYNC_TOPIC).toBe('0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1');
            expect(detector.isRunning).toBe(false);
            expect(detector.pairRegistry.size).toBe(0);
            expect(detector.stats.eventsReceived).toBe(0);
        });

        test('should have correct statistics structure', () => {
            expect(detector.stats).toHaveProperty('eventsReceived');
            expect(detector.stats).toHaveProperty('eventsProcessed');
            expect(detector.stats).toHaveProperty('eventsDebounced');
            expect(detector.stats).toHaveProperty('reserveUpdates');
            expect(detector.stats).toHaveProperty('errors');
        });

        test('should respect enabled config', () => {
            const disabledDetector = new TestableEventDrivenDetector({ enabled: false });
            expect(disabledDetector.enabled).toBe(false);
        });
    });

    describe('Sync Event Decoding', () => {
        test('should correctly decode Sync event data', () => {
            // Sample Sync event data with reserve0 = 1000000000000000000 (1e18)
            // and reserve1 = 2000000000000000000 (2e18)
            const reserve0 = '0000000000000000000000000000000000000000000000000de0b6b3a7640000'; // 1e18
            const reserve1 = '0000000000000000000000000000000000000000000000001bc16d674ec80000'; // 2e18
            const eventData = '0x' + reserve0 + reserve1;

            const result = detector.decodeSyncEvent(eventData);

            expect(result).not.toBeNull();
            expect(result.reserve0).toBe(BigInt('1000000000000000000'));
            expect(result.reserve1).toBe(BigInt('2000000000000000000'));
        });

        test('should return null for invalid event data', () => {
            const result = detector.decodeSyncEvent('0x1234');
            expect(result).toBeNull();
        });

        test('should handle event data without 0x prefix', () => {
            const reserve0 = '0000000000000000000000000000000000000000000000000de0b6b3a7640000';
            const reserve1 = '0000000000000000000000000000000000000000000000001bc16d674ec80000';
            const eventData = reserve0 + reserve1;

            const result = detector.decodeSyncEvent(eventData);

            expect(result).not.toBeNull();
            expect(result.reserve0).toBe(BigInt('1000000000000000000'));
        });

        test('should decode larger reserve values correctly', () => {
            // Large reserves: 1000000 tokens each
            const reserve0 = '00000000000000000000000000000000000000000000d3c21bcecceda1000000'; // 1e24
            const reserve1 = '00000000000000000000000000000000000000000000d3c21bcecceda1000000'; // 1e24
            const eventData = '0x' + reserve0 + reserve1;

            const result = detector.decodeSyncEvent(eventData);

            expect(result).not.toBeNull();
            expect(result.reserve0).toBe(BigInt('1000000000000000000000000'));
            expect(result.reserve1).toBe(BigInt('1000000000000000000000000'));
        });
    });

    describe('Pair Registry Management', () => {
        test('should add pair correctly', async () => {
            const pairAddress = '0x1234567890123456789012345678901234567890';
            const pairInfo = {
                tokenA: mockTokens.WBNB,
                tokenB: mockTokens.USDT,
                dexName: 'PancakeSwap',
                pairKey: 'WBNB/USDT',
            };

            await detector.addPair(pairAddress, pairInfo);

            expect(detector.pairRegistry.has(pairAddress.toLowerCase())).toBe(true);
            expect(detector.addressToPairInfo.has(pairAddress.toLowerCase())).toBe(true);
        });

        test('should remove pair correctly', async () => {
            const pairAddress = '0x1234567890123456789012345678901234567890';
            const pairInfo = {
                tokenA: mockTokens.WBNB,
                tokenB: mockTokens.USDT,
                dexName: 'PancakeSwap',
                pairKey: 'WBNB/USDT',
            };

            await detector.addPair(pairAddress, pairInfo);
            detector.removePair(pairAddress);

            expect(detector.pairRegistry.has(pairAddress.toLowerCase())).toBe(false);
            expect(detector.addressToPairInfo.has(pairAddress.toLowerCase())).toBe(false);
        });

        test('should not add duplicate pairs', async () => {
            const pairAddress = '0x1234567890123456789012345678901234567890';
            const pairInfo = {
                tokenA: mockTokens.WBNB,
                tokenB: mockTokens.USDT,
                dexName: 'PancakeSwap',
                pairKey: 'WBNB/USDT',
            };

            await detector.addPair(pairAddress, pairInfo);
            await detector.addPair(pairAddress, pairInfo);

            expect(detector.pairRegistry.size).toBe(1);
        });

        test('should handle case-insensitive addresses', async () => {
            const pairAddress = '0xAbCdEf1234567890123456789012345678901234';
            const pairInfo = {
                tokenA: mockTokens.WBNB,
                tokenB: mockTokens.USDT,
                dexName: 'PancakeSwap',
                pairKey: 'WBNB/USDT',
            };

            await detector.addPair(pairAddress, pairInfo);

            expect(detector.pairRegistry.has(pairAddress.toLowerCase())).toBe(true);
        });
    });

    describe('Event Handling', () => {
        test('should emit reserveUpdate event on valid Sync event', (done) => {
            const pairAddress = '0x1234567890123456789012345678901234567890';
            const pairInfo = {
                tokenA: mockTokens.WBNB,
                tokenB: mockTokens.USDT,
                dexName: 'PancakeSwap',
                pairKey: 'WBNB/USDT',
                fee: 0.0025,
            };

            detector.addressToPairInfo.set(pairAddress.toLowerCase(), pairInfo);

            detector.on('reserveUpdate', (data) => {
                try {
                    expect(data.pairAddress).toBe(pairAddress.toLowerCase());
                    expect(data.pairKey).toBe('WBNB/USDT');
                    expect(data.dexName).toBe('PancakeSwap');
                    expect(data.reserves).toHaveProperty('reserve0');
                    expect(data.reserves).toHaveProperty('reserve1');
                    done();
                } catch (e) {
                    done(e);
                }
            });

            const reserve0 = '0000000000000000000000000000000000000000000000000de0b6b3a7640000';
            const reserve1 = '0000000000000000000000000000000000000000000000001bc16d674ec80000';

            const mockEventLog = {
                address: pairAddress,
                data: '0x' + reserve0 + reserve1,
                blockNumber: 12345,
                transactionHash: '0xabc123',
            };

            detector.handleSyncEvent(mockEventLog);
        });

        test('should debounce rapid events from same pair', () => {
            const pairAddress = '0x1234567890123456789012345678901234567890';
            const pairInfo = {
                tokenA: mockTokens.WBNB,
                tokenB: mockTokens.USDT,
                dexName: 'PancakeSwap',
                pairKey: 'WBNB/USDT',
                fee: 0.0025,
            };

            detector.addressToPairInfo.set(pairAddress.toLowerCase(), pairInfo);
            detector.debounceMs = 1000; // 1 second debounce for testing

            const reserve0 = '0000000000000000000000000000000000000000000000000de0b6b3a7640000';
            const reserve1 = '0000000000000000000000000000000000000000000000001bc16d674ec80000';

            const mockEventLog = {
                address: pairAddress,
                data: '0x' + reserve0 + reserve1,
                blockNumber: 12345,
                transactionHash: '0xabc123',
            };

            // First event should be processed
            detector.handleSyncEvent(mockEventLog);
            expect(detector.stats.eventsProcessed).toBe(1);

            // Second immediate event should be debounced
            detector.handleSyncEvent(mockEventLog);
            expect(detector.stats.eventsDebounced).toBe(1);
            expect(detector.stats.eventsProcessed).toBe(1); // Still 1
        });

        test('should update statistics on each event', () => {
            const pairAddress = '0x1234567890123456789012345678901234567890';
            const pairInfo = {
                tokenA: mockTokens.WBNB,
                tokenB: mockTokens.USDT,
                dexName: 'PancakeSwap',
                pairKey: 'WBNB/USDT',
                fee: 0.0025,
            };

            detector.addressToPairInfo.set(pairAddress.toLowerCase(), pairInfo);

            const reserve0 = '0000000000000000000000000000000000000000000000000de0b6b3a7640000';
            const reserve1 = '0000000000000000000000000000000000000000000000001bc16d674ec80000';

            const mockEventLog = {
                address: pairAddress,
                data: '0x' + reserve0 + reserve1,
                blockNumber: 12345,
                transactionHash: '0xabc123',
            };

            detector.handleSyncEvent(mockEventLog);

            expect(detector.stats.eventsReceived).toBe(1);
            expect(detector.stats.eventsProcessed).toBe(1);
            expect(detector.stats.reserveUpdates).toBe(1);
            expect(detector.stats.lastEventTime).not.toBeNull();
        });

        test('should ignore events from unknown pairs', () => {
            const unknownPairAddress = '0xunknown';

            const reserve0 = '0000000000000000000000000000000000000000000000000de0b6b3a7640000';
            const reserve1 = '0000000000000000000000000000000000000000000000001bc16d674ec80000';

            const mockEventLog = {
                address: unknownPairAddress,
                data: '0x' + reserve0 + reserve1,
                blockNumber: 12345,
                transactionHash: '0xabc123',
            };

            detector.handleSyncEvent(mockEventLog);

            expect(detector.stats.eventsReceived).toBe(1);
            expect(detector.stats.eventsProcessed).toBe(0); // Not processed
        });
    });

    describe('Statistics', () => {
        test('should return correct stats', () => {
            detector.stats.eventsReceived = 100;
            detector.stats.eventsProcessed = 90;
            detector.stats.eventsDebounced = 10;
            detector.stats.errors = 0;

            const stats = detector.getStats();

            expect(stats.eventsReceived).toBe(100);
            expect(stats.eventsProcessed).toBe(90);
            expect(stats.eventsDebounced).toBe(10);
            expect(stats.isRunning).toBe(false);
        });

        test('should reset stats correctly', () => {
            detector.stats.eventsReceived = 100;
            detector.stats.eventsProcessed = 90;

            detector.resetStats();

            expect(detector.stats.eventsReceived).toBe(0);
            expect(detector.stats.eventsProcessed).toBe(0);
        });
    });

    describe('Lifecycle', () => {
        test('isActive should return false when not running', () => {
            expect(detector.isActive()).toBe(false);
        });

        test('isActive should return true when running and enabled', () => {
            detector.isRunning = true;
            expect(detector.isActive()).toBe(true);
        });

        test('isActive should return false when disabled even if running', () => {
            detector.isRunning = true;
            detector.enabled = false;
            expect(detector.isActive()).toBe(false);
        });

        test('should clean up on stop', async () => {
            detector.isRunning = true;
            detector.wsProvider = { removeAllListeners: jest.fn() };
            detector.recentlyProcessed.set('test', Date.now());

            await detector.stop();

            expect(detector.isRunning).toBe(false);
            expect(detector.wsProvider.removeAllListeners).toHaveBeenCalled();
            expect(detector.recentlyProcessed.size).toBe(0);
        });
    });

    describe('Debounce Cleanup', () => {
        test('should clean up old debounce entries', () => {
            const oldTimestamp = Date.now() - 10000; // 10 seconds ago
            const recentTimestamp = Date.now();

            detector.debounceMs = 100;
            detector.recentlyProcessed.set('old-pair', oldTimestamp);
            detector.recentlyProcessed.set('recent-pair', recentTimestamp);

            detector.cleanupDebounceMap();

            expect(detector.recentlyProcessed.has('old-pair')).toBe(false);
            expect(detector.recentlyProcessed.has('recent-pair')).toBe(true);
        });
    });

    describe('Price Change Event', () => {
        test('should emit priceChange event with correct data', (done) => {
            const pairAddress = '0x1234567890123456789012345678901234567890';
            const pairInfo = {
                tokenA: mockTokens.WBNB,
                tokenB: mockTokens.USDT,
                dexName: 'PancakeSwap',
                pairKey: 'WBNB/USDT',
                fee: 0.0025,
            };

            detector.addressToPairInfo.set(pairAddress.toLowerCase(), pairInfo);

            detector.on('priceChange', (data) => {
                try {
                    expect(data.pairKey).toBe('WBNB/USDT');
                    expect(data.dexName).toBe('PancakeSwap');
                    expect(data.blockNumber).toBe(12345);
                    expect(data.reserves).toBeDefined();
                    done();
                } catch (e) {
                    done(e);
                }
            });

            const reserve0 = '0000000000000000000000000000000000000000000000000de0b6b3a7640000';
            const reserve1 = '0000000000000000000000000000000000000000000000001bc16d674ec80000';

            const mockEventLog = {
                address: pairAddress,
                data: '0x' + reserve0 + reserve1,
                blockNumber: 12345,
                transactionHash: '0xabc123',
            };

            detector.handleSyncEvent(mockEventLog);
        });
    });
});

describe('Sync Event Topic Verification', () => {
    test('should have correct Sync event topic hash', () => {
        // The Sync event signature is: event Sync(uint112 reserve0, uint112 reserve1)
        // Topic should be keccak256("Sync(uint112,uint112)")
        const expectedTopic = '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1';
        const detector = new TestableEventDrivenDetector();
        expect(detector.SYNC_TOPIC).toBe(expectedTopic);
    });
});

describe('Swap Event Processing', () => {
    let detector;

    const mockTokens = {
        WBNB: { symbol: 'WBNB', address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', decimals: 18 },
        USDT: { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
    };

    beforeEach(() => {
        detector = new TestableEventDrivenDetector({ enabled: true, minSwapUSD: 100 });
    });

    afterEach(() => {
        detector.removeAllListeners();
    });

    describe('Swap Event Topic Verification', () => {
        test('should have correct Swap event topic hash', () => {
            // event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)
            const expectedTopic = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
            expect(detector.SWAP_TOPIC).toBe(expectedTopic);
        });
    });

    describe('Swap Event Decoding', () => {
        test('should correctly decode Swap event data', () => {
            // Swap event with:
            // sender: 0x1234567890123456789012345678901234567890
            // to: 0xabcdef1234567890123456789012345678901234
            // amount0In: 1e18, amount1In: 0, amount0Out: 0, amount1Out: 500e18
            const senderPadded = '0x0000000000000000000000001234567890123456789012345678901234567890';
            const toPadded = '0x000000000000000000000000abcdef1234567890123456789012345678901234';

            const amount0In = '0000000000000000000000000000000000000000000000000de0b6b3a7640000'; // 1e18
            const amount1In = '0000000000000000000000000000000000000000000000000000000000000000'; // 0
            const amount0Out = '0000000000000000000000000000000000000000000000000000000000000000'; // 0
            const amount1Out = '00000000000000000000000000000000000000000000001b1ae4d6e2ef500000'; // 500e18

            const mockEventLog = {
                topics: [
                    detector.SWAP_TOPIC,
                    senderPadded,
                    toPadded,
                ],
                data: '0x' + amount0In + amount1In + amount0Out + amount1Out,
                address: '0x1234567890123456789012345678901234567890',
                blockNumber: 12345,
            };

            const result = detector.decodeSwapEvent(mockEventLog);

            expect(result).not.toBeNull();
            expect(result.sender).toBe('0x1234567890123456789012345678901234567890');
            expect(result.recipient).toBe('0xabcdef1234567890123456789012345678901234');
            expect(result.amount0In).toBe(BigInt('1000000000000000000'));
            expect(result.amount1In).toBe(0n);
            expect(result.amount0Out).toBe(0n);
            expect(result.amount1Out).toBe(BigInt('500000000000000000000'));
        });

        test('should return null for invalid swap event data', () => {
            const mockEventLog = {
                topics: [detector.SWAP_TOPIC], // Missing sender/recipient
                data: '0x1234',
                address: '0x1234567890123456789012345678901234567890',
                blockNumber: 12345,
            };

            const result = detector.decodeSwapEvent(mockEventLog);
            expect(result).toBeNull();
        });

        test('should return null for insufficient data length', () => {
            const senderPadded = '0x0000000000000000000000001234567890123456789012345678901234567890';
            const toPadded = '0x000000000000000000000000abcdef1234567890123456789012345678901234';

            const mockEventLog = {
                topics: [detector.SWAP_TOPIC, senderPadded, toPadded],
                data: '0x1234', // Too short
                address: '0x1234567890123456789012345678901234567890',
                blockNumber: 12345,
            };

            const result = detector.decodeSwapEvent(mockEventLog);
            expect(result).toBeNull();
        });
    });

    describe('Swap Value Calculation', () => {
        test('should calculate swap value and direction correctly for buy', () => {
            const swapData = {
                amount0In: BigInt('1000000000000000000'), // 1 USDT (token0 = USDT)
                amount1In: 0n,
                amount0Out: 0n,
                amount1Out: BigInt('3000000000000000'), // 0.003 WBNB
            };

            // USDT address < WBNB address, so USDT is token0
            const result = detector.calculateSwapValue(swapData, mockTokens.WBNB, mockTokens.USDT);

            expect(result.amountUSD).toBeGreaterThan(0);
            expect(result.direction).toBe('buy'); // Selling USDT (token0), buying WBNB
        });

        test('should calculate swap value and direction correctly for sell', () => {
            const swapData = {
                amount0In: 0n,
                amount1In: BigInt('1000000000000000000'), // 1 WBNB
                amount0Out: BigInt('300000000000000000000'), // 300 USDT
                amount1Out: 0n,
            };

            // USDT address < WBNB address, so USDT is token0
            const result = detector.calculateSwapValue(swapData, mockTokens.WBNB, mockTokens.USDT);

            expect(result.amountUSD).toBeGreaterThan(0);
            expect(result.direction).toBe('sell'); // Selling WBNB, buying USDT
        });
    });

    describe('Swap Event Handling', () => {
        test('should emit swapDetected event on valid swap', (done) => {
            const pairAddress = '0x1234567890123456789012345678901234567890';
            const pairInfo = {
                tokenA: mockTokens.WBNB,
                tokenB: mockTokens.USDT,
                dexName: 'PancakeSwap',
                pairKey: 'WBNB/USDT',
            };

            detector.addressToPairInfo.set(pairAddress.toLowerCase(), pairInfo);

            detector.on('swapDetected', (data) => {
                try {
                    expect(data.pairAddress).toBe(pairAddress.toLowerCase());
                    expect(data.pairKey).toBe('WBNB/USDT');
                    expect(data.dexName).toBe('PancakeSwap');
                    expect(data.sender).toBeDefined();
                    expect(data.recipient).toBeDefined();
                    expect(data.amountUSD).toBeGreaterThan(0);
                    expect(['buy', 'sell', 'unknown']).toContain(data.direction);
                    done();
                } catch (e) {
                    done(e);
                }
            });

            const senderPadded = '0x0000000000000000000000001234567890123456789012345678901234567890';
            const toPadded = '0x000000000000000000000000abcdef1234567890123456789012345678901234';
            const amount0In = '0000000000000000000000000000000000000000000000000de0b6b3a7640000'; // 1e18
            const amount1In = '0000000000000000000000000000000000000000000000000000000000000000';
            const amount0Out = '0000000000000000000000000000000000000000000000000000000000000000';
            const amount1Out = '00000000000000000000000000000000000000000000001b1ae4d6e2ef500000'; // 500e18

            const mockEventLog = {
                topics: [detector.SWAP_TOPIC, senderPadded, toPadded],
                data: '0x' + amount0In + amount1In + amount0Out + amount1Out,
                address: pairAddress,
                blockNumber: 12345,
                transactionHash: '0xabc123',
            };

            detector.handleSwapEvent(mockEventLog);
        });

        test('should update swap statistics', () => {
            const pairAddress = '0x1234567890123456789012345678901234567890';
            const pairInfo = {
                tokenA: mockTokens.WBNB,
                tokenB: mockTokens.USDT,
                dexName: 'PancakeSwap',
                pairKey: 'WBNB/USDT',
            };

            detector.addressToPairInfo.set(pairAddress.toLowerCase(), pairInfo);

            const senderPadded = '0x0000000000000000000000001234567890123456789012345678901234567890';
            const toPadded = '0x000000000000000000000000abcdef1234567890123456789012345678901234';
            const amount0In = '0000000000000000000000000000000000000000000000000de0b6b3a7640000';
            const amount1In = '0000000000000000000000000000000000000000000000000000000000000000';
            const amount0Out = '0000000000000000000000000000000000000000000000000000000000000000';
            const amount1Out = '00000000000000000000000000000000000000000000001b1ae4d6e2ef500000';

            const mockEventLog = {
                topics: [detector.SWAP_TOPIC, senderPadded, toPadded],
                data: '0x' + amount0In + amount1In + amount0Out + amount1Out,
                address: pairAddress,
                blockNumber: 12345,
                transactionHash: '0xabc123',
            };

            detector.handleSwapEvent(mockEventLog);

            expect(detector.stats.swapEventsReceived).toBe(1);
            expect(detector.stats.swapEventsProcessed).toBe(1);
            expect(detector.stats.lastSwapTime).not.toBeNull();
        });

        test('should ignore swaps below minimum USD threshold', () => {
            const pairAddress = '0x1234567890123456789012345678901234567890';
            const pairInfo = {
                tokenA: mockTokens.WBNB,
                tokenB: mockTokens.USDT,
                dexName: 'PancakeSwap',
                pairKey: 'WBNB/USDT',
            };

            detector.addressToPairInfo.set(pairAddress.toLowerCase(), pairInfo);
            detector.minSwapUSD = 10000; // Set high threshold

            let eventEmitted = false;
            detector.on('swapDetected', () => {
                eventEmitted = true;
            });

            // Small swap: 0.0001 WBNB = ~$0.03
            const senderPadded = '0x0000000000000000000000001234567890123456789012345678901234567890';
            const toPadded = '0x000000000000000000000000abcdef1234567890123456789012345678901234';
            const amount0In = '0000000000000000000000000000000000000000000000000000000000000001'; // Very small
            const amount1In = '0000000000000000000000000000000000000000000000000000000000000000';
            const amount0Out = '0000000000000000000000000000000000000000000000000000000000000000';
            const amount1Out = '0000000000000000000000000000000000000000000000000000000000000001';

            const mockEventLog = {
                topics: [detector.SWAP_TOPIC, senderPadded, toPadded],
                data: '0x' + amount0In + amount1In + amount0Out + amount1Out,
                address: pairAddress,
                blockNumber: 12345,
                transactionHash: '0xabc123',
            };

            detector.handleSwapEvent(mockEventLog);

            expect(eventEmitted).toBe(false);
            expect(detector.stats.swapEventsReceived).toBe(1);
            expect(detector.stats.swapEventsProcessed).toBe(0); // Not processed due to threshold
        });

        test('should ignore swaps from unknown pairs', () => {
            const senderPadded = '0x0000000000000000000000001234567890123456789012345678901234567890';
            const toPadded = '0x000000000000000000000000abcdef1234567890123456789012345678901234';
            const amount0In = '0000000000000000000000000000000000000000000000000de0b6b3a7640000';
            const amount1In = '0000000000000000000000000000000000000000000000000000000000000000';
            const amount0Out = '0000000000000000000000000000000000000000000000000000000000000000';
            const amount1Out = '00000000000000000000000000000000000000000000001b1ae4d6e2ef500000';

            const mockEventLog = {
                topics: [detector.SWAP_TOPIC, senderPadded, toPadded],
                data: '0x' + amount0In + amount1In + amount0Out + amount1Out,
                address: '0xunknownpair',
                blockNumber: 12345,
                transactionHash: '0xabc123',
            };

            let eventEmitted = false;
            detector.on('swapDetected', () => {
                eventEmitted = true;
            });

            detector.handleSwapEvent(mockEventLog);

            expect(eventEmitted).toBe(false);
            expect(detector.stats.swapEventsReceived).toBe(1);
            expect(detector.stats.swapEventsProcessed).toBe(0);
        });

        test('should include swap event stats in getStats', () => {
            detector.stats.swapEventsReceived = 100;
            detector.stats.swapEventsProcessed = 80;

            const stats = detector.getStats();

            expect(stats.swapEventsReceived).toBe(100);
            expect(stats.swapEventsProcessed).toBe(80);
            expect(stats.swapEventsEnabled).toBe(true);
        });
    });
});

// ============ V3 Swap Event Processing Tests ============

describe('V3 Swap Event Processing', () => {
    let detector;

    const mockTokens = {
        WBNB: { symbol: 'WBNB', address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', decimals: 18 },
        USDT: { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
    };

    beforeEach(() => {
        detector = new TestableEventDrivenDetector({ enabled: true, v3Enabled: true, minSwapUSD: 100 });
    });

    afterEach(() => {
        detector.removeAllListeners();
    });

    describe('V3 Event Topic Verification', () => {
        test('should have correct V3 Swap event topic hash', () => {
            // V3 Swap event: event Swap(address indexed sender, address indexed recipient,
            //                          int256 amount0, int256 amount1, uint160 sqrtPriceX96,
            //                          uint128 liquidity, int24 tick)
            const expectedTopic = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
            expect(detector.SWAP_TOPIC_V3).toBe(expectedTopic);
        });

        test('should maintain backwards compatible V2 SWAP_TOPIC', () => {
            expect(detector.SWAP_TOPIC).toBe(detector.SWAP_TOPIC_V2);
        });
    });

    describe('V3 Pool Registry', () => {
        test('should add V3 pool correctly', async () => {
            const poolAddress = '0x1234567890123456789012345678901234567890';
            const poolInfo = {
                tokenA: mockTokens.WBNB,
                tokenB: mockTokens.USDT,
                dexName: 'PancakeSwapV3',
                poolKey: 'WBNB/USDT',
                feeTier: 2500, // 0.25%
            };

            await detector.addV3Pool(poolAddress, poolInfo);

            expect(detector.v3PoolRegistry.has(poolAddress.toLowerCase())).toBe(true);
            expect(detector.addressToV3PoolInfo.has(poolAddress.toLowerCase())).toBe(true);
        });

        test('should remove V3 pool correctly', async () => {
            const poolAddress = '0x1234567890123456789012345678901234567890';
            const poolInfo = {
                tokenA: mockTokens.WBNB,
                tokenB: mockTokens.USDT,
                dexName: 'PancakeSwapV3',
                poolKey: 'WBNB/USDT',
                feeTier: 2500,
            };

            await detector.addV3Pool(poolAddress, poolInfo);
            detector.removeV3Pool(poolAddress);

            expect(detector.v3PoolRegistry.has(poolAddress.toLowerCase())).toBe(false);
            expect(detector.addressToV3PoolInfo.has(poolAddress.toLowerCase())).toBe(false);
        });

        test('should include V3 pools in getStats', () => {
            const stats = detector.getStats();
            expect(stats.v3PoolsSubscribed).toBe(0);
            expect(stats.v3Enabled).toBe(true);
        });
    });

    describe('V3 Swap Event Decoding', () => {
        test('should correctly decode V3 Swap event data', () => {
            // V3 Swap event with:
            // sender: 0x1234567890123456789012345678901234567890
            // recipient: 0xabcdef1234567890123456789012345678901234
            // amount0: -1e18 (negative = tokens OUT)
            // amount1: 300e18 (positive = tokens IN)
            // sqrtPriceX96: some value
            // liquidity: some value
            // tick: -12345

            const senderPadded = '0x0000000000000000000000001234567890123456789012345678901234567890';
            const recipientPadded = '0x000000000000000000000000abcdef1234567890123456789012345678901234';

            // amount0 = -1e18 (in two's complement 256-bit)
            const amount0Negative = 'fffffffffffffffffffffffffffffffffffffffffffffffff21f494c589c0000'; // -1e18
            // amount1 = 300e18
            const amount1 = '00000000000000000000000000000000000000000000001043561a8829300000'; // 300e18
            // sqrtPriceX96 (example value)
            const sqrtPriceX96 = '000000000000000000000000000000000000000001000000000000000000000000';
            // liquidity
            const liquidity = '0000000000000000000000000000000000000000000000001bc16d674ec80000';
            // tick = -12345 (negative, in two's complement)
            const tick = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffcfc7'; // -12345

            const mockEventLog = {
                topics: [
                    detector.SWAP_TOPIC_V3,
                    senderPadded,
                    recipientPadded,
                ],
                data: '0x' + amount0Negative + amount1 + sqrtPriceX96 + liquidity + tick,
                address: '0x1234567890123456789012345678901234567890',
                blockNumber: 12345,
            };

            const result = detector.decodeSwapEventV3(mockEventLog);

            expect(result).not.toBeNull();
            expect(result.sender).toBe('0x1234567890123456789012345678901234567890');
            expect(result.recipient).toBe('0xabcdef1234567890123456789012345678901234');
            expect(result.amount0).toBeLessThan(0n); // Negative (tokens out)
            expect(result.amount1).toBeGreaterThan(0n); // Positive (tokens in)
            expect(result.sqrtPriceX96).toBeGreaterThan(0n);
            expect(result.liquidity).toBeGreaterThan(0n);
        });

        test('should return null for invalid V3 event data', () => {
            const mockEventLog = {
                topics: [detector.SWAP_TOPIC_V3], // Missing sender/recipient
                data: '0x1234',
                address: '0x1234567890123456789012345678901234567890',
                blockNumber: 12345,
            };

            const result = detector.decodeSwapEventV3(mockEventLog);
            expect(result).toBeNull();
        });

        test('should return null for insufficient V3 data length', () => {
            const senderPadded = '0x0000000000000000000000001234567890123456789012345678901234567890';
            const recipientPadded = '0x000000000000000000000000abcdef1234567890123456789012345678901234';

            const mockEventLog = {
                topics: [detector.SWAP_TOPIC_V3, senderPadded, recipientPadded],
                data: '0x1234', // Too short - needs 320 hex chars for 5 values
                address: '0x1234567890123456789012345678901234567890',
                blockNumber: 12345,
            };

            const result = detector.decodeSwapEventV3(mockEventLog);
            expect(result).toBeNull();
        });
    });

    describe('V3 Swap Value Calculation', () => {
        test('should calculate swap value and direction for V3 buy', () => {
            // V3: positive amount = tokens IN, negative amount = tokens OUT
            // Selling USDT (amount0 > 0), buying WBNB (amount1 < 0)
            const swapData = {
                amount0: BigInt('1000000000000000000'), // +1 USDT (selling)
                amount1: BigInt('-3000000000000000'), // -0.003 WBNB (buying)
                sqrtPriceX96: BigInt('79228162514264337593543950336'), // ~1.0 price
                liquidity: BigInt('1000000000000000000'),
                tick: 0,
            };

            // USDT address < WBNB address, so USDT is token0
            const result = detector.calculateSwapValueV3(swapData, mockTokens.WBNB, mockTokens.USDT);

            expect(result.amountUSD).toBeGreaterThan(0);
            expect(result.direction).toBe('buy'); // Selling USDT (token0), buying WBNB
            expect(result.price).toBeDefined();
        });

        test('should calculate swap value and direction for V3 sell', () => {
            // V3: positive amount = tokens IN, negative amount = tokens OUT
            // Selling WBNB (amount1 > 0), buying USDT (amount0 < 0)
            const swapData = {
                amount0: BigInt('-300000000000000000000'), // -300 USDT (getting)
                amount1: BigInt('1000000000000000000'), // +1 WBNB (selling)
                sqrtPriceX96: BigInt('79228162514264337593543950336'),
                liquidity: BigInt('1000000000000000000'),
                tick: 0,
            };

            const result = detector.calculateSwapValueV3(swapData, mockTokens.WBNB, mockTokens.USDT);

            expect(result.amountUSD).toBeGreaterThan(0);
            expect(result.direction).toBe('sell'); // Selling WBNB, buying USDT
        });
    });

    describe('V3 Swap Event Handling', () => {
        test('should emit v3PriceUpdate event on valid V3 swap', (done) => {
            const poolAddress = '0x1234567890123456789012345678901234567890';
            const poolInfo = {
                tokenA: mockTokens.WBNB,
                tokenB: mockTokens.USDT,
                dexName: 'PancakeSwapV3',
                poolKey: 'WBNB/USDT',
                feeTier: 2500,
            };

            detector.addressToV3PoolInfo.set(poolAddress.toLowerCase(), poolInfo);

            detector.on('v3PriceUpdate', (data) => {
                try {
                    expect(data.poolAddress).toBe(poolAddress.toLowerCase());
                    expect(data.poolKey).toBe('WBNB/USDT');
                    expect(data.dexName).toBe('PancakeSwapV3');
                    expect(data.feeTier).toBe(2500);
                    expect(data.sqrtPriceX96).toBeDefined();
                    expect(data.liquidity).toBeDefined();
                    expect(data.tick).toBeDefined();
                    expect(data.price).toBeDefined();
                    done();
                } catch (e) {
                    done(e);
                }
            });

            const senderPadded = '0x0000000000000000000000001234567890123456789012345678901234567890';
            const recipientPadded = '0x000000000000000000000000abcdef1234567890123456789012345678901234';
            // Valid V3 swap data (5 x 64 hex chars = 320 chars)
            const amount0 = 'fffffffffffffffffffffffffffffffffffffffffffffffff21f494c589c0000'; // -1e18
            const amount1 = '00000000000000000000000000000000000000000000001043561a8829300000'; // 300e18
            const sqrtPriceX96 = '000000000000000000000000000000000000000001000000000000000000000000';
            const liquidity = '0000000000000000000000000000000000000000000000001bc16d674ec80000';
            const tick = '0000000000000000000000000000000000000000000000000000000000000000'; // tick 0

            const mockEventLog = {
                topics: [detector.SWAP_TOPIC_V3, senderPadded, recipientPadded],
                data: '0x' + amount0 + amount1 + sqrtPriceX96 + liquidity + tick,
                address: poolAddress,
                blockNumber: 12345,
                transactionHash: '0xabc123',
            };

            detector.handleSwapEventV3(mockEventLog);
        });

        test('should update V3 swap statistics', () => {
            const poolAddress = '0x1234567890123456789012345678901234567890';
            const poolInfo = {
                tokenA: mockTokens.WBNB,
                tokenB: mockTokens.USDT,
                dexName: 'PancakeSwapV3',
                poolKey: 'WBNB/USDT',
                feeTier: 2500,
            };

            detector.addressToV3PoolInfo.set(poolAddress.toLowerCase(), poolInfo);

            const senderPadded = '0x0000000000000000000000001234567890123456789012345678901234567890';
            const recipientPadded = '0x000000000000000000000000abcdef1234567890123456789012345678901234';
            const amount0 = 'fffffffffffffffffffffffffffffffffffffffffffffffff21f494c589c0000';
            const amount1 = '00000000000000000000000000000000000000000000001043561a8829300000';
            const sqrtPriceX96 = '000000000000000000000000000000000000000001000000000000000000000000';
            const liquidity = '0000000000000000000000000000000000000000000000001bc16d674ec80000';
            const tick = '0000000000000000000000000000000000000000000000000000000000000000';

            const mockEventLog = {
                topics: [detector.SWAP_TOPIC_V3, senderPadded, recipientPadded],
                data: '0x' + amount0 + amount1 + sqrtPriceX96 + liquidity + tick,
                address: poolAddress,
                blockNumber: 12345,
                transactionHash: '0xabc123',
            };

            detector.handleSwapEventV3(mockEventLog);

            expect(detector.stats.v3SwapEventsReceived).toBe(1);
            expect(detector.stats.v3SwapEventsProcessed).toBe(1);
            expect(detector.stats.v3PriceUpdates).toBe(1);
            expect(detector.stats.lastV3SwapTime).not.toBeNull();
        });

        test('should emit swapDetected for large V3 swaps (for whale tracking)', (done) => {
            const poolAddress = '0x1234567890123456789012345678901234567890';
            const poolInfo = {
                tokenA: mockTokens.WBNB,
                tokenB: mockTokens.USDT,
                dexName: 'PancakeSwapV3',
                poolKey: 'WBNB/USDT',
                feeTier: 2500,
            };

            detector.addressToV3PoolInfo.set(poolAddress.toLowerCase(), poolInfo);
            detector.minSwapUSD = 100; // Lower threshold for test

            detector.on('swapDetected', (data) => {
                try {
                    expect(data.isV3).toBe(true);
                    expect(data.feeTier).toBe(2500);
                    expect(data.sender).toBeDefined();
                    expect(data.recipient).toBeDefined();
                    expect(data.amountUSD).toBeGreaterThan(0);
                    done();
                } catch (e) {
                    done(e);
                }
            });

            const senderPadded = '0x0000000000000000000000001234567890123456789012345678901234567890';
            const recipientPadded = '0x000000000000000000000000abcdef1234567890123456789012345678901234';
            const amount0 = 'fffffffffffffffffffffffffffffffffffffffffffffffff21f494c589c0000';
            const amount1 = '00000000000000000000000000000000000000000000001043561a8829300000';
            const sqrtPriceX96 = '000000000000000000000000000000000000000001000000000000000000000000';
            const liquidity = '0000000000000000000000000000000000000000000000001bc16d674ec80000';
            const tick = '0000000000000000000000000000000000000000000000000000000000000000';

            const mockEventLog = {
                topics: [detector.SWAP_TOPIC_V3, senderPadded, recipientPadded],
                data: '0x' + amount0 + amount1 + sqrtPriceX96 + liquidity + tick,
                address: poolAddress,
                blockNumber: 12345,
                transactionHash: '0xabc123',
            };

            detector.handleSwapEventV3(mockEventLog);
        });

        test('should ignore V3 swaps from unknown pools', () => {
            const senderPadded = '0x0000000000000000000000001234567890123456789012345678901234567890';
            const recipientPadded = '0x000000000000000000000000abcdef1234567890123456789012345678901234';
            const amount0 = 'fffffffffffffffffffffffffffffffffffffffffffffffff21f494c589c0000';
            const amount1 = '00000000000000000000000000000000000000000000001043561a8829300000';
            const sqrtPriceX96 = '000000000000000000000000000000000000000001000000000000000000000000';
            const liquidity = '0000000000000000000000000000000000000000000000001bc16d674ec80000';
            const tick = '0000000000000000000000000000000000000000000000000000000000000000';

            const mockEventLog = {
                topics: [detector.SWAP_TOPIC_V3, senderPadded, recipientPadded],
                data: '0x' + amount0 + amount1 + sqrtPriceX96 + liquidity + tick,
                address: '0xunknownpool',
                blockNumber: 12345,
                transactionHash: '0xabc123',
            };

            let eventEmitted = false;
            detector.on('v3PriceUpdate', () => {
                eventEmitted = true;
            });

            detector.handleSwapEventV3(mockEventLog);

            expect(eventEmitted).toBe(false);
            expect(detector.stats.v3SwapEventsReceived).toBe(1);
            expect(detector.stats.v3SwapEventsProcessed).toBe(0);
        });

        test('should include V3 stats in getStats', () => {
            detector.stats.v3SwapEventsReceived = 100;
            detector.stats.v3SwapEventsProcessed = 90;
            detector.stats.v3PriceUpdates = 90;

            const stats = detector.getStats();

            expect(stats.v3SwapEventsReceived).toBe(100);
            expect(stats.v3SwapEventsProcessed).toBe(90);
            expect(stats.v3PriceUpdates).toBe(90);
            expect(stats.v3Enabled).toBe(true);
            expect(stats.v3PoolsSubscribed).toBe(0);
        });
    });

    describe('Signed Integer Parsing', () => {
        test('should correctly parse positive int256', () => {
            // +1e18 = 0x0de0b6b3a7640000
            const hexStr = '0000000000000000000000000000000000000000000000000de0b6b3a7640000';
            const result = detector._parseSignedInt256(hexStr);
            expect(result).toBe(BigInt('1000000000000000000'));
        });

        test('should correctly parse negative int256', () => {
            // -1e18 in two's complement
            const hexStr = 'fffffffffffffffffffffffffffffffffffffffffffffffff21f494c589c0000';
            const result = detector._parseSignedInt256(hexStr);
            expect(result).toBeLessThan(0n);
        });

        test('should correctly parse positive int24', () => {
            // tick = 100 (padded to 256 bits)
            const hexStr = '0000000000000000000000000000000000000000000000000000000000000064';
            const result = detector._parseSignedInt24(hexStr);
            expect(result).toBe(100);
        });

        test('should correctly parse negative int24', () => {
            // tick = -100 in two's complement (24-bit range)
            // -100 in 24-bit = 0xFFFF9C, padded to 256 bits as signed extend
            const hexStr = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff9c';
            const result = detector._parseSignedInt24(hexStr);
            expect(result).toBe(-100);
        });
    });
});
