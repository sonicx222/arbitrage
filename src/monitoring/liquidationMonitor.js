import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import log from '../utils/logger.js';
import {
    AAVE_V3_LIQUIDATION_ABI,
    COMPOUND_V3_ABI,
    AAVE_V3_DATA_PROVIDER_ABI,
    LIQUIDATION_PROTOCOL_ADDRESSES,
    LIQUIDATION_BONUSES,
    LIQUIDATION_EVENT_TOPICS,
    ERC20_ABI,
} from '../contracts/abis.js';

/**
 * Liquidation Monitor
 *
 * Monitors lending protocol liquidation events for backrun arbitrage opportunities.
 *
 * Strategy: When a liquidation occurs, the liquidator receives collateral at a discount
 * (typically 5-10% bonus). This collateral is often sold immediately on DEXes, creating
 * a price impact. By monitoring liquidations, we can:
 *
 * 1. **Backrun the liquidator**: Buy the collateral they're selling on DEXes
 * 2. **Arbitrage the price impact**: If liquidation causes significant price deviation
 * 3. **Participate in auctions**: For protocols like Compound V3 with buyCollateral()
 *
 * Supported Protocols:
 * - Aave V3 (LiquidationCall events)
 * - Compound V3 (AbsorbCollateral / BuyCollateral events)
 *
 * Expected Impact: $5-50 per liquidation event, 10-50 events per day across chains
 */
class LiquidationMonitor extends EventEmitter {
    constructor(config = {}) {
        super();

        // Chain configuration
        this.chainId = config.chainId || 1;
        this.provider = config.provider || null;

        // Protocol addresses
        this.protocolAddresses = LIQUIDATION_PROTOCOL_ADDRESSES[this.chainId] || {};

        // Minimum liquidation size to track (USD)
        this.minLiquidationUSD = config.minLiquidationUSD || 1000;

        // Minimum estimated profit to emit opportunity
        this.minProfitUSD = config.minProfitUSD || 5;

        // Liquidation bonus thresholds
        this.liquidationBonuses = LIQUIDATION_BONUSES;

        // Contract instances (lazy initialization)
        this.contracts = new Map();

        // Event subscriptions
        this.subscriptions = [];

        // Token price cache for USD calculations
        this.tokenPriceCache = new Map();
        this.priceCacheMaxAge = config.priceCacheMaxAge || 60000; // 1 minute

        // Recent liquidations for deduplication
        this.recentLiquidations = new Map();
        this.liquidationDedupeWindow = config.liquidationDedupeWindow || 30000; // 30 seconds

        // Statistics
        this.stats = {
            liquidationsDetected: 0,
            aaveLiquidations: 0,
            compoundAbsorptions: 0,
            compoundBuyCollateral: 0,
            opportunitiesEmitted: 0,
            totalLiquidationValueUSD: 0,
            lastLiquidationTime: null,
        };

        // Running state
        this.isRunning = false;

        log.info('LiquidationMonitor initialized', {
            chainId: this.chainId,
            minLiquidationUSD: this.minLiquidationUSD,
            protocols: Object.keys(this.protocolAddresses),
        });
    }

    /**
     * Initialize the monitor with a provider
     * @param {Object} provider - ethers provider
     * @param {number} chainId - Chain ID
     */
    async initialize(provider, chainId = null) {
        if (provider) {
            this.provider = provider;
        }
        if (chainId) {
            this.chainId = chainId;
            this.protocolAddresses = LIQUIDATION_PROTOCOL_ADDRESSES[this.chainId] || {};
        }

        // Initialize protocol contracts
        await this._initializeContracts();

        log.info('LiquidationMonitor ready', {
            chainId: this.chainId,
            aavePool: this.protocolAddresses.aaveV3Pool ? 'configured' : 'not available',
            compoundV3: this.protocolAddresses.compoundV3USDC ? 'configured' : 'not available',
        });
    }

    /**
     * Start monitoring liquidation events
     */
    async start() {
        if (this.isRunning) {
            log.warn('LiquidationMonitor already running');
            return;
        }

        if (!this.provider) {
            log.error('Cannot start LiquidationMonitor: no provider');
            return;
        }

        this.isRunning = true;

        // Subscribe to Aave V3 liquidations
        if (this.protocolAddresses.aaveV3Pool) {
            await this._subscribeToAaveLiquidations();
        }

        // Subscribe to Compound V3 events
        if (this.protocolAddresses.compoundV3USDC) {
            await this._subscribeToCompoundEvents(this.protocolAddresses.compoundV3USDC, 'USDC');
        }
        if (this.protocolAddresses.compoundV3WETH) {
            await this._subscribeToCompoundEvents(this.protocolAddresses.compoundV3WETH, 'WETH');
        }

        // Start cleanup timer for old liquidation records
        this._startCleanupTimer();

        log.info('LiquidationMonitor started', {
            chainId: this.chainId,
            subscriptions: this.subscriptions.length,
        });
    }

