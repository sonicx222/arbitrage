/**
 * Regression tests for chainWorker Error serialization fix.
 *
 * Bug: When the chain emitted an 'error' event with an Error object,
 * the Error's properties (message, stack) were non-enumerable and got
 * lost when serialized through postMessage, resulting in empty {} objects.
 *
 * Fix: chainWorker now extracts Error properties before sending messages.
 */
describe('ChainWorker Error Serialization', () => {
    describe('Error object handling', () => {
        /**
         * Helper to simulate the error serialization logic from chainWorker.js
         */
        const serializeErrorData = (data, chainId) => {
            const errorData = data instanceof Error
                ? {
                    chainId: chainId,
                    error: data.message,
                    stack: data.stack,
                    code: data.code,
                }
                : {
                    chainId: chainId,
                    ...data,
                    error: data?.error instanceof Error ? data.error.message : (data?.error || data?.message),
                    stack: data?.error instanceof Error ? data.error.stack : data?.stack,
                };
            return errorData;
        };

        it('should correctly serialize Error objects', () => {
            const error = new Error('Test error message');
            error.code = 'TEST_CODE';

            const serialized = serializeErrorData(error, 56);

            expect(serialized.chainId).toBe(56);
            expect(serialized.error).toBe('Test error message');
            expect(serialized.stack).toContain('Error: Test error message');
            expect(serialized.code).toBe('TEST_CODE');
        });

        it('should preserve plain object data', () => {
            const data = {
                error: 'Plain error string',
                extra: 'additional data',
            };

            const serialized = serializeErrorData(data, 56);

            expect(serialized.chainId).toBe(56);
            expect(serialized.error).toBe('Plain error string');
            expect(serialized.extra).toBe('additional data');
        });

        it('should extract nested Error from data.error property', () => {
            const nestedError = new Error('Nested error');
            const data = {
                error: nestedError,
                context: 'some context',
            };

            const serialized = serializeErrorData(data, 56);

            expect(serialized.chainId).toBe(56);
            expect(serialized.error).toBe('Nested error');
            expect(serialized.stack).toContain('Error: Nested error');
            expect(serialized.context).toBe('some context');
        });

        it('should handle undefined error data gracefully', () => {
            const serialized = serializeErrorData(undefined, 56);

            expect(serialized.chainId).toBe(56);
            expect(serialized.error).toBeUndefined();
        });

        it('should handle null error data gracefully', () => {
            const serialized = serializeErrorData(null, 56);

            expect(serialized.chainId).toBe(56);
            expect(serialized.error).toBeUndefined();
        });

        it('should handle data with message property as fallback', () => {
            const data = {
                message: 'Fallback message',
            };

            const serialized = serializeErrorData(data, 56);

            expect(serialized.chainId).toBe(56);
            expect(serialized.error).toBe('Fallback message');
        });

        it('should demonstrate the serialization bug fix', () => {
            // Create an Error and simulate postMessage serialization
            const error = new Error('WebSocket disconnected');

            // Before fix: Error properties are non-enumerable
            const jsonSerialized = JSON.parse(JSON.stringify(error));
            expect(jsonSerialized).toEqual({}); // Bug: Empty object!

            // After fix: Using our serialization helper
            const serialized = serializeErrorData(error, 56);
            expect(serialized.error).toBe('WebSocket disconnected');
            expect(serialized.stack).toBeDefined();
        });
    });

    describe('postMessage simulation', () => {
        it('should survive structured clone algorithm (simulated via JSON)', () => {
            const serializeErrorData = (data, chainId) => {
                const errorData = data instanceof Error
                    ? {
                        chainId: chainId,
                        error: data.message,
                        stack: data.stack,
                        code: data.code,
                    }
                    : {
                        chainId: chainId,
                        ...data,
                        error: data?.error instanceof Error ? data.error.message : (data?.error || data?.message),
                        stack: data?.error instanceof Error ? data.error.stack : data?.stack,
                    };
                return errorData;
            };

            // Original error
            const error = new Error('Connection timeout');
            error.code = 'ETIMEDOUT';

            // Serialize with our fix
            const serialized = serializeErrorData(error, 56);

            // Simulate postMessage structured clone (JSON roundtrip approximation)
            const transmitted = JSON.parse(JSON.stringify(serialized));

            // Should preserve all critical information
            expect(transmitted.chainId).toBe(56);
            expect(transmitted.error).toBe('Connection timeout');
            expect(transmitted.code).toBe('ETIMEDOUT');
            expect(transmitted.stack).toContain('Connection timeout');
        });
    });
});
