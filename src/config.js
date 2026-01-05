import dotenv from 'dotenv';
import { top100Tokens } from './data/tokenList.js';

dotenv.config();

export default {
  // Global Settings
  debugMode: process.env.DEBUG_MODE === 'false',
  dynamicGas: process.env.DYNAMIC_GAS === 'true',
  // Network Configuration
  network: {
    name: 'BSC Mainnet',
    chainId: 56,
    blockTime: 3000, // 3 seconds average
  },

  // RPC Configuration
  rpc: {
    // Alchemy Priority Endpoints
    alchemy: {
      http: process.env.ALCHEMY_RPC_URL || '',
      ws: process.env.ALCHEMY_WS_URL || '',
    },

    http: [
      process.env.ALCHEMY_RPC_URL,
      ...(process.env.RPC_ENDPOINTS ||
        'https://bsc-dataseed.binance.org,' +
        'https://bsc-dataseed1.defibit.io,' +
        'https://bsc-dataseed1.ninicoin.io,' +
        'https://bsc.publicnode.com,' +
        'https://bsc-rpc.publicnode.com'
      ).split(',')
    ].filter(Boolean).map(url => url.trim()),

    ws: [
      process.env.ALCHEMY_WS_URL,
      ...(process.env.WS_ENDPOINTS || 'wss://bsc.publicnode.com').split(',')
    ].filter(Boolean).map(url => url.trim()),

    // Rate limit settings
    maxRequestsPerMinute: parseInt(process.env.MAX_RPC_RPM || '300'),
    requestDelay: 50, // Reduced from 150ms for performance
    retryAttempts: 5,
    retryDelay: 1000, // ms
  },

  // DEX Configurations - Optimized for Profitability
  dex: {
    pancakeswap: {
      name: 'PancakeSwap',
      router: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
      factory: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
      fee: 0.0025, // 0.25% (V2 Standard)
      enabled: true,
    },
    biswap: {
      name: 'Biswap',
      router: '0x3a6d8CA2b07040D826A7E02798e0964253350dD8',
      factory: '0x858E3312ed3A876947EA49d572A7C42DE08af7EE',
      fee: 0.002, // 0.2% (Updated V2 fee)
      enabled: true,
    },
    babyswap: {
      name: 'BabySwap',
      router: '0x325E343f1dE602396E256B67eFd1F61C3A6B38Bd',
      factory: '0x86407bEa2078ea5f5EB5A52B2caA963bC1F889Da',
      fee: 0.003, // 0.3%
      enabled: true,
    },
    apeswap: {
      name: 'ApeSwap',
      router: '0xcF0feBd3f17CEf5b47b0cD257aCf6025c5BFf3b7',
      factory: '0x0841BD0B734E4F5853f0dD8d7Ea041c241fb0Da6',
      fee: 0.002, // 0.2%
      enabled: true, // Re-enabled for more opportunities
    },
    mdex: {
      name: 'MDEX',
      router: '0x7DAe51BD3E3376B8c7c4900E9107f12Be3AF1bA8',
      factory: '0x3CD1C46068dAEa5Ebb0d3f55F6915B10648062B8',
      fee: 0.003, // 0.3%
      enabled: true,
    },
    knightswap: {
      name: 'KnightSwap',
      router: '0x05E61E0cDcD2170a76F9568a110CEe3AFdD6c46f',
      factory: '0xf0bc2E21a76513aa7CC2730C7A1D6deE0790751f',
      fee: 0.002, // 0.2%
      enabled: true,
    },
    sushiswap: {
      name: 'SushiSwap',
      router: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
      factory: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
      fee: 0.003, // 0.3%
      enabled: true,
    },
  },

  // Token Addresses (BSC Mainnet) - Scaling to top 100
  tokens: top100Tokens,

  // Base assets for pairing (everything will be paired against these)
  baseTokens: [
    'WBNB',
    'USDT',
    'BUSD',
    'USDC',
    'ETH',
    'BTCB'
  ],

  // Trading Parameters
  trading: {
    minProfitPercentage: parseFloat(process.env.MIN_PROFIT_PERCENTAGE || '0.5'),
    maxSlippage: parseFloat(process.env.MAX_SLIPPAGE || '1.0'),
    gasPriceGwei: parseInt(process.env.GAS_PRICE_GWEI || '5'),
    estimatedGasLimit: 300000, // Estimated gas for swap
  },

  // Monitoring Configuration
  monitoring: {
    maxPairsToMonitor: parseInt(process.env.MAX_PAIRS_TO_MONITOR || '100'), // Increased for 100 tokens
    cacheSize: parseInt(process.env.CACHE_SIZE || '5000'), // Increased for larger state
    blockProcessingTimeout: parseInt(process.env.BLOCK_PROCESSING_TIMEOUT_MS || '5000'),
  },

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

    // Alert thresholds
    minProfitForAlert: parseFloat(process.env.MIN_PROFIT_PERCENTAGE || '0.5'),
    cooldownMs: 60000, // 1 minute cooldown per pair to avoid spam
  },

  // Logging Configuration
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    toFile: process.env.LOG_TO_FILE === 'true',
    directory: 'logs',
  },

  // Environment
  env: process.env.NODE_ENV || 'development',
  isDevelopment: process.env.NODE_ENV !== 'production',
  isProduction: process.env.NODE_ENV === 'production',
};
