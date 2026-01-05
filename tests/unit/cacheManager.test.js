import { jest } from '@jest/globals';
import cacheManager from '../../src/data/cacheManager.js';
import config from '../../src/config.js';

describe('CacheManager', () => {
    beforeEach(() => {
        cacheManager.clearAll();
    });

    describe('Price Cache', () => {
        const mockPriceData = {
            price: 100,
            liquidity: 1000,
            tokenA: '0x123',
            tokenB: '0x456',
            dex: 'pancakeswap'
        };

        test('should set and get price data correctly', () => {
            const key = cacheManager.getPriceKey('0x123', '0x456', 'pancakeswap');
            cacheManager.setPrice(key, mockPriceData, 1000);

            const retrieved = cacheManager.getPrice(key, 1000);
            expect(retrieved).toEqual(mockPriceData);
        });

        test('should return null for non-existent key', () => {
            const retrieved = cacheManager.getPrice('non-existent', 1000);
            expect(retrieved).toBeNull();
        });

        test('should return null for stale block data', () => {
            const key = cacheManager.getPriceKey('0x123', '0x456', 'pancakeswap');
            cacheManager.setPrice(key, mockPriceData, 999); // Old block

            const retrieved = cacheManager.getPrice(key, 1000); // Current block is newer
            expect(retrieved).toBeNull();
        });

        test('should return data for same block', () => {
            const key = cacheManager.getPriceKey('0x123', '0x456', 'pancakeswap');
            cacheManager.setPrice(key, mockPriceData, 1000);

            const retrieved = cacheManager.getPrice(key, 1000);
            expect(retrieved).toEqual(mockPriceData);
        });

        test('should return stale data if within maxStaleBlocks', () => {
            const key = 'staleKey';
            cacheManager.setPrice(key, mockPriceData, 1000);

            // Request for block 1002 with 2 blocks tolerance (1002 - 1000 = 2 <= 2)
            const retrieved = cacheManager.getPrice(key, 1002, 2);
            expect(retrieved).toEqual(mockPriceData);
        });

        test('should return null if data exceeds maxStaleBlocks', () => {
            const key = 'tooStaleKey';
            cacheManager.setPrice(key, mockPriceData, 1000);

            // Request for block 1005 with 2 blocks tolerance (1005 - 1000 = 5 > 2)
            const retrieved = cacheManager.getPrice(key, 1005, 2);
            expect(retrieved).toBeNull();
        });

        test('should invalidate older entries', () => {
            const key1 = 'key1';
            const key2 = 'key2';
            cacheManager.setPrice(key1, mockPriceData, 1000);
            cacheManager.setPrice(key2, mockPriceData, 1001);

            cacheManager.invalidateOlderThan(1001);

            expect(cacheManager.getPrice(key1, 1002)).toBeNull(); // Should be gone
            expect(cacheManager.getPrice(key2, 1001)).toEqual(mockPriceData); // Should exist (checked without currentBlock for pure existence)
        });
    });

    describe('Permanent Cache (Addresses & Decimals)', () => {
        test('should cache and retrieve pair addresses', () => {
            const tokenA = '0x123';
            const tokenB = '0x456';
            const dex = 'biswap';
            const pairAddress = '0xabc';

            cacheManager.setPairAddress(tokenA, tokenB, dex, pairAddress);
            const retrieved = cacheManager.getPairAddress(tokenA, tokenB, dex);

            expect(retrieved).toBe(pairAddress);
        });

        test('should treat tokens as case-insensitive for pair keys', () => {
            const tokenA = '0xABC';
            const tokenB = '0xDEF';
            const dex = 'biswap';
            const pairAddress = '0x789';

            cacheManager.setPairAddress(tokenA, tokenB, dex, pairAddress);
            const retrieved = cacheManager.getPairAddress(tokenA.toLowerCase(), tokenB.toLowerCase(), dex);

            expect(retrieved).toBe(pairAddress);
        });

        test('should cache and retrieve token decimals', () => {
            const token = '0xToken';
            const decimals = 18;

            cacheManager.setTokenDecimals(token, decimals);
            const retrieved = cacheManager.getTokenDecimals(token);

            expect(retrieved).toBe(decimals);
        });
    });

    describe('Utils', () => {
        test('should generate consistent keys regardless of token order', () => {
            const key1 = cacheManager.getPairKey('0xA', '0xB', 'dex');
            const key2 = cacheManager.getPairKey('0xB', '0xA', 'dex');
            expect(key1).toBe(key2);
        });
    });
});
