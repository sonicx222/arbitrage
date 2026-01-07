import log from '../utils/logger.js';

/**
 * Price Impact Calculator
 *
 * Calculates precise price impact for trades using actual pool reserves.
 * Supports both Uniswap V2 constant product and V3 concentrated liquidity.
 *
 * Key formulas:
 * - V2: price_impact = 2 * trade_size / (reserve + trade_size)
 * - V3: price_impact depends on liquidity in current tick range
 *
 * Accurate price impact is critical for:
 * 1. Determining realistic profit expectations
 * 2. Finding optimal trade sizes
 * 3. Avoiding failed trades due to slippage
 */
class PriceImpactCalculator {
    constructor(config = {}) {
        // Impact thresholds for risk assessment
        this.impactThresholds = {
            minimal: 0.001,    // 0.1% - Negligible impact
            low: 0.005,        // 0.5% - Low impact
            moderate: 0.01,    // 1.0% - Moderate impact
            high: 0.02,        // 2.0% - High impact
            extreme: 0.05,     // 5.0% - Extreme impact
        };

        // Maximum acceptable impact (default 2%)
        this.maxAcceptableImpact = config.maxAcceptableImpact || 0.02;

        // V3 specific settings
        this.v3TickSpacing = config.v3TickSpacing || 60;

        // Cache for reserve data
        this.reserveCache = new Map();
        this.cacheTTL = config.cacheTTL || 3000; // 3 seconds

        log.info('Price Impact Calculator initialized', {
            maxAcceptableImpact: `${this.maxAcceptableImpact * 100}%`,
        });
    }

    /**
     * Calculate price impact for a V2 swap
     *
     * Uses the constant product formula: x * y = k
     * Price impact = 2 * amountIn / (reserveIn + amountIn)
     *
     * @param {BigInt|number} amountIn - Input amount
     * @param {BigInt|number} reserveIn - Reserve of input token
     * @param {BigInt|number} reserveOut - Reserve of output token
     * @param {number} fee - Swap fee as decimal (e.g., 0.003)
     * @returns {Object} Impact analysis
     */
    calculateV2Impact(amountIn, reserveIn, reserveOut, fee = 0.003) {
        // Convert to BigInt for precision
        const amtIn = BigInt(amountIn);
        const resIn = BigInt(reserveIn);
        const resOut = BigInt(reserveOut);

        if (resIn === 0n || resOut === 0n || amtIn === 0n) {
            return this._emptyImpact();
        }

        // Calculate actual output using constant product formula
        const amountInWithFee = amtIn * BigInt(Math.floor((1 - fee) * 10000));
        const numerator = amountInWithFee * resOut;
        const denominator = (resIn * 10000n) + amountInWithFee;
        const amountOut = numerator / denominator;

        // Spot price (what you'd get for infinitesimal trade)
        // spotPrice = reserveOut / reserveIn
        const spotPriceScaled = (resOut * 10n ** 18n) / resIn;
        const spotPrice = Number(spotPriceScaled) / 1e18;

        // Execution price (actual rate you get)
        const execPriceScaled = (amountOut * 10n ** 18n) / amtIn;
        const executionPrice = Number(execPriceScaled) / 1e18;

        // Price impact = (spotPrice - executionPrice) / spotPrice
        const priceImpact = spotPrice > 0 ? (spotPrice - executionPrice) / spotPrice : 0;

        // Theoretical impact formula: 2 * amountIn / (reserveIn + amountIn)
        const theoreticalImpact = Number(2n * amtIn * 10000n / (resIn + amtIn)) / 10000;

        // Trade size as percentage of pool
        const poolSizePercent = Number(amtIn * 10000n / resIn) / 100;

        return {
            priceImpact: Math.abs(priceImpact),
            priceImpactPercent: Math.abs(priceImpact) * 100,
            theoreticalImpact,
            theoreticalImpactPercent: theoreticalImpact * 100,
            spotPrice,
            executionPrice,
            amountOut: amountOut.toString(),
            poolSizePercent,
            severity: this._getSeverity(Math.abs(priceImpact)),
            isAcceptable: Math.abs(priceImpact) <= this.maxAcceptableImpact,
        };
    }

