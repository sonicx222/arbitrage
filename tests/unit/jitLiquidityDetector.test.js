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
const { JITLiquidityDetector, default: jitLiquidityDetector } = await import('../../src/analysis/jitLiquidityDetector.js');

describe('JITLiquidityDetector', () => {
    let detector;

    beforeEach(() => {
        detector = new JITLiquidityDetector();
    });

    describe('constructor', () => {
        test('should initialize with default values', () => {
            expect(detector.jitWindowBlocks).toBe(2);
            expect(detector.minLiquidityUSD).toBe(10000);
            expect(detector.minAddRemoveRatio).toBe(0.8);
            expect(detector.maxTickRange).toBe(200);
        });

        test('should accept custom configuration', () => {
            const custom = new JITLiquidityDetector({
                jitWindowBlocks: 3,
                minLiquidityUSD: 5000,
                minAddRemoveRatio: 0.9,
                maxTickRange: 100,
            });

            expect(custom.jitWindowBlocks).toBe(3);
            expect(custom.minLiquidityUSD).toBe(5000);
            expect(custom.minAddRemoveRatio).toBe(0.9);
            expect(custom.maxTickRange).toBe(100);
        });

        test('should initialize empty tracking state', () => {
            expect(detector.pendingMints.size).toBe(0);
            expect(detector.recentJITEvents.length).toBe(0);
            expect(detector.poolStats.size).toBe(0);
        });
    });

    describe('recordMint', () => {
        test('should record a valid mint event', () => {
            const mint = detector.recordMint({
                chainId: 56,
                poolAddress: '0xPool123',
                sender: '0xSender',
                owner: '0xOwner123',
                tickLower: -100,
                tickUpper: 100,
                amount: 1000000n,
                amount0: 500000000000000000n,
                amount1: 600000000000000000n,
                blockNumber: 1000,
                transactionHash: '0xTx123',
                liquidityUSD: 15000,
            });

            expect(mint).not.toBeNull();
            expect(mint.isConcentrated).toBe(true);
            expect(mint.tickRange).toBe(200);
            expect(detector.pendingMints.size).toBe(1);
            expect(detector.stats.mintsTracked).toBe(1);
        });

        test('should reject mint below minimum liquidity', () => {
            const mint = detector.recordMint({
                chainId: 56,
                poolAddress: '0xPool123',
                owner: '0xOwner123',
                tickLower: -100,
                tickUpper: 100,
                amount: 1000n,
                blockNumber: 1000,
                transactionHash: '0xTx123',
                liquidityUSD: 500, // Below 10000 threshold
            });

            expect(mint).toBeNull();
            expect(detector.pendingMints.size).toBe(0);
        });

        test('should detect concentrated liquidity', () => {
            const concentrated = detector.recordMint({
                chainId: 56,
                poolAddress: '0xPool123',
                owner: '0xOwner123',
                tickLower: -50,
                tickUpper: 50, // Range of 100 ticks
                amount: 1000000n,
                blockNumber: 1000,
                transactionHash: '0xTx123',
                liquidityUSD: 15000,
            });

            expect(concentrated.isConcentrated).toBe(true);
            expect(concentrated.tickRange).toBe(100);
        });

        test('should detect non-concentrated liquidity', () => {
            const spread = detector.recordMint({
                chainId: 56,
                poolAddress: '0xPool123',
                owner: '0xOwner123',
                tickLower: -500,
                tickUpper: 500, // Range of 1000 ticks
                amount: 1000000n,
                blockNumber: 1000,
                transactionHash: '0xTx123',
                liquidityUSD: 15000,
            });

            expect(spread.isConcentrated).toBe(false);
            expect(spread.tickRange).toBe(1000);
        });

        test('should emit potentialJIT for large concentrated mints', (done) => {
            detector.on('potentialJIT', (event) => {
                expect(event.type).toBe('mint');
                expect(event.confidence).toBe('medium');
                expect(event.isConcentrated).toBe(true);
                done();
            });

            detector.recordMint({
                chainId: 56,
                poolAddress: '0xPool123',
                owner: '0xOwner123',
                tickLower: -50,
                tickUpper: 50,
                amount: 1000000n,
                blockNumber: 1000,
                transactionHash: '0xTx123',
                liquidityUSD: 25000, // > 2x minimum
            });
        });
    });

    describe('recordBurn', () => {
        test('should detect JIT pattern when burn matches mint', () => {
            // Record mint
            detector.recordMint({
                chainId: 56,
                poolAddress: '0xPool123',
                owner: '0xOwner123',
                tickLower: -100,
                tickUpper: 100,
                amount: 1000000n,
                amount0: 500000000000000000n,
                amount1: 600000000000000000n,
                blockNumber: 1000,
                transactionHash: '0xMintTx',
                liquidityUSD: 15000,
            });

            // Record matching burn within JIT window
            const jit = detector.recordBurn({
                chainId: 56,
                poolAddress: '0xPool123',
                owner: '0xOwner123',
                tickLower: -100,
                tickUpper: 100,
                amount: 950000n, // 95% of original (> 80% threshold)
                amount0: 520000000000000000n,
                amount1: 620000000000000000n,
                blockNumber: 1001, // 1 block later
                transactionHash: '0xBurnTx',
            });

            expect(jit).not.toBeNull();
            expect(jit.blockDuration).toBe(1);
            expect(jit.mintTxHash).toBe('0xMintTx');
            expect(jit.burnTxHash).toBe('0xBurnTx');
            expect(detector.stats.jitDetected).toBe(1);
        });

        test('should not detect JIT if burn is outside window', () => {
            detector.recordMint({
                chainId: 56,
                poolAddress: '0xPool123',
                owner: '0xOwner123',
                tickLower: -100,
                tickUpper: 100,
                amount: 1000000n,
                blockNumber: 1000,
                transactionHash: '0xMintTx',
                liquidityUSD: 15000,
            });

            const jit = detector.recordBurn({
                chainId: 56,
                poolAddress: '0xPool123',
                owner: '0xOwner123',
                tickLower: -100,
                tickUpper: 100,
                amount: 1000000n,
                blockNumber: 1010, // 10 blocks later (outside window)
                transactionHash: '0xBurnTx',
            });

            expect(jit).toBeNull();
        });

        test('should not detect JIT if tick range does not match', () => {
            detector.recordMint({
                chainId: 56,
                poolAddress: '0xPool123',
                owner: '0xOwner123',
                tickLower: -100,
                tickUpper: 100,
                amount: 1000000n,
                blockNumber: 1000,
                transactionHash: '0xMintTx',
                liquidityUSD: 15000,
            });

            const jit = detector.recordBurn({
                chainId: 56,
                poolAddress: '0xPool123',
                owner: '0xOwner123',
                tickLower: -200, // Different tick range
                tickUpper: 200,
                amount: 1000000n,
                blockNumber: 1001,
                transactionHash: '0xBurnTx',
            });

            expect(jit).toBeNull();
        });

        test('should not detect JIT if liquidity ratio is too low', () => {
            detector.recordMint({
                chainId: 56,
                poolAddress: '0xPool123',
                owner: '0xOwner123',
                tickLower: -100,
                tickUpper: 100,
                amount: 1000000n,
                blockNumber: 1000,
                transactionHash: '0xMintTx',
                liquidityUSD: 15000,
            });

            const jit = detector.recordBurn({
                chainId: 56,
                poolAddress: '0xPool123',
                owner: '0xOwner123',
                tickLower: -100,
                tickUpper: 100,
                amount: 500000n, // Only 50% (< 80% threshold)
                blockNumber: 1001,
                transactionHash: '0xBurnTx',
            });

            expect(jit).toBeNull();
        });

        test('should emit jitDetected event', (done) => {
            detector.on('jitDetected', (event) => {
                expect(event.blockDuration).toBe(1);
                expect(event.poolAddress).toBe('0xPool123');
                done();
            });

            detector.recordMint({
                chainId: 56,
                poolAddress: '0xPool123',
                owner: '0xOwner123',
                tickLower: -100,
                tickUpper: 100,
                amount: 1000000n,
                blockNumber: 1000,
                transactionHash: '0xMintTx',
                liquidityUSD: 15000,
            });

            detector.recordBurn({
                chainId: 56,
                poolAddress: '0xPool123',
                owner: '0xOwner123',
                tickLower: -100,
                tickUpper: 100,
                amount: 1000000n,
                blockNumber: 1001,
                transactionHash: '0xBurnTx',
            });
        });

        test('should calculate fees earned', () => {
            detector.recordMint({
                chainId: 56,
                poolAddress: '0xPool123',
                owner: '0xOwner123',
                tickLower: -100,
                tickUpper: 100,
                amount: 1000000n,
                amount0: 500000000000000000n,
                amount1: 600000000000000000n,
                blockNumber: 1000,
                transactionHash: '0xMintTx',
                liquidityUSD: 15000,
            });

            const jit = detector.recordBurn({
                chainId: 56,
                poolAddress: '0xPool123',
                owner: '0xOwner123',
                tickLower: -100,
                tickUpper: 100,
                amount: 1000000n,
                amount0: 510000000000000000n, // Slightly more (fees)
                amount1: 610000000000000000n,
                blockNumber: 1001,
                transactionHash: '0xBurnTx',
            });

            expect(jit.feesEarned).toBeDefined();
            expect(jit.feesEarned.token0).toBeGreaterThan(0);
            expect(jit.feesEarned.token1).toBeGreaterThan(0);
        });
    });

    describe('analyzePool', () => {
        test('should return no activity for unknown pool', () => {
            const analysis = detector.analyzePool('0xUnknownPool');

            expect(analysis.hasJITActivity).toBe(false);
            expect(analysis.jitCount).toBe(0);
        });

        test('should analyze pool with JIT activity', () => {
            // Simulate multiple JIT events
            for (let i = 0; i < 5; i++) {
                detector.recordMint({
                    chainId: 56,
                    poolAddress: '0xActivePool',
                    owner: `0xOwner${i}`,
                    tickLower: -100,
                    tickUpper: 100,
                    amount: 1000000n,
                    blockNumber: 1000 + i * 10,
                    transactionHash: `0xMint${i}`,
                    liquidityUSD: 15000,
                });

                detector.recordBurn({
                    chainId: 56,
                    poolAddress: '0xActivePool',
                    owner: `0xOwner${i}`,
                    tickLower: -100,
                    tickUpper: 100,
                    amount: 1000000n,
                    blockNumber: 1001 + i * 10,
                    transactionHash: `0xBurn${i}`,
                });
            }

            const analysis = detector.analyzePool('0xActivePool');

            expect(analysis.hasJITActivity).toBe(true);
            expect(analysis.jitCount).toBe(5);
            expect(analysis.jitFrequency).toBe('medium');
            expect(analysis.uniqueProviders).toBe(5);
        });

        test('should classify high frequency JIT pools', () => {
            // Simulate 15 JIT events
            for (let i = 0; i < 15; i++) {
                detector.recordMint({
                    chainId: 56,
                    poolAddress: '0xHighJITPool',
                    owner: '0xOwner',
                    tickLower: -100,
                    tickUpper: 100,
                    amount: 1000000n,
                    blockNumber: 1000 + i * 10,
                    transactionHash: `0xMint${i}`,
                    liquidityUSD: 15000,
                });

                detector.recordBurn({
                    chainId: 56,
                    poolAddress: '0xHighJITPool',
                    owner: '0xOwner',
                    tickLower: -100,
                    tickUpper: 100,
                    amount: 1000000n,
                    blockNumber: 1001 + i * 10,
                    transactionHash: `0xBurn${i}`,
                });
            }

            const analysis = detector.analyzePool('0xHighJITPool');

            expect(analysis.jitFrequency).toBe('high');
            expect(analysis.recommendation).toContain('High JIT activity');
        });
    });

    describe('predictJIT', () => {
        test('should predict low likelihood for unknown pool', () => {
            const prediction = detector.predictJIT({
                poolAddress: '0xUnknownPool',
                tradeSizeUSD: 10000,
            });

            expect(prediction.jitLikelihood).toBe(0);
            expect(prediction.recommendation).toContain('unlikely');
        });

        test('should predict higher likelihood for active JIT pools', () => {
            // Create JIT history
            for (let i = 0; i < 12; i++) {
                detector.recordMint({
                    chainId: 56,
                    poolAddress: '0xJITPool',
                    owner: '0xOwner',
                    tickLower: -100,
                    tickUpper: 100,
                    amount: 1000000n,
                    blockNumber: 1000 + i * 10,
                    transactionHash: `0xMint${i}`,
                    liquidityUSD: 15000,
                });

                detector.recordBurn({
                    chainId: 56,
                    poolAddress: '0xJITPool',
                    owner: '0xOwner',
                    tickLower: -100,
                    tickUpper: 100,
                    amount: 1000000n,
                    blockNumber: 1001 + i * 10,
                    transactionHash: `0xBurn${i}`,
                });
            }

            const prediction = detector.predictJIT({
                poolAddress: '0xJITPool',
                tradeSizeUSD: 60000,
            });

            expect(prediction.jitLikelihood).toBeGreaterThan(0.5);
            expect(prediction.recommendation).toContain('likely');
            expect(prediction.expectedImpact).not.toBeNull();
        });

        test('should increase likelihood for larger trades', () => {
            // Create moderate JIT history
            for (let i = 0; i < 5; i++) {
                detector.recordMint({
                    chainId: 56,
                    poolAddress: '0xPool',
                    owner: '0xOwner',
                    tickLower: -100,
                    tickUpper: 100,
                    amount: 1000000n,
                    blockNumber: 1000 + i * 10,
                    transactionHash: `0xMint${i}`,
                    liquidityUSD: 15000,
                });

                detector.recordBurn({
                    chainId: 56,
                    poolAddress: '0xPool',
                    owner: '0xOwner',
                    tickLower: -100,
                    tickUpper: 100,
                    amount: 1000000n,
                    blockNumber: 1001 + i * 10,
                    transactionHash: `0xBurn${i}`,
                });
            }

            const smallTrade = detector.predictJIT({
                poolAddress: '0xPool',
                tradeSizeUSD: 5000,
            });

            const largeTrade = detector.predictJIT({
                poolAddress: '0xPool',
                tradeSizeUSD: 100000,
            });

            expect(largeTrade.jitLikelihood).toBeGreaterThan(smallTrade.jitLikelihood);
        });
    });

    describe('getRecentJITEvents', () => {
        test('should return empty array when no events', () => {
            const events = detector.getRecentJITEvents();
            expect(events).toEqual([]);
        });

        test('should return recent JIT events', () => {
            // Create some JIT events
            for (let i = 0; i < 3; i++) {
                detector.recordMint({
                    chainId: 56,
                    poolAddress: '0xPool',
                    owner: '0xOwner',
                    tickLower: -100,
                    tickUpper: 100,
                    amount: 1000000n,
                    blockNumber: 1000 + i * 10,
                    transactionHash: `0xMint${i}`,
                    liquidityUSD: 15000,
                });

                detector.recordBurn({
                    chainId: 56,
                    poolAddress: '0xPool',
                    owner: '0xOwner',
                    tickLower: -100,
                    tickUpper: 100,
                    amount: 1000000n,
                    blockNumber: 1001 + i * 10,
                    transactionHash: `0xBurn${i}`,
                });
            }

            const events = detector.getRecentJITEvents();

            expect(events.length).toBe(3);
            // Should be newest first
            expect(events[0].burnBlockNumber).toBeGreaterThan(events[2].burnBlockNumber);
        });

        test('should filter by chain ID', () => {
            // Create events on different chains
            detector.recordMint({
                chainId: 56,
                poolAddress: '0xBSCPool',
                owner: '0xOwner',
                tickLower: -100,
                tickUpper: 100,
                amount: 1000000n,
                blockNumber: 1000,
                transactionHash: '0xMint1',
                liquidityUSD: 15000,
            });
            detector.recordBurn({
                chainId: 56,
                poolAddress: '0xBSCPool',
                owner: '0xOwner',
                tickLower: -100,
                tickUpper: 100,
                amount: 1000000n,
                blockNumber: 1001,
                transactionHash: '0xBurn1',
            });

            detector.recordMint({
                chainId: 1,
                poolAddress: '0xETHPool',
                owner: '0xOwner',
                tickLower: -100,
                tickUpper: 100,
                amount: 1000000n,
                blockNumber: 1000,
                transactionHash: '0xMint2',
                liquidityUSD: 15000,
            });
            detector.recordBurn({
                chainId: 1,
                poolAddress: '0xETHPool',
                owner: '0xOwner',
                tickLower: -100,
                tickUpper: 100,
                amount: 1000000n,
                blockNumber: 1001,
                transactionHash: '0xBurn2',
            });

            const bscEvents = detector.getRecentJITEvents(56);
            const ethEvents = detector.getRecentJITEvents(1);

            expect(bscEvents.length).toBe(1);
            expect(ethEvents.length).toBe(1);
            expect(bscEvents[0].chainId).toBe(56);
            expect(ethEvents[0].chainId).toBe(1);
        });
    });

    describe('getTopJITPools', () => {
        test('should return empty array when no pools', () => {
            const pools = detector.getTopJITPools();
            expect(pools).toEqual([]);
        });

        test('should return pools sorted by JIT count', () => {
            // Create different activity levels
            const poolCounts = [
                { pool: '0xPool1', count: 3 },
                { pool: '0xPool2', count: 10 },
                { pool: '0xPool3', count: 5 },
            ];

            for (const { pool, count } of poolCounts) {
                for (let i = 0; i < count; i++) {
                    detector.recordMint({
                        chainId: 56,
                        poolAddress: pool,
                        owner: '0xOwner',
                        tickLower: -100,
                        tickUpper: 100,
                        amount: 1000000n,
                        blockNumber: 1000 + i * 10,
                        transactionHash: `0xMint${pool}${i}`,
                        liquidityUSD: 15000,
                    });

                    detector.recordBurn({
                        chainId: 56,
                        poolAddress: pool,
                        owner: '0xOwner',
                        tickLower: -100,
                        tickUpper: 100,
                        amount: 1000000n,
                        blockNumber: 1001 + i * 10,
                        transactionHash: `0xBurn${pool}${i}`,
                    });
                }
            }

            const topPools = detector.getTopJITPools(3);

            expect(topPools.length).toBe(3);
            expect(topPools[0].address).toBe('0xPool2');
            expect(topPools[0].jitCount).toBe(10);
            expect(topPools[1].address).toBe('0xPool3');
            expect(topPools[2].address).toBe('0xPool1');
        });
    });

    describe('findJITArbitrage', () => {
        test('should return null without market prices', () => {
            const jitEvent = {
                poolAddress: '0xPool',
                tickLower: -100,
                tickUpper: 100,
                liquidityUSD: 15000,
            };

            const arb = detector.findJITArbitrage(jitEvent, null);
            expect(arb).toBeNull();
        });

        test('should find arbitrage opportunity with price discrepancy', () => {
            const jitEvent = {
                poolAddress: '0xJITPool',
                tickLower: -10,
                tickUpper: 10,
                liquidityUSD: 50000,
            };

            // Mid price of ticks -10 to 10 is ~1.0
            const marketPrices = {
                pools: {
                    '0xJITPool': 1.0,
                    '0xOtherPool': 1.02, // 2% higher
                },
            };

            const arb = detector.findJITArbitrage(jitEvent, marketPrices);

            expect(arb).not.toBeNull();
            expect(arb.type).toBe('jit-arbitrage');
            expect(arb.spread).toBeGreaterThan(0.003);
        });

        test('should not find arbitrage if spread too small', () => {
            const jitEvent = {
                poolAddress: '0xJITPool',
                tickLower: -10,
                tickUpper: 10,
                liquidityUSD: 50000,
            };

            const marketPrices = {
                pools: {
                    '0xJITPool': 1.0,
                    '0xOtherPool': 1.001, // 0.1% - too small
                },
            };

            const arb = detector.findJITArbitrage(jitEvent, marketPrices);
            expect(arb).toBeNull();
        });
    });

    describe('getStats', () => {
        test('should return comprehensive statistics', () => {
            // Create some activity
            detector.recordMint({
                chainId: 56,
                poolAddress: '0xPool',
                owner: '0xOwner',
                tickLower: -100,
                tickUpper: 100,
                amount: 1000000n,
                blockNumber: 1000,
                transactionHash: '0xMint',
                liquidityUSD: 15000,
            });

            detector.recordBurn({
                chainId: 56,
                poolAddress: '0xPool',
                owner: '0xOwner',
                tickLower: -100,
                tickUpper: 100,
                amount: 1000000n,
                blockNumber: 1001,
                transactionHash: '0xBurn',
            });

            const stats = detector.getStats();

            expect(stats.mintsTracked).toBe(1);
            expect(stats.jitDetected).toBe(1);
            expect(stats.poolsTracked).toBe(1);
            expect(stats.recentEvents).toBe(1);
            expect(stats.topPools).toBeDefined();
        });
    });

    describe('reset', () => {
        test('should clear all tracking state', () => {
            // Create some activity
            detector.recordMint({
                chainId: 56,
                poolAddress: '0xPool',
                owner: '0xOwner',
                tickLower: -100,
                tickUpper: 100,
                amount: 1000000n,
                blockNumber: 1000,
                transactionHash: '0xMint',
                liquidityUSD: 15000,
            });

            detector.recordBurn({
                chainId: 56,
                poolAddress: '0xPool',
                owner: '0xOwner',
                tickLower: -100,
                tickUpper: 100,
                amount: 1000000n,
                blockNumber: 1001,
                transactionHash: '0xBurn',
            });

            detector.reset();

            expect(detector.pendingMints.size).toBe(0);
            expect(detector.recentJITEvents.length).toBe(0);
            expect(detector.poolStats.size).toBe(0);
            expect(detector.stats.jitDetected).toBe(0);
        });
    });

    describe('cleanup', () => {
        test('should clean up old pending mints', () => {
            // Add old mint
            detector.recordMint({
                chainId: 56,
                poolAddress: '0xPool1',
                owner: '0xOwner1',
                tickLower: -100,
                tickUpper: 100,
                amount: 1000000n,
                blockNumber: 1000,
                transactionHash: '0xMint1',
                liquidityUSD: 15000,
            });

            // Add new mint (triggers cleanup)
            detector.recordMint({
                chainId: 56,
                poolAddress: '0xPool2',
                owner: '0xOwner2',
                tickLower: -100,
                tickUpper: 100,
                amount: 1000000n,
                blockNumber: 1100, // 100 blocks later
                transactionHash: '0xMint2',
                liquidityUSD: 15000,
            });

            // Old mint should be cleaned up
            expect(detector.pendingMints.size).toBe(1);
        });
    });
});

// Test singleton instance
describe('JITLiquidityDetector Singleton', () => {
    test('should export singleton instance', () => {
        expect(jitLiquidityDetector).toBeDefined();
        expect(typeof jitLiquidityDetector.recordMint).toBe('function');
        expect(typeof jitLiquidityDetector.recordBurn).toBe('function');
    });

    test('should be an EventEmitter', () => {
        expect(typeof jitLiquidityDetector.on).toBe('function');
        expect(typeof jitLiquidityDetector.emit).toBe('function');
    });
});
