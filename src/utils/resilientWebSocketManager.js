import { EventEmitter } from 'events';
import { ResilientWebSocket } from './resilientWebSocket.js';
import log from './logger.js';

/**
 * ResilientWebSocketManager - Manages multiple WebSocket connections with failover
 *
 * Features:
 * 1. Multiple endpoint support with automatic failover
 * 2. Health-based endpoint selection (latency, error rate)
 * 3. Parallel connections for redundancy
 * 4. Unified event forwarding from all connections
 * 5. Provider scoring for optimal selection
 */
export class ResilientWebSocketManager extends EventEmitter {
    constructor(options = {}) {
        super();

        // Configuration
        // FIX v3.8: Increased failover delay and added stagger settings
        // FIX v3.10: Added graceful 429 handling during initialization
        this.config = {
            maxConcurrentConnections: options.maxConcurrentConnections || 2,
            preferredEndpointIndex: options.preferredEndpointIndex || 0,
            failoverDelayMs: options.failoverDelayMs || 3000,      // FIX v3.8: Increased from 1000
            healthCheckIntervalMs: options.healthCheckIntervalMs || 30000,
            // FIX v3.8: Stagger reconnection to prevent thundering herd
            staggerDelayMs: options.staggerDelayMs || 2000,        // Delay between endpoint reconnects
            staggerJitterMs: options.staggerJitterMs || 1000,      // Random jitter added to stagger
            // FIX v3.10: Initial connection retry settings
            initRetryDelayMs: options.initRetryDelayMs || 5000,    // 5s wait before retry on init failure
            maxInitRetries: options.maxInitRetries || 2,           // Max retries for initial primary connection
            // Pass through to ResilientWebSocket
            wsOptions: options.wsOptions || {},
        };

        // Connection management
        this.connections = new Map(); // endpoint -> ResilientWebSocket
        this.endpointScores = new Map(); // endpoint -> { score, latency, errors, lastCheck }
        this.endpoints = [];
        this.chainId = null;
        this.chainName = 'Unknown'; // FIX v3.3: Add chain name for log context
        this.primaryEndpoint = null;

        // State
        this.isInitialized = false;
        this.healthCheckTimer = null;
        this.isShuttingDown = false; // Shutdown flag to prevent reconnect during teardown
        this.pendingFailoverTimers = []; // Track failover timers for cleanup

        // FIX v3.6: Connection locks to prevent concurrent operations on same endpoint
        // This prevents race conditions when multiple failovers trigger simultaneously
        this.pendingConnections = new Set(); // Endpoints currently being connected

        // FIX v3.6: Failover debounce to prevent cascade when multiple WS disconnect simultaneously
        this.failoverInProgress = false;
        this.failoverDebounceTimer = null;

        // Statistics
        this.stats = {
            failovers: 0,
            totalConnections: 0,
            totalDisconnections: 0,
            requestsServed: 0,
        };
    }

