import { parseUnits, formatUnits } from 'ethers';
import rpcManager from '../utils/rpcManager.js';
import config from '../config.js';
import log from '../utils/logger.js';

/**
 * Gas Optimizer
 *
 * Optimizes gas price based on opportunity profitability and network conditions.
 * Strategy:
 * - High profit opportunities (>$50): Pay 20% premium for faster inclusion
 * - Medium profit ($10-50): Use current market gas price
 * - Low profit ($1-10): Use slightly below average, willing to wait
 *
 * Also tracks historical gas prices for analysis.
 */
class GasOptimizer {
    constructor() {
        // Gas price history for analysis
        this.gasPriceHistory = [];
        this.maxHistorySize = 100;

        // Gas price limits
        this.maxGasPriceGwei = config.execution?.maxGasPriceGwei || 10;
        this.minGasPriceGwei = 1;

        // Premium/discount tiers based on profit
        this.tiers = {
            high: { minProfit: 50, multiplier: 1.20 },    // $50+ -> 20% premium
            medium: { minProfit: 10, multiplier: 1.0 },   // $10-50 -> market rate
            low: { minProfit: 0, multiplier: 0.95 },      // <$10 -> 5% discount
        };

        // Cache for gas price to avoid redundant calls
        this.cachedGasPrice = null;
        this.cacheTimestamp = 0;
        this.cacheDuration = 3000; // 3 seconds

        log.info('Gas Optimizer initialized', {
            maxGasPrice: `${this.maxGasPriceGwei} Gwei`,
            tiers: this.tiers,
        });
    }

    /**
     * Get optimal gas price for a specific opportunity
     *
     * @param {Object} opportunity - Arbitrage opportunity with profit calculation
     * @returns {BigInt} Optimal gas price in wei
     */
    async getOptimalGasPrice(opportunity) {
        const currentGasPrice = await this.getCurrentGasPrice();
        const profitUSD = opportunity.profitCalculation?.netProfitUSD || 0;

        // Determine tier and multiplier
        let multiplier = this.tiers.low.multiplier;
        let tier = 'low';

        if (profitUSD >= this.tiers.high.minProfit) {
            multiplier = this.tiers.high.multiplier;
            tier = 'high';
        } else if (profitUSD >= this.tiers.medium.minProfit) {
            multiplier = this.tiers.medium.multiplier;
            tier = 'medium';
        }

        // Calculate optimal gas price
        let optimalGasPrice = BigInt(Math.floor(Number(currentGasPrice) * multiplier));

        // Apply limits
        const maxGasWei = parseUnits(this.maxGasPriceGwei.toString(), 'gwei');
        const minGasWei = parseUnits(this.minGasPriceGwei.toString(), 'gwei');

        if (optimalGasPrice > maxGasWei) {
            optimalGasPrice = maxGasWei;
            log.debug('Gas price capped at maximum', { maxGwei: this.maxGasPriceGwei });
        }

        if (optimalGasPrice < minGasWei) {
            optimalGasPrice = minGasWei;
        }

        log.debug('Gas price optimized', {
            currentGwei: formatUnits(currentGasPrice, 'gwei'),
            optimalGwei: formatUnits(optimalGasPrice, 'gwei'),
            tier,
            profitUSD: profitUSD.toFixed(2),
        });

        return optimalGasPrice;
    }

    /**
     * Get current network gas price with caching
     *
     * @returns {BigInt} Gas price in wei
     */
    async getCurrentGasPrice() {
        const now = Date.now();

        // Return cached value if fresh
        if (this.cachedGasPrice && (now - this.cacheTimestamp < this.cacheDuration)) {
            return this.cachedGasPrice;
        }

        try {
            const gasPrice = await rpcManager.getGasPrice();

            // Update cache
            this.cachedGasPrice = gasPrice;
            this.cacheTimestamp = now;

            // Record in history
            this.recordGasPrice(gasPrice);

            return gasPrice;
        } catch (error) {
            log.error('Failed to fetch gas price', { error: error.message });

            // Fallback to cached or default
            if (this.cachedGasPrice) {
                return this.cachedGasPrice;
            }

            return parseUnits(config.trading.gasPriceGwei.toString(), 'gwei');
        }
    }

    /**
     * Record gas price in history
     *
     * FIX v3.2: Replaced O(n) Array.shift() with batched slice() for better performance
     * Old approach: shift() on every insert above maxHistorySize = O(n) per insert
     * New approach: slice() when 20% over limit = O(1) amortized
     *
     * @param {BigInt} gasPrice - Gas price in wei
     */
    recordGasPrice(gasPrice) {
        this.gasPriceHistory.push({
            gasPrice,
            timestamp: Date.now(),
        });

        // FIX v3.2: Trim history with batched slice instead of O(n) shift
        // Only trim when 20% over limit (reduces frequency of O(n) operations)
        const trimThreshold = Math.floor(this.maxHistorySize * 1.2);
        if (this.gasPriceHistory.length > trimThreshold) {
            // Keep most recent maxHistorySize entries
            this.gasPriceHistory = this.gasPriceHistory.slice(-this.maxHistorySize);
        }
    }

