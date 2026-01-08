import BaseChain from '../BaseChain.js';
import log from '../../utils/logger.js';

/**
 * Arbitrum One Chain Implementation
 *
 * Extends BaseChain for Arbitrum-specific behavior.
 * L2 chain with fast block times and lower gas costs.
 */
export default class ArbitrumChain extends BaseChain {
    constructor(config) {
        super(config);
        this.logger = log;
    }

    /**
     * Initialize Arbitrum chain components
     * FIX v3.3: Creates fresh instances with chain-specific config
     */
    async initialize() {
        this.log('info', 'Initializing Arbitrum chain components...');

        try {
            // FIX v3.3: Import CLASSES (not singletons) for chain-specific instances
            const { RPCManager } = await import('../../utils/rpcManager.js');
            const { BlockMonitor } = await import('../../monitoring/blockMonitor.js');
            const { default: PriceFetcherClass } = await import('../../data/priceFetcher.js');
            const { default: CacheManagerClass } = await import('../../data/cacheManager.js');
            const { default: ArbitrageDetectorClass } = await import('../../analysis/arbitrageDetector.js');

            // FIX v3.3: Create NEW instances with Arbitrum config
            this.rpcManager = new RPCManager(this.config);
            this.blockMonitor = new BlockMonitor(this.rpcManager, this.config.name);
            this.priceFetcher = PriceFetcherClass;
            this.cache = CacheManagerClass;
            this.arbitrageDetector = ArbitrageDetectorClass;

            this.setupEventHandlers();

            this.log('info', 'Arbitrum chain initialized successfully', {
                dexes: this.getEnabledDexes().length,
                tokens: Object.keys(this.config.tokens || {}).length,
            });

        } catch (error) {
            this.log('error', 'Failed to initialize Arbitrum chain', { error: error.message });
            throw error;
        }
    }

    /**
     * Start monitoring Arbitrum
     */
    async start() {
        if (this.isRunning) {
            this.log('warn', 'Arbitrum chain is already running');
            return;
        }

        this.log('info', 'Starting Arbitrum chain monitoring...');

        try {
            await this.blockMonitor.start();
            this.isRunning = true;
            this.log('info', 'Arbitrum chain monitoring started');
        } catch (error) {
            this.log('error', 'Failed to start Arbitrum chain', { error: error.message });
            throw error;
        }
    }

    /**
     * Stop monitoring Arbitrum
     */
    async stop() {
        if (!this.isRunning) {
            return;
        }

        this.log('info', 'Stopping Arbitrum chain monitoring...');
        this.isRunning = false;

        try {
            await this.blockMonitor.stop();
            await this.cleanup();
            this.log('info', 'Arbitrum chain stopped');
        } catch (error) {
            this.log('error', 'Error stopping Arbitrum chain', { error: error.message });
        }
    }

    /**
     * Estimate gas cost in USD for Arbitrum
     * Arbitrum uses ETH for gas but with much lower costs
     */
    estimateGasCostUSD(gasPrice, gasLimit = 300000) {
        const ethPrice = this.config.nativeToken?.priceUSD || 3500;
        const gasCostETH = (BigInt(gasLimit) * gasPrice);
        const gasCostETHFloat = Number(gasCostETH) / 1e18;
        return gasCostETHFloat * ethPrice;
    }
}
