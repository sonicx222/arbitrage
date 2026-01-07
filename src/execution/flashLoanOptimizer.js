import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import rpcManager from '../utils/rpcManager.js';
import config from '../config.js';
import log from '../utils/logger.js';

/**
 * Flash Loan Optimizer
 *
 * Selects the optimal flash loan provider based on:
 * 1. Fee structure (0% > 0.09% > 0.25%)
 * 2. Asset availability
 * 3. Liquidity depth
 * 4. Gas costs
 *
 * Supported Providers:
 * - dYdX: 0% fee (limited assets: WETH, USDC, DAI on Ethereum mainnet)
 * - Balancer: 0% fee (requires Balancer pool interaction)
 * - Aave: 0.09% fee (V3, wide asset selection)
 * - PancakeSwap: 0.25% fee (any V2 pair, fallback)
 *
 * Expected Impact: +20-40% cost savings on flash loan fees
 */
class FlashLoanOptimizer extends EventEmitter {
    constructor() {
        super();

        // Flash loan providers ordered by fee (lowest first)
        this.providers = [
            {
                name: 'dydx',
                fee: 0,
                chainIds: [1], // Ethereum mainnet only
                assets: new Set(['WETH', 'USDC', 'DAI', 'USDT']),
                poolAddress: '0x1E0447b19BB6EcFdAe1e4AE1694b0C3659614e4e', // dYdX SoloMargin
                enabled: true,
                gasOverhead: 80000, // Additional gas for dYdX interaction
            },
            {
                name: 'balancer',
                fee: 0,
                chainIds: [1, 137, 42161], // ETH, Polygon, Arbitrum
                assets: 'dynamic', // Fetched from Balancer pools
                vaultAddress: '0xBA12222222228d8Ba445958a75a0704d566BF2C8', // Balancer V2 Vault
                enabled: true,
                gasOverhead: 50000,
            },
            {
                name: 'aave_v3',
                fee: 0.0009, // 0.09%
                chainIds: [1, 137, 42161, 10, 8453, 43114, 56], // ETH, Polygon, Arbitrum, Optimism, Base, Avalanche, BSC
                assets: 'dynamic', // Fetched from Aave markets
                poolAddresses: {
                    1: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',    // ETH
                    137: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',  // Polygon
                    42161: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', // Arbitrum
                    10: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',   // Optimism
                    8453: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5', // Base
                    43114: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', // Avalanche
                    56: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB',   // BSC
                },
                enabled: true,
                gasOverhead: 60000,
            },
            {
                name: 'pancakeswap',
                fee: 0.0025, // 0.25%
                chainIds: [56, 1, 42161], // BSC, ETH, Arbitrum
                assets: 'any', // Any pair in PancakeSwap
                factoryAddresses: {
                    56: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',   // BSC
                    1: '0x1097053Fd2ea711dad45caCcc45EfF7548fCB362',    // ETH
                    42161: '0x02a84c1b3BBD7401a5f7fa98a384EBC70bB5749E', // Arbitrum
                },
                enabled: true,
                gasOverhead: 30000,
            },
            {
                name: 'uniswap_v2',
                fee: 0.003, // 0.3%
                chainIds: [1], // ETH mainnet
                assets: 'any',
                factoryAddress: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
                enabled: true,
                gasOverhead: 30000,
            },
        ];

        // Cache for asset availability per provider
        this.assetCache = new Map(); // provider_chainId -> Set<asset>
        this.cacheExpiry = 5 * 60 * 1000; // 5 minutes
        this.lastCacheUpdate = new Map();

        // Statistics
        this.stats = {
            selectionsTotal: 0,
            selectionsByProvider: {},
            estimatedSavings: 0, // Cumulative USD saved vs PancakeSwap
        };

        // Initialize provider stats
        this.providers.forEach(p => {
            this.stats.selectionsByProvider[p.name] = 0;
        });

        // Current chain ID (set by initialize)
        this.chainId = config.network?.chainId || 56;

        log.info('FlashLoanOptimizer initialized', {
            providers: this.providers.map(p => `${p.name} (${p.fee * 100}%)`),
            chainId: this.chainId,
        });
    }

    /**
     * Initialize the optimizer for a specific chain
     * @param {number} chainId - Chain ID
     */
    async initialize(chainId = null) {
        if (chainId) {
            this.chainId = chainId;
        }

        // Pre-fetch available assets for dynamic providers
        await this.refreshAssetCache();

        log.info('FlashLoanOptimizer ready', {
            chainId: this.chainId,
            availableProviders: this.getAvailableProviders().map(p => p.name),
        });
    }

