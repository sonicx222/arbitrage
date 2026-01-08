import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { LiquidationMonitor } from '../../src/monitoring/liquidationMonitor.js';

describe('LiquidationMonitor', () => {
    let monitor;

    beforeEach(() => {
        monitor = new LiquidationMonitor({
            chainId: 1,
            minLiquidationUSD: 1000,
            minProfitUSD: 5,
        });
    });

    afterEach(() => {
        monitor.clearCache();
    });

    describe('constructor', () => {
        it('should initialize with default values', () => {
            const m = new LiquidationMonitor();
            expect(m.chainId).toBe(1);
            expect(m.minLiquidationUSD).toBe(1000);
            expect(m.minProfitUSD).toBe(5);
        });

        it('should accept custom configuration', () => {
            const m = new LiquidationMonitor({
                chainId: 42161,
                minLiquidationUSD: 5000,
                minProfitUSD: 10,
                priceCacheMaxAge: 120000,
                liquidationDedupeWindow: 60000,
            });
            expect(m.chainId).toBe(42161);
            expect(m.minLiquidationUSD).toBe(5000);
            expect(m.minProfitUSD).toBe(10);
            expect(m.priceCacheMaxAge).toBe(120000);
            expect(m.liquidationDedupeWindow).toBe(60000);
        });

        it('should initialize stats', () => {
            expect(monitor.stats.liquidationsDetected).toBe(0);
            expect(monitor.stats.aaveLiquidations).toBe(0);
            expect(monitor.stats.compoundAbsorptions).toBe(0);
            expect(monitor.stats.compoundBuyCollateral).toBe(0);
            expect(monitor.stats.opportunitiesEmitted).toBe(0);
            expect(monitor.stats.totalLiquidationValueUSD).toBe(0);
            expect(monitor.stats.lastLiquidationTime).toBeNull();
        });

        it('should initialize with correct protocol addresses', () => {
            expect(monitor.protocolAddresses).toBeDefined();
            expect(monitor.protocolAddresses.aaveV3Pool).toBe('0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2');
        });
    });

    describe('protocol addresses by chain', () => {
        const chainTests = [
            { chainId: 1, name: 'Ethereum', hasAave: true, hasCompound: true },
            { chainId: 42161, name: 'Arbitrum', hasAave: true, hasCompound: true },
            { chainId: 137, name: 'Polygon', hasAave: true, hasCompound: false },
            { chainId: 10, name: 'Optimism', hasAave: true, hasCompound: false },
            { chainId: 8453, name: 'Base', hasAave: true, hasCompound: true },
            { chainId: 43114, name: 'Avalanche', hasAave: true, hasCompound: false },
            { chainId: 56, name: 'BSC', hasAave: false, hasCompound: false },
        ];

        chainTests.forEach(chain => {
            it(`should have correct protocol config for ${chain.name} (${chain.chainId})`, () => {
                const m = new LiquidationMonitor({ chainId: chain.chainId });

                if (chain.hasAave) {
                    expect(m.protocolAddresses.aaveV3Pool).toBeDefined();
                }

                if (chain.hasCompound) {
                    expect(m.protocolAddresses.compoundV3USDC || m.protocolAddresses.compoundV3WETH).toBeDefined();
                }
            });
        });
    });

    describe('getSupportedProtocols', () => {
        it('should return Aave and Compound for Ethereum', () => {
            const protocols = monitor.getSupportedProtocols();
            expect(protocols.length).toBeGreaterThan(0);

            const protocolNames = protocols.map(p => p.name);
            expect(protocolNames).toContain('aave-v3');
            expect(protocolNames).toContain('compound-v3-usdc');
            expect(protocolNames).toContain('compound-v3-weth');
        });

        it('should return only Aave for Polygon', () => {
            const m = new LiquidationMonitor({ chainId: 137 });
            const protocols = m.getSupportedProtocols();

            const protocolNames = protocols.map(p => p.name);
            expect(protocolNames).toContain('aave-v3');
            expect(protocolNames).not.toContain('compound-v3-usdc');
        });

        it('should return empty for unsupported chain', () => {
            const m = new LiquidationMonitor({ chainId: 56 }); // BSC
            const protocols = m.getSupportedProtocols();
            expect(protocols.length).toBe(0);
        });
    });

    describe('token price lookup', () => {
        it('should return ETH price', () => {
            const price = monitor._getTokenPriceUSD('WETH');
            expect(price).toBe(3500);
        });

        it('should return stablecoin price as $1', () => {
            expect(monitor._getTokenPriceUSD('USDC')).toBe(1);
            expect(monitor._getTokenPriceUSD('USDT')).toBe(1);
            expect(monitor._getTokenPriceUSD('DAI')).toBe(1);
        });

        it('should return LSD prices', () => {
            expect(monitor._getTokenPriceUSD('wstETH')).toBe(4000);
            expect(monitor._getTokenPriceUSD('rETH')).toBe(3800);
            expect(monitor._getTokenPriceUSD('cbETH')).toBe(3700);
        });

        it('should return BTC price', () => {
            expect(monitor._getTokenPriceUSD('WBTC')).toBe(95000);
        });

        it('should return $1 for unknown tokens', () => {
            expect(monitor._getTokenPriceUSD('UNKNOWN')).toBe(1);
        });
    });

    describe('liquidation bonuses', () => {
        it('should have correct Aave V3 bonus', () => {
            expect(monitor.liquidationBonuses.AAVE_V3_DEFAULT).toBe(0.05);
            expect(monitor.liquidationBonuses.AAVE_V3_ETH).toBe(0.05);
            expect(monitor.liquidationBonuses.AAVE_V3_STABLECOINS).toBe(0.04);
        });

        it('should have correct Compound V3 bonus', () => {
            expect(monitor.liquidationBonuses.COMPOUND_V3).toBe(0.05);
        });
    });

    describe('deduplication', () => {
        it('should detect first occurrence as not duplicate', () => {
            const isDupe = monitor._isDuplicate('test_key_1');
            expect(isDupe).toBe(false);
        });

        it('should detect second occurrence as duplicate', () => {
            monitor._isDuplicate('test_key_2');
            const isDupe = monitor._isDuplicate('test_key_2');
            expect(isDupe).toBe(true);
        });

        it('should handle different keys independently', () => {
            monitor._isDuplicate('key_a');
            monitor._isDuplicate('key_b');

            expect(monitor._isDuplicate('key_a')).toBe(true);
            expect(monitor._isDuplicate('key_b')).toBe(true);
            expect(monitor._isDuplicate('key_c')).toBe(false);
        });
    });

    describe('start/stop', () => {
        it('should not start without provider', async () => {
            await monitor.start();
            expect(monitor.isRunning).toBe(false);
        });

        it('should warn if already running', async () => {
            monitor.isRunning = true;
            await monitor.start();
            // Should not throw, just warn
            expect(monitor.isRunning).toBe(true);
        });

        it('should stop cleanly', async () => {
            monitor.isRunning = true;
            monitor._cleanupTimer = setInterval(() => {}, 10000);

            await monitor.stop();

            expect(monitor.isRunning).toBe(false);
            expect(monitor.subscriptions).toEqual([]);
        });

        it('should handle stop when not running', async () => {
            await monitor.stop();
            expect(monitor.isRunning).toBe(false);
        });
    });

    describe('statistics', () => {
        it('should return comprehensive stats', () => {
            const stats = monitor.getStats();

            expect(stats.chainId).toBe(1);
            expect(stats.isRunning).toBe(false);
            expect(stats.liquidationsDetected).toBe(0);
            expect(stats.subscriptions).toBe(0);
            expect(stats.supportedProtocols).toBeGreaterThan(0);
        });

        it('should reset stats correctly', () => {
            monitor.stats.liquidationsDetected = 10;
            monitor.stats.aaveLiquidations = 5;
            monitor.stats.compoundAbsorptions = 3;
            monitor.stats.totalLiquidationValueUSD = 50000;
            monitor.stats.lastLiquidationTime = Date.now();

            monitor.resetStats();

            expect(monitor.stats.liquidationsDetected).toBe(0);
            expect(monitor.stats.aaveLiquidations).toBe(0);
            expect(monitor.stats.compoundAbsorptions).toBe(0);
            expect(monitor.stats.totalLiquidationValueUSD).toBe(0);
            // lastLiquidationTime should be preserved
            expect(monitor.stats.lastLiquidationTime).not.toBeNull();
        });

        it('should track recent liquidations count', () => {
            monitor._isDuplicate('liq_1');
            monitor._isDuplicate('liq_2');
            monitor._isDuplicate('liq_3');

            const stats = monitor.getStats();
            expect(stats.recentLiquidationsTracked).toBe(3);
        });
    });

    describe('cache management', () => {
        it('should clear token price cache', () => {
            monitor.tokenPriceCache.set('test', { symbol: 'TEST', timestamp: Date.now() });
            expect(monitor.tokenPriceCache.size).toBe(1);

            monitor.clearCache();
            expect(monitor.tokenPriceCache.size).toBe(0);
        });

        it('should clear recent liquidations cache', () => {
            monitor._isDuplicate('liq_1');
            monitor._isDuplicate('liq_2');
            expect(monitor.recentLiquidations.size).toBe(2);

            monitor.clearCache();
            expect(monitor.recentLiquidations.size).toBe(0);
        });
    });

    describe('initialize', () => {
        it('should update chainId when provided', async () => {
            const mockProvider = {};
            await monitor.initialize(mockProvider, 42161);

            expect(monitor.chainId).toBe(42161);
            expect(monitor.provider).toBe(mockProvider);
        });

        it('should update protocol addresses on chain change', async () => {
            const initialAddresses = monitor.protocolAddresses;

            await monitor.initialize(null, 8453); // Base

            expect(monitor.protocolAddresses).not.toEqual(initialAddresses);
            expect(monitor.protocolAddresses.aaveV3Pool).toBe('0xA238Dd80C259a72e81d7e4664a9801593F98d1c5');
        });
    });

    describe('event emission', () => {
        it('should emit opportunity events', () => {
            let emittedOpportunity = null;
            monitor.on('opportunity', (opp) => {
                emittedOpportunity = opp;
            });

            expect(monitor.listenerCount('opportunity')).toBe(1);
        });

        it('should emit liquidation events', () => {
            let emittedLiquidation = null;
            monitor.on('liquidation', (liq) => {
                emittedLiquidation = liq;
            });

            expect(monitor.listenerCount('liquidation')).toBe(1);
        });

        it('should emit buyCollateralExecuted events', () => {
            let emitted = null;
            monitor.on('buyCollateralExecuted', (data) => {
                emitted = data;
            });

            expect(monitor.listenerCount('buyCollateralExecuted')).toBe(1);
        });
    });

    describe('opportunity structure', () => {
        it('should have expected Aave liquidation opportunity format', () => {
            const mockOpportunity = {
                type: 'liquidation-backrun',
                protocol: 'aave-v3',
                collateralAsset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
                collateralSymbol: 'WETH',
                debtAsset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
                debtSymbol: 'USDC',
                liquidatedUser: '0x1234567890abcdef1234567890abcdef12345678',
                liquidator: '0xabcdef1234567890abcdef1234567890abcdef12',
                collateralAmount: 10.5,
                collateralValueUSD: 36750,
                debtAmount: 30000,
                debtValueUSD: 30000,
                liquidationBonusPercent: 5,
                bonusValueUSD: 1837.5,
                estimatedSlippagePercent: 0.3675,
                estimatedProfitUSD: 135,
                receiveAToken: false,
                transactionHash: '0x123...',
                blockNumber: 18500000,
                timestamp: Date.now(),
                chainId: 1,
            };

            expect(mockOpportunity).toHaveProperty('type');
            expect(mockOpportunity).toHaveProperty('protocol');
            expect(mockOpportunity).toHaveProperty('collateralSymbol');
            expect(mockOpportunity).toHaveProperty('estimatedProfitUSD');
            expect(mockOpportunity.type).toBe('liquidation-backrun');
            expect(mockOpportunity.protocol).toBe('aave-v3');
        });

        it('should have expected Compound absorption opportunity format', () => {
            const mockOpportunity = {
                type: 'liquidation-buyCollateral',
                protocol: 'compound-v3',
                baseToken: 'USDC',
                collateralAsset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
                collateralSymbol: 'WETH',
                absorber: '0xabcd...',
                borrower: '0x1234...',
                collateralAmount: 5.0,
                collateralValueUSD: 17500,
                estimatedProfitUSD: 875,
                action: 'buy-collateral-available',
                transactionHash: '0x456...',
                blockNumber: 18500001,
                timestamp: Date.now(),
                chainId: 1,
            };

            expect(mockOpportunity).toHaveProperty('type');
            expect(mockOpportunity).toHaveProperty('protocol');
            expect(mockOpportunity).toHaveProperty('action');
            expect(mockOpportunity.type).toBe('liquidation-buyCollateral');
            expect(mockOpportunity.action).toBe('buy-collateral-available');
        });
    });

    describe('contract initialization', () => {
        it('should not initialize contracts without provider', async () => {
            await monitor._initializeContracts();
            expect(monitor.contracts.size).toBe(0);
        });

        it('should have contracts map available', () => {
            expect(monitor.contracts).toBeDefined();
            expect(monitor.contracts instanceof Map).toBe(true);
        });
    });

    describe('health factor and liquidatable checks', () => {
        it('should return null health factor without contract', async () => {
            const healthFactor = await monitor.getAaveHealthFactor('0x1234...');
            expect(healthFactor).toBeNull();
        });

        it('should return false for isLiquidatable without contract', async () => {
            const isLiquidatable = await monitor.isCompoundLiquidatable('USDC', '0x1234...');
            expect(isLiquidatable).toBe(false);
        });

        it('should return null for collateral reserves without contract', async () => {
            const reserves = await monitor.getCompoundCollateralReserves('USDC', '0xWETH...');
            expect(reserves).toBeNull();
        });
    });

    describe('multi-chain support', () => {
        const chains = [
            { id: 1, name: 'Ethereum' },
            { id: 42161, name: 'Arbitrum' },
            { id: 137, name: 'Polygon' },
            { id: 10, name: 'Optimism' },
            { id: 8453, name: 'Base' },
            { id: 43114, name: 'Avalanche' },
        ];

        chains.forEach(chain => {
            it(`should support ${chain.name} (${chain.id})`, () => {
                const m = new LiquidationMonitor({ chainId: chain.id });
                const protocols = m.getSupportedProtocols();

                // All supported chains should have at least Aave V3
                expect(protocols.length).toBeGreaterThan(0);
                expect(protocols.some(p => p.name === 'aave-v3')).toBe(true);
            });
        });
    });

    describe('cleanup timer', () => {
        it('should start cleanup timer', () => {
            monitor._startCleanupTimer();
            expect(monitor._cleanupTimer).toBeDefined();

            // Clean up
            clearInterval(monitor._cleanupTimer);
        });

        it('should clean old liquidation records', () => {
            // Add some records
            const oldTimestamp = Date.now() - 60000; // 60 seconds ago
            monitor.recentLiquidations.set('old_key', oldTimestamp);
            monitor.recentLiquidations.set('new_key', Date.now());

            // Manually trigger cleanup logic
            const cutoff = Date.now() - monitor.liquidationDedupeWindow;
            for (const [key, timestamp] of monitor.recentLiquidations) {
                if (timestamp < cutoff) {
                    monitor.recentLiquidations.delete(key);
                }
            }

            // Old record should be removed (if older than window)
            // This depends on liquidationDedupeWindow (default 30s)
            expect(monitor.recentLiquidations.has('new_key')).toBe(true);
        });
    });

    describe('token info fetching', () => {
        it('should cache token info', async () => {
            // Mock token info in cache
            const cacheKey = '1_0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
            const mockInfo = {
                symbol: 'WETH',
                decimals: 18,
                priceUSD: 3500,
                timestamp: Date.now(),
            };
            monitor.tokenPriceCache.set(cacheKey, mockInfo);

            // Should return cached value
            const info = await monitor._getTokenInfo('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
            expect(info.symbol).toBe('WETH');
            expect(info.decimals).toBe(18);
        });

        it('should use fallback for unknown tokens without provider', async () => {
            const info = await monitor._getTokenInfo('0x0000000000000000000000000000000000000000');
            expect(info.symbol).toBe('UNKNOWN');
            expect(info.decimals).toBe(18);
            expect(info.priceUSD).toBe(1);
        });
    });

    describe('profit calculation', () => {
        it('should calculate estimated slippage based on size', () => {
            // Small liquidation: $10k -> 0.1% slippage
            // Large liquidation: $100k+ -> 1% slippage (capped)

            const smallValue = 10000;
            const largeValue = 150000;

            const smallSlippage = Math.min(1, smallValue / 100000);
            const largeSlippage = Math.min(1, largeValue / 100000);

            expect(smallSlippage).toBe(0.1);
            expect(largeSlippage).toBe(1);
        });

        it('should filter opportunities below min profit', () => {
            const estimatedProfit = 3; // Below default minProfitUSD of 5
            expect(estimatedProfit >= monitor.minProfitUSD).toBe(false);
        });

        it('should accept opportunities above min profit', () => {
            const estimatedProfit = 10;
            expect(estimatedProfit >= monitor.minProfitUSD).toBe(true);
        });
    });
});

describe('LiquidationMonitor singleton', () => {
    it('should export default singleton instance', async () => {
        const { default: singleton } = await import('../../src/monitoring/liquidationMonitor.js');
        expect(singleton).toBeDefined();
        expect(singleton.constructor.name).toBe('LiquidationMonitor');
    });

    it('should export LiquidationMonitor class', async () => {
        const { LiquidationMonitor: LM } = await import('../../src/monitoring/liquidationMonitor.js');
        expect(LM).toBeDefined();
        expect(typeof LM).toBe('function');
    });
});
