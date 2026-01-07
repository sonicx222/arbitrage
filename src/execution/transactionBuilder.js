import { ethers, parseUnits } from 'ethers';
import config from '../config.js';
import log from '../utils/logger.js';
import { FLASH_ARBITRAGE_ABI, getWrappedNativeAddress } from '../contracts/abis.js';
import cacheManager from '../data/cacheManager.js';
import gasPriceManager from '../utils/gasPriceManager.js';

/**
 * Transaction Builder
 *
 * Builds and encodes transactions for the FlashArbitrage smart contract.
 * Handles both cross-DEX and triangular arbitrage transaction construction.
 * Supports both legacy (BSC) and EIP-1559 (Ethereum, Polygon, Arbitrum, Base, Avalanche) gas pricing.
 */
class TransactionBuilder {
    constructor() {
        this.contractAddress = config.execution?.contractAddress || null;
        this.contractInterface = new ethers.Interface(FLASH_ARBITRAGE_ABI);

        // Chain configuration
        this.chainId = 56; // Default BSC
        this.provider = null;

        // Gas limit estimates
        this.gasLimits = {
            crossDex: 400000n,      // 2 swaps + flash loan overhead
            triangular: 500000n,    // 3 swaps + flash loan overhead
            buffer: 50000n,         // Safety buffer
        };

        log.info('Transaction Builder initialized', {
            contractAddress: this.contractAddress || 'not configured',
            eip1559Support: true,
        });
    }

    /**
     * Set chain configuration for proper gas pricing
     *
     * @param {number} chainId - Chain ID
     * @param {Object} provider - ethers.js provider
     */
    setChain(chainId, provider) {
        this.chainId = chainId;
        this.provider = provider;
        log.info(`Transaction Builder configured for chain ${chainId}`, {
            isEIP1559: gasPriceManager.isEIP1559Chain(chainId),
        });
    }

    /**
     * Set contract address (called after deployment)
     *
     * @param {string} address - Deployed contract address
     */
    setContractAddress(address) {
        this.contractAddress = address;
        log.info('Contract address set', { address });
    }

    /**
     * Build a cross-DEX arbitrage transaction
     *
     * @param {Object} opportunity - Cross-DEX opportunity
     * @param {BigInt|Object} gasParams - Gas price (legacy) or gas params object (EIP-1559)
     * @returns {Object} Transaction object ready for signing
     */
    buildCrossDexTx(opportunity, gasParams) {
        if (!this.contractAddress) {
            throw new Error('Contract address not configured');
        }

        const {
            buyDex,
            sellDex,
            tokenA,
            tokenB,
            optimalTradeSizeUSD,
            profitCalculation,
        } = opportunity;

        // Get token addresses
        const tokenBorrow = config.tokens[tokenB]?.address;
        const tokenTarget = config.tokens[tokenA]?.address;

        if (!tokenBorrow || !tokenTarget) {
            throw new Error(`Token addresses not found: ${tokenA}, ${tokenB}`);
        }

        // Find flash pair (borrow from PancakeSwap by default)
        const flashPair = this._findFlashPair(tokenBorrow, tokenTarget);

        // Calculate borrow amount
        const tokenBDecimals = config.tokens[tokenB]?.decimals || 18;
        const tokenPriceUSD = this._getTokenPriceUSD(tokenB);
        const borrowAmount = parseUnits(
            (optimalTradeSizeUSD / tokenPriceUSD).toFixed(tokenBDecimals),
            tokenBDecimals
        );

        // Build path: tokenB -> tokenA -> tokenB
        const path = [tokenBorrow, tokenTarget, tokenBorrow];

        // Build routers array (buy router, sell router)
        const routers = [
            config.dex[buyDex].router,
            config.dex[sellDex].router,
        ];

        // Minimum profit (in base token units) with 1% buffer
        const minProfitUSD = profitCalculation.netProfitUSD * 0.99;
        const minProfit = parseUnits(
            (minProfitUSD / tokenPriceUSD).toFixed(tokenBDecimals),
            tokenBDecimals
        );

        // Encode function call
        const data = this.contractInterface.encodeFunctionData(
            'executeCrossDexArbitrage',
            [flashPair, borrowAmount, tokenBorrow, path, routers, minProfit]
        );

        // Build base transaction
        const baseTx = {
            to: this.contractAddress,
            data,
            gasLimit: this.gasLimits.crossDex + this.gasLimits.buffer,
            value: 0n,
        };

        // Apply gas parameters (supports both legacy and EIP-1559)
        const tx = this._applyGasParams(baseTx, gasParams);

        log.debug('Built cross-DEX transaction', {
            pair: `${tokenA}/${tokenB}`,
            borrowAmount: ethers.formatUnits(borrowAmount, tokenBDecimals),
            buyDex,
            sellDex,
            minProfit: ethers.formatUnits(minProfit, tokenBDecimals),
            isEIP1559: tx.type === 2,
        });

        return tx;
    }

