import dotenv from 'dotenv';

dotenv.config();

/**
 * zkSync Era Chain Configuration
 * Chain ID: 324
 *
 * zkSync Era is a Layer 2 using ZK rollups for Ethereum scaling.
 * Key characteristics:
 * - ZK validity proofs for security
 * - ~1-2 second block times
 * - Native ETH as gas token
 * - Growing DeFi ecosystem with less MEV competition
 */
export default {
    // Chain identification
    name: 'zkSync Era',
    chainId: 324,
    enabled: process.env.ZKSYNC_ENABLED === 'true',
    blockTime: 1500, // ~1-2 seconds

    // Native token
    nativeToken: {
        symbol: 'ETH',
        decimals: 18,
        wrapped: '0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91', // WETH
        priceUSD: 3500, // Approximate, should be fetched dynamically
    },

    // RPC Configuration
    rpc: {
        alchemy: {
            http: process.env.ZKSYNC_ALCHEMY_HTTP || '',
            ws: process.env.ZKSYNC_ALCHEMY_WS || '',
        },

        http: [
            process.env.ZKSYNC_ALCHEMY_HTTP,
            process.env.ZKSYNC_RPC_HTTP_1,
            'https://mainnet.era.zksync.io',
            'https://zksync.drpc.org',
            'https://zksync-era.blockpi.network/v1/rpc/public',
            'https://zksync.meowrpc.com',
            'https://1rpc.io/zksync2-era',
        ].filter(Boolean).map(url => url.trim()),

        ws: [
            process.env.ZKSYNC_ALCHEMY_WS,
            'wss://mainnet.era.zksync.io/ws',
        ].filter(Boolean).map(url => url.trim()),

        maxRequestsPerMinute: parseInt(process.env.ZKSYNC_MAX_RPC_RPM || process.env.MAX_RPC_RPM || '300'),
        requestDelay: 50,
        retryAttempts: 5,
        retryDelay: 1000,
    },

    // Contract addresses (zkSync has different Multicall)
    contracts: {
        multicall: '0xF9cda624FBC7e059355ce98a31693d299FACd963', // zkSync Multicall3
        flashLoanProvider: process.env.ZKSYNC_FLASH_CONTRACT || null,
    },

    // DEX Configurations
    dex: {
        // SyncSwap - Dominant DEX on zkSync
        syncswap: {
            name: 'SyncSwap',
            router: '0x2da10A1e27bF85cEdD8FFb1AbBe97e53391C0295',
            factory: '0xf2DAd89f2788a8CD54625C60b55cD3d2D0ACa7Cb',
            fee: 0.003,
            enabled: true,
            type: 'syncswap',
            tvlRank: 1,
        },
        // Mute.io
        mute: {
            name: 'Mute.io',
            router: '0x8B791913eB07C32779a16750e3868aA8495F5964',
            factory: '0x40be1cBa6C5B47cDF9da7f963B6F761F4C60627D',
            fee: 0.003,
            enabled: true,
            type: 'uniswapV2',
            tvlRank: 2,
        },
        // SpaceFi
        spacefi: {
            name: 'SpaceFi',
            router: '0xbE7D1FD1f6748bbDefC4fbaCafBb11C6Fc506d1d',
            factory: '0x0700Fb51560CfC8F896B2c812499D17c5B0bF6A7',
            fee: 0.003,
            enabled: true,
            type: 'uniswapV2',
            tvlRank: 3,
        },
        // Velocore - Solidly-style
        velocore: {
            name: 'Velocore',
            router: '0xF29Eb540eEba673f8Fb6131a7C7403C8e4C3f143',
            vault: '0xf5E67261CB357eDb6C7719fEFAFaaB280cB5E2A6',
            fee: 0.003,
            enabled: true,
            type: 'solidly',
            tvlRank: 4,
        },
        // zkSwap
        zkswap: {
            name: 'zkSwap',
            router: '0x18381c0f738146Fb694DE18D1106BdE2BE040Fa4',
            factory: '0x3a76e377ED58c8731F9DF3A36155942438744Ce3',
            fee: 0.003,
            enabled: true,
            type: 'uniswapV2',
            tvlRank: 5,
        },
        // Maverick
        maverick: {
            name: 'Maverick',
            router: '0x39E098A153Ad69834a9Dac32f0FCa92066aD03f4',
            factory: '0x2C1a605f843A2E18b7d7772f0Ce23c236acCF7f5',
            enabled: true,
            type: 'maverick',
            tvlRank: 6,
            fee: 0.003,
        },
        // PancakeSwap
        pancakeswap: {
            name: 'PancakeSwap',
            router: '0xf8b59f3c3Ab33200ec80a8A58b2aA5F5D2a8944C',
            factory: '0x1BB72E0CbbEA93c08f535fc7856E0338D7F7a8aB',
            enabled: true,
            type: 'uniswapV2',
            tvlRank: 7,
            fee: 0.0025,
        },
    },

    // Token configuration
    tokens: {
        WETH: {
            symbol: 'WETH',
            address: '0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91',
            decimals: 18,
        },
        USDC: {
            symbol: 'USDC',
            address: '0x3355df6D4c9C3035724Fd0e3914dE96A5a83aaf4',
            decimals: 6,
        },
        USDT: {
            symbol: 'USDT',
            address: '0x493257fD37EDB34451f62EDf8D2a0C418852bA4C',
            decimals: 6,
        },
        WBTC: {
            symbol: 'WBTC',
            address: '0xBBeB516fb02a01611cBBE0453Fe3c580D7281011',
            decimals: 8,
        },
        DAI: {
            symbol: 'DAI',
            address: '0x4B9eb6c0b6ea15176BBF62841C6B2A8a398cb656',
            decimals: 18,
        },
        ZK: {
            symbol: 'ZK',
            address: '0x5A7d6b2F92C77FAD6CCaBd7EE0624E64907Eaf3E',
            decimals: 18,
        },
        BUSD: {
            symbol: 'BUSD',
            address: '0x2039bb4116B4EFc145Ec4f0e2eA75012D6C0f181',
            decimals: 18,
        },
        MUTE: {
            symbol: 'MUTE',
            address: '0x0e97C7a0F8B2C9885C8ac9fC6136e829CbC21d42',
            decimals: 18,
        },
        VC: {
            symbol: 'VC',
            address: '0x85D84c774CF8e9fF85342684b0E795Df72A24908',
            decimals: 18,
        },
        LUSD: {
            symbol: 'LUSD',
            address: '0x503234F203fC7Eb888EEC8513210612a43Cf6115',
            decimals: 18,
        },
        HOLD: {
            symbol: 'HOLD',
            address: '0xed4040fD47629e7c8FBB7DA76bb50B3e7695F0f2',
            decimals: 18,
        },
    },

    // Base tokens for arbitrage paths
    baseTokens: ['WETH', 'USDC', 'USDT', 'WBTC', 'DAI', 'ZK'],

    // Trading parameters
    trading: {
        minProfitPercentage: parseFloat(process.env.ZKSYNC_MIN_PROFIT || '0.15'),
        maxSlippage: parseFloat(process.env.ZKSYNC_MAX_SLIPPAGE || '0.5'),
        gasPriceGwei: parseFloat(process.env.ZKSYNC_GAS_PRICE || '0.25'),
        estimatedGasLimit: 500000, // zkSync gas is different
    },

    // Monitoring configuration
    monitoring: {
        maxPairsToMonitor: parseInt(process.env.ZKSYNC_MAX_PAIRS || '150'),
        cacheSize: parseInt(process.env.ZKSYNC_CACHE_SIZE || '1000'),
        blockProcessingTimeout: parseInt(process.env.ZKSYNC_BLOCK_TIMEOUT || '1500'),
    },

    // Triangular arbitrage settings
    triangular: {
        enabled: process.env.ZKSYNC_TRIANGULAR_ENABLED !== 'false',
        maxPathLength: 4,
        minLiquidityUSD: parseInt(process.env.ZKSYNC_TRIANGULAR_MIN_LIQUIDITY || '2000'),
        maxTradeSizeUSD: parseInt(process.env.ZKSYNC_TRIANGULAR_MAX_TRADE || '3000'),
    },

    // V3 settings (limited on zkSync)
    v3: {
        enabled: false, // No standard V3 on zkSync
        feeTiers: [],
        minLiquidityUSD: 0,
        minProfitPercent: 0,
    },

    // Execution settings
    execution: {
        enabled: process.env.ZKSYNC_EXECUTION_ENABLED === 'true',
        mode: process.env.ZKSYNC_EXECUTION_MODE || 'simulation',
        contractAddress: process.env.ZKSYNC_FLASH_CONTRACT || null,
        privateKey: process.env.ZKSYNC_PRIVATE_KEY || process.env.PRIVATE_KEY || null,
        minProfitUSD: parseFloat(process.env.ZKSYNC_MIN_PROFIT_USD || '0.5'),
        maxGasPriceGwei: parseFloat(process.env.ZKSYNC_MAX_GAS_PRICE || '1'),
        slippageTolerance: parseFloat(process.env.ZKSYNC_SLIPPAGE_TOLERANCE || '0.5'),
        flashLoanFee: 0.003,
    },

    // Flash loan providers (limited on zkSync)
    flashLoan: {
        providers: [],
        preferredProvider: null,
    },

    // Bridge configurations
    bridges: {
        zkSyncBridge: {
            l1Bridge: '0x32400084C286CF3E17e7B677ea9583e60a000324',
            enabled: true,
        },
    },
};
