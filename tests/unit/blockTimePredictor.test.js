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
const { BlockTimePredictor, default: blockTimePredictor } = await import('../../src/execution/blockTimePredictor.js');

describe('BlockTimePredictor', () => {
    let predictor;

    beforeEach(() => {
        predictor = new BlockTimePredictor();
    });

    describe('constructor', () => {
        test('should initialize with default values', () => {
            expect(predictor.sampleSize).toBe(50);
            expect(predictor.optimalLeadTime).toBe(400);
            expect(predictor.activeChainId).toBe(56);
        });

        test('should accept custom configuration', () => {
            const custom = new BlockTimePredictor({
                sampleSize: 100,
                optimalLeadTime: 300,
                chainId: 1,
            });

            expect(custom.sampleSize).toBe(100);
            expect(custom.optimalLeadTime).toBe(300);
            expect(custom.activeChainId).toBe(1);
        });

        test('should have expected block times for all chains', () => {
            expect(predictor.expectedBlockTimes[1]).toBe(12000);   // Ethereum
            expect(predictor.expectedBlockTimes[56]).toBe(3000);   // BSC
            expect(predictor.expectedBlockTimes[137]).toBe(2000);  // Polygon
            expect(predictor.expectedBlockTimes[42161]).toBe(250); // Arbitrum
        });
    });

    describe('recordBlock', () => {
        test('should record block to history', () => {
            const now = Date.now();
            predictor.recordBlock(1000, now, 56);

            expect(predictor.blockHistory.has(56)).toBe(true);
            expect(predictor.blockHistory.get(56).length).toBe(1);
            expect(predictor.stats.blocksRecorded).toBe(1);
        });

        test('should convert timestamp from seconds to ms', () => {
            const timestampSeconds = Math.floor(Date.now() / 1000);
            predictor.recordBlock(1000, timestampSeconds, 56);

            const history = predictor.blockHistory.get(56);
            expect(history[0].timestamp).toBeGreaterThan(1e12);
        });

        test('should maintain sample size limit', () => {
            predictor.sampleSize = 5;

            for (let i = 0; i < 10; i++) {
                predictor.recordBlock(1000 + i, Date.now() + i * 3000, 56);
            }

            expect(predictor.blockHistory.get(56).length).toBe(5);
        });

        test('should emit blockRecorded event', (done) => {
            predictor.on('blockRecorded', (data) => {
                expect(data.chainId).toBe(56);
                expect(data.blockNumber).toBe(1001);
                done();
            });

            const now = Date.now();
            predictor.recordBlock(1000, now, 56);
            predictor.recordBlock(1001, now + 3000, 56);
        });
    });

    describe('getAverageBlockTime', () => {
        test('should return expected block time if no history', () => {
            expect(predictor.getAverageBlockTime(56)).toBe(3000);
            expect(predictor.getAverageBlockTime(1)).toBe(12000);
        });

        test('should calculate average from history', () => {
            const now = Date.now();
            predictor.recordBlock(1000, now, 56);
            predictor.recordBlock(1001, now + 3000, 56);
            predictor.recordBlock(1002, now + 6000, 56);
            predictor.recordBlock(1003, now + 9000, 56);

            // Average should be 3000ms
            expect(predictor.getAverageBlockTime(56)).toBe(3000);
        });

        test('should handle varying block times', () => {
            const now = Date.now();
            predictor.recordBlock(1000, now, 56);
            predictor.recordBlock(1001, now + 2000, 56); // 2s
            predictor.recordBlock(1002, now + 6000, 56); // 4s

            // Average should be 3000ms
            expect(predictor.getAverageBlockTime(56)).toBe(3000);
        });
    });

    describe('getBlockTimeStdDev', () => {
        test('should return 0 if insufficient history', () => {
            expect(predictor.getBlockTimeStdDev(56)).toBe(0);

            predictor.recordBlock(1000, Date.now(), 56);
            expect(predictor.getBlockTimeStdDev(56)).toBe(0);
        });

        test('should calculate standard deviation', () => {
            const now = Date.now();
            predictor.recordBlock(1000, now, 56);
            predictor.recordBlock(1001, now + 3000, 56);
            predictor.recordBlock(1002, now + 6000, 56);
            predictor.recordBlock(1003, now + 9000, 56);

            // All blocks exactly 3s apart - stddev should be 0
            expect(predictor.getBlockTimeStdDev(56)).toBe(0);
        });

        test('should reflect variance in block times', () => {
            const now = Date.now();
            predictor.recordBlock(1000, now, 56);
            predictor.recordBlock(1001, now + 2000, 56); // 2s
            predictor.recordBlock(1002, now + 6000, 56); // 4s
            predictor.recordBlock(1003, now + 8000, 56); // 2s

            // With varying times, stddev should be > 0
            expect(predictor.getBlockTimeStdDev(56)).toBeGreaterThan(0);
        });
    });

    describe('predictNextBlock', () => {
        test('should return low confidence with no history', () => {
            const prediction = predictor.predictNextBlock(56);

            expect(prediction.confidence).toBe('low');
            expect(prediction.reason).toBe('Insufficient block history');
        });

        test('should predict based on average block time', () => {
            const now = Date.now();
            predictor.recordBlock(1000, now - 6000, 56);
            predictor.recordBlock(1001, now - 3000, 56);
            predictor.recordBlock(1002, now, 56);

            const prediction = predictor.predictNextBlock(56);

            // Should predict next block ~3s from now
            expect(prediction.predictedTime).toBeCloseTo(now + 3000, -2);
            expect(prediction.lastBlockNumber).toBe(1002);
        });

        test('should have high confidence with consistent blocks', () => {
            const now = Date.now();
            for (let i = 0; i < 20; i++) {
                predictor.recordBlock(1000 + i, now - (20 - i) * 3000, 56);
            }

            const prediction = predictor.predictNextBlock(56);

            expect(prediction.confidence).toBe('high');
        });
    });

    describe('getOptimalSubmissionWindow', () => {
        test('should recommend immediate submission if block imminent', () => {
            const now = Date.now();
            predictor.recordBlock(1000, now - 6000, 56);
            predictor.recordBlock(1001, now - 3000, 56);
            predictor.recordBlock(1002, now - 100, 56); // Very recent block

            const window = predictor.getOptimalSubmissionWindow(56);

            // Next block should be ~3s away, should provide timing
            expect(window.submit).toBe(true);
        });

        test('should calculate delay for optimal window', () => {
            const now = Date.now();
            // Set up blocks so next block is ~2s away
            predictor.recordBlock(1000, now - 4000, 56);
            predictor.recordBlock(1001, now - 1000, 56);

            const window = predictor.getOptimalSubmissionWindow(56);

            expect(window.submit).toBe(true);
            expect(typeof window.delay).toBe('number');
        });

        test('should include prediction data in response', () => {
            const now = Date.now();
            predictor.recordBlock(1000, now - 3000, 56);
            predictor.recordBlock(1001, now, 56);

            const window = predictor.getOptimalSubmissionWindow(56);

            expect(window.avgBlockTime).toBeDefined();
            expect(window.lastBlockNumber).toBeDefined();
        });
    });

    describe('shouldSubmitNow', () => {
        test('should return boolean', () => {
            const result = predictor.shouldSubmitNow(56);
            expect(typeof result).toBe('boolean');
        });
    });

    describe('waitForOptimalWindow', () => {
        test('should return immediately if delay is 0', async () => {
            const now = Date.now();
            predictor.recordBlock(1000, now - 2900, 56);
            predictor.recordBlock(1001, now, 56);

            const start = Date.now();
            const window = await predictor.waitForOptimalWindow(56, 1000);
            const elapsed = Date.now() - start;

            // Should be very fast (< 100ms)
            expect(elapsed).toBeLessThan(100);
            expect(window.submit).toBe(true);
        });

        test('should respect maxWait parameter', async () => {
            // Create scenario where delay would be > maxWait
            const now = Date.now();
            predictor.recordBlock(1000, now - 100, 56); // Very recent

            const start = Date.now();
            await predictor.waitForOptimalWindow(56, 100);
            const elapsed = Date.now() - start;

            expect(elapsed).toBeLessThan(200);
        });
    });

    describe('setActiveChain', () => {
        test('should update active chain', () => {
            predictor.setActiveChain(1);
            expect(predictor.activeChainId).toBe(1);
        });
    });

    describe('getStats', () => {
        test('should return statistics', () => {
            predictor.recordBlock(1000, Date.now(), 56);
            predictor.predictNextBlock(56);

            const stats = predictor.getStats();

            expect(stats.blocksRecorded).toBe(1);
            expect(stats.predictionsRequested).toBe(1);
            expect(stats.chainStats).toBeDefined();
            expect(stats.activeChainId).toBe(56);
        });

        test('should include per-chain stats', () => {
            const now = Date.now();
            predictor.recordBlock(1000, now - 3000, 56);
            predictor.recordBlock(1001, now, 56);

            const stats = predictor.getStats();

            expect(stats.chainStats[56]).toBeDefined();
            expect(stats.chainStats[56].samplesRecorded).toBe(2);
        });
    });

    describe('clearHistory', () => {
        test('should clear history for specific chain', () => {
            predictor.recordBlock(1000, Date.now(), 56);
            predictor.recordBlock(1000, Date.now(), 1);

            predictor.clearHistory(56);

            expect(predictor.blockHistory.has(56)).toBe(false);
            expect(predictor.blockHistory.has(1)).toBe(true);
        });

        test('should clear all history if no chain specified', () => {
            predictor.recordBlock(1000, Date.now(), 56);
            predictor.recordBlock(1000, Date.now(), 1);

            predictor.clearHistory();

            expect(predictor.blockHistory.size).toBe(0);
        });
    });

    describe('getRecentBlockTimes', () => {
        test('should return empty array if no history', () => {
            const times = predictor.getRecentBlockTimes(56);
            expect(times).toEqual([]);
        });

        test('should return recent block times', () => {
            const now = Date.now();
            predictor.recordBlock(1000, now - 9000, 56);
            predictor.recordBlock(1001, now - 6000, 56);
            predictor.recordBlock(1002, now - 3000, 56);
            predictor.recordBlock(1003, now, 56);

            const times = predictor.getRecentBlockTimes(56, 3);

            expect(times.length).toBe(3);
            expect(times[0].blockNumber).toBe(1001);
            expect(times[2].blockNumber).toBe(1003);
            expect(times[0].blockTime).toBe(3000);
        });
    });
});

// Test singleton instance
describe('BlockTimePredictor Singleton', () => {
    test('should export singleton instance', () => {
        expect(blockTimePredictor).toBeDefined();
        expect(typeof blockTimePredictor.recordBlock).toBe('function');
    });

    test('should be an EventEmitter', () => {
        expect(typeof blockTimePredictor.on).toBe('function');
        expect(typeof blockTimePredictor.emit).toBe('function');
    });
});