    /**
     * Calculate price impact for a V3 swap
     *
     * V3 concentrated liquidity means impact depends on:
     * 1. Current liquidity in the tick range
     * 2. Distance to cross into next tick range
     *
     * @param {BigInt|number} amountIn - Input amount
     * @param {BigInt} sqrtPriceX96 - Current sqrt price
     * @param {BigInt|number} liquidity - Active liquidity
     * @param {number} fee - Pool fee tier in bps (e.g., 500 = 0.05%)
     * @param {boolean} zeroForOne - Direction of swap
     * @returns {Object} Impact analysis
     */
    calculateV3Impact(amountIn, sqrtPriceX96, liquidity, fee = 3000, zeroForOne = true) {
        const amtIn = BigInt(amountIn);
        const liq = BigInt(liquidity);
        const sqrtPrice = BigInt(sqrtPriceX96);
        const Q96 = 2n ** 96n;

        if (liq === 0n || amtIn === 0n) {
            return this._emptyImpact();
        }

        // Calculate spot price from sqrtPriceX96
        const priceScaled = (sqrtPrice * sqrtPrice) / Q96;
        const spotPrice = Number(priceScaled) / Number(Q96);

        // Fee adjustment
        const feeDecimal = fee / 1000000;
        const amountInAfterFee = amtIn * BigInt(Math.floor((1 - feeDecimal) * 10000)) / 10000n;

        // V3 price impact estimation
        // For concentrated liquidity: Δ√P = Δx / L (for token0 in)
        // Price impact scales with trade size relative to liquidity
        const impactNumerator = amountInAfterFee * Q96;
        const impactDenominator = liq;

        // Estimated new sqrt price
        let newSqrtPrice;
        if (zeroForOne) {
            // Price decreases when swapping token0 for token1
            newSqrtPrice = sqrtPrice - (impactNumerator / impactDenominator);
        } else {
            // Price increases when swapping token1 for token0
            newSqrtPrice = sqrtPrice + (impactNumerator / impactDenominator);
        }

        if (newSqrtPrice <= 0n) {
            // Trade too large for current liquidity
            return {
                ...this._emptyImpact(),
                priceImpact: 1,
                priceImpactPercent: 100,
                severity: 'extreme',
                isAcceptable: false,
                error: 'Trade size exceeds available liquidity',
            };
        }

        // Calculate new price
        const newPriceScaled = (newSqrtPrice * newSqrtPrice) / Q96;
        const executionPrice = Number(newPriceScaled) / Number(Q96);

        // Price impact
        const priceImpact = Math.abs((spotPrice - executionPrice) / spotPrice);

        // Estimate output (simplified - actual V3 calculation is more complex)
        const avgPrice = (spotPrice + executionPrice) / 2;
        const amountOut = Number(amountInAfterFee) * avgPrice;

        // Pool utilization (how much of liquidity is used)
        const poolUtilization = Number(amountInAfterFee * 10000n / liq) / 100;

        return {
            priceImpact,
            priceImpactPercent: priceImpact * 100,
            spotPrice,
            executionPrice,
            amountOut: Math.floor(amountOut).toString(),
            poolUtilization,
            severity: this._getSeverity(priceImpact),
            isAcceptable: priceImpact <= this.maxAcceptableImpact,
            isV3: true,
        };
    }