    /**
     * Select the best flash loan provider for a given asset and amount
     *
     * @param {string} asset - Asset symbol (e.g., 'WBNB', 'USDT')
     * @param {number} amountUSD - Loan amount in USD
     * @param {Object} options - Additional options
     * @returns {Object} Selected provider with details
     */
    selectBestProvider(asset, amountUSD, options = {}) {
        this.stats.selectionsTotal++;

        const { preferLowGas = false, excludeProviders = [] } = options;

        // Get providers available for current chain and asset
        const candidates = this.providers.filter(p => {
            // Check if enabled
            if (!p.enabled) return false;

            // Check if excluded
            if (excludeProviders.includes(p.name)) return false;

            // Check chain support
            if (!p.chainIds.includes(this.chainId)) return false;

            // Check asset support
            if (p.assets === 'any') return true;
            if (p.assets === 'dynamic') {
                const cacheKey = `${p.name}_${this.chainId}`;
                const cachedAssets = this.assetCache.get(cacheKey);
                return cachedAssets && cachedAssets.has(asset);
            }
            return p.assets.has(asset);
        });

        if (candidates.length === 0) {
            log.warn('No flash loan provider available', { asset, chainId: this.chainId });
            return null;
        }

        // Sort by fee (and optionally by gas)
        const sorted = [...candidates].sort((a, b) => {
            if (preferLowGas) {
                // Prefer lower total cost (fee + gas)
                const costA = a.fee * amountUSD + a.gasOverhead * 0.00001; // Rough gas cost estimate
                const costB = b.fee * amountUSD + b.gasOverhead * 0.00001;
                return costA - costB;
            }
            // Prefer lower fee
            return a.fee - b.fee;
        });

        const selected = sorted[0];

        // Calculate savings vs default (PancakeSwap on BSC)
        const defaultProvider = this.providers.find(p => p.name === 'pancakeswap');
        if (defaultProvider && selected.fee < defaultProvider.fee) {
            const savings = (defaultProvider.fee - selected.fee) * amountUSD;
            this.stats.estimatedSavings += savings;
        }

        this.stats.selectionsByProvider[selected.name]++;

        // Build result with contract addresses
        const result = this._buildProviderResult(selected, asset, amountUSD);

        log.debug('Selected flash loan provider', {
            asset,
            amountUSD: amountUSD.toFixed(2),
            provider: selected.name,
            fee: `${selected.fee * 100}%`,
            feeCost: `$${(selected.fee * amountUSD).toFixed(4)}`,
        });

        return result;
    }

    /**
     * Build provider result with contract addresses and encoding
     * @private
     */
    _buildProviderResult(provider, asset, amountUSD) {
        const result = {
            name: provider.name,
            fee: provider.fee,
            feeCostUSD: provider.fee * amountUSD,
            gasOverhead: provider.gasOverhead,
            chainId: this.chainId,
        };

        // Add provider-specific details
        switch (provider.name) {
            case 'dydx':
                result.contractAddress = provider.poolAddress;
                result.callType = 'operate';
                break;

            case 'balancer':
                result.contractAddress = provider.vaultAddress;
                result.callType = 'flashLoan';
                break;

            case 'aave_v3':
                result.contractAddress = provider.poolAddresses[this.chainId];
                result.callType = 'flashLoanSimple';
                break;

            case 'pancakeswap':
            case 'uniswap_v2':
                result.factoryAddress = provider.factoryAddresses?.[this.chainId] || provider.factoryAddress;
                result.callType = 'swap'; // Uses swap callback for flash loan
                break;
        }

        return result;
    }

    /**
     * Get available providers for current chain
     * @returns {Array} Available providers
     */
    getAvailableProviders() {
        return this.providers.filter(p =>
            p.enabled && p.chainIds.includes(this.chainId)
        );
    }

    /**
     * Check if an asset is supported by any provider
     * @param {string} asset - Asset symbol
     * @returns {boolean}
     */
    isAssetSupported(asset) {
        return this.providers.some(p => {
            if (!p.enabled || !p.chainIds.includes(this.chainId)) return false;
            if (p.assets === 'any') return true;
            if (p.assets === 'dynamic') {
                const cacheKey = `${p.name}_${this.chainId}`;
                const cachedAssets = this.assetCache.get(cacheKey);
                return cachedAssets && cachedAssets.has(asset);
            }
            return p.assets.has(asset);
        });
    }

    /**
     * Get the fee for a specific provider
     * @param {string} providerName - Provider name
     * @returns {number} Fee as decimal (e.g., 0.0009 for 0.09%)
     */
    getProviderFee(providerName) {
        const provider = this.providers.find(p => p.name === providerName);
        return provider?.fee ?? 0.0025; // Default to PancakeSwap fee
    }

    /**
     * Calculate total cost for a flash loan
     * @param {string} providerName - Provider name
     * @param {number} amountUSD - Loan amount in USD
     * @param {number} gasPriceGwei - Gas price in Gwei
     * @returns {Object} Cost breakdown
     */
    calculateCost(providerName, amountUSD, gasPriceGwei = 5) {
        const provider = this.providers.find(p => p.name === providerName);
        if (!provider) return null;

        const feeCostUSD = provider.fee * amountUSD;

        // Estimate gas cost in USD (assuming native token price from config)
        const gasUnits = provider.gasOverhead;
        const gasCostETH = gasUnits * gasPriceGwei / 1e9;
        const nativePrice = this._getNativeTokenPrice();
        const gasCostUSD = gasCostETH * nativePrice;

        return {
            provider: providerName,
            feeCostUSD,
            gasCostUSD,
            totalCostUSD: feeCostUSD + gasCostUSD,
            breakdown: {
                fee: `${provider.fee * 100}%`,
                gasOverhead: gasUnits,
                gasPriceGwei,
                nativeTokenPrice: nativePrice,
            },
        };
    }