    /**
     * Build a triangular arbitrage transaction
     *
     * @param {Object} opportunity - Triangular opportunity
     * @param {BigInt|Object} gasParams - Gas price (legacy) or gas params object (EIP-1559)
     * @returns {Object} Transaction object ready for signing
     */
    buildTriangularTx(opportunity, gasParams) {
        if (!this.contractAddress) {
            throw new Error('Contract address not configured');
        }

        const {
            dexName,
            dexPath, // For cross-dex-triangular
            path: tokenPath,
            profitCalculation,
            type,
        } = opportunity;

        // Get token addresses for path
        const pathAddresses = tokenPath.map(symbol => {
            const address = config.tokens[symbol]?.address;
            if (!address) {
                throw new Error(`Token address not found: ${symbol}`);
            }
            return address;
        });

        const baseToken = tokenPath[0];
        const tokenBorrow = pathAddresses[0];

        // Find flash pair
        const flashPair = this._findFlashPair(tokenBorrow, pathAddresses[1]);

        // Calculate borrow amount
        const tokenDecimals = config.tokens[baseToken]?.decimals || 18;
        const tokenPriceUSD = this._getTokenPriceUSD(baseToken);
        const borrowAmount = parseUnits(
            (profitCalculation.tradeSizeUSD / tokenPriceUSD).toFixed(tokenDecimals),
            tokenDecimals
        );

        // Router(s) - for cross-dex-triangular, we need multiple routers
        let routers;
        if (type === 'cross-dex-triangular' && dexPath) {
            // Cross-DEX triangular uses different router for each hop
            routers = dexPath.map(dex => config.dex[dex]?.router).filter(Boolean);
            if (routers.length !== 3) {
                throw new Error(`Invalid dexPath: expected 3 routers, got ${routers.length}`);
            }
        } else {
            // Single-DEX triangular uses same router for all hops
            const router = config.dex[dexName]?.router;
            if (!router) {
                throw new Error(`Router not found for DEX: ${dexName}`);
            }
            routers = [router, router, router];
        }

        // Minimum profit with 1% buffer
        const minProfitUSD = profitCalculation.netProfitUSD * 0.99;
        const minProfit = parseUnits(
            (minProfitUSD / tokenPriceUSD).toFixed(tokenDecimals),
            tokenDecimals
        );

        // Encode function call
        // Note: For cross-dex-triangular, the contract needs to support multiple routers
        // If the contract only supports single router, we use the first one (legacy behavior)
        const data = this.contractInterface.encodeFunctionData(
            'executeTriangularArbitrage',
            [flashPair, borrowAmount, tokenBorrow, pathAddresses, routers[0], minProfit]
        );

        // Build base transaction
        const baseTx = {
            to: this.contractAddress,
            data,
            gasLimit: this.gasLimits.triangular + this.gasLimits.buffer,
            value: 0n,
        };

        // Apply gas parameters (supports both legacy and EIP-1559)
        const tx = this._applyGasParams(baseTx, gasParams);

        log.debug('Built triangular transaction', {
            path: tokenPath.join(' -> '),
            type,
            dex: type === 'cross-dex-triangular' ? dexPath?.join(' -> ') : dexName,
            borrowAmount: ethers.formatUnits(borrowAmount, tokenDecimals),
            minProfit: ethers.formatUnits(minProfit, tokenDecimals),
            isEIP1559: tx.type === 2,
        });

        return tx;
    }

    /**
     * Build transaction based on opportunity type
     *
     * @param {Object} opportunity - Arbitrage opportunity
     * @param {BigInt|Object} gasParams - Gas price (legacy) or gas params object (EIP-1559)
     * @returns {Object} Transaction object
     */
    build(opportunity, gasParams) {
        // Validate opportunity type
        const validTypes = ['cross-dex', 'triangular', 'cross-dex-triangular'];
        if (!validTypes.includes(opportunity.type)) {
            throw new Error(`Invalid opportunity type: ${opportunity.type}. Expected one of: ${validTypes.join(', ')}`);
        }

        if (opportunity.type === 'triangular' || opportunity.type === 'cross-dex-triangular') {
            return this.buildTriangularTx(opportunity, gasParams);
        } else {
            return this.buildCrossDexTx(opportunity, gasParams);
        }
    }

    /**
     * Build transaction with automatic gas parameter detection
     * Fetches optimal gas params based on chain type (legacy vs EIP-1559)
     *
     * @param {Object} opportunity - Arbitrage opportunity
     * @param {Object} options - Optional gas options (speed, maxGasPriceGwei)
     * @returns {Promise<Object>} Transaction object
     */
    async buildWithOptimalGas(opportunity, options = {}) {
        if (!this.provider) {
            throw new Error('Provider not set. Call setChain() first.');
        }

        const gasParams = await gasPriceManager.getGasParams(
            this.provider,
            this.chainId,
            options
        );

        return this.build(opportunity, gasParams);
    }

