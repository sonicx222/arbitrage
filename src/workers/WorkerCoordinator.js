import { Worker } from 'worker_threads';
import { EventEmitter } from 'events';
import path from 'path';
import { fileURLToPath } from 'url';
import { MessageType, createMessage } from './workerMessages.js';
import log from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * WorkerCoordinator - Manages worker threads for multi-chain monitoring
 *
 * Features:
 * - Spawns and manages worker threads for each enabled chain
 * - Handles worker lifecycle (start, stop, restart)
 * - Aggregates opportunities from all workers
 * - Error isolation - one worker failure doesn't affect others
 * - Automatic worker restart on crash
 */
export default class WorkerCoordinator extends EventEmitter {
    constructor(config = {}) {
        super();

        // Worker tracking
        this.workers = new Map(); // chainId -> Worker
        this.workerStatus = new Map(); // chainId -> { status, lastHeartbeat, errors }
        this.workerConfigs = new Map(); // chainId -> config

        // Configuration
        this.maxWorkers = config.maxWorkers || 6;
        this.workerTimeout = config.workerTimeout || 30000;
        this.restartDelay = config.restartDelay || 5000;
        this.heartbeatInterval = config.heartbeatInterval || 10000;

        // State
        this.isRunning = false;
        this.heartbeatTimer = null;

        // Statistics
        this.stats = {
            totalOpportunities: 0,
            opportunitiesByChain: {},
            workerRestarts: 0,
            errors: 0,
        };
    }

    /**
     * Spawn a worker thread for a specific chain
     * @param {number} chainId - Chain ID
     * @param {Object} chainConfig - Chain configuration
     * @returns {Worker} Worker instance
     */
    spawnWorker(chainId, chainConfig) {
        if (this.workers.has(chainId)) {
            log.warn(`Worker for chain ${chainId} already exists`);
            return this.workers.get(chainId);
        }

        const workerPath = path.resolve(__dirname, 'ChainWorker.js');

        const worker = new Worker(workerPath, {
            workerData: {
                chainId,
                config: chainConfig,
            },
        });

        // Handle messages from worker
        worker.on('message', (message) => {
            this.handleWorkerMessage(chainId, message);
        });

        // Handle worker errors
        worker.on('error', (error) => {
            log.error(`Worker ${chainId} error`, { error: error.message, stack: error.stack });
            this.updateWorkerStatus(chainId, 'error', { error: error.message });
            this.emit('workerError', { chainId, error });
            this.stats.errors++;

            // Restart worker if coordinator is still running
            if (this.isRunning) {
                this.scheduleWorkerRestart(chainId);
            }
        });

        // Handle worker exit
        worker.on('exit', (code) => {
            log.info(`Worker ${chainId} exited with code ${code}`);

            if (code !== 0 && this.isRunning) {
                log.warn(`Worker ${chainId} crashed, scheduling restart...`);
                this.scheduleWorkerRestart(chainId);
            }
        });

        // Store worker and config
        this.workers.set(chainId, worker);
        this.workerConfigs.set(chainId, chainConfig);
        // Initialize lastHeartbeat to prevent false "unresponsive" detection during restarts
        // (old status entries may have stale timestamps from previous worker instances)
        this.updateWorkerStatus(chainId, 'initializing', { lastHeartbeat: Date.now() });

        log.info(`Spawned worker for chain ${chainId} (${chainConfig.name})`);

        return worker;
    }

