import { ethers } from 'ethers';
import log from '../utils/logger.js';
import config from '../config.js';

/**
 * Flashbots Provider
 *
 * Provides MEV protection by submitting transactions directly to block builders
 * via the Flashbots relay, bypassing the public mempool.
 *
 * Key Features:
 * - Private transaction submission (no mempool exposure)
 * - Bundle simulation before submission
 * - Atomic bundle execution (all-or-nothing)
 * - Bundle status tracking
 * - Multi-builder support (MEV-Share, MEV Blocker)
 *
 * Usage:
 * ```javascript
 * await flashbotsProvider.initialize(signer, 1); // Ethereum mainnet
 * const bundle = await flashbotsProvider.createBundle([signedTx], targetBlock);
 * const result = await flashbotsProvider.submitBundle(bundle);
 * ```
 *
 * @see https://docs.flashbots.net/
 */
class FlashbotsProvider {
    constructor() {
        // Relay endpoints by chain ID
        this.relayEndpoints = {
            1: 'https://relay.flashbots.net',           // Ethereum Mainnet
            5: 'https://relay-goerli.flashbots.net',    // Goerli (deprecated)
            11155111: 'https://relay-sepolia.flashbots.net', // Sepolia testnet
        };

        // Alternative relays for redundancy
        this.alternativeRelays = {
            1: [
                'https://rpc.beaverbuild.org',          // Beaver Builder
                'https://rpc.titanbuilder.xyz',         // Titan Builder
                'https://builder0x69.io',               // Builder0x69
                'https://rsync-builder.xyz',            // Rsync Builder
            ],
        };

        // State
        this.initialized = false;
        this.signer = null;
        this.authSigner = null; // Separate signer for Flashbots authentication
        this.chainId = null;
        this.provider = null;
        this.relayUrl = null;

        // Configuration
        this.config = {
            maxRetries: 3,
            retryDelayMs: 1000,
            simulationEnabled: true,
            useAlternativeRelays: true,
            bundleTimeoutBlocks: 25, // Max blocks to wait for inclusion
            minPriorityFee: ethers.parseUnits('1', 'gwei'),
            maxPriorityFee: ethers.parseUnits('50', 'gwei'),
        };

        // Statistics
        this.stats = {
            bundlesCreated: 0,
            bundlesSubmitted: 0,
            bundlesIncluded: 0,
            bundlesFailed: 0,
            simulationsRun: 0,
            simulationsPassed: 0,
            simulationsFailed: 0,
            totalGasSaved: 0n,
            averageInclusionBlocks: 0,
        };

        // Bundle tracking
        this.pendingBundles = new Map(); // bundleHash -> { bundle, targetBlock, timestamp }
        this.maxPendingBundles = 100;

        log.info('FlashbotsProvider created');
    }

    /**
     * Initialize the Flashbots provider
     *
     * @param {ethers.Signer} signer - Signer for transaction signing
     * @param {number} chainId - Chain ID (1 for Ethereum mainnet)
     * @param {Object} options - Optional configuration
     */
    async initialize(signer, chainId, options = {}) {
        // Validate chain support
        if (!this.relayEndpoints[chainId]) {
            log.warn('Flashbots not available for this chain', { chainId });
            return false;
        }

        this.chainId = chainId;
        this.signer = signer;
        this.provider = signer.provider;
        this.relayUrl = this.relayEndpoints[chainId];

        // Create auth signer for Flashbots reputation
        // This should be a persistent key to build searcher reputation
        if (options.authKey) {
            this.authSigner = new ethers.Wallet(options.authKey);
        } else if (config.flashbots?.authKey) {
            this.authSigner = new ethers.Wallet(config.flashbots.authKey);
        } else {
            // Use main signer as auth signer (not recommended for production)
            this.authSigner = signer;
            log.warn('Using main signer for Flashbots auth - consider using dedicated auth key');
        }

        // Apply configuration overrides
        if (options.maxRetries) this.config.maxRetries = options.maxRetries;
        if (options.simulationEnabled !== undefined) this.config.simulationEnabled = options.simulationEnabled;
        if (options.useAlternativeRelays !== undefined) this.config.useAlternativeRelays = options.useAlternativeRelays;

        this.initialized = true;

        log.info('FlashbotsProvider initialized', {
            chainId,
            relayUrl: this.relayUrl,
            authAddress: await this.authSigner.getAddress(),
            simulationEnabled: this.config.simulationEnabled,
        });

        return true;
    }

