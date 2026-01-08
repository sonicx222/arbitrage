import BaseChain from '../BaseChain.js';
import log from '../../utils/logger.js';

/**
 * Polygon (Matic) Mainnet Chain Implementation
 *
 * Extends BaseChain for Polygon-specific behavior.
 * Fast block times (~2 seconds) require efficient processing.
 */
export default class PolygonChain extends BaseChain {
    constructor(config) {
        super(config);
        this.logger = log;
    }

    /**
     * Initialize Polygon chain components
     * FIX v3.3: Creates fresh instances with chain-specific config
     */
    async initialize() {
        this.log('info', 'Initializing Polygon chain components...');

        try {
            // FIX v3.3: Import CLASSES (not singletons) for chain-specific instances
            const { RPCManager } = await import('../../utils/rpcManager.js');
            const { BlockMonitor } = await import('../../monitoring/blockMonitor.js');
            const { default: PriceFetcherClass } = await import('../../data/priceFetcher.js');
            const { default: CacheManagerClass } = await import('../../data/cacheManager.js');
            const { default: ArbitrageDetectorClass } = await import('../../analysis/arbitrageDetector.js');

            // FIX v3.3: Create NEW instances with Polygon config
            this.rpcManager = new RPCManager(this.config);
            this.blockMonitor = new BlockMonitor(this.rpcManager, this.config.name);
            this.priceFetcher = PriceFetcherClass;
            this.cache = CacheManagerClass;
            this.arbitrageDetector = ArbitrageDetectorClass;

            this.setupEventHandlers();

            this.log('info', 'Polygon chain initialized successfully', {
                dexes: this.getEnabledDexes().length,
                tokens: Object.keys(this.config.tokens || {}).length,
            });

        } catch (error) {
            this.log('error', 'Failed to initialize Polygon chain', { error: error.message });
            throw error;
        }
    }

    /**
     * Start monitoring Polygon
     */
    async start() {
        if (this.isRunning) {
            this.log('warn', 'Polygon chain is already running');
            return;
        }

        this.log('info', 'Starting Polygon chain monitoring...');

        try {
            await this.blockMonitor.start();
            this.isRunning = true;
            this.log('info', 'Polygon chain monitoring started');
        } catch (error) {
            this.log('error', 'Failed to start Polygon chain', { error: error.message });
            throw error;
        }
    }

    /**
     * Stop monitoring Polygon
     */
    async stop() {
        if (!this.isRunning) {
            return;
        }

        this.log('info', 'Stopping Polygon chain monitoring...');
        this.isRunning = false;

        try {
            await this.blockMonitor.stop();
            await this.cleanup();
            this.log('info', 'Polygon chain stopped');
        } catch (error) {
            this.log('error', 'Error stopping Polygon chain', { error: error.message });
        }
    }

    /**
     * Estimate gas cost in USD for Polygon
     */
    estimateGasCostUSD(gasPrice, gasLimit = 350000) {
        const maticPrice = this.config.nativeToken?.priceUSD || 0.5;
        const gasCostMATIC = (BigInt(gasLimit) * gasPrice);
        const gasCostMATICFloat = Number(gasCostMATIC) / 1e18;
        return gasCostMATICFloat * maticPrice;
    }
}
