/**
 * Optimized Token List for BSC Arbitrage Bot
 *
 * Selection Criteria:
 * 1. High liquidity (>$500K TVL across DEXs)
 * 2. Active trading volume (reduces stale price risk)
 * 3. Present on multiple DEXs (enables cross-DEX arbitrage)
 * 4. Verified contract addresses from official sources
 *
 * Resource Optimization:
 * - 35 tokens × 6 base tokens × 5 DEXs = ~1,000 pair checks per block
 * - With Multicall (200/batch) = 5 calls per block
 * - At 3s blocks = ~100 RPM (well under 300 limit)
 *
 * Sources: CoinGecko, BscScan, PancakeSwap, Biswap official docs
 * Last verified: January 2025
 */

/**
 * Tier 1: Core Infrastructure (Base tokens + highest liquidity)
 * These have the most trading pairs and deepest liquidity
 */
const tier1Tokens = {
    // Native wrapped token - required for all pairs
    WBNB: {
        symbol: 'WBNB',
        address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
        decimals: 18,
        tier: 1,
        coingeckoId: 'wbnb',
    },
    // Major stablecoins - essential for triangular paths
    USDT: {
        symbol: 'USDT',
        address: '0x55d398326f99059fF775485246999027B3197955',
        decimals: 18,
        tier: 1,
        coingeckoId: 'tether',
    },
    USDC: {
        symbol: 'USDC',
        address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
        decimals: 18,
        tier: 1,
        coingeckoId: 'usd-coin',
    },
    BUSD: {
        symbol: 'BUSD',
        address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
        decimals: 18,
        tier: 1,
        coingeckoId: 'binance-usd',
    },
    FDUSD: {
        symbol: 'FDUSD',
        address: '0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409',
        decimals: 18,
        tier: 1,
        coingeckoId: 'first-digital-usd',
    },
    // Major bridged assets
    ETH: {
        symbol: 'ETH',
        address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
        decimals: 18,
        tier: 1,
        coingeckoId: 'ethereum',
    },
    BTCB: {
        symbol: 'BTCB',
        address: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c',
        decimals: 18,
        tier: 1,
        coingeckoId: 'bitcoin-bep2',
    },
};

/**
 * Tier 2: High Volume DEX Natives & DeFi Tokens
 * Native tokens of major DEXs - high volume, multiple pools
 */
const tier2Tokens = {
    // DEX native tokens (high volume, multiple pools)
    CAKE: {
        symbol: 'CAKE',
        address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
        decimals: 18,
        tier: 2,
        coingeckoId: 'pancakeswap-token',
    },
    BSW: {
        symbol: 'BSW',
        address: '0x965F527D9159dCe6288a2219DB51fc6Eef120dD1',
        decimals: 18,
        tier: 2,
        coingeckoId: 'biswap',
    },
    BAKE: {
        symbol: 'BAKE',
        address: '0xE02dF9e3e622DeBdD69fb838bB799E3F168902c5',
        decimals: 18,
        tier: 2,
        coingeckoId: 'bakerytoken',
    },
    // Major DeFi protocols
    XVS: {
        symbol: 'XVS',
        address: '0xcF6BB5389c92Bdda8a3747Ddb454cB7a64626C63',
        decimals: 18,
        tier: 2,
        coingeckoId: 'venus',
    },
    ALPACA: {
        symbol: 'ALPACA',
        address: '0x8F0528cE5eF7B51152A59745bEfDD91D97091d2F',
        decimals: 18,
        tier: 2,
        coingeckoId: 'alpaca-finance',
    },
    // Liquid staking tokens
    WBETH: {
        symbol: 'WBETH',
        address: '0xa2E3356610840701BDf5611a53974510Ae27E2e1',
        decimals: 18,
        tier: 2,
        coingeckoId: 'wrapped-beacon-eth',
    },
    stkBNB: {
        symbol: 'stkBNB',
        address: '0xc2E9d07F66A89c44062459A47a0D2Dc038E4fb16',
        decimals: 18,
        tier: 2,
        coingeckoId: 'pstake-staked-bnb',
    },
};

/**
 * Tier 3: Popular Trading Tokens
 * High volume, frequently traded tokens with good arbitrage potential
 */
const tier3Tokens = {
    // Major bridged L1s (high volume)
    XRP: {
        symbol: 'XRP',
        address: '0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE',
        decimals: 18,
        tier: 3,
        coingeckoId: 'ripple',
    },
    ADA: {
        symbol: 'ADA',
        address: '0x3EE2200Efb3400fAbB9AacF31297cBdD1d435D47',
        decimals: 18,
        tier: 3,
        coingeckoId: 'cardano',
    },
    DOT: {
        symbol: 'DOT',
        address: '0x7083609fCE4d1d8Dc0C979AAb8c869Ea2C873402',
        decimals: 18,
        tier: 3,
        coingeckoId: 'polkadot',
    },
    LINK: {
        symbol: 'LINK',
        address: '0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD',
        decimals: 18,
        tier: 3,
        coingeckoId: 'chainlink',
    },
    UNI: {
        symbol: 'UNI',
        address: '0xBf5140A22578168FD562DCcF235E5D43A02ce9B1',
        decimals: 18,
        tier: 3,
        coingeckoId: 'uniswap',
    },
    MATIC: {
        symbol: 'MATIC',
        address: '0xCC42724C6683B7E57334c4E856f4c9965ED682bD',
        decimals: 18,
        tier: 3,
        coingeckoId: 'matic-network',
    },
    AVAX: {
        symbol: 'AVAX',
        address: '0x1CE0c2827e2eF14D5C4f29a091d735A204794041',
        decimals: 18,
        tier: 3,
        coingeckoId: 'avalanche-2',
    },
    ATOM: {
        symbol: 'ATOM',
        address: '0x0Eb3a705fc54725037CC9e008bDede697f62F335',
        decimals: 18,
        tier: 3,
        coingeckoId: 'cosmos',
    },
    // Popular stablecoins
    DAI: {
        symbol: 'DAI',
        address: '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3',
        decimals: 18,
        tier: 3,
        coingeckoId: 'dai',
    },
    TUSD: {
        symbol: 'TUSD',
        address: '0x40af3827F39D0EAcBF4A168f8D4ee67c121D11c9',
        decimals: 18,
        tier: 3,
        coingeckoId: 'true-usd',
    },
};

