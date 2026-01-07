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
    ensureWsReady: jest.fn().mockResolvedValue(true),
    on: jest.fn(),
    off: jest.fn(),
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
        blockMonitor.mode = 'disconnected';
        blockMonitor.pollingInterval = null;
        // Restore default mock behavior
        mockRPCManager.ensureWsReady.mockResolvedValue(true);
        mockRPCManager.getWsProvider.mockReturnValue({ provider: mockProvider });
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
        blockMonitor.mode = 'disconnected';
        blockMonitor.removeAllListeners();
        await blockMonitor.stop();
    });

    describe('Startup (Resilient Mode)', () => {
        test('should start in resilient WebSocket mode when WS is ready', async () => {
            await blockMonitor.start();

            expect(mockRPCManager.ensureWsReady).toHaveBeenCalled();
            expect(mockRPCManager.on).toHaveBeenCalledWith('block', expect.any(Function));
            expect(mockRPCManager.on).toHaveBeenCalledWith('wsAllDown', expect.any(Function));
            expect(mockRPCManager.on).toHaveBeenCalledWith('endpointRecovered', expect.any(Function));
            expect(blockMonitor.isRunning).toBe(true);
            expect(blockMonitor.mode).toBe('websocket');
        });

        test('should fallback to HTTP polling if WebSocket not ready', async () => {
            mockRPCManager.ensureWsReady.mockResolvedValue(false);

            // Spy on fallback method
            const pollingSpy = jest.spyOn(blockMonitor, 'startHttpPolling');

            await blockMonitor.start();

            expect(pollingSpy).toHaveBeenCalled();
            expect(blockMonitor.isRunning).toBe(true);
            expect(blockMonitor.mode).toBe('polling');

            pollingSpy.mockRestore();
        });

        test('should subscribe to rpcManager events on start', async () => {
            await blockMonitor.start();

            // Check that event subscriptions were made
            expect(mockRPCManager.on).toHaveBeenCalledTimes(3);
            expect(mockRPCManager.on).toHaveBeenCalledWith('block', blockMonitor._boundHandleBlock);
            expect(mockRPCManager.on).toHaveBeenCalledWith('wsAllDown', blockMonitor._boundHandleAllDown);
            expect(mockRPCManager.on).toHaveBeenCalledWith('endpointRecovered', blockMonitor._boundHandleRecovery);
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

        test('should update lastBlockNumber and lastBlockTime on new block', () => {
            const blockNum = 12345;
            const beforeTime = Date.now();

            blockMonitor.handleNewBlock(blockNum);

            expect(blockMonitor.lastBlockNumber).toBe(blockNum);
            expect(blockMonitor.lastBlockTime).toBeGreaterThanOrEqual(beforeTime);
        });
    });

    describe('Fallback and Recovery', () => {
        test('should fallback to HTTP polling when all WS endpoints down', async () => {
            blockMonitor.isRunning = true;
            blockMonitor.mode = 'websocket';

            // Mock startHttpPolling to set mode to polling (as the real implementation does)
            const pollingSpy = jest.spyOn(blockMonitor, 'startHttpPolling').mockImplementation(async () => {
                blockMonitor.mode = 'polling';
            });

            const fallbackPromise = new Promise(resolve => {
                blockMonitor.once('fallbackToPolling', () => {
                    resolve();
                });
            });

            // Trigger the all-down handler
            await blockMonitor._handleAllWsDown();
            await fallbackPromise;

            expect(pollingSpy).toHaveBeenCalled();
            expect(blockMonitor.mode).toBe('polling');

            pollingSpy.mockRestore();
        });

        test('should emit error if HTTP polling fallback also fails', async () => {
            blockMonitor.isRunning = true;
            blockMonitor.mode = 'websocket';

            const pollingSpy = jest.spyOn(blockMonitor, 'startHttpPolling')
                .mockRejectedValue(new Error('HTTP polling failed'));

            const errorPromise = new Promise(resolve => {
                blockMonitor.once('error', (err) => {
                    expect(err.message).toBe('All connection methods failed');
                    resolve();
                });
            });

            await blockMonitor._handleAllWsDown();
            await errorPromise;

            pollingSpy.mockRestore();
        });

        test('should switch back to WebSocket mode on recovery', async () => {
            blockMonitor.isRunning = true;
            blockMonitor.mode = 'polling';
            blockMonitor.pollingInterval = setInterval(() => {}, 1000);

            const recoveryPromise = new Promise(resolve => {
                blockMonitor.once('recoveredToWebSocket', () => {
                    resolve();
                });
            });

            blockMonitor._handleWsRecovery();
            await recoveryPromise;

            expect(blockMonitor.mode).toBe('websocket');
            expect(blockMonitor.pollingInterval).toBeNull();
        });

        test('should not switch to WebSocket if not in polling mode', () => {
            blockMonitor.isRunning = true;
            blockMonitor.mode = 'websocket';

            let recovered = false;
            blockMonitor.once('recoveredToWebSocket', () => {
                recovered = true;
            });

            blockMonitor._handleWsRecovery();

            expect(recovered).toBe(false);
            expect(blockMonitor.mode).toBe('websocket');
        });
    });

    describe('Stale Block Detection (Safety Net)', () => {
        test('should have staleCheckInterval property initialized', () => {
            expect(blockMonitor).toHaveProperty('staleCheckInterval');
        });

        test('should set up stale block detection when starting in WebSocket mode', async () => {
            await blockMonitor.start();

            expect(blockMonitor.staleCheckInterval).not.toBeNull();
        });

        test('should clear stale check interval on stop', async () => {
            await blockMonitor.start();
            expect(blockMonitor.staleCheckInterval).not.toBeNull();

            await blockMonitor.stop();
            expect(blockMonitor.staleCheckInterval).toBeNull();
        });
    });

    describe('Stop', () => {
        test('should unsubscribe from rpcManager events on stop', async () => {
            await blockMonitor.start();
            await blockMonitor.stop();

            expect(mockRPCManager.off).toHaveBeenCalledWith('block', blockMonitor._boundHandleBlock);
            expect(mockRPCManager.off).toHaveBeenCalledWith('wsAllDown', blockMonitor._boundHandleAllDown);
            expect(mockRPCManager.off).toHaveBeenCalledWith('endpointRecovered', blockMonitor._boundHandleRecovery);
        });

        test('should clear polling interval on stop', async () => {
            mockRPCManager.ensureWsReady.mockResolvedValue(false);
            await blockMonitor.start();

            expect(blockMonitor.pollingInterval).not.toBeNull();

            await blockMonitor.stop();

            expect(blockMonitor.pollingInterval).toBeNull();
        });

        test('should set mode to disconnected on stop', async () => {
            await blockMonitor.start();
            expect(blockMonitor.mode).toBe('websocket');

            await blockMonitor.stop();
            expect(blockMonitor.mode).toBe('disconnected');
        });
    });

    describe('getStatus', () => {
        test('should return current mode in status', async () => {
            await blockMonitor.start();

            const status = blockMonitor.getStatus();

            expect(status.mode).toBe('websocket');
            expect(status.isRunning).toBe(true);
            expect(status).toHaveProperty('lastBlockNumber');
            expect(status).toHaveProperty('lastBlockTime');
            expect(status).toHaveProperty('timeSinceLastBlock');
        });

        test('should return polling mode when in HTTP polling', async () => {
            mockRPCManager.ensureWsReady.mockResolvedValue(false);
            await blockMonitor.start();

            const status = blockMonitor.getStatus();

            expect(status.mode).toBe('polling');
        });
    });
});
