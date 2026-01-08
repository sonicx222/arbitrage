import { ethers, parseUnits, formatUnits } from 'ethers';
import log from '../utils/logger.js';

/**
 * L2 Gas Calculator
 *
 * Calculates total gas costs for Layer 2 chains (Arbitrum, Base) which have
 * two gas components:
 * 1. L2 execution gas - Gas for executing the transaction on L2
 * 2. L1 data fee - Cost to post transaction calldata to Ethereum L1
 *
 * This is critical for accurate profit calculation on L2 chains where
 * L1 data fees can be a significant portion of total transaction cost.
 */

// ABI for Arbitrum ArbGasInfo precompile
const ARB_GAS_INFO_ABI = [
    'function getPricesInWei() external view returns (uint256 perL2Tx, uint256 perL1CalldataUnit, uint256 perArbGasBase, uint256 perArbGasCongestion, uint256 perArbGasTotal)',
    'function getL1BaseFeeEstimate() external view returns (uint256)',
    'function getCurrentTxL1GasFees() external view returns (uint256)',
];

// ABI for Base GasPriceOracle (Optimism-based)
const BASE_GAS_ORACLE_ABI = [
    'function l1BaseFee() external view returns (uint256)',
    'function overhead() external view returns (uint256)',
    'function scalar() external view returns (uint256)',
    'function decimals() external view returns (uint256)',
    'function getL1Fee(bytes memory _data) external view returns (uint256)',
    'function getL1GasUsed(bytes memory _data) external view returns (uint256)',
];

// Contract addresses
const L2_GAS_CONTRACTS = {
    arbitrum: {
        arbGasInfo: '0x000000000000000000000000000000000000006C', // Precompile
        chainId: 42161,
    },
    base: {
        gasPriceOracle: '0x420000000000000000000000000000000000000F', // Predeploy
        chainId: 8453,
    },
};

class L2GasCalculator {
    constructor() {
        // Cache for L1 fee estimates
        this.l1FeeCache = new Map();
        this.cacheTTL = 5000; // 5 seconds

        // Average transaction sizes for gas estimation
        this.txSizeEstimates = {
            crossDex: 500,      // ~500 bytes for 2 swaps
            triangular: 700,   // ~700 bytes for 3 swaps
            flashLoan: 800,    // ~800 bytes with flash loan overhead
        };

        // FIX v3.3: Changed to debug - logs for each worker in multi-chain mode
        log.debug('L2 Gas Calculator initialized', {
            supportedChains: ['arbitrum', 'base'],
        });
    }

    /**
     * Calculate total gas cost for an L2 transaction
     *
     * @param {string} chain - Chain name ('arbitrum' or 'base')
     * @param {Object} provider - ethers.js provider
     * @param {BigInt} l2GasUsed - Estimated L2 gas units
     * @param {BigInt} l2GasPrice - L2 gas price in wei
     * @param {number} txDataSize - Transaction data size in bytes (optional)
     * @returns {Object} { l2Cost, l1DataFee, totalCost, breakdown }
     */
    async calculateTotalGasCost(chain, provider, l2GasUsed, l2GasPrice, txDataSize = null) {
        const chainLower = chain.toLowerCase();

        // L2 execution cost
        const l2Cost = l2GasUsed * l2GasPrice;

        // L1 data fee
        let l1DataFee = 0n;
        const dataSize = txDataSize || this.txSizeEstimates.flashLoan;

        try {
            if (chainLower === 'arbitrum') {
                l1DataFee = await this._getArbitrumL1Fee(provider, dataSize);
            } else if (chainLower === 'base') {
                l1DataFee = await this._getBaseL1Fee(provider, dataSize);
            }
        } catch (error) {
            log.warn(`Failed to get L1 data fee for ${chain}`, { error: error.message });
            // Use estimate based on historical data
            l1DataFee = this._estimateL1Fee(chainLower, dataSize);
        }

        const totalCost = l2Cost + l1DataFee;

        return {
            l2Cost,
            l1DataFee,
            totalCost,
            breakdown: {
                l2CostGwei: formatUnits(l2Cost, 'gwei'),
                l1DataFeeGwei: formatUnits(l1DataFee, 'gwei'),
                totalCostGwei: formatUnits(totalCost, 'gwei'),
                l2CostETH: formatUnits(l2Cost, 'ether'),
                l1DataFeeETH: formatUnits(l1DataFee, 'ether'),
                totalCostETH: formatUnits(totalCost, 'ether'),
            },
        };
    }

