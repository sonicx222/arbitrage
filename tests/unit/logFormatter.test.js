import { jest } from '@jest/globals';
import {
    formatUSD,
    formatPercent,
    formatPrice,
    shortDex,
    formatChain,
    formatPath,
    formatDexPath,
    formatDuration,
    formatOpportunity,
    formatOpportunitySummary,
} from '../../src/utils/logFormatter.js';

describe('LogFormatter', () => {
    describe('formatUSD', () => {
        test('should format positive values', () => {
            expect(formatUSD(123.456)).toBe('$123.46');
            expect(formatUSD(0.99)).toBe('$0.99');
            expect(formatUSD(1000)).toBe('$1000.00');
        });

        test('should handle null/undefined', () => {
            expect(formatUSD(null)).toBe('$--.--');
            expect(formatUSD(undefined)).toBe('$--.--');
            expect(formatUSD(NaN)).toBe('$--.--');
        });

        test('should respect custom decimals', () => {
            expect(formatUSD(123.456789, 4)).toBe('$123.4568');
        });
    });

    describe('formatPercent', () => {
        test('should format percentage values', () => {
            expect(formatPercent(1.5)).toBe('1.50%');
            expect(formatPercent(0.1234)).toBe('0.12%');
            expect(formatPercent(100)).toBe('100.00%');
        });

        test('should handle null/undefined', () => {
            expect(formatPercent(null)).toBe('--.--');
            expect(formatPercent(undefined)).toBe('--.--');
        });
    });

    describe('formatPrice', () => {
        test('should format prices with appropriate precision', () => {
            expect(formatPrice(0.00001234)).toMatch(/e/); // exponential for very small
            expect(formatPrice(0.123456)).toBe('0.123456');
            expect(formatPrice(12.3456)).toBe('12.3456');
            expect(formatPrice(1234.56)).toBe('1234.56');
        });

        test('should handle null/undefined', () => {
            expect(formatPrice(null)).toBe('N/A');
            expect(formatPrice(undefined)).toBe('N/A');
        });
    });

    describe('shortDex', () => {
        test('should shorten known DEX names', () => {
            expect(shortDex('pancakeswap')).toBe('PCS');
            expect(shortDex('biswap')).toBe('BiS');
            expect(shortDex('uniswap_v3')).toBe('UniV3');
            expect(shortDex('sushiswap')).toBe('Sushi');
        });

        test('should truncate unknown DEX names', () => {
            expect(shortDex('unknowndex')).toBe('unkno');
        });

        test('should handle null/undefined', () => {
            expect(shortDex(null)).toBe('N/A');
            expect(shortDex(undefined)).toBe('N/A');
        });
    });

    describe('formatChain', () => {
        test('should format known chain IDs', () => {
            expect(formatChain(56)).toBe('BSC');
            expect(formatChain(1)).toBe('ETH');
            expect(formatChain(137)).toBe('Polygon');
            expect(formatChain(42161)).toBe('Arbitrum');
        });

        test('should return unknown chain ID as string', () => {
            expect(formatChain(999)).toBe('999');
        });
    });

    describe('formatPath', () => {
        test('should format token path', () => {
            expect(formatPath(['WBNB', 'CAKE', 'USDT', 'WBNB'])).toBe('WBNB→CAKE→USDT→WBNB');
        });

        test('should handle null/undefined', () => {
            expect(formatPath(null)).toBe('N/A');
            expect(formatPath(undefined)).toBe('N/A');
        });
    });

    describe('formatDexPath', () => {
        test('should format DEX path with shortcuts', () => {
            expect(formatDexPath(['pancakeswap', 'biswap', 'pancakeswap'])).toBe('PCS→BiS→PCS');
        });
    });

    describe('formatDuration', () => {
        test('should format milliseconds', () => {
            expect(formatDuration(500)).toBe('500ms');
            expect(formatDuration(1500)).toBe('1.5s');
            expect(formatDuration(90000)).toBe('1.5m');
        });
    });

    describe('formatOpportunity', () => {
        test('should format cross-dex opportunity', () => {
            const opp = {
                type: 'cross-dex',
                pairKey: 'CAKE/WBNB',
                buyDex: 'pancakeswap',
                sellDex: 'biswap',
                buyPrice: 0.004,
                sellPrice: 0.00412,
                profitCalculation: { netProfitUSD: 12.50, netProfitPercent: 0.85 },
            };
            const result = formatOpportunity(opp);
            expect(result.icon).toBe('📊');
            expect(result.text).toContain('CAKE/WBNB');
            expect(result.text).toContain('PCS');
            expect(result.text).toContain('BiS');
            expect(result.text).toContain('$12.50');
        });

        test('should format triangular opportunity', () => {
            const opp = {
                type: 'triangular',
                path: ['WBNB', 'CAKE', 'USDT', 'WBNB'],
                dexName: 'pancakeswap',
                profitCalculation: { netProfitUSD: 8.25, netProfitPercent: 1.2 },
            };
            const result = formatOpportunity(opp);
            expect(result.icon).toBe('🔺');
            expect(result.text).toContain('WBNB→CAKE→USDT→WBNB');
            expect(result.text).toContain('PCS');
        });

        test('should format cross-dex-triangular opportunity', () => {
            const opp = {
                type: 'cross-dex-triangular',
                path: ['WBNB', 'CAKE', 'USDT', 'WBNB'],
                dexPath: ['pancakeswap', 'biswap', 'pancakeswap'],
                profitCalculation: { netProfitUSD: 15.00, netProfitPercent: 1.5 },
            };
            const result = formatOpportunity(opp);
            expect(result.icon).toBe('🔷');
            expect(result.text).toContain('PCS→BiS→PCS');
        });
    });

    describe('formatOpportunitySummary', () => {
        test('should format opportunity summary', () => {
            const opportunities = [
                { type: 'cross-dex', profitCalculation: { netProfitUSD: 10 } },
                { type: 'triangular', profitCalculation: { netProfitUSD: 15 } },
                { type: 'cross-dex-triangular', profitCalculation: { netProfitUSD: 5 } },
            ];
            const result = formatOpportunitySummary(opportunities, 150);
            expect(result).toContain('Found 3 opportunities');
            expect(result).toContain('Cross:1');
            expect(result).toContain('Tri:1');
            expect(result).toContain('X-Tri:1');
            expect(result).toContain('$15.00'); // Top profit
        });

        test('should return null for empty opportunities', () => {
            expect(formatOpportunitySummary([], 100)).toBeNull();
            expect(formatOpportunitySummary(null, 100)).toBeNull();
        });
    });
});
