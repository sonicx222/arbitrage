import { EventEmitter } from 'events';
import log from '../utils/logger.js';
import config from '../config.js';

/**
 * CrossChainFlashLoanCoordinator
 *
 * Coordinates flash loan arbitrage execution across multiple blockchains.
 *
 * KEY INSIGHT: True cross-chain flash loans are impossible because:
 * - Flash loans must be repaid in the same transaction
 * - Cross-chain operations take minutes to hours via bridges
 *
 * SUPPORTED STRATEGIES:
 *
 * 1. DUAL_CHAIN_ATOMIC - Execute independent flash loans on both chains simultaneously
 *    - Detect price discrepancy (Token cheaper on Chain A, expensive on Chain B)
 *    - Execute flash loan arbitrage on Chain A (buy cheap)
 *    - Execute flash loan arbitrage on Chain B (sell expensive)
 *    - Profit captured on BOTH chains independently
 *
 * 2. BRIDGE_AND_FLASH - Bridge capital then use flash loan
 *    - Start with capital on Chain A
 *    - Execute flash loan arbitrage on Chain A
 *    - Bridge profit to Chain B
 *    - Execute flash loan arbitrage on Chain B using bridged capital as base
 *
 * 3. STARGATE_ATOMIC - Use Stargate for cross-chain swaps (requires Stargate integration)
 *    - Initiate swap on Chain A via Stargate
 *    - Stargate delivers tokens to Chain B
 *    - Chain B contract receives and executes arbitrage
 *    - Note: Not truly atomic, has bridge latency
 *
 * @example
 * ```javascript
 * const coordinator = new CrossChainFlashLoanCoordinator(config);
 * coordinator.registerChain(56, bscExecutionManager, bscProvider);
 * coordinator.registerChain(1, ethExecutionManager, ethProvider);
 *
 * coordinator.on('executionComplete', (result) => {
 *     console.log('Cross-chain execution complete', result);
 * });
 *
 * await coordinator.executeDualChain(crossChainOpportunity);
 * ```
 */
class CrossChainFlashLoanCoordinator extends EventEmitter {
    constructor(options = {}) {
        super();

        // Registered chains: chainId -> { executionManager, provider, signer, contract }
        this.chains = new Map();

        // Configuration
        this.config = {
            maxPriceAgeSec: options.maxPriceAgeSec || 10,
            minProfitUSD: options.minProfitUSD || 5,
            maxSlippagePercent: options.maxSlippagePercent || 1.0,
            parallelExecutionTimeout: options.parallelExecutionTimeout || 30000, // 30s
            bridgeTimeoutMs: options.bridgeTimeoutMs || 600000, // 10 minutes
            ...options,
        };

        // Execution states
        this.pendingExecutions = new Map(); // executionId -> ExecutionState
        this.executionHistory = [];
        this.maxHistorySize = 1000;

        // Bridge integration (placeholder - implement specific bridges)
        this.bridges = new Map(); // "chainA-chainB" -> BridgeAdapter

        // Statistics
        this.stats = {
            dualChainAttempted: 0,
            dualChainSuccess: 0,
            dualChainFailed: 0,
            bridgeAndFlashAttempted: 0,
            bridgeAndFlashSuccess: 0,
            bridgeAndFlashFailed: 0,
            totalProfitUSD: 0,
            averageExecutionTimeMs: 0,
        };

        log.info('CrossChainFlashLoanCoordinator initialized', {
            maxPriceAgeSec: this.config.maxPriceAgeSec,
            minProfitUSD: this.config.minProfitUSD,
        });
    }

    /**
     * Register a chain for cross-chain execution
     *
     * @param {number} chainId - Chain ID
     * @param {Object} executionManager - ExecutionManager instance for this chain
     * @param {Object} provider - ethers Provider for this chain
     * @param {Object} signer - ethers Signer for this chain
     * @param {string} contractAddress - Flash arbitrage contract address on this chain
     */
    registerChain(chainId, executionManager, provider, signer = null, contractAddress = null) {
        this.chains.set(chainId, {
            executionManager,
            provider,
            signer,
            contractAddress,
            lastBlockNumber: 0,
        });

        log.info(`Registered chain ${chainId} for cross-chain coordination`, {
            hasContract: !!contractAddress,
            hasSigner: !!signer,
        });
    }

    /**
     * Unregister a chain
     *
     * @param {number} chainId - Chain ID
     */
    unregisterChain(chainId) {
        this.chains.delete(chainId);
        log.info(`Unregistered chain ${chainId} from cross-chain coordination`);
    }

