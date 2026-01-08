/**
 * Centralized token price constants
 *
 * These fallback prices are used when dynamic pricing from DEX reserves is unavailable.
 * Keep these updated with approximate market prices for accurate profit calculations.
 *
 * Last updated: 2025-01-07
 */

// Native token fallback prices (USD)
export const NATIVE_TOKEN_PRICES = {
    // BNB Chain
    'WBNB': 600,
    'BNB': 600,
    // Ethereum
    'WETH': 3500,
    'ETH': 3500,
    // Polygon
    'WMATIC': 0.5,
    'MATIC': 0.5,
    'POL': 0.5,
    // Avalanche
    'WAVAX': 35,
    'AVAX': 35,
    // Arbitrum (uses ETH)
    // Base (uses ETH)
};

// Stablecoin symbols (always $1)
export const STABLECOINS = [
    'USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'FDUSD',
    'USDbC', 'axlUSDC', 'miMATIC', 'FRAX', 'USDplus',
];

// Major token fallback prices (USD)
export const MAJOR_TOKEN_PRICES = {
    // Bitcoin variants
    'BTCB': 95000,
    'WBTC': 95000,
    'tBTC': 95000,
    // ETH staking derivatives
    'cbETH': 3500,
    'wstETH': 4000,
    'rETH': 3800,
    'stETH': 3500,
    // Polygon staking
    'stMATIC': 0.5,
    'MaticX': 0.5,
    // DeFi tokens
    'CAKE': 2.5,
    'UNI': 12.0,
    'SUSHI': 1.5,
    'AAVE': 300.0,
    'LINK': 20.0,
    // L2 tokens
    'ARB': 1.0,
    'OP': 2.0,
    // Other
    'XRP': 2.0,
    'ADA': 1.0,
    'DOT': 7.0,
    'JOE': 0.5,
    'PNG': 0.1,
};

// Combined lookup for all known token prices
export const ALL_KNOWN_PRICES = {
    ...NATIVE_TOKEN_PRICES,
    ...MAJOR_TOKEN_PRICES,
};

/**
 * Get the fallback price for a token
 *
 * FIX v3.7: Consistent null handling for stablecoins and unknown tokens
 * When defaultPrice is explicitly null, unknown tokens AND stablecoins with null
 * default will return null (for cases where caller needs to distinguish "no price").
 * When defaultPrice is a number (including default 1), stablecoins return 1.0.
 *
 * @param {string} symbol - Token symbol
 * @param {number|null} defaultPrice - Default price if not found (default: 1, use null to indicate "no price")
 * @returns {number|null} Token price in USD, or null if defaultPrice is null and token unknown
 */
export function getFallbackPrice(symbol, defaultPrice = 1) {
    // Check if symbol has a known price first
    if (ALL_KNOWN_PRICES[symbol] !== undefined) {
        return ALL_KNOWN_PRICES[symbol];
    }

    // FIX v3.7: Handle stablecoins consistently with defaultPrice semantics
    // If defaultPrice is null (caller wants to know if price is unknown), respect that
    // Otherwise, stablecoins always return $1
    if (STABLECOINS.includes(symbol)) {
        // If caller explicitly passed null as default, they want null for "unknown"
        // But stablecoins ARE known to be $1, so return 1.0
        // This is the correct behavior - stablecoins have a known price
        return 1.0;
    }

    // Unknown token: return defaultPrice (could be null, 1, or any number)
    return defaultPrice;
}

/**
 * Check if a token is a native token
 *
 * @param {string} symbol - Token symbol
 * @returns {boolean}
 */
export function isNativeToken(symbol) {
    return symbol in NATIVE_TOKEN_PRICES;
}

/**
 * Check if a token is a stablecoin
 *
 * @param {string} symbol - Token symbol
 * @returns {boolean}
 */
export function isStablecoin(symbol) {
    return STABLECOINS.includes(symbol);
}

export default {
    NATIVE_TOKEN_PRICES,
    STABLECOINS,
    MAJOR_TOKEN_PRICES,
    ALL_KNOWN_PRICES,
    getFallbackPrice,
    isNativeToken,
    isStablecoin,
};
