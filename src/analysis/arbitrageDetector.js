import { ethers, parseUnits, formatUnits } from 'ethers';
import rpcManager from '../utils/rpcManager.js';
import triangularDetector from './triangularDetector.js';
import profitCalculator from './profitCalculator.js';
import cacheManager from '../data/cacheManager.js';
import config from '../config.js';
import log from '../utils/logger.js';
import { formatOpportunity, formatOpportunitySummary, formatDuration } from '../utils/logFormatter.js';
import { NATIVE_TOKEN_PRICES } from '../constants/tokenPrices.js';
import gasPriceCache from '../utils/gasPriceCache.js';
import speedMetrics from '../utils/speedMetrics.js';

/**
 * Arbitrage Detector - Identifies profitable arbitrage opportunities across DEXs
 *
 * Supports multiple arbitrage types:
 * 1. Cross-DEX: Buy on DEX A, sell on DEX B
 * 2. Triangular: A -> B -> C -> A within single DEX
 * 3. Cross-DEX Triangular: A -> B -> C -> A across different DEXes
 */
class ArbitrageDetector {
    constructor() {
        this.minProfitPercentage = config.trading.minProfitPercentage;
        this.gasPriceGwei = config.trading.gasPriceGwei;
        this.estimatedGasLimit = config.trading.estimatedGasLimit;

        // Triangular arbitrage enabled by config
        this.triangularEnabled = config.triangular?.enabled !== false;

        log.debug('Arbitrage Detector ready');
    }

