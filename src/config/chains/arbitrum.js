import dotenv from 'dotenv';

dotenv.config();

/**
 * Arbitrum One Configuration
 * Chain ID: 42161
 */
export default {
    // Chain identification
    name: 'Arbitrum One',
    chainId: 42161,
    enabled: process.env.ARBITRUM_ENABLED === 'true',
    blockTime: 250, // ~0.25 seconds (very fast)

    // Native token
    nativeToken: {
        symbol: 'ETH',
        decimals: 18,
        wrapped: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // WETH
        priceUSD: 3500,
    },

    // RPC Configuration
    rpc: {
        alchemy: {
            http: process.env.ARBITRUM_ALCHEMY_HTTP || '',
            ws: process.env.ARBITRUM_ALCHEMY_WS || '',
        },

        http: [
            process.env.ARBITRUM_ALCHEMY_HTTP,
            process.env.ARBITRUM_RPC_HTTP_1,
            'https://arb1.arbitrum.io/rpc',
            'https://arbitrum.llamarpc.com',
            'https://arbitrum-one.public.blastapi.io',
        ].filter(Boolean).map(url => url.trim()),

        ws: [
            process.env.ARBITRUM_ALCHEMY_WS,
            process.env.ARBITRUM_RPC_WS_1,
            'wss://arbitrum.publicnode.com',
        ].filter(Boolean).map(url => url.trim()),

        maxRequestsPerMinute: parseInt(process.env.ARBITRUM_MAX_RPC_RPM || '300'),
        requestDelay: 20,
        retryAttempts: 5,
        retryDelay: 500,
    },

    // Contract addresses
    contracts: {
        multicall: '0xcA11bde05977b3631167028862bE2a173976CA11',
        flashLoanProvider: process.env.ARBITRUM_FLASH_CONTRACT || null,
    },

    // DEX Configurations
    dexes: {
        uniswapV3: {
            name: 'Uniswap V3',
            router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
            factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
            quoter: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6',
            enabled: true,
            type: 'uniswapV3',
            feeTiers: [100, 500, 3000, 10000],
            tvlRank: 1,
        },
        sushiswap: {
            name: 'SushiSwap',
            router: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
            factory: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
            fee: 0.003,
            enabled: true,
            type: 'uniswapV2',
            tvlRank: 2,
        },
        camelot: {
            name: 'Camelot',
            router: '0xc873fEcbd354f5A56E00E710B90EF4201db2448d',
            factory: '0x6EcCab422D763aC031210895C81787E87B43A652',
            fee: 0.003,
            enabled: true,
            type: 'uniswapV2',
            tvlRank: 3,
        },
        traderjoe: {
            name: 'TraderJoe',
            router: '0xbeE5c10Cf6E4F68f831E11C1D9E59B43560B3571',
            factory: '0xaE4EC9901c3076D0DdBe76A520F9E90a6227Acb7',
            fee: 0.003,
            enabled: true,
            type: 'uniswapV2',
            tvlRank: 4,
        },
    },

    // Token configuration
    tokens: {
        WETH: {
            symbol: 'WETH',
            address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
            decimals: 18,
        },
        USDT: {
            symbol: 'USDT',
            address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
            decimals: 6,
        },
        USDC: {
            symbol: 'USDC',
            address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
            decimals: 6,
        },
        'USDC.e': {
            symbol: 'USDC.e',
            address: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',
            decimals: 6,
        },
        DAI: {
            symbol: 'DAI',
            address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
            decimals: 18,
        },
        WBTC: {
            symbol: 'WBTC',
            address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
            decimals: 8,
        },
        ARB: {
            symbol: 'ARB',
            address: '0x912CE59144191C1204E64559FE8253a0e49E6548',
            decimals: 18,
        },
        GMX: {
            symbol: 'GMX',
            address: '0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a',
            decimals: 18,
        },
        LINK: {
            symbol: 'LINK',
            address: '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4',
            decimals: 18,
        },
        UNI: {
            symbol: 'UNI',
            address: '0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0',
            decimals: 18,
        },
        MAGIC: {
            symbol: 'MAGIC',
            address: '0x539bdE0d7Dbd336b79148AA742883198BBF60342',
            decimals: 18,
        },
        RDNT: {
            symbol: 'RDNT',
            address: '0x3082CC23568eA640225c2467653dB90e9250AaA0',
            decimals: 18,
        },
    },

    // Base tokens
    baseTokens: ['WETH', 'USDT', 'USDC', 'USDC.e', 'DAI'],

    // Trading parameters
    trading: {
        minProfitPercentage: parseFloat(process.env.ARBITRUM_MIN_PROFIT || '0.2'),
        maxSlippage: parseFloat(process.env.ARBITRUM_MAX_SLIPPAGE || '0.5'),
        gasPriceGwei: parseInt(process.env.ARBITRUM_GAS_PRICE || '0.1'),
        estimatedGasLimit: 500000,
    },

    // Monitoring
    monitoring: {
        maxPairsToMonitor: parseInt(process.env.ARBITRUM_MAX_PAIRS || '200'),
        cacheSize: parseInt(process.env.ARBITRUM_CACHE_SIZE || '1500'),
        blockProcessingTimeout: parseInt(process.env.ARBITRUM_BLOCK_TIMEOUT || '200'),
    },

    // Triangular arbitrage
    triangular: {
        enabled: process.env.ARBITRUM_TRIANGULAR_ENABLED !== 'false',
        maxPathLength: 4,
        minLiquidityUSD: parseInt(process.env.ARBITRUM_TRIANGULAR_MIN_LIQUIDITY || '10000'),
        maxTradeSizeUSD: parseInt(process.env.ARBITRUM_TRIANGULAR_MAX_TRADE || '10000'),
    },

    // Execution
    execution: {
        enabled: process.env.ARBITRUM_EXECUTION_ENABLED === 'true',
        mode: process.env.ARBITRUM_EXECUTION_MODE || 'simulation',
        contractAddress: process.env.ARBITRUM_FLASH_CONTRACT || null,
        privateKey: process.env.ARBITRUM_PRIVATE_KEY || null,
        minProfitUSD: parseFloat(process.env.ARBITRUM_MIN_PROFIT_USD || '2.0'),
        maxGasPriceGwei: parseInt(process.env.ARBITRUM_MAX_GAS_PRICE || '1'),
        slippageTolerance: parseFloat(process.env.ARBITRUM_SLIPPAGE_TOLERANCE || '0.5'),
    },

    // Flash loan providers
    flashLoan: {
        providers: ['aave', 'balancer'],
        preferredProvider: 'balancer',
        aave: {
            poolAddress: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
            fee: 0.0009,
        },
        balancer: {
            vault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
            fee: 0,
        },
    },

    // Bridge configurations
    bridges: {
        stargate: {
            router: '0x53Bf833A5d6c4ddA888F69c22C88C9f356a41614',
            enabled: true,
        },
    },
};
