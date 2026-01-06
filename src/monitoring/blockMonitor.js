import { EventEmitter } from 'events';
import rpcManager from '../utils/rpcManager.js';
import log from '../utils/logger.js';
import config from '../config.js';

/**
 * Block Monitor using WebSocket subscription for real-time block updates
 */
class BlockMonitor extends EventEmitter {
    constructor() {
        super();

        this.provider = null;
        this.isRunning = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 1000; // Start with 1 second
        this.lastBlockNumber = 0;
        this.lastBlockTime = Date.now();
        this.pollingInterval = null; // For HTTP polling fallback

        log.info('Block Monitor initialized');
    }

    /**
   * Start monitoring blocks
   */
    async start() {
        if (this.isRunning) {
            log.warn('Block Monitor already running');
            return;
        }

        try {
            // Try WebSocket first
            try {
                await this.connect();
                this.isRunning = true;
                this.reconnectAttempts = 0;
                log.info('✅ Block Monitor started successfully (WebSocket mode)');
                return;
            } catch (wsError) {
                log.warn('WebSocket connection failed, falling back to HTTP polling', { error: wsError.message });
                // Fall through to HTTP polling
            }

            // Fallback to HTTP polling
            await this.startHttpPolling();
            this.isRunning = true;
            log.info('✅ Block Monitor started successfully (HTTP polling mode)');

        } catch (error) {
            log.error('Failed to start Block Monitor', { error: error.message });
            throw error;
        }
    }

    /**
     * Start HTTP polling mode as fallback
     */
    async startHttpPolling() {
        log.info('Starting HTTP polling mode (polling every 3 seconds)');

        // Get initial block
        const initialBlock = await rpcManager.withRetry(async (provider) => {
            return await provider.getBlockNumber();
        });

        this.lastBlockNumber = initialBlock;
        this.lastBlockTime = Date.now();

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
     * Connect to WebSocket provider
     */
    async connect() {
        const wsData = rpcManager.getWsProvider();
        if (!wsData) throw new Error('No WebSocket providers available');

        this.provider = wsData.provider;

        // Set up listeners
        this.provider.on('block', (n) => this.handleNewBlock(n));
        this.provider.on('error', (e) => log.debug('WS error', { error: e.message }));

        // Initialize last block with 5s timeout
        let timeoutId;
        try {
            this.lastBlockNumber = await Promise.race([
                this.provider.getBlockNumber(),
                new Promise((_, reject) => {
                    timeoutId = setTimeout(() => reject(new Error('getBlockNumber timeout')), 5000);
                })
            ]);
            log.ws(`Connected to WS, current block: ${this.lastBlockNumber}`);
        } finally {
            if (timeoutId) clearTimeout(timeoutId);
        }
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

        // Reset reconnect attempts on successful block
        this.reconnectAttempts = 0;
    }

    /**
     * Handle reconnection with exponential backoff
     */
    async handleReconnect() {
        if (!this.isRunning) {
            return; // Don't reconnect if stopped
        }

        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            log.error(`Max reconnection attempts (${this.maxReconnectAttempts}) reached`);
            this.emit('error', new Error('Max reconnection attempts reached'));
            return;
        }

        this.reconnectAttempts++;
        const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

        log.ws(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

        await this.sleep(delay);

        try {
            // Clean up old provider
            if (this.provider) {
                this.provider.removeAllListeners();
            }

            // Reconnect
            await this.connect();
            log.ws('✅ Reconnected successfully');

        } catch (error) {
            log.error('Reconnection failed', { error: error.message });
            await this.handleReconnect(); // Try again
        }
    }

    /**
     * Stop monitoring blocks
     */
    async stop() {
        if (!this.isRunning) {
            return;
        }

        this.isRunning = false;

        try {
            // Stop polling if active
            if (this.pollingInterval) {
                clearInterval(this.pollingInterval);
                this.pollingInterval = null;
            }

            // Close WebSocket if active
            if (this.provider) {
                this.provider.removeAllListeners();
                await this.provider.destroy();
            }

            log.info('Block Monitor stopped');
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
            lastBlockNumber: this.lastBlockNumber,
            lastBlockTime: this.lastBlockTime,
            timeSinceLastBlock: Date.now() - this.lastBlockTime,
            reconnectAttempts: this.reconnectAttempts,
        };
    }

    /**
     * Sleep utility
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Export singleton instance
const blockMonitor = new BlockMonitor();
export default blockMonitor;