    /**
     * Check if both chains are ready for execution
     *
     * @param {number} chainA - First chain ID
     * @param {number} chainB - Second chain ID
     * @returns {Object} { ready: boolean, reason?: string }
     */
    checkChainsReady(chainA, chainB) {
        const chainAData = this.chains.get(chainA);
        const chainBData = this.chains.get(chainB);

        if (!chainAData) {
            return { ready: false, reason: `Chain ${chainA} not registered` };
        }

        if (!chainBData) {
            return { ready: false, reason: `Chain ${chainB} not registered` };
        }

        if (!chainAData.executionManager) {
            return { ready: false, reason: `Chain ${chainA} missing executionManager` };
        }

        if (!chainBData.executionManager) {
            return { ready: false, reason: `Chain ${chainB} missing executionManager` };
        }

        return { ready: true };
    }

    // ============ Strategy 1: Dual Chain Atomic ============

    /**
     * Execute dual-chain atomic arbitrage
     *
     * This strategy executes independent flash loan arbitrage on BOTH chains simultaneously.
     * Each chain captures profit independently based on local price discrepancies.
     *
     * @param {Object} opportunity - Cross-chain opportunity from CrossChainDetector
     * @returns {Object} Execution result
     */
    async executeDualChain(opportunity) {
        const executionId = this._generateExecutionId();
        const startTime = Date.now();

        this.stats.dualChainAttempted++;

        log.info(`[${executionId}] Starting dual-chain execution`, {
            token: opportunity.token,
            buyChain: opportunity.buyChain.chainId,
            sellChain: opportunity.sellChain.chainId,
            spreadPercent: opportunity.spreadPercent,
        });

        try {
            // Validate opportunity is still fresh
            const validation = this._validateOpportunity(opportunity);
            if (!validation.valid) {
                throw new Error(`Invalid opportunity: ${validation.reason}`);
            }

            // Check chains are ready
            const readiness = this.checkChainsReady(
                opportunity.buyChain.chainId,
                opportunity.sellChain.chainId
            );
            if (!readiness.ready) {
                throw new Error(readiness.reason);
            }

            // Build opportunities for each chain
            const buyChainOpp = this._buildChainOpportunity(opportunity, 'buy');
            const sellChainOpp = this._buildChainOpportunity(opportunity, 'sell');

            // Execute on both chains in parallel
            const results = await this._executeParallel([
                {
                    chainId: opportunity.buyChain.chainId,
                    opportunity: buyChainOpp,
                    type: 'buy',
                },
                {
                    chainId: opportunity.sellChain.chainId,
                    opportunity: sellChainOpp,
                    type: 'sell',
                },
            ]);

            // Aggregate results
            const executionTime = Date.now() - startTime;
            const result = this._aggregateResults(executionId, results, executionTime);

            if (result.success) {
                this.stats.dualChainSuccess++;
                this.stats.totalProfitUSD += result.totalProfitUSD;
                this._updateAverageExecutionTime(executionTime);

                log.info(`[${executionId}] Dual-chain execution SUCCESS`, {
                    totalProfitUSD: result.totalProfitUSD,
                    executionTimeMs: executionTime,
                });
            } else {
                this.stats.dualChainFailed++;
                log.warn(`[${executionId}] Dual-chain execution FAILED`, {
                    reason: result.failureReason,
                });
            }

            // Store in history
            this._recordExecution(result);

            this.emit('executionComplete', result);
            return result;

        } catch (error) {
            this.stats.dualChainFailed++;
            const result = {
                executionId,
                success: false,
                strategy: 'DUAL_CHAIN_ATOMIC',
                error: error.message,
                executionTimeMs: Date.now() - startTime,
            };

            this._recordExecution(result);
            log.error(`[${executionId}] Dual-chain execution ERROR`, { error: error.message });

            this.emit('executionError', result);
            return result;
        }
    }

    /**
     * Execute opportunities on multiple chains in parallel
     *
     * @private
     * @param {Array} chainOpportunities - Array of { chainId, opportunity, type }
     * @returns {Array} Results from each chain
     */
    async _executeParallel(chainOpportunities) {
        const promises = chainOpportunities.map(async (item) => {
            const chainData = this.chains.get(item.chainId);
            if (!chainData) {
                return {
                    chainId: item.chainId,
                    success: false,
                    error: `Chain ${item.chainId} not registered`,
                };
            }

            try {
                // Use execution manager for this chain
                const result = await Promise.race([
                    chainData.executionManager.execute(item.opportunity),
                    this._timeout(this.config.parallelExecutionTimeout),
                ]);

                return {
                    chainId: item.chainId,
                    type: item.type,
                    success: result?.success || false,
                    txHash: result?.txHash,
                    profitUSD: result?.profitUSD || 0,
                    gasUsed: result?.gasUsed,
                    error: result?.error,
                };
            } catch (error) {
                return {
                    chainId: item.chainId,
                    type: item.type,
                    success: false,
                    error: error.message,
                };
            }
        });

        return Promise.all(promises);
    }

