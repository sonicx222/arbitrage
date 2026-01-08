import log from '../utils/logger.js';

/**
 * Dynamic Slippage Manager
 *
 * Calculates optimal slippage tolerance based on:
 * - Token type (stablecoin, native, blue-chip, volatile, meme)
 * - Pool liquidity depth
 * - Trade size relative to reserves
 *
 * This allows tighter slippage on stable pairs (capturing more opportunities)
 * and wider slippage on volatile pairs (avoiding failed trades).
 */
class SlippageManager {
    constructor() {
        // Token type classifications - determines base slippage
        this.tokenTypes = {
            // Stablecoins - very tight slippage (0.1%)
            stablecoin: new Set([
                'USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'FDUSD', 'FRAX', 'MIM',
                'USDC.e', 'USDbC', 'USDT.e', 'axlUSDC', 'EURS', 'AGEUR', 'EURC',
                'USDplus', 'miMATIC', 'sUSD', 'LUSD', 'crvUSD', 'GHO', 'USDP',
            ]),

            // Native/wrapped tokens - tight slippage (0.3%)
            native: new Set([
                'WBNB', 'BNB', 'WETH', 'ETH', 'WMATIC', 'MATIC', 'WAVAX', 'AVAX',
                'WETH.e', 'cbETH', 'wstETH', 'rETH', 'stETH', 'sAVAX', 'stMATIC',
                'MaticX',
            ]),

            // Blue-chip tokens - moderate slippage (0.5%)
            blueChip: new Set([
                'BTCB', 'WBTC', 'WBTC.e', 'BTC.b', 'tBTC',
                'LINK', 'UNI', 'AAVE', 'MKR', 'SNX', 'COMP', 'CRV', 'LDO',
                'ARB', 'OP', 'GMX', 'PENDLE', 'RPL', 'ENS', 'GNO',
                'SUSHI', 'BAL', 'CAKE', 'JOE', 'PNG',
            ]),

            // Volatile tokens - wider slippage (1.0%)
            volatile: new Set([
                'RDNT', 'GRAIL', 'JONES', 'DPX', 'MAGIC', 'STG', 'FXS',
                'APE', 'SAND', 'MANA', 'GHST', 'QUICK', 'VELA', 'GNS',
                'QI', 'SPELL', 'YAK', 'XAVA', 'LODE', 'WINR', 'PREMIA',
                'ICE', 'SPHERE', 'TETU', 'ORBS', 'BIFI', 'KLIMA', 'VOXEL',
                'AERO', 'BSWAP', 'WELL', 'SNX', 'EXTRA', 'SEAM', 'OVN',
            ]),

            // Meme/high-volatility tokens - widest slippage (1.5-2.0%)
            meme: new Set([
                'SHIB', 'PEPE', 'DOGE', 'FLOKI', 'BABYDOGE',
                'TOSHI', 'DEGEN', 'BRETT', 'BALD', 'MOCHI', 'COIN',
                'NORMIE', 'DOGINME', 'HIGHER', 'VIRTUAL', 'PRIME',
                'TIME', 'BASED',
            ]),
        };

        // Base slippage rates by token type (as decimal)
        this.baseSlippageRates = {
            stablecoin: 0.001,   // 0.1%
            native: 0.003,       // 0.3%
            blueChip: 0.005,     // 0.5%
            volatile: 0.010,     // 1.0%
            meme: 0.015,         // 1.5%
            unknown: 0.010,      // 1.0% default
        };

        // Liquidity-based multipliers (trade size / pool liquidity)
        this.liquidityMultipliers = {
            // Trade is <1% of pool liquidity - no adjustment
            minimal: { threshold: 0.01, multiplier: 1.0 },
            // Trade is 1-5% of pool - slight increase
            low: { threshold: 0.05, multiplier: 1.2 },
            // Trade is 5-10% of pool - moderate increase
            medium: { threshold: 0.10, multiplier: 1.5 },
            // Trade is 10-20% of pool - significant increase
            high: { threshold: 0.20, multiplier: 2.0 },
            // Trade is >20% of pool - high slippage risk
            extreme: { threshold: 1.0, multiplier: 3.0 },
        };

        // Minimum and maximum slippage bounds
        this.minSlippage = 0.0005;  // 0.05% minimum
        this.maxSlippage = 0.03;    // 3.0% maximum

        // FIX v3.3: Changed to debug - logs for each worker in multi-chain mode
        log.debug('Slippage Manager initialized', {
            tokenTypes: Object.keys(this.tokenTypes).length,
            stablecoins: this.tokenTypes.stablecoin.size,
            baseRates: this.baseSlippageRates,
        });
    }

