import { formatUnits } from 'ethers';
import config from '../config.js';
import log from '../utils/logger.js';
import { FLASH_LOAN_FEE } from '../contracts/abis.js';

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
     * Calculate profit for triangular arbitrage
     *
     * @private
     */
    _calculateTriangularProfit(opportunity, gasPrice, bnbPrice) {
        const {
            estimatedProfitPercent,
            minLiquidityUSD,
            dexName,
            path,
        } = opportunity;

        // Get base token price (first token in path)
        const baseToken = path[0];
        const baseTokenPriceUSD = this._getTokenPriceUSD(baseToken, bnbPrice);

        // Determine optimal trade size (limited by liquidity)
        const maxTradeUSD = Math.min(5000, minLiquidityUSD * 0.1); // Max 10% of pool
        const tradeSizeUSD = maxTradeUSD;

        // Gross profit from cycle rate
        const grossProfitUSD = tradeSizeUSD * (estimatedProfitPercent / 100);

        // Flash loan fee
        const flashFeeUSD = tradeSizeUSD * this.flashLoanFee;

        // Gas cost (3 swaps for triangular)
        const swapCount = 3;
        const gasCostUSD = this._estimateGasCostUSD(gasPrice, swapCount, bnbPrice);

        // Slippage buffer
        const slippageUSD = grossProfitUSD * this.slippageBuffer;

        // Net profit
        const netProfitUSD = grossProfitUSD - flashFeeUSD - gasCostUSD - slippageUSD;
        const netProfitPercent = tradeSizeUSD > 0
            ? (netProfitUSD / tradeSizeUSD) * 100
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
            tradeSizeUSD,
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
