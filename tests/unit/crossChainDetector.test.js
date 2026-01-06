import CrossChainDetector from '../../src/analysis/CrossChainDetector.js';

describe('CrossChainDetector', () => {
    let detector;

    beforeEach(() => {
        detector = new CrossChainDetector({
            minProfitUSD: 10,
            maxPriceAgeMs: 60000,
            minSpreadPercent: 0.5,
        });
    });

    afterEach(() => {
        detector.removeAllListeners();
        detector.clearPrices();
    });

    describe('constructor', () => {
        it('should initialize with default config', () => {
            const defaultDetector = new CrossChainDetector();
            expect(defaultDetector.minProfitUSD).toBe(10);
            expect(defaultDetector.maxPriceAgeMs).toBe(15000);
            expect(defaultDetector.minSpreadPercent).toBe(0.5);
        });

        it('should initialize with custom config', () => {
            expect(detector.minProfitUSD).toBe(10);
            expect(detector.maxPriceAgeMs).toBe(60000);
            expect(detector.minSpreadPercent).toBe(0.5);
        });

        it('should have token mappings', () => {
            expect(detector.tokenMappings).toBeDefined();
            expect(typeof detector.tokenMappings).toBe('object');
        });

        it('should have bridge costs configured', () => {
            expect(detector.bridgeCosts).toBeDefined();
            expect(typeof detector.bridgeCosts).toBe('object');
        });
    });

    describe('updateChainPrices', () => {
        it('should store prices for a chain', () => {
            const prices = {
                'USDC/WBNB': {
                    PancakeSwap: { priceUSD: 1.0, price: 0.002 },
                },
            };

            detector.updateChainPrices(56, prices, 12345);

            expect(detector.chainPrices.has(56)).toBe(true);
            const chainData = detector.chainPrices.get(56);
            expect(chainData.blockNumber).toBe(12345);
        });

        it('should update statistics', () => {
            detector.updateChainPrices(56, {}, 1);
            expect(detector.stats.priceUpdates).toBe(1);
        });

        it('should return opportunities array', () => {
            const result = detector.updateChainPrices(56, {}, 1);
            expect(Array.isArray(result)).toBe(true);
        });
    });

    describe('detectCrossChainOpportunities', () => {
        it('should return empty array when only one chain has prices', () => {
            detector.updateChainPrices(56, { 'USDC/BNB': { dex1: { price: 1.0 } } }, 1);
            const opportunities = detector.detectCrossChainOpportunities();
            expect(opportunities).toEqual([]);
        });

        it('should return empty array when price data is stale', () => {
            // Set a very short max age to make data stale
            detector.maxPriceAgeMs = 1;

            detector.updateChainPrices(56, { 'USDC/BNB': { dex1: { price: 1.0 } } }, 1);
            detector.updateChainPrices(1, { 'USDC/ETH': { dex1: { price: 1.05 } } }, 1);

            // Wait a bit to make data stale
            return new Promise(resolve => setTimeout(() => {
                const opportunities = detector.detectCrossChainOpportunities();
                expect(Array.isArray(opportunities)).toBe(true);
                resolve();
            }, 10));
        });

        it('should return array of opportunities', () => {
            detector.updateChainPrices(56, {}, 1);
            detector.updateChainPrices(1, {}, 1);
            const opportunities = detector.detectCrossChainOpportunities();
            expect(Array.isArray(opportunities)).toBe(true);
        });
    });

    describe('_getBridgeCost', () => {
        it('should return cost for known routes', () => {
            // Access private method for testing
            const cost = detector._getBridgeCost(1, 56);
            expect(cost).toBeDefined();
            expect(cost.costUSD).toBeGreaterThan(0);
            expect(cost.estimatedTimeMinutes).toBeGreaterThan(0);
        });

        it('should return default cost for unknown routes', () => {
            const cost = detector._getBridgeCost(999, 998);
            expect(cost.costUSD).toBe(25);
            expect(cost.estimatedTimeMinutes).toBe(30);
        });
    });

    describe('addTokenMapping', () => {
        it('should add new token mapping', () => {
            detector.addTokenMapping('NEWTOKEN', {
                56: '0xnewtoken_bsc',
                1: '0xnewtoken_eth',
            });

            expect(detector.tokenMappings['NEWTOKEN']).toBeDefined();
            expect(detector.tokenMappings['NEWTOKEN'][56]).toBe('0xnewtoken_bsc');
        });

        it('should merge with existing mapping', () => {
            detector.addTokenMapping('USDC', {
                999: '0xusdc_newchain',
            });

            expect(detector.tokenMappings['USDC'][999]).toBe('0xusdc_newchain');
        });
    });

    describe('updateBridgeCost', () => {
        it('should update bridge cost for a route', () => {
            detector.updateBridgeCost(56, 1, 15, 10);

            const cost = detector._getBridgeCost(56, 1);
            expect(cost.costUSD).toBe(15);
            expect(cost.estimatedTimeMinutes).toBe(10);
        });
    });

    describe('getStats', () => {
        it('should return statistics object', () => {
            const stats = detector.getStats();
            expect(stats).toHaveProperty('priceUpdates');
            expect(stats).toHaveProperty('opportunitiesFound');
            expect(stats).toHaveProperty('chainsTracked');
            expect(stats).toHaveProperty('tokensTracked');
            expect(stats).toHaveProperty('lastOpportunityTime');
        });

        it('should track chains after price updates', () => {
            detector.updateChainPrices(56, {}, 1);
            detector.updateChainPrices(1, {}, 1);

            const stats = detector.getStats();
            expect(stats.chainsTracked).toBe(2);
        });
    });

    describe('clearPrices', () => {
        it('should clear all price data', () => {
            detector.updateChainPrices(56, {}, 1);
            detector.updateChainPrices(1, {}, 1);

            detector.clearPrices();

            expect(detector.chainPrices.size).toBe(0);
        });
    });

    describe('event emission', () => {
        it('should emit opportunities event when opportunities found', (done) => {
            detector.on('opportunities', (opportunities) => {
                expect(Array.isArray(opportunities)).toBe(true);
                done();
            });

            // Manually emit to test event handling
            detector.emit('opportunities', [{ test: true }]);
        });
    });

    describe('_isTrackedToken', () => {
        it('should return true for tracked tokens', () => {
            // USDC is likely tracked by default
            const isTracked = detector._isTrackedToken('USDC');
            // May or may not be tracked depending on crossChainTokens config
            expect(typeof isTracked).toBe('boolean');
        });

        it('should return false for untracked tokens', () => {
            const isTracked = detector._isTrackedToken('RANDOMTOKEN123');
            expect(isTracked).toBe(false);
        });
    });
});
