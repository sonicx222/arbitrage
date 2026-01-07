import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { WhaleTracker } from '../../src/analysis/whaleTracker.js';

describe('WhaleTracker', () => {
    let tracker;

    beforeEach(() => {
        tracker = new WhaleTracker({
            minTradeUSD: 10000,
            minTradesForWhale: 3,
            historyLength: 50,
            activityWindowMs: 60000, // 1 minute for testing
        });
    });

    afterEach(() => {
        tracker.reset();
    });

    describe('constructor', () => {
        it('should initialize with default options', () => {
            const defaultTracker = new WhaleTracker();
            expect(defaultTracker.minTradeUSD).toBe(10000);
            expect(defaultTracker.minTradesForWhale).toBe(5);
        });

        it('should accept custom options', () => {
            expect(tracker.minTradeUSD).toBe(10000);
            expect(tracker.minTradesForWhale).toBe(3);
        });

        it('should initialize empty data structures', () => {
            expect(tracker.addresses.size).toBe(0);
            expect(tracker.tradesByPair.size).toBe(0);
        });
    });

    describe('recordTrade', () => {
        it('should record a trade', () => {
            tracker.recordTrade({
                address: '0x1234567890123456789012345678901234567890',
                pairKey: 'WBNB/USDT',
                dexName: 'pancakeswap',
                amountUSD: 15000,
                direction: 'buy',
                blockNumber: 1000,
                txHash: '0xabc',
            });

            expect(tracker.stats.tradesRecorded).toBe(1);
            expect(tracker.stats.addressesTracked).toBe(1);
        });

        it('should not record trades with missing data', () => {
            tracker.recordTrade({});
            tracker.recordTrade({ address: '0x123' });
            tracker.recordTrade({ address: '0x123', pairKey: 'WBNB/USDT' });

            expect(tracker.stats.tradesRecorded).toBe(0);
        });

        it('should update stats for multiple trades from same address', () => {
            const address = '0x1234567890123456789012345678901234567890';

            for (let i = 0; i < 5; i++) {
                tracker.recordTrade({
                    address,
                    pairKey: 'WBNB/USDT',
                    dexName: 'pancakeswap',
                    amountUSD: 20000,
                    direction: 'buy',
                    blockNumber: 1000 + i,
                    txHash: `0x${i}`,
                });
            }

            const addressData = tracker.addresses.get(address.toLowerCase());
            expect(addressData.stats.totalTradesCount).toBe(5);
            expect(addressData.stats.totalVolumeUSD).toBe(100000);
            expect(addressData.stats.avgTradeUSD).toBe(20000);
        });

        it('should track favored pairs', () => {
            const address = '0x1234567890123456789012345678901234567890';

            tracker.recordTrade({
                address,
                pairKey: 'WBNB/USDT',
                dexName: 'pancakeswap',
                amountUSD: 15000,
                direction: 'buy',
                blockNumber: 1000,
            });

            tracker.recordTrade({
                address,
                pairKey: 'WBNB/USDT',
                dexName: 'pancakeswap',
                amountUSD: 15000,
                direction: 'sell',
                blockNumber: 1001,
            });

            tracker.recordTrade({
                address,
                pairKey: 'CAKE/USDT',
                dexName: 'pancakeswap',
                amountUSD: 15000,
                direction: 'buy',
                blockNumber: 1002,
            });

            const addressData = tracker.addresses.get(address.toLowerCase());
            expect(addressData.stats.favoredPairs.get('WBNB/USDT')).toBe(2);
            expect(addressData.stats.favoredPairs.get('CAKE/USDT')).toBe(1);
        });
    });

    describe('whale identification', () => {
        it('should identify whale after minimum trades with large volume', () => {
            const address = '0x1234567890123456789012345678901234567890';

            for (let i = 0; i < 3; i++) {
                tracker.recordTrade({
                    address,
                    pairKey: 'WBNB/USDT',
                    dexName: 'pancakeswap',
                    amountUSD: 15000,
                    direction: 'buy',
                    blockNumber: 1000 + i,
                });
            }

            const addressData = tracker.addresses.get(address.toLowerCase());
            expect(addressData.isWhale).toBe(true);
            expect(tracker.stats.whalesIdentified).toBe(1);
        });

        it('should not identify whale with insufficient trades', () => {
            const address = '0x1234567890123456789012345678901234567890';

            tracker.recordTrade({
                address,
                pairKey: 'WBNB/USDT',
                dexName: 'pancakeswap',
                amountUSD: 50000,
                direction: 'buy',
                blockNumber: 1000,
            });

            const addressData = tracker.addresses.get(address.toLowerCase());
            expect(addressData.isWhale).toBe(false);
        });

        it('should emit whaleActivity event for whale trades', (done) => {
            const address = '0x1234567890123456789012345678901234567890';

            // First make the address a whale
            for (let i = 0; i < 3; i++) {
                tracker.recordTrade({
                    address,
                    pairKey: 'WBNB/USDT',
                    dexName: 'pancakeswap',
                    amountUSD: 15000,
                    direction: 'buy',
                    blockNumber: 1000 + i,
                });
            }

            // Now listen for the event
            tracker.on('whaleActivity', (signal) => {
                expect(signal.type).toBe('whale-trade');
                expect(signal.address).toBe(address.toLowerCase());
                expect(signal.amountUSD).toBe(25000);
                done();
            });

            // This trade should trigger the event
            tracker.recordTrade({
                address,
                pairKey: 'CAKE/USDT',
                dexName: 'pancakeswap',
                amountUSD: 25000,
                direction: 'sell',
                blockNumber: 1003,
            });
        });
    });

    describe('getWhaleActivityForPair', () => {
        it('should return no activity for unknown pair', () => {
            const activity = tracker.getWhaleActivityForPair('UNKNOWN/PAIR');
            expect(activity.hasActivity).toBe(false);
            expect(activity.tradeCount).toBe(0);
        });

        it('should return whale activity for pair', () => {
            const address = '0x1234567890123456789012345678901234567890';

            // Make address a whale
            for (let i = 0; i < 3; i++) {
                tracker.recordTrade({
                    address,
                    pairKey: 'WBNB/USDT',
                    dexName: 'pancakeswap',
                    amountUSD: 15000,
                    direction: 'buy',
                    blockNumber: 1000 + i,
                });
            }

            const activity = tracker.getWhaleActivityForPair('WBNB/USDT');
            expect(activity.hasActivity).toBe(true);
            expect(activity.tradeCount).toBe(3);
            expect(activity.totalVolumeUSD).toBe(45000);
            expect(activity.netDirection).toBe('buy');
        });

        it('should detect sell pressure', () => {
            const address = '0x1234567890123456789012345678901234567890';

            // Make address a whale with sells
            for (let i = 0; i < 3; i++) {
                tracker.recordTrade({
                    address,
                    pairKey: 'WBNB/USDT',
                    dexName: 'pancakeswap',
                    amountUSD: 15000,
                    direction: 'sell',
                    blockNumber: 1000 + i,
                });
            }

            const activity = tracker.getWhaleActivityForPair('WBNB/USDT');
            expect(activity.netDirection).toBe('sell');
        });
    });

    describe('assessCompetition', () => {
        it('should return none when no activity', () => {
            const assessment = tracker.assessCompetition('WBNB/USDT', 'buy');
            expect(assessment.level).toBe('none');
            expect(assessment.recommendation).toBe('proceed');
        });

        it('should detect high competition when whales very active', () => {
            const address = '0x1234567890123456789012345678901234567890';

            // Make address a whale with high volume in same direction
            for (let i = 0; i < 3; i++) {
                tracker.recordTrade({
                    address,
                    pairKey: 'WBNB/USDT',
                    dexName: 'pancakeswap',
                    amountUSD: 20000,
                    direction: 'buy',
                    blockNumber: 1000 + i,
                });
            }

            // Recent high-volume same-direction should be "high"
            const assessment = tracker.assessCompetition('WBNB/USDT', 'buy');
            expect(assessment.level).toBe('high');
            expect(assessment.recommendation).toBe('caution');
        });

        it('should detect low competition for opposite direction', () => {
            const address = '0x1234567890123456789012345678901234567890';

            // Make address a whale with buys
            for (let i = 0; i < 3; i++) {
                tracker.recordTrade({
                    address,
                    pairKey: 'WBNB/USDT',
                    dexName: 'pancakeswap',
                    amountUSD: 20000,
                    direction: 'buy',
                    blockNumber: 1000 + i,
                });
            }

            // Checking sell direction when whales are buying
            const assessment = tracker.assessCompetition('WBNB/USDT', 'sell');
            expect(assessment.level).toBe('low');
            expect(assessment.recommendation).toBe('proceed');
        });
    });

    describe('getTopWhales', () => {
        it('should return empty array when no whales', () => {
            const whales = tracker.getTopWhales();
            expect(whales).toEqual([]);
        });

        it('should return top whales sorted by volume', () => {
            // Create multiple whales
            const addresses = [
                '0x1111111111111111111111111111111111111111',
                '0x2222222222222222222222222222222222222222',
                '0x3333333333333333333333333333333333333333',
            ];

            // Whale 1: $150k volume
            for (let i = 0; i < 5; i++) {
                tracker.recordTrade({
                    address: addresses[0],
                    pairKey: 'WBNB/USDT',
                    dexName: 'pancakeswap',
                    amountUSD: 30000,
                    direction: 'buy',
                    blockNumber: 1000 + i,
                });
            }

            // Whale 2: $100k volume
            for (let i = 0; i < 5; i++) {
                tracker.recordTrade({
                    address: addresses[1],
                    pairKey: 'WBNB/USDT',
                    dexName: 'pancakeswap',
                    amountUSD: 20000,
                    direction: 'buy',
                    blockNumber: 1000 + i,
                });
            }

            // Whale 3: $50k volume
            for (let i = 0; i < 5; i++) {
                tracker.recordTrade({
                    address: addresses[2],
                    pairKey: 'WBNB/USDT',
                    dexName: 'pancakeswap',
                    amountUSD: 10000,
                    direction: 'buy',
                    blockNumber: 1000 + i,
                });
            }

            const whales = tracker.getTopWhales(2);
            expect(whales.length).toBe(2);
            expect(whales[0].totalVolumeUSD).toBe(150000);
            expect(whales[1].totalVolumeUSD).toBe(100000);
        });
    });

    describe('import/export', () => {
        it('should export whale data', () => {
            const address = '0x1234567890123456789012345678901234567890';

            for (let i = 0; i < 5; i++) {
                tracker.recordTrade({
                    address,
                    pairKey: 'WBNB/USDT',
                    dexName: 'pancakeswap',
                    amountUSD: 20000,
                    direction: 'buy',
                    blockNumber: 1000 + i,
                });
            }

            const exported = tracker.exportWhales();
            expect(exported.length).toBe(1);
            expect(exported[0].address).toBe(address.toLowerCase());
            expect(exported[0].volumeUSD).toBe(100000);
        });

        it('should import whale data', () => {
            const whaleData = [
                {
                    address: '0xaaaa111111111111111111111111111111111111',
                    tradesCount: 10,
                    volumeUSD: 200000,
                    avgTradeUSD: 20000,
                    largeTradesCount: 8,
                    favoredPairs: [['WBNB/USDT', 5], ['CAKE/USDT', 3]],
                },
            ];

            tracker.importWhales(whaleData);

            expect(tracker.stats.whalesIdentified).toBe(1);
            expect(tracker.addresses.size).toBe(1);

            const addressData = tracker.addresses.get(whaleData[0].address.toLowerCase());
            expect(addressData.isWhale).toBe(true);
            expect(addressData.stats.totalVolumeUSD).toBe(200000);
        });
    });

    describe('getStats', () => {
        it('should return comprehensive stats', () => {
            const address = '0x1234567890123456789012345678901234567890';

            for (let i = 0; i < 5; i++) {
                tracker.recordTrade({
                    address,
                    pairKey: 'WBNB/USDT',
                    dexName: 'pancakeswap',
                    amountUSD: 20000,
                    direction: 'buy',
                    blockNumber: 1000 + i,
                });
            }

            const stats = tracker.getStats();
            expect(stats.addressesTracked).toBe(1);
            expect(stats.whalesIdentified).toBe(1);
            expect(stats.tradesRecorded).toBe(5);
            expect(stats.activeWhales).toBe(1);
            expect(stats.pairsTracked).toBe(1);
        });
    });

    describe('reset', () => {
        it('should clear all data', () => {
            const address = '0x1234567890123456789012345678901234567890';

            for (let i = 0; i < 5; i++) {
                tracker.recordTrade({
                    address,
                    pairKey: 'WBNB/USDT',
                    dexName: 'pancakeswap',
                    amountUSD: 20000,
                    direction: 'buy',
                    blockNumber: 1000 + i,
                });
            }

            tracker.reset();

            expect(tracker.addresses.size).toBe(0);
            expect(tracker.tradesByPair.size).toBe(0);
            expect(tracker.stats.tradesRecorded).toBe(0);
        });
    });
});