    /**
     * Calculate multi-hop price impact
     *
     * For triangular or multi-hop paths, impact compounds at each hop.
     *
     * @param {Array} hops - Array of hop configurations
     *   Each hop: { amountIn, reserveIn, reserveOut, fee, isV3, liquidity, sqrtPriceX96 }
     * @returns {Object} Cumulative impact analysis
     */
    calculateMultiHopImpact(hops) {
        if (!hops || hops.length === 0) {
            return this._emptyImpact();
        }

        const hopResults = [];
        let currentAmount = BigInt(hops[0].amountIn);
        let cumulativeImpact = 0;

        for (let i = 0; i < hops.length; i++) {
            const hop = hops[i];

            let hopResult;
            if (hop.isV3) {
                hopResult = this.calculateV3Impact(
                    currentAmount,
                    hop.sqrtPriceX96,
                    hop.liquidity,
                    hop.fee,
                    hop.zeroForOne
                );
            } else {
                hopResult = this.calculateV2Impact(
                    currentAmount,
                    hop.reserveIn,
                    hop.reserveOut,
                    hop.fee
                );
            }

            hopResults.push({
                hop: i + 1,
                ...hopResult,
            });

            // Compound impact: (1 - impact1) * (1 - impact2) - 1
            cumulativeImpact = 1 - (1 - cumulativeImpact) * (1 - hopResult.priceImpact);

            // Use output as input for next hop
            currentAmount = BigInt(hopResult.amountOut);
        }

        // Final output
        const finalOutput = currentAmount;
        const initialInput = BigInt(hops[0].amountIn);

        // Effective rate
        const effectiveRate = Number(finalOutput * 10n ** 18n / initialInput) / 1e18;

        return {
            cumulativeImpact,
            cumulativeImpactPercent: cumulativeImpact * 100,
            hopResults,
            hops: hops.length,
            finalOutput: finalOutput.toString(),
            effectiveRate,
            severity: this._getSeverity(cumulativeImpact),
            isAcceptable: cumulativeImpact <= this.maxAcceptableImpact,
        };
    }

    /**
     * Find optimal trade size that maximizes profit while limiting impact
     *
     * @param {Object} params - Trade parameters
     *   { reserveIn, reserveOut, fee, targetProfitPercent, maxImpact }
     * @returns {Object} Optimal trade analysis
     */
    findOptimalTradeSize(params) {
        const {
            reserveIn,
            reserveOut,
            fee = 0.003,
            targetProfitPercent = 0.5,
            maxImpact = this.maxAcceptableImpact,
        } = params;

        const resIn = BigInt(reserveIn);
        const resOut = BigInt(reserveOut);

        if (resIn === 0n || resOut === 0n) {
            return { optimalSize: 0n, reason: 'Zero reserves' };
        }

        // Binary search for optimal size
        let low = resIn / 10000n; // 0.01% of reserve
        let high = resIn / 10n;    // 10% of reserve
        let optimal = low;
        let optimalResult = null;

        const iterations = 20;
        for (let i = 0; i < iterations; i++) {
            const mid = (low + high) / 2n;

            const result = this.calculateV2Impact(mid, resIn, resOut, fee);

            if (result.priceImpact <= maxImpact) {
                // Impact is acceptable, try larger size
                optimal = mid;
                optimalResult = result;
                low = mid;
            } else {
                // Impact too high, try smaller size
                high = mid;
            }

            // Check convergence
            if (high - low < resIn / 100000n) break;
        }

        // Calculate profit at optimal size
        const profitMultiplier = (100 + targetProfitPercent) / 100;
        const requiredOutput = (optimal * BigInt(Math.floor(profitMultiplier * 10000))) / 10000n;

        return {
            optimalSize: optimal.toString(),
            optimalSizeFloat: Number(optimal) / 1e18,
            maxAllowedImpact: maxImpact,
            actualImpact: optimalResult?.priceImpact || 0,
            poolPercentage: Number(optimal * 10000n / resIn) / 100,
            analysis: optimalResult,
        };
    }

    /**
     * Estimate slippage tolerance needed for a trade
     *
     * @param {BigInt|number} amountIn - Input amount
     * @param {BigInt|number} reserveIn - Reserve of input token
     * @param {BigInt|number} reserveOut - Reserve of output token
     * @param {number} safetyBuffer - Additional buffer (default 50%)
     * @returns {Object} Recommended slippage settings
     */
    estimateSlippageTolerance(amountIn, reserveIn, reserveOut, safetyBuffer = 0.5) {
        const impact = this.calculateV2Impact(amountIn, reserveIn, reserveOut);

        // Base slippage = price impact + buffer
        const baseSlippage = impact.priceImpact;
        const recommendedSlippage = baseSlippage * (1 + safetyBuffer);

        // Minimum amountOut calculation
        const expectedOut = BigInt(impact.amountOut);
        const minAmountOut = expectedOut * BigInt(Math.floor((1 - recommendedSlippage) * 10000)) / 10000n;

        return {
            priceImpact: impact.priceImpactPercent,
            recommendedSlippage: recommendedSlippage * 100,
            minimumSlippage: baseSlippage * 100,
            expectedAmountOut: impact.amountOut,
            minAmountOut: minAmountOut.toString(),
            severity: impact.severity,
        };
    }

