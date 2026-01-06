import WorkerCoordinator from '../../src/workers/WorkerCoordinator.js';
import { MessageType } from '../../src/workers/workerMessages.js';

describe('WorkerCoordinator', () => {
    let coordinator;

    beforeEach(() => {
        coordinator = new WorkerCoordinator({
            maxWorkers: 3,
            workerTimeout: 30000,
            restartDelay: 1000,
        });
    });

    afterEach(async () => {
        // Ensure coordinator is stopped after each test
        if (coordinator.isRunning) {
            await coordinator.stopAll();
        }
        coordinator.removeAllListeners();
    });

    describe('constructor', () => {
        it('should initialize with default config', () => {
            const defaultCoordinator = new WorkerCoordinator();
            expect(defaultCoordinator.maxWorkers).toBe(6);
            expect(defaultCoordinator.workerTimeout).toBe(30000);
            expect(defaultCoordinator.restartDelay).toBe(5000);
        });

        it('should initialize with custom config', () => {
            expect(coordinator.maxWorkers).toBe(3);
            expect(coordinator.workerTimeout).toBe(30000);
            expect(coordinator.restartDelay).toBe(1000);
        });

        it('should initialize empty worker maps', () => {
            expect(coordinator.workers.size).toBe(0);
            expect(coordinator.workerStatus.size).toBe(0);
            expect(coordinator.workerConfigs.size).toBe(0);
        });

        it('should initialize statistics', () => {
            expect(coordinator.stats.totalOpportunities).toBe(0);
            expect(coordinator.stats.workerRestarts).toBe(0);
            expect(coordinator.stats.errors).toBe(0);
        });
    });

    describe('updateWorkerStatus', () => {
        it('should update status for a worker', () => {
            coordinator.updateWorkerStatus(56, 'running', { lastHeartbeat: Date.now() });

            const status = coordinator.workerStatus.get(56);
            expect(status.status).toBe('running');
            expect(status.lastHeartbeat).toBeDefined();
            expect(status.lastUpdate).toBeDefined();
        });

        it('should merge with existing status', () => {
            coordinator.updateWorkerStatus(56, 'initializing');
            coordinator.updateWorkerStatus(56, 'running', { extra: 'data' });

            const status = coordinator.workerStatus.get(56);
            expect(status.status).toBe('running');
            expect(status.extra).toBe('data');
        });
    });

    describe('handleOpportunities', () => {
        it('should update statistics', () => {
            const data = {
                opportunities: [{ id: 1 }, { id: 2 }],
                blockNumber: 12345,
                processingTime: 100,
            };

            coordinator.handleOpportunities(56, data);

            expect(coordinator.stats.totalOpportunities).toBe(2);
            expect(coordinator.stats.opportunitiesByChain[56]).toBe(2);
        });

        it('should emit opportunities event', (done) => {
            coordinator.on('opportunities', (eventData) => {
                expect(eventData.chainId).toBe(56);
                expect(eventData.opportunities.length).toBe(2);
                done();
            });

            coordinator.handleOpportunities(56, {
                opportunities: [{ id: 1 }, { id: 2 }],
                blockNumber: 12345,
                processingTime: 100,
            });
        });

        it('should handle empty opportunities array', () => {
            const initialTotal = coordinator.stats.totalOpportunities;

            coordinator.handleOpportunities(56, {
                opportunities: [],
                blockNumber: 12345,
            });

            expect(coordinator.stats.totalOpportunities).toBe(initialTotal);
        });
    });

    describe('handleWorkerMessage', () => {
        it('should update status on INITIALIZED message', () => {
            coordinator.handleWorkerMessage(56, {
                type: MessageType.INITIALIZED,
                data: { chainId: 56 },
            });

            expect(coordinator.workerStatus.get(56).status).toBe('initialized');
        });

        it('should update status on STARTED message', () => {
            coordinator.handleWorkerMessage(56, {
                type: MessageType.STARTED,
                data: { chainId: 56 },
            });

            expect(coordinator.workerStatus.get(56).status).toBe('running');
        });

        it('should update status on STOPPED message', () => {
            coordinator.handleWorkerMessage(56, {
                type: MessageType.STOPPED,
                data: { chainId: 56 },
            });

            expect(coordinator.workerStatus.get(56).status).toBe('stopped');
        });

        it('should process OPPORTUNITIES message', () => {
            coordinator.handleWorkerMessage(56, {
                type: MessageType.OPPORTUNITIES,
                data: {
                    opportunities: [{ id: 1 }],
                    blockNumber: 12345,
                },
            });

            expect(coordinator.stats.totalOpportunities).toBe(1);
        });

        it('should update heartbeat on HEARTBEAT message', () => {
            const beforeTime = Date.now();
            coordinator.handleWorkerMessage(56, {
                type: MessageType.HEARTBEAT,
                data: { chainId: 56 },
            });

            const status = coordinator.workerStatus.get(56);
            expect(status.lastHeartbeat).toBeGreaterThanOrEqual(beforeTime);
        });

        it('should emit workerError on ERROR message', (done) => {
            coordinator.on('workerError', (data) => {
                expect(data.chainId).toBe(56);
                expect(data.error).toBe('test error');
                done();
            });

            coordinator.handleWorkerMessage(56, {
                type: MessageType.ERROR,
                data: { error: 'test error' },
            });
        });

        it('should increment error count on ERROR message', () => {
            const initialErrors = coordinator.stats.errors;

            coordinator.handleWorkerMessage(56, {
                type: MessageType.ERROR,
                data: { error: 'test error' },
            });

            expect(coordinator.stats.errors).toBe(initialErrors + 1);
        });
    });

    describe('sendToWorker', () => {
        it('should return false if worker not found', () => {
            const result = coordinator.sendToWorker(999, MessageType.START);
            expect(result).toBe(false);
        });
    });

    describe('broadcastToWorkers', () => {
        it('should call postMessage for each worker', () => {
            // Create mock workers with postMessage function
            const mockWorker1 = { postMessage: function() { this.called = true; }, called: false };
            const mockWorker2 = { postMessage: function() { this.called = true; }, called: false };

            coordinator.workers.set(56, mockWorker1);
            coordinator.workers.set(1, mockWorker2);

            coordinator.broadcastToWorkers(MessageType.GET_STATUS);

            expect(mockWorker1.called).toBe(true);
            expect(mockWorker2.called).toBe(true);
        });
    });

    describe('getStatus', () => {
        it('should return comprehensive status', () => {
            coordinator.updateWorkerStatus(56, 'running');
            coordinator.workerConfigs.set(56, { name: 'BSC' });

            const status = coordinator.getStatus();

            expect(status.isRunning).toBe(false);
            expect(status.workerCount).toBe(0);
            expect(status.workers).toBeDefined();
            expect(status.stats).toBeDefined();
        });

        it('should include worker configs', () => {
            coordinator.workerConfigs.set(56, { name: 'BSC' });
            coordinator.updateWorkerStatus(56, 'running');

            const status = coordinator.getStatus();

            expect(status.workers[56].name).toBe('BSC');
        });
    });

    describe('getStats', () => {
        it('should return copy of statistics', () => {
            coordinator.stats.totalOpportunities = 10;

            const stats = coordinator.getStats();

            expect(stats.totalOpportunities).toBe(10);
            // Verify it's a copy
            stats.totalOpportunities = 99;
            expect(coordinator.stats.totalOpportunities).toBe(10);
        });
    });

    describe('event emissions', () => {
        it('should emit workerInitialized on initialization', (done) => {
            coordinator.on('workerInitialized', (data) => {
                expect(data.chainId).toBe(56);
                done();
            });

            coordinator.handleWorkerMessage(56, {
                type: MessageType.INITIALIZED,
                data: { chainId: 56 },
            });
        });

        it('should emit workerStarted on start', (done) => {
            coordinator.on('workerStarted', (data) => {
                expect(data.chainId).toBe(56);
                done();
            });

            coordinator.handleWorkerMessage(56, {
                type: MessageType.STARTED,
                data: { chainId: 56 },
            });
        });

        it('should emit workerStopped on stop', (done) => {
            coordinator.on('workerStopped', (data) => {
                expect(data.chainId).toBe(56);
                done();
            });

            coordinator.handleWorkerMessage(56, {
                type: MessageType.STOPPED,
                data: { chainId: 56 },
            });
        });

        it('should emit workerStatus on STATUS message', (done) => {
            coordinator.on('workerStatus', (data) => {
                expect(data.chainId).toBe(56);
                expect(data.status).toEqual({ isRunning: true });
                done();
            });

            coordinator.handleWorkerMessage(56, {
                type: MessageType.STATUS,
                data: { isRunning: true },
            });
        });
    });
});
