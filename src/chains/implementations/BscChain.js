import BaseChain from '../BaseChain.js';
import RPCManager from '../../utils/rpcManager.js';
import BlockMonitor from '../../monitoring/blockMonitor.js';
import PriceFetcher from '../../data/priceFetcher.js';
import CacheManager from '../../data/cacheManager.js';
import ArbitrageDetector from '../../analysis/arbitrageDetector.js';
import TriangularDetector from '../../analysis/triangularDetector.js';
import ExecutionManager from '../../execution/executionManager.js';
import log from '../../utils/logger.js';

/**
 * BSC Chain Implementation
 *
 * Implements the BaseChain abstract class for Binance Smart Chain.
 * This is the primary chain and uses the existing singleton modules
 * for backward compatibility.
 *
 * For new chains, we would create new instances instead of using singletons.
 */
export default class BscChain extends BaseChain {
    constructor(config) {
        super(config);
        this.logger = log;
    }

    /**
     * Initialize all BSC components
     * Uses existing singleton instances for backward compatibility
     */
    async initialize() {
        this.log('info', 'Initializing BSC chain components...');

        try {
            // Use existing singleton instances
            // In the future, these would be created as new instances per chain
            this.rpcManager = RPCManager;
            this.blockMonitor = BlockMonitor;
            this.priceFetcher = PriceFetcher;
            this.cache = CacheManager;
            this.arbitrageDetector = ArbitrageDetector;
            this.triangularDetector = TriangularDetector;
            this.executionManager = ExecutionManager;

            // Set up event handlers
            this.setupEventHandlers();

            // Initialize execution manager if enabled
            if (this.config.execution?.enabled) {
                await this.executionManager.initialize();
                this.log('info', 'Execution manager initialized', {
                    mode: this.executionManager.mode,
                });
            }

            this.log('info', 'BSC chain initialized successfully', {
                dexes: this.getEnabledDexes().length,
                tokens: Object.keys(this.config.tokens || {}).length,
                baseTokens: (this.config.baseTokens || []).length,
            });

        } catch (error) {
            this.log('error', 'Failed to initialize BSC chain', { error: error.message });
            throw error;
        }
    }

    /**
     * Start monitoring BSC
     */
    async start() {
        if (this.isRunning) {
            this.log('warn', 'BSC chain is already running');
            return;
        }

        this.log('info', 'Starting BSC chain monitoring...');

        try {
            // Start block monitoring
            await this.blockMonitor.start();

            this.isRunning = true;
            this.log('info', 'BSC chain monitoring started');

        } catch (error) {
            this.log('error', 'Failed to start BSC chain', { error: error.message });
            throw error;
        }
    }

    /**
     * Stop monitoring BSC
     */
    async stop() {
        if (!this.isRunning) {
            return;
        }

        this.log('info', 'Stopping BSC chain monitoring...');
        this.isRunning = false;

        try {
            // Stop block monitor
            await this.blockMonitor.stop();

            // Cleanup
            await this.cleanup();

            this.log('info', 'BSC chain stopped');

        } catch (error) {
            this.log('error', 'Error stopping BSC chain', { error: error.message });
        }
    }

    /**
     * Handle new block - BSC specific implementation
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
            // Update cache
            this.cache.currentBlockNumber = blockNumber;
            this.cache.invalidateOlderThan(blockNumber);

            // Fetch all prices
            const prices = await this.priceFetcher.fetchAllPrices(blockNumber);

            if (Object.keys(prices).length === 0) {
                this.log('debug', 'No prices fetched for this block');
                return [];
            }

            // Detect opportunities (async to handle dynamic gas)
            const opportunities = await this.arbitrageDetector.detectOpportunities(
                prices,
                blockNumber
            );

            // Add chain context
            const enrichedOpportunities = opportunities.map(opp => ({
                ...opp,
                chainId: this.chainId,
                chainName: this.name,
            }));

            // Emit opportunities
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
            this.log('error', `Error processing block ${blockNumber}`, {
                error: error.message,
                stack: error.stack,
            });
            this.emit('error', { chainId: this.chainId, error, blockNumber });
            return [];
        } finally {
            this.processingBlock = false;
        }
    }

    /**
     * Get BSC-specific gas price
     * BSC uses a simple gas model (not EIP-1559)
     */
    async getGasPrice() {
        return await this.rpcManager.getGasPrice();
    }

    /**
     * Estimate gas cost in USD for BSC
     * @param {BigInt} gasPrice - Gas price in wei
     * @param {number} gasLimit - Estimated gas limit
     * @returns {number} Gas cost in USD
     */
    estimateGasCostUSD(gasPrice, gasLimit = 350000) {
        const bnbPrice = this.config.nativeToken?.priceUSD || 600;
        const gasCostBNB = (BigInt(gasLimit) * gasPrice);
        const gasCostBNBFloat = Number(gasCostBNB) / 1e18;
        return gasCostBNBFloat * bnbPrice;
    }

    /**
     * Get chain status
     */
    getStatus() {
        return {
            ...super.getStatus(),
            executionEnabled: this.config.execution?.enabled || false,
            executionMode: this.executionManager?.mode || 'detection-only',
            triangularEnabled: this.config.triangular?.enabled !== false,
        };
    }
}
