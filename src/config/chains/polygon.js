import dotenv from 'dotenv';

dotenv.config();

/**
 * Polygon (Matic) Mainnet Configuration
 * Chain ID: 137
 */
export default {
    // Chain identification
    name: 'Polygon Mainnet',
    chainId: 137,
    enabled: process.env.POLYGON_ENABLED !== 'false',
    blockTime: 2000, // ~2 seconds average

    // Native token
    nativeToken: {
        symbol: 'MATIC',
        decimals: 18,
        wrapped: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', // WMATIC
        priceUSD: 0.5, // Approximate
    },

    // RPC Configuration
    rpc: {
        alchemy: {
            http: process.env.POLYGON_ALCHEMY_HTTP || '',
            ws: process.env.POLYGON_ALCHEMY_WS || '',
        },

        http: [
            process.env.POLYGON_ALCHEMY_HTTP,
            process.env.POLYGON_RPC_HTTP_1,
            'https://polygon-rpc.com',
            'https://polygon.llamarpc.com',
            'https://polygon-mainnet.public.blastapi.io',
        ].filter(Boolean).map(url => url.trim()),

        ws: [
            process.env.POLYGON_ALCHEMY_WS,
            process.env.POLYGON_RPC_WS_1,
            'wss://polygon.publicnode.com',
        ].filter(Boolean).map(url => url.trim()),

        maxRequestsPerMinute: parseInt(process.env.POLYGON_MAX_RPC_RPM || '300'),
        requestDelay: 50,
        retryAttempts: 5,
        retryDelay: 1000,
    },

    // Contract addresses
    contracts: {
        multicall: '0xcA11bde05977b3631167028862bE2a173976CA11',
        flashLoanProvider: process.env.POLYGON_FLASH_CONTRACT || null,
    },

    // DEX Configurations
    dexes: {
        quickswap: {
            name: 'QuickSwap',
            router: '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff',
            factory: '0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32',
            fee: 0.003,
            enabled: true,
            type: 'uniswapV2',
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
        apeswap: {
            name: 'ApeSwap',
            router: '0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607',
            factory: '0xCf083Be4164828f00cAE704EC15a36D711491284',
            fee: 0.002,
            enabled: true,
            type: 'uniswapV2',
            tvlRank: 3,
        },
    },

    // Token configuration
    tokens: {
        WMATIC: {
            symbol: 'WMATIC',
            address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
            decimals: 18,
        },
        USDT: {
            symbol: 'USDT',
            address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
            decimals: 6,
        },
        USDC: {
            symbol: 'USDC',
            address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
            decimals: 6,
        },
        DAI: {
            symbol: 'DAI',
            address: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063',
            decimals: 18,
        },
        WETH: {
            symbol: 'WETH',
            address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
            decimals: 18,
        },
        WBTC: {
            symbol: 'WBTC',
            address: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6',
            decimals: 8,
        },
        QUICK: {
            symbol: 'QUICK',
            address: '0xB5C064F955D8e7F38fE0460C556a72987494eE17',
            decimals: 18,
        },
        AAVE: {
            symbol: 'AAVE',
            address: '0xD6DF932A45C0f255f85145f286eA0b292B21C90B',
            decimals: 18,
        },
        LINK: {
            symbol: 'LINK',
            address: '0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39',
            decimals: 18,
        },
        UNI: {
            symbol: 'UNI',
            address: '0xb33EaAd8d922B1083446DC23f610c2567fB5180f',
            decimals: 18,
        },
    },

    // Base tokens
    baseTokens: ['WMATIC', 'USDT', 'USDC', 'DAI', 'WETH'],

    // Trading parameters
    trading: {
        minProfitPercentage: parseFloat(process.env.POLYGON_MIN_PROFIT || '0.3'),
        maxSlippage: parseFloat(process.env.POLYGON_MAX_SLIPPAGE || '1.0'),
        gasPriceGwei: parseInt(process.env.POLYGON_GAS_PRICE || '50'),
        estimatedGasLimit: 350000,
    },

    // Monitoring
    monitoring: {
        maxPairsToMonitor: parseInt(process.env.POLYGON_MAX_PAIRS || '200'),
        cacheSize: parseInt(process.env.POLYGON_CACHE_SIZE || '1500'),
        blockProcessingTimeout: parseInt(process.env.POLYGON_BLOCK_TIMEOUT || '1800'),
    },

    // Triangular arbitrage
    triangular: {
        enabled: process.env.POLYGON_TRIANGULAR_ENABLED !== 'false',
        maxPathLength: 4,
        minLiquidityUSD: parseInt(process.env.POLYGON_TRIANGULAR_MIN_LIQUIDITY || '5000'),
        maxTradeSizeUSD: parseInt(process.env.POLYGON_TRIANGULAR_MAX_TRADE || '5000'),
    },

    // Execution
    execution: {
        enabled: process.env.POLYGON_EXECUTION_ENABLED === 'true',
        mode: process.env.POLYGON_EXECUTION_MODE || 'simulation',
        contractAddress: process.env.POLYGON_FLASH_CONTRACT || null,
        privateKey: process.env.POLYGON_PRIVATE_KEY || null,
        minProfitUSD: parseFloat(process.env.POLYGON_MIN_PROFIT_USD || '1.0'),
        maxGasPriceGwei: parseInt(process.env.POLYGON_MAX_GAS_PRICE || '200'),
        slippageTolerance: parseFloat(process.env.POLYGON_SLIPPAGE_TOLERANCE || '1.0'),
    },

    // Flash loan providers
    flashLoan: {
        providers: ['aave', 'balancer'],
        preferredProvider: 'aave',
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
            router: '0x45A01E4e04F14f7A4a6702c74187c5F6222033cd',
            enabled: true,
        },
    },
};
