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
import liquidationMonitor from './monitoring/liquidationMonitor.js';
import v2v3Arbitrage from './analysis/v2v3Arbitrage.js';
import v3PriceFetcher from './data/v3PriceFetcher.js';
import statisticalArbitrageDetector from './analysis/statisticalArbitrageDetector.js';
import StablecoinDetector from './analysis/stablecoinDetector.js';
import newPairMonitorSingleton from './monitoring/newPairMonitor.js';
import blockTimePredictor from './execution/blockTimePredictor.js';
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

        // P1/P2 components: Stablecoin depeg & New pair monitoring
        this.stablecoinDetector = null;
        this.newPairMonitor = null;

        // Cleanup interval timer (for proper cleanup on stop)
        this.cleanupIntervalTimer = null;

        // FIX v3.4: Track whether handlers have been set up to prevent duplicate listeners
        this.singleChainHandlersSetup = false;
        this.eventDrivenHandlersSetup = false;
        this.multiChainHandlersSetup = false;

        // FIX v3.4: Store handler references for proper cleanup
        // Without storing references, anonymous handlers cannot be removed with .off()
        // causing memory leaks and duplicate event processing
        this._handlers = {
            // Single-chain handlers
            blockMonitor: {},
            rpcManager: {},
            // Event-driven handlers
            eventDrivenDetector: {},
            crossPoolCorrelation: {},
            reserveDifferentialAnalyzer: {},
            dexAggregator: {},
            whaleTracker: {},
            statisticalArbitrageDetector: {},
            liquidationMonitor: {},
            // P1/P2 handlers
            stablecoinDetector: {},
            newPairMonitor: {},
            // Multi-chain handlers
            workerCoordinator: {},
            crossChainDetector: {},
            mempoolMonitor: {},
        };

        // Event-driven detection stats
        this.eventDrivenStats = {
            opportunitiesFromEvents: 0,
            opportunitiesFromBlocks: 0,
            opportunitiesFromDifferential: 0,
            opportunitiesFromV2V3: 0,
            opportunitiesFromFeeTier: 0,
            opportunitiesFromStatistical: 0,
            opportunitiesFromLiquidations: 0,
            opportunitiesFromStablecoin: 0, // P1: Stablecoin depeg opportunities
            opportunitiesFromNewPairs: 0,   // P2: New pair opportunities
            droppedEvents: 0, // FIX v3.1: Track dropped events
        };

        // FIX v3.1: Event queue to prevent dropped events during processing
        // Events are queued and processed sequentially instead of being silently dropped
        this.eventQueue = [];
        this.maxEventQueueSize = 50; // Prevent unbounded queue growth
        this.eventQueueProcessing = false;

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

        // Start liquidation monitoring (Aave V3 + Compound V3)
        if (config.liquidation?.enabled !== false) {
            try {
                const chainId = config.chainId || 56;
                const provider = rpcManager.getProvider();
                await liquidationMonitor.initialize(provider, chainId);
                await liquidationMonitor.start();
                log.info('Liquidation monitor started', {
                    chainId,
                    protocols: liquidationMonitor.getSupportedProtocols().map(p => p.name),
                });
            } catch (error) {
                log.warn('Liquidation monitor failed to start', { error: error.message });
            }
        }

        // ==================== P1: STABLECOIN DEPEG DETECTION ====================
        // High-profit opportunities during market stress events
        // Expected impact: Catch 0.5-5%+ spreads during depeg events
        if (config.stablecoin?.enabled !== false) {
            try {
                this.stablecoinDetector = new StablecoinDetector({
                    depegThreshold: config.stablecoin?.depegThreshold || 0.002,
                    arbitrageThreshold: config.stablecoin?.arbitrageThreshold || 0.003,
                    severeDepegThreshold: config.stablecoin?.severeDepegThreshold || 0.01,
                });
                this.setupStablecoinHandlers();
                log.info('Stablecoin depeg detector started', {
                    depegThreshold: `${(config.stablecoin?.depegThreshold || 0.002) * 100}%`,
                    arbitrageThreshold: `${(config.stablecoin?.arbitrageThreshold || 0.003) * 100}%`,
                });
            } catch (error) {
                log.warn('Stablecoin detector failed to start', { error: error.message });
            }
        }

        // ==================== P2: NEW PAIR MONITORING ====================
        // Detect new liquidity pools with potential price inefficiencies
        // Expected impact: Early detection of arbitrage on new pools
        if (config.newPairs?.enabled !== false) {
            try {
                const chainId = config.chainId || 56;
                const wsProvider = rpcManager.getWebSocketProvider?.() || rpcManager.getProvider();

                // Use singleton instance and configure it
                this.newPairMonitor = newPairMonitorSingleton;

                // Update configuration if provided
                if (config.newPairs?.minLiquidityUSD) {
                    this.newPairMonitor.minLiquidityUSD = config.newPairs.minLiquidityUSD;
                }
                if (config.newPairs?.minSpreadPercent) {
                    this.newPairMonitor.minSpreadPercent = config.newPairs.minSpreadPercent;
                }

                // Configure factories for this chain
                const factories = {};
                for (const [dexName, dexConfig] of Object.entries(config.dex)) {
                    if (dexConfig.enabled && dexConfig.factory) {
                        factories[dexName] = dexConfig.factory;
                    }
                }
                this.newPairMonitor.setFactories(chainId, factories);
                this.newPairMonitor.setKnownTokens(chainId, config.tokens);

                // Subscribe to factory events
                await this.newPairMonitor.subscribe(chainId, wsProvider);
                this.setupNewPairHandlers();

                log.info('New pair monitor started', {
                    chainId,
                    factories: Object.keys(factories).length,
                    minLiquidityUSD: this.newPairMonitor.minLiquidityUSD,
                });
            } catch (error) {
                log.warn('New pair monitor failed to start', { error: error.message });
            }
        }

        // Configure block time predictor for optimal transaction timing
        const activeChainId = config.chainId || 56;
        blockTimePredictor.setActiveChain(activeChainId);

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
     * FIX v3.4: Guard against duplicate handler registration
     * FIX v3.4: Store handler references for proper cleanup in stop()
     */
    setupSingleChainEventHandlers() {
        if (this.singleChainHandlersSetup) {
            log.debug('Single-chain handlers already set up, skipping');
            return;
        }
        this.singleChainHandlersSetup = true;

        // FIX v3.4: Create named handlers and store references
        this._handlers.blockMonitor.newBlock = async (blockData) => {
            await this.handleNewBlock(blockData);
        };
        this._handlers.blockMonitor.error = (error) => {
            log.error('Block monitor error', { error: error.message });
        };
        this._handlers.rpcManager.endpointUnhealthy = (endpoint) => {
            log.warn(`RPC endpoint unhealthy: ${endpoint}`);
        };

        // Handle new blocks
        blockMonitor.on('newBlock', this._handlers.blockMonitor.newBlock);

        // Handle errors
        blockMonitor.on('error', this._handlers.blockMonitor.error);

        // Handle RPC manager events
        rpcManager.on('endpointUnhealthy', this._handlers.rpcManager.endpointUnhealthy);
    }

    /**
     * Set up event handlers for event-driven detection
     * Processes Sync events in real-time for faster opportunity detection
     * FIX v3.4: Guard against duplicate handler registration
     * FIX v3.4: Store handler references for proper cleanup in stop()
     */
    setupEventDrivenHandlers() {
        if (this.eventDrivenHandlersSetup) {
            log.debug('Event-driven handlers already set up, skipping');
            return;
        }
        this.eventDrivenHandlersSetup = true;

        // FIX v3.4: Create named handlers and store references for cleanup
        this._handlers.eventDrivenDetector.reserveUpdate = async (data) => {
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
        };

        this._handlers.crossPoolCorrelation.checkCorrelated = async (correlationData) => {
            await this.handleCorrelatedPoolCheck(correlationData);
        };

        this._handlers.reserveDifferentialAnalyzer.correlatedOpportunity = async (data) => {
            await this.handleDifferentialOpportunity(data);
        };

        this._handlers.dexAggregator.opportunity = async (opportunity) => {
            await this.handleAggregatorOpportunity(opportunity);
        };

        this._handlers.whaleTracker.whaleActivity = async (signal) => {
            await this.handleWhaleActivity(signal);
        };

        this._handlers.statisticalArbitrageDetector.statisticalSignal = async (signal) => {
            await this.handleStatisticalSignal(signal);
        };

        this._handlers.eventDrivenDetector.swapDetected = (swapData) => {
            this.handleSwapForWhaleTracking(swapData);
        };

        this._handlers.eventDrivenDetector.priceChange = (data) => {
            log.debug(`Sync event: ${data.pairKey} on ${data.dexName}`, {
                blockNumber: data.blockNumber,
            });
        };

        this._handlers.eventDrivenDetector.v3PriceUpdate = async (data) => {
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
        };

        // Liquidation monitor handlers
        this._handlers.liquidationMonitor.opportunity = async (opportunity) => {
            await this.handleLiquidationOpportunity(opportunity);
        };

        this._handlers.liquidationMonitor.liquidation = (data) => {
            log.debug(`Liquidation detected on ${data.protocol}`, {
                collateral: `${data.collateralAmount?.toFixed(4)} ${data.collateralSymbol}`,
                valueUSD: data.collateralValueUSD?.toFixed(2),
                liquidator: data.liquidator?.slice(0, 10) + '...',
            });
        };

        // Register all handlers with their emitters
        eventDrivenDetector.on('reserveUpdate', this._handlers.eventDrivenDetector.reserveUpdate);
        crossPoolCorrelation.on('checkCorrelated', this._handlers.crossPoolCorrelation.checkCorrelated);
        reserveDifferentialAnalyzer.on('correlatedOpportunity', this._handlers.reserveDifferentialAnalyzer.correlatedOpportunity);
        dexAggregator.on('opportunity', this._handlers.dexAggregator.opportunity);
        whaleTracker.on('whaleActivity', this._handlers.whaleTracker.whaleActivity);
        statisticalArbitrageDetector.on('statisticalSignal', this._handlers.statisticalArbitrageDetector.statisticalSignal);
        liquidationMonitor.on('opportunity', this._handlers.liquidationMonitor.opportunity);
        liquidationMonitor.on('liquidation', this._handlers.liquidationMonitor.liquidation);
        eventDrivenDetector.on('swapDetected', this._handlers.eventDrivenDetector.swapDetected);
        eventDrivenDetector.on('priceChange', this._handlers.eventDrivenDetector.priceChange);
        eventDrivenDetector.on('v3PriceUpdate', this._handlers.eventDrivenDetector.v3PriceUpdate);

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
     * Handle liquidation backrun opportunity
     * Triggered when a profitable liquidation event is detected on Aave V3 or Compound V3
     *
     * Strategy: When a liquidation occurs, the liquidator receives collateral at a discount.
     * This collateral is often sold immediately on DEXes, creating price impact that can be
     * arbitraged by buying the discounted collateral.
     *
     * @param {Object} opportunity - Liquidation opportunity from LiquidationMonitor
     */
    async handleLiquidationOpportunity(opportunity) {
        if (!opportunity) return;

        this.eventDrivenStats.opportunitiesFromLiquidations++;
        dashboard.recordOpportunities(1);

        log.info(`[LIQUIDATION] Backrun opportunity detected`, {
            type: opportunity.type,
            protocol: opportunity.protocol,
            collateral: `${opportunity.collateralAmount?.toFixed(4)} ${opportunity.collateralSymbol}`,
            valueUSD: `$${opportunity.collateralValueUSD?.toFixed(2)}`,
            estimatedProfit: `$${opportunity.estimatedProfitUSD?.toFixed(2)}`,
            liquidator: opportunity.liquidator?.slice(0, 10) + '...',
            txHash: opportunity.transactionHash?.slice(0, 14) + '...',
        });

        // Record with adaptive prioritizer to boost collateral token pairs
        const pairKeyWithSource = `${opportunity.collateralSymbol}/WETH:liquidation`;
        adaptivePrioritizer.recordOpportunity(pairKeyWithSource, {
            volumeUSD: opportunity.collateralValueUSD || 1000,
            priority: 2, // High priority for liquidation backruns
        });

        // Convert to standard opportunity format for alerting
        const standardOpportunity = {
            type: opportunity.type,
            protocol: opportunity.protocol,
            pairKey: `${opportunity.collateralSymbol}/${opportunity.debtSymbol || 'USDC'}`,
            collateralSymbol: opportunity.collateralSymbol,
            collateralAmount: opportunity.collateralAmount,
            collateralValueUSD: opportunity.collateralValueUSD,
            profitUSD: opportunity.estimatedProfitUSD,
            profitPercent: opportunity.estimatedSlippagePercent,
            liquidationBonusPercent: opportunity.liquidationBonusPercent,
            liquidator: opportunity.liquidator,
            transactionHash: opportunity.transactionHash,
            blockNumber: opportunity.blockNumber,
            source: 'liquidation-monitor',
            timestamp: opportunity.timestamp,
            chainId: opportunity.chainId,
        };

        // Send alert
        await alertManager.notify(standardOpportunity);

        // Note: Liquidation backrun execution requires:
        // 1. Fast detection (within same block or next block)
        // 2. Knowing which DEX the liquidator will sell on
        // 3. MEV protection (Flashbots) to avoid being frontrun
        // For now, we alert and log - execution is a future enhancement (Task 3.3)
        if (config.execution?.enabled && config.execution?.liquidationEnabled) {
            log.info('[LIQUIDATION] Execution enabled but backrun logic not yet implemented (Task 3.3)');
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
     * Set up event handlers for stablecoin depeg detection (P1)
     * Monitors for depeg events and stablecoin arbitrage opportunities
     */
    setupStablecoinHandlers() {
        if (!this.stablecoinDetector) return;

        // Handle severe depeg alerts
        this._handlers.stablecoinDetector.severeDepeg = async (depeg) => {
            log.warn(`[STABLECOIN] SEVERE DEPEG: ${depeg.stablecoin}`, {
                deviation: `${(depeg.deviation * 100).toFixed(3)}%`,
                chainId: depeg.chainId,
            });

            // Alert on severe depegs (potential arbitrage opportunity)
            await alertManager.notify({
                type: 'stablecoin-depeg',
                severity: 'severe',
                stablecoin: depeg.stablecoin,
                deviation: depeg.deviation,
                chainId: depeg.chainId,
                timestamp: Date.now(),
            });
        };

        // Handle stablecoin arbitrage opportunities
        this._handlers.stablecoinDetector.opportunity = async (opportunity) => {
            this.eventDrivenStats.opportunitiesFromStablecoin++;
            dashboard.recordOpportunities(1);

            log.info(`[STABLECOIN] Arbitrage opportunity`, {
                type: opportunity.type,
                pair: opportunity.pairKey,
                profit: `$${opportunity.estimatedProfitUSD?.toFixed(2)}`,
                spread: `${(opportunity.spreadPercent * 100).toFixed(3)}%`,
            });

            // Record with adaptive prioritizer
            if (opportunity.pairKey) {
                adaptivePrioritizer.recordOpportunity(`${opportunity.pairKey}:stablecoin`, {
                    volumeUSD: opportunity.estimatedProfitUSD * 100, // Approximate trade size
                    priority: 2, // High priority for stablecoin opps
                });
            }

            // Send alert
            await alertManager.notify({
                ...opportunity,
                source: 'stablecoin-detector',
            });

            // Execute if enabled
            if (config.execution?.enabled && config.execution?.stablecoinEnabled) {
                if (this.shouldExecuteWithWhaleCheck(opportunity)) {
                    const result = await executionManager.execute(opportunity);
                    if (result.simulated) {
                        dashboard.recordSimulation(result.success);
                    } else if (result.success) {
                        dashboard.recordExecution(true, opportunity.estimatedProfitUSD || 0);
                    } else {
                        dashboard.recordExecution(false);
                    }
                }
            }
        };

        // Register handlers
        this.stablecoinDetector.on('severeDepeg', this._handlers.stablecoinDetector.severeDepeg);
        this.stablecoinDetector.on('opportunity', this._handlers.stablecoinDetector.opportunity);

        log.info('Stablecoin detection handlers registered');
    }

    /**
     * Set up event handlers for new pair monitoring (P2)
     * Monitors DEX factory contracts for new pool creation
     */
    setupNewPairHandlers() {
        if (!this.newPairMonitor) return;

        // Handle new pair creation events
        this._handlers.newPairMonitor.newPair = async (pairData) => {
            log.info(`[NEW PAIR] Detected: ${pairData.token0Symbol}/${pairData.token1Symbol}`, {
                dex: pairData.dexName,
                pairAddress: pairData.pairAddress?.slice(0, 14) + '...',
                blockNumber: pairData.blockNumber,
            });

            // Add to token list for monitoring (if known tokens)
            if (pairData.token0Address && pairData.token1Address) {
                // Cache the new pair for price fetching
                cacheManager.recordNewPair(pairData);
            }
        };

        // Handle new pair arbitrage opportunities
        this._handlers.newPairMonitor.opportunity = async (opportunity) => {
            this.eventDrivenStats.opportunitiesFromNewPairs++;
            dashboard.recordOpportunities(1);

            log.info(`[NEW PAIR] Arbitrage opportunity on new pool`, {
                pair: opportunity.pairKey,
                dex: opportunity.dexName,
                spread: `${opportunity.spreadPercent?.toFixed(3)}%`,
                liquidityUSD: `$${opportunity.liquidityUSD?.toFixed(0)}`,
                ageMinutes: opportunity.ageMinutes?.toFixed(1),
            });

            // Record with adaptive prioritizer (high priority for new pairs)
            adaptivePrioritizer.recordOpportunity(`${opportunity.pairKey}:newpair`, {
                volumeUSD: opportunity.liquidityUSD || 1000,
                priority: 3, // Very high priority for new pair opps
            });

            // Send alert
            await alertManager.notify({
                ...opportunity,
                type: 'new-pair-arbitrage',
                source: 'new-pair-monitor',
            });

            // Execute if enabled (careful with new pairs - lower liquidity)
            if (config.execution?.enabled && config.execution?.newPairEnabled) {
                // Additional liquidity check for new pairs
                if (opportunity.liquidityUSD >= (config.newPairs?.minLiquidityUSD || 5000)) {
                    if (this.shouldExecuteWithWhaleCheck(opportunity)) {
                        const result = await executionManager.execute(opportunity);
                        if (result.simulated) {
                            dashboard.recordSimulation(result.success);
                        } else if (result.success) {
                            dashboard.recordExecution(true, opportunity.profitCalculation?.netProfitUSD || 0);
                        } else {
                            dashboard.recordExecution(false);
                        }
                    }
                } else {
                    log.debug('[NEW PAIR] Skipping execution - insufficient liquidity', {
                        liquidityUSD: opportunity.liquidityUSD,
                        minRequired: config.newPairs?.minLiquidityUSD || 5000,
                    });
                }
            }
        };

        // Register handlers
        this.newPairMonitor.on('newPair', this._handlers.newPairMonitor.newPair);
        this.newPairMonitor.on('opportunity', this._handlers.newPairMonitor.opportunity);

        log.info('New pair monitoring handlers registered');
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

        // FIX v3.1: Queue events instead of dropping them
        // If already processing, add to queue (with size limit)
        if (this.processingEvent) {
            if (this.eventQueue.length < this.maxEventQueueSize) {
                // Deduplicate: only queue if this pair isn't already queued
                const alreadyQueued = this.eventQueue.some(e => e.pairKey === pairKey && e.dexName === dexName);
                if (!alreadyQueued) {
                    this.eventQueue.push(data);
                }
            } else {
                this.eventDrivenStats.droppedEvents++;
                log.debug(`Event queue full, dropping event for ${pairKey}`);
            }
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

            // FIX v3.4: Atomically check and schedule queue processing
            // Use synchronous flag check to prevent race condition
            this._scheduleQueueProcessing();
        }
    }

    /**
     * Safely schedule queue processing without race conditions
     * FIX v3.4: Atomic check-and-set pattern
     * @private
     */
    _scheduleQueueProcessing() {
        // Only schedule if queue has items AND not already processing
        if (this.eventQueue.length > 0 && !this.eventQueueProcessing) {
            this.eventQueueProcessing = true;
            // Use setImmediate to allow other I/O to complete first
            setImmediate(() => this._processEventQueue());
        }
    }

    /**
     * Process queued events sequentially
     * FIX v3.4: Safe queue processing with proper flag management
     * @private
     */
    async _processEventQueue() {
        try {
            while (this.eventQueue.length > 0 && this.isRunning) {
                // Atomically remove item from queue
                const nextEvent = this.eventQueue.shift();
                if (nextEvent) {
                    // Process without recursive flag manipulation
                    await this._processQueuedEvent(nextEvent);
                }
            }
        } finally {
            // Reset flag AFTER loop completes
            this.eventQueueProcessing = false;

            // FIX v3.4: Re-check queue - items may have been added during processing
            // This prevents missed events from race window
            if (this.eventQueue.length > 0 && this.isRunning) {
                this._scheduleQueueProcessing();
            }
        }
    }

    /**
     * Process a single queued event (called from queue processor)
     * FIX v3.4: Separate handler to avoid recursive processingEvent manipulation
     * @private
     */
    async _processQueuedEvent(data) {
        const { pairKey, blockNumber } = data;
        const startTime = Date.now();

        try {
            const prices = {};
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

            if (prices[pairKey] && Object.keys(prices[pairKey]).length >= 2) {
                const opportunities = await arbitrageDetector.detectOpportunities(prices, blockNumber);

                if (opportunities.length > 0) {
                    this.eventDrivenStats.opportunitiesFromEvents += opportunities.length;
                    dashboard.recordOpportunities(opportunities.length);

                    for (const opportunity of opportunities) {
                        opportunity.source = 'queued-event';
                        opportunity.detectionLatencyMs = Date.now() - data.timestamp;
                        await alertManager.notify(opportunity);

                        if (config.execution?.enabled) {
                            if (this.shouldExecuteWithWhaleCheck(opportunity)) {
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
            }
        } catch (error) {
            log.error('Error processing queued event', { error: error.message, pairKey });
            dashboard.recordError();
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
     * FIX v3.4: Guard against duplicate handler registration
     * FIX v3.4: Store handler references for proper cleanup in stop()
     */
    setupMultiChainEventHandlers() {
        if (!this.workerCoordinator) return;

        if (this.multiChainHandlersSetup) {
            log.debug('Multi-chain handlers already set up, skipping');
            return;
        }
        this.multiChainHandlersSetup = true;

        // FIX v3.4: Create named handlers and store references for cleanup
        this._handlers.workerCoordinator.opportunities = async (data) => {
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
        };

        this._handlers.workerCoordinator.workerError = ({ chainId, error }) => {
            log.error(`Worker ${formatChain(chainId)} error: ${error?.message || error}`);
            dashboard.recordError();
        };

        this._handlers.workerCoordinator.workerStarted = ({ chainId }) => {
            log.debug(`Worker ${formatChain(chainId)} started`);
        };

        this._handlers.workerCoordinator.workerStopped = ({ chainId }) => {
            log.debug(`Worker ${formatChain(chainId)} stopped`);
        };

        // Register workerCoordinator handlers
        this.workerCoordinator.on('opportunities', this._handlers.workerCoordinator.opportunities);
        this.workerCoordinator.on('workerError', this._handlers.workerCoordinator.workerError);
        this.workerCoordinator.on('workerStarted', this._handlers.workerCoordinator.workerStarted);
        this.workerCoordinator.on('workerStopped', this._handlers.workerCoordinator.workerStopped);

        // Handle cross-chain opportunities
        if (this.crossChainDetector) {
            this._handlers.crossChainDetector.crossChainOpportunity = async (opportunity) => {
                log.info(`🌐 Cross-chain: ${opportunity.token} | ${formatChain(opportunity.buyChain)}→${formatChain(opportunity.sellChain)} | Spread: ${formatPercent(opportunity.spreadPercent)} | Net: ${formatPercent(opportunity.netProfitPercent)}`);

                // Send alert for cross-chain opportunity
                await alertManager.notify({
                    ...opportunity,
                    type: 'cross-chain',
                });

                dashboard.recordOpportunities(1);
            };
            this.crossChainDetector.on('crossChainOpportunity', this._handlers.crossChainDetector.crossChainOpportunity);
        }

        // Handle mempool events (debug level - can be noisy)
        if (this.mempoolMonitor) {
            this._handlers.mempoolMonitor.largeSwap = (swapInfo) => {
                log.debug(`🔮 Mempool: ${swapInfo.method} | ${swapInfo.txHash?.slice(0, 14)}... | ${swapInfo.value}`);
            };
            this.mempoolMonitor.on('largeSwap', this._handlers.mempoolMonitor.largeSwap);
        }
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

            // ==================== P1: STABLECOIN DEPEG DETECTION ====================
            // Analyze stablecoin pairs for depeg opportunities
            // High-profit during market stress events
            let stablecoinOpportunities = [];
            if (this.stablecoinDetector) {
                try {
                    const chainId = config.chainId || 56;
                    stablecoinOpportunities = this.stablecoinDetector.analyzeStablecoins(
                        chainId,
                        prices,
                        blockNumber
                    );

                    if (stablecoinOpportunities.length > 0) {
                        this.eventDrivenStats.opportunitiesFromStablecoin += stablecoinOpportunities.length;
                        log.info(`[STABLECOIN] Found ${stablecoinOpportunities.length} stablecoin opportunities`, {
                            bestProfit: `$${stablecoinOpportunities[0]?.estimatedProfitUSD?.toFixed(2)}`,
                        });
                    }
                } catch (error) {
                    log.debug('Stablecoin detection error', { error: error.message });
                }
            }

            const allOpportunities = [...opportunities, ...multiHopOpportunities, ...v2v3Opportunities, ...stablecoinOpportunities];

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
     * FIX v3.1: Added graceful shutdown with in-flight operation handling
     */
    async stop() {
        if (!this.isRunning) {
            return;
        }

        log.info('Stopping Arbitrage Bot (graceful shutdown)...');
        this.isRunning = false;

        // FIX v3.1: Set up shutdown timeout to prevent hanging
        const shutdownTimeout = setTimeout(() => {
            log.warn('Graceful shutdown timeout reached, forcing exit');
            process.exit(1);
        }, 30000); // 30 second timeout

        try {
            // FIX v3.1: Wait for in-flight operations to complete
            await this._waitForInFlightOperations();

            if (this.multiChainMode) {
                await this.stopMultiChain();
            } else {
                await this.stopSingleChain();
            }

            // FIX v3.1: Stop execution manager cleanup interval
            executionManager.stopCleanup();

            // FIX v3.1: Save persistent cache before shutdown
            await cacheManager.savePersistentCache();
            log.info('Persistent cache saved');

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
        } finally {
            clearTimeout(shutdownTimeout);
        }
    }

    /**
     * Wait for in-flight operations to complete
     * FIX v3.1: Prevents data loss/corruption during shutdown
     * @private
     */
    async _waitForInFlightOperations() {
        const maxWait = 10000; // 10 seconds max wait
        const startTime = Date.now();

        // Wait for block processing to complete
        if (this.processingBlock) {
            log.info('Waiting for block processing to complete...');
            while (this.processingBlock && Date.now() - startTime < maxWait) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            if (this.processingBlock) {
                log.warn('Block processing still in progress after timeout');
            }
        }

        // Wait for event processing to complete
        if (this.processingEvent) {
            log.info('Waiting for event processing to complete...');
            while (this.processingEvent && Date.now() - startTime < maxWait) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }

        // Drain event queue
        if (this.eventQueue.length > 0) {
            log.info(`Draining ${this.eventQueue.length} queued events...`);
            this.eventQueue = []; // Clear queue rather than processing during shutdown
        }

        // Wait for execution to complete
        if (executionManager.isExecuting) {
            log.info('Waiting for execution to complete...');
            while (executionManager.isExecuting && Date.now() - startTime < maxWait) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            if (executionManager.isExecuting) {
                log.warn('Execution still in progress after timeout');
            }
        }

        log.debug('In-flight operations completed or timed out');
    }

    /**
     * Remove all registered event handlers
     * FIX v3.4: Prevents memory leaks from accumulated listeners
     * @private
     */
    _removeAllEventHandlers() {
        // Remove single-chain handlers
        if (this._handlers.blockMonitor.newBlock) {
            blockMonitor.off('newBlock', this._handlers.blockMonitor.newBlock);
        }
        if (this._handlers.blockMonitor.error) {
            blockMonitor.off('error', this._handlers.blockMonitor.error);
        }
        if (this._handlers.rpcManager.endpointUnhealthy) {
            rpcManager.off('endpointUnhealthy', this._handlers.rpcManager.endpointUnhealthy);
        }

        // Remove event-driven handlers
        if (this._handlers.eventDrivenDetector.reserveUpdate) {
            eventDrivenDetector.off('reserveUpdate', this._handlers.eventDrivenDetector.reserveUpdate);
        }
        if (this._handlers.eventDrivenDetector.swapDetected) {
            eventDrivenDetector.off('swapDetected', this._handlers.eventDrivenDetector.swapDetected);
        }
        if (this._handlers.eventDrivenDetector.priceChange) {
            eventDrivenDetector.off('priceChange', this._handlers.eventDrivenDetector.priceChange);
        }
        if (this._handlers.eventDrivenDetector.v3PriceUpdate) {
            eventDrivenDetector.off('v3PriceUpdate', this._handlers.eventDrivenDetector.v3PriceUpdate);
        }
        if (this._handlers.crossPoolCorrelation.checkCorrelated) {
            crossPoolCorrelation.off('checkCorrelated', this._handlers.crossPoolCorrelation.checkCorrelated);
        }
        if (this._handlers.reserveDifferentialAnalyzer.correlatedOpportunity) {
            reserveDifferentialAnalyzer.off('correlatedOpportunity', this._handlers.reserveDifferentialAnalyzer.correlatedOpportunity);
        }
        if (this._handlers.dexAggregator.opportunity) {
            dexAggregator.off('opportunity', this._handlers.dexAggregator.opportunity);
        }
        if (this._handlers.whaleTracker.whaleActivity) {
            whaleTracker.off('whaleActivity', this._handlers.whaleTracker.whaleActivity);
        }
        if (this._handlers.statisticalArbitrageDetector.statisticalSignal) {
            statisticalArbitrageDetector.off('statisticalSignal', this._handlers.statisticalArbitrageDetector.statisticalSignal);
        }
        if (this._handlers.liquidationMonitor.opportunity) {
            liquidationMonitor.off('opportunity', this._handlers.liquidationMonitor.opportunity);
        }
        if (this._handlers.liquidationMonitor.liquidation) {
            liquidationMonitor.off('liquidation', this._handlers.liquidationMonitor.liquidation);
        }

        // Remove P1/P2 handlers (stablecoin & new pair)
        if (this.stablecoinDetector) {
            if (this._handlers.stablecoinDetector.severeDepeg) {
                this.stablecoinDetector.off('severeDepeg', this._handlers.stablecoinDetector.severeDepeg);
            }
            if (this._handlers.stablecoinDetector.opportunity) {
                this.stablecoinDetector.off('opportunity', this._handlers.stablecoinDetector.opportunity);
            }
        }
        if (this.newPairMonitor) {
            if (this._handlers.newPairMonitor.newPair) {
                this.newPairMonitor.off('newPair', this._handlers.newPairMonitor.newPair);
            }
            if (this._handlers.newPairMonitor.opportunity) {
                this.newPairMonitor.off('opportunity', this._handlers.newPairMonitor.opportunity);
            }
        }

        // Remove multi-chain handlers
        if (this.workerCoordinator) {
            if (this._handlers.workerCoordinator.opportunities) {
                this.workerCoordinator.off('opportunities', this._handlers.workerCoordinator.opportunities);
            }
            if (this._handlers.workerCoordinator.workerError) {
                this.workerCoordinator.off('workerError', this._handlers.workerCoordinator.workerError);
            }
            if (this._handlers.workerCoordinator.workerStarted) {
                this.workerCoordinator.off('workerStarted', this._handlers.workerCoordinator.workerStarted);
            }
            if (this._handlers.workerCoordinator.workerStopped) {
                this.workerCoordinator.off('workerStopped', this._handlers.workerCoordinator.workerStopped);
            }
        }
        if (this.crossChainDetector && this._handlers.crossChainDetector.crossChainOpportunity) {
            this.crossChainDetector.off('crossChainOpportunity', this._handlers.crossChainDetector.crossChainOpportunity);
        }
        if (this.mempoolMonitor && this._handlers.mempoolMonitor.largeSwap) {
            this.mempoolMonitor.off('largeSwap', this._handlers.mempoolMonitor.largeSwap);
        }

        // Clear handler references
        this._handlers = {
            blockMonitor: {},
            rpcManager: {},
            eventDrivenDetector: {},
            crossPoolCorrelation: {},
            reserveDifferentialAnalyzer: {},
            dexAggregator: {},
            whaleTracker: {},
            statisticalArbitrageDetector: {},
            liquidationMonitor: {},
            stablecoinDetector: {},
            newPairMonitor: {},
            workerCoordinator: {},
            crossChainDetector: {},
            mempoolMonitor: {},
        };

        // Reset setup flags
        this.singleChainHandlersSetup = false;
        this.eventDrivenHandlersSetup = false;
        this.multiChainHandlersSetup = false;

        log.debug('All event handlers removed');
    }

    /**
     * Stop single-chain mode components
     * FIX v3.4: Added event handler cleanup
     */
    async stopSingleChain() {
        // FIX v3.4: Remove event handlers first to prevent memory leaks
        this._removeAllEventHandlers();

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

        // FIX v3.1: Stop whale tracker cleanup interval
        whaleTracker.stop();
        log.info('Whale tracker stopped', {
            stats: whaleTracker.getStats(),
        });

        // Stop liquidation monitor
        await liquidationMonitor.stop();
        log.info('Liquidation monitor stopped', {
            stats: liquidationMonitor.getStats(),
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

        // Stop P1/P2 components: stablecoin detector and new pair monitor
        if (this.stablecoinDetector) {
            log.info('Stablecoin detector stats:', {
                stats: this.stablecoinDetector.stats,
            });
            this.stablecoinDetector = null;
        }

        if (this.newPairMonitor) {
            this.newPairMonitor.unsubscribeAll?.();
            log.info('New pair monitor stats:', {
                stats: this.newPairMonitor.stats,
            });
            this.newPairMonitor = null;
        }

        // Log event-driven vs block-based stats
        log.info('Detection source statistics:', {
            fromEvents: this.eventDrivenStats.opportunitiesFromEvents,
            fromBlocks: this.eventDrivenStats.opportunitiesFromBlocks,
            fromDifferential: this.eventDrivenStats.opportunitiesFromDifferential,
            fromV2V3: this.eventDrivenStats.opportunitiesFromV2V3,
            fromFeeTier: this.eventDrivenStats.opportunitiesFromFeeTier,
            fromStatistical: this.eventDrivenStats.opportunitiesFromStatistical,
            fromLiquidations: this.eventDrivenStats.opportunitiesFromLiquidations,
            fromStablecoin: this.eventDrivenStats.opportunitiesFromStablecoin,
            fromNewPairs: this.eventDrivenStats.opportunitiesFromNewPairs,
        });

        // Log execution stats if enabled
        if (config.execution?.enabled) {
            const execStats = executionManager.getStats();
            log.info('Execution statistics:', execStats);
        }
    }

    /**
     * Stop multi-chain mode components
     * FIX v3.4: Added event handler cleanup
     */
    async stopMultiChain() {
        // FIX v3.4: Remove event handlers first to prevent memory leaks
        this._removeAllEventHandlers();

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
                liquidationMonitor: liquidationMonitor.getStats(),
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
        // Don't exit - allow the bot to continue running for non-fatal rejections
    });

    // Handle Node.js warnings (deprecation notices, etc.)
    process.on('warning', (warning) => {
        log.warn('Node.js Warning', {
            name: warning.name,
            message: warning.message,
            stack: warning.stack,
        });
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
