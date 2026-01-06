import BaseChain from '../BaseChain.js';
import log from '../../utils/logger.js';

/**
 * Base (Coinbase L2) Chain Implementation
 *
 * Note: File is named BaseChainImpl.js to avoid conflict with BaseChain.js abstract class.
 * Extends BaseChain for Base-specific behavior.
 * L2 chain optimized for low-cost transactions.
 */
export default class BaseChainImpl extends BaseChain {
    constructor(config) {
        super(config);
        this.logger = log;
    }

    /**
     * Initialize Base chain components
     */
    async initialize() {
        this.log('info', 'Initializing Base chain components...');

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

            this.log('info', 'Base chain initialized successfully', {
                dexes: this.getEnabledDexes().length,
                tokens: Object.keys(this.config.tokens || {}).length,
            });

        } catch (error) {
            this.log('error', 'Failed to initialize Base chain', { error: error.message });
            throw error;
        }
    }

    /**
     * Start monitoring Base
     */
    async start() {
        if (this.isRunning) {
            this.log('warn', 'Base chain is already running');
            return;
        }

        this.log('info', 'Starting Base chain monitoring...');

        try {
            await this.blockMonitor.start();
            this.isRunning = true;
            this.log('info', 'Base chain monitoring started');
        } catch (error) {
            this.log('error', 'Failed to start Base chain', { error: error.message });
            throw error;
        }
    }

    /**
     * Stop monitoring Base
     */
    async stop() {
        if (!this.isRunning) {
            return;
        }

        this.log('info', 'Stopping Base chain monitoring...');
        this.isRunning = false;

        try {
            await this.blockMonitor.stop();
            await this.cleanup();
            this.log('info', 'Base chain stopped');
        } catch (error) {
            this.log('error', 'Error stopping Base chain', { error: error.message });
        }
    }

    /**
     * Estimate gas cost in USD for Base
     * Base uses ETH for gas with very low costs
     */
    estimateGasCostUSD(gasPrice, gasLimit = 250000) {
        const ethPrice = this.config.nativeToken?.priceUSD || 3500;
        const gasCostETH = (BigInt(gasLimit) * gasPrice);
        const gasCostETHFloat = Number(gasCostETH) / 1e18;
        return gasCostETHFloat * ethPrice;
    }
}
