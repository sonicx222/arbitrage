import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { CrossPoolCorrelation } from '../../src/analysis/crossPoolCorrelation.js';

describe('CrossPoolCorrelation', () => {
    let correlation;

    beforeEach(() => {
        correlation = new CrossPoolCorrelation({
            historyLength: 50,
            minHistoryForCorrelation: 5,
            correlationThreshold: 0.7,
        });
    });

    afterEach(() => {
        correlation.stop();
        correlation.reset();
    });

    describe('constructor', () => {
        it('should initialize with default options', () => {
            const defaultCorrelation = new CrossPoolCorrelation();
            expect(defaultCorrelation.historyLength).toBe(100);
            expect(defaultCorrelation.correlationThreshold).toBe(0.7);
        });

        it('should accept custom options', () => {
            expect(correlation.historyLength).toBe(50);
            expect(correlation.minHistoryForCorrelation).toBe(5);
            expect(correlation.correlationThreshold).toBe(0.7);
        });

        it('should initialize empty data structures', () => {
            expect(correlation.correlationMatrix.size).toBe(0);
            expect(correlation.priceHistory.size).toBe(0);
        });
    });

    describe('start and stop', () => {
        it('should start the update timer', () => {
            correlation.start();
            expect(correlation.updateTimer).not.toBeNull();
        });

        it('should stop the update timer', () => {
            correlation.start();
            correlation.stop();
            expect(correlation.updateTimer).toBeNull();
        });

        it('should not create multiple timers on repeated start', () => {
            correlation.start();
            const timer1 = correlation.updateTimer;
            correlation.start();
            expect(correlation.updateTimer).toBe(timer1);
        });
    });

    describe('recordPriceUpdate', () => {
        it('should record price updates', () => {
            correlation.recordPriceUpdate({
                pairKey: 'WBNB/USDT',
                dexName: 'pancakeswap',
                price: 600,
                blockNumber: 1000,
            });

            expect(correlation.priceHistory.size).toBe(1);
            expect(correlation.stats.priceUpdatesProcessed).toBe(1);
        });

        it('should not record insignificant price changes', () => {
            correlation.recordPriceUpdate({
                pairKey: 'WBNB/USDT',
                dexName: 'pancakeswap',
                price: 600,
                blockNumber: 1000,
            });

            correlation.recordPriceUpdate({
                pairKey: 'WBNB/USDT',
                dexName: 'pancakeswap',
                price: 600.001, // 0.0001% change - below threshold
                blockNumber: 1001,
            });

            const history = correlation.priceHistory.get('WBNB/USDT:pancakeswap');
            expect(history.length).toBe(1);
        });

        it('should record significant price changes', () => {
            correlation.recordPriceUpdate({
                pairKey: 'WBNB/USDT',
                dexName: 'pancakeswap',
                price: 600,
                blockNumber: 1000,
            });

            correlation.recordPriceUpdate({
                pairKey: 'WBNB/USDT',
                dexName: 'pancakeswap',
                price: 601, // ~0.17% change - above threshold
                blockNumber: 1001,
            });

            const history = correlation.priceHistory.get('WBNB/USDT:pancakeswap');
            expect(history.length).toBe(2);
        });

        it('should trim history when too long', () => {
            for (let i = 0; i < 60; i++) {
                correlation.recordPriceUpdate({
                    pairKey: 'WBNB/USDT',
                    dexName: 'pancakeswap',
                    price: 600 + i, // Ensure each is significant
                    blockNumber: 1000 + i,
                });
            }

            const history = correlation.priceHistory.get('WBNB/USDT:pancakeswap');
            expect(history.length).toBe(50); // historyLength = 50
        });

        it('should update pool groups', () => {
            correlation.recordPriceUpdate({
                pairKey: 'WBNB/USDT',
                dexName: 'pancakeswap',
                price: 600,
                blockNumber: 1000,
            });

            expect(correlation.poolGroups.pairDexPools.has('WBNB/USDT')).toBe(true);
            expect(correlation.poolGroups.baseTokenPools.has('WBNB')).toBe(true);
            expect(correlation.poolGroups.baseTokenPools.has('USDT')).toBe(true);
        });
    });

    describe('getCorrelatedPools', () => {
        beforeEach(() => {
            // Setup pools on different DEXs
            correlation.recordPriceUpdate({
                pairKey: 'WBNB/USDT',
                dexName: 'pancakeswap',
                price: 600,
                blockNumber: 1000,
            });
            correlation.recordPriceUpdate({
                pairKey: 'WBNB/USDT',
                dexName: 'biswap',
                price: 600,
                blockNumber: 1000,
            });
            correlation.recordPriceUpdate({
                pairKey: 'WBNB/BUSD',
                dexName: 'pancakeswap',
                price: 600,
                blockNumber: 1000,
            });
        });

        it('should find same-pair correlations across DEXs', () => {
            const correlated = correlation.getCorrelatedPools('WBNB/USDT', 'pancakeswap');

            expect(correlated.length).toBeGreaterThan(0);
            const poolKeys = correlated.map(c => c.poolKey);
            expect(poolKeys).toContain('WBNB/USDT:biswap');
        });

        it('should assign high score to same-pair correlations', () => {
            const correlated = correlation.getCorrelatedPools('WBNB/USDT', 'pancakeswap');
            const biswapCorrelation = correlated.find(c => c.poolKey === 'WBNB/USDT:biswap');

            expect(biswapCorrelation).toBeDefined();
            expect(biswapCorrelation.score).toBe(0.95);
            expect(biswapCorrelation.type).toBe('same-pair');
        });

        it('should find base token correlations', () => {
            const correlated = correlation.getCorrelatedPools('WBNB/USDT', 'pancakeswap');
            const poolKeys = correlated.map(c => c.poolKey);

            expect(poolKeys).toContain('WBNB/BUSD:pancakeswap');
        });

        it('should increment stats on correlation check', () => {
            correlation.getCorrelatedPools('WBNB/USDT', 'pancakeswap');
            expect(correlation.stats.correlationChecks).toBe(1);
        });

        it('should respect limit option', () => {
            const correlated = correlation.getCorrelatedPools('WBNB/USDT', 'pancakeswap', {
                limit: 1,
            });
            expect(correlated.length).toBe(1);
        });
    });

    describe('processReserveUpdate', () => {
        beforeEach(() => {
            // Setup correlated pools
            correlation.recordPriceUpdate({
                pairKey: 'WBNB/USDT',
                dexName: 'biswap',
                price: 600,
                blockNumber: 1000,
            });
        });

        it('should emit checkCorrelated events for high correlations', () => {
            const handler = jest.fn();
            correlation.on('checkCorrelated', handler);

            correlation.processReserveUpdate({
                pairKey: 'WBNB/USDT',
                dexName: 'pancakeswap',
                price: 601,
                blockNumber: 1001,
            });

            expect(handler).toHaveBeenCalled();
            const event = handler.mock.calls[0][0];
            expect(event.sourcePool).toBe('WBNB/USDT:pancakeswap');
            expect(event.correlationScore).toBeGreaterThanOrEqual(0.7);
        });

        it('should return correlated pools', () => {
            const correlated = correlation.processReserveUpdate({
                pairKey: 'WBNB/USDT',
                dexName: 'pancakeswap',
                price: 601,
                blockNumber: 1001,
            });

            expect(correlated.length).toBeGreaterThan(0);
        });
    });

    describe('updateCorrelationMatrix', () => {
        it('should calculate correlations with enough history', () => {
            // Create two pools with correlated price movements
            for (let i = 0; i < 10; i++) {
                const basePrice = 600 + i * 10;
                correlation.recordPriceUpdate({
                    pairKey: 'WBNB/USDT',
                    dexName: 'pancakeswap',
                    price: basePrice,
                    blockNumber: 1000 + i,
                });
                correlation.recordPriceUpdate({
                    pairKey: 'WBNB/USDT',
                    dexName: 'biswap',
                    price: basePrice + 1, // Slightly different but correlated
                    blockNumber: 1000 + i,
                });
            }

            correlation.updateCorrelationMatrix();

            expect(correlation.stats.matrixSize).toBeGreaterThan(0);
            expect(correlation.stats.lastCorrelationUpdate).not.toBeNull();
        });

        it('should not calculate with insufficient history', () => {
            correlation.recordPriceUpdate({
                pairKey: 'WBNB/USDT',
                dexName: 'pancakeswap',
                price: 600,
                blockNumber: 1000,
            });

            correlation.updateCorrelationMatrix();

            expect(correlation.stats.matrixSize).toBe(0);
        });
    });

    describe('getCorrelation', () => {
        it('should return null for unknown pools', () => {
            const result = correlation.getCorrelation('unknown:pool1', 'unknown:pool2');
            expect(result).toBeNull();
        });

        it('should return correlation score for known pools', () => {
            // Manually set correlation for testing
            correlation.correlationMatrix.set('pool1', new Map([['pool2', 0.85]]));

            const result = correlation.getCorrelation('pool1', 'pool2');
            expect(result).toBe(0.85);
        });
    });

    describe('getTopCorrelated', () => {
        it('should return empty array for unknown pool', () => {
            const result = correlation.getTopCorrelated('unknown:pool');
            expect(result).toEqual([]);
        });

        it('should return sorted correlations', () => {
            correlation.correlationMatrix.set('pool1', new Map([
                ['pool2', 0.9],
                ['pool3', 0.7],
                ['pool4', 0.8],
            ]));

            const result = correlation.getTopCorrelated('pool1', 3);

            expect(result.length).toBe(3);
            expect(result[0].pool).toBe('pool2');
            expect(result[0].score).toBe(0.9);
        });

        it('should respect limit parameter', () => {
            correlation.correlationMatrix.set('pool1', new Map([
                ['pool2', 0.9],
                ['pool3', 0.7],
                ['pool4', 0.8],
            ]));

            const result = correlation.getTopCorrelated('pool1', 2);
            expect(result.length).toBe(2);
        });
    });

    describe('export and import', () => {
        it('should export data correctly', () => {
            for (let i = 0; i < 5; i++) {
                correlation.recordPriceUpdate({
                    pairKey: 'WBNB/USDT',
                    dexName: 'pancakeswap',
                    price: 600 + i * 10,
                    blockNumber: 1000 + i,
                });
            }

            const exported = correlation.export();

            expect(exported.priceHistory).toBeDefined();
            expect(exported.correlationMatrix).toBeDefined();
            expect(Object.keys(exported.priceHistory).length).toBeGreaterThan(0);
        });

        it('should import data correctly', () => {
            const data = {
                priceHistory: {
                    'WBNB/USDT:pancakeswap': [
                        { price: 600, timestamp: Date.now(), blockNumber: 1000 },
                        { price: 610, timestamp: Date.now(), blockNumber: 1001 },
                    ],
                },
                correlationMatrix: {
                    'pool1': { 'pool2': 0.85 },
                },
            };

            correlation.import(data);

            expect(correlation.priceHistory.size).toBe(1);
            expect(correlation.correlationMatrix.size).toBe(1);
        });

        it('should rebuild pool groups on import', () => {
            const data = {
                priceHistory: {
                    'WBNB/USDT:pancakeswap': [
                        { price: 600, timestamp: Date.now(), blockNumber: 1000 },
                    ],
                },
                correlationMatrix: {},
            };

            correlation.import(data);

            expect(correlation.poolGroups.pairDexPools.has('WBNB/USDT')).toBe(true);
            expect(correlation.poolGroups.baseTokenPools.has('WBNB')).toBe(true);
        });
    });

    describe('getStats', () => {
        it('should return comprehensive stats', () => {
            correlation.recordPriceUpdate({
                pairKey: 'WBNB/USDT',
                dexName: 'pancakeswap',
                price: 600,
                blockNumber: 1000,
            });

            const stats = correlation.getStats();

            expect(stats.priceUpdatesProcessed).toBe(1);
            expect(stats.poolsTracked).toBe(1);
            expect(stats.pairGroups).toBe(1);
            expect(stats.baseTokenGroups).toBe(2); // WBNB and USDT
        });
    });

    describe('reset', () => {
        it('should clear all data', () => {
            correlation.recordPriceUpdate({
                pairKey: 'WBNB/USDT',
                dexName: 'pancakeswap',
                price: 600,
                blockNumber: 1000,
            });

            correlation.reset();

            expect(correlation.priceHistory.size).toBe(0);
            expect(correlation.correlationMatrix.size).toBe(0);
            expect(correlation.poolGroups.pairDexPools.size).toBe(0);
            expect(correlation.stats.priceUpdatesProcessed).toBe(0);
        });
    });
});