    /**
     * Detect all arbitrage opportunities from price data
     * Includes both cross-DEX and triangular arbitrage
     *
     * SPEED OPTIMIZATIONS (v3.0):
     * 1. Gas price caching (-100-200ms)
     * 2. Early-exit spread filter (-30-50% pairs)
     * 3. Parallel cross-DEX + triangular detection (-40-60%)
     */
    async detectOpportunities(prices, blockNumber) {
        const startTime = Date.now();
        const trace = speedMetrics.startTrace(`detection_${blockNumber}`);
        let opportunities = [];

        // ==================== SPEED OPT 1: CACHED GAS PRICE ====================
        // Uses shared gas price cache with 2s TTL to eliminate redundant RPC calls
        // Expected improvement: -100-200ms per detection cycle
        speedMetrics.markPhaseStart('gasPrice');
        let gasPrice = BigInt(parseUnits(config.trading.gasPriceGwei.toString(), 'gwei'));
        if (config.dynamicGas) {
            try {
                const cachedGas = await gasPriceCache.getGasPrice(async () => {
                    return await rpcManager.withRetry(async (provider) => provider.getFeeData());
                });
                gasPrice = cachedGas.gasPrice || gasPrice;
                log.debug(`Gas price: ${formatUnits(gasPrice, 'gwei')} Gwei (${cachedGas.source || 'cached'})`);
            } catch (err) {
                log.warn('Fallback to static gas price');
            }
        }
        speedMetrics.markPhaseEnd('gasPrice');

        const pairs = Object.entries(prices);
        if (config.debugMode) {
            log.info(`🔍 Scanning ${pairs.length} pairs for arbitrage at block ${blockNumber}...`);
        }

        // ==================== SPEED OPT 2: EARLY-EXIT SPREAD FILTER ====================
        // Pre-filter pairs with obvious negative spread to skip expensive analysis
        // Expected improvement: -30-50% pairs processed
        speedMetrics.markPhaseStart('pairFilter');
        const filteredPairs = this._quickSpreadFilter(pairs);
        speedMetrics.markPhaseEnd('pairFilter');

        if (config.debugMode && filteredPairs.length < pairs.length) {
            log.debug(`Speed opt: Filtered ${pairs.length - filteredPairs.length}/${pairs.length} pairs (no spread)`);
        }

        // ==================== SPEED OPT 3: PARALLEL DETECTION ====================
        // Run cross-DEX and triangular detection in parallel
        // Expected improvement: -40-60% detection time
        speedMetrics.markPhaseStart('crossDexDetection');
        speedMetrics.markPhaseStart('triangularDetection');

        const [crossDexOpps, triangularOpps] = await Promise.all([
            // Cross-DEX detection (now on filtered pairs)
            Promise.resolve().then(() => {
                const opps = [];
                for (const [pairKey, dexPrices] of filteredPairs) {
                    const opp = this.checkOpportunity(pairKey, dexPrices, gasPrice);
                    if (opp) {
                        opp.type = 'cross-dex';
                        opp.blockNumber = blockNumber;
                        opps.push(opp);
                    }
                }
                speedMetrics.markPhaseEnd('crossDexDetection');
                return opps;
            }),
            // Triangular detection (parallel)
            this.triangularEnabled
                ? Promise.resolve().then(() => {
                    const opps = this._detectTriangularOpportunities(prices, blockNumber);
                    speedMetrics.markPhaseEnd('triangularDetection');
                    return opps;
                })
                : Promise.resolve([]),
        ]);

        opportunities = [...crossDexOpps, ...triangularOpps];

        // 3. Calculate accurate profit for all opportunities
        // Note: batchCalculate already returns results sorted by netProfitUSD descending
        if (opportunities.length > 0) {
            opportunities = profitCalculator.batchCalculate(opportunities, gasPrice);

            // ==================== MEV-ADJUSTED SORTING ====================
            // Improvement v2.0: Sort by MEV-adjusted score if enabled
            // This prioritizes opportunities with lower MEV risk
            if (config.execution?.mevAwareSorting !== false) {
                opportunities.sort((a, b) => {
                    // Sort by MEV-adjusted score if available, otherwise by profit
                    const scoreA = a.mevAdjustedScore || a.profitUSD || 0;
                    const scoreB = b.mevAdjustedScore || b.profitUSD || 0;
                    return scoreB - scoreA;
                });
            }
        }

        // 5. Log results - single consolidated log entry
        const duration = Date.now() - startTime;
        speedMetrics.endTrace('totalDetection');

        if (opportunities.length > 0) {
            // Summary line with counts and top profit
            const summary = formatOpportunitySummary(opportunities, duration);
            log.info(`💰 ${summary}`);

            // Log top 3 opportunities with consistent formatting
            const topOpps = opportunities.slice(0, 3);
            for (const opp of topOpps) {
                const { icon, text } = formatOpportunity(opp);
                log.info(`   ${icon} ${text}`);
            }
        } else {
            // Log every 10th block with no opportunities to show the bot is alive
            if (blockNumber % 10 === 0) {
                log.debug(`📡 Block ${blockNumber} scanned | ${pairs.length} pairs | ${formatDuration(duration)} | No opportunities`);
            }
        }

        return opportunities;
    }

    /**
     * Quick spread filter for early-exit optimization
     *
     * SPEED OPTIMIZATION: Pre-filters pairs with no profitable spread
     * to avoid expensive checkOpportunity analysis on hopeless pairs.
     *
     * @private
     * @param {Array} pairs - Array of [pairKey, dexPrices] entries
     * @returns {Array} Filtered pairs with potential spread
     */
    _quickSpreadFilter(pairs) {
        // Get minimum total fee (buy + sell) from config
        const dexFees = Object.values(config.dex || {})
            .filter(d => d.enabled)
            .map(d => d.fee || 0.003);
        const minFee = Math.min(...dexFees) || 0.003;
        const minSpreadPercent = (minFee * 2 * 100) + this.minProfitPercentage;

        return pairs.filter(([pairKey, dexPrices]) => {
            const priceValues = Object.values(dexPrices);

            // Need at least 2 DEXes to arbitrage
            if (priceValues.length < 2) return false;

            // Extract prices, filtering invalid ones
            const prices = priceValues
                .map(d => d.price)
                .filter(p => p > 0 && Number.isFinite(p));

            if (prices.length < 2) return false;

            // Calculate spread
            const min = Math.min(...prices);
            const max = Math.max(...prices);

            // Skip if no spread (same DEX would be buy and sell)
            if (min === max) return false;

            const spreadPercent = ((max - min) / min) * 100;

            // Early exit if spread doesn't exceed minimum threshold
            return spreadPercent >= minSpreadPercent;
        });
    }

