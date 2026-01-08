import dotenv from 'dotenv';

dotenv.config();

/**
 * Fantom Chain Configuration
 * Chain ID: 250
 *
 * Fantom is a high-performance L1 using DAG-based consensus (Lachesis).
 * Key characteristics:
 * - Extremely fast finality (~1 second)
 * - Very low gas costs
 * - Native FTM as gas token
 * - Multiple active DEXes creating arbitrage opportunities
 */
export default {
    // Chain identification
    name: 'Fantom Opera',
    chainId: 250,
    enabled: process.env.FANTOM_ENABLED !== 'false', // Enabled by default, set FANTOM_ENABLED=false to disable
    blockTime: 1000, // ~1 second (very fast!)

    // Native token
    nativeToken: {
        symbol: 'FTM',
        decimals: 18,
        wrapped: '0x21be370D5312f44cB42ce377BC9b8a0cEF1A4C83', // WFTM
        priceUSD: 0.5, // Approximate, should be fetched dynamically
    },

    // RPC Configuration
    rpc: {
        alchemy: {
            http: process.env.FANTOM_ALCHEMY_HTTP || '',
            ws: process.env.FANTOM_ALCHEMY_WS || '',
        },

        http: [
            process.env.FANTOM_ALCHEMY_HTTP,
            process.env.FANTOM_RPC_HTTP_1,
            'https://rpc.ftm.tools',
            'https://fantom.publicnode.com',
            'https://rpc.ankr.com/fantom',
            'https://fantom-mainnet.public.blastapi.io',
            'https://rpcapi.fantom.network',
        ].filter(Boolean).map(url => url.trim()),

        ws: [
            process.env.FANTOM_ALCHEMY_WS,
            'wss://fantom.publicnode.com',
        ].filter(Boolean).map(url => url.trim()),

        maxRequestsPerMinute: parseInt(process.env.FANTOM_MAX_RPC_RPM || process.env.MAX_RPC_RPM || '300'),
        requestDelay: 50,
        retryAttempts: 5,
        retryDelay: 1000,
    },

    // Contract addresses
    contracts: {
        multicall: '0xcA11bde05977b3631167028862bE2a173976CA11', // Multicall3
        flashLoanProvider: process.env.FANTOM_FLASH_CONTRACT || null,
    },

    // DEX Configurations
    dex: {
        // SpookySwap - Dominant DEX on Fantom
        spookyswap: {
            name: 'SpookySwap',
            router: '0xF491e7B69E4244ad4002BC14e878a34207E38c29',
            factory: '0x152eE697f2E276fA89E96742e9bB9aB1F2E61bE3',
            fee: 0.002,
            enabled: true,
            type: 'uniswapV2',
            tvlRank: 1,
        },
        // Equalizer - Solidly fork
        equalizer: {
            name: 'Equalizer',
            router: '0x1A05EB736873485655F29a37DEf8a0AA87F5a447',
            factory: '0xc6366EFD0AF1d09171fe0EBF32c7943BB310832a',
            fee: 0.003,
            enabled: true,
            type: 'solidly',
            tvlRank: 2,
        },
        // SpiritSwap
        spiritswap: {
            name: 'SpiritSwap',
            router: '0x16327E3FbDaCA3bcF7E38F5Af2599D2DDc33aE52',
            factory: '0xEF45d134b73241eDa7703fa787148D9C9F4950b0',
            fee: 0.003,
            enabled: true,
            type: 'uniswapV2',
            tvlRank: 3,
        },
        // Beethoven X (Balancer fork)
        beethovenx: {
            name: 'Beethoven X',
            router: '0x20dd72Ed959b6147912C2e529F0a0C651c33c9ce',
            vault: '0x20dd72Ed959b6147912C2e529F0a0C651c33c9ce',
            enabled: true,
            type: 'balancer',
            tvlRank: 4,
            fee: 0.003,
        },
        // Curve Finance
        curve: {
            name: 'Curve Finance',
            router: '0x0DCDED3545D565bA3B19E683431381007245d983',
            enabled: true,
            type: 'curve',
            tvlRank: 5,
            fee: 0.0004,
        },
        // WooFi
        woofi: {
            name: 'WooFi',
            router: '0x382A9b0bC5D29e96c3a0b81cE9c64d6C8F150Efb',
            enabled: true,
            type: 'woofi',
            tvlRank: 6,
            fee: 0.00025,
        },
        // SushiSwap
        sushiswap: {
            name: 'SushiSwap',
            router: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
            factory: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
            fee: 0.003,
            enabled: true,
            type: 'uniswapV2',
            tvlRank: 7,
        },
        // ProtoFi
        protofi: {
            name: 'ProtoFi',
            router: '0xF4C587a0972Ac2039BFF67Bc44574bB403eF5235',
            factory: '0x39720E5Fe53BEEeb9De4759c0D0AaEfFbcfa1862',
            fee: 0.003,
            enabled: true,
            type: 'uniswapV2',
            tvlRank: 8,
        },
    },

    // Token configuration
    tokens: {
        WFTM: {
            symbol: 'WFTM',
            address: '0x21be370D5312f44cB42ce377BC9b8a0cEF1A4C83',
            decimals: 18,
        },
        USDC: {
            symbol: 'USDC',
            address: '0x04068DA6C83AFCFA0e13ba15A6696662335D5B75',
            decimals: 6,
        },
        USDT: {
            symbol: 'USDT',
            address: '0x049d68029688eAbF473097a2fC38ef61633A3C7A',
            decimals: 6,
        },
        DAI: {
            symbol: 'DAI',
            address: '0x8D11eC38a3EB5E956B052f67Da8Bdc9bef8Abf3E',
            decimals: 18,
        },
        WBTC: {
            symbol: 'WBTC',
            address: '0x321162Cd933E2Be498Cd2267a90534A804051b11',
            decimals: 8,
        },
        WETH: {
            symbol: 'WETH',
            address: '0x74b23882a30290451A17c44f4F05243b6b58C76d',
            decimals: 18,
        },
        BOO: {
            symbol: 'BOO',
            address: '0x841FAD6EAe12c286d1Fd18d1d525DFfA75C7EFFE',
            decimals: 18,
        },
        SPIRIT: {
            symbol: 'SPIRIT',
            address: '0x5Cc61A78F164885776AA610fb0FE1257df78E59B',
            decimals: 18,
        },
        EQUAL: {
            symbol: 'EQUAL',
            address: '0x3Fd3A0c85B70754eFc07aC9Ac0cbBDCe664865A6',
            decimals: 18,
        },
        sFTMx: {
            symbol: 'sFTMx',
            address: '0xd7028092c830b5C8FcE061Af2E593413EbbC1fc1',
            decimals: 18,
        },
        MIM: {
            symbol: 'MIM',
            address: '0x82f0B8B456c1A451378467398982d4834b6829c1',
            decimals: 18,
        },
        FRAX: {
            symbol: 'FRAX',
            address: '0xdc301622e621166BD8E82f2cA0A26c13Ad0BE355',
            decimals: 18,
        },
        LINK: {
            symbol: 'LINK',
            address: '0xb3654dc3D10Ea7645f8319668E8F54d2574FBdC8',
            decimals: 18,
        },
        CRV: {
            symbol: 'CRV',
            address: '0x1E4F97b9f9F913c46F1632781732927B9019C68b',
            decimals: 18,
        },
    },

    // Base tokens for arbitrage paths
    baseTokens: ['WFTM', 'USDC', 'USDT', 'DAI', 'WETH', 'WBTC', 'MIM'],

    // Trading parameters
    trading: {
        minProfitPercentage: parseFloat(process.env.FANTOM_MIN_PROFIT || '0.15'),
        maxSlippage: parseFloat(process.env.FANTOM_MAX_SLIPPAGE || '0.5'),
        gasPriceGwei: parseInt(process.env.FANTOM_GAS_PRICE || '50'),
        estimatedGasLimit: 350000,
    },

    // Monitoring configuration
    monitoring: {
        maxPairsToMonitor: parseInt(process.env.FANTOM_MAX_PAIRS || '250'),
        cacheSize: parseInt(process.env.FANTOM_CACHE_SIZE || '2000'),
        blockProcessingTimeout: parseInt(process.env.FANTOM_BLOCK_TIMEOUT || '1000'),
    },

    // Triangular arbitrage settings
    triangular: {
        enabled: process.env.FANTOM_TRIANGULAR_ENABLED !== 'false',
        maxPathLength: 4,
        minLiquidityUSD: parseInt(process.env.FANTOM_TRIANGULAR_MIN_LIQUIDITY || '2000'),
        maxTradeSizeUSD: parseInt(process.env.FANTOM_TRIANGULAR_MAX_TRADE || '3000'),
    },

    // V3 settings (limited V3 on Fantom)
    v3: {
        enabled: false, // No major V3 DEX on Fantom
        feeTiers: [],
        minLiquidityUSD: 0,
        minProfitPercent: 0,
    },

    // Execution settings
    execution: {
        enabled: process.env.FANTOM_EXECUTION_ENABLED === 'true',
        mode: process.env.FANTOM_EXECUTION_MODE || 'simulation',
        contractAddress: process.env.FANTOM_FLASH_CONTRACT || null,
        privateKey: process.env.FANTOM_PRIVATE_KEY || process.env.PRIVATE_KEY || null,
        minProfitUSD: parseFloat(process.env.FANTOM_MIN_PROFIT_USD || '0.5'),
        maxGasPriceGwei: parseInt(process.env.FANTOM_MAX_GAS_PRICE || '200'),
        slippageTolerance: parseFloat(process.env.FANTOM_SLIPPAGE_TOLERANCE || '0.5'),
        flashLoanFee: 0,
    },

    // Flash loan providers
    flashLoan: {
        providers: ['beethovenx'],
        preferredProvider: 'beethovenx',
        beethovenx: {
            vault: '0x20dd72Ed959b6147912C2e529F0a0C651c33c9ce',
            fee: 0,
        },
    },

    // Bridge configurations
    bridges: {
        stargate: {
            router: '0xAf5191B0De278C7286d6C7CC6ab6BB8A73bA2Cd6',
            enabled: true,
        },
    },
};
