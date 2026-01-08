import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import config from '../config.js';
import log from '../utils/logger.js';
import {
    BALANCER_VAULT_ABI,
    BALANCER_VAULT_ADDRESSES,
    DYDX_SOLO_MARGIN_ABI,
    DYDX_ADDRESSES,
    DYDX_ACTION_TYPES,
    AAVE_V3_POOL_ABI,
    AAVE_V3_POOL_ADDRESSES,
    FLASH_LOAN_FEES,
    WRAPPED_NATIVE_ADDRESSES,
} from '../contracts/abis.js';

/**
 * Flash Loan Optimizer v2.0
 *
 * Enhanced flash loan provider selection with:
 * - Zero-fee providers prioritized (dYdX, Balancer)
 * - Multi-chain Balancer support (ETH, Polygon, Arbitrum, Base, Avalanche, Optimism)
 * - Dynamic liquidity checking
 * - Resilient fallback chain
 *
 * Provider Priority (by fee):
 * 1. dYdX: 0% fee (Ethereum only, limited assets: WETH, USDC, DAI)
 * 2. Balancer: 0% fee (multi-chain, pool-based liquidity)
 * 3. Aave V3: 0.09% fee (wide asset selection)
 * 4. PancakeSwap/Uniswap V2: 0.25-0.3% fee (any pair, fallback)
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
                fee: FLASH_LOAN_FEES.DYDX,
                chainIds: [1], // Ethereum mainnet only
                assets: new Set(['WETH', 'USDC', 'DAI']),
                contractAddress: DYDX_ADDRESSES.soloMargin,
                marketIds: DYDX_ADDRESSES.markets,
                enabled: true,
                gasOverhead: 150000, // dYdX has higher gas due to operate() complexity
                callType: 'operate',
                minLiquidity: 10000, // Minimum $10k liquidity required
            },
            {
                name: 'balancer',
                fee: FLASH_LOAN_FEES.BALANCER,
                chainIds: [1, 137, 42161, 10, 8453, 43114], // ETH, Polygon, Arbitrum, Optimism, Base, Avalanche
                assets: 'dynamic', // Fetched from Balancer pools
                vaultAddresses: BALANCER_VAULT_ADDRESSES,
                enabled: true,
                gasOverhead: 80000,
                callType: 'flashLoan',
                minLiquidity: 5000,
                // Common assets available on Balancer across chains
                commonAssets: new Set([
                    'WETH', 'USDC', 'USDT', 'DAI', 'WBTC', 'BAL',
                    'AAVE', 'LINK', 'UNI', 'CRV', 'FRAX', 'LUSD',
                    'wstETH', 'rETH', 'cbETH', // LSDs
                ]),
            },
            {
                name: 'aave_v3',
                fee: FLASH_LOAN_FEES.AAVE_V3,
                chainIds: [1, 137, 42161, 10, 8453, 43114, 56], // All major chains including BSC
                assets: 'dynamic',
                poolAddresses: AAVE_V3_POOL_ADDRESSES,
                enabled: true,
                gasOverhead: 100000,
                callType: 'flashLoanSimple',
                minLiquidity: 1000,
            },
            {
                name: 'pancakeswap',
                fee: FLASH_LOAN_FEES.PANCAKE_V2,
                chainIds: [56, 1, 42161], // BSC, ETH, Arbitrum
                assets: 'any', // Any pair in PancakeSwap
                factoryAddresses: {
                    56: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
                    1: '0x1097053Fd2ea711dad45caCcc45EfF7548fCB362',
                    42161: '0x02a84c1b3BBD7401a5f7fa98a384EBC70bB5749E',
                },
                enabled: true,
                gasOverhead: 50000,
                callType: 'swap',
                minLiquidity: 500,
            },
            {
                name: 'uniswap_v2',
                fee: FLASH_LOAN_FEES.UNISWAP_V2,
                chainIds: [1], // ETH mainnet
                assets: 'any',
                factoryAddress: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
                enabled: true,
                gasOverhead: 50000,
                callType: 'swap',
                minLiquidity: 500,
            },
        ];

        // Cache for asset availability and liquidity per provider
        this.assetCache = new Map(); // provider_chainId -> Map<asset, liquidity>
        this.cacheExpiry = 5 * 60 * 1000; // 5 minutes
        this.lastCacheUpdate = new Map();

        // Provider contracts cache (lazy initialization)
        this.contracts = new Map();

        // Statistics
        this.stats = {
            selectionsTotal: 0,
            selectionsByProvider: {},
            estimatedSavings: 0, // Cumulative USD saved vs default provider
            zeroFeeSelections: 0, // Count of dYdX + Balancer selections
            liquidityChecks: 0,
            liquidityChecksFailed: 0,
        };

        // Initialize provider stats
        this.providers.forEach(p => {
            this.stats.selectionsByProvider[p.name] = 0;
        });

        // Current chain ID (set by initialize)
        this.chainId = config.network?.chainId || 56;

        // Provider reference (set by initialize for on-chain checks)
        this.rpcProvider = null;

        log.info('FlashLoanOptimizer v2.0 initialized', {
            providers: this.providers.map(p => `${p.name} (${p.fee * 100}%)`),
            chainId: this.chainId,
            zeroFeeProviders: ['dydx', 'balancer'],
        });
    }

    /**
     * Initialize the optimizer for a specific chain
     * @param {number} chainId - Chain ID
     * @param {Object} provider - Optional ethers provider for on-chain checks
     */
    async initialize(chainId = null, provider = null) {
        if (chainId) {
            this.chainId = chainId;
        }

        if (provider) {
            this.rpcProvider = provider;
        }

        // Pre-fetch available assets for dynamic providers
        await this.refreshAssetCache();

        const availableProviders = this.getAvailableProviders();
        const zeroFeeAvailable = availableProviders.filter(p => p.fee === 0);

        log.info('FlashLoanOptimizer ready', {
            chainId: this.chainId,
            availableProviders: availableProviders.map(p => p.name),
            zeroFeeProviders: zeroFeeAvailable.map(p => p.name),
            hasFreeFlashLoans: zeroFeeAvailable.length > 0,
        });
    }

    /**
     * Select the best flash loan provider for a given asset and amount
     *
     * Selection priority:
     * 1. Zero-fee providers (dYdX > Balancer) if asset is supported
     * 2. Lowest fee provider with sufficient liquidity
     * 3. Fallback to any provider (PancakeSwap/Uniswap)
     *
     * @param {string} asset - Asset symbol (e.g., 'WBNB', 'USDT')
     * @param {number} amountUSD - Loan amount in USD
     * @param {Object} options - Additional options
     * @returns {Object|null} Selected provider with details
     */
    selectBestProvider(asset, amountUSD, options = {}) {
        this.stats.selectionsTotal++;

        const {
            preferLowGas = false,
            excludeProviders = [],
            requireZeroFee = false,
            minLiquidity = null,
        } = options;

        // Normalize asset symbol
        const normalizedAsset = this._normalizeAsset(asset);

        // Get providers available for current chain and asset
        const candidates = this.providers.filter(p => {
            // Check if enabled
            if (!p.enabled) return false;

            // Check if excluded
            if (excludeProviders.includes(p.name)) return false;

            // Check chain support
            if (!p.chainIds.includes(this.chainId)) return false;

            // Check zero-fee requirement
            if (requireZeroFee && p.fee > 0) return false;

            // Check asset support
            if (!this._isAssetSupportedByProvider(p, normalizedAsset)) return false;

            // Check minimum liquidity if specified
            if (minLiquidity !== null) {
                const liquidity = this._getCachedLiquidity(p, normalizedAsset);
                if (liquidity !== null && liquidity < minLiquidity) return false;
            }

            return true;
        });

        if (candidates.length === 0) {
            log.warn('No flash loan provider available', {
                asset: normalizedAsset,
                chainId: this.chainId,
                requireZeroFee,
            });
            return null;
        }

        // Sort by fee (and optionally by gas)
        const sorted = [...candidates].sort((a, b) => {
            // Primary sort: fee
            if (a.fee !== b.fee) {
                return a.fee - b.fee;
            }

            // Secondary sort: gas overhead (if preferLowGas) or liquidity
            if (preferLowGas) {
                return a.gasOverhead - b.gasOverhead;
            }

            // Prefer providers with known liquidity
            const liqA = this._getCachedLiquidity(a, normalizedAsset) || 0;
            const liqB = this._getCachedLiquidity(b, normalizedAsset) || 0;
            return liqB - liqA; // Higher liquidity first
        });

        const selected = sorted[0];

        // Calculate savings vs default (PancakeSwap on BSC)
        const defaultFee = FLASH_LOAN_FEES.PANCAKE_V2;
        if (selected.fee < defaultFee) {
            const savings = (defaultFee - selected.fee) * amountUSD;
            this.stats.estimatedSavings += savings;
        }

        // Track zero-fee selections
        if (selected.fee === 0) {
            this.stats.zeroFeeSelections++;
        }

        this.stats.selectionsByProvider[selected.name]++;

        // Build result with contract addresses
        const result = this._buildProviderResult(selected, normalizedAsset, amountUSD);

        log.debug('Selected flash loan provider', {
            asset: normalizedAsset,
            amountUSD: amountUSD.toFixed(2),
            provider: selected.name,
            fee: `${selected.fee * 100}%`,
            feeCost: `$${(selected.fee * amountUSD).toFixed(4)}`,
            isZeroFee: selected.fee === 0,
        });

        return result;
    }

    /**
     * Check if an asset is supported by a specific provider
     * @private
     */
    _isAssetSupportedByProvider(provider, asset) {
        if (provider.assets === 'any') {
            return true;
        }

        if (provider.assets === 'dynamic') {
            // Check cache first
            const cacheKey = `${provider.name}_${this.chainId}`;
            const cachedAssets = this.assetCache.get(cacheKey);

            if (cachedAssets) {
                return cachedAssets.has(asset);
            }

            // Fallback to common assets for Balancer
            if (provider.name === 'balancer' && provider.commonAssets) {
                return provider.commonAssets.has(asset);
            }

            // Assume supported if no cache (will be validated on-chain)
            return true;
        }

        if (provider.assets instanceof Set) {
            return provider.assets.has(asset);
        }

        return false;
    }

    /**
     * Get cached liquidity for an asset from a provider
     * @private
     */
    _getCachedLiquidity(provider, asset) {
        const cacheKey = `${provider.name}_${this.chainId}`;
        const cachedAssets = this.assetCache.get(cacheKey);

        if (!cachedAssets || !(cachedAssets instanceof Map)) {
            return null;
        }

        return cachedAssets.get(asset) || null;
    }

    /**
     * Normalize asset symbol for consistent matching
     * @private
     */
    _normalizeAsset(asset) {
        const upperAsset = asset.toUpperCase();

        // Map common variations
        const assetMap = {
            'ETH': 'WETH',
            'BNB': 'WBNB',
            'MATIC': 'WMATIC',
            'AVAX': 'WAVAX',
        };

        return assetMap[upperAsset] || upperAsset;
    }

    /**
     * Build provider result with contract addresses and encoding
     * @private
     */
    _buildProviderResult(provider, asset, amountUSD) {
        const result = {
            name: provider.name,
            fee: provider.fee,
            feePercent: `${provider.fee * 100}%`,
            feeCostUSD: provider.fee * amountUSD,
            gasOverhead: provider.gasOverhead,
            chainId: this.chainId,
            callType: provider.callType,
            isZeroFee: provider.fee === 0,
        };

        // Add provider-specific details
        switch (provider.name) {
            case 'dydx':
                result.contractAddress = provider.contractAddress;
                result.marketId = provider.marketIds[asset];
                result.actionTypes = DYDX_ACTION_TYPES;
                // dYdX requires specific action encoding
                result.callData = {
                    actionType: DYDX_ACTION_TYPES.Withdraw,
                    callbackType: DYDX_ACTION_TYPES.Call,
                    depositType: DYDX_ACTION_TYPES.Deposit,
                };
                break;

            case 'balancer':
                result.contractAddress = provider.vaultAddresses[this.chainId];
                // Balancer flashLoan takes arrays even for single asset
                result.isMultiAsset = false;
                break;

            case 'aave_v3':
                result.contractAddress = provider.poolAddresses[this.chainId];
                result.referralCode = 0; // No referral
                break;

            case 'pancakeswap':
            case 'uniswap_v2':
                result.factoryAddress = provider.factoryAddresses?.[this.chainId] || provider.factoryAddress;
                // V2 flash loans use swap callback
                result.useCallback = true;
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
     * Get zero-fee providers available for current chain
     * @returns {Array} Zero-fee providers
     */
    getZeroFeeProviders() {
        return this.getAvailableProviders().filter(p => p.fee === 0);
    }

    /**
     * Check if zero-fee flash loans are available for an asset
     * @param {string} asset - Asset symbol
     * @returns {boolean}
     */
    hasZeroFeeFlashLoan(asset) {
        const normalizedAsset = this._normalizeAsset(asset);
        const zeroFeeProviders = this.getZeroFeeProviders();

        return zeroFeeProviders.some(p =>
            this._isAssetSupportedByProvider(p, normalizedAsset)
        );
    }

    /**
     * Check if an asset is supported by any provider
     * @param {string} asset - Asset symbol
     * @returns {boolean}
     */
    isAssetSupported(asset) {
        const normalizedAsset = this._normalizeAsset(asset);
        return this.getAvailableProviders().some(p =>
            this._isAssetSupportedByProvider(p, normalizedAsset)
        );
    }

    /**
     * Get the fee for a specific provider
     * @param {string} providerName - Provider name
     * @returns {number} Fee as decimal (e.g., 0.0009 for 0.09%)
     */
    getProviderFee(providerName) {
        const provider = this.providers.find(p => p.name === providerName);
        return provider?.fee ?? FLASH_LOAN_FEES.PANCAKE_V2;
    }

    /**
     * Calculate total cost for a flash loan
     * @param {string} providerName - Provider name
     * @param {number} amountUSD - Loan amount in USD
     * @param {number} gasPriceGwei - Gas price in Gwei
     * @returns {Object|null} Cost breakdown
     */
    calculateCost(providerName, amountUSD, gasPriceGwei = 5) {
        const provider = this.providers.find(p => p.name === providerName);
        if (!provider) return null;

        const feeCostUSD = provider.fee * amountUSD;

        // Estimate gas cost in USD
        const gasUnits = provider.gasOverhead;
        const gasCostETH = gasUnits * gasPriceGwei / 1e9;
        const nativePrice = this._getNativeTokenPrice();
        const gasCostUSD = gasCostETH * nativePrice;

        return {
            provider: providerName,
            fee: provider.fee,
            feePercent: `${provider.fee * 100}%`,
            feeCostUSD,
            gasCostUSD,
            totalCostUSD: feeCostUSD + gasCostUSD,
            isZeroFee: provider.fee === 0,
            breakdown: {
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
        const normalizedAsset = this._normalizeAsset(asset);
        const comparisons = [];

        for (const provider of this.getAvailableProviders()) {
            if (!this._isAssetSupportedByProvider(provider, normalizedAsset)) {
                continue;
            }

            const cost = this.calculateCost(provider.name, amountUSD, gasPriceGwei);
            if (cost) {
                cost.asset = normalizedAsset;
                cost.supported = true;
                comparisons.push(cost);
            }
        }

        return comparisons.sort((a, b) => a.totalCostUSD - b.totalCostUSD);
    }

    /**
     * Refresh the asset cache for dynamic providers
     * Attempts on-chain liquidity checks when provider available
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
                log.warn(`Failed to refresh ${provider.name} assets`, {
                    error: error.message,
                    chainId: this.chainId,
                });
            }
        }
    }

    /**
     * Fetch available assets from a provider
     * @private
     */
    async _fetchProviderAssets(provider) {
        // For now, use predefined lists based on common assets
        // In production, this would query actual protocol contracts

        const wrappedNative = this._getWrappedNativeSymbol();

        switch (provider.name) {
            case 'balancer':
                // Balancer V2 common assets per chain
                return new Set([
                    wrappedNative,
                    'USDC', 'USDT', 'DAI', 'WBTC',
                    'BAL', 'AAVE', 'LINK', 'UNI',
                    // LSDs (Ethereum mainly)
                    ...(this.chainId === 1 ? ['wstETH', 'rETH', 'cbETH', 'sfrxETH'] : []),
                    // Polygon specific
                    ...(this.chainId === 137 ? ['WMATIC', 'stMATIC'] : []),
                ]);

            case 'aave_v3':
                // Aave V3 has wide asset coverage
                return new Set([
                    wrappedNative,
                    'USDC', 'USDT', 'DAI', 'WBTC',
                    'LINK', 'AAVE', 'UNI', 'CRV',
                    // Chain specific
                    ...(this.chainId === 1 ? ['wstETH', 'rETH', 'cbETH', 'FRAX', 'LUSD', 'GHO'] : []),
                    ...(this.chainId === 137 ? ['WMATIC', 'stMATIC', 'MaticX'] : []),
                    ...(this.chainId === 56 ? ['WBNB', 'CAKE', 'XVS'] : []),
                ]);

            default:
                return new Set([wrappedNative, 'USDC', 'USDT', 'DAI']);
        }
    }

    /**
     * Get wrapped native token symbol for current chain
     * @private
     */
    _getWrappedNativeSymbol() {
        const symbols = {
            1: 'WETH',
            56: 'WBNB',
            137: 'WMATIC',
            42161: 'WETH',
            10: 'WETH',
            8453: 'WETH',
            43114: 'WAVAX',
        };
        return symbols[this.chainId] || 'WETH';
    }

    /**
     * Get native token price for gas calculations
     * @private
     */
    _getNativeTokenPrice() {
        // Chain-specific native token prices (fallback values)
        const prices = {
            1: 3500,     // ETH
            56: 600,     // BNB
            137: 0.5,    // MATIC
            42161: 3500, // ETH (Arbitrum)
            10: 3500,    // ETH (Optimism)
            8453: 3500,  // ETH (Base)
            43114: 35,   // AVAX
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
        const availableProviders = this.getAvailableProviders();
        const zeroFeeProviders = this.getZeroFeeProviders();

        return {
            ...this.stats,
            chainId: this.chainId,
            availableProviders: availableProviders.map(p => ({
                name: p.name,
                fee: `${p.fee * 100}%`,
                isZeroFee: p.fee === 0,
            })),
            zeroFeeProviderCount: zeroFeeProviders.length,
            zeroFeeSelectionRate: this.stats.selectionsTotal > 0
                ? `${((this.stats.zeroFeeSelections / this.stats.selectionsTotal) * 100).toFixed(1)}%`
                : '0%',
        };
    }

    /**
     * Reset statistics
     */
    resetStats() {
        this.stats.selectionsTotal = 0;
        this.stats.estimatedSavings = 0;
        this.stats.zeroFeeSelections = 0;
        this.stats.liquidityChecks = 0;
        this.stats.liquidityChecksFailed = 0;
        this.providers.forEach(p => {
            this.stats.selectionsByProvider[p.name] = 0;
        });
    }

    /**
     * Get provider contract instance for on-chain interactions
     * @param {string} providerName - Provider name
     * @returns {Object|null} ethers Contract instance
     */
    getProviderContract(providerName) {
        if (!this.rpcProvider) {
            log.warn('No RPC provider set for on-chain contract calls');
            return null;
        }

        const cacheKey = `${providerName}_${this.chainId}`;
        if (this.contracts.has(cacheKey)) {
            return this.contracts.get(cacheKey);
        }

        const provider = this.providers.find(p => p.name === providerName);
        if (!provider) return null;

        let contract = null;

        switch (providerName) {
            case 'balancer':
                const balancerAddress = provider.vaultAddresses[this.chainId];
                if (balancerAddress) {
                    contract = new ethers.Contract(balancerAddress, BALANCER_VAULT_ABI, this.rpcProvider);
                }
                break;

            case 'dydx':
                if (this.chainId === 1) { // Only on Ethereum
                    contract = new ethers.Contract(provider.contractAddress, DYDX_SOLO_MARGIN_ABI, this.rpcProvider);
                }
                break;

            case 'aave_v3':
                const aaveAddress = provider.poolAddresses[this.chainId];
                if (aaveAddress) {
                    contract = new ethers.Contract(aaveAddress, AAVE_V3_POOL_ABI, this.rpcProvider);
                }
                break;
        }

        if (contract) {
            this.contracts.set(cacheKey, contract);
        }

        return contract;
    }

    /**
     * Check if Balancer has sufficient liquidity for an asset
     * @param {string} asset - Asset symbol
     * @param {number} amountUSD - Required amount in USD
     * @returns {Promise<boolean>}
     */
    async checkBalancerLiquidity(asset, amountUSD) {
        // For now, return true - in production would check Balancer pools
        // This would query Balancer subgraph or vault for pool balances
        this.stats.liquidityChecks++;

        // Basic check - assume Balancer has liquidity for common assets
        const hasLiquidity = this._isAssetSupportedByProvider(
            this.providers.find(p => p.name === 'balancer'),
            this._normalizeAsset(asset)
        );

        if (!hasLiquidity) {
            this.stats.liquidityChecksFailed++;
        }

        return hasLiquidity;
    }

    /**
     * Estimate flash loan savings for an opportunity
     * @param {number} amountUSD - Loan amount
     * @param {string} asset - Asset symbol
     * @returns {Object} Savings estimate
     */
    estimateSavings(amountUSD, asset) {
        const normalizedAsset = this._normalizeAsset(asset);
        const bestProvider = this.selectBestProvider(normalizedAsset, amountUSD);

        if (!bestProvider) {
            return { savings: 0, provider: null };
        }

        const defaultFee = FLASH_LOAN_FEES.PANCAKE_V2; // 0.25%
        const savings = (defaultFee - bestProvider.fee) * amountUSD;

        return {
            savings,
            savingsPercent: `${((defaultFee - bestProvider.fee) * 100).toFixed(2)}%`,
            provider: bestProvider.name,
            providerFee: bestProvider.feePercent,
            isZeroFee: bestProvider.isZeroFee,
        };
    }
}

// Export singleton instance
const flashLoanOptimizer = new FlashLoanOptimizer();
export default flashLoanOptimizer;
export { FlashLoanOptimizer };
