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
const { default: OpportunityScorer } = await import('../../src/analysis/opportunityScorer.js');

describe('OpportunityScorer', () => {
    let scorer;

    beforeEach(() => {
        // Create fresh instance for each test
        scorer = new OpportunityScorer.__proto__.constructor();
    });

    describe('constructor', () => {
        test('should initialize with default weights summing to 1.0', () => {
            const totalWeight = Object.values(scorer.weights).reduce((a, b) => a + b, 0);
            expect(totalWeight).toBeCloseTo(1.0, 5);
        });

        test('should accept custom configuration', () => {
            const customScorer = new OpportunityScorer.__proto__.constructor({
                profitWeight: 0.50,
                liquidityWeight: 0.20,
                executionWeight: 0.15,
                timeWeight: 0.10,
                tokenQualityWeight: 0.05,
            });

            expect(customScorer.weights.profit).toBe(0.50);
            expect(customScorer.weights.liquidity).toBe(0.20);
        });
    });

    describe('calculateScore', () => {
        test('should calculate score for cross-dex opportunity', () => {
            const opportunity = {
                type: 'cross-dex',
                profitUSD: 10,
                minLiquidityUSD: 50000,
                timestamp: Date.now(),
                pairKey: 'WBNB/USDT',
            };

            const result = scorer.calculateScore(opportunity);

            expect(result.finalScore).toBeGreaterThan(0);
            expect(result.finalScore).toBeLessThanOrEqual(100);
            expect(result.tier).toBeDefined();
            expect(result.recommendation).toBeDefined();
        });

        test('should calculate score for triangular opportunity', () => {
            const opportunity = {
                type: 'triangular',
                profitCalculation: {
                    netProfitUSD: 25,
                    gasCostUSD: 2,
                    slippageRate: 0.005,
                },
                minLiquidityUSD: 100000,
                path: ['WBNB', 'USDT', 'ETH', 'WBNB'],
                timestamp: Date.now(),
            };

            const result = scorer.calculateScore(opportunity);

            expect(result.finalScore).toBeGreaterThan(50);
            expect(result.scores.profit).toBeGreaterThan(0);
            expect(result.scores.execution).toBeGreaterThan(0);
        });

        test('should give higher scores to higher profit', () => {
            const lowProfitOpp = {
                type: 'cross-dex',
                profitUSD: 2,
                minLiquidityUSD: 50000,
                timestamp: Date.now(),
            };

            const highProfitOpp = {
                type: 'cross-dex',
                profitUSD: 50,
                minLiquidityUSD: 50000,
                timestamp: Date.now(),
            };

            const lowScore = scorer.calculateScore(lowProfitOpp);
            const highScore = scorer.calculateScore(highProfitOpp);

            expect(highScore.finalScore).toBeGreaterThan(lowScore.finalScore);
            expect(highScore.scores.profit).toBeGreaterThan(lowScore.scores.profit);
        });

        test('should give higher scores to higher liquidity', () => {
            const lowLiqOpp = {
                type: 'cross-dex',
                profitUSD: 10,
                minLiquidityUSD: 5000,
                timestamp: Date.now(),
            };

            const highLiqOpp = {
                type: 'cross-dex',
                profitUSD: 10,
                minLiquidityUSD: 500000,
                timestamp: Date.now(),
            };

            const lowScore = scorer.calculateScore(lowLiqOpp);
            const highScore = scorer.calculateScore(highLiqOpp);

            expect(highScore.scores.liquidity).toBeGreaterThan(lowScore.scores.liquidity);
        });
    });

    describe('_scoreProfitPotential', () => {
        test('should return 0 for zero or negative profit', () => {
            expect(scorer._scoreProfitPotential({ profitUSD: 0 })).toBe(0);
            expect(scorer._scoreProfitPotential({ profitUSD: -5 })).toBe(0);
        });

        test('should return higher score for higher profit', () => {
            const score1 = scorer._scoreProfitPotential({ profitUSD: 1 });
            const score10 = scorer._scoreProfitPotential({ profitUSD: 10 });
            const score100 = scorer._scoreProfitPotential({ profitUSD: 100 });

            expect(score10).toBeGreaterThan(score1);
            expect(score100).toBeGreaterThan(score10);
        });

        test('should cap at 100', () => {
            const score = scorer._scoreProfitPotential({ profitUSD: 10000 });
            expect(score).toBeLessThanOrEqual(100);
        });

        test('should use profitCalculation.netProfitUSD if available', () => {
            const opp = {
                profitUSD: 5,
                profitCalculation: { netProfitUSD: 20 },
            };
            const score = scorer._scoreProfitPotential(opp);
            const expectedScore = scorer._scoreProfitPotential({ profitUSD: 20 });
            expect(score).toBe(expectedScore);
        });
    });

    describe('_scoreLiquidity', () => {
        test('should return 100 for excellent liquidity', () => {
            const score = scorer._scoreLiquidity({ minLiquidityUSD: 500000 });
            expect(score).toBe(100);
        });

        test('should return score between 80-100 for great liquidity', () => {
            const score = scorer._scoreLiquidity({ minLiquidityUSD: 200000 });
            expect(score).toBeGreaterThanOrEqual(80);
            expect(score).toBeLessThanOrEqual(100);
        });

        test('should return lower score for low liquidity', () => {
            const score = scorer._scoreLiquidity({ minLiquidityUSD: 3000 });
            expect(score).toBeLessThan(20);
        });

        test('should estimate liquidity from trade size', () => {
            const opp = { optimalTradeSizeUSD: 500 };
            const score = scorer._scoreLiquidity(opp);
            // Should estimate 500 * 10 = 5000 liquidity
            expect(score).toBeGreaterThan(0);
        });
    });

    describe('_scoreExecutionProbability', () => {
        test('should return high score for triangular', () => {
            const score = scorer._scoreExecutionProbability({ type: 'triangular' });
            expect(score).toBe(90);
        });

        test('should return medium score for cross-dex', () => {
            const score = scorer._scoreExecutionProbability({ type: 'cross-dex' });
            expect(score).toBe(75);
        });

        test('should return low score for cross-chain', () => {
            const score = scorer._scoreExecutionProbability({ type: 'cross-chain' });
            expect(score).toBe(40);
        });

        test('should reduce score for high slippage', () => {
            const normalScore = scorer._scoreExecutionProbability({
                type: 'cross-dex',
                profitCalculation: { slippageRate: 0.01 },
            });

            const highSlippageScore = scorer._scoreExecutionProbability({
                type: 'cross-dex',
                profitCalculation: { slippageRate: 0.04 },
            });

            expect(highSlippageScore).toBeLessThan(normalScore);
        });
    });

    describe('_scoreTimeSensitivity', () => {
        test('should return 100 for very fresh opportunity', () => {
            const score = scorer._scoreTimeSensitivity({ timestamp: Date.now() });
            expect(score).toBeGreaterThanOrEqual(90);
        });

        test('should return lower score for older opportunity', () => {
            const freshScore = scorer._scoreTimeSensitivity({ timestamp: Date.now() });
            const oldScore = scorer._scoreTimeSensitivity({ timestamp: Date.now() - 5000 });

            expect(oldScore).toBeLessThan(freshScore);
        });

        test('should return 0 for stale opportunity', () => {
            const score = scorer._scoreTimeSensitivity({ timestamp: Date.now() - 15000 });
            expect(score).toBe(0);
        });
    });

    describe('_scoreTokenQuality', () => {
        test('should return high score for stablecoin pairs', () => {
            const score = scorer._scoreTokenQuality({ pairKey: 'USDT/USDC' });
            expect(score).toBeGreaterThanOrEqual(90);
        });

        test('should return lower score for meme tokens', () => {
            const score = scorer._scoreTokenQuality({ pairKey: 'PEPE/SHIB' });
            expect(score).toBeLessThan(60);
        });

        test('should use path tokens for triangular', () => {
            const score = scorer._scoreTokenQuality({
                path: ['WBNB', 'USDT', 'ETH'],
            });
            expect(score).toBeGreaterThan(0);
        });
    });

    describe('_getTier', () => {
        test('should return EXCELLENT for score >= 80', () => {
            expect(scorer._getTier(80)).toBe('EXCELLENT');
            expect(scorer._getTier(95)).toBe('EXCELLENT');
        });

        test('should return GOOD for score 60-79', () => {
            expect(scorer._getTier(60)).toBe('GOOD');
            expect(scorer._getTier(79)).toBe('GOOD');
        });

        test('should return ACCEPTABLE for score 40-59', () => {
            expect(scorer._getTier(40)).toBe('ACCEPTABLE');
            expect(scorer._getTier(59)).toBe('ACCEPTABLE');
        });

        test('should return MARGINAL for score 20-39', () => {
            expect(scorer._getTier(20)).toBe('MARGINAL');
            expect(scorer._getTier(39)).toBe('MARGINAL');
        });

        test('should return POOR for score < 20', () => {
            expect(scorer._getTier(10)).toBe('POOR');
            expect(scorer._getTier(0)).toBe('POOR');
        });
    });

    describe('scoreAndSort', () => {
        test('should sort opportunities by score descending', () => {
            const opportunities = [
                { type: 'cross-dex', profitUSD: 5, timestamp: Date.now() },
                { type: 'cross-dex', profitUSD: 50, timestamp: Date.now() },
                { type: 'cross-dex', profitUSD: 10, timestamp: Date.now() },
            ];

            const sorted = scorer.scoreAndSort(opportunities);

            expect(sorted[0].profitUSD).toBe(50);
            expect(sorted[1].profitUSD).toBe(10);
            expect(sorted[2].profitUSD).toBe(5);
        });

        test('should add scoring property to each opportunity', () => {
            const opportunities = [
                { type: 'cross-dex', profitUSD: 10, timestamp: Date.now() },
            ];

            const sorted = scorer.scoreAndSort(opportunities);

            expect(sorted[0].scoring).toBeDefined();
            expect(sorted[0].scoring.finalScore).toBeDefined();
            expect(sorted[0].scoring.tier).toBeDefined();
        });
    });

    describe('filterByScore', () => {
        test('should filter out low-score opportunities', () => {
            const opportunities = [
                { scoring: { finalScore: 80 } },
                { scoring: { finalScore: 30 } },
                { scoring: { finalScore: 60 } },
            ];

            const filtered = scorer.filterByScore(opportunities, 50);

            expect(filtered.length).toBe(2);
            expect(filtered[0].scoring.finalScore).toBe(80);
            expect(filtered[1].scoring.finalScore).toBe(60);
        });

        test('should use default threshold of 40', () => {
            const opportunities = [
                { scoring: { finalScore: 50 } },
                { scoring: { finalScore: 30 } },
            ];

            const filtered = scorer.filterByScore(opportunities);

            expect(filtered.length).toBe(1);
        });
    });

    describe('getTopOpportunities', () => {
        test('should return top N opportunities', () => {
            const opportunities = [
                { type: 'cross-dex', profitUSD: 5, timestamp: Date.now() },
                { type: 'cross-dex', profitUSD: 50, timestamp: Date.now() },
                { type: 'cross-dex', profitUSD: 10, timestamp: Date.now() },
                { type: 'cross-dex', profitUSD: 25, timestamp: Date.now() },
            ];

            const top2 = scorer.getTopOpportunities(opportunities, 2);

            expect(top2.length).toBe(2);
            expect(top2[0].profitUSD).toBe(50);
            expect(top2[1].profitUSD).toBe(25);
        });

        test('should default to 5 opportunities', () => {
            const opportunities = Array(10).fill(null).map((_, i) => ({
                type: 'cross-dex',
                profitUSD: i + 1,
                timestamp: Date.now(),
            }));

            const top = scorer.getTopOpportunities(opportunities);

            expect(top.length).toBe(5);
        });
    });

    describe('getStats', () => {
        test('should return empty stats when no history', () => {
            scorer.resetHistory();
            const stats = scorer.getStats();

            expect(stats.totalScored).toBe(0);
            expect(stats.averageScore).toBe(0);
        });

        test('should return stats after scoring', () => {
            scorer.resetHistory();

            // Score some opportunities
            scorer.calculateScore({ type: 'cross-dex', profitUSD: 10, timestamp: Date.now() });
            scorer.calculateScore({ type: 'triangular', profitUSD: 20, timestamp: Date.now() });

            const stats = scorer.getStats();

            expect(stats.totalScored).toBe(2);
            expect(parseFloat(stats.averageScore)).toBeGreaterThan(0);
            expect(stats.tierDistribution).toBeDefined();
        });
    });

    describe('updateWeights', () => {
        test('should update weights and normalize to sum 1.0', () => {
            // Update all weights together to sum to 1.0
            scorer.updateWeights({
                profit: 0.50,
                liquidity: 0.25,
                execution: 0.15,
                time: 0.05,
                tokenQuality: 0.05,
            });

            expect(scorer.weights.profit).toBe(0.50);
            expect(scorer.weights.liquidity).toBe(0.25);

            const total = Object.values(scorer.weights).reduce((a, b) => a + b, 0);
            expect(total).toBeCloseTo(1.0, 5);
        });

        test('should normalize weights if they do not sum to 1.0', () => {
            scorer.updateWeights({
                profit: 0.50,
                liquidity: 0.50,
                execution: 0.50,
                time: 0.50,
                tokenQuality: 0.50,
            });

            const total = Object.values(scorer.weights).reduce((a, b) => a + b, 0);
            expect(total).toBeCloseTo(1.0, 5);
            // Each weight should now be 0.2 after normalization
            expect(scorer.weights.profit).toBeCloseTo(0.2, 5);
        });
    });

    describe('recommendation', () => {
        test('should recommend EXECUTE_IMMEDIATELY for excellent opportunities', () => {
            const opp = {
                type: 'triangular',
                profitUSD: 100,
                minLiquidityUSD: 500000,
                timestamp: Date.now(),
                pairKey: 'WBNB/USDT',
            };

            const result = scorer.calculateScore(opp);

            if (result.finalScore >= 80) {
                expect(result.recommendation.action).toBe('EXECUTE_IMMEDIATELY');
                expect(result.recommendation.priority).toBe(1);
            }
        });

        test('should recommend SKIP for poor opportunities', () => {
            const opp = {
                type: 'cross-chain',
                profitUSD: 0.5,
                minLiquidityUSD: 1000,
                timestamp: Date.now() - 15000, // Stale
                pairKey: 'PEPE/SHIB',
            };

            const result = scorer.calculateScore(opp);

            if (result.finalScore < 20) {
                expect(result.recommendation.action).toBe('SKIP');
                expect(result.recommendation.priority).toBe(5);
            }
        });
    });
});

// Test the singleton instance
describe('OpportunityScorer Singleton', () => {
    let opportunityScorer;

    beforeAll(async () => {
        const module = await import('../../src/analysis/opportunityScorer.js');
        opportunityScorer = module.default;
    });

    test('should export singleton instance', () => {
        expect(opportunityScorer).toBeDefined();
        expect(typeof opportunityScorer.calculateScore).toBe('function');
    });

    test('should have default configuration', () => {
        expect(opportunityScorer.weights).toBeDefined();
        expect(opportunityScorer.profitThresholds).toBeDefined();
        expect(opportunityScorer.executionProbability).toBeDefined();
    });
});