    /**
     * Check if Flashbots is available for the current chain
     *
     * @returns {boolean} True if available
     */
    isAvailable() {
        return this.initialized && this.chainId === 1; // Only mainnet for now
    }

    /**
     * Create a Flashbots bundle from transactions
     *
     * @param {Array} transactions - Array of signed transaction hex strings or transaction objects
     * @param {number} targetBlock - Target block number for inclusion
     * @param {Object} options - Bundle options
     * @returns {Object} Bundle object ready for submission
     */
    async createBundle(transactions, targetBlock, options = {}) {
        if (!this.initialized) {
            throw new Error('FlashbotsProvider not initialized');
        }

        // Ensure transactions are properly formatted
        const signedTxs = await this._prepareTransactions(transactions);

        if (signedTxs.length === 0) {
            throw new Error('No valid transactions for bundle');
        }

        // Calculate bundle hash for tracking
        const bundleHash = this._calculateBundleHash(signedTxs, targetBlock);

        const bundle = {
            signedTransactions: signedTxs,
            blockNumber: `0x${targetBlock.toString(16)}`,
            // Optional time bounds
            ...(options.minTimestamp && { minTimestamp: options.minTimestamp }),
            ...(options.maxTimestamp && { maxTimestamp: options.maxTimestamp }),
            // Metadata
            bundleHash,
            createdAt: Date.now(),
            targetBlock,
        };

        this.stats.bundlesCreated++;

        log.debug('Bundle created', {
            bundleHash: bundleHash.slice(0, 18) + '...',
            txCount: signedTxs.length,
            targetBlock,
        });

        return bundle;
    }

    /**
     * Simulate a bundle to check if it will succeed
     *
     * @param {Object} bundle - Bundle to simulate
     * @returns {Object} Simulation result
     */
    async simulateBundle(bundle) {
        if (!this.initialized) {
            throw new Error('FlashbotsProvider not initialized');
        }

        this.stats.simulationsRun++;

        try {
            const payload = {
                jsonrpc: '2.0',
                id: 1,
                method: 'eth_callBundle',
                params: [{
                    txs: bundle.signedTransactions,
                    blockNumber: bundle.blockNumber,
                    stateBlockNumber: 'latest',
                }],
            };

            const response = await this._sendToRelay(payload);

            if (response.error) {
                this.stats.simulationsFailed++;
                return {
                    success: false,
                    error: response.error.message || 'Simulation failed',
                    code: response.error.code,
                };
            }

            const result = response.result;

            // Check for reverts in simulation
            const hasRevert = result.results?.some(r => r.error || r.revert);
            if (hasRevert) {
                this.stats.simulationsFailed++;
                const revertReason = result.results.find(r => r.error || r.revert);
                return {
                    success: false,
                    error: revertReason?.error || revertReason?.revert || 'Transaction reverted',
                    results: result.results,
                };
            }

            this.stats.simulationsPassed++;

            // Calculate effective gas price and potential savings
            const totalGasUsed = result.results?.reduce((sum, r) => sum + BigInt(r.gasUsed || 0), 0n) || 0n;
            const bundleGasPrice = result.bundleGasPrice ? BigInt(result.bundleGasPrice) : 0n;

            return {
                success: true,
                totalGasUsed,
                bundleGasPrice,
                coinbaseDiff: result.coinbaseDiff ? BigInt(result.coinbaseDiff) : 0n,
                gasFees: result.gasFees ? BigInt(result.gasFees) : 0n,
                results: result.results,
                stateBlockNumber: result.stateBlockNumber,
            };

        } catch (error) {
            this.stats.simulationsFailed++;
            log.error('Bundle simulation error', { error: error.message });
            return {
                success: false,
                error: error.message,
            };
        }
    }