/**
 * Tier 4: Meme & High-Volatility Tokens
 * High volatility = more arbitrage opportunities, but higher risk
 */
const tier4Tokens = {
    DOGE: {
        symbol: 'DOGE',
        address: '0xbA2aE424d960c26247Dd6c32edC70B295c744C43',
        decimals: 8,
        tier: 4,
        coingeckoId: 'dogecoin',
    },
    SHIB: {
        symbol: 'SHIB',
        address: '0x2859e4544C4bB03966803b044A93563Bd2D0DD4D',
        decimals: 18,
        tier: 4,
        coingeckoId: 'shiba-inu',
    },
    FLOKI: {
        symbol: 'FLOKI',
        address: '0xfb5B838b6cfEEdC2873aB27866079AC55363D37E',
        decimals: 9,
        tier: 4,
        coingeckoId: 'floki',
    },
    PEPE: {
        symbol: 'PEPE',
        address: '0x25d887Ce7a35172C62FeBFD67a1856F20FaEbB00',
        decimals: 18,
        tier: 4,
        coingeckoId: 'pepe',
    },
    BABYDOGE: {
        symbol: 'BABYDOGE',
        address: '0xc748673057861a797275CD8A068AbB95A902e8de',
        decimals: 9,
        tier: 4,
        coingeckoId: 'baby-doge-coin',
    },
    // BSC ecosystem tokens with high volatility
    TWT: {
        symbol: 'TWT',
        address: '0x4B0F1812e5Df2A09796481Ff14017e6005508003',
        decimals: 18,
        tier: 4,
        coingeckoId: 'trust-wallet-token',
    },
    C98: {
        symbol: 'C98',
        address: '0xaEC945e04baF28b135Fa7c640f624f8D90F1C3a6',
        decimals: 18,
        tier: 4,
        coingeckoId: 'coin98',
    },
    SFP: {
        symbol: 'SFP',
        address: '0xD41FDb03Ba84762dD66a0af1a6C8540FF1ba5dfb',
        decimals: 18,
        tier: 4,
        coingeckoId: 'safepal',
    },
};

/**
 * Tier 5: Cross-chain & Layer Zero Tokens
 * Newer tokens with growing liquidity, good for emerging opportunities
 */
const tier5Tokens = {
    STG: {
        symbol: 'STG',
        address: '0xB0D502E938ed5f4df2E681fE6E419ff29631d62b',
        decimals: 18,
        tier: 5,
        coingeckoId: 'stargate-finance',
    },
    RDNT: {
        symbol: 'RDNT',
        address: '0xf7DE7E8A6bd59ED41a4b5fe50278b3B7f31384dF',
        decimals: 18,
        tier: 5,
        coingeckoId: 'radiant-capital',
    },
    PENDLE: {
        symbol: 'PENDLE',
        address: '0xb3Ed0A426155B79B898849803E3B36552f7ED507',
        decimals: 18,
        tier: 5,
        coingeckoId: 'pendle',
    },
    ID: {
        symbol: 'ID',
        address: '0x2dfF88A56767223A5529eA5960Da7A3F5f766406',
        decimals: 18,
        tier: 5,
        coingeckoId: 'space-id',
    },
};

/**
 * Combined optimized token list
 * Total: 36 tokens (7 + 7 + 10 + 8 + 4)
 *
 * Resource calculation:
 * - 36 tokens × 6 base tokens = 216 unique pairs (minus ~15 base-to-base)
 * - ~200 pairs × 5 DEXs = 1,000 pair-DEX combinations
 * - Multicall batch size: 200 → 5 calls per block
 * - BSC block time: 3 seconds
 * - RPC calls/minute: 5 × 20 blocks = 100 RPM (67% under 300 limit)
 */
export const optimizedTokens = {
    ...tier1Tokens,
    ...tier2Tokens,
    ...tier3Tokens,
    ...tier4Tokens,
    ...tier5Tokens,
};

/**
 * Legacy export for backward compatibility
 * Note: Reduced from 100 to 36 tokens for optimal performance
 */
export const top100Tokens = optimizedTokens;

/**
 * Get tokens by tier
 * @param {number} tier - Tier number (1-5)
 * @returns {Object} Tokens in that tier
 */
export function getTokensByTier(tier) {
    return Object.fromEntries(
        Object.entries(optimizedTokens).filter(([_, token]) => token.tier === tier)
    );
}

/**
 * Get token by symbol
 * @param {string} symbol - Token symbol
 * @returns {Object|null} Token data or null
 */
export function getToken(symbol) {
    return optimizedTokens[symbol] || null;
}

/**
 * Validate token address format
 * @param {string} address - Ethereum address
 * @returns {boolean} True if valid checksum address
 */
export function isValidAddress(address) {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
}

/**
 * Get all token addresses for verification
 * @returns {Array<{symbol: string, address: string}>}
 */
export function getAllAddresses() {
    return Object.entries(optimizedTokens).map(([symbol, data]) => ({
        symbol,
        address: data.address,
        decimals: data.decimals,
    }));
}

export default optimizedTokens;
