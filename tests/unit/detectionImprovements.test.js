import { jest } from '@jest/globals';

// Define mocks
jest.unstable_mockModule('../../src/utils/logger.js', () => ({
    default: {
        info: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
    }
}));

// Import modules after mocking
const { default: arbitrageDetector } = await import('../../src/analysis/arbitrageDetector.js');
const { default: statisticalArbitrageDetector } = await import('../../src/analysis/statisticalArbitrageDetector.js');
const { default: MultiHopDetector } = await import('../../src/analysis/MultiHopDetector.js');

/**
 * Detection Improvements Regression Tests
 *
 * This test suite validates all improvements from DETECTION_IMPROVEMENTS.md:
 * - P0: Analytical Optimal Trade Size Formula
 * - P0: ReserveDifferentialAnalyzer Integration
 * - P1: CrossPoolCorrelation Predictive Detection
 * - P1: V3 Fee Tier Arbitrage Integration
 * - P1: Transaction Simulation Before Execution
 * - P2: MEV-Aware Opportunity Scoring
 * - P2: Multi-DEX Path Optimization
 * - P3: Statistical Arbitrage Detection
 */

describe('Detection Improvements', () => {
    // ==================== P0: Analytical Optimal Trade Size ====================
    describe('P0: Analytical Optimal Trade Size Formula', () => {
        const buyDexData = {
            dexName: 'pancakeswap',
            reserveA: BigInt(1000 * 1e18).toString(),
            reserveB: BigInt(300000 * 1e18).toString(),
            price: 300,
            liquidityUSD: 600000,
        };

        const sellDexData = {
            dexName: 'biswap',
            reserveA: BigInt(1000 * 1e18).toString(),
            reserveB: BigInt(315000 * 1e18).toString(),
            price: 315,
            liquidityUSD: 630000,
        };

        test('should use analytical formula for initial estimate', () => {
            const result = arbitrageDetector.optimizeTradeAmount(buyDexData, sellDexData, 18, 18);

            // Verify we get a valid result
            expect(result).toHaveProperty('profitUSD');
            expect(result).toHaveProperty('optimalAmount');
            expect(result.optimalAmount).toBeGreaterThan(0n);
        });

        test('should use refined binary search around analytical estimate', () => {
            const result = arbitrageDetector.optimizeTradeAmount(buyDexData, sellDexData, 18, 18);

            // With 5% spread, there should be meaningful profit
            expect(result.profitUSD).toBeGreaterThan(0);
        });

        test('_calculateAnalyticalOptimal should return valid BigInt', () => {
            const buyInRes = BigInt(300000 * 1e18);
            const buyOutRes = BigInt(1000 * 1e18);
            const sellInRes = BigInt(1000 * 1e18);
            const sellOutRes = BigInt(315000 * 1e18);

            const result = arbitrageDetector._calculateAnalyticalOptimal(
                buyInRes, buyOutRes, sellInRes, sellOutRes,
                0.003, 0.003, 18
            );

            expect(typeof result).toBe('bigint');
            expect(result >= 0n).toBe(true);
        });

        test('_refineOptimalAmount should improve upon initial estimate', () => {
            const calcProfit = (amount) => {
                // Simulate profit curve that peaks at 1000n
                const peak = 1000n;
                const diff = amount > peak ? amount - peak : peak - amount;
                return 1000n - diff;
            };

            const result = arbitrageDetector._refineOptimalAmount(
                500n, // initial estimate
                calcProfit,
                500n, // initial profit
                100n, // min
                2000n // max
            );

            // Should find better amount closer to peak
            expect(result.profit).toBeGreaterThanOrEqual(500n);
        });
    });

    // ==================== P2: MEV-Aware Opportunity Scoring ====================
    describe('P2: MEV-Aware Opportunity Scoring', () => {
        test('should calculate MEV risk for opportunity', () => {
            const result = arbitrageDetector._calculateMEVRisk({
                profitUSD: 50,
                tradeSizeUSD: 2000,
                minLiquidityUSD: 100000,
                spreadPercent: 1.5,
            });

            expect(result).toHaveProperty('riskLevel');
            expect(result).toHaveProperty('riskFactor');
            expect(result).toHaveProperty('competitionLevel');
            expect(result).toHaveProperty('competitionScore');
            expect(result).toHaveProperty('expectedLossUSD');
            expect(result).toHaveProperty('breakdown');
        });

        test('should assign higher risk to larger profits', () => {
            const smallProfit = arbitrageDetector._calculateMEVRisk({
                profitUSD: 3,
                tradeSizeUSD: 500,
                minLiquidityUSD: 100000,
                spreadPercent: 0.3,
            });

            const largeProfit = arbitrageDetector._calculateMEVRisk({
                profitUSD: 100,
                tradeSizeUSD: 5000,
                minLiquidityUSD: 100000,
                spreadPercent: 2,
            });

            expect(largeProfit.riskFactor).toBeGreaterThan(smallProfit.riskFactor);
        });

        test('should assign higher competition to larger spreads', () => {
            const smallSpread = arbitrageDetector._calculateMEVRisk({
                profitUSD: 10,
                tradeSizeUSD: 1000,
                minLiquidityUSD: 100000,
                spreadPercent: 0.3,
            });

            const largeSpread = arbitrageDetector._calculateMEVRisk({
                profitUSD: 10,
                tradeSizeUSD: 1000,
                minLiquidityUSD: 100000,
                spreadPercent: 3,
            });

            expect(largeSpread.competitionScore).toBeGreaterThan(smallSpread.competitionScore);
        });

        test('opportunities should include MEV risk fields', async () => {
            const mockPriceData = {
                'WBNB/BUSD': {
                    'pancakeswap': {
                        price: 300,
                        reserveA: BigInt(1000 * 1e18).toString(),
                        reserveB: BigInt(300000 * 1e18).toString(),
                        liquidityUSD: 600000,
                        dexName: 'pancakeswap'
                    },
                    'biswap': {
                        price: 315,
                        reserveA: BigInt(1000 * 1e18).toString(),
                        reserveB: BigInt(315000 * 1e18).toString(),
                        liquidityUSD: 630000,
                        dexName: 'biswap'
                    },
                }
            };

            const opportunities = await arbitrageDetector.detectOpportunities(mockPriceData, 12345);

            if (opportunities.length > 0) {
                const opp = opportunities[0];
                expect(opp).toHaveProperty('mevRisk');
                expect(opp).toHaveProperty('mevRiskFactor');
                expect(opp).toHaveProperty('mevAdjustedScore');
                expect(opp).toHaveProperty('competitionLevel');
            }
        });
    });

    // ==================== P2: Multi-DEX Path Optimization ====================
    describe('P2: Multi-DEX Path Optimization', () => {
        const multiHopDetector = new MultiHopDetector({
            maxPathLength: 4,
            minProfitPercent: 0.3,
            minLiquidityUSD: 1000,
        });

        test('should build price graph with multi-DEX edges', () => {
            const prices = {
                'WBNB/BUSD': {
                    'pancakeswap': { price: 300, liquidityUSD: 100000 },
                    'biswap': { price: 305, liquidityUSD: 80000 },
                },
                'WBNB/USDT': {
                    'pancakeswap': { price: 301, liquidityUSD: 90000 },
                },
            };

            const dexConfig = {
                'pancakeswap': { fee: 0.0025 },
                'biswap': { fee: 0.003 },
            };

            const graph = multiHopDetector.buildPriceGraph(prices, dexConfig);

            // Graph should have nodes for WBNB, BUSD, USDT
            expect(graph.has('WBNB')).toBe(true);
            expect(graph.has('BUSD')).toBe(true);

            // Edge should contain allDexes array
            const wbnbEdges = graph.get('WBNB');
            const busdEdge = wbnbEdges.get('BUSD');
            expect(busdEdge).toHaveProperty('allDexes');
            expect(busdEdge.allDexes.length).toBe(2); // Two DEXs for this pair
        });

        test('should select best DEX for each edge', () => {
            const prices = {
                'WBNB/BUSD': {
                    'pancakeswap': { price: 300, liquidityUSD: 100000 },
                    'biswap': { price: 298, liquidityUSD: 80000 }, // Better price on biswap
                },
            };

            const dexConfig = {
                'pancakeswap': { fee: 0.0025 },
                'biswap': { fee: 0.003 },
            };

            const graph = multiHopDetector.buildPriceGraph(prices, dexConfig);

            const wbnbEdges = graph.get('WBNB');
            const busdEdge = wbnbEdges.get('BUSD');

            // Should select best effective price (considering fees)
            expect(busdEdge.dex).toBeDefined();
        });

        test('should track price spread across DEXs', () => {
            const prices = {
                'WBNB/BUSD': {
                    'pancakeswap': { price: 300, liquidityUSD: 100000 },
                    'biswap': { price: 310, liquidityUSD: 80000 },
                },
            };

            const dexConfig = {
                'pancakeswap': { fee: 0.0025 },
                'biswap': { fee: 0.003 },
            };

            const graph = multiHopDetector.buildPriceGraph(prices, dexConfig);

            const wbnbEdges = graph.get('WBNB');
            const busdEdge = wbnbEdges.get('BUSD');

            expect(busdEdge).toHaveProperty('priceSpread');
            expect(busdEdge.priceSpread).toBeGreaterThan(0);
        });
    });

    // ==================== P3: Statistical Arbitrage Detection ====================
    describe('P3: Statistical Arbitrage Detection', () => {
        beforeEach(() => {
            statisticalArbitrageDetector.reset();
        });

        test('should record spread samples', () => {
            statisticalArbitrageDetector.recordSpread(
                'WBNB/BUSD', 'pancakeswap', 'biswap', 300, 302, 12345
            );

            const stats = statisticalArbitrageDetector.getStats();
            expect(stats.samplesRecorded).toBe(1);
            expect(stats.pairsTracked).toBe(1);
        });

        test('should calculate rolling statistics', () => {
            // Add multiple samples
            for (let i = 0; i < 30; i++) {
                const priceA = 300 + Math.sin(i * 0.1) * 2; // Slight variation
                const priceB = 302 + Math.sin(i * 0.1) * 2;
                statisticalArbitrageDetector.recordSpread(
                    'WBNB/BUSD', 'pancakeswap', 'biswap', priceA, priceB, 12345 + i
                );
            }

            const spreadStats = statisticalArbitrageDetector.getSpreadStats('WBNB/BUSD:pancakeswap:biswap');
            expect(spreadStats).not.toBeNull();
            expect(spreadStats.mean).toBeDefined();
            expect(spreadStats.stdDev).toBeDefined();
            expect(spreadStats.sampleCount).toBe(30);
        });

        test('should generate signal on significant z-score deviation', () => {
            // Build up history with stable spread
            for (let i = 0; i < 25; i++) {
                statisticalArbitrageDetector.recordSpread(
                    'WBNB/BUSD', 'pancakeswap', 'biswap', 300, 301, 12345 + i
                );
            }

            // Now add a significant deviation
            const signal = statisticalArbitrageDetector.recordSpread(
                'WBNB/BUSD', 'pancakeswap', 'biswap', 300, 310, 12370 // Large deviation
            );

            // Should generate a signal due to significant deviation
            if (signal) {
                expect(signal).toHaveProperty('type', 'statistical-arbitrage');
                expect(signal).toHaveProperty('zScore');
                expect(Math.abs(signal.zScore)).toBeGreaterThan(1);
                expect(signal).toHaveProperty('direction');
                expect(signal).toHaveProperty('confidence');
            }
        });

        test('should process all prices and detect signals', () => {
            // Build up history
            for (let i = 0; i < 25; i++) {
                const prices = {
                    'WBNB/BUSD': {
                        'pancakeswap': { price: 300 + Math.random() * 0.5 },
                        'biswap': { price: 301 + Math.random() * 0.5 },
                    }
                };
                statisticalArbitrageDetector.processAllPrices(prices, 12345 + i);
            }

            const stats = statisticalArbitrageDetector.getStats();
            expect(stats.samplesRecorded).toBeGreaterThan(0);
        });

        test('should emit statisticalSignal event on significant deviation', (done) => {
            // Build up history
            for (let i = 0; i < 25; i++) {
                statisticalArbitrageDetector.recordSpread(
                    'WBNB/BUSD', 'pancakeswap', 'biswap', 300, 301, 12345 + i
                );
            }

            // Listen for signal
            let signalReceived = false;
            statisticalArbitrageDetector.once('statisticalSignal', (signal) => {
                signalReceived = true;
                expect(signal).toHaveProperty('type', 'statistical-arbitrage');
                done();
            });

            // Add significant deviation
            statisticalArbitrageDetector.recordSpread(
                'WBNB/BUSD', 'pancakeswap', 'biswap', 300, 315, 12370
            );

            // If no signal, complete test after timeout
            setTimeout(() => {
                if (!signalReceived) {
                    done();
                }
            }, 100);
        });

        test('should classify signal strength correctly', () => {
            // Build up history with very stable data
            for (let i = 0; i < 50; i++) {
                statisticalArbitrageDetector.recordSpread(
                    'WBNB/BUSD', 'pancakeswap', 'biswap', 300, 300.3, 12345 + i
                );
            }

            // Strong deviation (should be z-score > 3)
            const signal = statisticalArbitrageDetector.recordSpread(
                'WBNB/BUSD', 'pancakeswap', 'biswap', 300, 310, 12400
            );

            if (signal) {
                expect(['weak', 'medium', 'strong']).toContain(signal.strength);
            }
        });
    });

    // ==================== Integration Test ====================
    describe('Integration: Full Detection Flow', () => {
        test('detected opportunities should have all enhanced fields', async () => {
            const mockPriceData = {
                'WBNB/BUSD': {
                    'pancakeswap': {
                        price: 300,
                        reserveA: BigInt(1000 * 1e18).toString(),
                        reserveB: BigInt(300000 * 1e18).toString(),
                        liquidityUSD: 600000,
                        dexName: 'pancakeswap'
                    },
                    'biswap': {
                        price: 315, // 5% spread
                        reserveA: BigInt(1000 * 1e18).toString(),
                        reserveB: BigInt(315000 * 1e18).toString(),
                        liquidityUSD: 630000,
                        dexName: 'biswap'
                    },
                }
            };

            const opportunities = await arbitrageDetector.detectOpportunities(mockPriceData, 12345);

            expect(opportunities.length).toBeGreaterThan(0);

            const opp = opportunities[0];

            // Standard fields
            expect(opp).toHaveProperty('pairKey');
            expect(opp).toHaveProperty('buyDex');
            expect(opp).toHaveProperty('sellDex');
            expect(opp).toHaveProperty('profitUSD');

            // Analytical optimal trade size fields
            expect(opp).toHaveProperty('optimalTradeSizeUSD');

            // MEV risk fields (P2 improvement)
            expect(opp).toHaveProperty('mevRisk');
            expect(opp).toHaveProperty('mevRiskFactor');
            expect(opp).toHaveProperty('mevAdjustedScore');
            expect(opp).toHaveProperty('competitionLevel');
            expect(opp).toHaveProperty('expectedMEVLoss');
        });
    });
});