    // ============ Strategy 2: Bridge and Flash ============

    /**
     * Execute bridge-and-flash strategy
     *
     * This strategy:
     * 1. Executes flash loan arbitrage on source chain
     * 2. Bridges profit to destination chain
     * 3. Executes flash loan arbitrage on destination chain using bridged capital as base
     *
     * @param {Object} opportunity - Cross-chain opportunity
     * @param {Object} bridgeConfig - Bridge configuration
     * @returns {Object} Execution result
     */
    async executeBridgeAndFlash(opportunity, bridgeConfig = {}) {
        const executionId = this._generateExecutionId();
        const startTime = Date.now();

        this.stats.bridgeAndFlashAttempted++;

        log.info(`[${executionId}] Starting bridge-and-flash execution`, {
            token: opportunity.token,
            sourceChain: opportunity.buyChain.chainId,
            destChain: opportunity.sellChain.chainId,
        });

        const state = {
            executionId,
            phase: 'INIT',
            sourceChainResult: null,
            bridgeResult: null,
            destChainResult: null,
        };

        this.pendingExecutions.set(executionId, state);

        try {
            // Phase 1: Execute on source chain
            state.phase = 'SOURCE_EXECUTION';
            const sourceOpp = this._buildChainOpportunity(opportunity, 'buy');
            const sourceChainData = this.chains.get(opportunity.buyChain.chainId);

            state.sourceChainResult = await sourceChainData.executionManager.execute(sourceOpp);

            if (!state.sourceChainResult?.success) {
                throw new Error(`Source chain execution failed: ${state.sourceChainResult?.error}`);
            }

            // Phase 2: Bridge profit to destination chain
            state.phase = 'BRIDGING';
            const profitAmount = state.sourceChainResult.profitUSD || 0;

            if (profitAmount < this.config.minProfitUSD) {
                log.warn(`[${executionId}] Skipping bridge - profit too low: $${profitAmount}`);
                // Skip bridge and dest chain execution
            } else {
                state.bridgeResult = await this._executeBridge(
                    opportunity.buyChain.chainId,
                    opportunity.sellChain.chainId,
                    opportunity.token,
                    profitAmount,
                    bridgeConfig
                );

                if (!state.bridgeResult?.success) {
                    log.warn(`[${executionId}] Bridge failed, continuing without dest chain`);
                } else {
                    // Phase 3: Execute on destination chain
                    state.phase = 'DEST_EXECUTION';
                    const destOpp = this._buildChainOpportunity(opportunity, 'sell');
                    const destChainData = this.chains.get(opportunity.sellChain.chainId);

                    state.destChainResult = await destChainData.executionManager.execute(destOpp);
                }
            }

            // Aggregate final result
            state.phase = 'COMPLETE';
            const executionTime = Date.now() - startTime;

            const result = {
                executionId,
                success: true,
                strategy: 'BRIDGE_AND_FLASH',
                sourceChain: {
                    chainId: opportunity.buyChain.chainId,
                    ...state.sourceChainResult,
                },
                bridge: state.bridgeResult,
                destChain: state.destChainResult ? {
                    chainId: opportunity.sellChain.chainId,
                    ...state.destChainResult,
                } : null,
                totalProfitUSD: this._calculateTotalProfit(state),
                executionTimeMs: executionTime,
            };

            this.stats.bridgeAndFlashSuccess++;
            this.stats.totalProfitUSD += result.totalProfitUSD;
            this._updateAverageExecutionTime(executionTime);

            this._recordExecution(result);
            this.pendingExecutions.delete(executionId);

            this.emit('executionComplete', result);
            return result;

        } catch (error) {
            this.stats.bridgeAndFlashFailed++;
            state.phase = 'FAILED';

            const result = {
                executionId,
                success: false,
                strategy: 'BRIDGE_AND_FLASH',
                phase: state.phase,
                error: error.message,
                partialResults: {
                    sourceChain: state.sourceChainResult,
                    bridge: state.bridgeResult,
                },
                executionTimeMs: Date.now() - startTime,
            };

            this._recordExecution(result);
            this.pendingExecutions.delete(executionId);

            log.error(`[${executionId}] Bridge-and-flash ERROR`, { error: error.message });
            this.emit('executionError', result);
            return result;
        }
    }

    // ============ Bridge Integration ============

