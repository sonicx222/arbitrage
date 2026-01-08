import { EventEmitter } from 'events';
import log from '../utils/logger.js';

/**
 * BridgeAdapter - Base class for cross-chain bridge integrations
 *
 * Implement this interface for specific bridges:
 * - StargateBridgeAdapter (LayerZero)
 * - AcrossBridgeAdapter (Across Protocol)
 * - CelerBridgeAdapter (Celer Network)
 * - HopBridgeAdapter (Hop Protocol)
 * - AxelarBridgeAdapter (Axelar Network)
 *
 * @abstract
 */
export class BridgeAdapter extends EventEmitter {
    constructor(name, config = {}) {
        super();

        this.name = name;
        this.supportedChains = new Set();
        this.supportedTokens = new Map(); // chainId -> Set of tokens

        // Configuration
        this.config = {
            maxRetries: config.maxRetries || 3,
            retryDelayMs: config.retryDelayMs || 5000,
            defaultSlippageBps: config.defaultSlippageBps || 50, // 0.5%
            ...config,
        };

        // Statistics
        this.stats = {
            bridgesAttempted: 0,
            bridgesSuccess: 0,
            bridgesFailed: 0,
            totalVolumeUSD: 0,
            averageTimeMs: 0,
        };

        log.info(`BridgeAdapter initialized: ${name}`);
    }

    /**
     * Execute a bridge transfer
     *
     * @abstract
     * @param {Object} params - Bridge parameters
     * @param {string} params.token - Token address or symbol
     * @param {string|BigInt} params.amount - Amount to bridge
     * @param {number} params.fromChain - Source chain ID
     * @param {number} params.toChain - Destination chain ID
     * @param {string} params.recipient - Recipient address on destination chain
     * @param {Object} params.options - Additional bridge-specific options
     * @returns {Promise<Object>} Bridge result
     */
    async execute(params) {
        throw new Error('execute() must be implemented by subclass');
    }

    /**
     * Get quote for bridge transfer
     *
     * @abstract
     * @param {Object} params - Quote parameters (same as execute)
     * @returns {Promise<Object>} Quote with fee estimates
     */
    async getQuote(params) {
        throw new Error('getQuote() must be implemented by subclass');
    }

    /**
     * Check if route is supported
     *
     * @param {number} fromChain - Source chain ID
     * @param {number} toChain - Destination chain ID
     * @param {string} token - Token symbol or address
     * @returns {boolean} True if supported
     */
    isRouteSupported(fromChain, toChain, token) {
        if (!this.supportedChains.has(fromChain) || !this.supportedChains.has(toChain)) {
            return false;
        }

        const fromTokens = this.supportedTokens.get(fromChain);
        const toTokens = this.supportedTokens.get(toChain);

        if (!fromTokens || !toTokens) {
            return false;
        }

        const normalizedToken = token.toUpperCase();
        return fromTokens.has(normalizedToken) && toTokens.has(normalizedToken);
    }

    /**
     * Get estimated bridge time
     *
     * @param {number} fromChain - Source chain ID
     * @param {number} toChain - Destination chain ID
     * @returns {number} Estimated time in seconds
     */
    getEstimatedTime(fromChain, toChain) {
        // Default estimates - override in subclass
        const l2Chains = new Set([42161, 10, 8453, 324]); // Arbitrum, Optimism, Base, zkSync

        // L2 to L2 is faster
        if (l2Chains.has(fromChain) && l2Chains.has(toChain)) {
            return 120; // ~2 minutes
        }

        // ETH mainnet involved is slower
        if (fromChain === 1 || toChain === 1) {
            return 600; // ~10 minutes
        }

        // Default
        return 300; // ~5 minutes
    }

    /**
     * Track bridge transaction status
     *
     * @param {string} txHash - Source chain transaction hash
     * @param {number} fromChain - Source chain ID
     * @param {number} toChain - Destination chain ID
     * @returns {Promise<Object>} Status object
     */
    async getTransactionStatus(txHash, fromChain, toChain) {
        throw new Error('getTransactionStatus() must be implemented by subclass');
    }

