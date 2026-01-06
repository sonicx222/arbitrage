import { formatUnits } from 'ethers';
import config from '../config.js';
import log from '../utils/logger.js';
import { FLASH_LOAN_FEE } from '../contracts/abis.js';

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
        // BNB price in USD (updated dynamically or from config)
        this.bnbPriceUSD = 600;

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

        log.info('Profit Calculator initialized', {
            flashLoanFee: `${this.flashLoanFee * 100}%`,
            slippageBuffer: `${this.slippageBuffer * 100}%`,
            minProfitUSD: `$${this.minProfitUSD}`,
        });
    }

    /**
     * Calculate comprehensive net profit for an opportunity
     *
     * @param {Object} opportunity - Arbitrage opportunity (cross-dex or triangular)
     * @param {BigInt} gasPrice - Current gas price in wei
     * @param {number} bnbPrice - Current BNB price in USD (optional)
     * @returns {Object} Detailed profit breakdown
     */
    calculateNetProfit(opportunity, gasPrice, bnbPrice = null) {
        const currentBnbPrice = bnbPrice || this.bnbPriceUSD;

        // Determine opportunity type and calculate accordingly
        if (opportunity.type === 'triangular') {
            return this._calculateTriangularProfit(opportunity, gasPrice, currentBnbPrice);
        } else {
            return this._calculateCrossDexProfit(opportunity, gasPrice, currentBnbPrice);
        }
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
     * Estimate gas cost in USD
     *
     * @private
     * @param {BigInt} gasPrice - Gas price in wei
     * @param {number} swapCount - Number of swaps
     * @param {number} bnbPrice - BNB price in USD
     * @returns {number} Gas cost in USD
     */
    _estimateGasCostUSD(gasPrice, swapCount, bnbPrice) {
        const totalGas = this.gasEstimates.flashLoanOverhead +
                        (this.gasEstimates.perSwap * BigInt(swapCount)) +
                        this.gasEstimates.profitValidation;

        const gasCostWei = totalGas * gasPrice;
        const gasCostBNB = Number(gasCostWei) / 1e18;
        const gasCostUSD = gasCostBNB * bnbPrice;

        return gasCostUSD;
    }

    /**
     * Get approximate token price in USD
     *
     * @private
     * @param {string} tokenSymbol - Token symbol
     * @param {number} bnbPrice - Current BNB price
     * @returns {number} Approximate USD price
     */
    _getTokenPriceUSD(tokenSymbol, bnbPrice) {
        // Stablecoins
        if (['USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'FDUSD'].includes(tokenSymbol)) {
            return 1.0;
        }

        // BNB-based
        if (['WBNB', 'BNB'].includes(tokenSymbol)) {
            return bnbPrice;
        }

        // Other major tokens (approximate)
        const tokenPrices = {
            'ETH': 3500,
            'BTCB': 95000,
            'WBTC': 95000,
            'CAKE': 2.5,
            'XRP': 2.0,
            'ADA': 1.0,
            'DOT': 7.0,
            'LINK': 20.0,
            'UNI': 12.0,
            'AAVE': 300.0,
        };

        return tokenPrices[tokenSymbol] || 1.0; // Default to $1 for unknown
    }

    /**
     * Update BNB price
     *
     * @param {number} price - New BNB price in USD
     */
    updateBnbPrice(price) {
        this.bnbPriceUSD = price;
        log.debug(`BNB price updated to $${price}`);
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
        return {
            bnbPriceUSD: this.bnbPriceUSD,
            flashLoanFee: this.flashLoanFee,
            slippageBuffer: this.slippageBuffer,
            minProfitUSD: this.minProfitUSD,
            gasEstimates: {
                flashLoanOverhead: this.gasEstimates.flashLoanOverhead.toString(),
                perSwap: this.gasEstimates.perSwap.toString(),
            },
        };
    }
}

// Export singleton instance
const profitCalculator = new ProfitCalculator();
export default profitCalculator;