    /**
     * Get the token type classification
     *
     * @param {string} tokenSymbol - Token symbol
     * @returns {string} Token type: 'stablecoin', 'native', 'blueChip', 'volatile', 'meme', 'unknown'
     */
    getTokenType(tokenSymbol) {
        for (const [type, tokens] of Object.entries(this.tokenTypes)) {
            if (tokens.has(tokenSymbol)) {
                return type;
            }
        }
        return 'unknown';
    }

    /**
     * Calculate dynamic slippage for a single token
     *
     * @param {string} tokenSymbol - Token symbol
     * @returns {number} Slippage tolerance as decimal (e.g., 0.005 = 0.5%)
     */
    getTokenSlippage(tokenSymbol) {
        const tokenType = this.getTokenType(tokenSymbol);
        return this.baseSlippageRates[tokenType];
    }

    /**
     * Calculate dynamic slippage for a trading pair
     *
     * Uses the higher slippage of the two tokens in the pair,
     * since the more volatile token dictates the risk.
     *
     * @param {string} tokenA - First token symbol
     * @param {string} tokenB - Second token symbol
     * @returns {number} Slippage tolerance as decimal
     */
    getPairSlippage(tokenA, tokenB) {
        const slippageA = this.getTokenSlippage(tokenA);
        const slippageB = this.getTokenSlippage(tokenB);
        return Math.max(slippageA, slippageB);
    }

    /**
     * Calculate dynamic slippage with liquidity adjustment
     *
     * @param {string} tokenA - First token symbol
     * @param {string} tokenB - Second token symbol
     * @param {number} tradeSizeUSD - Trade size in USD
     * @param {number} poolLiquidityUSD - Pool liquidity in USD
     * @returns {Object} Slippage info with breakdown
     */
    calculateSlippage(tokenA, tokenB, tradeSizeUSD, poolLiquidityUSD) {
        // Get base slippage for the pair
        const baseSlippage = this.getPairSlippage(tokenA, tokenB);

        // Calculate trade impact ratio
        const impactRatio = poolLiquidityUSD > 0 ? tradeSizeUSD / poolLiquidityUSD : 0.5;

        // Determine liquidity multiplier
        let liquidityMultiplier = this.liquidityMultipliers.minimal.multiplier;
        let liquidityTier = 'minimal';

        for (const [tier, { threshold, multiplier }] of Object.entries(this.liquidityMultipliers)) {
            if (impactRatio <= threshold) {
                liquidityMultiplier = multiplier;
                liquidityTier = tier;
                break;
            }
        }

        // Calculate final slippage
        const adjustedSlippage = baseSlippage * liquidityMultiplier;
        const finalSlippage = Math.min(
            Math.max(adjustedSlippage, this.minSlippage),
            this.maxSlippage
        );

        return {
            slippage: finalSlippage,
            slippagePercent: finalSlippage * 100,
            baseSlippage,
            liquidityMultiplier,
            liquidityTier,
            impactRatio,
            tokenAType: this.getTokenType(tokenA),
            tokenBType: this.getTokenType(tokenB),
        };
    }

