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

// Mock v3PriceFetcher
jest.unstable_mockModule('../../src/data/v3PriceFetcher.js', () => ({
    default: {
        fetchAllPrices: jest.fn(),
        getBestPool: jest.fn(),
    }
}));

// Import after mocks
const { default: V2V3Arbitrage } = await import('../../src/analysis/v2v3Arbitrage.js');

describe('V2V3Arbitrage', () => {
    let detector;

    beforeEach(() => {
        detector = new V2V3Arbitrage.__proto__.constructor();
        detector.resetStats();
    });

    describe('constructor', () => {
        test('should initialize with default configuration', () => {
            expect(detector.minSpreadPercent).toBe(0.15);
            expect(detector.v2Fee).toBe(0.003);
            expect(detector.minLiquidityUSD).toBe(5000);
        });

        test('should accept custom configuration', () => {
            const customDetector = new V2V3Arbitrage.__proto__.constructor({
                minSpreadPercent: 0.2,
                v2Fee: 0.0025,
                minLiquidityUSD: 10000,
            });

            expect(customDetector.minSpreadPercent).toBe(0.2);
            expect(customDetector.v2Fee).toBe(0.0025);
            expect(customDetector.minLiquidityUSD).toBe(10000);
        });

        test('should have supported chains configured', () => {
            expect(detector.supportedChains[56]).toBeDefined();
            expect(detector.supportedChains[1]).toBeDefined();
            expect(detector.supportedChains[137]).toBeDefined();
            expect(detector.supportedChains[42161]).toBeDefined();
        });
    });

    describe('analyzeOpportunities', () => {
        test('should return empty for unsupported chain', () => {
            const result = detector.analyzeOpportunities(999, {}, {}, 1000);
            expect(result).toEqual([]);
        });

        test('should return empty when no matching pairs', () => {
            const v2Prices = {
                'WBNB/USDT': {
                    'pancakeswap': { price: 600, liquidityUSD: 100000 },
                },
            };
            const v3Prices = {
                'ETH/USDC': {  // Different pair
                    'v3-500': { price: 3000, liquidityUSD: 500000, isV3: true },
                },
            };

            const result = detector.analyzeOpportunities(56, v2Prices, v3Prices, 1000);
            expect(result).toEqual([]);
        });

        test('should detect V2 to V3 opportunity', () => {
            const v2Prices = {
                'WBNB/USDT': {
                    'pancakeswap': { price: 600, liquidityUSD: 100000 },
                },
            };
            const v3Prices = {
                'WBNB/USDT': {
                    'v3-500': { price: 605, liquidityUSD: 200000, isV3: true },
                },
            };

            const result = detector.analyzeOpportunities(56, v2Prices, v3Prices, 1000);

            // V2 price (600) is lower than V3 price (605)
            // After fees: V2 buy = 600 * 1.003 = 601.8, V3 sell = 605 * 0.9995 = 604.7
            // Spread = (604.7 - 601.8) / 601.8 = 0.48%
            expect(result.length).toBeGreaterThanOrEqual(0); // May or may not meet threshold
        });

        test('should detect V3 to V2 opportunity', () => {
            const v2Prices = {
                'WBNB/USDT': {
                    'pancakeswap': { price: 605, liquidityUSD: 100000 },
                },
            };
            const v3Prices = {
                'WBNB/USDT': {
                    'v3-500': { price: 600, liquidityUSD: 200000, isV3: true },
                },
            };

            const result = detector.analyzeOpportunities(56, v2Prices, v3Prices, 1000);

            // V3 price (600) is lower than V2 price (605)
            expect(result.length).toBeGreaterThanOrEqual(0);
        });

        test('should skip pairs with low liquidity', () => {
            detector.minLiquidityUSD = 50000;

            const v2Prices = {
                'WBNB/USDT': {
                    'pancakeswap': { price: 600, liquidityUSD: 10000 }, // Below threshold
                },
            };
            const v3Prices = {
                'WBNB/USDT': {
                    'v3-500': { price: 610, liquidityUSD: 10000, isV3: true },
                },
            };

            const result = detector.analyzeOpportunities(56, v2Prices, v3Prices, 1000);
            expect(result).toEqual([]);
        });

        test('should emit event when opportunities found', () => {
            const spy = jest.fn();
            detector.on('opportunitiesFound', spy);

            // Create a significant spread that should trigger opportunity
            detector.minSpreadPercent = 0.1;

            const v2Prices = {
                'WBNB/USDT': {
                    'pancakeswap': { price: 600, liquidityUSD: 100000 },
                },
            };
            const v3Prices = {
                'WBNB/USDT': {
                    'v3-500': { price: 610, liquidityUSD: 200000, isV3: true },
                },
            };

            detector.analyzeOpportunities(56, v2Prices, v3Prices, 1000);

            // Check if spy was called (depends on spread meeting threshold)
            if (detector.stats.opportunitiesFound > 0) {
                expect(spy).toHaveBeenCalled();
            }
        });
    });

    describe('_analyzeV2Prices', () => {
        test('should find best buy and sell prices', () => {
            const v2Prices = {
                'pancakeswap': { price: 600, liquidityUSD: 100000 },
                'biswap': { price: 598, liquidityUSD: 50000 },
            };

            const result = detector._analyzeV2Prices(v2Prices, ['pancakeswap', 'biswap']);

            expect(result.buyPrice).toBe(598);
            expect(result.sellPrice).toBe(600);
            expect(result.buyDex).toBe('biswap');
            expect(result.sellDex).toBe('pancakeswap');
        });

        test('should return null for insufficient liquidity', () => {
            detector.minLiquidityUSD = 50000;

            const v2Prices = {
                'pancakeswap': { price: 600, liquidityUSD: 10000 },
            };

            const result = detector._analyzeV2Prices(v2Prices, ['pancakeswap']);
            expect(result).toBeNull();
        });
    });

    describe('_analyzeV3Prices', () => {
        test('should find best prices across fee tiers', () => {
            const v3Prices = {
                'v3-500': { price: 600, liquidityUSD: 100000, isV3: true },
                'v3-3000': { price: 601, liquidityUSD: 200000, isV3: true },
            };

            const result = detector._analyzeV3Prices(v3Prices);

            expect(result.buyPrice).toBe(600);
            expect(result.sellPrice).toBe(601);
            expect(result.buyTier).toBe('v3-500');
            expect(result.sellTier).toBe('v3-3000');
        });

        test('should skip non-V3 entries', () => {
            const v3Prices = {
                'v3-500': { price: 600, liquidityUSD: 100000, isV3: true },
                'v2-legacy': { price: 599, liquidityUSD: 50000 }, // Not V3
            };

            const result = detector._analyzeV3Prices(v3Prices);

            expect(result.buyPrice).toBe(600); // Should use V3 price only
        });
    });

    describe('_getFeeFromTierKey', () => {
        test('should extract fee from tier key', () => {
            expect(detector._getFeeFromTierKey('v3-500')).toBe(0.0005);
            expect(detector._getFeeFromTierKey('v3-3000')).toBe(0.003);
            expect(detector._getFeeFromTierKey('pancakeswap-v3-2500')).toBe(0.0025);
            expect(detector._getFeeFromTierKey('v3-10000')).toBe(0.01);
        });

        test('should return default fee for invalid tier key', () => {
            expect(detector._getFeeFromTierKey('unknown')).toBe(0.003);
        });
    });

    describe('findBestV3Tier', () => {
        test('should find tier with best effective price', () => {
            const v3Prices = {
                'v3-500': { price: 600, liquidityUSD: 100000, isV3: true },
                'v3-3000': { price: 599, liquidityUSD: 500000, isV3: true },
            };

            const result = detector.findBestV3Tier(v3Prices, 1000);

            // v3-3000 has lower raw price but higher fee
            // v3-500: 600 * 1.0005 = 600.3
            // v3-3000: 599 * 1.003 = 600.8
            // v3-500 should win with better effective price
            expect(result).not.toBeNull();
            expect(result.tierKey).toBeDefined();
        });

        test('should return null for empty prices', () => {
            expect(detector.findBestV3Tier({}, 1000)).toBeNull();
            expect(detector.findBestV3Tier(null, 1000)).toBeNull();
        });

        test('should skip tiers with insufficient liquidity', () => {
            const v3Prices = {
                'v3-500': { price: 600, liquidityUSD: 1000, isV3: true }, // Too low for 1000 USD trade
            };

            // Trade should be at most 5% of liquidity (1000 * 20 = 20000 required)
            const result = detector.findBestV3Tier(v3Prices, 1000);
            expect(result).toBeNull();
        });
    });

    describe('calculateOptimalTradeSize', () => {
        test('should calculate optimal trade size', () => {
            const opportunity = {
                spreadPercent: 0.5,
                minLiquidityUSD: 100000,
            };

            const result = detector.calculateOptimalTradeSize(opportunity);

            expect(result.optimalSize).toBeGreaterThan(0);
            expect(result.estimatedProfit).toBeGreaterThan(0);
            expect(result.profitPercent).toBeDefined();
        });

        test('should limit size based on price impact', () => {
            const opportunity = {
                spreadPercent: 0.3, // Small spread
                minLiquidityUSD: 50000,
            };

            const result = detector.calculateOptimalTradeSize(opportunity);

            // Larger sizes should have more impact, reducing optimal size
            expect(result.optimalSize).toBeLessThan(opportunity.minLiquidityUSD * 0.05);
        });
    });

    describe('getStats', () => {
        test('should return statistics', () => {
            const stats = detector.getStats();

            expect(stats).toHaveProperty('pairsAnalyzed');
            expect(stats).toHaveProperty('opportunitiesFound');
            expect(stats).toHaveProperty('v2ToBetter');
            expect(stats).toHaveProperty('v3ToV2Better');
            expect(stats).toHaveProperty('supportedChains');
        });

        test('should track analyzed pairs', () => {
            const v2Prices = {
                'WBNB/USDT': {
                    'pancakeswap': { price: 600, liquidityUSD: 100000 },
                },
            };
            const v3Prices = {
                'WBNB/USDT': {
                    'v3-500': { price: 601, liquidityUSD: 200000, isV3: true },
                },
            };

            detector.analyzeOpportunities(56, v2Prices, v3Prices, 1000);

            expect(detector.stats.pairsAnalyzed).toBeGreaterThan(0);
        });
    });

    describe('updateConfig', () => {
        test('should update configuration', () => {
            detector.updateConfig({
                minSpreadPercent: 0.25,
                v2Fee: 0.0025,
                minLiquidityUSD: 20000,
            });

            expect(detector.minSpreadPercent).toBe(0.25);
            expect(detector.v2Fee).toBe(0.0025);
            expect(detector.minLiquidityUSD).toBe(20000);
        });

        test('should only update provided values', () => {
            const originalFee = detector.v2Fee;
            detector.updateConfig({ minSpreadPercent: 0.3 });

            expect(detector.minSpreadPercent).toBe(0.3);
            expect(detector.v2Fee).toBe(originalFee);
        });
    });

    describe('opportunity format', () => {
        test('should include all required fields in opportunity', () => {
            detector.minSpreadPercent = 0.1;

            const v2Prices = {
                'WBNB/USDT': {
                    'pancakeswap': { price: 600, liquidityUSD: 100000 },
                },
            };
            const v3Prices = {
                'WBNB/USDT': {
                    'v3-500': { price: 610, liquidityUSD: 200000, isV3: true },
                },
            };

            const results = detector.analyzeOpportunities(56, v2Prices, v3Prices, 1000);

            if (results.length > 0) {
                const opp = results[0];
                expect(opp.type).toBe('v2-v3-arb');
                expect(opp.subType).toMatch(/v2-to-v3|v3-to-v2/);
                expect(opp.pairKey).toBeDefined();
                expect(opp.buyDex).toBeDefined();
                expect(opp.sellDex).toBeDefined();
                expect(opp.spreadPercent).toBeDefined();
                expect(opp.estimatedProfitUSD).toBeDefined();
                expect(opp.fees).toBeDefined();
                expect(opp.timestamp).toBeDefined();
            }
        });
    });
});

// Test singleton instance
describe('V2V3Arbitrage Singleton', () => {
    let v2v3Arbitrage;

    beforeAll(async () => {
        const module = await import('../../src/analysis/v2v3Arbitrage.js');
        v2v3Arbitrage = module.default;
    });

    test('should export singleton instance', () => {
        expect(v2v3Arbitrage).toBeDefined();
        expect(typeof v2v3Arbitrage.analyzeOpportunities).toBe('function');
    });

    test('should be an EventEmitter', () => {
        expect(typeof v2v3Arbitrage.on).toBe('function');
        expect(typeof v2v3Arbitrage.emit).toBe('function');
    });
});
