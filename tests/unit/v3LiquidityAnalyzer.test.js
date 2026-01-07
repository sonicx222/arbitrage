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
});
