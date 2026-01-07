import dotenv from 'dotenv';
import { optimizedTokens } from '../../data/tokenList.js';

dotenv.config();

/**
 * BSC (Binance Smart Chain) Configuration
 * Chain ID: 56
 *
 * This is the primary chain configuration, migrated from the original config.js
 * for multi-chain support.
 */
export default {
    // Chain identification
    name: 'BSC Mainnet',
    chainId: 56,
    enabled: true,
    blockTime: 3000, // 3 seconds average

    // Native token
    nativeToken: {
        symbol: 'BNB',
        decimals: 18,
        wrapped: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // WBNB
        priceUSD: 600, // Approximate, should be fetched dynamically
    },

    // RPC Configuration
    rpc: {
        // Alchemy Priority Endpoints (if available)
        alchemy: {
            http: process.env.ALCHEMY_RPC_URL || process.env.BSC_ALCHEMY_HTTP || '',
            ws: process.env.ALCHEMY_WS_URL || process.env.BSC_ALCHEMY_WS || '',
        },

        http: [
            process.env.ALCHEMY_RPC_URL || process.env.BSC_ALCHEMY_HTTP,
            process.env.BSC_RPC_HTTP_1,
            process.env.BSC_RPC_HTTP_2,
            'https://bsc-dataseed.binance.org',
            'https://bsc-dataseed1.defibit.io',
            'https://bsc-dataseed1.ninicoin.io',
            'https://bsc.publicnode.com',
            'https://bsc-rpc.publicnode.com',
        ].filter(Boolean).map(url => url.trim()),

        ws: [
            process.env.ALCHEMY_WS_URL || process.env.BSC_ALCHEMY_WS,
            process.env.BSC_RPC_WS_1,
            'wss://bsc.publicnode.com',
        ].filter(Boolean).map(url => url.trim()),

        // Rate limiting
        maxRequestsPerMinute: parseInt(process.env.BSC_MAX_RPC_RPM || process.env.MAX_RPC_RPM || '300'),
        requestDelay: 50,
        retryAttempts: 5,
        retryDelay: 1000,
    },

    // Contract addresses
    contracts: {
        multicall: '0xcA11bde05977b3631167028862bE2a173976CA11', // Multicall3
        flashLoanProvider: process.env.BSC_FLASH_CONTRACT || process.env.FLASH_CONTRACT_ADDRESS || null,
    },

    // DEX Configurations
    dexes: {
        // Tier 1: Highest liquidity DEXs
        pancakeswap: {
            name: 'PancakeSwap',
            router: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
            factory: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
            fee: 0.0025, // 0.25% (V2 Standard)
            enabled: true,
            type: 'uniswapV2',
            tvlRank: 1,
        },
        biswap: {
            name: 'Biswap',
            router: '0x3a6d8CA2b07040D826A7E02798e0964253350dD8',
            factory: '0x858E3312ed3A876947EA49d572A7C42DE08af7EE',
            fee: 0.001, // 0.1% (lower fee = better for arbitrage)
            enabled: true,
            type: 'uniswapV2',
            tvlRank: 2,
        },
        // Tier 2: Good liquidity
        apeswap: {
            name: 'ApeSwap',
            router: '0xcF0feBd3f17CEf5b47b0cD257aCf6025c5BFf3b7',
            factory: '0x0841BD0B734E4F5853f0dD8d7Ea041c241fb0Da6',
            fee: 0.002, // 0.2%
            enabled: true,
            type: 'uniswapV2',
            tvlRank: 3,
        },
        babyswap: {
            name: 'BabySwap',
            router: '0x325E343f1dE602396E256B67eFd1F61C3A6B38Bd',
            factory: '0x86407bEa2078ea5f5EB5A52B2caA963bC1F889Da',
            fee: 0.003, // 0.3%
            enabled: true,
            type: 'uniswapV2',
            tvlRank: 4,
        },
        mdex: {
            name: 'MDEX',
            router: '0x7DAe51BD3E3376B8c7c4900E9107f12Be3AF1bA8',
            factory: '0x3CD1C46068dAEa5Ebb0d3f55F6915B10648062B8',
            fee: 0.003, // 0.3%
            enabled: true,
            type: 'uniswapV2',
            tvlRank: 5,
        },
        // Tier 3: Lower liquidity (disabled by default)
        knightswap: {
            name: 'KnightSwap',
            router: '0x05E61E0cDcD2170a76F9568a110CEe3AFdD6c46f',
            factory: '0xf0bc2E21a76513aa7CC2730C7A1D6deE0790751f',
            fee: 0.002,
            enabled: false,
            type: 'uniswapV2',
            tvlRank: 6,
        },
        sushiswap: {
            name: 'SushiSwap',
            router: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
            factory: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
            fee: 0.003,
            enabled: true,
            type: 'uniswapV2',
            tvlRank: 7,
        },
        // High-volume Solidly-fork DEXes
        thena: {
            name: 'THENA',
            router: '0xd4ae6eCA985340Dd434D38F470aCCce4DC78D109',
            factory: '0xAFD89d21BdB66d00817d4153E055830B1c2B3970',
            fee: 0.003,
            enabled: true,
            type: 'solidly',
            tvlRank: 3,
        },
        wombat: {
            name: 'Wombat Exchange',
            router: '0x19609B03C976CCA288fbDae5c21d4290e9a4aDD7',
            factory: '0x7a69c763F5b9E6dd3aC0B86Ba170A41b1a91745C',
            fee: 0.0005,
            enabled: true,
            type: 'wombat',
            tvlRank: 4,
        },
        nomiswap: {
            name: 'NomiSwap',
            router: '0xD654953D746f0b114d1F85332Dc43446ac79413d',
            factory: '0xd6715A8be3944ec72738F0BFDC739d48C3c29349',
            fee: 0.003,
            enabled: true,
            type: 'uniswapV2',
            tvlRank: 6,
        },
        // Uniswap V3 style DEXes (concentrated liquidity)
        'pancakeswap-v3': {
            name: 'PancakeSwap V3',
            factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
            quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
            router: '0x1b81D678ffb9C0263b24A97847620C99d213eB14',
            // V3 has multiple fee tiers, fees handled per-pool
            feeTiers: [100, 500, 2500, 10000], // 0.01%, 0.05%, 0.25%, 1%
            enabled: true,
            type: 'uniswapV3',
            tvlRank: 1,
        },
    },

    // Token configuration
    tokens: optimizedTokens,

    // Base tokens for arbitrage paths
    baseTokens: [
        'WBNB',   // Native token - required
        'USDT',   // Primary stablecoin
        'BUSD',   // Binance stablecoin
        'USDC',   // Circle stablecoin
        'ETH',    // Bridged ETH - high volume
        'BTCB',   // Bridged BTC - high volume
    ],

    // Trading parameters
    trading: {
        minProfitPercentage: parseFloat(process.env.BSC_MIN_PROFIT || process.env.MIN_PROFIT_PERCENTAGE || '0.5'),
        maxSlippage: parseFloat(process.env.BSC_MAX_SLIPPAGE || process.env.MAX_SLIPPAGE || '1.0'),
        gasPriceGwei: parseInt(process.env.BSC_GAS_PRICE || process.env.GAS_PRICE_GWEI || '5'),
        estimatedGasLimit: 350000,
    },

    // Monitoring configuration
    monitoring: {
        maxPairsToMonitor: parseInt(process.env.BSC_MAX_PAIRS || process.env.MAX_PAIRS_TO_MONITOR || '250'),
        cacheSize: parseInt(process.env.BSC_CACHE_SIZE || process.env.CACHE_SIZE || '2000'),
        blockProcessingTimeout: parseInt(process.env.BSC_BLOCK_TIMEOUT || process.env.BLOCK_PROCESSING_TIMEOUT_MS || '2500'),
    },

    // Triangular arbitrage settings
    triangular: {
        enabled: process.env.BSC_TRIANGULAR_ENABLED !== 'false' && process.env.TRIANGULAR_ENABLED !== 'false',
        maxPathLength: 4,
        minLiquidityUSD: parseInt(process.env.BSC_TRIANGULAR_MIN_LIQUIDITY || process.env.TRIANGULAR_MIN_LIQUIDITY || '5000'),
        maxTradeSizeUSD: parseInt(process.env.BSC_TRIANGULAR_MAX_TRADE || process.env.TRIANGULAR_MAX_TRADE || '5000'),
    },

    // V3 (concentrated liquidity) settings
    v3: {
        enabled: process.env.BSC_V3_ENABLED !== 'false' && process.env.V3_ENABLED !== 'false',
        feeTiers: [100, 500, 2500, 10000], // Check these fee tiers
        minLiquidityUSD: parseInt(process.env.BSC_V3_MIN_LIQUIDITY || process.env.V3_MIN_LIQUIDITY || '3000'),
        // Lower min profit for V3 due to lower fees
        minProfitPercent: parseFloat(process.env.BSC_V3_MIN_PROFIT || process.env.V3_MIN_PROFIT || '0.2'),
    },

    // Execution settings
    execution: {
        enabled: process.env.BSC_EXECUTION_ENABLED === 'true' || process.env.EXECUTION_ENABLED === 'true',
        mode: process.env.BSC_EXECUTION_MODE || process.env.EXECUTION_MODE || 'simulation',
        contractAddress: process.env.BSC_FLASH_CONTRACT || process.env.FLASH_CONTRACT_ADDRESS || null,
        privateKey: process.env.BSC_PRIVATE_KEY || process.env.PRIVATE_KEY || null,
        minProfitUSD: parseFloat(process.env.BSC_MIN_PROFIT_USD || process.env.MIN_PROFIT_USD || '1.0'),
        maxGasPriceGwei: parseInt(process.env.BSC_MAX_GAS_PRICE || process.env.MAX_GAS_PRICE_GWEI || '10'),
        slippageTolerance: parseFloat(process.env.BSC_SLIPPAGE_TOLERANCE || process.env.SLIPPAGE_TOLERANCE || '1.0'),
        flashLoanFee: 0.0025, // PancakeSwap V2 flash loan fee
    },

    // Flash loan providers
    flashLoan: {
        providers: ['pancakeswap'],
        preferredProvider: 'pancakeswap',
        pancakeswap: {
            router: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
            fee: 0.0025,
        },
    },

    // Bridge configurations (for cross-chain)
    bridges: {
        stargate: {
            router: '0x4a364f8c717cAAD9A442737Eb7b8A55cc6cf18D8',
            enabled: true,
        },
        cbridge: {
            bridge: '0xdd90E5E87A2081Dcf0391920868eBc2FFB81a1aF',
            enabled: false,
        },
    },
};
