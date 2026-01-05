import { jest } from '@jest/globals';
import { parseUnits } from 'ethers';

// Mock dependencies
jest.unstable_mockModule('../../src/utils/logger.js', () => ({
    default: {
        info: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
    }
}));

jest.unstable_mockModule('../../src/utils/rpcManager.js', () => ({
    default: {
        withRetry: jest.fn(),
        getGasPrice: jest.fn().mockResolvedValue(parseUnits('5', 'gwei')),
        getHttpProvider: jest.fn().mockReturnValue({
            provider: {
                call: jest.fn().mockResolvedValue('0x'),
            },
        }),
    }
}));

jest.unstable_mockModule('../../src/data/cacheManager.js', () => ({
    default: {
        currentBlockNumber: 12345,
        getPairAddress: jest.fn().mockReturnValue('0x0eD7e52944161450477ee417DE9Cd3a859b14fD0'),
        setPairAddress: jest.fn(),
    }
}));

jest.unstable_mockModule('../../src/execution/transactionBuilder.js', () => ({
    default: {
        contractAddress: '0x1234567890123456789012345678901234567890',
        setContractAddress: jest.fn(),
        build: jest.fn().mockReturnValue({
            to: '0x1234567890123456789012345678901234567890',
            data: '0xabcdef',
            gasLimit: 400000n,
        }),
    }
}));

const { default: executionManager } = await import('../../src/execution/executionManager.js');
const { default: rpcManager } = await import('../../src/utils/rpcManager.js');
const { default: transactionBuilder } = await import('../../src/execution/transactionBuilder.js');

describe('ExecutionManager', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('initialization', () => {
        test('should initialize with simulation mode by default', () => {
            expect(executionManager.mode).toBe('simulation');
        });

        test('should track execution statistics', () => {
            const stats = executionManager.getStats();

            expect(stats).toHaveProperty('mode');
            expect(stats).toHaveProperty('simulations');
            expect(stats).toHaveProperty('executions');
            expect(stats).toHaveProperty('totalProfitUSD');
        });
    });

    describe('validateOpportunity', () => {
        test('should reject opportunities with insufficient profit', async () => {
            const lowProfitOpp = {
                type: 'cross-dex',
                profitCalculation: {
                    netProfitUSD: 0.5, // Below $1 minimum
                },
                blockNumber: 12345,
            };

            const result = await executionManager.validateOpportunity(lowProfitOpp);

            expect(result.valid).toBe(false);
            expect(result.reason).toContain('below minimum');
        });

        test('should reject stale opportunities (>2 blocks old)', async () => {
            const staleOpp = {
                type: 'cross-dex',
                profitCalculation: {
                    netProfitUSD: 10,
                },
                blockNumber: 12340, // 5 blocks behind
            };

            const result = await executionManager.validateOpportunity(staleOpp);

            expect(result.valid).toBe(false);
            expect(result.reason).toContain('too old');
        });

        test('should accept valid opportunities', async () => {
            const validOpp = {
                type: 'cross-dex',
                profitCalculation: {
                    netProfitUSD: 5,
                },
                blockNumber: 12345,
            };

            const result = await executionManager.validateOpportunity(validOpp);

            // With mocked contract address, valid opportunity should pass
            expect(result.valid).toBe(true);
        });
    });

    describe('simulate', () => {
        test('should call eth_call and return success on valid tx', async () => {
            const mockTx = {
                to: '0x1234567890123456789012345678901234567890',
                data: '0xabcdef',
                gasLimit: 400000n,
            };

            const mockOpportunity = {
                type: 'cross-dex',
                profitCalculation: {
                    netProfitUSD: 5,
                },
            };

            // Mock successful call
            rpcManager.withRetry.mockResolvedValueOnce('0x0000000000000000000000000000000000000000000000000000000000000001');

            const result = await executionManager.simulate(mockTx, mockOpportunity);

            expect(result.success).toBe(true);
            expect(result.simulated).toBe(true);
            expect(result).toHaveProperty('estimatedProfit');
        });

        test('should return failure on revert', async () => {
            const mockTx = {
                to: '0x1234567890123456789012345678901234567890',
                data: '0xabcdef',
                gasLimit: 400000n,
            };

            const mockOpportunity = {
                type: 'cross-dex',
            };

            // Mock revert
            rpcManager.withRetry.mockRejectedValueOnce(new Error('execution reverted: InsufficientProfit'));

            const result = await executionManager.simulate(mockTx, mockOpportunity);

            expect(result.success).toBe(false);
            expect(result.simulated).toBe(true);
            expect(result.reason).toContain('InsufficientProfit');
        });

        test('should increment simulation statistics', async () => {
            const initialStats = executionManager.getStats();
            const initialTotal = initialStats.simulations.total;

            const mockTx = {
                to: '0x1234567890123456789012345678901234567890',
                data: '0xabcdef',
                gasLimit: 400000n,
            };

            rpcManager.withRetry.mockResolvedValueOnce('0x01');

            await executionManager.simulate(mockTx, { type: 'cross-dex' });

            const newStats = executionManager.getStats();
            expect(newStats.simulations.total).toBe(initialTotal + 1);
        });
    });

    describe('getStats', () => {
        test('should return comprehensive statistics', () => {
            const stats = executionManager.getStats();

            expect(stats.mode).toBe('simulation');
            expect(stats.simulations).toHaveProperty('total');
            expect(stats.simulations).toHaveProperty('success');
            expect(stats.simulations).toHaveProperty('failed');
            expect(stats.simulations).toHaveProperty('successRate');
            expect(stats.executions).toHaveProperty('total');
            expect(typeof stats.totalProfitUSD).toBe('string');
        });

        test('should calculate success rate correctly', () => {
            // After some simulations, check success rate format
            const stats = executionManager.getStats();
            expect(stats.simulations.successRate).toMatch(/^\d+(\.\d+)?%$/);
        });
    });

    describe('getRecentExecutions', () => {
        test('should return recent execution history', () => {
            const recent = executionManager.getRecentExecutions(5);

            expect(Array.isArray(recent)).toBe(true);
            expect(recent.length).toBeLessThanOrEqual(5);
        });

        test('should limit results by parameter', () => {
            const recent = executionManager.getRecentExecutions(2);
            expect(recent.length).toBeLessThanOrEqual(2);
        });
    });

    describe('setMode', () => {
        test('should change execution mode', () => {
            const originalMode = executionManager.mode;

            executionManager.setMode('live');
            expect(executionManager.mode).toBe('live');

            executionManager.setMode('simulation');
            expect(executionManager.mode).toBe('simulation');

            // Restore original
            executionManager.setMode(originalMode);
        });

        test('should reject invalid modes', () => {
            expect(() => executionManager.setMode('invalid')).toThrow('Invalid mode');
        });
    });

    describe('concurrent execution prevention', () => {
        test('should prevent concurrent executions', async () => {
            // Force isExecuting state
            executionManager.isExecuting = true;

            const result = await executionManager.execute({
                type: 'cross-dex',
                profitCalculation: { netProfitUSD: 10 },
            });

            expect(result.success).toBe(false);
            expect(result.reason).toContain('Another execution in progress');

            // Reset state
            executionManager.isExecuting = false;
        });
    });
});
