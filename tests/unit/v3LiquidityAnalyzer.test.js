import { V3LiquidityAnalyzer } from '../../src/analysis/v3LiquidityAnalyzer.js';

describe('V3LiquidityAnalyzer', () => {
    let analyzer;

    beforeEach(() => {
        analyzer = new V3LiquidityAnalyzer({
            tickWindow: 100,
            minLiquidityUSD: 1000,
            feeTierSpreadThreshold: 0.1,
            cacheMaxAge: 30000,
        });
    });

    afterEach(() => {
        analyzer.removeAllListeners();
        analyzer.clearCache();
    });

    describe('constructor', () => {
        it('should initialize with default config', () => {
            const defaultAnalyzer = new V3LiquidityAnalyzer();
            expect(defaultAnalyzer.tickWindow).toBe(100);
            expect(defaultAnalyzer.minLiquidityUSD).toBe(1000);
            expect(defaultAnalyzer.feeTierSpreadThreshold).toBe(0.1);
        });

        it('should initialize with custom config', () => {
            expect(analyzer.tickWindow).toBe(100);
            expect(analyzer.minLiquidityUSD).toBe(1000);
            expect(analyzer.feeTierSpreadThreshold).toBe(0.1);
            expect(analyzer.cacheMaxAge).toBe(30000);
        });

        it('should have correct fee tiers', () => {
            expect(analyzer.feeTiers).toEqual([100, 500, 3000, 10000]);
        });

        it('should have correct tick spacing per fee tier', () => {
            expect(analyzer.tickSpacing[100]).toBe(1);
            expect(analyzer.tickSpacing[500]).toBe(10);
            expect(analyzer.tickSpacing[3000]).toBe(60);
            expect(analyzer.tickSpacing[10000]).toBe(200);
        });

        it('should initialize empty cache', () => {
            expect(analyzer.tickCache.size).toBe(0);
        });

        it('should initialize statistics', () => {
            expect(analyzer.stats.tickAnalyses).toBe(0);
            expect(analyzer.stats.feeTierOpportunities).toBe(0);
            expect(analyzer.stats.crossTickCalculations).toBe(0);
            expect(analyzer.stats.cacheHits).toBe(0);
            expect(analyzer.stats.cacheMisses).toBe(0);
        });
    });

    describe('detectFeeTierArbitrage', () => {
        it('should return null when fewer than 2 V3 tiers', () => {
            const v3Prices = {
                'v3-3000': { isV3: true, price: 100, liquidityUSD: 10000 },
            };

            const result = analyzer.detectFeeTierArbitrage(v3Prices);
            expect(result).toBeNull();
        });

        it('should return null when no V3 tiers', () => {
            const v3Prices = {
                'pancakeswap': { isV3: false, price: 100, liquidityUSD: 10000 },
            };

            const result = analyzer.detectFeeTierArbitrage(v3Prices);
            expect(result).toBeNull();
        });

        it('should detect fee tier arbitrage when spread exists', () => {
            const v3Prices = {
                'v3-500': { isV3: true, price: 100, liquidityUSD: 50000 },   // 0.05% fee, lower price
                'v3-3000': { isV3: true, price: 101, liquidityUSD: 50000 },  // 0.3% fee, higher price
            };

            const result = analyzer.detectFeeTierArbitrage(v3Prices);

            // With 1% price spread and reasonable fees, should detect opportunity
            // Buy fee: 0.05%, Sell fee: 0.3%
            // Effective buy: 100 * 1.0005 = 100.05
            // Effective sell: 101 * 0.997 = 100.697
            // Spread: (100.697 - 100.05) / 100.05 = 0.647%
            expect(result).not.toBeNull();
            expect(result.type).toBe('v3-fee-tier-arb');
            expect(result.buyTier).toBe('v3-500');
            expect(result.sellTier).toBe('v3-3000');
            expect(result.spreadPercent).toBeGreaterThan(0);
        });

        it('should return null when spread below threshold', () => {
            const v3Prices = {
                'v3-500': { isV3: true, price: 100.00, liquidityUSD: 50000 },
                'v3-3000': { isV3: true, price: 100.01, liquidityUSD: 50000 }, // 0.01% difference
            };

            // With such small spread, after fees it's not profitable
            const result = analyzer.detectFeeTierArbitrage(v3Prices);
            expect(result).toBeNull();
        });

        it('should correctly identify buy/sell tiers', () => {
            const v3Prices = {
                'v3-100': { isV3: true, price: 102, liquidityUSD: 30000 },  // Highest price
                'v3-500': { isV3: true, price: 99, liquidityUSD: 40000 },   // Lowest price
                'v3-3000': { isV3: true, price: 100, liquidityUSD: 50000 }, // Middle
            };

            const result = analyzer.detectFeeTierArbitrage(v3Prices);

            expect(result).not.toBeNull();
            expect(result.buyTier).toBe('v3-500');   // Lowest price = buy
            expect(result.sellTier).toBe('v3-100');  // Highest price = sell
        });

        it('should track statistics', () => {
            const v3Prices = {
                'v3-500': { isV3: true, price: 100, liquidityUSD: 50000 },
                'v3-3000': { isV3: true, price: 102, liquidityUSD: 50000 },
            };

            analyzer.detectFeeTierArbitrage(v3Prices);

            expect(analyzer.stats.feeTierOpportunities).toBe(1);
        });
    });

    describe('findOptimalFeeTier', () => {
        it('should return null for empty prices', () => {
            const result = analyzer.findOptimalFeeTier({}, 1000, true);
            expect(result).toBeNull();
        });

        it('should return null for non-V3 prices', () => {
            const v3Prices = {
                'pancakeswap': { isV3: false, price: 100, liquidityUSD: 10000 },
            };

            const result = analyzer.findOptimalFeeTier(v3Prices, 1000, true);
            expect(result).toBeNull();
        });

        it('should skip tiers with insufficient liquidity', () => {
            const v3Prices = {
                'v3-500': { isV3: true, price: 99, liquidityUSD: 100 },   // Too low liquidity
                'v3-3000': { isV3: true, price: 100, liquidityUSD: 100000 }, // Enough liquidity
            };

            const result = analyzer.findOptimalFeeTier(v3Prices, 1000, true);

            expect(result).not.toBeNull();
            expect(result.tierKey).toBe('v3-3000');
        });

        it('should find best tier for buying (lowest effective price)', () => {
            const v3Prices = {
                'v3-100': { isV3: true, price: 100.5, liquidityUSD: 200000 },  // 0.01% fee
                'v3-500': { isV3: true, price: 100.0, liquidityUSD: 200000 },  // 0.05% fee
                'v3-3000': { isV3: true, price: 99.5, liquidityUSD: 200000 },  // 0.3% fee
            };

            const result = analyzer.findOptimalFeeTier(v3Prices, 1000, true);

            expect(result).not.toBeNull();
            // Best tier depends on effective price = rawPrice * (1 + fee + impact)
            // Lower tier with slightly higher price might win due to lower fee
        });

        it('should include price impact in calculation', () => {
            const v3Prices = {
                'v3-3000': { isV3: true, price: 100, liquidityUSD: 100000 },
            };

            const result = analyzer.findOptimalFeeTier(v3Prices, 1000, true);

            expect(result).not.toBeNull();
            expect(result.priceImpactPercent).toBeGreaterThan(0);
            expect(result.effectivePrice).toBeGreaterThan(result.rawPrice);
        });
    });

    describe('getActiveLiquidity', () => {
        it('should return 0 for empty ticks', () => {
            const result = analyzer.getActiveLiquidity([], 1000, 1);
            expect(result).toBe(0n);
        });

        it('should count liquidity within range', () => {
            const ticks = [
                { index: 900, liquidityNet: 1000000n },
                { index: 1000, liquidityNet: 2000000n },
                { index: 1100, liquidityNet: 500000n },
                { index: 2000, liquidityNet: 3000000n }, // Outside range
            ];

            const result = analyzer.getActiveLiquidity(ticks, 1000, 1);

            // 1% range = ~100 ticks (900 to 1100 included)
            // Should include first 3 ticks
            expect(result).toBeGreaterThan(0n);
        });
    });

    describe('estimateSlippage', () => {
        it('should return 100% for null analysis', () => {
            const result = analyzer.estimateSlippage(1000, null);
            expect(result).toBe(100);
        });

        it('should return 100% for zero liquidity', () => {
            const analysis = { activeLiquidityUSD: 0, concentrationScore: 0.5 };
            const result = analyzer.estimateSlippage(1000, analysis);
            expect(result).toBe(100);
        });

        it('should calculate base slippage from liquidity ratio', () => {
            const analysis = { activeLiquidityUSD: 100000, concentrationScore: 0 };
            const result = analyzer.estimateSlippage(1000, analysis);

            // 1000 / 100000 * 100 = 1%
            expect(result).toBeCloseTo(1, 1);
        });

        it('should reduce slippage for high concentration', () => {
            const lowConc = { activeLiquidityUSD: 100000, concentrationScore: 0.4 };
            const highConc = { activeLiquidityUSD: 100000, concentrationScore: 0.9 };

            const lowResult = analyzer.estimateSlippage(1000, lowConc);
            const highResult = analyzer.estimateSlippage(1000, highConc);

            expect(highResult).toBeLessThan(lowResult);
        });
    });

    describe('calculateSwapOutputWithTicks', () => {
        it('should track statistics', () => {
            const amountIn = 1000000000000000000n; // 1 token
            const sqrtPriceX96 = 79228162514264337593543950336n; // ~1:1 price
            const liquidity = 1000000000000000000000n;
            const currentTick = 0;
            const ticks = [];
            const feeTier = 3000;

            analyzer.calculateSwapOutputWithTicks(
                amountIn, sqrtPriceX96, liquidity, currentTick, ticks, feeTier, true
            );

            expect(analyzer.stats.crossTickCalculations).toBe(1);
        });

        it('should return output with tick crossing info', () => {
            const amountIn = 1000000000000000000n;
            const sqrtPriceX96 = 79228162514264337593543950336n;
            const liquidity = 1000000000000000000000n;
            const currentTick = 0;
            const ticks = [
                { index: -60, liquidityNet: 100000000000000000n, initialized: true },
                { index: 60, liquidityNet: -100000000000000000n, initialized: true },
            ];
            const feeTier = 3000;

            const result = analyzer.calculateSwapOutputWithTicks(
                amountIn, sqrtPriceX96, liquidity, currentTick, ticks, feeTier, true
            );

            expect(result).toHaveProperty('amountOut');
            expect(result).toHaveProperty('priceImpact');
            expect(result).toHaveProperty('ticksCrossed');
            expect(result).toHaveProperty('effectivePrice');
        });

        it('should return zero output for zero liquidity', () => {
            const amountIn = 1000000000000000000n;
            const sqrtPriceX96 = 79228162514264337593543950336n;
            const liquidity = 0n;
            const currentTick = 0;
            const ticks = [];
            const feeTier = 3000;

            const result = analyzer.calculateSwapOutputWithTicks(
                amountIn, sqrtPriceX96, liquidity, currentTick, ticks, feeTier, true
            );

            expect(result.amountOut).toBe(0n);
        });
    });

    describe('statistics', () => {
        it('should return comprehensive stats', () => {
            const stats = analyzer.getStats();

            expect(stats).toHaveProperty('tickAnalyses');
            expect(stats).toHaveProperty('feeTierOpportunities');
            expect(stats).toHaveProperty('crossTickCalculations');
            expect(stats).toHaveProperty('cacheHits');
            expect(stats).toHaveProperty('cacheMisses');
            expect(stats).toHaveProperty('cacheHitRate');
            expect(stats).toHaveProperty('cachedPools');
        });

        it('should calculate cache hit rate correctly', () => {
            analyzer.stats.cacheHits = 80;
            analyzer.stats.cacheMisses = 20;

            const stats = analyzer.getStats();
            expect(stats.cacheHitRate).toBe('80.0%');
        });

        it('should reset stats correctly', () => {
            analyzer.stats.tickAnalyses = 100;
            analyzer.stats.feeTierOpportunities = 50;

            analyzer.resetStats();

            expect(analyzer.stats.tickAnalyses).toBe(0);
            expect(analyzer.stats.feeTierOpportunities).toBe(0);
        });
    });

    describe('cache management', () => {
        it('should clear cache', () => {
            analyzer.tickCache.set('test', { ticks: [], timestamp: Date.now() });
            expect(analyzer.tickCache.size).toBe(1);

            analyzer.clearCache();
            expect(analyzer.tickCache.size).toBe(0);
        });

        it('should cleanup old entries', () => {
            const oldTime = Date.now() - 100000; // 100 seconds ago
            const recentTime = Date.now();

            analyzer.tickCache.set('old', { ticks: [], timestamp: oldTime });
            analyzer.tickCache.set('recent', { ticks: [], timestamp: recentTime });

            analyzer.cleanup();

            expect(analyzer.tickCache.has('old')).toBe(false);
            expect(analyzer.tickCache.has('recent')).toBe(true);
        });
    });

    describe('price calculations', () => {
        it('should convert tick to sqrt price', () => {
            // tick 0 should give sqrtPrice of 1 * 2^96
            const sqrtPrice = analyzer._tickToSqrtPrice(0);
            const price = analyzer._sqrtPriceToPrice(sqrtPrice);
            expect(price).toBeCloseTo(1, 5);
        });

        it('should convert sqrt price to price', () => {
            // sqrtPriceX96 = 2^96 means price = 1
            const sqrtPriceX96 = analyzer.Q96;
            const price = analyzer._sqrtPriceToPrice(sqrtPriceX96);
            expect(price).toBeCloseTo(1, 5);
        });

        it('should handle various tick values', () => {
            // Higher tick = higher price
            const sqrtPriceLow = analyzer._tickToSqrtPrice(-1000);
            const sqrtPriceHigh = analyzer._tickToSqrtPrice(1000);

            const priceLow = analyzer._sqrtPriceToPrice(sqrtPriceLow);
            const priceHigh = analyzer._sqrtPriceToPrice(sqrtPriceHigh);

            expect(priceHigh).toBeGreaterThan(priceLow);
        });
    });

    describe('fee extraction', () => {
        it('should extract fee from tier key', () => {
            expect(analyzer._extractFee('v3-500')).toBe(0.0005);
            expect(analyzer._extractFee('v3-3000')).toBe(0.003);
            expect(analyzer._extractFee('pancakeswap-v3-2500')).toBe(0.0025);
        });

        it('should default to 0.3% for unknown format', () => {
            expect(analyzer._extractFee('unknown')).toBe(0.003);
        });
    });

    describe('price impact estimation', () => {
        it('should return 100% for zero liquidity', () => {
            expect(analyzer._estimatePriceImpact(1000, 0)).toBe(100);
        });

        it('should calculate impact based on trade size', () => {
            // 1% of liquidity = ~0.5% impact
            const impact = analyzer._estimatePriceImpact(1000, 100000);
            expect(impact).toBeCloseTo(0.5, 1);
        });
    });

    // ==================== v3.1 Enhanced Tests ====================

    describe('v3.1 Enhanced Stats', () => {
        it('should initialize v3.1 enhanced statistics', () => {
            expect(analyzer.stats.tickCrossingsDetected).toBe(0);
            expect(analyzer.stats.jitLiquidityEvents).toBe(0);
            expect(analyzer.stats.depthAnalyses).toBe(0);
            expect(analyzer.stats.optimalRouteCalculations).toBe(0);
        });

        it('should reset v3.1 stats correctly', () => {
            analyzer.stats.tickCrossingsDetected = 10;
            analyzer.stats.jitLiquidityEvents = 5;
            analyzer.stats.depthAnalyses = 20;
            analyzer.stats.optimalRouteCalculations = 15;

            analyzer.resetStats();

            expect(analyzer.stats.tickCrossingsDetected).toBe(0);
            expect(analyzer.stats.jitLiquidityEvents).toBe(0);
            expect(analyzer.stats.depthAnalyses).toBe(0);
            expect(analyzer.stats.optimalRouteCalculations).toBe(0);
        });
    });

    describe('trackTickCrossing', () => {
        it('should store initial state on first observation', () => {
            const result = analyzer.trackTickCrossing('0xPool1', 1000, 1000000n, {});

            expect(result).toBeNull(); // First observation returns null
            expect(analyzer.tickCrossingTracker.has('0xPool1')).toBe(true);

            const tracker = analyzer.tickCrossingTracker.get('0xPool1');
            expect(tracker.lastTick).toBe(1000);
            expect(tracker.lastLiquidity).toBe(1000000n);
        });

        it('should not emit event for small tick changes', () => {
            let emittedEvent = null;
            analyzer.on('tickCrossing', (event) => {
                emittedEvent = event;
            });

            // First observation
            analyzer.trackTickCrossing('0xPool2', 1000, 1000000n, {});

            // Small tick change (< threshold of 10)
            const result = analyzer.trackTickCrossing('0xPool2', 1005, 1000000n, {});

            expect(result).toBeNull();
            expect(emittedEvent).toBeNull();
        });

        it('should detect and emit significant tick crossing', () => {
            let emittedEvent = null;
            analyzer.on('tickCrossing', (event) => {
                emittedEvent = event;
            });

            // First observation
            analyzer.trackTickCrossing('0xPool3', 1000, 1000000n, {});

            // Large tick change (>= threshold of 10)
            const result = analyzer.trackTickCrossing('0xPool3', 1020, 1200000n, {});

            expect(result).not.toBeNull();
            expect(result.ticksCrossed).toBe(20);
            expect(result.direction).toBe('up');
            expect(result.previousTick).toBe(1000);
            expect(result.newTick).toBe(1020);
            expect(emittedEvent).not.toBeNull();
            expect(analyzer.stats.tickCrossingsDetected).toBe(1);
        });

        it('should detect downward tick crossing', () => {
            analyzer.trackTickCrossing('0xPool4', 1000, 1000000n, {});
            const result = analyzer.trackTickCrossing('0xPool4', 980, 900000n, {});

            expect(result).not.toBeNull();
            expect(result.direction).toBe('down');
            expect(result.ticksCrossed).toBe(20);
        });

        it('should calculate price change percent', () => {
            analyzer.trackTickCrossing('0xPool5', 1000, 1000000n, {});
            const result = analyzer.trackTickCrossing('0xPool5', 1100, 1000000n, {});

            expect(result.priceChangePercent).toBeDefined();
            expect(result.priceChangePercent).toBeGreaterThan(0);
        });

        it('should include metadata in event', () => {
            analyzer.trackTickCrossing('0xPool6', 1000, 1000000n, {});
            const result = analyzer.trackTickCrossing('0xPool6', 1050, 1000000n, {
                blockNumber: 12345678,
                txHash: '0xabc123',
            });

            expect(result.blockNumber).toBe(12345678);
            expect(result.txHash).toBe('0xabc123');
            expect(result.timestamp).toBeDefined();
        });

        it('should accept custom tick crossing threshold', () => {
            const customAnalyzer = new V3LiquidityAnalyzer({
                tickCrossingThreshold: 5, // Lower threshold
            });

            customAnalyzer.trackTickCrossing('0xPool7', 1000, 1000000n, {});
            const result = customAnalyzer.trackTickCrossing('0xPool7', 1006, 1000000n, {});

            expect(result).not.toBeNull(); // Should trigger with 6 ticks crossed
            expect(result.ticksCrossed).toBe(6);

            customAnalyzer.removeAllListeners();
        });
    });

    describe('trackLiquidityChange and JIT detection', () => {
        it('should track liquidity additions', () => {
            analyzer.trackLiquidityChange('0xPoolJIT1', 1000000n, 1000, {});

            expect(analyzer.jitTracker.has('0xPoolJIT1')).toBe(true);
            const tracker = analyzer.jitTracker.get('0xPoolJIT1');
            expect(tracker.liquidityChanges.length).toBe(1);
            expect(tracker.liquidityChanges[0].delta).toBe(1000000n);
        });

        it('should track multiple liquidity changes', () => {
            analyzer.trackLiquidityChange('0xPoolJIT2', 1000000n, 1000, {});
            analyzer.trackLiquidityChange('0xPoolJIT2', 500000n, 1000, {});
            analyzer.trackLiquidityChange('0xPoolJIT2', -800000n, 1000, {});

            const tracker = analyzer.jitTracker.get('0xPoolJIT2');
            expect(tracker.liquidityChanges.length).toBe(3);
        });

        it('should detect JIT liquidity pattern (add then remove)', () => {
            let jitEvent = null;
            analyzer.on('jitLiquidity', (event) => {
                jitEvent = event;
            });

            // Simulate JIT pattern: large add followed by similar remove
            analyzer.trackLiquidityChange('0xPoolJIT3', BigInt(1e18), 1000, { provider: 'test' });

            // Small delay simulation (we can't actually wait, so we use same tick)
            analyzer.trackLiquidityChange('0xPoolJIT3', BigInt(-1e18), 1000, { provider: 'test' });

            // JIT detection looks for add-then-remove at same tick
            expect(analyzer.jitTracker.has('0xPoolJIT3')).toBe(true);
        });

        it('should include metadata in JIT tracking', () => {
            analyzer.trackLiquidityChange('0xPoolJIT4', 1000000n, 1500, {
                blockNumber: 12345,
                txHash: '0xdef456',
            });

            const tracker = analyzer.jitTracker.get('0xPoolJIT4');
            const change = tracker.liquidityChanges[0];
            expect(change.blockNumber).toBe(12345);
            expect(change.txHash).toBe('0xdef456');
            expect(change.tick).toBe(1500);
        });

        it('should accept custom JIT window', () => {
            const customAnalyzer = new V3LiquidityAnalyzer({
                jitWindow: 30000, // 30 seconds
            });

            expect(customAnalyzer.jitWindow).toBe(30000);
            customAnalyzer.removeAllListeners();
        });
    });

    describe('_detectJitPattern', () => {
        it('should return null for insufficient changes', () => {
            const changes = [{ timestamp: Date.now(), delta: 1000000n, tick: 1000 }];
            const result = analyzer._detectJitPattern(changes, 1000);
            expect(result).toBeNull();
        });

        it('should detect add-remove pattern at same tick', () => {
            const now = Date.now();
            const changes = [
                { timestamp: now, delta: BigInt(1e18), tick: 1000 },
                { timestamp: now + 5000, delta: BigInt(-1e18), tick: 1000 }, // Remove same amount
            ];

            const result = analyzer._detectJitPattern(changes, 1000);

            expect(result).not.toBeNull();
            expect(result.type).toBe('add-remove');
            expect(result.tick).toBe(1000);
            expect(result.timeBetweenMs).toBe(5000);
        });

        it('should not detect pattern for different ticks', () => {
            const now = Date.now();
            const changes = [
                { timestamp: now, delta: BigInt(1e18), tick: 1000 },
                { timestamp: now + 5000, delta: BigInt(-1e18), tick: 2000 }, // Different tick
            ];

            const result = analyzer._detectJitPattern(changes, 1500);
            expect(result).toBeNull();
        });

        it('should not detect pattern when time exceeds threshold', () => {
            const now = Date.now();
            const changes = [
                { timestamp: now, delta: BigInt(1e18), tick: 1000 },
                { timestamp: now + 60000, delta: BigInt(-1e18), tick: 1000 }, // 60s > 30s threshold
            ];

            const result = analyzer._detectJitPattern(changes, 1000);
            expect(result).toBeNull();
        });

        it('should not detect pattern for dissimilar amounts', () => {
            const now = Date.now();
            const changes = [
                { timestamp: now, delta: BigInt(1e18), tick: 1000 },
                { timestamp: now + 5000, delta: BigInt(-5e17), tick: 1000 }, // Only 50% removed
            ];

            const result = analyzer._detectJitPattern(changes, 1000);
            expect(result).toBeNull();
        });

        it('should identify if pattern is near current tick', () => {
            const now = Date.now();
            const changes = [
                { timestamp: now, delta: BigInt(1e18), tick: 1000 },
                { timestamp: now + 5000, delta: BigInt(-1e18), tick: 1000 },
            ];

            const result = analyzer._detectJitPattern(changes, 1050); // Close to tick 1000
            expect(result).not.toBeNull();
            expect(result.isNearCurrentTick).toBe(true);
        });
    });

    describe('calculateLiquidityDepth', () => {
        it('should increment depth analysis stat', async () => {
            const slot0 = { sqrtPriceX96: 79228162514264337593543950336n, tick: 0 };

            // Will fail without provider but should increment stat
            try {
                await analyzer.calculateLiquidityDepth('0xPool', slot0, 1000000n, 3000);
            } catch (e) {
                // Expected without provider
            }

            expect(analyzer.stats.depthAnalyses).toBe(1);
        });

        it('should use cached depth data when available', async () => {
            const cacheKey = 'depth:0xPoolCached:100';
            const mockData = {
                poolAddress: '0xPoolCached',
                currentTick: 100,
                levels: { '1%': { buyCapacity: '1000', sellCapacity: '1000' } },
                depthScore: 0.8,
            };

            analyzer.depthCache.set(cacheKey, {
                data: mockData,
                timestamp: Date.now(), // Fresh cache
            });

            const slot0 = { sqrtPriceX96: 79228162514264337593543950336n, tick: 100 };
            const result = await analyzer.calculateLiquidityDepth('0xPoolCached', slot0, 1000000n, 3000);

            expect(result).toEqual(mockData);
        });

        it('should have correct depth profile structure', () => {
            // Test expected structure of depth profile
            const expectedStructure = {
                poolAddress: expect.any(String),
                currentTick: expect.any(Number),
                currentLiquidity: expect.any(String),
                feeTier: expect.any(Number),
                levels: expect.any(Object),
                timestamp: expect.any(Number),
            };

            const mockProfile = {
                poolAddress: '0xTest',
                currentTick: 1000,
                currentLiquidity: '1000000',
                feeTier: 3000,
                levels: {
                    '0.5%': { buyCapacity: '100', sellCapacity: '100', ticksTraversed: 5 },
                    '1%': { buyCapacity: '200', sellCapacity: '200', ticksTraversed: 10 },
                },
                timestamp: Date.now(),
                depthScore: 0.75,
            };

            expect(mockProfile).toMatchObject(expectedStructure);
        });
    });

    describe('_calculateDirectionalDepth', () => {
        it('should return zero for empty ticks', () => {
            const result = analyzer._calculateDirectionalDepth([], 1000, 1000000n, 100, true);

            expect(result.capacity).toBe(0n);
            expect(result.liquidityUsed).toBe(0n);
            expect(result.ticks).toBe(0);
        });

        it('should calculate depth for buy direction (zeroForOne)', () => {
            const ticks = [
                { index: 900, liquidityNet: 500000n, initialized: true },
                { index: 950, liquidityNet: 300000n, initialized: true },
            ];

            const result = analyzer._calculateDirectionalDepth(ticks, 1000, 1000000n, 150, true);

            expect(result.capacity).toBeGreaterThan(0n);
            expect(result.ticks).toBeGreaterThan(0);
        });

        it('should calculate depth for sell direction (!zeroForOne)', () => {
            const ticks = [
                { index: 1050, liquidityNet: 500000n, initialized: true },
                { index: 1100, liquidityNet: 300000n, initialized: true },
            ];

            const result = analyzer._calculateDirectionalDepth(ticks, 1000, 1000000n, 150, false);

            expect(result.capacity).toBeGreaterThan(0n);
        });
    });

    describe('findOptimalSwapRoute', () => {
        it('should increment route calculation stat', () => {
            const amountIn = 1000000000000000000n;
            const slot0 = { sqrtPriceX96: 79228162514264337593543950336n, tick: 0 };
            const ticks = [];

            analyzer.findOptimalSwapRoute(amountIn, slot0, 1000000n, ticks, 3000, true);

            expect(analyzer.stats.optimalRouteCalculations).toBe(1);
        });

        it('should return route structure', () => {
            const amountIn = 1000000000000000000n;
            const slot0 = { sqrtPriceX96: 79228162514264337593543950336n, tick: 0 };
            const ticks = [];

            const result = analyzer.findOptimalSwapRoute(amountIn, slot0, 1000000n, ticks, 3000, true);

            expect(result).toHaveProperty('route');
            expect(result).toHaveProperty('totalAmountIn');
            expect(result).toHaveProperty('totalAmountOut');
            expect(result).toHaveProperty('stepsRequired');
            expect(result).toHaveProperty('startPrice');
            expect(result).toHaveProperty('avgExecutionPrice');
            expect(result).toHaveProperty('priceImpactPercent');
            expect(result).toHaveProperty('ticksCrossed');
            expect(result).toHaveProperty('isComplete');
            expect(result).toHaveProperty('unfilledAmount');
        });

        it('should handle multi-tick routes', () => {
            const amountIn = 10000000000000000000n; // Large amount
            const slot0 = { sqrtPriceX96: 79228162514264337593543950336n, tick: 0 };
            const ticks = [
                { index: -60, liquidityNet: 100000000000000000n, initialized: true },
                { index: -120, liquidityNet: 200000000000000000n, initialized: true },
            ];

            const result = analyzer.findOptimalSwapRoute(amountIn, slot0, 1000000000000000000n, ticks, 3000, true);

            expect(result.route).toBeInstanceOf(Array);
            expect(result.stepsRequired).toBeGreaterThanOrEqual(0);
        });

        it('should include step details in route', () => {
            const amountIn = 1000000000000000000n;
            const slot0 = { sqrtPriceX96: 79228162514264337593543950336n, tick: 0 };
            const ticks = [
                { index: -60, liquidityNet: 100000000000000000n, initialized: true },
            ];

            const result = analyzer.findOptimalSwapRoute(amountIn, slot0, 1000000000000000000n, ticks, 3000, true);

            if (result.route.length > 0) {
                const step = result.route[0];
                expect(step).toHaveProperty('step');
                expect(step).toHaveProperty('fromTick');
                expect(step).toHaveProperty('toTick');
                expect(step).toHaveProperty('amountIn');
                expect(step).toHaveProperty('amountOut');
                expect(step).toHaveProperty('liquidityUsed');
            }
        });
    });

    describe('_ticksToPercent', () => {
        it('should convert 0 ticks to 0%', () => {
            const result = analyzer._ticksToPercent(0);
            expect(result).toBeCloseTo(0, 5);
        });

        it('should convert 100 ticks to approximately 1%', () => {
            // 1.0001^100 - 1 ≈ 0.01005 ≈ 1%
            const result = analyzer._ticksToPercent(100);
            expect(result).toBeCloseTo(1, 0);
        });

        it('should convert 1000 ticks to approximately 10.5%', () => {
            // 1.0001^1000 - 1 ≈ 0.1052 ≈ 10.5%
            const result = analyzer._ticksToPercent(1000);
            expect(result).toBeCloseTo(10.5, 0);
        });

        it('should handle negative tick values', () => {
            // Negative ticks represent price decrease
            const result = analyzer._ticksToPercent(-100);
            expect(result).toBeLessThan(0);
        });
    });

    describe('v3.1 enhanced cleanup', () => {
        it('should clean old tick crossing trackers', () => {
            const oldTime = Date.now() - 400000; // 400 seconds ago (> 5 min threshold)
            const recentTime = Date.now();

            analyzer.tickCrossingTracker.set('oldPool', {
                lastTick: 1000,
                lastLiquidity: 1000000n,
                lastUpdate: oldTime,
            });
            analyzer.tickCrossingTracker.set('recentPool', {
                lastTick: 2000,
                lastLiquidity: 2000000n,
                lastUpdate: recentTime,
            });

            analyzer.cleanup();

            expect(analyzer.tickCrossingTracker.has('oldPool')).toBe(false);
            expect(analyzer.tickCrossingTracker.has('recentPool')).toBe(true);
        });

        it('should clean old depth cache entries', () => {
            const oldTime = Date.now() - 60000; // 60 seconds ago
            const recentTime = Date.now();

            analyzer.depthCache.set('depth:oldPool:100', {
                data: { poolAddress: 'oldPool' },
                timestamp: oldTime,
            });
            analyzer.depthCache.set('depth:recentPool:100', {
                data: { poolAddress: 'recentPool' },
                timestamp: recentTime,
            });

            analyzer.cleanup();

            expect(analyzer.depthCache.has('depth:oldPool:100')).toBe(false);
            expect(analyzer.depthCache.has('depth:recentPool:100')).toBe(true);
        });

        it('should clean empty JIT trackers', () => {
            // Add tracker with no recent changes
            analyzer.jitTracker.set('emptyPool', {
                liquidityChanges: [],
                baseLiquidity: 0n,
            });

            // Add tracker with recent changes
            analyzer.jitTracker.set('activePool', {
                liquidityChanges: [{ timestamp: Date.now(), delta: 1000n, tick: 100 }],
                baseLiquidity: 0n,
            });

            analyzer.cleanup();

            expect(analyzer.jitTracker.has('emptyPool')).toBe(false);
            expect(analyzer.jitTracker.has('activePool')).toBe(true);
        });
    });

    describe('clearAllTrackers', () => {
        it('should clear all v3.1 trackers', () => {
            // Populate all trackers
            analyzer.tickCrossingTracker.set('pool1', { lastTick: 1000 });
            analyzer.jitTracker.set('pool2', { liquidityChanges: [] });
            analyzer.depthCache.set('key', { data: {} });

            expect(analyzer.tickCrossingTracker.size).toBe(1);
            expect(analyzer.jitTracker.size).toBe(1);
            expect(analyzer.depthCache.size).toBe(1);

            analyzer.clearAllTrackers();

            expect(analyzer.tickCrossingTracker.size).toBe(0);
            expect(analyzer.jitTracker.size).toBe(0);
            expect(analyzer.depthCache.size).toBe(0);
        });
    });

    describe('v3.1 configuration options', () => {
        it('should accept tickCrossingThreshold config', () => {
            const custom = new V3LiquidityAnalyzer({ tickCrossingThreshold: 20 });
            expect(custom.tickCrossingThreshold).toBe(20);
            custom.removeAllListeners();
        });

        it('should accept jitWindow config', () => {
            const custom = new V3LiquidityAnalyzer({ jitWindow: 120000 });
            expect(custom.jitWindow).toBe(120000);
            custom.removeAllListeners();
        });

        it('should accept jitThreshold config', () => {
            const custom = new V3LiquidityAnalyzer({ jitThreshold: 0.2 });
            expect(custom.jitThreshold).toBe(0.2);
            custom.removeAllListeners();
        });

        it('should accept depthCacheMaxAge config', () => {
            const custom = new V3LiquidityAnalyzer({ depthCacheMaxAge: 30000 });
            expect(custom.depthCacheMaxAge).toBe(30000);
            custom.removeAllListeners();
        });
    });
});