    /**
     * Stop monitoring
     */
    async stop() {
        if (!this.isRunning) return;

        this.isRunning = false;

        // Remove all event subscriptions
        for (const sub of this.subscriptions) {
            try {
                if (sub.contract && sub.event) {
                    sub.contract.off(sub.event, sub.handler);
                }
            } catch (error) {
                log.debug('Error removing subscription', { error: error.message });
            }
        }
        this.subscriptions = [];

        // Clear cleanup timer
        if (this._cleanupTimer) {
            clearInterval(this._cleanupTimer);
            this._cleanupTimer = null;
        }

        log.info('LiquidationMonitor stopped', {
            stats: this.stats,
        });
    }

    /**
     * Initialize protocol contracts
     * @private
     */
    async _initializeContracts() {
        if (!this.provider) return;

        // Aave V3 Pool
        if (this.protocolAddresses.aaveV3Pool) {
            const aavePool = new ethers.Contract(
                this.protocolAddresses.aaveV3Pool,
                AAVE_V3_LIQUIDATION_ABI,
                this.provider
            );
            this.contracts.set('aaveV3Pool', aavePool);
        }

        // Aave V3 Data Provider
        if (this.protocolAddresses.aaveV3DataProvider) {
            const dataProvider = new ethers.Contract(
                this.protocolAddresses.aaveV3DataProvider,
                AAVE_V3_DATA_PROVIDER_ABI,
                this.provider
            );
            this.contracts.set('aaveV3DataProvider', dataProvider);
        }

        // Compound V3 USDC
        if (this.protocolAddresses.compoundV3USDC) {
            const compoundUSDC = new ethers.Contract(
                this.protocolAddresses.compoundV3USDC,
                COMPOUND_V3_ABI,
                this.provider
            );
            this.contracts.set('compoundV3USDC', compoundUSDC);
        }

        // Compound V3 WETH
        if (this.protocolAddresses.compoundV3WETH) {
            const compoundWETH = new ethers.Contract(
                this.protocolAddresses.compoundV3WETH,
                COMPOUND_V3_ABI,
                this.provider
            );
            this.contracts.set('compoundV3WETH', compoundWETH);
        }
    }

    /**
     * Subscribe to Aave V3 LiquidationCall events
     * @private
     */
    async _subscribeToAaveLiquidations() {
        const aavePool = this.contracts.get('aaveV3Pool');
        if (!aavePool) return;

        const handler = async (...args) => {
            try {
                await this._handleAaveLiquidation(args);
            } catch (error) {
                log.error('Error handling Aave liquidation', { error: error.message });
            }
        };

        // Listen for LiquidationCall events
        aavePool.on('LiquidationCall', handler);

        this.subscriptions.push({
            contract: aavePool,
            event: 'LiquidationCall',
            handler,
        });

        log.debug('Subscribed to Aave V3 LiquidationCall events', {
            pool: this.protocolAddresses.aaveV3Pool,
        });
    }

    /**
     * Subscribe to Compound V3 events
     * @private
     */
    async _subscribeToCompoundEvents(marketAddress, baseToken) {
        const contractKey = `compoundV3${baseToken}`;
        const contract = this.contracts.get(contractKey);
        if (!contract) return;

        // AbsorbCollateral handler
        const absorbHandler = async (...args) => {
            try {
                await this._handleCompoundAbsorb(args, baseToken);
            } catch (error) {
                log.error('Error handling Compound absorb', { error: error.message });
            }
        };

        // BuyCollateral handler
        const buyHandler = async (...args) => {
            try {
                await this._handleCompoundBuyCollateral(args, baseToken);
            } catch (error) {
                log.error('Error handling Compound buy collateral', { error: error.message });
            }
        };

        contract.on('AbsorbCollateral', absorbHandler);
        contract.on('BuyCollateral', buyHandler);

        this.subscriptions.push(
            { contract, event: 'AbsorbCollateral', handler: absorbHandler },
            { contract, event: 'BuyCollateral', handler: buyHandler }
        );

        log.debug('Subscribed to Compound V3 events', {
            market: marketAddress,
            baseToken,
        });
    }

