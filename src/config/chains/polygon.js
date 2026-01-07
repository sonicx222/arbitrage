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
        // High-volume DEXes for better arbitrage detection
        balancer: {
            name: 'Balancer',
            router: '0xBA12222222228d8Ba445958a75a0704d566BF2C8', // Vault acts as router
            vault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
            enabled: false, // Disabled until Balancer integration is complete
            type: 'balancer',
            tvlRank: 2,
        },
        dystopia: {
            name: 'Dystopia',
            router: '0xbE75Dd16D029c6B32B7aD57A0FD9C1c20Dd2862e',
            factory: '0x1d21Db6cde1b18c7E47B0F7F42f4b3F68b9beeC9',
            fee: 0.003,
            enabled: true,
            type: 'solidly',
            tvlRank: 4,
        },
        meshswap: {
            name: 'MeshSwap',
            router: '0x10f4A785F458Bc144e3706575924889954946639',
            factory: '0x9F3044f7F9FC8bC9eD615d54845b4577B833282d',
            fee: 0.003,
            enabled: true,
            type: 'uniswapV2',
            tvlRank: 5,
        },
        jetswap: {
            name: 'JetSwap',
            router: '0x5C6EC38fb0e2609672BDf628B1fD605A523E5923',
            factory: '0x668ad0ed2622C62E24f0d5ab6B6Ac1b9D2cD4AC7',
            fee: 0.003,
            enabled: true,
            type: 'uniswapV2',
            tvlRank: 6,
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
        // High-volume tokens for better arbitrage detection
        CRV: {
            symbol: 'CRV',
            address: '0x172370d5Cd63279eFa6d502DAB29171933a610AF',
            decimals: 18,
        },
        BAL: {
            symbol: 'BAL',
            address: '0x9a71012B13CA4d3D0Cdc72A177DF3ef03b0E76A3',
            decimals: 18,
        },
        SUSHI: {
            symbol: 'SUSHI',
            address: '0x0b3F868E0BE5597D5DB7fEB59E1CADBb0fdDa50a',
            decimals: 18,
        },
        GHST: {
            symbol: 'GHST',
            address: '0x385Eeac5cB85A38A9a07A70c73e0a3271CfB54A7',
            decimals: 18,
        },
        SAND: {
            symbol: 'SAND',
            address: '0xBbba073C31bF03b8ACf7c28EF0738DeCF3695683',
            decimals: 18,
        },
        MANA: {
            symbol: 'MANA',
            address: '0xA1c57f48F0Deb89f569dFbE6E2B7f46D33606fD4',
            decimals: 18,
        },
        stMATIC: {
            symbol: 'stMATIC',
            address: '0x3A58a54C066FdC0f2D55FC9C89F0415C92eBf3C4',
            decimals: 18,
        },
        MaticX: {
            symbol: 'MaticX',
            address: '0xfa68FB4628DFF1028CFEc22b4162FCcd0d45efb6',
            decimals: 18,
        },
        miMATIC: {
            symbol: 'miMATIC',
            address: '0xa3Fa99A148fA48D14Ed51d610c367C61876997F1',
            decimals: 18,
        },
        FRAX: {
            symbol: 'FRAX',
            address: '0x45c32fA6DF82ead1e2EF74d17b76547EDdFaFF89',
            decimals: 18,
        },
        // Additional high-volume Polygon tokens
        EURS: {
            symbol: 'EURS',
            address: '0xE111178A87A3BFf0c8d18DECBa5798827539Ae99',
            decimals: 2,
        },
        AGEUR: {
            symbol: 'AGEUR',
            address: '0xE0B52e49357Fd4DAf2c15e02058DCE6BC0057db4',
            decimals: 18,
        },
        VOXEL: {
            symbol: 'VOXEL',
            address: '0xd0258a3fD00f38aa8090dfee343f10A9D4d30D3F',
            decimals: 18,
        },
        KLIMA: {
            symbol: 'KLIMA',
            address: '0x4e78011Ce80ee02d2c3e649Fb657E45898257815',
            decimals: 9,
        },
        BIFI: {
            symbol: 'BIFI',
            address: '0xFbdd194376de19a88118e84E279b977f165d01b8',
            decimals: 18,
        },
        QI: {
            symbol: 'QI',
            address: '0x580A84C73811E1839F75d86d75d88cCa0c241fF4',
            decimals: 18,
        },
        ICE: {
            symbol: 'ICE',
            address: '0x4e1581f01046eFDd7a1a2CDB0F82cDD7F71F2E59',
            decimals: 18,
        },
        SPHERE: {
            symbol: 'SPHERE',
            address: '0x62F594339830b90AE4C084aE7D223fFAFd9658A7',
            decimals: 18,
        },
        TETU: {
            symbol: 'TETU',
            address: '0x255707B70BF90aa112006E1b07B9AeA6De021424',
            decimals: 18,
        },
        ORBS: {
            symbol: 'ORBS',
            address: '0x614389EaAE0A6821DC49062D56BDA3d9d45Fa2ff',
            decimals: 18,
        },
    },

    // Base tokens (including stables for triangular arbitrage) - Expanded
    baseTokens: ['WMATIC', 'USDT', 'USDC', 'DAI', 'WETH', 'miMATIC', 'FRAX', 'AGEUR'],

    // Trading parameters - Optimized for low gas costs
    trading: {
        minProfitPercentage: parseFloat(process.env.POLYGON_MIN_PROFIT || '0.15'), // Lowered for low gas
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

    // V3 (concentrated liquidity) settings
    v3: {
        enabled: process.env.POLYGON_V3_ENABLED !== 'false',
        feeTiers: [100, 500, 3000, 10000],
        minLiquidityUSD: parseInt(process.env.POLYGON_V3_MIN_LIQUIDITY || '3000'),
        minProfitPercent: parseFloat(process.env.POLYGON_V3_MIN_PROFIT || '0.1'),
    },

    // Execution - Optimized for low gas costs
    execution: {
        enabled: process.env.POLYGON_EXECUTION_ENABLED === 'true',
        mode: process.env.POLYGON_EXECUTION_MODE || 'simulation',
        contractAddress: process.env.POLYGON_FLASH_CONTRACT || null,
        privateKey: process.env.POLYGON_PRIVATE_KEY || null,
        minProfitUSD: parseFloat(process.env.POLYGON_MIN_PROFIT_USD || '0.50'), // Lowered for low gas
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