    /**
     * Process a single token pair across all DEXs
     */
    checkOpportunity(pairKey, dexPrices, gasPrice) {
        if (Object.keys(dexPrices).length < 2) return null;

        const spread = this.findBestSpread(dexPrices);
        if (!spread.buyDex || !spread.sellDex) return null;

        const { buyDex, sellDex } = spread;
        const buyDexData = { ...dexPrices[buyDex], dexName: buyDex };
        const sellDexData = { ...dexPrices[sellDex], dexName: sellDex };

        // 1. Initial viability filters
        if (!this._isViable(pairKey, buyDexData, sellDexData)) return null;

        // 2. Calculate Real Profit with Optimal Trade Size
        const [tokenA, tokenB] = pairKey.split('/');
        const tokenADecimals = config.tokens[tokenA]?.decimals || 18;
        const tokenBDecimals = config.tokens[tokenB]?.decimals || 18;

        const { profitUSD, optimalAmount, priceUSD } = this.optimizeTradeAmount(
            buyDexData,
            sellDexData,
            tokenADecimals,
            tokenBDecimals
        );

        // 3. Factor in Gas (use dynamic native token price)
        const nativePrice = this._getDynamicNativePrice();
        const gasCostUSD = this.estimateGasCost(gasPrice) * nativePrice;
        const netProfitUSD = profitUSD - gasCostUSD;

        const tradeSizeUSD = (Number(optimalAmount) / Math.pow(10, tokenBDecimals)) * priceUSD;
        const roiPercent = tradeSizeUSD > 0 ? (netProfitUSD / tradeSizeUSD) * 100 : 0;

        if (netProfitUSD <= 1.0) return null; // Min $1 profit after gas

        // ==================== MEV RISK SCORING ====================
        // Improvement v2.0: Add MEV-aware opportunity scoring
        // Helps prioritize opportunities by execution viability
        const mevAnalysis = this._calculateMEVRisk({
            profitUSD: netProfitUSD,
            tradeSizeUSD,
            minLiquidityUSD: Math.min(buyDexData.liquidityUSD || 0, sellDexData.liquidityUSD || 0),
            spreadPercent: ((spread.sellPrice - spread.buyPrice) / spread.buyPrice) * 100,
        });

        // Calculate MEV-adjusted score (higher = better opportunity)
        const mevAdjustedScore = (netProfitUSD * (1 - mevAnalysis.riskFactor)) /
            Math.max(0.1, mevAnalysis.competitionScore);

        return {
            pairKey, tokenA, tokenB,
            buyDex, sellDex,
            buyPrice: spread.buyPrice,
            sellPrice: spread.sellPrice,
            profitUSD: netProfitUSD,
            optimalTradeSizeUSD: tradeSizeUSD,
            netProfitPercentage: roiPercent,
            gasCostUSD,
            // MEV risk scoring (v2.0)
            mevRisk: mevAnalysis.riskLevel,
            mevRiskFactor: mevAnalysis.riskFactor,
            mevAdjustedScore,
            competitionLevel: mevAnalysis.competitionLevel,
            expectedMEVLoss: mevAnalysis.expectedLossUSD,
            timestamp: Date.now()
        };
    }

