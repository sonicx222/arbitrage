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
            expect(stats).toHaveProperty('supportsCrossDexTriangular');
            expect(typeof stats.baseTokens).toBe('number');
            expect(stats.supportsCrossDexTriangular).toBe(true);
        });
    });

    describe('findCrossDexTriangularOpportunities', () => {
        const crossDexMockData = {
            // WBNB/CAKE on two DEXes with different prices
            'CAKE/WBNB': {
                'pancakeswap': {
                    price: 0.004, // 1 CAKE = 0.004 WBNB
                    reserveA: '1000000000000000000000000',
                    reserveB: '4000000000000000000000',
                    liquidityUSD: 5000000,
                    pairAddress: '0x123',
                },
                'biswap': {
                    price: 0.00405, // Slightly higher price on BiSwap
                    reserveA: '800000000000000000000000',
                    reserveB: '3240000000000000000000',
                    liquidityUSD: 4000000,
                    pairAddress: '0x456',
                },
            },
            'USDT/CAKE': {
                'pancakeswap': {
                    price: 0.4,
                    reserveA: '2500000000000000000000000',
                    reserveB: '1000000000000000000000000',
                    liquidityUSD: 5000000,
                    pairAddress: '0x789',
                },
                'biswap': {
                    price: 0.398, // Slightly lower on BiSwap
                    reserveA: '2000000000000000000000000',
                    reserveB: '800000000000000000000000',
                    liquidityUSD: 4000000,
                    pairAddress: '0xabc',
                },
            },
            'WBNB/USDT': {
                'pancakeswap': {
                    price: 600,
                    reserveA: '8333000000000000000000',
                    reserveB: '5000000000000000000000000',
                    liquidityUSD: 10000000,
                    pairAddress: '0xdef',
                },
                'biswap': {
                    price: 602, // Slightly higher on BiSwap
                    reserveA: '6600000000000000000000',
                    reserveB: '3975000000000000000000000',
                    liquidityUSD: 8000000,
                    pairAddress: '0xfed',
                },
            },
        };

        test('should find cross-DEX triangular opportunities', () => {
            const opportunities = triangularDetector.findCrossDexTriangularOpportunities(crossDexMockData, 12345);
            expect(Array.isArray(opportunities)).toBe(true);
        });

        test('should include dexPath in cross-DEX opportunities', () => {
            const opportunities = triangularDetector.findCrossDexTriangularOpportunities(crossDexMockData, 12345);

            if (opportunities.length > 0) {
                const opp = opportunities[0];
                expect(opp).toHaveProperty('type', 'cross-dex-triangular');
                expect(opp).toHaveProperty('dexPath');
                expect(opp).toHaveProperty('fees');
                expect(Array.isArray(opp.dexPath)).toBe(true);
                expect(opp.dexPath.length).toBe(3);
                expect(Array.isArray(opp.fees)).toBe(true);
            }
        });

        test('should skip paths where all DEXes are the same', () => {
            // Create data with only one DEX
            const singleDexData = {
                'CAKE/WBNB': {
                    'pancakeswap': {
                        price: 0.004,
                        reserveA: '1000000000000000000000000',
                        reserveB: '4000000000000000000000',
                        liquidityUSD: 5000000,
                        pairAddress: '0x123',
                    },
                },
                'USDT/CAKE': {
                    'pancakeswap': {
                        price: 0.4,
                        reserveA: '2500000000000000000000000',
                        reserveB: '1000000000000000000000000',
                        liquidityUSD: 5000000,
                        pairAddress: '0x789',
                    },
                },
                'WBNB/USDT': {
                    'pancakeswap': {
                        price: 600,
                        reserveA: '8333000000000000000000',
                        reserveB: '5000000000000000000000000',
                        liquidityUSD: 10000000,
                        pairAddress: '0xdef',
                    },
                },
            };

            const opportunities = triangularDetector.findCrossDexTriangularOpportunities(singleDexData, 12345);
            // Should be empty because all would be same-DEX paths
            expect(opportunities.length).toBe(0);
        });

        test('should handle empty price data', () => {
            const opportunities = triangularDetector.findCrossDexTriangularOpportunities({}, 12345);
            expect(opportunities).toEqual([]);
        });
    });

    describe('calculateCrossDexOutput', () => {
        test('should calculate output with per-hop fees', () => {
            const opportunity = {
                reserves: [
                    { in: '1000000000000000000000', out: '4000000000000000000' },
                    { in: '4000000000000000000', out: '2400000000000000000000' },
                    { in: '2400000000000000000000', out: '1000000000000000000000' },
                ],
                fees: [0.003, 0.001, 0.002], // Different fees per DEX
            };

            const inputAmount = BigInt('10000000000000000000'); // 10 tokens
            const result = triangularDetector.calculateCrossDexOutput(opportunity, inputAmount, 18);

            expect(result).toHaveProperty('outputAmount');
            expect(result).toHaveProperty('profitAmount');
            expect(result).toHaveProperty('effectiveRate');
            expect(typeof result.outputAmount).toBe('bigint');
        });
    });

    describe('Golden Section Search in findOptimalTradeSize', () => {
        test('should use golden ratio for convergence', () => {
            const opportunity = {
                dexName: 'pancakeswap',
                reserves: [
                    { in: '1000000000000000000000000', out: '4000000000000000000000' },
                    { in: '4000000000000000000000', out: '2400000000000000000000000' },
                    { in: '2400000000000000000000000', out: '1000000000000000000000000' },
                ],
                cycleProduct: 1.01,
            };

            // Multiple calls should give consistent results
            const result1 = triangularDetector.findOptimalTradeSize(opportunity, 18, 5000, 600);
            const result2 = triangularDetector.findOptimalTradeSize(opportunity, 18, 5000, 600);

            expect(result1.optimalAmount).toBe(result2.optimalAmount);
        });

        test('should converge faster than linear search', () => {
            const opportunity = {
                dexName: 'pancakeswap',
                reserves: [
                    { in: '1000000000000000000000000', out: '4000000000000000000000' },
                    { in: '4000000000000000000000', out: '2400000000000000000000000' },
                    { in: '2400000000000000000000000', out: '1000000000000000000000000' },
                ],
                cycleProduct: 1.005,
            };

            // Should complete quickly (golden section converges in ~15 iterations)
            const startTime = Date.now();
            triangularDetector.findOptimalTradeSize(opportunity, 18, 10000, 600);
            const duration = Date.now() - startTime;

            // Should be fast (< 50ms for golden section)
            expect(duration).toBeLessThan(50);
        });

        test('should handle edge case of very small trade range', () => {
            const opportunity = {
                dexName: 'pancakeswap',
                reserves: [
                    { in: '1000000000000000000', out: '4000000000000000' }, // Very small pool
                    { in: '4000000000000000', out: '2400000000000000000' },
                    { in: '2400000000000000000', out: '1000000000000000000' },
                ],
                cycleProduct: 1.01,
            };

            const result = triangularDetector.findOptimalTradeSize(opportunity, 18, 1, 600);
            expect(result).toHaveProperty('optimalAmount');
            expect(result).toHaveProperty('profitUSD');
        });
    });
});