    /**
     * Initialize with WebSocket endpoints
     * FIX v3.3: Added chainName parameter for log context
     * @param {Array<string>} endpoints - Array of WebSocket URLs
     * @param {number} chainId - Chain ID for providers
     * @param {string} chainName - Optional chain name for logging
     */
    async initialize(endpoints, chainId, chainName = null) {
        if (!endpoints || endpoints.length === 0) {
            throw new Error('At least one WebSocket endpoint is required');
        }

        this.endpoints = endpoints;
        this.chainId = chainId;
        this.chainName = chainName || `Chain ${chainId}`;

        // Initialize scores for all endpoints
        for (const endpoint of endpoints) {
            this.endpointScores.set(endpoint, {
                score: 100, // Start with perfect score
                latency: 0,
                errors: 0,
                successes: 0,
                lastCheck: Date.now(),
            });
        }

        // FIX v3.10: Connect to primary endpoint with retries for 429 resilience
        const primaryEndpoint = endpoints[this.config.preferredEndpointIndex] || endpoints[0];
        let primaryConnected = false;

        for (let attempt = 0; attempt < this.config.maxInitRetries && !primaryConnected; attempt++) {
            try {
                await this._connectToEndpoint(primaryEndpoint);
                primaryConnected = true;
            } catch (error) {
                const is429 = error?.message?.includes('429') || error?.message?.includes('rate limit');

                if (is429) {
                    log.warn(`Primary WS endpoint rate-limited (429), waiting before retry...`, {
                        attempt: attempt + 1,
                        maxRetries: this.config.maxInitRetries,
                        delayMs: this.config.initRetryDelayMs,
                    });
                } else {
                    log.warn(`Primary WS endpoint connection failed, trying next...`, {
                        error: error.message,
                        attempt: attempt + 1,
                    });
                }

                // Wait before retry (longer for rate limits)
                const delay = is429
                    ? this.config.initRetryDelayMs * (attempt + 1)
                    : this.config.initRetryDelayMs;
                await this._sleep(delay);

                // If all retries failed, try next endpoint in list
                if (attempt === this.config.maxInitRetries - 1 && endpoints.length > 1) {
                    log.info('Primary endpoint failed, trying fallback endpoint...');
                    const fallbackEndpoint = endpoints[1];
                    try {
                        await this._connectToEndpoint(fallbackEndpoint);
                        primaryConnected = true;
                    } catch (fallbackError) {
                        log.error('Fallback endpoint also failed', { error: fallbackError.message });
                    }
                }
            }
        }

        if (!primaryConnected) {
            throw new Error('Failed to connect to any WebSocket endpoint');
        }

        // FIX v3.8: Stagger backup endpoint connections to prevent thundering herd
        // Connect to backup endpoints (up to maxConcurrentConnections)
        const backupEndpoints = endpoints.filter((_, i) => i !== this.config.preferredEndpointIndex);
        const backupsToConnect = backupEndpoints.slice(0, this.config.maxConcurrentConnections - 1);

        for (let i = 0; i < backupsToConnect.length; i++) {
            const endpoint = backupsToConnect[i];
            // FIX v3.8: Stagger connection attempts with increasing delay
            const staggerDelay = (i + 1) * this.config.staggerDelayMs +
                                 Math.random() * this.config.staggerJitterMs;

            // Connect backups in background with stagger (don't await)
            setTimeout(() => {
                if (!this.isShuttingDown) {
                    this._connectToEndpoint(endpoint).catch(e => {
                        log.debug(`Backup endpoint connection deferred: ${this._maskUrl(endpoint)}`);
                    });
                }
            }, staggerDelay);
        }

        // Start health monitoring
        this._startHealthMonitoring();

        this.isInitialized = true;

        // FIX v3.3: Include chain name in log for multi-chain clarity
        log.info(`[${this.chainName}] WebSocket manager initialized`, {
            endpoints: endpoints.length,
            chainId,
            primaryEndpoint: this._maskUrl(this.primaryEndpoint),
        });
    }

    /**
     * Connect to a specific endpoint
     * FIX v3.6: Added connection locking to prevent race conditions
     * @private
     */
    async _connectToEndpoint(endpoint) {
        // Don't create new connections during shutdown
        if (this.isShuttingDown) {
            return null;
        }

        // FIX v3.6: Prevent concurrent connection attempts to the same endpoint
        // This can happen when multiple failovers trigger simultaneously
        if (this.pendingConnections.has(endpoint)) {
            log.debug(`Connection to ${this._maskUrl(endpoint)} already in progress, skipping`);
            // Wait briefly and return existing connection if available
            await new Promise(resolve => setTimeout(resolve, 100));
            const existing = this.connections.get(endpoint);
            if (existing?.isConnected()) {
                return existing;
            }
            return null;
        }

        // Mark this endpoint as having a pending connection
        this.pendingConnections.add(endpoint);

        try {
            if (this.connections.has(endpoint)) {
                const existing = this.connections.get(endpoint);
                if (existing.isConnected()) {
                    return existing;
                }
                // Clean up old disconnected connection to prevent event listener accumulation
                // FIX v3.6: Enhanced error handling for cleanup
                try {
                    existing.removeAllListeners();
                } catch (e) {
                    // Ignore listener removal errors
                }
                try {
                    await existing.disconnect();
                } catch (e) {
                    // FIX v3.6: Log but don't throw on cleanup errors
                    log.debug(`Cleanup error for ${this._maskUrl(endpoint)} (ignored)`, {
                        error: e.message
                    });
                }
                this.connections.delete(endpoint);
            }

            // FIX v3.3: Pass chainName for clearer logging in multi-chain mode
            const wsOptions = { ...this.config.wsOptions, chainName: this.chainName };
            const ws = new ResilientWebSocket(endpoint, this.chainId, wsOptions);

            // Forward events from this connection
            this._setupConnectionEvents(ws, endpoint);

            try {
                await ws.connect();
                this.connections.set(endpoint, ws);
                this.stats.totalConnections++;

                // Set as primary if we don't have one
                if (!this.primaryEndpoint) {
                    this.primaryEndpoint = endpoint;
                }

                // Update score on successful connection
                this._updateEndpointScore(endpoint, true, 0);

                return ws;
            } catch (error) {
                this._updateEndpointScore(endpoint, false);
                throw error;
            }
        } finally {
            // FIX v3.6: Always release the connection lock
            this.pendingConnections.delete(endpoint);
        }
    }

