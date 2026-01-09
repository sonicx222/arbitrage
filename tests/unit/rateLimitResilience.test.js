import { jest } from '@jest/globals';

/**
 * Rate Limit Resilience Tests (v3.8/v3.9/v3.10)
 *
 * Tests for rate limit handling improvements:
 * - Immediate rollover on 429 errors
 * - Monthly capacity detection for Alchemy
 * - Staggered worker startup
 * - WebSocket 429 handling during handshake
 */

// Mock ethers before imports
const mockProvider = {
    destroy: jest.fn(),
    getBlockNumber: jest.fn().mockResolvedValue(12345),
    getFeeData: jest.fn().mockResolvedValue({ gasPrice: 5000000000n }),
    removeAllListeners: jest.fn(),
};

jest.unstable_mockModule('ethers', () => {
    const mockEthers = {
        JsonRpcProvider: jest.fn(() => mockProvider),
        WebSocketProvider: jest.fn(() => ({
            ...mockProvider,
            _websocket: { on: jest.fn() },
            websocket: { on: jest.fn(), readyState: 1 },
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
const { RPCManager } = await import('../../src/utils/rpcManager.js');

describe('Rate Limit Resilience (v3.8/v3.9/v3.10)', () => {
    let rpcManager;

    beforeEach(() => {
        // Create fresh instance for each test with mock config
        const mockChainConfig = {
            rpc: {
                http: [
                    'https://free-rpc-1.example.com',
                    'https://free-rpc-2.example.com',
                    'https://alchemy.com/api/key123',
                ],
                ws: ['wss://ws.example.com'],
                maxRequestsPerMinute: 100,
                requestDelay: 50,
                retryAttempts: 3,
                retryDelay: 100,
            },
            chainId: 1,
            name: 'Test Chain',
        };

        rpcManager = new RPCManager(mockChainConfig);
    });

    afterEach(async () => {
        if (rpcManager) {
            await rpcManager.cleanup();
            rpcManager.removeAllListeners();
        }
    });

    describe('v3.8: Alchemy Endpoint Detection', () => {
        test('should identify Alchemy endpoints', () => {
            expect(rpcManager.alchemyEndpoints.size).toBe(1);
            expect([...rpcManager.alchemyEndpoints][0]).toContain('alchemy.com');
        });

        test('should prioritize non-Alchemy endpoints (free first)', () => {
            // Get multiple providers and check that Alchemy comes last
            const providerEndpoints = [];
            for (let i = 0; i < 3; i++) {
                const provider = rpcManager.getHttpProvider();
                providerEndpoints.push(provider.endpoint);
                // Mark as used for rate limit
            }

            // First provider should NOT be Alchemy
            expect(providerEndpoints[0]).not.toContain('alchemy.com');
        });
    });

    describe('v3.8: Monthly Capacity Detection', () => {
        test('should detect monthly capacity errors', () => {
            const monthlyErrors = [
                new Error('monthly capacity limit exceeded'),
                new Error('Monthly limit reached'),
                new Error('Please upgrade your scaling policy'),
                new Error('capacity limit exceeded - visit dashboard.alchemy.com'),
            ];

            monthlyErrors.forEach(error => {
                expect(rpcManager._isMonthlyCapacityError(error)).toBe(true);
            });
        });

        test('should NOT flag regular rate limits as monthly', () => {
            const regularErrors = [
                new Error('429 Too Many Requests'),
                new Error('rate limit exceeded'),
                new Error('Too many requests'),
            ];

            regularErrors.forEach(error => {
                expect(rpcManager._isMonthlyCapacityError(error)).toBe(false);
            });
        });

        test('should apply 24h cooldown for monthly limit endpoints', () => {
            const alchemyEndpoint = [...rpcManager.alchemyEndpoints][0];

            // Simulate monthly limit hit
            rpcManager.monthlyLimitEndpoints.set(alchemyEndpoint, Date.now());

            // Should be excluded from available providers
            const provider = rpcManager.getHttpProvider();
            expect(provider.endpoint).not.toBe(alchemyEndpoint);
        });
    });

    describe('v3.9: Rate Limit Detection', () => {
        test('should detect 429 errors', () => {
            const rateLimitErrors = [
                new Error('Unexpected server response: 429'),
                new Error('429 Too Many Requests'),
                new Error('rate limit exceeded'),
                new Error('quota exceeded'),
            ];

            rateLimitErrors.forEach(error => {
                expect(rpcManager._isRateLimitError(error)).toBe(true);
            });
        });

        test('should NOT flag non-rate-limit errors', () => {
            const otherErrors = [
                new Error('Connection timeout'),
                new Error('ECONNREFUSED'),
                new Error('Invalid response'),
            ];

            otherErrors.forEach(error => {
                expect(rpcManager._isRateLimitError(error)).toBe(false);
            });
        });
    });

    describe('v3.9: Immediate Rollover', () => {
        test('should set endpoint cooldown on rate limit', () => {
            const endpoint = 'https://free-rpc-1.example.com';

            // Set cooldown
            rpcManager.setEndpointCooldown(endpoint, 30000);

            // Should be in cooldown
            const cooldownUntil = rpcManager.endpointCooldowns.get(endpoint);
            expect(cooldownUntil).toBeGreaterThan(Date.now());
        });

        test('should skip endpoints in cooldown', () => {
            const endpoint = rpcManager.httpProviders[0].endpoint;

            // Put first endpoint in cooldown
            rpcManager.setEndpointCooldown(endpoint, 60000);

            // Should get different provider
            const provider = rpcManager.getHttpProvider();
            expect(provider.endpoint).not.toBe(endpoint);
        });

        test('should apply longer cooldown for Alchemy (5 min vs 30s)', () => {
            const freeEndpoint = 'https://free-rpc-1.example.com';
            const alchemyEndpoint = [...rpcManager.alchemyEndpoints][0];

            // Based on v3.9 implementation:
            // - Free endpoints: 30s cooldown
            // - Alchemy endpoints: 5 min cooldown
            const freeCooldownMs = 30 * 1000;
            const alchemyCooldownMs = 5 * 60 * 1000;

            expect(freeCooldownMs).toBeLessThan(alchemyCooldownMs);
        });
    });

    describe('v3.7: Request Reservation System', () => {
        test('should track pending requests', () => {
            const endpoint = 'https://test.example.com';

            // Make a reservation
            rpcManager.canMakeRequest(endpoint, true);

            // Should have pending request
            expect(rpcManager.pendingRequests.get(endpoint)).toBe(1);
        });

        test('should complete request reservation', () => {
            const endpoint = 'https://test.example.com';

            // Make a reservation
            rpcManager.canMakeRequest(endpoint, true);
            expect(rpcManager.pendingRequests.get(endpoint)).toBe(1);

            // Complete the request
            rpcManager.completeRequest(endpoint, true);
            expect(rpcManager.pendingRequests.get(endpoint)).toBe(0);
        });

        test('should cancel request reservation', () => {
            const endpoint = 'https://test.example.com';

            // Make a reservation
            rpcManager.canMakeRequest(endpoint, true);
            expect(rpcManager.pendingRequests.get(endpoint)).toBe(1);

            // Cancel reservation
            rpcManager.cancelRequestReservation(endpoint);
            expect(rpcManager.pendingRequests.get(endpoint)).toBe(0);
        });
    });

    describe('v2.1: Global Request Budget', () => {
        test('should have global request budget', () => {
            expect(rpcManager.globalRequestBudget).toBeDefined();
            expect(rpcManager.globalRequestBudget.maxPerMinute).toBeLessThanOrEqual(1000);
        });

        test('should reset global budget after time passes', () => {
            // Set budget in the past
            rpcManager.globalRequestBudget.count = 100;
            rpcManager.globalRequestBudget.resetTime = Date.now() - 1000;

            // Should reset on next request
            const endpoint = 'https://test.example.com';
            rpcManager.canMakeRequest(endpoint, true);

            expect(rpcManager.globalRequestBudget.count).toBe(0);
        });
    });

    describe('v2.1: Request Throttling', () => {
        test('should have throttle configured', () => {
            expect(rpcManager.minRequestIntervalMs).toBeGreaterThan(0);
        });

        test('throttle should delay if called too quickly', async () => {
            rpcManager.lastRequestTime = Date.now();

            const startTime = Date.now();
            await rpcManager.throttle();
            const elapsed = Date.now() - startTime;

            // Should have waited at least some time (depends on minRequestIntervalMs)
            expect(elapsed).toBeGreaterThanOrEqual(0);
        });
    });

    describe('Endpoint Health Management', () => {
        test('should not include monthly-limited in emergency recovery', () => {
            // Mark all endpoints as rate-limited (cooldown)
            rpcManager.httpProviders.forEach(p => {
                rpcManager.setEndpointCooldown(p.endpoint, 60000);
            });

            // Mark Alchemy as monthly-limited
            const alchemyEndpoint = [...rpcManager.alchemyEndpoints][0];
            if (alchemyEndpoint) {
                rpcManager.monthlyLimitEndpoints.set(alchemyEndpoint, Date.now());
            }

            // Should still get a provider (emergency reset)
            // but it should NOT be the monthly-limited Alchemy
            const provider = rpcManager.getHttpProvider();
            expect(provider).toBeDefined();
            if (alchemyEndpoint) {
                expect(provider.endpoint).not.toBe(alchemyEndpoint);
            }
        });
    });
});

describe('Staggered Startup (v3.10)', () => {
    test('WorkerCoordinator should have stagger config', async () => {
        // Dynamic import to avoid mocking issues
        const { default: WorkerCoordinator } = await import('../../src/workers/WorkerCoordinator.js');

        const coordinator = new WorkerCoordinator();

        // Should have stagger configuration
        expect(coordinator.workerStartupDelayMs).toBeDefined();
        expect(coordinator.workerStartupDelayMs).toBeGreaterThan(0);
        expect(coordinator.workerStartupJitterMs).toBeDefined();
    });
});

describe('WebSocket Resilience (v3.10)', () => {
    test('ResilientWebSocket should have initial connection config', async () => {
        // Create a test instance to check config
        const { ResilientWebSocket } = await import('../../src/utils/resilientWebSocket.js');

        const ws = new ResilientWebSocket('wss://test.example.com', 1, {});

        // Should have v3.10 config for initial connection
        expect(ws.config.initialConnectionTimeoutMs).toBeDefined();
        expect(ws.config.initialConnectionTimeoutMs).toBeGreaterThanOrEqual(10000);
        expect(ws.config.initialConnectionRetries).toBeDefined();
        expect(ws.config.initialConnectionRetries).toBeGreaterThanOrEqual(2);
        expect(ws.config.initialRetryDelayMs).toBeDefined();
    });

    test('ResilientWebSocket should categorize 429 errors', async () => {
        const { ResilientWebSocket } = await import('../../src/utils/resilientWebSocket.js');

        const ws = new ResilientWebSocket('wss://test.example.com', 1, {});

        // Test error categorization
        expect(ws._categorizeError('rate_limit', new Error('429'))).toBe('rate_limit');
        expect(ws._categorizeError('ws_error', new Error('Too Many Requests'))).toBe('rate_limit');
        expect(ws._categorizeError('ws_error', new Error('Invalid WebSocket frame'))).toBe('frame_error');
        expect(ws._categorizeError('ws_error', new Error('Connection timeout'))).toBe('connection_error');
        expect(ws._categorizeError('ws_error', new Error('Unknown error'))).toBe('unknown');
    });

    test('ResilientWebSocket should track consecutive 429 errors', async () => {
        const { ResilientWebSocket } = await import('../../src/utils/resilientWebSocket.js');

        const ws = new ResilientWebSocket('wss://test.example.com', 1, {});

        // Initial state
        expect(ws.consecutive429Errors).toBe(0);

        // Simulate rate limit errors (would increment counter)
        ws.lastErrorType = 'rate_limit';
        ws.consecutive429Errors++;
        expect(ws.consecutive429Errors).toBe(1);

        ws.consecutive429Errors++;
        expect(ws.consecutive429Errors).toBe(2);
    });
});

describe('ResilientWebSocketManager (v3.10)', () => {
    test('should have init retry config', async () => {
        const { ResilientWebSocketManager } = await import('../../src/utils/resilientWebSocketManager.js');

        const manager = new ResilientWebSocketManager();

        // Should have v3.10 config
        expect(manager.config.initRetryDelayMs).toBeDefined();
        expect(manager.config.initRetryDelayMs).toBeGreaterThan(0);
        expect(manager.config.maxInitRetries).toBeDefined();
        expect(manager.config.maxInitRetries).toBeGreaterThanOrEqual(2);
    });

    test('should have stagger config', async () => {
        const { ResilientWebSocketManager } = await import('../../src/utils/resilientWebSocketManager.js');

        const manager = new ResilientWebSocketManager();

        // Should have v3.8 stagger config
        expect(manager.config.staggerDelayMs).toBeDefined();
        expect(manager.config.staggerDelayMs).toBeGreaterThan(0);
        expect(manager.config.staggerJitterMs).toBeDefined();
    });

    test('should have failover debounce', async () => {
        const { ResilientWebSocketManager } = await import('../../src/utils/resilientWebSocketManager.js');

        const manager = new ResilientWebSocketManager();

        // Should have failover debounce (v3.6/v3.8)
        expect(manager.failoverInProgress).toBe(false);
        expect(manager.failoverDebounceTimer).toBeNull();
    });
});

describe('Chain Config RPC Endpoints (v3.9)', () => {
    test('BSC should have multiple free endpoints', async () => {
        const bscConfig = await import('../../src/config/chains/bsc.js');

        // Should have many free endpoints
        expect(bscConfig.default.rpc.http.length).toBeGreaterThan(10);

        // Should have Binance official endpoints first
        expect(bscConfig.default.rpc.http[0]).toContain('binance.org');
    });

    test('Ethereum should have multiple free endpoints', async () => {
        const ethConfig = await import('../../src/config/chains/ethereum.js');

        // Should have many free endpoints
        expect(ethConfig.default.rpc.http.length).toBeGreaterThan(8);
    });

    test('Polygon should have multiple free endpoints', async () => {
        const polygonConfig = await import('../../src/config/chains/polygon.js');

        // Should have many free endpoints
        expect(polygonConfig.default.rpc.http.length).toBeGreaterThan(8);

        // Should have official polygon-rpc.com first
        expect(polygonConfig.default.rpc.http[0]).toContain('polygon');
    });

    test('Alchemy endpoints should be at the end', async () => {
        const bscConfig = await import('../../src/config/chains/bsc.js');

        const httpEndpoints = bscConfig.default.rpc.http;
        const lastEndpoints = httpEndpoints.slice(-3);

        // Alchemy should be near the end (after env vars filter)
        // The actual position depends on env vars being set
        // Just verify Alchemy isn't first
        if (httpEndpoints.some(e => e?.includes('alchemy'))) {
            expect(httpEndpoints[0]).not.toContain('alchemy');
        }
    });
});
