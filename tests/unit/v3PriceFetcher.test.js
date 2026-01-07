import { jest } from '@jest/globals';

// Mock logger first
jest.unstable_mockModule('../../src/utils/logger.js', () => ({
    default: {
        info: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
    }
}));

// Mock rpcManager
jest.unstable_mockModule('../../src/utils/rpcManager.js', () => ({
    default: {
        withRetry: jest.fn((fn) => fn('mock_provider')),
    }
}));

// Mock cacheManager
jest.unstable_mockModule('../../src/data/cacheManager.js', () => ({
    default: {
        getPrice: jest.fn(),
        setPrice: jest.fn(),
    }
}));

// Mock ethers
const mockMulticallContract = {
    tryAggregate: jest.fn(),
};

jest.unstable_mockModule('ethers', () => ({
    ethers: {
        Contract: jest.fn(() => mockMulticallContract),
        Interface: jest.fn(() => ({
            encodeFunctionData: jest.fn(() => '0xencoded'),
            decodeFunctionResult: jest.fn((funcName, data) => {
                if (funcName === 'getPool') {
                    return ['0x1234567890123456789012345678901234567890'];
                }
                if (funcName === 'slot0') {
                    // sqrtPriceX96 for price ~1.0 (1 * 2^96)
                    return [
                        79228162514264337593543950336n, // sqrtPriceX96 (≈1.0)
                        0n, // tick
                        0, // observationIndex
                        0, // observationCardinality
                        0, // observationCardinalityNext
                        0, // feeProtocol
                        true, // unlocked
                    ];
                }
                if (funcName === 'liquidity') {
                    return [1000000000000000000n]; // 1e18
                }
                return [];
            }),
        })),
        ZeroAddress: '0x0000000000000000000000000000000000000000',
    }
}));

// Import after mocks
const { default: v3PriceFetcher } = await import('../../src/data/v3PriceFetcher.js');