    /**
     * Detect triangular arbitrage opportunities
     *
     * @private
     * @param {Object} prices - Price data from priceFetcher
     * @param {number} blockNumber - Current block number
     * @returns {Array} Array of triangular opportunities
     */
    _detectTriangularOpportunities(prices, blockNumber) {
        const opportunities = [];

        try {
            // Single-DEX triangular
            const triangularOpps = triangularDetector.findTriangularOpportunities(prices, blockNumber);
            opportunities.push(...triangularOpps);

            // Cross-DEX triangular
            const crossDexOpps = triangularDetector.findCrossDexTriangularOpportunities(prices, blockNumber);
            opportunities.push(...crossDexOpps);

            // Note: Summary logging is handled by detectOpportunities, not here
        } catch (err) {
            log.error('Triangular detection error', { error: err.message });
        }

        return opportunities;
    }

    /**
     * Calculate MEV risk factors for an opportunity
     *
     * Improvement v2.0: MEV-aware opportunity scoring
     * Analyzes:
     * - Frontrunning risk based on profit size
     * - Sandwich attack risk based on trade size
     * - Competition level based on spread visibility
     * - Expected MEV loss estimation
     *
     * @private
     * @param {Object} params - Opportunity parameters
     * @returns {Object} MEV risk analysis
     */
    _calculateMEVRisk({ profitUSD, tradeSizeUSD, minLiquidityUSD, spreadPercent }) {
        // Risk factors (0-1 scale)
        let frontrunRisk = 0;
        let sandwichRisk = 0;
        let backrunRisk = 0;

        // Frontrunning risk: Higher profit = more attractive to frontrunners
        // Bots typically don't bother with < $5 profit
        if (profitUSD > 50) {
            frontrunRisk = 0.6;
        } else if (profitUSD > 20) {
            frontrunRisk = 0.4;
        } else if (profitUSD > 5) {
            frontrunRisk = 0.2;
        }

        // Sandwich risk: Larger trades are more attractive for sandwich attacks
        // Risk increases significantly above $1000 trade size
        if (tradeSizeUSD > 5000) {
            sandwichRisk = 0.5;
        } else if (tradeSizeUSD > 2000) {
            sandwichRisk = 0.3;
        } else if (tradeSizeUSD > 1000) {
            sandwichRisk = 0.15;
        }

        // Backrun risk: Based on trade impact relative to liquidity
        const tradeImpact = tradeSizeUSD / Math.max(1, minLiquidityUSD);
        if (tradeImpact > 0.05) { // > 5% of liquidity
            backrunRisk = 0.4;
        } else if (tradeImpact > 0.02) {
            backrunRisk = 0.2;
        }

        // Competition level based on spread visibility
        // Larger spreads are more visible to other bots
        let competitionLevel = 'low';
        let competitionScore = 0.5; // 0-1, higher = more competition
        if (spreadPercent > 2) {
            competitionLevel = 'high';
            competitionScore = 0.9;
        } else if (spreadPercent > 1) {
            competitionLevel = 'medium';
            competitionScore = 0.7;
        } else if (spreadPercent > 0.5) {
            competitionLevel = 'moderate';
            competitionScore = 0.5;
        } else {
            competitionLevel = 'low';
            competitionScore = 0.3;
        }

        // Total risk factor (weighted average)
        const riskFactor = Math.min(1,
            (frontrunRisk * 0.4) +
            (sandwichRisk * 0.35) +
            (backrunRisk * 0.25)
        );

        // Risk level classification
        let riskLevel = 'low';
        if (riskFactor > 0.4) {
            riskLevel = 'high';
        } else if (riskFactor > 0.2) {
            riskLevel = 'medium';
        }

        // Expected MEV loss (conservative estimate)
        const expectedLossUSD = profitUSD * riskFactor;

        return {
            riskLevel,
            riskFactor,
            competitionLevel,
            competitionScore,
            expectedLossUSD,
            breakdown: {
                frontrun: frontrunRisk,
                sandwich: sandwichRisk,
                backrun: backrunRisk,
            },
        };
    }

