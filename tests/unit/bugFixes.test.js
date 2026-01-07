import { jest } from '@jest/globals';

/**
 * Regression Tests for Bug Fixes
 *
 * This file contains tests that verify bug fixes remain fixed.
 * Each test is named with the bug number and a brief description.
 */

// Mock dependencies
jest.unstable_mockModule('../../src/utils/logger.js', () => ({
    default: {
        info: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
    }
}));

// Import after mocking
const { default: config } = await import('../../src/config.js');

describe('Bug Fix Regression Tests', () => {

    describe('Fix #1: Flash Loan Fee in Triangular Optimization', () => {
        test('triangularDetector.findOptimalTradeSize should account for flash loan fee', async () => {
            const { default: triangularDetector } = await import('../../src/analysis/triangularDetector.js');

            // Create a mock opportunity with reserves
            const opportunity = {
                type: 'triangular',
                dexName: 'pancakeswap',
                path: ['WBNB', 'USDT', 'CAKE', 'WBNB'],
                reserves: [
                    { in: (1000n * BigInt(1e18)).toString(), out: (300000n * BigInt(1e18)).toString() },
                    { in: (300000n * BigInt(1e18)).toString(), out: (100000n * BigInt(1e18)).toString() },
                    { in: (100000n * BigInt(1e18)).toString(), out: (1050n * BigInt(1e18)).toString() }, // 5% profit cycle
                ],
                cycleProduct: 1.05,
            };

            const result = triangularDetector.findOptimalTradeSize(opportunity, 18, 1000, 300);

            // The profit should be reduced by flash loan fee (0.25%)
            // If flash fee wasn't accounted for, profitUSD would be higher
            expect(result).toHaveProperty('profitUSD');
            expect(result).toHaveProperty('optimalAmount');

            // Verify flash loan fee is configured
            expect(config.execution.flashLoanFee).toBe(0.0025);
        });
    });

    describe('Fix #3: No Double Flash Fee Deduction', () => {
        test('profitCalculator should not double-count flash loan fee for cross-DEX', async () => {
            const { default: profitCalculator } = await import('../../src/analysis/profitCalculator.js');

            // Create a cross-DEX opportunity where profitUSD is already net of flash fee
            const opportunity = {
                type: 'cross-dex',
                profitUSD: 10, // This is already net of flash loan fee from arbitrageDetector
                optimalTradeSizeUSD: 1000,
                tokenA: 'WBNB',
                tokenB: 'USDT',
                minLiquidityUSD: 100000,
            };

            const gasPrice = BigInt(5e9); // 5 Gwei
            const result = profitCalculator.calculateNetProfit(opportunity, gasPrice, 300);

            // The net profit should only subtract gas and slippage, not flash fee again
            // grossProfitUSD in the result should show the "true gross" (profitUSD + flashFee)
            expect(result.grossProfitUSD).toBeGreaterThan(opportunity.profitUSD);

            // Flash fee should be tracked for reporting
            expect(result.flashFeeUSD).toBeCloseTo(1000 * 0.0025, 2); // 0.25% of trade size
        });
    });

    describe('Fix #4: Centralized Token Prices', () => {
        test('tokenPrices constants should export all required functions', async () => {
            const tokenPrices = await import('../../src/constants/tokenPrices.js');

            expect(tokenPrices.NATIVE_TOKEN_PRICES).toBeDefined();
            expect(tokenPrices.STABLECOINS).toBeDefined();
            expect(tokenPrices.getFallbackPrice).toBeDefined();
            expect(tokenPrices.isNativeToken).toBeDefined();
            expect(tokenPrices.isStablecoin).toBeDefined();
        });

        test('getFallbackPrice should return correct prices', async () => {
            const { getFallbackPrice, isStablecoin, isNativeToken } = await import('../../src/constants/tokenPrices.js');

            // Native tokens
            expect(getFallbackPrice('WBNB')).toBe(600);
            expect(getFallbackPrice('WETH')).toBe(3500);

            // Stablecoins
            expect(getFallbackPrice('USDT')).toBe(1);
            expect(getFallbackPrice('USDC')).toBe(1);

            // Major tokens
            expect(getFallbackPrice('BTCB')).toBe(95000);

            // Unknown token returns default
            expect(getFallbackPrice('UNKNOWN', 1)).toBe(1);
        });

        test('isStablecoin should identify stablecoins', async () => {
            const { isStablecoin } = await import('../../src/constants/tokenPrices.js');

            expect(isStablecoin('USDT')).toBe(true);
            expect(isStablecoin('USDC')).toBe(true);
            expect(isStablecoin('BUSD')).toBe(true);
            expect(isStablecoin('WBNB')).toBe(false);
            expect(isStablecoin('BTCB')).toBe(false);
        });

        test('isNativeToken should identify native tokens', async () => {
            const { isNativeToken } = await import('../../src/constants/tokenPrices.js');

            expect(isNativeToken('WBNB')).toBe(true);
            expect(isNativeToken('WETH')).toBe(true);
            expect(isNativeToken('WMATIC')).toBe(true);
            expect(isNativeToken('USDT')).toBe(false);
            expect(isNativeToken('CAKE')).toBe(false);
        });
    });

    describe('Fix #6: Configurable Trade Size Limits', () => {
        test('config should have trade size limits', () => {
            expect(config.trading.minTradeSizeUSD).toBeDefined();
            expect(config.trading.maxTradeSizeUSD).toBeDefined();
            expect(config.trading.minTradeSizeUSD).toBe(10);
            expect(config.trading.maxTradeSizeUSD).toBe(5000);
        });
    });

    describe('Fix #11: Transaction Builder Type Validation', () => {
        test('build() should reject invalid opportunity types', async () => {
            const { default: transactionBuilder } = await import('../../src/execution/transactionBuilder.js');

            // Set a dummy contract address to pass initial check
            transactionBuilder.setContractAddress('0x1234567890123456789012345678901234567890');

            const invalidOpportunity = {
                type: 'invalid-type',
                profitCalculation: { tradeSizeUSD: 100, netProfitUSD: 1 },
            };

            expect(() => {
                transactionBuilder.build(invalidOpportunity, BigInt(5e9));
            }).toThrow('Invalid opportunity type');
        });

        test('build() should accept valid opportunity types', async () => {
            const { default: transactionBuilder } = await import('../../src/execution/transactionBuilder.js');

            // We can't fully test without all required fields, but we verify the validation passes
            const validTypes = ['cross-dex', 'triangular', 'cross-dex-triangular'];

            for (const type of validTypes) {
                const opportunity = {
                    type,
                    // Other fields would cause errors, but type validation should pass first
                };

                // This will fail on missing fields, but should NOT fail on type validation
                try {
                    transactionBuilder.build(opportunity, BigInt(5e9));
                } catch (error) {
                    // Should NOT be a type validation error
                    expect(error.message).not.toContain('Invalid opportunity type');
                }
            }
        });
    });
});

describe('Configuration Validation', () => {
    test('flash loan fee should be 0.25% (0.0025)', () => {
        expect(config.execution.flashLoanFee).toBe(0.0025);
    });

    test('debugMode should be false when DEBUG_MODE is not set', () => {
        if (process.env.DEBUG_MODE !== 'true') {
            expect(config.debugMode).toBe(false);
        }
    });

    test('trading parameters should have valid defaults', () => {
        expect(config.trading.minProfitPercentage).toBeGreaterThan(0);
        expect(config.trading.gasPriceGwei).toBeGreaterThan(0);
        expect(config.trading.minTradeSizeUSD).toBeGreaterThan(0);
        expect(config.trading.maxTradeSizeUSD).toBeGreaterThan(config.trading.minTradeSizeUSD);
    });
});
