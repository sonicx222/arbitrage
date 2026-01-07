import BaseChain from '../BaseChain.js';
import log from '../../utils/logger.js';

/**
 * Optimism Chain Implementation
 *
 * Extends BaseChain for Optimism-specific behavior.
 * Optimistic rollup L2 with fast finality (~2 seconds) and low gas costs.
 * Velodrome is the dominant DEX.
 */
export default class OptimismChain extends BaseChain {
    constructor(config) {
        super(config);
        this.logger = log;
    }

    /**
     * Initialize Optimism chain components
     */
    async initialize() {
        this.log('info', 'Initializing Optimism chain components...');

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

            this.log('info', 'Optimism chain initialized successfully', {
                dexes: this.getEnabledDexes().length,
                tokens: Object.keys(this.config.tokens || {}).length,
            });

        } catch (error) {
            this.log('error', 'Failed to initialize Optimism chain', { error: error.message });
            throw error;
        }
    }

    /**
     * Start monitoring Optimism
     */
    async start() {
        if (this.isRunning) {
            this.log('warn', 'Optimism chain is already running');
            return;
        }

        this.log('info', 'Starting Optimism chain monitoring...');

        try {
            await this.blockMonitor.start();
            this.isRunning = true;
            this.log('info', 'Optimism chain monitoring started');
        } catch (error) {
            this.log('error', 'Failed to start Optimism chain', { error: error.message });
            throw error;
        }
    }

    /**
     * Stop monitoring Optimism
     */
    async stop() {
        if (!this.isRunning) {
            return;
        }

        this.log('info', 'Stopping Optimism chain monitoring...');
        this.isRunning = false;

        try {
            await this.blockMonitor.stop();
            await this.cleanup();
            this.log('info', 'Optimism chain stopped');
        } catch (error) {
            this.log('error', 'Error stopping Optimism chain', { error: error.message });
        }
    }

    /**
     * Estimate gas cost in USD for Optimism
     * L2 gas costs are very low
     */
    estimateGasCostUSD(gasPrice, gasLimit = 400000) {
        const ethPrice = this.config.nativeToken?.priceUSD || 3500;
        const gasCostETH = (BigInt(gasLimit) * gasPrice);
        const gasCostETHFloat = Number(gasCostETH) / 1e18;
        return gasCostETHFloat * ethPrice;
    }
}
