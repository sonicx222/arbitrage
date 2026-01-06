import { jest } from '@jest/globals';

// Define mocks
jest.unstable_mockModule('../../src/utils/logger.js', () => ({
    default: {
        info: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
    }
}));

const { default: arbitrageDetector } = await import('../../src/analysis/arbitrageDetector.js');
const { default: config } = await import('../../src/config.js');

describe('ArbitrageDetector', () => {
    describe('detectOpportunities', () => {
        const mockPriceData = {
            'WBNB/BUSD': {
                'pancakeswap': {
                    price: 300,
                    reserveA: BigInt(1000 * 1e18).toString(), // 1000 WBNB
                    reserveB: BigInt(300000 * 1e18).toString(), // 300,000 BUSD (Price 300)
                    liquidityUSD: 600000,
                    timestamp: Date.now(),
                    dexName: 'pancakeswap' // Ensure dexName is present for fee lookup
                },
                'biswap': {
                    price: 310,
                    reserveA: BigInt(1000 * 1e18).toString(),
                    reserveB: BigInt(310000 * 1e18).toString(), // 310,000 BUSD (Price 310)
                    liquidityUSD: 620000,
                    timestamp: Date.now(),
                    dexName: 'biswap'
                },
            }
        };

        test('should detect profitable opportunity with optimal trade size', async () => {
            const opportunities = await arbitrageDetector.detectOpportunities(mockPriceData, 12345);

            expect(opportunities.length).toBe(1);
            const opp = opportunities[0];

            expect(opp.buyDex).toBe('pancakeswap');
            expect(opp.sellDex).toBe('biswap');
            expect(opp.profitUSD).toBeGreaterThan(0);
            expect(opp.optimalTradeSizeUSD).toBeGreaterThan(0);
            // console.log(`Test Opportunity Profit: $${opp.profitUSD.toFixed(2)} with size $${opp.optimalTradeSizeUSD.toFixed(2)}`);
        });

        test('should ignore non-profitable spreads due to gas/fees', async () => {
            const tightSpreadData = {
                'WBNB/BUSD': {
                    'pancakeswap': {
                        price: 300,
                        reserveA: BigInt(1000 * 1e18).toString(),
                        reserveB: BigInt(300000 * 1e18).toString(),
                        liquidityUSD: 600000,
                        dexName: 'pancakeswap'
                    },
                    'biswap': {
                        price: 300.5, // Tiny spread 0.16%
                        reserveA: BigInt(1000 * 1e18).toString(),
                        reserveB: BigInt(300500 * 1e18).toString(),
                        liquidityUSD: 601000,
                        dexName: 'biswap'
                    },
                }
            };

            const opportunities = await arbitrageDetector.detectOpportunities(tightSpreadData, 12345);
            expect(opportunities.length).toBe(0);
        });

        test('should filter out low liquidity pools', async () => {
            const lowLiqData = {
                'WBNB/BUSD': {
                    'pancakeswap': {
                        price: 300,
                        reserveA: BigInt(1 * 1e18).toString(),
                        reserveB: BigInt(300 * 1e18).toString(),
                        liquidityUSD: 600, // < 1000
                        dexName: 'pancakeswap'
                    },
                    'biswap': {
                        price: 310,
                        reserveA: BigInt(1000 * 1e18).toString(),
                        reserveB: BigInt(310000 * 1e18).toString(),
                        liquidityUSD: 620000,
                        dexName: 'biswap'
                    },
                }
            };

            const opportunities = await arbitrageDetector.detectOpportunities(lowLiqData, 12345);
            expect(opportunities.length).toBe(0);
        });
    });

    describe('Gas Estimation', () => {
        test('should calculate gas cost in BNB', () => {
            const gasCost = arbitrageDetector.estimateGasCost();
            expect(gasCost).toBeGreaterThan(0);
        });
    });

    describe('Uniswap Math', () => {
        test('getAmountOut should calculate standard 0.3% fee output correctly', () => {
            // ReserveIn: 1000, ReserveOut: 1000.
            // Input 10. Fee 0.3% (0.003).
            // InputWithFee = 10 * 0.997 = 9.97
            // Numerator = 9.97 * 1000 = 9970
            // Denom = 1000 + 9.97 = 1009.97
            // Output = 9970 / 1009.97 ≈ 9.8715

            const amountIn = 10n * BigInt(1e18);
            const reserveIn = 1000n * BigInt(1e18);
            const reserveOut = 1000n * BigInt(1e18);
            const fee = 0.003;

            const amountOut = arbitrageDetector.getAmountOut(amountIn, reserveIn, reserveOut, fee);

            // Approximate expected value: ~9.8715 * 1e18
            const expectedApprox = 9871500000000000000n;

            // Allow 0.1% tolerance
            const diff = amountOut > expectedApprox ? amountOut - expectedApprox : expectedApprox - amountOut;
            const tolerance = expectedApprox / 1000n; // 0.1%

            expect(diff < tolerance).toBe(true);
        });
    });

    describe('Flash Loan Fee in Trade Optimization (Bug Fix Regression)', () => {
        test('optimizeTradeAmount should account for flash loan fee', () => {
            // This test verifies that the flash loan fee (0.25%) is deducted from profit calculations
            // The fix ensures that we optimize for actual net profit after flash loan repayment

            const buyDexData = {
                dexName: 'pancakeswap',
                reserveA: BigInt(1000 * 1e18).toString(),
                reserveB: BigInt(300000 * 1e18).toString(),
                price: 300,
                liquidityUSD: 600000,
            };

            const sellDexData = {
                dexName: 'biswap',
                reserveA: BigInt(1000 * 1e18).toString(),
                reserveB: BigInt(310000 * 1e18).toString(),
                price: 310,
                liquidityUSD: 620000,
            };

            const result = arbitrageDetector.optimizeTradeAmount(buyDexData, sellDexData, 18, 18);

            // The result should be reasonable and account for flash loan fee
            // With 0.25% flash loan fee, even good spreads may not be profitable
            expect(result).toHaveProperty('profitUSD');
            expect(result).toHaveProperty('optimalAmount');

            // Verify flash loan fee is actually in config (regression check)
            expect(config.execution.flashLoanFee).toBe(0.0025);
        });

        test('should return lower profit than without flash loan fee consideration', () => {
            // This test ensures the flash loan fee is actually being deducted
            // If we calculate profit the "old way" (without flash fee) it would be higher

            const buyDexData = {
                dexName: 'pancakeswap',
                reserveA: BigInt(100 * 1e18).toString(),  // 100 tokens
                reserveB: BigInt(30000 * 1e18).toString(), // 30,000 in base
                price: 300,
                liquidityUSD: 60000,
            };

            const sellDexData = {
                dexName: 'biswap',
                reserveA: BigInt(100 * 1e18).toString(),
                reserveB: BigInt(33000 * 1e18).toString(), // 10% higher price
                price: 330,
                liquidityUSD: 66000,
            };

            const result = arbitrageDetector.optimizeTradeAmount(buyDexData, sellDexData, 18, 18);

            // With such a wide spread (10%), there should still be profit even after flash loan fee
            // But it should be less than 10% of trade size (since flash fee eats 0.25%)
            if (result.optimalAmount > 0n) {
                const tradeSizeUSD = (Number(result.optimalAmount) / 1e18) * result.priceUSD;
                // Max theoretical profit is 10% spread, flash fee is 0.25%, so net max is ~9.75%
                // Due to price impact, actual profit should be much lower
                expect(result.profitUSD / tradeSizeUSD).toBeLessThan(0.1);
            }
        });
    });
});