    /**
     * Set up event forwarding for a connection
     * @private
     */
    _setupConnectionEvents(ws, endpoint) {
        // Forward block events (only from primary to avoid duplicates)
        ws.on('block', (blockNumber) => {
            if (endpoint === this.primaryEndpoint) {
                this.emit('block', blockNumber);
            }
        });

        ws.on('connected', () => {
            log.debug(`WebSocket connected: ${this._maskUrl(endpoint)}`);
            this._updateEndpointScore(endpoint, true);
        });

        ws.on('disconnected', (reason) => {
            log.warn(`WebSocket disconnected: ${this._maskUrl(endpoint)}`, { reason });
            this.stats.totalDisconnections++;
            this._updateEndpointScore(endpoint, false);

            // If primary disconnected, failover
            if (endpoint === this.primaryEndpoint) {
                this._handlePrimaryFailover();
            }
        });

        ws.on('reconnected', () => {
            log.info(`WebSocket reconnected: ${this._maskUrl(endpoint)}`);
            this._updateEndpointScore(endpoint, true);
        });

        ws.on('circuitOpen', (data) => {
            log.error(`Circuit breaker opened for: ${this._maskUrl(endpoint)}`, data);
            this._updateEndpointScore(endpoint, false);

            if (endpoint === this.primaryEndpoint) {
                this._handlePrimaryFailover();
            }

            this.emit('circuitOpen', { endpoint: this._maskUrl(endpoint), ...data });
        });
    }

    /**
     * Handle failover when primary connection fails
     * FIX v3.6: Added debounce to prevent cascade when multiple WS disconnect simultaneously
     * @private
     */
    _handlePrimaryFailover() {
        // Don't attempt failover during shutdown
        if (this.isShuttingDown) {
            return;
        }

        // FIX v3.6: Debounce failover - when multiple connections drop simultaneously,
        // we only want to handle failover once, not trigger multiple failovers
        if (this.failoverInProgress) {
            log.debug('Failover already in progress, skipping duplicate');
            return;
        }

        // FIX v3.8: Increased debounce to better coalesce cascade disconnections
        if (this.failoverDebounceTimer) {
            clearTimeout(this.failoverDebounceTimer);
        }

        this.failoverDebounceTimer = setTimeout(() => {
            this.failoverDebounceTimer = null;
            this._executeFailover();
        }, 500); // FIX v3.8: Increased from 100ms to 500ms
    }

    /**
     * Execute the actual failover logic
     * FIX v3.6: Separated from _handlePrimaryFailover for debouncing
     * @private
     */
    _executeFailover() {
        // Double-check shutdown flag
        if (this.isShuttingDown || this.failoverInProgress) {
            return;
        }

        this.failoverInProgress = true;

        try {
            const oldPrimary = this.primaryEndpoint;

            // Find best healthy alternative
            const newPrimary = this._selectBestEndpoint(oldPrimary);

            if (newPrimary && newPrimary !== oldPrimary) {
                this.primaryEndpoint = newPrimary;
                this.stats.failovers++;

                log.warn('Primary WebSocket failover', {
                    from: this._maskUrl(oldPrimary),
                    to: this._maskUrl(newPrimary),
                    totalFailovers: this.stats.failovers,
                });

                this.emit('failover', {
                    from: this._maskUrl(oldPrimary),
                    to: this._maskUrl(newPrimary),
                });

                // FIX v3.8: Staggered reconnect of old primary with longer delay
                // This prevents thundering herd when multiple failovers happen
                // Track timer for cleanup during shutdown
                const staggeredDelay = this.config.failoverDelayMs +
                                       Math.random() * this.config.staggerJitterMs +
                                       this.stats.failovers * 1000; // Add 1s per failover to spread reconnects
                const timer = setTimeout(() => {
                    // Remove from pending timers
                    const idx = this.pendingFailoverTimers.indexOf(timer);
                    if (idx !== -1) this.pendingFailoverTimers.splice(idx, 1);

                    // Only reconnect if not shutting down
                    if (!this.isShuttingDown) {
                        this._connectToEndpoint(oldPrimary).catch((e) => {
                            log.debug(`Background reconnect failed for ${this._maskUrl(oldPrimary)}`, {
                                error: e.message
                            });
                        });
                    }
                }, staggeredDelay);

                timer.unref();
                this.pendingFailoverTimers.push(timer);
            } else {
                log.error('No healthy WebSocket endpoints available for failover');
                this.emit('allEndpointsDown');
            }
        } finally {
            // FIX v3.6: Release failover lock after a short delay to prevent rapid re-entry
            setTimeout(() => {
                this.failoverInProgress = false;
            }, 500);
        }
    }

