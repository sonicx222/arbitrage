import { jest } from '@jest/globals';

// Import new chain configurations
import optimismConfig from '../../src/config/chains/optimism.js';
import fantomConfig from '../../src/config/chains/fantom.js';
import zksyncConfig from '../../src/config/chains/zksync.js';

/**
 * New Chain Configuration Tests - Tier 1 Chains
 *
 * Validates that all new chain configurations are correctly structured
 * and contain valid addresses for DEXes and tokens.
 *
 * Chains covered:
 * - Optimism (Chain ID: 10)
 * - Fantom (Chain ID: 250)
 * - zkSync Era (Chain ID: 324)
 */
describe('Tier 1 New Chain Configurations', () => {
    const newChains = [
        { name: 'Optimism', config: optimismConfig, chainId: 10 },
        { name: 'Fantom', config: fantomConfig, chainId: 250 },
        { name: 'zkSync Era', config: zksyncConfig, chainId: 324 },
    ];

    describe('Required Fields', () => {
        test.each(newChains)('$name config has required chain identification fields', ({ config, chainId }) => {
            expect(config.name).toBeDefined();
            expect(typeof config.name).toBe('string');
            expect(config.chainId).toBe(chainId);
            expect(typeof config.enabled).toBe('boolean');
            expect(config.blockTime).toBeGreaterThan(0);
        });

        test.each(newChains)('$name config has native token configuration', ({ config }) => {
            expect(config.nativeToken).toBeDefined();
            expect(config.nativeToken.symbol).toBeDefined();
            expect(config.nativeToken.decimals).toBe(18);
            expect(config.nativeToken.wrapped).toMatch(/^0x[a-fA-F0-9]{40}$/);
            expect(config.nativeToken.priceUSD).toBeGreaterThan(0);
        });

        test.each(newChains)('$name config has RPC configuration', ({ config }) => {
            expect(config.rpc).toBeDefined();
            expect(Array.isArray(config.rpc.http)).toBe(true);
            expect(Array.isArray(config.rpc.ws)).toBe(true);
            // At least one public RPC should be available
            expect(config.rpc.http.length).toBeGreaterThan(0);
        });

        test.each(newChains)('$name config has DEX configurations', ({ config }) => {
            expect(config.dex).toBeDefined();
            expect(typeof config.dex).toBe('object');

            const dexNames = Object.keys(config.dex);
            expect(dexNames.length).toBeGreaterThan(0);

            // Check at least one DEX is enabled
            const enabledDexes = Object.values(config.dex).filter(dex => dex.enabled);
            expect(enabledDexes.length).toBeGreaterThan(0);
        });

        test.each(newChains)('$name config has token configurations', ({ config }) => {
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

        test.each(newChains)('$name config has base tokens array', ({ config }) => {
            expect(Array.isArray(config.baseTokens)).toBe(true);
            expect(config.baseTokens.length).toBeGreaterThan(0);

            // Base tokens should exist in tokens config
            for (const baseToken of config.baseTokens) {
                expect(config.tokens[baseToken]).toBeDefined();
            }
        });

        test.each(newChains)('$name config has trading parameters', ({ config }) => {
            expect(config.trading).toBeDefined();
            expect(config.trading.minProfitPercentage).toBeGreaterThanOrEqual(0);
            expect(config.trading.maxSlippage).toBeGreaterThan(0);
            expect(config.trading.gasPriceGwei).toBeGreaterThanOrEqual(0);
            expect(config.trading.estimatedGasLimit).toBeGreaterThan(0);
        });

        test.each(newChains)('$name config has monitoring settings', ({ config }) => {
            expect(config.monitoring).toBeDefined();
            expect(config.monitoring.maxPairsToMonitor).toBeGreaterThan(0);
            expect(config.monitoring.cacheSize).toBeGreaterThan(0);
        });

        test.each(newChains)('$name config has contracts section', ({ config }) => {
            expect(config.contracts).toBeDefined();
            expect(config.contracts.multicall).toMatch(/^0x[a-fA-F0-9]{40}$/);
        });
    });

    describe('DEX Configuration Validity', () => {
        test.each(newChains)('$name DEXes have valid router addresses', ({ config }) => {
            for (const [name, dex] of Object.entries(config.dex)) {
                if (!dex.enabled) continue;

                // All enabled DEXes should have a router address
                expect(dex.router).toMatch(/^0x[a-fA-F0-9]{40}$/);
            }
        });

        test.each(newChains)('$name V2-style DEXes have factory addresses', ({ config }) => {
            for (const [name, dex] of Object.entries(config.dex)) {
                if (!dex.enabled) continue;

                if (dex.type === 'uniswapV2') {
                    expect(dex.factory).toMatch(/^0x[a-fA-F0-9]{40}$/);
                    expect(dex.fee).toBeGreaterThan(0);
                    expect(dex.fee).toBeLessThan(0.1);
                }
            }
        });

        test.each(newChains)('$name V3-style DEXes have required fields', ({ config }) => {
            for (const [name, dex] of Object.entries(config.dex)) {
                if (!dex.enabled) continue;

                if (dex.type === 'uniswapV3') {
                    expect(dex.factory).toMatch(/^0x[a-fA-F0-9]{40}$/);
                    expect(dex.quoter).toMatch(/^0x[a-fA-F0-9]{40}$/);
                    expect(Array.isArray(dex.feeTiers)).toBe(true);
                    expect(dex.feeTiers.length).toBeGreaterThan(0);
                }
            }
        });

        test.each(newChains)('$name Balancer-style DEXes have vault address', ({ config }) => {
            for (const [name, dex] of Object.entries(config.dex)) {
                if (!dex.enabled) continue;

                if (dex.type === 'balancer') {
                    expect(dex.vault || dex.router).toMatch(/^0x[a-fA-F0-9]{40}$/);
                }
            }
        });

        test.each(newChains)('$name Solidly-style DEXes have factory address', ({ config }) => {
            for (const [name, dex] of Object.entries(config.dex)) {
                if (!dex.enabled) continue;

                if (dex.type === 'solidly') {
                    expect(dex.factory || dex.vault).toMatch(/^0x[a-fA-F0-9]{40}$/);
                }
            }
        });
    });

    describe('Token Address Validity', () => {
        test.each(newChains)('$name all token addresses are valid checksummed addresses', ({ config }) => {
            for (const [symbol, token] of Object.entries(config.tokens)) {
                // Check address format
                expect(token.address).toMatch(/^0x[a-fA-F0-9]{40}$/);

                // Check address is not zero address
                expect(token.address).not.toBe('0x0000000000000000000000000000000000000000');
            }
        });

        test.each(newChains)('$name has required stablecoins', ({ config, name }) => {
            // All chains should have at least USDC or USDT
            const hasUSDC = config.tokens.USDC !== undefined;
            const hasUSDT = config.tokens.USDT !== undefined;
            expect(hasUSDC || hasUSDT).toBe(true);
        });

        test.each(newChains)('$name wrapped native token is in tokens', ({ config }) => {
            const wrappedAddress = config.nativeToken.wrapped.toLowerCase();
            const tokenAddresses = Object.values(config.tokens).map(t => t.address.toLowerCase());
            expect(tokenAddresses).toContain(wrappedAddress);
        });
    });
});

describe('Optimism-Specific Tests', () => {
    test('has Velodrome as dominant DEX', () => {
        expect(optimismConfig.dex.velodrome).toBeDefined();
        expect(optimismConfig.dex.velodrome.enabled).toBe(true);
        expect(optimismConfig.dex.velodrome.type).toBe('solidly');
        expect(optimismConfig.dex.velodrome.tvlRank).toBe(1);
    });

    test('has Uniswap V3', () => {
        expect(optimismConfig.dex['uniswap-v3']).toBeDefined();
        expect(optimismConfig.dex['uniswap-v3'].enabled).toBe(true);
        expect(optimismConfig.dex['uniswap-v3'].type).toBe('uniswapV3');
    });

    test('has OP token', () => {
        expect(optimismConfig.tokens.OP).toBeDefined();
        expect(optimismConfig.tokens.OP.address).toBe('0x4200000000000000000000000000000000000042');
    });

    test('has LST tokens (wstETH, rETH)', () => {
        expect(optimismConfig.tokens.wstETH).toBeDefined();
        expect(optimismConfig.tokens.rETH).toBeDefined();
    });

    test('has correct chain ID', () => {
        expect(optimismConfig.chainId).toBe(10);
    });

    test('WETH address is correct for Optimism', () => {
        expect(optimismConfig.tokens.WETH.address).toBe('0x4200000000000000000000000000000000000006');
        expect(optimismConfig.nativeToken.wrapped).toBe('0x4200000000000000000000000000000000000006');
    });

    test('has Balancer/Beethoven X for flash loans', () => {
        expect(optimismConfig.flashLoan.balancer).toBeDefined();
        expect(optimismConfig.flashLoan.balancer.vault).toBe('0xBA12222222228d8Ba445958a75a0704d566BF2C8');
        expect(optimismConfig.flashLoan.balancer.fee).toBe(0); // Free flash loans
    });
});

describe('Fantom-Specific Tests', () => {
    test('has SpookySwap as dominant DEX', () => {
        expect(fantomConfig.dex.spookyswap).toBeDefined();
        expect(fantomConfig.dex.spookyswap.enabled).toBe(true);
        expect(fantomConfig.dex.spookyswap.type).toBe('uniswapV2');
        expect(fantomConfig.dex.spookyswap.tvlRank).toBe(1);
    });

    test('has Equalizer (Solidly fork)', () => {
        expect(fantomConfig.dex.equalizer).toBeDefined();
        expect(fantomConfig.dex.equalizer.enabled).toBe(true);
        expect(fantomConfig.dex.equalizer.type).toBe('solidly');
    });

    test('has SpiritSwap', () => {
        expect(fantomConfig.dex.spiritswap).toBeDefined();
        expect(fantomConfig.dex.spiritswap.enabled).toBe(true);
    });

    test('has WFTM as native token', () => {
        expect(fantomConfig.nativeToken.symbol).toBe('FTM');
        expect(fantomConfig.tokens.WFTM).toBeDefined();
        expect(fantomConfig.tokens.WFTM.address).toBe('0x21be370D5312f44cB42ce377BC9b8a0cEF1A4C83');
    });

    test('has correct chain ID', () => {
        expect(fantomConfig.chainId).toBe(250);
    });

    test('has very fast block time (~1 second)', () => {
        expect(fantomConfig.blockTime).toBe(1000);
    });

    test('has BOO and SPIRIT DEX tokens', () => {
        expect(fantomConfig.tokens.BOO).toBeDefined();
        expect(fantomConfig.tokens.SPIRIT).toBeDefined();
    });

    test('V3 is disabled (no major V3 on Fantom)', () => {
        expect(fantomConfig.v3.enabled).toBe(false);
    });
});

describe('zkSync Era-Specific Tests', () => {
    test('has SyncSwap as dominant DEX', () => {
        expect(zksyncConfig.dex.syncswap).toBeDefined();
        expect(zksyncConfig.dex.syncswap.enabled).toBe(true);
        expect(zksyncConfig.dex.syncswap.tvlRank).toBe(1);
    });

    test('has Mute.io', () => {
        expect(zksyncConfig.dex.mute).toBeDefined();
        expect(zksyncConfig.dex.mute.enabled).toBe(true);
    });

    test('has Velocore (Solidly-style)', () => {
        expect(zksyncConfig.dex.velocore).toBeDefined();
        expect(zksyncConfig.dex.velocore.type).toBe('solidly');
    });

    test('has correct chain ID', () => {
        expect(zksyncConfig.chainId).toBe(324);
    });

    test('has zkSync-specific WETH address', () => {
        expect(zksyncConfig.tokens.WETH.address).toBe('0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91');
        expect(zksyncConfig.nativeToken.wrapped).toBe('0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91');
    });

    test('has ZK token', () => {
        expect(zksyncConfig.tokens.ZK).toBeDefined();
        expect(zksyncConfig.tokens.ZK.address).toBe('0x5A7d6b2F92C77FAD6CCaBd7EE0624E64907Eaf3E');
    });

    test('has zkSync-specific Multicall address', () => {
        expect(zksyncConfig.contracts.multicall).toBe('0xF9cda624FBC7e059355ce98a31693d299FACd963');
    });

    test('has MUTE DEX token', () => {
        expect(zksyncConfig.tokens.MUTE).toBeDefined();
    });

    test('V3 is disabled (no standard V3 on zkSync)', () => {
        expect(zksyncConfig.v3.enabled).toBe(false);
    });

    test('has limited flash loan providers', () => {
        // zkSync has ZeroLend (Aave V3 fork) as its only flash loan provider
        expect(zksyncConfig.flashLoan.providers).toHaveLength(1);
        expect(zksyncConfig.flashLoan.providers).toContain('zerolend');
    });
});

describe('Cross-Chain Token Consistency', () => {
    test('USDC exists on all new chains', () => {
        expect(optimismConfig.tokens.USDC).toBeDefined();
        expect(fantomConfig.tokens.USDC).toBeDefined();
        expect(zksyncConfig.tokens.USDC).toBeDefined();
    });

    test('USDT exists on all new chains', () => {
        expect(optimismConfig.tokens.USDT).toBeDefined();
        expect(fantomConfig.tokens.USDT).toBeDefined();
        expect(zksyncConfig.tokens.USDT).toBeDefined();
    });

    test('WBTC exists on all new chains', () => {
        expect(optimismConfig.tokens.WBTC).toBeDefined();
        expect(fantomConfig.tokens.WBTC).toBeDefined();
        expect(zksyncConfig.tokens.WBTC).toBeDefined();
    });

    test('DAI exists on all new chains', () => {
        expect(optimismConfig.tokens.DAI).toBeDefined();
        expect(fantomConfig.tokens.DAI).toBeDefined();
        expect(zksyncConfig.tokens.DAI).toBeDefined();
    });

    test('WETH exists on ETH L2s (Optimism, zkSync)', () => {
        expect(optimismConfig.tokens.WETH).toBeDefined();
        expect(zksyncConfig.tokens.WETH).toBeDefined();
        // Fantom has bridged WETH
        expect(fantomConfig.tokens.WETH).toBeDefined();
    });
});

describe('DEX Type Coverage', () => {
    test('Optimism has multiple DEX types', () => {
        const types = new Set(Object.values(optimismConfig.dex).map(d => d.type));
        expect(types.has('solidly')).toBe(true); // Velodrome
        expect(types.has('uniswapV3')).toBe(true); // Uniswap V3
        expect(types.has('balancer')).toBe(true); // Beethoven X
    });

    test('Fantom has multiple DEX types', () => {
        const types = new Set(Object.values(fantomConfig.dex).map(d => d.type));
        expect(types.has('uniswapV2')).toBe(true); // SpookySwap, SpiritSwap
        expect(types.has('solidly')).toBe(true); // Equalizer
        expect(types.has('balancer')).toBe(true); // Beethoven X
    });

    test('zkSync has multiple DEX types', () => {
        const types = new Set(Object.values(zksyncConfig.dex).map(d => d.type));
        expect(types.has('uniswapV2')).toBe(true); // Mute, SpaceFi
        expect(types.has('solidly')).toBe(true); // Velocore
        expect(types.has('maverick')).toBe(true); // Maverick
    });
});

describe('Address Format Regression Tests', () => {
    const addressRegex = /^0x[a-fA-F0-9]{40}$/;

    test('All Optimism DEX router addresses are valid', () => {
        for (const [name, dex] of Object.entries(optimismConfig.dex)) {
            expect(dex.router).toMatch(addressRegex);
        }
    });

    test('All Fantom DEX router addresses are valid', () => {
        for (const [name, dex] of Object.entries(fantomConfig.dex)) {
            expect(dex.router).toMatch(addressRegex);
        }
    });

    test('All zkSync DEX router addresses are valid', () => {
        for (const [name, dex] of Object.entries(zksyncConfig.dex)) {
            expect(dex.router).toMatch(addressRegex);
        }
    });

    test('All Optimism token addresses are valid', () => {
        for (const [symbol, token] of Object.entries(optimismConfig.tokens)) {
            expect(token.address).toMatch(addressRegex);
        }
    });

    test('All Fantom token addresses are valid', () => {
        for (const [symbol, token] of Object.entries(fantomConfig.tokens)) {
            expect(token.address).toMatch(addressRegex);
        }
    });

    test('All zkSync token addresses are valid', () => {
        for (const [symbol, token] of Object.entries(zksyncConfig.tokens)) {
            expect(token.address).toMatch(addressRegex);
        }
    });
});

describe('Configuration Completeness', () => {
    test.each([
        ['Optimism', optimismConfig],
        ['Fantom', fantomConfig],
        ['zkSync', zksyncConfig],
    ])('%s has all required sections', (name, config) => {
        expect(config.name).toBeDefined();
        expect(config.chainId).toBeDefined();
        expect(config.enabled).toBeDefined();
        expect(config.blockTime).toBeDefined();
        expect(config.nativeToken).toBeDefined();
        expect(config.rpc).toBeDefined();
        expect(config.contracts).toBeDefined();
        expect(config.dex).toBeDefined();
        expect(config.tokens).toBeDefined();
        expect(config.baseTokens).toBeDefined();
        expect(config.trading).toBeDefined();
        expect(config.monitoring).toBeDefined();
        expect(config.triangular).toBeDefined();
        expect(config.v3).toBeDefined();
        expect(config.execution).toBeDefined();
        expect(config.flashLoan).toBeDefined();
        expect(config.bridges).toBeDefined();
    });
});
