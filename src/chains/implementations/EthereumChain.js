import BaseChain from '../BaseChain.js';
import log from '../../utils/logger.js';

/**
 * Ethereum Mainnet Chain Implementation
 *
 * Extends BaseChain for Ethereum-specific behavior.
 * Uses EIP-1559 gas model.
 *
 * FIX v3.3: Creates fresh instances of RPC Manager, Block Monitor, etc.
 * with chain-specific configuration for proper multi-chain support.
 */
export default class EthereumChain extends BaseChain {
    constructor(config) {
        super(config);
        this.logger = log;
    }

    /**
     * Initialize Ethereum chain components
     * FIX v3.3: Creates fresh instances (not singletons) for proper chain isolation
     */
    async initialize() {
        this.log('info', 'Initializing Ethereum chain components...');

        try {
            // FIX v3.3: Import CLASSES (not singletons) for chain-specific instances
            const { RPCManager } = await import('../../utils/rpcManager.js');
            const { BlockMonitor } = await import('../../monitoring/blockMonitor.js');
            const { default: PriceFetcherClass } = await import('../../data/priceFetcher.js');
            const { default: CacheManagerClass } = await import('../../data/cacheManager.js');
            const { default: ArbitrageDetectorClass } = await import('../../analysis/arbitrageDetector.js');

            // FIX v3.3: Create NEW instances with Ethereum config instead of BSC singletons
            this.rpcManager = new RPCManager(this.config);
            this.blockMonitor = new BlockMonitor(this.rpcManager, this.config.name);

            // These still use singletons for now (need further refactoring)
            this.priceFetcher = PriceFetcherClass;
            this.cache = CacheManagerClass;
            this.arbitrageDetector = ArbitrageDetectorClass;

            // Set up event handlers
            this.setupEventHandlers();

            this.log('info', 'Ethereum chain initialized successfully', {
                dexes: this.getEnabledDexes().length,
                tokens: Object.keys(this.config.tokens || {}).length,
            });

        } catch (error) {
            this.log('error', 'Failed to initialize Ethereum chain', { error: error.message });
            throw error;
        }
    }

    /**
     * Start monitoring Ethereum
     */
    async start() {
        if (this.isRunning) {
            this.log('warn', 'Ethereum chain is already running');
            return;
        }

        this.log('info', 'Starting Ethereum chain monitoring...');

        try {
            await this.blockMonitor.start();
            this.isRunning = true;
            this.log('info', 'Ethereum chain monitoring started');
        } catch (error) {
            this.log('error', 'Failed to start Ethereum chain', { error: error.message });
            throw error;
        }
    }

    /**
     * Stop monitoring Ethereum
     */
    async stop() {
        if (!this.isRunning) {
            return;
        }

        this.log('info', 'Stopping Ethereum chain monitoring...');
        this.isRunning = false;

        try {
            await this.blockMonitor.stop();
            await this.cleanup();
            this.log('info', 'Ethereum chain stopped');
        } catch (error) {
            this.log('error', 'Error stopping Ethereum chain', { error: error.message });
        }
    }

    /**
     * Get Ethereum gas price (EIP-1559 aware)
     */
    async getGasPrice() {
        return await this.rpcManager.getGasPrice();
    }

    /**
     * Estimate gas cost in USD for Ethereum
     */
    estimateGasCostUSD(gasPrice, gasLimit = 400000) {
        const ethPrice = this.config.nativeToken?.priceUSD || 3500;
        const gasCostETH = (BigInt(gasLimit) * gasPrice);
        const gasCostETHFloat = Number(gasCostETH) / 1e18;
        return gasCostETHFloat * ethPrice;
    }
}
