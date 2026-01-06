import { formatUnits } from 'ethers';
import config from '../config.js';
import log from '../utils/logger.js';
import { FLASH_LOAN_FEE } from '../contracts/abis.js';
import cacheManager from '../data/cacheManager.js';
import l2GasCalculator from '../execution/l2GasCalculator.js';

// Lazy import to avoid circular dependency
let triangularDetector = null;
const getTriangularDetector = async () => {
    if (!triangularDetector) {
        const module = await import('./triangularDetector.js');
        triangularDetector = module.default;
    }
    return triangularDetector;
};

/**
 * Profit Calculator
 *
 * Calculates accurate net profit for arbitrage opportunities by considering:
 * - Flash loan fees (0.25% for PancakeSwap V2)
 * - Gas costs (dynamic based on current gas price)
 * - DEX trading fees
 * - Slippage buffer
 * - Price impact from trade size
 *
 * This is critical for realistic profitability assessment.
 */
class ProfitCalculator {
    constructor() {
        // Native token price fallbacks (used when cache is empty)
        this.defaultNativePrices = {
            'WBNB': 600,
            'BNB': 600,
            'WETH': 3500,
            'ETH': 3500,
            'WMATIC': 0.5,
            'MATIC': 0.5,
            'WAVAX': 35,
            'AVAX': 35,
        };

        // Current native token price (dynamically updated)
        this.nativeTokenPriceUSD = this.defaultNativePrices['WBNB'];
        this.nativeTokenSymbol = 'WBNB'; // Default for BSC

        // Flash loan fee rate
        this.flashLoanFee = FLASH_LOAN_FEE.PANCAKE_V2; // 0.25%

        // Slippage buffer (additional safety margin)
        this.slippageBuffer = 0.01; // 1%

        // Gas estimates for different operation types
        this.gasEstimates = {
            flashLoanOverhead: 150000n,     // Base flash loan cost
            perSwap: 100000n,               // Gas per swap
            profitValidation: 10000n,       // On-chain profit check
        };

        // Minimum profit thresholds
        this.minProfitUSD = config.execution?.minProfitUSD || 1.0;
        this.minProfitPercent = config.trading.minProfitPercentage || 0.5;

        // Get enabled DEX names for price lookup
        this.dexNames = Object.entries(config.dex)
            .filter(([_, dexConfig]) => dexConfig.enabled)
            .map(([name]) => name);

        // Chain configuration for L2 gas calculation
        this.chainId = 56; // Default BSC
        this.chainName = 'bsc';
        this.provider = null; // Set via setProvider() for L2 chains

        log.info('Profit Calculator initialized', {
            flashLoanFee: `${this.flashLoanFee * 100}%`,
            slippageBuffer: `${this.slippageBuffer * 100}%`,
            minProfitUSD: `$${this.minProfitUSD}`,
            dynamicPricing: true,
            l2GasSupport: true,
        });
    }

    /**
     * Calculate comprehensive net profit for an opportunity
     *
     * @param {Object} opportunity - Arbitrage opportunity (cross-dex or triangular)
     * @param {BigInt} gasPrice - Current gas price in wei
     * @param {number} nativePrice - Native token price in USD (optional, fetched dynamically if not provided)
     * @returns {Object} Detailed profit breakdown
     */
    calculateNetProfit(opportunity, gasPrice, nativePrice = null) {
        // Get dynamic native token price from cache if not provided
        const currentNativePrice = nativePrice || this._getDynamicNativePrice();

        // Determine opportunity type and calculate accordingly
        if (opportunity.type === 'triangular') {
            return this._calculateTriangularProfit(opportunity, gasPrice, currentNativePrice);
        } else {
            return this._calculateCrossDexProfit(opportunity, gasPrice, currentNativePrice);
        }
    }