    /**
     * Register a bridge adapter
     *
     * @param {number} fromChain - Source chain ID
     * @param {number} toChain - Destination chain ID
     * @param {Object} adapter - Bridge adapter with execute() method
     */
    registerBridge(fromChain, toChain, adapter) {
        const key = `${fromChain}-${toChain}`;
        this.bridges.set(key, adapter);
        log.info(`Registered bridge: ${fromChain} -> ${toChain}`);
    }

    /**
     * Execute bridge transfer
     *
     * @private
     * @param {number} fromChain - Source chain ID
     * @param {number} toChain - Destination chain ID
     * @param {string} token - Token to bridge
     * @param {number} amount - Amount to bridge (USD value)
     * @param {Object} config - Bridge configuration
     * @returns {Object} Bridge result
     */
    async _executeBridge(fromChain, toChain, token, amount, bridgeConfig = {}) {
        const key = `${fromChain}-${toChain}`;
        const adapter = this.bridges.get(key);

        if (!adapter) {
            log.warn(`No bridge adapter for ${fromChain} -> ${toChain}`);
            return {
                success: false,
                error: 'No bridge adapter registered',
            };
        }

        try {
            const result = await Promise.race([
                adapter.execute({
                    token,
                    amount,
                    fromChain,
                    toChain,
                    ...bridgeConfig,
                }),
                this._timeout(this.config.bridgeTimeoutMs),
            ]);

            return {
                success: true,
                ...result,
            };
        } catch (error) {
            return {
                success: false,
                error: error.message,
            };
        }
    }

    // ============ Helper Methods ============

    /**
     * Validate opportunity is still actionable
     *
     * @private
     */
    _validateOpportunity(opportunity) {
        const now = Date.now();
        const maxAge = this.config.maxPriceAgeSec * 1000;

        if (!opportunity.timestamp) {
            return { valid: false, reason: 'Missing timestamp' };
        }

        if (now - opportunity.timestamp > maxAge) {
            return { valid: false, reason: 'Opportunity too old' };
        }

        if (opportunity.estimatedProfitUSD < this.config.minProfitUSD) {
            return { valid: false, reason: 'Profit below minimum' };
        }

        if (!opportunity.buyChain || !opportunity.sellChain) {
            return { valid: false, reason: 'Missing chain information' };
        }

        return { valid: true };
    }

    /**
     * Build chain-specific opportunity from cross-chain opportunity
     *
     * @private
     */
    _buildChainOpportunity(crossChainOpp, side) {
        const chainData = side === 'buy' ? crossChainOpp.buyChain : crossChainOpp.sellChain;

        return {
            type: 'cross-chain-leg',
            token: crossChainOpp.token,
            chainId: chainData.chainId,
            side,
            dex: chainData.dex,
            priceUSD: chainData.priceUSD,
            blockNumber: chainData.blockNumber,
            tradeSizeUSD: crossChainOpp.tradeSizeUSD,
            minProfit: this.config.minProfitUSD,
            crossChainRef: crossChainOpp,
            source: 'cross-chain-coordinator',
        };
    }

    /**
     * Aggregate results from parallel execution
     *
     * FIX v3.5: Improved partial execution tracking
     * - Distinguishes between full success, partial success, and full failure
     * - Tracks failed chains and their error reasons
     * - Calculates net profit accounting for gas costs on failed chains
     *
     * @private
     */
    _aggregateResults(executionId, results, executionTime) {
        const successCount = results.filter(r => r.success).length;
        const failedCount = results.length - successCount;
        const totalProfit = results.reduce((sum, r) => sum + (r.profitUSD || 0), 0);

        // FIX v3.5: Track failed chains for better diagnostics
        const failedChains = results
            .filter(r => !r.success)
            .map(r => ({
                chainId: r.chainId,
                type: r.type,
                error: r.error || 'Unknown error',
            }));

        // FIX v3.5: Estimate gas cost lost on failed chains (conservative estimate)
        // Failed txs still cost gas if they were submitted
        const estimatedGasLossUSD = failedChains.length * 0.5; // ~$0.50 per failed tx estimate
        const netProfitUSD = Math.max(0, totalProfit - estimatedGasLossUSD);

        // FIX v3.5: Determine execution status more precisely
        let status;
        let failureReason = null;
        if (successCount === results.length) {
            status = 'FULL_SUCCESS';
        } else if (successCount > 0) {
            status = 'PARTIAL_SUCCESS';
            failureReason = `${failedCount}/${results.length} chains failed: ${failedChains.map(f => `Chain ${f.chainId}: ${f.error}`).join('; ')}`;
        } else {
            status = 'FULL_FAILURE';
            failureReason = 'All chains failed';
        }

        return {
            executionId,
            success: successCount > 0,
            // FIX v3.5: Add partialSuccess flag for better status tracking
            partialSuccess: successCount > 0 && successCount < results.length,
            status,
            strategy: 'DUAL_CHAIN_ATOMIC',
            successCount,
            failedCount,
            totalCount: results.length,
            totalProfitUSD: netProfitUSD,
            grossProfitUSD: totalProfit,
            estimatedGasLossUSD,
            results,
            failedChains,
            executionTimeMs: executionTime,
            failureReason,
        };
    }

