import { ethers } from 'ethers';
import log from './logger.js';

/**
 * Gas Price Manager
 *
 * Handles gas pricing for both legacy (BSC) and EIP-1559 chains (Ethereum, Polygon, Arbitrum, Base, Avalanche).
 * Optimizes gas costs by using proper EIP-1559 parameters when available.
 */
class GasPriceManager {
    constructor() {
        // Chain types for gas pricing
        // Legacy chains use gasPrice, EIP-1559 chains use maxFeePerGas + maxPriorityFeePerGas
        this.eip1559Chains = new Set([
            1,      // Ethereum
            137,    // Polygon
            42161,  // Arbitrum
            8453,   // Base
            43114,  // Avalanche
        ]);

        this.legacyChains = new Set([
            56,     // BSC
        ]);

        // Default priority fee by chain (in gwei)
        // These are typical "tip" amounts for fast inclusion
        this.defaultPriorityFees = {
            1: 1.5,      // Ethereum: 1.5 gwei tip
            137: 30,     // Polygon: 30 gwei tip (higher due to low base fee)
            42161: 0.01, // Arbitrum: very low (L2)
            8453: 0.001, // Base: extremely low (L2)
            43114: 1,    // Avalanche: 1 gwei tip
        };

        // Max fee multipliers (multiply base fee by this for maxFeePerGas)
        // Higher multiplier = more willing to pay if base fee spikes
        this.maxFeeMultipliers = {
            1: 2.0,      // Ethereum: 2x base fee headroom
            137: 1.5,    // Polygon: 1.5x
            42161: 1.5,  // Arbitrum: 1.5x
            8453: 1.5,   // Base: 1.5x
            43114: 1.5,  // Avalanche: 1.5x
        };

        // Cache for gas prices
        this.cache = new Map();
        this.cacheMaxAge = 3000; // 3 seconds

        log.info('Gas Price Manager initialized', {
            eip1559Chains: [...this.eip1559Chains],
            legacyChains: [...this.legacyChains],
        });
    }

    /**
     * Check if a chain supports EIP-1559
     *
     * @param {number} chainId - Chain ID
     * @returns {boolean}
     */
    isEIP1559Chain(chainId) {
        return this.eip1559Chains.has(chainId);
    }

    /**
     * Get optimal gas parameters for a transaction
     *
     * @param {Object} provider - ethers.js provider
     * @param {number} chainId - Chain ID
     * @param {Object} options - Optional overrides
     * @returns {Promise<Object>} Gas parameters for transaction
     */
    async getGasParams(provider, chainId, options = {}) {
        const cacheKey = `gas_${chainId}`;
        const cached = this.cache.get(cacheKey);

        if (cached && Date.now() - cached.timestamp < this.cacheMaxAge) {
            return { ...cached.params };
        }

        let params;

        if (this.isEIP1559Chain(chainId)) {
            params = await this._getEIP1559Params(provider, chainId, options);
        } else {
            params = await this._getLegacyParams(provider, chainId, options);
        }

        // Cache the result
        this.cache.set(cacheKey, {
            params,
            timestamp: Date.now(),
        });

        return params;
    }

    /**
     * Get EIP-1559 gas parameters
     *
     * @private
     */
    async _getEIP1559Params(provider, chainId, options = {}) {
        try {
            const feeData = await provider.getFeeData();

            // Get base fee from latest block
            const baseFee = feeData.gasPrice || ethers.parseUnits('1', 'gwei');

            // Calculate priority fee (tip)
            const defaultPriority = this.defaultPriorityFees[chainId] || 1;
            const priorityFeeGwei = options.priorityFeeGwei || defaultPriority;
            const maxPriorityFeePerGas = ethers.parseUnits(priorityFeeGwei.toString(), 'gwei');

            // Calculate max fee (base fee * multiplier + priority fee)
            const multiplier = this.maxFeeMultipliers[chainId] || 1.5;
            const maxFeePerGas = options.maxFeePerGas ||
                (baseFee * BigInt(Math.floor(multiplier * 100)) / 100n) + maxPriorityFeePerGas;

            // Ensure maxFee >= priorityFee
            const finalMaxFee = maxFeePerGas > maxPriorityFeePerGas
                ? maxFeePerGas
                : maxPriorityFeePerGas * 2n;

            log.debug(`EIP-1559 gas params for chain ${chainId}`, {
                baseFeeGwei: ethers.formatUnits(baseFee, 'gwei'),
                maxPriorityFeeGwei: ethers.formatUnits(maxPriorityFeePerGas, 'gwei'),
                maxFeeGwei: ethers.formatUnits(finalMaxFee, 'gwei'),
            });

            return {
                type: 2, // EIP-1559 transaction type
                maxFeePerGas: finalMaxFee,
                maxPriorityFeePerGas,
            };
        } catch (error) {
            log.warn(`Failed to get EIP-1559 params, falling back to legacy`, {
                chainId,
                error: error.message,
            });
            return this._getLegacyParams(provider, chainId, options);
        }
    }