    /**
     * Get dynamic native token price from price cache
     *
     * @private
     * @returns {number} Native token price in USD
     */
    _getDynamicNativePrice() {
        const fallback = this.defaultNativePrices[this.nativeTokenSymbol] || 600;

        const dynamicPrice = cacheManager.getNativeTokenPrice(
            this.nativeTokenSymbol,
            config.tokens,
            this.dexNames,
            fallback
        );

        // Update cached value for quick access
        if (dynamicPrice !== this.nativeTokenPriceUSD) {
            this.nativeTokenPriceUSD = dynamicPrice;
            log.debug(`Updated ${this.nativeTokenSymbol} price: $${dynamicPrice.toFixed(2)}`);
        }

        return dynamicPrice;
    }

    /**
     * Set the native token symbol for the current chain
     *
     * @param {string} symbol - Native token symbol (e.g., 'WBNB', 'WETH')
     */
    setNativeTokenSymbol(symbol) {
        this.nativeTokenSymbol = symbol;
        this.nativeTokenPriceUSD = this.defaultNativePrices[symbol] || 1;
        log.info(`Native token set to ${symbol}, fallback price: $${this.nativeTokenPriceUSD}`);
    }

    /**
     * Calculate profit for cross-DEX arbitrage
     *
     * @private
     */
    _calculateCrossDexProfit(opportunity, gasPrice, bnbPrice) {
        const {
            profitUSD: grossProfitUSD,
            optimalTradeSizeUSD,
            gasCostUSD: existingGasCost,
        } = opportunity;

        // Calculate flash loan fee
        const flashFeeUSD = optimalTradeSizeUSD * this.flashLoanFee;

        // Calculate gas cost
        const swapCount = 2; // Buy + Sell
        const gasCostUSD = this._estimateGasCostUSD(gasPrice, swapCount, bnbPrice);

        // Calculate slippage buffer
        const slippageUSD = grossProfitUSD * this.slippageBuffer;

        // Net profit
        const netProfitUSD = grossProfitUSD - flashFeeUSD - gasCostUSD - slippageUSD;
        const netProfitPercent = optimalTradeSizeUSD > 0
            ? (netProfitUSD / optimalTradeSizeUSD) * 100
            : 0;

        // Is it profitable?
        const isProfitable = netProfitUSD >= this.minProfitUSD &&
                            netProfitPercent >= this.minProfitPercent;

        return {
            type: 'cross-dex',
            grossProfitUSD,
            flashFeeUSD,
            gasCostUSD,
            slippageUSD,
            netProfitUSD,
            netProfitPercent,
            tradeSizeUSD: optimalTradeSizeUSD,
            isProfitable,
            breakdown: {
                gross: grossProfitUSD,
                flashLoan: -flashFeeUSD,
                gas: -gasCostUSD,
                slippage: -slippageUSD,
                net: netProfitUSD,
            },
        };
    }

    /**
     * Calculate profit for triangular arbitrage using accurate AMM formula
     *
     * Uses the Uniswap V2 getAmountOut formula with actual reserves to calculate
     * price impact at each hop, providing much more accurate profit estimates
     * than simple price ratio multiplication.
     *
     * @private
     */
    _calculateTriangularProfit(opportunity, gasPrice, bnbPrice) {
        const {
            reserves,
            minLiquidityUSD,
            dexName,
            path,
        } = opportunity;

        // Get base token info
        const baseToken = path[0];
        const baseTokenPriceUSD = this._getTokenPriceUSD(baseToken, bnbPrice);
        const tokenDecimals = config.tokens[baseToken]?.decimals || 18;

        // Determine max trade size (limited by liquidity - max 10% of smallest pool)
        const maxTradeUSD = Math.min(
            config.triangular?.maxTradeSizeUSD || 5000,
            minLiquidityUSD * 0.1
        );

        // Convert trade size to token amount
        const tradeSizeTokens = maxTradeUSD / baseTokenPriceUSD;
        const inputAmount = BigInt(Math.floor(tradeSizeTokens * Math.pow(10, tokenDecimals)));

        // Calculate exact output using AMM formula with reserves
        const { grossProfitUSD, optimalInputAmount, tradeSizeUSD: actualTradeSizeUSD } =
            this._calculateExactTriangularProfit(opportunity, inputAmount, tokenDecimals, baseTokenPriceUSD);

        // Flash loan fee (on the actual trade size)
        const flashFeeUSD = actualTradeSizeUSD * this.flashLoanFee;

        // Gas cost (3 swaps for triangular)
        const swapCount = 3;
        const gasCostUSD = this._estimateGasCostUSD(gasPrice, swapCount, bnbPrice);

        // Slippage buffer (reduced since we're using accurate AMM math)
        const slippageUSD = grossProfitUSD * this.slippageBuffer;

        // Net profit
        const netProfitUSD = grossProfitUSD - flashFeeUSD - gasCostUSD - slippageUSD;
        const netProfitPercent = actualTradeSizeUSD > 0
            ? (netProfitUSD / actualTradeSizeUSD) * 100
            : 0;

        // Is it profitable?
        const isProfitable = netProfitUSD >= this.minProfitUSD &&
                            netProfitPercent >= this.minProfitPercent;

        return {
            type: 'triangular',
            grossProfitUSD,
            flashFeeUSD,
            gasCostUSD,
            slippageUSD,
            netProfitUSD,
            netProfitPercent,
            tradeSizeUSD: actualTradeSizeUSD,
            optimalInputAmount: optimalInputAmount.toString(),
            isProfitable,
            breakdown: {
                gross: grossProfitUSD,
                flashLoan: -flashFeeUSD,
                gas: -gasCostUSD,
                slippage: -slippageUSD,
                net: netProfitUSD,
            },
            dexName,
            path: path.join(' -> '),
        };
    }

