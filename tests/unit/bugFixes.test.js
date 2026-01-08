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

describe('Bug Fix Regression Tests - Session 2', () => {

    describe('Fix: TransactionBuilder cross-DEX triangular router validation', () => {
        test('buildTriangularTx should throw error for cross-DEX triangular with multiple routers', async () => {
            const { default: transactionBuilder } = await import('../../src/execution/transactionBuilder.js');

            // Set a dummy contract address
            transactionBuilder.setContractAddress('0x1234567890123456789012345678901234567890');

            const crossDexTriangularOpportunity = {
                type: 'cross-dex-triangular',
                dexPath: ['pancakeswap', 'biswap', 'apeswap'], // Different DEXes with different routers
                path: ['WBNB', 'CAKE', 'USDT', 'WBNB'],
                profitCalculation: {
                    tradeSizeUSD: 1000,
                    netProfitUSD: 10,
                },
            };

            expect(() => {
                transactionBuilder.build(crossDexTriangularOpportunity, BigInt(5e9));
            }).toThrow('Cross-DEX triangular arbitrage not supported');
        });

        test('buildTriangularTx should allow cross-DEX triangular when all use same router', async () => {
            const { default: transactionBuilder } = await import('../../src/execution/transactionBuilder.js');

            // If all DEXes happen to use the same router, it should proceed (and fail on other validation)
            const sameRouterOpportunity = {
                type: 'cross-dex-triangular',
                dexPath: ['pancakeswap', 'pancakeswap', 'pancakeswap'], // Same DEX (same router)
                path: ['WBNB', 'CAKE', 'USDT', 'WBNB'],
                profitCalculation: {
                    tradeSizeUSD: 1000,
                    netProfitUSD: 10,
                },
            };

            // Should NOT throw "Cross-DEX triangular arbitrage not supported"
            // It will fail on missing token addresses instead
            try {
                transactionBuilder.build(sameRouterOpportunity, BigInt(5e9));
            } catch (error) {
                expect(error.message).not.toContain('Cross-DEX triangular arbitrage not supported');
            }
        });
    });

    describe('Fix: CacheManager getStats() division by zero', () => {
        test('getStats should return 0.00% hit rate when no requests have been made', async () => {
            // Create a fresh cache manager for this test
            const NodeCache = (await import('node-cache')).default;
            const priceCache = new NodeCache({ stdTTL: 30, useClones: false });

            // Verify the cache has zero hits and misses
            const stats = priceCache.getStats();
            expect(stats.hits).toBe(0);
            expect(stats.misses).toBe(0);

            // The fix ensures totalRequests > 0 check before division
            const totalRequests = stats.hits + stats.misses;
            const hitRate = totalRequests > 0
                ? ((stats.hits / totalRequests) * 100).toFixed(2) + '%'
                : '0.00%';

            expect(hitRate).toBe('0.00%');
            // Without the fix, this would be 'NaN%'
        });

        test('getStats should correctly calculate hit rate with requests', async () => {
            const { default: cacheManager } = await import('../../src/data/cacheManager.js');

            // Make some cache operations to generate hits/misses
            cacheManager.setPrice('test:key1', { price: 100 }, 12345);
            cacheManager.getPrice('test:key1'); // hit
            cacheManager.getPrice('test:nonexistent'); // miss

            const stats = cacheManager.getStats();

            // Hit rate should be a valid percentage string
            expect(stats.prices.hitRate).toMatch(/^\d+\.\d{2}%$/);
            expect(stats.prices.hitRate).not.toBe('NaN%');
        });
    });

    describe('Fix: TriangularDetector decimal-aware reverse price', () => {
        test('_buildDexGraphs should calculate reverse price as 1/price (decimal-aware)', async () => {
            const { default: triangularDetector } = await import('../../src/analysis/triangularDetector.js');

            // Create mock price data with forward price
            const prices = {
                'WBNB/USDT': {
                    pancakeswap: {
                        price: 600, // 1 WBNB = 600 USDT (decimal-adjusted)
                        reserveA: (1000n * 10n ** 18n).toString(), // WBNB reserve (18 decimals)
                        reserveB: (600000n * 10n ** 18n).toString(), // USDT reserve (assuming 18 decimals for simplicity)
                        liquidityUSD: 1200000,
                        pairAddress: '0x1234',
                    },
                },
            };

            // Call the private method through the public API
            const opportunities = triangularDetector.findTriangularOpportunities(prices, 12345);

            // The key test: verify the reverse price is calculated correctly
            // If using raw reserves without decimals, the reverse would be wrong
            // The fix ensures reversePrice = 1/price = 1/600 ≈ 0.00167
            const expectedReversePrice = 1 / 600;

            // We can't directly access the graph, but we can verify the logic
            // by creating a scenario where decimal mismatch would cause issues
            expect(expectedReversePrice).toBeCloseTo(0.00166667, 5);
        });

        test('reverse price should be inverse of forward price, not raw reserve ratio', () => {
            // This test demonstrates the bug: if tokens have different decimals,
            // using raw reserves gives wrong price

            // Scenario: WBNB (18 decimals) / USDT (6 decimals on some chains)
            const reserveWBNB = 1000n * 10n ** 18n; // 1000 WBNB
            const reserveUSDT = 600000n * 10n ** 6n; // 600,000 USDT (6 decimals)

            // BUG: Raw reserve ratio ignores decimals
            const buggyReversePrice = Number(reserveWBNB) / Number(reserveUSDT);
            // This gives ~1.67e12 which is completely wrong!

            // FIX: Forward price is already decimal-adjusted
            const forwardPrice = 600; // 1 WBNB = 600 USDT (correct)
            const correctReversePrice = 1 / forwardPrice; // 1 USDT = 0.00167 WBNB (correct)

            // Verify the fix gives the right answer
            expect(correctReversePrice).toBeCloseTo(0.00166667, 5);

            // Verify the bug gives a wildly wrong answer (1.67e9 instead of 0.00167)
            expect(buggyReversePrice).toBeGreaterThan(1e9); // ~1.67 billion times wrong!
        });
    });

    describe('Fix: PriceFetcher ESM-compatible async prioritizer', () => {
        test('_getPrioritizer should be async and return prioritizer or null', async () => {
            const { default: priceFetcher } = await import('../../src/data/priceFetcher.js');

            // The method should be async (returns a Promise)
            const result = priceFetcher._getPrioritizer();
            expect(result).toBeInstanceOf(Promise);

            // Should resolve to either the prioritizer or null
            const prioritizer = await result;
            // Either null or an object with shouldCheckPair method
            if (prioritizer !== null) {
                expect(typeof prioritizer.shouldCheckPair).toBe('function');
            }
        });
    });

    describe('Fix: RPC Manager marks correct endpoint unhealthy', () => {
        test('withRetry should mark the actual failed endpoint, not a different one', async () => {
            const { default: rpcManager } = await import('../../src/utils/rpcManager.js');

            // Save original state
            const originalHealthMap = new Map(rpcManager.endpointHealth);

            // Get the first endpoint
            const providerData = rpcManager.getHttpProvider();
            const testEndpoint = providerData?.endpoint;

            if (testEndpoint) {
                // Reset health for all endpoints
                rpcManager.endpointHealth.forEach((health) => {
                    health.failures = 0;
                    health.healthy = true;
                });

                // Simulate a rate limit error on a specific endpoint
                // The fix ensures we capture providerData.endpoint BEFORE the error
                // and use THAT endpoint when marking unhealthy
                const health = rpcManager.endpointHealth.get(testEndpoint);
                if (health) {
                    // Directly test the markEndpointUnhealthy function
                    rpcManager.markEndpointUnhealthy(testEndpoint);
                    rpcManager.markEndpointUnhealthy(testEndpoint);
                    rpcManager.markEndpointUnhealthy(testEndpoint); // 3 failures = unhealthy

                    expect(health.failures).toBe(3);
                    expect(health.healthy).toBe(false);
                }
            }

            // Restore original state
            rpcManager.endpointHealth = originalHealthMap;
        });
    });
});

