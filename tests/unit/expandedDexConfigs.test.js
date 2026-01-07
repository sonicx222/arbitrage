import { jest } from '@jest/globals';

// Import chain configurations
import bscConfig from '../../src/config/chains/bsc.js';
import ethereumConfig from '../../src/config/chains/ethereum.js';
import polygonConfig from '../../src/config/chains/polygon.js';
import arbitrumConfig from '../../src/config/chains/arbitrum.js';
import baseConfig from '../../src/config/chains/base.js';

/**
 * Expanded DEX Configuration Tests
 *
 * Tests for the v2.1 DEX expansion including:
 * - Curve Finance (Ethereum, Polygon, BSC, Base)
 * - Balancer V2 (all chains)
 * - Maverick (Ethereum, Base)
 * - KyberSwap Elastic (all chains)
 * - GMX (Arbitrum)
 * - Ellipsis (BSC)
 * - Additional DEXes per chain
 */

describe('Expanded DEX Configurations - v2.1', () => {

    describe('Ethereum DEX Expansion', () => {
        const config = ethereumConfig;

        test('Curve Finance is enabled and configured', () => {
            const curve = config.dex.curve;
            expect(curve).toBeDefined();
            expect(curve.enabled).toBe(true);
            expect(curve.type).toBe('curve');
            expect(curve.router).toMatch(/^0x[a-fA-F0-9]{40}$/);
            expect(curve.fee).toBeLessThan(0.01); // Curve has very low fees
        });

        test('Balancer V2 is enabled and configured', () => {
            const balancer = config.dex.balancer;
            expect(balancer).toBeDefined();
            expect(balancer.enabled).toBe(true);
            expect(balancer.type).toBe('balancer');
            expect(balancer.vault).toMatch(/^0x[a-fA-F0-9]{40}$/);
            expect(balancer.router).toBe(balancer.vault); // Vault acts as router
        });

        test('Maverick is enabled and configured', () => {
            const maverick = config.dex.maverick;
            expect(maverick).toBeDefined();
            expect(maverick.enabled).toBe(true);
            expect(maverick.type).toBe('maverick');
            expect(maverick.router).toMatch(/^0x[a-fA-F0-9]{40}$/);
            expect(maverick.factory).toMatch(/^0x[a-fA-F0-9]{40}$/);
        });

        test('KyberSwap Elastic is enabled and configured', () => {
            const kyber = config.dex.kyberswap;
            expect(kyber).toBeDefined();
            expect(kyber.enabled).toBe(true);
            expect(kyber.router).toMatch(/^0x[a-fA-F0-9]{40}$/);
            expect(kyber.factory).toMatch(/^0x[a-fA-F0-9]{40}$/);
            expect(Array.isArray(kyber.feeTiers)).toBe(true);
            expect(kyber.feeTiers.length).toBeGreaterThan(0);
        });

        test('has at least 7 DEXes enabled', () => {
            const enabledDexes = Object.values(config.dex).filter(dex => dex.enabled);
            expect(enabledDexes.length).toBeGreaterThanOrEqual(7);
        });

        test('has liquid staking tokens (LSTs) configured', () => {
            expect(config.tokens.wstETH).toBeDefined();
            expect(config.tokens.rETH).toBeDefined();
            expect(config.tokens.cbETH).toBeDefined();
            expect(config.tokens.sfrxETH).toBeDefined();
            expect(config.tokens.swETH).toBeDefined();
            expect(config.tokens.ankrETH).toBeDefined();
        });

        test('base tokens include LSTs for triangular arbitrage', () => {
            expect(config.baseTokens).toContain('wstETH');
            expect(config.baseTokens).toContain('rETH');
            expect(config.baseTokens).toContain('cbETH');
        });
    });

    describe('Arbitrum DEX Expansion', () => {
        const config = arbitrumConfig;

        test('GMX is enabled and configured', () => {
            const gmx = config.dex.gmx;
            expect(gmx).toBeDefined();
            expect(gmx.enabled).toBe(true);
            expect(gmx.type).toBe('gmx');
            expect(gmx.router).toMatch(/^0x[a-fA-F0-9]{40}$/);
            expect(gmx.vault).toMatch(/^0x[a-fA-F0-9]{40}$/);
            expect(gmx.reader).toMatch(/^0x[a-fA-F0-9]{40}$/);
        });

        test('Balancer V2 is enabled and configured', () => {
            const balancer = config.dex.balancer;
            expect(balancer).toBeDefined();
            expect(balancer.enabled).toBe(true);
            expect(balancer.type).toBe('balancer');
            expect(balancer.vault).toMatch(/^0x[a-fA-F0-9]{40}$/);
        });

        test('KyberSwap Elastic is enabled and configured', () => {
            const kyber = config.dex.kyberswap;
            expect(kyber).toBeDefined();
            expect(kyber.enabled).toBe(true);
            expect(kyber.router).toMatch(/^0x[a-fA-F0-9]{40}$/);
            expect(Array.isArray(kyber.feeTiers)).toBe(true);
        });

        test('Chronos (ve3,3 DEX) is enabled', () => {
            const chronos = config.dex.chronos;
            expect(chronos).toBeDefined();
            expect(chronos.enabled).toBe(true);
            expect(chronos.type).toBe('solidly');
        });

        test('WooFi is enabled with low fees', () => {
            const woofi = config.dex.woofi;
            expect(woofi).toBeDefined();
            expect(woofi.enabled).toBe(true);
            expect(woofi.type).toBe('woofi');
            expect(woofi.fee).toBeLessThan(0.001); // Very low fees
        });

        test('has at least 12 DEXes enabled', () => {
            const enabledDexes = Object.values(config.dex).filter(dex => dex.enabled);
            expect(enabledDexes.length).toBeGreaterThanOrEqual(12);
        });
    });

    describe('BSC DEX Expansion', () => {
        const config = bscConfig;

        test('KnightSwap is now enabled', () => {
            const knightswap = config.dex.knightswap;
            expect(knightswap).toBeDefined();
            expect(knightswap.enabled).toBe(true);
            expect(knightswap.type).toBe('uniswapV2');
            expect(knightswap.router).toMatch(/^0x[a-fA-F0-9]{40}$/);
        });

        test('Ellipsis Finance (Curve fork) is enabled', () => {
            const ellipsis = config.dex.ellipsis;
            expect(ellipsis).toBeDefined();
            expect(ellipsis.enabled).toBe(true);
            expect(ellipsis.type).toBe('curve');
            expect(ellipsis.router).toMatch(/^0x[a-fA-F0-9]{40}$/);
            expect(ellipsis.fee).toBeLessThan(0.01); // Low stable fees
        });

        test('KyberSwap Elastic is enabled', () => {
            const kyber = config.dex.kyberswap;
            expect(kyber).toBeDefined();
            expect(kyber.enabled).toBe(true);
            expect(Array.isArray(kyber.feeTiers)).toBe(true);
        });

        test('DODO (PMM) is enabled', () => {
            const dodo = config.dex.dodo;
            expect(dodo).toBeDefined();
            expect(dodo.enabled).toBe(true);
            expect(dodo.type).toBe('dodo');
            expect(dodo.router).toMatch(/^0x[a-fA-F0-9]{40}$/);
        });

        test('has at least 14 DEXes enabled', () => {
            const enabledDexes = Object.values(config.dex).filter(dex => dex.enabled);
            expect(enabledDexes.length).toBeGreaterThanOrEqual(14);
        });
    });

    describe('Polygon DEX Expansion', () => {
        const config = polygonConfig;

        test('Balancer V2 is now enabled', () => {
            const balancer = config.dex.balancer;
            expect(balancer).toBeDefined();
            expect(balancer.enabled).toBe(true);
            expect(balancer.type).toBe('balancer');
            expect(balancer.vault).toMatch(/^0x[a-fA-F0-9]{40}$/);
        });

        test('Curve Finance is enabled', () => {
            const curve = config.dex.curve;
            expect(curve).toBeDefined();
            expect(curve.enabled).toBe(true);
            expect(curve.type).toBe('curve');
            expect(curve.router).toMatch(/^0x[a-fA-F0-9]{40}$/);
        });

        test('KyberSwap Elastic is enabled', () => {
            const kyber = config.dex.kyberswap;
            expect(kyber).toBeDefined();
            expect(kyber.enabled).toBe(true);
            expect(Array.isArray(kyber.feeTiers)).toBe(true);
        });

        test('Retro (ve3,3 DEX) is enabled', () => {
            const retro = config.dex.retro;
            expect(retro).toBeDefined();
            expect(retro.enabled).toBe(true);
            expect(retro.type).toBe('solidly');
        });

        test('has at least 10 DEXes enabled', () => {
            const enabledDexes = Object.values(config.dex).filter(dex => dex.enabled);
            expect(enabledDexes.length).toBeGreaterThanOrEqual(10);
        });
    });

    describe('Base DEX Expansion', () => {
        const config = baseConfig;

        test('Balancer V2 is enabled', () => {
            const balancer = config.dex.balancer;
            expect(balancer).toBeDefined();
            expect(balancer.enabled).toBe(true);
            expect(balancer.type).toBe('balancer');
            expect(balancer.vault).toMatch(/^0x[a-fA-F0-9]{40}$/);
        });

        test('Maverick is enabled', () => {
            const maverick = config.dex.maverick;
            expect(maverick).toBeDefined();
            expect(maverick.enabled).toBe(true);
            expect(maverick.type).toBe('maverick');
            expect(maverick.router).toMatch(/^0x[a-fA-F0-9]{40}$/);
        });

        test('Curve Finance is enabled', () => {
            const curve = config.dex.curve;
            expect(curve).toBeDefined();
            expect(curve.enabled).toBe(true);
            expect(curve.type).toBe('curve');
        });

        test('WooFi is enabled with low fees', () => {
            const woofi = config.dex.woofi;
            expect(woofi).toBeDefined();
            expect(woofi.enabled).toBe(true);
            expect(woofi.fee).toBeLessThan(0.001);
        });

        test('base tokens include LSTs', () => {
            expect(config.baseTokens).toContain('cbETH');
            expect(config.baseTokens).toContain('wstETH');
            expect(config.baseTokens).toContain('rETH');
        });

        test('has at least 11 DEXes enabled', () => {
            const enabledDexes = Object.values(config.dex).filter(dex => dex.enabled);
            expect(enabledDexes.length).toBeGreaterThanOrEqual(11);
        });
    });
});

