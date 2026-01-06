/**
 * Jest Test Setup
 *
 * This file runs before all tests to configure the test environment.
 */

// Set NODE_ENV to test to suppress console logging
process.env.NODE_ENV = 'test';

// Suppress unhandled rejection warnings in tests (they are expected in some test cases)
process.on('unhandledRejection', () => {});
