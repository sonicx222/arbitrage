import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import log from '../utils/logger.js';
import {
    CURVE_POOL_ABI,
    CURVE_POOL_ADDRESSES,
    CURVE_FEE,
} from '../contracts/abis.js';

/**
 * Curve Arbitrage Detector
 *
 * Detects arbitrage opportunities between Curve StableSwap pools and other DEXes.
 *
 * Curve's StableSwap algorithm provides:
 * - Very low slippage for stable-to-stable swaps
 * - Lower fees than Uniswap V2/V3 (0.04% vs 0.3%)
 * - Efficient swaps even for large amounts
 *
 * Arbitrage opportunities arise when:
 * 1. Curve price differs from Uniswap/SushiSwap price
 * 2. DEX prices lag after large Curve trades
 * 3. Imbalanced Curve pools create price deviations
 *
 * Expected Impact: $0.50-5 per trade, 10+ opportunities per day
 */
class CurveArbitrage extends EventEmitter {
    constructor(config = {}) {
        super();

        // Chain configuration
        this.chainId = config.chainId || 1;
        this.provider = config.provider || null;

        // Pool configurations by chain
        this.poolConfigs = this._getPoolConfigs();

        // Arbitrage thresholds
        this.minProfitPercent = config.minProfitPercent || 0.1; // 0.1% minimum profit
        this.minProfitUSD = config.minProfitUSD || 1; // $1 minimum profit
        this.maxTradeSize = config.maxTradeSize || 100000; // $100k max trade

        // Price cache for Curve pools
        this.priceCache = new Map(); // poolName -> { price, timestamp, balances }
        this.cacheMaxAge = config.cacheMaxAge || 5000; // 5 seconds

        // Contract instances (lazy initialization)
        this.contracts = new Map();

        // Statistics
        this.stats = {
            opportunitiesDetected: 0,
            poolsMonitored: 0,
            priceQueries: 0,
            lastOpportunityTime: null,
            totalEstimatedProfit: 0,
        };

        // Pool metadata cache
        this.poolMetadata = new Map(); // poolName -> { coins, decimals, fee, A }

        log.info('CurveArbitrage initialized', {
            chainId: this.chainId,
            minProfitPercent: `${this.minProfitPercent}%`,
            pools: Object.keys(this.poolConfigs[this.chainId] || {}).length,
        });
    }

    /**
     * Initialize the module with a provider
     * @param {Object} provider - ethers provider
     * @param {number} chainId - Chain ID
     */
    async initialize(provider, chainId = null) {
        if (provider) {
            this.provider = provider;
        }
        if (chainId) {
            this.chainId = chainId;
        }

        // Pre-load pool metadata
        await this._loadPoolMetadata();

        this.stats.poolsMonitored = Object.keys(this.poolConfigs[this.chainId] || {}).length;

        log.info('CurveArbitrage ready', {
            chainId: this.chainId,
            poolsMonitored: this.stats.poolsMonitored,
        });
    }

    /**
     * Analyze prices for Curve vs DEX arbitrage
     *
     * @param {Object} dexPrices - Price data from other DEXes { pairKey: { dex: { price, ... } } }
     * @param {number} blockNumber - Current block number
     * @returns {Array} Array of arbitrage opportunities
     */
    async analyzeOpportunities(dexPrices, blockNumber) {
        const opportunities = [];
        const pools = this.poolConfigs[this.chainId];

        if (!pools || !this.provider) {
            return opportunities;
        }

        for (const [poolName, poolAddress] of Object.entries(pools)) {
            try {
                const poolOpportunities = await this._analyzePool(
                    poolName,
                    poolAddress,
                    dexPrices,
                    blockNumber
                );
                opportunities.push(...poolOpportunities);
            } catch (error) {
                log.debug(`Error analyzing Curve pool ${poolName}`, {
                    error: error.message,
                });
            }
        }

        // Sort by estimated profit
        opportunities.sort((a, b) => b.estimatedProfitUSD - a.estimatedProfitUSD);

        if (opportunities.length > 0) {
            this.stats.opportunitiesDetected += opportunities.length;
            this.stats.lastOpportunityTime = Date.now();
            this.stats.totalEstimatedProfit += opportunities.reduce(
                (sum, opp) => sum + opp.estimatedProfitUSD,
                0
            );

            this.emit('opportunity', opportunities[0]);
        }

        return opportunities;
    }

