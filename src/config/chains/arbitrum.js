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
    enabled: process.env.ARBITRUM_ENABLED !== 'false',
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
        // High-volume DEXes for better arbitrage detection
        ramses: {
            name: 'Ramses',
            router: '0xAAA87963EFeB6f7E0a2711F397663105Acb1805e',
            factory: '0xAAA20D08e59F6561f242b08513D36266C5A29415',
            fee: 0.003,
            enabled: true,
            type: 'solidly',
            tvlRank: 5,
        },
        zyberswap: {
            name: 'Zyberswap',
            router: '0x16e71B13fE6079B4312063F7E81F76d165Ad32Ad',
            factory: '0xAC2ee06A14c52570Ef3B9812Ed240BCe359772e7',
            fee: 0.003,
            enabled: true,
            type: 'uniswapV2',
            tvlRank: 6,
        },
        arbidex: {
            name: 'ArbiDex',
            router: '0x7238FB45146BD8FcB2c463Dc119A53494be57Aac',
            factory: '0x1C6E968f2E6c9DEC61DB874E28589fd5CE3E1f2c',
            fee: 0.003,
            enabled: true,
            type: 'uniswapV2',
            tvlRank: 7,
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
        // High-volume tokens for better arbitrage detection
        PENDLE: {
            symbol: 'PENDLE',
            address: '0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8',
            decimals: 18,
        },
        GRAIL: {
            symbol: 'GRAIL',
            address: '0x3d9907F9a368ad0a51Be60f7Da3b97cf940982D8',
            decimals: 18,
        },
        JONES: {
            symbol: 'JONES',
            address: '0x10393c20975cF177a3513071bC110f7962CD67da',
            decimals: 18,
        },
        DPX: {
            symbol: 'DPX',
            address: '0x6C2C06790b3E3E3c38e12Ee22F8183b37a13EE55',
            decimals: 18,
        },
        SUSHI: {
            symbol: 'SUSHI',
            address: '0xd4d42F0b6DEF4CE0383636770eF773390d85c61A',
            decimals: 18,
        },
        CRV: {
            symbol: 'CRV',
            address: '0x11cDb42B0EB46D95f990BeDD4695A6e3fA034978',
            decimals: 18,
        },
        FRAX: {
            symbol: 'FRAX',
            address: '0x17FC002b466eEc40DaE837Fc4bE5c67993ddBd6F',
            decimals: 18,
        },
        STG: {
            symbol: 'STG',
            address: '0x6694340fc020c5E6B96567843da2df01b2CE1eb6',
            decimals: 18,
        },
        LDO: {
            symbol: 'LDO',
            address: '0x13Ad51ed4F1B7e9Dc168d8a00cB3f4dDD85EfA60',
            decimals: 18,
        },
        wstETH: {
            symbol: 'wstETH',
            address: '0x5979D7b546E38E414F7E9822514be443A4800529',
            decimals: 18,
        },
        rETH: {
            symbol: 'rETH',
            address: '0xEC70Dcb4A1EFa46b8F2D97C310C9c4790ba5ffA8',
            decimals: 18,
        },
    },

    // Base tokens
    baseTokens: ['WETH', 'USDT', 'USDC', 'USDC.e', 'DAI', 'FRAX'],

    // Trading parameters
    trading: {
        minProfitPercentage: parseFloat(process.env.ARBITRUM_MIN_PROFIT || '0.2'),
        maxSlippage: parseFloat(process.env.ARBITRUM_MAX_SLIPPAGE || '0.5'),
        gasPriceGwei: parseFloat(process.env.ARBITRUM_GAS_PRICE || '0.1'),
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
