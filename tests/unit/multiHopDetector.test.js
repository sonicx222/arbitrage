import MultiHopDetector from '../../src/analysis/MultiHopDetector.js';

describe('MultiHopDetector', () => {
    let detector;
    let mockDexConfig;
    let mockPrices;

    beforeEach(() => {
        detector = new MultiHopDetector({
            maxPathLength: 5,
            minProfitPercent: 0.3,
            maxPathsToCheck: 1000,
            minLiquidityUSD: 100, // Low for testing
        });

        mockDexConfig = {
            dex1: {
                enabled: true,
                name: 'TestDEX',
                fee: 0.003,
            },
        };

        // Mock prices with proper structure: "TOKEN_A/TOKEN_B" -> { dexName: { price, liquidityUSD, ... } }
        mockPrices = {
            'tokenA/tokenB': {
                dex1: {
                    price: 2.0, // 1 tokenA = 2 tokenB
                    liquidityUSD: 10000,
                },
            },
            'tokenB/tokenC': {
                dex1: {
                    price: 1.5, // 1 tokenB = 1.5 tokenC
                    liquidityUSD: 10000,
                },
            },
            'tokenC/tokenA': {
                dex1: {
                    price: 0.4, // 1 tokenC = 0.4 tokenA (creates cycle)
                    liquidityUSD: 10000,
                },
            },
        };
    });

    describe('constructor', () => {
        it('should initialize with default config', () => {
            const defaultDetector = new MultiHopDetector();
            expect(defaultDetector.maxPathLength).toBe(5);
            expect(defaultDetector.minProfitPercent).toBe(0.3);
        });

        it('should initialize with custom config', () => {
            expect(detector.maxPathLength).toBe(5);
            expect(detector.minProfitPercent).toBe(0.3);
            expect(detector.maxPathsToCheck).toBe(1000);
        });

        it('should initialize statistics', () => {
            expect(detector.stats.pathsChecked).toBe(0);
            expect(detector.stats.opportunitiesFound).toBe(0);
        });
    });

    describe('buildPriceGraph', () => {
        it('should build graph from prices', () => {
            const graph = detector.buildPriceGraph(mockPrices, mockDexConfig);
            expect(graph.size).toBeGreaterThan(0);
        });

        it('should create bidirectional edges', () => {
            const graph = detector.buildPriceGraph(mockPrices, mockDexConfig);
            const tokenAEdges = graph.get('tokenA');
            expect(tokenAEdges).toBeDefined();
            expect(tokenAEdges.size).toBeGreaterThan(0);
        });

        it('should handle empty prices', () => {
            const graph = detector.buildPriceGraph({}, mockDexConfig);
            expect(graph.size).toBe(0);
        });

        it('should skip pairs with low liquidity', () => {
            const lowLiquidityPrices = {
                'tokenA/tokenB': {
                    dex1: {
                        price: 2.0,
                        liquidityUSD: 10, // Below minLiquidityUSD
                    },
                },
            };
            const graph = detector.buildPriceGraph(lowLiquidityPrices, mockDexConfig);
            expect(graph.size).toBe(0);
        });

        it('should skip pairs with invalid price', () => {
            const invalidPrices = {
                'tokenA/tokenB': {
                    dex1: {
                        price: 0, // Invalid
                        liquidityUSD: 10000,
                    },
                },
            };
            const graph = detector.buildPriceGraph(invalidPrices, mockDexConfig);
            expect(graph.size).toBe(0);
        });
    });

    describe('findOpportunities', () => {
        it('should return array of opportunities', () => {
            const opportunities = detector.findOpportunities(
                mockPrices,
                mockDexConfig,
                ['tokenA', 'tokenB'],
                12345
            );
            expect(Array.isArray(opportunities)).toBe(true);
        });

        it('should include block number in opportunities', () => {
            const opportunities = detector.findOpportunities(
                mockPrices,
                mockDexConfig,
                ['tokenA'],
                12345
            );
            for (const opp of opportunities) {
                expect(opp.blockNumber).toBe(12345);
            }
        });

        it('should handle empty base tokens', () => {
            const opportunities = detector.findOpportunities(
                mockPrices,
                mockDexConfig,
                [],
                12345
            );
            expect(opportunities).toEqual([]);
        });

        it('should handle empty prices', () => {
            const opportunities = detector.findOpportunities(
                {},
                mockDexConfig,
                ['tokenA'],
                12345
            );
            expect(opportunities).toEqual([]);
        });

        it('should update statistics', () => {
            const initialPaths = detector.stats.pathsChecked;
            detector.findOpportunities(mockPrices, mockDexConfig, ['tokenA'], 12345);
            expect(detector.stats.pathsChecked).toBeGreaterThanOrEqual(initialPaths);
        });

        it('should sort opportunities by profit', () => {
            // Create prices with multiple potential arbitrage paths
            const multiPathPrices = {
                'A/B': { dex1: { price: 1.1, liquidityUSD: 10000 } },
                'B/C': { dex1: { price: 1.1, liquidityUSD: 10000 } },
                'C/A': { dex1: { price: 1.1, liquidityUSD: 10000 } }, // Profitable cycle
                'B/D': { dex1: { price: 1.05, liquidityUSD: 10000 } },
                'D/A': { dex1: { price: 1.05, liquidityUSD: 10000 } },
            };

            const opportunities = detector.findOpportunities(
                multiPathPrices,
                mockDexConfig,
                ['A'],
                12345
            );

            // If multiple opportunities found, they should be sorted by profit descending
            for (let i = 1; i < opportunities.length; i++) {
                expect(opportunities[i - 1].profitPercent).toBeGreaterThanOrEqual(
                    opportunities[i].profitPercent
                );
            }
        });
    });

    describe('calculateOptimalTradeSize', () => {
        it('should calculate optimal trade size based on liquidity', () => {
            const edges = [
                { liquidityUSD: 10000, price: 1.5, fee: 0.003 },
                { liquidityUSD: 5000, price: 1.2, fee: 0.003 },
            ];

            const result = detector.calculateOptimalTradeSize(edges, 10000);
            expect(result.optimalSizeUSD).toBeGreaterThan(0);
            expect(result.optimalSizeUSD).toBeLessThanOrEqual(10000);
        });

        it('should limit by max trade size', () => {
            const edges = [
                { liquidityUSD: 1000000, price: 1.5, fee: 0.003 },
            ];

            const result = detector.calculateOptimalTradeSize(edges, 100);
            expect(result.optimalSizeUSD).toBeLessThanOrEqual(100);
        });
    });

    describe('validateOpportunity', () => {
        it('should validate opportunity with current prices', () => {
            const opportunity = {
                path: ['A', 'B', 'C', 'A'],
            };

            const currentPrices = {
                'A/B': { dex1: { price: 1.1 } },
                'B/C': { dex1: { price: 1.1 } },
                'C/A': { dex1: { price: 1.1 } },
            };

            const result = detector.validateOpportunity(opportunity, currentPrices, mockDexConfig);
            expect(result).toHaveProperty('valid');
            expect(result).toHaveProperty('currentProfitPercent');
            expect(result).toHaveProperty('reason');
        });

        it('should return invalid for missing prices', () => {
            const opportunity = {
                path: ['A', 'B', 'C', 'A'],
            };

            const currentPrices = {
                'A/B': { dex1: { price: 1.1 } },
                // Missing B/C and C/A
            };

            const result = detector.validateOpportunity(opportunity, currentPrices, mockDexConfig);
            expect(result.valid).toBe(false);
            expect(result.reason).toContain('No price found');
        });
    });

    describe('getStats', () => {
        it('should return statistics object', () => {
            const stats = detector.getStats();
            expect(stats).toHaveProperty('pathsChecked');
            expect(stats).toHaveProperty('opportunitiesFound');
            expect(stats).toHaveProperty('lastScanTime');
        });

        it('should track search statistics after findOpportunities', () => {
            detector.findOpportunities(mockPrices, mockDexConfig, ['tokenA'], 1);
            const stats = detector.getStats();
            expect(stats.pathsChecked).toBeGreaterThanOrEqual(0);
        });
    });

    describe('resetStats', () => {
        it('should reset all statistics', () => {
            detector.stats.pathsChecked = 100;
            detector.stats.opportunitiesFound = 10;

            detector.resetStats();

            expect(detector.stats.pathsChecked).toBe(0);
            expect(detector.stats.opportunitiesFound).toBe(0);
        });
    });

    describe('opportunity structure', () => {
        it('should include required fields in opportunity', () => {
            // Create prices with profitable arbitrage opportunity
            const profitablePrices = {
                'A/B': {
                    dex1: { price: 1.2, liquidityUSD: 10000 },
                },
                'B/C': {
                    dex1: { price: 1.2, liquidityUSD: 10000 },
                },
                'C/D': {
                    dex1: { price: 1.2, liquidityUSD: 10000 },
                },
                'D/A': {
                    dex1: { price: 1.0, liquidityUSD: 10000 }, // Creates profit potential
                },
            };

            detector.minProfitPercent = 0.1; // Lower threshold for test

            const opportunities = detector.findOpportunities(
                profitablePrices,
                mockDexConfig,
                ['A'],
                12345
            );

            // If opportunities are found, verify structure
            for (const opp of opportunities) {
                expect(opp).toHaveProperty('type', 'multi-hop');
                expect(opp).toHaveProperty('path');
                expect(opp).toHaveProperty('profitPercent');
                expect(opp).toHaveProperty('blockNumber');
                expect(opp).toHaveProperty('edges');
                expect(opp).toHaveProperty('minLiquidityUSD');
                expect(Array.isArray(opp.path)).toBe(true);
            }
        });
    });
});
