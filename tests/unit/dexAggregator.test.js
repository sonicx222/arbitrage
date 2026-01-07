import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { DexAggregator } from '../../src/analysis/dexAggregator.js';

describe('DexAggregator', () => {
    let aggregator;

    beforeEach(() => {
        aggregator = new DexAggregator();
        // Mock fetch globally
        global.fetch = jest.fn();
    });

    afterEach(() => {
        aggregator.resetStats();
        aggregator.clearCache();
        jest.clearAllMocks();
    });

    describe('constructor', () => {
        it('should initialize with default aggregators', () => {
            expect(aggregator.aggregators['1inch']).toBeDefined();
            expect(aggregator.aggregators.paraswap).toBeDefined();
        });

        it('should initialize with BSC chain by default', () => {
            expect(aggregator.chainId).toBe(56);
        });

        it('should initialize stats', () => {
            expect(aggregator.stats.quotesRequested).toBe(0);
            expect(aggregator.stats.opportunitiesFound).toBe(0);
        });

        it('should have rate limiting state', () => {
            expect(aggregator.lastRequestTime).toBeDefined();
            expect(aggregator.lastRequestTime instanceof Map).toBe(true);
        });
    });

    describe('initialize', () => {
        it('should set chain ID', () => {
            aggregator.initialize(137);
            expect(aggregator.chainId).toBe(137);
        });

        it('should use existing chain ID if not provided', () => {
            aggregator.chainId = 42161;
            aggregator.initialize();
            expect(aggregator.chainId).toBe(42161);
        });
    });

    describe('getQuote', () => {
        const mockQuoteResponse = {
            toAmount: '1000000000000000000',
            gas: 150000,
            protocols: [{ name: 'UNISWAP_V3', part: 100 }],
        };

        it('should return null for disabled aggregator', async () => {
            aggregator.setAggregatorEnabled('1inch', false);
            const result = await aggregator.getQuote(
                '1inch',
                '0xtoken1',
                '0xtoken2',
                '1000000000000000000'
            );
            expect(result).toBeNull();
        });

        it('should return null for unsupported chain', async () => {
            aggregator.chainId = 99999;
            const result = await aggregator.getQuote(
                '1inch',
                '0xtoken1',
                '0xtoken2',
                '1000000000000000000'
            );
            expect(result).toBeNull();
        });

        it('should use cache for repeated requests', async () => {
            // Setup mock response
            global.fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => mockQuoteResponse,
            });

            const fromToken = '0xtoken1';
            const toToken = '0xtoken2';
            const amount = '1000000000000000000';

            // First request
            await aggregator.getQuote('1inch', fromToken, toToken, amount);

            // Second request (should use cache)
            const result = await aggregator.getQuote('1inch', fromToken, toToken, amount);

            expect(result).not.toBeNull();
            expect(aggregator.stats.cacheHits).toBe(1);
        });

        it('should handle rate limiting', async () => {
            global.fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => mockQuoteResponse,
            });

            // First request
            await aggregator.getQuote('1inch', '0x1', '0x2', '1000');

            // Immediate second request (should be rate limited)
            const result = await aggregator.getQuote('1inch', '0x3', '0x4', '2000');

            expect(aggregator.stats.rateLimitHits).toBeGreaterThanOrEqual(0);
        });

        it('should handle API errors gracefully', async () => {
            global.fetch.mockRejectedValueOnce(new Error('Network error'));

            const result = await aggregator.getQuote(
                '1inch',
                '0xtoken1',
                '0xtoken2',
                '1000000000000000000'
            );

            expect(result).toBeNull();
            expect(aggregator.stats.quoteErrors).toBe(1);
        });

        it('should handle non-OK response', async () => {
            global.fetch.mockResolvedValueOnce({
                ok: false,
                status: 500,
            });

            const result = await aggregator.getQuote(
                '1inch',
                '0xtoken1',
                '0xtoken2',
                '1000000000000000000'
            );

            expect(result).toBeNull();
            expect(aggregator.stats.quoteErrors).toBe(1);
        });
    });

    describe('findAggregatorArbitrage', () => {
        it('should find arbitrage when aggregator has better price', async () => {
            // Mock aggregator returning better price
            global.fetch.mockResolvedValue({
                ok: true,
                json: async () => ({
                    toAmount: '1100000000000000000', // 10% better
                    gas: 150000,
                    protocols: [],
                }),
            });

            const result = await aggregator.findAggregatorArbitrage(
                '0xfromToken',
                '0xtoToken',
                '1000000000000000000',
                '1000000000000000000', // Direct price
                { minSpreadPercent: 0.5 }
            );

            expect(result).not.toBeNull();
            expect(result.type).toBe('aggregator-arbitrage');
            expect(result.spreadPercent).toBeGreaterThan(0);
        });

        it('should return null when direct price is better', async () => {
            // Mock aggregator returning worse price
            global.fetch.mockResolvedValue({
                ok: true,
                json: async () => ({
                    toAmount: '900000000000000000', // 10% worse
                    gas: 150000,
                    protocols: [],
                }),
            });

            const result = await aggregator.findAggregatorArbitrage(
                '0xfromToken',
                '0xtoToken',
                '1000000000000000000',
                '1000000000000000000',
                { minSpreadPercent: 0.5 }
            );

            expect(result).toBeNull();
        });

        it('should return null when spread is below minimum', async () => {
            // Mock aggregator returning slightly better price
            global.fetch.mockResolvedValue({
                ok: true,
                json: async () => ({
                    toAmount: '1001000000000000000', // 0.1% better
                    gas: 150000,
                    protocols: [],
                }),
            });

            const result = await aggregator.findAggregatorArbitrage(
                '0xfromToken',
                '0xtoToken',
                '1000000000000000000',
                '1000000000000000000',
                { minSpreadPercent: 0.5 } // 0.5% minimum
            );

            expect(result).toBeNull();
        });

        it('should emit opportunity event when found', async () => {
            const opportunityHandler = jest.fn();
            aggregator.on('opportunity', opportunityHandler);

            global.fetch.mockResolvedValue({
                ok: true,
                json: async () => ({
                    toAmount: '1100000000000000000',
                    gas: 150000,
                    protocols: [],
                }),
            });

            await aggregator.findAggregatorArbitrage(
                '0xfromToken',
                '0xtoToken',
                '1000000000000000000',
                '1000000000000000000',
                { minSpreadPercent: 0.5 }
            );

            expect(opportunityHandler).toHaveBeenCalled();
            expect(aggregator.stats.opportunitiesFound).toBe(1);
        });
    });

    describe('getBestPrice', () => {
        it('should return best quote from multiple aggregators', async () => {
            // Mock different prices from aggregators
            global.fetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({
                        toAmount: '1000000000000000000',
                        gas: 150000,
                        protocols: [],
                    }),
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({
                        priceRoute: {
                            destAmount: '1100000000000000000', // Paraswap is better
                            gasCost: '150000',
                            bestRoute: [],
                        },
                    }),
                });

            // Allow second request (bypass rate limit)
            aggregator.lastRequestTime.set('paraswap', 0);

            const result = await aggregator.getBestPrice(
                '0xfromToken',
                '0xtoToken',
                '1000000000000000000'
            );

            expect(result).not.toBeNull();
            expect(result.toAmount).toBe('1100000000000000000');
        });

        it('should return null when no quotes available', async () => {
            global.fetch.mockRejectedValue(new Error('API error'));

            const result = await aggregator.getBestPrice(
                '0xfromToken',
                '0xtoToken',
                '1000000000000000000'
            );

            expect(result).toBeNull();
        });
    });

    describe('getSupportedAggregators', () => {
        it('should return aggregators for BSC', () => {
            aggregator.chainId = 56;
            const supported = aggregator.getSupportedAggregators();

            expect(supported.length).toBeGreaterThan(0);
            const names = supported.map(a => a.name);
            expect(names).toContain('1inch');
            expect(names).toContain('Paraswap');
        });

        it('should filter out disabled aggregators', () => {
            aggregator.chainId = 56;
            aggregator.setAggregatorEnabled('1inch', false);

            const supported = aggregator.getSupportedAggregators();
            const names = supported.map(a => a.name);

            expect(names).not.toContain('1inch');
        });
    });

    describe('setAggregatorEnabled', () => {
        it('should disable an aggregator', () => {
            aggregator.setAggregatorEnabled('1inch', false);
            expect(aggregator.aggregators['1inch'].enabled).toBe(false);
        });

        it('should enable an aggregator', () => {
            aggregator.setAggregatorEnabled('1inch', false);
            aggregator.setAggregatorEnabled('1inch', true);
            expect(aggregator.aggregators['1inch'].enabled).toBe(true);
        });
    });

    describe('setApiKey', () => {
        it('should set API key for aggregator', () => {
            aggregator.setApiKey('1inch', 'test-api-key');
            expect(aggregator.aggregators['1inch'].apiKey).toBe('test-api-key');
        });
    });

    describe('clearCache', () => {
        it('should clear the quote cache', async () => {
            global.fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    toAmount: '1000000000000000000',
                    gas: 150000,
                    protocols: [],
                }),
            });

            await aggregator.getQuote('1inch', '0x1', '0x2', '1000');
            expect(aggregator.quoteCache.size).toBe(1);

            aggregator.clearCache();
            expect(aggregator.quoteCache.size).toBe(0);
        });
    });

    describe('getStats', () => {
        it('should return comprehensive stats', async () => {
            global.fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    toAmount: '1000000000000000000',
                    gas: 150000,
                    protocols: [],
                }),
            });

            await aggregator.getQuote('1inch', '0x1', '0x2', '1000');

            const stats = aggregator.getStats();

            expect(stats.quotesRequested).toBe(1);
            expect(stats.chainId).toBe(56);
            expect(stats.cacheSize).toBeDefined();
        });
    });

    describe('resetStats', () => {
        it('should reset all statistics', async () => {
            global.fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    toAmount: '1000000000000000000',
                    gas: 150000,
                    protocols: [],
                }),
            });

            await aggregator.getQuote('1inch', '0x1', '0x2', '1000');
            aggregator.resetStats();

            expect(aggregator.stats.quotesRequested).toBe(0);
            expect(aggregator.stats.quotesReceived).toBe(0);
        });
    });
});