    /**
     * Calculate exact triangular profit using AMM getAmountOut formula
     *
     * This uses the actual reserves to simulate each swap, accounting for
     * price impact at every hop.
     *
     * @private
     * @param {Object} opportunity - Triangular opportunity with reserves
     * @param {BigInt} maxInputAmount - Maximum input amount to consider
     * @param {number} tokenDecimals - Decimals of base token
     * @param {number} baseTokenPriceUSD - USD price of base token
     * @returns {Object} { grossProfitUSD, optimalInputAmount, tradeSizeUSD }
     */
    _calculateExactTriangularProfit(opportunity, maxInputAmount, tokenDecimals, baseTokenPriceUSD) {
        const { reserves, dexName } = opportunity;
        const fee = config.dex[dexName]?.fee || 0.003;

        // If no reserves data, fall back to simple calculation
        if (!reserves || reserves.length !== 3) {
            const simpleProfitPercent = opportunity.estimatedProfitPercent || 0;
            const tradeSizeUSD = Number(maxInputAmount) / Math.pow(10, tokenDecimals) * baseTokenPriceUSD;
            return {
                grossProfitUSD: tradeSizeUSD * (simpleProfitPercent / 100),
                optimalInputAmount: maxInputAmount,
                tradeSizeUSD,
            };
        }

        // Binary search for optimal input amount (10 check points)
        const minAmount = maxInputAmount / 50n; // Start at 2% of max
        const checkPoints = 10;
        const increment = (maxInputAmount - minAmount) / BigInt(checkPoints);

        let bestProfit = 0n;
        let bestAmount = minAmount;

        for (let i = 0; i <= checkPoints; i++) {
            const testAmount = minAmount + (increment * BigInt(i));
            if (testAmount <= 0n) continue;

            const outputAmount = this._simulateTriangularSwaps(testAmount, reserves, fee);
            const profit = outputAmount - testAmount;

            if (profit > bestProfit) {
                bestProfit = profit;
                bestAmount = testAmount;
            } else if (profit < bestProfit && bestProfit > 0n) {
                // Passed the peak, stop searching
                break;
            }
        }

        // Convert to USD
        const profitFloat = Number(bestProfit) / Math.pow(10, tokenDecimals);
        const grossProfitUSD = profitFloat * baseTokenPriceUSD;
        const tradeSizeUSD = (Number(bestAmount) / Math.pow(10, tokenDecimals)) * baseTokenPriceUSD;

        return {
            grossProfitUSD,
            optimalInputAmount: bestAmount,
            tradeSizeUSD,
        };
    }

