import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Import chain configurations
import bscConfig from './chains/bsc.js';
import ethereumConfig from './chains/ethereum.js';
import polygonConfig from './chains/polygon.js';
import arbitrumConfig from './chains/arbitrum.js';
import baseConfig from './chains/base.js';
import avalancheConfig from './chains/avalanche.js';

/**
 * Multi-Chain Configuration Manager
 *
 * Aggregates all chain configurations and provides global settings
 */

// Chain configurations indexed by chain ID
export const chainConfigs = {
    56: bscConfig,        // BSC
    1: ethereumConfig,    // Ethereum
    137: polygonConfig,   // Polygon
    42161: arbitrumConfig, // Arbitrum
    8453: baseConfig,     // Base
    43114: avalancheConfig, // Avalanche
};

// Chain ID to name mapping
export const chainNames = {
    56: 'BSC',
    1: 'Ethereum',
    137: 'Polygon',
    42161: 'Arbitrum',
    8453: 'Base',
    43114: 'Avalanche',
};

/**
 * Get configuration for a specific chain
 * @param {number} chainId - Chain ID
 * @returns {Object|null} Chain configuration or null
 */
export function getChainConfig(chainId) {
    return chainConfigs[chainId] || null;
}

/**
 * Get all enabled chain configurations
 * @returns {Object} Map of chainId -> config for enabled chains
 */
export function getEnabledChains() {
    const enabled = {};
    for (const [chainId, config] of Object.entries(chainConfigs)) {
        if (config.enabled) {
            enabled[chainId] = config;
        }
    }
    return enabled;
}

/**
 * Get chain IDs for all enabled chains
 * @returns {Array<number>} Array of enabled chain IDs
 */
export function getEnabledChainIds() {
    return Object.entries(chainConfigs)
        .filter(([, config]) => config.enabled)
        .map(([chainId]) => parseInt(chainId));
}

// Global settings (chain-agnostic)
export const globalConfig = {
    // Debug mode
    debugMode: process.env.DEBUG_MODE === 'true',

    // Dynamic gas pricing
    dynamicGas: process.env.DYNAMIC_GAS === 'true',

    // Alert Configuration
    alerts: {
        console: true,
        discord: !!process.env.DISCORD_WEBHOOK_URL,
        telegram: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),

        webhooks: {
            discord: process.env.DISCORD_WEBHOOK_URL,
            telegram: {
                botToken: process.env.TELEGRAM_BOT_TOKEN,
                chatId: process.env.TELEGRAM_CHAT_ID,
            },
        },

        minProfitForAlert: parseFloat(process.env.MIN_PROFIT_PERCENTAGE || '0.5'),
        cooldownMs: parseInt(process.env.ALERT_COOLDOWN_MS || '60000'),
    },

    // Logging Configuration
    logging: {
        level: process.env.LOG_LEVEL || 'info',
        toFile: process.env.LOG_TO_FILE === 'true',
        directory: 'logs',
    },

    // Worker thread configuration
    workers: {
        enabled: process.env.WORKERS_ENABLED !== 'false',
        maxWorkers: parseInt(process.env.MAX_WORKERS || '6'),
        workerTimeout: parseInt(process.env.WORKER_TIMEOUT || '30000'),
        restartDelay: parseInt(process.env.WORKER_RESTART_DELAY || '5000'),
    },

    // Cross-chain configuration - Optimized for more opportunities
    crossChain: {
        enabled: process.env.CROSS_CHAIN_ENABLED !== 'false', // Enabled by default
        minProfitUSD: parseFloat(process.env.CROSS_CHAIN_MIN_PROFIT || '5'), // Lowered from $10
        maxPriceAgeMs: parseInt(process.env.CROSS_CHAIN_PRICE_AGE || '5000'), // Fresher prices (5s)
        minSpreadPercent: parseFloat(process.env.CROSS_CHAIN_MIN_SPREAD || '0.3'), // Lowered from 0.5%
    },

    // Mempool monitoring
    mempool: {
        enabled: process.env.MEMPOOL_ENABLED === 'true',
        minSwapSizeUSD: parseFloat(process.env.MEMPOOL_MIN_SWAP_SIZE || '10000'),
    },

    // Environment
    env: process.env.NODE_ENV || 'development',
    isDevelopment: process.env.NODE_ENV !== 'production',
    isProduction: process.env.NODE_ENV === 'production',
};

