import { EventEmitter } from 'events';

/**
 * Abstract base class for blockchain implementations
 * Each chain extends this with chain-specific logic
 *
 * This enables multi-chain arbitrage detection with:
 * - Isolated RPC connections per chain
 * - Chain-specific DEX configurations
 * - Parallel monitoring via worker threads
 */
export default class BaseChain extends EventEmitter {
    constructor(config) {
        super();

        if (new.target === BaseChain) {
            throw new Error('BaseChain is abstract and cannot be instantiated directly');
        }

        this.config = config;
        this.chainId = config.chainId;
        this.name = config.name;
        this.isRunning = false;
        this.processingBlock = false;

        // These will be initialized by subclasses or factory
        this.rpcManager = null;
        this.blockMonitor = null;
        this.priceFetcher = null;
        this.arbitrageDetector = null;
        this.triangularDetector = null;
        this.executionManager = null;
        this.cache = null;
        this.logger = null;
    }

    /**
     * Initialize all chain components
     * Must be implemented by subclasses
     * @abstract
     */
    async initialize() {
        throw new Error('initialize() must be implemented by subclass');
    }

    /**
     * Start monitoring this chain
     * @abstract
     */
    async start() {
        throw new Error('start() must be implemented by subclass');
    }

    /**
     * Stop monitoring
     * @abstract
     */
    async stop() {
        throw new Error('stop() must be implemented by subclass');
    }

    /**
     * Get chain-specific DEX configurations
     * @returns {Object} DEX configuration object
     */
    getDexConfig() {
        return this.config.dexes || {};
    }

    /**
     * Get enabled DEXes for this chain
     * @returns {Array} Array of enabled DEX names
     */
    getEnabledDexes() {
        return Object.entries(this.config.dexes || {})
            .filter(([, dex]) => dex.enabled)
            .map(([name]) => name);
    }

    /**
     * Get token configuration for this chain
     * @returns {Object} Token configuration
     */
    getTokens() {
        return this.config.tokens || {};
    }

    /**
     * Get base tokens for arbitrage paths
     * @returns {Array} Array of base token symbols
     */
    getBaseTokens() {
        return this.config.baseTokens || [];
    }

    /**
     * Get chain-specific gas price
     * Should be overridden for chains with different gas models (EIP-1559, etc.)
     * @abstract
     */
    async getGasPrice() {
        if (!this.rpcManager) {
            throw new Error('RPC Manager not initialized');
        }
        return await this.rpcManager.getGasPrice();
    }

    /**
     * Estimate gas cost for a transaction in USD
     * @param {BigInt} gasPrice - Gas price in wei
     * @param {number} gasLimit - Estimated gas limit
     * @returns {number} Gas cost in USD
     */
    estimateGasCostUSD(gasPrice, gasLimit = 350000) {
        const nativeTokenPrice = this.config.nativeToken?.priceUSD || 0;
        const gasCostNative = (BigInt(gasLimit) * gasPrice);
        const gasCostNativeFloat = Number(gasCostNative) / 1e18;
        return gasCostNativeFloat * nativeTokenPrice;
    }

    /**
     * Handle new block - default implementation
     * Can be overridden for chain-specific behavior
     * @param {Object} blockData - Block information
     */
    async handleNewBlock(blockData) {
        const { blockNumber } = blockData;

        // Prevent concurrent block processing
        if (this.processingBlock) {
            this.log('debug', `Skipping block ${blockNumber}, still processing previous`);
            return [];
        }

        this.processingBlock = true;
        const startTime = Date.now();

        try {
            // Invalidate stale cache
            if (this.cache) {
                this.cache.invalidateOlderThan(blockNumber);
            }

            // Fetch prices
            const prices = await this.priceFetcher.fetchAllPrices(blockNumber);

            if (Object.keys(prices).length === 0) {
                this.log('debug', `No prices fetched for block ${blockNumber}`);
                return [];
            }

            // Detect opportunities
            const opportunities = await this.arbitrageDetector.detectOpportunities(
                prices,
                blockNumber
            );

            // Add chain context to opportunities
            const enrichedOpportunities = opportunities.map(opp => ({
                ...opp,
                chainId: this.chainId,
                chainName: this.name,
            }));

            // Emit opportunities for cross-chain coordinator
            if (enrichedOpportunities.length > 0) {
                this.emit('opportunities', {
                    chainId: this.chainId,
                    chainName: this.name,
                    blockNumber,
                    opportunities: enrichedOpportunities,
                    processingTime: Date.now() - startTime,
                });

                this.log('info', `Found ${enrichedOpportunities.length} opportunities in block ${blockNumber}`);
            }

            return enrichedOpportunities;

        } catch (error) {
            this.log('error', `Error processing block ${blockNumber}`, { error: error.message });
            this.emit('error', { chainId: this.chainId, error, blockNumber });
            return [];
        } finally {
            this.processingBlock = false;
        }
    }

    /**
     * Set up event handlers for block monitoring
     */
    setupEventHandlers() {
        if (!this.blockMonitor) {
            throw new Error('Block monitor not initialized');
        }

        this.blockMonitor.on('newBlock', async (blockData) => {
            await this.handleNewBlock(blockData);
        });

        this.blockMonitor.on('error', (error) => {
            this.log('error', 'Block monitor error', { error: error.message });
            this.emit('error', { chainId: this.chainId, error });
        });

        if (this.rpcManager) {
            this.rpcManager.on('endpointUnhealthy', (endpoint) => {
                this.log('warn', `RPC endpoint unhealthy: ${endpoint}`);
            });
        }
    }

    /**
     * Get current chain status
     * @returns {Object} Status information
     */
    getStatus() {
        return {
            chainId: this.chainId,
            name: this.name,
            isRunning: this.isRunning,
            processingBlock: this.processingBlock,
            blockMonitor: this.blockMonitor?.getStatus?.() || null,
            rpc: this.rpcManager?.getStats?.() || null,
            cache: this.cache?.getStats?.() || null,
        };
    }

    /**
     * Log with chain context
     * @param {string} level - Log level
     * @param {string} message - Log message
     * @param {Object} meta - Additional metadata
     */
    log(level, message, meta = {}) {
        const logger = this.logger || console;
        const enrichedMeta = {
            ...meta,
            chainId: this.chainId,
            chainName: this.name,
        };

        if (logger[level]) {
            logger[level](`[${this.name}] ${message}`, enrichedMeta);
        } else {
            console.log(`[${level.toUpperCase()}] [${this.name}] ${message}`, enrichedMeta);
        }
    }

    /**
     * Cleanup resources
     */
    async cleanup() {
        this.log('info', 'Cleaning up chain resources...');

        if (this.blockMonitor) {
            await this.blockMonitor.stop?.();
        }

        if (this.rpcManager) {
            await this.rpcManager.cleanup?.();
        }

        this.removeAllListeners();
        this.isRunning = false;
    }
}