    /**
     * Simulate triangular swaps using Uniswap V2 AMM formula
     *
     * @private
     * @param {BigInt} inputAmount - Amount to swap
     * @param {Array} reserves - Array of {in, out} reserves for each hop
     * @param {number} fee - DEX fee as decimal (e.g., 0.003)
     * @returns {BigInt} Final output amount
     */
    _simulateTriangularSwaps(inputAmount, reserves, fee) {
        let currentAmount = inputAmount;

        for (let i = 0; i < reserves.length; i++) {
            const { in: reserveIn, out: reserveOut } = reserves[i];
            currentAmount = this._getAmountOut(
                currentAmount,
                BigInt(reserveIn),
                BigInt(reserveOut),
                fee
            );
        }

        return currentAmount;
    }

    /**
     * Calculate output amount using Uniswap V2 formula
     *
     * amountOut = (amountIn * (1-fee) * reserveOut) / (reserveIn + amountIn * (1-fee))
     *
     * @private
     * @param {BigInt} amountIn - Input amount
     * @param {BigInt} reserveIn - Reserve of input token
     * @param {BigInt} reserveOut - Reserve of output token
     * @param {number} fee - Fee as decimal
     * @returns {BigInt} Output amount
     */
    _getAmountOut(amountIn, reserveIn, reserveOut, fee) {
        if (reserveIn === 0n || reserveOut === 0n || amountIn === 0n) return 0n;

        const feeNumerator = BigInt(Math.floor((1 - fee) * 10000));
        const amountInWithFee = amountIn * feeNumerator;
        const numerator = amountInWithFee * reserveOut;
        const denominator = (reserveIn * 10000n) + amountInWithFee;

        return denominator > 0n ? numerator / denominator : 0n;
    }

    /**
     * Estimate gas cost in USD (supports L1 and L2 chains)
     *
     * For L2 chains (Arbitrum, Base), this includes both L2 execution cost
     * and L1 data fee for posting calldata to Ethereum.
     *
     * @private
     * @param {BigInt} gasPrice - Gas price in wei
     * @param {number} swapCount - Number of swaps
     * @param {number} nativePrice - Native token price in USD
     * @returns {number} Gas cost in USD
     */
    _estimateGasCostUSD(gasPrice, swapCount, nativePrice) {
        const totalGas = this.gasEstimates.flashLoanOverhead +
                        (this.gasEstimates.perSwap * BigInt(swapCount)) +
                        this.gasEstimates.profitValidation;

        // L2 execution cost (same calculation for all chains)
        const l2GasCostWei = totalGas * gasPrice;
        const l2GasCostNative = Number(l2GasCostWei) / 1e18;
        let gasCostUSD = l2GasCostNative * nativePrice;

        // Add L1 data fee for L2 chains
        if (l2GasCalculator.isL2Chain(this.chainId)) {
            const txType = swapCount === 3 ? 'triangular' : 'crossDex';
            const l1DataFeeEstimate = this._estimateL1DataFeeUSD(txType, nativePrice);
            gasCostUSD += l1DataFeeEstimate;

            log.debug(`L2 gas cost breakdown for ${this.chainName}`, {
                l2CostUSD: (l2GasCostNative * nativePrice).toFixed(4),
                l1DataFeeUSD: l1DataFeeEstimate.toFixed(4),
                totalUSD: gasCostUSD.toFixed(4),
            });
        }

        return gasCostUSD;
    }

    /**
     * Estimate L1 data fee for L2 transactions (synchronous fallback)
     *
     * For accurate L1 fees, use calculateNetProfitAsync with provider.
     *
     * @private
     * @param {string} txType - Transaction type ('crossDex', 'triangular')
     * @param {number} nativePrice - Native token price in USD
     * @returns {number} Estimated L1 data fee in USD
     */
    _estimateL1DataFeeUSD(txType, nativePrice) {
        // Historical average L1 data fees (conservative estimates)
        // These are based on typical L1 gas prices around 20-30 gwei
        const l1FeeEstimates = {
            arbitrum: {
                crossDex: 0.02,    // ~$0.02 for 2-swap tx
                triangular: 0.03,  // ~$0.03 for 3-swap tx
                flashLoan: 0.04,   // ~$0.04 with flash loan overhead
            },
            base: {
                crossDex: 0.002,   // ~$0.002 (very cheap with blob data)
                triangular: 0.003, // ~$0.003
                flashLoan: 0.004,  // ~$0.004
            },
        };

        const chainEstimates = l1FeeEstimates[this.chainName] || l1FeeEstimates.arbitrum;
        return chainEstimates[txType] || chainEstimates.flashLoan;
    }

