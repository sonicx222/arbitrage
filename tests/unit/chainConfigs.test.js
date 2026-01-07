import { jest } from '@jest/globals';

// Import chain configurations
import bscConfig from '../../src/config/chains/bsc.js';
import ethereumConfig from '../../src/config/chains/ethereum.js';
import polygonConfig from '../../src/config/chains/polygon.js';
import arbitrumConfig from '../../src/config/chains/arbitrum.js';
import baseConfig from '../../src/config/chains/base.js';
import avalancheConfig from '../../src/config/chains/avalanche.js';

// Import config index functions
import { chainConfigs, getChainConfig, getEnabledChains, chainNames } from '../../src/config/index.js';

// Import chain factory
import chainFactory from '../../src/chains/ChainFactory.js';

/**
 * Chain Configuration Tests
 *
 * Validates that all chain configurations are correctly structured
 * and contain the required information for multi-chain operation.
 */
describe('Chain Configurations', () => {
    const allConfigs = [
        { name: 'BSC', config: bscConfig, chainId: 56 },
        { name: 'Ethereum', config: ethereumConfig, chainId: 1 },
        { name: 'Polygon', config: polygonConfig, chainId: 137 },
        { name: 'Arbitrum', config: arbitrumConfig, chainId: 42161 },
        { name: 'Base', config: baseConfig, chainId: 8453 },
        { name: 'Avalanche', config: avalancheConfig, chainId: 43114 },
    ];

    describe('Required Fields', () => {
        test.each(allConfigs)('$name config has required chain identification fields', ({ config, chainId }) => {
            expect(config.name).toBeDefined();
            expect(typeof config.name).toBe('string');
            expect(config.chainId).toBe(chainId);
            expect(typeof config.enabled).toBe('boolean');
            expect(config.blockTime).toBeGreaterThan(0);
        });

        test.each(allConfigs)('$name config has native token configuration', ({ config }) => {
            expect(config.nativeToken).toBeDefined();
            expect(config.nativeToken.symbol).toBeDefined();
            expect(config.nativeToken.decimals).toBe(18);
            expect(config.nativeToken.wrapped).toMatch(/^0x[a-fA-F0-9]{40}$/);
            expect(config.nativeToken.priceUSD).toBeGreaterThan(0);
        });

        test.each(allConfigs)('$name config has RPC configuration', ({ config }) => {
            expect(config.rpc).toBeDefined();
            expect(Array.isArray(config.rpc.http)).toBe(true);
            expect(Array.isArray(config.rpc.ws)).toBe(true);
            // At least one public RPC should be available
            expect(config.rpc.http.length).toBeGreaterThan(0);
        });

        test.each(allConfigs)('$name config has DEX configurations', ({ config }) => {
            expect(config.dex).toBeDefined();
            expect(typeof config.dex).toBe('object');

            const dexNames = Object.keys(config.dex);
            expect(dexNames.length).toBeGreaterThan(0);

            // Check at least one DEX is enabled
            const enabledDexes = Object.values(config.dex).filter(dex => dex.enabled);
            expect(enabledDexes.length).toBeGreaterThan(0);
        });

        test.each(allConfigs)('$name config has token configurations', ({ config }) => {
            expect(config.tokens).toBeDefined();
            expect(typeof config.tokens).toBe('object');
            expect(Object.keys(config.tokens).length).toBeGreaterThan(0);

            // Check token structure
            for (const [symbol, token] of Object.entries(config.tokens)) {
                expect(token.symbol).toBe(symbol);
                expect(token.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
                expect(token.decimals).toBeGreaterThanOrEqual(0);
                expect(token.decimals).toBeLessThanOrEqual(18);
            }
        });

        test.each(allConfigs)('$name config has base tokens array', ({ config }) => {
            expect(Array.isArray(config.baseTokens)).toBe(true);
            expect(config.baseTokens.length).toBeGreaterThan(0);

            // Base tokens should exist in tokens config
            for (const baseToken of config.baseTokens) {
                expect(config.tokens[baseToken]).toBeDefined();
            }
        });

        test.each(allConfigs)('$name config has trading parameters', ({ config }) => {
            expect(config.trading).toBeDefined();
            expect(config.trading.minProfitPercentage).toBeGreaterThanOrEqual(0);
            expect(config.trading.maxSlippage).toBeGreaterThan(0);
            expect(config.trading.gasPriceGwei).toBeGreaterThan(0);
            expect(config.trading.estimatedGasLimit).toBeGreaterThan(0);
        });

        test.each(allConfigs)('$name config has monitoring settings', ({ config }) => {
            expect(config.monitoring).toBeDefined();
            expect(config.monitoring.maxPairsToMonitor).toBeGreaterThan(0);
            expect(config.monitoring.cacheSize).toBeGreaterThan(0);
        });
    });

    describe('DEX Configuration Validity', () => {
        test.each(allConfigs)('$name DEXes have valid router/factory addresses', ({ config }) => {
            for (const [name, dex] of Object.entries(config.dex)) {
                if (!dex.enabled) continue;

                // All enabled DEXes should have a router address
                expect(dex.router).toMatch(/^0x[a-fA-F0-9]{40}$/);

                // V2-style DEXes need factory
                if (dex.type === 'uniswapV2') {
                    expect(dex.factory).toMatch(/^0x[a-fA-F0-9]{40}$/);
                    expect(dex.fee).toBeGreaterThan(0);
                    expect(dex.fee).toBeLessThan(0.1); // Fee should be < 10%
                }

                // V3-style DEXes need quoter and fee tiers
                if (dex.type === 'uniswapV3') {
                    expect(dex.factory).toMatch(/^0x[a-fA-F0-9]{40}$/);
                    expect(dex.quoter).toMatch(/^0x[a-fA-F0-9]{40}$/);
                    expect(Array.isArray(dex.feeTiers)).toBe(true);
                    expect(dex.feeTiers.length).toBeGreaterThan(0);
                }
            }
        });
    });

    describe('Cross-Chain Token Consistency', () => {
        test('Common tokens exist on all major chains', () => {
            const commonTokens = ['USDT', 'USDC'];
            const majorChains = [bscConfig, ethereumConfig, polygonConfig, arbitrumConfig];

            for (const token of commonTokens) {
                for (const config of majorChains) {
                    expect(config.tokens[token]).toBeDefined();
                    expect(config.tokens[token].address).toMatch(/^0x[a-fA-F0-9]{40}$/);
                }
            }
        });

        test('WETH exists on all EVM chains except BSC (has WBNB)', () => {
            expect(ethereumConfig.tokens.WETH).toBeDefined();
            expect(polygonConfig.tokens.WETH).toBeDefined();
            expect(arbitrumConfig.tokens.WETH).toBeDefined();
            expect(baseConfig.tokens.WETH).toBeDefined();
            expect(avalancheConfig.tokens.WAVAX).toBeDefined(); // Avalanche uses WAVAX

            // BSC uses WBNB instead
            expect(bscConfig.tokens.WBNB).toBeDefined();
        });
    });
});

describe('Config Index Functions', () => {
    describe('chainConfigs', () => {
        test('contains all 9 chain configurations', () => {
            expect(Object.keys(chainConfigs)).toHaveLength(9);
            expect(chainConfigs[56]).toBeDefined();    // BSC
            expect(chainConfigs[1]).toBeDefined();     // Ethereum
            expect(chainConfigs[137]).toBeDefined();   // Polygon
            expect(chainConfigs[42161]).toBeDefined(); // Arbitrum
            expect(chainConfigs[8453]).toBeDefined();  // Base
            expect(chainConfigs[43114]).toBeDefined(); // Avalanche
            expect(chainConfigs[10]).toBeDefined();    // Optimism
            expect(chainConfigs[250]).toBeDefined();   // Fantom
            expect(chainConfigs[324]).toBeDefined();   // zkSync Era
        });
    });

    describe('getChainConfig', () => {
        test('returns correct config for valid chain ID', () => {
            const bsc = getChainConfig(56);
            expect(bsc.name).toBe('BSC Mainnet');
            expect(bsc.chainId).toBe(56);

            const eth = getChainConfig(1);
            expect(eth.name).toBe('Ethereum Mainnet');
            expect(eth.chainId).toBe(1);
        });

        test('returns null for invalid chain ID', () => {
            expect(getChainConfig(999)).toBeNull();
            expect(getChainConfig(0)).toBeNull();
        });
    });

    describe('getEnabledChains', () => {
        test('returns object with enabled chains', () => {
            const enabled = getEnabledChains();
            expect(typeof enabled).toBe('object');

            // BSC is enabled by default
            expect(enabled[56]).toBeDefined();
        });

        test('returned object keys are chain IDs', () => {
            const enabled = getEnabledChains();
            for (const key of Object.keys(enabled)) {
                expect(parseInt(key)).not.toBeNaN();
            }
        });
    });

    describe('chainNames', () => {
        test('maps chain IDs to names', () => {
            expect(chainNames[56]).toBe('BSC');
            expect(chainNames[1]).toBe('Ethereum');
            expect(chainNames[137]).toBe('Polygon');
            expect(chainNames[42161]).toBe('Arbitrum');
            expect(chainNames[8453]).toBe('Base');
            expect(chainNames[43114]).toBe('Avalanche');
        });
    });
});

describe('Chain Factory', () => {
    describe('Chain name resolution', () => {
        test('resolves chain ID to name', () => {
            expect(chainFactory.getChainName(56)).toBe('bsc');
            expect(chainFactory.getChainName(1)).toBe('ethereum');
            expect(chainFactory.getChainName(137)).toBe('polygon');
            expect(chainFactory.getChainName(42161)).toBe('arbitrum');
            expect(chainFactory.getChainName(8453)).toBe('base');
            expect(chainFactory.getChainName(43114)).toBe('avalanche');
        });

        test('returns null for unknown chain ID', () => {
            expect(chainFactory.getChainName(999)).toBeNull();
        });

        test('resolves chain name to ID', () => {
            expect(chainFactory.getChainId('bsc')).toBe(56);
            expect(chainFactory.getChainId('ethereum')).toBe(1);
            expect(chainFactory.getChainId('Polygon')).toBe(137); // Case insensitive
        });
    });

    describe('Supported chains', () => {
        test('returns all supported chain IDs', () => {
            const supported = chainFactory.getSupportedChainIds();
            expect(supported).toContain(56);
            expect(supported).toContain(1);
            expect(supported).toContain(137);
            expect(supported).toContain(42161);
            expect(supported).toContain(8453);
            expect(supported).toContain(43114);
        });

        test('checks if chain is supported by ID', () => {
            expect(chainFactory.isSupported(56)).toBe(true);
            expect(chainFactory.isSupported(1)).toBe(true);
            expect(chainFactory.isSupported(999)).toBe(false);
        });

        test('checks if chain is supported by name', () => {
            expect(chainFactory.isSupported('bsc')).toBe(true);
            expect(chainFactory.isSupported('ethereum')).toBe(true);
            expect(chainFactory.isSupported('unknown')).toBe(false);
        });
    });

    describe('Chain creation', () => {
        test('creates BSC chain instance', async () => {
            const chain = await chainFactory.create(56, bscConfig);
            expect(chain).toBeDefined();
            expect(chain.chainId).toBe(56);
            expect(chain.name).toBe('BSC Mainnet');
        });

        test('throws for unknown chain ID', async () => {
            await expect(chainFactory.create(999, {})).rejects.toThrow('Unknown chain ID: 999');
        });
    });
});

describe('Chain Implementation Loading', () => {
    test('loads BSC chain implementation', async () => {
        const ChainClass = await chainFactory.loadChainImplementation('bsc');
        expect(ChainClass).toBeDefined();
        expect(ChainClass.name).toBe('BscChain');
    });

    test('loads Ethereum chain implementation', async () => {
        const ChainClass = await chainFactory.loadChainImplementation('ethereum');
        expect(ChainClass).toBeDefined();
        expect(ChainClass.name).toBe('EthereumChain');
    });

    test('loads Polygon chain implementation', async () => {
        const ChainClass = await chainFactory.loadChainImplementation('polygon');
        expect(ChainClass).toBeDefined();
        expect(ChainClass.name).toBe('PolygonChain');
    });

    test('loads Arbitrum chain implementation', async () => {
        const ChainClass = await chainFactory.loadChainImplementation('arbitrum');
        expect(ChainClass).toBeDefined();
        expect(ChainClass.name).toBe('ArbitrumChain');
    });

    test('loads Base chain implementation', async () => {
        const ChainClass = await chainFactory.loadChainImplementation('base');
        expect(ChainClass).toBeDefined();
        expect(ChainClass.name).toBe('BaseChainImpl');
    });

    test('loads Avalanche chain implementation', async () => {
        const ChainClass = await chainFactory.loadChainImplementation('avalanche');
        expect(ChainClass).toBeDefined();
        expect(ChainClass.name).toBe('AvalancheChain');
    });

    test('returns null for unknown chain', async () => {
        const ChainClass = await chainFactory.loadChainImplementation('unknown');
        expect(ChainClass).toBeNull();
    });
});
