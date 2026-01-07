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
const { ExecutionSimulator, default: executionSimulator } = await import('../../src/execution/executionSimulator.js');

describe('ExecutionSimulator', () => {
    let simulator;

    beforeEach(() => {
        simulator = new ExecutionSimulator();
    });

    describe('constructor', () => {
        test('should initialize with default values', () => {
            expect(simulator.blockTime).toBe(3000);
            expect(simulator.avgTxPropagation).toBe(500);
            expect(simulator.competitorConfig.avgCompetitors).toBe(3);
        });

        test('should accept custom configuration', () => {
            const custom = new ExecutionSimulator({
                blockTime: 12000,
                avgCompetitors: 5,
                avgGasMultiplier: 1.5,
            });

            expect(custom.blockTime).toBe(12000);
            expect(custom.competitorConfig.avgCompetitors).toBe(5);
            expect(custom.competitorConfig.avgGasMultiplier).toBe(1.5);
        });
    });

    describe('simulate', () => {
        test('should return comprehensive simulation results', () => {
            const opportunity = {
                type: 'cross-dex',
                pairKey: 'WBNB/USDT',
                profitCalculation: {
                    netProfitUSD: 10,
                    tradeSizeUSD: 1000,
                    gasCostUSD: 0.5,
                },
                minLiquidityUSD: 50000,
                blockNumber: 100,
                timestamp: Date.now() - 1000,
            };

            const result = simulator.simulate(opportunity, {
                gasPrice: 3000000000n,
                currentBlock: 101,
                nativePrice: 600,
            });

            expect(result.opportunity).toBeDefined();
            expect(result.timing).toBeDefined();
            expect(result.competition).toBeDefined();
            expect(result.mevRisk).toBeDefined();
            expect(result.priceStability).toBeDefined();
            expect(result.slippageRisk).toBeDefined();
            expect(result.successProbability).toBeDefined();
            expect(result.recommendation).toBeDefined();
            expect(result.adjustedEV).toBeDefined();
        });

        test('should track simulation statistics', () => {
            const opportunity = {
                type: 'cross-dex',
                pairKey: 'WBNB/USDT',
                profitCalculation: {
                    netProfitUSD: 5,
                    tradeSizeUSD: 500,
                },
                minLiquidityUSD: 10000,
            };

            const beforeCount = simulator.stats.totalSimulations;
            simulator.simulate(opportunity);
            expect(simulator.stats.totalSimulations).toBe(beforeCount + 1);
        });

        test('should emit simulationComplete event', (done) => {
            simulator.on('simulationComplete', (result) => {
                expect(result.opportunity.type).toBe('triangular');
                done();
            });

            simulator.simulate({
                type: 'triangular',
                path: ['WBNB', 'USDT', 'BUSD', 'WBNB'],
                estimatedProfitUSD: 15,
                minLiquidityUSD: 20000,
            });
        });
    });

    describe('_analyzeExecutionTiming', () => {
        test('should calculate block age and staleness', () => {
            const opportunity = { blockNumber: 100 };
            const result = simulator._analyzeExecutionTiming(opportunity, 103);

            expect(result.blockAge).toBe(3);
            expect(result.isStale).toBe(true);
            expect(result.stalenessFactor).toBe(1);
        });

        test('should consider opportunity fresh if same block', () => {
            const opportunity = { blockNumber: 100 };
            const result = simulator._analyzeExecutionTiming(opportunity, 100);

            expect(result.blockAge).toBe(0);
            expect(result.isStale).toBe(false);
            expect(result.stalenessFactor).toBe(0);
        });

        test('should assess time pressure from timestamp', () => {
            // Recent opportunity
            const recentOpp = { timestamp: Date.now() - 1000 };
            const recentResult = simulator._analyzeExecutionTiming(recentOpp, 100);
            expect(recentResult.timePressure).toBe('low');

            // Older opportunity
            const olderOpp = { timestamp: Date.now() - 3000 };
            const olderResult = simulator._analyzeExecutionTiming(olderOpp, 100);
            expect(olderResult.timePressure).toBe('medium');
        });
    });

    describe('_analyzeCompetition', () => {
        test('should estimate competitors based on profit', () => {
            const smallProfit = {
                profitCalculation: { netProfitUSD: 5 },
            };
            const largeProfit = {
                profitCalculation: { netProfitUSD: 100 },
            };

            const smallResult = simulator._analyzeCompetition(smallProfit, 3000000000n);
            const largeResult = simulator._analyzeCompetition(largeProfit, 3000000000n);

            expect(largeResult.estimatedCompetitors).toBeGreaterThanOrEqual(
                smallResult.estimatedCompetitors
            );
        });

        test('should calculate win probability', () => {
            const opportunity = {
                profitCalculation: { netProfitUSD: 10 },
            };

            const result = simulator._analyzeCompetition(opportunity, 5000000000n);

            expect(result.winProbability).toBeGreaterThan(0);
            expect(result.winProbability).toBeLessThanOrEqual(1);
        });

        test('should classify competition level', () => {
            simulator.competitorConfig.avgCompetitors = 2;

            const lowProfit = { profitCalculation: { netProfitUSD: 1 } };
            const result = simulator._analyzeCompetition(lowProfit, 3000000000n);

            expect(['low', 'medium', 'high']).toContain(result.competitionLevel);
        });
    });

    describe('_analyzeMEVRisk', () => {
        test('should identify frontrunning risk for profitable trades', () => {
            const opportunity = {
                profitCalculation: {
                    netProfitUSD: 20,
                    tradeSizeUSD: 2000,
                },
            };

            const result = simulator._analyzeMEVRisk(opportunity, 600);

            const frontrunRisk = result.applicableRisks.find(r => r.type === 'frontrunning');
            expect(frontrunRisk).toBeDefined();
        });

        test('should not flag frontrunning for small profits', () => {
            const opportunity = {
                profitCalculation: {
                    netProfitUSD: 2,
                    tradeSizeUSD: 200,
                },
            };

            const result = simulator._analyzeMEVRisk(opportunity, 600);

            const frontrunRisk = result.applicableRisks.find(r => r.type === 'frontrunning');
            expect(frontrunRisk).toBeUndefined();
        });

        test('should calculate potential MEV loss', () => {
            const opportunity = {
                profitCalculation: {
                    netProfitUSD: 50,
                    tradeSizeUSD: 5000,
                },
            };

            const result = simulator._analyzeMEVRisk(opportunity, 600);

            expect(result.potentialMEVLossUSD).toBeGreaterThan(0);
            // MEV loss is at most equal to profit (when risk = 100%)
            expect(result.potentialMEVLossUSD).toBeLessThanOrEqual(50);
        });

        test('should classify risk level', () => {
            const highRiskOpp = {
                profitCalculation: {
                    netProfitUSD: 100,
                    tradeSizeUSD: 10000,
                },
            };

            const result = simulator._analyzeMEVRisk(highRiskOpp, 600);

            expect(['low', 'medium', 'high', 'extreme']).toContain(result.riskLevel);
        });
    });

    describe('_analyzePriceStability', () => {
        test('should assess stability from liquidity when no history', () => {
            const opportunity = {
                minLiquidityUSD: 50000,
            };

            const result = simulator._analyzePriceStability(opportunity);

            expect(result.hasHistory).toBe(false);
            expect(result.stabilityScore).toBeGreaterThan(0);
            expect(['stable', 'moderate', 'volatile']).toContain(result.assessment);
        });

        test('should calculate volatility from price history', () => {
            const opportunity = {
                priceHistory: [100, 100.1, 100.2, 99.9, 100, 100.3, 99.8],
            };

            const result = simulator._analyzePriceStability(opportunity);

            expect(result.hasHistory).toBe(true);
            expect(result.dataPoints).toBe(7);
            expect(result.volatility).toBeGreaterThanOrEqual(0);
        });
    });

    describe('_analyzeSlippageRisk', () => {
        test('should calculate trade ratio', () => {
            const opportunity = {
                profitCalculation: {
                    tradeSizeUSD: 1000,
                },
                minLiquidityUSD: 100000,
            };

            const result = simulator._analyzeSlippageRisk(opportunity);

            expect(result.tradeRatio).toBeCloseTo(0.01, 2);
            expect(result.tradeRatioPercent).toBeCloseTo(1, 1);
        });

        test('should classify slippage risk level', () => {
            const smallTrade = {
                profitCalculation: { tradeSizeUSD: 100 },
                minLiquidityUSD: 100000,
            };
            const largeTrade = {
                profitCalculation: { tradeSizeUSD: 20000 },
                minLiquidityUSD: 100000,
            };

            const smallResult = simulator._analyzeSlippageRisk(smallTrade);
            const largeResult = simulator._analyzeSlippageRisk(largeTrade);

            expect(smallResult.riskLevel).toBe('low');
            expect(['medium', 'high']).toContain(largeResult.riskLevel);
        });
    });

    describe('_calculateSuccessProbability', () => {
        test('should combine all factors into probability', () => {
            const analysis = {
                timing: { stalenessFactor: 0.1 },
                competition: { winProbability: 0.7 },
                mev: { totalRisk: 0.2 },
                priceStability: { stabilityScore: 0.8 },
                slippageRisk: { slippageRisk: 0.1 },
                opportunity: {
                    profitCalculation: { netProfitUSD: 15 },
                },
            };

            const result = simulator._calculateSuccessProbability(analysis);

            expect(result.probability).toBeGreaterThan(0);
            expect(result.probability).toBeLessThanOrEqual(1);
            expect(result.probabilityPercent).toBeGreaterThan(0);
            expect(result.probabilityPercent).toBeLessThanOrEqual(100);
            expect(result.components).toBeDefined();
        });

        test('should classify confidence level', () => {
            const highProb = {
                timing: { stalenessFactor: 0 },
                competition: { winProbability: 0.9 },
                mev: { totalRisk: 0 },
                priceStability: { stabilityScore: 1 },
                slippageRisk: { slippageRisk: 0 },
                opportunity: { profitCalculation: { netProfitUSD: 50 } },
            };

            const result = simulator._calculateSuccessProbability(highProb);
            expect(['high', 'medium', 'low', 'very_low']).toContain(result.confidence);
        });
    });

    describe('_generateRecommendation', () => {
        test('should recommend EXECUTE for high probability', () => {
            const successProb = { probability: 0.8 };
            const competition = { estimatedCompetitors: 2 };
            const mev = { riskLevel: 'low' };
            const opportunity = {
                profitCalculation: { netProfitUSD: 10 },
            };

            const result = simulator._generateRecommendation(
                successProb, competition, mev, opportunity
            );

            expect(result.action).toBe('EXECUTE');
        });

        test('should recommend SKIP for high competition', () => {
            const successProb = { probability: 0.5 };
            const competition = { estimatedCompetitors: 10 };
            const mev = { riskLevel: 'low' };
            const opportunity = {
                profitCalculation: { netProfitUSD: 5 },
            };

            const result = simulator._generateRecommendation(
                successProb, competition, mev, opportunity
            );

            expect(result.action).toBe('SKIP');
        });

        test('should recommend SKIP for extreme MEV risk', () => {
            const successProb = { probability: 0.6 };
            const competition = { estimatedCompetitors: 3 };
            const mev = { riskLevel: 'extreme' };
            const opportunity = {
                profitCalculation: { netProfitUSD: 10 },
            };

            const result = simulator._generateRecommendation(
                successProb, competition, mev, opportunity
            );

            expect(result.action).toBe('SKIP');
        });
    });

    describe('_calculateAdjustedExpectedValue', () => {
        test('should calculate positive EV for profitable opportunity', () => {
            const opportunity = {
                profitCalculation: {
                    netProfitUSD: 20,
                    gasCostUSD: 0.5,
                },
            };
            const successProb = { probability: 0.8 };
            const mev = { potentialMEVLossUSD: 2 };

            const result = simulator._calculateAdjustedExpectedValue(
                opportunity, successProb, mev
            );

            expect(result.expectedValue).toBeGreaterThan(0);
            expect(result.isPositiveEV).toBe(true);
        });

        test('should calculate negative EV for low probability', () => {
            const opportunity = {
                profitCalculation: {
                    netProfitUSD: 5,
                    gasCostUSD: 2,
                },
            };
            const successProb = { probability: 0.2 };
            const mev = { potentialMEVLossUSD: 3 };

            const result = simulator._calculateAdjustedExpectedValue(
                opportunity, successProb, mev
            );

            expect(result.isPositiveEV).toBe(false);
        });
    });

    describe('batchSimulate', () => {
        test('should simulate multiple opportunities', () => {
            const opportunities = [
                {
                    type: 'cross-dex',
                    pairKey: 'WBNB/USDT',
                    profitCalculation: { netProfitUSD: 10 },
                    minLiquidityUSD: 50000,
                },
                {
                    type: 'cross-dex',
                    pairKey: 'ETH/USDT',
                    profitCalculation: { netProfitUSD: 15 },
                    minLiquidityUSD: 100000,
                },
            ];

            const results = simulator.batchSimulate(opportunities);

            expect(results.length).toBe(2);
            // Should be sorted by expected value
            expect(results[0].adjustedEV.expectedValue).toBeGreaterThanOrEqual(
                results[1].adjustedEV.expectedValue
            );
        });
    });

    describe('getExecutableOpportunities', () => {
        test('should filter to executable opportunities', () => {
            const opportunities = [
                {
                    type: 'cross-dex',
                    pairKey: 'HIGH_PROB',
                    profitCalculation: {
                        netProfitUSD: 25,
                        tradeSizeUSD: 1000,
                    },
                    minLiquidityUSD: 200000,
                },
                {
                    type: 'cross-dex',
                    pairKey: 'LOW_PROB',
                    profitCalculation: {
                        netProfitUSD: 1,
                        tradeSizeUSD: 100,
                    },
                    minLiquidityUSD: 1000, // Low liquidity = risky
                },
            ];

            const executable = simulator.getExecutableOpportunities(opportunities);

            // At least one should be executable
            expect(executable.every(e =>
                e.recommendation.action === 'EXECUTE' ||
                e.recommendation.action === 'EXECUTE_WITH_CAUTION'
            )).toBe(true);
        });
    });

    describe('getStats', () => {
        test('should return statistics', () => {
            // Run some simulations
            simulator.simulate({
                type: 'cross-dex',
                pairKey: 'TEST',
                profitCalculation: { netProfitUSD: 10 },
                minLiquidityUSD: 50000,
            });

            const stats = simulator.getStats();

            expect(stats.totalSimulations).toBeGreaterThan(0);
            expect(stats.avgSuccessProbability).toBeDefined();
            expect(stats.mevRiskDistribution).toBeDefined();
            expect(stats.recommendationBreakdown).toBeDefined();
        });
    });

    describe('clearHistory', () => {
        test('should clear all history and stats', () => {
            // Run simulation
            simulator.simulate({
                type: 'cross-dex',
                pairKey: 'TEST',
                profitCalculation: { netProfitUSD: 10 },
            });

            simulator.clearHistory();

            expect(simulator.simulationHistory.length).toBe(0);
            expect(simulator.stats.totalSimulations).toBe(0);
        });
    });

    describe('exportHistory', () => {
        test('should export history data', () => {
            simulator.simulate({
                type: 'triangular',
                path: ['A', 'B', 'C', 'A'],
                estimatedProfitUSD: 8,
            });

            const exported = simulator.exportHistory();

            expect(exported.history).toBeDefined();
            expect(exported.stats).toBeDefined();
            expect(exported.exportedAt).toBeDefined();
        });
    });
});

// Test singleton instance
describe('ExecutionSimulator Singleton', () => {
    test('should export singleton instance', () => {
        expect(executionSimulator).toBeDefined();
        expect(typeof executionSimulator.simulate).toBe('function');
    });

    test('should be an EventEmitter', () => {
        expect(typeof executionSimulator.on).toBe('function');
        expect(typeof executionSimulator.emit).toBe('function');
    });
});
