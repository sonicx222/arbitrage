import BaseChain from '../BaseChain.js';
import log from '../../utils/logger.js';

/**
 * Avalanche C-Chain Implementation
 *
 * Extends BaseChain for Avalanche-specific behavior.
 * Fast finality (~2 seconds) and EVM-compatible.
 */
export default class AvalancheChain extends BaseChain {
    constructor(config) {
        super(config);
        this.logger = log;
    }

    /**
     * Initialize Avalanche chain components
     * FIX v3.3: Create NEW instances with chain-specific config instead of using singletons
     */
    async initialize() {
        this.log('info', 'Initializing Avalanche chain components...');

        try {
            // FIX v3.3: Import CLASSES (not singletons) for proper chain isolation
            const { RPCManager } = await import('../../utils/rpcManager.js');
            const { BlockMonitor } = await import('../../monitoring/blockMonitor.js');
            // These still use singletons for now (require deeper refactoring)
            const { default: PriceFetcherClass } = await import('../../data/priceFetcher.js');
            const { default: CacheManagerClass } = await import('../../data/cacheManager.js');
            const { default: ArbitrageDetectorClass } = await import('../../analysis/arbitrageDetector.js');

            // FIX v3.3: Create NEW instances with Avalanche-specific config
            this.rpcManager = new RPCManager(this.config);
            this.blockMonitor = new BlockMonitor(this.rpcManager, this.config.name);

            // These still use singletons (future improvement: per-chain instances)
            this.priceFetcher = PriceFetcherClass;
            this.cache = CacheManagerClass;
            this.arbitrageDetector = ArbitrageDetectorClass;

            this.setupEventHandlers();

            this.log('info', 'Avalanche chain initialized successfully', {
                dexes: this.getEnabledDexes().length,
                tokens: Object.keys(this.config.tokens || {}).length,
            });

        } catch (error) {
            this.log('error', 'Failed to initialize Avalanche chain', { error: error.message });
            throw error;
        }
    }

    /**
     * Start monitoring Avalanche
     */
    async start() {
        if (this.isRunning) {
            this.log('warn', 'Avalanche chain is already running');
            return;
        }

        this.log('info', 'Starting Avalanche chain monitoring...');

        try {
            await this.blockMonitor.start();
            this.isRunning = true;
            this.log('info', 'Avalanche chain monitoring started');
        } catch (error) {
            this.log('error', 'Failed to start Avalanche chain', { error: error.message });
            throw error;
        }
    }

    /**
     * Stop monitoring Avalanche
     */
    async stop() {
        if (!this.isRunning) {
            return;
        }

        this.log('info', 'Stopping Avalanche chain monitoring...');
        this.isRunning = false;

        try {
            await this.blockMonitor.stop();
            await this.cleanup();
            this.log('info', 'Avalanche chain stopped');
        } catch (error) {
            this.log('error', 'Error stopping Avalanche chain', { error: error.message });
        }
    }

    /**
     * Estimate gas cost in USD for Avalanche
     */
    estimateGasCostUSD(gasPrice, gasLimit = 300000) {
        const avaxPrice = this.config.nativeToken?.priceUSD || 35;
        const gasCostAVAX = (BigInt(gasLimit) * gasPrice);
        const gasCostAVAXFloat = Number(gasCostAVAX) / 1e18;
        return gasCostAVAXFloat * avaxPrice;
    }
}
