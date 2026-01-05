import { ethers, parseUnits, formatUnits } from 'ethers';
import rpcManager from '../utils/rpcManager.js';
import config from '../config.js';
import log from '../utils/logger.js';

/**
 * Arbitrage Detector - Identifies profitable arbitrage opportunities across DEXs
 */
class ArbitrageDetector {
    constructor() {
        this.minProfitPercentage = config.trading.minProfitPercentage;
        this.gasPriceGwei = config.trading.gasPriceGwei;
        this.estimatedGasLimit = config.trading.estimatedGasLimit;

        log.info('Arbitrage Detector initialized', {
            minProfit: `${this.minProfitPercentage}%`,
            gasPrice: `${this.gasPriceGwei} Gwei`,
        });
    }

    /**
     * Detect arbitrage opportunities from price data
     */
    async detectOpportunities(prices, blockNumber) {
        const startTime = Date.now();
        const opportunities = [];

        // Fetch dynamic gas price if enabled
        let gasPrice = BigInt(parseUnits(config.trading.gasPriceGwei.toString(), 'gwei'));
        if (config.dynamicGas) {
            try {
                gasPrice = await rpcManager.getGasPrice();
                log.debug(`Using dynamic gas price: ${formatUnits(gasPrice, 'gwei')} Gwei`);
            } catch (err) {
                log.warn('Fallback to static gas price');
            }
        }

        const pairs = Object.entries(prices);
        if (config.debugMode) {
            log.info(`🔍 Scanning ${pairs.length} pairs for arbitrage at block ${blockNumber}...`);
        }

        for (const [pairKey, dexPrices] of pairs) {
            const opp = this.checkOpportunity(pairKey, dexPrices, gasPrice);
            if (opp) opportunities.push(opp);
        }

        if (opportunities.length > 0) {
            log.info(`Found ${opportunities.length} potential opportunities in ${Date.now() - startTime}ms`);
        } else if (config.debugMode) {
            log.debug(`No opportunities found in ${pairs.length} pairs (${Date.now() - startTime}ms)`);
        }

        return opportunities;
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

        // 3. Factor in Gas
        const gasCostUSD = this.estimateGasCost(gasPrice) * 600; // Updated heuristic BNB price ($600)
        const netProfitUSD = profitUSD - gasCostUSD;

        const tradeSizeUSD = (Number(optimalAmount) / Math.pow(10, tokenBDecimals)) * priceUSD;
        const roiPercent = tradeSizeUSD > 0 ? (netProfitUSD / tradeSizeUSD) * 100 : 0;

        if (netProfitUSD <= 1.0) return null; // Min $1 profit after gas

        log.info(`API: Opportunity ${pairKey}: Profit $${netProfitUSD.toFixed(2)} (${roiPercent.toFixed(2)}%) | Size: $${tradeSizeUSD.toFixed(2)}`);

        return {
            pairKey, tokenA, tokenB,
            buyDex, sellDex,
            buyPrice: spread.buyPrice,
            sellPrice: spread.sellPrice,
            profitUSD: netProfitUSD,
            optimalTradeSizeUSD: tradeSizeUSD,
            netProfitPercentage: roiPercent,
            gasCostUSD,
            timestamp: Date.now()
        };
    }

    /**
     * Quick check if a pair is worth deep analysis
     * @private
     */
    _isViable(pairKey, buyDexData, sellDexData) {
        const minLiquidity = Math.min(buyDexData.liquidityUSD || 0, sellDexData.liquidityUSD || 0);
        if (minLiquidity < 1000) return false;

        const buyFee = config.dex[buyDexData.dexName].fee;
        const sellFee = config.dex[sellDexData.sellName]?.fee || config.dex[sellDexData.dexName].fee;
        const totalFee = (buyFee + sellFee) * 100;

        // Simple spread check before expensive optimization
        const spreadPercent = ((sellDexData.price - buyDexData.price) / buyDexData.price) * 100;
        return (spreadPercent - totalFee) >= this.minProfitPercentage;
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
     * Estimate gas cost in BNB
     */
    estimateGasCost(gasPrice = null) {
        const price = gasPrice || BigInt(parseUnits(this.gasPriceGwei.toString(), 'gwei'));
        // Gas cost in BNB
        const gasCostBNB = (BigInt(this.estimatedGasLimit) * price);
        return Number(gasCostBNB) / 1e18;
    }

    /**
     * Calculate exact output amount using Uniswap V2 formula
     */
    getAmountOut(amountIn, reserveIn, reserveOut, feePercent) {
        const amountInWithFee = amountIn * BigInt(Math.floor((1 - feePercent) * 10000));
        const numerator = amountInWithFee * reserveOut;
        const denominator = (reserveIn * 10000n) + amountInWithFee;

        if (denominator === 0n) return 0n;
        return numerator / denominator;
    }

    /**
     * Find the optimal input amount that maximizes profit in USD
     * Uses Binary Search approach
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

        const buyFee = config.dex[buyDexData.dexName].fee;
        const sellFee = config.dex[sellDexData.dexName].fee;

        // Search range: 1 USD worth of B to 50% of pool (safety) or $5k
        const liquidityUSD = buyDexData.liquidityUSD;
        const reserveB_Float = Number(buyInRes) / Math.pow(10, tokenBDecimals);
        const priceB_USD = (liquidityUSD / 2) / reserveB_Float || 1; // Approx price

        const MAX_TRADE_USD = 5000; // Cap at $5k for safety

        // Safety check for very small pools
        if (priceB_USD === 0) return { profitUSD: 0, optimalAmount: 0n, priceUSD: 0 };

        const minAmount = BigInt(Math.floor((10 / priceB_USD) * Math.pow(10, tokenBDecimals))); // $10 min
        const maxAmount = BigInt(Math.floor((MAX_TRADE_USD / priceB_USD) * Math.pow(10, tokenBDecimals)));

        if (maxAmount <= minAmount) return { profitUSD: 0, optimalAmount: 0n, priceUSD: priceB_USD };

        // Function to calculate profit for a given input amount of B
        const calcProfit = (amountInB) => {
            // 1. Buy A on LowDex (Input B -> Output A)
            const amountOutA = this.getAmountOut(amountInB, buyInRes, buyOutRes, buyFee);

            // 2. Sell A on HighDex (Input A -> Output B)
            const amountOutB = this.getAmountOut(amountOutA, sellInRes, sellOutRes, sellFee);

            // 3. Profit = Final B - Initial B
            return amountOutB - amountInB;
        };

        let maxProfit = 0n;
        let bestAmount = 0n;

        // Scan 10 points
        const checkPoints = 10;
        const incr = (maxAmount - minAmount) / BigInt(checkPoints);

        if (incr <= 0n) return { profitUSD: 0, optimalAmount: 0n, priceUSD: priceB_USD };

        for (let i = 0; i <= checkPoints; i++) {
            const currentAmount = minAmount + (incr * BigInt(i));
            if (currentAmount <= 0n) continue;

            const p = calcProfit(currentAmount);
            if (p > maxProfit) {
                maxProfit = p;
                bestAmount = currentAmount;
            } else if (p < maxProfit && maxProfit > 0n) {
                // Profit curve is convex/concave, if it drops we past the peak
                break;
            }
        }

        // Convert profit to USD
        const profitFloat = Number(maxProfit) / Math.pow(10, tokenBDecimals);
        const profitUSD = profitFloat * priceB_USD;

        return { profitUSD, optimalAmount: bestAmount, priceUSD: priceB_USD };
    }
}

// Export singleton instance
const arbitrageDetector = new ArbitrageDetector();
export default arbitrageDetector;