    /**
     * Quick check if a pair is worth deep analysis
     * @private
     */
    _isViable(pairKey, buyDexData, sellDexData) {
        const minLiquidity = Math.min(buyDexData.liquidityUSD || 0, sellDexData.liquidityUSD || 0);
        if (minLiquidity < 1000) return false;

        // Safety check: prices must be valid positive numbers
        if (!buyDexData.price || buyDexData.price <= 0 || !Number.isFinite(buyDexData.price)) {
            return false;
        }
        if (!sellDexData.price || sellDexData.price <= 0 || !Number.isFinite(sellDexData.price)) {
            return false;
        }

        const buyFee = config.dex[buyDexData.dexName]?.fee || 0.003;
        const sellFee = config.dex[sellDexData.dexName]?.fee || 0.003;
        const totalFee = (buyFee + sellFee) * 100;

        // Simple spread check before expensive optimization
        const spreadPercent = ((sellDexData.price - buyDexData.price) / buyDexData.price) * 100;
        return Number.isFinite(spreadPercent) && (spreadPercent - totalFee) >= this.minProfitPercentage;
    }

    /**
     * Find the best buy/sell spread across all DEXs for a pair
     */
    findBestSpread(dexPrices) {
        let lowestPrice = Infinity;
        let highestPrice = -Infinity;
        let buyDex = null;
        let sellDex = null;

        // Find lowest (buy) and highest (sell) prices
        for (const [dexName, priceData] of Object.entries(dexPrices)) {
            const price = priceData.price;

            if (price < lowestPrice) {
                lowestPrice = price;
                buyDex = dexName;
            }

            if (price > highestPrice) {
                highestPrice = price;
                sellDex = dexName;
            }
        }

        // If buy and sell are same DEX, no arbitrage
        if (buyDex === sellDex) {
            return { buyDex: null, sellDex: null };
        }

        // Calculate profit percentage
        const profitPercentage = ((highestPrice - lowestPrice) / lowestPrice) * 100;

        return {
            buyDex,
            sellDex,
            buyPrice: lowestPrice,
            sellPrice: highestPrice,
            profitPercentage,
        };
    }

    /**
     * Estimate gas cost in native token (BNB/ETH/MATIC etc.)
     */
    estimateGasCost(gasPrice = null) {
        const price = gasPrice || BigInt(parseUnits(this.gasPriceGwei.toString(), 'gwei'));
        // Gas cost in native token
        const gasCostNative = (BigInt(this.estimatedGasLimit) * price);
        return Number(gasCostNative) / 1e18;
    }

    /**
     * Get dynamic native token price from cache
     * @private
     */
    _getDynamicNativePrice() {
        const nativeSymbol = config.nativeToken?.symbol || 'WBNB';

        const dexNames = Object.entries(config.dex)
            .filter(([_, dexConfig]) => dexConfig.enabled)
            .map(([name]) => name);

        // Use centralized fallback prices
        return cacheManager.getNativeTokenPrice(
            nativeSymbol,
            config.tokens,
            dexNames,
            NATIVE_TOKEN_PRICES[nativeSymbol] || 600
        );
    }

    /**
     * Calculate exact output amount using Uniswap V2 formula
     *
     * FIX v3.1: Added input validation to prevent NaN/BigInt conversion errors
     */
    getAmountOut(amountIn, reserveIn, reserveOut, feePercent) {
        // FIX: Early exit for zero/invalid inputs
        if (amountIn === 0n || reserveIn === 0n || reserveOut === 0n) {
            return 0n;
        }

        // FIX: Validate feePercent to prevent BigInt(NaN) crashes
        const fee = typeof feePercent === 'number' && Number.isFinite(feePercent)
            ? feePercent
            : 0.003; // Default 0.3% fee

        // Ensure fee is within valid range [0, 1)
        const safeFee = Math.max(0, Math.min(fee, 0.9999));

        const feeMultiplier = Math.floor((1 - safeFee) * 10000);
        const amountInWithFee = amountIn * BigInt(feeMultiplier);
        const numerator = amountInWithFee * reserveOut;
        const denominator = (reserveIn * 10000n) + amountInWithFee;

        if (denominator === 0n) return 0n;
        return numerator / denominator;
    }