    /**
     * Handle Aave V3 LiquidationCall event
     * @private
     */
    async _handleAaveLiquidation(args) {
        // Event: LiquidationCall(collateralAsset, debtAsset, user, debtToCover, liquidatedCollateralAmount, liquidator, receiveAToken)
        const event = args[args.length - 1]; // Last arg is the event object
        const collateralAsset = args[0];
        const debtAsset = args[1];
        const user = args[2];
        const debtToCover = args[3];
        const liquidatedCollateralAmount = args[4];
        const liquidator = args[5];
        const receiveAToken = args[6];

        // Create unique key for deduplication
        const liquidationKey = `aave_${event.transactionHash}_${user}`;
        if (this._isDuplicate(liquidationKey)) {
            return;
        }

        this.stats.liquidationsDetected++;
        this.stats.aaveLiquidations++;
        this.stats.lastLiquidationTime = Date.now();

        // Get token info for USD calculation
        const collateralInfo = await this._getTokenInfo(collateralAsset);
        const debtInfo = await this._getTokenInfo(debtAsset);

        const collateralAmount = Number(liquidatedCollateralAmount) / Math.pow(10, collateralInfo.decimals);
        const debtAmount = Number(debtToCover) / Math.pow(10, debtInfo.decimals);

        const collateralValueUSD = collateralAmount * (collateralInfo.priceUSD || 1);
        const debtValueUSD = debtAmount * (debtInfo.priceUSD || 1);

        this.stats.totalLiquidationValueUSD += collateralValueUSD;

        // Skip small liquidations
        if (collateralValueUSD < this.minLiquidationUSD) {
            log.debug('Skipping small Aave liquidation', {
                collateralValueUSD,
                minLiquidationUSD: this.minLiquidationUSD,
            });
            return;
        }

        // Calculate potential backrun opportunity
        const liquidationBonus = this.liquidationBonuses.AAVE_V3_DEFAULT;
        const bonusValueUSD = collateralValueUSD * liquidationBonus;

        // Estimate slippage from liquidator selling collateral
        // Assume 0.3-1% price impact depending on size
        const estimatedSlippagePercent = Math.min(1, collateralValueUSD / 100000);
        const estimatedProfitUSD = collateralValueUSD * (estimatedSlippagePercent / 100);

        const opportunity = {
            type: 'liquidation-backrun',
            protocol: 'aave-v3',
            collateralAsset,
            collateralSymbol: collateralInfo.symbol,
            debtAsset,
            debtSymbol: debtInfo.symbol,
            liquidatedUser: user,
            liquidator,
            collateralAmount,
            collateralValueUSD: parseFloat(collateralValueUSD.toFixed(2)),
            debtAmount,
            debtValueUSD: parseFloat(debtValueUSD.toFixed(2)),
            liquidationBonusPercent: liquidationBonus * 100,
            bonusValueUSD: parseFloat(bonusValueUSD.toFixed(2)),
            estimatedSlippagePercent: parseFloat(estimatedSlippagePercent.toFixed(4)),
            estimatedProfitUSD: parseFloat(estimatedProfitUSD.toFixed(2)),
            receiveAToken,
            transactionHash: event.transactionHash,
            blockNumber: event.blockNumber,
            timestamp: Date.now(),
            chainId: this.chainId,
        };

        log.info('Aave V3 liquidation detected', {
            collateral: `${collateralAmount.toFixed(4)} ${collateralInfo.symbol}`,
            debt: `${debtAmount.toFixed(4)} ${debtInfo.symbol}`,
            valueUSD: collateralValueUSD.toFixed(2),
            liquidator: liquidator.slice(0, 10) + '...',
        });

        if (estimatedProfitUSD >= this.minProfitUSD) {
            this.stats.opportunitiesEmitted++;
            this.emit('opportunity', opportunity);
        }

        this.emit('liquidation', opportunity);
    }