    /**
     * Analyze a specific Curve pool for arbitrage
     * @private
     */
    async _analyzePool(poolName, poolAddress, dexPrices, blockNumber) {
        const opportunities = [];
        const metadata = this.poolMetadata.get(poolName);

        if (!metadata || metadata.coins.length < 2) {
            return opportunities;
        }

        // Get Curve prices for each token pair in the pool
        for (let i = 0; i < metadata.coins.length; i++) {
            for (let j = i + 1; j < metadata.coins.length; j++) {
                const tokenA = metadata.coinSymbols[i];
                const tokenB = metadata.coinSymbols[j];

                // Skip if we don't have DEX prices for this pair
                const pairKey = `${tokenA}/${tokenB}`;
                const reversePairKey = `${tokenB}/${tokenA}`;
                const dexPairData = dexPrices[pairKey] || dexPrices[reversePairKey];

                if (!dexPairData) continue;

                // Get Curve output for a standard amount
                const standardAmount = this._getStandardAmount(tokenA, metadata.decimals[i]);
                const curveOutput = await this._getCurveOutput(
                    poolName,
                    poolAddress,
                    i,
                    j,
                    standardAmount
                );

                if (!curveOutput) continue;

                // Calculate Curve price
                const curvePrice = this._calculatePrice(
                    standardAmount,
                    curveOutput,
                    metadata.decimals[i],
                    metadata.decimals[j]
                );

                // Compare with each DEX
                for (const [dexName, dexData] of Object.entries(dexPairData)) {
                    if (!dexData.price || dexData.price <= 0) continue;

                    let dexPrice = dexData.price;
                    // Normalize if reverse pair
                    if (dexPrices[reversePairKey] && !dexPrices[pairKey]) {
                        dexPrice = 1 / dexPrice;
                    }

                    // Calculate spread
                    const spread = Math.abs(curvePrice - dexPrice) / Math.min(curvePrice, dexPrice);
                    const curveFee = CURVE_FEE;
                    const dexFee = dexData.fee || 0.003;
                    const totalFees = curveFee + dexFee;
                    const netSpread = spread - totalFees;

                    if (netSpread >= this.minProfitPercent / 100) {
                        // Determine trade direction
                        const buyOnCurve = curvePrice < dexPrice;
                        const [buyVenue, sellVenue] = buyOnCurve
                            ? ['curve', dexName]
                            : [dexName, 'curve'];

                        // Calculate optimal trade size
                        const minLiquidity = Math.min(
                            dexData.liquidityUSD || this.maxTradeSize,
                            await this._getPoolLiquidity(poolName, poolAddress, i)
                        );
                        const optimalSize = Math.min(
                            Math.max(minLiquidity * 0.02, 1000), // 2% of liquidity or $1000
                            this.maxTradeSize
                        );

                        const estimatedProfitUSD = optimalSize * netSpread;

                        if (estimatedProfitUSD >= this.minProfitUSD) {
                            opportunities.push({
                                type: 'curve-dex',
                                poolName,
                                poolAddress,
                                pairKey: `${tokenA}/${tokenB}`,
                                tokenA,
                                tokenB,
                                tokenIndexA: i,
                                tokenIndexB: j,
                                curvePrice,
                                dexPrice,
                                dexName,
                                buyVenue,
                                sellVenue,
                                spreadPercent: parseFloat((spread * 100).toFixed(4)),
                                netSpreadPercent: parseFloat((netSpread * 100).toFixed(4)),
                                curveFee: curveFee * 100,
                                dexFee: dexFee * 100,
                                optimalSizeUSD: parseFloat(optimalSize.toFixed(2)),
                                estimatedProfitUSD: parseFloat(estimatedProfitUSD.toFixed(2)),
                                minLiquidityUSD: minLiquidity,
                                blockNumber,
                                timestamp: Date.now(),
                                chainId: this.chainId,
                            });
                        }
                    }
                }
            }
        }

        return opportunities;
    }

    /**
     * Get Curve swap output using get_dy
     * @private
     */
    async _getCurveOutput(poolName, poolAddress, i, j, amountIn) {
        try {
            const contract = this._getPoolContract(poolName, poolAddress);
            if (!contract) return null;

            this.stats.priceQueries++;

            // Use get_dy to get expected output
            const output = await contract.get_dy(i, j, amountIn);
            return output;
        } catch (error) {
            log.debug(`Failed to get Curve output for ${poolName}`, {
                error: error.message,
                i,
                j,
            });
            return null;
        }
    }

