import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import log from './logger.js';

/**
 * ResilientWebSocket - A wrapper for ethers WebSocketProvider with:
 * 1. Application-level heartbeats (ping/pong via eth_blockNumber)
 * 2. Connection state machine
 * 3. Automatic reconnection with jitter
 * 4. Circuit breaker pattern
 * 5. Proactive connection refresh
 */
export class ResilientWebSocket extends EventEmitter {
    constructor(url, chainId, options = {}) {
        super();

        // FIX v3.11: Set max listeners to catch potential memory leaks early
        this.setMaxListeners(15);

        this.url = url;
        this.chainId = chainId;
        // FIX v3.3: Add chain name for clearer logging
        this.chainName = options.chainName || `Chain ${chainId}`;

        // Configuration
        // FIX v3.8: Increased delays and jitter to prevent thundering herd and rate limit cascades
        // FIX v3.10: Further increased initial connection timeout and added connection retry
        this.config = {
            heartbeatIntervalMs: options.heartbeatIntervalMs || 15000,     // Check connection every 15s
            heartbeatTimeoutMs: options.heartbeatTimeoutMs || 5000,        // Heartbeat must respond in 5s
            reconnectBaseDelayMs: options.reconnectBaseDelayMs || 2000,    // FIX v3.8: Increased from 1000 to 2000
            reconnectMaxDelayMs: options.reconnectMaxDelayMs || 120000,    // FIX v3.8: Increased from 60s to 120s
            maxReconnectAttempts: options.maxReconnectAttempts || 10,      // Before circuit opens
            circuitBreakerCooldownMs: options.circuitBreakerCooldownMs || 300000, // FIX v3.8: Increased from 2 to 5 min cooldown
            proactiveRefreshMs: options.proactiveRefreshMs || 30 * 60 * 1000,     // Refresh every 30 min
            jitterFactor: options.jitterFactor || 0.5,                     // FIX v3.8: Increased from 30% to 50% jitter
            // FIX v3.10: Initial connection settings
            initialConnectionTimeoutMs: options.initialConnectionTimeoutMs || 15000, // 15s initial timeout (was 10s)
            initialConnectionRetries: options.initialConnectionRetries || 3,         // Retry initial connection 3 times
            initialRetryDelayMs: options.initialRetryDelayMs || 2000,               // 2s between initial retries
        };

        // FIX v3.8: Track consecutive 429 errors for adaptive backoff
        this.consecutive429Errors = 0;
        this.lastErrorType = null;

        // State
        this.state = 'disconnected'; // disconnected, connecting, connected, reconnecting, circuit_open
        this.provider = null;
        this.reconnectAttempts = 0;
        this.lastSuccessfulHeartbeat = null;
        this.connectionStartTime = null;

        // Timers
        this.heartbeatTimer = null;
        this.reconnectTimer = null;
        this.refreshTimer = null;
        this.circuitRecoveryTimer = null;

        // Circuit breaker
        this.circuitOpenTime = null;

        // Cleanup state flag to prevent race conditions
        this.isCleaningUp = false;

        // Shutdown flag - prevents reconnection during graceful shutdown
        this.isShuttingDown = false;

        // Metrics
        this.metrics = {
            connectionsEstablished: 0,
            heartbeatsSent: 0,
            heartbeatsFailed: 0,
            reconnectAttempts: 0,
            circuitBreakerTrips: 0,
            proactiveRefreshes: 0,
        };
    }

