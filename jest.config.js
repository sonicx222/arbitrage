/** @type {import('jest').Config} */
export default {
    // Use ES modules
    transform: {},

    // Test environment
    testEnvironment: 'node',

    // Set NODE_ENV to test to suppress console output
    setupFiles: ['<rootDir>/tests/setup.js'],

    // Test file patterns
    testMatch: [
        '**/tests/**/*.test.js',
    ],

    // Ignore patterns
    testPathIgnorePatterns: [
        '/node_modules/',
    ],

    // Module file extensions
    moduleFileExtensions: ['js', 'json', 'node'],

    // Verbose output
    verbose: false,

    // Force exit after tests complete (handles async cleanup issues)
    forceExit: true,

    // Detect open handles (useful for debugging, but slow)
    // detectOpenHandles: true,

    // Silence console during tests (optional - uncomment to suppress all console output)
    // silent: true,

    // Coverage configuration (optional)
    collectCoverageFrom: [
        'src/**/*.js',
        '!src/index.js', // Exclude main entry point
    ],

    // Timeout for async tests
    testTimeout: 10000,

    // Clear mocks between tests
    clearMocks: true,

    // Restore mocks after each test
    restoreMocks: true,
};
