/**
 * SlippageManager Unit Tests
 *
 * Tests dynamic slippage calculation based on:
 * - Token type classification
 * - Pair slippage calculation
 * - Liquidity-adjusted slippage
 * - Multi-hop path slippage
 */

import slippageManager from '../../src/analysis/slippageManager.js';

describe('SlippageManager', () => {
    describe('Token Type Classification', () => {
        test('should classify stablecoins correctly', () => {
            const stablecoins = ['USDT', 'USDC', 'DAI', 'BUSD', 'FRAX', 'MIM', 'USDC.e'];
            stablecoins.forEach(token => {
                expect(slippageManager.getTokenType(token)).toBe('stablecoin');
            });
        });

        test('should classify native tokens correctly', () => {
            const nativeTokens = ['WBNB', 'WETH', 'WMATIC', 'WAVAX', 'wstETH', 'cbETH'];
            nativeTokens.forEach(token => {
                expect(slippageManager.getTokenType(token)).toBe('native');
            });
        });

        test('should classify blue-chip tokens correctly', () => {
            const blueChips = ['BTCB', 'WBTC', 'LINK', 'UNI', 'AAVE', 'MKR', 'CRV'];
            blueChips.forEach(token => {
                expect(slippageManager.getTokenType(token)).toBe('blueChip');
            });
        });

        test('should classify volatile tokens correctly', () => {
            const volatile = ['RDNT', 'GRAIL', 'MAGIC', 'STG', 'QI', 'SPELL'];
            volatile.forEach(token => {
                expect(slippageManager.getTokenType(token)).toBe('volatile');
            });
        });

        test('should classify meme tokens correctly', () => {
            const memeTokens = ['SHIB', 'PEPE', 'DEGEN', 'BRETT', 'BALD'];
            memeTokens.forEach(token => {
                expect(slippageManager.getTokenType(token)).toBe('meme');
            });
        });

        test('should return unknown for unclassified tokens', () => {
            expect(slippageManager.getTokenType('RANDOM_TOKEN')).toBe('unknown');
            expect(slippageManager.getTokenType('XYZ')).toBe('unknown');
        });
    });

    describe('Token Slippage Rates', () => {
        test('should return lowest slippage for stablecoins', () => {
            const slippage = slippageManager.getTokenSlippage('USDT');
            expect(slippage).toBe(0.001); // 0.1%
        });

        test('should return low slippage for native tokens', () => {
            const slippage = slippageManager.getTokenSlippage('WETH');
            expect(slippage).toBe(0.003); // 0.3%
        });

        test('should return moderate slippage for blue-chip tokens', () => {
            const slippage = slippageManager.getTokenSlippage('LINK');
            expect(slippage).toBe(0.005); // 0.5%
        });

        test('should return higher slippage for volatile tokens', () => {
            const slippage = slippageManager.getTokenSlippage('MAGIC');
            expect(slippage).toBe(0.010); // 1.0%
        });

        test('should return highest slippage for meme tokens', () => {
            const slippage = slippageManager.getTokenSlippage('PEPE');
            expect(slippage).toBe(0.015); // 1.5%
        });

        test('should return default slippage for unknown tokens', () => {
            const slippage = slippageManager.getTokenSlippage('UNKNOWN');
            expect(slippage).toBe(0.010); // 1.0% default
        });
    });

    describe('Pair Slippage Calculation', () => {
        test('should return lowest slippage for stable-stable pairs', () => {
            const slippage = slippageManager.getPairSlippage('USDT', 'USDC');
            expect(slippage).toBe(0.001); // 0.1%
        });

        test('should use higher slippage of the two tokens', () => {
            // USDT (stablecoin: 0.1%) + WETH (native: 0.3%) = 0.3%
            const slippage = slippageManager.getPairSlippage('USDT', 'WETH');
            expect(slippage).toBe(0.003);
        });

        test('should handle volatile + stable pairs correctly', () => {
            // MAGIC (volatile: 1.0%) + USDC (stablecoin: 0.1%) = 1.0%
            const slippage = slippageManager.getPairSlippage('MAGIC', 'USDC');
            expect(slippage).toBe(0.010);
        });

        test('should handle meme + native pairs correctly', () => {
            // PEPE (meme: 1.5%) + WETH (native: 0.3%) = 1.5%
            const slippage = slippageManager.getPairSlippage('PEPE', 'WETH');
            expect(slippage).toBe(0.015);
        });
    });

    describe('Liquidity-Adjusted Slippage', () => {
        test('should not increase slippage for small trades', () => {
            // Trade is <1% of pool liquidity
            const result = slippageManager.calculateSlippage('USDT', 'USDC', 100, 100000);
            expect(result.liquidityTier).toBe('minimal');
            expect(result.liquidityMultiplier).toBe(1.0);
            expect(result.slippage).toBe(0.001); // Base stablecoin rate
        });

        test('should increase slippage for medium trades', () => {
            // Trade is ~5% of pool liquidity
            const result = slippageManager.calculateSlippage('USDT', 'USDC', 5000, 100000);
            expect(result.liquidityTier).toBe('low');
            expect(result.liquidityMultiplier).toBe(1.2);
            expect(result.slippage).toBe(0.0012); // 0.1% * 1.2
        });

        test('should significantly increase slippage for large trades', () => {
            // Trade is ~15% of pool liquidity
            const result = slippageManager.calculateSlippage('WETH', 'USDC', 15000, 100000);
            expect(result.liquidityTier).toBe('high');
            expect(result.liquidityMultiplier).toBe(2.0);
            expect(result.slippage).toBe(0.006); // 0.3% * 2.0
        });

        test('should cap slippage at maximum', () => {
            // Very large trade with meme token should still be capped
            const result = slippageManager.calculateSlippage('PEPE', 'WETH', 50000, 100000);
            expect(result.slippage).toBeLessThanOrEqual(0.03); // Max 3%
        });

        test('should return complete slippage info object', () => {
            const result = slippageManager.calculateSlippage('WETH', 'USDC', 1000, 50000);
            expect(result).toHaveProperty('slippage');
            expect(result).toHaveProperty('slippagePercent');
            expect(result).toHaveProperty('baseSlippage');
            expect(result).toHaveProperty('liquidityMultiplier');
            expect(result).toHaveProperty('liquidityTier');
            expect(result).toHaveProperty('impactRatio');
            expect(result).toHaveProperty('tokenAType');
            expect(result).toHaveProperty('tokenBType');
        });
    });

    describe('Path Slippage Calculation', () => {
        test('should calculate slippage for simple path', () => {
            const path = ['WETH', 'USDC'];
            const result = slippageManager.calculatePathSlippage(path, [100000], 1000);
            expect(result.hops).toBe(1);
            expect(result.slippage).toBeGreaterThan(0);
        });

        test('should calculate slippage for triangular path', () => {
            const path = ['WETH', 'USDC', 'DAI', 'WETH'];
            const liquidities = [100000, 80000, 90000];
            const result = slippageManager.calculatePathSlippage(path, liquidities, 1000);
            expect(result.hops).toBe(3);
            expect(result.hopSlippages).toHaveLength(3);
        });

        test('should apply compound multiplier for multi-hop', () => {
            // 3 hops should have compoundMultiplier of 1.2 (1 + (3-1)*0.1)
            const path = ['WETH', 'USDC', 'DAI', 'WETH'];
            const result = slippageManager.calculatePathSlippage(path, [100000, 100000, 100000], 1000);
            expect(result.compoundMultiplier).toBe(1.2);
        });

        test('should use highest slippage hop', () => {
            // Path with volatile token in the middle
            const path = ['USDC', 'MAGIC', 'WETH'];
            const result = slippageManager.calculatePathSlippage(path, [100000, 50000], 1000);
            expect(result.maxSlippageHop).not.toBeNull();
            // Should be higher than pure stablecoin path
            expect(result.slippage).toBeGreaterThan(0.001);
        });

        test('should handle single token path', () => {
            const result = slippageManager.calculatePathSlippage(['WETH'], [], 1000);
            expect(result.hops).toBe(0);
        });
    });

    describe('Stablecoin Detection', () => {
        test('should correctly identify stablecoins', () => {
            expect(slippageManager.isStablecoin('USDT')).toBe(true);
            expect(slippageManager.isStablecoin('USDC')).toBe(true);
            expect(slippageManager.isStablecoin('DAI')).toBe(true);
            expect(slippageManager.isStablecoin('FRAX')).toBe(true);
        });

        test('should correctly identify non-stablecoins', () => {
            expect(slippageManager.isStablecoin('WETH')).toBe(false);
            expect(slippageManager.isStablecoin('LINK')).toBe(false);
            expect(slippageManager.isStablecoin('PEPE')).toBe(false);
        });

        test('should correctly identify stable pairs', () => {
            expect(slippageManager.isStablePair('USDT', 'USDC')).toBe(true);
            expect(slippageManager.isStablePair('DAI', 'FRAX')).toBe(true);
        });

        test('should correctly identify non-stable pairs', () => {
            expect(slippageManager.isStablePair('WETH', 'USDC')).toBe(false);
            expect(slippageManager.isStablePair('LINK', 'UNI')).toBe(false);
        });
    });

    describe('Slippage Cost Calculation', () => {
        test('should calculate slippage cost correctly', () => {
            const cost = slippageManager.calculateSlippageCost(0.01, 100);
            expect(cost).toBe(1); // 1% of $100 = $1
        });

        test('should handle zero profit', () => {
            const cost = slippageManager.calculateSlippageCost(0.01, 0);
            expect(cost).toBe(0);
        });
    });

    describe('Token Management', () => {
        test('should add new token to category', () => {
            slippageManager.addToken('NEW_STABLE', 'stablecoin');
            expect(slippageManager.isStablecoin('NEW_STABLE')).toBe(true);
        });
    });

    describe('Statistics', () => {
        test('should return complete stats object', () => {
            const stats = slippageManager.getStats();
            expect(stats).toHaveProperty('tokenCategories');
            expect(stats).toHaveProperty('baseRates');
            expect(stats).toHaveProperty('bounds');
            expect(stats.tokenCategories).toHaveProperty('stablecoins');
            expect(stats.tokenCategories).toHaveProperty('native');
            expect(stats.tokenCategories).toHaveProperty('blueChip');
            expect(stats.tokenCategories).toHaveProperty('volatile');
            expect(stats.tokenCategories).toHaveProperty('meme');
        });
    });

    describe('Edge Cases', () => {
        test('should handle zero pool liquidity', () => {
            const result = slippageManager.calculateSlippage('WETH', 'USDC', 1000, 0);
            expect(result.slippage).toBeGreaterThan(0);
            expect(result.slippage).toBeLessThanOrEqual(0.03);
        });

        test('should handle empty path', () => {
            const result = slippageManager.calculatePathSlippage([], [], 1000);
            expect(result.hops).toBe(0);
        });

        test('should handle undefined liquidities array', () => {
            const path = ['WETH', 'USDC', 'DAI'];
            const result = slippageManager.calculatePathSlippage(path, undefined, 1000);
            expect(result.hops).toBe(2);
        });
    });
});
