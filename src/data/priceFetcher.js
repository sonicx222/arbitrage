import { ethers } from 'ethers';
import { PAIR_ABI, FACTORY_ABI, ERC20_ABI, MULTICALL_ABI, MULTICALL_ADDRESS } from '../contracts/abis.js';
import rpcManager from '../utils/rpcManager.js';
import cacheManager from './cacheManager.js';
import config from '../config.js';
import log from '../utils/logger.js';

/**
 * Price Fetcher - Fetches token prices from DEX pairs via smart contract calls
 */
class PriceFetcher {
    constructor() {
        this.dexes = Object.entries(config.dex).filter(([_, dexConfig]) => dexConfig.enabled);
        log.info(`Price Fetcher initialized for ${this.dexes.length} DEXs`);
    }

    /**
     * Fetch prices for all configured token pairs across all DEXs
     */
    async fetchAllPrices(blockNumber) {
        const startTime = Date.now();
        try {
            const tokenPairs = this._getTokenPairs();
            const validPairs = await this._resolvePairs(tokenPairs);

            const results = await this._fetchBatchedReserves(validPairs);
            const prices = this._parseReserves(validPairs, results, blockNumber);

            log.debug(`Fetched ${Object.keys(prices).length} pair prices in ${Date.now() - startTime}ms`);
            return prices;
        } catch (error) {
            log.error('Error fetching prices (Multicall)', { error: error.message });
            return {};
        }
    }

    /**
     * Resolve pair addresses (cached or batched RPC)
     * @private
     */
    async _resolvePairs(tokenPairs) {
        const combinations = this.dexes.flatMap(([dexName, dexConfig]) =>
            tokenPairs.map(pair => ({ ...pair, dexName, dexConfig }))
        );

        const found = [];
        const missing = [];

        for (const combo of combinations) {
            const cached = cacheManager.getPairAddress(combo.tokenA.address, combo.tokenB.address, combo.dexName);
            if (cached === null || cached === false) continue;
            if (cached) found.push({ ...combo, address: cached });
            else missing.push(combo);
        }

        if (missing.length > 0) {
            const fetched = await this._batchFetchAddresses(missing);
            found.push(...fetched);
        }

        return found.filter(p => p.address && p.address !== ethers.ZeroAddress);
    }

    /**
     * Batch fetch pair addresses via Multicall
     * @private
     */
    async _batchFetchAddresses(pairs) {
        const BATCH_SIZE = 200;
        const fetched = [];

        for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
            const batch = pairs.slice(i, i + BATCH_SIZE);
            const calls = batch.map(c => ({
                target: c.dexConfig.factory,
                callData: new ethers.Interface(FACTORY_ABI).encodeFunctionData('getPair', [c.tokenA.address, c.tokenB.address])
            }));

            const results = await rpcManager.withRetry(async (p) => {
                return await new ethers.Contract(MULTICALL_ADDRESS, MULTICALL_ABI, p).tryAggregate(false, calls);
            });

            batch.forEach((combo, idx) => {
                const { success, returnData } = results[idx];
                let address = ethers.ZeroAddress;
                if (success && returnData !== '0x') {
                    address = new ethers.Interface(FACTORY_ABI).decodeFunctionResult('getPair', returnData)[0];
                }

                if (address !== ethers.ZeroAddress) {
                    cacheManager.setPairAddress(combo.tokenA.address, combo.tokenB.address, combo.dexName, address);
                    fetched.push({ ...combo, address });
                } else {
                    cacheManager.setPairAddress(combo.tokenA.address, combo.tokenB.address, combo.dexName, null);
                }
            });
        }

        if (fetched.length > 0) {
            cacheManager.savePersistentCache();
        }