    /**
     * Submit a bundle to the Flashbots relay
     *
     * @param {Object} bundle - Bundle to submit
     * @param {Object} options - Submission options
     * @returns {Object} Submission result
     */
    async submitBundle(bundle, options = {}) {
        if (!this.initialized) {
            throw new Error('FlashbotsProvider not initialized');
        }

        // Optionally simulate first
        if (this.config.simulationEnabled && options.skipSimulation !== true) {
            const simResult = await this.simulateBundle(bundle);
            if (!simResult.success) {
                log.warn('Bundle simulation failed, skipping submission', {
                    bundleHash: bundle.bundleHash?.slice(0, 18),
                    error: simResult.error,
                });
                return {
                    success: false,
                    submitted: false,
                    reason: `Simulation failed: ${simResult.error}`,
                    simulation: simResult,
                };
            }
        }

        this.stats.bundlesSubmitted++;

        try {
            const payload = {
                jsonrpc: '2.0',
                id: 1,
                method: 'eth_sendBundle',
                params: [{
                    txs: bundle.signedTransactions,
                    blockNumber: bundle.blockNumber,
                    ...(bundle.minTimestamp && { minTimestamp: bundle.minTimestamp }),
                    ...(bundle.maxTimestamp && { maxTimestamp: bundle.maxTimestamp }),
                    // Optional: revert protection
                    ...(options.revertingTxHashes && { revertingTxHashes: options.revertingTxHashes }),
                }],
            };

            const response = await this._sendToRelay(payload);

            if (response.error) {
                this.stats.bundlesFailed++;
                return {
                    success: false,
                    submitted: true,
                    reason: response.error.message || 'Submission rejected',
                    code: response.error.code,
                };
            }

            // Track pending bundle
            this._trackPendingBundle(bundle);

            log.info('Bundle submitted to Flashbots', {
                bundleHash: bundle.bundleHash?.slice(0, 18) + '...',
                targetBlock: bundle.targetBlock,
            });

            return {
                success: true,
                submitted: true,
                bundleHash: response.result?.bundleHash || bundle.bundleHash,
                targetBlock: bundle.targetBlock,
            };

        } catch (error) {
            this.stats.bundlesFailed++;
            log.error('Bundle submission error', { error: error.message });
            return {
                success: false,
                submitted: false,
                reason: error.message,
            };
        }
    }

    /**
     * Submit bundle to multiple builders for higher inclusion probability
     *
     * @param {Object} bundle - Bundle to submit
     * @returns {Object} Multi-submission result
     */
    async submitToMultipleBuilders(bundle) {
        if (!this.initialized || !this.config.useAlternativeRelays) {
            return this.submitBundle(bundle);
        }

        const relays = [this.relayUrl, ...(this.alternativeRelays[this.chainId] || [])];
        const results = [];

        // Submit to all relays in parallel
        const submissions = relays.map(async (relayUrl) => {
            try {
                const originalRelayUrl = this.relayUrl;
                this.relayUrl = relayUrl;
                const result = await this.submitBundle(bundle, { skipSimulation: true });
                this.relayUrl = originalRelayUrl;
                return { relay: relayUrl, ...result };
            } catch (error) {
                return { relay: relayUrl, success: false, error: error.message };
            }
        });

        const allResults = await Promise.allSettled(submissions);

        for (const result of allResults) {
            if (result.status === 'fulfilled') {
                results.push(result.value);
            } else {
                results.push({ success: false, error: result.reason?.message });
            }
        }

        const successCount = results.filter(r => r.success).length;

        log.info('Multi-builder submission complete', {
            successCount,
            totalRelays: relays.length,
            targetBlock: bundle.targetBlock,
        });

        return {
            success: successCount > 0,
            successCount,
            totalRelays: relays.length,
            results,
        };
    }

    /**
     * Check if a bundle was included in a block
     *
     * @param {string} bundleHash - Bundle hash to check
     * @param {number} targetBlock - Target block number
     * @returns {Object} Inclusion status
     */
    async checkBundleInclusion(bundleHash, targetBlock) {
        if (!this.initialized) {
            throw new Error('FlashbotsProvider not initialized');
        }

        try {
            const payload = {
                jsonrpc: '2.0',
                id: 1,
                method: 'flashbots_getBundleStats',
                params: [bundleHash, `0x${targetBlock.toString(16)}`],
            };

            const response = await this._sendToRelay(payload);

            if (response.error) {
                return {
                    included: false,
                    status: 'unknown',
                    error: response.error.message,
                };
            }

            const stats = response.result;

            // Update statistics if included
            if (stats.isSimulated && stats.isSentToMiners) {
                if (stats.isHighPriority) {
                    // Bundle was included
                    this.stats.bundlesIncluded++;
                    this._removePendingBundle(bundleHash);
                }
            }

            return {
                included: stats.isHighPriority || false,
                status: this._interpretBundleStats(stats),
                stats,
            };

        } catch (error) {
            log.debug('Bundle status check failed', { error: error.message });
            return {
                included: false,
                status: 'error',
                error: error.message,
            };
        }
    }

