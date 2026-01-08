import { jest } from '@jest/globals';

// Mock dependencies
jest.unstable_mockModule('../../src/utils/logger.js', () => ({
    default: {
        info: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
    }
}));

jest.unstable_mockModule('../../src/config.js', () => ({
    default: {}
}));

const { CrossChainFlashLoanCoordinator } = await import('../../src/execution/crossChainCoordinator.js');

describe('CrossChainFlashLoanCoordinator', () => {
    let coordinator;
    let mockExecutionManager;

    beforeEach(() => {
        coordinator = new CrossChainFlashLoanCoordinator({
            maxPriceAgeSec: 10,
            minProfitUSD: 5,
        });

        mockExecutionManager = {
            execute: jest.fn().mockResolvedValue({
                success: true,
                txHash: '0xtest',
                profitUSD: 15,
            }),
        };
    });

    afterEach(() => {
        coordinator.cleanup();
        jest.clearAllMocks();
    });

    describe('constructor', () => {
        test('should initialize with default config', () => {
            const coord = new CrossChainFlashLoanCoordinator();
            expect(coord.config.maxPriceAgeSec).toBe(10);
            expect(coord.config.minProfitUSD).toBe(5);
            coord.cleanup();
        });

        test('should accept custom config', () => {
            const coord = new CrossChainFlashLoanCoordinator({
                maxPriceAgeSec: 30,
                minProfitUSD: 20,
            });
            expect(coord.config.maxPriceAgeSec).toBe(30);
            expect(coord.config.minProfitUSD).toBe(20);
            coord.cleanup();
        });

        test('should initialize empty chains map', () => {
            expect(coordinator.chains.size).toBe(0);
        });

        test('should initialize empty bridges map', () => {
            expect(coordinator.bridges.size).toBe(0);
        });

        test('should initialize stats to zero', () => {
            expect(coordinator.stats.dualChainAttempted).toBe(0);
            expect(coordinator.stats.totalProfitUSD).toBe(0);
        });
    });

    describe('registerChain', () => {
        test('should register a chain', () => {
            coordinator.registerChain(56, mockExecutionManager, {});
            expect(coordinator.chains.has(56)).toBe(true);
        });

        test('should store execution manager', () => {
            coordinator.registerChain(56, mockExecutionManager, {});
            expect(coordinator.chains.get(56).executionManager).toBe(mockExecutionManager);
        });

        test('should store provider', () => {
            const mockProvider = { getBlockNumber: jest.fn() };
            coordinator.registerChain(56, mockExecutionManager, mockProvider);
            expect(coordinator.chains.get(56).provider).toBe(mockProvider);
        });

        test('should store optional signer', () => {
            const mockSigner = { signTransaction: jest.fn() };
            coordinator.registerChain(56, mockExecutionManager, {}, mockSigner);
            expect(coordinator.chains.get(56).signer).toBe(mockSigner);
        });

        test('should store optional contract address', () => {
            coordinator.registerChain(56, mockExecutionManager, {}, null, '0xcontract');
            expect(coordinator.chains.get(56).contractAddress).toBe('0xcontract');
        });
    });

    describe('unregisterChain', () => {
        test('should remove a registered chain', () => {
            coordinator.registerChain(56, mockExecutionManager, {});
            coordinator.unregisterChain(56);
            expect(coordinator.chains.has(56)).toBe(false);
        });

        test('should handle unregistering non-existent chain', () => {
            expect(() => coordinator.unregisterChain(999)).not.toThrow();
        });
    });

    describe('checkChainsReady', () => {
        test('should return ready when both chains registered', () => {
            coordinator.registerChain(56, mockExecutionManager, {});
            coordinator.registerChain(1, mockExecutionManager, {});

            const result = coordinator.checkChainsReady(56, 1);
            expect(result.ready).toBe(true);
        });

        test('should return not ready when chain A not registered', () => {
            coordinator.registerChain(1, mockExecutionManager, {});

            const result = coordinator.checkChainsReady(56, 1);
            expect(result.ready).toBe(false);
            expect(result.reason).toContain('56');
        });

        test('should return not ready when chain B not registered', () => {
            coordinator.registerChain(56, mockExecutionManager, {});

            const result = coordinator.checkChainsReady(56, 1);
            expect(result.ready).toBe(false);
            expect(result.reason).toContain('1');
        });

        test('should return not ready when execution manager missing', () => {
            coordinator.chains.set(56, { provider: {} });
            coordinator.registerChain(1, mockExecutionManager, {});

            const result = coordinator.checkChainsReady(56, 1);
            expect(result.ready).toBe(false);
            expect(result.reason).toContain('executionManager');
        });
    });

    describe('_validateOpportunity', () => {
        const validOpportunity = {
            timestamp: Date.now(),
            estimatedProfitUSD: 20,
            buyChain: { chainId: 56 },
            sellChain: { chainId: 1 },
        };

        test('should validate fresh opportunity', () => {
            const result = coordinator._validateOpportunity(validOpportunity);
            expect(result.valid).toBe(true);
        });

        test('should reject opportunity without timestamp', () => {
            const opp = { ...validOpportunity, timestamp: undefined };
            const result = coordinator._validateOpportunity(opp);
            expect(result.valid).toBe(false);
            expect(result.reason).toContain('timestamp');
        });

        test('should reject stale opportunity', () => {
            const opp = {
                ...validOpportunity,
                timestamp: Date.now() - 60000, // 1 minute ago
            };
            const result = coordinator._validateOpportunity(opp);
            expect(result.valid).toBe(false);
            expect(result.reason).toContain('old');
        });

        test('should reject opportunity with low profit', () => {
            const opp = { ...validOpportunity, estimatedProfitUSD: 2 };
            const result = coordinator._validateOpportunity(opp);
            expect(result.valid).toBe(false);
            expect(result.reason).toContain('Profit');
        });

        test('should reject opportunity without buyChain', () => {
            const opp = { ...validOpportunity, buyChain: undefined };
            const result = coordinator._validateOpportunity(opp);
            expect(result.valid).toBe(false);
            expect(result.reason).toContain('chain');
        });
    });

    describe('_buildChainOpportunity', () => {
        const crossChainOpp = {
            token: 'USDC',
            tradeSizeUSD: 10000,
            buyChain: {
                chainId: 56,
                dex: 'pancakeswap',
                priceUSD: 0.999,
                blockNumber: 12345,
            },
            sellChain: {
                chainId: 1,
                dex: 'uniswap',
                priceUSD: 1.002,
                blockNumber: 67890,
            },
        };

        test('should build buy-side opportunity', () => {
            const result = coordinator._buildChainOpportunity(crossChainOpp, 'buy');

            expect(result.type).toBe('cross-chain-leg');
            expect(result.side).toBe('buy');
            expect(result.chainId).toBe(56);
            expect(result.dex).toBe('pancakeswap');
            expect(result.priceUSD).toBe(0.999);
        });

        test('should build sell-side opportunity', () => {
            const result = coordinator._buildChainOpportunity(crossChainOpp, 'sell');

            expect(result.type).toBe('cross-chain-leg');
            expect(result.side).toBe('sell');
            expect(result.chainId).toBe(1);
            expect(result.dex).toBe('uniswap');
            expect(result.priceUSD).toBe(1.002);
        });

        test('should include token and trade size', () => {
            const result = coordinator._buildChainOpportunity(crossChainOpp, 'buy');

            expect(result.token).toBe('USDC');
            expect(result.tradeSizeUSD).toBe(10000);
        });

        test('should include cross-chain reference', () => {
            const result = coordinator._buildChainOpportunity(crossChainOpp, 'buy');

            expect(result.crossChainRef).toBe(crossChainOpp);
            expect(result.source).toBe('cross-chain-coordinator');
        });
    });

    describe('executeDualChain', () => {
        const validOpportunity = {
            token: 'USDC',
            timestamp: Date.now(),
            estimatedProfitUSD: 50,
            tradeSizeUSD: 10000,
            spreadPercent: 0.5,
            buyChain: {
                chainId: 56,
                dex: 'pancakeswap',
                priceUSD: 0.999,
                blockNumber: 12345,
            },
            sellChain: {
                chainId: 1,
                dex: 'uniswap',
                priceUSD: 1.004,
                blockNumber: 67890,
            },
        };

        beforeEach(() => {
            coordinator.registerChain(56, mockExecutionManager, {});
            coordinator.registerChain(1, mockExecutionManager, {});
        });

        test('should execute on both chains', async () => {
            const result = await coordinator.executeDualChain(validOpportunity);

            expect(mockExecutionManager.execute).toHaveBeenCalledTimes(2);
            expect(result.success).toBe(true);
            expect(result.strategy).toBe('DUAL_CHAIN_ATOMIC');
        });

        test('should return execution ID', async () => {
            const result = await coordinator.executeDualChain(validOpportunity);

            expect(result.executionId).toBeDefined();
            expect(result.executionId.startsWith('xc_')).toBe(true);
        });

        test('should aggregate profit from both chains', async () => {
            const result = await coordinator.executeDualChain(validOpportunity);

            // Both chains return 15 profit each
            expect(result.totalProfitUSD).toBe(30);
        });

        test('should emit executionComplete event', async () => {
            const eventPromise = new Promise((resolve) => {
                coordinator.on('executionComplete', resolve);
            });

            coordinator.executeDualChain(validOpportunity);

            const event = await eventPromise;
            expect(event.success).toBe(true);
        });

        test('should update statistics on success', async () => {
            await coordinator.executeDualChain(validOpportunity);

            expect(coordinator.stats.dualChainAttempted).toBe(1);
            expect(coordinator.stats.dualChainSuccess).toBe(1);
            expect(coordinator.stats.totalProfitUSD).toBeGreaterThan(0);
        });

        test('should fail when chains not ready', async () => {
            coordinator.unregisterChain(56);

            const result = await coordinator.executeDualChain(validOpportunity);

            expect(result.success).toBe(false);
            expect(result.error).toContain('56');
        });

        test('should fail when opportunity is stale', async () => {
            const staleOpp = {
                ...validOpportunity,
                timestamp: Date.now() - 60000,
            };

            const result = await coordinator.executeDualChain(staleOpp);

            expect(result.success).toBe(false);
            expect(result.error).toContain('Invalid opportunity');
        });

        test('should handle execution failure on one chain', async () => {
            const failingManager = {
                execute: jest.fn().mockResolvedValue({
                    success: false,
                    error: 'Insufficient liquidity',
                }),
            };

            coordinator.chains.get(1).executionManager = failingManager;

            const result = await coordinator.executeDualChain(validOpportunity);

            // Still success because one chain succeeded
            expect(result.success).toBe(true);
            expect(result.successCount).toBe(1);
            expect(result.totalCount).toBe(2);
        });

        test('should record execution in history', async () => {
            await coordinator.executeDualChain(validOpportunity);

            expect(coordinator.executionHistory.length).toBe(1);
            expect(coordinator.executionHistory[0].strategy).toBe('DUAL_CHAIN_ATOMIC');
        });
    });

    describe('_aggregateResults', () => {
        test('should aggregate successful results', () => {
            const results = [
                { chainId: 56, success: true, profitUSD: 10 },
                { chainId: 1, success: true, profitUSD: 15 },
            ];

            const aggregated = coordinator._aggregateResults('test_id', results, 100);

            expect(aggregated.success).toBe(true);
            expect(aggregated.successCount).toBe(2);
            expect(aggregated.totalProfitUSD).toBe(25);
            expect(aggregated.executionTimeMs).toBe(100);
        });

        test('should report partial success', () => {
            const results = [
                { chainId: 56, success: true, profitUSD: 10 },
                { chainId: 1, success: false, error: 'failed' },
            ];

            const aggregated = coordinator._aggregateResults('test_id', results, 100);

            expect(aggregated.success).toBe(true);
            expect(aggregated.successCount).toBe(1);
        });

        test('should report total failure', () => {
            const results = [
                { chainId: 56, success: false },
                { chainId: 1, success: false },
            ];

            const aggregated = coordinator._aggregateResults('test_id', results, 100);

            expect(aggregated.success).toBe(false);
            expect(aggregated.failureReason).toBe('All chains failed');
        });
    });

    describe('registerBridge', () => {
        test('should register bridge adapter', () => {
            const mockAdapter = { execute: jest.fn() };
            coordinator.registerBridge(56, 1, mockAdapter);

            expect(coordinator.bridges.has('56-1')).toBe(true);
        });

        test('should store adapter correctly', () => {
            const mockAdapter = { execute: jest.fn() };
            coordinator.registerBridge(56, 1, mockAdapter);

            expect(coordinator.bridges.get('56-1')).toBe(mockAdapter);
        });
    });

    describe('getStats', () => {
        test('should return comprehensive statistics', () => {
            const stats = coordinator.getStats();

            expect(stats.dualChainAttempted).toBeDefined();
            expect(stats.dualChainSuccess).toBeDefined();
            expect(stats.bridgeAndFlashAttempted).toBeDefined();
            expect(stats.totalProfitUSD).toBeDefined();
            expect(stats.chainsRegistered).toBeDefined();
            expect(stats.successRate).toBeDefined();
        });

        test('should include chain count', () => {
            coordinator.registerChain(56, mockExecutionManager, {});
            coordinator.registerChain(1, mockExecutionManager, {});

            const stats = coordinator.getStats();
            expect(stats.chainsRegistered).toBe(2);
        });

        test('should include bridge count', () => {
            coordinator.registerBridge(56, 1, {});
            coordinator.registerBridge(1, 137, {});

            const stats = coordinator.getStats();
            expect(stats.bridgesRegistered).toBe(2);
        });

        test('should calculate success rate', async () => {
            coordinator.registerChain(56, mockExecutionManager, {});
            coordinator.registerChain(1, mockExecutionManager, {});

            const opp = {
                token: 'USDC',
                timestamp: Date.now(),
                estimatedProfitUSD: 50,
                tradeSizeUSD: 10000,
                buyChain: { chainId: 56, dex: 'pancake', priceUSD: 0.999, blockNumber: 1 },
                sellChain: { chainId: 1, dex: 'uni', priceUSD: 1.004, blockNumber: 1 },
            };

            await coordinator.executeDualChain(opp);

            const stats = coordinator.getStats();
            expect(stats.successRate).toBe('100.0%');
        });
    });

    describe('getHistory', () => {
        test('should return empty array initially', () => {
            expect(coordinator.getHistory()).toEqual([]);
        });

        test('should return executions after running', async () => {
            coordinator.registerChain(56, mockExecutionManager, {});
            coordinator.registerChain(1, mockExecutionManager, {});

            const opp = {
                token: 'USDC',
                timestamp: Date.now(),
                estimatedProfitUSD: 50,
                tradeSizeUSD: 10000,
                buyChain: { chainId: 56, dex: 'pancake', priceUSD: 0.999, blockNumber: 1 },
                sellChain: { chainId: 1, dex: 'uni', priceUSD: 1.004, blockNumber: 1 },
            };

            await coordinator.executeDualChain(opp);

            const history = coordinator.getHistory();
            expect(history.length).toBe(1);
        });

        test('should respect limit parameter', async () => {
            coordinator.registerChain(56, mockExecutionManager, {});
            coordinator.registerChain(1, mockExecutionManager, {});

            // Run multiple executions
            for (let i = 0; i < 5; i++) {
                const opp = {
                    token: 'USDC',
                    timestamp: Date.now(),
                    estimatedProfitUSD: 50,
                    tradeSizeUSD: 10000,
                    buyChain: { chainId: 56, dex: 'pancake', priceUSD: 0.999, blockNumber: 1 },
                    sellChain: { chainId: 1, dex: 'uni', priceUSD: 1.004, blockNumber: 1 },
                };
                await coordinator.executeDualChain(opp);
            }

            const history = coordinator.getHistory(3);
            expect(history.length).toBe(3);
        });
    });

    describe('getRegisteredChains', () => {
        test('should return array of chain IDs', () => {
            coordinator.registerChain(56, mockExecutionManager, {});
            coordinator.registerChain(1, mockExecutionManager, {});
            coordinator.registerChain(137, mockExecutionManager, {});

            const chains = coordinator.getRegisteredChains();

            expect(chains).toContain(56);
            expect(chains).toContain(1);
            expect(chains).toContain(137);
            expect(chains.length).toBe(3);
        });
    });

    describe('resetStats', () => {
        test('should reset all statistics', async () => {
            coordinator.registerChain(56, mockExecutionManager, {});
            coordinator.registerChain(1, mockExecutionManager, {});

            const opp = {
                token: 'USDC',
                timestamp: Date.now(),
                estimatedProfitUSD: 50,
                tradeSizeUSD: 10000,
                buyChain: { chainId: 56, dex: 'pancake', priceUSD: 0.999, blockNumber: 1 },
                sellChain: { chainId: 1, dex: 'uni', priceUSD: 1.004, blockNumber: 1 },
            };

            await coordinator.executeDualChain(opp);

            expect(coordinator.stats.dualChainAttempted).toBeGreaterThan(0);

            coordinator.resetStats();

            expect(coordinator.stats.dualChainAttempted).toBe(0);
            expect(coordinator.stats.totalProfitUSD).toBe(0);
        });
    });

    describe('cleanup', () => {
        test('should clear all chains', () => {
            coordinator.registerChain(56, mockExecutionManager, {});
            coordinator.registerChain(1, mockExecutionManager, {});

            coordinator.cleanup();

            expect(coordinator.chains.size).toBe(0);
        });

        test('should clear all bridges', () => {
            coordinator.registerBridge(56, 1, {});

            coordinator.cleanup();

            expect(coordinator.bridges.size).toBe(0);
        });

        test('should clear pending executions', () => {
            coordinator.pendingExecutions.set('test', {});

            coordinator.cleanup();

            expect(coordinator.pendingExecutions.size).toBe(0);
        });

        test('should remove event listeners', () => {
            coordinator.on('executionComplete', () => {});

            coordinator.cleanup();

            expect(coordinator.listenerCount('executionComplete')).toBe(0);
        });
    });

    describe('_generateExecutionId', () => {
        test('should generate unique IDs', () => {
            const id1 = coordinator._generateExecutionId();
            const id2 = coordinator._generateExecutionId();

            expect(id1).not.toBe(id2);
        });

        test('should start with xc_ prefix', () => {
            const id = coordinator._generateExecutionId();
            expect(id.startsWith('xc_')).toBe(true);
        });
    });

    describe('_calculateTotalProfit', () => {
        test('should sum profits from all phases', () => {
            const state = {
                sourceChainResult: { profitUSD: 10 },
                destChainResult: { profitUSD: 15 },
                bridgeResult: { costUSD: 3 },
            };

            const profit = coordinator._calculateTotalProfit(state);
            expect(profit).toBe(22); // 10 + 15 - 3
        });

        test('should handle missing results', () => {
            const state = {
                sourceChainResult: { profitUSD: 10 },
                destChainResult: null,
                bridgeResult: null,
            };

            const profit = coordinator._calculateTotalProfit(state);
            expect(profit).toBe(10);
        });

        test('should not return negative profit', () => {
            const state = {
                sourceChainResult: { profitUSD: 5 },
                bridgeResult: { costUSD: 10 },
            };

            const profit = coordinator._calculateTotalProfit(state);
            expect(profit).toBe(0);
        });
    });
});