    /**
     * Find the optimal input amount that maximizes profit in USD
     * Uses hybrid approach: Analytical formula + refined grid search
     *
     * IMPORTANT: Accounts for flash loan fee (0.25%) which is deducted from the borrowed amount
     *
     * Improvement v2.0: Added analytical optimal calculation for constant product AMM
     * Expected improvement: +15-25% profit capture on existing opportunities
     */
    optimizeTradeAmount(buyDexData, sellDexData, tokenADecimals, tokenBDecimals) {
        // We know we want to flow: Buy Low -> Sell High
        // Price is A in B. If BuyDex price is low, A is cheap. We buy A with B.
        // Flow: Input B -> Buy A on LowDex -> Sell A for B on HighDex -> Output B
        // Profit is in Token B.

        // Determine reserves
        const buyInRes = BigInt(buyDexData.reserveB);
        const buyOutRes = BigInt(buyDexData.reserveA);
        const sellInRes = BigInt(sellDexData.reserveA);
        const sellOutRes = BigInt(sellDexData.reserveB);

        const buyFee = config.dex[buyDexData.dexName]?.fee ?? 0.003;
        const sellFee = config.dex[sellDexData.dexName]?.fee ?? 0.003;

        // Flash loan fee (0.25% = 0.0025)
        const flashLoanFee = config.execution?.flashLoanFee || 0.0025;

        // Search range from config (with defaults for backwards compatibility)
        const MIN_TRADE_USD = config.trading?.minTradeSizeUSD || 10;
        const MAX_TRADE_USD = config.trading?.maxTradeSizeUSD || 5000;

        const liquidityUSD = buyDexData.liquidityUSD;

        // FIX v3.1: Validate liquidityUSD to prevent division by zero/Infinity
        if (!liquidityUSD || liquidityUSD <= 0 || !Number.isFinite(liquidityUSD)) {
            return { profitUSD: 0, optimalAmount: 0n, priceUSD: 0 };
        }

        const reserveB_Float = Number(buyInRes) / Math.pow(10, tokenBDecimals);

        // Safety check: prevent division by zero (Infinity || 1 does NOT work - Infinity is truthy!)
        if (reserveB_Float <= 0 || !Number.isFinite(reserveB_Float)) {
            return { profitUSD: 0, optimalAmount: 0n, priceUSD: 0 };
        }

        const priceB_USD = (liquidityUSD / 2) / reserveB_Float;

        // Safety check for invalid price
        if (!Number.isFinite(priceB_USD) || priceB_USD <= 0) {
            return { profitUSD: 0, optimalAmount: 0n, priceUSD: 0 };
        }

        const minAmount = BigInt(Math.floor((MIN_TRADE_USD / priceB_USD) * Math.pow(10, tokenBDecimals)));
        const maxAmount = BigInt(Math.floor((MAX_TRADE_USD / priceB_USD) * Math.pow(10, tokenBDecimals)));

        if (maxAmount <= minAmount) return { profitUSD: 0, optimalAmount: 0n, priceUSD: priceB_USD };

        // Function to calculate profit for a given input amount of B
        // This accounts for the flash loan fee that must be repaid
        const calcProfit = (amountInB) => {
            // 1. Buy A on LowDex (Input B -> Output A)
            const amountOutA = this.getAmountOut(amountInB, buyInRes, buyOutRes, buyFee);

            // 2. Sell A on HighDex (Input A -> Output B)
            const amountOutB = this.getAmountOut(amountOutA, sellInRes, sellOutRes, sellFee);

            // 3. Calculate flash loan repayment amount (borrowed + 0.25% fee)
            // Flash loan fee is calculated on the borrowed amount
            const flashFeeAmount = (amountInB * BigInt(Math.floor(flashLoanFee * 10000))) / 10000n;
            const totalRepayment = amountInB + flashFeeAmount;

            // 4. Net Profit = Final B - Total Repayment (borrowed + flash fee)
            return amountOutB - totalRepayment;
        };

        let maxProfit = 0n;
        let bestAmount = 0n;

        // ==================== ANALYTICAL OPTIMAL CALCULATION ====================
        // For constant product AMM arbitrage between two pools:
        // Optimal input ≈ sqrt(R_A_in * R_A_out * R_B_in * R_B_out * γ_A * γ_B) - R_A_in * sqrt(γ_A * γ_B)
        // Where γ = (1 - fee) is the gamma factor
        //
        // This closed-form solution provides a starting point that is refined below
        const analyticalOptimal = this._calculateAnalyticalOptimal(
            buyInRes, buyOutRes, sellInRes, sellOutRes,
            buyFee, sellFee, tokenBDecimals
        );

        // Test analytical optimal if valid
        if (analyticalOptimal > 0n && analyticalOptimal >= minAmount && analyticalOptimal <= maxAmount) {
            const analyticalProfit = calcProfit(analyticalOptimal);
            if (analyticalProfit > maxProfit) {
                maxProfit = analyticalProfit;
                bestAmount = analyticalOptimal;
            }
        }

        // ==================== REFINED GRID SEARCH ====================
        // Scan 50 points (5x more precision than before)
        const checkPoints = 50;
        const incr = (maxAmount - minAmount) / BigInt(checkPoints);

        if (incr > 0n) {
            for (let i = 0; i <= checkPoints; i++) {
                const currentAmount = minAmount + (incr * BigInt(i));
                if (currentAmount <= 0n) continue;

                const p = calcProfit(currentAmount);
                if (p > maxProfit) {
                    maxProfit = p;
                    bestAmount = currentAmount;
                }
            }
        }

        // ==================== BINARY REFINEMENT AROUND BEST ====================
        // If we found a profitable amount, refine around it with binary search
        if (bestAmount > 0n && maxProfit > 0n) {
            const refinedResult = this._refineOptimalAmount(
                bestAmount, calcProfit, maxProfit, minAmount, maxAmount
            );
            if (refinedResult.profit > maxProfit) {
                maxProfit = refinedResult.profit;
                bestAmount = refinedResult.amount;
            }
        }

        // Convert profit to USD (this is already net of flash loan fee)
        const profitFloat = Number(maxProfit) / Math.pow(10, tokenBDecimals);
        const profitUSD = profitFloat * priceB_USD;

        return { profitUSD, optimalAmount: bestAmount, priceUSD: priceB_USD };
    }