    /**
     * Calculate net profit with accurate L2 gas fees (async version)
     *
     * Use this when you have a provider available for accurate L1 fee calculation.
     *
     * @param {Object} opportunity - Arbitrage opportunity
     * @param {BigInt} gasPrice - Current gas price in wei
     * @param {Object} provider - ethers.js provider for L1 fee queries
     * @returns {Promise<Object>} Detailed profit breakdown
     */
    async calculateNetProfitAsync(opportunity, gasPrice, provider = null) {
        // Use synchronous calculation if no provider or not an L2 chain
        if (!provider || !l2GasCalculator.isL2Chain(this.chainId)) {
            return this.calculateNetProfit(opportunity, gasPrice);
        }

        // Get dynamic native token price
        const nativePrice = this._getDynamicNativePrice();

        // Calculate L2 gas
        const swapCount = opportunity.type === 'triangular' ? 3 : 2;
        const totalGas = this.gasEstimates.flashLoanOverhead +
                        (this.gasEstimates.perSwap * BigInt(swapCount)) +
                        this.gasEstimates.profitValidation;

        // Get accurate L2 gas cost with L1 data fee
        const txType = opportunity.type === 'triangular' ? 'triangular' : 'crossDex';
        const gasCost = await l2GasCalculator.calculateGasCostUSD(
            this.chainName,
            provider,
            totalGas,
            gasPrice,
            nativePrice,
            txType
        );

        // Now calculate profit with accurate gas cost
        const result = this.calculateNetProfit(opportunity, gasPrice, nativePrice);

        // Override gas cost with accurate L2 calculation
        const gasDiff = gasCost.totalCostUSD - result.gasCostUSD;
        result.gasCostUSD = gasCost.totalCostUSD;
        result.netProfitUSD -= gasDiff;
        result.breakdown.gas = -gasCost.totalCostUSD;
        result.breakdown.net = result.netProfitUSD;

        // Add L2-specific breakdown
        result.l2GasBreakdown = {
            l2CostUSD: gasCost.l2CostUSD,
            l1DataFeeUSD: gasCost.l1DataFeeUSD,
            totalCostUSD: gasCost.totalCostUSD,
        };

        // Recalculate profitability
        result.netProfitPercent = result.tradeSizeUSD > 0
            ? (result.netProfitUSD / result.tradeSizeUSD) * 100
            : 0;
        result.isProfitable = result.netProfitUSD >= this.minProfitUSD &&
                              result.netProfitPercent >= this.minProfitPercent;

        return result;
    }

    /**
     * Set chain configuration for L2 gas calculation
     *
     * @param {number} chainId - Chain ID
     * @param {string} chainName - Chain name (e.g., 'arbitrum', 'base')
     * @param {Object} provider - ethers.js provider (optional)
     */
    setChain(chainId, chainName, provider = null) {
        this.chainId = chainId;
        this.chainName = chainName.toLowerCase();
        this.provider = provider;

        log.info(`Chain set for profit calculation`, {
            chainId,
            chainName: this.chainName,
            isL2: l2GasCalculator.isL2Chain(chainId),
        });
    }