    /**
     * Check if current gas price is favorable for trading
     *
     * FIX v3.2: Added validation to prevent NaN/Infinity from division by zero
     *
     * @param {number} profitUSD - Expected profit in USD
     * @param {number} gasCostUSD - Estimated gas cost in USD
     * @returns {boolean} True if gas conditions are favorable
     */
    async isGasFavorable(profitUSD, gasCostUSD) {
        // FIX v3.2: Validate inputs to prevent NaN/Infinity
        // profitUSD of 0 or negative means unfavorable by definition
        if (!Number.isFinite(profitUSD) || profitUSD <= 0) {
            log.debug('Gas conditions unfavorable: invalid or non-positive profit', {
                profitUSD,
                gasCostUSD,
            });
            return false;
        }

        if (!Number.isFinite(gasCostUSD) || gasCostUSD < 0) {
            log.debug('Gas conditions unfavorable: invalid gas cost', {
                profitUSD,
                gasCostUSD,
            });
            return false;
        }

        // Gas should be less than 50% of profit
        const gasCostRatio = gasCostUSD / profitUSD;
        const isFavorable = gasCostRatio < 0.5;

        if (!isFavorable) {
            log.debug('Gas conditions unfavorable', {
                profitUSD: profitUSD.toFixed(2),
                gasCostUSD: gasCostUSD.toFixed(2),
                ratio: `${(gasCostRatio * 100).toFixed(1)}%`,
            });
        }

        return isFavorable;
    }

    /**
     * Check if opportunity should be executed based on gas price
     *
     * @param {Object} opportunity - Opportunity with profit calculation
     * @returns {Object} { shouldExecute, reason }
     */
    async shouldExecute(opportunity) {
        const currentGasPrice = await this.getCurrentGasPrice();
        const maxGasWei = parseUnits(this.maxGasPriceGwei.toString(), 'gwei');

        // Check if gas is too high
        if (currentGasPrice > maxGasWei) {
            return {
                shouldExecute: false,
                reason: `Gas price too high: ${formatUnits(currentGasPrice, 'gwei')} > ${this.maxGasPriceGwei} Gwei`,
            };
        }

        // Check if profit covers gas
        const profitCalc = opportunity.profitCalculation;
        if (profitCalc && profitCalc.gasCostUSD > profitCalc.netProfitUSD) {
            return {
                shouldExecute: false,
                reason: `Gas cost ($${profitCalc.gasCostUSD.toFixed(2)}) exceeds profit ($${profitCalc.netProfitUSD.toFixed(2)})`,
            };
        }

        return {
            shouldExecute: true,
            reason: 'Gas conditions favorable',
        };
    }

    /**
     * Get gas price statistics
     *
     * @returns {Object} Statistics
     */
    getStats() {
        if (this.gasPriceHistory.length === 0) {
            return {
                current: null,
                average: null,
                min: null,
                max: null,
                samples: 0,
            };
        }

        const prices = this.gasPriceHistory.map(h => Number(formatUnits(h.gasPrice, 'gwei')));
        const current = prices[prices.length - 1];
        const average = prices.reduce((a, b) => a + b, 0) / prices.length;
        const min = Math.min(...prices);
        const max = Math.max(...prices);

        return {
            current: `${current.toFixed(2)} Gwei`,
            average: `${average.toFixed(2)} Gwei`,
            min: `${min.toFixed(2)} Gwei`,
            max: `${max.toFixed(2)} Gwei`,
            samples: prices.length,
        };
    }

    /**
     * Get gas price trend (increasing, decreasing, stable)
     *
     * @returns {string} Trend indicator
     */
    getTrend() {
        if (this.gasPriceHistory.length < 10) {
            return 'insufficient_data';
        }

        const recent = this.gasPriceHistory.slice(-5);
        const older = this.gasPriceHistory.slice(-10, -5);

        const recentAvg = recent.reduce((a, b) => a + Number(b.gasPrice), 0) / recent.length;
        const olderAvg = older.reduce((a, b) => a + Number(b.gasPrice), 0) / older.length;

        // FIX v3.2: Validate divisor to prevent division by zero
        if (!Number.isFinite(olderAvg) || olderAvg <= 0) {
            return 'insufficient_data';
        }

        const changePercent = ((recentAvg - olderAvg) / olderAvg) * 100;

        if (changePercent > 10) return 'increasing';
        if (changePercent < -10) return 'decreasing';
        return 'stable';
    }

    /**
     * Wait for favorable gas conditions
     *
     * @param {number} maxWaitMs - Maximum time to wait
     * @param {number} targetGwei - Target gas price in Gwei
     * @returns {Promise<boolean>} True if favorable conditions achieved
     */
    async waitForFavorableGas(maxWaitMs = 30000, targetGwei = null) {
        const target = targetGwei || this.maxGasPriceGwei * 0.8;
        const targetWei = parseUnits(target.toString(), 'gwei');
        const startTime = Date.now();

        log.debug(`Waiting for gas price <= ${target} Gwei (max ${maxWaitMs}ms)`);

        while (Date.now() - startTime < maxWaitMs) {
            const currentGasPrice = await this.getCurrentGasPrice();

            if (currentGasPrice <= targetWei) {
                log.debug('Favorable gas conditions achieved', {
                    currentGwei: formatUnits(currentGasPrice, 'gwei'),
                    targetGwei: target,
                });
                return true;
            }

            // Wait 1 second before checking again
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        log.debug('Timeout waiting for favorable gas');
        return false;
    }
}

// Export singleton instance
const gasOptimizer = new GasOptimizer();
export default gasOptimizer;
