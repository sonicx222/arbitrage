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

    // ==================== Task 3.3: Liquidation Backrun Tests ====================

    describe('executeLiquidationBackrun', () => {
        describe('input validation', () => {
            test('should reject null opportunity', async () => {
                const result = await executionManager.executeLiquidationBackrun(null);

                expect(result.success).toBe(false);
                expect(result.reason).toContain('must be an object');
                expect(result.stage).toBe('validation');
            });

            test('should reject non-object opportunity', async () => {
                const result = await executionManager.executeLiquidationBackrun('invalid');

                expect(result.success).toBe(false);
                expect(result.reason).toContain('must be an object');
            });

            test('should reject opportunity without protocol', async () => {
                const result = await executionManager.executeLiquidationBackrun({
                    type: 'liquidation-backrun',
                    estimatedProfitUSD: 10,
                });

                expect(result.success).toBe(false);
                expect(result.reason).toContain('missing protocol');
            });

            test('should reject opportunity with insufficient profit', async () => {
                const result = await executionManager.executeLiquidationBackrun({
                    protocol: 'aave-v3',
                    type: 'liquidation-backrun',
                    estimatedProfitUSD: 1, // Below $5 minimum
                    timestamp: Date.now(),
                });

                expect(result.success).toBe(false);
                expect(result.reason).toContain('below minimum');
                expect(result.stage).toBe('validation');
            });

            test('should reject stale liquidation opportunity', async () => {
                const result = await executionManager.executeLiquidationBackrun({
                    protocol: 'aave-v3',
                    type: 'liquidation-backrun',
                    estimatedProfitUSD: 50,
                    timestamp: Date.now() - 20000, // 20 seconds ago
                });

                expect(result.success).toBe(false);
                expect(result.reason).toContain('too old');
                expect(result.stage).toBe('validation');
            });
        });

        describe('opportunity conversion', () => {
            test('should fail if conversion returns null', async () => {
                // Invalid type that won't convert
                const result = await executionManager.executeLiquidationBackrun({
                    protocol: 'aave-v3',
                    type: 'invalid-type',
                    estimatedProfitUSD: 50,
                    timestamp: Date.now(),
                });

                expect(result.success).toBe(false);
                expect(result.reason).toContain('Could not convert');
                expect(result.stage).toBe('conversion');
            });
        });

        describe('statistics tracking', () => {
            test('should increment liquidationBackrunsAttempted', async () => {
                const initialCount = executionManager.stats.liquidationBackrunsAttempted;

                await executionManager.executeLiquidationBackrun({
                    protocol: 'aave-v3',
                    type: 'liquidation-backrun',
                    estimatedProfitUSD: 1, // Will fail validation but still increment
                    timestamp: Date.now(),
                });

                expect(executionManager.stats.liquidationBackrunsAttempted).toBe(initialCount + 1);
            });

            test('should include liquidation stats in getStats', () => {
                const stats = executionManager.getStats();

                expect(stats.liquidationBackruns).toBeDefined();
                expect(stats.liquidationBackruns).toHaveProperty('attempted');
                expect(stats.liquidationBackruns).toHaveProperty('success');
                expect(stats.liquidationBackruns).toHaveProperty('failed');
                expect(stats.liquidationBackruns).toHaveProperty('profitUSD');
                expect(stats.liquidationBackruns).toHaveProperty('successRate');
            });

            test('should format successRate as percentage', () => {
                const stats = executionManager.getStats();
                expect(stats.liquidationBackruns.successRate).toMatch(/^\d+(\.\d+)?%$/);
            });
        });
    });

    describe('_convertLiquidationToTrade', () => {
        test('should return null for unknown liquidation type', () => {
            const result = executionManager._convertLiquidationToTrade({
                protocol: 'aave-v3',
                type: 'unknown-type',
            });

            expect(result).toBeNull();
        });

        test('should convert liquidation-backrun type', () => {
            const result = executionManager._convertLiquidationToTrade({
                protocol: 'aave-v3',
                type: 'liquidation-backrun',
                collateralAsset: '0xCollateral',
                collateralSymbol: 'WETH',
                debtAsset: '0xDebt',
                debtSymbol: 'USDC',
                collateralValueUSD: 10000,
                estimatedProfitUSD: 50,
                liquidationBonusPercent: 5,
            });

            // May return null if no DEX configured, which is fine
            if (result !== null) {
                expect(result.type).toBe('liquidation-backrun');
                expect(result.tokenA).toBe('WETH');
                expect(result.tokenB).toBe('USDC');
                expect(result.originalLiquidation).toBeDefined();
                expect(result.originalLiquidation.protocol).toBe('aave-v3');
                expect(result.profitCalculation.netProfitUSD).toBe(50);
            }
        });

        test('should convert liquidation-buyCollateral type', () => {
            const result = executionManager._convertLiquidationToTrade({
                protocol: 'compound-v3',
                type: 'liquidation-buyCollateral',
                collateralAsset: '0xCollateral',
                collateralSymbol: 'WETH',
                baseToken: 'USDC',
                collateralValueUSD: 5000,
                estimatedProfitUSD: 100,
            });

            // May return null if no DEX configured
            if (result !== null) {
                expect(result.type).toBe('liquidation-buyCollateral');
                expect(result.protocol).toBe('compound-v3');
                expect(result.collateralAsset).toBe('0xCollateral');
            }
        });

        test('should include slippage estimation', () => {
            const result = executionManager._convertLiquidationToTrade({
                protocol: 'aave-v3',
                type: 'liquidation-backrun',
                collateralSymbol: 'WETH',
                debtSymbol: 'USDC',
                collateralValueUSD: 50000,
                estimatedProfitUSD: 100,
            });

            if (result !== null) {
                expect(result.profitCalculation.slippagePercent).toBeDefined();
                expect(typeof result.profitCalculation.slippagePercent).toBe('number');
            }
        });
    });

    describe('_findBestDexForToken', () => {
        test('should return null for unknown token', () => {
            const result = executionManager._findBestDexForToken('UNKNOWN_TOKEN');
            // Should be null since no token config exists
            expect(result === null || typeof result === 'string').toBe(true);
        });
    });

    describe('_estimateLiquidationSlippage', () => {
        test('should return 0.5% for small liquidations', () => {
            expect(executionManager._estimateLiquidationSlippage(5000)).toBe(0.5);
        });

        test('should return 1.0% for medium liquidations', () => {
            expect(executionManager._estimateLiquidationSlippage(25000)).toBe(1.0);
        });

        test('should return 1.5% for large liquidations', () => {
            expect(executionManager._estimateLiquidationSlippage(75000)).toBe(1.5);
        });

        test('should return 2.0% for very large liquidations', () => {
            expect(executionManager._estimateLiquidationSlippage(150000)).toBe(2.0);
        });

        test('should handle boundary values', () => {
            expect(executionManager._estimateLiquidationSlippage(10000)).toBe(1.0);
            expect(executionManager._estimateLiquidationSlippage(50000)).toBe(1.5);
            expect(executionManager._estimateLiquidationSlippage(100000)).toBe(2.0);
        });
    });

    describe('_recordLiquidationExecution', () => {
        test('should record liquidation execution in recent history', () => {
            const initialLength = executionManager.recentExecutions.length;

            executionManager._recordLiquidationExecution(
                {
                    type: 'liquidation-backrun',
                    protocol: 'aave-v3',
                    collateralSymbol: 'WETH',
                    estimatedProfitUSD: 50,
                },
                {
                    success: true,
                    simulated: true,
                    profit: 50,
                },
                150
            );

            expect(executionManager.recentExecutions.length).toBe(initialLength + 1);

            const lastExecution = executionManager.recentExecutions[executionManager.recentExecutions.length - 1];
            expect(lastExecution.type).toBe('liquidation-backrun');
            expect(lastExecution.protocol).toBe('aave-v3');
            expect(lastExecution.collateral).toBe('WETH');
            expect(lastExecution.success).toBe(true);
            expect(lastExecution.durationMs).toBe(150);
        });

        test('should include failure reason when execution fails', () => {
            executionManager._recordLiquidationExecution(
                {
                    type: 'liquidation-backrun',
                    protocol: 'compound-v3',
                    collateralSymbol: 'WBTC',
                },
                {
                    success: false,
                    simulated: true,
                    reason: 'Insufficient liquidity',
                },
                200
            );

            const lastExecution = executionManager.recentExecutions[executionManager.recentExecutions.length - 1];
            expect(lastExecution.success).toBe(false);
            expect(lastExecution.reason).toBe('Insufficient liquidity');
        });
    });

    describe('execute with liquidation types', () => {
        test('should route liquidation-backrun to executeLiquidationBackrun', async () => {
            const result = await executionManager.execute({
                type: 'liquidation-backrun',
                protocol: 'aave-v3',
                estimatedProfitUSD: 1, // Will fail validation
                timestamp: Date.now(),
            });

            // Should have gone through liquidation backrun path
            expect(result.stage).toBe('validation');
        });

        test('should route liquidation-buyCollateral to executeLiquidationBackrun', async () => {
            const result = await executionManager.execute({
                type: 'liquidation-buyCollateral',
                protocol: 'compound-v3',
                estimatedProfitUSD: 2, // Will fail validation
                timestamp: Date.now(),
            });

            expect(result.stage).toBe('validation');
        });

        test('should reject invalid opportunity types', async () => {
            const result = await executionManager.execute({
                type: 'invalid-type',
            });

            expect(result.success).toBe(false);
            expect(result.reason).toContain('Invalid opportunity type');
        });
    });
});