    /**
     * Calculate price from input/output amounts
     * @private
     */
    _calculatePrice(amountIn, amountOut, decimalsIn, decimalsOut) {
        const normalizedIn = Number(amountIn) / Math.pow(10, decimalsIn);
        const normalizedOut = Number(amountOut) / Math.pow(10, decimalsOut);
        return normalizedOut / normalizedIn;
    }

    /**
     * Get standard amount for price queries (e.g., 1000 USDC)
     * @private
     */
    _getStandardAmount(tokenSymbol, decimals) {
        // Use smaller amounts for stables, larger for ETH/BTC
        const isStable = ['USDC', 'USDT', 'DAI', 'FRAX', 'LUSD', 'BUSD'].includes(tokenSymbol);
        const baseAmount = isStable ? 1000 : 1; // 1000 stables or 1 ETH/BTC
        return ethers.parseUnits(baseAmount.toString(), decimals);
    }

    /**
     * Get pool liquidity estimate
     * @private
     */
    async _getPoolLiquidity(poolName, poolAddress, tokenIndex) {
        try {
            const contract = this._getPoolContract(poolName, poolAddress);
            if (!contract) return this.maxTradeSize;

            const balance = await contract.balances(tokenIndex);
            const metadata = this.poolMetadata.get(poolName);

            if (!metadata) return this.maxTradeSize;

            const normalizedBalance = Number(balance) / Math.pow(10, metadata.decimals[tokenIndex]);

            // Estimate USD value (assume stables are $1, ETH ~$3500)
            const symbol = metadata.coinSymbols[tokenIndex];
            const priceUSD = this._getTokenPriceUSD(symbol);

            return normalizedBalance * priceUSD;
        } catch (error) {
            return this.maxTradeSize;
        }
    }

    /**
     * Get token price in USD (fallback values)
     * @private
     */
    _getTokenPriceUSD(symbol) {
        const prices = {
            'USDC': 1,
            'USDT': 1,
            'DAI': 1,
            'FRAX': 1,
            'LUSD': 1,
            'BUSD': 1,
            'WETH': 3500,
            'ETH': 3500,
            'stETH': 3500,
            'wstETH': 4000,
            'rETH': 3800,
            'cbETH': 3700,
            'WBTC': 95000,
        };
        return prices[symbol] || 1;
    }

    /**
     * Get or create pool contract instance
     * @private
     */
    _getPoolContract(poolName, poolAddress) {
        if (!this.provider) return null;

        const cacheKey = `${poolName}_${this.chainId}`;
        if (this.contracts.has(cacheKey)) {
            return this.contracts.get(cacheKey);
        }

        try {
            const contract = new ethers.Contract(poolAddress, CURVE_POOL_ABI, this.provider);
            this.contracts.set(cacheKey, contract);
            return contract;
        } catch (error) {
            log.error(`Failed to create Curve contract for ${poolName}`, {
                error: error.message,
            });
            return null;
        }
    }

    /**
     * Load pool metadata (coins, decimals, fee, A)
     * @private
     */
    async _loadPoolMetadata() {
        const pools = this.poolConfigs[this.chainId];
        if (!pools || !this.provider) return;

        for (const [poolName, poolAddress] of Object.entries(pools)) {
            try {
                const contract = this._getPoolContract(poolName, poolAddress);
                if (!contract) continue;

                // Get number of coins (try common values)
                let numCoins = 2;
                try {
                    numCoins = await contract.N_COINS();
                } catch {
                    // Default to 2 for most pools, 3 for 3pool
                    numCoins = poolName.includes('3pool') || poolName.includes('3') ? 3 : 2;
                }

                // Get coin addresses
                const coins = [];
                const decimals = [];
                const coinSymbols = [];

                for (let i = 0; i < Number(numCoins); i++) {
                    try {
                        const coinAddress = await contract.coins(i);
                        coins.push(coinAddress);

                        // Get decimals from coin contract
                        const coinContract = new ethers.Contract(
                            coinAddress,
                            ['function decimals() view returns (uint8)', 'function symbol() view returns (string)'],
                            this.provider
                        );

                        const [decimal, symbol] = await Promise.all([
                            coinContract.decimals(),
                            coinContract.symbol(),
                        ]);

                        decimals.push(Number(decimal));
                        coinSymbols.push(symbol);
                    } catch (error) {
                        // Default decimals for common tokens
                        decimals.push(18);
                        coinSymbols.push(`TOKEN${i}`);
                    }
                }

                // Get pool fee
                let fee = CURVE_FEE;
                try {
                    const feeRaw = await contract.fee();
                    fee = Number(feeRaw) / 1e10; // Curve fees are in 1e10
                } catch {
                    // Use default
                }

                // Get amplification coefficient
                let A = 100;
                try {
                    A = Number(await contract.A());
                } catch {
                    // Use default
                }

                this.poolMetadata.set(poolName, {
                    address: poolAddress,
                    coins,
                    decimals,
                    coinSymbols,
                    fee,
                    A,
                    numCoins: Number(numCoins),
                });

                log.debug(`Loaded Curve pool metadata: ${poolName}`, {
                    coins: coinSymbols,
                    fee: `${fee * 100}%`,
                    A,
                });
            } catch (error) {
                log.warn(`Failed to load metadata for Curve pool ${poolName}`, {
                    error: error.message,
                });
            }
        }
    }

