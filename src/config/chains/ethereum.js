import dotenv from 'dotenv';

dotenv.config();

/**
 * Ethereum Mainnet Configuration
 * Chain ID: 1
 */
export default {
    // Chain identification
    name: 'Ethereum Mainnet',
    chainId: 1,
    enabled: process.env.ETH_ENABLED !== 'false',
    blockTime: 12000, // 12 seconds average

    // Native token
    nativeToken: {
        symbol: 'ETH',
        decimals: 18,
        wrapped: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
        priceUSD: 3500, // Approximate, should be fetched dynamically
    },

    // RPC Configuration
    rpc: {
        alchemy: {
            http: process.env.ETH_ALCHEMY_HTTP || '',
            ws: process.env.ETH_ALCHEMY_WS || '',
        },

        http: [
            process.env.ETH_ALCHEMY_HTTP,
            process.env.ETH_RPC_HTTP_1,
            'https://eth.llamarpc.com',
            'https://ethereum.publicnode.com',
            'https://rpc.ankr.com/eth',
        ].filter(Boolean).map(url => url.trim()),

        ws: [
            process.env.ETH_ALCHEMY_WS,
            process.env.ETH_RPC_WS_1,
            'wss://ethereum.publicnode.com',
        ].filter(Boolean).map(url => url.trim()),

        maxRequestsPerMinute: parseInt(process.env.ETH_MAX_RPC_RPM || '300'),
        requestDelay: 100,
        retryAttempts: 5,
        retryDelay: 1000,
    },

    // Contract addresses
    contracts: {
        multicall: '0xcA11bde05977b3631167028862bE2a173976CA11', // Multicall3
        flashLoanProvider: process.env.ETH_FLASH_CONTRACT || null,
    },

    // DEX Configurations
    dexes: {
        uniswapV2: {
            name: 'Uniswap V2',
            router: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
            factory: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
            fee: 0.003,
            enabled: true,
            type: 'uniswapV2',
            tvlRank: 1,
        },
        uniswapV3: {
            name: 'Uniswap V3',
            router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
            factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
            quoter: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6',
            enabled: true,
            type: 'uniswapV3',
            feeTiers: [100, 500, 3000, 10000], // 0.01%, 0.05%, 0.3%, 1%
            tvlRank: 1,
        },
        sushiswap: {
            name: 'SushiSwap',
            router: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F',
            factory: '0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac',
            fee: 0.003,
            enabled: true,
            type: 'uniswapV2',
            tvlRank: 2,
        },
        curve: {
            name: 'Curve Finance',
            registry: '0x90E00ACe148ca3b23Ac1bC8C240C2a7Dd9c2d7f5',
            enabled: false, // Requires custom implementation
            type: 'curve',
            tvlRank: 3,
        },
    },

    // Token configuration
    tokens: {
        WETH: {
            symbol: 'WETH',
            address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
            decimals: 18,
        },
        USDT: {
            symbol: 'USDT',
            address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
            decimals: 6,
        },
        USDC: {
            symbol: 'USDC',
            address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
            decimals: 6,
        },
        DAI: {
            symbol: 'DAI',
            address: '0x6B175474E89094C44Da98b954EedeAC8b5bAef36',
            decimals: 18,
        },
        WBTC: {
            symbol: 'WBTC',
            address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
            decimals: 8,
        },
        UNI: {
            symbol: 'UNI',
            address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
            decimals: 18,
        },
        LINK: {
            symbol: 'LINK',
            address: '0x514910771AF9Ca656af840dff83E8264EcF986CA',
            decimals: 18,
        },
        AAVE: {
            symbol: 'AAVE',
            address: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9',
            decimals: 18,
        },
        CRV: {
            symbol: 'CRV',
            address: '0xD533a949740bb3306d119CC777fa900bA034cd52',
            decimals: 18,
        },
        MKR: {
            symbol: 'MKR',
            address: '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2',
            decimals: 18,
        },
        SHIB: {
            symbol: 'SHIB',
            address: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE',
            decimals: 18,
        },
        PEPE: {
            symbol: 'PEPE',
            address: '0x6982508145454Ce325dDbE47a25d4ec3d2311933',
            decimals: 18,
        },
    },

    // Base tokens
    baseTokens: ['WETH', 'USDT', 'USDC', 'DAI', 'WBTC'],

    // Trading parameters
    trading: {
        minProfitPercentage: parseFloat(process.env.ETH_MIN_PROFIT || '0.3'),
        maxSlippage: parseFloat(process.env.ETH_MAX_SLIPPAGE || '0.5'),
        gasPriceGwei: parseInt(process.env.ETH_GAS_PRICE || '30'),
        estimatedGasLimit: 400000,
    },

    // Monitoring
    monitoring: {
        maxPairsToMonitor: parseInt(process.env.ETH_MAX_PAIRS || '150'),
        cacheSize: parseInt(process.env.ETH_CACHE_SIZE || '1500'),
        blockProcessingTimeout: parseInt(process.env.ETH_BLOCK_TIMEOUT || '10000'),
    },

    // Triangular arbitrage
    triangular: {
        enabled: process.env.ETH_TRIANGULAR_ENABLED !== 'false',
        maxPathLength: 4,
        minLiquidityUSD: parseInt(process.env.ETH_TRIANGULAR_MIN_LIQUIDITY || '50000'),
        maxTradeSizeUSD: parseInt(process.env.ETH_TRIANGULAR_MAX_TRADE || '10000'),
    },

    // Execution
    execution: {
        enabled: process.env.ETH_EXECUTION_ENABLED === 'true',
        mode: process.env.ETH_EXECUTION_MODE || 'simulation',
        contractAddress: process.env.ETH_FLASH_CONTRACT || null,
        privateKey: process.env.ETH_PRIVATE_KEY || null,
        minProfitUSD: parseFloat(process.env.ETH_MIN_PROFIT_USD || '10.0'),
        maxGasPriceGwei: parseInt(process.env.ETH_MAX_GAS_PRICE || '100'),
        slippageTolerance: parseFloat(process.env.ETH_SLIPPAGE_TOLERANCE || '0.5'),
    },

    // Flash loan providers
    flashLoan: {
        providers: ['aave', 'balancer', 'uniswapV3'],
        preferredProvider: 'balancer', // Zero fee
        aave: {
            poolAddress: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
            fee: 0.0009, // 0.09%
        },
        balancer: {
            vault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
            fee: 0, // No fee
        },
    },

    // Bridge configurations
    bridges: {
        stargate: {
            router: '0x8731d54E9D02c286767d56ac03e8037C07e01e98',
            enabled: true,
        },
    },
};
