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
});