    /**
     * Wait for bundle inclusion with timeout
     *
     * @param {string} bundleHash - Bundle hash
     * @param {number} targetBlock - Target block
     * @param {number} maxBlocks - Maximum blocks to wait
     * @returns {Object} Final inclusion status
     */
    async waitForInclusion(bundleHash, targetBlock, maxBlocks = 25) {
        const startBlock = await this.provider.getBlockNumber();
        const deadline = targetBlock + maxBlocks;

        log.debug('Waiting for bundle inclusion', {
            bundleHash: bundleHash.slice(0, 18) + '...',
            targetBlock,
            deadline,
        });

        return new Promise((resolve) => {
            const checkInclusion = async () => {
                const currentBlock = await this.provider.getBlockNumber();

                if (currentBlock > deadline) {
                    this._removePendingBundle(bundleHash);
                    resolve({
                        included: false,
                        reason: 'Bundle expired',
                        blocksWaited: currentBlock - startBlock,
                    });
                    return;
                }

                const status = await this.checkBundleInclusion(bundleHash, targetBlock);

                if (status.included) {
                    const blocksToInclusion = currentBlock - startBlock;
                    this._updateInclusionStats(blocksToInclusion);
                    resolve({
                        included: true,
                        blockNumber: currentBlock,
                        blocksToInclusion,
                        stats: status.stats,
                    });
                    return;
                }

                // Check again in ~1 block time
                setTimeout(checkInclusion, 12000);
            };

            checkInclusion();
        });
    }

    /**
     * Cancel a pending bundle (if possible)
     * Note: Flashbots doesn't support true cancellation, but we can stop tracking
     *
     * @param {string} bundleHash - Bundle hash to cancel
     * @returns {boolean} True if bundle was removed from tracking
     */
    cancelBundle(bundleHash) {
        const removed = this.pendingBundles.delete(bundleHash);
        if (removed) {
            log.debug('Bundle cancelled', { bundleHash: bundleHash.slice(0, 18) + '...' });
        }
        return removed;
    }

    /**
     * Get user statistics from Flashbots relay
     *
     * @returns {Object} User stats including reputation
     */
    async getUserStats() {
        if (!this.initialized) {
            throw new Error('FlashbotsProvider not initialized');
        }

        try {
            const payload = {
                jsonrpc: '2.0',
                id: 1,
                method: 'flashbots_getUserStats',
                params: [await this.authSigner.getAddress()],
            };

            const response = await this._sendToRelay(payload);

            if (response.error) {
                return { success: false, error: response.error.message };
            }

            return {
                success: true,
                ...response.result,
            };

        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Send a private transaction (bypasses mempool, no bundle required)
     *
     * @param {string} signedTx - Signed transaction hex
     * @param {Object} options - Options including maxBlockNumber
     * @returns {Object} Submission result
     */
    async sendPrivateTransaction(signedTx, options = {}) {
        if (!this.initialized) {
            throw new Error('FlashbotsProvider not initialized');
        }

        const currentBlock = await this.provider.getBlockNumber();
        const maxBlockNumber = options.maxBlockNumber || currentBlock + 25;

        try {
            const payload = {
                jsonrpc: '2.0',
                id: 1,
                method: 'eth_sendPrivateTransaction',
                params: [{
                    tx: signedTx,
                    maxBlockNumber: `0x${maxBlockNumber.toString(16)}`,
                    preferences: {
                        fast: options.fast !== false, // Default to fast mode
                    },
                }],
            };

            const response = await this._sendToRelay(payload);

            if (response.error) {
                return {
                    success: false,
                    reason: response.error.message,
                };
            }

            return {
                success: true,
                txHash: response.result,
                maxBlockNumber,
            };

        } catch (error) {
            log.error('Private transaction submission failed', { error: error.message });
            return {
                success: false,
                reason: error.message,
            };
        }
    }

    /**
     * Prepare transactions for bundle
     *
     * @private
     * @param {Array} transactions - Raw transactions
     * @returns {Array} Signed transaction hex strings
     */
    async _prepareTransactions(transactions) {
        const signedTxs = [];

        for (const tx of transactions) {
            if (typeof tx === 'string') {
                // Already signed hex string
                signedTxs.push(tx);
            } else if (tx.serialized) {
                // ethers.js transaction response
                signedTxs.push(tx.serialized);
            } else if (tx.to && tx.data) {
                // Unsigned transaction object - sign it
                const signedTx = await this.signer.signTransaction(tx);
                signedTxs.push(signedTx);
            } else {
                log.warn('Invalid transaction format, skipping', { tx });
            }
        }

        return signedTxs;
    }

    /**
     * Calculate bundle hash
     *
     * @private
     * @param {Array} signedTxs - Signed transactions
     * @param {number} targetBlock - Target block
     * @returns {string} Bundle hash
     */
    _calculateBundleHash(signedTxs, targetBlock) {
        const data = signedTxs.join('') + targetBlock.toString();
        return ethers.keccak256(ethers.toUtf8Bytes(data));
    }

    /**
     * Send request to Flashbots relay with authentication
     *
     * @private
     * @param {Object} payload - JSON-RPC payload
     * @returns {Object} Response
     */
    async _sendToRelay(payload) {
        const body = JSON.stringify(payload);
        const signature = await this._signPayload(body);

        const response = await fetch(this.relayUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Flashbots-Signature': `${await this.authSigner.getAddress()}:${signature}`,
            },
            body,
        });

        if (!response.ok) {
            throw new Error(`Relay error: ${response.status} ${response.statusText}`);
        }

        return await response.json();
    }

