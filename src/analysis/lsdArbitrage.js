import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import log from '../utils/logger.js';
import {
    STETH_ABI,
    WSTETH_ABI,
    RETH_ABI,
    CBETH_ABI,
    SFRXETH_ABI,
    LSD_ADDRESSES,
    LIDO_ORACLE_ABI,
    LIDO_ORACLE_ADDRESS,
    CURVE_POOL_ADDRESSES,
} from '../contracts/abis.js';

/**
 * Liquid Staking Derivative (LSD) Arbitrage Detector
 *
 * Monitors and detects arbitrage opportunities for liquid staking tokens:
 * - stETH (Lido) - Rebasing token, balance increases daily
 * - wstETH (Wrapped stETH) - Non-rebasing, value increases
 * - rETH (Rocket Pool) - Exchange rate increases with rewards
 * - cbETH (Coinbase) - Exchange rate based
 * - sfrxETH (Frax) - ERC4626 vault with share-based accounting
 *
 * Arbitrage opportunities arise from:
 * 1. Protocol exchange rate vs DEX market rate (e.g., rETH/ETH on Uniswap vs Rocket Pool rate)
 * 2. Cross-DEX price differences for LSD tokens
 * 3. Post-rebase opportunities (stETH rebases daily ~12:00 UTC)
 * 4. Curve pool imbalances (ETH/stETH pool)
 *
 * Expected Impact: $1-10 per trade, 5+ opportunities per day
 */
