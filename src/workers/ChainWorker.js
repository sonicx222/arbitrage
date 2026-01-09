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

        // Forward errors - ensure Error objects are serialized properly
        this.chain.on('error', (data) => {
            // Error objects have non-enumerable properties that get lost in postMessage
            // Convert to plain object with extracted properties
            const errorData = data instanceof Error
                ? {
                    chainId: this.chainId,
                    error: data.message,
                    stack: data.stack,
                    code: data.code,
                }
                : {
                    chainId: this.chainId,
                    ...data,
                    // Also extract error/message if data contains an Error object
                    error: data?.error instanceof Error ? data.error.message : (data?.error || data?.message),
                    stack: data?.error instanceof Error ? data.error.stack : data?.stack,
                };
            this.sendMessage(MessageType.ERROR, errorData);
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
                // Use .catch() to handle async errors since handleMessage is sync
                this.start().catch(error => {
                    this.sendMessage(MessageType.ERROR, {
                        chainId: this.chainId,
                        error: `Start failed: ${error.message}`,
                        stack: error.stack,
                    });
                });
                break;

            case MessageType.STOP:
                // Use .catch() to handle async errors
                this.stop().catch(error => {
                    console.error('Stop error:', error);
                    // Still send stopped message even on error
                    this.sendMessage(MessageType.STOPPED, { chainId: this.chainId });
                });
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

// FIX v3.6: Improved uncaught error handling for 24/7 uptime
// These handlers catch errors that slip through and attempt to recover
// rather than letting the worker crash

// Track error counts for rate limiting restarts
let uncaughtErrorCount = 0;
let lastErrorResetTime = Date.now();
const ERROR_RESET_INTERVAL = 60000; // Reset error count every minute
const MAX_ERRORS_PER_INTERVAL = 10; // Max errors before giving up

process.on('uncaughtException', (error) => {
    // Reset error count if enough time has passed
    if (Date.now() - lastErrorResetTime > ERROR_RESET_INTERVAL) {
        uncaughtErrorCount = 0;
        lastErrorResetTime = Date.now();
    }

    uncaughtErrorCount++;
    const errorMessage = error?.message || String(error);

    // Log the error
    console.error(`[Worker ${worker.chainId}] Uncaught exception (${uncaughtErrorCount}/${MAX_ERRORS_PER_INTERVAL}):`, errorMessage);

    // Notify coordinator
    try {
        worker.sendMessage(MessageType.ERROR, {
            chainId: worker.chainId,
            error: errorMessage,
            stack: error?.stack,
            fatal: uncaughtErrorCount >= MAX_ERRORS_PER_INTERVAL,
            errorCount: uncaughtErrorCount,
        });
    } catch (sendError) {
        console.error('Failed to send error message:', sendError);
    }

    // FIX v3.11: Comprehensive list of recoverable network/WebSocket errors
    const isRecoverable = [
        'WebSocket was closed before',      // Cleanup race condition
        'Unexpected server response',       // WebSocket handshake 301/404
        'Connection timeout',               // Connection timeout
        'ECONNRESET',                        // Network reset
        'ETIMEDOUT',                         // Network timeout
        'ENOTFOUND',                         // DNS failure
        'ECONNREFUSED',                      // Connection refused
        'socket hang up',                    // Connection dropped
        'EPIPE',                             // Broken pipe
        'EHOSTUNREACH',                      // Host unreachable
        'EAI_AGAIN',                         // DNS temporary failure
        'certificate has expired',          // SSL cert issue (transient)
    ].some(pattern => errorMessage.includes(pattern));

    if (isRecoverable && uncaughtErrorCount < MAX_ERRORS_PER_INTERVAL) {
        console.log(`[Worker ${worker.chainId}] Recoverable error detected, continuing operation`);
        // Don't exit - let the resilient WebSocket handle reconnection
        return;
    }

    // If too many errors, let the coordinator handle worker restart
    if (uncaughtErrorCount >= MAX_ERRORS_PER_INTERVAL) {
        console.error(`[Worker ${worker.chainId}] Too many errors, allowing coordinator to restart worker`);
        // Exit with code 1 to trigger coordinator restart
        process.exit(1);
    }
});

process.on('unhandledRejection', (reason, promise) => {
    const errorMessage = reason?.message || String(reason);
    console.error(`[Worker ${worker.chainId}] Unhandled rejection:`, errorMessage);

    // FIX v3.6: Don't crash on unhandled rejections - they're often from
    // background operations that don't need to block the worker
    try {
        worker.sendMessage(MessageType.WARNING, {
            chainId: worker.chainId,
            warning: `Unhandled rejection: ${errorMessage}`,
            stack: reason?.stack,
        });
    } catch (sendError) {
        console.error('Failed to send warning message:', sendError);
    }

    // FIX v3.6: Check if this is a known issue that should be logged but not crash
    const isKnownIssue = [
        'WebSocket was closed before the connection was established',
        'Connection timeout',
        'provider.destroy is not a function',
    ].some(pattern => errorMessage.includes(pattern));

    if (isKnownIssue) {
        console.log(`[Worker ${worker.chainId}] Known issue detected, continuing operation`);
    }
});
