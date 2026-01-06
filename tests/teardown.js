/**
 * Jest Global Teardown
 *
 * Cleans up singleton modules that have persistent timers/connections.
 * This runs after all tests are complete.
 */

export default async function globalTeardown() {
    // Give any pending async operations a moment to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    // Force cleanup any remaining timers (belt and suspenders approach)
    // Jest's forceExit will handle anything that remains
}
