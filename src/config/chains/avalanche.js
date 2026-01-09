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
    enabled: process.env.AVALANCHE_ENABLED !== 'false',
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

        // FIX v3.10: Expanded free HTTP endpoints for better rate limit resilience
        http: [
            // Tier 1: Official & most reliable
            'https://api.avax.network/ext/bc/C/rpc',  // Avalanche official - free
            'https://avalanche.llamarpc.com',         // LlamaRPC - reliable
            'https://avalanche-c-chain.publicnode.com', // PublicNode - reliable
            // Tier 2: Additional free endpoints
            'https://avalanche.public-rpc.com',       // Public RPC
            'https://rpc.ankr.com/avalanche',         // Ankr - free tier
            'https://1rpc.io/avax/c',                 // 1RPC - privacy-focused
            'https://avalanche.drpc.org',             // dRPC - free tier
            'https://avax.meowrpc.com',               // MeowRPC - free
            'https://avalanche-c-chain-rpc.publicnode.com', // PublicNode backup
            // Tier 3: Custom & paid (last resort)
            process.env.AVALANCHE_RPC_HTTP_1,
            process.env.AVALANCHE_ALCHEMY_HTTP,       // Alchemy last (paid)
        ].filter(Boolean).map(url => url.trim()),

        // FIX v3.10: Expanded WS endpoints
        ws: [
            'wss://avalanche-c-chain.publicnode.com', // PublicNode - free
            'wss://avalanche-c-chain-rpc.publicnode.com', // PublicNode backup
            process.env.AVALANCHE_RPC_WS_1,
            process.env.AVALANCHE_ALCHEMY_WS,         // Alchemy last (paid)
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

    // DEX Configurations (use 'dex' for backward compatibility with legacy code)
    dex: {
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
        // Additional high-volume Avalanche tokens
        LINK: {
            symbol: 'LINK',
            address: '0x5947BB275c521040051D82396192181b413227A3',
            decimals: 18,
        },
        AAVE: {
            symbol: 'AAVE',
            address: '0x63a72806098Bd3D9520cC43356dD78afe5D386D9',
            decimals: 18,
        },
        SUSHI: {
            symbol: 'SUSHI',
            address: '0x37B608519F91f70F2EeB0e5Ed9AF4061722e4F76',
            decimals: 18,
        },
        CRV: {
            symbol: 'CRV',
            address: '0x47536F17F4fF30e64A96a7555826b8f9e66ec468',
            decimals: 18,
        },
        STG: {
            symbol: 'STG',
            address: '0x2F6F07CDcf3588944Bf4C42aC74ff24bF56e7590',
            decimals: 18,
        },
        MIM: {
            symbol: 'MIM',
            address: '0x130966628846BFd36ff31a822705796e8cb8C18D',
            decimals: 18,
        },
        SPELL: {
            symbol: 'SPELL',
            address: '0xCE1bFFBD5374Dac86a2893119683F4911a2F7814',
            decimals: 18,
        },
        TIME: {
            symbol: 'TIME',
            address: '0xb54f16fB19478766A268F172C9480f8da1a7c9C3',
            decimals: 9,
        },
        FRAX: {
            symbol: 'FRAX',
            address: '0xD24C2Ad096400B6FBcd2ad8B24E7acBc21A1da64',
            decimals: 18,
        },
        FXS: {
            symbol: 'FXS',
            address: '0x214DB107654fF987AD859F34125307783fC8e387',
            decimals: 18,
        },
        YAK: {
            symbol: 'YAK',
            address: '0x59414b3089ce2AF0010e7523Dea7E2b35d776ec7',
            decimals: 18,
        },
        XAVA: {
            symbol: 'XAVA',
            address: '0xd1c3f94DE7e5B45fa4eDBBA472491a9f4B166FC4',
            decimals: 18,
        },
    },

    // Base tokens - Expanded for more triangular paths
    baseTokens: ['WAVAX', 'USDT', 'USDC', 'USDC.e', 'DAI', 'WETH.e', 'MIM', 'FRAX'],

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

    // V3 (concentrated liquidity) settings
    v3: {
        enabled: process.env.AVALANCHE_V3_ENABLED !== 'false',
        feeTiers: [100, 500, 3000, 10000],
        minLiquidityUSD: parseInt(process.env.AVALANCHE_V3_MIN_LIQUIDITY || '3000'),
        minProfitPercent: parseFloat(process.env.AVALANCHE_V3_MIN_PROFIT || '0.15'),
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