    /**
     * Connect to the WebSocket endpoint
     * FIX v3.10: Added retry logic for initial connection with 429 detection
     */
    async connect() {
        if (this.state === 'connected' || this.state === 'connecting') {
            return this.provider;
        }

        // Check circuit breaker
        if (this.state === 'circuit_open') {
            const cooldownRemaining = this.circuitOpenTime + this.config.circuitBreakerCooldownMs - Date.now();
            if (cooldownRemaining > 0) {
                throw new Error(`Circuit breaker open, ${Math.ceil(cooldownRemaining / 1000)}s until retry`);
            }
            // Cooldown passed, allow retry
            this.state = 'disconnected';
        }

        this.state = 'connecting';

        // FIX v3.10: Retry initial connection with exponential backoff
        let lastError = null;
        for (let attempt = 0; attempt < this.config.initialConnectionRetries; attempt++) {
            try {
                // Clean up any previous failed provider
                if (this.provider) {
                    try {
                        this.provider.removeAllListeners();
                        this.provider.destroy();
                    } catch (e) {
                        // Ignore cleanup errors
                    }
                    this.provider = null;
                }

                // Create new provider
                this.provider = new ethers.WebSocketProvider(this.url, this.chainId);

                // Wait for ready with increased timeout
                await this._waitForReady(this.config.initialConnectionTimeoutMs);

                // Set up event handlers
                this._setupEventHandlers();

                // Start heartbeat monitoring
                this._startHeartbeat();

                // Schedule proactive refresh
                this._scheduleProactiveRefresh();

                this.state = 'connected';
                this.reconnectAttempts = 0;
                this.connectionStartTime = Date.now();
                this.lastSuccessfulHeartbeat = Date.now();
                this.metrics.connectionsEstablished++;

                // FIX v3.3: Changed to debug level - manager logs init at info level
                log.debug(`[${this.chainName}] WebSocket endpoint connected`, {
                    url: this._maskUrl(this.url),
                    attempt: attempt + 1,
                });

                this.emit('connected');
                return this.provider;

            } catch (error) {
                lastError = error;
                const errorMsg = error?.message || '';

                // FIX v3.10: Detect 429 during handshake and apply longer delay
                const isRateLimit = errorMsg.includes('429') ||
                                   errorMsg.includes('Too Many Requests') ||
                                   errorMsg.includes('rate limit');

                if (isRateLimit) {
                    this.consecutive429Errors++;
                    // Exponential backoff for rate limits: 2s, 4s, 8s...
                    const rateLimitDelay = this.config.initialRetryDelayMs * Math.pow(2, this.consecutive429Errors);
                    log.warn(`WebSocket handshake rate limited (429), waiting ${rateLimitDelay}ms...`, {
                        attempt: attempt + 1,
                        maxAttempts: this.config.initialConnectionRetries,
                        consecutive429s: this.consecutive429Errors,
                    });
                    await this._sleep(rateLimitDelay);
                } else if (attempt < this.config.initialConnectionRetries - 1) {
                    // Non-rate-limit error, use standard retry delay
                    const retryDelay = this.config.initialRetryDelayMs * (attempt + 1);
                    log.debug(`WebSocket connection attempt ${attempt + 1} failed, retrying in ${retryDelay}ms...`, {
                        error: errorMsg,
                    });
                    await this._sleep(retryDelay);
                }
            }
        }

        // All retries exhausted
        this.state = 'disconnected';
        log.error('ResilientWebSocket connection failed after retries', {
            error: lastError?.message,
            attempts: this.config.initialConnectionRetries,
        });
        throw lastError || new Error('Connection failed');
    }

