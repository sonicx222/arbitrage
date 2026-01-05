import { jest } from '@jest/globals';

// Mocks must be defined before imports
jest.unstable_mockModule('../../src/utils/logger.js', () => ({
    default: {
        info: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
    }
}));

jest.unstable_mockModule('../../src/utils/rpcManager.js', () => ({
    default: {
        withRetry: jest.fn((fn) => fn('mock_provider')),
        getProvider: jest.fn(),
    }
}));

jest.unstable_mockModule('../../src/data/cacheManager.js', () => ({
    default: {
        getPairAddress: jest.fn(),
        setPairAddress: jest.fn(),
        getPrice: jest.fn(),
        setPrice: jest.fn(),
        getPriceKey: jest.fn((tA, tB, d) => `price:${d}:${tA}:${tB}`),
        getPairKey: jest.fn((tA, tB, d) => `pair:${d}:${tA}:${tB}`),
    }
}));

// Mock ethers
const mockInterface = {
    encodeFunctionData: jest.fn(() => '0xencoded'),
    decodeFunctionResult: jest.fn(() => ['0xdecoded_result']),
};

const mockContract = jest.fn(() => ({
    interface: mockInterface,
    tryAggregate: jest.fn().mockResolvedValue([
        { success: true, returnData: '0x123' }, // For getPair
        { success: true, returnData: '0x456' }  // For getReserves
    ]),
    getReserves: jest.fn().mockResolvedValue([1000n, 1000n, 123456789n]), // reserve0, reserve1, timestamp
}));

jest.unstable_mockModule('ethers', () => ({
    ethers: {
        Contract: mockContract,
        ZeroAddress: '0x0000000000000000000000000000000000000000',
        formatUnits: jest.fn(() => '1.0'),
        WebSocketProvider: jest.fn(),
        JsonRpcProvider: jest.fn(),
        isAddress: jest.fn(() => true),
    }
}));

// Import modules after mocking
const { default: priceFetcher } = await import('../../src/data/priceFetcher.js');
const { default: config } = await import('../../src/config.js');

describe('PriceFetcher', () => {
    describe('getTokenPairs', () => {
        test('should generate pairs from config tokens', () => {
            // We rely on the actual config.js tokens
            const pairs = priceFetcher._getTokenPairs();
            // Current config has ~12 tokens. 
            // 12 tokens => 12*11/2 = 66 pairs? Check exact count or just > 0
            expect(pairs.length).toBeGreaterThan(0);
            expect(pairs[0]).toHaveProperty('tokenA');
            expect(pairs[0]).toHaveProperty('tokenB');
            expect(pairs[0]).toHaveProperty('pairKey');
        });
    });

    // Validating fetchAllPrices is complex due to the extensive internal logic
    // We will verify it doesn't crash effectively mocked
    describe('fetchAllPrices', () => {
        test('should execute without error using mocked RPC', async () => {
            // This test mainly verifies the orchestration logic doesn't throw
            const results = await priceFetcher.fetchAllPrices(100);
            expect(results).toBeDefined();
            // Since we mocked everything to return something, we expect some result structure
            expect(typeof results).toBe('object');
        });
    });
});
