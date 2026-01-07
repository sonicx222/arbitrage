import blockMonitor from './monitoring/blockMonitor.js';
import priceFetcher from './data/priceFetcher.js';
import arbitrageDetector from './analysis/arbitrageDetector.js';
import alertManager from './alerts/alertManager.js';
import performanceTracker from './monitoring/performanceTracker.js';
import cacheManager from './data/cacheManager.js';
import rpcManager from './utils/rpcManager.js';
import dashboard from './monitoring/dashboard.js';
import executionManager from './execution/executionManager.js';
import eventDrivenDetector from './monitoring/eventDrivenDetector.js';
import adaptivePrioritizer from './analysis/adaptivePrioritizer.js';
import reserveDifferentialAnalyzer from './analysis/reserveDifferentialAnalyzer.js';
import crossPoolCorrelation from './analysis/crossPoolCorrelation.js';
import dexAggregator from './analysis/dexAggregator.js';
import whaleTracker from './analysis/whaleTracker.js';
import v2v3Arbitrage from './analysis/v2v3Arbitrage.js';
import v3PriceFetcher from './data/v3PriceFetcher.js';
import statisticalArbitrageDetector from './analysis/statisticalArbitrageDetector.js';
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
        this.processingEvent = false; // For event-driven detection

        // Multi-chain components (initialized if multi-chain mode)
        this.workerCoordinator = null;
        this.crossChainDetector = null;
        this.multiHopDetector = null;
        this.mempoolMonitor = null;

        // Cleanup interval timer (for proper cleanup on stop)
        this.cleanupIntervalTimer = null;

        // Event-driven detection stats
        this.eventDrivenStats = {
            opportunitiesFromEvents: 0,
            opportunitiesFromBlocks: 0,
            opportunitiesFromDifferential: 0,
            opportunitiesFromV2V3: 0,
            opportunitiesFromFeeTier: 0,
            opportunitiesFromStatistical: 0,
        };

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
            eventDrivenEnabled: config.eventDriven?.enabled !== false,
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

        // Start block monitoring (still needed for fallback and block number tracking)
        await blockMonitor.start();

        // Start adaptive pair prioritization
        adaptivePrioritizer.start();
        log.info('Adaptive pair prioritization started');

        // Start cross-pool correlation tracking
        crossPoolCorrelation.start();
        log.info('Cross-pool correlation tracking started');

        // Start statistical arbitrage detection (P3 improvement)
        statisticalArbitrageDetector.start();
        log.info('Statistical arbitrage detector started');

        // Initialize DEX aggregator with chain ID
        const chainId = config.chainId || 56;
        dexAggregator.initialize(chainId);
        log.info('DEX aggregator initialized', { chainId });

        // Start event-driven detection (real-time Sync event monitoring)
        if (config.eventDriven?.enabled !== false) {
            const eventDrivenStarted = await eventDrivenDetector.start();
            if (eventDrivenStarted) {
                log.info('Event-driven detection started (real-time Sync events)');
                this.setupEventDrivenHandlers();
            } else {
                log.warn('Event-driven detection failed to start, falling back to block-only mode');
            }
        }

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
     * Set up event handlers for event-driven detection
     * Processes Sync events in real-time for faster opportunity detection
     */
    setupEventDrivenHandlers() {
        // Handle real-time reserve updates from Sync events
        eventDrivenDetector.on('reserveUpdate', async (data) => {
            // First, run reserve differential analysis (detects cross-DEX lag opportunities)
            const differentialResult = reserveDifferentialAnalyzer.processReserveUpdate(data);

            // Record price update for cross-pool correlation tracking
            if (data.price) {
                crossPoolCorrelation.recordPriceUpdate({
                    pairKey: data.pairKey,
                    dexName: data.dexName,
                    price: data.price,
                    blockNumber: data.blockNumber,
                });

                // Process correlation and emit checkCorrelated events
                crossPoolCorrelation.processReserveUpdate(data);
            }

            // Then run standard arbitrage detection
            await this.handleReserveUpdate(data);
        });

        // Handle correlated pool checks from cross-pool correlation
        crossPoolCorrelation.on('checkCorrelated', async (correlationData) => {
            await this.handleCorrelatedPoolCheck(correlationData);
        });

        // Handle correlated opportunities from differential analysis
        reserveDifferentialAnalyzer.on('correlatedOpportunity', async (data) => {
            await this.handleDifferentialOpportunity(data);
        });

        // Handle DEX aggregator arbitrage opportunities
        dexAggregator.on('opportunity', async (opportunity) => {
            await this.handleAggregatorOpportunity(opportunity);
        });

        // Handle whale activity signals (from confirmed whale trades)
        whaleTracker.on('whaleActivity', async (signal) => {
            await this.handleWhaleActivity(signal);
        });

        // Handle statistical arbitrage signals (P3 improvement)
        statisticalArbitrageDetector.on('statisticalSignal', async (signal) => {
            await this.handleStatisticalSignal(signal);
        });

        // Handle swap events for whale tracking (feeds trader addresses to WhaleTracker)
        eventDrivenDetector.on('swapDetected', (swapData) => {
            this.handleSwapForWhaleTracking(swapData);
        });

        // Log price changes at debug level
        eventDrivenDetector.on('priceChange', (data) => {
            log.debug(`Sync event: ${data.pairKey} on ${data.dexName}`, {
                blockNumber: data.blockNumber,
            });
        });

        // Handle V3 price updates (V3 Swap events include sqrtPriceX96 directly!)
        // This is more valuable than V2 because we get the exact pool price
        eventDrivenDetector.on('v3PriceUpdate', async (data) => {
            // Record price for cross-pool correlation
            crossPoolCorrelation.recordPriceUpdate({
                pairKey: data.poolKey,
                dexName: data.dexName,
                price: data.price,
                blockNumber: data.blockNumber,
                feeTier: data.feeTier,
                isV3: true,
            });

            // Process for correlation events
            crossPoolCorrelation.processReserveUpdate({
                pairKey: data.poolKey,
                dexName: data.dexName,
                price: data.price,
                blockNumber: data.blockNumber,
            });

            // Run differential analysis for V3 pools
            reserveDifferentialAnalyzer.processReserveUpdate({
                pairKey: data.poolKey,
                dexName: data.dexName,
                tokenA: data.tokenA,
                tokenB: data.tokenB,
                price: data.price,
                blockNumber: data.blockNumber,
                timestamp: data.timestamp,
                isV3: true,
                feeTier: data.feeTier,
            });

            log.debug(`V3 Swap event: ${data.poolKey} (${data.feeTier / 10000}%) on ${data.dexName}`, {
                price: data.price?.toFixed(6),
                tick: data.tick,
                blockNumber: data.blockNumber,
            });
        });

        // Periodic cleanup of old differential history
        this.cleanupIntervalTimer = setInterval(() => {
            reserveDifferentialAnalyzer.cleanup();
        }, 60000); // Every minute
        this.cleanupIntervalTimer.unref(); // Don't block process exit
    }

    /**
     * Handle opportunity detected by reserve differential analysis
     * These are cross-DEX opportunities detected from price lag
     *
     * Improvement v2.0: Full integration with price re-fetch and profit calculation
     * Expected impact: +20-40% more opportunities detected
     */
    async handleDifferentialOpportunity(data) {
        const { opportunity, timestamp } = data;

        if (!opportunity) return;

        try {
            // Step 1: Re-verify opportunity by fetching current prices
            // The differential analyzer detected a spread, but we need full profit calculation
            const [token0Symbol, token1Symbol] = opportunity.pairKey.split('/');
            const token0 = config.tokens[token0Symbol];
            const token1 = config.tokens[token1Symbol];

            if (!token0 || !token1) {
                log.debug('[DIFFERENTIAL] Unknown tokens, skipping', { pairKey: opportunity.pairKey });
                return;
            }

            // Build prices object from cache for both DEXs
            const prices = { [opportunity.pairKey]: {} };
            const [addr0, addr1] = token0.address.toLowerCase() < token1.address.toLowerCase()
                ? [token0.address.toLowerCase(), token1.address.toLowerCase()]
                : [token1.address.toLowerCase(), token0.address.toLowerCase()];

            // Get cached prices for buy and sell DEXs
            for (const dexName of [opportunity.buyDex, opportunity.sellDex]) {
                const cacheKey = `price:${dexName}:${addr0}:${addr1}`;
                const priceData = cacheManager.priceCache.get(cacheKey);
                if (priceData?.data) {
                    prices[opportunity.pairKey][dexName] = priceData.data;
                }
            }

            // Step 2: Run full arbitrage detection with profit calculation
            if (Object.keys(prices[opportunity.pairKey]).length >= 2) {
                const opportunities = await arbitrageDetector.detectOpportunities(
                    prices,
                    cacheManager.currentBlockNumber
                );

                // Check if we still have a profitable opportunity
                if (opportunities.length === 0) {
                    log.debug('[DIFFERENTIAL] Opportunity no longer profitable after re-verification');
                    return;
                }

                // Use the verified opportunity with full profit calculation
                const verifiedOpportunity = opportunities[0];
                verifiedOpportunity.source = 'reserve-differential';
                verifiedOpportunity.detectionLatencyMs = Date.now() - timestamp;
                verifiedOpportunity.priority = 'high'; // Mark as high priority for faster execution
                verifiedOpportunity.differentialTrigger = opportunity.trigger;

                this.eventDrivenStats.opportunitiesFromDifferential++;
                dashboard.recordOpportunities(1);

                log.info(`[DIFFERENTIAL] Cross-DEX lag opportunity verified`, {
                    pairKey: verifiedOpportunity.pairKey,
                    spread: `${(verifiedOpportunity.netProfitPercentage || 0).toFixed(3)}%`,
                    profit: `$${(verifiedOpportunity.profitUSD || 0).toFixed(2)}`,
                    buyDex: verifiedOpportunity.buyDex,
                    sellDex: verifiedOpportunity.sellDex,
                    lagMs: opportunity.trigger?.lagMs,
                    latencyMs: verifiedOpportunity.detectionLatencyMs,
                });

                // Record with adaptive prioritizer (boost priority)
                const pairKeyWithDex = `${verifiedOpportunity.pairKey}:${verifiedOpportunity.buyDex}`;
                adaptivePrioritizer.recordOpportunity(pairKeyWithDex, {
                    volumeUSD: verifiedOpportunity.optimalTradeSizeUSD,
                    priority: 2, // Double priority boost for differential opportunities
                });

                // Send alert
                await alertManager.notify(verifiedOpportunity);

                // Execute if enabled (with whale competition check)
                if (config.execution?.enabled) {
                    if (!this.shouldExecuteWithWhaleCheck(verifiedOpportunity)) {
                        log.info(`[DIFFERENTIAL] Skipping execution due to whale competition`);
                        return;
                    }

                    const result = await executionManager.execute(verifiedOpportunity);

                    if (result.simulated) {
                        dashboard.recordSimulation(result.success);
                    } else if (result.success) {
                        dashboard.recordExecution(true, verifiedOpportunity.profitUSD || 0);
                    } else {
                        dashboard.recordExecution(false);
                    }
                }
            } else {
                // Fallback: alert on basic opportunity if we can't get full prices
                log.debug('[DIFFERENTIAL] Incomplete price data, using basic opportunity');
                opportunity.source = 'reserve-differential';
                opportunity.detectionLatencyMs = Date.now() - timestamp;

                this.eventDrivenStats.opportunitiesFromDifferential++;
                dashboard.recordOpportunities(1);

                log.info(`[DIFFERENTIAL] Cross-DEX lag opportunity (unverified)`, {
                    pairKey: opportunity.pairKey,
                    spread: `${opportunity.spreadPercent?.toFixed(3)}%`,
                    buyDex: opportunity.buyDex,
                    sellDex: opportunity.sellDex,
                });

                await alertManager.notify(opportunity);
            }
        } catch (error) {
            log.debug('[DIFFERENTIAL] Error processing opportunity', { error: error.message });
        }
    }

    /**
     * Handle correlated pool check from cross-pool correlation
     * When one pool updates, check correlated pools for arbitrage before they update
     */
    async handleCorrelatedPoolCheck(correlationData) {
        const { sourcePool, targetPool, correlationScore, priceChange } = correlationData;

        // Only check high-correlation pools (saves RPC calls)
        if (correlationScore < 0.7) return;

        try {
            // Parse target pool info
            const [pairKey, dexName] = targetPool.split(':');
            if (!pairKey || !dexName) return;

            // Get cached price for target pool
            const [token0Symbol, token1Symbol] = pairKey.split('/');
            const token0 = config.tokens[token0Symbol];
            const token1 = config.tokens[token1Symbol];

            if (!token0 || !token1) return;

            const cacheKey = `price:${dexName}:${token0.address.toLowerCase()}:${token1.address.toLowerCase()}`;
            const priceData = cacheManager.priceCache.get(cacheKey);

            if (!priceData || !priceData.data) return;

            // Build prices object for detection
            const prices = { [pairKey]: { [dexName]: priceData.data } };

            // Add source pool prices for comparison
            const [sourcePair, sourceDex] = sourcePool.split(':');
            if (sourcePair === pairKey) {
                const sourceCacheKey = `price:${sourceDex}:${token0.address.toLowerCase()}:${token1.address.toLowerCase()}`;
                const sourcePrice = cacheManager.priceCache.get(sourceCacheKey);
                if (sourcePrice?.data) {
                    prices[pairKey][sourceDex] = sourcePrice.data;
                }
            }

            // Check for arbitrage
            if (Object.keys(prices[pairKey]).length >= 2) {
                const opportunities = await arbitrageDetector.detectOpportunities(
                    prices,
                    cacheManager.currentBlockNumber
                );

                for (const opportunity of opportunities) {
                    opportunity.source = 'correlation-predictive';
                    opportunity.correlationScore = correlationScore;

                    log.info(`[CORRELATION] Predictive opportunity from ${sourcePool}`, {
                        target: targetPool,
                        score: correlationScore.toFixed(2),
                        profit: `${opportunity.profitPercent?.toFixed(3)}%`,
                    });

                    this.eventDrivenStats.opportunitiesFromEvents++;
                    dashboard.recordOpportunities(1);
                    await alertManager.notify(opportunity);

                    if (config.execution?.enabled) {
                        if (!this.shouldExecuteWithWhaleCheck(opportunity)) {
                            log.info(`[CORRELATION] Skipping execution due to whale competition`);
                            continue;
                        }

                        const result = await executionManager.execute(opportunity);
                        if (result.simulated) {
                            dashboard.recordSimulation(result.success);
                        } else if (result.success) {
                            dashboard.recordExecution(true, opportunity.profitCalculation?.netProfitUSD || 0);
                        } else {
                            dashboard.recordExecution(false);
                        }
                    }
                }
            }
        } catch (error) {
            log.debug('Correlated pool check failed', { error: error.message });
        }
    }

    /**
     * Handle opportunity detected by DEX aggregator
     * These are split-route opportunities found via 1inch/Paraswap APIs
     */
    async handleAggregatorOpportunity(opportunity) {
        if (!opportunity) return;

        dashboard.recordOpportunities(1);

        log.info(`[AGGREGATOR] Split-route opportunity detected`, {
            aggregator: opportunity.aggregator,
            spread: `${opportunity.spreadPercent?.toFixed(3)}%`,
            route: opportunity.route?.join(' → ') || 'multi-hop',
        });

        // Record with adaptive prioritizer
        if (opportunity.pairKey) {
            adaptivePrioritizer.recordOpportunity(opportunity.pairKey, {
                volumeUSD: opportunity.amountUSD,
            });
        }

        // Send alert
        await alertManager.notify({
            ...opportunity,
            type: 'aggregator-arbitrage',
            source: 'dex-aggregator',
        });

        // Note: Aggregator arbitrage execution requires different transaction building
        // For now, log and alert only. Future: integrate with executionManager
        if (config.execution?.enabled && config.execution?.aggregatorEnabled) {
            log.info('Aggregator execution not yet implemented - opportunity logged for analysis');
        }
    }

    /**
     * Handle whale activity signal
     * When a known whale trades, check for related arbitrage opportunities
     */
    async handleWhaleActivity(signal) {
        if (!signal) return;

        log.info(`[WHALE] Activity detected`, {
            address: signal.address.slice(0, 10) + '...',
            pair: signal.pairKey,
            direction: signal.direction,
            amount: `$${signal.amountUSD?.toFixed(0)}`,
            block: signal.blockNumber,
        });

        // Whale trades often create price dislocations - boost priority of this pair
        if (signal.pairKey) {
            adaptivePrioritizer.recordOpportunity(`${signal.pairKey}:whale`, {
                volumeUSD: signal.amountUSD,
            });
        }
    }

    /**
     * Handle statistical arbitrage signal
     * P3 Improvement: Mean-reversion based opportunity detection
     *
     * @param {Object} signal - Statistical signal from StatisticalArbitrageDetector
     */
    async handleStatisticalSignal(signal) {
        if (!signal) return;

        this.eventDrivenStats.opportunitiesFromStatistical++;
        dashboard.recordOpportunities(1);

        log.info(`[STATISTICAL] Mean-reversion signal detected`, {
            pairKey: signal.pairKey,
            zScore: signal.zScore.toFixed(2),
            direction: signal.direction,
            strength: signal.strength,
            confidence: `${(signal.confidence * 100).toFixed(1)}%`,
            expectedReversion: `${signal.expectedReversionPercent.toFixed(3)}%`,
            action: `Buy on ${signal.action.buy}, sell on ${signal.action.sell}`,
        });

        // Record with adaptive prioritizer to boost this pair's priority
        const pairKeyWithSource = `${signal.pairKey}:statistical`;
        adaptivePrioritizer.recordOpportunity(pairKeyWithSource, {
            volumeUSD: 1000, // Default volume for statistical signals
            priority: signal.strength === 'strong' ? 2 : 1,
        });

        // Convert signal to opportunity format for alerting
        const opportunity = {
            type: 'statistical-arbitrage',
            pairKey: signal.pairKey,
            buyDex: signal.action.buy,
            sellDex: signal.action.sell,
            profitPercent: signal.expectedReversionPercent,
            confidence: signal.confidence,
            zScore: signal.zScore,
            strength: signal.strength,
            source: 'statistical-detector',
            blockNumber: signal.blockNumber,
            timestamp: signal.timestamp,
        };

        // Send alert
        await alertManager.notify(opportunity);

        // Note: Statistical signals are informational - they indicate potential
        // mean reversion but don't guarantee immediate profit. Execution is
        // optional and should be handled with caution.
        if (config.execution?.enabled && config.execution?.statisticalEnabled && signal.strength === 'strong') {
            log.info('[STATISTICAL] Strong signal - checking for immediate arbitrage');
            // The actual execution would require fetching current prices and
            // running through the normal arbitrage detection to verify profit
        }
    }

    /**
     * Handle swap event for whale tracking
     * This feeds trader addresses from Swap events to WhaleTracker
     * Enables automatic whale detection from on-chain activity
     *
     * @param {Object} swapData - Swap event data from EventDrivenDetector
     */
    handleSwapForWhaleTracking(swapData) {
        if (!swapData || !swapData.sender) return;

        // Record the trade for the sender (the address initiating the swap)
        whaleTracker.recordTrade({
            address: swapData.sender,
            pairKey: swapData.pairKey,
            dexName: swapData.dexName,
            amountUSD: swapData.amountUSD,
            direction: swapData.direction,
            blockNumber: swapData.blockNumber,
            txHash: swapData.transactionHash,
        });

        // Also record for recipient if different from sender (might be a router)
        // This helps track MEV bots and arbitrage contracts
        if (swapData.recipient && swapData.recipient !== swapData.sender) {
            // Only track if recipient looks like an EOA or known contract
            // Router addresses typically receive then forward tokens
            whaleTracker.recordTrade({
                address: swapData.recipient,
                pairKey: swapData.pairKey,
                dexName: swapData.dexName,
                amountUSD: swapData.amountUSD,
                direction: swapData.direction === 'buy' ? 'sell' : 'buy', // Recipient gets opposite direction
                blockNumber: swapData.blockNumber,
                txHash: swapData.transactionHash,
            });
        }

        log.debug(`[SWAP] Recorded for whale tracking`, {
            sender: swapData.sender.slice(0, 10) + '...',
            pair: swapData.pairKey,
            amount: `$${swapData.amountUSD?.toFixed(0)}`,
        });
    }

    /**
     * Check whale competition before executing an opportunity
     * Returns true if we should proceed, false if we should skip
     *
     * @param {Object} opportunity - The opportunity to check
     * @returns {boolean} Whether to proceed with execution
     */
    shouldExecuteWithWhaleCheck(opportunity) {
        // Extract pair key from opportunity
        const pairKey = opportunity.pairKey ||
            (opportunity.path ? `${opportunity.path[0]}/${opportunity.path[1]}` : null);

        if (!pairKey) return true; // Can't check, proceed

        // Determine trade direction
        const direction = opportunity.buyDex ? 'buy' : (opportunity.direction || 'buy');

        // Assess whale competition
        const competition = whaleTracker.assessCompetition(pairKey, direction);

        if (competition.level === 'high') {
            log.warn(`[WHALE] High competition detected for ${pairKey}`, {
                reason: competition.reason,
                recommendation: competition.recommendation,
                whaleVolume: `$${competition.whaleVolume?.toFixed(0) || 'N/A'}`,
            });

            // Skip execution when whale competition is high
            if (competition.recommendation === 'caution') {
                return false;
            }
        } else if (competition.level === 'medium') {
            log.debug(`[WHALE] Medium competition for ${pairKey}: ${competition.reason}`);
        }

        return true;
    }

    /**
     * Handle real-time reserve update from Sync event
     * This runs arbitrage detection immediately without waiting for next block
     */
    async handleReserveUpdate(data) {
        const { pairKey, dexName, blockNumber, timestamp } = data;

        // Skip if already processing an event (prevent queue buildup)
        if (this.processingEvent) {
            return;
        }

        this.processingEvent = true;
        const startTime = Date.now();

        try {
            // Get all current prices from cache (includes the just-updated pair)
            const prices = {};
            const cacheStats = cacheManager.getStats();

            // Build prices object from cache for affected pair and related pairs
            // This is faster than fetching all prices via RPC
            const affectedPairs = this.getRelatedPairs(pairKey);

            for (const pair of affectedPairs) {
                const cacheKey = `price:${pair.dexName}:${pair.token0}:${pair.token1}`;
                const priceData = cacheManager.priceCache.get(cacheKey);
                if (priceData && priceData.data) {
                    if (!prices[pair.pairKey]) {
                        prices[pair.pairKey] = {};
                    }
                    prices[pair.pairKey][pair.dexName] = priceData.data;
                }
            }

            // If we have prices for the affected pair across multiple DEXs, check for arbitrage
            if (prices[pairKey] && Object.keys(prices[pairKey]).length >= 2) {
                // Run quick cross-DEX check on this pair only
                const opportunities = await arbitrageDetector.detectOpportunities(prices, blockNumber);

                if (opportunities.length > 0) {
                    this.eventDrivenStats.opportunitiesFromEvents += opportunities.length;
                    dashboard.recordOpportunities(opportunities.length);

                    for (const opportunity of opportunities) {
                        opportunity.source = 'sync-event';
                        opportunity.detectionLatencyMs = Date.now() - timestamp;

                        // Log with special indicator for event-driven detection
                        log.info(`[EVENT] Opportunity detected via Sync event`, {
                            type: opportunity.type,
                            pairKey: opportunity.pairKey,
                            profit: `${opportunity.profitPercent?.toFixed(3)}%`,
                            latencyMs: opportunity.detectionLatencyMs,
                        });

                        await alertManager.notify(opportunity);

                        // Execute if enabled (with whale competition check)
                        if (config.execution?.enabled) {
                            if (!this.shouldExecuteWithWhaleCheck(opportunity)) {
                                log.info(`[EVENT] Skipping execution due to whale competition`);
                                continue;
                            }

                            const result = await executionManager.execute(opportunity);
                            if (result.simulated) {
                                dashboard.recordSimulation(result.success);
                            } else if (result.success) {
                                dashboard.recordExecution(true, opportunity.profitCalculation?.netProfitUSD || 0);
                            } else {
                                dashboard.recordExecution(false);
                            }
                        }
                    }
                }
            }

            const duration = Date.now() - startTime;
            if (duration > 100) {
                log.debug(`Event processing took ${duration}ms for ${pairKey}`);
            }

        } catch (error) {
            log.error('Error processing reserve update', { error: error.message, pairKey });
            dashboard.recordError();
        } finally {
            this.processingEvent = false;
        }
    }

    /**
     * Get related pairs for a given pair key (same tokens, different DEXs)
     * @private
     */
    getRelatedPairs(pairKey) {
        const [token0Symbol, token1Symbol] = pairKey.split('/');
        const related = [];

        // Get token addresses
        const token0 = config.tokens[token0Symbol];
        const token1 = config.tokens[token1Symbol];

        if (!token0 || !token1) {
            return related;
        }

        const [addr0, addr1] = token0.address.toLowerCase() < token1.address.toLowerCase()
            ? [token0.address.toLowerCase(), token1.address.toLowerCase()]
            : [token1.address.toLowerCase(), token0.address.toLowerCase()];

        // Find this pair on all enabled DEXs
        for (const [dexName, dexConfig] of Object.entries(config.dex)) {
            if (!dexConfig.enabled) continue;

            related.push({
                pairKey,
                dexName,
                token0: addr0,
                token1: addr1,
            });
        }

        return related;
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
     *
     * Optimized flow:
     * 1. Get pairs already updated via Sync events (no need to re-fetch)
     * 2. Fetch remaining pairs via RPC (cache-aware)
     * 3. Run detection on combined price data
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

            // Get pairs already updated via event-driven detection
            // These pairs already have fresh data in cache from Sync events
            const eventUpdatedPairs = eventDrivenDetector.isActive()
                ? eventDrivenDetector.getPairsUpdatedInBlock(blockNumber)
                : new Set();

            // Fetch prices (cache-aware: skips pairs with fresh event data)
            const prices = await priceFetcher.fetchAllPrices(blockNumber, {
                excludePairs: eventUpdatedPairs,
                respectPriority: true,
            });

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

            // ==================== V2/V3 ARBITRAGE DETECTION ====================
            // Improvement v2.0: Detect V2/V3 and fee tier arbitrage opportunities
            // Expected impact: +10-20% V3-specific opportunities
            let v2v3Opportunities = [];
            try {
                // Fetch V3 prices if we have V3-enabled DEXs
                const v3Dexes = Object.entries(config.dex)
                    .filter(([_, dex]) => dex.enabled && dex.type === 'v3');

                if (v3Dexes.length > 0) {
                    const v3Prices = await v3PriceFetcher.fetchAllV3Prices(blockNumber);

                    if (v3Prices && Object.keys(v3Prices).length > 0) {
                        const chainId = config.chainId || 56;
                        v2v3Opportunities = v2v3Arbitrage.analyzeOpportunities(
                            chainId,
                            prices,      // V2 prices
                            v3Prices,    // V3 prices
                            blockNumber
                        );

                        // Track statistics by type
                        for (const opp of v2v3Opportunities) {
                            if (opp.type === 'v3-fee-tier-arb') {
                                this.eventDrivenStats.opportunitiesFromFeeTier++;
                            } else if (opp.type === 'v2-v3-arb') {
                                this.eventDrivenStats.opportunitiesFromV2V3++;
                            }
                        }
                    }
                }
            } catch (error) {
                log.debug('V2/V3 detection error', { error: error.message });
            }

            // ==================== STATISTICAL ARBITRAGE PROCESSING ====================
            // P3 Improvement: Feed prices to statistical detector for mean-reversion signals
            // This runs asynchronously - signals are emitted via events
            try {
                statisticalArbitrageDetector.processAllPrices(prices, blockNumber);
            } catch (error) {
                log.debug('Statistical arbitrage error', { error: error.message });
            }

            const allOpportunities = [...opportunities, ...multiHopOpportunities, ...v2v3Opportunities];

            // Update dashboard with opportunities found
            dashboard.recordOpportunities(allOpportunities.length);

            if (allOpportunities.length > 0) {
                this.eventDrivenStats.opportunitiesFromBlocks += allOpportunities.length;

                // Note: Opportunity details are already logged by arbitrageDetector
                // Process each opportunity for alerts and execution
                for (const opportunity of allOpportunities) {
                    // Record with adaptive prioritizer to boost this pair's priority
                    const pairKey = `${opportunity.pairKey}:${opportunity.buyDex}`;
                    adaptivePrioritizer.recordOpportunity(pairKey, {
                        volumeUSD: opportunity.profitCalculation?.tradeSizeUSD,
                        liquidityUSD: opportunity.liquidityUSD,
                    });

                    // Send alert
                    await alertManager.notify(opportunity);

                    // Execute if enabled (with whale competition check)
                    if (config.execution?.enabled) {
                        if (!this.shouldExecuteWithWhaleCheck(opportunity)) {
                            log.info(`[BLOCK] Skipping execution due to whale competition`);
                            continue;
                        }

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
        // Stop cleanup interval timer (prevents memory leak)
        if (this.cleanupIntervalTimer) {
            clearInterval(this.cleanupIntervalTimer);
            this.cleanupIntervalTimer = null;
        }

        // Stop event-driven detector
        if (eventDrivenDetector.isActive()) {
            await eventDrivenDetector.stop();
            log.info('Event-driven detector stopped', {
                stats: eventDrivenDetector.getStats(),
            });
        }

        // Stop adaptive prioritizer
        adaptivePrioritizer.stop();
        log.info('Adaptive prioritizer stopped', {
            stats: adaptivePrioritizer.getStats(),
        });

        // Stop cross-pool correlation
        crossPoolCorrelation.stop();
        log.info('Cross-pool correlation stopped', {
            stats: crossPoolCorrelation.getStats(),
        });

        // Stop statistical arbitrage detector
        statisticalArbitrageDetector.stop();
        log.info('Statistical arbitrage detector stopped', {
            stats: statisticalArbitrageDetector.getStats(),
        });

        // Log DEX aggregator stats
        log.info('DEX aggregator stats:', {
            stats: dexAggregator.getStats(),
        });

        // Log whale tracker stats
        log.info('Whale tracker stats:', {
            stats: whaleTracker.getStats(),
        });

        // Stop block monitor
        await blockMonitor.stop();

        // Cleanup RPC manager
        await rpcManager.cleanup();

        // Cleanup performance tracker
        performanceTracker.cleanup();

        // Log differential analyzer stats
        log.info('Reserve differential analyzer stats:', {
            stats: reserveDifferentialAnalyzer.getStats(),
        });

        // Log V2/V3 arbitrage stats
        log.info('V2/V3 arbitrage stats:', {
            stats: v2v3Arbitrage.getStats(),
        });

        // Log event-driven vs block-based stats
        log.info('Detection source statistics:', {
            fromEvents: this.eventDrivenStats.opportunitiesFromEvents,
            fromBlocks: this.eventDrivenStats.opportunitiesFromBlocks,
            fromDifferential: this.eventDrivenStats.opportunitiesFromDifferential,
            fromV2V3: this.eventDrivenStats.opportunitiesFromV2V3,
            fromFeeTier: this.eventDrivenStats.opportunitiesFromFeeTier,
            fromStatistical: this.eventDrivenStats.opportunitiesFromStatistical,
        });

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
                priceFetcher: priceFetcher.getStats(),
                eventDriven: eventDrivenDetector.getStats(),
                prioritizer: adaptivePrioritizer.getStats(),
                differential: reserveDifferentialAnalyzer.getStats(),
                correlation: crossPoolCorrelation.getStats(),
                aggregator: dexAggregator.getStats(),
                whaleTracker: whaleTracker.getStats(),
                detectionStats: this.eventDrivenStats,
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
