import { EventEmitter } from 'events';
import rpcManager from '../utils/rpcManager.js';
import log from '../utils/logger.js';
import config from '../config.js';

/**
 * Block Monitor using WebSocket subscription for real-time block updates
 *
 * Now integrates with ResilientWebSocketManager through rpcManager:
 * - Subscribes to rpcManager's forwarded 'block' events
 * - Automatically benefits from connection resilience and failover
 * - Falls back to HTTP polling only when all WS endpoints are down
 */
class BlockMonitor extends EventEmitter {
    constructor() {
        super();

        this.isRunning = false;
        this.mode = 'disconnected'; // 'websocket', 'polling', 'disconnected'
        this.lastBlockNumber = 0;
        this.lastBlockTime = Date.now();
        this.pollingInterval = null; // For HTTP polling fallback
        this.staleCheckInterval = null; // For stale block detection

        // Bound handlers for event subscription
        this._boundHandleBlock = this._handleBlockFromManager.bind(this);
        this._boundHandleAllDown = this._handleAllWsDown.bind(this);
        this._boundHandleRecovery = this._handleWsRecovery.bind(this);

        log.info('Block Monitor initialized (resilient mode)');
    }

    /**
     * Start monitoring blocks
     * Uses rpcManager's resilient WebSocket events with HTTP polling fallback
     */
    async start() {
        if (this.isRunning) {
            log.warn('Block Monitor already running');
            return;
        }

        try {
            // Ensure WebSocket manager is ready
            const wsReady = await rpcManager.ensureWsReady();

            if (wsReady) {
                // Subscribe to rpcManager's forwarded block events
                rpcManager.on('block', this._boundHandleBlock);
                rpcManager.on('wsAllDown', this._boundHandleAllDown);
                rpcManager.on('endpointRecovered', this._boundHandleRecovery);

                // Get initial block number
                const initialBlock = await rpcManager.withRetry(async (provider) => {
                    return await provider.getBlockNumber();
                });

                this.lastBlockNumber = initialBlock;
                this.lastBlockTime = Date.now();
                this.mode = 'websocket';
                this.isRunning = true;

                // Start stale block detection as safety net
                this._setupStaleBlockDetection();

                log.info('✅ Block Monitor started (resilient WebSocket mode)', {
                    initialBlock,
                });
            } else {
                // WebSocket not available, use HTTP polling
                log.warn('WebSocket not available, using HTTP polling mode');
                await this.startHttpPolling();
                this.isRunning = true;
            }

        } catch (error) {
            log.error('Failed to start Block Monitor', { error: error.message });
            throw error;
        }
    }

    /**
     * Start HTTP polling mode as fallback
     */
    async startHttpPolling() {
        // Stop any existing polling
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
        }

        log.info('Starting HTTP polling mode (polling every 3 seconds)');

        // Get initial block
        const initialBlock = await rpcManager.withRetry(async (provider) => {
            return await provider.getBlockNumber();
        });

        this.lastBlockNumber = initialBlock;
        this.lastBlockTime = Date.now();
        this.mode = 'polling';

