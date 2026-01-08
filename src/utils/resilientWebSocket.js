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

        this.url = url;
        this.chainId = chainId;
        // FIX v3.3: Add chain name for clearer logging
        this.chainName = options.chainName || `Chain ${chainId}`;

        // Configuration
        this.config = {
            heartbeatIntervalMs: options.heartbeatIntervalMs || 15000,     // Check connection every 15s
            heartbeatTimeoutMs: options.heartbeatTimeoutMs || 5000,        // Heartbeat must respond in 5s
            reconnectBaseDelayMs: options.reconnectBaseDelayMs || 1000,    // Base delay for reconnect
            reconnectMaxDelayMs: options.reconnectMaxDelayMs || 60000,     // Max 60s between reconnects
            maxReconnectAttempts: options.maxReconnectAttempts || 10,      // Before circuit opens
            circuitBreakerCooldownMs: options.circuitBreakerCooldownMs || 120000, // 2 min cooldown
            proactiveRefreshMs: options.proactiveRefreshMs || 30 * 60 * 1000,     // Refresh every 30 min
            jitterFactor: options.jitterFactor || 0.3,                     // 30% jitter on delays
        };

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

        try {
            // Create new provider
            this.provider = new ethers.WebSocketProvider(this.url, this.chainId);

            // Wait for ready with timeout
            await this._waitForReady(10000);

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
            });

            this.emit('connected');
            return this.provider;

        } catch (error) {
            this.state = 'disconnected';
            log.error('ResilientWebSocket connection failed', { error: error.message });
            throw error;
        }
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
     */
    _setupEventHandlers() {
        // Provider-level errors
        this.provider.on('error', (error) => {
            log.warn('WebSocket provider error', { error: error.message });
            this._handleDisconnect('provider_error');
        });

        // Access underlying WebSocket if available (ethers v6)
        const ws = this.provider.websocket || this.provider._websocket;
        if (ws) {
            ws.on('close', (code, reason) => {
                log.warn('WebSocket closed', { code, reason: reason?.toString() });
                this._handleDisconnect('ws_close');
            });

            ws.on('error', (error) => {
                log.warn('WebSocket error', { error: error.message });
                this._handleDisconnect('ws_error');
            });
        }

        // Forward block events
        this.provider.on('block', (blockNumber) => {
            this.lastSuccessfulHeartbeat = Date.now();
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
     */
    _handleDisconnect(reason) {
        // Prevent re-entry during cleanup, reconnection, or shutdown
        if (this.state === 'reconnecting' || this.state === 'circuit_open' || this.isCleaningUp || this.isShuttingDown) {
            return; // Already handling or shutting down
        }

        log.warn('ResilientWebSocket disconnected', { reason });
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
     * Schedule reconnection with exponential backoff + jitter
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

        // Calculate delay with exponential backoff
        const baseDelay = this.config.reconnectBaseDelayMs * Math.pow(2, this.reconnectAttempts - 1);
        const cappedDelay = Math.min(baseDelay, this.config.reconnectMaxDelayMs);

        // Add jitter to prevent thundering herd
        const jitter = cappedDelay * this.config.jitterFactor * (Math.random() - 0.5) * 2;
        const finalDelay = Math.max(100, cappedDelay + jitter);

        log.info('Scheduling reconnect', {
            attempt: this.reconnectAttempts,
            maxAttempts: this.config.maxReconnectAttempts,
            delayMs: Math.round(finalDelay),
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
            // Don't refresh if shutting down or not connected
            if (this.isShuttingDown || this.state !== 'connected') return;

            log.info('Proactive connection refresh', {
                connectionAgeMs: Date.now() - this.connectionStartTime,
            });

            this.metrics.proactiveRefreshes++;

            // Gracefully close and reconnect
            this._cleanup();
            this.state = 'disconnected';

            // Only reconnect if not shutting down
            if (!this.isShuttingDown) {
                try {
                    await this.connect();
                    this.emit('refreshed');
                } catch (error) {
                    log.error('Proactive refresh failed', { error: error.message });
                }
            }
        }, this.config.proactiveRefreshMs);

        this.refreshTimer.unref();
    }

    /**
     * Clean up resources
     * Uses isCleaningUp flag to prevent race conditions with WebSocket close events
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
                try {
                    this.provider.removeAllListeners();

                    // Check WebSocket readyState before destroying to avoid errors
                    // readyState: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
                    const ws = this.provider.websocket || this.provider._websocket;
                    const readyState = ws?.readyState;

                    // Only call destroy if connection is established (OPEN) or closing
                    // Skip if still CONNECTING (0) to avoid "closed before established" error
                    if (readyState === undefined || readyState >= 1) {
                        this.provider.destroy();
                    } else {
                        // For CONNECTING state, close the underlying WebSocket directly
                        try {
                            if (ws && typeof ws.close === 'function') {
                                ws.close();
                            }
                        } catch (closeError) {
                            // Ignore close errors on CONNECTING websockets
                        }
                    }
                } catch (e) {
                    // Ignore cleanup errors - common during proactive refresh or connection issues
                    // "WebSocket was closed before the connection was established" is expected in some cases
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
