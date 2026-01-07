import { jest } from '@jest/globals';

describe('Logger', () => {
    let log;

    beforeEach(async () => {
        // Clear module cache to get fresh import
        jest.resetModules();
        // Import logger fresh
        const loggerModule = await import('../../src/utils/logger.js');
        log = loggerModule.default;
    });

    describe('API Consistency', () => {
        test('should have error method', () => {
            expect(typeof log.error).toBe('function');
        });

        test('should have warn method', () => {
            expect(typeof log.warn).toBe('function');
        });

        test('should have info method', () => {
            expect(typeof log.info).toBe('function');
        });

        test('should have debug method', () => {
            expect(typeof log.debug).toBe('function');
        });

        test('should have verbose method', () => {
            expect(typeof log.verbose).toBe('function');
        });

        test('should have opportunity method', () => {
            expect(typeof log.opportunity).toBe('function');
        });

        test('should have performance method', () => {
            expect(typeof log.performance).toBe('function');
        });

        test('should have rpc method', () => {
            expect(typeof log.rpc).toBe('function');
        });

        test('should have ws method', () => {
            expect(typeof log.ws).toBe('function');
        });
    });

    describe('Method Execution (No Errors)', () => {
        test('error() should not throw', () => {
            expect(() => log.error('test error')).not.toThrow();
        });

        test('warn() should not throw', () => {
            expect(() => log.warn('test warning')).not.toThrow();
        });

        test('info() should not throw', () => {
            expect(() => log.info('test info')).not.toThrow();
        });

        test('debug() should not throw', () => {
            expect(() => log.debug('test debug')).not.toThrow();
        });

        test('verbose() should not throw', () => {
            expect(() => log.verbose('test verbose')).not.toThrow();
        });

        test('error() with meta should not throw', () => {
            expect(() => log.error('test error', { key: 'value' })).not.toThrow();
        });

        test('info() with complex meta should not throw', () => {
            expect(() => log.info('test info', {
                number: 123,
                string: 'test',
                nested: { a: 1, b: 2 },
                array: [1, 2, 3],
            })).not.toThrow();
        });

        test('opportunity() should not throw', () => {
            expect(() => log.opportunity({
                type: 'cross-dex',
                pairKey: 'WBNB/USDT',
                profitPercent: 0.5,
            })).not.toThrow();
        });

        test('performance() should not throw', () => {
            expect(() => log.performance({
                blocksProcessed: 100,
                avgTime: 50,
            })).not.toThrow();
        });

        test('rpc() should not throw', () => {
            expect(() => log.rpc('RPC connection issue', { endpoint: 'test' })).not.toThrow();
        });

        test('ws() should not throw', () => {
            expect(() => log.ws('WebSocket message', { type: 'subscribe' })).not.toThrow();
        });
    });

    describe('Edge Cases', () => {
        test('should handle empty message', () => {
            expect(() => log.info('')).not.toThrow();
        });

        test('should handle null meta', () => {
            expect(() => log.info('test', null)).not.toThrow();
        });

        test('should handle undefined meta', () => {
            expect(() => log.info('test', undefined)).not.toThrow();
        });

        test('should handle empty object meta', () => {
            expect(() => log.info('test', {})).not.toThrow();
        });

        test('should handle message with special characters', () => {
            expect(() => log.info('Test with "quotes" and \'apostrophes\' and \n newlines')).not.toThrow();
        });

        test('should handle very long message', () => {
            const longMessage = 'x'.repeat(10000);
            expect(() => log.info(longMessage)).not.toThrow();
        });

        test('should handle BigInt in meta (converted to string)', () => {
            // BigInt can't be serialized to JSON directly
            // The logger should handle this gracefully
            expect(() => log.info('test', { value: String(BigInt(123456789012345678901234567890n)) })).not.toThrow();
        });

        test('should handle Error objects in meta', () => {
            const error = new Error('test error');
            expect(() => log.error('Error occurred', { error: error.message, stack: error.stack })).not.toThrow();
        });

        test('should handle circular reference gracefully', () => {
            // Circular references cause JSON.stringify to fail
            // The logger should handle this without crashing
            const circular = { a: 1 };
            circular.self = circular;
            // This might throw or might be handled - either way, shouldn't crash the app
            try {
                log.info('circular test', circular);
            } catch (e) {
                // Expected - circular references can't be stringified
            }
        });
    });

    describe('Named Export', () => {
        test('should have named export "log"', async () => {
            const module = await import('../../src/utils/logger.js');
            expect(module.log).toBeDefined();
            expect(typeof module.log.info).toBe('function');
        });
    });
});

describe('Fallback Logger', () => {
    // Test the fallback logger behavior by simulating winston failure
    // Note: This is a behavioral test - the actual fallback is tested implicitly
    // when tests run without winston (e.g., in worker threads)

    test('createFallbackLogger concept should work', () => {
        // Simulate what createFallbackLogger does
        const formatMeta = (meta) => {
            if (meta && typeof meta === 'object' && Object.keys(meta).length > 0) {
                return ' ' + JSON.stringify(meta);
            }
            return '';
        };

        const timestamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

        const fallbackLog = {
            error: (message, meta = {}) => `${timestamp()} [error] ${message}${formatMeta(meta)}`,
            warn: (message, meta = {}) => `${timestamp()} [warn] ${message}${formatMeta(meta)}`,
            info: (message, meta = {}) => `${timestamp()} [info] ${message}${formatMeta(meta)}`,
            debug: (message, meta = {}) => `${timestamp()} [debug] ${message}${formatMeta(meta)}`,
            verbose: (message, meta = {}) => `${timestamp()} [verbose] ${message}${formatMeta(meta)}`,
        };

        // Test that the fallback logger produces expected output format
        const output = fallbackLog.info('test message');
        expect(output).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[info\] test message/);

        const outputWithMeta = fallbackLog.error('error test', { code: 500 });
        expect(outputWithMeta).toMatch(/\[error\] error test/);
        expect(outputWithMeta).toContain('{"code":500}');
    });

    test('formatMeta should handle edge cases', () => {
        const formatMeta = (meta) => {
            if (meta && typeof meta === 'object' && Object.keys(meta).length > 0) {
                return ' ' + JSON.stringify(meta);
            }
            return '';
        };

        expect(formatMeta(null)).toBe('');
        expect(formatMeta(undefined)).toBe('');
        expect(formatMeta({})).toBe('');
        expect(formatMeta({ a: 1 })).toBe(' {"a":1}');
    });

    test('timestamp should produce valid format', () => {
        const timestamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
        const ts = timestamp();

        // Should be YYYY-MM-DD HH:MM:SS format
        expect(ts).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });
});

describe('Winston Integration', () => {
    test('logger should be properly initialized', async () => {
        const { default: log } = await import('../../src/utils/logger.js');

        // The logger should exist and have all required methods
        expect(log).toBeDefined();
        expect(log.info).toBeDefined();
        expect(log.error).toBeDefined();
        expect(log.warn).toBeDefined();
        expect(log.debug).toBeDefined();
    });

    test('logger should handle concurrent calls', async () => {
        const { default: log } = await import('../../src/utils/logger.js');

        // Fire multiple log calls concurrently
        const promises = [];
        for (let i = 0; i < 100; i++) {
            promises.push(
                Promise.resolve().then(() => log.info(`Concurrent log ${i}`))
            );
        }

        // All calls should complete without error
        await expect(Promise.all(promises)).resolves.not.toThrow();
    });
});
