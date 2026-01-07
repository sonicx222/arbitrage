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
const { default: PriceImpactCalculator } = await import('../../src/analysis/priceImpactCalculator.js');

describe('PriceImpactCalculator', () => {
    let calculator;

    beforeEach(() => {
        calculator = new PriceImpactCalculator.__proto__.constructor();
    });

    describe('constructor', () => {
        test('should initialize with default configuration', () => {
            expect(calculator.maxAcceptableImpact).toBe(0.02);
            expect(calculator.impactThresholds).toBeDefined();
        });

        test('should accept custom configuration', () => {
            const custom = new PriceImpactCalculator.__proto__.constructor({
                maxAcceptableImpact: 0.03,
            });

            expect(custom.maxAcceptableImpact).toBe(0.03);
        });
    });

    describe('calculateV2Impact', () => {
        test('should calculate price impact for small trade', () => {
            const amountIn = BigInt(1e18); // 1 token
            const reserveIn = BigInt(1000e18); // 1000 tokens
            const reserveOut = BigInt(1000e18); // 1000 tokens

            const result = calculator.calculateV2Impact(amountIn, reserveIn, reserveOut, 0.003);

            // 0.1% trade (1/1000) gives ~0.2% impact due to constant product
            // Impact formula: 2 * trade / (reserve + trade) ≈ 0.002
            expect(result.priceImpact).toBeLessThan(0.01);
            expect(result.priceImpactPercent).toBeLessThan(1);
            expect(result.isAcceptable).toBe(true);
            // 0.2% impact is in 'low' range (0.1%-0.5%)
            expect(result.severity).toBe('low');
        });

        test('should calculate higher impact for large trade', () => {
            const amountIn = BigInt(100e18); // 100 tokens (10% of pool)
            const reserveIn = BigInt(1000e18);
            const reserveOut = BigInt(1000e18);

            const result = calculator.calculateV2Impact(amountIn, reserveIn, reserveOut, 0.003);

            // Large trade should have significant impact
            expect(result.priceImpact).toBeGreaterThan(0.05);
            expect(result.severity).not.toBe('minimal');
        });

        test('should return empty impact for zero reserves', () => {
            const result = calculator.calculateV2Impact(BigInt(1e18), 0n, BigInt(1e18));

            expect(result.priceImpact).toBe(0);
            expect(result.amountOut).toBe('0');
        });

        test('should return empty impact for zero amount', () => {
            const result = calculator.calculateV2Impact(0n, BigInt(1e18), BigInt(1e18));

            expect(result.priceImpact).toBe(0);
        });

        test('should calculate correct spot and execution prices', () => {
            const reserveIn = BigInt(1000e18);
            const reserveOut = BigInt(2000e18); // 2:1 ratio

            const result = calculator.calculateV2Impact(BigInt(1e18), reserveIn, reserveOut, 0);

            // Spot price should be ~2
            expect(result.spotPrice).toBeCloseTo(2, 1);
            // Execution price should be slightly less due to impact
            expect(result.executionPrice).toBeLessThan(result.spotPrice);
        });

        test('should account for fees', () => {
            const amountIn = BigInt(10e18);
            const reserveIn = BigInt(1000e18);
            const reserveOut = BigInt(1000e18);

            const resultNoFee = calculator.calculateV2Impact(amountIn, reserveIn, reserveOut, 0);
            const resultWithFee = calculator.calculateV2Impact(amountIn, reserveIn, reserveOut, 0.003);

            // Output should be lower with fees
            expect(BigInt(resultWithFee.amountOut)).toBeLessThan(BigInt(resultNoFee.amountOut));
        });

        test('should calculate pool size percentage', () => {
            const amountIn = BigInt(50e18);
            const reserveIn = BigInt(1000e18);
            const reserveOut = BigInt(1000e18);

            const result = calculator.calculateV2Impact(amountIn, reserveIn, reserveOut);

            expect(result.poolSizePercent).toBeCloseTo(5, 1); // 50/1000 = 5%
        });
    });

    describe('calculateV3Impact', () => {
        test('should calculate V3 price impact', () => {
            // sqrtPriceX96 for price ~1.0
            const sqrtPriceX96 = 79228162514264337593543950336n; // 2^96
            const liquidity = BigInt(1e21); // High liquidity
            const amountIn = BigInt(1e18);

            const result = calculator.calculateV3Impact(amountIn, sqrtPriceX96, liquidity, 3000, true);

            expect(result.priceImpact).toBeDefined();
            expect(result.isV3).toBe(true);
            expect(result.spotPrice).toBeGreaterThan(0);
        });

        test('should return error for zero liquidity', () => {
            const sqrtPriceX96 = 79228162514264337593543950336n;

            const result = calculator.calculateV3Impact(BigInt(1e18), sqrtPriceX96, 0n, 3000);

            expect(result.priceImpact).toBe(0);
        });

        test('should handle trade exceeding liquidity', () => {
            const sqrtPriceX96 = 79228162514264337593543950336n;
            const liquidity = BigInt(1e15); // Very low liquidity
            const amountIn = BigInt(1e21); // Very large trade

            const result = calculator.calculateV3Impact(amountIn, sqrtPriceX96, liquidity, 3000, true);

            expect(result.severity).toBe('extreme');
            expect(result.isAcceptable).toBe(false);
        });

        test('should calculate pool utilization', () => {
            const sqrtPriceX96 = 79228162514264337593543950336n;
            const liquidity = BigInt(1e20);
            const amountIn = BigInt(1e18);

            const result = calculator.calculateV3Impact(amountIn, sqrtPriceX96, liquidity, 3000);

            expect(result.poolUtilization).toBeDefined();
            expect(result.poolUtilization).toBeGreaterThan(0);
        });
    });

    describe('calculateMultiHopImpact', () => {
        test('should calculate cumulative impact for multi-hop', () => {
            const hops = [
                {
                    amountIn: BigInt(10e18),
                    reserveIn: BigInt(1000e18),
                    reserveOut: BigInt(1000e18),
                    fee: 0.003,
                    isV3: false,
                },
                {
                    // amountIn will be set from previous output
                    reserveIn: BigInt(1000e18),
                    reserveOut: BigInt(1000e18),
                    fee: 0.003,
                    isV3: false,
                },
                {
                    reserveIn: BigInt(1000e18),
                    reserveOut: BigInt(1000e18),
                    fee: 0.003,
                    isV3: false,
                },
            ];

            const result = calculator.calculateMultiHopImpact(hops);

            expect(result.hops).toBe(3);
            expect(result.hopResults.length).toBe(3);
            expect(result.cumulativeImpact).toBeGreaterThan(0);
            // Cumulative should be greater than individual
            expect(result.cumulativeImpact).toBeGreaterThan(result.hopResults[0].priceImpact);
        });

        test('should return empty for no hops', () => {
            const result = calculator.calculateMultiHopImpact([]);
            expect(result.priceImpact).toBe(0);
        });

        test('should track effective rate', () => {
            const hops = [
                {
                    amountIn: BigInt(10e18),
                    reserveIn: BigInt(1000e18),
                    reserveOut: BigInt(2000e18), // 2x rate
                    fee: 0,
                    isV3: false,
                },
            ];

            const result = calculator.calculateMultiHopImpact(hops);

            // With 2:1 reserves, rate should be close to 2 minus impact
            expect(result.effectiveRate).toBeGreaterThan(1.5);
            expect(result.effectiveRate).toBeLessThan(2);
        });
    });

    describe('findOptimalTradeSize', () => {
        test('should find optimal size within impact limit', () => {
            const result = calculator.findOptimalTradeSize({
                reserveIn: BigInt(1000e18),
                reserveOut: BigInt(1000e18),
                fee: 0.003,
                maxImpact: 0.01, // 1% max impact
            });

            expect(BigInt(result.optimalSize)).toBeGreaterThan(0n);
            expect(result.actualImpact).toBeLessThanOrEqual(0.01);
            expect(result.poolPercentage).toBeGreaterThan(0);
        });

        test('should return zero for empty reserves', () => {
            const result = calculator.findOptimalTradeSize({
                reserveIn: 0n,
                reserveOut: BigInt(1000e18),
            });

            expect(result.optimalSize).toBe(0n);
        });
    });

    describe('estimateSlippageTolerance', () => {
        test('should calculate recommended slippage', () => {
            const result = calculator.estimateSlippageTolerance(
                BigInt(10e18),
                BigInt(1000e18),
                BigInt(1000e18),
                0.5 // 50% buffer
            );

            expect(result.recommendedSlippage).toBeGreaterThan(0);
            expect(result.recommendedSlippage).toBeGreaterThan(result.minimumSlippage);
            expect(result.minAmountOut).toBeDefined();
        });

        test('should include severity assessment', () => {
            const result = calculator.estimateSlippageTolerance(
                BigInt(100e18), // Large trade
                BigInt(1000e18),
                BigInt(1000e18)
            );

            expect(result.severity).toBeDefined();
        });
    });

    describe('analyzeTradeViability', () => {
        test('should analyze trade viability', () => {
            const opportunity = {
                reserveA: BigInt(1000e18).toString(),
                reserveB: BigInt(1000e18).toString(),
                optimalTradeSizeUSD: 100,
                buyPrice: 1.0,
                sellPrice: 1.02, // 2% spread
            };

            const result = calculator.analyzeTradeViability(opportunity);

            expect(result.buyImpact).toBeDefined();
            expect(result.sellImpact).toBeDefined();
            expect(result.totalImpact).toBeDefined();
            expect(result.grossSpread).toBeDefined();
            expect(result.netSpread).toBeDefined();
            expect(result.isViable).toBeDefined();
            expect(result.recommendation).toBeDefined();
        });

        test('should identify non-viable trades', () => {
            const opportunity = {
                reserveA: BigInt(100e18).toString(), // Low liquidity
                reserveB: BigInt(100e18).toString(),
                optimalTradeSizeUSD: 1000, // Large trade
                buyPrice: 1.0,
                sellPrice: 1.005, // 0.5% spread
            };

            const result = calculator.analyzeTradeViability(opportunity);

            // High impact + low spread = not viable
            expect(result.netSpread).toBeLessThan(result.grossSpread);
        });
    });

    describe('_getSeverity', () => {
        test('should classify minimal impact', () => {
            expect(calculator._getSeverity(0.0005)).toBe('minimal');
        });

        test('should classify low impact', () => {
            expect(calculator._getSeverity(0.003)).toBe('low');
        });

        test('should classify moderate impact', () => {
            expect(calculator._getSeverity(0.008)).toBe('moderate');
        });

        test('should classify high impact', () => {
            expect(calculator._getSeverity(0.015)).toBe('high');
        });

        test('should classify extreme impact', () => {
            expect(calculator._getSeverity(0.06)).toBe('extreme');
        });
    });

    describe('setMaxAcceptableImpact', () => {
        test('should update max acceptable impact', () => {
            calculator.setMaxAcceptableImpact(0.05);
            expect(calculator.maxAcceptableImpact).toBe(0.05);
        });
    });

    describe('getStats', () => {
        test('should return statistics', () => {
            const stats = calculator.getStats();

            expect(stats.maxAcceptableImpact).toBeDefined();
            expect(stats.impactThresholds).toBeDefined();
        });
    });
});

// Test singleton instance
describe('PriceImpactCalculator Singleton', () => {
    let priceImpactCalculator;

    beforeAll(async () => {
        const module = await import('../../src/analysis/priceImpactCalculator.js');
        priceImpactCalculator = module.default;
    });

    test('should export singleton instance', () => {
        expect(priceImpactCalculator).toBeDefined();
        expect(typeof priceImpactCalculator.calculateV2Impact).toBe('function');
    });
});