    /**
     * Apply gas parameters to a base transaction
     * Handles both legacy gasPrice and EIP-1559 params
     *
     * @private
     * @param {Object} baseTx - Base transaction without gas params
     * @param {BigInt|Object} gasParams - Gas price or gas params object
     * @returns {Object} Transaction with gas parameters
     */
    _applyGasParams(baseTx, gasParams) {
        const tx = { ...baseTx };

        // Check if gasParams is an EIP-1559 object or legacy BigInt
        if (typeof gasParams === 'object' && gasParams !== null) {
            // EIP-1559 gas params object
            if (gasParams.type === 2 || gasParams.maxFeePerGas) {
                tx.type = 2;
                tx.maxFeePerGas = gasParams.maxFeePerGas;
                tx.maxPriorityFeePerGas = gasParams.maxPriorityFeePerGas;
            } else {
                // Legacy params in object form
                tx.type = 0;
                tx.gasPrice = gasParams.gasPrice;
            }
        } else {
            // Legacy BigInt gasPrice
            tx.type = 0;
            tx.gasPrice = gasParams;
        }

        return tx;
    }

    /**
     * Find a flash pair to borrow from
     *
     * @private
     * @param {string} tokenA - First token address
     * @param {string} tokenB - Second token address
     * @returns {string} Pair address
     */
    _findFlashPair(tokenA, tokenB) {
        // For now, we'll need to get this from cache or calculate
        // In production, this would be fetched from cacheManager
        // Default to a common pair if not found

        // Get wrapped native address for current chain
        const wrappedNative = getWrappedNativeAddress(this.chainId);

        // If one token is the wrapped native token, use that pair
        if (tokenA.toLowerCase() === wrappedNative.toLowerCase() ||
            tokenB.toLowerCase() === wrappedNative.toLowerCase()) {
            // Return placeholder - will be resolved by executionManager
            return 'RESOLVE_PAIR';
        }

        return 'RESOLVE_PAIR';
    }

    /**
     * Get token price in USD - uses dynamic pricing from cache with fallbacks
     *
     * @private
     * @param {string} tokenSymbol - Token symbol
     * @returns {number} Price in USD
     */
    _getTokenPriceUSD(tokenSymbol) {
        // Stablecoins - always $1
        if (['USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'FDUSD'].includes(tokenSymbol)) {
            return 1.0;
        }

        // Get enabled DEX names
        const dexNames = Object.entries(config.dex)
            .filter(([_, dexConfig]) => dexConfig.enabled)
            .map(([name]) => name);

        // For native tokens, get dynamic price
        const nativeSymbols = ['WBNB', 'BNB', 'WETH', 'ETH', 'WMATIC', 'MATIC', 'WAVAX', 'AVAX'];
        if (nativeSymbols.includes(tokenSymbol)) {
            const fallbackPrices = {
                'WBNB': 600, 'BNB': 600,
                'WETH': 3500, 'ETH': 3500,
                'WMATIC': 0.5, 'MATIC': 0.5,
                'WAVAX': 35, 'AVAX': 35,
            };
            return cacheManager.getNativeTokenPrice(
                tokenSymbol,
                config.tokens,
                dexNames,
                fallbackPrices[tokenSymbol] || 1
            );
        }

        // For other tokens, try cache then fallback
        const nativePrice = cacheManager.getNativeTokenPrice('WBNB', config.tokens, dexNames, 600);
        const cachedPrice = cacheManager.getTokenPriceUSD(tokenSymbol, config.tokens, dexNames, nativePrice);

        if (cachedPrice !== null && cachedPrice > 0) {
            return cachedPrice;
        }

        // Final fallback for known tokens
        const fallbackPrices = {
            'BTCB': 95000,
            'WBTC': 95000,
            'CAKE': 2.5,
        };

        return fallbackPrices[tokenSymbol] || 1;
    }

    /**
     * Estimate gas for a transaction
     *
     * @param {Object} opportunity - Arbitrage opportunity
     * @returns {BigInt} Estimated gas
     */
    estimateGas(opportunity) {
        if (opportunity.type === 'triangular') {
            return this.gasLimits.triangular + this.gasLimits.buffer;
        }
        return this.gasLimits.crossDex + this.gasLimits.buffer;
    }

    /**
     * Decode transaction data for debugging
     *
     * @param {string} data - Transaction data
     * @returns {Object} Decoded parameters
     */
    decodeTransaction(data) {
        try {
            const decoded = this.contractInterface.parseTransaction({ data });
            return {
                name: decoded.name,
                args: decoded.args,
            };
        } catch (error) {
            log.error('Failed to decode transaction', { error: error.message });
            return null;
        }
    }
}

// Export singleton instance
const transactionBuilder = new TransactionBuilder();
export default transactionBuilder;
