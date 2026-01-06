import dotenv from 'dotenv';

dotenv.config();

/**
 * Avalanche C-Chain Configuration
 * Chain ID: 43114
 */
export default {
    // Chain identification
    name: 'Avalanche C-Chain',
    chainId: 43114,
    enabled: process.env.AVALANCHE_ENABLED === 'true',
    blockTime: 2000, // ~2 seconds

    // Native token
    nativeToken: {
        symbol: 'AVAX',
        decimals: 18,
        wrapped: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', // WAVAX
        priceUSD: 35,
    },

    // RPC Configuration
    rpc: {
        alchemy: {
            http: process.env.AVALANCHE_ALCHEMY_HTTP || '',
            ws: process.env.AVALANCHE_ALCHEMY_WS || '',
        },

        http: [
            process.env.AVALANCHE_ALCHEMY_HTTP,
            process.env.AVALANCHE_RPC_HTTP_1,
            'https://api.avax.network/ext/bc/C/rpc',
            'https://avalanche.public-rpc.com',
            'https://avalanche-c-chain.publicnode.com',
        ].filter(Boolean).map(url => url.trim()),

        ws: [
            process.env.AVALANCHE_ALCHEMY_WS,
            process.env.AVALANCHE_RPC_WS_1,
            'wss://avalanche-c-chain.publicnode.com',
        ].filter(Boolean).map(url => url.trim()),

        maxRequestsPerMinute: parseInt(process.env.AVALANCHE_MAX_RPC_RPM || '300'),
        requestDelay: 50,
        retryAttempts: 5,
        retryDelay: 1000,
    },

    // Contract addresses
    contracts: {
        multicall: '0xcA11bde05977b3631167028862bE2a173976CA11',
        flashLoanProvider: process.env.AVALANCHE_FLASH_CONTRACT || null,
    },

    // DEX Configurations
    dexes: {
        traderjoe: {
            name: 'TraderJoe',
            router: '0x60aE616a2155Ee3d9A68541Ba4544862310933d4',
            factory: '0x9Ad6C38BE94206cA50bb0d90783181e7c50F92A8',
            fee: 0.003,
            enabled: true,
            type: 'uniswapV2',
            tvlRank: 1,
        },
        pangolin: {
            name: 'Pangolin',
            router: '0xE54Ca86531e17Ef3616d22Ca28b0D458b6C89106',
            factory: '0xefa94DE7a4656D787667C749f7E1223D71E9FD88',
            fee: 0.003,
            enabled: true,
            type: 'uniswapV2',
            tvlRank: 2,
        },
        sushiswap: {
            name: 'SushiSwap',
            router: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
            factory: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
            fee: 0.003,
            enabled: true,
            type: 'uniswapV2',
            tvlRank: 3,
        },
        uniswapV3: {
            name: 'Uniswap V3',
            router: '0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE',
            factory: '0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD',
            quoter: '0xbe0F5544EC67e9B3b2D979aaA43f18Fd87E6257F',
            enabled: true,
            type: 'uniswapV3',
            feeTiers: [100, 500, 3000, 10000],
            tvlRank: 2,
        },
    },

    // Token configuration
    tokens: {
        WAVAX: {
            symbol: 'WAVAX',
            address: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
            decimals: 18,
        },
        USDT: {
            symbol: 'USDT',
            address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7',
            decimals: 6,
        },
        USDC: {
            symbol: 'USDC',
            address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
            decimals: 6,
        },
        'USDC.e': {
            symbol: 'USDC.e',
            address: '0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664',
            decimals: 6,
        },
        DAI: {
            symbol: 'DAI',
            address: '0xd586E7F844cEa2F87f50152665BCbc2C279D8d70',
            decimals: 18,
        },
        'WETH.e': {
            symbol: 'WETH.e',
            address: '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB',
            decimals: 18,
        },
        'WBTC.e': {
            symbol: 'WBTC.e',
            address: '0x50b7545627a5162F82A992c33b87aDc75187B218',
            decimals: 8,
        },
        JOE: {
            symbol: 'JOE',
            address: '0x6e84a6216eA6dACC71eE8E6b0a5B7322EEbC0fDd',
            decimals: 18,
        },
        PNG: {
            symbol: 'PNG',
            address: '0x60781C2586D68229fde47564546784ab3fACA982',
            decimals: 18,
        },
        QI: {
            symbol: 'QI',
            address: '0x8729438EB15e2C8B576fCc6AeCdA6A148776C0F5',
            decimals: 18,
        },
        sAVAX: {
            symbol: 'sAVAX',
            address: '0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE',
            decimals: 18,
        },
        GMX: {
            symbol: 'GMX',
            address: '0x62edc0692BD897D2295872a9FFCac5425011c661',
            decimals: 18,
        },
    },

    // Base tokens
    baseTokens: ['WAVAX', 'USDT', 'USDC', 'USDC.e', 'DAI', 'WETH.e'],

    // Trading parameters
    trading: {
        minProfitPercentage: parseFloat(process.env.AVALANCHE_MIN_PROFIT || '0.3'),
        maxSlippage: parseFloat(process.env.AVALANCHE_MAX_SLIPPAGE || '1.0'),
        gasPriceGwei: parseInt(process.env.AVALANCHE_GAS_PRICE || '25'),
        estimatedGasLimit: 350000,
    },

    // Monitoring
    monitoring: {
        maxPairsToMonitor: parseInt(process.env.AVALANCHE_MAX_PAIRS || '200'),
        cacheSize: parseInt(process.env.AVALANCHE_CACHE_SIZE || '1500'),
        blockProcessingTimeout: parseInt(process.env.AVALANCHE_BLOCK_TIMEOUT || '1800'),
    },

    // Triangular arbitrage
    triangular: {
        enabled: process.env.AVALANCHE_TRIANGULAR_ENABLED !== 'false',
        maxPathLength: 4,
        minLiquidityUSD: parseInt(process.env.AVALANCHE_TRIANGULAR_MIN_LIQUIDITY || '5000'),
        maxTradeSizeUSD: parseInt(process.env.AVALANCHE_TRIANGULAR_MAX_TRADE || '5000'),
    },

    // Execution
    execution: {
        enabled: process.env.AVALANCHE_EXECUTION_ENABLED === 'true',
        mode: process.env.AVALANCHE_EXECUTION_MODE || 'simulation',
        contractAddress: process.env.AVALANCHE_FLASH_CONTRACT || null,
        privateKey: process.env.AVALANCHE_PRIVATE_KEY || null,
        minProfitUSD: parseFloat(process.env.AVALANCHE_MIN_PROFIT_USD || '1.0'),
        maxGasPriceGwei: parseInt(process.env.AVALANCHE_MAX_GAS_PRICE || '50'),
        slippageTolerance: parseFloat(process.env.AVALANCHE_SLIPPAGE_TOLERANCE || '1.0'),
    },

    // Flash loan providers
    flashLoan: {
        providers: ['aave', 'benqi'],
        preferredProvider: 'aave',
        aave: {
            poolAddress: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
            fee: 0.0009,
        },
        benqi: {
            comptroller: '0x486Af39519B4Dc9a7fCcd318217352830E8AD9b4',
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