    /**
     * Get legacy gas parameters
     *
     * @private
     */
    async _getLegacyParams(provider, chainId, options = {}) {
        try {
            const feeData = await provider.getFeeData();
            let gasPrice = feeData.gasPrice;

            // Apply speed multiplier if requested
            if (options.speed === 'fast') {
                gasPrice = gasPrice * 120n / 100n; // 20% increase
            } else if (options.speed === 'instant') {
                gasPrice = gasPrice * 150n / 100n; // 50% increase
            }

            // Apply max gas price cap if configured
            if (options.maxGasPriceGwei) {
                const maxGas = ethers.parseUnits(options.maxGasPriceGwei.toString(), 'gwei');
                if (gasPrice > maxGas) {
                    gasPrice = maxGas;
                }
            }

            log.debug(`Legacy gas params for chain ${chainId}`, {
                gasPriceGwei: ethers.formatUnits(gasPrice, 'gwei'),
            });

            return {
                type: 0, // Legacy transaction type
                gasPrice,
            };
        } catch (error) {
            log.error(`Failed to get gas price`, { chainId, error: error.message });
            // Return a reasonable default
            const defaultGwei = chainId === 56 ? '5' : '30';
            return {
                type: 0,
                gasPrice: ethers.parseUnits(defaultGwei, 'gwei'),
            };
        }
    }

    /**
     * Estimate transaction cost in USD
     *
     * @param {Object} gasParams - Gas parameters from getGasParams
     * @param {BigInt} gasLimit - Estimated gas limit
     * @param {number} nativeTokenPriceUSD - Native token price in USD
     * @returns {Object} Cost breakdown
     */
    estimateCostUSD(gasParams, gasLimit, nativeTokenPriceUSD) {
        let effectiveGasPrice;

        if (gasParams.type === 2) {
            // For EIP-1559, use maxFeePerGas as worst case
            // Actual cost will be baseFee + priorityFee (usually lower)
            effectiveGasPrice = gasParams.maxFeePerGas;
        } else {
            effectiveGasPrice = gasParams.gasPrice;
        }

        const gasCostWei = effectiveGasPrice * gasLimit;
        const gasCostNative = Number(gasCostWei) / 1e18;
        const gasCostUSD = gasCostNative * nativeTokenPriceUSD;

        return {
            gasCostWei: gasCostWei.toString(),
            gasCostNative,
            gasCostUSD,
            effectiveGasPriceGwei: Number(ethers.formatUnits(effectiveGasPrice, 'gwei')),
            isEIP1559: gasParams.type === 2,
        };
    }

    /**
     * Build transaction with proper gas parameters
     *
     * @param {Object} baseTx - Base transaction object (to, data, value, gasLimit)
     * @param {Object} gasParams - Gas parameters from getGasParams
     * @returns {Object} Complete transaction object
     */
    buildTransaction(baseTx, gasParams) {
        const tx = { ...baseTx };

        if (gasParams.type === 2) {
            // EIP-1559 transaction
            tx.type = 2;
            tx.maxFeePerGas = gasParams.maxFeePerGas;
            tx.maxPriorityFeePerGas = gasParams.maxPriorityFeePerGas;
            // Remove legacy gasPrice if present
            delete tx.gasPrice;
        } else {
            // Legacy transaction
            tx.type = 0;
            tx.gasPrice = gasParams.gasPrice;
            // Remove EIP-1559 fields if present
            delete tx.maxFeePerGas;
            delete tx.maxPriorityFeePerGas;
        }

        return tx;
    }

    /**
     * Clear cached gas prices
     */
    clearCache() {
        this.cache.clear();
    }

    /**
     * Get statistics
     */
    getStats() {
        return {
            eip1559Chains: [...this.eip1559Chains],
            legacyChains: [...this.legacyChains],
            cacheSize: this.cache.size,
            cacheMaxAge: this.cacheMaxAge,
        };
    }
}

// Export singleton instance
const gasPriceManager = new GasPriceManager();
export default gasPriceManager;