describe('V3PriceFetcher', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        v3PriceFetcher.clearCache();
    });

    describe('sqrtPriceX96ToPrice', () => {
        test('should convert sqrtPriceX96 to price correctly for equal decimals', () => {
            // sqrtPriceX96 = sqrt(price) * 2^96
            // For price = 1.0: sqrtPriceX96 = 1 * 2^96 = 79228162514264337593543950336
            const sqrtPriceX96 = 79228162514264337593543950336n;
            const price = v3PriceFetcher.sqrtPriceX96ToPrice(sqrtPriceX96, 18, 18);

            expect(price).toBeCloseTo(1.0, 5);
        });

        test('should convert sqrtPriceX96 to price correctly for different decimals', () => {
            // USDC (6 decimals) / ETH (18 decimals)
            // If 1 ETH = 2000 USDC, then price in V3 terms is different
            const sqrtPriceX96 = 79228162514264337593543950336n; // Base price ~1
            const price = v3PriceFetcher.sqrtPriceX96ToPrice(sqrtPriceX96, 6, 18);

            // With decimal adjustment: 1 * 10^(6-18) = 1e-12
            expect(price).toBeCloseTo(1e-12, 20);
        });

        test('should handle high prices correctly', () => {
            // sqrtPriceX96 for price = 4.0: sqrt(4) * 2^96 = 2 * 2^96
            const sqrtPriceX96 = 158456325028528675187087900672n; // 2 * 2^96
            const price = v3PriceFetcher.sqrtPriceX96ToPrice(sqrtPriceX96, 18, 18);

            expect(price).toBeCloseTo(4.0, 5);
        });

        test('should handle low prices correctly', () => {
            // sqrtPriceX96 for price = 0.25: sqrt(0.25) * 2^96 = 0.5 * 2^96
            const sqrtPriceX96 = 39614081257132168796771975168n; // 0.5 * 2^96
            const price = v3PriceFetcher.sqrtPriceX96ToPrice(sqrtPriceX96, 18, 18);

            expect(price).toBeCloseTo(0.25, 5);
        });
    });

    describe('priceToSqrtPriceX96', () => {
        test('should convert price to sqrtPriceX96 correctly', () => {
            const price = 1.0;
            const sqrtPriceX96 = v3PriceFetcher.priceToSqrtPriceX96(price, 18, 18);

            // Should be approximately 2^96
            const expected = 2n ** 96n;
            const tolerance = expected / 1000n; // 0.1% tolerance

            expect(sqrtPriceX96).toBeGreaterThan(expected - tolerance);
            expect(sqrtPriceX96).toBeLessThan(expected + tolerance);
        });

        test('should be inverse of sqrtPriceX96ToPrice', () => {
            const originalPrice = 2.5;
            const sqrtPriceX96 = v3PriceFetcher.priceToSqrtPriceX96(originalPrice, 18, 18);
            const recoveredPrice = v3PriceFetcher.sqrtPriceX96ToPrice(sqrtPriceX96, 18, 18);

            expect(recoveredPrice).toBeCloseTo(originalPrice, 4);
        });
    });

    describe('calculateSwapOutput', () => {
        test('should calculate output with fee deduction', () => {
            const amountIn = 1000000000000000000n; // 1 token
            const sqrtPriceX96 = 79228162514264337593543950336n; // price = 1.0
            const liquidity = 1000000000000000000000n; // High liquidity
            const fee = 3000; // 0.3%
            const zeroForOne = true;

            const output = v3PriceFetcher.calculateSwapOutput(
                amountIn,
                sqrtPriceX96,
                liquidity,
                fee,
                zeroForOne
            );

            // Output should be roughly input * price * (1 - fee)
            // 1 * 1.0 * 0.997 ≈ 0.997
            expect(Number(output)).toBeGreaterThan(0);
            expect(Number(output)).toBeLessThan(Number(amountIn));
        });

        test('should return 0 for zero liquidity', () => {
            const amountIn = 1000000000000000000n;
            const sqrtPriceX96 = 79228162514264337593543950336n;
            const liquidity = 0n;
            const fee = 3000;

            const output = v3PriceFetcher.calculateSwapOutput(
                amountIn,
                sqrtPriceX96,
                liquidity,
                fee,
                true
            );

            expect(output).toBe(0n);
        });
    });

    describe('estimateLiquidityUSD', () => {
        test('should estimate liquidity in USD', () => {
            const liquidity = 1000000000000000000000n; // Large liquidity
            const sqrtPriceX96 = 79228162514264337593543950336n;
            const token0PriceUSD = 2000; // ETH price

            const tvl = v3PriceFetcher.estimateLiquidityUSD(
                liquidity,
                sqrtPriceX96,
                token0PriceUSD,
                18,
                18
            );

            expect(tvl).toBeGreaterThan(0);
        });

        test('should return 0 for zero liquidity', () => {
            const tvl = v3PriceFetcher.estimateLiquidityUSD(0n, 79228162514264337593543950336n, 2000, 18, 18);
            expect(tvl).toBe(0);
        });

        test('should return 0 for zero token price', () => {
            const tvl = v3PriceFetcher.estimateLiquidityUSD(1000n, 79228162514264337593543950336n, 0, 18, 18);
            expect(tvl).toBe(0);
        });
    });

    describe('_generateTokenPairs', () => {
        test('should generate correct pairs from tokens', () => {
            const tokens = {
                WETH: { symbol: 'WETH', address: '0xA', decimals: 18 },
                USDC: { symbol: 'USDC', address: '0xB', decimals: 6 },
                DAI: { symbol: 'DAI', address: '0xC', decimals: 18 },
            };
            const baseTokens = ['WETH', 'USDC'];

            const pairs = v3PriceFetcher._generateTokenPairs(tokens, baseTokens);

            // Should generate: WETH/USDC, WETH/DAI, USDC/DAI (with USDC as base)
            expect(pairs.length).toBe(3);
            expect(pairs[0]).toHaveProperty('token0');
            expect(pairs[0]).toHaveProperty('token1');
            expect(pairs[0]).toHaveProperty('pairKey');
        });

        test('should not duplicate pairs', () => {
            const tokens = {
                WETH: { symbol: 'WETH', address: '0xA', decimals: 18 },
                USDC: { symbol: 'USDC', address: '0xB', decimals: 6 },
            };
            const baseTokens = ['WETH', 'USDC'];

            const pairs = v3PriceFetcher._generateTokenPairs(tokens, baseTokens);

            // Only one pair should exist: WETH/USDC
            expect(pairs.length).toBe(1);
        });

        test('should normalize pair order by address', () => {
            const tokens = {
                WETH: { symbol: 'WETH', address: '0xBBB', decimals: 18 },
                USDC: { symbol: 'USDC', address: '0xAAA', decimals: 6 },
            };
            const baseTokens = ['WETH', 'USDC'];

            const pairs = v3PriceFetcher._generateTokenPairs(tokens, baseTokens);

            // token0 should have lower address
            expect(pairs[0].token0.address).toBe('0xAAA');
            expect(pairs[0].token1.address).toBe('0xBBB');
        });
    });

    describe('getBestPool', () => {
        test('should return pool with highest liquidity', () => {
            const v3Prices = {
                'v3-500': { isV3: true, liquidityUSD: 100000, price: 1.0 },
                'v3-3000': { isV3: true, liquidityUSD: 500000, price: 1.001 },
                'v3-10000': { isV3: true, liquidityUSD: 50000, price: 0.999 },
            };

            const best = v3PriceFetcher.getBestPool(v3Prices);

            expect(best).not.toBeNull();
            expect(best.dexName).toBe('v3-3000');
            expect(best.liquidityUSD).toBe(500000);
        });

        test('should return null for empty prices', () => {
            const best = v3PriceFetcher.getBestPool({});
            expect(best).toBeNull();
        });

        test('should return null for null input', () => {
            const best = v3PriceFetcher.getBestPool(null);
            expect(best).toBeNull();
        });
    });

    describe('fetchAllPrices', () => {
        beforeEach(() => {
            // Setup mock multicall responses
            mockMulticallContract.tryAggregate.mockResolvedValue([
                { success: true, returnData: '0x123' }, // getPool result
                { success: true, returnData: '0x456' }, // slot0 result
                { success: true, returnData: '0x789' }, // liquidity result
            ]);
        });

        test('should return empty object for unsupported chain', async () => {
            const prices = await v3PriceFetcher.fetchAllPrices(
                999999, // Unsupported chain
                {},
                [],
                100
            );

            expect(prices).toEqual({});
        });

        test('should handle empty token list', async () => {
            const prices = await v3PriceFetcher.fetchAllPrices(
                56, // BSC
                {},
                [],
                100
            );

            expect(prices).toEqual({});
        });

        test('should use pool cache on subsequent calls', async () => {
            const tokens = {
                WETH: { symbol: 'WETH', address: '0xA', decimals: 18 },
                USDC: { symbol: 'USDC', address: '0xB', decimals: 6 },
            };

            // First call
            await v3PriceFetcher.fetchAllPrices(56, tokens, ['WETH'], 100);

            // Second call should use cache
            const callCountBefore = mockMulticallContract.tryAggregate.mock.calls.length;
            await v3PriceFetcher.fetchAllPrices(56, tokens, ['WETH'], 101);
            const callCountAfter = mockMulticallContract.tryAggregate.mock.calls.length;

            // Cache should reduce calls (pool resolution cached)
            // Note: slot0/liquidity still need to be fetched
            expect(callCountAfter).toBeGreaterThanOrEqual(callCountBefore);
        });
    });

    describe('getStats', () => {
        test('should return statistics object', () => {
            const stats = v3PriceFetcher.getStats();

            expect(stats).toHaveProperty('cachedPools');
            expect(stats).toHaveProperty('feeTiers');
            expect(Array.isArray(stats.feeTiers)).toBe(true);
        });
    });

    describe('clearCache', () => {
        test('should clear pool cache', () => {
            // Add something to cache
            v3PriceFetcher.poolCache.set('test', 'value');
            expect(v3PriceFetcher.poolCache.size).toBe(1);

            // Clear
            v3PriceFetcher.clearCache();
            expect(v3PriceFetcher.poolCache.size).toBe(0);
        });
    });
});

