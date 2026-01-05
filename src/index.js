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

/**
 * Main application orchestrator for BSC Arbitrage Bot
 */
class ArbitrageBot {
    constructor() {
        this.isRunning = false;
        this.processingBlock = false;
    }

    /**
     * Start the arbitrage bot
     */
    async start() {
        try {
            log.info('🚀 BSC Arbitrage Bot v2.0.0 starting...');
            log.info('Configuration:', {
                minProfit: `${config.trading.minProfitPercentage}%`,
                maxPairs: config.monitoring.maxPairsToMonitor,
                dexes: Object.keys(config.dex).filter(dex => config.dex[dex].enabled),
                executionEnabled: config.execution?.enabled || false,
                executionMode: config.execution?.mode || 'detection-only',
                triangularEnabled: config.triangular?.enabled !== false,
            });

            // Set up event handlers
            this.setupEventHandlers();

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

            this.isRunning = true;
            log.info('✅ Bot is now running and monitoring for arbitrage opportunities');
            log.info(`📊 Monitoring ${Object.keys(config.tokens).length} tokens across ${Object.keys(config.dex).filter(d => config.dex[d].enabled).length} DEXs`);

        } catch (error) {
            log.error('Failed to start bot', { error: error.message, stack: error.stack });
            throw error;
        }
    }

    /**
     * Set up event handlers for block monitoring
     */
    setupEventHandlers() {
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
     * Handle new block event
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

            // Update dashboard with opportunities found
            dashboard.recordOpportunities(opportunities.length);

            if (opportunities.length > 0) {
                log.info(`✅ Found ${opportunities.length} arbitrage opportunities in block ${blockNumber}`);

                // Process each opportunity
                for (const opportunity of opportunities) {
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
            performanceTracker.recordBlockProcessing(blockNumber, duration, opportunities.length);

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

        log.info('Stopping BSC Arbitrage Bot...');
        this.isRunning = false;

        try {
            // Stop block monitor
            await blockMonitor.stop();

            // Stop dashboard server
            dashboard.stop();

            // Cleanup RPC manager
            await rpcManager.cleanup();

            // Cleanup performance tracker
            performanceTracker.cleanup();

            // Generate final report
            const metrics = performanceTracker.getMetrics();
            const dashboardMetrics = dashboard.getMetrics();
            log.info('Final performance report:', metrics);
            log.info('Dashboard metrics:', dashboardMetrics);

            // Log execution stats if enabled
            if (config.execution?.enabled) {
                const execStats = executionManager.getStats();
                log.info('Execution statistics:', execStats);
            }

            log.info('✅ Bot stopped gracefully');

        } catch (error) {
            log.error('Error stopping bot', { error: error.message });
        }
    }

    /**
     * Get current bot status
     */
    getStatus() {
        const status = {
            isRunning: this.isRunning,
            processingBlock: this.processingBlock,
            blockMonitor: blockMonitor.getStatus(),
            rpc: rpcManager.getStats(),
            cache: cacheManager.getStats(),
            performance: performanceTracker.getMetrics(),
            dashboard: dashboard.getMetrics(),
        };

        // Include execution stats if enabled
        if (config.execution?.enabled) {
            status.execution = executionManager.getStats();
        }

        return status;
    }
}

// Main entry point
async function main() {
    const bot = new ArbitrageBot();

    // Handle graceful shutdown
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
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}

export default ArbitrageBot;