    /**
     * Calculate total gas cost in USD
     *
     * @param {string} chain - Chain name
     * @param {Object} provider - ethers.js provider
     * @param {BigInt} l2GasUsed - Estimated L2 gas units
     * @param {BigInt} l2GasPrice - L2 gas price in wei
     * @param {number} nativeTokenPriceUSD - Native token (ETH) price in USD
     * @param {string} txType - Transaction type ('crossDex', 'triangular', 'flashLoan')
     * @returns {Object} { l2CostUSD, l1DataFeeUSD, totalCostUSD }
     */
    async calculateGasCostUSD(chain, provider, l2GasUsed, l2GasPrice, nativeTokenPriceUSD, txType = 'flashLoan') {
        const txDataSize = this.txSizeEstimates[txType] || this.txSizeEstimates.flashLoan;

        const { l2Cost, l1DataFee, totalCost, breakdown } = await this.calculateTotalGasCost(
            chain,
            provider,
            l2GasUsed,
            l2GasPrice,
            txDataSize
        );

        const l2CostUSD = Number(formatUnits(l2Cost, 'ether')) * nativeTokenPriceUSD;
        const l1DataFeeUSD = Number(formatUnits(l1DataFee, 'ether')) * nativeTokenPriceUSD;
        const totalCostUSD = l2CostUSD + l1DataFeeUSD;

        log.debug(`L2 gas cost for ${chain}`, {
            l2CostUSD: l2CostUSD.toFixed(4),
            l1DataFeeUSD: l1DataFeeUSD.toFixed(4),
            totalCostUSD: totalCostUSD.toFixed(4),
            txType,
        });

        return {
            l2CostUSD,
            l1DataFeeUSD,
            totalCostUSD,
            breakdown,
        };
    }

    /**
     * Get Arbitrum L1 data fee using ArbGasInfo precompile
     *
     * @private
     * @param {Object} provider - ethers.js provider
     * @param {number} txDataSize - Transaction data size in bytes
     * @returns {BigInt} L1 data fee in wei
     */
    async _getArbitrumL1Fee(provider, txDataSize) {
        const cacheKey = `arb_${txDataSize}`;
        const cached = this._getFromCache(cacheKey);
        if (cached !== null) return cached;

        const arbGasInfo = new ethers.Contract(
            L2_GAS_CONTRACTS.arbitrum.arbGasInfo,
            ARB_GAS_INFO_ABI,
            provider
        );

        // Get L1 base fee and per-calldata-unit cost
        const prices = await arbGasInfo.getPricesInWei();
        const perL1CalldataUnit = prices[1]; // Cost per byte of calldata

        // Arbitrum charges ~16 gas per non-zero byte, ~4 per zero byte
        // Assume average of 12 gas units per byte for typical tx data
        const avgGasPerByte = 12;
        const l1GasUnits = BigInt(txDataSize * avgGasPerByte);
        const l1Fee = l1GasUnits * perL1CalldataUnit;

        this._setCache(cacheKey, l1Fee);
        return l1Fee;
    }