    /**
     * Handle messages received from workers
     * @param {number} chainId - Source chain ID
     * @param {Object} message - Message object
     */
    handleWorkerMessage(chainId, message) {
        const { type, data, meta } = message;

        switch (type) {
            case MessageType.INITIALIZED:
                this.updateWorkerStatus(chainId, 'initialized');
                log.info(`Worker ${chainId} initialized`);
                this.emit('workerInitialized', { chainId });
                break;

            case MessageType.STARTED:
                this.updateWorkerStatus(chainId, 'running');
                log.info(`Worker ${chainId} started monitoring`);
                this.emit('workerStarted', { chainId });
                break;

            case MessageType.STOPPED:
                this.updateWorkerStatus(chainId, 'stopped');
                log.info(`Worker ${chainId} stopped`);
                this.emit('workerStopped', { chainId });
                break;

            case MessageType.OPPORTUNITIES:
                this.handleOpportunities(chainId, data);
                break;

            case MessageType.HEARTBEAT:
                this.updateWorkerStatus(chainId, 'running', { lastHeartbeat: Date.now() });
                break;

            case MessageType.STATUS:
                this.emit('workerStatus', { chainId, status: data });
                break;

            case MessageType.ERROR:
                log.error(`Worker ${chainId} reported error`, data);
                this.stats.errors++;
                this.emit('workerError', { chainId, ...data });
                break;

            case MessageType.WARNING:
                log.warn(`Worker ${chainId} warning`, data);
                break;

            default:
                log.debug(`Unknown message type from worker ${chainId}: ${type}`);
        }
    }

    /**
     * Handle opportunities detected by a worker
     * @param {number} chainId - Source chain ID
     * @param {Object} data - Opportunities data
     */
    handleOpportunities(chainId, data) {
        const { opportunities, blockNumber, processingTime } = data;

        if (!opportunities || opportunities.length === 0) return;

        // Update statistics
        this.stats.totalOpportunities += opportunities.length;
        this.stats.opportunitiesByChain[chainId] =
            (this.stats.opportunitiesByChain[chainId] || 0) + opportunities.length;

        // Emit for cross-chain detector and alerting
        this.emit('opportunities', {
            chainId,
            blockNumber,
            opportunities,
            processingTime,
        });
    }

    /**
     * Update worker status
     * @param {number} chainId - Chain ID
     * @param {string} status - New status
     * @param {Object} extra - Additional data
     */
    updateWorkerStatus(chainId, status, extra = {}) {
        const current = this.workerStatus.get(chainId) || {};
        this.workerStatus.set(chainId, {
            ...current,
            status,
            lastUpdate: Date.now(),
            ...extra,
        });
    }

    /**
     * Schedule worker restart after delay
     * @param {number} chainId - Chain ID to restart
     */
    scheduleWorkerRestart(chainId) {
        const config = this.workerConfigs.get(chainId);
        if (!config) {
            log.error(`Cannot restart worker ${chainId}: config not found`);
            return;
        }

        setTimeout(async () => {
            if (!this.isRunning) return;

            log.info(`Restarting worker ${chainId}...`);

            // Terminate old worker if exists
            const oldWorker = this.workers.get(chainId);
            if (oldWorker) {
                try {
                    await oldWorker.terminate();
                } catch (e) {
                    // Ignore termination errors
                }
                this.workers.delete(chainId);
            }

            // Spawn new worker
            this.spawnWorker(chainId, config);
            this.stats.workerRestarts++;

            // Wait for initialization then start
            await this.waitForWorker(chainId, 'initialized', 15000);
            this.sendToWorker(chainId, MessageType.START);

        }, this.restartDelay);
    }

    /**
     * Start all workers for enabled chains
     * @param {Object} chainConfigs - Map of chainId -> config
     */
    async startAll(chainConfigs) {
        this.isRunning = true;

        // Spawn workers for all enabled chains
        const enabledChains = Object.entries(chainConfigs)
            .filter(([, config]) => config.enabled)
            .slice(0, this.maxWorkers);

        if (enabledChains.length === 0) {
            log.warn('No chains enabled for worker monitoring');
            return;
        }

        log.info(`Starting workers for ${enabledChains.length} chains...`);

        // Spawn all workers
        for (const [chainId, config] of enabledChains) {
            this.spawnWorker(parseInt(chainId), config);
        }

        // Wait for all workers to initialize
        await this.waitForAllWorkers('initialized', 30000);

        // Start all workers
        for (const chainId of this.workers.keys()) {
            this.sendToWorker(chainId, MessageType.START);
        }

        // Wait for all to start running
        await this.waitForAllWorkers('running', 10000);

        // Start heartbeat monitoring
        this.startHeartbeatMonitor();

        log.info(`All ${this.workers.size} workers started successfully`);
    }

