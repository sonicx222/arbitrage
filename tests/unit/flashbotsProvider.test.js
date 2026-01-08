import { jest } from '@jest/globals';
import { ethers } from 'ethers';

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
    default: {
        flashbots: {
            authKey: null,
        },
    }
}));

// Mock global fetch
global.fetch = jest.fn();

const { default: flashbotsProvider } = await import('../../src/execution/flashbotsProvider.js');

describe('FlashbotsProvider', () => {
    // Mock signer
    const mockPrivateKey = '0x' + '1'.repeat(64);
    let mockSigner;
    let mockProvider;

    beforeAll(() => {
        mockProvider = {
            getBlockNumber: jest.fn().mockResolvedValue(18000000),
            getNetwork: jest.fn().mockResolvedValue({ chainId: 1n }),
            _isProvider: true,
        };
        // Create wallet and connect to mock provider
        const wallet = new ethers.Wallet(mockPrivateKey);
        // Use Object.defineProperty to add provider since ethers v6 has it read-only
        mockSigner = {
            ...wallet,
            provider: mockProvider,
            signTransaction: wallet.signTransaction.bind(wallet),
            signMessage: wallet.signMessage.bind(wallet),
            getAddress: wallet.getAddress.bind(wallet),
        };
    });

    beforeEach(() => {
        jest.clearAllMocks();
        flashbotsProvider.initialized = false;
        flashbotsProvider.resetStats();
        flashbotsProvider.pendingBundles.clear();
    });

    describe('constructor', () => {
        test('should initialize with correct default values', () => {
            expect(flashbotsProvider.initialized).toBe(false);
            expect(flashbotsProvider.relayEndpoints[1]).toBe('https://relay.flashbots.net');
            expect(flashbotsProvider.config.maxRetries).toBe(3);
            expect(flashbotsProvider.config.simulationEnabled).toBe(true);
        });

        test('should have relay endpoints for supported chains', () => {
            expect(flashbotsProvider.relayEndpoints[1]).toBeDefined(); // Mainnet
            expect(flashbotsProvider.relayEndpoints[11155111]).toBeDefined(); // Sepolia
        });

        test('should have alternative relays for mainnet', () => {
            expect(flashbotsProvider.alternativeRelays[1]).toBeDefined();
            expect(flashbotsProvider.alternativeRelays[1].length).toBeGreaterThan(0);
        });
    });

    describe('initialize', () => {
        test('should initialize for Ethereum mainnet', async () => {
            const result = await flashbotsProvider.initialize(mockSigner, 1);

            expect(result).toBe(true);
            expect(flashbotsProvider.initialized).toBe(true);
            expect(flashbotsProvider.chainId).toBe(1);
            expect(flashbotsProvider.relayUrl).toBe('https://relay.flashbots.net');
        });

        test('should return false for unsupported chains', async () => {
            const result = await flashbotsProvider.initialize(mockSigner, 56); // BSC

            expect(result).toBe(false);
            expect(flashbotsProvider.initialized).toBe(false);
        });

        test('should initialize for Sepolia testnet', async () => {
            const result = await flashbotsProvider.initialize(mockSigner, 11155111);

            expect(result).toBe(true);
            expect(flashbotsProvider.relayUrl).toBe('https://relay-sepolia.flashbots.net');
        });

        test('should use custom auth key if provided', async () => {
            const customAuthKey = '0x' + '2'.repeat(64);
            await flashbotsProvider.initialize(mockSigner, 1, { authKey: customAuthKey });

            expect(flashbotsProvider.authSigner).toBeDefined();
            const authAddress = await flashbotsProvider.authSigner.getAddress();
            expect(authAddress).not.toBe(await mockSigner.getAddress());
        });

        test('should apply configuration overrides', async () => {
            await flashbotsProvider.initialize(mockSigner, 1, {
                maxRetries: 5,
                simulationEnabled: false,
                useAlternativeRelays: false,
            });

            expect(flashbotsProvider.config.maxRetries).toBe(5);
            expect(flashbotsProvider.config.simulationEnabled).toBe(false);
            expect(flashbotsProvider.config.useAlternativeRelays).toBe(false);
        });
    });

    describe('isAvailable', () => {
        test('should return false when not initialized', () => {
            expect(flashbotsProvider.isAvailable()).toBe(false);
        });

        test('should return true for Ethereum mainnet when initialized', async () => {
            await flashbotsProvider.initialize(mockSigner, 1);
            expect(flashbotsProvider.isAvailable()).toBe(true);
        });

        test('should return false for non-mainnet even when initialized', async () => {
            await flashbotsProvider.initialize(mockSigner, 11155111);
            expect(flashbotsProvider.isAvailable()).toBe(false); // Only mainnet returns true
        });
    });

    describe('createBundle', () => {
        beforeEach(async () => {
            await flashbotsProvider.initialize(mockSigner, 1);
        });

        test('should create bundle from signed transactions', async () => {
            const signedTxs = ['0x1234567890abcdef', '0xfedcba0987654321'];
            const targetBlock = 18000001;

            const bundle = await flashbotsProvider.createBundle(signedTxs, targetBlock);

            expect(bundle.signedTransactions).toHaveLength(2);
            expect(bundle.targetBlock).toBe(targetBlock);
            expect(bundle.blockNumber).toBe('0x112a881');
            expect(bundle.bundleHash).toBeDefined();
            expect(bundle.createdAt).toBeDefined();
        });

        test('should increment bundlesCreated stat', async () => {
            const initialCount = flashbotsProvider.stats.bundlesCreated;

            await flashbotsProvider.createBundle(['0xabc'], 18000001);

            expect(flashbotsProvider.stats.bundlesCreated).toBe(initialCount + 1);
        });

        test('should throw if not initialized', async () => {
            flashbotsProvider.initialized = false;

            await expect(flashbotsProvider.createBundle(['0xabc'], 18000001))
                .rejects.toThrow('FlashbotsProvider not initialized');
        });

        test('should throw if no valid transactions', async () => {
            await expect(flashbotsProvider.createBundle([], 18000001))
                .rejects.toThrow('No valid transactions for bundle');
        });

        test('should include optional time bounds', async () => {
            const bundle = await flashbotsProvider.createBundle(
                ['0xabc'],
                18000001,
                { minTimestamp: 1700000000, maxTimestamp: 1700001000 }
            );

            expect(bundle.minTimestamp).toBe(1700000000);
            expect(bundle.maxTimestamp).toBe(1700001000);
        });
    });

    describe('simulateBundle', () => {
        beforeEach(async () => {
            await flashbotsProvider.initialize(mockSigner, 1);
        });

        test('should return success on successful simulation', async () => {
            global.fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    result: {
                        results: [{ gasUsed: '0x5208' }],
                        bundleGasPrice: '0x3b9aca00',
                        coinbaseDiff: '0x100',
                    },
                }),
            });

            const bundle = await flashbotsProvider.createBundle(['0xabc'], 18000001);
            const result = await flashbotsProvider.simulateBundle(bundle);

            expect(result.success).toBe(true);
            expect(result.totalGasUsed).toBeDefined();
            expect(flashbotsProvider.stats.simulationsPassed).toBe(1);
        });

        test('should return failure on revert', async () => {
            global.fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    result: {
                        results: [{ error: 'execution reverted' }],
                    },
                }),
            });

            const bundle = await flashbotsProvider.createBundle(['0xabc'], 18000001);
            const result = await flashbotsProvider.simulateBundle(bundle);

            expect(result.success).toBe(false);
            expect(result.error).toContain('reverted');
            expect(flashbotsProvider.stats.simulationsFailed).toBe(1);
        });

        test('should handle relay errors', async () => {
            global.fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    error: { message: 'Rate limited', code: -32005 },
                }),
            });

            const bundle = await flashbotsProvider.createBundle(['0xabc'], 18000001);
            const result = await flashbotsProvider.simulateBundle(bundle);

            expect(result.success).toBe(false);
            expect(result.error).toContain('Rate limited');
        });

        test('should throw if not initialized', async () => {
            flashbotsProvider.initialized = false;

            await expect(flashbotsProvider.simulateBundle({}))
                .rejects.toThrow('FlashbotsProvider not initialized');
        });
    });

    describe('submitBundle', () => {
        beforeEach(async () => {
            await flashbotsProvider.initialize(mockSigner, 1);
            flashbotsProvider.config.simulationEnabled = false; // Skip simulation for these tests
        });

        test('should submit bundle successfully', async () => {
            global.fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    result: { bundleHash: '0xbundlehash123' },
                }),
            });

            const bundle = await flashbotsProvider.createBundle(['0xabc'], 18000001);
            const result = await flashbotsProvider.submitBundle(bundle);

            expect(result.success).toBe(true);
            expect(result.submitted).toBe(true);
            expect(flashbotsProvider.stats.bundlesSubmitted).toBe(1);
        });

        test('should track pending bundles', async () => {
            global.fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ result: {} }),
            });

            const bundle = await flashbotsProvider.createBundle(['0xabc'], 18000001);
            await flashbotsProvider.submitBundle(bundle);

            expect(flashbotsProvider.pendingBundles.size).toBe(1);
        });

        test('should skip submission on simulation failure when enabled', async () => {
            flashbotsProvider.config.simulationEnabled = true;

            global.fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    result: { results: [{ error: 'revert' }] },
                }),
            });

            const bundle = await flashbotsProvider.createBundle(['0xabc'], 18000001);
            const result = await flashbotsProvider.submitBundle(bundle);

            expect(result.success).toBe(false);
            expect(result.submitted).toBe(false);
            expect(result.reason).toContain('Simulation failed');
        });

        test('should handle relay rejection', async () => {
            global.fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    error: { message: 'Bundle rejected' },
                }),
            });

            const bundle = await flashbotsProvider.createBundle(['0xabc'], 18000001);
            const result = await flashbotsProvider.submitBundle(bundle);

            expect(result.success).toBe(false);
            expect(result.submitted).toBe(true);
            expect(flashbotsProvider.stats.bundlesFailed).toBe(1);
        });
    });

    describe('submitToMultipleBuilders', () => {
        beforeEach(async () => {
            await flashbotsProvider.initialize(mockSigner, 1);
            flashbotsProvider.config.simulationEnabled = false;
            flashbotsProvider.config.useAlternativeRelays = true; // Ensure multi-relay is enabled
        });

        test('should submit to multiple relays', async () => {
            global.fetch.mockResolvedValue({
                ok: true,
                json: async () => ({ result: {} }),
            });

            const bundle = await flashbotsProvider.createBundle(['0xabc'], 18000001);
            const result = await flashbotsProvider.submitToMultipleBuilders(bundle);

            expect(result.success).toBe(true);
            expect(result.successCount).toBeGreaterThan(0);
            expect(result.totalRelays).toBeGreaterThan(1);
            expect(result.results).toBeDefined();
        });

        test('should report partial success', async () => {
            let callCount = 0;
            global.fetch.mockImplementation(async () => {
                callCount++;
                if (callCount === 1) {
                    return { ok: true, json: async () => ({ result: {} }) };
                }
                return { ok: true, json: async () => ({ error: { message: 'Failed' } }) };
            });

            const bundle = await flashbotsProvider.createBundle(['0xabc'], 18000001);
            const result = await flashbotsProvider.submitToMultipleBuilders(bundle);

            expect(result.success).toBe(true);
            expect(result.successCount).toBeGreaterThan(0);
            expect(result.results).toBeDefined();
        });

        test('should fallback to single relay when useAlternativeRelays is false', async () => {
            flashbotsProvider.config.useAlternativeRelays = false;

            global.fetch.mockResolvedValue({
                ok: true,
                json: async () => ({ result: {} }),
            });

            const bundle = await flashbotsProvider.createBundle(['0xabc'], 18000001);
            const result = await flashbotsProvider.submitToMultipleBuilders(bundle);

            // When useAlternativeRelays is false, it falls back to submitBundle
            expect(result.success).toBe(true);
            expect(result.submitted).toBe(true);
        });
    });

    describe('checkBundleInclusion', () => {
        beforeEach(async () => {
            await flashbotsProvider.initialize(mockSigner, 1);
        });

        test('should return included status when bundle is included', async () => {
            global.fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    result: {
                        isSimulated: true,
                        isSentToMiners: true,
                        isHighPriority: true,
                    },
                }),
            });

            const result = await flashbotsProvider.checkBundleInclusion('0xbundlehash', 18000001);

            expect(result.included).toBe(true);
            expect(result.status).toBe('included');
        });

        test('should return pending status when not yet included', async () => {
            global.fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    result: {
                        isSimulated: true,
                        isSentToMiners: true,
                        isHighPriority: false,
                    },
                }),
            });

            const result = await flashbotsProvider.checkBundleInclusion('0xbundlehash', 18000001);

            expect(result.included).toBe(false);
            expect(result.status).toBe('sent_to_builders');
        });

        test('should handle check errors gracefully', async () => {
            global.fetch.mockRejectedValueOnce(new Error('Network error'));

            const result = await flashbotsProvider.checkBundleInclusion('0xbundlehash', 18000001);

            expect(result.included).toBe(false);
            expect(result.status).toBe('error');
        });
    });

    describe('cancelBundle', () => {
        beforeEach(async () => {
            await flashbotsProvider.initialize(mockSigner, 1);
        });

        test('should remove bundle from pending tracking', async () => {
            flashbotsProvider.pendingBundles.set('0xhash', { bundle: {}, timestamp: Date.now() });

            const removed = flashbotsProvider.cancelBundle('0xhash');

            expect(removed).toBe(true);
            expect(flashbotsProvider.pendingBundles.size).toBe(0);
        });

        test('should return false for non-existent bundle', () => {
            const removed = flashbotsProvider.cancelBundle('0xnonexistent');

            expect(removed).toBe(false);
        });
    });

    describe('getUserStats', () => {
        beforeEach(async () => {
            await flashbotsProvider.initialize(mockSigner, 1);
        });

        test('should fetch user stats from relay', async () => {
            global.fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    result: {
                        is_high_priority: true,
                        all_time_miner_payments: '1000000000000000000',
                    },
                }),
            });

            const result = await flashbotsProvider.getUserStats();

            expect(result.success).toBe(true);
            expect(result.is_high_priority).toBe(true);
        });

        test('should handle errors', async () => {
            global.fetch.mockRejectedValueOnce(new Error('Network error'));

            const result = await flashbotsProvider.getUserStats();

            expect(result.success).toBe(false);
            expect(result.error).toBeDefined();
        });
    });

    describe('sendPrivateTransaction', () => {
        beforeEach(async () => {
            await flashbotsProvider.initialize(mockSigner, 1);
        });

        test('should send private transaction', async () => {
            global.fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    result: '0xtxhash123',
                }),
            });

            const result = await flashbotsProvider.sendPrivateTransaction('0xsignedtx');

            expect(result.success).toBe(true);
            expect(result.txHash).toBe('0xtxhash123');
        });

        test('should use custom maxBlockNumber', async () => {
            global.fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ result: '0xhash' }),
            });

            const result = await flashbotsProvider.sendPrivateTransaction('0xsignedtx', {
                maxBlockNumber: 18000100,
            });

            expect(result.maxBlockNumber).toBe(18000100);
        });

        test('should handle submission failure', async () => {
            global.fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    error: { message: 'Transaction invalid' },
                }),
            });

            const result = await flashbotsProvider.sendPrivateTransaction('0xsignedtx');

            expect(result.success).toBe(false);
            expect(result.reason).toContain('invalid');
        });
    });

    describe('_prepareTransactions', () => {
        beforeEach(async () => {
            await flashbotsProvider.initialize(mockSigner, 1);
        });

        test('should handle hex string transactions', async () => {
            const txs = ['0xabc', '0xdef'];
            const prepared = await flashbotsProvider._prepareTransactions(txs);

            expect(prepared).toHaveLength(2);
            expect(prepared[0]).toBe('0xabc');
        });

        test('should handle transaction objects with serialized field', async () => {
            const txs = [{ serialized: '0xserialized' }];
            const prepared = await flashbotsProvider._prepareTransactions(txs);

            expect(prepared).toHaveLength(1);
            expect(prepared[0]).toBe('0xserialized');
        });
    });

    describe('_calculateBundleHash', () => {
        test('should generate consistent hash for same input', () => {
            const txs = ['0xabc', '0xdef'];
            const block = 18000001;

            const hash1 = flashbotsProvider._calculateBundleHash(txs, block);
            const hash2 = flashbotsProvider._calculateBundleHash(txs, block);

            expect(hash1).toBe(hash2);
        });

        test('should generate different hash for different input', () => {
            const txs1 = ['0xabc'];
            const txs2 = ['0xdef'];

            const hash1 = flashbotsProvider._calculateBundleHash(txs1, 18000001);
            const hash2 = flashbotsProvider._calculateBundleHash(txs2, 18000001);

            expect(hash1).not.toBe(hash2);
        });
    });

    describe('_trackPendingBundle', () => {
        test('should enforce size limit', () => {
            flashbotsProvider.maxPendingBundles = 3;

            for (let i = 0; i < 5; i++) {
                flashbotsProvider._trackPendingBundle({
                    bundleHash: `0xhash${i}`,
                    targetBlock: 18000000 + i,
                });
            }

            expect(flashbotsProvider.pendingBundles.size).toBe(3);
        });
    });

    describe('_interpretBundleStats', () => {
        test('should return correct status strings', () => {
            expect(flashbotsProvider._interpretBundleStats({ isHighPriority: true })).toBe('included');
            expect(flashbotsProvider._interpretBundleStats({ isSimulated: true, isSentToMiners: true })).toBe('sent_to_builders');
            expect(flashbotsProvider._interpretBundleStats({ isSimulated: true })).toBe('simulated');
            expect(flashbotsProvider._interpretBundleStats({})).toBe('pending');
            expect(flashbotsProvider._interpretBundleStats(null)).toBe('unknown');
        });
    });

    describe('getStats', () => {
        test('should return comprehensive statistics', () => {
            const stats = flashbotsProvider.getStats();

            expect(stats.initialized).toBeDefined();
            expect(stats.bundles).toBeDefined();
            expect(stats.bundles.created).toBeDefined();
            expect(stats.bundles.submitted).toBeDefined();
            expect(stats.bundles.inclusionRate).toBeDefined();
            expect(stats.simulations).toBeDefined();
            expect(stats.simulations.passRate).toBeDefined();
        });

        test('should calculate inclusion rate correctly', async () => {
            await flashbotsProvider.initialize(mockSigner, 1);
            flashbotsProvider.stats.bundlesSubmitted = 10;
            flashbotsProvider.stats.bundlesIncluded = 8;

            const stats = flashbotsProvider.getStats();

            expect(stats.bundles.inclusionRate).toBe('80.0%');
        });

        test('should handle zero submissions', () => {
            const stats = flashbotsProvider.getStats();

            expect(stats.bundles.inclusionRate).toBe('0%');
            expect(stats.simulations.passRate).toBe('0%');
        });
    });

    describe('resetStats', () => {
        test('should reset all statistics', () => {
            flashbotsProvider.stats.bundlesCreated = 100;
            flashbotsProvider.stats.simulationsRun = 50;

            flashbotsProvider.resetStats();

            expect(flashbotsProvider.stats.bundlesCreated).toBe(0);
            expect(flashbotsProvider.stats.simulationsRun).toBe(0);
        });
    });

    describe('cleanup', () => {
        test('should clear pending bundles and reset state', async () => {
            await flashbotsProvider.initialize(mockSigner, 1);
            flashbotsProvider.pendingBundles.set('0xhash', {});

            flashbotsProvider.cleanup();

            expect(flashbotsProvider.initialized).toBe(false);
            expect(flashbotsProvider.pendingBundles.size).toBe(0);
        });
    });

    describe('relay authentication', () => {
        beforeEach(async () => {
            await flashbotsProvider.initialize(mockSigner, 1);
        });

        test('should sign payload for authentication', async () => {
            const signature = await flashbotsProvider._signPayload('{"test": "payload"}');

            expect(signature).toBeDefined();
            expect(typeof signature).toBe('string');
            expect(signature.startsWith('0x')).toBe(true);
        });
    });

    describe('error handling', () => {
        test('should handle network errors in _sendToRelay', async () => {
            await flashbotsProvider.initialize(mockSigner, 1);

            global.fetch.mockResolvedValueOnce({
                ok: false,
                status: 503,
                statusText: 'Service Unavailable',
            });

            // simulateBundle catches errors and returns a result object
            const result = await flashbotsProvider.simulateBundle({ signedTransactions: ['0x'], blockNumber: '0x1' });

            expect(result.success).toBe(false);
            expect(result.error).toContain('Relay error');
        });

        test('should throw in _sendToRelay directly', async () => {
            await flashbotsProvider.initialize(mockSigner, 1);

            global.fetch.mockResolvedValueOnce({
                ok: false,
                status: 503,
                statusText: 'Service Unavailable',
            });

            await expect(flashbotsProvider._sendToRelay({ method: 'test' }))
                .rejects.toThrow('Relay error');
        });
    });
});
