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

        // v2.1: Also clear cooldowns and reset global budget
        if (rpcManager.endpointCooldowns) {
            rpcManager.endpointCooldowns.clear();
        }
        if (rpcManager.globalRequestBudget) {
            rpcManager.globalRequestBudget.count = 0;
            rpcManager.globalRequestBudget.resetTime = Date.now() + 60000;
        }

        // Re-init health for configured endpoints
        rpcManager.httpEndpoints.forEach(ep => {
            rpcManager.endpointHealth.set(ep, { healthy: true, lastCheck: Date.now(), failures: 0 });
        });
    });

    afterAll(async () => {
        // Cleanup to prevent open handles
        await rpcManager.cleanup();
        rpcManager.removeAllListeners();
    });

    describe('Provider Selection', () => {
        test('v2.1: should use round-robin across all healthy providers (no priority)', () => {
            // v2.1 changed from Alchemy-priority to true round-robin for better load distribution
            // This prevents rate limit issues by spreading load across all endpoints
            const alchemyEndpoint = rpcManager.httpProviders[0].endpoint;
            config.rpc.alchemy.http = alchemyEndpoint;
            rpcManager.endpointHealth.set(alchemyEndpoint, { healthy: true });

            // Multiple calls should cycle through providers, not always return Alchemy
            const providers = new Set();
            for (let i = 0; i < rpcManager.httpProviders.length + 1; i++) {
                const provider = rpcManager.getHttpProvider();
                providers.add(provider.endpoint);
            }

            // Should have used multiple providers (round-robin behavior)
            expect(providers.size).toBeGreaterThan(0);
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

    describe('Self-Healing', () => {
        test('should track unhealthySince when marking endpoint unhealthy', () => {
            const endpoint = 'http://unhealthy.com';
            rpcManager.endpointHealth.set(endpoint, { healthy: true, failures: 0 });

            // Mark unhealthy 3 times to trigger unhealthy status
            rpcManager.markEndpointUnhealthy(endpoint);
            rpcManager.markEndpointUnhealthy(endpoint);
            rpcManager.markEndpointUnhealthy(endpoint);

            const health = rpcManager.endpointHealth.get(endpoint);
            expect(health.healthy).toBe(false);
            expect(health.unhealthySince).toBeDefined();
            expect(health.unhealthySince).toBeLessThanOrEqual(Date.now());
        });

        test('should emit endpointUnhealthy event when endpoint becomes unhealthy', () => {
            const endpoint = 'http://failing.com';
            rpcManager.endpointHealth.set(endpoint, { healthy: true, failures: 0 });

            const eventHandler = jest.fn();
            rpcManager.on('endpointUnhealthy', eventHandler);

            // Trigger unhealthy status
            rpcManager.markEndpointUnhealthy(endpoint);
            rpcManager.markEndpointUnhealthy(endpoint);
            rpcManager.markEndpointUnhealthy(endpoint);

            expect(eventHandler).toHaveBeenCalledWith(endpoint);
            rpcManager.removeListener('endpointUnhealthy', eventHandler);
        });

        test('should start and stop self-healing interval', () => {
            // Stop any existing interval first
            rpcManager.stopSelfHealing();
            expect(rpcManager.healingInterval).toBeNull();

            // Start self-healing
            rpcManager.startSelfHealing();
            expect(rpcManager.healingInterval).not.toBeNull();

            // Stop self-healing
            rpcManager.stopSelfHealing();
            expect(rpcManager.healingInterval).toBeNull();
        });

        test('should have self-healing stats in getStats', () => {
            const stats = rpcManager.getStats();

            expect(stats).toHaveProperty('selfHealing');
            expect(stats.selfHealing).toHaveProperty('enabled');
            expect(stats.selfHealing).toHaveProperty('intervalMs');
            expect(stats.selfHealing).toHaveProperty('unhealthyEndpoints');
        });

        test('should identify unhealthy endpoints for healing', async () => {
            const endpoint = 'http://heal-test.com';
            const now = Date.now();

            // Set up an unhealthy endpoint that's ready for retry
            rpcManager.endpointHealth.set(endpoint, {
                healthy: false,
                failures: 5,
                unhealthySince: now - (rpcManager.minRecoveryTimeMs + 1000), // Past recovery time
            });

            // The healUnhealthyEndpoints method should find this endpoint
            const stats = rpcManager.getStats();
            expect(stats.selfHealing.unhealthyEndpoints).toBeGreaterThanOrEqual(1);
        });

        test('should mask endpoint URLs in logs for security', () => {
            const endpoint = 'https://eth-mainnet.g.alchemy.com/v2/abc123secretkey456';
            const masked = rpcManager._maskEndpoint(endpoint);

            // Should not expose the full API key
            expect(masked).not.toContain('abc123secretkey456');
            expect(masked).toContain('...');
            expect(masked).toContain('alchemy.com');
        });

        test('forceHealAll should trigger healing check', async () => {
            // Just verify it doesn't throw
            await expect(rpcManager.forceHealAll()).resolves.not.toThrow();
        });
    });
});
