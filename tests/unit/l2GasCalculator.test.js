import { jest } from '@jest/globals';
import { parseUnits, formatUnits } from 'ethers';
import l2GasCalculator from '../../src/execution/l2GasCalculator.js';

describe('L2GasCalculator', () => {
    beforeEach(() => {
        l2GasCalculator.clearCache();
    });

    describe('isL2Chain', () => {
        test('should return true for Arbitrum One', () => {
            expect(l2GasCalculator.isL2Chain(42161)).toBe(true);
        });

        test('should return true for Base', () => {
            expect(l2GasCalculator.isL2Chain(8453)).toBe(true);
        });

        test('should return true for Optimism', () => {
            expect(l2GasCalculator.isL2Chain(10)).toBe(true);
        });

        test('should return false for BSC', () => {
            expect(l2GasCalculator.isL2Chain(56)).toBe(false);
        });

        test('should return false for Ethereum', () => {
            expect(l2GasCalculator.isL2Chain(1)).toBe(false);
        });

        test('should return false for Polygon', () => {
            expect(l2GasCalculator.isL2Chain(137)).toBe(false);
        });
    });

    describe('getL2ChainName', () => {
        test('should return arbitrum for chain ID 42161', () => {
            expect(l2GasCalculator.getL2ChainName(42161)).toBe('arbitrum');
        });

        test('should return base for chain ID 8453', () => {
            expect(l2GasCalculator.getL2ChainName(8453)).toBe('base');
        });

        test('should return null for non-L2 chain', () => {
            expect(l2GasCalculator.getL2ChainName(56)).toBeNull();
        });
    });

    describe('calculateTotalGasCost', () => {
        const mockProvider = {
            call: jest.fn(),
        };

        test('should calculate L2 cost correctly', async () => {
            const l2GasUsed = 300000n;
            const l2GasPrice = parseUnits('0.1', 'gwei'); // 0.1 gwei

            const result = await l2GasCalculator.calculateTotalGasCost(
                'arbitrum',
                mockProvider,
                l2GasUsed,
                l2GasPrice,
                500 // tx data size
            );

            expect(result).toHaveProperty('l2Cost');
            expect(result).toHaveProperty('l1DataFee');
            expect(result).toHaveProperty('totalCost');
            expect(result).toHaveProperty('breakdown');

            // L2 cost should be l2GasUsed * l2GasPrice
            const expectedL2Cost = l2GasUsed * l2GasPrice;
            expect(result.l2Cost).toBe(expectedL2Cost);

            // Total cost should be >= L2 cost (includes L1 fee estimate)
            expect(result.totalCost).toBeGreaterThanOrEqual(result.l2Cost);
        });

        test('should use fallback estimate when provider fails', async () => {
            const failingProvider = {
                call: jest.fn().mockRejectedValue(new Error('RPC error')),
            };

            const l2GasUsed = 300000n;
            const l2GasPrice = parseUnits('0.1', 'gwei');

            const result = await l2GasCalculator.calculateTotalGasCost(
                'base',
                failingProvider,
                l2GasUsed,
                l2GasPrice,
                500
            );

            // Should still return a result with estimated L1 fee
            expect(result.totalCost).toBeGreaterThan(result.l2Cost);
        });
    });

    describe('calculateGasCostUSD', () => {
        const mockProvider = {
            call: jest.fn(),
        };

        test('should convert gas costs to USD', async () => {
            const l2GasUsed = 300000n;
            const l2GasPrice = parseUnits('0.1', 'gwei');
            const ethPriceUSD = 3500;

            const result = await l2GasCalculator.calculateGasCostUSD(
                'arbitrum',
                mockProvider,
                l2GasUsed,
                l2GasPrice,
                ethPriceUSD,
                'crossDex'
            );

            expect(result).toHaveProperty('l2CostUSD');
            expect(result).toHaveProperty('l1DataFeeUSD');
            expect(result).toHaveProperty('totalCostUSD');

            // L2 cost in USD should be calculated from ETH amount
            const l2CostETH = Number(l2GasUsed * l2GasPrice) / 1e18;
            const expectedL2CostUSD = l2CostETH * ethPriceUSD;
            expect(result.l2CostUSD).toBeCloseTo(expectedL2CostUSD, 6);

            // Total should be sum of L2 and L1 costs
            expect(result.totalCostUSD).toBeCloseTo(result.l2CostUSD + result.l1DataFeeUSD, 6);
        });

        test('should handle different transaction types', async () => {
            const l2GasUsed = 300000n;
            const l2GasPrice = parseUnits('0.1', 'gwei');
            const ethPriceUSD = 3500;

            const crossDexResult = await l2GasCalculator.calculateGasCostUSD(
                'arbitrum',
                mockProvider,
                l2GasUsed,
                l2GasPrice,
                ethPriceUSD,
                'crossDex'
            );

            const triangularResult = await l2GasCalculator.calculateGasCostUSD(
                'arbitrum',
                mockProvider,
                l2GasUsed,
                l2GasPrice,
                ethPriceUSD,
                'triangular'
            );

            // Triangular should have higher L1 fee (more calldata)
            expect(triangularResult.l1DataFeeUSD).toBeGreaterThanOrEqual(crossDexResult.l1DataFeeUSD);
        });
    });

    describe('txSizeEstimates', () => {
        test('should have estimates for different tx types', () => {
            const stats = l2GasCalculator.getStats();
            expect(stats.txSizeEstimates).toHaveProperty('crossDex');
            expect(stats.txSizeEstimates).toHaveProperty('triangular');
            expect(stats.txSizeEstimates).toHaveProperty('flashLoan');
        });

        test('should have reasonable byte estimates', () => {
            const stats = l2GasCalculator.getStats();
            expect(stats.txSizeEstimates.crossDex).toBeGreaterThan(0);
            expect(stats.txSizeEstimates.crossDex).toBeLessThan(2000);
            expect(stats.txSizeEstimates.triangular).toBeGreaterThan(stats.txSizeEstimates.crossDex);
        });
    });

    describe('caching', () => {
        test('should have cache functionality', () => {
            // Clear cache first
            l2GasCalculator.clearCache();
            expect(l2GasCalculator.getStats().cacheSize).toBe(0);

            // The cache is populated when real L2 contract calls succeed
            // In tests without real providers, the fallback estimate is used
            // which doesn't populate the cache
        });

        test('should clear cache', () => {
            l2GasCalculator.clearCache();
            const stats = l2GasCalculator.getStats();
            expect(stats.cacheSize).toBe(0);
        });
    });

    describe('getStats', () => {
        test('should return statistics', () => {
            const stats = l2GasCalculator.getStats();
            expect(stats).toHaveProperty('cacheSize');
            expect(stats).toHaveProperty('supportedChains');
            expect(stats).toHaveProperty('txSizeEstimates');
            expect(stats.supportedChains).toContain('arbitrum');
            expect(stats.supportedChains).toContain('base');
        });
    });
});
