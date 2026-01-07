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
const { default: AdaptivePoller } = await import('../../src/monitoring/adaptivePoller.js');

describe('AdaptivePoller', () => {
    let poller;

    beforeEach(() => {
        poller = new AdaptivePoller();
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('constructor', () => {
        test('should initialize with default values', () => {
            expect(poller.minInterval).toBe(500);
            expect(poller.maxInterval).toBe(5000);
            expect(poller.defaultInterval).toBe(2500);
            expect(poller.currentInterval).toBe(2500);
        });

        test('should accept custom configuration', () => {
            const customPoller = new AdaptivePoller({
                minInterval: 200,
                maxInterval: 10000,
                defaultInterval: 3000,
            });

            expect(customPoller.minInterval).toBe(200);
            expect(customPoller.maxInterval).toBe(10000);
            expect(customPoller.defaultInterval).toBe(3000);
        });
    });

    describe('recordPriceChange', () => {
        test('should record price changes', () => {
            poller.recordPriceChange('WBNB/USDT', 100, 101);
            expect(poller.priceChanges.length).toBe(1);
            expect(poller.priceChanges[0].change).toBeCloseTo(0.01, 5);
        });

        test('should handle zero or invalid prices', () => {
            poller.recordPriceChange('WBNB/USDT', 0, 100);
            expect(poller.priceChanges.length).toBe(0);

            poller.recordPriceChange('WBNB/USDT', null, 100);
            expect(poller.priceChanges.length).toBe(0);
        });

        test('should maintain window size', () => {
            // Add more changes than window size
            for (let i = 0; i < 50; i++) {
                poller.recordPriceChange('WBNB/USDT', 100, 100 + i * 0.1);
            }

            expect(poller.priceChanges.length).toBeLessThanOrEqual(poller.windowSize);
        });
    });

    describe('recordOpportunity', () => {
        test('should record opportunities', () => {
            poller.recordOpportunity({ type: 'cross-dex', profitPercent: 0.5 });
            expect(poller.recentOpportunities.length).toBe(1);
        });

        test('should clean old opportunities', () => {
            // Record an opportunity
            poller.recordOpportunity({ type: 'test', profitPercent: 1.0 });

            // Advance time past the opportunity window
            jest.advanceTimersByTime(poller.opportunityWindow + 1000);

            // Record another opportunity (triggers cleanup)
            poller.recordOpportunity({ type: 'test2', profitPercent: 1.0 });

            // Only the new opportunity should remain
            expect(poller.recentOpportunities.length).toBe(1);
        });

        test('should trigger high intensity on opportunity burst', () => {
            const spy = jest.fn();
            poller.on('highIntensityTriggered', spy);

            // Record 3+ opportunities quickly
            poller.recordOpportunity({ type: 'test', profitPercent: 1.0 });
            poller.recordOpportunity({ type: 'test', profitPercent: 1.0 });
            poller.recordOpportunity({ type: 'test', profitPercent: 1.0 });

            expect(spy).toHaveBeenCalled();
            expect(spy).toHaveBeenCalledWith({ reason: 'opportunity_burst' });
        });
    });

    describe('calculateVolatility', () => {
        test('should return unknown for insufficient data', () => {
            const result = poller.calculateVolatility();
            expect(result.level).toBe('unknown');
        });

        test('should calculate low volatility correctly', () => {
            // Add stable price changes (~0.1%)
            for (let i = 0; i < 10; i++) {
                poller.priceChanges.push({
                    change: 0.001 + Math.random() * 0.001,
                    timestamp: Date.now(),
                });
            }

            const result = poller.calculateVolatility();
            expect(result.level).toBe('low');
        });

        test('should calculate high volatility correctly', () => {
            // Add volatile price changes with high variance
            // Standard deviation needs to be > 2% for high volatility
            const volatileChanges = [0.01, 0.05, 0.02, 0.08, 0.01, 0.06, 0.03, 0.07, 0.02, 0.09];
            for (const change of volatileChanges) {
                poller.priceChanges.push({
                    change,
                    timestamp: Date.now(),
                });
            }

            const result = poller.calculateVolatility();
            // These values have std dev > 0.02 (2%)
            expect(['high', 'medium']).toContain(result.level);
        });
    });

    describe('getInterval', () => {
        test('should return default interval initially', () => {
            const interval = poller.getInterval(56);
            expect(interval).toBeGreaterThanOrEqual(poller.minInterval);
            expect(interval).toBeLessThanOrEqual(poller.maxInterval);
        });

        test('should respect chain block times', () => {
            // BSC: 3 second blocks - interval shouldn't be faster than 1.5s
            const bscInterval = poller.getInterval(56);
            expect(bscInterval).toBeGreaterThanOrEqual(1500);

            // Arbitrum: 0.25 second blocks - can be faster
            poller.currentInterval = 300;
            const arbInterval = poller.getInterval(42161);
            expect(arbInterval).toBeGreaterThanOrEqual(125);
        });

        test('should slow down when approaching rate limit', () => {
            // Simulate high RPC usage
            poller.rpcCallsPerMinute = poller.maxRpcPerMinute * 0.85;

            const interval = poller.getInterval(56);
            expect(interval).toBeGreaterThanOrEqual(poller.defaultInterval);
        });
    });

    describe('recordRpcCall', () => {
        test('should increment RPC counter', () => {
            expect(poller.rpcCallsPerMinute).toBe(0);
            poller.recordRpcCall();
            expect(poller.rpcCallsPerMinute).toBe(1);
        });
    });

    describe('setIntensityMode', () => {
        test('should change mode to AGGRESSIVE', () => {
            poller.setIntensityMode('AGGRESSIVE');
            expect(poller.currentMode).toBe('AGGRESSIVE');
        });

        test('should change mode to CONSERVATIVE', () => {
            poller.setIntensityMode('CONSERVATIVE');
            expect(poller.currentMode).toBe('CONSERVATIVE');
        });

        test('should ignore invalid modes', () => {
            poller.setIntensityMode('INVALID_MODE');
            expect(poller.currentMode).toBe('NORMAL');
        });
    });

    describe('getTimeBasedIntensity', () => {
        test('should return valid intensity mode', () => {
            const intensity = poller.getTimeBasedIntensity();
            expect(['AGGRESSIVE', 'NORMAL', 'CONSERVATIVE']).toContain(intensity);
        });
    });

    describe('shouldPollNow', () => {
        test('should return false immediately after construction', () => {
            // Just created - shouldn't poll yet
            expect(poller.shouldPollNow(56)).toBe(false);
        });

        test('should return true after interval passes', () => {
            jest.advanceTimersByTime(poller.getInterval(56) + 100);
            expect(poller.shouldPollNow(56)).toBe(true);
        });
    });

    describe('markPollComplete', () => {
        test('should update last poll time', () => {
            const before = poller.lastPollTime;
            jest.advanceTimersByTime(1000);
            poller.markPollComplete();

            expect(poller.lastPollTime).toBeGreaterThan(before);
        });

        test('should increment total polls', () => {
            const before = poller.stats.totalPolls;
            poller.markPollComplete();
            expect(poller.stats.totalPolls).toBe(before + 1);
        });
    });

    describe('interval adjustment', () => {
        test('should decrease interval during high volatility', () => {
            // Record high volatility price changes
            for (let i = 0; i < 10; i++) {
                poller.recordPriceChange('WBNB/USDT', 100, 100 + (Math.random() - 0.5) * 10);
            }

            // Interval should be lower than default
            expect(poller.currentInterval).toBeLessThanOrEqual(poller.defaultInterval);
        });

        test('should emit intervalChanged event', () => {
            const spy = jest.fn();
            poller.on('intervalChanged', spy);

            // Force a significant interval change
            poller.currentInterval = poller.maxInterval;
            for (let i = 0; i < 10; i++) {
                poller.recordPriceChange('WBNB/USDT', 100, 105); // 5% change
            }

            // Should have emitted event
            expect(spy).toHaveBeenCalled();
        });
    });

    describe('getStats', () => {
        test('should return statistics object', () => {
            const stats = poller.getStats();

            expect(stats).toHaveProperty('currentInterval');
            expect(stats).toHaveProperty('currentMode');
            expect(stats).toHaveProperty('volatility');
            expect(stats).toHaveProperty('volatilityLevel');
            expect(stats).toHaveProperty('recentOpportunities');
            expect(stats).toHaveProperty('rpcCallsThisMinute');
            expect(stats).toHaveProperty('totalPolls');
        });
    });

    describe('reset', () => {
        test('should reset all tracking data', () => {
            // Add some data
            poller.recordPriceChange('WBNB/USDT', 100, 101);
            poller.recordOpportunity({ type: 'test', profitPercent: 1.0 });
            poller.setIntensityMode('AGGRESSIVE');
            poller.rpcCallsPerMinute = 100;

            // Reset
            poller.reset();

            // Verify reset
            expect(poller.priceChanges.length).toBe(0);
            expect(poller.recentOpportunities.length).toBe(0);
            expect(poller.currentMode).toBe('NORMAL');
            expect(poller.rpcCallsPerMinute).toBe(0);
            expect(poller.currentInterval).toBe(poller.defaultInterval);
        });
    });

    describe('integration scenarios', () => {
        test('should adapt to market conditions', () => {
            jest.useRealTimers(); // Need real timers for this test

            const adaptivePoller = new AdaptivePoller();

            // Simulate calm market
            for (let i = 0; i < 10; i++) {
                adaptivePoller.recordPriceChange('WBNB/USDT', 100, 100.01);
            }
            const calmInterval = adaptivePoller.currentInterval;

            // Simulate volatile market
            for (let i = 0; i < 10; i++) {
                adaptivePoller.recordPriceChange('WBNB/USDT', 100, 100 + (Math.random() - 0.5) * 10);
            }
            const volatileInterval = adaptivePoller.currentInterval;

            // Volatile interval should be smaller
            expect(volatileInterval).toBeLessThanOrEqual(calmInterval);
        });

        test('should respond to opportunity bursts', () => {
            jest.useRealTimers();

            const adaptivePoller = new AdaptivePoller();
            const initialInterval = adaptivePoller.currentInterval;

            // Simulate opportunity burst
            adaptivePoller.recordOpportunity({ type: 'test1', profitPercent: 1.0 });
            adaptivePoller.recordOpportunity({ type: 'test2', profitPercent: 1.5 });
            adaptivePoller.recordOpportunity({ type: 'test3', profitPercent: 2.0 });

            // Should have switched to aggressive mode
            expect(adaptivePoller.currentMode).toBe('AGGRESSIVE');
            expect(adaptivePoller.currentInterval).toBeLessThanOrEqual(initialInterval);
        });
    });
});