        // Poll for new blocks (unref to not block process exit)
        this.pollingInterval = setInterval(async () => {
            try {
                const currentBlock = await rpcManager.withRetry(async (provider) => {
                    return await provider.getBlockNumber();
                });

                // Only emit if this is a new block
                if (currentBlock > this.lastBlockNumber) {
                    this.handleNewBlock(currentBlock);
                }
            } catch (error) {
                log.error('Error polling for blocks', { error: error.message });
            }
        }, 3000); // Poll every 3 seconds (average BSC block time)
        this.pollingInterval.unref();
    }

    /**
     * Handle block event from rpcManager (forwarded from ResilientWebSocketManager)
     * @private
     */
    _handleBlockFromManager(blockNumber) {
        if (!this.isRunning || this.mode !== 'websocket') return;
        this.handleNewBlock(blockNumber);
    }

    /**
     * Handle all WebSocket endpoints down event
     * @private
     */
    async _handleAllWsDown() {
        if (!this.isRunning) return;

        log.warn('All WebSocket endpoints down, falling back to HTTP polling');

        // Switch to HTTP polling
        try {
            await this.startHttpPolling();
            this.emit('fallbackToPolling');
        } catch (error) {
            log.error('Failed to start HTTP polling fallback', { error: error.message });
            this.emit('error', new Error('All connection methods failed'));
        }
    }

    /**
     * Handle WebSocket recovery - switch back from polling to WebSocket
     * @private
     */
    _handleWsRecovery() {
        if (!this.isRunning || this.mode !== 'polling') return;

        log.info('WebSocket recovered, switching back from HTTP polling');

        // Stop polling
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }

        this.mode = 'websocket';
        this.emit('recoveredToWebSocket');
    }


    /**
     * Set up detection for stale blocks (no updates in 30+ seconds)
     * This is a safety net - the resilient WebSocket manager should handle most cases
     * @private
     */
    _setupStaleBlockDetection() {
        // Clear any existing stale check interval
        if (this.staleCheckInterval) {
            clearInterval(this.staleCheckInterval);
        }

        // Check every 15 seconds if we've received blocks recently
        this.staleCheckInterval = setInterval(async () => {
            if (!this.isRunning || this.mode !== 'websocket') return;

            const timeSinceLastBlock = Date.now() - this.lastBlockTime;
            const staleThreshold = 30000; // 30 seconds (BSC blocks are ~3s)

            if (timeSinceLastBlock > staleThreshold) {
                log.warn(`No new blocks for ${Math.round(timeSinceLastBlock / 1000)}s, connection may be stale`, {
                    lastBlock: this.lastBlockNumber,
                    lastBlockTime: new Date(this.lastBlockTime).toISOString(),
                    mode: this.mode,
                });

                // Fall back to HTTP polling as safety net
                // The ResilientWebSocketManager should recover, but this ensures we don't miss blocks
                await this._handleAllWsDown();
            }
        }, 15000);

        // Don't prevent process exit
        this.staleCheckInterval.unref();
    }

    /**
     * Handle new block event
     */
    handleNewBlock(blockNumber) {
        const now = Date.now();
        const timeSinceLastBlock = now - this.lastBlockTime;

        // Log block info
        log.debug(`📦 New block: ${blockNumber}`, {
            timeSinceLastBlock: `${(timeSinceLastBlock / 1000).toFixed(1)}s`,
            mode: this.mode,
        });

        // Emit event for listeners
        this.emit('newBlock', {
            blockNumber,
            timestamp: now,
            timeSinceLastBlock,
        });

        // Update tracking
        this.lastBlockNumber = blockNumber;
        this.lastBlockTime = now;
    }


    /**
     * Stop monitoring blocks
     */
    async stop() {
        if (!this.isRunning) {
            return;
        }

        this.isRunning = false;
        const previousMode = this.mode;
        this.mode = 'disconnected';

        try {
            // Stop stale block detection
            if (this.staleCheckInterval) {
                clearInterval(this.staleCheckInterval);
                this.staleCheckInterval = null;
            }

            // Stop polling if active
            if (this.pollingInterval) {
                clearInterval(this.pollingInterval);
                this.pollingInterval = null;
            }

            // Unsubscribe from rpcManager events
            rpcManager.off('block', this._boundHandleBlock);
            rpcManager.off('wsAllDown', this._boundHandleAllDown);
            rpcManager.off('endpointRecovered', this._boundHandleRecovery);

            log.info('Block Monitor stopped', { previousMode });
        } catch (error) {
            log.error('Error stopping Block Monitor', { error: error.message });
        }
    }

    /**
     * Get current block number
     */
    getCurrentBlock() {
        return this.lastBlockNumber;
    }

    /**
     * Get monitor status
     */
    getStatus() {
        return {
            isRunning: this.isRunning,
            mode: this.mode,
            lastBlockNumber: this.lastBlockNumber,
            lastBlockTime: this.lastBlockTime,
            timeSinceLastBlock: Date.now() - this.lastBlockTime,
        };
    }
}

// Export singleton instance
const blockMonitor = new BlockMonitor();
export default blockMonitor;
