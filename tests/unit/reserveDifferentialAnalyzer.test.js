import { ReserveDifferentialAnalyzer } from '../../src/analysis/reserveDifferentialAnalyzer.js';

// Mock token configuration for tests
const mockTokens = {
    WBNB: { symbol: 'WBNB', address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', decimals: 18 },
    USDT: { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
    BUSD: { symbol: 'BUSD', address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', decimals: 18 },
    CAKE: { symbol: 'CAKE', address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', decimals: 18 },
};

describe('ReserveDifferentialAnalyzer', () => {
    let analyzer;

    beforeEach(() => {
        analyzer = new ReserveDifferentialAnalyzer({
            significantChangeThreshold: 0.5,
            largeChangeThreshold: 2.0,
            maxHistoryAge: 30000,
            correlationWindow: 5000,
        });
    });

    afterEach(() => {
        analyzer.removeAllListeners();
        analyzer.clear();
    });

    describe('constructor', () => {
        it('should initialize with default config', () => {
            const defaultAnalyzer = new ReserveDifferentialAnalyzer();
            expect(defaultAnalyzer.significantChangeThreshold).toBe(0.5);
            expect(defaultAnalyzer.largeChangeThreshold).toBe(2.0);
            expect(defaultAnalyzer.maxHistoryAge).toBe(30000);
        });

        it('should initialize with custom config', () => {
            expect(analyzer.significantChangeThreshold).toBe(0.5);
            expect(analyzer.largeChangeThreshold).toBe(2.0);
            expect(analyzer.maxHistoryAge).toBe(30000);
            expect(analyzer.correlationWindow).toBe(5000);
        });

        it('should initialize empty maps', () => {
            expect(analyzer.reserveHistory.size).toBe(0);
            expect(analyzer.crossDexPairs.size).toBe(0);
        });

        it('should initialize statistics', () => {
            expect(analyzer.stats.updatesProcessed).toBe(0);
            expect(analyzer.stats.significantChanges).toBe(0);
            expect(analyzer.stats.largeChanges).toBe(0);
            expect(analyzer.stats.correlatedOpportunities).toBe(0);
            expect(analyzer.stats.priceDisparities).toBe(0);
        });
    });

    describe('processReserveUpdate', () => {
        it('should process first update and store history', () => {
            const data = {
                pairAddress: '0x1234567890123456789012345678901234567890',
                pairKey: 'WBNB/USDT',
                dexName: 'PancakeSwap',
                tokenA: mockTokens.WBNB,
                tokenB: mockTokens.USDT,
                reserves: {
                    reserve0: BigInt('1000000000000000000000'), // 1000 WBNB
                    reserve1: BigInt('500000000000000000000000'), // 500000 USDT
                },
                blockNumber: 12345,
                timestamp: Date.now(),
            };

            const result = analyzer.processReserveUpdate(data);

            expect(result.fullPairKey).toBe('WBNB/USDT:PancakeSwap');
            expect(result.baseKey).toBe('WBNB/USDT');
            expect(result.dexName).toBe('PancakeSwap');
            expect(result.changeMagnitude).toBeNull(); // No previous data
            expect(analyzer.stats.updatesProcessed).toBe(1);
        });

        it('should detect significant reserve change', () => {
            const baseData = {
                pairAddress: '0x1234567890123456789012345678901234567890',
                pairKey: 'WBNB/USDT',
                dexName: 'PancakeSwap',
                tokenA: mockTokens.WBNB,
                tokenB: mockTokens.USDT,
                blockNumber: 12345,
                timestamp: Date.now(),
            };

            // First update
            analyzer.processReserveUpdate({
                ...baseData,
                reserves: {
                    reserve0: BigInt('1000000000000000000000'), // 1000 WBNB
                    reserve1: BigInt('500000000000000000000000'), // 500000 USDT
                },
            });

            // Second update with 1% change (above 0.5% threshold)
            const result = analyzer.processReserveUpdate({
                ...baseData,
                reserves: {
                    reserve0: BigInt('990000000000000000000'), // 990 WBNB (-1%)
                    reserve1: BigInt('505000000000000000000000'), // 505000 USDT (+1%)
                },
                timestamp: Date.now() + 100,
            });

            expect(result.isSignificant).toBe(true);
            expect(result.changeMagnitude).toBeGreaterThanOrEqual(0.5);
            expect(analyzer.stats.significantChanges).toBe(1);
        });

        it('should detect large reserve change', () => {
            const baseData = {
                pairAddress: '0x1234567890123456789012345678901234567890',
                pairKey: 'WBNB/USDT',
                dexName: 'PancakeSwap',
                tokenA: mockTokens.WBNB,
                tokenB: mockTokens.USDT,
                blockNumber: 12345,
                timestamp: Date.now(),
            };

            // First update
            analyzer.processReserveUpdate({
                ...baseData,
                reserves: {
                    reserve0: BigInt('1000000000000000000000'),
                    reserve1: BigInt('500000000000000000000000'),
                },
            });

            // Second update with 3% change (above 2% large threshold)
            const result = analyzer.processReserveUpdate({
                ...baseData,
                reserves: {
                    reserve0: BigInt('970000000000000000000'), // -3%
                    reserve1: BigInt('515000000000000000000000'), // +3%
                },
                timestamp: Date.now() + 100,
            });

            expect(result.isLarge).toBe(true);
            expect(result.isSignificant).toBe(true);
            expect(analyzer.stats.largeChanges).toBe(1);
        });

        it('should track price change direction', () => {
            const baseData = {
                pairAddress: '0x1234567890123456789012345678901234567890',
                pairKey: 'WBNB/USDT',
                dexName: 'PancakeSwap',
                tokenA: mockTokens.WBNB,
                tokenB: mockTokens.USDT,
                blockNumber: 12345,
                timestamp: Date.now(),
            };

            // First update
            analyzer.processReserveUpdate({
                ...baseData,
                reserves: {
                    reserve0: BigInt('1000000000000000000000'),
                    reserve1: BigInt('500000000000000000000000'),
                },
            });

            // Buy pressure (reserve0 decreases)
            const buyResult = analyzer.processReserveUpdate({
                ...baseData,
                reserves: {
                    reserve0: BigInt('950000000000000000000'), // -5%
                    reserve1: BigInt('526000000000000000000000'),
                },
                timestamp: Date.now() + 100,
            });

            expect(buyResult.changeDirection).toBe('buy');
        });
    });

    describe('cross-DEX correlation', () => {
        it('should register pairs across multiple DEXs', () => {
            const baseData = {
                pairKey: 'WBNB/USDT',
                tokenA: mockTokens.WBNB,
                tokenB: mockTokens.USDT,
                blockNumber: 12345,
                timestamp: Date.now(),
            };

            // Update from PancakeSwap
            analyzer.processReserveUpdate({
                ...baseData,
                pairAddress: '0x1111111111111111111111111111111111111111',
                dexName: 'PancakeSwap',
                reserves: {
                    reserve0: BigInt('1000000000000000000000'),
                    reserve1: BigInt('500000000000000000000000'),
                },
            });

            // Update from Biswap
            analyzer.processReserveUpdate({
                ...baseData,
                pairAddress: '0x2222222222222222222222222222222222222222',
                dexName: 'Biswap',
                reserves: {
                    reserve0: BigInt('800000000000000000000'),
                    reserve1: BigInt('400000000000000000000000'),
                },
            });

            expect(analyzer.crossDexPairs.has('WBNB/USDT')).toBe(true);
            expect(analyzer.crossDexPairs.get('WBNB/USDT').size).toBe(2);
        });

        it('should detect cross-DEX price disparity opportunity', (done) => {
            const baseData = {
                pairKey: 'WBNB/USDT',
                tokenA: mockTokens.WBNB,
                tokenB: mockTokens.USDT,
                blockNumber: 12345,
            };

            // Initial update from PancakeSwap - price 500 USDT per WBNB
            analyzer.processReserveUpdate({
                ...baseData,
                pairAddress: '0x1111111111111111111111111111111111111111',
                dexName: 'PancakeSwap',
                reserves: {
                    reserve0: BigInt('1000000000000000000000'), // 1000 WBNB
                    reserve1: BigInt('500000000000000000000000'), // 500000 USDT
                },
                timestamp: Date.now(),
            });

            // Initial update from Biswap - same price
            analyzer.processReserveUpdate({
                ...baseData,
                pairAddress: '0x2222222222222222222222222222222222222222',
                dexName: 'Biswap',
                reserves: {
                    reserve0: BigInt('1000000000000000000000'),
                    reserve1: BigInt('500000000000000000000000'),
                },
                timestamp: Date.now(),
            });

            // Set up event listener for opportunity
            analyzer.on('correlatedOpportunity', (data) => {
                try {
                    expect(data.opportunity).not.toBeNull();
                    expect(data.opportunity.type).toBe('cross-dex-differential');
                    expect(data.opportunity.spreadPercent).toBeGreaterThan(0.5);
                    done();
                } catch (e) {
                    done(e);
                }
            });

            // Significant price change on PancakeSwap (price moves to 505 USDT per WBNB)
            // This creates a 1% spread vs Biswap which is still at 500
            analyzer.processReserveUpdate({
                ...baseData,
                pairAddress: '0x1111111111111111111111111111111111111111',
                dexName: 'PancakeSwap',
                reserves: {
                    reserve0: BigInt('980000000000000000000'), // -2% WBNB
                    reserve1: BigInt('510000000000000000000000'), // +2% USDT (price up ~4%)
                },
                timestamp: Date.now() + 100,
            });
        });
    });

    describe('getPriceDisparity', () => {
        beforeEach(() => {
            const baseData = {
                pairKey: 'WBNB/USDT',
                tokenA: mockTokens.WBNB,
                tokenB: mockTokens.USDT,
                blockNumber: 12345,
                timestamp: Date.now(),
            };

            // PancakeSwap - price 500
            analyzer.processReserveUpdate({
                ...baseData,
                pairAddress: '0x1111111111111111111111111111111111111111',
                dexName: 'PancakeSwap',
                reserves: {
                    reserve0: BigInt('1000000000000000000000'),
                    reserve1: BigInt('500000000000000000000000'),
                },
            });

            // Biswap - price 510 (2% higher)
            analyzer.processReserveUpdate({
                ...baseData,
                pairAddress: '0x2222222222222222222222222222222222222222',
                dexName: 'Biswap',
                reserves: {
                    reserve0: BigInt('1000000000000000000000'),
                    reserve1: BigInt('510000000000000000000000'),
                },
            });
        });

        it('should return price disparity info', () => {
            const disparity = analyzer.getPriceDisparity('WBNB/USDT');

            expect(disparity).not.toBeNull();
            expect(disparity.baseKey).toBe('WBNB/USDT');
            expect(disparity.lowest).toBeDefined();
            expect(disparity.highest).toBeDefined();
            expect(disparity.spreadPercent).toBeGreaterThan(0);
        });

        it('should identify correct buy/sell DEXs', () => {
            const disparity = analyzer.getPriceDisparity('WBNB/USDT');

            expect(disparity.lowest.dexName).toBe('PancakeSwap');
            expect(disparity.highest.dexName).toBe('Biswap');
        });

        it('should return null for unknown pair', () => {
            const disparity = analyzer.getPriceDisparity('UNKNOWN/PAIR');
            expect(disparity).toBeNull();
        });

        it('should return null for pair with single DEX', () => {
            const singleAnalyzer = new ReserveDifferentialAnalyzer();
            singleAnalyzer.processReserveUpdate({
                pairAddress: '0x1111111111111111111111111111111111111111',
                pairKey: 'CAKE/BUSD',
                dexName: 'PancakeSwap',
                tokenA: mockTokens.CAKE,
                tokenB: mockTokens.BUSD,
                reserves: {
                    reserve0: BigInt('1000000000000000000000'),
                    reserve1: BigInt('2000000000000000000000'),
                },
                blockNumber: 12345,
                timestamp: Date.now(),
            });

            const disparity = singleAnalyzer.getPriceDisparity('CAKE/BUSD');
            expect(disparity).toBeNull();
        });
    });

    describe('getAllPriceDisparities', () => {
        it('should return all disparities above threshold', () => {
            // Set up two pairs with different spreads
            const timestamp = Date.now();

            // WBNB/USDT with 2% spread
            analyzer.processReserveUpdate({
                pairAddress: '0x1111',
                pairKey: 'WBNB/USDT',
                dexName: 'DEX1',
                tokenA: mockTokens.WBNB,
                tokenB: mockTokens.USDT,
                reserves: { reserve0: BigInt('1000000000000000000000'), reserve1: BigInt('500000000000000000000000') },
                blockNumber: 1,
                timestamp,
            });
            analyzer.processReserveUpdate({
                pairAddress: '0x2222',
                pairKey: 'WBNB/USDT',
                dexName: 'DEX2',
                tokenA: mockTokens.WBNB,
                tokenB: mockTokens.USDT,
                reserves: { reserve0: BigInt('1000000000000000000000'), reserve1: BigInt('510000000000000000000000') },
                blockNumber: 1,
                timestamp,
            });

            // CAKE/BUSD with 0.1% spread (below 0.3% threshold)
            analyzer.processReserveUpdate({
                pairAddress: '0x3333',
                pairKey: 'CAKE/BUSD',
                dexName: 'DEX1',
                tokenA: mockTokens.CAKE,
                tokenB: mockTokens.BUSD,
                reserves: { reserve0: BigInt('1000000000000000000000'), reserve1: BigInt('2000000000000000000000') },
                blockNumber: 1,
                timestamp,
            });
            analyzer.processReserveUpdate({
                pairAddress: '0x4444',
                pairKey: 'CAKE/BUSD',
                dexName: 'DEX2',
                tokenA: mockTokens.CAKE,
                tokenB: mockTokens.BUSD,
                reserves: { reserve0: BigInt('1000000000000000000000'), reserve1: BigInt('2002000000000000000000') },
                blockNumber: 1,
                timestamp,
            });

            const disparities = analyzer.getAllPriceDisparities(0.3);

            expect(disparities.length).toBe(1);
            expect(disparities[0].baseKey).toBe('WBNB/USDT');
        });

        it('should sort disparities by spread descending', () => {
            const timestamp = Date.now();

            // 1% spread
            analyzer.processReserveUpdate({
                pairAddress: '0x1111',
                pairKey: 'PAIR1',
                dexName: 'DEX1',
                tokenA: mockTokens.WBNB,
                tokenB: mockTokens.USDT,
                reserves: { reserve0: BigInt('1000000000000000000000'), reserve1: BigInt('500000000000000000000000') },
                blockNumber: 1,
                timestamp,
            });
            analyzer.processReserveUpdate({
                pairAddress: '0x2222',
                pairKey: 'PAIR1',
                dexName: 'DEX2',
                tokenA: mockTokens.WBNB,
                tokenB: mockTokens.USDT,
                reserves: { reserve0: BigInt('1000000000000000000000'), reserve1: BigInt('505000000000000000000000') },
                blockNumber: 1,
                timestamp,
            });

            // 3% spread
            analyzer.processReserveUpdate({
                pairAddress: '0x3333',
                pairKey: 'PAIR2',
                dexName: 'DEX1',
                tokenA: mockTokens.CAKE,
                tokenB: mockTokens.BUSD,
                reserves: { reserve0: BigInt('1000000000000000000000'), reserve1: BigInt('2000000000000000000000') },
                blockNumber: 1,
                timestamp,
            });
            analyzer.processReserveUpdate({
                pairAddress: '0x4444',
                pairKey: 'PAIR2',
                dexName: 'DEX2',
                tokenA: mockTokens.CAKE,
                tokenB: mockTokens.BUSD,
                reserves: { reserve0: BigInt('1000000000000000000000'), reserve1: BigInt('2060000000000000000000') },
                blockNumber: 1,
                timestamp,
            });

            const disparities = analyzer.getAllPriceDisparities(0.3);

            expect(disparities.length).toBe(2);
            expect(disparities[0].baseKey).toBe('PAIR2'); // Higher spread first
            expect(disparities[1].baseKey).toBe('PAIR1');
        });
    });

    describe('getRecentSignificantChanges', () => {
        it('should return recent changes within time window', () => {
            const now = Date.now();

            analyzer.processReserveUpdate({
                pairAddress: '0x1111',
                pairKey: 'WBNB/USDT',
                dexName: 'PancakeSwap',
                tokenA: mockTokens.WBNB,
                tokenB: mockTokens.USDT,
                reserves: { reserve0: BigInt('1000000000000000000000'), reserve1: BigInt('500000000000000000000000') },
                blockNumber: 1,
                timestamp: now,
            });

            const recent = analyzer.getRecentSignificantChanges(5000);
            expect(recent.length).toBe(1);
        });
    });

    describe('cleanup', () => {
        it('should remove old history entries', () => {
            // Manually set old timestamp
            analyzer.reserveHistory.set('old:entry', {
                reserves: { reserve0: '1000', reserve1: '2000' },
                timestamp: Date.now() - 100000, // Very old
                blockNumber: 1,
            });

            analyzer.reserveHistory.set('recent:entry', {
                reserves: { reserve0: '1000', reserve1: '2000' },
                timestamp: Date.now(),
                blockNumber: 2,
            });

            analyzer.cleanup();

            expect(analyzer.reserveHistory.has('old:entry')).toBe(false);
            expect(analyzer.reserveHistory.has('recent:entry')).toBe(true);
        });

        it('should clean up empty cross-DEX maps', () => {
            // Set up old cross-DEX entry
            const oldDexMap = new Map();
            oldDexMap.set('OldDEX', {
                fullPairKey: 'OLD:OldDEX',
                price: 100,
                timestamp: Date.now() - 100000,
            });
            analyzer.crossDexPairs.set('OLD', oldDexMap);

            analyzer.cleanup();

            expect(analyzer.crossDexPairs.has('OLD')).toBe(false);
        });
    });

    describe('statistics', () => {
        it('should return comprehensive stats', () => {
            analyzer.processReserveUpdate({
                pairAddress: '0x1111',
                pairKey: 'WBNB/USDT',
                dexName: 'PancakeSwap',
                tokenA: mockTokens.WBNB,
                tokenB: mockTokens.USDT,
                reserves: { reserve0: BigInt('1000000000000000000000'), reserve1: BigInt('500000000000000000000000') },
                blockNumber: 1,
                timestamp: Date.now(),
            });

            const stats = analyzer.getStats();

            expect(stats.updatesProcessed).toBe(1);
            expect(stats.trackedPairs).toBe(1);
            expect(stats.crossDexPairs).toBe(1);
        });

        it('should reset stats correctly', () => {
            analyzer.stats.updatesProcessed = 100;
            analyzer.stats.significantChanges = 50;

            analyzer.resetStats();

            expect(analyzer.stats.updatesProcessed).toBe(0);
            expect(analyzer.stats.significantChanges).toBe(0);
        });
    });

    describe('clear', () => {
        it('should clear all data', () => {
            analyzer.processReserveUpdate({
                pairAddress: '0x1111',
                pairKey: 'WBNB/USDT',
                dexName: 'PancakeSwap',
                tokenA: mockTokens.WBNB,
                tokenB: mockTokens.USDT,
                reserves: { reserve0: BigInt('1000000000000000000000'), reserve1: BigInt('500000000000000000000000') },
                blockNumber: 1,
                timestamp: Date.now(),
            });

            analyzer.clear();

            expect(analyzer.reserveHistory.size).toBe(0);
            expect(analyzer.crossDexPairs.size).toBe(0);
            expect(analyzer.stats.updatesProcessed).toBe(0);
        });
    });

    describe('price calculation', () => {
        it('should calculate price correctly with same decimals', () => {
            analyzer.processReserveUpdate({
                pairAddress: '0x1111',
                pairKey: 'WBNB/USDT',
                dexName: 'PancakeSwap',
                tokenA: mockTokens.WBNB,
                tokenB: mockTokens.USDT,
                reserves: {
                    reserve0: BigInt('1000000000000000000000'), // 1000 WBNB
                    reserve1: BigInt('500000000000000000000000'), // 500000 USDT
                },
                blockNumber: 1,
                timestamp: Date.now(),
            });

            const history = analyzer.reserveHistory.get('WBNB/USDT:PancakeSwap');
            // Price should be approximately 500 USDT per WBNB
            expect(history.price).toBeCloseTo(500, 0);
        });

        it('should handle zero reserves', () => {
            // Should not throw
            analyzer.processReserveUpdate({
                pairAddress: '0x1111',
                pairKey: 'WBNB/USDT',
                dexName: 'PancakeSwap',
                tokenA: mockTokens.WBNB,
                tokenB: mockTokens.USDT,
                reserves: {
                    reserve0: BigInt('0'),
                    reserve1: BigInt('500000000000000000000000'),
                },
                blockNumber: 1,
                timestamp: Date.now(),
            });

            const history = analyzer.reserveHistory.get('WBNB/USDT:PancakeSwap');
            expect(history.price).toBe(0);
        });
    });

    describe('event emission', () => {
        it('should emit reserveAnalyzed event on each update', (done) => {
            analyzer.on('reserveAnalyzed', (result) => {
                try {
                    expect(result.fullPairKey).toBe('WBNB/USDT:PancakeSwap');
                    done();
                } catch (e) {
                    done(e);
                }
            });

            analyzer.processReserveUpdate({
                pairAddress: '0x1111',
                pairKey: 'WBNB/USDT',
                dexName: 'PancakeSwap',
                tokenA: mockTokens.WBNB,
                tokenB: mockTokens.USDT,
                reserves: { reserve0: BigInt('1000000000000000000000'), reserve1: BigInt('500000000000000000000000') },
                blockNumber: 1,
                timestamp: Date.now(),
            });
        });
    });
});