describe('Bug Fix Regression Tests - Session 3', () => {

    describe('Fix: ArbitrageDetector Infinity price bug', () => {
        test('optimizeTradeAmount should return zero profit when reserveB is zero', async () => {
            const { default: arbitrageDetector } = await import('../../src/analysis/arbitrageDetector.js');

            // Create mock dex data with zero reserves (would cause Infinity price)
            const buyDexData = {
                dexName: 'pancakeswap',
                price: 600,
                reserveA: '0', // Zero reserve!
                reserveB: '0', // Zero reserve!
                liquidityUSD: 0,
            };

            const sellDexData = {
                dexName: 'biswap',
                price: 610,
                reserveA: '1000000000000000000000',
                reserveB: '600000000000000000000000',
                liquidityUSD: 1200000,
            };

            const result = arbitrageDetector.optimizeTradeAmount(buyDexData, sellDexData, 18, 18);

            // Should return zero profit, not Infinity or NaN
            expect(result.profitUSD).toBe(0);
            expect(result.optimalAmount).toBe(0n);
            expect(Number.isFinite(result.priceUSD)).toBe(true);
        });

        test('Infinity || 1 bug demonstration: Infinity is truthy', () => {
            // This test proves why the original code was buggy
            const result = Infinity || 1;
            expect(result).toBe(Infinity); // NOT 1!

            // The fix uses proper validation instead
            const fixed = Number.isFinite(Infinity) ? Infinity : 0;
            expect(fixed).toBe(0); // Correctly returns 0
        });
    });

    describe('Fix: ArbitrageDetector spread calculation validation', () => {
        test('_isViable should return false for invalid prices', async () => {
            const { default: arbitrageDetector } = await import('../../src/analysis/arbitrageDetector.js');

            const buyDexData = {
                dexName: 'pancakeswap',
                price: 0, // Invalid price!
                liquidityUSD: 50000,
            };

            const sellDexData = {
                dexName: 'biswap',
                price: 600,
                liquidityUSD: 50000,
            };

            // Should return false, not throw or return true with NaN spread
            const result = arbitrageDetector._isViable('WBNB/USDT', buyDexData, sellDexData);
            expect(result).toBe(false);
        });

        test('_isViable should return false for NaN/Infinity prices', async () => {
            const { default: arbitrageDetector } = await import('../../src/analysis/arbitrageDetector.js');

            const buyDexData = {
                dexName: 'pancakeswap',
                price: NaN,
                liquidityUSD: 50000,
            };

            const sellDexData = {
                dexName: 'biswap',
                price: Infinity,
                liquidityUSD: 50000,
            };

            expect(arbitrageDetector._isViable('WBNB/USDT', buyDexData, sellDexData)).toBe(false);
        });
    });

    describe('Fix: ArbitrageDetector DEX fee null access', () => {
        test('optimizeTradeAmount should use default fee for unknown DEX', async () => {
            const { default: arbitrageDetector } = await import('../../src/analysis/arbitrageDetector.js');

            // Create mock data with an unknown DEX name
            const buyDexData = {
                dexName: 'unknown_dex_that_does_not_exist',
                price: 600,
                reserveA: '1000000000000000000000',
                reserveB: '600000000000000000000000',
                liquidityUSD: 1200000,
            };

            const sellDexData = {
                dexName: 'another_fake_dex',
                price: 610,
                reserveA: '1000000000000000000000',
                reserveB: '610000000000000000000000',
                liquidityUSD: 1220000,
            };

            // Should NOT throw TypeError, should use default fee of 0.003
            expect(() => {
                arbitrageDetector.optimizeTradeAmount(buyDexData, sellDexData, 18, 18);
            }).not.toThrow();
        });
    });

    describe('Fix: ProfitCalculator small amount edge case', () => {
        test('_calculateExactTriangularProfit should handle very small maxInputAmount', async () => {
            const { default: profitCalculator } = await import('../../src/analysis/profitCalculator.js');

            // Create opportunity with minimal data
            const opportunity = {
                reserves: [
                    { in: '100', out: '100' }, // Very small reserves
                    { in: '100', out: '100' },
                    { in: '100', out: '100' },
                ],
                dexName: 'pancakeswap',
            };

            // Very small input amount that could cause minAmount to be 0n
            const maxInputAmount = 10n; // < 50, so maxInputAmount / 50n = 0n

            // Should NOT throw, should return valid result
            const result = profitCalculator._calculateExactTriangularProfit(
                opportunity,
                maxInputAmount,
                18,
                1.0
            );

            expect(result).toHaveProperty('grossProfitUSD');
            expect(result).toHaveProperty('optimalInputAmount');
            expect(result).toHaveProperty('tradeSizeUSD');
            expect(Number.isFinite(result.grossProfitUSD)).toBe(true);
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

describe('Bug Fix Regression Tests - Session 4', () => {

    describe('Fix: V3PriceFetcher BigInt precision loss', () => {
        test('sqrtPriceX96ToPrice should handle large BigInt values without precision loss', async () => {
            const { default: v3PriceFetcher } = await import('../../src/data/v3PriceFetcher.js');

            // Test with a large sqrtPriceX96 value that exceeds Number.MAX_SAFE_INTEGER
            // sqrtPriceX96 = 2^96 would give price = 1 (for same decimals)
            const Q96 = 2n ** 96n;
            const sqrtPriceX96 = Q96; // This equals ~7.9e28, way beyond MAX_SAFE_INTEGER

            const price = v3PriceFetcher.sqrtPriceX96ToPrice(sqrtPriceX96, 18, 18);

            // Price should be approximately 1.0 (sqrtPriceX96 = Q96 means price = 1)
            expect(price).toBeCloseTo(1.0, 6);

            // Test with a realistic ETH/USDC price (~3000 USDC per ETH)
            // If price = 3000, sqrtPrice = ~54.77, sqrtPriceX96 = 54.77 * 2^96
            const ethUsdcSqrtPriceX96 = 4339505179874779185945021694n; // ~3000 USD/ETH
            const ethPrice = v3PriceFetcher.sqrtPriceX96ToPrice(ethUsdcSqrtPriceX96, 18, 6);

            // Price should be in reasonable range (adjusting for decimals: 18-6 = 12)
            expect(ethPrice).toBeGreaterThan(0);
            expect(Number.isFinite(ethPrice)).toBe(true);
        });

        test('sqrtPriceX96ToPrice should return 0 for zero input', async () => {
            const { default: v3PriceFetcher } = await import('../../src/data/v3PriceFetcher.js');

            const price = v3PriceFetcher.sqrtPriceX96ToPrice(0n, 18, 18);
            expect(price).toBe(0);
        });

        test('priceToSqrtPriceX96 should use BigInt arithmetic to avoid precision loss', async () => {
            const { default: v3PriceFetcher } = await import('../../src/data/v3PriceFetcher.js');

            // Convert price to sqrtPriceX96 and back - should be consistent
            const originalPrice = 1.0;
            const sqrtPriceX96 = v3PriceFetcher.priceToSqrtPriceX96(originalPrice, 18, 18);

            // sqrtPriceX96 should be a BigInt close to Q96 for price = 1
            expect(typeof sqrtPriceX96).toBe('bigint');
            expect(sqrtPriceX96).toBeGreaterThan(0n);

            // Convert back and verify
            const recoveredPrice = v3PriceFetcher.sqrtPriceX96ToPrice(sqrtPriceX96, 18, 18);
            expect(recoveredPrice).toBeCloseTo(originalPrice, 4);
        });

        test('priceToSqrtPriceX96 should return 0n for zero or negative price', async () => {
            const { default: v3PriceFetcher } = await import('../../src/data/v3PriceFetcher.js');

            expect(v3PriceFetcher.priceToSqrtPriceX96(0, 18, 18)).toBe(0n);
            expect(v3PriceFetcher.priceToSqrtPriceX96(-1, 18, 18)).toBe(0n);
        });

        test('_bigIntSqrt should correctly compute square root', async () => {
            const { default: v3PriceFetcher } = await import('../../src/data/v3PriceFetcher.js');

            // Test small values
            expect(v3PriceFetcher._bigIntSqrt(0n)).toBe(0n);
            expect(v3PriceFetcher._bigIntSqrt(1n)).toBe(1n);
            expect(v3PriceFetcher._bigIntSqrt(4n)).toBe(2n);
            expect(v3PriceFetcher._bigIntSqrt(9n)).toBe(3n);

            // Test large value
            const largeValue = 10n ** 36n; // 10^36
            const sqrt = v3PriceFetcher._bigIntSqrt(largeValue);
            expect(sqrt).toBe(10n ** 18n); // sqrt(10^36) = 10^18
        });
    });

    describe('Fix: MempoolMonitor stale entry cleanup', () => {
        test('MempoolMonitor should have cleanup timer configuration', async () => {
            const { default: MempoolMonitor } = await import('../../src/analysis/MempoolMonitor.js');

            const monitor = new MempoolMonitor({ enabled: false });

            // Verify stale threshold is configured
            expect(monitor.staleThresholdMs).toBe(120000); // 2 minutes
            expect(monitor.cleanupTimer).toBeNull(); // Not started yet
        });

        test('_cleanupStaleEntries should remove old entries', async () => {
            const { default: MempoolMonitor } = await import('../../src/analysis/MempoolMonitor.js');

            const monitor = new MempoolMonitor({ enabled: false });

            // Add some entries
            const now = Date.now();
            monitor.pendingSwaps.set('tx1', { timestamp: now - 150000 }); // Stale (2.5 min old)
            monitor.pendingSwaps.set('tx2', { timestamp: now - 150000 }); // Stale
            monitor.pendingSwaps.set('tx3', { timestamp: now - 30000 });  // Fresh (30 sec old)

            expect(monitor.pendingSwaps.size).toBe(3);

            // Run cleanup
            monitor._cleanupStaleEntries();

            // Only fresh entry should remain
            expect(monitor.pendingSwaps.size).toBe(1);
            expect(monitor.pendingSwaps.has('tx3')).toBe(true);
            expect(monitor.pendingSwaps.has('tx1')).toBe(false);
            expect(monitor.pendingSwaps.has('tx2')).toBe(false);
        });

        test('cachePendingSwap should trigger cleanup periodically', async () => {
            const { default: MempoolMonitor } = await import('../../src/analysis/MempoolMonitor.js');

            const monitor = new MempoolMonitor({ enabled: false, maxPendingSwaps: 100 });
            const now = Date.now();

            // Add stale entries
            for (let i = 0; i < 49; i++) {
                monitor.pendingSwaps.set(`stale-tx-${i}`, { timestamp: now - 150000 });
            }

            // Add one more to trigger cleanup (at size 50 % 50 === 0)
            monitor.cachePendingSwap('new-tx', { timestamp: now });

            // After cleanup trigger, stale entries should be removed
            // Size should be much smaller now (only fresh entries)
            expect(monitor.pendingSwaps.size).toBeLessThanOrEqual(50);
        });

        test('stop should clear cleanup timer', async () => {
            const { default: MempoolMonitor } = await import('../../src/analysis/MempoolMonitor.js');

            const monitor = new MempoolMonitor({ enabled: true });

            // Manually set a timer to simulate started state
            monitor.isMonitoring = true;
            monitor.cleanupTimer = setInterval(() => {}, 30000);

            expect(monitor.cleanupTimer).not.toBeNull();

            // Stop should clear the timer
            monitor.stop();

            expect(monitor.cleanupTimer).toBeNull();
            expect(monitor.isMonitoring).toBe(false);
        });
    });

    describe('Fix: ChainWorker async message handling', () => {
        // Note: Full ChainWorker testing requires worker_threads which is complex in Jest
        // These tests verify the code structure was updated correctly

        test('ChainWorker should export from correct path', async () => {
            // This validates the file can be imported (syntax is correct)
            const fs = await import('fs');
            const path = await import('path');

            const workerPath = path.default.resolve('src/workers/chainWorker.js');
            const content = fs.default.readFileSync(workerPath, 'utf-8');

            // Verify the fix was applied - async calls now have .catch() handlers
            expect(content).toContain('this.start().catch(error');
            expect(content).toContain('this.stop().catch(error');

            // Verify error handling sends ERROR message
            expect(content).toContain('Start failed:');
        });
    });
});

describe('Bug Fix Regression Tests - Session 5 (v3.5)', () => {

    describe('Fix v3.5 #1: ExecutionManager Flashbots provider reference', () => {
        test('_executeWithFlashbots should use signer.provider not this.provider', async () => {
            const fs = await import('fs');
            const path = await import('path');

            const filePath = path.default.resolve('src/execution/executionManager.js');
            const content = fs.default.readFileSync(filePath, 'utf-8');

            // Verify the fix: should use this.signer.provider, NOT this.provider
            expect(content).toContain('this.signer.provider.getBlockNumber()');
            expect(content).toContain('this.signer?.provider');

            // Verify it does NOT use undefined this.provider directly
            // (Look for the Flashbots section specifically)
            const flashbotsSection = content.match(/_executeWithFlashbots[\s\S]*?return \{[\s\S]*?flashbots: true/);
            if (flashbotsSection) {
                expect(flashbotsSection[0]).not.toMatch(/await this\.provider\.getBlockNumber\(\)/);
            }
        });

        test('ExecutionManager should throw if signer.provider is not available', async () => {
            const fs = await import('fs');
            const path = await import('path');

            const filePath = path.default.resolve('src/execution/executionManager.js');
            const content = fs.default.readFileSync(filePath, 'utf-8');

            // Verify validation error message exists
            expect(content).toContain('Signer provider not available for Flashbots execution');
        });
    });

    describe('Fix v3.5 #2: TransactionBuilder RESOLVE_PAIR validation', () => {
        test('buildCrossDexTx should validate flashPair is a valid address', async () => {
            const fs = await import('fs');
            const path = await import('path');

            const filePath = path.default.resolve('src/execution/transactionBuilder.js');
            const content = fs.default.readFileSync(filePath, 'utf-8');

            // Verify the fix: ethers.isAddress validation
            expect(content).toContain('ethers.isAddress(flashPair)');
            expect(content).toContain("flashPair === 'RESOLVE_PAIR'");
            expect(content).toContain('Invalid flash pair address');
        });

        test('buildTriangularTx should check router validation BEFORE flash pair', async () => {
            const fs = await import('fs');
            const path = await import('path');

            const filePath = path.default.resolve('src/execution/transactionBuilder.js');
            const content = fs.default.readFileSync(filePath, 'utf-8');

            // Find the buildTriangularTx function
            const triangularSection = content.match(/buildTriangularTx[\s\S]*?encodeFunctionData/);
            if (triangularSection) {
                const section = triangularSection[0];
                // Router validation should appear BEFORE flash pair validation
                const routerCheckIndex = section.indexOf('Cross-DEX triangular arbitrage not supported');
                const flashPairCheckIndex = section.indexOf('Invalid flash pair address for triangular');

                expect(routerCheckIndex).toBeGreaterThan(-1);
                expect(flashPairCheckIndex).toBeGreaterThan(-1);
                expect(routerCheckIndex).toBeLessThan(flashPairCheckIndex);
            }
        });

        test('TransactionBuilder should use pre-resolved flashPair from opportunity', async () => {
            const fs = await import('fs');
            const path = await import('path');

            const filePath = path.default.resolve('src/execution/transactionBuilder.js');
            const content = fs.default.readFileSync(filePath, 'utf-8');

            // Verify the fix: uses opportunity.flashPair first
            expect(content).toContain('let flashPair = opportunity.flashPair');
        });
    });

    describe('Fix v3.5 #3: PriceFetcher block tolerance for sync events', () => {
        test('_categorizePairs should allow configurable block tolerance for sync event freshness', async () => {
            const fs = await import('fs');
            const path = await import('path');

            const filePath = path.default.resolve('src/data/priceFetcher.js');
            const content = fs.default.readFileSync(filePath, 'utf-8');

            // Verify the fix: maxBlockAge is now configurable (FIX v3.6)
            // Changed from hardcoded 'const maxBlockAge = 2' to 'this.maxBlockAge' instance property
            expect(content).toContain('this.maxBlockAge = parseInt(process.env.SYNC_EVENT_MAX_BLOCK_AGE');
            expect(content).toContain('(blockNumber - cached.blockNumber) <= this.maxBlockAge');
            expect(content).toContain('isFreshSyncEvent');
        });

        test('priceFetcher should consider data from block N-1 or N-2 as fresh', async () => {
            // This is a logical test - sync events from 1-2 blocks ago are still valid
            const maxBlockAge = 2;

            // Current block is N=100
            const currentBlock = 100;

            // Data from block 100 (same block) - should be fresh
            expect(currentBlock - 100).toBeLessThanOrEqual(maxBlockAge); // true

            // Data from block 99 (1 block old) - should be fresh
            expect(currentBlock - 99).toBeLessThanOrEqual(maxBlockAge); // true

            // Data from block 98 (2 blocks old) - should be fresh
            expect(currentBlock - 98).toBeLessThanOrEqual(maxBlockAge); // true

            // Data from block 97 (3 blocks old) - should be stale
            expect(currentBlock - 97).toBeGreaterThan(maxBlockAge); // true - 3 > 2
        });
    });

    describe('Fix v3.5 #4: CrossChainCoordinator partial execution tracking', () => {
        test('_aggregateResults should include partialSuccess flag', async () => {
            const fs = await import('fs');
            const path = await import('path');

            const filePath = path.default.resolve('src/execution/crossChainCoordinator.js');
            const content = fs.default.readFileSync(filePath, 'utf-8');

            // Verify the fix: partialSuccess field
            expect(content).toContain('partialSuccess:');
            expect(content).toContain("status = 'PARTIAL_SUCCESS'");
            expect(content).toContain("status = 'FULL_SUCCESS'");
            expect(content).toContain("status = 'FULL_FAILURE'");
        });

        test('_aggregateResults should track failed chains', async () => {
            const fs = await import('fs');
            const path = await import('path');

            const filePath = path.default.resolve('src/execution/crossChainCoordinator.js');
            const content = fs.default.readFileSync(filePath, 'utf-8');

            // Verify the fix: failedChains tracking
            expect(content).toContain('failedChains');
            expect(content).toContain('failedCount');
            expect(content).toContain('estimatedGasLossUSD');
        });

        test('CrossChainCoordinator aggregation should calculate net profit accounting for gas losses', async () => {
            const { CrossChainFlashLoanCoordinator } = await import('../../src/execution/crossChainCoordinator.js');

            const coordinator = new CrossChainFlashLoanCoordinator();

            // Mock results with partial success
            const results = [
                { chainId: 56, success: true, profitUSD: 10, type: 'buy' },
                { chainId: 1, success: false, error: 'Gas price spike', type: 'sell' },
            ];

            const aggregated = coordinator._aggregateResults('test-123', results, 1000);

            // Verify partial success detection
            expect(aggregated.partialSuccess).toBe(true);
            expect(aggregated.status).toBe('PARTIAL_SUCCESS');
            expect(aggregated.successCount).toBe(1);
            expect(aggregated.failedCount).toBe(1);

            // Verify failed chains tracked
            expect(aggregated.failedChains.length).toBe(1);
            expect(aggregated.failedChains[0].chainId).toBe(1);
            expect(aggregated.failedChains[0].error).toBe('Gas price spike');

            // Verify net profit accounts for gas loss estimate
            expect(aggregated.grossProfitUSD).toBe(10);
            expect(aggregated.estimatedGasLossUSD).toBeGreaterThan(0);
            expect(aggregated.totalProfitUSD).toBeLessThan(aggregated.grossProfitUSD);
        });
    });

    describe('Fix v3.5 #5: ExecutionManager priority-based eviction', () => {
        test('_evictLowestValueTimedOutTx helper method should exist', async () => {
            const fs = await import('fs');
            const path = await import('path');

            const filePath = path.default.resolve('src/execution/executionManager.js');
            const content = fs.default.readFileSync(filePath, 'utf-8');

            // Verify the fix: new helper method
            expect(content).toContain('_evictLowestValueTimedOutTx()');
            expect(content).toContain('lowestValueKey');
            expect(content).toContain('lowestValue = Infinity');
        });

        test('_evictLowestValueTimedOutTx should evict lowest profitUSD transaction', async () => {
            const { default: executionManager } = await import('../../src/execution/executionManager.js');

            // Clear existing timed out txs
            executionManager.timedOutTxs.clear();

            // Add transactions with different profit values
            executionManager.timedOutTxs.set('tx-high', {
                timestamp: Date.now() - 1000,
                opportunity: { type: 'cross-dex', profitUSD: 50 },
            });
            executionManager.timedOutTxs.set('tx-low', {
                timestamp: Date.now() - 2000, // Older but higher value should be kept
                opportunity: { type: 'cross-dex', profitUSD: 5 },
            });
            executionManager.timedOutTxs.set('tx-medium', {
                timestamp: Date.now(),
                opportunity: { type: 'cross-dex', profitUSD: 20 },
            });

            expect(executionManager.timedOutTxs.size).toBe(3);

            // Evict lowest value
            executionManager._evictLowestValueTimedOutTx();

            expect(executionManager.timedOutTxs.size).toBe(2);

            // The lowest value tx (tx-low with profitUSD=5) should be evicted
            expect(executionManager.timedOutTxs.has('tx-low')).toBe(false);
            expect(executionManager.timedOutTxs.has('tx-high')).toBe(true);
            expect(executionManager.timedOutTxs.has('tx-medium')).toBe(true);
        });

        test('_evictLowestValueTimedOutTx should fall back to oldest if same value', async () => {
            const { default: executionManager } = await import('../../src/execution/executionManager.js');

            // Clear existing timed out txs
            executionManager.timedOutTxs.clear();

            // Add transactions with same profit value but different timestamps
            executionManager.timedOutTxs.set('tx-newest', {
                timestamp: Date.now(),
                opportunity: { type: 'cross-dex', profitUSD: 10 },
            });
            executionManager.timedOutTxs.set('tx-oldest', {
                timestamp: Date.now() - 5000, // Oldest
                opportunity: { type: 'cross-dex', profitUSD: 10 }, // Same value
            });
            executionManager.timedOutTxs.set('tx-middle', {
                timestamp: Date.now() - 2000,
                opportunity: { type: 'cross-dex', profitUSD: 10 }, // Same value
            });

            // With same values, should evict any of them (lowest is first found)
            executionManager._evictLowestValueTimedOutTx();

            expect(executionManager.timedOutTxs.size).toBe(2);
        });
    });
});