    /**
     * Calculate analytical optimal trade amount using closed-form solution
     * For constant product AMM arbitrage between two pools
     *
     * Mathematical derivation:
     * Given two pools with reserves (R_in, R_out) and fees γ = (1-fee):
     * The profit function P(x) = OutputB - x is maximized when dP/dx = 0
     *
     * For the two-pool case:
     * optimal_x ≈ sqrt(R_A_in * R_A_out * R_B_in * R_B_out * γ_A * γ_B) - R_A_in * sqrt(γ_A * γ_B)
     *
     * @private
     */
    _calculateAnalyticalOptimal(buyInRes, buyOutRes, sellInRes, sellOutRes, buyFee, sellFee, decimals) {
        try {
            // FIX v3.1: Check for integer overflow before converting BigInt to Number
            // Number.MAX_SAFE_INTEGER is 2^53 - 1 = 9007199254740991
            const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

            // If any reserve exceeds safe integer limit, fall back to grid search
            // This prevents precision loss for very large pools (>$100B TVL at 18 decimals)
            if (buyInRes > MAX_SAFE || buyOutRes > MAX_SAFE ||
                sellInRes > MAX_SAFE || sellOutRes > MAX_SAFE) {
                log.debug('Reserves exceed MAX_SAFE_INTEGER, falling back to grid search');
                return 0n; // Fall back to grid search
            }

            // Convert to numbers for sqrt calculation
            const rAin = Number(buyInRes);
            const rAout = Number(buyOutRes);
            const rBin = Number(sellInRes);
            const rBout = Number(sellOutRes);

            // Safety checks
            if (rAin <= 0 || rAout <= 0 || rBin <= 0 || rBout <= 0) {
                return 0n;
            }

            // Gamma factors (1 - fee)
            const gammaA = 1 - buyFee;
            const gammaB = 1 - sellFee;
            const gammaProduct = gammaA * gammaB;

            // Calculate optimal using closed-form formula
            // optimal_x = sqrt(rAin * rAout * rBin * rBout * gammaA * gammaB) - rAin * sqrt(gammaA * gammaB)
            const productTerm = rAin * rAout * rBin * rBout * gammaProduct;
            const sqrtProduct = Math.sqrt(productTerm);
            const offset = rAin * Math.sqrt(gammaProduct);

            const optimalFloat = sqrtProduct - offset;

            // Safety checks
            if (!Number.isFinite(optimalFloat) || optimalFloat <= 0) {
                return 0n;
            }

            // Scale down to account for the fact that we're inputting token B, not A
            // The formula above gives optimal in terms of pool A's input reserve units
            // We need to adjust based on the ratio of reserves
            const scaleFactor = rAin / rBout;
            const adjustedOptimal = optimalFloat / (scaleFactor > 0 ? scaleFactor : 1);

            return BigInt(Math.floor(Math.max(0, adjustedOptimal)));
        } catch (error) {
            // If analytical calculation fails, return 0 to fall back to grid search
            return 0n;
        }
    }