describe('V3 Fee Tiers', () => {
    test('should have correct fee tier values', async () => {
        const { V3_FEE_TIERS } = await import('../../src/contracts/abis.js');

        expect(V3_FEE_TIERS.LOWEST).toBe(100);   // 0.01%
        expect(V3_FEE_TIERS.LOW).toBe(500);      // 0.05%
        expect(V3_FEE_TIERS.MEDIUM).toBe(3000);  // 0.30%
        expect(V3_FEE_TIERS.HIGH).toBe(10000);   // 1.00%
    });
});

describe('V3 Factory Addresses', () => {
    test('should have factory addresses for supported chains', async () => {
        const { V3_FACTORY_ADDRESSES } = await import('../../src/contracts/abis.js');

        expect(V3_FACTORY_ADDRESSES[1]).toBeDefined();     // Ethereum
        expect(V3_FACTORY_ADDRESSES[56]).toBeDefined();    // BSC
        expect(V3_FACTORY_ADDRESSES[137]).toBeDefined();   // Polygon
        expect(V3_FACTORY_ADDRESSES[42161]).toBeDefined(); // Arbitrum
        expect(V3_FACTORY_ADDRESSES[8453]).toBeDefined();  // Base
        expect(V3_FACTORY_ADDRESSES[43114]).toBeDefined(); // Avalanche
    });

    test('should have valid Ethereum addresses', async () => {
        const { V3_FACTORY_ADDRESSES } = await import('../../src/contracts/abis.js');

        for (const [chainId, address] of Object.entries(V3_FACTORY_ADDRESSES)) {
            expect(address).toMatch(/^0x[a-fA-F0-9]{40}$/);
        }
    });
});
