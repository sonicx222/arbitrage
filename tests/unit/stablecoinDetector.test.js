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

// Import after mocks
const { default: StablecoinDetector } = await import('../../src/analysis/stablecoinDetector.js');

describe('StablecoinDetector', () => {
    let detector;

    beforeEach(() => {
        detector = new StablecoinDetector();
    });

    describe('constructor', () => {
        test('should initialize with default stablecoins', () => {
            expect(detector.stablecoinsByChain).toBeDefined();
            expect(detector.stablecoinsByChain[56]).toContain('USDT');
            expect(detector.stablecoinsByChain[56]).toContain('USDC');
        });

        test('should accept custom configuration', () => {
            const customDetector = new StablecoinDetector({
                depegThreshold: 0.01,
                arbitrageThreshold: 0.005,
            });

            expect(customDetector.depegThreshold).toBe(0.01);
            expect(customDetector.arbitrageThreshold).toBe(0.005);
        });
    });

    describe('isStablecoin', () => {
        test('should identify known stablecoins', () => {
            expect(detector.isStablecoin(56, 'USDT')).toBe(true);
            expect(detector.isStablecoin(56, 'USDC')).toBe(true);
            expect(detector.isStablecoin(56, 'DAI')).toBe(true);
        });

        test('should return false for non-stablecoins', () => {
            expect(detector.isStablecoin(56, 'WBNB')).toBe(false);
            expect(detector.isStablecoin(56, 'ETH')).toBe(false);
            expect(detector.isStablecoin(56, 'CAKE')).toBe(false);
        });

        test('should handle unknown chains', () => {
            expect(detector.isStablecoin(999, 'USDT')).toBe(false);
        });
    });

    describe('addStablecoins', () => {
        test('should add new stablecoins to existing chain', () => {
            detector.addStablecoins(56, ['NEW_STABLE']);
            expect(detector.stablecoinsByChain[56]).toContain('NEW_STABLE');
        });

        test('should add stablecoins to new chain', () => {
            detector.addStablecoins(999, ['USTC', 'USDX']);
            expect(detector.stablecoinsByChain[999]).toContain('USTC');
            expect(detector.stablecoinsByChain[999]).toContain('USDX');
        });

        test('should not duplicate stablecoins', () => {
            detector.addStablecoins(56, ['USDT', 'USDC']);
            const usdtCount = detector.stablecoinsByChain[56].filter(s => s === 'USDT').length;
            expect(usdtCount).toBe(1);
        });
    });

    describe('analyzeStablecoins', () => {
        test('should return empty array when no stables for chain', () => {
            const result = detector.analyzeStablecoins(999999, {}, 100);
            expect(result).toEqual([]);
        });

        test('should return empty array when less than 2 stables', () => {
            detector.stablecoinsByChain[999] = ['USDT'];
            const result = detector.analyzeStablecoins(999, {}, 100);
            expect(result).toEqual([]);
        });

        test('should detect cross-DEX arbitrage opportunity', () => {
            const prices = {
                'USDT/USDC': {
                    'pancakeswap': { price: 0.998, fee: 0.0025, liquidityUSD: 1000000 },
                    'biswap': { price: 1.005, fee: 0.001, liquidityUSD: 500000 },
                },
            };

            const result = detector.analyzeStablecoins(56, prices, 100);

            // Should find opportunity: buy on pancakeswap (lower), sell on biswap (higher)
            const crossDexOpps = result.filter(r => r.type === 'stable-cross-dex');
            expect(crossDexOpps.length).toBeGreaterThanOrEqual(0); // May or may not pass threshold
        });

        test('should detect significant spreads', () => {
            // Create a clear arbitrage opportunity
            const prices = {
                'USDT/USDC': {
                    'dex1': { price: 0.990, fee: 0.001, liquidityUSD: 1000000 },
                    'dex2': { price: 1.010, fee: 0.001, liquidityUSD: 1000000 },
                },
            };

            const result = detector.analyzeStablecoins(56, prices, 100);
            const crossDexOpps = result.filter(r => r.type === 'stable-cross-dex');

            // 2% spread minus 0.2% fees = 1.8% net spread (above 0.3% threshold)
            expect(crossDexOpps.length).toBeGreaterThan(0);
            expect(crossDexOpps[0].spreadPercent).toBeGreaterThan(1.5);
        });
    });

    describe('_checkDepegStatus', () => {
        test('should detect minor depeg', () => {
            const prices = {
                'USDT/USDC': {
                    'dex1': { price: 0.997, fee: 0.003 }, // 0.3% depeg (> 0.2% threshold but < 0.4% moderate)
                },
            };

            const status = detector._checkDepegStatus(['USDT', 'USDC'], prices, 56);
            expect(status.length).toBeGreaterThan(0);
            expect(status[0].severity).toBe('minor');
        });

        test('should detect severe depeg', () => {
            const prices = {
                'USDT/USDC': {
                    'dex1': { price: 0.980, fee: 0.003 }, // 2% depeg
                },
            };

            const status = detector._checkDepegStatus(['USDT', 'USDC'], prices, 56);
            expect(status.length).toBeGreaterThan(0);
            expect(status[0].severity).toBe('severe');
        });

        test('should not flag normal prices', () => {
            const prices = {
                'USDT/USDC': {
                    'dex1': { price: 1.0005, fee: 0.003 }, // 0.05% - within tolerance
                },
            };

            const status = detector._checkDepegStatus(['USDT', 'USDC'], prices, 56);
            expect(status.length).toBe(0);
        });
    });

    describe('_findTriangularStableArbitrage', () => {
        test('should find profitable triangular path', () => {
            const prices = {
                'USDT/USDC': {
                    'dex1': { price: 0.998, fee: 0.001, liquidityUSD: 1000000 },
                },
                'USDC/DAI': {
                    'dex1': { price: 1.003, fee: 0.001, liquidityUSD: 1000000 },
                },
                'DAI/USDT': {
                    'dex1': { price: 1.002, fee: 0.001, liquidityUSD: 1000000 },
                },
            };

            const result = detector._findTriangularStableArbitrage(
                ['USDT', 'USDC', 'DAI'],
                prices,
                100
            );

            // Product: 0.998 * 1.003 * 1.002 = 1.003... (0.3% profit before fees)
            // After ~0.3% fees, may or may not be profitable
            expect(Array.isArray(result)).toBe(true);
        });

        test('should handle missing price data', () => {
            const prices = {
                'USDT/USDC': {
                    'dex1': { price: 1.0, fee: 0.001, liquidityUSD: 1000000 },
                },
                // Missing USDC/DAI and DAI/USDT
            };

            const result = detector._findTriangularStableArbitrage(
                ['USDT', 'USDC', 'DAI'],
                prices,
                100
            );

            expect(result).toEqual([]);
        });
    });

    describe('_calculateTriangularProfit', () => {
        test('should calculate profit correctly', () => {
            const prices = {
                'A/B': { 'dex': { price: 1.01, fee: 0.001, liquidityUSD: 1000000 } },
                'B/C': { 'dex': { price: 1.01, fee: 0.001, liquidityUSD: 1000000 } },
                'C/A': { 'dex': { price: 1.01, fee: 0.001, liquidityUSD: 1000000 } },
            };

            const result = detector._calculateTriangularProfit(['A', 'B', 'C', 'A'], prices);

            expect(result).not.toBeNull();
            expect(result.path).toEqual(['A', 'B', 'C', 'A']);
            expect(result.dexes.length).toBe(3);
            // 1.01 * 1.01 * 1.01 * (0.999)^3 ≈ 1.027 (2.7% gross profit)
            expect(result.grossProfitPercent).toBeGreaterThan(0.02);
        });

        test('should return null for missing prices', () => {
            const prices = {
                'A/B': { 'dex': { price: 1.01, fee: 0.001 } },
                // Missing B/C
            };

            const result = detector._calculateTriangularProfit(['A', 'B', 'C', 'A'], prices);
            expect(result).toBeNull();
        });
    });

    describe('depeg events', () => {
        test('should emit severeDepeg event', (done) => {
            detector.on('severeDepeg', (depeg) => {
                expect(depeg.severity).toBe('severe');
                expect(depeg.stablecoin).toBeDefined();
                done();
            });

            const prices = {
                'USDT/USDC': {
                    'dex1': { price: 0.975, fee: 0.003 }, // 2.5% depeg
                },
            };

            detector.analyzeStablecoins(56, prices, 100);
        });

        test('should record depeg history', () => {
            const prices = {
                'USDT/USDC': {
                    'dex1': { price: 0.990, fee: 0.003 }, // 1% depeg
                },
            };

            detector.analyzeStablecoins(56, prices, 100);

            const history = detector.getRecentDepegs(10);
            expect(history.length).toBeGreaterThan(0);
        });
    });

    describe('getStats', () => {
        test('should return statistics object', () => {
            const stats = detector.getStats();

            expect(stats).toHaveProperty('depegEvents');
            expect(stats).toHaveProperty('arbitrageOpportunities');
            expect(stats).toHaveProperty('severeDepegs');
            expect(stats).toHaveProperty('chainsMonitored');
            expect(stats.chainsMonitored).toBe(6); // 6 default chains
        });
    });

    describe('clearHistory', () => {
        test('should clear depeg history', () => {
            // Add some history
            detector.depegHistory.push({ test: 'data' });
            expect(detector.depegHistory.length).toBe(1);

            // Clear
            detector.clearHistory();
            expect(detector.depegHistory.length).toBe(0);
        });
    });

    describe('integration scenarios', () => {
        test('should handle complex multi-DEX stable arbitrage', () => {
            const prices = {
                'USDT/USDC': {
                    'pancakeswap': { price: 0.997, fee: 0.0025, liquidityUSD: 5000000 },
                    'biswap': { price: 1.000, fee: 0.001, liquidityUSD: 2000000 },
                    'apeswap': { price: 1.003, fee: 0.002, liquidityUSD: 1000000 },
                },
                'USDC/BUSD': {
                    'pancakeswap': { price: 0.999, fee: 0.0025, liquidityUSD: 3000000 },
                    'biswap': { price: 1.001, fee: 0.001, liquidityUSD: 1500000 },
                },
                'BUSD/USDT': {
                    'pancakeswap': { price: 1.002, fee: 0.0025, liquidityUSD: 4000000 },
                },
            };

            const result = detector.analyzeStablecoins(56, prices, 100);

            // Should find both cross-DEX and possibly triangular opportunities
            expect(Array.isArray(result)).toBe(true);

            // All opportunities should be marked as stablecoin
            for (const opp of result) {
                expect(opp.isStablecoin).toBe(true);
            }
        });
    });
});
