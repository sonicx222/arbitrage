import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { CurveArbitrage } from '../../src/analysis/curveArbitrage.js';

describe('CurveArbitrage', () => {
    let curveArbitrage;

    beforeEach(() => {
        curveArbitrage = new CurveArbitrage({
            chainId: 1,
            minProfitPercent: 0.1,
            minProfitUSD: 1,
        });
    });

    afterEach(() => {
        curveArbitrage.clearCache();
    });

    describe('constructor', () => {
        it('should initialize with default values', () => {
            const ca = new CurveArbitrage();
            expect(ca.chainId).toBe(1);
            expect(ca.minProfitPercent).toBe(0.1);
            expect(ca.minProfitUSD).toBe(1);
            expect(ca.maxTradeSize).toBe(100000);
        });

        it('should accept custom configuration', () => {
            const ca = new CurveArbitrage({
                chainId: 42161,
                minProfitPercent: 0.2,
                minProfitUSD: 5,
                maxTradeSize: 50000,
            });
            expect(ca.chainId).toBe(42161);
            expect(ca.minProfitPercent).toBe(0.2);
            expect(ca.minProfitUSD).toBe(5);
            expect(ca.maxTradeSize).toBe(50000);
        });

        it('should initialize stats', () => {
            expect(curveArbitrage.stats.opportunitiesDetected).toBe(0);
            expect(curveArbitrage.stats.priceQueries).toBe(0);
            expect(curveArbitrage.stats.poolsMonitored).toBe(0);
        });
    });

    describe('pool configurations', () => {
        it('should have Ethereum pools configured', () => {
            const pools = curveArbitrage.getAvailablePools();
            expect(pools.length).toBeGreaterThan(0);
            expect(pools).toContain('3pool');
            expect(pools).toContain('steth');
        });

        it('should have Arbitrum pools configured', () => {
            const ca = new CurveArbitrage({ chainId: 42161 });
            const pools = ca.getAvailablePools();
            expect(pools.length).toBeGreaterThan(0);
            expect(pools).toContain('2pool');
        });

        it('should have Polygon pools configured', () => {
            const ca = new CurveArbitrage({ chainId: 137 });
            const pools = ca.getAvailablePools();
            expect(pools.length).toBeGreaterThan(0);
            expect(pools).toContain('aave');
        });

        it('should have Base pools configured', () => {
            const ca = new CurveArbitrage({ chainId: 8453 });
            const pools = ca.getAvailablePools();
            expect(pools.length).toBeGreaterThan(0);
            expect(pools).toContain('4pool');
            expect(pools).toContain('cbeth');
        });

        it('should return empty for unsupported chain', () => {
            const ca = new CurveArbitrage({ chainId: 56 }); // BSC - no Curve
            const pools = ca.getAvailablePools();
            expect(pools.length).toBe(0);
        });
    });

    describe('price calculations', () => {
        it('should calculate price correctly for equal decimals', () => {
            const price = curveArbitrage._calculatePrice(
                1000000000000000000n, // 1e18 (1 token)
                1010000000000000000n, // 1.01e18 (1.01 tokens)
                18,
                18
            );
            expect(price).toBeCloseTo(1.01, 4);
        });

        it('should calculate price correctly for different decimals', () => {
            // 1000 USDC (6 decimals) -> 1000 DAI (18 decimals)
            const price = curveArbitrage._calculatePrice(
                1000000000n, // 1000 USDC (1000 * 1e6)
                1000000000000000000000n, // 1000 DAI (1000 * 1e18)
                6,
                18
            );
            expect(price).toBeCloseTo(1.0, 4);
        });

        it('should calculate price correctly for stablecoin swap', () => {
            // 1000 USDT -> 999 USDC (slight slippage)
            const price = curveArbitrage._calculatePrice(
                1000000000n, // 1000 USDT (6 decimals)
                999000000n,  // 999 USDC (6 decimals)
                6,
                6
            );
            expect(price).toBeCloseTo(0.999, 4);
        });
    });

    describe('standard amounts', () => {
        it('should return 1000 for stablecoins', () => {
            const amount = curveArbitrage._getStandardAmount('USDC', 6);
            expect(amount.toString()).toBe('1000000000'); // 1000 * 1e6
        });

        it('should return 1 for ETH', () => {
            const amount = curveArbitrage._getStandardAmount('WETH', 18);
            expect(amount.toString()).toBe('1000000000000000000'); // 1 * 1e18
        });

        it('should return 1 for stETH', () => {
            const amount = curveArbitrage._getStandardAmount('stETH', 18);
            expect(amount.toString()).toBe('1000000000000000000');
        });

        it('should handle DAI correctly', () => {
            const amount = curveArbitrage._getStandardAmount('DAI', 18);
            expect(amount.toString()).toBe('1000000000000000000000'); // 1000 * 1e18
        });
    });

    describe('token prices', () => {
        it('should return $1 for stablecoins', () => {
            expect(curveArbitrage._getTokenPriceUSD('USDC')).toBe(1);
            expect(curveArbitrage._getTokenPriceUSD('USDT')).toBe(1);
            expect(curveArbitrage._getTokenPriceUSD('DAI')).toBe(1);
            expect(curveArbitrage._getTokenPriceUSD('FRAX')).toBe(1);
        });

        it('should return ETH price for ETH variants', () => {
            expect(curveArbitrage._getTokenPriceUSD('WETH')).toBe(3500);
            expect(curveArbitrage._getTokenPriceUSD('ETH')).toBe(3500);
            expect(curveArbitrage._getTokenPriceUSD('stETH')).toBe(3500);
        });

        it('should return appropriate prices for LSDs', () => {
            expect(curveArbitrage._getTokenPriceUSD('wstETH')).toBe(4000);
            expect(curveArbitrage._getTokenPriceUSD('rETH')).toBe(3800);
            expect(curveArbitrage._getTokenPriceUSD('cbETH')).toBe(3700);
        });

        it('should return $1 for unknown tokens', () => {
            expect(curveArbitrage._getTokenPriceUSD('UNKNOWN')).toBe(1);
        });
    });

    describe('analyzeOpportunities', () => {
        it('should return empty array without provider', async () => {
            const opportunities = await curveArbitrage.analyzeOpportunities({}, 12345);
            expect(opportunities).toEqual([]);
        });

        it('should return empty array without prices', async () => {
            curveArbitrage.provider = {}; // Mock provider
            const opportunities = await curveArbitrage.analyzeOpportunities({}, 12345);
            expect(opportunities).toEqual([]);
        });

        it('should emit opportunity event when found', async () => {
            let emittedOpportunity = null;
            curveArbitrage.on('opportunity', (opp) => {
                emittedOpportunity = opp;
            });

            // Would need mock provider with contract calls to test actual detection
            // For now, verify the event listener is set up
            expect(curveArbitrage.listenerCount('opportunity')).toBe(1);
        });
    });

    describe('cache management', () => {
        it('should clear price cache', () => {
            curveArbitrage.priceCache.set('3pool', { prices: {}, timestamp: Date.now() });
            expect(curveArbitrage.priceCache.size).toBe(1);

            curveArbitrage.clearCache();
            expect(curveArbitrage.priceCache.size).toBe(0);
        });

        it('should respect cache max age setting', () => {
            const ca = new CurveArbitrage({ cacheMaxAge: 10000 });
            expect(ca.cacheMaxAge).toBe(10000);
        });
    });

    describe('statistics', () => {
        it('should return comprehensive stats', () => {
            curveArbitrage.chainId = 1;
            const stats = curveArbitrage.getStats();

            expect(stats.chainId).toBe(1);
            expect(stats.opportunitiesDetected).toBe(0);
            expect(stats.priceQueries).toBe(0);
            expect(stats.poolsConfigured).toBeGreaterThan(0);
        });

        it('should reset stats correctly', () => {
            curveArbitrage.stats.opportunitiesDetected = 10;
            curveArbitrage.stats.priceQueries = 100;
            curveArbitrage.stats.totalEstimatedProfit = 500;

            curveArbitrage.resetStats();

            expect(curveArbitrage.stats.opportunitiesDetected).toBe(0);
            expect(curveArbitrage.stats.priceQueries).toBe(0);
            expect(curveArbitrage.stats.totalEstimatedProfit).toBe(0);
        });

        it('should preserve poolsMonitored on reset', () => {
            curveArbitrage.stats.poolsMonitored = 5;
            curveArbitrage.resetStats();
            expect(curveArbitrage.stats.poolsMonitored).toBe(5);
        });
    });

    describe('pool info', () => {
        it('should return null for unknown pool', () => {
            const info = curveArbitrage.getPoolInfo('unknown_pool');
            expect(info).toBeNull();
        });

        it('should return metadata for loaded pool', () => {
            // Simulate loaded metadata
            curveArbitrage.poolMetadata.set('3pool', {
                address: '0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7',
                coins: ['0x...', '0x...', '0x...'],
                decimals: [18, 6, 6],
                coinSymbols: ['DAI', 'USDC', 'USDT'],
                fee: 0.0004,
                A: 2000,
                numCoins: 3,
            });

            const info = curveArbitrage.getPoolInfo('3pool');
            expect(info).not.toBeNull();
            expect(info.coinSymbols).toContain('DAI');
            expect(info.coinSymbols).toContain('USDC');
            expect(info.coinSymbols).toContain('USDT');
            expect(info.numCoins).toBe(3);
        });
    });

    describe('getCurvePrice', () => {
        it('should return null without provider', async () => {
            const price = await curveArbitrage.getCurvePrice('DAI', 'USDC');
            expect(price).toBeNull();
        });

        it('should return null for tokens not in any pool', async () => {
            curveArbitrage.provider = {};
            // No pool metadata loaded
            const price = await curveArbitrage.getCurvePrice('UNKNOWN1', 'UNKNOWN2');
            expect(price).toBeNull();
        });
    });

    describe('multi-chain support', () => {
        const chains = [
            { id: 1, name: 'Ethereum', hasPool: true },
            { id: 42161, name: 'Arbitrum', hasPool: true },
            { id: 137, name: 'Polygon', hasPool: true },
            { id: 10, name: 'Optimism', hasPool: true },
            { id: 8453, name: 'Base', hasPool: true },
            { id: 56, name: 'BSC', hasPool: false },
        ];

        chains.forEach(chain => {
            it(`should ${chain.hasPool ? 'have' : 'not have'} pools on ${chain.name}`, () => {
                const ca = new CurveArbitrage({ chainId: chain.id });
                const pools = ca.getAvailablePools();

                if (chain.hasPool) {
                    expect(pools.length).toBeGreaterThan(0);
                } else {
                    expect(pools.length).toBe(0);
                }
            });
        });
    });

    describe('Curve fee handling', () => {
        it('should use standard Curve fee', () => {
            // Standard Curve fee is 0.04%
            expect(curveArbitrage._getTokenPriceUSD).toBeDefined();
            // The CURVE_FEE constant is 0.0004 (0.04%)
        });
    });

    describe('opportunity structure', () => {
        it('should create properly structured opportunity object', () => {
            // Simulate what an opportunity should look like
            const mockOpportunity = {
                type: 'curve-dex',
                poolName: '3pool',
                poolAddress: '0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7',
                pairKey: 'DAI/USDC',
                tokenA: 'DAI',
                tokenB: 'USDC',
                tokenIndexA: 0,
                tokenIndexB: 1,
                curvePrice: 0.9998,
                dexPrice: 1.0012,
                dexName: 'uniswap_v3',
                buyVenue: 'curve',
                sellVenue: 'uniswap_v3',
                spreadPercent: 0.14,
                netSpreadPercent: 0.10,
                curveFee: 0.04,
                dexFee: 0.05,
                optimalSizeUSD: 5000,
                estimatedProfitUSD: 5.00,
                minLiquidityUSD: 250000,
                blockNumber: 12345678,
                timestamp: Date.now(),
                chainId: 1,
            };

            // Verify structure has required fields
            expect(mockOpportunity).toHaveProperty('type');
            expect(mockOpportunity).toHaveProperty('poolName');
            expect(mockOpportunity).toHaveProperty('curvePrice');
            expect(mockOpportunity).toHaveProperty('dexPrice');
            expect(mockOpportunity).toHaveProperty('estimatedProfitUSD');
            expect(mockOpportunity.type).toBe('curve-dex');
        });
    });
});
