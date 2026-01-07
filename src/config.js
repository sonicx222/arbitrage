import dotenv from 'dotenv';
import { top100Tokens } from './data/tokenList.js';

dotenv.config();

export default {
  // Global Settings
  debugMode: process.env.DEBUG_MODE === 'true',
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
  // Reduced to 5 DEXs to stay within rate limits while maximizing arbitrage potential
  // Selection criteria: TVL, trading volume, pair coverage
  dex: {
    // Tier 1: Highest liquidity DEXs (must have)
    pancakeswap: {
      name: 'PancakeSwap',
      router: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
      factory: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
      fee: 0.0025, // 0.25% (V2 Standard)
      enabled: true,
      tvlRank: 1, // ~$1.5B TVL
    },
    biswap: {
      name: 'Biswap',
      router: '0x3a6d8CA2b07040D826A7E02798e0964253350dD8',
      factory: '0x858E3312ed3A876947EA49d572A7C42DE08af7EE',
      fee: 0.001, // 0.1% (lower fee = better for arbitrage)
      enabled: true,
      tvlRank: 2, // ~$100M TVL
    },
    // Tier 2: Good liquidity, different fee structures
    apeswap: {
      name: 'ApeSwap',
      router: '0xcF0feBd3f17CEf5b47b0cD257aCf6025c5BFf3b7',
      factory: '0x0841BD0B734E4F5853f0dD8d7Ea041c241fb0Da6',
      fee: 0.002, // 0.2%
      enabled: true,
      tvlRank: 3, // ~$50M TVL
    },
    babyswap: {
      name: 'BabySwap',
      router: '0x325E343f1dE602396E256B67eFd1F61C3A6B38Bd',
      factory: '0x86407bEa2078ea5f5EB5A52B2caA963bC1F889Da',
      fee: 0.003, // 0.3%
      enabled: true,
      tvlRank: 4, // ~$30M TVL
    },
    mdex: {
      name: 'MDEX',
      router: '0x7DAe51BD3E3376B8c7c4900E9107f12Be3AF1bA8',
      factory: '0x3CD1C46068dAEa5Ebb0d3f55F6915B10648062B8',
      fee: 0.003, // 0.3%
      enabled: true,
      tvlRank: 5, // ~$20M TVL
    },
    // Tier 3: Lower liquidity (disabled by default to save resources)
    knightswap: {
      name: 'KnightSwap',
      router: '0x05E61E0cDcD2170a76F9568a110CEe3AFdD6c46f',
      factory: '0xf0bc2E21a76513aa7CC2730C7A1D6deE0790751f',
      fee: 0.002, // 0.2%
      enabled: false, // Disabled - lower liquidity
      tvlRank: 6,
    },
    sushiswap: {
      name: 'SushiSwap',
      router: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
      factory: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
      fee: 0.003, // 0.3%
      enabled: false, // Disabled - lower BSC liquidity
      tvlRank: 7,
    },
  },

  // Token Addresses (BSC Mainnet) - Optimized selection of 36 high-liquidity tokens
  tokens: top100Tokens,

  // Base assets for pairing (everything will be paired against these)
  // 6 base tokens provide good triangular arbitrage paths
  baseTokens: [
    'WBNB',   // Native token - required
    'USDT',   // Primary stablecoin
    'BUSD',   // Binance stablecoin
    'USDC',   // Circle stablecoin
    'ETH',    // Bridged ETH - high volume
    'BTCB',   // Bridged BTC - high volume
  ],

  // Trading Parameters
  trading: {
    minProfitPercentage: parseFloat(process.env.MIN_PROFIT_PERCENTAGE || '0.5'),
    maxSlippage: parseFloat(process.env.MAX_SLIPPAGE || '1.0'),
    gasPriceGwei: parseInt(process.env.GAS_PRICE_GWEI || '5'),
    estimatedGasLimit: 350000, // Estimated gas for flash loan + swaps
    // Trade size limits (USD)
    minTradeSizeUSD: parseFloat(process.env.MIN_TRADE_SIZE_USD || '10'),
    maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || '5000'),
  },

  // Monitoring Configuration
  // Optimized for 36 tokens × 6 bases × 5 DEXs = ~1,000 pairs
  monitoring: {
    maxPairsToMonitor: parseInt(process.env.MAX_PAIRS_TO_MONITOR || '250'), // Optimized for 36 tokens
    cacheSize: parseInt(process.env.CACHE_SIZE || '2000'), // Reduced for lower token count
    blockProcessingTimeout: parseInt(process.env.BLOCK_PROCESSING_TIMEOUT_MS || '2500'), // Faster timeout
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

  // Execution Configuration (Flash Loan Arbitrage)
  execution: {
    // Enable/disable actual execution (false = detection only)
    enabled: process.env.EXECUTION_ENABLED === 'true',

    // Execution mode: 'simulation' (eth_call only) or 'live' (real transactions)
    mode: process.env.EXECUTION_MODE || 'simulation',

    // Deployed FlashArbitrage contract address
    contractAddress: process.env.FLASH_CONTRACT_ADDRESS || null,

    // Private key for signing transactions (KEEP SECRET!)
    privateKey: process.env.PRIVATE_KEY || null,

    // Minimum net profit in USD to execute (after all fees)
    minProfitUSD: parseFloat(process.env.MIN_PROFIT_USD || '1.0'),

    // Maximum gas price in Gwei (abort if higher)
    maxGasPriceGwei: parseInt(process.env.MAX_GAS_PRICE_GWEI || '10'),

    // Slippage tolerance for trades (percentage)
    slippageTolerance: parseFloat(process.env.SLIPPAGE_TOLERANCE || '1.0'),

    // Flash loan fee (PancakeSwap V2 = 0.25%)
    flashLoanFee: 0.0025,
  },

  // Triangular Arbitrage Configuration
  triangular: {
    // Enable triangular arbitrage detection
    enabled: process.env.TRIANGULAR_ENABLED !== 'false',

    // Maximum path length (4 = A->B->C->A)
    maxPathLength: 4,

    // Minimum liquidity per pool in USD
    minLiquidityUSD: parseInt(process.env.TRIANGULAR_MIN_LIQUIDITY || '5000'),

    // Maximum trade size in USD (to limit price impact)
    maxTradeSizeUSD: parseInt(process.env.TRIANGULAR_MAX_TRADE || '5000'),
  },

  // Environment
  env: process.env.NODE_ENV || 'development',
  isDevelopment: process.env.NODE_ENV !== 'production',
  isProduction: process.env.NODE_ENV === 'production',
};
