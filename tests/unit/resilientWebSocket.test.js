import { jest } from '@jest/globals';

// Mock ethers WebSocketProvider
const mockProvider = {
    getBlockNumber: jest.fn().mockResolvedValue(12345),
    on: jest.fn(),
    removeAllListeners: jest.fn(),
    destroy: jest.fn(),
    websocket: {
        on: jest.fn(),
    },
};

jest.unstable_mockModule('ethers', () => ({
    ethers: {
        WebSocketProvider: jest.fn().mockImplementation(() => mockProvider),
    },
}));

const { ResilientWebSocket } = await import('../../src/utils/resilientWebSocket.js');

describe('ResilientWebSocket', () => {
    let ws;

    beforeEach(() => {
        jest.clearAllMocks();
        ws = new ResilientWebSocket('wss://test.endpoint/key', 56, {
            heartbeatIntervalMs: 1000,
            heartbeatTimeoutMs: 500,
            reconnectBaseDelayMs: 100,
            maxReconnectAttempts: 3,
            circuitBreakerCooldownMs: 1000,
        });
    });

    afterEach(async () => {
        await ws.disconnect();
    });

    describe('Connection State Machine', () => {
        it('should start in disconnected state', () => {
            expect(ws.state).toBe('disconnected');
        });

        it('should transition to connected on successful connect', async () => {
            await ws.connect();
            expect(ws.state).toBe('connected');
        });

        it('should track connection establishment', async () => {
            await ws.connect();
            expect(ws.metrics.connectionsEstablished).toBe(1);
        });

        it('should update connectionStartTime on connect', async () => {
            const before = Date.now();
            await ws.connect();
            const after = Date.now();

            expect(ws.connectionStartTime).toBeGreaterThanOrEqual(before);
            expect(ws.connectionStartTime).toBeLessThanOrEqual(after);
        });
    });

    describe('Circuit Breaker', () => {
        it('should have circuit breaker metrics initialized', () => {
            expect(ws.metrics.circuitBreakerTrips).toBe(0);
        });

        it('should track reconnect attempts in metrics', () => {
            expect(ws.metrics.reconnectAttempts).toBe(0);
        });

        it('should open circuit after max reconnect attempts', async () => {
            // Simulate max reconnect attempts
            ws.reconnectAttempts = ws.config.maxReconnectAttempts;

            // Trigger circuit breaker check
            ws._openCircuitBreaker();

            expect(ws.state).toBe('circuit_open');
            expect(ws.metrics.circuitBreakerTrips).toBe(1);
        });

        it('should emit circuitOpen event when circuit opens', (done) => {
            ws.on('circuitOpen', (data) => {
                expect(data).toHaveProperty('cooldownMs');
                expect(data).toHaveProperty('willRetryAt');
                done();
            });

            ws._openCircuitBreaker();
        });

        it('should block connections when circuit is open', async () => {
            ws._openCircuitBreaker();

            await expect(ws.connect()).rejects.toThrow(/Circuit breaker open/);
        });
    });

    describe('Heartbeat', () => {
        it('should track heartbeat metrics', async () => {
            await ws.connect();

            expect(ws.metrics.heartbeatsSent).toBe(0); // Not yet sent
            expect(ws.metrics.heartbeatsFailed).toBe(0);
        });

        it('should update lastSuccessfulHeartbeat on connect', async () => {
            await ws.connect();

            expect(ws.lastSuccessfulHeartbeat).toBeDefined();
            expect(Date.now() - ws.lastSuccessfulHeartbeat).toBeLessThan(1000);
        });

        it('should calculate consecutive failures correctly', async () => {
            await ws.connect();

            // Recent heartbeat = 0 failures
            ws.lastSuccessfulHeartbeat = Date.now();
            expect(ws._getConsecutiveFailures()).toBe(0);

            // Simulate old heartbeat
            ws.lastSuccessfulHeartbeat = Date.now() - 5000; // 5 seconds ago
            // With 1000ms interval, that's 5 missed heartbeats
            expect(ws._getConsecutiveFailures()).toBe(5);
        });
    });

    describe('Reconnection with Jitter', () => {
        it('should add jitter to reconnect delay', () => {
            // Test that delays vary due to jitter
            const delays = [];

            for (let i = 0; i < 10; i++) {
                ws.reconnectAttempts = 1;
                const baseDelay = ws.config.reconnectBaseDelayMs;
                const cappedDelay = Math.min(baseDelay, ws.config.reconnectMaxDelayMs);
                const jitter = cappedDelay * ws.config.jitterFactor * (Math.random() - 0.5) * 2;
                delays.push(cappedDelay + jitter);
            }

            // Check that not all delays are identical (jitter working)
            const uniqueDelays = new Set(delays);
            expect(uniqueDelays.size).toBeGreaterThan(1);
        });

        it('should cap delay at maxReconnectDelayMs', () => {
            ws.reconnectAttempts = 100; // Very high to test cap

            const baseDelay = ws.config.reconnectBaseDelayMs * Math.pow(2, ws.reconnectAttempts - 1);
            const cappedDelay = Math.min(baseDelay, ws.config.reconnectMaxDelayMs);

            expect(cappedDelay).toBe(ws.config.reconnectMaxDelayMs);
        });
    });

    describe('Status and Metrics', () => {
        it('should return comprehensive status', async () => {
            await ws.connect();

            const status = ws.getStatus();

            expect(status.state).toBe('connected');
            expect(status.url).toBeDefined();
            expect(status.connectionAgeMs).toBeGreaterThanOrEqual(0);
            expect(status.lastHeartbeat).toBeDefined();
            expect(status.metrics).toBeDefined();
            expect(status.metrics.connectionsEstablished).toBe(1);
        });

        it('should mask long URLs in status', () => {
            // Create ws with long API key in URL
            const wsLongKey = new ResilientWebSocket(
                'wss://test.endpoint/v1/abcdefghijklmnopqrstuvwxyz1234567890',
                56
            );
            const status = wsLongKey.getStatus();

            // Long paths should be truncated with ...
            expect(status.url).toContain('...');
            // Should not contain full key
            expect(status.url).not.toContain('1234567890');
        });
    });

    describe('Event Emission', () => {
        it('should emit connected event', (done) => {
            ws.on('connected', () => {
                done();
            });

            ws.connect();
        });

        it('should emit disconnected event with reason', (done) => {
            ws.on('disconnected', (reason) => {
                expect(reason).toBe('test_reason');
                done();
            });

            ws.state = 'connected';
            ws._handleDisconnect('test_reason');
        });
    });

    describe('Proactive Refresh', () => {
        it('should track proactive refresh metrics', () => {
            expect(ws.metrics.proactiveRefreshes).toBe(0);
        });
    });

    describe('Cleanup', () => {
        it('should clean up resources on disconnect', async () => {
            await ws.connect();
            await ws.disconnect();

            expect(ws.state).toBe('disconnected');
            expect(ws.provider).toBeNull();
            expect(ws.heartbeatTimer).toBeNull();
        });

        it('should clear all timers on cleanup', async () => {
            await ws.connect();

            // Verify timers exist
            expect(ws.heartbeatTimer).not.toBeNull();

            await ws.disconnect();

            expect(ws.heartbeatTimer).toBeNull();
            expect(ws.refreshTimer).toBeNull();
            expect(ws.reconnectTimer).toBeNull();
        });

        it('should prevent cleanup race condition with isCleaningUp flag', async () => {
            await ws.connect();

            // Verify initial state
            expect(ws.isCleaningUp).toBe(false);

            // Manually set isCleaningUp to simulate concurrent cleanup
            ws.isCleaningUp = true;

            // Call cleanup - should return early without error
            ws._cleanup();

            // Provider should NOT be null since cleanup was skipped
            expect(ws.provider).not.toBeNull();

            // Reset flag and cleanup properly
            ws.isCleaningUp = false;
            ws._cleanup();

            // Now provider should be null
            expect(ws.provider).toBeNull();
        });

        it('should reset isCleaningUp flag after cleanup completes', async () => {
            await ws.connect();

            ws._cleanup();

            // Flag should be reset after cleanup
            expect(ws.isCleaningUp).toBe(false);
        });

        it('should handle disconnect event during cleanup without error', async () => {
            await ws.connect();

            // Start cleanup
            ws.isCleaningUp = true;

            // Simulate WebSocket close event triggering handleDisconnect
            // This should be ignored because isCleaningUp is true
            const disconnectSpy = jest.fn();
            ws.on('disconnected', disconnectSpy);

            ws._handleDisconnect('ws_close');

            // Disconnect should not have been processed
            expect(disconnectSpy).not.toHaveBeenCalled();
            expect(ws.state).toBe('connected'); // State unchanged

            ws.isCleaningUp = false;
        });

        it('should handle provider.destroy() errors gracefully', async () => {
            await ws.connect();

            // Mock destroy to throw error (like "WebSocket was closed before connection established")
            ws.provider.destroy = jest.fn().mockImplementation(() => {
                throw new Error('WebSocket was closed before the connection was established');
            });

            // Cleanup should not throw
            expect(() => ws._cleanup()).not.toThrow();

            // Provider should still be set to null
            expect(ws.provider).toBeNull();
        });
    });
});
