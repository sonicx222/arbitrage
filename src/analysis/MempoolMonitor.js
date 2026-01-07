import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import log from '../utils/logger.js';

/**
 * MempoolMonitor - Monitors pending transactions for arbitrage opportunities
 *
 * Features:
 * 1. Detect large swaps that will move prices
 * 2. Identify frontrunning opportunities
 * 3. Track competitor arbitrage transactions
 *
 * IMPORTANT: This requires a WebSocket connection to an archive/MEV-enabled node
 * that supports pendingTransactions subscription (eth_subscribe newPendingTransactions)
 *
 * Supported providers:
 * - Alchemy (with mempool API access)
 * - Flashbots Protect RPC
 * - Blocknative
 * - QuickNode with mempool add-on
 */
export default class MempoolMonitor extends EventEmitter {
    constructor(config = {}) {
        super();

        this.enabled = config.enabled || false;
        this.chainId = config.chainId || 56;

        // Router addresses to monitor (DEX routers)
        this.routerAddresses = new Set();
        if (config.dex) {
            for (const dex of Object.values(config.dex)) {
                if (dex.router && dex.enabled) {
                    this.routerAddresses.add(dex.router.toLowerCase());
                }
            }
        }

        // Swap method signatures (Uniswap V2 style)
        this.swapSignatures = new Map([
            ['0x38ed1739', 'swapExactTokensForTokens'],
            ['0x8803dbee', 'swapTokensForExactTokens'],
            ['0x7ff36ab5', 'swapExactETHForTokens'],
            ['0x18cbafe5', 'swapExactTokensForETH'],
            ['0xfb3bdb41', 'swapETHForExactTokens'],
            ['0x5c11d795', 'swapExactTokensForTokensSupportingFeeOnTransferTokens'],
            ['0xb6f9de95', 'swapExactETHForTokensSupportingFeeOnTransferTokens'],
            ['0x791ac947', 'swapExactTokensForETHSupportingFeeOnTransferTokens'],
        ]);

        // Minimum swap size to track (in wei for native token, or USD equivalent)
        this.minSwapSizeUSD = config.minSwapSizeUSD || 10000;

        // Pending transaction cache
        this.pendingSwaps = new Map(); // txHash -> { decoded, timestamp }
        this.maxPendingSwaps = config.maxPendingSwaps || 500;

        // WebSocket provider
        this.wsProvider = null;
        this.isMonitoring = false;

        // Stale entry cleanup timer
        this.cleanupTimer = null;
        this.staleThresholdMs = 120000; // 2 minutes

        // Statistics
        this.stats = {
            txsProcessed: 0,
            swapsDetected: 0,
            largeSwaps: 0,
            errors: 0,
        };

        // Router interface for decoding
        this.routerInterface = new ethers.Interface([
            'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline)',
            'function swapTokensForExactTokens(uint amountOut, uint amountInMax, address[] path, address to, uint deadline)',
            'function swapExactETHForTokens(uint amountOutMin, address[] path, address to, uint deadline)',
            'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline)',
            'function swapETHForExactTokens(uint amountOut, address[] path, address to, uint deadline)',
        ]);

        log.info('MempoolMonitor initialized', {
            enabled: this.enabled,
            chainId: this.chainId,
            routersTracked: this.routerAddresses.size,
            minSwapSizeUSD: this.minSwapSizeUSD,
        });
    }

    /**
     * Start monitoring the mempool
     * @param {Object} wsProvider - WebSocket provider with pendingTransactions support
     */
    async start(wsProvider) {
        if (!this.enabled) {
            log.info('Mempool monitoring disabled');
            return;
        }

        if (this.isMonitoring) {
            log.warn('Mempool monitor already running');
            return;
        }

        if (!wsProvider) {
            log.error('WebSocket provider required for mempool monitoring');
            return;
        }

        this.wsProvider = wsProvider;

        try {
            // Subscribe to pending transactions
            // Note: Not all providers support this
            this.wsProvider.on('pending', async (txHash) => {
                await this.processPendingTransaction(txHash);
            });

            // Start periodic cleanup to prevent unbounded growth
            // Runs every 30 seconds to remove stale entries
            this.cleanupTimer = setInterval(() => {
                this._cleanupStaleEntries();
            }, 30000);
            // Unref to not block process exit
            this.cleanupTimer.unref?.();

            this.isMonitoring = true;
            log.info('Mempool monitoring started');

        } catch (error) {
            log.error('Failed to start mempool monitoring', { error: error.message });
            this.stats.errors++;
        }
    }