// Token mappings for cross-chain arbitrage
// Expanded from 4 to 11 tokens for better cross-chain opportunity detection
export const crossChainTokens = {
    // Stablecoins - highest volume, most consistent cross-chain
    'USDC': {
        1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        56: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
        137: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
        42161: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
        8453: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        43114: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
    },
    'USDT': {
        1: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
        56: '0x55d398326f99059fF775485246999027B3197955',
        137: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
        42161: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
        43114: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7',
    },
    'DAI': {
        1: '0x6B175474E89094C44Da98b954EedeAC495F36668',
        56: '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3',
        137: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063',
        42161: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
        8453: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
        43114: '0xd586E7F844cEa2F87f50152665BCbc2C279D8d70',
    },
    // Native wrapped tokens - high volume, price discrepancies common
    'WETH': {
        1: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        56: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
        137: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
        42161: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
        8453: '0x4200000000000000000000000000000000000006',
        43114: '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB',
    },
    // Bitcoin wrapped tokens - often have cross-chain premiums
    'WBTC': {
        1: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
        56: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', // BTCB on BSC
        137: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6',
        42161: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
        43114: '0x50b7545627a5162F82A992c33b87aDc75187B218',
    },
    // DeFi blue chips - good liquidity across chains
    'LINK': {
        1: '0x514910771AF9Ca656af840dff83E8264EcF986CA',
        56: '0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD',
        137: '0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39',
        42161: '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4',
        43114: '0x5947BB275c521040051D82396192181b413227A3',
    },
    'AAVE': {
        1: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9',
        137: '0xD6DF932A45C0f255f85145f286eA0b292B21C90B',
        42161: '0xba5DdD1f9d7F570dc94a51479a000E3BCE967196',
        43114: '0x63a72806098Bd3D9520cC43356dD78afe5D386D9',
    },
    'UNI': {
        1: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
        56: '0xBf5140A22578168FD562DCcF235E5D43A02ce9B1',
        137: '0xb33EaAd8d922B1083446DC23f610c2567fB5180f',
        42161: '0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0',
    },
    'SUSHI': {
        1: '0x6B3595068778DD592e39A122f4f5a5cF09C90fE2',
        137: '0x0b3F868E0BE5597D5DB7fEB59E1CADBb0fdDa50a',
        42161: '0xd4d42F0b6DEF4CE0383636770eF773390d85c61A',
        43114: '0x37B608519F91f70F2EeB0e5Ed9AF4061722e4F76',
    },
    'CRV': {
        1: '0xD533a949740bb3306d119CC777fa900bA034cd52',
        137: '0x172370d5Cd63279eFa6d502DAB29171933a610AF',
        42161: '0x11cDb42B0EB46D95f990BeDD4695A6e3fA034978',
        43114: '0x47536F17F4fF30e64A96a7555826b8f9e66ec468',
    },
    // Liquid staking tokens - often have cross-chain price discrepancies
    'wstETH': {
        1: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0',
        42161: '0x5979D7b546E38E414F7E9822514be443A4800529',
        8453: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452',
        137: '0x03b54A6e9a984069379fae1a4fC4dBAE93B3bCCD',
    },
};

// Default export for backward compatibility with existing code
// Uses BSC config as the primary chain
export default {
    ...bscConfig,
    ...globalConfig,

    // Network (for backward compatibility)
    network: {
        name: bscConfig.name,
        chainId: bscConfig.chainId,
        blockTime: bscConfig.blockTime,
    },

    // DEX (use BSC dexes for backward compatibility)
    dex: bscConfig.dexes,

    // Tokens
    tokens: bscConfig.tokens,
    baseTokens: bscConfig.baseTokens,

    // Trading
    trading: bscConfig.trading,

    // Monitoring
    monitoring: bscConfig.monitoring,

    // RPC
    rpc: bscConfig.rpc,

    // Execution
    execution: bscConfig.execution,

    // Triangular
    triangular: bscConfig.triangular,

    // Multi-chain access
    chains: chainConfigs,
    getChainConfig,
    getEnabledChains,
    getEnabledChainIds,
    crossChainTokens,
};