    /**
     * Get pool configurations by chain
     * @private
     */
    _getPoolConfigs() {
        return CURVE_POOL_ADDRESSES;
    }

    /**
     * Manually refresh price cache for a pool
     */
    async refreshPoolPrices(poolName) {
        const pools = this.poolConfigs[this.chainId];
        if (!pools || !pools[poolName]) {
            return null;
        }

        const metadata = this.poolMetadata.get(poolName);
        if (!metadata) {
            return null;
        }

        const prices = {};
        const poolAddress = pools[poolName];

        for (let i = 0; i < metadata.numCoins; i++) {
            for (let j = i + 1; j < metadata.numCoins; j++) {
                const standardAmount = this._getStandardAmount(
                    metadata.coinSymbols[i],
                    metadata.decimals[i]
                );

                const output = await this._getCurveOutput(poolName, poolAddress, i, j, standardAmount);
                if (output) {
                    const price = this._calculatePrice(
                        standardAmount,
                        output,
                        metadata.decimals[i],
                        metadata.decimals[j]
                    );
                    prices[`${metadata.coinSymbols[i]}/${metadata.coinSymbols[j]}`] = price;
                }
            }
        }

        this.priceCache.set(poolName, {
            prices,
            timestamp: Date.now(),
        });

        return prices;
    }

    /**
     * Get current Curve price for a token pair
     */
    async getCurvePrice(tokenA, tokenB, poolName = null) {
        const pools = this.poolConfigs[this.chainId];
        if (!pools) return null;

        // Find pool containing both tokens
        for (const [name, address] of Object.entries(pools)) {
            if (poolName && name !== poolName) continue;

            const metadata = this.poolMetadata.get(name);
            if (!metadata) continue;

            const indexA = metadata.coinSymbols.indexOf(tokenA);
            const indexB = metadata.coinSymbols.indexOf(tokenB);

            if (indexA >= 0 && indexB >= 0) {
                const standardAmount = this._getStandardAmount(tokenA, metadata.decimals[indexA]);
                const output = await this._getCurveOutput(name, address, indexA, indexB, standardAmount);

                if (output) {
                    return this._calculatePrice(
                        standardAmount,
                        output,
                        metadata.decimals[indexA],
                        metadata.decimals[indexB]
                    );
                }
            }
        }

        return null;
    }

    /**
     * Get pool information
     */
    getPoolInfo(poolName) {
        return this.poolMetadata.get(poolName) || null;
    }

    /**
     * Get all available pools for current chain
     */
    getAvailablePools() {
        return Object.keys(this.poolConfigs[this.chainId] || {});
    }

    /**
     * Get statistics
     */
    getStats() {
        return {
            ...this.stats,
            chainId: this.chainId,
            poolsConfigured: Object.keys(this.poolConfigs[this.chainId] || {}).length,
            poolMetadataLoaded: this.poolMetadata.size,
            cacheSize: this.priceCache.size,
        };
    }

    /**
     * Reset statistics
     */
    resetStats() {
        this.stats = {
            opportunitiesDetected: 0,
            poolsMonitored: this.stats.poolsMonitored,
            priceQueries: 0,
            lastOpportunityTime: null,
            totalEstimatedProfit: 0,
        };
    }

    /**
     * Clear caches
     */
    clearCache() {
        this.priceCache.clear();
    }
}

// Export singleton instance
const curveArbitrage = new CurveArbitrage();
export default curveArbitrage;
export { CurveArbitrage };
