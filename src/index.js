import blockMonitor from './monitoring/blockMonitor.js';
import priceFetcher from './data/priceFetcher.js';
import arbitrageDetector from './analysis/arbitrageDetector.js';
import alertManager from './alerts/alertManager.js';
import performanceTracker from './monitoring/performanceTracker.js';
import cacheManager from './data/cacheManager.js';
import rpcManager from './utils/rpcManager.js';
import dashboard from './monitoring/dashboard.js';
import executionManager from './execution/executionManager.js';
import config from './config.js';
import log from './utils/logger.js';
import { formatChain, formatUSD, formatPercent } from './utils/logFormatter.js';

// Multi-chain imports
import WorkerCoordinator from './workers/WorkerCoordinator.js';
import CrossChainDetector from './analysis/CrossChainDetector.js';
import MultiHopDetector from './analysis/MultiHopDetector.js';
import MempoolMonitor from './analysis/MempoolMonitor.js';
import { chainConfigs, getEnabledChains, globalConfig } from './config/index.js';

/**
 * Main application orchestrator for Arbitrage Bot
 *
 * Supports two modes:
 * - Single-chain mode: Original BSC-only operation (backward compatible)
 * - Multi-chain mode: Parallel worker threads for multiple chains
 *
 * Mode is determined by:
 * 1. MULTI_CHAIN_MODE env var (explicit)
 * 2. Number of enabled chains in config (auto-detect)
 */
class ArbitrageBot {
    constructor() {
        this.isRunning = false;
        this.processingBlock = false;

        // Multi-chain components (initialized if multi-chain mode)
        this.workerCoordinator = null;
        this.crossChainDetector = null;
        this.multiHopDetector = null;
        this.mempoolMonitor = null;

        // Determine operating mode
        this.multiChainMode = this.determineMode();
    }

    /**
     * Determine whether to run in single-chain or multi-chain mode
     */
    determineMode() {
        // Explicit environment variable takes precedence
        if (process.env.MULTI_CHAIN_MODE !== undefined) {
            return process.env.MULTI_CHAIN_MODE === 'true';
        }

        // Auto-detect based on enabled chains
        try {
            const enabledChains = getEnabledChains();
            return Object.keys(enabledChains).length > 1;
        } catch (e) {
            // If config/index.js fails, fall back to single-chain
            return false;
        }
    }

    /**
     * Start the arbitrage bot
     */
    async start() {
        try {
            const version = this.multiChainMode ? 'v3.0.0 (Multi-Chain)' : 'v2.0.0';
            log.info(`Arbitrage Bot ${version} starting...`);

            if (this.multiChainMode) {
                await this.startMultiChain();
            } else {
                await this.startSingleChain();
            }

            this.isRunning = true;
            log.info('Bot is now running and monitoring for arbitrage opportunities');

        } catch (error) {
            log.error('Failed to start bot', { error: error.message, stack: error.stack });
            throw error;
        }
    }

    /**
     * Start in single-chain mode (original BSC operation)
     */
    async startSingleChain() {
        log.info('Starting in single-chain mode (BSC)');
        log.info('Configuration:', {
            minProfit: `${config.trading.minProfitPercentage}%`,
            maxPairs: config.monitoring.maxPairsToMonitor,
            dexes: Object.keys(config.dex).filter(dex => config.dex[dex].enabled),
            executionEnabled: config.execution?.enabled || false,
            executionMode: config.execution?.mode || 'detection-only',
            triangularEnabled: config.triangular?.enabled !== false,
        });

        // Set up event handlers
        this.setupSingleChainEventHandlers();

        // Initialize execution manager if enabled
        if (config.execution?.enabled) {
            await executionManager.initialize();
            log.info('Execution manager initialized', { mode: executionManager.mode });
        }

        // Start dashboard server
        dashboard.start(this);
        log.info(`Dashboard available at http://localhost:${dashboard.port}`);

        // Start block monitoring
        await blockMonitor.start();

        log.info(`Monitoring ${Object.keys(config.tokens).length} tokens across ${Object.keys(config.dex).filter(d => config.dex[d].enabled).length} DEXs`);
    }