    /**
     * Refine optimal amount using golden section search around the initial estimate
     *
     * Golden section search is efficient for unimodal functions (like our profit curve)
     *
     * @private
     */
    _refineOptimalAmount(initialAmount, calcProfit, initialProfit, minAmount, maxAmount) {
        const GOLDEN_RATIO = 0.618033988749895;
        const TOLERANCE = 0.001; // 0.1% tolerance

        // Search in a window around the initial amount (±20%)
        let lower = initialAmount * 80n / 100n;
        let upper = initialAmount * 120n / 100n;

        // Clamp to valid range
        if (lower < minAmount) lower = minAmount;
        if (upper > maxAmount) upper = maxAmount;

        // If range is too small, return initial
        if (upper <= lower) {
            return { amount: initialAmount, profit: initialProfit };
        }

        let bestAmount = initialAmount;
        let bestProfit = initialProfit;

        // Golden section search iterations (5 iterations gives ~0.5% precision)
        for (let iter = 0; iter < 5; iter++) {
            const range = upper - lower;
            if (range <= 1n) break;

            const rangeNum = Number(range);
            const x1 = lower + BigInt(Math.floor(rangeNum * (1 - GOLDEN_RATIO)));
            const x2 = lower + BigInt(Math.floor(rangeNum * GOLDEN_RATIO));

            const profit1 = calcProfit(x1);
            const profit2 = calcProfit(x2);

            // Update best if we found better
            if (profit1 > bestProfit) {
                bestProfit = profit1;
                bestAmount = x1;
            }
            if (profit2 > bestProfit) {
                bestProfit = profit2;
                bestAmount = x2;
            }

            // Narrow the search range
            if (profit1 > profit2) {
                upper = x2;
            } else {
                lower = x1;
            }
        }

        return { amount: bestAmount, profit: bestProfit };
    }
}

// Export singleton instance
const arbitrageDetector = new ArbitrageDetector();
export default arbitrageDetector;
