import { jest } from '@jest/globals';

// Define mocks BEFORE any imports
jest.unstable_mockModule('ethers', () => {
    const mockEthers = {
        JsonRpcProvider: jest.fn().mockImplementation(() => ({
            destroy: jest.fn().mockResolvedValue(),
            getFeeData: jest.fn().mockResolvedValue({ gasPrice: 5000000000n }),
        })),
        WebSocketProvider: jest.fn().mockImplementation(() => ({
            _websocket: { on: jest.fn() },
            on: jest.fn(),
            destroy: jest.fn().mockResolvedValue(),
            getFeeData: jest.fn().mockResolvedValue({ gasPrice: 5000000000n }),
        })),
        Contract: jest.fn(),
        Interface: jest.fn(),
        ZeroAddress: '0x0000000000000000000000000000000000000000',
        parseUnits: jest.fn((val, unit) => BigInt(val) * (unit === 'gwei' ? 1000000000n : 1n)),
        formatUnits: jest.fn((val) => val.toString()),
    };
    return {
        ethers: mockEthers,
        parseUnits: mockEthers.parseUnits,
        formatUnits: mockEthers.formatUnits,
        ZeroAddress: mockEthers.ZeroAddress,
        Contract: mockEthers.Contract,
        Interface: mockEthers.Interface,
    };
});

// Dynamic imports for modules under test
const { default: ArbitrageBot } = await import('../../src/index.js');
const { default: priceFetcher } = await import('../../src/data/priceFetcher.js');
const { default: blockMonitor } = await import('../../src/monitoring/blockMonitor.js');
const { default: alertManager } = await import('../../src/alerts/alertManager.js');
const { default: cacheManager } = await import('../../src/data/cacheManager.js');
const { default: rpcManager } = await import('../../src/utils/rpcManager.js');
const { default: performanceTracker } = await import('../../src/monitoring/performanceTracker.js');

