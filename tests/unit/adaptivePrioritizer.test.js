import { jest } from '@jest/globals';
import { AdaptivePrioritizer } from '../../src/analysis/adaptivePrioritizer.js';

describe('AdaptivePrioritizer', () => {
    let prioritizer;

    beforeEach(() => {
        prioritizer = new AdaptivePrioritizer({
            decayIntervalMs: 60000,
            volumeThresholdHigh: 100000,
            volumeThresholdLow: 10000,
        });
    });

    afterEach(() => {
        prioritizer.stop();
        prioritizer.removeAllListeners();
    });

    describe('Initialization', () => {
        test('should initialize with correct tier configuration', () => {
            expect(prioritizer.tiers[1].name).toBe('HOT');
            expect(prioritizer.tiers[2].name).toBe('WARM');
            expect(prioritizer.tiers[3].name).toBe('NORMAL');
            expect(prioritizer.tiers[4].name).toBe('COLD');
        });

        test('should have correct tier frequencies', () => {
            expect(prioritizer.tiers[1].frequency).toBe(1); // Every block
            expect(prioritizer.tiers[2].frequency).toBe(2); // Every 2 blocks
            expect(prioritizer.tiers[3].frequency).toBe(3); // Every 3 blocks
            expect(prioritizer.tiers[4].frequency).toBe(5); // Every 5 blocks
        });

        test('should initialize with empty pair map', () => {
            expect(prioritizer.pairPriority.size).toBe(0);
        });

        test('should initialize stats correctly', () => {
            expect(prioritizer.stats.promotions).toBe(0);
            expect(prioritizer.stats.demotions).toBe(0);
            expect(prioritizer.stats.checksSkipped).toBe(0);
            expect(prioritizer.stats.checksPerformed).toBe(0);
        });
    });

    describe('Pair Registration', () => {
        test('should register pair with default tier', () => {
            prioritizer.registerPair('WBNB/USDT:pancakeswap');
            expect(prioritizer.pairPriority.has('WBNB/USDT:pancakeswap')).toBe(true);
            expect(prioritizer.getTier('WBNB/USDT:pancakeswap')).toBe(3); // NORMAL
        });

        test('should register high volume pair as WARM', () => {
            prioritizer.registerPair('WBNB/USDT:pancakeswap', { volumeUSD: 150000 });
            expect(prioritizer.getTier('WBNB/USDT:pancakeswap')).toBe(2); // WARM
        });

        test('should register low liquidity pair as COLD', () => {
            prioritizer.registerPair('SMALL/TOKEN:biswap', { liquidityUSD: 5000 });
            expect(prioritizer.getTier('SMALL/TOKEN:biswap')).toBe(4); // COLD
        });

        test('should not re-register existing pair', () => {
            prioritizer.registerPair('WBNB/USDT:pancakeswap', { volumeUSD: 150000 });
            prioritizer.registerPair('WBNB/USDT:pancakeswap', { volumeUSD: 5000 });
            // Tier should remain at initial registration value
            expect(prioritizer.getTier('WBNB/USDT:pancakeswap')).toBe(2);
        });
    });

    describe('Opportunity Recording and Promotion', () => {
        test('should promote pair to HOT tier on opportunity', () => {
            prioritizer.registerPair('WBNB/USDT:pancakeswap');
            expect(prioritizer.getTier('WBNB/USDT:pancakeswap')).toBe(3); // NORMAL

            prioritizer.recordOpportunity('WBNB/USDT:pancakeswap');
            expect(prioritizer.getTier('WBNB/USDT:pancakeswap')).toBe(1); // HOT
        });

        test('should increment opportunity count', () => {
            prioritizer.registerPair('WBNB/USDT:pancakeswap');
            prioritizer.recordOpportunity('WBNB/USDT:pancakeswap');
            prioritizer.recordOpportunity('WBNB/USDT:pancakeswap');

            const info = prioritizer.getPairInfo('WBNB/USDT:pancakeswap');
            expect(info.opportunityCount).toBe(2);
        });

        test('should auto-register pair on opportunity if not tracked', () => {
            expect(prioritizer.pairPriority.has('NEW/PAIR:dex')).toBe(false);
            prioritizer.recordOpportunity('NEW/PAIR:dex');
            expect(prioritizer.pairPriority.has('NEW/PAIR:dex')).toBe(true);
            expect(prioritizer.getTier('NEW/PAIR:dex')).toBe(1); // Promoted to HOT
        });

        test('should emit tierChange event on promotion', (done) => {
            prioritizer.registerPair('WBNB/USDT:pancakeswap');

            prioritizer.on('tierChange', (data) => {
                expect(data.pairKey).toBe('WBNB/USDT:pancakeswap');
                expect(data.oldTier).toBe(3);
                expect(data.newTier).toBe(1);
                expect(data.reason).toBe('opportunity');
                done();
            });

            prioritizer.recordOpportunity('WBNB/USDT:pancakeswap');
        });

        test('should track promotion count in stats', () => {
            prioritizer.registerPair('WBNB/USDT:pancakeswap');
            prioritizer.recordOpportunity('WBNB/USDT:pancakeswap');
            expect(prioritizer.stats.promotions).toBe(1);
        });
    });

    describe('Block-based Checking Logic', () => {
        test('should allow HOT tier pairs every block', () => {
            prioritizer.registerPair('HOT/PAIR:dex');
            prioritizer.setTier('HOT/PAIR:dex', 1);

            expect(prioritizer.shouldCheckPair('HOT/PAIR:dex', 100)).toBe(true);
            expect(prioritizer.shouldCheckPair('HOT/PAIR:dex', 101)).toBe(true);
            expect(prioritizer.shouldCheckPair('HOT/PAIR:dex', 102)).toBe(true);
        });

        test('should allow WARM tier pairs every 2nd block', () => {
            prioritizer.registerPair('WARM/PAIR:dex');
            prioritizer.setTier('WARM/PAIR:dex', 2);

            expect(prioritizer.shouldCheckPair('WARM/PAIR:dex', 100)).toBe(true);
            expect(prioritizer.shouldCheckPair('WARM/PAIR:dex', 101)).toBe(false);
            expect(prioritizer.shouldCheckPair('WARM/PAIR:dex', 102)).toBe(true);
        });

        test('should allow NORMAL tier pairs every 3rd block', () => {
            prioritizer.registerPair('NORMAL/PAIR:dex');
            prioritizer.setTier('NORMAL/PAIR:dex', 3);

            expect(prioritizer.shouldCheckPair('NORMAL/PAIR:dex', 99)).toBe(true);
            expect(prioritizer.shouldCheckPair('NORMAL/PAIR:dex', 100)).toBe(false);
            expect(prioritizer.shouldCheckPair('NORMAL/PAIR:dex', 101)).toBe(false);
            expect(prioritizer.shouldCheckPair('NORMAL/PAIR:dex', 102)).toBe(true);
        });

        test('should allow COLD tier pairs every 5th block', () => {
            prioritizer.registerPair('COLD/PAIR:dex');
            prioritizer.setTier('COLD/PAIR:dex', 4);

            expect(prioritizer.shouldCheckPair('COLD/PAIR:dex', 100)).toBe(true);
            expect(prioritizer.shouldCheckPair('COLD/PAIR:dex', 101)).toBe(false);
            expect(prioritizer.shouldCheckPair('COLD/PAIR:dex', 104)).toBe(false);
            expect(prioritizer.shouldCheckPair('COLD/PAIR:dex', 105)).toBe(true);
        });

        test('should track checks performed and skipped', () => {
            prioritizer.registerPair('PAIR:dex');
            prioritizer.setTier('PAIR:dex', 2);

            prioritizer.shouldCheckPair('PAIR:dex', 100); // Check
            prioritizer.shouldCheckPair('PAIR:dex', 101); // Skip
            prioritizer.shouldCheckPair('PAIR:dex', 102); // Check

            expect(prioritizer.stats.checksPerformed).toBe(2);
            expect(prioritizer.stats.checksSkipped).toBe(1);
        });
    });

    describe('getPairsToCheck', () => {
        test('should return only pairs that should be checked', () => {
            prioritizer.registerPair('HOT:dex');
            prioritizer.registerPair('WARM:dex');
            prioritizer.registerPair('NORMAL:dex');
            prioritizer.registerPair('COLD:dex');

            prioritizer.setTier('HOT:dex', 1);
            prioritizer.setTier('WARM:dex', 2);
            prioritizer.setTier('NORMAL:dex', 3);
            prioritizer.setTier('COLD:dex', 4);

            const allPairs = ['HOT:dex', 'WARM:dex', 'NORMAL:dex', 'COLD:dex'];

            // Block 100: HOT (1%100=0), WARM (100%2=0), COLD (100%5=0)
            const block100 = prioritizer.getPairsToCheck(allPairs, 100);
            expect(block100).toContain('HOT:dex');
            expect(block100).toContain('WARM:dex');
            expect(block100).not.toContain('NORMAL:dex'); // 100%3=1, not 0
            expect(block100).toContain('COLD:dex');
        });
    });

    describe('Tier Decay', () => {
        test('should demote tier when max age exceeded', () => {
            prioritizer.registerPair('WBNB/USDT:pancakeswap');
            prioritizer.recordOpportunity('WBNB/USDT:pancakeswap');
            expect(prioritizer.getTier('WBNB/USDT:pancakeswap')).toBe(1); // HOT

            // Manually set lastOpportunity to be older than HOT tier maxAge
            const pairData = prioritizer.pairPriority.get('WBNB/USDT:pancakeswap');
            pairData.lastOpportunity = Date.now() - (6 * 60 * 1000); // 6 minutes ago

            prioritizer.decayTiers();

            expect(prioritizer.getTier('WBNB/USDT:pancakeswap')).toBe(2); // Demoted to WARM
        });

        test('should not demote COLD tier (already lowest)', () => {
            prioritizer.registerPair('LOW/PAIR:dex');
            prioritizer.setTier('LOW/PAIR:dex', 4);

            prioritizer.decayTiers();

            expect(prioritizer.getTier('LOW/PAIR:dex')).toBe(4); // Still COLD
        });

        test('should track demotions in stats', () => {
            prioritizer.registerPair('WBNB/USDT:pancakeswap');
            prioritizer.setTier('WBNB/USDT:pancakeswap', 1);

            const pairData = prioritizer.pairPriority.get('WBNB/USDT:pancakeswap');
            pairData.lastOpportunity = Date.now() - (6 * 60 * 1000); // Older than HOT maxAge

            prioritizer.decayTiers();

            expect(prioritizer.stats.demotions).toBe(1);
        });

        test('should emit tierChange event on demotion', (done) => {
            prioritizer.registerPair('WBNB/USDT:pancakeswap');
            prioritizer.setTier('WBNB/USDT:pancakeswap', 1);

            const pairData = prioritizer.pairPriority.get('WBNB/USDT:pancakeswap');
            pairData.lastOpportunity = Date.now() - (6 * 60 * 1000);

            prioritizer.on('tierChange', (data) => {
                expect(data.pairKey).toBe('WBNB/USDT:pancakeswap');
                expect(data.oldTier).toBe(1);
                expect(data.newTier).toBe(2);
                expect(data.reason).toBe('decay');
                done();
            });

            prioritizer.decayTiers();
        });
    });

    describe('Manual Tier Control', () => {
        test('should allow manual tier setting', () => {
            prioritizer.registerPair('WBNB/USDT:pancakeswap');
            prioritizer.setTier('WBNB/USDT:pancakeswap', 1);
            expect(prioritizer.getTier('WBNB/USDT:pancakeswap')).toBe(1);
        });

        test('should reject invalid tier values', () => {
            prioritizer.registerPair('WBNB/USDT:pancakeswap');
            expect(() => prioritizer.setTier('WBNB/USDT:pancakeswap', 0)).toThrow();
            expect(() => prioritizer.setTier('WBNB/USDT:pancakeswap', 5)).toThrow();
        });

        test('should auto-register on setTier if not tracked', () => {
            expect(prioritizer.pairPriority.has('NEW:dex')).toBe(false);
            prioritizer.setTier('NEW:dex', 2);
            expect(prioritizer.pairPriority.has('NEW:dex')).toBe(true);
            expect(prioritizer.getTier('NEW:dex')).toBe(2);
        });
    });

    describe('Statistics', () => {
        test('should return comprehensive stats', () => {
            prioritizer.registerPair('PAIR1:dex');
            prioritizer.registerPair('PAIR2:dex');
            prioritizer.registerPair('PAIR3:dex');

            const stats = prioritizer.getStats();

            expect(stats).toHaveProperty('promotions');
            expect(stats).toHaveProperty('demotions');
            expect(stats).toHaveProperty('checksSkipped');
            expect(stats).toHaveProperty('checksPerformed');
            expect(stats).toHaveProperty('totalPairs');
            expect(stats).toHaveProperty('skipRate');
            expect(stats).toHaveProperty('tierDistribution');
            expect(stats).toHaveProperty('tierNames');

            expect(stats.totalPairs).toBe(3);
        });

        test('should track tier distribution', () => {
            prioritizer.registerPair('HOT1:dex');
            prioritizer.registerPair('HOT2:dex');
            prioritizer.registerPair('NORMAL:dex');

            prioritizer.setTier('HOT1:dex', 1);
            prioritizer.setTier('HOT2:dex', 1);
            prioritizer.setTier('NORMAL:dex', 3);

            const stats = prioritizer.getStats();

            expect(stats.tierDistribution[1]).toBe(2);
            expect(stats.tierDistribution[3]).toBe(1);
        });
    });

    describe('Pair Info', () => {
        test('should return detailed pair info', () => {
            prioritizer.registerPair('WBNB/USDT:pancakeswap', { volumeUSD: 50000 });
            prioritizer.recordOpportunity('WBNB/USDT:pancakeswap');

            const info = prioritizer.getPairInfo('WBNB/USDT:pancakeswap');

            expect(info).not.toBeNull();
            expect(info.tier).toBe(1);
            expect(info.tierName).toBe('HOT');
            expect(info.frequency).toBe(1);
            expect(info.opportunityCount).toBe(1);
            expect(info.timeSinceLastOpportunity).toBeLessThan(1000);
        });

        test('should return null for unknown pair', () => {
            const info = prioritizer.getPairInfo('UNKNOWN:dex');
            expect(info).toBeNull();
        });
    });

    describe('getPairsByTier', () => {
        test('should return all pairs in specific tier', () => {
            prioritizer.registerPair('HOT1:dex');
            prioritizer.registerPair('HOT2:dex');
            prioritizer.registerPair('NORMAL:dex');

            prioritizer.setTier('HOT1:dex', 1);
            prioritizer.setTier('HOT2:dex', 1);
            prioritizer.setTier('NORMAL:dex', 3);

            const hotPairs = prioritizer.getPairsByTier(1);
            expect(hotPairs).toContain('HOT1:dex');
            expect(hotPairs).toContain('HOT2:dex');
            expect(hotPairs).not.toContain('NORMAL:dex');
        });
    });

    describe('Export/Import', () => {
        test('should export priority data', () => {
            prioritizer.registerPair('WBNB/USDT:pancakeswap', { volumeUSD: 50000 });
            prioritizer.recordOpportunity('WBNB/USDT:pancakeswap');

            const exported = prioritizer.export();

            expect(exported['WBNB/USDT:pancakeswap']).toBeDefined();
            expect(exported['WBNB/USDT:pancakeswap'].tier).toBe(1);
            expect(exported['WBNB/USDT:pancakeswap'].opportunityCount).toBe(1);
        });

        test('should import priority data', () => {
            const data = {
                'WBNB/USDT:pancakeswap': { tier: 1, opportunityCount: 5 },
                'CAKE/USDT:biswap': { tier: 3, opportunityCount: 0 },
            };

            prioritizer.import(data);

            expect(prioritizer.getTier('WBNB/USDT:pancakeswap')).toBe(1);
            expect(prioritizer.getTier('CAKE/USDT:biswap')).toBe(3);
            expect(prioritizer.pairPriority.size).toBe(2);
        });
    });

    describe('Reset', () => {
        test('should reset all pairs to default tier', () => {
            prioritizer.registerPair('HOT:dex');
            prioritizer.registerPair('WARM:dex');

            prioritizer.setTier('HOT:dex', 1);
            prioritizer.setTier('WARM:dex', 2);

            prioritizer.reset();

            expect(prioritizer.getTier('HOT:dex')).toBe(3);
            expect(prioritizer.getTier('WARM:dex')).toBe(3);
        });

        test('should reset stats on reset', () => {
            prioritizer.stats.promotions = 10;
            prioritizer.stats.demotions = 5;

            prioritizer.reset();

            expect(prioritizer.stats.promotions).toBe(0);
            expect(prioritizer.stats.demotions).toBe(0);
        });
    });
});
