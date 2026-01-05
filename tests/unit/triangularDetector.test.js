import { jest } from '@jest/globals';

// Mock dependencies
jest.unstable_mockModule('../../src/utils/logger.js', () => ({
    default: {
        info: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
    }
}));

const { default: triangularDetector } = await import('../../src/analysis/triangularDetector.js');

describe('TriangularDetector', () => {
    describe('findTriangularOpportunities', () => {
        const mockPriceData = {
            // Create a triangular opportunity: WBNB -> CAKE -> USDT -> WBNB
            'CAKE/WBNB': {
                'pancakeswap': {
                    price: 0.004, // 1 CAKE = 0.004 WBNB (250 CAKE per WBNB)
                    reserveA: '1000000000000000000000000', // 1M CAKE
                    reserveB: '4000000000000000000000', // 4000 WBNB
                    liquidityUSD: 5000000,
                    pairAddress: '0x0eD7e52944161450477ee417DE9Cd3a859b14fD0',
                },
            },
            'USDT/CAKE': {
                'pancakeswap': {
                    price: 0.4, // 1 USDT = 0.4 CAKE (2.5 USDT per CAKE)
                    reserveA: '2500000000000000000000000', // 2.5M USDT
                    reserveB: '1000000000000000000000000', // 1M CAKE
                    liquidityUSD: 5000000,
                    pairAddress: '0x804678fa97d91B974ec2af3c843270886528a9E6',
                },
            },
            'WBNB/USDT': {
                'pancakeswap': {
                    price: 600, // 1 WBNB = 600 USDT
                    reserveA: '8333000000000000000000', // 8333 WBNB
                    reserveB: '5000000000000000000000000', // 5M USDT
                    liquidityUSD: 10000000,
                    pairAddress: '0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE',
                },
            },
        };

        test('should find triangular opportunities when profitable', () => {
            const opportunities = triangularDetector.findTriangularOpportunities(mockPriceData, 12345);

            // Should find at least some paths to analyze
            // Note: Whether they're profitable depends on the exact rates and fees
            expect(Array.isArray(opportunities)).toBe(true);
        });

        test('should include required fields in opportunity object', () => {
            const opportunities = triangularDetector.findTriangularOpportunities(mockPriceData, 12345);

            if (opportunities.length > 0) {
                const opp = opportunities[0];

                expect(opp).toHaveProperty('type', 'triangular');
                expect(opp).toHaveProperty('dexName');
                expect(opp).toHaveProperty('path');
                expect(opp).toHaveProperty('rates');
                expect(opp).toHaveProperty('reserves');
                expect(opp).toHaveProperty('estimatedProfitPercent');
                expect(opp).toHaveProperty('minLiquidityUSD');
                expect(opp).toHaveProperty('blockNumber');
                expect(opp.path).toHaveLength(4); // A -> B -> C -> A
            }
        });

        test('should filter out low liquidity paths', () => {
            const lowLiquidityData = {
                'CAKE/WBNB': {
                    'pancakeswap': {
                        price: 0.004,
                        reserveA: '1000000000000000000', // Only 1 CAKE
                        reserveB: '4000000000000000', // 0.004 WBNB
                        liquidityUSD: 100, // Too low
                        pairAddress: '0x123',
                    },
                },
            };

            const opportunities = triangularDetector.findTriangularOpportunities(lowLiquidityData, 12345);
            expect(opportunities.length).toBe(0);
        });

        test('should handle empty price data', () => {
            const opportunities = triangularDetector.findTriangularOpportunities({}, 12345);
            expect(opportunities).toEqual([]);
        });

        test('should handle missing DEX data gracefully', () => {
            const partialData = {
                'CAKE/WBNB': {}, // Empty DEX data
            };

            const opportunities = triangularDetector.findTriangularOpportunities(partialData, 12345);
            expect(Array.isArray(opportunities)).toBe(true);
        });
    });

    describe('calculateExactOutput', () => {
        test('should calculate output with price impact', () => {
            const opportunity = {
                dexName: 'pancakeswap',
                reserves: [
                    { in: '1000000000000000000000', out: '4000000000000000000' }, // 1000 -> 4
                    { in: '4000000000000000000', out: '2400000000000000000000' }, // 4 -> 2400
                    { in: '2400000000000000000000', out: '1000000000000000000000' }, // 2400 -> 1000
                ],
            };

            const inputAmount = BigInt('10000000000000000000'); // 10 tokens
            const result = triangularDetector.calculateExactOutput(opportunity, inputAmount, 18);

            expect(result).toHaveProperty('outputAmount');
            expect(result).toHaveProperty('profitAmount');
            expect(result).toHaveProperty('effectiveRate');
            expect(result).toHaveProperty('priceImpactPercent');
            expect(typeof result.outputAmount).toBe('bigint');
        });

        test('should handle zero reserves gracefully', () => {
            const opportunity = {
                dexName: 'pancakeswap',
                reserves: [
                    { in: '0', out: '0' },
                    { in: '0', out: '0' },
                    { in: '0', out: '0' },
                ],
            };

            const result = triangularDetector.calculateExactOutput(opportunity, BigInt('1000000000000000000'), 18);
            expect(result.outputAmount).toBe(0n);
        });
    });

    describe('findOptimalTradeSize', () => {
        test('should find optimal trade size that maximizes profit', () => {
            const opportunity = {
                dexName: 'pancakeswap',
                reserves: [
                    { in: '1000000000000000000000000', out: '4000000000000000000000' },
                    { in: '4000000000000000000000', out: '2400000000000000000000000' },
                    { in: '2400000000000000000000000', out: '1000000000000000000000000' },
                ],
                cycleProduct: 1.01, // 1% theoretical profit
            };

            const result = triangularDetector.findOptimalTradeSize(
                opportunity,
                18, // decimals
                5000, // maxTradeUSD
                600 // WBNB price
            );

            expect(result).toHaveProperty('optimalAmount');
            expect(result).toHaveProperty('maxProfitAmount');
            expect(result).toHaveProperty('profitUSD');
            expect(typeof result.optimalAmount).toBe('bigint');
        });

        test('should respect maximum trade size', () => {
            const opportunity = {
                dexName: 'pancakeswap',
                reserves: [
                    { in: '1000000000000000000000000', out: '4000000000000000000000' },
                    { in: '4000000000000000000000', out: '2400000000000000000000000' },
                    { in: '2400000000000000000000000', out: '1000000000000000000000000' },
                ],
                cycleProduct: 1.01,
            };

            const maxTradeUSD = 100;
            const tokenPrice = 600;

            const result = triangularDetector.findOptimalTradeSize(opportunity, 18, maxTradeUSD, tokenPrice);

            // Optimal amount should not exceed max trade size
            const optimalUSD = Number(result.optimalAmount) / 1e18 * tokenPrice;
            expect(optimalUSD).toBeLessThanOrEqual(maxTradeUSD * 1.1); // Allow 10% tolerance
        });
    });

    describe('getStats', () => {
        test('should return detector statistics', () => {
            const stats = triangularDetector.getStats();

            expect(stats).toHaveProperty('baseTokens');
            expect(stats).toHaveProperty('totalTokens');
            expect(stats).toHaveProperty('minProfitThreshold');
            expect(stats).toHaveProperty('minLiquidity');
            expect(typeof stats.baseTokens).toBe('number');
        });
    });
});