describe('ArbitrageBot Integration Flow', () => {
    let bot;
    let blockHandler;

    beforeEach(async () => {
        // Clear all mocks
        jest.clearAllMocks();

        // Check if blockMonitor.on is mocked, if not mock it manually (since it's a singleton already imported)
        // Note: rpcManager initialization happened on import, but with MOCKED ethers, so no real connection.

        // Mock specific behavior for the test
        jest.spyOn(blockMonitor, 'on').mockImplementation((event, handler) => {
            if (event === 'newBlock') {
                blockHandler = handler;
            }
        });
        jest.spyOn(blockMonitor, 'start').mockResolvedValue();
        jest.spyOn(blockMonitor, 'stop').mockResolvedValue();

        jest.spyOn(rpcManager, 'getStats').mockReturnValue({});
        jest.spyOn(rpcManager, 'cleanup').mockResolvedValue();

        jest.spyOn(performanceTracker, 'recordBlockProcessing');
        jest.spyOn(performanceTracker, 'cleanup');
        jest.spyOn(performanceTracker, 'getMetrics').mockReturnValue({});

        jest.spyOn(cacheManager, 'invalidateOlderThan');
        jest.spyOn(cacheManager, 'getStats').mockReturnValue({});

        jest.spyOn(alertManager, 'notify').mockResolvedValue();

        // Mock price fetcher
        jest.spyOn(priceFetcher, 'fetchAllPrices').mockResolvedValue({});

        bot = new ArbitrageBot();
    });

    afterEach(async () => {
        if (bot) {
            await bot.stop();
        }
    });

    test('should start and subscribe to block events', async () => {
        await bot.start();
        expect(blockMonitor.start).toHaveBeenCalled();
        expect(blockMonitor.on).toHaveBeenCalledWith('newBlock', expect.any(Function));
        // We can't easily check bot.isRunning if it's internal, but checking calls is good enough
    });

    test('should detect profitable opportunity and alert', async () => {
        await bot.start();

        // Mock prices with arbitrage opportunity
        // Mock prices with arbitrage opportunity
        priceFetcher.fetchAllPrices.mockResolvedValue({
            'WBNB/BUSD': {
                'pancakeswap': {
                    price: 300,
                    reserveA: '1000000000000000000', // 1 WBNB
                    reserveB: '300000000000000000000', // 300 BUSD
                    liquidityUSD: 200000,
                    pairAddress: '0x123',
                    dexName: 'pancakeswap',
                    timestamp: Date.now()
                },
                'biswap': {
                    price: 310,
                    reserveA: '1000000000000000000',
                    reserveB: '310000000000000000000', // 310 BUSD
                    liquidityUSD: 200000,
                    pairAddress: '0x456',
                    dexName: 'biswap',
                    timestamp: Date.now()
                }
            }
        });

        // Simulate new block
        const blockData = { blockNumber: 12345678, timestamp: Date.now() };

        // trigger the handler captured in beforeEach
        if (blockHandler) {
            await blockHandler(blockData);
        } else {
            throw new Error('Block handler not captured');
        }

        expect(priceFetcher.fetchAllPrices).toHaveBeenCalledWith(12345678);
        expect(alertManager.notify).toHaveBeenCalledTimes(1);

        const opportunity = alertManager.notify.mock.calls[0][0];
        expect(opportunity.pairKey).toBe('WBNB/BUSD');
        expect(opportunity.buyDex).toBe('pancakeswap');
        expect(opportunity.sellDex).toBe('biswap');
    });

    test('should NOT alert when no profitable opportunity exists', async () => {
        await bot.start();

        priceFetcher.fetchAllPrices.mockResolvedValue({
            'WBNB/BUSD': {
                'pancakeswap': {
                    price: 300,
                    reserveA: '1000000000000000000',
                    reserveB: '300000000000000000000',
                    liquidityUSD: 200000,
                    dexName: 'pancakeswap'
                },
                'biswap': {
                    price: 300.1,
                    reserveA: '1000000000000000000',
                    reserveB: '300100000000000000000',
                    liquidityUSD: 200000,
                    dexName: 'biswap'
                }
            }
        });

        if (blockHandler) {
            await blockHandler({ blockNumber: 12345679 });
        }

        expect(alertManager.notify).not.toHaveBeenCalled();
    });

    test('should handle errors during block processing gracefully', async () => {
        // Prevent console logs during expected error
        jest.spyOn(console, 'log').mockImplementation(() => { });
        jest.spyOn(console, 'error').mockImplementation(() => { });

        await bot.start();

        priceFetcher.fetchAllPrices.mockRejectedValue(new Error('RPC Error'));

        if (blockHandler) {
            await blockHandler({ blockNumber: 12345680 });
        }

        // It should complete without throwing out of the test
        expect(priceFetcher.fetchAllPrices).toHaveBeenCalled();
    });

    test('should skip block processing if previous block is still processing', async () => {
        await bot.start();

        // Mock a slow price fetch
        let resolvePriceFetch;
        const priceFetchPromise = new Promise(resolve => {
            resolvePriceFetch = resolve;
        });

        priceFetcher.fetchAllPrices.mockReturnValue(priceFetchPromise);

        // 1. Process Block A (will hang on fetchAllPrices)
        const blockA = { blockNumber: 100, timestamp: Date.now() };
        const processA = blockHandler(blockA); // This is async but blocked internally

        // 2. Try to process Block B immediately while A is "running"
        const blockB = { blockNumber: 101, timestamp: Date.now() };
        await blockHandler(blockB); // This should return immediately because 'processingBlock' flag is true

        // Resolve Block A
        resolvePriceFetch({});
        await processA;

        // Expect priceFetcher to be called ONLY ONCE (for Block A)
        // because Block B should have been skipped
        expect(priceFetcher.fetchAllPrices).toHaveBeenCalledTimes(1);
        expect(priceFetcher.fetchAllPrices).toHaveBeenCalledWith(100);
    });

    test('should handle multiple opportunities in a single block', async () => {
        await bot.start();

        priceFetcher.fetchAllPrices.mockResolvedValue({
            // Opportunity 1
            'WBNB/BUSD': {
                'pancakeswap': {
                    price: 300,
                    reserveA: '1000000000000000000',
                    reserveB: '300000000000000000000',
                    liquidityUSD: 200000,
                    pairAddress: '0x1',
                    dexName: 'pancakeswap',
                    timestamp: Date.now()
                },
                'biswap': {
                    price: 310,
                    reserveA: '1000000000000000000',
                    reserveB: '310000000000000000000',
                    liquidityUSD: 200000,
                    pairAddress: '0x2',
                    dexName: 'biswap',
                    timestamp: Date.now()
                }
            },
            // Opportunity 2
            'ETH/USDT': {
                'pancakeswap': {
                    price: 2000,
                    reserveA: '1000000000000000000',
                    reserveB: '2000000000000000000000',
                    liquidityUSD: 500000,
                    pairAddress: '0x3',
                    dexName: 'pancakeswap',
                    timestamp: Date.now()
                },
                'biswap': {
                    price: 2050,
                    reserveA: '1000000000000000000',
                    reserveB: '2050000000000000000000',
                    liquidityUSD: 500000,
                    pairAddress: '0x4',
                    dexName: 'biswap',
                    timestamp: Date.now()
                }
            }
        });

        if (blockHandler) {
            await blockHandler({ blockNumber: 200 });
        }

        expect(alertManager.notify).toHaveBeenCalledTimes(2);

        // Verify both pairs were alerted
        const calls = alertManager.notify.mock.calls;
        const pairs = calls.map(call => call[0].pairKey);
        expect(pairs).toContain('WBNB/BUSD');
        expect(pairs).toContain('ETH/USDT');
    });
});
