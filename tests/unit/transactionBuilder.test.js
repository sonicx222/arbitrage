import { jest } from '@jest/globals';

// Mock dependencies
jest.unstable_mockModule('../../src/utils/logger.js', () => ({
    default: {
        info: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
    }
}));

jest.unstable_mockModule('../../src/config.js', () => ({
    default: {
        execution: { contractAddress: '0x1234567890123456789012345678901234567890' },
        tokens: {
            WBNB: { address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', decimals: 18, symbol: 'WBNB' },
            USDT: { address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18, symbol: 'USDT' },
            CAKE: { address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', decimals: 18, symbol: 'CAKE' },
        },
        dex: {
            pancakeswap: { router: '0x10ED43C718714eb63d5aA57B78B54704E256024E', enabled: true },
            biswap: { router: '0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8', enabled: true },
        },
    }
}));

jest.unstable_mockModule('../../src/contracts/abis.js', () => ({
    FLASH_ARBITRAGE_ABI: [
        'function executeCrossDexArbitrage(address flashPair, uint256 borrowAmount, address tokenBorrow, address[] path, address[] routers, uint256 minProfit)',
        'function executeTriangularArbitrage(address flashPair, uint256 borrowAmount, address tokenBorrow, address[] path, address router, uint256 minProfit)',
    ],
    WBNB_ADDRESS: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
}));

jest.unstable_mockModule('../../src/data/cacheManager.js', () => ({
    default: {
        getNativeTokenPrice: jest.fn(() => 600),
        getTokenPriceUSD: jest.fn(() => 1),
    }
}));

jest.unstable_mockModule('../../src/utils/gasPriceManager.js', () => ({
    default: {
        isEIP1559Chain: jest.fn((chainId) => [1, 137, 42161, 8453, 43114].includes(chainId)),
        getGasParams: jest.fn(async (provider, chainId) => {
            if ([1, 137, 42161, 8453, 43114].includes(chainId)) {
                return {
                    type: 2,
                    maxFeePerGas: 50000000000n,
                    maxPriorityFeePerGas: 2000000000n,
                };
            }
            return {
                type: 0,
                gasPrice: 5000000000n,
            };
        }),
    }
}));

const { default: transactionBuilder } = await import('../../src/execution/transactionBuilder.js');

describe('TransactionBuilder', () => {
    beforeEach(() => {
        transactionBuilder.setContractAddress('0x1234567890123456789012345678901234567890');
    });

    describe('setChain', () => {
        test('should set chain configuration', () => {
            const mockProvider = { getBlockNumber: jest.fn() };
            transactionBuilder.setChain(1, mockProvider);

            expect(transactionBuilder.chainId).toBe(1);
            expect(transactionBuilder.provider).toBe(mockProvider);
        });
    });

    describe('_applyGasParams', () => {
        const baseTx = {
            to: '0x1234567890123456789012345678901234567890',
            data: '0x',
            gasLimit: 400000n,
            value: 0n,
        };

        test('should apply EIP-1559 gas params', () => {
            const gasParams = {
                type: 2,
                maxFeePerGas: 50000000000n,
                maxPriorityFeePerGas: 2000000000n,
            };

            const tx = transactionBuilder._applyGasParams(baseTx, gasParams);

            expect(tx.type).toBe(2);
            expect(tx.maxFeePerGas).toBe(50000000000n);
            expect(tx.maxPriorityFeePerGas).toBe(2000000000n);
            expect(tx.gasPrice).toBeUndefined();
        });

        test('should apply legacy gas params from object', () => {
            const gasParams = {
                type: 0,
                gasPrice: 5000000000n,
            };

            const tx = transactionBuilder._applyGasParams(baseTx, gasParams);

            expect(tx.type).toBe(0);
            expect(tx.gasPrice).toBe(5000000000n);
            expect(tx.maxFeePerGas).toBeUndefined();
        });

        test('should apply legacy gas params from BigInt', () => {
            const gasPrice = 5000000000n;

            const tx = transactionBuilder._applyGasParams(baseTx, gasPrice);

            expect(tx.type).toBe(0);
            expect(tx.gasPrice).toBe(gasPrice);
        });

        test('should preserve base transaction fields', () => {
            const gasParams = { type: 0, gasPrice: 5000000000n };

            const tx = transactionBuilder._applyGasParams(baseTx, gasParams);

            expect(tx.to).toBe(baseTx.to);
            expect(tx.data).toBe(baseTx.data);
            expect(tx.gasLimit).toBe(baseTx.gasLimit);
            expect(tx.value).toBe(baseTx.value);
        });
    });

    describe('buildWithOptimalGas', () => {
        test('should throw if provider not set', async () => {
            transactionBuilder.provider = null;

            const opportunity = {
                type: 'cross-dex',
                buyDex: 'pancakeswap',
                sellDex: 'biswap',
                tokenA: 'CAKE',
                tokenB: 'USDT',
                optimalTradeSizeUSD: 1000,
                profitCalculation: { netProfitUSD: 10 },
            };

            await expect(transactionBuilder.buildWithOptimalGas(opportunity))
                .rejects.toThrow('Provider not set');
        });

        test('should use EIP-1559 gas params on supported chains', async () => {
            const mockProvider = { getBlockNumber: jest.fn() };
            transactionBuilder.setChain(1, mockProvider); // Ethereum

            // Mock the build method to avoid the full transaction building
            const buildSpy = jest.spyOn(transactionBuilder, 'build').mockReturnValue({
                to: '0x1234',
                data: '0x',
                type: 2,
                maxFeePerGas: 50000000000n,
                maxPriorityFeePerGas: 2000000000n,
            });

            const opportunity = {
                type: 'cross-dex',
                buyDex: 'pancakeswap',
                sellDex: 'biswap',
                tokenA: 'CAKE',
                tokenB: 'USDT',
                optimalTradeSizeUSD: 1000,
                profitCalculation: { netProfitUSD: 10 },
            };

            const tx = await transactionBuilder.buildWithOptimalGas(opportunity);

            // Verify the gas params were passed to build
            expect(buildSpy).toHaveBeenCalledWith(opportunity, expect.objectContaining({
                type: 2,
                maxFeePerGas: expect.any(BigInt),
            }));

            buildSpy.mockRestore();
        });

        test('should use legacy gas params on BSC', async () => {
            const mockProvider = { getBlockNumber: jest.fn() };
            transactionBuilder.setChain(56, mockProvider); // BSC

            // Mock the build method
            const buildSpy = jest.spyOn(transactionBuilder, 'build').mockReturnValue({
                to: '0x1234',
                data: '0x',
                type: 0,
                gasPrice: 5000000000n,
            });

            const opportunity = {
                type: 'cross-dex',
                buyDex: 'pancakeswap',
                sellDex: 'biswap',
                tokenA: 'CAKE',
                tokenB: 'USDT',
                optimalTradeSizeUSD: 1000,
                profitCalculation: { netProfitUSD: 10 },
            };

            const tx = await transactionBuilder.buildWithOptimalGas(opportunity);

            // Verify legacy gas params were passed
            expect(buildSpy).toHaveBeenCalledWith(opportunity, expect.objectContaining({
                type: 0,
                gasPrice: expect.any(BigInt),
            }));

            buildSpy.mockRestore();
        });
    });

    describe('estimateGas', () => {
        test('should return higher gas for triangular vs cross-dex', () => {
            const crossDexOpp = { type: 'cross-dex' };
            const triangularOpp = { type: 'triangular' };

            const crossDexGas = transactionBuilder.estimateGas(crossDexOpp);
            const triangularGas = transactionBuilder.estimateGas(triangularOpp);

            expect(triangularGas).toBeGreaterThan(crossDexGas);
        });

        test('should include buffer in gas estimate', () => {
            const opp = { type: 'cross-dex' };
            const gas = transactionBuilder.estimateGas(opp);

            expect(gas).toBe(transactionBuilder.gasLimits.crossDex + transactionBuilder.gasLimits.buffer);
        });
    });

    describe('build', () => {
        test('should route triangular opportunities to buildTriangularTx', () => {
            const spy = jest.spyOn(transactionBuilder, 'buildTriangularTx');

            const opp = {
                type: 'triangular',
                dexName: 'pancakeswap',
                path: ['WBNB', 'CAKE', 'USDT', 'WBNB'],
                profitCalculation: { netProfitUSD: 10, tradeSizeUSD: 1000 },
            };

            try {
                transactionBuilder.build(opp, 5000000000n);
            } catch (e) {
                // May fail due to mock limitations, but spy should be called
            }

            expect(spy).toHaveBeenCalled();
            spy.mockRestore();
        });

        test('should route cross-dex opportunities to buildCrossDexTx', () => {
            const spy = jest.spyOn(transactionBuilder, 'buildCrossDexTx');

            const opp = {
                type: 'cross-dex',
                buyDex: 'pancakeswap',
                sellDex: 'biswap',
                tokenA: 'CAKE',
                tokenB: 'USDT',
                optimalTradeSizeUSD: 1000,
                profitCalculation: { netProfitUSD: 10 },
            };

            try {
                transactionBuilder.build(opp, 5000000000n);
            } catch (e) {
                // May fail due to mock limitations, but spy should be called
            }

            expect(spy).toHaveBeenCalled();
            spy.mockRestore();
        });

        test('should route cross-dex-triangular to buildTriangularTx', () => {
            const spy = jest.spyOn(transactionBuilder, 'buildTriangularTx');

            const opp = {
                type: 'cross-dex-triangular',
                dexPath: ['pancakeswap', 'biswap', 'pancakeswap'],
                path: ['WBNB', 'CAKE', 'USDT', 'WBNB'],
                profitCalculation: { netProfitUSD: 10, tradeSizeUSD: 1000 },
            };

            try {
                transactionBuilder.build(opp, 5000000000n);
            } catch (e) {
                // May fail due to mock limitations
            }

            expect(spy).toHaveBeenCalled();
            spy.mockRestore();
        });
    });

    describe('Contract Address Management', () => {
        test('should throw if contract address not set', () => {
            transactionBuilder.contractAddress = null;

            const opp = {
                type: 'cross-dex',
                buyDex: 'pancakeswap',
                sellDex: 'biswap',
                tokenA: 'CAKE',
                tokenB: 'USDT',
                optimalTradeSizeUSD: 1000,
                profitCalculation: { netProfitUSD: 10 },
            };

            expect(() => transactionBuilder.build(opp, 5000000000n))
                .toThrow('Contract address not configured');
        });

        test('should set contract address', () => {
            const newAddress = '0xabcdef1234567890123456789012345678901234';
            transactionBuilder.setContractAddress(newAddress);

            expect(transactionBuilder.contractAddress).toBe(newAddress);
        });
    });
});