describe('DEX Type Consistency', () => {
    const allConfigs = [
        { name: 'Ethereum', config: ethereumConfig },
        { name: 'BSC', config: bscConfig },
        { name: 'Polygon', config: polygonConfig },
        { name: 'Arbitrum', config: arbitrumConfig },
        { name: 'Base', config: baseConfig },
    ];

    const validDexTypes = [
        'uniswapV2',
        'uniswapV3',
        'curve',
        'balancer',
        'solidly',
        'maverick',
        'gmx',
        'woofi',
        'dodo',
        'wombat',
    ];

    test.each(allConfigs)('$name - all DEXes have valid types', ({ config }) => {
        for (const [name, dex] of Object.entries(config.dex)) {
            if (!dex.enabled) continue;
            expect(validDexTypes).toContain(dex.type);
        }
    });

    test.each(allConfigs)('$name - all DEXes have tvlRank', ({ config }) => {
        for (const [name, dex] of Object.entries(config.dex)) {
            if (!dex.enabled) continue;
            expect(dex.tvlRank).toBeDefined();
            expect(dex.tvlRank).toBeGreaterThan(0);
        }
    });
});

describe('Cross-Chain DEX Consistency', () => {
    test('Balancer V2 vault address is consistent across chains', () => {
        const balancerVault = '0xBA12222222228d8Ba445958a75a0704d566BF2C8';

        // Balancer uses same vault address on all EVM chains
        expect(ethereumConfig.dex.balancer.vault.toLowerCase()).toBe(balancerVault.toLowerCase());
        expect(polygonConfig.dex.balancer.vault.toLowerCase()).toBe(balancerVault.toLowerCase());
        expect(arbitrumConfig.dex.balancer.vault.toLowerCase()).toBe(balancerVault.toLowerCase());
        expect(baseConfig.dex.balancer.vault.toLowerCase()).toBe(balancerVault.toLowerCase());
    });

    test('KyberSwap router addresses are chain-specific', () => {
        // KyberSwap may use different routers per chain but should all exist
        expect(ethereumConfig.dex.kyberswap.router).toMatch(/^0x[a-fA-F0-9]{40}$/);
        expect(bscConfig.dex.kyberswap.router).toMatch(/^0x[a-fA-F0-9]{40}$/);
        expect(polygonConfig.dex.kyberswap.router).toMatch(/^0x[a-fA-F0-9]{40}$/);
        expect(arbitrumConfig.dex.kyberswap.router).toMatch(/^0x[a-fA-F0-9]{40}$/);
    });

    test('Curve-style DEXes have low fees', () => {
        // Curve and Curve forks (Ellipsis) should have fees < 0.1%
        expect(ethereumConfig.dex.curve.fee).toBeLessThan(0.001);
        expect(bscConfig.dex.ellipsis.fee).toBeLessThan(0.001);
        expect(polygonConfig.dex.curve.fee).toBeLessThan(0.001);
        expect(baseConfig.dex.curve.fee).toBeLessThan(0.001);
    });
});