    /**
     * Start in multi-chain mode with worker threads
     */
    async startMultiChain() {
        const enabledChains = getEnabledChains();
        const chainList = Object.values(enabledChains);
        log.info('Starting in multi-chain mode', {
            chains: chainList.map(c => c.name),
            chainCount: chainList.length,
        });

        // Initialize WorkerCoordinator
        this.workerCoordinator = new WorkerCoordinator({
            maxWorkers: globalConfig?.maxWorkers || 6,
            workerTimeout: globalConfig?.workerTimeout || 30000,
            restartDelay: globalConfig?.restartDelay || 5000,
        });

        // Initialize CrossChainDetector
        this.crossChainDetector = new CrossChainDetector({
            minProfitPercent: globalConfig?.crossChain?.minProfitPercent || 0.5,
            maxPriceAge: globalConfig?.crossChain?.maxPriceAge || 10000,
        });

        // Initialize MultiHopDetector for each chain (used in workers)
        this.multiHopDetector = new MultiHopDetector({
            maxHops: globalConfig?.multiHop?.maxHops || 5,
            minProfitPercent: globalConfig?.multiHop?.minProfitPercent || 0.3,
        });

        // Initialize MempoolMonitor (if any chain has it enabled)
        const mempoolEnabled = chainList.some(c => c.mempool?.enabled);
        if (mempoolEnabled) {
            this.mempoolMonitor = new MempoolMonitor({
                enabled: true,
                minSwapSizeUSD: globalConfig?.mempool?.minSwapSizeUSD || 10000,
            });
            log.info('Mempool monitoring enabled');
        }

        // Initialize execution manager if enabled (multi-chain mode)
        if (config.execution?.enabled) {
            await executionManager.initialize();
            log.info('Execution manager initialized for multi-chain mode', { mode: executionManager.mode });
        }

        // Set up multi-chain event handlers
        this.setupMultiChainEventHandlers();

        // Start dashboard server
        dashboard.start(this);
        log.info(`Dashboard available at http://localhost:${dashboard.port}`);

        // Start all workers
        await this.workerCoordinator.startAll(chainConfigs);

        log.info(`Multi-chain monitoring started for ${chainList.length} chains`);
    }

    /**
     * Set up event handlers for single-chain mode
     */
    setupSingleChainEventHandlers() {
        // Handle new blocks
        blockMonitor.on('newBlock', async (blockData) => {
            await this.handleNewBlock(blockData);
        });

        // Handle errors
        blockMonitor.on('error', (error) => {
            log.error('Block monitor error', { error: error.message });
        });

        // Handle RPC manager events
        rpcManager.on('endpointUnhealthy', (endpoint) => {
            log.warn(`RPC endpoint unhealthy: ${endpoint}`);
        });
    }

    /**
     * Set up event handlers for multi-chain mode
     */
    setupMultiChainEventHandlers() {
        if (!this.workerCoordinator) return;

        // Handle opportunities from workers
        this.workerCoordinator.on('opportunities', async (data) => {
            const { chainId, blockNumber, opportunities, processingTime } = data;

            // Update dashboard metrics
            dashboard.recordBlock();
            dashboard.recordOpportunities(opportunities.length);

            // Update cross-chain detector with latest prices
            if (this.crossChainDetector && opportunities.length > 0) {
                // Extract prices from opportunities for cross-chain comparison
                const prices = this.extractPricesFromOpportunities(opportunities);
                this.crossChainDetector.updateChainPrices(chainId, prices, blockNumber);
            }

            // Process opportunities (details already logged by per-chain arbitrageDetector)
            for (const opportunity of opportunities) {
                // Add chain context to opportunity
                opportunity.chainId = chainId;
                opportunity.blockNumber = blockNumber;

                // Send alert
                await alertManager.notify(opportunity);

                // Execute if enabled (multi-chain execution)
                if (config.execution?.enabled) {
                    const result = await executionManager.execute(opportunity);

                    if (result.simulated) {
                        dashboard.recordSimulation(result.success);
                    } else if (result.success) {
                        dashboard.recordExecution(
                            true,
                            opportunity.profitCalculation?.netProfitUSD || 0
                        );
                    } else {
                        dashboard.recordExecution(false);
                    }
                }
            }

            // Record performance
            performanceTracker.recordBlockProcessing(blockNumber, processingTime, opportunities.length);
        });

        // Handle cross-chain opportunities
        if (this.crossChainDetector) {
            this.crossChainDetector.on('crossChainOpportunity', async (opportunity) => {
                log.info(`🌐 Cross-chain: ${opportunity.token} | ${formatChain(opportunity.buyChain)}→${formatChain(opportunity.sellChain)} | Spread: ${formatPercent(opportunity.spreadPercent)} | Net: ${formatPercent(opportunity.netProfitPercent)}`);

                // Send alert for cross-chain opportunity
                await alertManager.notify({
                    ...opportunity,
                    type: 'cross-chain',
                });

                dashboard.recordOpportunities(1);
            });
        }

        // Handle mempool events (debug level - can be noisy)
        if (this.mempoolMonitor) {
            this.mempoolMonitor.on('largeSwap', (swapInfo) => {
                log.debug(`🔮 Mempool: ${swapInfo.method} | ${swapInfo.txHash?.slice(0, 14)}... | ${swapInfo.value}`);
            });
        }

        // Handle worker errors
        this.workerCoordinator.on('workerError', ({ chainId, error }) => {
            log.error(`Worker ${formatChain(chainId)} error: ${error?.message || error}`);
            dashboard.recordError();
        });

        // Handle worker lifecycle events (debug level - not critical for users)
        this.workerCoordinator.on('workerStarted', ({ chainId }) => {
            log.debug(`Worker ${formatChain(chainId)} started`);
        });

        this.workerCoordinator.on('workerStopped', ({ chainId }) => {
            log.debug(`Worker ${formatChain(chainId)} stopped`);
        });
    }

