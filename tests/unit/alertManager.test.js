import { jest } from '@jest/globals';

// Mock dependencies
const mockAxios = {
    post: jest.fn().mockResolvedValue({}),
};

jest.unstable_mockModule('axios', () => ({
    default: mockAxios
}));

// Mock config
const mockConfig = {
    alerts: {
        console: true,
        discord: true,
        telegram: true,
        cooldownMs: 60000,
        webhooks: {
            discord: 'http://discord.webhook',
            telegram: { botToken: 'token', chatId: '123' }
        }
    },
    logging: {
        directory: './logs',
        level: 'info'
    }
};

jest.unstable_mockModule('../../src/config.js', () => ({
    default: mockConfig
}));

// Import after mocking
const { default: alertManager } = await import('../../src/alerts/alertManager.js');

describe('AlertManager', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        alertManager.lastAlertTime.clear();
        alertManager.enabledChannels = {
            console: true,
            discord: true,
            telegram: true
        };
    });

    const mockOpp = {
        pairKey: 'WBNB/BUSD',
        tokenA: 'WBNB',
        tokenB: 'BUSD',
        buyDex: 'pancakeswap',
        sellDex: 'biswap',
        buyPrice: 300,
        sellPrice: 310,
        netProfitPercentage: 1.5,
        totalFeePercentage: 0.5,
        minLiquidity: 10000,
        timestamp: Date.now()
    };

    describe('Cooldown Logic', () => {
        test('should allow alert if not on cooldown', async () => {
            const spy = jest.spyOn(alertManager, 'sendConsoleAlert').mockImplementation(() => { });

            await alertManager.notify(mockOpp);

            expect(spy).toHaveBeenCalled();
            expect(alertManager.lastAlertTime.has(mockOpp.pairKey)).toBe(true);
        });

        test('should block alert if on cooldown', async () => {
            alertManager.lastAlertTime.set(mockOpp.pairKey, Date.now()); // Set cooldown

            const spy = jest.spyOn(alertManager, 'sendConsoleAlert');

            await alertManager.notify(mockOpp);

            expect(spy).not.toHaveBeenCalled();
        });

        test('should expire cooldown after time passes', async () => {
            const pastTime = Date.now() - 61000; // > 60s ago
            alertManager.lastAlertTime.set(mockOpp.pairKey, pastTime);

            const spy = jest.spyOn(alertManager, 'sendConsoleAlert').mockImplementation(() => { });

            await alertManager.notify(mockOpp);

            expect(spy).toHaveBeenCalled();
        });
    });

    describe('Channel Dispatch', () => {
        test('should send to all enabled channels', async () => {
            const consoleSpy = jest.spyOn(alertManager, 'sendConsoleAlert').mockImplementation(() => { });

            await alertManager.notify(mockOpp);

            expect(consoleSpy).toHaveBeenCalled();
            expect(mockAxios.post).toHaveBeenCalledTimes(2); // Discord + Telegram
        });

        test('should respect disabled channels', async () => {
            alertManager.enabledChannels.discord = false;
            alertManager.enabledChannels.telegram = false;

            const consoleSpy = jest.spyOn(alertManager, 'sendConsoleAlert').mockImplementation(() => { });

            await alertManager.notify(mockOpp);

            expect(consoleSpy).toHaveBeenCalled();
            expect(mockAxios.post).not.toHaveBeenCalled();
        });
    });
});
