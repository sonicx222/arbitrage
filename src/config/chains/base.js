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
        // Additional DEXes for better arbitrage detection
        alienbase: {
            name: 'AlienBase',
            router: '0x8c1A3cF8f83074169FE5D7aD50B978e1cD6b37c7',
            factory: '0x3E84D913803b02A4a7f027165E8cA42C14C0FdE7',
            fee: 0.003,
            enabled: true,
            type: 'uniswapV2',
            tvlRank: 4,
        },
        swapbased: {
            name: 'SwapBased',
            router: '0xaaa3b1F1bd7BCc97fD1917c18ADE665C5D31F066',
            factory: '0x04C9f118d21e8B767D2e50C946f0cC9F6C367300',
            fee: 0.003,
            enabled: true,
            type: 'uniswapV2',
            tvlRank: 5,
        },
        rocketswap: {
            name: 'RocketSwap',
            router: '0x4cf76043B3f97ba06917cBd90F9e3A2AAC1B306e',
            factory: '0x1B8128c3A1B7D20053D10763ff02466ca7FF99FC',
            fee: 0.003,
            enabled: true,
            type: 'uniswapV2',
            tvlRank: 6,
        },
        uniswapV2: {
            name: 'Uniswap V2',
            router: '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24',
            factory: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6',
            fee: 0.003,
            enabled: true,
            type: 'uniswapV2',
            tvlRank: 2,
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
        // High-volume tokens for better arbitrage detection
        WELL: {
            symbol: 'WELL',
            address: '0xA88594D404727625A9437C3f886C7643872296AE',
            decimals: 18,
        },
        SNX: {
            symbol: 'SNX',
            address: '0x22e6966B799c4D5B13BE962E1D117b56327FDa66',
            decimals: 18,
        },
        EXTRA: {
            symbol: 'EXTRA',
            address: '0x2dad3a13ef0c6366220f989157009e501e7938F8',
            decimals: 18,
        },
        SEAM: {
            symbol: 'SEAM',
            address: '0x1C7a460413dD4e964f96D8dFC56E7223cE88CD85',
            decimals: 18,
        },
        BASED: {
            symbol: 'BASED',
            address: '0x32E0f9d26D1e33625742A52620cC76C1130efde6',
            decimals: 18,
        },
        OVN: {
            symbol: 'OVN',
            address: '0xA3d1a8DEB97B111454B294E2324EfAD13a9d8396',
            decimals: 18,
        },
        USDplus: {
            symbol: 'USDplus',
            address: '0xB79DD08EA68A908A97220C76d19A6aA9cBDE4376',
            decimals: 6,
        },
        axlUSDC: {
            symbol: 'axlUSDC',
            address: '0xEB466342C4d449BC9f53A865D5Cb90586f405215',
            decimals: 6,
        },
        wstETH: {
            symbol: 'wstETH',
            address: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452',
            decimals: 18,
        },
        rETH: {
            symbol: 'rETH',
            address: '0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c',
            decimals: 18,
        },
        // Additional Base ecosystem tokens
        BALD: {
            symbol: 'BALD',
            address: '0x27D2DECb4bFC9C76F0309b8E88dec3a601Fe25a8',
            decimals: 18,
        },
        MOCHI: {
            symbol: 'MOCHI',
            address: '0xF6e932Ca12afa26665dC4dDE7e27be02A7c02e50',
            decimals: 18,
        },
        COIN: {
            symbol: 'COIN',
            address: '0xE3086852A4B125803C815a158249ae468A3254Ca',
            decimals: 18,
        },
        NORMIE: {
            symbol: 'NORMIE',
            address: '0x7F12d13B34F5F4f0a9449c16Bcd42f0da47AF200',
            decimals: 9,
        },
        DOGINME: {
            symbol: 'DOGINME',
            address: '0x6921B130D297cc43754afba22e5EAc0FBf8Db75b',
            decimals: 18,
        },
        HIGHER: {
            symbol: 'HIGHER',
            address: '0x0578d8A44db98B23BF096A382e016e29a5Ce0ffe',
            decimals: 18,
        },
        VIRTUAL: {
            symbol: 'VIRTUAL',
            address: '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b',
            decimals: 18,
        },
        PRIME: {
            symbol: 'PRIME',
            address: '0xfA980cEd6895AC314E7dE34Ef1bFAE90a5AdD21b',
            decimals: 18,
        },
        EURC: {
            symbol: 'EURC',
            address: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42',
            decimals: 6,
        },
    },

    // Base tokens (including stables for better triangular arbitrage)
    baseTokens: ['WETH', 'USDC', 'USDbC', 'DAI', 'axlUSDC', 'EURC'],

    // Trading parameters - Optimized for L2 ultra-low gas costs
    trading: {
        minProfitPercentage: parseFloat(process.env.BASE_MIN_PROFIT || '0.05'), // Lowered for L2
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

    // V3 (concentrated liquidity) settings - Optimized for L2
    v3: {
        enabled: process.env.BASE_V3_ENABLED !== 'false',
        feeTiers: [100, 500, 3000, 10000],
        minLiquidityUSD: parseInt(process.env.BASE_V3_MIN_LIQUIDITY || '3000'),
        minProfitPercent: parseFloat(process.env.BASE_V3_MIN_PROFIT || '0.08'),
    },

    // Execution - Optimized for L2 ultra-low gas costs
    execution: {
        enabled: process.env.BASE_EXECUTION_ENABLED === 'true',
        mode: process.env.BASE_EXECUTION_MODE || 'simulation',
        contractAddress: process.env.BASE_FLASH_CONTRACT || null,
        privateKey: process.env.BASE_PRIVATE_KEY || null,
        minProfitUSD: parseFloat(process.env.BASE_MIN_PROFIT_USD || '0.20'), // Lowered for L2
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