    /**
     * Wait for a specific worker to reach a status
     * @param {number} chainId - Chain ID
     * @param {string} targetStatus - Target status
     * @param {number} timeout - Timeout in ms
     */
    async waitForWorker(chainId, targetStatus, timeout = 30000) {
        const startTime = Date.now();

        while (Date.now() - startTime < timeout) {
            const status = this.workerStatus.get(chainId);
            if (status?.status === targetStatus || status?.status === 'running') {
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        throw new Error(`Timeout waiting for worker ${chainId} to reach ${targetStatus}`);
    }

    /**
     * Wait for all workers to reach a specific status
     * @param {string} targetStatus - Target status
     * @param {number} timeout - Timeout in ms
     */
    async waitForAllWorkers(targetStatus, timeout = 30000) {
        const startTime = Date.now();

        while (Date.now() - startTime < timeout) {
            let allReady = true;

            for (const chainId of this.workers.keys()) {
                const status = this.workerStatus.get(chainId);
                if (status?.status !== targetStatus && status?.status !== 'running') {
                    allReady = false;
                    break;
                }
            }

            if (allReady) return;
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        // Log which workers didn't reach target status
        for (const [chainId, status] of this.workerStatus) {
            if (status?.status !== targetStatus && status?.status !== 'running') {
                log.warn(`Worker ${chainId} did not reach ${targetStatus}, current: ${status?.status}`);
            }
        }
    }

    /**
     * Send a message to a specific worker
     * @param {number} chainId - Target chain ID
     * @param {string} type - Message type
     * @param {Object} data - Message data
     */
    sendToWorker(chainId, type, data = {}) {
        const worker = this.workers.get(chainId);
        if (!worker) {
            log.warn(`Cannot send to worker ${chainId}: not found`);
            return false;
        }

        worker.postMessage(createMessage(type, data));
        return true;
    }

    /**
     * Broadcast a message to all workers
     * @param {string} type - Message type
     * @param {Object} data - Message data
     */
    broadcastToWorkers(type, data = {}) {
        for (const chainId of this.workers.keys()) {
            this.sendToWorker(chainId, type, data);
        }
    }

    /**
     * Start heartbeat monitoring to detect stalled workers
     */
    startHeartbeatMonitor() {
        this.heartbeatTimer = setInterval(() => {
            const now = Date.now();

            for (const [chainId, status] of this.workerStatus) {
                if (status.status !== 'running') continue;

                const lastHeartbeat = status.lastHeartbeat || status.lastUpdate;
                const timeSinceHeartbeat = now - lastHeartbeat;

                if (timeSinceHeartbeat > this.workerTimeout) {
                    log.warn(`Worker ${chainId} unresponsive (${timeSinceHeartbeat}ms since heartbeat)`);
                    this.scheduleWorkerRestart(chainId);
                }
            }
        }, this.heartbeatInterval);
        // Unref to not block process exit
        this.heartbeatTimer.unref();
    }

    /**
     * Stop all workers
     */
    async stopAll() {
        this.isRunning = false;

        // Stop heartbeat monitor
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }

        // Send stop message to all workers
        this.broadcastToWorkers(MessageType.STOP);

        // Wait briefly for graceful shutdown
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Terminate all workers
        const terminatePromises = [];
        for (const [chainId, worker] of this.workers) {
            terminatePromises.push(
                worker.terminate().catch(e => {
                    log.debug(`Error terminating worker ${chainId}:`, e.message);
                })
            );
        }

        await Promise.all(terminatePromises);

        this.workers.clear();
        this.workerStatus.clear();

        log.info('All workers stopped');
    }

    /**
     * Get status of all workers
     * @returns {Object} Worker status summary
     */
    getStatus() {
        const status = {};

        for (const [chainId, workerStatus] of this.workerStatus) {
            const config = this.workerConfigs.get(chainId);
            status[chainId] = {
                name: config?.name || `Chain ${chainId}`,
                ...workerStatus,
            };
        }

        return {
            isRunning: this.isRunning,
            workerCount: this.workers.size,
            workers: status,
            stats: this.stats,
        };
    }

    /**
     * Get statistics
     * @returns {Object} Statistics
     */
    getStats() {
        return { ...this.stats };
    }
}