    /**
     * Sign payload for Flashbots authentication
     *
     * @private
     * @param {string} body - Request body
     * @returns {string} Signature
     */
    async _signPayload(body) {
        const hash = ethers.keccak256(ethers.toUtf8Bytes(body));
        return await this.authSigner.signMessage(ethers.getBytes(hash));
    }

    /**
     * Track a pending bundle
     *
     * @private
     * @param {Object} bundle - Bundle to track
     */
    _trackPendingBundle(bundle) {
        // Enforce size limit
        if (this.pendingBundles.size >= this.maxPendingBundles) {
            // Remove oldest entry
            const oldestKey = this.pendingBundles.keys().next().value;
            if (oldestKey) {
                this.pendingBundles.delete(oldestKey);
            }
        }

        this.pendingBundles.set(bundle.bundleHash, {
            bundle,
            targetBlock: bundle.targetBlock,
            timestamp: Date.now(),
        });
    }

    /**
     * Remove a bundle from pending tracking
     *
     * @private
     * @param {string} bundleHash - Bundle hash
     */
    _removePendingBundle(bundleHash) {
        this.pendingBundles.delete(bundleHash);
    }

    /**
     * Interpret bundle stats into human-readable status
     *
     * @private
     * @param {Object} stats - Bundle stats from relay
     * @returns {string} Status string
     */
    _interpretBundleStats(stats) {
        if (!stats) return 'unknown';
        if (stats.isHighPriority) return 'included';
        if (stats.isSentToMiners) return 'sent_to_builders';
        if (stats.isSimulated) return 'simulated';
        return 'pending';
    }

    /**
     * Update inclusion statistics
     *
     * @private
     * @param {number} blocksToInclusion - Blocks until inclusion
     */
    _updateInclusionStats(blocksToInclusion) {
        const totalInclusions = this.stats.bundlesIncluded;
        const currentAvg = this.stats.averageInclusionBlocks;
        this.stats.averageInclusionBlocks =
            (currentAvg * totalInclusions + blocksToInclusion) / (totalInclusions + 1);
    }

    /**
     * Get provider statistics
     *
     * @returns {Object} Statistics
     */
    getStats() {
        return {
            initialized: this.initialized,
            chainId: this.chainId,
            bundles: {
                created: this.stats.bundlesCreated,
                submitted: this.stats.bundlesSubmitted,
                included: this.stats.bundlesIncluded,
                failed: this.stats.bundlesFailed,
                pending: this.pendingBundles.size,
                inclusionRate: this.stats.bundlesSubmitted > 0
                    ? `${(this.stats.bundlesIncluded / this.stats.bundlesSubmitted * 100).toFixed(1)}%`
                    : '0%',
                averageInclusionBlocks: this.stats.averageInclusionBlocks.toFixed(1),
            },
            simulations: {
                total: this.stats.simulationsRun,
                passed: this.stats.simulationsPassed,
                failed: this.stats.simulationsFailed,
                passRate: this.stats.simulationsRun > 0
                    ? `${(this.stats.simulationsPassed / this.stats.simulationsRun * 100).toFixed(1)}%`
                    : '0%',
            },
        };
    }

    /**
     * Reset statistics
     */
    resetStats() {
        this.stats = {
            bundlesCreated: 0,
            bundlesSubmitted: 0,
            bundlesIncluded: 0,
            bundlesFailed: 0,
            simulationsRun: 0,
            simulationsPassed: 0,
            simulationsFailed: 0,
            totalGasSaved: 0n,
            averageInclusionBlocks: 0,
        };
    }

    /**
     * Cleanup resources
     */
    cleanup() {
        this.pendingBundles.clear();
        this.initialized = false;
        log.debug('FlashbotsProvider cleaned up');
    }
}

// Export singleton instance
const flashbotsProvider = new FlashbotsProvider();
export default flashbotsProvider;