    /**
     * Extract price data from opportunities for cross-chain comparison
     */
    extractPricesFromOpportunities(opportunities) {
        const prices = {};

        for (const opp of opportunities) {
            if (opp.token0 && opp.price0) {
                prices[opp.token0] = opp.price0;
            }
            if (opp.token1 && opp.price1) {
                prices[opp.token1] = opp.price1;
            }
        }

        return prices;
    }

    /**
     * Handle new block event (single-chain mode)
     */
    async handleNewBlock(blockData) {
        const { blockNumber } = blockData;

        // Prevent concurrent block processing
        if (this.processingBlock) {
            log.debug(`Skipping block ${blockNumber}, still processing previous block`);
            return;
        }

        this.processingBlock = true;
        const startTime = Date.now();

        try {
            // Update dashboard metrics
            dashboard.recordBlock();
            cacheManager.currentBlockNumber = blockNumber;

            // Invalidate stale cache entries
            cacheManager.invalidateOlderThan(blockNumber);

            // Fetch all prices
            const prices = await priceFetcher.fetchAllPrices(blockNumber);

            if (Object.keys(prices).length === 0) {
                log.debug('No prices fetched for this block');
                return;
            }

            // Detect arbitrage opportunities (now async to fetch dynamic gas)
            const opportunities = await arbitrageDetector.detectOpportunities(prices, blockNumber);

            // Also run multi-hop detection if available (single-chain mode)
            let multiHopOpportunities = [];
            if (this.multiHopDetector) {
                multiHopOpportunities = this.multiHopDetector.findOpportunities(
                    prices,
                    config.dex,
                    config.baseTokens,
                    blockNumber
                );
            }

            const allOpportunities = [...opportunities, ...multiHopOpportunities];

            // Update dashboard with opportunities found
            dashboard.recordOpportunities(allOpportunities.length);

            if (allOpportunities.length > 0) {
                // Note: Opportunity details are already logged by arbitrageDetector
                // Process each opportunity for alerts and execution
                for (const opportunity of allOpportunities) {
                    // Send alert
                    await alertManager.notify(opportunity);

                    // Execute if enabled
                    if (config.execution?.enabled) {
                        const result = await executionManager.execute(opportunity);

                        if (result.simulated) {
                            dashboard.recordSimulation(result.success);
                        } else if (result.success) {
                            dashboard.recordExecution(
                                true,
                                opportunity.profitCalculation?.netProfitUSD || 0
                            );
                        } else {
                            dashboard.recordExecution(false);
                        }
                    }
                }
            }

            // Record performance metrics
            const duration = Date.now() - startTime;
            performanceTracker.recordBlockProcessing(blockNumber, duration, allOpportunities.length);

        } catch (error) {
            log.error(`Error processing block ${blockNumber}`, {
                error: error.message,
                stack: error.stack,
            });
            dashboard.recordError();
        } finally {
            this.processingBlock = false;
        }
    }

