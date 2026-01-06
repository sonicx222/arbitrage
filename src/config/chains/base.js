import dotenv from 'dotenv';

dotenv.config();

/**
 * Base Mainnet Configuration
 * Chain ID: 8453
 */
export default {
    // Chain identification
    name: 'Base Mainnet',
    chainId: 8453,
    enabled: process.env.BASE_ENABLED !== 'false',
    blockTime: 2000, // ~2 seconds

    // Native token
    nativeToken: {
        symbol: 'ETH',
        decimals: 18,
        wrapped: '0x4200000000000000000000000000000000000006', // WETH
        priceUSD: 3500,
    },

    // RPC Configuration
    rpc: {
        alchemy: {
            http: process.env.BASE_ALCHEMY_HTTP || '',
            ws: process.env.BASE_ALCHEMY_WS || '',
        },

        http: [
            process.env.BASE_ALCHEMY_HTTP,
            process.env.BASE_RPC_HTTP_1,
            'https://mainnet.base.org',
            'https://base.llamarpc.com',
            'https://base-mainnet.public.blastapi.io',
        ].filter(Boolean).map(url => url.trim()),

        ws: [
            process.env.BASE_ALCHEMY_WS,
            process.env.BASE_RPC_WS_1,
            'wss://base.publicnode.com',
        ].filter(Boolean).map(url => url.trim()),

        maxRequestsPerMinute: parseInt(process.env.BASE_MAX_RPC_RPM || '300'),
        requestDelay: 50,
        retryAttempts: 5,
        retryDelay: 500,
    },

    // Contract addresses
    contracts: {
        multicall: '0xcA11bde05977b3631167028862bE2a173976CA11',
        flashLoanProvider: process.env.BASE_FLASH_CONTRACT || null,
    },

    // DEX Configurations
    dexes: {
        uniswapV3: {
            name: 'Uniswap V3',
            router: '0x2626664c2603336E57B271c5C0b26F421741e481',
            factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
            quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
            enabled: true,
            type: 'uniswapV3',
            feeTiers: [100, 500, 3000, 10000],
            tvlRank: 1,
        },
        aerodrome: {
            name: 'Aerodrome',
            router: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
            factory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
            fee: 0.003,
            enabled: true,
            type: 'solidly',
            tvlRank: 1,
        },
        baseswap: {
            name: 'BaseSwap',
            router: '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86',
            factory: '0xFDa619b6d20975be80A10332cD39b9a4b0FAa8BB',
            fee: 0.003,
            enabled: true,
            type: 'uniswapV2',
            tvlRank: 2,
        },
        sushiswap: {
            name: 'SushiSwap',
            router: '0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891',
            factory: '0x71524B4f93c58fcbF659783284E38825f0622859',
            fee: 0.003,
            enabled: true,
            type: 'uniswapV2',
            tvlRank: 3,
        },
    },

    // Token configuration
    tokens: {
        WETH: {
            symbol: 'WETH',
            address: '0x4200000000000000000000000000000000000006',
            decimals: 18,
        },
        USDC: {
            symbol: 'USDC',
            address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            decimals: 6,
        },
        USDbC: {
            symbol: 'USDbC',
            address: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA',
            decimals: 6,
        },
        DAI: {
            symbol: 'DAI',
            address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
            decimals: 18,
        },
        cbETH: {
            symbol: 'cbETH',
            address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22',
            decimals: 18,
        },
        AERO: {
            symbol: 'AERO',
            address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
            decimals: 18,
        },
        BSWAP: {
            symbol: 'BSWAP',
            address: '0x78a087d713Be963Bf307b18F2Ff8122EF9A63ae9',
            decimals: 18,
        },
        TOSHI: {
            symbol: 'TOSHI',
            address: '0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4',
            decimals: 18,
        },
        DEGEN: {
            symbol: 'DEGEN',
            address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed',
            decimals: 18,
        },
        BRETT: {
            symbol: 'BRETT',
            address: '0x532f27101965dd16442E59d40670FaF5eBB142E4',
            decimals: 18,
        },
    },

    // Base tokens
    baseTokens: ['WETH', 'USDC', 'USDbC', 'DAI'],

    // Trading parameters
    trading: {
        minProfitPercentage: parseFloat(process.env.BASE_MIN_PROFIT || '0.2'),
        maxSlippage: parseFloat(process.env.BASE_MAX_SLIPPAGE || '0.5'),
        gasPriceGwei: parseFloat(process.env.BASE_GAS_PRICE || '0.01'),
        estimatedGasLimit: 400000,
    },

    // Monitoring
    monitoring: {
        maxPairsToMonitor: parseInt(process.env.BASE_MAX_PAIRS || '150'),
        cacheSize: parseInt(process.env.BASE_CACHE_SIZE || '1000'),
        blockProcessingTimeout: parseInt(process.env.BASE_BLOCK_TIMEOUT || '1500'),
    },

    // Triangular arbitrage
    triangular: {
        enabled: process.env.BASE_TRIANGULAR_ENABLED !== 'false',
        maxPathLength: 4,
        minLiquidityUSD: parseInt(process.env.BASE_TRIANGULAR_MIN_LIQUIDITY || '5000'),
        maxTradeSizeUSD: parseInt(process.env.BASE_TRIANGULAR_MAX_TRADE || '5000'),
    },

    // Execution
    execution: {
        enabled: process.env.BASE_EXECUTION_ENABLED === 'true',
        mode: process.env.BASE_EXECUTION_MODE || 'simulation',
        contractAddress: process.env.BASE_FLASH_CONTRACT || null,
        privateKey: process.env.BASE_PRIVATE_KEY || null,
        minProfitUSD: parseFloat(process.env.BASE_MIN_PROFIT_USD || '1.0'),
        maxGasPriceGwei: parseInt(process.env.BASE_MAX_GAS_PRICE || '1'),
        slippageTolerance: parseFloat(process.env.BASE_SLIPPAGE_TOLERANCE || '0.5'),
    },

    // Flash loan providers
    flashLoan: {
        providers: ['aave'],
        preferredProvider: 'aave',
        aave: {
            poolAddress: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
            fee: 0.0009,
        },
    },

    // Bridge configurations
    bridges: {
        stargate: {
            router: '0x45f1A95A4D3f3836523F5c83673c797f4d4d263B',
            enabled: true,
        },
    },
};
