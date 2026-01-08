import { ethers } from 'ethers';
import rpcManager from '../utils/rpcManager.js';
import transactionBuilder from './transactionBuilder.js';
import gasOptimizer from './gasOptimizer.js';
import flashLoanOptimizer from './flashLoanOptimizer.js';
import flashbotsProvider from './flashbotsProvider.js';
import executionSimulator from './executionSimulator.js';
import cacheManager from '../data/cacheManager.js';
import blockMonitor from '../monitoring/blockMonitor.js';
import config from '../config.js';
import log from '../utils/logger.js';
import { FACTORY_ABI } from '../contracts/abis.js';
import gasPriceCache from '../utils/gasPriceCache.js';
import speedMetrics from '../utils/speedMetrics.js';

/**
 * Execution Manager
 *
 * Manages the complete execution lifecycle for arbitrage opportunities:
 * 1. Pre-flight validation (opportunity still valid?)
 * 2. Transaction building
 * 3. Simulation (eth_call)
 * 4. Execution (if live mode)
 * 5. Result tracking
 *
 * Supports two modes:
 * - simulation: Validates transactions without sending them
 * - live: Actually executes trades
 */
class ExecutionManager {
    constructor() {
        // Execution mode: 'simulation' or 'live'
        this.mode = config.execution?.mode || 'simulation';

        // Wallet signer (only needed for live mode)
        this.signer = null;

        // Execution state
        this.isExecuting = false;
        this.pendingTx = null;

        // FIX v3.1: Track potentially pending transactions from timeouts
        // These txs may still confirm later even though we timed out waiting
        this.timedOutTxs = new Map(); // hash -> { timestamp, opportunity }

        // Statistics
        this.stats = {
            simulationsRun: 0,
            simulationsSuccess: 0,
            simulationsFailed: 0,
            executionsRun: 0,
            executionsSuccess: 0,
            executionsFailed: 0,
            totalProfitUSD: 0,
            // Improvement v2.0: Pre-simulation filtering stats
            preSimulationsRun: 0,
            preSimulationsSkipped: 0,
            preSimulationsProceeded: 0,
            // Task 3.3: Liquidation backrun stats
            liquidationBackrunsAttempted: 0,
            liquidationBackrunsSuccess: 0,
            liquidationBackrunsFailed: 0,
            liquidationBackrunProfitUSD: 0,
            // Task 3.4: Flashbots stats
            flashbotsExecutions: 0,
            flashbotsSuccess: 0,
            flashbotsFailed: 0,
        };

        // Task 3.4: Flashbots configuration
        this.flashbotsEnabled = config.flashbots?.enabled !== false;
        this.flashbotsInitialized = false;

        // Recent executions for analysis
        this.recentExecutions = [];
        this.maxRecentExecutions = 100;

        // FIX v3.1: Cleanup interval for timedOutTxs to prevent unbounded growth
        this.timedOutTxCleanupInterval = null;
        this.timedOutTxMaxAge = 24 * 60 * 60 * 1000; // 24 hours
        // FIX v3.4: Maximum size limit to prevent memory issues from burst timeouts
        this.timedOutTxMaxSize = 1000;

        log.info('Execution Manager initialized', {
            mode: this.mode,
            contractConfigured: !!config.execution?.contractAddress,
        });
    }

    /**
     * Initialize the execution manager
     *
     * @param {Object} options - Initialization options
     */
    async initialize(options = {}) {
        // Set contract address if provided
        if (options.contractAddress) {
            transactionBuilder.setContractAddress(options.contractAddress);
        } else if (config.execution?.contractAddress) {
            transactionBuilder.setContractAddress(config.execution.contractAddress);
        }

        // Initialize flash loan optimizer with chain ID
        // FIX v3.6: Standardized chainId access path for consistency
        const chainId = config.network?.chainId || config.chainId || 56; // Default to BSC
        await flashLoanOptimizer.initialize(chainId);
        log.info('Flash loan optimizer initialized', {
            chainId,
            providers: flashLoanOptimizer.getAvailableProviders().map(p => p.name),
        });

        // Initialize signer for live mode
        if (this.mode === 'live' && config.execution?.privateKey) {
            const provider = await this._getProvider();
            this.signer = new ethers.Wallet(config.execution.privateKey, provider);
            log.info('Signer initialized', { address: this.signer.address });
        }

        // ==================== SPEED OPT: WARM FLASH PAIR CACHE ====================
        // Pre-resolve top trading pairs to eliminate RPC latency during execution
        // Expected improvement: -50-200ms on first execution
        await this._warmFlashPairCache();

        // FIX v3.1: Start cleanup interval for timedOutTxs
        this._startTimedOutTxCleanup();

        // ==================== Task 3.4: FLASHBOTS INTEGRATION ====================
        // Initialize Flashbots for MEV protection on Ethereum mainnet
        await this._initializeFlashbots(chainId);

        log.info('Execution Manager ready', { mode: this.mode, flashbots: this.flashbotsInitialized });
    }

    /**
     * Start periodic cleanup of timed-out transactions
     * FIX v3.1: Prevents unbounded memory growth from timedOutTxs Map
     * @private
     */
    _startTimedOutTxCleanup() {
        // Clean up every hour
        this.timedOutTxCleanupInterval = setInterval(() => {
            this._cleanupTimedOutTxs();
        }, 60 * 60 * 1000);

        log.debug('Started timedOutTxs cleanup interval');
    }

