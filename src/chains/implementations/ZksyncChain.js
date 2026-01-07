import BaseChain from '../BaseChain.js';
import log from '../../utils/logger.js';

/**
 * zkSync Era Chain Implementation
 *
 * Extends BaseChain for zkSync-specific behavior.
 * zkSync Era is a ZK-rollup L2 with:
 * - Very low gas costs
 * - ETH as native token
 * - Different contract addresses than mainnet
 * - Growing DeFi ecosystem with SyncSwap as dominant DEX
 */
export default class ZksyncChain extends BaseChain {
    constructor(config) {
        super(config);
        this.logger = log;
    }

    /**
     * Initialize zkSync chain components
     */
    async initialize() {
        this.log('info', 'Initializing zkSync Era chain components...');

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

            this.log('info', 'zkSync Era chain initialized successfully', {
                dexes: this.getEnabledDexes().length,
                tokens: Object.keys(this.config.tokens || {}).length,
            });

        } catch (error) {
            this.log('error', 'Failed to initialize zkSync Era chain', { error: error.message });
            throw error;
        }
    }

    /**
     * Start monitoring zkSync Era
     */
    async start() {
        if (this.isRunning) {
            this.log('warn', 'zkSync Era chain is already running');
            return;
        }

        this.log('info', 'Starting zkSync Era chain monitoring...');

        try {
            await this.blockMonitor.start();
            this.isRunning = true;
            this.log('info', 'zkSync Era chain monitoring started');
        } catch (error) {
            this.log('error', 'Failed to start zkSync Era chain', { error: error.message });
            throw error;
        }
    }

    /**
     * Stop monitoring zkSync Era
     */
    async stop() {
        if (!this.isRunning) {
            return;
        }

        this.log('info', 'Stopping zkSync Era chain monitoring...');
        this.isRunning = false;

        try {
            await this.blockMonitor.stop();
            await this.cleanup();
            this.log('info', 'zkSync Era chain stopped');
        } catch (error) {
            this.log('error', 'Error stopping zkSync Era chain', { error: error.message });
        }
    }

    /**
     * Estimate gas cost in USD for zkSync Era
     * Gas costs are very low on zkSync (ZK-rollup efficiency)
     */
    estimateGasCostUSD(gasPrice, gasLimit = 500000) {
        const ethPrice = this.config.nativeToken?.priceUSD || 3500;
        const gasCostETH = (BigInt(gasLimit) * gasPrice);
        const gasCostETHFloat = Number(gasCostETH) / 1e18;
        return gasCostETHFloat * ethPrice;
    }
}