    /**
     * Calculate slippage for a multi-hop path (triangular arbitrage)
     *
     * For multi-hop, we use the highest slippage of any pair in the path,
     * with a small compound adjustment for each additional hop.
     *
     * @param {Array<string>} path - Array of token symbols in the path
     * @param {Array<number>} liquidities - Array of pool liquidities for each hop (optional)
     * @param {number} tradeSizeUSD - Trade size in USD
     * @returns {Object} Slippage info for the path
     */
    calculatePathSlippage(path, liquidities = [], tradeSizeUSD = 0) {
        if (path.length < 2) {
            return {
                slippage: this.baseSlippageRates.unknown,
                slippagePercent: this.baseSlippageRates.unknown * 100,
                hops: 0,
            };
        }

        let maxSlippage = 0;
        let maxSlippageHop = null;
        const hopSlippages = [];

        // Calculate slippage for each hop
        for (let i = 0; i < path.length - 1; i++) {
            const tokenA = path[i];
            const tokenB = path[i + 1];
            const liquidity = liquidities[i] || 50000; // Default to $50k if unknown

            const hopResult = this.calculateSlippage(tokenA, tokenB, tradeSizeUSD, liquidity);
            hopSlippages.push({
                pair: `${tokenA}/${tokenB}`,
                ...hopResult,
            });

            if (hopResult.slippage > maxSlippage) {
                maxSlippage = hopResult.slippage;
                maxSlippageHop = i;
            }
        }

        // Compound adjustment: each additional hop adds 10% to the max slippage
        // This accounts for cumulative execution risk
        const hops = path.length - 1;
        const compoundMultiplier = 1 + (hops - 1) * 0.1;
        const finalSlippage = Math.min(maxSlippage * compoundMultiplier, this.maxSlippage);

        return {
            slippage: finalSlippage,
            slippagePercent: finalSlippage * 100,
            hops,
            maxSlippageHop,
            compoundMultiplier,
            hopSlippages,
        };
    }

    /**
     * Calculate slippage cost in USD
     *
     * @param {number} slippage - Slippage as decimal
     * @param {number} grossProfitUSD - Gross profit in USD
     * @returns {number} Slippage cost in USD
     */
    calculateSlippageCost(slippage, grossProfitUSD) {
        return grossProfitUSD * slippage;
    }

    /**
     * Check if a token is a stablecoin
     *
     * @param {string} tokenSymbol - Token symbol
     * @returns {boolean}
     */
    isStablecoin(tokenSymbol) {
        return this.tokenTypes.stablecoin.has(tokenSymbol);
    }

    /**
     * Check if a pair is a stablecoin pair (both tokens are stablecoins)
     *
     * @param {string} tokenA - First token symbol
     * @param {string} tokenB - Second token symbol
     * @returns {boolean}
     */
    isStablePair(tokenA, tokenB) {
        return this.isStablecoin(tokenA) && this.isStablecoin(tokenB);
    }

    /**
     * Add a new token to a category
     *
     * @param {string} tokenSymbol - Token symbol
     * @param {string} tokenType - Token type
     */
    addToken(tokenSymbol, tokenType) {
        if (this.tokenTypes[tokenType]) {
            this.tokenTypes[tokenType].add(tokenSymbol);
            log.debug(`Added ${tokenSymbol} to ${tokenType} category`);
        }
    }

    /**
     * Get slippage statistics for reporting
     *
     * @returns {Object} Slippage configuration stats
     */
    getStats() {
        return {
            tokenCategories: {
                stablecoins: this.tokenTypes.stablecoin.size,
                native: this.tokenTypes.native.size,
                blueChip: this.tokenTypes.blueChip.size,
                volatile: this.tokenTypes.volatile.size,
                meme: this.tokenTypes.meme.size,
            },
            baseRates: {
                stablecoin: `${this.baseSlippageRates.stablecoin * 100}%`,
                native: `${this.baseSlippageRates.native * 100}%`,
                blueChip: `${this.baseSlippageRates.blueChip * 100}%`,
                volatile: `${this.baseSlippageRates.volatile * 100}%`,
                meme: `${this.baseSlippageRates.meme * 100}%`,
            },
            bounds: {
                min: `${this.minSlippage * 100}%`,
                max: `${this.maxSlippage * 100}%`,
            },
        };
    }
}

// Export singleton instance
const slippageManager = new SlippageManager();
export default slippageManager;