    /**
     * Stop the arbitrage bot
     */
    async stop() {
        if (!this.isRunning) {
            return;
        }

        log.info('Stopping Arbitrage Bot...');
        this.isRunning = false;

        try {
            if (this.multiChainMode) {
                await this.stopMultiChain();
            } else {
                await this.stopSingleChain();
            }

            // Stop dashboard server
            dashboard.stop();

            // Generate final report
            const metrics = performanceTracker.getMetrics();
            const dashboardMetrics = dashboard.getMetrics();
            log.info('Final performance report:', metrics);
            log.info('Dashboard metrics:', dashboardMetrics);

            log.info('Bot stopped gracefully');

        } catch (error) {
            log.error('Error stopping bot', { error: error.message });
        }
    }

    /**
     * Stop single-chain mode components
     */
    async stopSingleChain() {
        // Stop block monitor
        await blockMonitor.stop();

        // Cleanup RPC manager
        await rpcManager.cleanup();

        // Cleanup performance tracker
        performanceTracker.cleanup();

        // Log execution stats if enabled
        if (config.execution?.enabled) {
            const execStats = executionManager.getStats();
            log.info('Execution statistics:', execStats);
        }
    }

    /**
     * Stop multi-chain mode components
     */
    async stopMultiChain() {
        // Stop worker coordinator
        if (this.workerCoordinator) {
            await this.workerCoordinator.stopAll();
        }

        // Stop mempool monitor
        if (this.mempoolMonitor) {
            this.mempoolMonitor.stop();
        }

        // Log execution stats if enabled (multi-chain mode)
        if (config.execution?.enabled) {
            const execStats = executionManager.getStats();
            log.info('Execution statistics:', execStats);
        }

        // Cleanup performance tracker
        performanceTracker.cleanup();

        // Log worker stats
        if (this.workerCoordinator) {
            const stats = this.workerCoordinator.getStats();
            log.info('Worker coordinator statistics:', stats);
        }
    }

    /**
     * Get current bot status
     */
    getStatus() {
        const baseStatus = {
            isRunning: this.isRunning,
            mode: this.multiChainMode ? 'multi-chain' : 'single-chain',
            processingBlock: this.processingBlock,
            performance: performanceTracker.getMetrics(),
            dashboard: dashboard.getMetrics(),
        };

        if (this.multiChainMode) {
            return {
                ...baseStatus,
                workers: this.workerCoordinator?.getStatus() || {},
                crossChain: this.crossChainDetector?.getStats() || {},
                mempool: this.mempoolMonitor?.getStats() || {},
            };
        } else {
            const status = {
                ...baseStatus,
                blockMonitor: blockMonitor.getStatus(),
                rpc: rpcManager.getStats(),
                cache: cacheManager.getStats(),
            };

            // Include execution stats if enabled
            if (config.execution?.enabled) {
                status.execution = executionManager.getStats();
            }

            return status;
        }
    }
}

// Main entry point
async function main() {
    const bot = new ArbitrageBot();

    // Handle graceful shutdown
    const gracefulShutdown = async (signal, exitCode = 0) => {
        log.info(`\nReceived shutdown signal: ${signal}`);
        await bot.stop();
        process.exit(exitCode);
    };

    process.on('SIGINT', () => gracefulShutdown('SIGINT', 0));   // Ctrl+C
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM', 0));  // Docker/Kubernetes stop
    process.on('SIGHUP', () => gracefulShutdown('SIGHUP', 0));   // Terminal closed

    // Handle unhandled errors
    process.on('unhandledRejection', (reason, promise) => {
        log.error('Unhandled Promise Rejection', { reason, promise });
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
        // Ignore WebSocket handshake 301/404 errors (they are just connection failures)
        if (error.message && error.message.includes('Unexpected server response')) {
            log.warn('Ignored harmless WebSocket handshake error', { error: error.message });
            return;
        }

        log.error('Uncaught Exception', { error: error.message, stack: error.stack });
        gracefulShutdown('Uncaught Exception', 1);
    });

    // Start the bot
    try {
        await bot.start();
    } catch (error) {
        log.error('Fatal error starting bot', { error: error.message });
        process.exit(1);
    }
}

// Run if this is the main module
// Cross-platform check: normalize paths and handle Windows drive letters
const isMainModule = (() => {
    if (!process.argv[1]) return false;
    const moduleUrl = new URL(import.meta.url);
    const scriptPath = new URL(`file://${process.argv[1].replace(/\\/g, '/')}`);
    return moduleUrl.pathname.toLowerCase() === scriptPath.pathname.toLowerCase();
})();

if (isMainModule) {
    main();
}

export default ArbitrageBot;