describe('Liquid Staking Token (LST) Configuration', () => {
    describe('Ethereum LSTs', () => {
        const tokens = ethereumConfig.tokens;

        test('Lido stETH variants exist', () => {
            expect(tokens.wstETH).toBeDefined();
            expect(tokens.wstETH.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
            expect(tokens.wstETH.decimals).toBe(18);
        });

        test('Rocket Pool rETH exists', () => {
            expect(tokens.rETH).toBeDefined();
            expect(tokens.rETH.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
            expect(tokens.rETH.decimals).toBe(18);
        });

        test('Coinbase cbETH exists', () => {
            expect(tokens.cbETH).toBeDefined();
            expect(tokens.cbETH.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
            expect(tokens.cbETH.decimals).toBe(18);
        });

        test('Frax sfrxETH exists', () => {
            expect(tokens.sfrxETH).toBeDefined();
            expect(tokens.sfrxETH.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
            expect(tokens.sfrxETH.decimals).toBe(18);
        });

        test('Swell swETH exists', () => {
            expect(tokens.swETH).toBeDefined();
            expect(tokens.swETH.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
        });

        test('Ankr ankrETH exists', () => {
            expect(tokens.ankrETH).toBeDefined();
            expect(tokens.ankrETH.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
        });
    });

    describe('Arbitrum LSTs', () => {
        const tokens = arbitrumConfig.tokens;

        test('wstETH bridged to Arbitrum', () => {
            expect(tokens.wstETH).toBeDefined();
            expect(tokens.wstETH.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
        });

        test('rETH bridged to Arbitrum', () => {
            expect(tokens.rETH).toBeDefined();
            expect(tokens.rETH.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
        });
    });

    describe('Base LSTs', () => {
        const tokens = baseConfig.tokens;

        test('cbETH on Base', () => {
            expect(tokens.cbETH).toBeDefined();
            expect(tokens.cbETH.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
        });

        test('wstETH on Base', () => {
            expect(tokens.wstETH).toBeDefined();
            expect(tokens.wstETH.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
        });

        test('rETH on Base', () => {
            expect(tokens.rETH).toBeDefined();
            expect(tokens.rETH.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
        });
    });

    describe('Polygon Liquid Staking', () => {
        const tokens = polygonConfig.tokens;

        test('stMATIC (Lido) exists', () => {
            expect(tokens.stMATIC).toBeDefined();
            expect(tokens.stMATIC.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
        });

        test('MaticX (Stader) exists', () => {
            expect(tokens.MaticX).toBeDefined();
            expect(tokens.MaticX.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
        });
    });
});

describe('Token Address Validity', () => {
    const allConfigs = [
        { name: 'Ethereum', config: ethereumConfig },
        { name: 'BSC', config: bscConfig },
        { name: 'Polygon', config: polygonConfig },
        { name: 'Arbitrum', config: arbitrumConfig },
        { name: 'Base', config: baseConfig },
    ];

    test.each(allConfigs)('$name - all token addresses are valid hex', ({ config }) => {
        const validHex = /^0x[a-fA-F0-9]{40}$/;

        for (const [symbol, token] of Object.entries(config.tokens)) {
            expect(token.address).toMatch(validHex);
        }
    });

    test.each(allConfigs)('$name - all base tokens exist in token config', ({ config }) => {
        for (const baseToken of config.baseTokens) {
            expect(config.tokens[baseToken]).toBeDefined();
        }
    });
});

describe('DEX Count Summary', () => {
    test('displays DEX expansion summary', () => {
        const summary = {
            Ethereum: Object.values(ethereumConfig.dex).filter(d => d.enabled).length,
            BSC: Object.values(bscConfig.dex).filter(d => d.enabled).length,
            Polygon: Object.values(polygonConfig.dex).filter(d => d.enabled).length,
            Arbitrum: Object.values(arbitrumConfig.dex).filter(d => d.enabled).length,
            Base: Object.values(baseConfig.dex).filter(d => d.enabled).length,
        };

        console.log('\n📊 DEX Expansion Summary (v2.1):');
        console.log('================================');
        for (const [chain, count] of Object.entries(summary)) {
            console.log(`  ${chain}: ${count} DEXes enabled`);
        }
        console.log(`  Total: ${Object.values(summary).reduce((a, b) => a + b, 0)} DEXes across all chains`);

        // Total should be significant
        const total = Object.values(summary).reduce((a, b) => a + b, 0);
        expect(total).toBeGreaterThanOrEqual(50);
    });
});
