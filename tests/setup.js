/**
 * Jest Test Setup
 *
 * This file runs before all tests to configure the test environment.
 */

// Set NODE_ENV to test to suppress console logging
process.env.NODE_ENV = 'test';

// Suppress unhandled rejection warnings in tests (they are expected in some test cases)
process.on('unhandledRejection', () => {});

// Track all timers so we can clean them up
const activeTimers = new Set();

// Store original setInterval so we can track and unref all timers
const originalSetInterval = global.setInterval;
global.setInterval = function(...args) {
    const timer = originalSetInterval.apply(this, args);
    // Unref the timer so it doesn't prevent the process from exiting
    if (timer && typeof timer.unref === 'function') {
        timer.unref();
    }
    activeTimers.add(timer);
    return timer;
};

// Store original clearInterval to track timer removal
const originalClearInterval = global.clearInterval;
global.clearInterval = function(timer) {
    activeTimers.delete(timer);
    return originalClearInterval.call(this, timer);
};

// Same for setTimeout
const originalSetTimeout = global.setTimeout;
global.setTimeout = function(...args) {
    const timer = originalSetTimeout.apply(this, args);
    if (timer && typeof timer.unref === 'function') {
        timer.unref();
    }
    activeTimers.add(timer);
    return timer;
};

const originalClearTimeout = global.clearTimeout;
global.clearTimeout = function(timer) {
    activeTimers.delete(timer);
    return originalClearTimeout.call(this, timer);
};

// Expose cleanup function for tests that need manual cleanup
global.__cleanupTimers = function() {
    for (const timer of activeTimers) {
        try {
            originalClearInterval.call(global, timer);
            originalClearTimeout.call(global, timer);
        } catch (e) {
            // Ignore errors during cleanup
        }
    }
    activeTimers.clear();
};
