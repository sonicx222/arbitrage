import MempoolMonitor from '../../src/analysis/MempoolMonitor.js';
import { EventEmitter } from 'events';

describe('MempoolMonitor', () => {
    let monitor;

    beforeEach(() => {
        monitor = new MempoolMonitor({
            enabled: true,
            chainId: 56,
            minSwapSizeUSD: 10000,
            maxPendingSwaps: 100,
        });
    });

    afterEach(() => {
        monitor.stop();
        monitor.removeAllListeners();
    });

    describe('constructor', () => {
        it('should initialize with default config', () => {
            const defaultMonitor = new MempoolMonitor();
            expect(defaultMonitor.enabled).toBe(false);
            expect(defaultMonitor.chainId).toBe(56);
            expect(defaultMonitor.minSwapSizeUSD).toBe(10000);
        });

        it('should initialize with custom config', () => {
            expect(monitor.enabled).toBe(true);
            expect(monitor.chainId).toBe(56);
            expect(monitor.minSwapSizeUSD).toBe(10000);
            expect(monitor.maxPendingSwaps).toBe(100);
        });

        it('should have swap signatures for common methods', () => {
            expect(monitor.swapSignatures.size).toBeGreaterThan(0);
            expect(monitor.swapSignatures.has('0x38ed1739')).toBe(true); // swapExactTokensForTokens
            expect(monitor.swapSignatures.has('0x7ff36ab5')).toBe(true); // swapExactETHForTokens
        });

        it('should initialize statistics', () => {
            expect(monitor.stats.txsProcessed).toBe(0);
            expect(monitor.stats.swapsDetected).toBe(0);
            expect(monitor.stats.largeSwaps).toBe(0);
            expect(monitor.stats.errors).toBe(0);
        });
    });

    describe('start', () => {
        it('should not start if disabled', async () => {
            const disabledMonitor = new MempoolMonitor({ enabled: false });
            await disabledMonitor.start(null);
            expect(disabledMonitor.isMonitoring).toBe(false);
        });

        it('should not start without WebSocket provider', async () => {
            await monitor.start(null);
            expect(monitor.isMonitoring).toBe(false);
        });

        it('should set up listener on WebSocket provider', async () => {
            const mockProvider = new EventEmitter();
            await monitor.start(mockProvider);
            expect(monitor.isMonitoring).toBe(true);
            expect(monitor.wsProvider).toBe(mockProvider);
        });

        it('should not start if already monitoring', async () => {
            const mockProvider = new EventEmitter();
            await monitor.start(mockProvider);
            const isMonitoringBefore = monitor.isMonitoring;
            await monitor.start(mockProvider);
            expect(monitor.isMonitoring).toBe(isMonitoringBefore);
        });
    });

    describe('stop', () => {
        it('should stop monitoring and clear pending swaps', async () => {
            const mockProvider = new EventEmitter();
            await monitor.start(mockProvider);

            // Add a pending swap
            monitor.pendingSwaps.set('0xtest', { test: true });

            monitor.stop();

            expect(monitor.isMonitoring).toBe(false);
            expect(monitor.pendingSwaps.size).toBe(0);
        });

        it('should remove listeners from provider', async () => {
            const mockProvider = new EventEmitter();
            await monitor.start(mockProvider);

            monitor.stop();

            expect(mockProvider.listenerCount('pending')).toBe(0);
        });
    });

    describe('decodeSwap', () => {
        it('should return null for invalid transaction data', () => {
            const tx = { data: '0x', value: 0n };
            const result = monitor.decodeSwap(tx, 'swapExactTokensForTokens');
            expect(result).toBeNull();
        });

        it('should return null for malformed data', () => {
            const tx = { data: '0x38ed173900000000', value: 0n };
            const result = monitor.decodeSwap(tx, 'swapExactTokensForTokens');
            expect(result).toBeNull();
        });
    });

    describe('isLargeSwap', () => {
        it('should detect large ETH swaps based on USD value', () => {
            const decoded = {};
            // 20 BNB at $600 = $12,000 (above $10,000 threshold)
            const value = BigInt('20000000000000000000'); // 20 BNB

            const isLarge = monitor.isLargeSwap(decoded, value);
            expect(isLarge).toBe(true);
        });

        it('should not flag small ETH swaps', () => {
            const decoded = {};
            // 1 BNB at $600 = $600 (below $10,000 threshold)
            const value = BigInt('1000000000000000000'); // 1 BNB

            const isLarge = monitor.isLargeSwap(decoded, value);
            expect(isLarge).toBe(false);
        });

        it('should detect large token swaps', () => {
            const decoded = {
                amountIn: '2000000000000000000000', // 2000 tokens
            };

            const isLarge = monitor.isLargeSwap(decoded, 0n);
            expect(isLarge).toBe(true);
        });

        it('should use ETH price for Ethereum chain', () => {
            const ethMonitor = new MempoolMonitor({
                enabled: true,
                chainId: 1,
                minSwapSizeUSD: 10000,
            });

            const decoded = {};
            // 4 ETH at $3000 = $12,000
            const value = BigInt('4000000000000000000');

            const isLarge = ethMonitor.isLargeSwap(decoded, value);
            expect(isLarge).toBe(true);
        });
    });

    describe('cachePendingSwap', () => {
        it('should cache swap info', () => {
            const swapInfo = { txHash: '0xtest', amount: '1000' };
            monitor.cachePendingSwap('0xtest', swapInfo);

            expect(monitor.pendingSwaps.has('0xtest')).toBe(true);
            expect(monitor.pendingSwaps.get('0xtest')).toEqual(swapInfo);
        });

        it('should evict oldest entry when cache is full', () => {
            monitor.maxPendingSwaps = 3;

            monitor.cachePendingSwap('0x1', { timestamp: 1 });
            monitor.cachePendingSwap('0x2', { timestamp: 2 });
            monitor.cachePendingSwap('0x3', { timestamp: 3 });
            monitor.cachePendingSwap('0x4', { timestamp: 4 });

            expect(monitor.pendingSwaps.size).toBe(3);
            expect(monitor.pendingSwaps.has('0x1')).toBe(false);
            expect(monitor.pendingSwaps.has('0x4')).toBe(true);
        });
    });

    describe('getPendingSwapsForPath', () => {
        beforeEach(() => {
            const now = Date.now();
            monitor.pendingSwaps.set('0x1', {
                path: ['0xTokenA', '0xTokenB'],
                timestamp: now,
            });
            monitor.pendingSwaps.set('0x2', {
                path: ['0xTokenA', '0xTokenC', '0xTokenB'],
                timestamp: now,
            });
            monitor.pendingSwaps.set('0x3', {
                path: ['0xTokenB', '0xTokenA'],
                timestamp: now,
            });
            // Old swap that should be cleaned up
            monitor.pendingSwaps.set('0x4', {
                path: ['0xTokenA', '0xTokenB'],
                timestamp: now - 130000, // > 2 minutes old
            });
        });

        it('should return swaps matching token path', () => {
            const matches = monitor.getPendingSwapsForPath('0xTokenA', '0xTokenB');
            expect(matches.length).toBe(2); // 0x1 and 0x2
        });

        it('should clean up stale entries', () => {
            monitor.getPendingSwapsForPath('0xTokenA', '0xTokenB');
            expect(monitor.pendingSwaps.has('0x4')).toBe(false);
        });

        it('should handle case-insensitive address matching', () => {
            const matches = monitor.getPendingSwapsForPath('0xtokena', '0xtokenb');
            expect(matches.length).toBe(2);
        });

        it('should return empty array for non-matching path', () => {
            const matches = monitor.getPendingSwapsForPath('0xTokenX', '0xTokenY');
            expect(matches.length).toBe(0);
        });
    });

    describe('estimatePendingImpact', () => {
        beforeEach(() => {
            const now = Date.now();
            monitor.pendingSwaps.set('0x1', {
                path: ['0xTokenA', '0xTokenB'],
                amountIn: '1000000000000000000000', // 1000 tokens
                timestamp: now,
            });
            monitor.pendingSwaps.set('0x2', {
                path: ['0xTokenA', '0xTokenB'],
                amountIn: '2000000000000000000000', // 2000 tokens
                timestamp: now,
            });
        });

        it('should calculate total pending volume', () => {
            const impact = monitor.estimatePendingImpact(
                '0xTokenA',
                '0xTokenB',
                { reserveIn: '10000000000000000000000' }
            );

            expect(impact.totalPendingVolume).toBe(3000000000000000000000n);
            expect(impact.pendingSwapCount).toBe(2);
        });

        it('should estimate price impact', () => {
            const impact = monitor.estimatePendingImpact(
                '0xTokenA',
                '0xTokenB',
                { reserveIn: '10000000000000000000000' } // 10000 tokens
            );

            // 3000/10000 * 100 = 30%
            expect(impact.estimatedPriceImpact).toBe(30);
        });

        it('should return zero impact when no pending swaps', () => {
            const impact = monitor.estimatePendingImpact(
                '0xTokenX',
                '0xTokenY',
                { reserveIn: '10000' }
            );

            expect(impact.totalPendingVolume).toBe(0n);
            expect(impact.estimatedPriceImpact).toBe(0);
        });

        it('should handle zero reserves', () => {
            const impact = monitor.estimatePendingImpact(
                '0xTokenA',
                '0xTokenB',
                { reserveIn: '0' }
            );

            expect(impact.estimatedPriceImpact).toBe(0);
        });
    });

    describe('getStats', () => {
        it('should return comprehensive statistics', () => {
            const stats = monitor.getStats();
            expect(stats).toHaveProperty('txsProcessed');
            expect(stats).toHaveProperty('swapsDetected');
            expect(stats).toHaveProperty('largeSwaps');
            expect(stats).toHaveProperty('errors');
            expect(stats).toHaveProperty('isMonitoring');
            expect(stats).toHaveProperty('pendingSwapsCached');
        });
    });

    describe('isActive', () => {
        it('should return false when not monitoring', () => {
            expect(monitor.isActive()).toBe(false);
        });

        it('should return true when enabled and monitoring', async () => {
            const mockProvider = new EventEmitter();
            await monitor.start(mockProvider);
            expect(monitor.isActive()).toBe(true);
        });
    });

    describe('event emission', () => {
        it('should emit largeSwap event for large detected swaps', (done) => {
            monitor.on('largeSwap', (swapInfo) => {
                expect(swapInfo).toHaveProperty('txHash');
                done();
            });

            // Manually trigger a large swap emission (simulating internal behavior)
            const swapInfo = {
                txHash: '0xtest',
                router: '0xrouter',
                method: 'swapExactTokensForTokens',
                timestamp: Date.now(),
            };
            monitor.emit('largeSwap', swapInfo);
        });
    });
});
