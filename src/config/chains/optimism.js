import dotenv from 'dotenv';

dotenv.config();

/**
 * Optimism Chain Configuration
 * Chain ID: 10
 *
 * Optimism is a Layer 2 scaling solution using optimistic rollups.
 * Key characteristics:
 * - Very low gas costs (~$0.01-0.05 per tx)
 * - ~2 second block times
 * - Native ETH as gas token
 * - Strong DeFi ecosystem with Velodrome as dominant DEX
 */
export default {
    // Chain identification
    name: 'Optimism Mainnet',
    chainId: 10,
    enabled: process.env.OPTIMISM_ENABLED === 'true',
    blockTime: 2000, // ~2 seconds

    // Native token
    nativeToken: {
        symbol: 'ETH',
        decimals: 18,
        wrapped: '0x4200000000000000000000000000000000000006', // WETH
        priceUSD: 3500, // Approximate, should be fetched dynamically
    },

    // RPC Configuration
    rpc: {
        alchemy: {
            http: process.env.OPTIMISM_ALCHEMY_HTTP || '',
            ws: process.env.OPTIMISM_ALCHEMY_WS || '',
        },

        http: [
            process.env.OPTIMISM_ALCHEMY_HTTP,
            process.env.OPTIMISM_RPC_HTTP_1,
            'https://mainnet.optimism.io',
            'https://optimism.llamarpc.com',
            'https://optimism-mainnet.public.blastapi.io',
            'https://rpc.ankr.com/optimism',
            'https://optimism.publicnode.com',
        ].filter(Boolean).map(url => url.trim()),

        ws: [
            process.env.OPTIMISM_ALCHEMY_WS,
            'wss://optimism.publicnode.com',
        ].filter(Boolean).map(url => url.trim()),

        maxRequestsPerMinute: parseInt(process.env.OPTIMISM_MAX_RPC_RPM || process.env.MAX_RPC_RPM || '300'),
        requestDelay: 50,
        retryAttempts: 5,
        retryDelay: 1000,
    },

    // Contract addresses
    contracts: {
        multicall: '0xcA11bde05977b3631167028862bE2a173976CA11', // Multicall3
        flashLoanProvider: process.env.OPTIMISM_FLASH_CONTRACT || null,
    },

    // DEX Configurations
    dex: {
        // Velodrome V2 - Dominant DEX on Optimism (solidly-style ve(3,3))
        velodrome: {
            name: 'Velodrome V2',
            router: '0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858',
            factory: '0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a',
            fee: 0.003,
            enabled: true,
            type: 'solidly',
            tvlRank: 1,
        },
        // Uniswap V3
        'uniswap-v3': {
            name: 'Uniswap V3',
            router: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
            factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
            quoter: '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6',
            enabled: true,
            type: 'uniswapV3',
            feeTiers: [100, 500, 3000, 10000],
            tvlRank: 2,
        },
        // Beethoven X (Balancer fork)
        beethovenx: {
            name: 'Beethoven X',
            router: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
            vault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
            enabled: true,
            type: 'balancer',
            tvlRank: 3,
            fee: 0.003,
        },
        // Curve Finance
        curve: {
            name: 'Curve Finance',
            router: '0x0DCDED3545D565bA3B19E683431381007245d983',
            enabled: true,
            type: 'curve',
            tvlRank: 4,
            fee: 0.0004,
        },
        // WooFi
        woofi: {
            name: 'WooFi',
            router: '0xEAf1Ac8E89EA0aE13E0f03634A4FF23502527024',
            enabled: true,
            type: 'woofi',
            tvlRank: 5,
            fee: 0.00025,
        },
        // Sushiswap
        sushiswap: {
            name: 'SushiSwap',
            router: '0x4C5D5234f232BD2D76B96aA33F5AE4FCF0E4BFAb',
            factory: '0xFbc12984689e5f15626Bad03Ad60160Fe98B303C',
            fee: 0.003,
            enabled: true,
            type: 'uniswapV2',
            tvlRank: 6,
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
            address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
            decimals: 6,
        },
        'USDC.e': {
            symbol: 'USDC.e',
            address: '0x7F5c764cBc14f9669B88837ca1490cCa17c31607',
            decimals: 6,
        },
        USDT: {
            symbol: 'USDT',
            address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
            decimals: 6,
        },
        DAI: {
            symbol: 'DAI',
            address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
            decimals: 18,
        },
        WBTC: {
            symbol: 'WBTC',
            address: '0x68f180fcCe6836688e9084f035309E29Bf0A2095',
            decimals: 8,
        },
        OP: {
            symbol: 'OP',
            address: '0x4200000000000000000000000000000000000042',
            decimals: 18,
        },
        wstETH: {
            symbol: 'wstETH',
            address: '0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb',
            decimals: 18,
        },
        rETH: {
            symbol: 'rETH',
            address: '0x9Bcef72be871e61ED4fBbc7630889beE758eb81D',
            decimals: 18,
        },
        SNX: {
            symbol: 'SNX',
            address: '0x8700dAec35aF8Ff88c16BdF0418774CB3D7599B4',
            decimals: 18,
        },
        LINK: {
            symbol: 'LINK',
            address: '0x350a791Bfc2C21F9Ed5d10980Dad2e2638ffa7f6',
            decimals: 18,
        },
        sUSD: {
            symbol: 'sUSD',
            address: '0x8c6f28f2F1A3C87F0f938b96d27520d9751ec8d9',
            decimals: 18,
        },
        VELO: {
            symbol: 'VELO',
            address: '0x9560e827aF36c94D2Ac33a39bCE1Fe78631088Db',
            decimals: 18,
        },
        FRAX: {
            symbol: 'FRAX',
            address: '0x2E3D870790dC77A83DD1d18184Acc7439A53f475',
            decimals: 18,
        },
    },

    // Base tokens for arbitrage paths
    baseTokens: ['WETH', 'USDC', 'USDC.e', 'USDT', 'DAI', 'wstETH', 'OP'],

    // Trading parameters
    trading: {
        minProfitPercentage: parseFloat(process.env.OPTIMISM_MIN_PROFIT || '0.1'),
        maxSlippage: parseFloat(process.env.OPTIMISM_MAX_SLIPPAGE || '0.5'),
        gasPriceGwei: parseFloat(process.env.OPTIMISM_GAS_PRICE || '0.001'),
        estimatedGasLimit: 400000,
    },

    // Monitoring configuration
    monitoring: {
        maxPairsToMonitor: parseInt(process.env.OPTIMISM_MAX_PAIRS || '200'),
        cacheSize: parseInt(process.env.OPTIMISM_CACHE_SIZE || '1500'),
        blockProcessingTimeout: parseInt(process.env.OPTIMISM_BLOCK_TIMEOUT || '2000'),
    },

    // Triangular arbitrage settings
    triangular: {
        enabled: process.env.OPTIMISM_TRIANGULAR_ENABLED !== 'false',
        maxPathLength: 4,
        minLiquidityUSD: parseInt(process.env.OPTIMISM_TRIANGULAR_MIN_LIQUIDITY || '3000'),
        maxTradeSizeUSD: parseInt(process.env.OPTIMISM_TRIANGULAR_MAX_TRADE || '5000'),
    },

    // V3 settings
    v3: {
        enabled: process.env.OPTIMISM_V3_ENABLED !== 'false',
        feeTiers: [100, 500, 3000, 10000],
        minLiquidityUSD: parseInt(process.env.OPTIMISM_V3_MIN_LIQUIDITY || '2000'),
        minProfitPercent: parseFloat(process.env.OPTIMISM_V3_MIN_PROFIT || '0.1'),
    },

    // Execution settings
    execution: {
        enabled: process.env.OPTIMISM_EXECUTION_ENABLED === 'true',
        mode: process.env.OPTIMISM_EXECUTION_MODE || 'simulation',
        contractAddress: process.env.OPTIMISM_FLASH_CONTRACT || null,
        privateKey: process.env.OPTIMISM_PRIVATE_KEY || process.env.PRIVATE_KEY || null,
        minProfitUSD: parseFloat(process.env.OPTIMISM_MIN_PROFIT_USD || '0.5'),
        maxGasPriceGwei: parseFloat(process.env.OPTIMISM_MAX_GAS_PRICE || '1'),
        slippageTolerance: parseFloat(process.env.OPTIMISM_SLIPPAGE_TOLERANCE || '0.5'),
        flashLoanFee: 0,
    },

    // Flash loan providers
    flashLoan: {
        providers: ['balancer', 'aave'],
        preferredProvider: 'balancer',
        balancer: {
            vault: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
            fee: 0,
        },
        aave: {
            poolProvider: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb',
            fee: 0.0005,
        },
    },

    // Bridge configurations
    bridges: {
        stargate: {
            router: '0xB0D502E938ed5f4df2E681fE6E419ff29631d62b',
            enabled: true,
        },
    },
};
