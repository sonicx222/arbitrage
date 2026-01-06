import { jest } from '@jest/globals';

// Mock ethers
jest.unstable_mockModule('ethers', () => {
    return {
        ethers: {
            parseUnits: jest.fn((val, unit) => {
                const multiplier = unit === 'gwei' ? 1000000000n : 1n;
                return BigInt(Math.floor(parseFloat(val))) * multiplier;
            }),
            formatUnits: jest.fn((val, unit) => {
                const divisor = unit === 'gwei' ? 1000000000n : 1n;
                return (Number(val) / Number(divisor)).toString();
            }),
        },
    };
});

// Mock logger
jest.unstable_mockModule('../../src/utils/logger.js', () => ({
    default: {
        info: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
    }
}));

const { default: gasPriceManager } = await import('../../src/utils/gasPriceManager.js');

describe('GasPriceManager', () => {
    describe('Chain Type Detection', () => {
        test('should identify EIP-1559 chains correctly', () => {
            expect(gasPriceManager.isEIP1559Chain(1)).toBe(true);      // Ethereum
            expect(gasPriceManager.isEIP1559Chain(137)).toBe(true);    // Polygon
            expect(gasPriceManager.isEIP1559Chain(42161)).toBe(true);  // Arbitrum
            expect(gasPriceManager.isEIP1559Chain(8453)).toBe(true);   // Base
            expect(gasPriceManager.isEIP1559Chain(43114)).toBe(true);  // Avalanche
        });

        test('should identify legacy chains correctly', () => {
            expect(gasPriceManager.isEIP1559Chain(56)).toBe(false);    // BSC
        });

        test('should return false for unknown chains', () => {
            expect(gasPriceManager.isEIP1559Chain(999999)).toBe(false);
        });
    });

    describe('getGasParams', () => {
        const mockProvider = {
            getFeeData: jest.fn(),
        };

        beforeEach(() => {
            jest.clearAllMocks();
            gasPriceManager.clearCache();
        });

        test('should return EIP-1559 params for Ethereum', async () => {
            mockProvider.getFeeData.mockResolvedValue({
                gasPrice: 30000000000n, // 30 Gwei
            });

            const params = await gasPriceManager.getGasParams(mockProvider, 1);

            expect(params.type).toBe(2);
            expect(params).toHaveProperty('maxFeePerGas');
            expect(params).toHaveProperty('maxPriorityFeePerGas');
            expect(params).not.toHaveProperty('gasPrice');
        });

        test('should return legacy params for BSC', async () => {
            mockProvider.getFeeData.mockResolvedValue({
                gasPrice: 5000000000n, // 5 Gwei
            });

            const params = await gasPriceManager.getGasParams(mockProvider, 56);

            expect(params.type).toBe(0);
            expect(params).toHaveProperty('gasPrice');
            expect(params).not.toHaveProperty('maxFeePerGas');
        });

        test('should cache gas params', async () => {
            mockProvider.getFeeData.mockResolvedValue({
                gasPrice: 5000000000n,
            });

            await gasPriceManager.getGasParams(mockProvider, 56);
            await gasPriceManager.getGasParams(mockProvider, 56);

            // Should only call once due to caching
            expect(mockProvider.getFeeData).toHaveBeenCalledTimes(1);
        });

        test('should use different priority fees per chain', async () => {
            mockProvider.getFeeData.mockResolvedValue({
                gasPrice: 30000000000n,
            });

            const ethParams = await gasPriceManager.getGasParams(mockProvider, 1);
            gasPriceManager.clearCache();

            const polygonParams = await gasPriceManager.getGasParams(mockProvider, 137);

            // Polygon has higher default priority fee (30 gwei vs 1.5 gwei)
            expect(polygonParams.maxPriorityFeePerGas).toBeGreaterThan(ethParams.maxPriorityFeePerGas);
        });

        test('should apply speed multiplier for fast transactions', async () => {
            mockProvider.getFeeData.mockResolvedValue({
                gasPrice: 5000000000n, // 5 Gwei
            });

            const normalParams = await gasPriceManager.getGasParams(mockProvider, 56);
            gasPriceManager.clearCache();

            const fastParams = await gasPriceManager.getGasParams(mockProvider, 56, { speed: 'fast' });

            // Fast should be 20% higher
            expect(fastParams.gasPrice).toBeGreaterThan(normalParams.gasPrice);
        });

        test('should respect max gas price cap', async () => {
            mockProvider.getFeeData.mockResolvedValue({
                gasPrice: 100000000000n, // 100 Gwei
            });

            const params = await gasPriceManager.getGasParams(mockProvider, 56, { maxGasPriceGwei: 10 });

            // Should be capped at 10 Gwei
            expect(params.gasPrice).toBeLessThanOrEqual(10000000000n);
        });

        test('should fallback to legacy on EIP-1559 error', async () => {
            mockProvider.getFeeData
                .mockRejectedValueOnce(new Error('EIP-1559 not supported'))
                .mockResolvedValueOnce({ gasPrice: 30000000000n });

            const params = await gasPriceManager.getGasParams(mockProvider, 1);

            // Should fall back to legacy
            expect(params.type).toBe(0);
            expect(params).toHaveProperty('gasPrice');
        });
    });

    describe('estimateCostUSD', () => {
        test('should calculate cost for EIP-1559 transaction', () => {
            const gasParams = {
                type: 2,
                maxFeePerGas: 50000000000n, // 50 Gwei
                maxPriorityFeePerGas: 2000000000n, // 2 Gwei
            };
            const gasLimit = 400000n;
            const ethPriceUSD = 3500;

            const result = gasPriceManager.estimateCostUSD(gasParams, gasLimit, ethPriceUSD);

            expect(result).toHaveProperty('gasCostWei');
            expect(result).toHaveProperty('gasCostNative');
            expect(result).toHaveProperty('gasCostUSD');
            expect(result).toHaveProperty('effectiveGasPriceGwei');
            expect(result.isEIP1559).toBe(true);
            expect(result.gasCostUSD).toBeGreaterThan(0);
        });

        test('should calculate cost for legacy transaction', () => {
            const gasParams = {
                type: 0,
                gasPrice: 5000000000n, // 5 Gwei
            };
            const gasLimit = 400000n;
            const bnbPriceUSD = 600;

            const result = gasPriceManager.estimateCostUSD(gasParams, gasLimit, bnbPriceUSD);

            expect(result.isEIP1559).toBe(false);
            expect(result.gasCostUSD).toBeGreaterThan(0);
            // 5 Gwei * 400000 gas = 0.002 BNB * $600 = $1.20
            expect(result.gasCostUSD).toBeCloseTo(1.2, 1);
        });
    });

    describe('buildTransaction', () => {
        const baseTx = {
            to: '0x1234567890123456789012345678901234567890',
            data: '0x',
            value: 0n,
            gasLimit: 400000n,
        };

        test('should add EIP-1559 fields for type 2', () => {
            const gasParams = {
                type: 2,
                maxFeePerGas: 50000000000n,
                maxPriorityFeePerGas: 2000000000n,
            };

            const tx = gasPriceManager.buildTransaction(baseTx, gasParams);

            expect(tx.type).toBe(2);
            expect(tx.maxFeePerGas).toBe(50000000000n);
            expect(tx.maxPriorityFeePerGas).toBe(2000000000n);
            expect(tx.gasPrice).toBeUndefined();
        });

        test('should add legacy gasPrice for type 0', () => {
            const gasParams = {
                type: 0,
                gasPrice: 5000000000n,
            };

            const tx = gasPriceManager.buildTransaction(baseTx, gasParams);

            expect(tx.type).toBe(0);
            expect(tx.gasPrice).toBe(5000000000n);
            expect(tx.maxFeePerGas).toBeUndefined();
            expect(tx.maxPriorityFeePerGas).toBeUndefined();
        });

        test('should preserve base transaction fields', () => {
            const gasParams = { type: 0, gasPrice: 5000000000n };

            const tx = gasPriceManager.buildTransaction(baseTx, gasParams);

            expect(tx.to).toBe(baseTx.to);
            expect(tx.data).toBe(baseTx.data);
            expect(tx.value).toBe(baseTx.value);
            expect(tx.gasLimit).toBe(baseTx.gasLimit);
        });
    });

    describe('getStats', () => {
        test('should return manager statistics', () => {
            const stats = gasPriceManager.getStats();

            expect(stats).toHaveProperty('eip1559Chains');
            expect(stats).toHaveProperty('legacyChains');
            expect(stats).toHaveProperty('cacheSize');
            expect(stats).toHaveProperty('cacheMaxAge');

            expect(stats.eip1559Chains).toContain(1);
            expect(stats.eip1559Chains).toContain(137);
            expect(stats.legacyChains).toContain(56);
        });
    });

    describe('clearCache', () => {
        test('should clear all cached gas prices', async () => {
            const mockProvider = {
                getFeeData: jest.fn().mockResolvedValue({ gasPrice: 5000000000n }),
            };

            await gasPriceManager.getGasParams(mockProvider, 56);
            expect(gasPriceManager.getStats().cacheSize).toBeGreaterThan(0);

            gasPriceManager.clearCache();
            expect(gasPriceManager.getStats().cacheSize).toBe(0);
        });
    });
});
