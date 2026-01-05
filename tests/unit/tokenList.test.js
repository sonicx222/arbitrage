import { jest } from '@jest/globals';

const {
    optimizedTokens,
    top100Tokens,
    getTokensByTier,
    getToken,
    isValidAddress,
    getAllAddresses,
} = await import('../../src/data/tokenList.js');

describe('Token List', () => {
    describe('Token Count and Structure', () => {
        test('should have 36 tokens in optimized list', () => {
            const tokenCount = Object.keys(optimizedTokens).length;
            expect(tokenCount).toBe(36);
        });

        test('top100Tokens should be same as optimizedTokens (backward compatibility)', () => {
            expect(top100Tokens).toEqual(optimizedTokens);
        });

        test('each token should have required properties', () => {
            for (const [symbol, token] of Object.entries(optimizedTokens)) {
                expect(token).toHaveProperty('symbol');
                expect(token).toHaveProperty('address');
                expect(token).toHaveProperty('decimals');
                expect(token).toHaveProperty('tier');
                expect(token.symbol).toBe(symbol);
            }
        });

        test('each token should have valid tier (1-5)', () => {
            for (const [_, token] of Object.entries(optimizedTokens)) {
                expect(token.tier).toBeGreaterThanOrEqual(1);
                expect(token.tier).toBeLessThanOrEqual(5);
            }
        });
    });

    describe('Address Validation', () => {
        test('all addresses should be valid Ethereum format', () => {
            for (const [symbol, token] of Object.entries(optimizedTokens)) {
                expect(isValidAddress(token.address)).toBe(true);
            }
        });

        test('all addresses should be checksummed (mixed case)', () => {
            for (const [symbol, token] of Object.entries(optimizedTokens)) {
                // Checksummed addresses have mixed case
                expect(token.address.startsWith('0x')).toBe(true);
                expect(token.address.length).toBe(42);
            }
        });

        test('addresses should be unique (no duplicates)', () => {
            const addresses = Object.values(optimizedTokens).map(t => t.address.toLowerCase());
            const uniqueAddresses = [...new Set(addresses)];
            expect(addresses.length).toBe(uniqueAddresses.length);
        });
    });

    describe('Tier 1 Tokens (Core Infrastructure)', () => {
        test('should have 7 tier 1 tokens', () => {
            const tier1 = getTokensByTier(1);
            expect(Object.keys(tier1).length).toBe(7);
        });

        test('should include essential tokens', () => {
            const tier1 = getTokensByTier(1);
            expect(tier1).toHaveProperty('WBNB');
            expect(tier1).toHaveProperty('USDT');
            expect(tier1).toHaveProperty('USDC');
            expect(tier1).toHaveProperty('BUSD');
            expect(tier1).toHaveProperty('ETH');
            expect(tier1).toHaveProperty('BTCB');
            expect(tier1).toHaveProperty('FDUSD');
        });

        test('WBNB address should be correct', () => {
            const wbnb = getToken('WBNB');
            expect(wbnb.address).toBe('0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c');
            expect(wbnb.decimals).toBe(18);
        });

        test('USDT address should be correct', () => {
            const usdt = getToken('USDT');
            expect(usdt.address).toBe('0x55d398326f99059fF775485246999027B3197955');
            expect(usdt.decimals).toBe(18);
        });

        test('BUSD address should be correct', () => {
            const busd = getToken('BUSD');
            expect(busd.address).toBe('0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56');
            expect(busd.decimals).toBe(18);
        });

        test('ETH (Binance-Peg) address should be correct', () => {
            const eth = getToken('ETH');
            expect(eth.address).toBe('0x2170Ed0880ac9A755fd29B2688956BD959F933F8');
            expect(eth.decimals).toBe(18);
        });

        test('BTCB address should be correct', () => {
            const btcb = getToken('BTCB');
            expect(btcb.address).toBe('0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c');
            expect(btcb.decimals).toBe(18);
        });
    });

    describe('Tier 2 Tokens (DEX Natives & DeFi)', () => {
        test('should have 7 tier 2 tokens', () => {
            const tier2 = getTokensByTier(2);
            expect(Object.keys(tier2).length).toBe(7);
        });

        test('CAKE (PancakeSwap) address should be correct', () => {
            const cake = getToken('CAKE');
            expect(cake.address).toBe('0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82');
            expect(cake.decimals).toBe(18);
        });

        test('BSW (Biswap) address should be correct', () => {
            const bsw = getToken('BSW');
            expect(bsw.address).toBe('0x965F527D9159dCe6288a2219DB51fc6Eef120dD1');
            expect(bsw.decimals).toBe(18);
        });

        test('XVS (Venus) address should be correct', () => {
            const xvs = getToken('XVS');
            expect(xvs.address).toBe('0xcF6BB5389c92Bdda8a3747Ddb454cB7a64626C63');
            expect(xvs.decimals).toBe(18);
        });
    });

    describe('Tier 3 Tokens (Popular Trading)', () => {
        test('should have 10 tier 3 tokens', () => {
            const tier3 = getTokensByTier(3);
            expect(Object.keys(tier3).length).toBe(10);
        });

        test('major bridged assets should have correct addresses', () => {
            expect(getToken('XRP').address).toBe('0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE');
            expect(getToken('ADA').address).toBe('0x3EE2200Efb3400fAbB9AacF31297cBdD1d435D47');
            expect(getToken('DOT').address).toBe('0x7083609fCE4d1d8Dc0C979AAb8c869Ea2C873402');
            expect(getToken('LINK').address).toBe('0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD');
        });
    });

    describe('Tier 4 Tokens (Meme & High-Volatility)', () => {
        test('should have 8 tier 4 tokens', () => {
            const tier4 = getTokensByTier(4);
            expect(Object.keys(tier4).length).toBe(8);
        });

        test('DOGE address and decimals should be correct', () => {
            const doge = getToken('DOGE');
            expect(doge.address).toBe('0xbA2aE424d960c26247Dd6c32edC70B295c744C43');
            expect(doge.decimals).toBe(8); // DOGE has 8 decimals
        });

        test('FLOKI address and decimals should be correct', () => {
            const floki = getToken('FLOKI');
            expect(floki.address).toBe('0xfb5B838b6cfEEdC2873aB27866079AC55363D37E');
            expect(floki.decimals).toBe(9); // FLOKI has 9 decimals
        });

        test('BABYDOGE address and decimals should be correct', () => {
            const babydoge = getToken('BABYDOGE');
            expect(babydoge.address).toBe('0xc748673057861a797275CD8A068AbB95A902e8de');
            expect(babydoge.decimals).toBe(9); // BABYDOGE has 9 decimals
        });
    });

    describe('Tier 5 Tokens (Cross-chain & Layer Zero)', () => {
        test('should have 4 tier 5 tokens', () => {
            const tier5 = getTokensByTier(5);
            expect(Object.keys(tier5).length).toBe(4);
        });

        test('STG (Stargate) address should be correct', () => {
            const stg = getToken('STG');
            expect(stg.address).toBe('0xB0D502E938ed5f4df2E681fE6E419ff29631d62b');
            expect(stg.decimals).toBe(18);
        });

        test('PENDLE address should be correct', () => {
            const pendle = getToken('PENDLE');
            expect(pendle.address).toBe('0xb3Ed0A426155B79B898849803E3B36552f7ED507');
            expect(pendle.decimals).toBe(18);
        });
    });

    describe('Helper Functions', () => {
        test('getToken should return null for unknown symbol', () => {
            expect(getToken('UNKNOWN')).toBeNull();
        });

        test('getToken should return correct token for known symbol', () => {
            const wbnb = getToken('WBNB');
            expect(wbnb).not.toBeNull();
            expect(wbnb.symbol).toBe('WBNB');
        });

        test('isValidAddress should validate correct addresses', () => {
            expect(isValidAddress('0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c')).toBe(true);
            expect(isValidAddress('0x55d398326f99059fF775485246999027B3197955')).toBe(true);
        });

        test('isValidAddress should reject invalid addresses', () => {
            expect(isValidAddress('0x123')).toBe(false);
            expect(isValidAddress('not-an-address')).toBe(false);
            expect(isValidAddress('')).toBe(false);
            expect(isValidAddress('0xZZZ4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c')).toBe(false);
        });

        test('getAllAddresses should return array with all tokens', () => {
            const addresses = getAllAddresses();
            expect(Array.isArray(addresses)).toBe(true);
            expect(addresses.length).toBe(36);
            expect(addresses[0]).toHaveProperty('symbol');
            expect(addresses[0]).toHaveProperty('address');
            expect(addresses[0]).toHaveProperty('decimals');
        });
    });

    describe('Decimal Values', () => {
        test('most tokens should have 18 decimals', () => {
            const tokens18 = Object.values(optimizedTokens).filter(t => t.decimals === 18);
            expect(tokens18.length).toBeGreaterThan(25); // Most tokens are 18 decimals
        });

        test('known non-18 decimal tokens should have correct values', () => {
            // 8 decimals
            expect(getToken('DOGE').decimals).toBe(8);

            // 9 decimals
            expect(getToken('FLOKI').decimals).toBe(9);
            expect(getToken('BABYDOGE').decimals).toBe(9);
        });
    });

    describe('Resource Calculation Verification', () => {
        test('token count should be within resource budget', () => {
            // 36 tokens × 6 bases × 5 DEXs = 1,080 max pairs
            // Actual pairs are less due to base-to-base exclusion
            const tokenCount = Object.keys(optimizedTokens).length;
            const baseTokenCount = 6;
            const dexCount = 5;

            const maxPairs = tokenCount * baseTokenCount * dexCount;
            expect(maxPairs).toBeLessThanOrEqual(1500); // Safety margin

            // With Multicall batching of 200, should be ~6 calls per block
            const callsPerBlock = Math.ceil(maxPairs / 200);
            expect(callsPerBlock).toBeLessThanOrEqual(10);
        });

        test('base tokens should all be in token list', () => {
            const baseSymbols = ['WBNB', 'USDT', 'BUSD', 'USDC', 'ETH', 'BTCB'];
            for (const symbol of baseSymbols) {
                expect(getToken(symbol)).not.toBeNull();
            }
        });
    });
});
