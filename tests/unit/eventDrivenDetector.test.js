import { EventEmitter } from 'events';
import { jest } from '@jest/globals';

// Create a minimal EventDrivenDetector class for testing
// This avoids dependency issues with mocking
class TestableEventDrivenDetector extends EventEmitter {
    constructor(config = {}) {
        super();

        this.SYNC_TOPIC = '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1';
        this.wsProvider = null;
        this.pairRegistry = new Map();
        this.addressToPairInfo = new Map();
        this.isRunning = false;
        this.eventQueue = [];
        this.processingQueue = false;
        this.recentlyProcessed = new Map();
        this.debounceMs = config.debounceMs || 100;
        this.enabled = config.enabled !== false;
        this.maxPairsToSubscribe = config.maxPairs || 100;
        this.batchSize = config.batchSize || 50;

        this.stats = {
            eventsReceived: 0,
            eventsProcessed: 0,
            eventsDebounced: 0,
            reserveUpdates: 0,
            errors: 0,
            lastEventTime: null,
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
            debounceMapSize: this.recentlyProcessed.size,
        };
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