    /**
     * Get token price in USD - uses dynamic pricing from cache with fallbacks
     *
     * @private
     * @param {string} tokenSymbol - Token symbol
     * @param {number} nativePrice - Current native token price for conversions
     * @returns {number} Token price in USD
     */
    _getTokenPriceUSD(tokenSymbol, nativePrice) {
        // Stablecoins - always $1
        if (['USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'FDUSD'].includes(tokenSymbol)) {
            return 1.0;
        }

        // Native tokens - use provided price
        const nativeSymbols = ['WBNB', 'BNB', 'WETH', 'ETH', 'WMATIC', 'MATIC', 'WAVAX', 'AVAX'];
        if (nativeSymbols.includes(tokenSymbol)) {
            return nativePrice;
        }

        // Try to get dynamic price from cache
        const cachedPrice = cacheManager.getTokenPriceUSD(
            tokenSymbol,
            config.tokens,
            this.dexNames,
            nativePrice
        );

        if (cachedPrice !== null && cachedPrice > 0) {
            return cachedPrice;
        }

        // Fallback to hardcoded approximate prices for major tokens
        const fallbackPrices = {
            'BTCB': 95000,
            'WBTC': 95000,
            'CAKE': 2.5,
            'XRP': 2.0,
            'ADA': 1.0,
            'DOT': 7.0,
            'LINK': 20.0,
            'UNI': 12.0,
            'AAVE': 300.0,
            'ARB': 1.0,
            'OP': 2.0,
            'JOE': 0.5,
            'PNG': 0.1,
            'SUSHI': 1.5,
        };

        return fallbackPrices[tokenSymbol] || 1.0; // Default to $1 for unknown
    }

    /**
     * Update native token price manually
     *
     * @param {number} price - New native token price in USD
     * @deprecated Use dynamic pricing from cache instead
     */
    updateBnbPrice(price) {
        this.nativeTokenPriceUSD = price;
        log.debug(`${this.nativeTokenSymbol} price manually updated to $${price}`);
    }

    /**
     * Update native token price
     *
     * @param {number} price - New native token price in USD
     */
    updateNativePrice(price) {
        this.nativeTokenPriceUSD = price;
        log.debug(`${this.nativeTokenSymbol} price updated to $${price}`);
    }

    /**
     * Batch calculate profits for multiple opportunities
     *
     * @param {Array} opportunities - Array of opportunities
     * @param {BigInt} gasPrice - Current gas price
     * @returns {Array} Opportunities with profit calculations, filtered for profitable ones
     */
    batchCalculate(opportunities, gasPrice) {
        const results = [];

        for (const opp of opportunities) {
            const profitCalc = this.calculateNetProfit(opp, gasPrice);

            if (profitCalc.isProfitable) {
                results.push({
                    ...opp,
                    profitCalculation: profitCalc,
                });
            }
        }

        // Sort by net profit descending
        results.sort((a, b) =>
            b.profitCalculation.netProfitUSD - a.profitCalculation.netProfitUSD
        );

        return results;
    }

    /**
     * Format profit breakdown for logging
     *
     * @param {Object} profitCalc - Profit calculation result
     * @returns {string} Formatted string
     */
    formatBreakdown(profitCalc) {
        const { breakdown, type, tradeSizeUSD, netProfitPercent } = profitCalc;

        return [
            `Type: ${type}`,
            `Trade Size: $${tradeSizeUSD.toFixed(2)}`,
            `Gross: +$${breakdown.gross.toFixed(2)}`,
            `Flash Fee: -$${(-breakdown.flashLoan).toFixed(2)}`,
            `Gas: -$${(-breakdown.gas).toFixed(2)}`,
            `Slippage Buffer: -$${(-breakdown.slippage).toFixed(2)}`,
            `Net: $${breakdown.net.toFixed(2)} (${netProfitPercent.toFixed(2)}%)`,
        ].join(' | ');
    }

    /**
     * Get calculator statistics
     */
    getStats() {
        // Get fresh dynamic price for stats
        const dynamicPrice = this._getDynamicNativePrice();

        return {
            nativeTokenSymbol: this.nativeTokenSymbol,
            nativeTokenPriceUSD: dynamicPrice,
            flashLoanFee: this.flashLoanFee,
            slippageBuffer: this.slippageBuffer,
            minProfitUSD: this.minProfitUSD,
            gasEstimates: {
                flashLoanOverhead: this.gasEstimates.flashLoanOverhead.toString(),
                perSwap: this.gasEstimates.perSwap.toString(),
            },
            dynamicPricing: true,
        };
    }
}

// Export singleton instance
const profitCalculator = new ProfitCalculator();
export default profitCalculator;