    /**
     * Process a pending transaction
     * @param {string} txHash - Transaction hash
     */
    async processPendingTransaction(txHash) {
        try {
            // Fetch transaction details
            const tx = await this.wsProvider.getTransaction(txHash);

            if (!tx || !tx.to) return;

            this.stats.txsProcessed++;

            // Check if it's to a monitored router
            const to = tx.to.toLowerCase();
            if (!this.routerAddresses.has(to)) return;

            // Check if it's a swap method
            const methodId = tx.data.slice(0, 10);
            const methodName = this.swapSignatures.get(methodId);
            if (!methodName) return;

            this.stats.swapsDetected++;

            // Try to decode the swap
            const decoded = this.decodeSwap(tx, methodName);
            if (!decoded) return;

            // Check if it's a large swap
            const isLarge = this.isLargeSwap(decoded, tx.value);

            if (isLarge) {
                this.stats.largeSwaps++;

                const swapInfo = {
                    txHash,
                    router: to,
                    method: methodName,
                    ...decoded,
                    gasPrice: tx.gasPrice?.toString(),
                    maxFeePerGas: tx.maxFeePerGas?.toString(),
                    maxPriorityFeePerGas: tx.maxPriorityFeePerGas?.toString(),
                    nonce: tx.nonce,
                    from: tx.from,
                    value: tx.value?.toString(),
                    timestamp: Date.now(),
                };

                // Cache the pending swap
                this.cachePendingSwap(txHash, swapInfo);

                // Emit event for potential frontrunning
                this.emit('largeSwap', swapInfo);

                log.debug('Large swap detected in mempool', {
                    txHash: txHash.slice(0, 10) + '...',
                    method: methodName,
                    path: decoded.path?.slice(0, 2).map(a => a.slice(0, 10) + '...'),
                });
            }

        } catch (error) {
            // Silently ignore individual tx errors (common with mempool)
            if (error.code !== 'TIMEOUT') {
                this.stats.errors++;
            }
        }
    }

    /**
     * Decode a swap transaction
     * @param {Object} tx - Transaction object
     * @param {string} methodName - Method name
     * @returns {Object|null} Decoded swap data
     */
    decodeSwap(tx, methodName) {
        try {
            const decoded = this.routerInterface.parseTransaction({
                data: tx.data,
                value: tx.value,
            });

            if (!decoded) return null;

            return {
                method: methodName,
                amountIn: decoded.args.amountIn?.toString() || decoded.args.amountInMax?.toString(),
                amountOut: decoded.args.amountOutMin?.toString() || decoded.args.amountOut?.toString(),
                path: decoded.args.path,
                to: decoded.args.to,
                deadline: decoded.args.deadline?.toString(),
            };

        } catch (error) {
            return null;
        }
    }

    /**
     * Check if a swap is large enough to track
     * @param {Object} decoded - Decoded swap data
     * @param {BigInt} value - Transaction value (for ETH swaps)
     * @returns {boolean}
     */
    isLargeSwap(decoded, value) {
        // For ETH swaps, check the value
        if (value && value > 0n) {
            // Assume 1 ETH ≈ $3000, 1 BNB ≈ $600
            const ethPrice = this.chainId === 1 ? 3000 : 600;
            const valueUSD = (Number(value) / 1e18) * ethPrice;
            return valueUSD >= this.minSwapSizeUSD;
        }

        // For token swaps, check amountIn (rough estimate)
        if (decoded.amountIn) {
            // This is a rough check - actual value depends on token
            // Consider amounts > 1000 tokens as potentially large
            const amount = BigInt(decoded.amountIn);
            return amount > BigInt('1000000000000000000000'); // > 1000 tokens (18 decimals)
        }

        return false;
    }