    /**
     * Clean up old timed-out transactions
     * FIX v3.1: Removes transactions older than 24 hours
     * @private
     */
    _cleanupTimedOutTxs() {
        const now = Date.now();
        let cleaned = 0;

        for (const [hash, data] of this.timedOutTxs.entries()) {
            if (now - data.timestamp > this.timedOutTxMaxAge) {
                this.timedOutTxs.delete(hash);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            log.debug(`Cleaned up ${cleaned} timed-out transactions`, {
                remaining: this.timedOutTxs.size,
            });
        }
    }

    /**
     * Stop cleanup interval and perform final cleanup
     * FIX v3.1: Called during graceful shutdown
     */
    stopCleanup() {
        if (this.timedOutTxCleanupInterval) {
            clearInterval(this.timedOutTxCleanupInterval);
            this.timedOutTxCleanupInterval = null;
            log.debug('Stopped timedOutTxs cleanup interval');
        }
    }

    /**
     * Evict the lowest-value timed-out transaction to make room for new ones
     *
     * FIX v3.5: Priority-based eviction strategy
     * - Keeps high-value pending transactions
     * - Evicts lowest profitUSD transaction first
     * - Falls back to oldest if all have same value
     *
     * @private
     */
    _evictLowestValueTimedOutTx() {
        if (this.timedOutTxs.size === 0) return;

        let lowestValueKey = null;
        let lowestValue = Infinity;
        let oldestKey = null;
        let oldestTimestamp = Infinity;

        for (const [hash, data] of this.timedOutTxs.entries()) {
            const profitUSD = data.opportunity?.profitUSD || 0;

            // Track lowest value
            if (profitUSD < lowestValue) {
                lowestValue = profitUSD;
                lowestValueKey = hash;
            }

            // Track oldest as fallback
            if (data.timestamp < oldestTimestamp) {
                oldestTimestamp = data.timestamp;
                oldestKey = hash;
            }
        }

        // Prefer evicting lowest value, fall back to oldest
        const keyToEvict = lowestValueKey || oldestKey;
        if (keyToEvict) {
            const evictedData = this.timedOutTxs.get(keyToEvict);
            this.timedOutTxs.delete(keyToEvict);
            log.debug('Evicted lowest-value timed-out tx due to size limit', {
                evictedHash: keyToEvict.slice(0, 10) + '...',
                evictedProfitUSD: evictedData?.opportunity?.profitUSD?.toFixed(2) || '0',
                currentSize: this.timedOutTxs.size,
            });
        }
    }

    /**
     * Pre-warm flash pair cache with common trading pairs
     *
     * SPEED OPTIMIZATION: Resolves flash pair addresses at startup
     * to avoid RPC calls during time-critical execution.
     *
     * @private
     */
    async _warmFlashPairCache() {
        const startTime = performance.now();

        try {
            // Get top tokens from config
            const tokens = Object.entries(config.tokens || {})
                .filter(([_, token]) => token.address)
                .slice(0, 20); // Top 20 tokens

            if (tokens.length < 2) {
                log.debug('Not enough tokens to warm flash pair cache');
                return;
            }

            // Get primary DEX factory
            const primaryDex = Object.entries(config.dex || {})
                .find(([_, d]) => d.enabled && d.factory);

            if (!primaryDex) {
                log.debug('No DEX factory configured for flash pair cache');
                return;
            }

            const [dexName, dexConfig] = primaryDex;
            const factory = new ethers.Contract(
                dexConfig.factory,
                FACTORY_ABI,
                (await rpcManager.getHttpProvider()).provider
            );

            // Resolve pairs for top tokens with wrapped native
            const nativeToken = config.nativeToken?.address;
            const stablecoins = tokens.filter(([symbol]) =>
                ['USDT', 'USDC', 'BUSD', 'DAI', 'FDUSD'].includes(symbol)
            );

            const pairsToResolve = [];

            // Native token pairs
            if (nativeToken) {
                for (const [symbol, token] of tokens) {
                    if (token.address !== nativeToken) {
                        pairsToResolve.push({ tokenA: nativeToken, tokenB: token.address, dex: dexName });
                    }
                }
            }

            // Stablecoin pairs
            for (const [stableSymbol, stableToken] of stablecoins) {
                for (const [symbol, token] of tokens) {
                    if (token.address !== stableToken.address) {
                        pairsToResolve.push({ tokenA: stableToken.address, tokenB: token.address, dex: dexName });
                    }
                }
            }

            // Resolve in parallel with rate limiting
            let resolved = 0;
            const batchSize = 10;
            for (let i = 0; i < pairsToResolve.length; i += batchSize) {
                const batch = pairsToResolve.slice(i, i + batchSize);
                const results = await Promise.allSettled(
                    batch.map(async ({ tokenA, tokenB, dex }) => {
                        // Check cache first
                        const cached = cacheManager.getPairAddress(tokenA, tokenB, dex);
                        if (cached) return cached;

                        // Resolve from factory
                        const pairAddress = await factory.getPair(tokenA, tokenB);
                        if (pairAddress && pairAddress !== ethers.ZeroAddress) {
                            cacheManager.setPairAddress(tokenA, tokenB, dex, pairAddress);
                            return pairAddress;
                        }
                        return null;
                    })
                );
                resolved += results.filter(r => r.status === 'fulfilled' && r.value).length;
            }

            const duration = performance.now() - startTime;
            log.info('Flash pair cache warmed', {
                resolved,
                attempted: pairsToResolve.length,
                durationMs: duration.toFixed(2),
            });

        } catch (error) {
            log.debug('Flash pair cache warming failed (non-critical)', { error: error.message });
        }
    }

    /**
     * Initialize Flashbots provider for MEV protection
     *
     * Task 3.4: Flashbots integration for Ethereum mainnet
     * - Enables private transaction submission
     * - Protects against frontrunning and sandwich attacks
     * - Only active on Ethereum mainnet (chainId 1)
     *
     * @private
     * @param {number} chainId - Chain ID
     */
    async _initializeFlashbots(chainId) {
        // Only initialize for Ethereum mainnet
        if (!this.flashbotsEnabled || chainId !== 1) {
            log.debug('Flashbots not enabled or not on Ethereum mainnet', {
                enabled: this.flashbotsEnabled,
                chainId,
            });
            return;
        }

        try {
            // Initialize Flashbots with signer (if live mode)
            if (this.signer) {
                const initialized = await flashbotsProvider.initialize(this.signer, chainId, {
                    authKey: config.flashbots?.authKey,
                    simulationEnabled: config.flashbots?.simulationEnabled !== false,
                    useAlternativeRelays: config.flashbots?.useAlternativeRelays !== false,
                });

                if (initialized) {
                    this.flashbotsInitialized = true;
                    log.info('Flashbots initialized for MEV protection', {
                        chainId,
                        simulationEnabled: flashbotsProvider.config.simulationEnabled,
                        multiBuilder: flashbotsProvider.config.useAlternativeRelays,
                    });
                }
            } else {
                log.debug('Flashbots requires signer - skipping in simulation mode');
            }
        } catch (error) {
            log.warn('Flashbots initialization failed (non-critical)', { error: error.message });
        }
    }

    /**
     * Check if Flashbots should be used for an opportunity
     *
     * @private
     * @param {Object} opportunity - Opportunity to check
     * @returns {boolean} True if Flashbots should be used
     */
    _shouldUseFlashbots(opportunity) {
        // Must be initialized and enabled
        if (!this.flashbotsInitialized || !this.flashbotsEnabled) {
            return false;
        }

        // Must be in live mode
        if (this.mode !== 'live') {
            return false;
        }

        // Check opportunity-specific MEV risk
        const mevRisk = opportunity.simulationInsights?.mevRisk?.riskLevel || 'unknown';
        if (mevRisk === 'low' && !config.flashbots?.forceAlways) {
            // Low MEV risk, can skip Flashbots for speed
            return false;
        }

        // Check if opportunity type benefits from MEV protection
        const highMevTypes = ['cross-dex', 'triangular', 'v2v3', 'fee-tier'];
        if (!highMevTypes.includes(opportunity.type)) {
            return false;
        }

        return true;
    }

    /**
     * Execute transaction via Flashbots bundle
     *
     * Task 3.4: Protected execution that bypasses public mempool
     *
     * @private
     * @param {Object} tx - Transaction object
     * @param {Object} opportunity - Original opportunity
     * @returns {Object} Execution result
     */
    async _executeWithFlashbots(tx, opportunity) {
        if (!this.flashbotsInitialized) {
            throw new Error('Flashbots not initialized');
        }

        this.stats.flashbotsExecutions++;

        try {
            // FIX v3.5: Use signer's provider instead of undefined this.provider
            // The signer is initialized with a provider in initialize() when mode is 'live'
            if (!this.signer?.provider) {
                throw new Error('Signer provider not available for Flashbots execution');
            }

            // Get current block for targeting
            const currentBlock = await this.signer.provider.getBlockNumber();
            const targetBlock = currentBlock + 1;

            // Sign the transaction
            const signedTx = await this.signer.signTransaction(tx);

            // Create bundle
            const bundle = await flashbotsProvider.createBundle([signedTx], targetBlock);

            log.info('[FLASHBOTS] Submitting protected transaction', {
                targetBlock,
                type: opportunity.type,
                profit: `$${opportunity.profitCalculation?.netProfitUSD?.toFixed(2)}`,
            });

            // Submit to multiple builders for higher inclusion probability
            const submitResult = await flashbotsProvider.submitToMultipleBuilders(bundle);

            if (!submitResult.success) {
                this.stats.flashbotsFailed++;
                return {
                    success: false,
                    reason: `Flashbots submission failed: ${submitResult.reason || 'Unknown error'}`,
                    flashbots: true,
                };
            }

            // Wait for inclusion (with timeout)
            const inclusionResult = await flashbotsProvider.waitForInclusion(
                bundle.bundleHash,
                targetBlock,
                config.flashbots?.maxWaitBlocks || 25
            );

            if (inclusionResult.included) {
                this.stats.flashbotsSuccess++;
                this.stats.executionsSuccess++;
                this.stats.totalProfitUSD += opportunity.profitCalculation?.netProfitUSD || 0;

                log.info('[FLASHBOTS] Transaction INCLUDED', {
                    bundleHash: bundle.bundleHash.slice(0, 18) + '...',
                    blocksToInclusion: inclusionResult.blocksToInclusion,
                    profit: `$${opportunity.profitCalculation?.netProfitUSD?.toFixed(2)}`,
                });

                return {
                    success: true,
                    flashbots: true,
                    bundleHash: bundle.bundleHash,
                    blockNumber: inclusionResult.blockNumber,
                    blocksToInclusion: inclusionResult.blocksToInclusion,
                    profit: opportunity.profitCalculation?.netProfitUSD || 0,
                };
            } else {
                this.stats.flashbotsFailed++;

                log.warn('[FLASHBOTS] Bundle not included', {
                    reason: inclusionResult.reason,
                    blocksWaited: inclusionResult.blocksWaited,
                });

                return {
                    success: false,
                    flashbots: true,
                    reason: `Bundle not included: ${inclusionResult.reason}`,
                    blocksWaited: inclusionResult.blocksWaited,
                };
            }

        } catch (error) {
            this.stats.flashbotsFailed++;
            log.error('[FLASHBOTS] Execution error', { error: error.message });
            return {
                success: false,
                flashbots: true,
                reason: error.message,
            };
        }
    }

    /**
     * Execute an arbitrage opportunity
     *
     * @param {Object} opportunity - Validated arbitrage opportunity
     * @returns {Object} Execution result
     */
    async execute(opportunity) {
        // FIX v3.1: Comprehensive input validation
        if (!opportunity || typeof opportunity !== 'object') {
            return {
                success: false,
                reason: 'Invalid opportunity: must be an object',
                stage: 'validation',
            };
        }

        // Validate required fields
        if (!opportunity.type) {
            return {
                success: false,
                reason: 'Invalid opportunity: missing type field',
                stage: 'validation',
            };
        }

        if (!['cross-dex', 'triangular', 'cross-dex-triangular', 'v2v3', 'fee-tier', 'liquidation-backrun', 'liquidation-buyCollateral'].includes(opportunity.type)) {
            return {
                success: false,
                reason: `Invalid opportunity type: ${opportunity.type}`,
                stage: 'validation',
            };
        }

        // Special handling for liquidation opportunities
        if (opportunity.type === 'liquidation-backrun' || opportunity.type === 'liquidation-buyCollateral') {
            return this.executeLiquidationBackrun(opportunity);
        }

        // Prevent concurrent executions
        if (this.isExecuting) {
            return {
                success: false,
                reason: 'Another execution in progress',
            };
        }

        this.isExecuting = true;
        const startTime = Date.now();

        try {
            // 1. Pre-flight validation
            const validation = await this.validateOpportunity(opportunity);
            if (!validation.valid) {
                return {
                    success: false,
                    reason: validation.reason,
                    stage: 'validation',
                };
            }

            // ==================== PRE-SIMULATION ANALYSIS ====================
            // Improvement v2.0: Comprehensive simulation before execution
            // Analyzes MEV risk, competition, timing, and success probability
            // Expected impact: +25-40% execution success rate improvement
            const preSimResult = await this._runPreSimulation(opportunity);
            if (!preSimResult.shouldProceed) {
                return {
                    success: false,
                    reason: preSimResult.reason,
                    stage: 'pre_simulation',
                    simulation: preSimResult.simulation,
                };
            }

            // Attach simulation insights to opportunity for downstream use
            opportunity.simulationInsights = preSimResult.simulation;

            // 2. Resolve flash pair address if needed
            opportunity = await this._resolveFlashPair(opportunity);

            // 3. Get optimal gas price
            const gasPrice = await gasOptimizer.getOptimalGasPrice(opportunity);

            // 4. Check gas conditions
            const gasCheck = await gasOptimizer.shouldExecute(opportunity);
            if (!gasCheck.shouldExecute) {
                return {
                    success: false,
                    reason: gasCheck.reason,
                    stage: 'gas_check',
                };
            }

            // 5. Build transaction
            const tx = transactionBuilder.build(opportunity, gasPrice);

            // 6. Simulate or execute
            let result;
            if (this.mode === 'simulation') {
                result = await this.simulate(tx, opportunity);
            } else {
                result = await this.executeLive(tx, opportunity);
            }

            // 7. Record result
            this._recordExecution(opportunity, result, Date.now() - startTime);

            return result;

        } catch (error) {
            log.error('Execution failed', {
                error: error.message,
                opportunity: opportunity.type,
            });

            return {
                success: false,
                reason: error.message,
                stage: 'error',
            };
        } finally {
            this.isExecuting = false;
        }
    }

    /**
     * Simulate a transaction using eth_call
     *
     * @param {Object} tx - Transaction object
     * @param {Object} opportunity - Original opportunity
     * @returns {Object} Simulation result
     */
    async simulate(tx, opportunity) {
        this.stats.simulationsRun++;

        try {
            // Use eth_call to simulate
            const result = await rpcManager.withRetry(async (provider) => {
                return await provider.call({
                    to: tx.to,
                    data: tx.data,
                    gasLimit: tx.gasLimit,
                });
            });

            this.stats.simulationsSuccess++;

            log.info('Simulation SUCCESS', {
                type: opportunity.type,
                profit: `$${opportunity.profitCalculation?.netProfitUSD?.toFixed(2) || 'N/A'}`,
                path: opportunity.type === 'triangular'
                    ? opportunity.path.join(' -> ')
                    : `${opportunity.buyDex} -> ${opportunity.sellDex}`,
            });

            return {
                success: true,
                simulated: true,
                result,
                estimatedProfit: opportunity.profitCalculation?.netProfitUSD || 0,
            };

        } catch (error) {
            this.stats.simulationsFailed++;

            // Parse revert reason if available
            const revertReason = this._parseRevertReason(error);

            log.warn('Simulation FAILED', {
                type: opportunity.type,
                reason: revertReason || error.message,
            });

            return {
                success: false,
                simulated: true,
                reason: revertReason || error.message,
            };
        }
    }

    /**
     * Execute a transaction for real
     *
     * @param {Object} tx - Transaction object
     * @param {Object} opportunity - Original opportunity
     * @returns {Object} Execution result
     */
    async executeLive(tx, opportunity) {
        if (!this.signer) {
            return {
                success: false,
                reason: 'No signer configured for live execution',
            };
        }

        this.stats.executionsRun++;

        try {
            // First simulate to verify
            const simResult = await this.simulate(tx, opportunity);
            if (!simResult.success) {
                return {
                    success: false,
                    reason: `Pre-execution simulation failed: ${simResult.reason}`,
                };
            }

            // ==================== Task 3.4: FLASHBOTS PATH ====================
            // Use Flashbots for MEV protection on Ethereum mainnet
            if (this._shouldUseFlashbots(opportunity)) {
                log.info('[FLASHBOTS] Using protected execution path', {
                    type: opportunity.type,
                    expectedProfit: `$${opportunity.profitCalculation?.netProfitUSD?.toFixed(2)}`,
                });
                return this._executeWithFlashbots(tx, opportunity);
            }

            log.info('Sending live transaction...', {
                type: opportunity.type,
                expectedProfit: `$${opportunity.profitCalculation?.netProfitUSD?.toFixed(2)}`,
            });

            // Send transaction (standard mempool path)
            const response = await this.signer.sendTransaction(tx);
            this.pendingTx = response.hash;

            log.info('Transaction sent', { hash: response.hash });

            // Wait for confirmation with timeout (2 minutes max to prevent hanging)
            // FIX v3.4: Proper timeout handling without orphaned promises
            const txTimeout = config.execution?.txTimeoutMs || 120000;
            let receipt;
            let isTimeout = false;
            let timeoutHandle = null;

            try {
                // FIX v3.4: Create timeout promise with cleanup capability
                const timeoutPromise = new Promise((_, reject) => {
                    timeoutHandle = setTimeout(() => {
                        timeoutHandle = null; // Clear reference
                        reject(new Error('TIMEOUT'));
                    }, txTimeout);
                });

                // FIX v3.4: Wrap wait() to clear timeout on success
                const waitPromise = response.wait(1).then(result => {
                    if (timeoutHandle) {
                        clearTimeout(timeoutHandle);
                        timeoutHandle = null;
                    }
                    return result;
                });

                receipt = await Promise.race([waitPromise, timeoutPromise]);
            } catch (waitError) {
                // FIX v3.1: Handle timeout separately from other errors
                if (waitError.message === 'TIMEOUT') {
                    isTimeout = true;
                    log.warn('Transaction confirmation timeout - tx may still be pending', {
                        hash: response.hash,
                        timeoutMs: txTimeout,
                    });

                    // Track timed-out transaction for later resolution
                    // FIX v3.5: Priority-based eviction - remove lowest-value tx instead of oldest
                    if (this.timedOutTxs.size >= this.timedOutTxMaxSize) {
                        this._evictLowestValueTimedOutTx();
                    }
                    this.timedOutTxs.set(response.hash, {
                        timestamp: Date.now(),
                        opportunity: {
                            type: opportunity.type,
                            profitUSD: opportunity.profitCalculation?.netProfitUSD || 0,
                        },
                    });

                    // Don't count as failed - status is uncertain
                    this.pendingTx = null;
                    return {
                        success: false,
                        hash: response.hash,
                        reason: 'Transaction confirmation timeout - may still confirm',
                        status: 'PENDING_TIMEOUT',
                        // Don't count towards failure stats
                    };
                }
                throw waitError;
            }

            this.pendingTx = null;

            if (receipt.status === 1) {
                this.stats.executionsSuccess++;
                this.stats.totalProfitUSD += opportunity.profitCalculation?.netProfitUSD || 0;

                log.info('Transaction CONFIRMED', {
                    hash: receipt.hash,
                    gasUsed: receipt.gasUsed.toString(),
                    profit: `$${opportunity.profitCalculation?.netProfitUSD?.toFixed(2)}`,
                });

                return {
                    success: true,
                    hash: receipt.hash,
                    gasUsed: receipt.gasUsed,
                    profit: opportunity.profitCalculation?.netProfitUSD || 0,
                };
            } else {
                this.stats.executionsFailed++;

                log.error('Transaction REVERTED', { hash: receipt.hash });

                return {
                    success: false,
                    hash: receipt.hash,
                    reason: 'Transaction reverted',
                };
            }

        } catch (error) {
            this.stats.executionsFailed++;
            this.pendingTx = null;

            log.error('Live execution failed', { error: error.message });

            return {
                success: false,
                reason: error.message,
            };
        }
    }

    /**
     * Validate that an opportunity is still viable
     *
     * @param {Object} opportunity - Opportunity to validate
     * @returns {Object} { valid: boolean, reason?: string }
     */
    async validateOpportunity(opportunity) {
        // Check if contract is configured
        if (!config.execution?.contractAddress && !transactionBuilder.contractAddress) {
            return {
                valid: false,
                reason: 'Contract address not configured',
            };
        }

        // Check minimum profit
        const minProfit = config.execution?.minProfitUSD || 1.0;
        if ((opportunity.profitCalculation?.netProfitUSD || 0) < minProfit) {
            return {
                valid: false,
                reason: `Profit ($${opportunity.profitCalculation?.netProfitUSD?.toFixed(2)}) below minimum ($${minProfit})`,
            };
        }

        // Check age (opportunities older than 2 blocks are stale)
        // Use blockMonitor for accurate current block (cacheManager may be stale)
        const currentBlock = blockMonitor.getCurrentBlock() || cacheManager.currentBlockNumber;
        if (opportunity.blockNumber && currentBlock - opportunity.blockNumber > 2) {
            return {
                valid: false,
                reason: `Opportunity too old (block ${opportunity.blockNumber}, current ${currentBlock})`,
            };
        }

        return { valid: true };
    }

    /**
     * Run comprehensive pre-simulation analysis using ExecutionSimulator
     *
     * Improvement v2.0: Filters low-probability opportunities before expensive
     * transaction building and eth_call simulation.
     *
     * Analyzes:
     * - MEV risk (frontrunning, sandwich, backrun)
     * - Competition level (estimated bots competing)
     * - Timing (opportunity staleness)
     * - Price stability
     * - Slippage risk
     *
     * @private
     * @param {Object} opportunity - Opportunity to analyze
     * @returns {Object} { shouldProceed, reason, simulation }
     */
    async _runPreSimulation(opportunity) {
        this.stats.preSimulationsRun++;
        speedMetrics.markPhaseStart('preSimulation');

        try {
            // ==================== SPEED OPT: CACHED GAS PRICE ====================
            // Uses shared gas price cache to avoid redundant RPC calls
            // Expected improvement: -50-100ms per pre-simulation
            const gasPrice = await gasPriceCache.getGasPrice(async () => {
                return await rpcManager.withRetry(async (provider) => provider.getFeeData());
            });

            const currentBlock = blockMonitor.getCurrentBlock() || cacheManager.currentBlockNumber;

            // Run comprehensive simulation
            const simulation = executionSimulator.simulate(opportunity, {
                gasPrice: gasPrice.gasPrice || 3000000000n,
                currentBlock,
                nativePrice: config.nativeToken?.priceUSD || 500,
            });

            // Decision based on simulation results
            const recommendation = simulation.recommendation;

            // Skip if recommendation is SKIP
            if (recommendation.action === 'SKIP') {
                this.stats.preSimulationsSkipped++;

                log.info('[PRE-SIM] Skipping opportunity', {
                    reason: recommendation.reason,
                    successProb: `${simulation.successProbability.probabilityPercent.toFixed(1)}%`,
                    mevRisk: simulation.mevRisk.riskLevel,
                    competition: simulation.competition.competitionLevel,
                });

                return {
                    shouldProceed: false,
                    reason: `Pre-simulation: ${recommendation.reason}`,
                    simulation,
                };
            }

            // Check minimum success probability threshold
            const minSuccessProb = config.execution?.minSuccessProbability || 0.3;
            if (simulation.successProbability.probability < minSuccessProb) {
                this.stats.preSimulationsSkipped++;

                log.info('[PRE-SIM] Low success probability', {
                    probability: `${simulation.successProbability.probabilityPercent.toFixed(1)}%`,
                    threshold: `${(minSuccessProb * 100).toFixed(1)}%`,
                    mevRisk: simulation.mevRisk.riskLevel,
                });

                return {
                    shouldProceed: false,
                    reason: `Success probability ${simulation.successProbability.probabilityPercent.toFixed(1)}% below threshold ${(minSuccessProb * 100).toFixed(1)}%`,
                    simulation,
                };
            }

            // Check expected value is positive
            if (!simulation.adjustedEV.isPositiveEV) {
                this.stats.preSimulationsSkipped++;

                log.info('[PRE-SIM] Negative expected value', {
                    ev: `$${simulation.adjustedEV.expectedValue.toFixed(2)}`,
                    rawProfit: `$${simulation.adjustedEV.rawProfit.toFixed(2)}`,
                    mevRisk: `$${simulation.adjustedEV.mevRisk.toFixed(2)}`,
                });

                return {
                    shouldProceed: false,
                    reason: `Negative expected value: $${simulation.adjustedEV.expectedValue.toFixed(2)}`,
                    simulation,
                };
            }

            // Proceed with execution
            this.stats.preSimulationsProceeded++;

            log.info('[PRE-SIM] Proceeding with execution', {
                action: recommendation.action,
                successProb: `${simulation.successProbability.probabilityPercent.toFixed(1)}%`,
                ev: `$${simulation.adjustedEV.expectedValue.toFixed(2)}`,
                gasStrategy: recommendation.gasStrategy,
                urgency: recommendation.urgency,
            });

            speedMetrics.markPhaseEnd('preSimulation');
            return {
                shouldProceed: true,
                simulation,
                gasStrategy: recommendation.gasStrategy,
                urgency: recommendation.urgency,
            };

        } catch (error) {
            speedMetrics.markPhaseEnd('preSimulation');
            log.debug('[PRE-SIM] Simulation error, proceeding with caution', {
                error: error.message,
            });

            // On simulation error, proceed but flag as uncertain
            return {
                shouldProceed: true,
                simulation: null,
                warning: 'Pre-simulation failed, proceeding with standard execution',
            };
        }
    }

    /**
     * Resolve flash pair address from token addresses
     * Uses FlashLoanOptimizer to select the best provider based on fees
     *
     * @private
     * @param {Object} opportunity - Opportunity needing pair resolution
     * @returns {Object} Opportunity with resolved flash pair and provider info
     */
    async _resolveFlashPair(opportunity) {
        // If pair is already resolved, return as-is
        if (opportunity.flashPair && opportunity.flashPair !== 'RESOLVE_PAIR') {
            return opportunity;
        }

        // Get token addresses and symbol
        let tokenA, tokenB, flashAsset;

        if (opportunity.type === 'triangular') {
            tokenA = config.tokens[opportunity.path[0]]?.address;
            tokenB = config.tokens[opportunity.path[1]]?.address;
            flashAsset = opportunity.path[0]; // First token in path
        } else {
            tokenA = config.tokens[opportunity.tokenA]?.address;
            tokenB = config.tokens[opportunity.tokenB]?.address;
            flashAsset = opportunity.tokenA;
        }

        // Use flash loan optimizer to select best provider
        const estimatedTradeUSD = opportunity.profitCalculation?.tradeSizeUSD || 1000;
        const bestProvider = flashLoanOptimizer.selectBestProvider(flashAsset, estimatedTradeUSD);

        if (bestProvider) {
            log.debug('Selected flash loan provider', {
                provider: bestProvider.name,
                fee: `${(bestProvider.fee * 100).toFixed(2)}%`,
                asset: flashAsset,
            });
        }

        // Try to get from cache first
        const preferredDex = bestProvider?.dexFactory || 'pancakeswap';
        const cachedPair = cacheManager.getPairAddress(tokenA, tokenB, preferredDex);
        if (cachedPair) {
            return {
                ...opportunity,
                flashPair: cachedPair,
                flashLoanProvider: bestProvider?.name || 'pancakeswap',
                flashLoanFee: bestProvider?.fee || 0.0025,
            };
        }

        // Fetch from factory - use optimal flash loan provider's factory
        try {
            const factoryAddress = config.dex[preferredDex]?.factory
                || config.dex.pancakeswap?.factory
                || config.dex.uniswapV2?.factory;

            if (!factoryAddress) {
                throw new Error('No factory address configured for flash loan provider');
            }

            const pairAddress = await rpcManager.withRetry(async (provider) => {
                const factory = new ethers.Contract(factoryAddress, FACTORY_ABI, provider);
                return await factory.getPair(tokenA, tokenB);
            });

            if (pairAddress && pairAddress !== ethers.ZeroAddress) {
                cacheManager.setPairAddress(tokenA, tokenB, preferredDex, pairAddress);
                return {
                    ...opportunity,
                    flashPair: pairAddress,
                    flashLoanProvider: bestProvider?.name || 'pancakeswap',
                    flashLoanFee: bestProvider?.fee || 0.0025,
                };
            }
        } catch (error) {
            log.error('Failed to resolve flash pair', { error: error.message });
        }

        throw new Error('Could not resolve flash pair address');
    }

    /**
     * Execute a liquidation backrun opportunity
     *
     * Task 3.3: Handles liquidation-based arbitrage by:
     * 1. Validating the liquidation opportunity
     * 2. Converting to a tradeable opportunity (buy collateral being sold)
     * 3. Selecting optimal DEX for buying the collateral
     * 4. Executing with flash loan if needed
     * 5. Tracking liquidation-specific statistics
     *
     * @param {Object} opportunity - Liquidation opportunity from LiquidationMonitor
     * @returns {Object} Execution result
     */
    async executeLiquidationBackrun(opportunity) {
        // FIX v3.1: Comprehensive input validation
        if (!opportunity || typeof opportunity !== 'object') {
            return {
                success: false,
                reason: 'Invalid liquidation opportunity: must be an object',
                stage: 'validation',
            };
        }

        // Validate required liquidation fields
        if (!opportunity.protocol) {
            return {
                success: false,
                reason: 'Invalid liquidation opportunity: missing protocol field',
                stage: 'validation',
            };
        }

        this.stats.liquidationBackrunsAttempted++;
        const startTime = Date.now();

        try {
            // 1. Validate minimum profit threshold
            const minProfit = config.execution?.minLiquidationProfitUSD || 5.0;
            const estimatedProfit = opportunity.estimatedProfitUSD || 0;

            if (estimatedProfit < minProfit) {
                return {
                    success: false,
                    reason: `Liquidation profit ($${estimatedProfit.toFixed(2)}) below minimum ($${minProfit})`,
                    stage: 'validation',
                };
            }

            // 2. Check opportunity age (liquidation opportunities are time-sensitive)
            const maxAgeMs = config.execution?.maxLiquidationAgeMs || 10000; // 10 seconds default
            const opportunityAge = Date.now() - (opportunity.timestamp || Date.now());

            if (opportunityAge > maxAgeMs) {
                return {
                    success: false,
                    reason: `Liquidation opportunity too old (${opportunityAge}ms > ${maxAgeMs}ms)`,
                    stage: 'validation',
                };
            }

            // 3. Convert liquidation to tradeable opportunity
            const tradeableOpp = this._convertLiquidationToTrade(opportunity);

            if (!tradeableOpp) {
                return {
                    success: false,
                    reason: 'Could not convert liquidation to tradeable opportunity',
                    stage: 'conversion',
                };
            }

            // 4. Build trade transaction
            log.info('[LIQUIDATION] Building backrun transaction', {
                protocol: opportunity.protocol,
                collateral: opportunity.collateralSymbol,
                valueUSD: opportunity.collateralValueUSD?.toFixed(2),
                estimatedProfit: `$${estimatedProfit.toFixed(2)}`,
            });

            // Get optimal gas price with urgency factor for liquidations
            const gasPrice = await gasOptimizer.getOptimalGasPrice(tradeableOpp, {
                urgency: 'high',
                priorityMultiplier: 1.2, // 20% higher priority for liquidation backruns
            });

            // Build transaction
            const tx = transactionBuilder.build(tradeableOpp, gasPrice);

            // 5. Execute based on mode
            let result;
            if (this.mode === 'simulation') {
                result = await this._simulateLiquidationBackrun(tx, opportunity);
            } else {
                result = await this._executeLiquidationBackrunLive(tx, opportunity);
            }

            // 6. Record result and update stats
            this._recordLiquidationExecution(opportunity, result, Date.now() - startTime);

            return result;

        } catch (error) {
            this.stats.liquidationBackrunsFailed++;

            log.error('[LIQUIDATION] Backrun execution failed', {
                error: error.message,
                protocol: opportunity.protocol,
                collateral: opportunity.collateralSymbol,
            });

            return {
                success: false,
                reason: error.message,
                stage: 'error',
            };
        }
    }

    /**
     * Convert a liquidation opportunity to a standard trade opportunity
     *
     * @private
     * @param {Object} liquidation - Liquidation opportunity
     * @returns {Object|null} Tradeable opportunity or null if conversion fails
     */
    _convertLiquidationToTrade(liquidation) {
        try {
            const {
                protocol,
                type,
                collateralAsset,
                collateralSymbol,
                debtAsset,
                debtSymbol,
                collateralValueUSD,
                estimatedProfitUSD,
                liquidationBonusPercent,
            } = liquidation;

            // For liquidation-backrun: Buy collateral that liquidator is selling
            // The liquidator sells collateral at a discount (bonus) - we buy and sell at market
            if (type === 'liquidation-backrun') {
                // Find best DEX to buy collateral
                const buyDex = this._findBestDexForToken(collateralSymbol);

                if (!buyDex) {
                    log.warn('[LIQUIDATION] No DEX found for collateral', { collateralSymbol });
                    return null;
                }

                // Calculate trade size based on liquidation value
                // Use a portion of the liquidated collateral value
                const tradeSizeUSD = Math.min(
                    collateralValueUSD * 0.5, // Trade up to 50% of collateral value
                    config.execution?.maxTradeSizeUSD || 10000
                );

                return {
                    type: 'liquidation-backrun',
                    tokenA: collateralSymbol,
                    tokenB: debtSymbol || 'USDC',
                    buyDex: buyDex,
                    sellDex: 'market', // Sell at market after liquidation
                    originalLiquidation: {
                        protocol,
                        collateralAsset,
                        debtAsset,
                        bonusPercent: liquidationBonusPercent,
                    },
                    profitCalculation: {
                        netProfitUSD: estimatedProfitUSD,
                        tradeSizeUSD: tradeSizeUSD,
                        slippagePercent: this._estimateLiquidationSlippage(collateralValueUSD),
                    },
                    blockNumber: cacheManager.currentBlockNumber,
                    timestamp: Date.now(),
                };
            }

            // For liquidation-buyCollateral (Compound V3): Buy collateral directly from protocol
            if (type === 'liquidation-buyCollateral') {
                return {
                    type: 'liquidation-buyCollateral',
                    tokenA: collateralSymbol,
                    tokenB: liquidation.baseToken || 'USDC',
                    protocol: protocol,
                    collateralAsset: collateralAsset,
                    profitCalculation: {
                        netProfitUSD: estimatedProfitUSD,
                        tradeSizeUSD: collateralValueUSD,
                        slippagePercent: this._estimateLiquidationSlippage(collateralValueUSD),
                    },
                    blockNumber: cacheManager.currentBlockNumber,
                    timestamp: Date.now(),
                };
            }

            return null;
        } catch (error) {
            log.error('[LIQUIDATION] Conversion error', { error: error.message });
            return null;
        }
    }

    /**
     * Find the best DEX to trade a given token
     *
     * @private
     * @param {string} tokenSymbol - Token symbol
     * @returns {string|null} DEX name or null
     */
    _findBestDexForToken(tokenSymbol) {
        // Check configured DEXes for the token
        const dexes = config.dex || {};
        const tokenConfig = config.tokens?.[tokenSymbol];

        if (!tokenConfig?.address) {
            return null;
        }

        // Prefer DEXes in order: PancakeSwap V3, Uniswap V3, PancakeSwap V2, Uniswap V2
        const preferredOrder = ['pancakeswap_v3', 'uniswap_v3', 'pancakeswap', 'uniswap', 'sushiswap'];

        for (const dexName of preferredOrder) {
            if (dexes[dexName]?.enabled && dexes[dexName]?.router) {
                return dexName;
            }
        }

        // Return first enabled DEX as fallback
        const enabledDex = Object.entries(dexes).find(([_, dex]) => dex.enabled && dex.router);
        return enabledDex ? enabledDex[0] : null;
    }

    /**
     * Estimate slippage for liquidation trades based on size
     *
     * @private
     * @param {number} valueUSD - Trade value in USD
     * @returns {number} Estimated slippage percentage
     */
    _estimateLiquidationSlippage(valueUSD) {
        // Higher slippage for larger liquidations due to market impact
        if (valueUSD < 10000) return 0.5;
        if (valueUSD < 50000) return 1.0;
        if (valueUSD < 100000) return 1.5;
        return 2.0;
    }

    /**
     * Simulate a liquidation backrun transaction
     *
     * @private
     * @param {Object} tx - Transaction object
     * @param {Object} opportunity - Original liquidation opportunity
     * @returns {Object} Simulation result
     */
    async _simulateLiquidationBackrun(tx, opportunity) {
        this.stats.simulationsRun++;

        try {
            const result = await rpcManager.withRetry(async (provider) => {
                return await provider.call({
                    to: tx.to,
                    data: tx.data,
                    gasLimit: tx.gasLimit,
                });
            });

            this.stats.simulationsSuccess++;
            this.stats.liquidationBackrunsSuccess++;

            log.info('[LIQUIDATION] Simulation SUCCESS', {
                protocol: opportunity.protocol,
                collateral: opportunity.collateralSymbol,
                estimatedProfit: `$${opportunity.estimatedProfitUSD?.toFixed(2)}`,
            });

            return {
                success: true,
                simulated: true,
                result,
                estimatedProfit: opportunity.estimatedProfitUSD || 0,
                type: 'liquidation-backrun',
            };

        } catch (error) {
            this.stats.simulationsFailed++;
            this.stats.liquidationBackrunsFailed++;

            const revertReason = this._parseRevertReason(error);

            log.warn('[LIQUIDATION] Simulation FAILED', {
                protocol: opportunity.protocol,
                reason: revertReason || error.message,
            });

            return {
                success: false,
                simulated: true,
                reason: revertReason || error.message,
                type: 'liquidation-backrun',
            };
        }
    }

    /**
     * Execute a liquidation backrun transaction for real
     *
     * @private
     * @param {Object} tx - Transaction object
     * @param {Object} opportunity - Original liquidation opportunity
     * @returns {Object} Execution result
     */
    async _executeLiquidationBackrunLive(tx, opportunity) {
        if (!this.signer) {
            return {
                success: false,
                reason: 'No signer configured for live execution',
                type: 'liquidation-backrun',
            };
        }

        this.stats.executionsRun++;

        try {
            // First simulate to verify
            const simResult = await this._simulateLiquidationBackrun(tx, opportunity);
            if (!simResult.success) {
                return {
                    success: false,
                    reason: `Pre-execution simulation failed: ${simResult.reason}`,
                    type: 'liquidation-backrun',
                };
            }

            log.info('[LIQUIDATION] Sending live backrun transaction...', {
                protocol: opportunity.protocol,
                collateral: opportunity.collateralSymbol,
                expectedProfit: `$${opportunity.estimatedProfitUSD?.toFixed(2)}`,
            });

            // Send transaction with higher priority for time-sensitive liquidation
            const response = await this.signer.sendTransaction(tx);
            this.pendingTx = response.hash;

            log.info('[LIQUIDATION] Transaction sent', { hash: response.hash });

            // Wait for confirmation with shorter timeout for liquidations
            const txTimeout = config.execution?.liquidationTxTimeoutMs || 60000; // 60s for liquidations
            let receipt;
            let timeoutHandle = null;

            try {
                const timeoutPromise = new Promise((_, reject) => {
                    timeoutHandle = setTimeout(() => {
                        timeoutHandle = null;
                        reject(new Error('TIMEOUT'));
                    }, txTimeout);
                });

                const waitPromise = response.wait(1).then(result => {
                    if (timeoutHandle) {
                        clearTimeout(timeoutHandle);
                        timeoutHandle = null;
                    }
                    return result;
                });

                receipt = await Promise.race([waitPromise, timeoutPromise]);
            } catch (waitError) {
                if (waitError.message === 'TIMEOUT') {
                    log.warn('[LIQUIDATION] Transaction confirmation timeout', {
                        hash: response.hash,
                        timeoutMs: txTimeout,
                    });

                    // Track timed-out transaction
                    // FIX v3.5: Use priority-based eviction
                    if (this.timedOutTxs.size >= this.timedOutTxMaxSize) {
                        this._evictLowestValueTimedOutTx();
                    }
                    this.timedOutTxs.set(response.hash, {
                        timestamp: Date.now(),
                        opportunity: {
                            type: 'liquidation-backrun',
                            protocol: opportunity.protocol,
                            profitUSD: opportunity.estimatedProfitUSD || 0,
                        },
                    });

                    this.pendingTx = null;
                    return {
                        success: false,
                        hash: response.hash,
                        reason: 'Liquidation backrun confirmation timeout - may still confirm',
                        status: 'PENDING_TIMEOUT',
                        type: 'liquidation-backrun',
                    };
                }
                throw waitError;
            }

            this.pendingTx = null;

            if (receipt.status === 1) {
                this.stats.executionsSuccess++;
                this.stats.liquidationBackrunsSuccess++;
                this.stats.liquidationBackrunProfitUSD += opportunity.estimatedProfitUSD || 0;

                log.info('[LIQUIDATION] Backrun CONFIRMED', {
                    hash: receipt.hash,
                    gasUsed: receipt.gasUsed.toString(),
                    profit: `$${opportunity.estimatedProfitUSD?.toFixed(2)}`,
                });

                return {
                    success: true,
                    hash: receipt.hash,
                    gasUsed: receipt.gasUsed,
                    profit: opportunity.estimatedProfitUSD || 0,
                    type: 'liquidation-backrun',
                };
            } else {
                this.stats.executionsFailed++;
                this.stats.liquidationBackrunsFailed++;

                log.error('[LIQUIDATION] Backrun REVERTED', { hash: receipt.hash });

                return {
                    success: false,
                    hash: receipt.hash,
                    reason: 'Liquidation backrun transaction reverted',
                    type: 'liquidation-backrun',
                };
            }

        } catch (error) {
            this.stats.executionsFailed++;
            this.stats.liquidationBackrunsFailed++;
            this.pendingTx = null;

            log.error('[LIQUIDATION] Live execution failed', { error: error.message });

            return {
                success: false,
                reason: error.message,
                type: 'liquidation-backrun',
            };
        }
    }

    /**
     * Record liquidation execution for statistics
     *
     * @private
     * @param {Object} opportunity - Liquidation opportunity
     * @param {Object} result - Execution result
     * @param {number} durationMs - Execution duration
     */
    _recordLiquidationExecution(opportunity, result, durationMs) {
        this.recentExecutions.push({
            timestamp: Date.now(),
            type: opportunity.type,
            protocol: opportunity.protocol,
            collateral: opportunity.collateralSymbol,
            success: result.success,
            simulated: result.simulated,
            profit: result.profit || opportunity.estimatedProfitUSD,
            reason: result.reason,
            durationMs,
        });

        // Trim history
        if (this.recentExecutions.length > this.maxRecentExecutions) {
            this.recentExecutions.shift();
        }
    }

    /**
     * Parse revert reason from error
     *
     * @private
     * @param {Error} error - Error object
     * @returns {string|null} Revert reason
     */
    _parseRevertReason(error) {
        // Try to extract revert reason from error message
        const match = error.message.match(/reason="([^"]+)"/);
        if (match) return match[1];

        // Check for common error patterns
        if (error.message.includes('InsufficientProfit')) {
            return 'InsufficientProfit: Trade no longer profitable';
        }
        if (error.message.includes('RouterNotWhitelisted')) {
            return 'RouterNotWhitelisted: DEX router not approved';
        }
        if (error.message.includes('INSUFFICIENT_OUTPUT_AMOUNT')) {
            return 'Slippage too high';
        }

        return null;
    }