    /**
     * Select the best endpoint based on scores
     * @private
     */
    _selectBestEndpoint(excludeEndpoint = null) {
        let bestEndpoint = null;
        let bestScore = -1;

        for (const [endpoint, scoreData] of this.endpointScores) {
            if (endpoint === excludeEndpoint) continue;

            // Check if connection exists and is healthy
            const conn = this.connections.get(endpoint);
            if (conn && conn.isConnected() && scoreData.score > bestScore) {
                bestScore = scoreData.score;
                bestEndpoint = endpoint;
            }
        }

        return bestEndpoint;
    }

    /**
     * Update endpoint health score
     * @private
     */
    _updateEndpointScore(endpoint, success, latencyMs = null) {
        const score = this.endpointScores.get(endpoint);
        if (!score) return;

        if (success) {
            score.successes++;
            score.score = Math.min(100, score.score + 5);
            if (latencyMs !== null) {
                // Exponential moving average for latency
                score.latency = score.latency === 0
                    ? latencyMs
                    : score.latency * 0.8 + latencyMs * 0.2;
            }
        } else {
            score.errors++;
            score.score = Math.max(0, score.score - 20);
        }

        score.lastCheck = Date.now();
    }

    /**
     * Start health monitoring background task
     * @private
     */
    _startHealthMonitoring() {
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
        }

        this.healthCheckTimer = setInterval(async () => {
            await this._performHealthChecks();
        }, this.config.healthCheckIntervalMs);

