import { jest } from '@jest/globals';
import { ethers } from 'ethers';

// We need to use dynamic import for the config because it might rely on dotenv which is loaded at runtime
const { default: config } = await import('../../src/config.js');

describe('Configuration Validation', () => {

    describe('Token Addresses', () => {
        const tokens = config.tokens;

        // Iterate over each token to create a test case
        for (const [symbol, data] of Object.entries(tokens)) {
            test(`should have valid checksum address for ${symbol}`, () => {
                const address = data.address;

                // ethers.getAddress throws if address is invalid or has bad checksum
                // It returns the checksummed address if valid
                expect(() => {
                    const checksummed = ethers.getAddress(address);
                    // Also strictly check that the config address matches the checksummed version
                    // This enforces best practice of storing checksummed addresses
                    expect(address).toBe(checksummed);
                }).not.toThrow();
            });

            test(`should have valid decimals for ${symbol}`, () => {
                expect(Number.isInteger(data.decimals)).toBe(true);
                expect(data.decimals).toBeGreaterThanOrEqual(0);
                expect(data.decimals).toBeLessThanOrEqual(18); // Typical max
            });
        }
    });

    describe('DEX Addresses', () => {
        const dexes = config.dex;

        for (const [name, data] of Object.entries(dexes)) {
            if (data.router) {
                test(`should have valid router address for ${name}`, () => {
                    expect(() => {
                        const checksummed = ethers.getAddress(data.router);
                        expect(data.router).toBe(checksummed);
                    }).not.toThrow();
                });
            }

            if (data.factory) {
                test(`should have valid factory address for ${name}`, () => {
                    expect(() => {
                        const checksummed = ethers.getAddress(data.factory);
                        expect(data.factory).toBe(checksummed);
                    }).not.toThrow();
                });
            }
        }
    });

    describe('Environment & Logic', () => {
        test('should have essential trading parameters', () => {
            expect(config.trading.minProfitPercentage).toBeDefined();
            expect(config.trading.gasPriceGwei).toBeGreaterThan(0);
        });

        test('debugMode should be false by default when DEBUG_MODE env is not set (Bug Fix Regression)', () => {
            // The fix changed: `debugMode: process.env.DEBUG_MODE === 'false'` (wrong)
            // To: `debugMode: process.env.DEBUG_MODE === 'true'` (correct)
            // Without DEBUG_MODE env set, debugMode should be false (not true)
            // This test ensures the logic isn't inverted
            expect(typeof config.debugMode).toBe('boolean');

            // If DEBUG_MODE is not explicitly 'true', debugMode should be false
            if (process.env.DEBUG_MODE !== 'true') {
                expect(config.debugMode).toBe(false);
            }
        });

        test('dynamicGas should be boolean', () => {
            expect(typeof config.dynamicGas).toBe('boolean');
        });
    });

    describe('Execution Configuration', () => {
        test('should have flash loan fee configured', () => {
            expect(config.execution).toHaveProperty('flashLoanFee');
            expect(config.execution.flashLoanFee).toBe(0.0025); // 0.25%
        });
    });
});
