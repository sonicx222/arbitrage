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

    // Cross-chain configuration
    crossChain: {
        enabled: process.env.CROSS_CHAIN_ENABLED === 'true',
        minProfitUSD: parseFloat(process.env.CROSS_CHAIN_MIN_PROFIT || '10'),
        maxPriceAgeMs: parseInt(process.env.CROSS_CHAIN_PRICE_AGE || '10000'),
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
export const crossChainTokens = {
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
    'WETH': {
        1: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        56: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
        137: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
        42161: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
        8453: '0x4200000000000000000000000000000000000006',
        43114: '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB',
    },
    'DAI': {
        1: '0x6B175474E89094C44Da98b954EescdeCB5BAeF36',
        56: '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3',
        137: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063',
        42161: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
        8453: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
        43114: '0xd586E7F844cEa2F87f50152665BCbc2C279D8d70',
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