    /**
     * Get Base L1 data fee using GasPriceOracle
     *
     * @private
     * @param {Object} provider - ethers.js provider
     * @param {number} txDataSize - Transaction data size in bytes
     * @returns {BigInt} L1 data fee in wei
     */
    async _getBaseL1Fee(provider, txDataSize) {
        const cacheKey = `base_${txDataSize}`;
        const cached = this._getFromCache(cacheKey);
        if (cached !== null) return cached;

        const gasPriceOracle = new ethers.Contract(
            L2_GAS_CONTRACTS.base.gasPriceOracle,
            BASE_GAS_ORACLE_ABI,
            provider
        );

        // Get L1 fee parameters
        const [l1BaseFee, overhead, scalar, decimals] = await Promise.all([
            gasPriceOracle.l1BaseFee(),
            gasPriceOracle.overhead(),
            gasPriceOracle.scalar(),
            gasPriceOracle.decimals(),
        ]);

        // Base L1 fee formula (Bedrock):
        // l1Fee = l1BaseFee * (txDataGas + fixedOverhead) * dynamicOverhead / 10^decimals
        // txDataGas = 16 * nonZeroBytes + 4 * zeroBytes
        // Assume ~75% non-zero bytes for typical tx
        const nonZeroBytes = Math.floor(txDataSize * 0.75);
        const zeroBytes = txDataSize - nonZeroBytes;
        const txDataGas = BigInt(nonZeroBytes * 16 + zeroBytes * 4);

        const l1GasUsed = txDataGas + overhead;
        const scaledFee = l1BaseFee * l1GasUsed * scalar;
        const l1Fee = scaledFee / (10n ** decimals);

        this._setCache(cacheKey, l1Fee);
        return l1Fee;
    }

    /**
     * Estimate L1 fee without RPC call (fallback)
     *
     * @private
     * @param {string} chain - Chain name
     * @param {number} txDataSize - Transaction data size in bytes
     * @returns {BigInt} Estimated L1 fee in wei
     */
    _estimateL1Fee(chain, txDataSize) {
        // Historical average estimates (as of 2024)
        // These should be updated periodically based on actual L1 gas prices
        const estimates = {
            arbitrum: {
                // Arbitrum L1 fee is typically $0.01-0.10 depending on L1 congestion
                // Assume ~20 gwei L1 base fee, 12 gas per byte
                baseFeeWei: parseUnits('20', 'gwei'),
                gasPerByte: 12,
            },
            base: {
                // Base L1 fee is typically $0.001-0.01 (very cheap)
                // Uses blob data which is much cheaper
                baseFeeWei: parseUnits('10', 'gwei'),
                gasPerByte: 8, // Lower due to blob data
            },
        };

        const chainEstimate = estimates[chain] || estimates.arbitrum;
        const l1GasUnits = BigInt(txDataSize * chainEstimate.gasPerByte);
        const l1Fee = l1GasUnits * chainEstimate.baseFeeWei;

        log.debug(`Using estimated L1 fee for ${chain}`, {
            txDataSize,
            l1FeeGwei: formatUnits(l1Fee, 'gwei'),
        });

        return l1Fee;
    }

    /**
     * Check if a chain is an L2 that requires special gas handling
     *
     * @param {number} chainId - Chain ID
     * @returns {boolean}
     */
    isL2Chain(chainId) {
        const l2ChainIds = [
            42161,  // Arbitrum One
            42170,  // Arbitrum Nova
            8453,   // Base
            10,     // Optimism
            324,    // zkSync Era
            1101,   // Polygon zkEVM
        ];
        return l2ChainIds.includes(chainId);
    }

    /**
     * Get the L2 chain name from chain ID
     *
     * @param {number} chainId - Chain ID
     * @returns {string|null} Chain name or null if not supported
     */
    getL2ChainName(chainId) {
        const chainNames = {
            42161: 'arbitrum',
            42170: 'arbitrum-nova',
            8453: 'base',
            10: 'optimism',
        };
        return chainNames[chainId] || null;
    }

    /**
     * Get from cache with TTL check
     *
     * @private
     */
    _getFromCache(key) {
        const cached = this.l1FeeCache.get(key);
        if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
            return cached.value;
        }
        return null;
    }

    /**
     * Set cache value
     *
     * @private
     */
    _setCache(key, value) {
        this.l1FeeCache.set(key, {
            value,
            timestamp: Date.now(),
        });
    }

    /**
     * Clear cache
     */
    clearCache() {
        this.l1FeeCache.clear();
    }

    /**
     * Get statistics
     */
    getStats() {
        return {
            cacheSize: this.l1FeeCache.size,
            supportedChains: ['arbitrum', 'base', 'optimism'],
            txSizeEstimates: this.txSizeEstimates,
        };
    }
}

// Export singleton instance
const l2GasCalculator = new L2GasCalculator();
export default l2GasCalculator;