    /**
     * Cache a pending swap
     * @param {string} txHash - Transaction hash
     * @param {Object} swapInfo - Swap information
     */
    cachePendingSwap(txHash, swapInfo) {
        // Clean stale entries periodically (every ~50 inserts)
        if (this.pendingSwaps.size > 0 && this.pendingSwaps.size % 50 === 0) {
            this._cleanupStaleEntries();
        }

        // Evict old entries if cache is full
        if (this.pendingSwaps.size >= this.maxPendingSwaps) {
            // Remove oldest entry
            const oldestKey = this.pendingSwaps.keys().next().value;
            this.pendingSwaps.delete(oldestKey);
        }

        this.pendingSwaps.set(txHash, swapInfo);
    }

    /**
     * Clean up stale entries from the pending swaps cache
     * @private
     */
    _cleanupStaleEntries() {
        const now = Date.now();
        let cleaned = 0;

        for (const [txHash, swap] of this.pendingSwaps) {
            if (now - swap.timestamp > this.staleThresholdMs) {
                this.pendingSwaps.delete(txHash);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            log.debug(`Mempool cache cleanup: removed ${cleaned} stale entries, ${this.pendingSwaps.size} remaining`);
        }
    }

    /**
     * Get pending swaps for a specific token path
     * @param {string} tokenIn - Input token address
     * @param {string} tokenOut - Output token address
     * @returns {Array} Pending swaps matching the path
     */
    getPendingSwapsForPath(tokenIn, tokenOut) {
        const matches = [];
        const now = Date.now();

        for (const [txHash, swap] of this.pendingSwaps) {
            // Remove stale entries (> 2 minutes old)
            if (now - swap.timestamp > 120000) {
                this.pendingSwaps.delete(txHash);
                continue;
            }

            // Check if path matches
            if (swap.path && swap.path.length >= 2) {
                const pathStart = swap.path[0].toLowerCase();
                const pathEnd = swap.path[swap.path.length - 1].toLowerCase();

                if (pathStart === tokenIn.toLowerCase() &&
                    pathEnd === tokenOut.toLowerCase()) {
                    matches.push(swap);
                }
            }
        }

        return matches;
    }

    /**
     * Estimate price impact of pending swaps
     * @param {string} tokenIn - Input token address
     * @param {string} tokenOut - Output token address
     * @param {Object} reserves - Current pool reserves
     * @returns {Object} { totalPendingVolume, estimatedPriceImpact }
     */
    estimatePendingImpact(tokenIn, tokenOut, reserves) {
        const pendingSwaps = this.getPendingSwapsForPath(tokenIn, tokenOut);

        if (pendingSwaps.length === 0) {
            return { totalPendingVolume: 0n, estimatedPriceImpact: 0 };
        }

        let totalVolume = 0n;

        for (const swap of pendingSwaps) {
            if (swap.amountIn) {
                totalVolume += BigInt(swap.amountIn);
            }
        }

        // Estimate price impact using constant product formula
        // Impact ≈ amountIn / reserveIn
        const reserveIn = BigInt(reserves.reserveIn || reserves.reserve0 || 0);

        if (reserveIn === 0n) {
            return { totalPendingVolume: totalVolume, estimatedPriceImpact: 0 };
        }

        const impactPercent = (Number(totalVolume) / Number(reserveIn)) * 100;

        return {
            totalPendingVolume: totalVolume,
            estimatedPriceImpact: parseFloat(impactPercent.toFixed(4)),
            pendingSwapCount: pendingSwaps.length,
        };
    }

    /**
     * Stop monitoring
     */
    stop() {
        if (!this.isMonitoring) return;

        // Clear cleanup timer
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }

        if (this.wsProvider) {
            this.wsProvider.removeAllListeners('pending');
        }

        this.isMonitoring = false;
        this.pendingSwaps.clear();

        log.info('Mempool monitoring stopped', { stats: this.stats });
    }

    /**
     * Get statistics
     */
    getStats() {
        return {
            ...this.stats,
            isMonitoring: this.isMonitoring,
            pendingSwapsCached: this.pendingSwaps.size,
        };
    }

    /**
     * Check if monitoring is active
     */
    isActive() {
        return this.enabled && this.isMonitoring;
    }
}