        return fetched;
    }

    /**
     * Fetch reserves for all pairs using multicall batches
     * @private
     */
    async _fetchBatchedReserves(pairs) {
        const BATCH_SIZE = 200; // Increased for Alchemy
        const allResults = [];
        const iface = new ethers.Interface(PAIR_ABI);

        for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
            const batch = pairs.slice(i, i + BATCH_SIZE);
            const calls = batch.map(p => ({
                target: p.address,
                callData: iface.encodeFunctionData('getReserves')
            }));

            try {
                const results = await rpcManager.withRetry(async (provider) => {
                    const multicall = new ethers.Contract(MULTICALL_ADDRESS, MULTICALL_ABI, provider);
                    return await multicall.tryAggregate(false, calls);
                });
                allResults.push(...results);

                // Progress heartbeat for debug mode
                if (config.debugMode && (i + BATCH_SIZE) % 400 === 0) {
                    log.info(`⏳ Progress: Fetched ${i + batch.length}/${pairs.length} pair reserves...`);
                }
            } catch (err) {
                // Return failed results so indices stay aligned
                batch.forEach(() => allResults.push({ success: false, returnData: '0x' }));
            }
        }
        return allResults;
    }

    /**
     * Parse raw reserves into price data
     * @private
     */
    _parseReserves(pairs, results, blockNumber) {
        const prices = {};
        const iface = new ethers.Interface(PAIR_ABI);

        pairs.forEach((pair, idx) => {
            const { success, returnData } = results[idx];
            let priceData = null;

            if (success && returnData !== '0x') {
                const reserves = iface.decodeFunctionResult('getReserves', returnData);
                priceData = this.calculatePrice(
                    { reserve0: reserves[0].toString(), reserve1: reserves[1].toString() },
                    pair.tokenA, pair.tokenB, pair.address
                );
            } else {
                // Fallback to stale cache if available
                priceData = cacheManager.getPrice(cacheManager.getPriceKey(pair.tokenA.address, pair.tokenB.address, pair.dexName), blockNumber, 1);
            }

            if (priceData) {
                if (!prices[pair.pairKey]) prices[pair.pairKey] = {};
                prices[pair.pairKey][pair.dexName] = priceData;
                cacheManager.setPrice(cacheManager.getPriceKey(pair.tokenA.address, pair.tokenB.address, pair.dexName), priceData, blockNumber);
            }
        });

        return prices;
    }

    /**
     * Calculate price and liquidity from reserves
     */
    calculatePrice(reserves, tokenA, tokenB, pairAddress) {
        if (!reserves || reserves.reserve0 === '0' || reserves.reserve1 === '0') return null;

        const r0 = BigInt(reserves.reserve0);
        const r1 = BigInt(reserves.reserve1);

        // Determine which reserve belongs to which token
        // In Uniswap V2, token0 address < token1 address
        const isToken0 = tokenA.address.toLowerCase() < tokenB.address.toLowerCase();

        const reserveA = isToken0 ? r0 : r1;
        const reserveB = isToken0 ? r1 : r0;

        // Calculate price: amount of B for 1 unit of A
        // price = (reserveB / 10^decB) / (reserveA / 10^decA)
        // price = (reserveB * 10^decA) / (reserveA * 10^decB)

        const factorA = 10n ** BigInt(tokenA.decimals);
        const factorB = 10n ** BigInt(tokenB.decimals);

        // Use higher precision for calculation
        const precision = 10n ** 18n;
        const priceBI = (reserveB * factorA * precision) / (reserveA * factorB);
        const price = Number(priceBI) / 1e18;

        return {
            price,
            reserveA: reserveA.toString(),
            reserveB: reserveB.toString(),
            pairAddress,
            timestamp: Date.now()
        };
    }

    /**
     * Get all token pairs to monitor - Dynamic generation from config.tokens against baseAssets
     * @private
     */
    _getTokenPairs() {
        const tokens = Object.values(config.tokens);
        const baseSymbols = config.baseTokens || ['WBNB', 'USDT'];
        const baseTokens = tokens.filter(t => baseSymbols.includes(t.symbol));

        const pairs = [];
        const seen = new Set();

        for (const token of tokens) {
            for (const base of baseTokens) {
                if (token.address === base.address) continue;

                const [t1, t2] = token.address.toLowerCase() < base.address.toLowerCase()
                    ? [token, base] : [base, token];

                const key = `${t1.symbol}/${t2.symbol}`;
                if (!seen.has(key)) {
                    pairs.push({ tokenA: t1, tokenB: t2, pairKey: key });
                    seen.add(key);
                }
            }
        }

        log.debug(`Generated ${pairs.length} unique pairs to monitor against ${baseSymbols.length} base assets`);
        return pairs;
    }
}

// Export singleton instance
const priceFetcher = new PriceFetcher();
export default priceFetcher;
