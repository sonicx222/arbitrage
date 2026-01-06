import { parentPort, workerData } from 'worker_threads';
import { MessageType, createMessage } from './workerMessages.js';

/**
 * ChainWorker - Worker thread for monitoring a single blockchain
 *
 * Each worker thread handles:
 * - Block monitoring for one chain
 * - Price fetching
 * - Arbitrage detection
 * - Sending opportunities back to main thread
 *
 * This isolates each chain's processing, so one chain's issues
 * don't affect other chains.
 */
class ChainWorker {
    constructor() {
        this.chain = null;
        this.chainId = null;
        this.config = null;
        this.isInitialized = false;
        this.isRunning = false;
        this.heartbeatTimer = null;
    }

    /**
     * Initialize the worker with chain configuration
     */
    async initialize() {
        const { chainId, config } = workerData;

        this.chainId = chainId;
        this.config = config;

        try {
            // Dynamically import chain factory and create chain instance
            const { default: chainFactory } = await import('../chains/ChainFactory.js');

            this.chain = await chainFactory.create(chainId, config);

            // Set up event handlers
            this.setupChainEventHandlers();

            // Initialize chain components
            await this.chain.initialize();

            this.isInitialized = true;
            this.sendMessage(MessageType.INITIALIZED, { chainId });

        } catch (error) {
            this.sendMessage(MessageType.ERROR, {
                chainId,
                error: error.message,
                stack: error.stack,
            });
        }
    }

    /**
     * Set up event handlers for chain events
     */
    setupChainEventHandlers() {
        if (!this.chain) return;

        // Forward opportunities to main thread
        this.chain.on('opportunities', (data) => {
            this.sendMessage(MessageType.OPPORTUNITIES, data);
        });

        // Forward errors
        this.chain.on('error', (data) => {
            this.sendMessage(MessageType.ERROR, data);
        });
    }

    /**
     * Start monitoring
     */
    async start() {
        if (!this.isInitialized) {
            this.sendMessage(MessageType.ERROR, {
                chainId: this.chainId,
                error: 'Worker not initialized',
            });
            return;
        }

        if (this.isRunning) {
            return;
        }

        try {
            await this.chain.start();
            this.isRunning = true;

            // Start heartbeat
            this.startHeartbeat();

            this.sendMessage(MessageType.STARTED, { chainId: this.chainId });

        } catch (error) {
            this.sendMessage(MessageType.ERROR, {
                chainId: this.chainId,
                error: error.message,
                stack: error.stack,
            });
        }
    }

    /**
     * Stop monitoring
     */
    async stop() {
        this.isRunning = false;

        // Stop heartbeat
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }

        if (this.chain) {
            try {
                await this.chain.stop();
            } catch (error) {
                // Log but don't throw
                console.error('Error stopping chain:', error);
            }
        }

        this.sendMessage(MessageType.STOPPED, { chainId: this.chainId });
    }

    /**
     * Start heartbeat to let coordinator know we're alive
     */
    startHeartbeat() {
        this.heartbeatTimer = setInterval(() => {
            if (this.isRunning) {
                this.sendMessage(MessageType.HEARTBEAT, {
                    chainId: this.chainId,
                    status: this.chain?.getStatus?.() || {},
                });
            }
        }, 5000);
        // Unref to not block process exit
        this.heartbeatTimer.unref();
    }

    /**
     * Send a message to the main thread
     * @param {string} type - Message type
     * @param {Object} data - Message data
     */
    sendMessage(type, data = {}) {
        parentPort.postMessage(createMessage(type, data));
    }

    /**
     * Handle messages from the main thread
     * @param {Object} message - Message object
     */
    handleMessage(message) {
        const { type, data } = message;

        switch (type) {
            case MessageType.START:
                this.start();
                break;

            case MessageType.STOP:
                this.stop();
                break;

            case MessageType.GET_STATUS:
                this.sendMessage(MessageType.STATUS, {
                    chainId: this.chainId,
                    isRunning: this.isRunning,
                    isInitialized: this.isInitialized,
                    chainStatus: this.chain?.getStatus?.() || null,
                });
                break;

            case MessageType.EXECUTE:
                if (this.chain?.executionManager) {
                    this.chain.executionManager.execute(data.opportunity)
                        .then(result => {
                            this.sendMessage(MessageType.EXECUTION_RESULT, {
                                chainId: this.chainId,
                                result,
                            });
                        })
                        .catch(error => {
                            this.sendMessage(MessageType.ERROR, {
                                chainId: this.chainId,
                                error: error.message,
                            });
                        });
                }
                break;

            case MessageType.UPDATE_CONFIG:
                // Update configuration at runtime
                if (data.config && this.chain) {
                    Object.assign(this.chain.config, data.config);
                    this.sendMessage(MessageType.CONFIG_UPDATED, { chainId: this.chainId });
                }
                break;

            default:
                console.warn(`Unknown message type: ${type}`);
        }
    }
}

// Worker entry point
const worker = new ChainWorker();

// Listen for messages from main thread
parentPort.on('message', (message) => {
    worker.handleMessage(message);
});

// Initialize on startup
worker.initialize();

// Handle uncaught errors
process.on('uncaughtException', (error) => {
    console.error('Uncaught exception in worker:', error);
    worker.sendMessage(MessageType.ERROR, {
        chainId: worker.chainId,
        error: error.message,
        stack: error.stack,
        fatal: true,
    });
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection in worker:', reason);
    worker.sendMessage(MessageType.ERROR, {
        chainId: worker.chainId,
        error: reason?.message || String(reason),
        fatal: false,
    });
});