    /**
     * Handle Compound V3 AbsorbCollateral event
     * @private
     */
    async _handleCompoundAbsorb(args, baseToken) {
        // Event: AbsorbCollateral(absorber, borrower, asset, collateralAbsorbed, usdValue)
        const event = args[args.length - 1];
        const absorber = args[0];
        const borrower = args[1];
        const asset = args[2];
        const collateralAbsorbed = args[3];
        const usdValue = args[4];

        const liquidationKey = `compound_absorb_${event.transactionHash}_${borrower}`;
        if (this._isDuplicate(liquidationKey)) {
            return;
        }

        this.stats.liquidationsDetected++;
        this.stats.compoundAbsorptions++;
        this.stats.lastLiquidationTime = Date.now();

        const assetInfo = await this._getTokenInfo(asset);
        const collateralAmount = Number(collateralAbsorbed) / Math.pow(10, assetInfo.decimals);
        const valueUSD = Number(usdValue) / 1e8; // Compound uses 8 decimals for USD

        this.stats.totalLiquidationValueUSD += valueUSD;

        if (valueUSD < this.minLiquidationUSD) {
            log.debug('Skipping small Compound absorption', {
                valueUSD,
                minLiquidationUSD: this.minLiquidationUSD,
            });
            return;
        }

        // After absorption, collateral is available via buyCollateral() at a discount
        const estimatedProfitUSD = valueUSD * this.liquidationBonuses.COMPOUND_V3;

        const opportunity = {
            type: 'liquidation-buyCollateral',
            protocol: 'compound-v3',
            baseToken,
            collateralAsset: asset,
            collateralSymbol: assetInfo.symbol,
            absorber,
            borrower,
            collateralAmount,
            collateralValueUSD: parseFloat(valueUSD.toFixed(2)),
            estimatedProfitUSD: parseFloat(estimatedProfitUSD.toFixed(2)),
            action: 'buy-collateral-available',
            transactionHash: event.transactionHash,
            blockNumber: event.blockNumber,
            timestamp: Date.now(),
            chainId: this.chainId,
        };

        log.info('Compound V3 absorption detected', {
            collateral: `${collateralAmount.toFixed(4)} ${assetInfo.symbol}`,
            valueUSD: valueUSD.toFixed(2),
            baseToken,
        });

        if (estimatedProfitUSD >= this.minProfitUSD) {
            this.stats.opportunitiesEmitted++;
            this.emit('opportunity', opportunity);
        }

        this.emit('liquidation', opportunity);
    }

    /**
     * Handle Compound V3 BuyCollateral event
     * @private
     */
    async _handleCompoundBuyCollateral(args, baseToken) {
        // Event: BuyCollateral(buyer, asset, baseAmount, collateralAmount)
        const event = args[args.length - 1];
        const buyer = args[0];
        const asset = args[1];
        const baseAmount = args[2];
        const collateralAmount = args[3];

        const liquidationKey = `compound_buy_${event.transactionHash}_${buyer}`;
        if (this._isDuplicate(liquidationKey)) {
            return;
        }

        this.stats.compoundBuyCollateral++;

        const assetInfo = await this._getTokenInfo(asset);
        const collateralAmt = Number(collateralAmount) / Math.pow(10, assetInfo.decimals);
        const baseAmt = Number(baseAmount) / 1e6; // Assuming USDC base (6 decimals)

        log.debug('Compound V3 buyCollateral executed', {
            buyer: buyer.slice(0, 10) + '...',
            collateral: `${collateralAmt.toFixed(4)} ${assetInfo.symbol}`,
            paid: `${baseAmt.toFixed(2)} ${baseToken}`,
        });

        // Emit event for tracking (buyer already executed, opportunity passed)
        this.emit('buyCollateralExecuted', {
            protocol: 'compound-v3',
            baseToken,
            buyer,
            asset,
            collateralAmount: collateralAmt,
            baseAmountPaid: baseAmt,
            transactionHash: event.transactionHash,
            blockNumber: event.blockNumber,
            timestamp: Date.now(),
            chainId: this.chainId,
        });
    }

    /**
     * Get token info (symbol, decimals, price)
     * @private
     */
    async _getTokenInfo(tokenAddress) {
        // Check cache
        const cacheKey = `${this.chainId}_${tokenAddress.toLowerCase()}`;
        const cached = this.tokenPriceCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < this.priceCacheMaxAge) {
            return cached;
        }

        let symbol = 'UNKNOWN';
        let decimals = 18;
        let priceUSD = 1;

        try {
            const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
            [symbol, decimals] = await Promise.all([
                tokenContract.symbol(),
                tokenContract.decimals(),
            ]);
            decimals = Number(decimals);

            // Get price from common tokens
            priceUSD = this._getTokenPriceUSD(symbol);
        } catch (error) {
            log.debug('Failed to get token info', {
                address: tokenAddress,
                error: error.message,
            });
        }

