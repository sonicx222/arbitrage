import { ethers } from 'ethers';
import rpcManager from '../utils/rpcManager.js';
import transactionBuilder from './transactionBuilder.js';
import gasOptimizer from './gasOptimizer.js';
import flashLoanOptimizer from './flashLoanOptimizer.js';
import executionSimulator from './executionSimulator.js';
import cacheManager from '../data/cacheManager.js';
import blockMonitor from '../monitoring/blockMonitor.js';
import config from '../config.js';
import log from '../utils/logger.js';
import { FACTORY_ABI } from '../contracts/abis.js';

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
        };

        // Recent executions for analysis
        this.recentExecutions = [];
        this.maxRecentExecutions = 100;

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
        const chainId = config.chainId || 56; // Default to BSC
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

        log.info('Execution Manager ready', { mode: this.mode });
    }

    /**
     * Execute an arbitrage opportunity
     *
     * @param {Object} opportunity - Validated arbitrage opportunity
     * @returns {Object} Execution result
     */
    async execute(opportunity) {
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

            log.info('Sending live transaction...', {
                type: opportunity.type,
                expectedProfit: `$${opportunity.profitCalculation?.netProfitUSD?.toFixed(2)}`,
            });

            // Send transaction
            const response = await this.signer.sendTransaction(tx);
            this.pendingTx = response.hash;

            log.info('Transaction sent', { hash: response.hash });

            // Wait for confirmation with timeout (2 minutes max to prevent hanging)
            const txTimeout = config.execution?.txTimeoutMs || 120000;
            const receipt = await Promise.race([
                response.wait(1),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Transaction confirmation timeout')), txTimeout)
                ),
            ]);

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

        try {
            // Get current gas price for simulation
            const gasPrice = await rpcManager.withRetry(async (provider) => {
                return await provider.getFeeData();
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

            return {
                shouldProceed: true,
                simulation,
                gasStrategy: recommendation.gasStrategy,
                urgency: recommendation.urgency,
            };

        } catch (error) {
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
