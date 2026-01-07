import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { FlashLoanOptimizer } from '../../src/execution/flashLoanOptimizer.js';

describe('FlashLoanOptimizer', () => {
    let optimizer;

    beforeEach(() => {
        optimizer = new FlashLoanOptimizer();
    });

    afterEach(() => {
        optimizer.resetStats();
    });

    describe('constructor', () => {
        it('should initialize with default providers', () => {
            expect(optimizer.providers).toBeDefined();
            expect(optimizer.providers.length).toBeGreaterThan(0);
        });

        it('should have providers sorted by fee', () => {
            const fees = optimizer.providers.map(p => p.fee);
            // dYdX and Balancer should be 0
            expect(fees[0]).toBe(0);
            expect(fees[1]).toBe(0);
        });

        it('should initialize with BSC chain by default', () => {
            expect(optimizer.chainId).toBe(56);
        });

        it('should initialize stats', () => {
            expect(optimizer.stats.selectionsTotal).toBe(0);
            expect(optimizer.stats.estimatedSavings).toBe(0);
        });
    });

    describe('selectBestProvider', () => {
        it('should select PancakeSwap for BSC chain with any asset', () => {
            optimizer.chainId = 56;
            const result = optimizer.selectBestProvider('WBNB', 1000);

            expect(result).not.toBeNull();
            // On BSC, Aave V3 and PancakeSwap are available
            // Aave has lower fee (0.09%) than PancakeSwap (0.25%)
            expect(['aave_v3', 'pancakeswap']).toContain(result.name);
        });

        it('should select lowest fee provider when multiple are available', () => {
            optimizer.chainId = 1; // Ethereum
            // Manually add asset to cache for dYdX
            const cacheKey = 'dydx_1';
            optimizer.assetCache.set(cacheKey, new Set(['WETH', 'USDC', 'DAI']));
            optimizer.lastCacheUpdate.set(cacheKey, Date.now());

            const result = optimizer.selectBestProvider('WETH', 1000);

            expect(result).not.toBeNull();
            // dYdX has 0% fee on Ethereum for WETH
            expect(result.name).toBe('dydx');
            expect(result.fee).toBe(0);
        });

        it('should exclude specified providers', () => {
            optimizer.chainId = 56;
            const result = optimizer.selectBestProvider('WBNB', 1000, {
                excludeProviders: ['aave_v3'],
            });

            expect(result).not.toBeNull();
            expect(result.name).not.toBe('aave_v3');
        });

        it('should return null for unsupported chain', () => {
            optimizer.chainId = 99999; // Unsupported chain
            const result = optimizer.selectBestProvider('WETH', 1000);

            expect(result).toBeNull();
        });

        it('should increment stats on selection', () => {
            optimizer.chainId = 56;
            optimizer.selectBestProvider('WBNB', 1000);

            expect(optimizer.stats.selectionsTotal).toBe(1);
        });

        it('should calculate estimated savings vs default', () => {
            optimizer.chainId = 1; // Ethereum
            // Setup dYdX as available
            optimizer.assetCache.set('dydx_1', new Set(['WETH']));
            optimizer.lastCacheUpdate.set('dydx_1', Date.now());

            const amount = 10000;
            optimizer.selectBestProvider('WETH', amount);

            // dYdX is 0%, PancakeSwap is 0.25%
            // Savings should be 0.25% * 10000 = $25
            expect(optimizer.stats.estimatedSavings).toBeGreaterThan(0);
        });
    });

    describe('getAvailableProviders', () => {
        it('should return providers for BSC', () => {
            optimizer.chainId = 56;
            const providers = optimizer.getAvailableProviders();

            expect(providers.length).toBeGreaterThan(0);
            const names = providers.map(p => p.name);
            expect(names).toContain('pancakeswap');
            expect(names).toContain('aave_v3');
        });

        it('should return providers for Ethereum', () => {
            optimizer.chainId = 1;
            const providers = optimizer.getAvailableProviders();

            expect(providers.length).toBeGreaterThan(0);
            const names = providers.map(p => p.name);
            expect(names).toContain('dydx');
            expect(names).toContain('balancer');
            expect(names).toContain('aave_v3');
        });

        it('should filter out disabled providers', () => {
            optimizer.chainId = 56;
            optimizer.setProviderEnabled('pancakeswap', false);

            const providers = optimizer.getAvailableProviders();
            const names = providers.map(p => p.name);

            expect(names).not.toContain('pancakeswap');
        });
    });

    describe('isAssetSupported', () => {
        it('should return true for any asset with PancakeSwap on BSC', () => {
            optimizer.chainId = 56;
            expect(optimizer.isAssetSupported('RANDOM_TOKEN')).toBe(true);
        });

        it('should return true for known dYdX assets on Ethereum', () => {
            optimizer.chainId = 1;
            optimizer.assetCache.set('dydx_1', new Set(['WETH', 'USDC', 'DAI']));
            optimizer.lastCacheUpdate.set('dydx_1', Date.now());

            expect(optimizer.isAssetSupported('WETH')).toBe(true);
        });
    });

    describe('getProviderFee', () => {
        it('should return correct fee for dYdX', () => {
            expect(optimizer.getProviderFee('dydx')).toBe(0);
        });

        it('should return correct fee for Balancer', () => {
            expect(optimizer.getProviderFee('balancer')).toBe(0);
        });

        it('should return correct fee for Aave', () => {
            expect(optimizer.getProviderFee('aave_v3')).toBe(0.0009);
        });

        it('should return correct fee for PancakeSwap', () => {
            expect(optimizer.getProviderFee('pancakeswap')).toBe(0.0025);
        });

        it('should return default fee for unknown provider', () => {
            expect(optimizer.getProviderFee('unknown')).toBe(0.0025);
        });
    });

    describe('calculateCost', () => {
        it('should calculate total cost correctly', () => {
            const cost = optimizer.calculateCost('pancakeswap', 10000, 5);

            expect(cost).not.toBeNull();
            expect(cost.provider).toBe('pancakeswap');
            expect(cost.feeCostUSD).toBe(25); // 0.25% * 10000
            expect(cost.gasCostUSD).toBeGreaterThan(0);
            expect(cost.totalCostUSD).toBe(cost.feeCostUSD + cost.gasCostUSD);
        });

        it('should return null for unknown provider', () => {
            const cost = optimizer.calculateCost('unknown', 10000);
            expect(cost).toBeNull();
        });

        it('should calculate zero fee cost for dYdX', () => {
            const cost = optimizer.calculateCost('dydx', 10000, 5);

            expect(cost).not.toBeNull();
            expect(cost.feeCostUSD).toBe(0);
        });
    });

    describe('compareCosts', () => {
        it('should compare costs across providers', () => {
            optimizer.chainId = 56;
            const comparisons = optimizer.compareCosts('WBNB', 10000, 5);

            expect(comparisons.length).toBeGreaterThan(0);
            // Should be sorted by total cost
            for (let i = 1; i < comparisons.length; i++) {
                expect(comparisons[i].totalCostUSD).toBeGreaterThanOrEqual(
                    comparisons[i - 1].totalCostUSD
                );
            }
        });
    });

    describe('setProviderEnabled', () => {
        it('should disable a provider', () => {
            optimizer.setProviderEnabled('pancakeswap', false);
            const provider = optimizer.providers.find(p => p.name === 'pancakeswap');
            expect(provider.enabled).toBe(false);
        });

        it('should enable a provider', () => {
            optimizer.setProviderEnabled('pancakeswap', false);
            optimizer.setProviderEnabled('pancakeswap', true);
            const provider = optimizer.providers.find(p => p.name === 'pancakeswap');
            expect(provider.enabled).toBe(true);
        });
    });

    describe('initialize', () => {
        it('should set chain ID', async () => {
            await optimizer.initialize(137);
            expect(optimizer.chainId).toBe(137);
        });

        it('should use existing chain ID if not provided', async () => {
            optimizer.chainId = 42161;
            await optimizer.initialize();
            expect(optimizer.chainId).toBe(42161);
        });
    });

    describe('getStats', () => {
        it('should return comprehensive stats', () => {
            optimizer.chainId = 56;
            optimizer.selectBestProvider('WBNB', 1000);

            const stats = optimizer.getStats();

            expect(stats.selectionsTotal).toBe(1);
            expect(stats.chainId).toBe(56);
            expect(stats.availableProviders).toBeDefined();
            expect(Array.isArray(stats.availableProviders)).toBe(true);
        });
    });

    describe('resetStats', () => {
        it('should reset all statistics', () => {
            optimizer.chainId = 56;
            optimizer.selectBestProvider('WBNB', 1000);
            optimizer.resetStats();

            expect(optimizer.stats.selectionsTotal).toBe(0);
            expect(optimizer.stats.estimatedSavings).toBe(0);
        });
    });
});