    /**
     * Wait for bridge completion
     *
     * @param {string} txHash - Source chain transaction hash
     * @param {number} fromChain - Source chain ID
     * @param {number} toChain - Destination chain ID
     * @param {number} timeoutMs - Maximum wait time
     * @returns {Promise<Object>} Final status
     */
    async waitForCompletion(txHash, fromChain, toChain, timeoutMs = 600000) {
        const startTime = Date.now();
        const pollInterval = 10000; // 10 seconds

        while (Date.now() - startTime < timeoutMs) {
            const status = await this.getTransactionStatus(txHash, fromChain, toChain);

            if (status.completed) {
                return status;
            }

            if (status.failed) {
                throw new Error(`Bridge failed: ${status.error}`);
            }

            await new Promise(resolve => setTimeout(resolve, pollInterval));
        }

        throw new Error('Bridge timeout');
    }

    /**
     * Get bridge statistics
     *
     * @returns {Object} Statistics
     */
    getStats() {
        return {
            name: this.name,
            ...this.stats,
            supportedChains: Array.from(this.supportedChains),
            successRate: this.stats.bridgesAttempted > 0
                ? `${((this.stats.bridgesSuccess / this.stats.bridgesAttempted) * 100).toFixed(1)}%`
                : '0%',
        };
    }

    /**
     * Update statistics after execution
     *
     * @protected
     */
    _updateStats(success, volumeUSD, timeMs) {
        this.stats.bridgesAttempted++;

        if (success) {
            this.stats.bridgesSuccess++;
            this.stats.totalVolumeUSD += volumeUSD || 0;

            const totalSuccess = this.stats.bridgesSuccess;
            this.stats.averageTimeMs =
                (this.stats.averageTimeMs * (totalSuccess - 1) + timeMs) / totalSuccess;
        } else {
            this.stats.bridgesFailed++;
        }
    }

    /**
     * Reset statistics
     */
    resetStats() {
        this.stats = {
            bridgesAttempted: 0,
            bridgesSuccess: 0,
            bridgesFailed: 0,
            totalVolumeUSD: 0,
            averageTimeMs: 0,
        };
    }
}

/**
 * StargateBridgeAdapter - Stargate (LayerZero) bridge implementation
 *
 * Supported chains: Ethereum, BSC, Polygon, Arbitrum, Optimism, Avalanche, Base
 * Supported tokens: USDC, USDT, ETH, DAI
 */
export class StargateBridgeAdapter extends BridgeAdapter {
    constructor(config = {}) {
        super('Stargate', config);

        // Stargate Router addresses
        this.routers = {
            1: '0x8731d54E9D02c286767d56ac03e8037C07e01e98',      // Ethereum
            56: '0x4a364f8c717cAAD9A442737Eb7b8A55cc6cf18D8',     // BSC
            137: '0x45A01E4e04F14f7A4a6702c74187c5F6222033cd',    // Polygon
            42161: '0x53Bf833A5d6c4ddA888F69c22C88C9f356a41614',  // Arbitrum
            10: '0xB0D502E938ed5f4df2E681fE6E419ff29631d62b',     // Optimism
            43114: '0x45A01E4e04F14f7A4a6702c74187c5F6222033cd',  // Avalanche
            8453: '0x45f1A95A4D3f3836523F5c83673c797f4d4d263B',   // Base
        };

        // Pool IDs by token
        this.poolIds = {
            USDC: 1,
            USDT: 2,
            DAI: 3,
            ETH: 13,
            WETH: 13,
        };

        // Chain IDs (LayerZero format)
        this.lzChainIds = {
            1: 101,      // Ethereum
            56: 102,     // BSC
            137: 109,    // Polygon
            42161: 110,  // Arbitrum
            10: 111,     // Optimism
            43114: 106,  // Avalanche
            8453: 184,   // Base
        };

        // Configure supported chains and tokens
        this.supportedChains = new Set([1, 56, 137, 42161, 10, 43114, 8453]);

        for (const chainId of this.supportedChains) {
            this.supportedTokens.set(chainId, new Set(['USDC', 'USDT', 'ETH', 'WETH', 'DAI']));
        }
    }