    /**
     * Sleep utility
     * @private
     */
    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Wait for provider to be ready
     */
    async _waitForReady(timeoutMs) {
        return Promise.race([
            this.provider.getBlockNumber(),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Connection timeout')), timeoutMs)
            ),
        ]);
    }

    /**
     * Set up WebSocket event handlers
     * FIX v3.8: Pass error objects through for better categorization
     */
    _setupEventHandlers() {
        // Provider-level errors
        this.provider.on('error', (error) => {
            // FIX v3.8: Detect and handle specific error types
            const errorMsg = error?.message || '';

            // Handle "Invalid WebSocket frame" errors gracefully
            if (errorMsg.includes('Invalid WebSocket frame') || errorMsg.includes('invalid payload length')) {
                log.warn('WebSocket frame error (will recover)', { error: errorMsg });
                this._handleDisconnect('frame_error', error);
                return;
            }

            // Handle 429 errors
            if (errorMsg.includes('429') || errorMsg.includes('Too Many Requests')) {
                log.warn('WebSocket rate limit error', { error: errorMsg });
                this._handleDisconnect('rate_limit', error);
                return;
            }

            log.warn('WebSocket provider error', { error: errorMsg });
            this._handleDisconnect('provider_error', error);
        });

        // Access underlying WebSocket if available (ethers v6)
        const ws = this.provider.websocket || this.provider._websocket;
        if (ws) {
            ws.on('close', (code, reason) => {
                log.warn('WebSocket closed', { code, reason: reason?.toString() });
                this._handleDisconnect('ws_close');
            });

            ws.on('error', (error) => {
                const errorMsg = error?.message || '';

                // FIX v3.8: Handle frame errors at the raw WebSocket level too
                if (errorMsg.includes('Invalid WebSocket frame') || errorMsg.includes('invalid payload length')) {
                    log.warn('WebSocket frame error (raw)', { error: errorMsg });
                    this._handleDisconnect('frame_error', error);
                    return;
                }

                log.warn('WebSocket error', { error: errorMsg });
                this._handleDisconnect('ws_error', error);
            });
        }

        // Forward block events
        this.provider.on('block', (blockNumber) => {
            this.lastSuccessfulHeartbeat = Date.now();
            // FIX v3.8: Reset 429 counter on successful block receipt
            this.consecutive429Errors = 0;
            this.emit('block', blockNumber);
        });
    }

    /**
     * Start application-level heartbeat
     */
    _startHeartbeat() {
        this._stopHeartbeat();

        this.heartbeatTimer = setInterval(async () => {
            if (this.state !== 'connected') return;

            try {
                this.metrics.heartbeatsSent++;

                // Use eth_blockNumber as heartbeat - lightweight and universally supported
                const blockPromise = this.provider.getBlockNumber();
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Heartbeat timeout')), this.config.heartbeatTimeoutMs)
                );

                await Promise.race([blockPromise, timeoutPromise]);

                this.lastSuccessfulHeartbeat = Date.now();

            } catch (error) {
                this.metrics.heartbeatsFailed++;
                log.warn('Heartbeat failed', {
                    error: error.message,
                    consecutiveFailures: this._getConsecutiveFailures(),
                });

                // If heartbeat fails, connection may be stale
                if (this._getConsecutiveFailures() >= 2) {
                    this._handleDisconnect('heartbeat_failure');
                }
            }
        }, this.config.heartbeatIntervalMs);

        this.heartbeatTimer.unref();
    }

    /**
     * Stop heartbeat timer
     */
    _stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    /**
     * Get consecutive heartbeat failures
     */
    _getConsecutiveFailures() {
        if (!this.lastSuccessfulHeartbeat) return 0;
        const timeSinceSuccess = Date.now() - this.lastSuccessfulHeartbeat;
        return Math.floor(timeSinceSuccess / this.config.heartbeatIntervalMs);
    }

    /**
     * Handle disconnection and trigger reconnect
     * FIX v3.8: Enhanced to track error types for adaptive backoff
     */
    _handleDisconnect(reason, error = null) {
        // Prevent re-entry during cleanup, reconnection, or shutdown
        if (this.state === 'reconnecting' || this.state === 'circuit_open' || this.isCleaningUp || this.isShuttingDown) {
            return; // Already handling or shutting down
        }

        // FIX v3.8: Track error type for adaptive backoff
        this.lastErrorType = this._categorizeError(reason, error);
        if (this.lastErrorType === 'rate_limit') {
            this.consecutive429Errors++;
            log.warn('ResilientWebSocket disconnected due to rate limit', {
                reason,
                consecutive429s: this.consecutive429Errors,
            });
        } else {
            // Reset 429 counter on non-rate-limit errors
            this.consecutive429Errors = 0;
            log.warn('ResilientWebSocket disconnected', { reason });
        }

        this.state = 'reconnecting';

        // Clean up current connection
        this._cleanup();

        // Only attempt reconnect if not shutting down
        if (!this.isShuttingDown) {
            this._scheduleReconnect();
        }

        this.emit('disconnected', reason);
    }

    /**
     * FIX v3.8: Categorize error for adaptive backoff strategy
     * @private
     */
    _categorizeError(reason, error = null) {
        const errorMsg = (error?.message || reason || '').toLowerCase();

        // Rate limit / 429 errors
        if (errorMsg.includes('429') ||
            errorMsg.includes('rate limit') ||
            errorMsg.includes('too many requests') ||
            errorMsg.includes('capacity')) {
            return 'rate_limit';
        }

        // Invalid WebSocket frame (Alchemy-specific issue)
        if (errorMsg.includes('invalid websocket frame') ||
            errorMsg.includes('invalid payload length')) {
            return 'frame_error';
        }

        // Connection errors
        if (errorMsg.includes('timeout') ||
            errorMsg.includes('econnreset') ||
            errorMsg.includes('enotfound')) {
            return 'connection_error';
        }

        return 'unknown';
    }

    /**
     * Schedule reconnection with exponential backoff + jitter
     * FIX v3.8: Adaptive backoff based on error type - longer delays for rate limits
     */
    _scheduleReconnect() {
        // Don't schedule reconnects during shutdown
        if (this.isShuttingDown) {
            return;
        }

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }

        this.reconnectAttempts++;
        this.metrics.reconnectAttempts++;

        // Check if circuit breaker should open
        if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
            this._openCircuitBreaker();
            return;
        }

        // FIX v3.8: Adaptive base delay based on error type
        let effectiveBaseDelay = this.config.reconnectBaseDelayMs;

        if (this.lastErrorType === 'rate_limit') {
            // Rate limit errors need much longer delays
            // Each consecutive 429 doubles the base delay
            effectiveBaseDelay = this.config.reconnectBaseDelayMs * Math.pow(2, this.consecutive429Errors);
            // Cap at 5 minutes for rate limit errors
            effectiveBaseDelay = Math.min(effectiveBaseDelay, 5 * 60 * 1000);
        } else if (this.lastErrorType === 'frame_error') {
            // Frame errors (Alchemy-specific) - moderate delay to let server stabilize
            effectiveBaseDelay = this.config.reconnectBaseDelayMs * 2;
        }

        // Calculate delay with exponential backoff
        const baseDelay = effectiveBaseDelay * Math.pow(2, this.reconnectAttempts - 1);
        const cappedDelay = Math.min(baseDelay, this.config.reconnectMaxDelayMs);

        // FIX v3.8: Increased jitter range to prevent thundering herd
        // Use random offset between 0 and jitterFactor (not centered around 0)
        // This ensures all workers don't reconnect at exactly the same time
        const jitter = cappedDelay * this.config.jitterFactor * Math.random();
        const finalDelay = Math.max(500, cappedDelay + jitter);

        log.info('Scheduling reconnect', {
            attempt: this.reconnectAttempts,
            maxAttempts: this.config.maxReconnectAttempts,
            delayMs: Math.round(finalDelay),
            errorType: this.lastErrorType,
            consecutive429s: this.consecutive429Errors,
        });

        this.reconnectTimer = setTimeout(async () => {
            // Double-check shutdown flag in case it was set during delay
            if (this.isShuttingDown) {
                return;
            }

            try {
                await this.connect();
                this.emit('reconnected');
            } catch (error) {
                log.error('Reconnect failed', { error: error.message });
                // Will be handled by next disconnect event or heartbeat failure
            }
        }, finalDelay);

        this.reconnectTimer.unref();
    }

    /**
     * Open circuit breaker after max reconnect attempts
     */
    _openCircuitBreaker() {
        this.state = 'circuit_open';
        this.circuitOpenTime = Date.now();
        this.metrics.circuitBreakerTrips++;

        log.error('Circuit breaker opened', {
            cooldownMs: this.config.circuitBreakerCooldownMs,
            reconnectAttempts: this.reconnectAttempts,
        });

        this.emit('circuitOpen', {
            cooldownMs: this.config.circuitBreakerCooldownMs,
            willRetryAt: new Date(this.circuitOpenTime + this.config.circuitBreakerCooldownMs),
        });

        // Schedule automatic recovery attempt (store reference for cleanup)
        this.circuitRecoveryTimer = setTimeout(() => {
            this.circuitRecoveryTimer = null;
            // Don't attempt recovery if shutting down
            if (this.isShuttingDown) {
                return;
            }
            if (this.state === 'circuit_open') {
                log.info('Circuit breaker cooldown complete, attempting recovery');
                this.reconnectAttempts = 0;
                this.state = 'disconnected';
                this.connect().catch(e => {
                    log.error('Recovery attempt failed', { error: e.message });
                });
            }
        }, this.config.circuitBreakerCooldownMs);

        // Unref to not block process exit
        if (this.circuitRecoveryTimer.unref) {
            this.circuitRecoveryTimer.unref();
        }
    }

    /**
     * Schedule proactive connection refresh
     */
    _scheduleProactiveRefresh() {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }

        this.refreshTimer = setTimeout(async () => {
            // FIX v3.11: Comprehensive defensive checks before proactive refresh
            try {
                // Don't refresh if shutting down or not connected
                if (this.isShuttingDown || this.state !== 'connected') {
                    log.debug('Proactive refresh skipped', {
                        reason: this.isShuttingDown ? 'shutting_down' : 'not_connected',
                        state: this.state
                    });
                    return;
                }

                // FIX v3.11: Check actual WebSocket state - don't refresh if CONNECTING
                const ws = this.provider?.websocket || this.provider?._websocket;
                const wsState = ws?.readyState;
                if (wsState !== 1) { // 1 = OPEN
                    log.debug('Proactive refresh skipped - WebSocket not OPEN', {
                        readyState: wsState,
                        stateLabel: ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][wsState] || 'unknown'
                    });
                    // Reschedule for later instead of crashing
                    this._scheduleProactiveRefresh();
                    return;
                }

                log.info('Proactive connection refresh', {
                    connectionAgeMs: Date.now() - this.connectionStartTime,
                });

                this.metrics.proactiveRefreshes++;

                // Gracefully close and reconnect
                this._cleanup();
                this.state = 'disconnected';

                // Only reconnect if not shutting down
                if (!this.isShuttingDown) {
                    await this.connect();
                    this.emit('refreshed');
                }
            } catch (error) {
                // FIX v3.11: Catch ALL errors during proactive refresh to prevent crashes
                log.error('Proactive refresh failed (non-fatal)', {
                    error: error.message,
                    url: this.url
                });
                // Try to reconnect anyway if not shutting down
                if (!this.isShuttingDown && this.state !== 'connected') {
                    this.state = 'disconnected';
                    try {
                        await this.connect();
                    } catch (reconnectError) {
                        log.warn('Proactive refresh reconnect also failed', {
                            error: reconnectError.message
                        });
                    }
                }
            }
        }, this.config.proactiveRefreshMs);

        this.refreshTimer.unref();
    }

    /**
     * Clean up resources
     * Uses isCleaningUp flag to prevent race conditions with WebSocket close events
     *
     * FIX v3.6: Comprehensive error handling for all WebSocket states
     * The ws library throws "WebSocket was closed before the connection was established"
     * when close() is called on a CONNECTING (readyState=0) WebSocket.
     */
    _cleanup() {
        // Prevent re-entry and race conditions
        if (this.isCleaningUp) {
            return;
        }
        this.isCleaningUp = true;

        try {
            this._stopHeartbeat();

            if (this.refreshTimer) {
                clearTimeout(this.refreshTimer);
                this.refreshTimer = null;
            }

            if (this.provider) {
                // FIX v3.6: Wrap ALL provider cleanup in try-catch
                // provider.destroy() internally calls ws.close() which can throw
                try {
                    this.provider.removeAllListeners();
                } catch (listenerError) {
                    // Ignore - provider may already be destroyed
                }

                // Check WebSocket readyState before destroying to avoid errors
                // readyState: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
                const ws = this.provider.websocket || this.provider._websocket;
                const readyState = ws?.readyState;

                // FIX v3.11: Handle each state explicitly with proper error handling
                if (readyState === 0) {
                    // CONNECTING state - WebSocket handshake not complete
                    // CRITICAL FIX v3.11: DO NOT call ws.close() on CONNECTING WebSocket!
                    // The ws library throws "WebSocket was closed before connection established"
                    // AND emits an 'error' event that propagates as uncaught exception.
                    //
                    // Solution: Remove ALL listeners to prevent error propagation,
                    // then let the socket timeout/close on its own.
                    try {
                        if (ws) {
                            // Remove error listener FIRST to prevent error event propagation
                            if (typeof ws.removeAllListeners === 'function') {
                                ws.removeAllListeners();
                            }
                            // DON'T call close() - it throws and emits error
                            // Just log and let it die naturally
                            log.debug('WebSocket in CONNECTING state, abandoning (will timeout)', {
                                url: this.url
                            });
                        }
                    } catch (connectingCleanupError) {
                        // Ignore - socket will timeout/close on its own
                        log.debug('WebSocket CONNECTING cleanup error (ignored)', {
                            error: connectingCleanupError.message
                        });
                    }
                } else if (readyState === 1 || readyState === 2) {
                    // OPEN or CLOSING - safe to destroy
                    try {
                        this.provider.destroy();
                    } catch (destroyError) {
                        // FIX v3.6: Catch "closed before established" and other errors
                        // This can happen if state changed between check and destroy
                        log.debug('Provider destroy error (ignored)', {
                            error: destroyError.message,
                            readyState
                        });
                    }
                } else if (readyState === 3) {
                    // CLOSED - already closed, just cleanup
                    try {
                        this.provider.destroy();
                    } catch (e) {
                        // Ignore - already closed
                    }
                } else if (readyState === undefined) {
                    // No underlying WebSocket or ethers v5 - try destroy with catch
                    try {
                        this.provider.destroy();
                    } catch (e) {
                        // Ignore destroy errors when readyState unknown
                    }
                }

                this.provider = null;
            }
        } finally {
            this.isCleaningUp = false;
        }
    }

    /**
     * Graceful disconnect
     * Sets shutdown flag FIRST to prevent any reconnection attempts during cleanup
     */
    async disconnect() {
        // IMPORTANT: Set shutdown flag FIRST to prevent reconnection attempts
        this.isShuttingDown = true;

        log.info('ResilientWebSocket disconnecting');

        // Clear ALL pending timers
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.circuitRecoveryTimer) {
            clearTimeout(this.circuitRecoveryTimer);
            this.circuitRecoveryTimer = null;
        }

        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }

        this._stopHeartbeat();

        // Now clean up the connection
        this._cleanup();
        this.state = 'disconnected';
    }

    /**
     * Get current provider (null if not connected)
     */
    getProvider() {
        return this.state === 'connected' ? this.provider : null;
    }

    /**
     * Check if connected
     */
    isConnected() {
        return this.state === 'connected';
    }

    /**
     * Get status and metrics
     */
    getStatus() {
        return {
            state: this.state,
            url: this._maskUrl(this.url),
            connectionAgeMs: this.connectionStartTime ? Date.now() - this.connectionStartTime : null,
            lastHeartbeat: this.lastSuccessfulHeartbeat,
            timeSinceHeartbeat: this.lastSuccessfulHeartbeat ? Date.now() - this.lastSuccessfulHeartbeat : null,
            reconnectAttempts: this.reconnectAttempts,
            circuitOpenTime: this.circuitOpenTime,
            metrics: { ...this.metrics },
        };
    }

    /**
     * Mask URL for logging
     */
    _maskUrl(url) {
        try {
            const parsed = new URL(url);
            if (parsed.pathname.length > 15) {
                parsed.pathname = parsed.pathname.substring(0, 15) + '...';
            }
            return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
        } catch {
            return url.substring(0, 30) + '...';
        }
    }
}

export default ResilientWebSocket;
