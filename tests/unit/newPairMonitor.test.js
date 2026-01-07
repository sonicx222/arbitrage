import { jest } from '@jest/globals';

// Mock logger
jest.unstable_mockModule('../../src/utils/logger.js', () => ({
    default: {
        info: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
    }
}));

// Mock ethers
const mockOn = jest.fn();
const mockOff = jest.fn();
const mockFilters = {
    PairCreated: jest.fn(() => 'PairCreatedFilter'),
};
const mockContract = jest.fn(() => ({
    on: mockOn,
    off: mockOff,
    filters: mockFilters,
}));

jest.unstable_mockModule('ethers', () => ({
    ethers: {
        Contract: mockContract,
    },
}));

// Import after mocks
const { NewPairMonitor, default: newPairMonitor } = await import('../../src/monitoring/newPairMonitor.js');

describe('NewPairMonitor', () => {
    let monitor;

    beforeEach(() => {
        monitor = new NewPairMonitor();
        mockOn.mockClear();
        mockOff.mockClear();
        mockContract.mockClear();
    });

    describe('constructor', () => {
        test('should initialize with default values', () => {
            expect(monitor.minLiquidityUSD).toBe(1000);
            expect(monitor.minSpreadPercent).toBe(0.5);
            expect(monitor.monitoringWindow).toBe(24 * 60 * 60 * 1000);
        });

        test('should accept custom configuration', () => {
            const custom = new NewPairMonitor({
                minLiquidityUSD: 5000,
                minSpreadPercent: 1.0,
                monitoringWindow: 12 * 60 * 60 * 1000,
            });

            expect(custom.minLiquidityUSD).toBe(5000);
            expect(custom.minSpreadPercent).toBe(1.0);
            expect(custom.monitoringWindow).toBe(12 * 60 * 60 * 1000);
        });
    });

    describe('setFactories', () => {
        test('should configure factories for a chain', () => {
            const factories = {
                pancakeswap: '0x1234567890123456789012345678901234567890',
                biswap: '0x0987654321098765432109876543210987654321',
            };

            monitor.setFactories(56, factories);

            expect(monitor.factoryAddresses[56]).toEqual(factories);
        });
    });

    describe('setKnownTokens', () => {
        test('should set known tokens for a chain', () => {
            const tokens = {
                WBNB: { address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', decimals: 18 },
                USDT: { address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
            };

            monitor.setKnownTokens(56, tokens);

            expect(monitor.knownTokens[56]).toEqual(tokens);
        });
    });

    describe('subscribe', () => {
        test('should warn if no factories configured', async () => {
            const provider = {};
            await monitor.subscribe(56, provider);

            expect(monitor.subscriptions.length).toBe(0);
        });

        test('should create subscriptions for configured factories', async () => {
            const factories = {
                pancakeswap: '0x1234567890123456789012345678901234567890',
            };
            monitor.setFactories(56, factories);

            const provider = {};
            await monitor.subscribe(56, provider);

            expect(mockContract).toHaveBeenCalledWith(
                factories.pancakeswap,
                expect.any(Array),
                provider
            );
            expect(mockOn).toHaveBeenCalled();
            expect(monitor.subscriptions.length).toBe(1);
        });
    });

    describe('_handleNewPair', () => {
        test('should track new pair and emit event', async () => {
            const spy = jest.fn();
            monitor.on('newPairDetected', spy);

            monitor.setKnownTokens(56, {
                WBNB: { address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', decimals: 18 },
            });

            await monitor._handleNewPair(56, 'pancakeswap', {
                token0: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
                token1: '0x55d398326f99059fF775485246999027B3197955',
                pairAddress: '0xNewPair123',
                pairCount: 12345,
                blockNumber: 1000000,
            });

            expect(spy).toHaveBeenCalled();
            expect(monitor.stats.pairsDetected).toBe(1);
            expect(monitor.recentPairs.size).toBe(1);
        });

        test('should detect opportunity when known token found', async () => {
            const opportunitySpy = jest.fn();
            monitor.on('newPairOpportunity', opportunitySpy);

            monitor.setKnownTokens(56, {
                WBNB: { address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', decimals: 18 },
            });

            await monitor._handleNewPair(56, 'pancakeswap', {
                token0: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
                token1: '0xNewToken123',
                pairAddress: '0xNewPair456',
                pairCount: 12346,
                blockNumber: 1000001,
            });

            expect(opportunitySpy).toHaveBeenCalled();
            expect(monitor.stats.opportunitiesFound).toBe(1);
        });
    });

    describe('_findKnownToken', () => {
        test('should find known token by address', () => {
            const knownTokens = {
                WBNB: { address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', decimals: 18 },
            };

            const result = monitor._findKnownToken(
                '0xBB4CDB9CBD36B01BD1CBAEBF2DE08D9173BC095C', // uppercase
                knownTokens
            );

            expect(result).toBe('WBNB');
        });

        test('should return null for unknown token', () => {
            const knownTokens = {
                WBNB: { address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', decimals: 18 },
            };

            const result = monitor._findKnownToken(
                '0x1234567890123456789012345678901234567890',
                knownTokens
            );

            expect(result).toBeNull();
        });
    });

    describe('_cleanupOldPairs', () => {
        test('should remove pairs older than monitoring window', () => {
            // Add old pair
            const oldTime = Date.now() - (25 * 60 * 60 * 1000); // 25 hours ago
            monitor.recentPairs.set('56:0xOldPair', {
                chainId: 56,
                detectedAt: oldTime,
            });

            // Add recent pair
            monitor.recentPairs.set('56:0xNewPair', {
                chainId: 56,
                detectedAt: Date.now(),
            });

            monitor._cleanupOldPairs();

            expect(monitor.recentPairs.has('56:0xOldPair')).toBe(false);
            expect(monitor.recentPairs.has('56:0xNewPair')).toBe(true);
        });

        test('should limit total pairs to maxRecentPairs', () => {
            monitor.maxRecentPairs = 5;

            // Add 10 pairs
            for (let i = 0; i < 10; i++) {
                monitor.recentPairs.set(`56:0xPair${i}`, {
                    chainId: 56,
                    detectedAt: Date.now() - (i * 1000), // Staggered times
                });
            }

            monitor._cleanupOldPairs();

            expect(monitor.recentPairs.size).toBe(5);
        });
    });

    describe('getRecentPairs', () => {
        test('should return all recent pairs', () => {
            monitor.recentPairs.set('56:0xPair1', {
                chainId: 56,
                detectedAt: Date.now() - 1000,
            });
            monitor.recentPairs.set('56:0xPair2', {
                chainId: 56,
                detectedAt: Date.now(),
            });

            const pairs = monitor.getRecentPairs();

            expect(pairs.length).toBe(2);
            // Should be sorted newest first
            expect(pairs[0].detectedAt).toBeGreaterThan(pairs[1].detectedAt);
        });

        test('should filter by chain ID', () => {
            monitor.recentPairs.set('56:0xPair1', {
                chainId: 56,
                detectedAt: Date.now(),
            });
            monitor.recentPairs.set('1:0xPair2', {
                chainId: 1,
                detectedAt: Date.now(),
            });

            const bscPairs = monitor.getRecentPairs(56);
            const ethPairs = monitor.getRecentPairs(1);

            expect(bscPairs.length).toBe(1);
            expect(ethPairs.length).toBe(1);
            expect(bscPairs[0].chainId).toBe(56);
        });

        test('should respect limit parameter', () => {
            for (let i = 0; i < 10; i++) {
                monitor.recentPairs.set(`56:0xPair${i}`, {
                    chainId: 56,
                    detectedAt: Date.now(),
                });
            }

            const pairs = monitor.getRecentPairs(null, 3);

            expect(pairs.length).toBe(3);
        });
    });

    describe('getPairsWithOpportunities', () => {
        test('should return only pairs with opportunities', () => {
            monitor.recentPairs.set('56:0xPair1', {
                chainId: 56,
                opportunities: [{ type: 'new-pair' }],
            });
            monitor.recentPairs.set('56:0xPair2', {
                chainId: 56,
                opportunities: [],
            });

            const pairs = monitor.getPairsWithOpportunities();

            expect(pairs.length).toBe(1);
            expect(pairs[0].opportunities.length).toBeGreaterThan(0);
        });
    });

    describe('getStats', () => {
        test('should return statistics', () => {
            monitor.stats.pairsDetected = 10;
            monitor.stats.opportunitiesFound = 3;
            monitor.recentPairs.set('56:0xPair1', { chainId: 56 });

            const stats = monitor.getStats();

            expect(stats.pairsDetected).toBe(10);
            expect(stats.opportunitiesFound).toBe(3);
            expect(stats.activePairs).toBe(1);
        });
    });

    describe('unsubscribe', () => {
        test('should remove all subscriptions', async () => {
            monitor.subscriptions = [
                {
                    chainId: 56,
                    dexName: 'pancakeswap',
                    factory: { off: mockOff },
                    filter: 'PairCreatedFilter',
                    listener: jest.fn(),
                },
            ];

            monitor.unsubscribe();

            expect(mockOff).toHaveBeenCalled();
            expect(monitor.subscriptions.length).toBe(0);
        });
    });

    describe('reset', () => {
        test('should reset all state', () => {
            monitor.stats.pairsDetected = 10;
            monitor.recentPairs.set('56:0xPair1', { chainId: 56 });

            monitor.reset();

            expect(monitor.stats.pairsDetected).toBe(0);
            expect(monitor.recentPairs.size).toBe(0);
        });
    });
});

// Test singleton instance
describe('NewPairMonitor Singleton', () => {
    test('should export singleton instance', () => {
        expect(newPairMonitor).toBeDefined();
        expect(typeof newPairMonitor.subscribe).toBe('function');
    });

    test('should be an EventEmitter', () => {
        expect(typeof newPairMonitor.on).toBe('function');
        expect(typeof newPairMonitor.emit).toBe('function');
    });
});
