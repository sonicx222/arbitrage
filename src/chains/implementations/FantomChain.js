import BaseChain from '../BaseChain.js';
import log from '../../utils/logger.js';

/**
 * Fantom Opera Chain Implementation
 *
 * Extends BaseChain for Fantom-specific behavior.
 * High-performance L1 with very fast finality (~1 second).
 * SpookySwap is the dominant DEX.
 */
export default class FantomChain extends BaseChain {
    constructor(config) {
        super(config);
        this.logger = log;
    }

    /**
     * Initialize Fantom chain components
     */
    async initialize() {
        this.log('info', 'Initializing Fantom chain components...');

        try {
            const { default: RPCManagerClass } = await import('../../utils/rpcManager.js');
            const { default: BlockMonitorClass } = await import('../../monitoring/blockMonitor.js');
            const { default: PriceFetcherClass } = await import('../../data/priceFetcher.js');
            const { default: CacheManagerClass } = await import('../../data/cacheManager.js');
            const { default: ArbitrageDetectorClass } = await import('../../analysis/arbitrageDetector.js');

            this.rpcManager = RPCManagerClass;
            this.blockMonitor = BlockMonitorClass;
            this.priceFetcher = PriceFetcherClass;
            this.cache = CacheManagerClass;
            this.arbitrageDetector = ArbitrageDetectorClass;

            this.setupEventHandlers();

            this.log('info', 'Fantom chain initialized successfully', {
                dexes: this.getEnabledDexes().length,
                tokens: Object.keys(this.config.tokens || {}).length,
            });

        } catch (error) {
            this.log('error', 'Failed to initialize Fantom chain', { error: error.message });
            throw error;
        }
    }

    /**
     * Start monitoring Fantom
     */
    async start() {
        if (this.isRunning) {
            this.log('warn', 'Fantom chain is already running');
            return;
        }

        this.log('info', 'Starting Fantom chain monitoring...');

        try {
            await this.blockMonitor.start();
            this.isRunning = true;
            this.log('info', 'Fantom chain monitoring started');
        } catch (error) {
            this.log('error', 'Failed to start Fantom chain', { error: error.message });
            throw error;
        }
    }

    /**
     * Stop monitoring Fantom
     */
    async stop() {
        if (!this.isRunning) {
            return;
        }

        this.log('info', 'Stopping Fantom chain monitoring...');
        this.isRunning = false;

        try {
            await this.blockMonitor.stop();
            await this.cleanup();
            this.log('info', 'Fantom chain stopped');
        } catch (error) {
            this.log('error', 'Error stopping Fantom chain', { error: error.message });
        }
    }

    /**
     * Estimate gas cost in USD for Fantom
     * Gas costs are low but not as low as L2s
     */
    estimateGasCostUSD(gasPrice, gasLimit = 350000) {
        const ftmPrice = this.config.nativeToken?.priceUSD || 0.5;
        const gasCostFTM = (BigInt(gasLimit) * gasPrice);
        const gasCostFTMFloat = Number(gasCostFTM) / 1e18;
        return gasCostFTMFloat * ftmPrice;
    }
}
