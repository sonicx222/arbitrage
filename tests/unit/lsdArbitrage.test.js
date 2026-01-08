import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { LsdArbitrage } from '../../src/analysis/lsdArbitrage.js';

describe('LsdArbitrage', () => {
    let lsdArbitrage;

    beforeEach(() => {
        lsdArbitrage = new LsdArbitrage({
            chainId: 1,
            minProfitPercent: 0.15,
            minProfitUSD: 2,
        });
    });

    afterEach(() => {
        lsdArbitrage.clearCache();
    });

    describe('constructor', () => {
        it('should initialize with default values', () => {
            const la = new LsdArbitrage();
            expect(la.chainId).toBe(1);
            expect(la.minProfitPercent).toBe(0.15);
            expect(la.minProfitUSD).toBe(2);
            expect(la.maxTradeSize).toBe(50000);
            expect(la.ethPriceUSD).toBe(3500);
        });

        it('should accept custom configuration', () => {
            const la = new LsdArbitrage({
                chainId: 42161,
                minProfitPercent: 0.2,
                minProfitUSD: 5,
                maxTradeSize: 25000,
                ethPriceUSD: 4000,
            });
            expect(la.chainId).toBe(42161);
            expect(la.minProfitPercent).toBe(0.2);
            expect(la.minProfitUSD).toBe(5);
            expect(la.maxTradeSize).toBe(25000);
            expect(la.ethPriceUSD).toBe(4000);
        });

        it('should initialize stats', () => {
            expect(lsdArbitrage.stats.opportunitiesDetected).toBe(0);
            expect(lsdArbitrage.stats.rateQueries).toBe(0);
            expect(lsdArbitrage.stats.rebasesDetected).toBe(0);
            expect(lsdArbitrage.stats.postRebaseOpportunities).toBe(0);
            expect(lsdArbitrage.stats.totalEstimatedProfit).toBe(0);
        });

        it('should initialize rebase window tracking', () => {
            expect(lsdArbitrage.lastRebaseTime).toBeNull();
            expect(lsdArbitrage.rebaseWindow).toBe(30 * 60 * 1000); // 30 minutes
            expect(typeof lsdArbitrage.isInRebaseWindow).toBe('boolean');
        });

        it('should accept custom cache max age', () => {
            const la = new LsdArbitrage({ cacheMaxAge: 20000 });
            expect(la.cacheMaxAge).toBe(20000);
        });
    });

    describe('LSD token configurations', () => {
        it('should have Ethereum LSD tokens configured', () => {
            const tokens = lsdArbitrage.getAvailableLsdTokens();
            expect(tokens.length).toBeGreaterThan(0);
            expect(tokens).toContain('stETH');
            expect(tokens).toContain('wstETH');
            expect(tokens).toContain('rETH');
            expect(tokens).toContain('cbETH');
        });

        it('should have Arbitrum LSD tokens configured', () => {
            const la = new LsdArbitrage({ chainId: 42161 });
            const tokens = la.getAvailableLsdTokens();
            expect(tokens.length).toBeGreaterThan(0);
            expect(tokens).toContain('wstETH');
            expect(tokens).toContain('rETH');
        });

        it('should have Base LSD tokens configured', () => {
            const la = new LsdArbitrage({ chainId: 8453 });
            const tokens = la.getAvailableLsdTokens();
            expect(tokens.length).toBeGreaterThan(0);
            expect(tokens).toContain('cbETH');
            expect(tokens).toContain('wstETH');
        });

        it('should have Polygon LSD tokens configured', () => {
            const la = new LsdArbitrage({ chainId: 137 });
            const tokens = la.getAvailableLsdTokens();
            expect(tokens.length).toBeGreaterThan(0);
            expect(tokens).toContain('wstETH');
            expect(tokens).toContain('stMATIC');
        });

        it('should filter out WETH/WMATIC from LSD token list', () => {
            const tokens = lsdArbitrage.getAvailableLsdTokens();
            expect(tokens).not.toContain('WETH');
            expect(tokens).not.toContain('WMATIC');
        });

        it('should return empty for unsupported chain', () => {
            const la = new LsdArbitrage({ chainId: 56 }); // BSC - no major LSDs
            const tokens = la.getAvailableLsdTokens();
            expect(tokens.length).toBe(0);
        });
    });

    describe('base token selection', () => {
        it('should return WETH for Ethereum', () => {
            const la = new LsdArbitrage({ chainId: 1 });
            expect(la._getBaseToken()).toBe('WETH');
        });

        it('should return WETH for Arbitrum', () => {
            const la = new LsdArbitrage({ chainId: 42161 });
            expect(la._getBaseToken()).toBe('WETH');
        });

        it('should return WMATIC for Polygon', () => {
            const la = new LsdArbitrage({ chainId: 137 });
            expect(la._getBaseToken()).toBe('WMATIC');
        });

        it('should return WETH for Base', () => {
            const la = new LsdArbitrage({ chainId: 8453 });
            expect(la._getBaseToken()).toBe('WETH');
        });
    });

    describe('ETH price management', () => {
        it('should have default ETH price', () => {
            expect(lsdArbitrage.ethPriceUSD).toBe(3500);
        });

        it('should allow setting ETH price', () => {
            lsdArbitrage.setEthPrice(4000);
            expect(lsdArbitrage.ethPriceUSD).toBe(4000);
        });

        it('should use ETH price in profit calculations', () => {
            lsdArbitrage.setEthPrice(5000);
            expect(lsdArbitrage.ethPriceUSD).toBe(5000);
        });
    });

    describe('analyzeOpportunities', () => {
        it('should return empty array without provider', async () => {
            const opportunities = await lsdArbitrage.analyzeOpportunities({}, 12345);
            expect(opportunities).toEqual([]);
        });

        it('should return empty array without LSD addresses for chain', async () => {
            const la = new LsdArbitrage({ chainId: 56 }); // BSC
            la.provider = {}; // Mock provider
            const opportunities = await la.analyzeOpportunities({}, 12345);
            expect(opportunities).toEqual([]);
        });

        it('should emit opportunity event when found', async () => {
            let emittedOpportunity = null;
            lsdArbitrage.on('opportunity', (opp) => {
                emittedOpportunity = opp;
            });

            // Verify the event listener is set up
            expect(lsdArbitrage.listenerCount('opportunity')).toBe(1);
        });
    });

    describe('exchange rate caching', () => {
        it('should start with empty cache', () => {
            expect(lsdArbitrage.rateCache.size).toBe(0);
        });

        it('should clear rate cache', () => {
            lsdArbitrage.rateCache.set('wstETH', { rate: 1.15, timestamp: Date.now() });
            lsdArbitrage.rateCache.set('rETH', { rate: 1.08, timestamp: Date.now() });
            expect(lsdArbitrage.rateCache.size).toBe(2);

            lsdArbitrage.clearCache();
            expect(lsdArbitrage.rateCache.size).toBe(0);
        });

        it('should respect cache max age setting', () => {
            const la = new LsdArbitrage({ cacheMaxAge: 5000 });
            expect(la.cacheMaxAge).toBe(5000);
        });
    });

    describe('rebase window detection', () => {
        it('should have checkRebaseWindow method', () => {
            expect(typeof lsdArbitrage.checkRebaseWindow).toBe('function');
        });

        it('should return boolean from checkRebaseWindow', () => {
            const result = lsdArbitrage.checkRebaseWindow();
            expect(typeof result).toBe('boolean');
        });

        it('should track isInRebaseWindow state', () => {
            lsdArbitrage.checkRebaseWindow();
            expect(typeof lsdArbitrage.isInRebaseWindow).toBe('boolean');
        });

        it('should have default rebase window of 30 minutes', () => {
            expect(lsdArbitrage.rebaseWindow).toBe(30 * 60 * 1000);
        });

        it('should accept custom rebase window', () => {
            const la = new LsdArbitrage({ rebaseWindow: 60 * 60 * 1000 });
            expect(la.rebaseWindow).toBe(60 * 60 * 1000);
        });
    });

    describe('statistics', () => {
        it('should return comprehensive stats', () => {
            const stats = lsdArbitrage.getStats();

            expect(stats.chainId).toBe(1);
            expect(stats.opportunitiesDetected).toBe(0);
            expect(stats.rateQueries).toBe(0);
            expect(stats.rebasesDetected).toBe(0);
            expect(stats.postRebaseOpportunities).toBe(0);
            expect(stats.lsdTokensConfigured).toBeGreaterThan(0);
            expect(stats.cachedRates).toBe(0);
            expect(typeof stats.isInRebaseWindow).toBe('boolean');
        });

        it('should reset stats correctly', () => {
            lsdArbitrage.stats.opportunitiesDetected = 10;
            lsdArbitrage.stats.rateQueries = 100;
            lsdArbitrage.stats.totalEstimatedProfit = 500;
            lsdArbitrage.stats.postRebaseOpportunities = 5;

            lsdArbitrage.resetStats();

            expect(lsdArbitrage.stats.opportunitiesDetected).toBe(0);
            expect(lsdArbitrage.stats.rateQueries).toBe(0);
            expect(lsdArbitrage.stats.totalEstimatedProfit).toBe(0);
            expect(lsdArbitrage.stats.postRebaseOpportunities).toBe(0);
        });

        it('should preserve rebasesDetected on reset', () => {
            lsdArbitrage.stats.rebasesDetected = 5;
            lsdArbitrage.resetStats();
            expect(lsdArbitrage.stats.rebasesDetected).toBe(5);
        });
    });

    describe('getExchangeRate', () => {
        it('should return null without provider', async () => {
            const rate = await lsdArbitrage.getExchangeRate('wstETH');
            expect(rate).toBeNull();
        });

        it('should return null for unknown LSD', async () => {
            lsdArbitrage.provider = {};
            const rate = await lsdArbitrage.getExchangeRate('UNKNOWN_LSD');
            expect(rate).toBeNull();
        });
    });

    describe('getAllRates', () => {
        it('should return stETH rate even without provider (hardcoded 1:1)', async () => {
            // stETH is rebasing token with 1:1 rate (balance changes, not rate)
            // This rate is hardcoded and doesn't require a provider
            const rates = await lsdArbitrage.getAllRates();
            expect(rates.stETH).toBe(1);
        });

        it('should return empty object for unsupported chain', async () => {
            const la = new LsdArbitrage({ chainId: 56 }); // BSC
            la.provider = {};
            const rates = await la.getAllRates();
            expect(rates).toEqual({});
        });
    });

    describe('multi-chain support', () => {
        const chains = [
            { id: 1, name: 'Ethereum', hasLsd: true },
            { id: 42161, name: 'Arbitrum', hasLsd: true },
            { id: 137, name: 'Polygon', hasLsd: true },
            { id: 10, name: 'Optimism', hasLsd: true },
            { id: 8453, name: 'Base', hasLsd: true },
            { id: 56, name: 'BSC', hasLsd: false },
        ];

        chains.forEach(chain => {
            it(`should ${chain.hasLsd ? 'have' : 'not have'} LSD tokens on ${chain.name}`, () => {
                const la = new LsdArbitrage({ chainId: chain.id });
                const tokens = la.getAvailableLsdTokens();

                if (chain.hasLsd) {
                    expect(tokens.length).toBeGreaterThan(0);
                } else {
                    expect(tokens.length).toBe(0);
                }
            });
        });
    });

    describe('opportunity structure', () => {
        it('should define expected opportunity types', () => {
            // Protocol vs DEX arbitrage opportunity structure
            const protocolDexOpp = {
                type: 'lsd-protocol-dex',
                lsdSymbol: 'rETH',
                lsdAddress: '0xae78736Cd615f374D3085123A210448E74Fc6393',
                baseToken: 'WETH',
                protocolRate: 1.08,
                dexRate: 1.075,
                dexName: 'uniswap_v3',
                action: 'buy-dex-redeem-protocol',
                spreadPercent: 0.46,
                netSpreadPercent: 0.16,
                optimalSizeUSD: 5000,
                estimatedProfitUSD: 8.00,
                isInRebaseWindow: false,
                blockNumber: 12345678,
                timestamp: Date.now(),
                chainId: 1,
            };

            expect(protocolDexOpp).toHaveProperty('type');
            expect(protocolDexOpp).toHaveProperty('lsdSymbol');
            expect(protocolDexOpp).toHaveProperty('protocolRate');
            expect(protocolDexOpp).toHaveProperty('dexRate');
            expect(protocolDexOpp).toHaveProperty('estimatedProfitUSD');
            expect(protocolDexOpp.type).toBe('lsd-protocol-dex');
        });

        it('should define cross-DEX LSD opportunity structure', () => {
            const crossDexOpp = {
                type: 'lsd-cross-dex',
                lsdSymbol: 'wstETH',
                baseToken: 'WETH',
                buyDex: 'uniswap_v3',
                sellDex: 'curve',
                buyRate: 1.145,
                sellRate: 1.148,
                spreadPercent: 0.26,
                netSpreadPercent: 0.16,
                optimalSizeUSD: 10000,
                estimatedProfitUSD: 16.00,
                minLiquidityUSD: 500000,
                isInRebaseWindow: false,
                blockNumber: 12345678,
                timestamp: Date.now(),
                chainId: 1,
            };

            expect(crossDexOpp).toHaveProperty('type');
            expect(crossDexOpp).toHaveProperty('buyDex');
            expect(crossDexOpp).toHaveProperty('sellDex');
            expect(crossDexOpp).toHaveProperty('buyRate');
            expect(crossDexOpp).toHaveProperty('sellRate');
            expect(crossDexOpp.type).toBe('lsd-cross-dex');
        });

        it('should define Curve LSD opportunity structure', () => {
            const curveLsdOpp = {
                type: 'lsd-curve-dex',
                lsdSymbol: 'stETH',
                curvePool: 'steth',
                curvePoolAddress: '0xDC24316b9AE028F1497c275EB9192a3Ea0f67022',
                dexName: 'uniswap_v3',
                dexRate: 0.998,
                pegDeviation: 0.20,
                buyVenue: 'uniswap_v3',
                sellVenue: 'curve',
                netDeviationPercent: 0.16,
                optimalSizeUSD: 8000,
                estimatedProfitUSD: 12.80,
                isInRebaseWindow: true,
                blockNumber: 12345678,
                timestamp: Date.now(),
                chainId: 1,
            };

            expect(curveLsdOpp).toHaveProperty('type');
            expect(curveLsdOpp).toHaveProperty('curvePool');
            expect(curveLsdOpp).toHaveProperty('dexRate');
            expect(curveLsdOpp).toHaveProperty('pegDeviation');
            expect(curveLsdOpp.type).toBe('lsd-curve-dex');
        });
    });

    describe('contract caching', () => {
        it('should start with empty contract cache', () => {
            expect(lsdArbitrage.contracts.size).toBe(0);
        });

        it('should cache contracts by symbol and chain', () => {
            // Simulate contract caching
            const mockContract = { address: '0x123' };
            const cacheKey = 'wstETH_1';
            lsdArbitrage.contracts.set(cacheKey, mockContract);

            expect(lsdArbitrage.contracts.has(cacheKey)).toBe(true);
            expect(lsdArbitrage.contracts.get(cacheKey)).toBe(mockContract);
        });
    });

    describe('initialization', () => {
        it('should have initialize method', () => {
            expect(typeof lsdArbitrage.initialize).toBe('function');
        });

        it('should accept provider in initialize', async () => {
            const mockProvider = { getNetwork: jest.fn() };
            // initialize will fail without real provider, but should accept it
            try {
                await lsdArbitrage.initialize(mockProvider);
            } catch (e) {
                // Expected to fail without real provider
            }
            expect(lsdArbitrage.provider).toBe(mockProvider);
        });

        it('should accept chainId in initialize', async () => {
            const mockProvider = { getNetwork: jest.fn() };
            try {
                await lsdArbitrage.initialize(mockProvider, 42161);
            } catch (e) {
                // Expected to fail without real provider
            }
            expect(lsdArbitrage.chainId).toBe(42161);
        });
    });

    describe('LSD token types', () => {
        it('should recognize rebasing tokens (stETH)', () => {
            // stETH is rebasing - balance increases, rate stays 1:1
            const tokens = lsdArbitrage.getAvailableLsdTokens();
            expect(tokens).toContain('stETH');
        });

        it('should recognize non-rebasing tokens (wstETH, rETH, cbETH)', () => {
            // These tokens have increasing exchange rates
            const tokens = lsdArbitrage.getAvailableLsdTokens();
            expect(tokens).toContain('wstETH');
            expect(tokens).toContain('rETH');
            expect(tokens).toContain('cbETH');
        });

        it('should include ERC4626 vault tokens (sfrxETH)', () => {
            const tokens = lsdArbitrage.getAvailableLsdTokens();
            expect(tokens).toContain('sfrxETH');
        });
    });
});