    /**
     * Calculate total profit from bridge-and-flash execution
     *
     * @private
     */
    _calculateTotalProfit(state) {
        let total = 0;

        if (state.sourceChainResult?.profitUSD) {
            total += state.sourceChainResult.profitUSD;
        }

        if (state.destChainResult?.profitUSD) {
            total += state.destChainResult.profitUSD;
        }

        // Subtract bridge costs
        if (state.bridgeResult?.costUSD) {
            total -= state.bridgeResult.costUSD;
        }

        return Math.max(0, total);
    }

    /**
     * Generate unique execution ID
     *
     * @private
     */
    _generateExecutionId() {
        return `xc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Create timeout promise
     *
     * @private
     */
    _timeout(ms) {
        return new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Operation timed out')), ms);
        });
    }

    /**
     * Update average execution time
     *
     * @private
     */
    _updateAverageExecutionTime(newTime) {
        const totalExecutions = this.stats.dualChainSuccess + this.stats.bridgeAndFlashSuccess;
        if (totalExecutions === 0) {
            this.stats.averageExecutionTimeMs = newTime;
        } else {
            this.stats.averageExecutionTimeMs =
                (this.stats.averageExecutionTimeMs * (totalExecutions - 1) + newTime) / totalExecutions;
        }
    }

    /**
     * Record execution in history
     *
     * @private
     */
    _recordExecution(result) {
        this.executionHistory.push({
            ...result,
            recordedAt: Date.now(),
        });

        // Trim history if needed
        if (this.executionHistory.length > this.maxHistorySize) {
            this.executionHistory = this.executionHistory.slice(-this.maxHistorySize);
        }
    }

    // ============ Status & Statistics ============

    /**
     * Get coordinator statistics
     *
     * @returns {Object} Statistics
     */
    getStats() {
        return {
            ...this.stats,
            chainsRegistered: this.chains.size,
            bridgesRegistered: this.bridges.size,
            pendingExecutions: this.pendingExecutions.size,
            historySize: this.executionHistory.length,
            successRate: this._calculateSuccessRate(),
        };
    }

    /**
     * Calculate overall success rate
     *
     * @private
     */
    _calculateSuccessRate() {
        const totalAttempted = this.stats.dualChainAttempted + this.stats.bridgeAndFlashAttempted;
        const totalSuccess = this.stats.dualChainSuccess + this.stats.bridgeAndFlashSuccess;

        if (totalAttempted === 0) return '0%';
        return `${((totalSuccess / totalAttempted) * 100).toFixed(1)}%`;
    }

    /**
     * Get execution history
     *
     * @param {number} limit - Max results to return
     * @returns {Array} Recent executions
     */
    getHistory(limit = 100) {
        return this.executionHistory.slice(-limit);
    }

    /**
     * Get pending execution status
     *
     * @param {string} executionId - Execution ID
     * @returns {Object|null} Execution state
     */
    getPendingExecution(executionId) {
        return this.pendingExecutions.get(executionId) || null;
    }

    /**
     * Get registered chains
     *
     * @returns {Array} Array of chain IDs
     */
    getRegisteredChains() {
        return Array.from(this.chains.keys());
    }

    /**
     * Reset statistics
     */
    resetStats() {
        this.stats = {
            dualChainAttempted: 0,
            dualChainSuccess: 0,
            dualChainFailed: 0,
            bridgeAndFlashAttempted: 0,
            bridgeAndFlashSuccess: 0,
            bridgeAndFlashFailed: 0,
            totalProfitUSD: 0,
            averageExecutionTimeMs: 0,
        };
    }

    /**
     * Cleanup resources
     */
    cleanup() {
        this.chains.clear();
        this.bridges.clear();
        this.pendingExecutions.clear();
        this.removeAllListeners();
        log.info('CrossChainFlashLoanCoordinator cleaned up');
    }
}

// Export singleton instance
const crossChainCoordinator = new CrossChainFlashLoanCoordinator();
export default crossChainCoordinator;

// Also export class for testing
export { CrossChainFlashLoanCoordinator };
