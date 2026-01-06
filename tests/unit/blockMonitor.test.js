import { jest } from '@jest/globals';

// Mock dependencies
const mockProvider = {
    on: jest.fn(),
    removeAllListeners: jest.fn(),
    destroy: jest.fn().mockResolvedValue(),
    getBlockNumber: jest.fn().mockResolvedValue(100),
};

const mockRPCManager = {
    getWsProvider: jest.fn(() => ({ provider: mockProvider })),
    withRetry: jest.fn((fn) => fn(mockProvider)),
};

jest.unstable_mockModule('../../src/utils/rpcManager.js', () => ({
    default: mockRPCManager
}));

// Import after mocking
const { default: blockMonitor } = await import('../../src/monitoring/blockMonitor.js');

describe('BlockMonitor', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Reset internal state
        blockMonitor.isRunning = false;
        blockMonitor.provider = null;
        blockMonitor.pollingInterval = null;
        blockMonitor.reconnectAttempts = 0;
        // Remove all event listeners to prevent leaks
        blockMonitor.removeAllListeners();
    });

    afterEach(async () => {
        // Ensure all timers are cleared
        if (blockMonitor.pollingInterval) {
            clearInterval(blockMonitor.pollingInterval);
            blockMonitor.pollingInterval = null;
        }
        if (blockMonitor.staleCheckInterval) {
            clearInterval(blockMonitor.staleCheckInterval);
            blockMonitor.staleCheckInterval = null;
        }
        blockMonitor.isRunning = false;
        blockMonitor.removeAllListeners();
        await blockMonitor.stop();
    });

    describe('Startup', () => {
        test('should connect via WebSocket logic primarily', async () => {
            await blockMonitor.start();

            expect(mockRPCManager.getWsProvider).toHaveBeenCalled();
            expect(mockProvider.on).toHaveBeenCalledWith('block', expect.any(Function));
            expect(blockMonitor.isRunning).toBe(true);
        });

        test('should fallback to HTTP polling if WebSocket fails', async () => {
            // Mock WS failure
            mockRPCManager.getWsProvider.mockReturnValue(null);

            // Spy on fallback method
            const pollingSpy = jest.spyOn(blockMonitor, 'startHttpPolling');

            await blockMonitor.start();

            expect(pollingSpy).toHaveBeenCalled();
            expect(blockMonitor.isRunning).toBe(true);
        });
    });

    describe('Event Handling', () => {
        test('should emit newBlock event when block received', (done) => {
            const blockNum = 12345;

            blockMonitor.on('newBlock', (data) => {
                try {
                    expect(data.blockNumber).toBe(blockNum);
                    expect(data).toHaveProperty('timestamp');
                    done();
                } catch (e) {
                    done(e);
                }
            });

            blockMonitor.handleNewBlock(blockNum);
        });
    });

    describe('Reconnection', () => {
        test('should attempt to reconnect on failure', async () => {
            // Setup fake timers
            jest.useFakeTimers();

            blockMonitor.isRunning = true;
            const connectSpy = jest.spyOn(blockMonitor, 'connect').mockResolvedValue();

            // Trigger reconnect
            const reconnectPromise = blockMonitor.handleReconnect();

            // Fast forward time
            jest.runAllTimers();

            await reconnectPromise;

            expect(connectSpy).toHaveBeenCalled();
            expect(blockMonitor.reconnectAttempts).toBe(1);

            jest.useRealTimers();
        });

        test('should stop reconnecting after max attempts', async () => {
            blockMonitor.isRunning = true;
            blockMonitor.reconnectAttempts = 10; // Max

            const errorPromise = new Promise(resolve => {
                blockMonitor.once('error', (err) => {
                    expect(err.message).toBe('Max reconnection attempts reached');
                    resolve();
                });
            });

            await blockMonitor.handleReconnect();
            await errorPromise;
        });
    });

    describe('Stale Block Detection (Bug Fix Regression)', () => {
        test('should have staleCheckInterval property initialized', () => {
            expect(blockMonitor).toHaveProperty('staleCheckInterval');
        });

        test('should set up stale block detection when connecting', async () => {
            // Restore WS provider
            mockRPCManager.getWsProvider.mockReturnValue({ provider: mockProvider });

            await blockMonitor.start();

            // After connecting, stale check interval should be set
            expect(blockMonitor.staleCheckInterval).not.toBeNull();
        });

        test('should clear stale check interval on stop', async () => {
            // Restore WS provider
            mockRPCManager.getWsProvider.mockReturnValue({ provider: mockProvider });

            await blockMonitor.start();
            expect(blockMonitor.staleCheckInterval).not.toBeNull();

            await blockMonitor.stop();
            expect(blockMonitor.staleCheckInterval).toBeNull();
        });

        test('should trigger reconnect on WebSocket error event', async () => {
            // Restore WS provider
            mockRPCManager.getWsProvider.mockReturnValue({ provider: mockProvider });

            const reconnectSpy = jest.spyOn(blockMonitor, 'handleReconnect').mockResolvedValue();

            await blockMonitor.start();

            // Find the error handler that was registered
            const errorHandler = mockProvider.on.mock.calls.find(call => call[0] === 'error');
            expect(errorHandler).toBeDefined();

            // Simulate an error event
            if (errorHandler) {
                errorHandler[1](new Error('WebSocket disconnected'));
            }

            expect(reconnectSpy).toHaveBeenCalled();
            reconnectSpy.mockRestore();
        });
    });
});