    /**
     * Record execution for statistics
     *
     * @private
     */
    _recordExecution(opportunity, result, durationMs) {
        this.recentExecutions.push({
            timestamp: Date.now(),
            type: opportunity.type,
            success: result.success,
            simulated: result.simulated,
            profit: result.profit || opportunity.profitCalculation?.netProfitUSD,
            reason: result.reason,
            durationMs,
        });

        // Trim history
        if (this.recentExecutions.length > this.maxRecentExecutions) {
            this.recentExecutions.shift();
        }
    }

    /**
     * Get provider instance
     *
     * @private
     */
    async _getProvider() {
        const providerData = rpcManager.getHttpProvider();
        return providerData.provider;
    }

    /**
     * Get execution statistics
     */
    getStats() {
        const successRate = this.stats.simulationsRun > 0
            ? (this.stats.simulationsSuccess / this.stats.simulationsRun * 100).toFixed(1)
            : 0;

        const preSimFilterRate = this.stats.preSimulationsRun > 0
            ? (this.stats.preSimulationsSkipped / this.stats.preSimulationsRun * 100).toFixed(1)
            : 0;

        return {
            mode: this.mode,
            preSimulation: {
                total: this.stats.preSimulationsRun,
                skipped: this.stats.preSimulationsSkipped,
                proceeded: this.stats.preSimulationsProceeded,
                filterRate: `${preSimFilterRate}%`,
            },
            simulations: {
                total: this.stats.simulationsRun,
                success: this.stats.simulationsSuccess,
                failed: this.stats.simulationsFailed,
                successRate: `${successRate}%`,
            },
            executions: {
                total: this.stats.executionsRun,
                success: this.stats.executionsSuccess,
                failed: this.stats.executionsFailed,
            },
            totalProfitUSD: this.stats.totalProfitUSD.toFixed(2),
            recentCount: this.recentExecutions.length,
            simulatorStats: executionSimulator.getStats(),
            // Task 3.3: Liquidation backrun stats
            liquidationBackruns: {
                attempted: this.stats.liquidationBackrunsAttempted,
                success: this.stats.liquidationBackrunsSuccess,
                failed: this.stats.liquidationBackrunsFailed,
                profitUSD: this.stats.liquidationBackrunProfitUSD.toFixed(2),
                successRate: this.stats.liquidationBackrunsAttempted > 0
                    ? `${(this.stats.liquidationBackrunsSuccess / this.stats.liquidationBackrunsAttempted * 100).toFixed(1)}%`
                    : '0%',
            },
            // Task 3.4: Flashbots MEV protection stats
            flashbots: {
                enabled: this.flashbotsEnabled,
                initialized: this.flashbotsInitialized,
                executions: this.stats.flashbotsExecutions,
                success: this.stats.flashbotsSuccess,
                failed: this.stats.flashbotsFailed,
                successRate: this.stats.flashbotsExecutions > 0
                    ? `${(this.stats.flashbotsSuccess / this.stats.flashbotsExecutions * 100).toFixed(1)}%`
                    : '0%',
                ...(this.flashbotsInitialized ? { providerStats: flashbotsProvider.getStats() } : {}),
            },
        };
    }

    /**
     * Get recent execution history
     *
     * @param {number} limit - Maximum entries to return
     */
    getRecentExecutions(limit = 10) {
        return this.recentExecutions.slice(-limit);
    }

    /**
     * Set execution mode
     *
     * @param {string} mode - 'simulation' or 'live'
     */
    setMode(mode) {
        if (!['simulation', 'live'].includes(mode)) {
            throw new Error('Invalid mode. Use "simulation" or "live"');
        }
        this.mode = mode;
        log.info('Execution mode changed', { mode });
    }
}

// Export singleton instance
const executionManager = new ExecutionManager();
export default executionManager;