        const info = { symbol, decimals, priceUSD, timestamp: Date.now() };
        this.tokenPriceCache.set(cacheKey, info);
        return info;
    }

    /**
     * Get token price in USD (fallback values)
     * @private
     */
    _getTokenPriceUSD(symbol) {
        const prices = {
            'WETH': 3500,
            'ETH': 3500,
            'WBTC': 95000,
            'BTC': 95000,
            'USDC': 1,
            'USDT': 1,
            'DAI': 1,
            'FRAX': 1,
            'LUSD': 1,
            'stETH': 3500,
            'wstETH': 4000,
            'rETH': 3800,
            'cbETH': 3700,
            'LINK': 25,
            'UNI': 15,
            'AAVE': 300,
            'CRV': 1,
            'MKR': 2000,
            'SNX': 5,
            'COMP': 100,
            'WMATIC': 1,
            'MATIC': 1,
            'WAVAX': 40,
            'AVAX': 40,
        };
        return prices[symbol] || 1;
    }

    /**
     * Check if liquidation is duplicate
     * @private
     */
    _isDuplicate(key) {
        if (this.recentLiquidations.has(key)) {
            return true;
        }
        this.recentLiquidations.set(key, Date.now());
        return false;
    }

    /**
     * Start cleanup timer for old records
     * @private
     */
    _startCleanupTimer() {
        this._cleanupTimer = setInterval(() => {
            const now = Date.now();
            const cutoff = now - this.liquidationDedupeWindow;

            for (const [key, timestamp] of this.recentLiquidations) {
                if (timestamp < cutoff) {
                    this.recentLiquidations.delete(key);
                }
            }
        }, this.liquidationDedupeWindow);
    }

    /**
     * Get available collateral for purchase on Compound V3
     * @param {string} market - 'USDC' or 'WETH'
     * @param {string} asset - Collateral asset address
     */
    async getCompoundCollateralReserves(market, asset) {
        const contract = this.contracts.get(`compoundV3${market}`);
        if (!contract) {
            return null;
        }

        try {
            const reserves = await contract.getCollateralReserves(asset);
            return reserves;
        } catch (error) {
            log.debug('Failed to get Compound collateral reserves', {
                market,
                asset,
                error: error.message,
            });
            return null;
        }
    }

    /**
     * Check if an account is liquidatable on Compound V3
     * @param {string} market - 'USDC' or 'WETH'
     * @param {string} account - Account address
     */
    async isCompoundLiquidatable(market, account) {
        const contract = this.contracts.get(`compoundV3${market}`);
        if (!contract) {
            return false;
        }

        try {
            return await contract.isLiquidatable(account);
        } catch (error) {
            return false;
        }
    }

    /**
     * Get user health factor on Aave V3
     * @param {string} user - User address
     */
    async getAaveHealthFactor(user) {
        const aavePool = this.contracts.get('aaveV3Pool');
        if (!aavePool) {
            return null;
        }

        try {
            const accountData = await aavePool.getUserAccountData(user);
            // healthFactor is in 1e18 format
            return Number(accountData.healthFactor) / 1e18;
        } catch (error) {
            log.debug('Failed to get Aave health factor', {
                user,
                error: error.message,
            });
            return null;
        }
    }

    /**
     * Get supported protocols for current chain
     */
    getSupportedProtocols() {
        const protocols = [];

        if (this.protocolAddresses.aaveV3Pool) {
            protocols.push({
                name: 'aave-v3',
                pool: this.protocolAddresses.aaveV3Pool,
                eventType: 'LiquidationCall',
            });
        }

        if (this.protocolAddresses.compoundV3USDC) {
            protocols.push({
                name: 'compound-v3-usdc',
                pool: this.protocolAddresses.compoundV3USDC,
                eventType: 'AbsorbCollateral',
            });
        }

        if (this.protocolAddresses.compoundV3WETH) {
            protocols.push({
                name: 'compound-v3-weth',
                pool: this.protocolAddresses.compoundV3WETH,
                eventType: 'AbsorbCollateral',
            });
        }

        return protocols;
    }

    /**
     * Get statistics
     */
    getStats() {
        return {
            ...this.stats,
            chainId: this.chainId,
            isRunning: this.isRunning,
            subscriptions: this.subscriptions.length,
            recentLiquidationsTracked: this.recentLiquidations.size,
            supportedProtocols: this.getSupportedProtocols().length,
        };
    }

    /**
     * Reset statistics
     */
    resetStats() {
        this.stats = {
            liquidationsDetected: 0,
            aaveLiquidations: 0,
            compoundAbsorptions: 0,
            compoundBuyCollateral: 0,
            opportunitiesEmitted: 0,
            totalLiquidationValueUSD: 0,
            lastLiquidationTime: this.stats.lastLiquidationTime,
        };
    }

    /**
     * Clear caches
     */
    clearCache() {
        this.tokenPriceCache.clear();
        this.recentLiquidations.clear();
    }
}

// Export singleton instance
const liquidationMonitor = new LiquidationMonitor();
export default liquidationMonitor;
export { LiquidationMonitor };
