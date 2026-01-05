import { jest } from '@jest/globals';

// Mock ethers before imports
const mockProvider = {
    destroy: jest.fn(),
};

jest.unstable_mockModule('ethers', () => {
    const mockEthers = {
        JsonRpcProvider: jest.fn(() => mockProvider),
        WebSocketProvider: jest.fn(() => ({
            ...mockProvider,
            _websocket: { on: jest.fn() },
            on: jest.fn(),
        })),
        parseUnits: jest.fn((val, unit) => BigInt(val) * (unit === 'gwei' ? 1000000000n : 1n)),
        formatUnits: jest.fn((val) => val.toString()),
        ZeroAddress: '0x0000000000000000000000000000000000000000',
    };
    return {
        ethers: mockEthers,
        parseUnits: mockEthers.parseUnits,
        formatUnits: mockEthers.formatUnits,
        ZeroAddress: mockEthers.ZeroAddress,
    };
});

// Import after mocking
const { default: rpcManager } = await import('../../src/utils/rpcManager.js');
const { default: config } = await import('../../src/config.js');

describe('RPCManager', () => {
    // Reset state before each test
    beforeEach(() => {
        // Since RPCManager is a singleton, we need to manually reset its internal state if possible
        // Or we can just access it directly for white-box testing
        rpcManager.currentHttpIndex = 0;
        rpcManager.currentWsIndex = 0;
        rpcManager.endpointHealth.clear();
        rpcManager.requestCounts.clear();

        // Re-init health for configured endpoints
        rpcManager.httpEndpoints.forEach(ep => {
            rpcManager.endpointHealth.set(ep, { healthy: true, lastCheck: Date.now(), failures: 0 });
        });
    });

    describe('Provider Selection', () => {
        test('should prioritize Alchemy when available and healthy', () => {
            const alchemyEndpoint = rpcManager.httpProviders[0].endpoint;
            config.rpc.alchemy.http = alchemyEndpoint;
            rpcManager.endpointHealth.set(alchemyEndpoint, { healthy: true });

            const provider = rpcManager.getHttpProvider();
            expect(provider.endpoint).toBe(alchemyEndpoint);
        });

        test('should cycle through HTTP providers (round-robin) when Alchemy is disabled', () => {
            // Disable Alchemy priority
            config.rpc.alchemy.http = '';

            // Assume at least 2 providers in config
            if (rpcManager.httpProviders.length < 2) return;

            const first = rpcManager.getHttpProvider();
            const second = rpcManager.getHttpProvider();

            expect(first.index).not.toBe(second.index);
        });

        test('should skip unhealthy Alchemy provider and fallback', () => {
            const alchemyEndpoint = rpcManager.httpProviders[0].endpoint;
            config.rpc.alchemy.http = alchemyEndpoint;
            rpcManager.endpointHealth.set(alchemyEndpoint, { healthy: false });

            const provider = rpcManager.getHttpProvider();
            expect(provider.endpoint).not.toBe(alchemyEndpoint);
        });

        test('should skip unhealthy providers', () => {
            if (rpcManager.httpProviders.length < 2) return;

            const badEndpoint = rpcManager.httpProviders[0].endpoint;
            // Mark first one as unhealthy
            rpcManager.endpointHealth.set(badEndpoint, { healthy: false });

            // Next calls should avoid the unhealthy one
            const provider = rpcManager.getHttpProvider();
            expect(provider.endpoint).not.toBe(badEndpoint);
        });

        test('should reset all to healthy if ALL are unhealthy', () => {
            // Mark ALL as unhealthy
            rpcManager.httpProviders.forEach(p => {
                rpcManager.endpointHealth.set(p.endpoint, { healthy: false });
            });

            // Should trigger reset and return a provider
            const provider = rpcManager.getHttpProvider();
            expect(provider).toBeDefined();

            // Check if health was reset
            expect(rpcManager.endpointHealth.get(provider.endpoint).healthy).toBe(true);
        });
    });

    describe('Rate Limiting', () => {
        test('should allow requests under limit', () => {
            const endpoint = 'http://test.com';
            // First request
            expect(rpcManager.canMakeRequest(endpoint)).toBe(true);

            // Stats check
            const stats = rpcManager.requestCounts.get(endpoint);
            expect(stats.count).toBe(1);
        });

        test('should block requests over limit', () => {
            const endpoint = 'http://limited.com';
            // Set max requests to 0 or simulate hitting limit
            rpcManager.maxRequestsPerMinute = 2;

            rpcManager.canMakeRequest(endpoint); // 1
            rpcManager.canMakeRequest(endpoint); // 2 (at limit)

            expect(rpcManager.canMakeRequest(endpoint)).toBe(false); // 3 (blocked)
        });

        test('should reset limit after time passes', () => {
            const endpoint = 'http://reset.com';
            const now = Date.now();
            rpcManager.requestCounts.set(endpoint, {
                count: 100,
                resetTime: now - 1000 // In the past
            });

            expect(rpcManager.canMakeRequest(endpoint)).toBe(true);
            expect(rpcManager.requestCounts.get(endpoint).count).toBe(1); // Reset to 1
        });
    });

    describe('Health Management', () => {
        test('should mark endpoint unhealthy after 3 failures', () => {
            const endpoint = 'http://fail.com';
            rpcManager.endpointHealth.set(endpoint, { healthy: true, failures: 0 });

            rpcManager.markEndpointUnhealthy(endpoint); // 1
            rpcManager.markEndpointUnhealthy(endpoint); // 2
            expect(rpcManager.endpointHealth.get(endpoint).healthy).toBe(true); // Still healthy

            rpcManager.markEndpointUnhealthy(endpoint); // 3
            expect(rpcManager.endpointHealth.get(endpoint).healthy).toBe(false); // Unhealthy
        });
    });

    describe('Gas Price', () => {
        test('should fetch and cache gas price', async () => {
            const mockGasPrice = 5000000000n; // 5 Gwei
            mockProvider.getFeeData = jest.fn().mockResolvedValue({
                gasPrice: mockGasPrice
            });

            const price = await rpcManager.getGasPrice();
            expect(price).toBe(mockGasPrice);
            expect(mockProvider.getFeeData).toHaveBeenCalledTimes(1);

            // Second call should used cached value
            const secondPrice = await rpcManager.getGasPrice();
            expect(secondPrice).toBe(mockGasPrice);
            expect(mockProvider.getFeeData).toHaveBeenCalledTimes(1);
        });
    });
});