        this.healthCheckTimer.unref();
    }

    /**
     * Perform health checks on all connections
     * @private
     */
    async _performHealthChecks() {
        // Skip health checks during shutdown
        if (this.isShuttingDown) {
            return;
        }

        for (const [endpoint, ws] of this.connections) {
            if (!ws.isConnected()) continue;

            const start = Date.now();
            try {
                const provider = ws.getProvider();
                if (provider) {
                    await Promise.race([
                        provider.getBlockNumber(),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('Health check timeout')), 5000)
                        ),
                    ]);
                    this._updateEndpointScore(endpoint, true, Date.now() - start);
                }
            } catch (error) {
                this._updateEndpointScore(endpoint, false);
            }
        }

        // Check if we should switch primary based on scores
        this._evaluatePrimarySwitch();
    }

    /**
     * Evaluate if we should switch primary to a better endpoint
     * @private
     */
    _evaluatePrimarySwitch() {
        // Skip during shutdown
        if (this.isShuttingDown || !this.primaryEndpoint) return;

        const currentScore = this.endpointScores.get(this.primaryEndpoint);
        const bestEndpoint = this._selectBestEndpoint();

        if (bestEndpoint && bestEndpoint !== this.primaryEndpoint) {
            const bestScore = this.endpointScores.get(bestEndpoint);

            // Switch if best is significantly better (20+ points) and current is degraded
            if (bestScore.score - currentScore.score > 20 && currentScore.score < 80) {
                const oldPrimary = this.primaryEndpoint;

                log.info('Proactive primary switch due to better endpoint available', {
                    from: this._maskUrl(oldPrimary),
                    to: this._maskUrl(bestEndpoint),
                    currentScore: currentScore.score,
                    newScore: bestScore.score,
                });

                this.primaryEndpoint = bestEndpoint;
                this.emit('primarySwitch', {
                    from: this._maskUrl(oldPrimary),
                    to: this._maskUrl(bestEndpoint),
                });
            }
        }
    }

    /**
     * Get the best available provider
     * @returns {Object|null} ethers provider or null
     */
    getProvider() {
        // Try primary first
        if (this.primaryEndpoint) {
            const primary = this.connections.get(this.primaryEndpoint);
            if (primary && primary.isConnected()) {
                this.stats.requestsServed++;
                return primary.getProvider();
            }
        }

        // Failover to any connected endpoint
        for (const [endpoint, ws] of this.connections) {
            if (ws.isConnected()) {
                this.stats.requestsServed++;
                return ws.getProvider();
            }
        }

        return null;
    }

    /**
     * Get provider with endpoint info (for compatibility with rpcManager)
     * @returns {Object|null} { provider, endpoint, index }
     */
    getWsProvider() {
        const provider = this.getProvider();
        if (!provider) return null;

        return {
            provider,
            endpoint: this.primaryEndpoint,
            index: this.endpoints.indexOf(this.primaryEndpoint),
        };
    }

    /**
     * Subscribe to events using the best provider
     * Events are automatically re-subscribed on failover
     * @param {Object|string} filter - Event filter or event name
     * @param {Function} callback - Event handler
     */
    subscribe(filter, callback) {
        const provider = this.getProvider();
        if (!provider) {
            throw new Error('No WebSocket provider available');
        }

        provider.on(filter, callback);

        // Store subscription for re-subscription on failover
        // (This is a simplified version - full implementation would track and replay)
        return () => {
            try {
                provider.off(filter, callback);
            } catch (e) {
                // Ignore removal errors
            }
        };
    }

    /**
     * Get status of all connections
     */
    getStatus() {
        const connectionStatus = {};

        for (const [endpoint, ws] of this.connections) {
            connectionStatus[this._maskUrl(endpoint)] = {
                ...ws.getStatus(),
                score: this.endpointScores.get(endpoint),
                isPrimary: endpoint === this.primaryEndpoint,
            };
        }

        return {
            isInitialized: this.isInitialized,
            primaryEndpoint: this._maskUrl(this.primaryEndpoint),
            totalEndpoints: this.endpoints.length,
            connectedEndpoints: [...this.connections.values()].filter(ws => ws.isConnected()).length,
            stats: { ...this.stats },
            connections: connectionStatus,
        };
    }

    /**
     * Force reconnection of a specific endpoint
     * @param {string} endpoint - Endpoint URL
     */
    async reconnectEndpoint(endpoint) {
        const ws = this.connections.get(endpoint);
        if (ws) {
            await ws.disconnect();
        }
        return this._connectToEndpoint(endpoint);
    }

    /**
     * Disconnect all connections
     * Sets shutdown flag FIRST to prevent reconnect/failover during teardown
     * FIX v3.6: Added cleanup for new debounce timers and connection locks
     */
    async disconnect() {
        // IMPORTANT: Set shutdown flag FIRST to prevent any reconnection attempts
        this.isShuttingDown = true;

        // FIX v3.6: Clear failover debounce timer
        if (this.failoverDebounceTimer) {
            clearTimeout(this.failoverDebounceTimer);
            this.failoverDebounceTimer = null;
        }
        this.failoverInProgress = false;

        // Clear health check timer
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = null;
        }

        // Clear ALL pending failover timers
        for (const timer of this.pendingFailoverTimers) {
            clearTimeout(timer);
        }
        this.pendingFailoverTimers = [];

        // FIX v3.6: Clear pending connections set
        this.pendingConnections.clear();

        // Disconnect all connections with error handling
        const disconnectPromises = [];
        for (const ws of this.connections.values()) {
            disconnectPromises.push(
                ws.disconnect().catch(e => {
                    // Ignore disconnect errors during shutdown
                    log.debug('Disconnect error during shutdown (ignored)', { error: e.message });
                })
            );
        }

        // Wait for all disconnects with a timeout to prevent hanging
        try {
            await Promise.race([
                Promise.all(disconnectPromises),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Disconnect timeout')), 5000)
                ),
            ]);
        } catch (e) {
            log.warn('Some connections did not disconnect cleanly', { error: e.message });
        }

        this.connections.clear();
        this.primaryEndpoint = null;
        this.isInitialized = false;

        log.info('ResilientWebSocketManager disconnected');
    }

    /**
     * Sleep utility for staggered operations
     * @private
     */
    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Mask URL for logging
     * @private
     */
    _maskUrl(url) {
        if (!url) return 'none';
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

export default ResilientWebSocketManager;