class LsdArbitrage extends EventEmitter {
    constructor(config = {}) {
        super();

        // Chain configuration
        this.chainId = config.chainId || 1;
        this.provider = config.provider || null;

        // LSD tokens to monitor
        this.lsdTokens = this._getLsdTokens();

        // Arbitrage thresholds
        this.minProfitPercent = config.minProfitPercent || 0.15; // 0.15% minimum profit
        this.minProfitUSD = config.minProfitUSD || 2; // $2 minimum profit
        this.maxTradeSize = config.maxTradeSize || 50000; // $50k max trade

        // Rebase monitoring
        this.lastRebaseTime = null;
        this.rebaseWindow = config.rebaseWindow || 30 * 60 * 1000; // 30 minutes after rebase
        this.isInRebaseWindow = false;

        // Exchange rate cache
        this.rateCache = new Map(); // lsdSymbol -> { rate, timestamp }
        this.cacheMaxAge = config.cacheMaxAge || 10000; // 10 seconds

        // Contract instances
        this.contracts = new Map();

        // Statistics
        this.stats = {
            opportunitiesDetected: 0,
            rateQueries: 0,
            rebasesDetected: 0,
            postRebaseOpportunities: 0,
            lastOpportunityTime: null,
            totalEstimatedProfit: 0,
        };

        // ETH price for USD calculations
        this.ethPriceUSD = config.ethPriceUSD || 3500;

        log.info('LsdArbitrage initialized', {
            chainId: this.chainId,
            minProfitPercent: `${this.minProfitPercent}%`,
            lsdTokens: Object.keys(this.lsdTokens[this.chainId] || {}).length,
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

        // Pre-fetch exchange rates
        await this._refreshAllRates();

        // Setup rebase monitoring (Ethereum only)
        if (this.chainId === 1) {
            await this._setupRebaseMonitoring();
        }

        log.info('LsdArbitrage ready', {
            chainId: this.chainId,
            lsdTokens: Object.keys(this.lsdTokens[this.chainId] || {}),
            cachedRates: this.rateCache.size,
        });
    }

    /**
     * Analyze prices for LSD arbitrage opportunities
     *
     * @param {Object} dexPrices - Price data from DEXes { pairKey: { dex: { price, ... } } }
     * @param {number} blockNumber - Current block number
     * @returns {Array} Array of arbitrage opportunities
     */
    async analyzeOpportunities(dexPrices, blockNumber) {
        const opportunities = [];
        const lsdAddresses = this.lsdTokens[this.chainId];

        if (!lsdAddresses || !this.provider) {
            return opportunities;
        }

        // 1. Check protocol rate vs DEX rate arbitrage
        const protocolOpps = await this._analyzeProtocolVsDex(dexPrices, blockNumber);
        opportunities.push(...protocolOpps);

        // 2. Check cross-DEX LSD arbitrage
        const crossDexOpps = this._analyzeCrossDexLsd(dexPrices, blockNumber);
        opportunities.push(...crossDexOpps);

        // 3. Check Curve pool arbitrage (if in rebase window, opportunities more likely)
        const curveOpps = await this._analyzeCurveLsd(dexPrices, blockNumber);
        opportunities.push(...curveOpps);

        // Sort by estimated profit
        opportunities.sort((a, b) => b.estimatedProfitUSD - a.estimatedProfitUSD);

        if (opportunities.length > 0) {
            this.stats.opportunitiesDetected += opportunities.length;
            this.stats.lastOpportunityTime = Date.now();
            this.stats.totalEstimatedProfit += opportunities.reduce(
                (sum, opp) => sum + opp.estimatedProfitUSD,
                0
            );

            if (this.isInRebaseWindow) {
                this.stats.postRebaseOpportunities += opportunities.length;
            }

            this.emit('opportunity', opportunities[0]);
        }

        return opportunities;
    }

    /**
     * Analyze protocol exchange rate vs DEX market rate
     * @private
     */
    async _analyzeProtocolVsDex(dexPrices, blockNumber) {
        const opportunities = [];
        const lsdAddresses = this.lsdTokens[this.chainId];

        for (const [lsdSymbol, address] of Object.entries(lsdAddresses)) {
            // Skip non-LSD tokens (WETH, WMATIC)
            if (['WETH', 'WMATIC'].includes(lsdSymbol)) continue;

            try {
                // Get protocol exchange rate
                const protocolRate = await this._getProtocolRate(lsdSymbol, address);
                if (!protocolRate) continue;

                // Find DEX prices for this LSD vs ETH/WETH
                const baseToken = this._getBaseToken();
                const pairKey = `${lsdSymbol}/${baseToken}`;
                const reversePairKey = `${baseToken}/${lsdSymbol}`;

                const dexPairData = dexPrices[pairKey] || dexPrices[reversePairKey];
                if (!dexPairData) continue;

                for (const [dexName, dexData] of Object.entries(dexPairData)) {
                    if (!dexData.price || dexData.price <= 0) continue;

                    let dexRate = dexData.price;
                    // Normalize to LSD/ETH format
                    if (dexPrices[reversePairKey] && !dexPrices[pairKey]) {
                        dexRate = 1 / dexRate;
                    }

                    // Calculate spread between protocol and DEX
                    const spread = Math.abs(protocolRate - dexRate) / Math.min(protocolRate, dexRate);
                    const dexFee = dexData.fee || 0.003;
                    const netSpread = spread - dexFee;

                    if (netSpread >= this.minProfitPercent / 100) {
                        // Determine trade direction
                        // If protocol rate > DEX rate: buy on DEX, redeem via protocol (if possible)
                        // If DEX rate > protocol rate: mint via protocol, sell on DEX (if possible)
                        const buyOnDex = protocolRate > dexRate;
                        const action = buyOnDex ? 'buy-dex-redeem-protocol' : 'mint-protocol-sell-dex';

                        // Most LSDs don't have direct mint/redeem, so this is cross-DEX/Curve arb
                        const optimalSize = Math.min(
                            Math.max((dexData.liquidityUSD || this.maxTradeSize) * 0.02, 1000),
                            this.maxTradeSize
                        );

                        const estimatedProfitUSD = (optimalSize / this.ethPriceUSD) * netSpread * this.ethPriceUSD;

                        if (estimatedProfitUSD >= this.minProfitUSD) {
                            opportunities.push({
                                type: 'lsd-protocol-dex',
                                lsdSymbol,
                                lsdAddress: address,
                                baseToken,
                                protocolRate,
                                dexRate,
                                dexName,
                                action,
                                spreadPercent: parseFloat((spread * 100).toFixed(4)),
                                netSpreadPercent: parseFloat((netSpread * 100).toFixed(4)),
                                optimalSizeUSD: parseFloat(optimalSize.toFixed(2)),
                                estimatedProfitUSD: parseFloat(estimatedProfitUSD.toFixed(2)),
                                isInRebaseWindow: this.isInRebaseWindow,
                                blockNumber,
                                timestamp: Date.now(),
                                chainId: this.chainId,
                            });
                        }
                    }
                }
            } catch (error) {
                log.debug(`Error analyzing LSD ${lsdSymbol}`, { error: error.message });
            }
        }

        return opportunities;
    }

    /**
     * Analyze cross-DEX LSD arbitrage
     * @private
     */
    _analyzeCrossDexLsd(dexPrices, blockNumber) {
        const opportunities = [];
        const lsdAddresses = this.lsdTokens[this.chainId];
        const baseToken = this._getBaseToken();

        for (const lsdSymbol of Object.keys(lsdAddresses)) {
            if (['WETH', 'WMATIC'].includes(lsdSymbol)) continue;

            const pairKey = `${lsdSymbol}/${baseToken}`;
            const reversePairKey = `${baseToken}/${lsdSymbol}`;

            const pairData = dexPrices[pairKey] || dexPrices[reversePairKey];
            if (!pairData) continue;

            // Get all DEX prices
            const dexRates = [];
            for (const [dexName, data] of Object.entries(pairData)) {
                if (!data.price || data.price <= 0) continue;

                let normalizedRate = data.price;
                if (dexPrices[reversePairKey] && !dexPrices[pairKey]) {
                    normalizedRate = 1 / data.price;
                }

                dexRates.push({
                    dex: dexName,
                    rate: normalizedRate,
                    liquidityUSD: data.liquidityUSD || 0,
                    fee: data.fee || 0.003,
                });
            }

            if (dexRates.length < 2) continue;

            // Sort by rate to find best buy (lowest) and sell (highest)
            dexRates.sort((a, b) => a.rate - b.rate);
            const buyDex = dexRates[0];
            const sellDex = dexRates[dexRates.length - 1];

            // Calculate spread
            const spread = (sellDex.rate - buyDex.rate) / buyDex.rate;
            const totalFees = buyDex.fee + sellDex.fee;
            const netSpread = spread - totalFees;

            if (netSpread >= this.minProfitPercent / 100) {
                const minLiquidity = Math.min(
                    buyDex.liquidityUSD || this.maxTradeSize,
                    sellDex.liquidityUSD || this.maxTradeSize
                );
                const optimalSize = Math.min(
                    Math.max(minLiquidity * 0.02, 1000),
                    this.maxTradeSize
                );

                const estimatedProfitUSD = optimalSize * netSpread;

                if (estimatedProfitUSD >= this.minProfitUSD) {
                    opportunities.push({
                        type: 'lsd-cross-dex',
                        lsdSymbol,
                        baseToken,
                        buyDex: buyDex.dex,
                        sellDex: sellDex.dex,
                        buyRate: buyDex.rate,
                        sellRate: sellDex.rate,
                        spreadPercent: parseFloat((spread * 100).toFixed(4)),
                        netSpreadPercent: parseFloat((netSpread * 100).toFixed(4)),
                        optimalSizeUSD: parseFloat(optimalSize.toFixed(2)),
                        estimatedProfitUSD: parseFloat(estimatedProfitUSD.toFixed(2)),
                        minLiquidityUSD: minLiquidity,
                        isInRebaseWindow: this.isInRebaseWindow,
                        blockNumber,
                        timestamp: Date.now(),
                        chainId: this.chainId,
                    });
                }
            }
        }

        return opportunities;
    }

    /**
     * Analyze Curve pool LSD arbitrage
     * @private
     */
    async _analyzeCurveLsd(dexPrices, blockNumber) {
        const opportunities = [];
        const curvePools = CURVE_POOL_ADDRESSES[this.chainId];

        if (!curvePools) return opportunities;

        // Check stETH/ETH pool on Ethereum
        if (this.chainId === 1 && curvePools.steth) {
            const stethPool = curvePools.steth;

            // Get stETH/ETH rate from Uniswap/DEXes
            const pairKey = 'stETH/WETH';
            const dexPairData = dexPrices[pairKey] || dexPrices['WETH/stETH'];

            if (dexPairData) {
                for (const [dexName, dexData] of Object.entries(dexPairData)) {
                    if (!dexData.price || dexData.price <= 0) continue;

                    let dexRate = dexData.price;
                    if (dexPrices['WETH/stETH'] && !dexPrices[pairKey]) {
                        dexRate = 1 / dexRate;
                    }

                    // stETH should be ~1:1 with ETH, any significant deviation is opportunity
                    const pegDeviation = Math.abs(1 - dexRate);
                    const curveFee = 0.0004; // 0.04%
                    const dexFee = dexData.fee || 0.003;
                    const netDeviation = pegDeviation - curveFee - dexFee;

                    // If stETH is trading below peg on DEX, buy there and sell on Curve
                    // If stETH is trading above peg, buy on Curve and sell on DEX
                    if (netDeviation >= this.minProfitPercent / 100) {
                        const buyOnDex = dexRate < 1;
                        const optimalSize = Math.min(
                            Math.max((dexData.liquidityUSD || this.maxTradeSize) * 0.02, 1000),
                            this.maxTradeSize
                        );

                        const estimatedProfitUSD = optimalSize * netDeviation;

                        if (estimatedProfitUSD >= this.minProfitUSD) {
                            opportunities.push({
                                type: 'lsd-curve-dex',
                                lsdSymbol: 'stETH',
                                curvePool: 'steth',
                                curvePoolAddress: stethPool,
                                dexName,
                                dexRate,
                                pegDeviation: parseFloat((pegDeviation * 100).toFixed(4)),
                                buyVenue: buyOnDex ? dexName : 'curve',
                                sellVenue: buyOnDex ? 'curve' : dexName,
                                netDeviationPercent: parseFloat((netDeviation * 100).toFixed(4)),
                                optimalSizeUSD: parseFloat(optimalSize.toFixed(2)),
                                estimatedProfitUSD: parseFloat(estimatedProfitUSD.toFixed(2)),
                                isInRebaseWindow: this.isInRebaseWindow,
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
     * Get protocol exchange rate for an LSD token
     * @private
     */
    async _getProtocolRate(lsdSymbol, address) {
        // Check cache
        const cached = this.rateCache.get(lsdSymbol);
        if (cached && Date.now() - cached.timestamp < this.cacheMaxAge) {
            return cached.rate;
        }

        this.stats.rateQueries++;

        try {
            let rate = null;

            switch (lsdSymbol) {
                case 'wstETH': {
                    const contract = this._getContract(lsdSymbol, address, WSTETH_ABI);
                    const stEthPerToken = await contract.stEthPerToken();
                    rate = Number(stEthPerToken) / 1e18;
                    break;
                }
                case 'rETH': {
                    const contract = this._getContract(lsdSymbol, address, RETH_ABI);
                    const exchangeRate = await contract.getExchangeRate();
                    rate = Number(exchangeRate) / 1e18;
                    break;
                }
                case 'cbETH': {
                    const contract = this._getContract(lsdSymbol, address, CBETH_ABI);
                    const exchangeRate = await contract.exchangeRate();
                    rate = Number(exchangeRate) / 1e18;
                    break;
                }
                case 'sfrxETH': {
                    const contract = this._getContract(lsdSymbol, address, SFRXETH_ABI);
                    const pricePerShare = await contract.pricePerShare();
                    rate = Number(pricePerShare) / 1e18;
                    break;
                }
                case 'stETH': {
                    // stETH is 1:1 with ETH in terms of rate (balance changes instead)
                    rate = 1.0;
                    break;
                }
                case 'stMATIC':
                case 'MaticX': {
                    // Staked MATIC tokens - would need specific ABIs
                    rate = 1.0; // Placeholder
                    break;
                }
                default:
                    return null;
            }

            if (rate !== null) {
                this.rateCache.set(lsdSymbol, { rate, timestamp: Date.now() });
            }

            return rate;
        } catch (error) {
            log.debug(`Failed to get protocol rate for ${lsdSymbol}`, {
                error: error.message,
            });
            return null;
        }
    }

    /**
     * Get or create contract instance
     * @private
     */
    _getContract(symbol, address, abi) {
        const cacheKey = `${symbol}_${this.chainId}`;
        if (this.contracts.has(cacheKey)) {
            return this.contracts.get(cacheKey);
        }

        const contract = new ethers.Contract(address, abi, this.provider);
        this.contracts.set(cacheKey, contract);
        return contract;
    }

    /**
     * Refresh all exchange rates
     * @private
     */
    async _refreshAllRates() {
        const lsdAddresses = this.lsdTokens[this.chainId];
        if (!lsdAddresses) return;

        for (const [symbol, address] of Object.entries(lsdAddresses)) {
            if (['WETH', 'WMATIC'].includes(symbol)) continue;
            await this._getProtocolRate(symbol, address);
        }
    }

    /**
     * Setup rebase monitoring for stETH
     * @private
     */
    async _setupRebaseMonitoring() {
        if (this.chainId !== 1 || !this.provider) return;

        try {
            const oracleContract = new ethers.Contract(
                LIDO_ORACLE_ADDRESS,
                LIDO_ORACLE_ABI,
                this.provider
            );

            // Get last rebase info
            const [postTotal, preTotal, timeElapsed] = await oracleContract.getLastCompletedReportDelta();

            // Calculate rebase percentage
            const rebasePercent = ((Number(postTotal) - Number(preTotal)) / Number(preTotal)) * 100;

            log.info('Lido rebase info loaded', {
                rebasePercent: `${rebasePercent.toFixed(4)}%`,
                timeElapsedHours: (Number(timeElapsed) / 3600).toFixed(1),
            });

            // Estimate next rebase time (rebases happen ~daily around 12:00 UTC)
            this._estimateNextRebase();

        } catch (error) {
            log.warn('Failed to setup rebase monitoring', { error: error.message });
        }
    }

    /**
     * Estimate next rebase time
     * @private
     */
    _estimateNextRebase() {
        const now = new Date();
        const utcHours = now.getUTCHours();
        const utcMinutes = now.getUTCMinutes();

        // Rebase typically happens around 12:00 UTC
        const rebaseHour = 12;

        let nextRebase = new Date(now);
        nextRebase.setUTCHours(rebaseHour, 0, 0, 0);

        // If we're past today's rebase time, schedule for tomorrow
        if (utcHours > rebaseHour || (utcHours === rebaseHour && utcMinutes > 30)) {
            nextRebase.setDate(nextRebase.getDate() + 1);
        }

        const msUntilRebase = nextRebase.getTime() - now.getTime();

        log.debug('Next stETH rebase estimated', {
            nextRebase: nextRebase.toISOString(),
            hoursUntil: (msUntilRebase / (1000 * 60 * 60)).toFixed(1),
        });

        // Check if we're currently in a rebase window
        const timeSinceRebaseHour = (utcHours - rebaseHour) * 60 + utcMinutes;
        this.isInRebaseWindow = timeSinceRebaseHour >= 0 && timeSinceRebaseHour <= 30;

        if (this.isInRebaseWindow) {
            log.info('Currently in stETH rebase window - higher opportunity likelihood');
        }
    }

    /**
     * Manually trigger rebase window check
     */
    checkRebaseWindow() {
        this._estimateNextRebase();
        return this.isInRebaseWindow;
    }

    /**
     * Get base token for current chain
     * @private
     */
    _getBaseToken() {
        switch (this.chainId) {
            case 137:
                return 'WMATIC';
            default:
                return 'WETH';
        }
    }

    /**
     * Get LSD tokens configuration by chain
     * @private
     */
    _getLsdTokens() {
        return LSD_ADDRESSES;
    }

    /**
     * Get current exchange rate for an LSD token
     */
    async getExchangeRate(lsdSymbol) {
        const lsdAddresses = this.lsdTokens[this.chainId];
        if (!lsdAddresses || !lsdAddresses[lsdSymbol]) {
            return null;
        }

        return await this._getProtocolRate(lsdSymbol, lsdAddresses[lsdSymbol]);
    }

    /**
     * Get all current exchange rates
     */
    async getAllRates() {
        const rates = {};
        const lsdAddresses = this.lsdTokens[this.chainId];

        if (!lsdAddresses) return rates;

        for (const [symbol, address] of Object.entries(lsdAddresses)) {
            if (['WETH', 'WMATIC'].includes(symbol)) continue;

            const rate = await this._getProtocolRate(symbol, address);
            if (rate !== null) {
                rates[symbol] = rate;
            }
        }

        return rates;
    }

    /**
     * Set ETH price for USD calculations
     */
    setEthPrice(priceUSD) {
        this.ethPriceUSD = priceUSD;
    }

    /**
     * Get available LSD tokens for current chain
     */
    getAvailableLsdTokens() {
        return Object.keys(this.lsdTokens[this.chainId] || {}).filter(
            symbol => !['WETH', 'WMATIC'].includes(symbol)
        );
    }

    /**
     * Get statistics
     */
    getStats() {
        return {
            ...this.stats,
            chainId: this.chainId,
            lsdTokensConfigured: this.getAvailableLsdTokens().length,
            cachedRates: this.rateCache.size,
            isInRebaseWindow: this.isInRebaseWindow,
        };
    }

    /**
     * Reset statistics
     */
    resetStats() {
        this.stats = {
            opportunitiesDetected: 0,
            rateQueries: 0,
            rebasesDetected: this.stats.rebasesDetected,
            postRebaseOpportunities: 0,
            lastOpportunityTime: null,
            totalEstimatedProfit: 0,
        };
    }

    /**
     * Clear caches
     */
    clearCache() {
        this.rateCache.clear();
    }
}

// Export singleton instance
const lsdArbitrage = new LsdArbitrage();
export default lsdArbitrage;
export { LsdArbitrage };