    /**
     * Analyze trade viability based on reserves and impact
     *
     * @param {Object} opportunity - Arbitrage opportunity with reserves
     * @returns {Object} Viability analysis
     */
    analyzeTradeViability(opportunity) {
        const {
            reserveA,
            reserveB,
            optimalTradeSizeUSD,
            buyPrice,
            sellPrice,
        } = opportunity;

        // Convert trade size to token amount (assuming price ~ 1 for simplicity)
        const tradeAmount = BigInt(Math.floor(optimalTradeSizeUSD * 1e18));

        // Check buy impact
        const buyImpact = this.calculateV2Impact(
            tradeAmount,
            reserveB || 1e23,
            reserveA || 1e23,
            0.003
        );

        // Check sell impact (output from buy becomes input for sell)
        const sellAmount = BigInt(buyImpact.amountOut);
        const sellImpact = this.calculateV2Impact(
            sellAmount,
            reserveA || 1e23,
            reserveB || 1e23,
            0.003
        );

        // Total impact
        const totalImpact = 1 - (1 - buyImpact.priceImpact) * (1 - sellImpact.priceImpact);

        // Spread vs impact analysis
        const spread = Math.abs(sellPrice - buyPrice) / buyPrice;
        const netSpread = spread - totalImpact;

        return {
            buyImpact: buyImpact.priceImpactPercent,
            sellImpact: sellImpact.priceImpactPercent,
            totalImpact: totalImpact * 100,
            grossSpread: spread * 100,
            netSpread: netSpread * 100,
            isViable: netSpread > 0 && totalImpact <= this.maxAcceptableImpact,
            recommendation: this._getRecommendation(netSpread, totalImpact),
        };
    }

    /**
     * Get severity classification for price impact
     *
     * @private
     */
    _getSeverity(impact) {
        if (impact <= this.impactThresholds.minimal) return 'minimal';
        if (impact <= this.impactThresholds.low) return 'low';
        if (impact <= this.impactThresholds.moderate) return 'moderate';
        if (impact <= this.impactThresholds.high) return 'high';
        return 'extreme';
    }

    /**
     * Get trade recommendation
     *
     * @private
     */
    _getRecommendation(netSpread, totalImpact) {
        if (netSpread <= 0) {
            return 'SKIP: Price impact exceeds spread';
        }
        if (totalImpact > this.maxAcceptableImpact) {
            return 'REDUCE_SIZE: Impact too high';
        }
        if (netSpread < 0.002) {
            return 'CAUTION: Thin margin';
        }
        return 'EXECUTE: Trade is viable';
    }

    /**
     * Return empty impact structure
     *
     * @private
     */
    _emptyImpact() {
        return {
            priceImpact: 0,
            priceImpactPercent: 0,
            spotPrice: 0,
            executionPrice: 0,
            amountOut: '0',
            severity: 'minimal',
            isAcceptable: true,
        };
    }

    /**
     * Update maximum acceptable impact
     *
     * @param {number} maxImpact - New maximum as decimal (e.g., 0.02 = 2%)
     */
    setMaxAcceptableImpact(maxImpact) {
        this.maxAcceptableImpact = maxImpact;
        log.info('Max acceptable impact updated', {
            maxAcceptableImpact: `${maxImpact * 100}%`,
        });
    }

    /**
     * Get calculator statistics
     */
    getStats() {
        return {
            maxAcceptableImpact: `${this.maxAcceptableImpact * 100}%`,
            impactThresholds: Object.fromEntries(
                Object.entries(this.impactThresholds).map(([k, v]) => [k, `${v * 100}%`])
            ),
        };
    }
}

// Export singleton instance
const priceImpactCalculator = new PriceImpactCalculator();
export default priceImpactCalculator;