    /**
     * Execute Stargate bridge transfer
     *
     * @override
     */
    async execute(params) {
        const startTime = Date.now();

        const {
            token,
            amount,
            fromChain,
            toChain,
            recipient,
            signer,
            slippageBps = this.config.defaultSlippageBps,
        } = params;

        if (!this.isRouteSupported(fromChain, toChain, token)) {
            throw new Error(`Route not supported: ${fromChain} -> ${toChain} (${token})`);
        }

        if (!signer) {
            throw new Error('Signer required for Stargate bridge');
        }

        try {
            // Get router contract
            const routerAddress = this.routers[fromChain];
            // Note: In production, use actual contract ABI and execute

            // Placeholder for actual bridge execution
            log.info(`[Stargate] Bridging ${amount} ${token} from ${fromChain} to ${toChain}`);

            // Simulate bridge (replace with actual contract call)
            const result = {
                success: true,
                txHash: `0x${Date.now().toString(16)}`,
                fromChain,
                toChain,
                token,
                amount,
                estimatedArrival: Date.now() + this.getEstimatedTime(fromChain, toChain) * 1000,
            };

            this._updateStats(true, parseFloat(amount), Date.now() - startTime);

            return result;

        } catch (error) {
            this._updateStats(false, 0, Date.now() - startTime);
            throw error;
        }
    }

    /**
     * Get Stargate quote
     *
     * @override
     */
    async getQuote(params) {
        const { token, amount, fromChain, toChain } = params;

        if (!this.isRouteSupported(fromChain, toChain, token)) {
            throw new Error(`Route not supported: ${fromChain} -> ${toChain} (${token})`);
        }

        // Base fee + percentage
        const baseFee = 1.5; // $1.50 base
        const percentageFee = parseFloat(amount) * 0.001; // 0.1%

        return {
            inputAmount: amount,
            outputAmount: parseFloat(amount) - baseFee - percentageFee,
            fee: baseFee + percentageFee,
            feeBreakdown: {
                baseFee,
                percentageFee,
                lzFee: baseFee * 0.5, // LayerZero portion
            },
            estimatedTimeSeconds: this.getEstimatedTime(fromChain, toChain),
            minOutputAmount: parseFloat(amount) * 0.995, // 0.5% slippage tolerance
        };
    }

    /**
     * Get Stargate transaction status
     *
     * @override
     */
    async getTransactionStatus(txHash, fromChain, toChain) {
        // In production, query LayerZero API for message status
        // Placeholder implementation
        return {
            txHash,
            fromChain,
            toChain,
            status: 'DELIVERED',
            completed: true,
            failed: false,
        };
    }

    /**
     * Get estimated bridge time
     *
     * @override
     */
    getEstimatedTime(fromChain, toChain) {
        // Stargate is generally fast
        const l2Chains = new Set([42161, 10, 8453]);

        if (l2Chains.has(fromChain) && l2Chains.has(toChain)) {
            return 60; // ~1 minute for L2 to L2
        }

        return 180; // ~3 minutes for most routes
    }
}

/**
 * MockBridgeAdapter - Mock implementation for testing
 */
export class MockBridgeAdapter extends BridgeAdapter {
    constructor(config = {}) {
        super('Mock', config);

        this.supportedChains = new Set([1, 56, 137, 42161, 10, 8453]);

        for (const chainId of this.supportedChains) {
            this.supportedTokens.set(chainId, new Set(['USDC', 'USDT', 'ETH', 'WETH', 'WBNB']));
        }

        this.mockDelay = config.mockDelay || 100;
        this.shouldFail = config.shouldFail || false;
    }

    async execute(params) {
        const startTime = Date.now();

        await new Promise(resolve => setTimeout(resolve, this.mockDelay));

        if (this.shouldFail) {
            this._updateStats(false, 0, Date.now() - startTime);
            throw new Error('Mock bridge failure');
        }

        const result = {
            success: true,
            txHash: `0xmock_${Date.now()}`,
            ...params,
            costUSD: 2.5,
            outputAmount: parseFloat(params.amount) - 2.5,
        };

        this._updateStats(true, parseFloat(params.amount), Date.now() - startTime);
        return result;
    }

    async getQuote(params) {
        return {
            inputAmount: params.amount,
            outputAmount: parseFloat(params.amount) - 2.5,
            fee: 2.5,
            estimatedTimeSeconds: 120,
        };
    }

    async getTransactionStatus(txHash) {
        return {
            txHash,
            status: 'COMPLETED',
            completed: true,
            failed: false,
        };
    }
}

export default BridgeAdapter;