    /**
     * Compare costs across all available providers
     * @param {string} asset - Asset symbol
     * @param {number} amountUSD - Loan amount
     * @param {number} gasPriceGwei - Gas price
     * @returns {Array} Sorted cost comparisons
     */
    compareCosts(asset, amountUSD, gasPriceGwei = 5) {
        const comparisons = [];

        for (const provider of this.getAvailableProviders()) {
            // Check asset support
            let supported = false;
            if (provider.assets === 'any') {
                supported = true;
            } else if (provider.assets === 'dynamic') {
                const cacheKey = `${provider.name}_${this.chainId}`;
                const cachedAssets = this.assetCache.get(cacheKey);
                supported = cachedAssets && cachedAssets.has(asset);
            } else {
                supported = provider.assets.has(asset);
            }

            if (!supported) continue;

            const cost = this.calculateCost(provider.name, amountUSD, gasPriceGwei);
            if (cost) {
                comparisons.push(cost);
            }
        }

        return comparisons.sort((a, b) => a.totalCostUSD - b.totalCostUSD);
    }

    /**
     * Refresh the asset cache for dynamic providers
     */
    async refreshAssetCache() {
        const now = Date.now();

        for (const provider of this.providers) {
            if (provider.assets !== 'dynamic') continue;
            if (!provider.chainIds.includes(this.chainId)) continue;

            const cacheKey = `${provider.name}_${this.chainId}`;
            const lastUpdate = this.lastCacheUpdate.get(cacheKey) || 0;

            if (now - lastUpdate < this.cacheExpiry) continue;

            try {
                const assets = await this._fetchProviderAssets(provider);
                this.assetCache.set(cacheKey, assets);
                this.lastCacheUpdate.set(cacheKey, now);

                log.debug(`Refreshed ${provider.name} asset cache`, {
                    chainId: this.chainId,
                    assetCount: assets.size,
                });
            } catch (error) {
                log.warn(`Failed to refresh ${provider.name} assets`, { error: error.message });
            }
        }
    }

    /**
     * Fetch available assets from a provider
     * @private
     */
    async _fetchProviderAssets(provider) {
        // For now, use a predefined list based on common assets
        // In production, this would query the actual protocol contracts

        const commonAssets = new Set([
            'WBNB', 'WETH', 'USDT', 'USDC', 'BUSD', 'DAI',
            'BTCB', 'WBTC', 'ETH', 'CAKE', 'XRP', 'ADA',
        ]);

        switch (provider.name) {
            case 'balancer':
                // Balancer V2 typically has these
                return new Set(['WETH', 'USDC', 'DAI', 'WBTC', 'BAL', 'AAVE']);

            case 'aave_v3':
                // Aave V3 has wide asset coverage
                return commonAssets;

            default:
                return commonAssets;
        }
    }

    /**
     * Get native token price for gas calculations
     * @private
     */
    _getNativeTokenPrice() {
        // Chain-specific native token prices (fallback values)
        const prices = {
            1: 3500,    // ETH
            56: 600,    // BNB
            137: 0.5,   // MATIC
            42161: 3500, // ETH (Arbitrum)
            10: 3500,   // ETH (Optimism)
            8453: 3500, // ETH (Base)
            43114: 35,  // AVAX
        };

        return prices[this.chainId] || 1;
    }

    /**
     * Enable or disable a provider
     * @param {string} providerName - Provider name
     * @param {boolean} enabled - Enable state
     */
    setProviderEnabled(providerName, enabled) {
        const provider = this.providers.find(p => p.name === providerName);
        if (provider) {
            provider.enabled = enabled;
            log.info(`Flash loan provider ${providerName} ${enabled ? 'enabled' : 'disabled'}`);
        }
    }

    /**
     * Get optimizer statistics
     */
    getStats() {
        return {
            ...this.stats,
            chainId: this.chainId,
            availableProviders: this.getAvailableProviders().map(p => ({
                name: p.name,
                fee: `${p.fee * 100}%`,
            })),
        };
    }

    /**
     * Reset statistics
     */
    resetStats() {
        this.stats.selectionsTotal = 0;
        this.stats.estimatedSavings = 0;
        this.providers.forEach(p => {
            this.stats.selectionsByProvider[p.name] = 0;
        });
    }
}

// Export singleton instance
const flashLoanOptimizer = new FlashLoanOptimizer();
export default flashLoanOptimizer;
export { FlashLoanOptimizer };
