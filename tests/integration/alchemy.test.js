import { jest } from '@jest/globals';
import { ethers } from 'ethers';

// Mock ethers
const mockProvider = {
    getBlockNumber: jest.fn().mockResolvedValue(100),
    on: jest.fn(),
    removeAllListeners: jest.fn(),
    destroy: jest.fn().mockResolvedValue(true),
    // For price fetching
    call: jest.fn().mockResolvedValue('0x' + '0'.repeat(64)),
};

// We need to capture the target URLs used by JsonRpcProvider and WebSocketProvider
const providerTargets = [];

jest.unstable_mockModule('ethers', () => ({
    ethers: {
        ...ethers,
        JsonRpcProvider: jest.fn((url) => {
            providerTargets.push(url);
            return mockProvider;
        }),
        WebSocketProvider: jest.fn((url) => {
            providerTargets.push(url);
            return {
                ...mockProvider,
                _websocket: { on: jest.fn() },
            };
        }),
        Contract: jest.fn(() => ({
            tryAggregate: jest.fn().mockResolvedValue([]),
        })),
    }
}));

// Mock logger to avoid noise
jest.unstable_mockModule('../../src/utils/logger.js', () => ({
    default: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        rpc: jest.fn(),
        ws: jest.fn(),
    }
}));

// Import modules
const { default: rpcManager } = await import('../../src/utils/rpcManager.js');
const { default: blockMonitor } = await import('../../src/monitoring/blockMonitor.js');
const { default: config } = await import('../../src/config.js');

describe('Alchemy Integration', () => {
    const ALCHEMY_HTTP = 'https://bnb-mainnet.g.alchemy.com/v2/test-key';
    const ALCHEMY_WS = 'wss://bnb-mainnet.g.alchemy.com/v2/test-key';

    beforeAll(() => {
        // Set Alchemy endpoints in config
        config.rpc.alchemy.http = ALCHEMY_HTTP;
        config.rpc.alchemy.ws = ALCHEMY_WS;

        // Re-initialize rpcManager providers with mockup URLs
        // We'll just push them manually to simulate initialization if needed,
        // but rpcManager already initialized with what was in config.js (which might be empty or actual Alchemy URL)

        // Ensure Alchemy is in the pools
        if (!rpcManager.httpProviders.some(p => p.endpoint === ALCHEMY_HTTP)) {
            rpcManager.httpProviders.unshift({ endpoint: ALCHEMY_HTTP, provider: mockProvider, index: -1 });
            rpcManager.endpointHealth.set(ALCHEMY_HTTP, { healthy: true, failures: 0 });
        }

        // For legacy WS providers (used when ResilientWebSocketManager is not initialized)
        if (!rpcManager.wsProviders.some(p => p.endpoint === ALCHEMY_WS)) {
            rpcManager.wsProviders.unshift({ endpoint: ALCHEMY_WS, provider: mockProvider, index: -1 });
            rpcManager.endpointHealth.set(ALCHEMY_WS, { healthy: true, failures: 0 });
        }

        // Disable the wsManager for this test to use legacy providers
        // This tests the fallback path and Alchemy priority in legacy mode
        rpcManager.wsManagerInitialized = false;
    });

    afterAll(() => {
        // Restore wsManager state if it was initialized
        // This is handled by the ResilientWebSocketManager automatically
    });

    test('should use Alchemy HTTP for price fetching priority', async () => {
        const providerData = rpcManager.getHttpProvider();
        expect(providerData.endpoint).toBe(ALCHEMY_HTTP);
    });

    test('should use Alchemy WS for block monitoring priority (legacy mode)', async () => {
        // Ensure legacy mode is active for this test
        rpcManager.wsManagerInitialized = false;

        const providerData = rpcManager.getWsProvider();
        expect(providerData.endpoint).toBe(ALCHEMY_WS);
    });

    test('should fallback if Alchemy is unhealthy', async () => {
        // Mark Alchemy as unhealthy
        rpcManager.endpointHealth.set(ALCHEMY_HTTP, { healthy: false });

        const providerData = rpcManager.getHttpProvider();
        expect(providerData.endpoint).not.toBe(ALCHEMY_HTTP);

        // Reset for other tests
        rpcManager.endpointHealth.set(ALCHEMY_HTTP, { healthy: true });
    });
});
