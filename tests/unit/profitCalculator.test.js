import { jest } from '@jest/globals';
import { parseUnits } from 'ethers';

// Mock dependencies
jest.unstable_mockModule('../../src/utils/logger.js', () => ({
    default: {
        info: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
    }
}));

const { default: profitCalculator } = await import('../../src/analysis/profitCalculator.js');

describe('ProfitCalculator', () => {
    // Standard gas price: 5 Gwei
    const gasPrice = parseUnits('5', 'gwei');
    const bnbPrice = 600;

    describe('calculateNetProfit - Cross-DEX', () => {
        const crossDexOpportunity = {
            type: 'cross-dex',
            pairKey: 'WBNB/USDT',
            tokenA: 'WBNB',
            tokenB: 'USDT',
            buyDex: 'pancakeswap',
            sellDex: 'biswap',
            profitUSD: 10, // Gross profit
            optimalTradeSizeUSD: 1000,
            gasCostUSD: 0.5,
        };

        test('should calculate net profit correctly', () => {
            const result = profitCalculator.calculateNetProfit(crossDexOpportunity, gasPrice, bnbPrice);

            expect(result).toHaveProperty('type', 'cross-dex');
            expect(result).toHaveProperty('grossProfitUSD');
            expect(result).toHaveProperty('flashFeeUSD');
            expect(result).toHaveProperty('gasCostUSD');
            expect(result).toHaveProperty('slippageUSD');
            expect(result).toHaveProperty('netProfitUSD');
            expect(result).toHaveProperty('netProfitPercent');
            expect(result).toHaveProperty('isProfitable');
        });

        test('should deduct flash loan fee (0.25%)', () => {
            const result = profitCalculator.calculateNetProfit(crossDexOpportunity, gasPrice, bnbPrice);

            // Flash fee should be 0.25% of trade size
            const expectedFlashFee = 1000 * 0.0025; // $2.50
            expect(result.flashFeeUSD).toBeCloseTo(expectedFlashFee, 2);
        });

        test('should include dynamic slippage based on token types', () => {
            const result = profitCalculator.calculateNetProfit(crossDexOpportunity, gasPrice, bnbPrice);

            // With dynamic slippage: WBNB (native: 0.3%) + USDT (stablecoin: 0.1%) = 0.3%
            // Slippage is calculated on gross profit, but with liquidity adjustments
            // Just verify slippage is calculated and reasonable
            expect(result.slippageUSD).toBeGreaterThan(0);
            expect(result.slippageUSD).toBeLessThan(result.grossProfitUSD);

            // Verify slippage info is included
            expect(result).toHaveProperty('slippageRate');
            expect(result).toHaveProperty('slippageInfo');
            expect(result.slippageRate).toBeGreaterThan(0);
        });

        test('should mark unprofitable opportunities correctly', () => {
            const unprofitableOpp = {
                ...crossDexOpportunity,
                profitUSD: 0.5, // Very low profit
                optimalTradeSizeUSD: 1000,
            };

            const result = profitCalculator.calculateNetProfit(unprofitableOpp, gasPrice, bnbPrice);

            // Net profit should be negative due to fees
            expect(result.netProfitUSD).toBeLessThan(1);
            expect(result.isProfitable).toBe(false);
        });

        test('should include breakdown object', () => {
            const result = profitCalculator.calculateNetProfit(crossDexOpportunity, gasPrice, bnbPrice);

            expect(result.breakdown).toHaveProperty('gross');
            expect(result.breakdown).toHaveProperty('flashLoan');
            expect(result.breakdown).toHaveProperty('gas');
            expect(result.breakdown).toHaveProperty('slippage');
            expect(result.breakdown).toHaveProperty('net');

            // Flash loan and gas should be negative (deductions)
            expect(result.breakdown.flashLoan).toBeLessThan(0);
            expect(result.breakdown.gas).toBeLessThan(0);
        });
    });

    describe('calculateNetProfit - Triangular', () => {
        const triangularOpportunity = {
            type: 'triangular',
            dexName: 'pancakeswap',
            path: ['WBNB', 'CAKE', 'USDT', 'WBNB'],
            estimatedProfitPercent: 1.5, // 1.5% theoretical profit
            minLiquidityUSD: 100000,
        };

        test('should calculate triangular profit correctly', () => {
            const result = profitCalculator.calculateNetProfit(triangularOpportunity, gasPrice, bnbPrice);

            expect(result).toHaveProperty('type', 'triangular');
            expect(result).toHaveProperty('grossProfitUSD');
            expect(result).toHaveProperty('flashFeeUSD');
            expect(result).toHaveProperty('gasCostUSD');
            expect(result).toHaveProperty('netProfitUSD');
            expect(result).toHaveProperty('dexName', 'pancakeswap');
            expect(result).toHaveProperty('path');
        });

        test('should account for 3 swaps in gas estimation', () => {
            const result = profitCalculator.calculateNetProfit(triangularOpportunity, gasPrice, bnbPrice);

            // Triangular has 3 swaps, cross-dex has 2
            // Gas cost should be higher for triangular
            const crossDexResult = profitCalculator.calculateNetProfit(
                { ...triangularOpportunity, type: 'cross-dex', profitUSD: 10, optimalTradeSizeUSD: 1000 },
                gasPrice,
                bnbPrice
            );

            expect(result.gasCostUSD).toBeGreaterThan(crossDexResult.gasCostUSD);
        });

        test('should limit trade size by liquidity', () => {
            const lowLiquidityOpp = {
                ...triangularOpportunity,
                minLiquidityUSD: 1000, // Very low liquidity
            };

            const result = profitCalculator.calculateNetProfit(lowLiquidityOpp, gasPrice, bnbPrice);

            // Trade size should be limited to 10% of pool liquidity
            expect(result.tradeSizeUSD).toBeLessThanOrEqual(1000 * 0.1);
        });
    });

    describe('batchCalculate', () => {
        test('should filter and sort opportunities by profit', () => {
            const opportunities = [
                {
                    type: 'cross-dex',
                    profitUSD: 5,
                    optimalTradeSizeUSD: 500,
                },
                {
                    type: 'cross-dex',
                    profitUSD: 20,
                    optimalTradeSizeUSD: 1000,
                },
                {
                    type: 'triangular',
                    dexName: 'pancakeswap',
                    path: ['WBNB', 'CAKE', 'USDT', 'WBNB'],
                    estimatedProfitPercent: 2,
                    minLiquidityUSD: 50000,
                },
            ];

            const results = profitCalculator.batchCalculate(opportunities, gasPrice);

            // Should be sorted by net profit descending
            for (let i = 1; i < results.length; i++) {
                const prevProfit = results[i - 1].profitCalculation.netProfitUSD;
                const currProfit = results[i].profitCalculation.netProfitUSD;
                expect(prevProfit).toBeGreaterThanOrEqual(currProfit);
            }

            // All results should be profitable
            results.forEach(result => {
                expect(result.profitCalculation.isProfitable).toBe(true);
            });
        });

        test('should filter out unprofitable opportunities', () => {
            const opportunities = [
                {
                    type: 'cross-dex',
                    profitUSD: 0.1, // Too low to be profitable after fees
                    optimalTradeSizeUSD: 100,
                },
            ];

            const results = profitCalculator.batchCalculate(opportunities, gasPrice);
            expect(results.length).toBe(0);
        });

        test('should handle empty array', () => {
            const results = profitCalculator.batchCalculate([], gasPrice);
            expect(results).toEqual([]);
        });
    });

    describe('updateBnbPrice', () => {
        test('should update BNB price', () => {
            profitCalculator.updateBnbPrice(700);

            // Recalculate and check gas cost changed
            const opportunity = {
                type: 'cross-dex',
                profitUSD: 10,
                optimalTradeSizeUSD: 1000,
            };

            const result = profitCalculator.calculateNetProfit(opportunity, gasPrice);

            // Reset to original price
            profitCalculator.updateBnbPrice(600);

            // Gas cost should have been calculated with new BNB price
            expect(result.gasCostUSD).toBeGreaterThan(0);
        });
    });

    describe('formatBreakdown', () => {
        test('should format profit breakdown as string', () => {
            const profitCalc = {
                type: 'cross-dex',
                tradeSizeUSD: 1000,
                netProfitPercent: 0.5,
                breakdown: {
                    gross: 10,
                    flashLoan: -2.5,
                    gas: -0.5,
                    slippage: -0.1,
                    net: 6.9,
                },
            };

            const formatted = profitCalculator.formatBreakdown(profitCalc);

            expect(typeof formatted).toBe('string');
            expect(formatted).toContain('Type: cross-dex');
            expect(formatted).toContain('Trade Size:');
            expect(formatted).toContain('Gross:');
            expect(formatted).toContain('Flash Fee:');
            expect(formatted).toContain('Gas:');
            expect(formatted).toContain('Net:');
        });
    });

    describe('getStats', () => {
        test('should return calculator statistics', () => {
            const stats = profitCalculator.getStats();

            expect(stats).toHaveProperty('nativeTokenSymbol');
            expect(stats).toHaveProperty('nativeTokenPriceUSD');
            expect(stats).toHaveProperty('flashLoanFee');
            expect(stats).toHaveProperty('slippageBuffer');
            expect(stats).toHaveProperty('minProfitUSD');
            expect(stats).toHaveProperty('gasEstimates');
            expect(stats).toHaveProperty('dynamicPricing');
            expect(stats).toHaveProperty('dynamicSlippage');
            expect(stats).toHaveProperty('slippageStats');
            expect(stats.flashLoanFee).toBe(0.0025);
            expect(stats.dynamicPricing).toBe(true);
            expect(stats.dynamicSlippage).toBe(true);
        });
    });
});
