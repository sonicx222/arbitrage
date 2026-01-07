import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import config from '../config.js';
import log from './logger.js';
import { ResilientWebSocketManager } from './resilientWebSocketManager.js';

/**
 * Smart RPC Manager with automatic failover, rate limiting, health checking,
 * and self-healing recovery for temporarily failed endpoints.
 *
 * Now uses ResilientWebSocketManager for WebSocket connections with:
 * - Application-level heartbeats
 * - Circuit breaker pattern
 * - Automatic failover between endpoints
 * - Connection health scoring
 *
 * v2.1 Improvements for 24/7 Operation:
 * - Request budgeting across all endpoints
 * - Smarter endpoint rotation (round-robin instead of priority)
 * - Per-request throttling with configurable delays
 * - Adaptive rate limiting based on endpoint health
 */
class RPCManager extends EventEmitter {
    constructor() {
        super();

        this.httpEndpoints = config.rpc.http;
        this.wsEndpoints = config.rpc.ws;

        // HTTP providers pool
        this.httpProviders = [];
        this.currentHttpIndex = 0;

        // WebSocket management via ResilientWebSocketManager
        this.wsManager = null;
        this.wsManagerInitialized = false;

        // Legacy: Keep wsProviders for backward compatibility during transition
        this.wsProviders = [];
        this.currentWsIndex = 0;

        // Rate limiting - v2.1: Enhanced with global budget
        this.requestCounts = new Map(); // endpoint -> { count, resetTime }
        this.maxRequestsPerMinute = config.rpc.maxRequestsPerMinute;

        // v2.1: Global request budget to prevent aggregate overload
        this.globalRequestBudget = {
            count: 0,
            resetTime: Date.now() + 60000,
            // Conservative: 80% of sum of all endpoint limits, capped at 1000/min
            maxPerMinute: Math.min(
                Math.floor((config.rpc.maxRequestsPerMinute || 300) * (config.rpc.http?.length || 1) * 0.8),
                1000
            ),
        };

        // v2.1: Request throttling for burst prevention
        this.lastRequestTime = 0;
        this.minRequestIntervalMs = config.rpc.requestDelay || 50; // Min ms between requests

        // v2.1: Cooldown tracking for rate-limited endpoints
        this.endpointCooldowns = new Map(); // endpoint -> cooldownUntil timestamp

        // Health tracking (primarily for HTTP now, WS handled by manager)
        this.endpointHealth = new Map(); // endpoint -> { healthy, lastCheck, failures, unhealthySince }

        // Self-healing configuration
        this.healingInterval = null;
        this.healingIntervalMs = 5 * 60 * 1000; // 5 minutes
        this.minRecoveryTimeMs = 60 * 1000; // Minimum 1 minute before retry

        // Initialize providers
        this.initializeProviders();

        // Start self-healing background task
        this.startSelfHealing();

        log.info(`RPC Manager initialized with ${this.httpProviders.length} HTTP and ${this.wsEndpoints.length} WebSocket endpoints`, {
            selfHealing: true,
            healingInterval: '5 minutes',
            resilientWebSocket: true,
            globalBudget: `${this.globalRequestBudget.maxPerMinute}/min`,
            throttling: `${this.minRequestIntervalMs}ms min interval`,
        });
    }

    /**
     * Initialize HTTP and WebSocket providers
     */
    initializeProviders() {
        // HTTP Providers
        this.httpEndpoints.forEach((endpoint, index) => {
            try {
                const provider = new ethers.JsonRpcProvider(endpoint);
                this.httpProviders.push({ endpoint, provider, index });
                this.endpointHealth.set(endpoint, { healthy: true, lastCheck: Date.now(), failures: 0 });
                log.debug(`HTTP Provider ${index} initialized: ${endpoint}`);
            } catch (error) {
                log.error(`Failed to initialize HTTP provider ${index}: ${endpoint}`, { error: error.message });
            }
        });

        // Initialize ResilientWebSocketManager for WebSocket connections
        // This is done lazily on first getWsProvider() call to avoid blocking constructor
        this._initWsManagerAsync();
    }

    /**
     * Initialize WebSocket manager asynchronously
     * @private
     */
    async _initWsManagerAsync() {
        if (this.wsManagerInitialized || this.wsEndpoints.length === 0) {
            return;
        }

        try {
            this.wsManager = new ResilientWebSocketManager({
                maxConcurrentConnections: Math.min(2, this.wsEndpoints.length),
                wsOptions: {
                    heartbeatIntervalMs: 15000,
                    heartbeatTimeoutMs: 5000,
                    reconnectBaseDelayMs: 1000,
                    reconnectMaxDelayMs: 30000,
                    maxReconnectAttempts: 10,
                    circuitBreakerCooldownMs: 120000,
                    proactiveRefreshMs: 30 * 60 * 1000, // Refresh every 30 min
                },
            });

            // Forward events from WS manager
            this.wsManager.on('block', (blockNumber) => {
                this.emit('block', blockNumber);
            });

            this.wsManager.on('failover', (data) => {
                log.warn('WebSocket failover occurred', data);
                this.emit('wsFailover', data);
            });

            this.wsManager.on('allEndpointsDown', () => {
                log.error('All WebSocket endpoints are down');
                this.emit('wsAllDown');
            });

            this.wsManager.on('circuitOpen', (data) => {
                this.emit('wsCircuitOpen', data);
            });

            // Initialize with configured endpoints
            await this.wsManager.initialize(this.wsEndpoints, config.network.chainId);
            this.wsManagerInitialized = true;

            log.info('ResilientWebSocketManager initialized successfully');
        } catch (error) {
            log.error('Failed to initialize ResilientWebSocketManager', { error: error.message });
            // Fall back to legacy initialization
            this._initLegacyWsProviders();
        }
    }

    /**
     * Legacy WebSocket initialization (fallback if ResilientWebSocketManager fails)
     * @private
     */
    _initLegacyWsProviders() {
        log.warn('Using legacy WebSocket initialization');

        this.wsEndpoints.forEach((endpoint, index) => {
            try {
                const provider = new ethers.WebSocketProvider(endpoint, config.network.chainId);

                // Set up error handlers
                if (provider._websocket) {
                    provider._websocket.on('error', (error) => {
                        log.debug(`WebSocket error on ${endpoint}: ${error.message}`);
                        this.markEndpointUnhealthy(endpoint);
                    });

                    provider._websocket.on('close', () => {
                        log.debug(`WebSocket closed: ${endpoint}`);
                        this.markEndpointUnhealthy(endpoint);
                    });
                }

                provider.on('error', (error) => {
                    log.debug(`Provider error on ${endpoint}: ${error.message}`);
                    this.markEndpointUnhealthy(endpoint);
                });

                this.wsProviders.push({ endpoint, provider, index });
                this.endpointHealth.set(endpoint, { healthy: true, lastCheck: Date.now(), failures: 0 });

                log.debug(`Legacy WebSocket Provider ${index} initialized: ${endpoint}`);
            } catch (error) {
                log.error(`Failed to initialize WebSocket provider ${index}`, { error: error.message });
            }
        });
    }

    /**
     * Get a healthy HTTP provider with smart load distribution (v2.1)
     *
     * Strategy: Round-robin across ALL healthy providers to distribute load,
     * instead of always prioritizing Alchemy which causes rate limit hits.
     *
     * Providers are filtered by:
     * 1. Health status (not marked unhealthy)
     * 2. Not in cooldown (recently rate-limited)
     * 3. Under per-endpoint rate limit
     */
    getHttpProvider() {
        const now = Date.now();

        // Get all providers not in cooldown and healthy
        const availableProviders = this.httpProviders.filter(p => {
            const health = this.endpointHealth.get(p.endpoint);
            const cooldownUntil = this.endpointCooldowns.get(p.endpoint) || 0;

            // Skip if unhealthy or in cooldown
            if (health?.healthy === false) return false;
            if (now < cooldownUntil) return false;

            // Skip if at rate limit (but don't mark unhealthy yet)
            if (!this.canMakeRequest(p.endpoint, false)) return false;

            return true;
        });

        if (availableProviders.length === 0) {
            // Try to find ANY provider that's at least healthy (ignore rate limits)
            const healthyProviders = this.httpProviders.filter(p =>
                this.endpointHealth.get(p.endpoint)?.healthy !== false
            );

            if (healthyProviders.length > 0) {
                // Clear cooldowns and reset rate limits - emergency recovery
                log.warn('All providers at rate limit, emergency reset...');
                this.endpointCooldowns.clear();
                this.requestCounts.clear();

                // Return first healthy, will wait if needed via throttle
                return healthyProviders[0];
            }

            // Last resort: reset all health status
            log.warn('All HTTP providers marked unhealthy, resetting all...');
            this.httpProviders.forEach(p => {
                const health = this.endpointHealth.get(p.endpoint);
                if (health) {
                    health.healthy = true;
                    health.failures = 0;
                }
            });
            this.endpointCooldowns.clear();
            this.requestCounts.clear();
            return this.httpProviders[0];
        }

        // v2.1: True round-robin across ALL available providers
        // This spreads load evenly instead of hammering Alchemy first
        this.currentHttpIndex = (this.currentHttpIndex + 1) % availableProviders.length;
        return availableProviders[this.currentHttpIndex];
    }

    /**
     * Get a healthy WebSocket provider
     * Uses ResilientWebSocketManager for automatic failover and health management
     * @returns {Object|null} { provider, endpoint, index } or null
     */
    getWsProvider() {
        // Use ResilientWebSocketManager if initialized
        if (this.wsManagerInitialized && this.wsManager) {
            return this.wsManager.getWsProvider();
        }

        // Fallback to legacy providers if manager not ready
        if (this.wsProviders.length > 0) {
            // Priority for Alchemy
            const alchemyUrl = config.rpc?.alchemy?.ws;
            if (alchemyUrl && this.endpointHealth.get(alchemyUrl)?.healthy) {
                const providerData = this.wsProviders.find(p => p.endpoint === alchemyUrl);
                if (providerData) return providerData;
            }

            const healthyProviders = this.wsProviders.filter(p =>
                this.endpointHealth.get(p.endpoint)?.healthy !== false
            );

            if (healthyProviders.length === 0) {
                log.warn('All WebSocket providers marked unhealthy, resetting...');
                this.wsProviders.forEach(p => {
                    const health = this.endpointHealth.get(p.endpoint);
                    if (health) health.healthy = true;
                });
                return this.wsProviders[0];
            }

            return healthyProviders[0];
        }

        return null;
    }

    /**
     * Ensure WebSocket manager is initialized
     * Call this before operations that require WebSocket
     * @returns {Promise<boolean>} true if manager is ready
     */
    async ensureWsReady() {
        if (this.wsManagerInitialized) {
            return true;
        }

        // Wait for async initialization with timeout
        const maxWait = 10000;
        const startTime = Date.now();

        while (!this.wsManagerInitialized && Date.now() - startTime < maxWait) {
            await this.sleep(100);
        }

        return this.wsManagerInitialized;
    }

    /**
     * Check if we can make a request to an endpoint (rate limiting)
     * v2.1: Enhanced with global budget tracking and optional increment
     *
     * @param {string} endpoint - The endpoint URL to check
     * @param {boolean} incrementCount - Whether to increment the counter (default: true)
     * @returns {boolean} - Whether the request can proceed
     */
    canMakeRequest(endpoint, incrementCount = true) {
        const now = Date.now();

        // v2.1: Check global budget first
        if (now > this.globalRequestBudget.resetTime) {
            // Reset global budget
            this.globalRequestBudget.count = 0;
            this.globalRequestBudget.resetTime = now + 60000;
        }

        if (this.globalRequestBudget.count >= this.globalRequestBudget.maxPerMinute) {
            log.rpc('Global request budget exhausted, throttling...', {
                count: this.globalRequestBudget.count,
                max: this.globalRequestBudget.maxPerMinute,
            });
            return false;
        }

        // Check per-endpoint rate limit
        const rateLimitData = this.requestCounts.get(endpoint);

        if (!rateLimitData) {
            // First request to this endpoint
            if (incrementCount) {
                this.requestCounts.set(endpoint, {
                    count: 1,
                    resetTime: now + 60000, // Reset after 1 minute
                });
                this.globalRequestBudget.count++;
            }
            return true;
        }

        // Check if reset time has passed
        if (now > rateLimitData.resetTime) {
            if (incrementCount) {
                rateLimitData.count = 1;
                rateLimitData.resetTime = now + 60000;
                this.globalRequestBudget.count++;
            }
            return true;
        }

        // Check if under limit
        if (rateLimitData.count < this.maxRequestsPerMinute) {
            if (incrementCount) {
                rateLimitData.count++;
                this.globalRequestBudget.count++;
            }
            return true;
        }

        return false;
    }

    /**
     * Set cooldown for an endpoint (v2.1)
     * Used when rate limit errors are received
     *
     * @param {string} endpoint - The endpoint URL
     * @param {number} cooldownMs - Cooldown duration in milliseconds
     */
    setEndpointCooldown(endpoint, cooldownMs = 60000) {
        const cooldownUntil = Date.now() + cooldownMs;
        this.endpointCooldowns.set(endpoint, cooldownUntil);
        log.rpc(`Endpoint ${this._maskEndpoint(endpoint)} in cooldown for ${cooldownMs / 1000}s`);
    }

    /**
     * Apply request throttling (v2.1)
     * Ensures minimum time between requests to prevent bursts
     *
     * @returns {Promise<void>}
     */
    async throttle() {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;

        if (timeSinceLastRequest < this.minRequestIntervalMs) {
            const waitTime = this.minRequestIntervalMs - timeSinceLastRequest;
            await this.sleep(waitTime);
        }

        this.lastRequestTime = Date.now();
    }

    /**
     * Execute a function with retry logic and automatic failover
     * v2.1: Enhanced with throttling and smarter rate limit handling
     */
    async withRetry(fn, maxRetries = config.rpc.retryAttempts) {
        let lastError = new Error('No successful RPC attempts');
        let currentProviderData = null; // Track provider for error handling

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                // v2.1: Apply throttling between requests
                await this.throttle();

                currentProviderData = this.getHttpProvider();
                const { provider, endpoint } = currentProviderData;

                // Check rate limiting (count already incremented via getHttpProvider check)
                if (!this.canMakeRequest(endpoint)) {
                    log.rpc(`Rate limit reached for ${this._maskEndpoint(endpoint)}, switching provider`);
                    lastError = new Error(`Rate limit reached for ${endpoint}`);
                    await this.sleep(config.rpc.requestDelay * 2); // Longer wait on rate limit
                    continue;
                }

                // Execute the function
                const result = await fn(provider);

                // Mark endpoint as healthy on success
                const health = this.endpointHealth.get(endpoint);
                if (health) {
                    health.healthy = true;
                    health.failures = 0;
                }

                return result;

            } catch (error) {
                lastError = error;

                // Get the endpoint that was actually used for this failed request
                const failedEndpoint = currentProviderData?.endpoint;

                log.rpc(`Request failed (attempt ${attempt + 1}/${maxRetries})`, {
                    error: error.message,
                    endpoint: failedEndpoint ? this._maskEndpoint(failedEndpoint) : 'unknown',
                });

                // v2.1: Enhanced rate limit detection and handling
                const isRateLimitError = this._isRateLimitError(error);

                if (failedEndpoint && isRateLimitError) {
                    // v2.1: Put endpoint in cooldown instead of just marking unhealthy
                    // This allows recovery without full 5-minute healing cycle
                    this.setEndpointCooldown(failedEndpoint, 60000); // 1 minute cooldown
                    this.markEndpointUnhealthy(failedEndpoint);
                    log.rpc(`Rate limit hit on ${this._maskEndpoint(failedEndpoint)}, cooldown activated`);

                    // Wait longer on rate limit errors
                    const delay = config.rpc.retryDelay * Math.pow(2, attempt + 1);
                    await this.sleep(delay);
                    continue;
                }

                // Exponential backoff for other errors
                const delay = config.rpc.retryDelay * Math.pow(2, attempt);
                await this.sleep(delay);
            }
        }

        throw new Error(`RPC request failed after ${maxRetries} attempts: ${lastError.message}`);
    }

    /**
     * Check if an error is a rate limit error (v2.1)
     * @private
     */
    _isRateLimitError(error) {
        if (!error) return false;

        // Check error code
        if (error.code === 429) return true;

        // Check error message
        const msg = error.message?.toLowerCase() || '';
        return msg.includes('429') ||
               msg.includes('rate limit') ||
               msg.includes('too many requests') ||
               msg.includes('quota exceeded') ||
               msg.includes('capacity exceeded');
    }

    /**
     * Mark an endpoint as unhealthy
     */
    markEndpointUnhealthy(endpoint) {
        const health = this.endpointHealth.get(endpoint);
        if (health) {
            health.failures++;
            if (health.failures >= 3 && health.healthy) {
                health.healthy = false;
                health.unhealthySince = Date.now();
                log.warn(`Endpoint marked unhealthy: ${endpoint}`, {
                    failures: health.failures,
                    willRetryIn: `${this.healingIntervalMs / 60000} minutes`,
                });
                this.emit('endpointUnhealthy', endpoint);
            }
        }
    }

    /**
     * Start the self-healing background task
     * Periodically re-tests unhealthy endpoints to check if they've recovered
     */
    startSelfHealing() {
        if (this.healingInterval) {
            clearInterval(this.healingInterval);
        }

        this.healingInterval = setInterval(() => {
            this.healUnhealthyEndpoints();
        }, this.healingIntervalMs);

        // Don't prevent process exit
        this.healingInterval.unref();

        log.debug('Self-healing background task started');
    }

    /**
     * Stop the self-healing background task
     */
    stopSelfHealing() {
        if (this.healingInterval) {
            clearInterval(this.healingInterval);
            this.healingInterval = null;
            log.debug('Self-healing background task stopped');
        }
    }

    /**
     * Attempt to heal unhealthy endpoints by re-testing them
     */
    async healUnhealthyEndpoints() {
        const now = Date.now();
        const unhealthyEndpoints = [];

        // Find endpoints that have been unhealthy long enough to retry
        this.endpointHealth.forEach((health, endpoint) => {
            if (!health.healthy && health.unhealthySince) {
                const timeSinceUnhealthy = now - health.unhealthySince;
                if (timeSinceUnhealthy >= this.minRecoveryTimeMs) {
                    unhealthyEndpoints.push(endpoint);
                }
            }
        });

        if (unhealthyEndpoints.length === 0) {
            return;
        }

        log.debug(`Self-healing: Testing ${unhealthyEndpoints.length} unhealthy endpoints`);

        for (const endpoint of unhealthyEndpoints) {
            await this.testEndpointHealth(endpoint);
        }
    }

    /**
     * Test if an endpoint has recovered by making a simple RPC call
     */
    async testEndpointHealth(endpoint) {
        const providerData = this.httpProviders.find(p => p.endpoint === endpoint) ||
                            this.wsProviders.find(p => p.endpoint === endpoint);

        if (!providerData) {
            return false;
        }

        try {
            // Simple health check: get block number
            const blockNumber = await Promise.race([
                providerData.provider.getBlockNumber(),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Health check timeout')), 5000)
                ),
            ]);

            if (blockNumber > 0) {
                // Endpoint recovered!
                const health = this.endpointHealth.get(endpoint);
                if (health) {
                    health.healthy = true;
                    health.failures = 0;
                    health.lastCheck = Date.now();
                    delete health.unhealthySince;
                }

                log.info(`Self-healing: Endpoint recovered: ${this._maskEndpoint(endpoint)}`, {
                    blockNumber,
                });
                this.emit('endpointRecovered', endpoint);
                return true;
            }
        } catch (error) {
            // Still unhealthy, update last check time
            const health = this.endpointHealth.get(endpoint);
            if (health) {
                health.lastCheck = Date.now();
            }

            log.debug(`Self-healing: Endpoint still unhealthy: ${this._maskEndpoint(endpoint)}`, {
                error: error.message,
            });
        }

        return false;
    }

    /**
     * Mask endpoint URL for logging (hide API keys)
     * @private
     */
    _maskEndpoint(endpoint) {
        try {
            const url = new URL(endpoint);
            // Mask API key if present in path or query
            if (url.pathname.length > 20) {
                url.pathname = url.pathname.substring(0, 20) + '...';
            }
            return `${url.protocol}//${url.host}${url.pathname.substring(0, 15)}...`;
        } catch {
            return endpoint.substring(0, 30) + '...';
        }
    }

    /**
     * Force re-test all unhealthy endpoints immediately
     */
    async forceHealAll() {
        log.info('Force healing all unhealthy endpoints');
        await this.healUnhealthyEndpoints();
    }

    /**
     * Get current RPC statistics
     */
    getStats() {
        const now = Date.now();
        const unhealthyEndpoints = [];

        // Collect unhealthy HTTP endpoint info
        this.endpointHealth.forEach((health, endpoint) => {
            if (!health.healthy) {
                unhealthyEndpoints.push({
                    endpoint: this._maskEndpoint(endpoint),
                    failures: health.failures,
                    unhealthyFor: health.unhealthySince
                        ? Math.round((now - health.unhealthySince) / 1000) + 's'
                        : 'unknown',
                });
            }
        });

        const stats = {
            http: {
                total: this.httpProviders.length,
                healthy: this.httpProviders.filter(p => this.endpointHealth.get(p.endpoint)?.healthy !== false).length,
            },
            ws: this.wsManagerInitialized && this.wsManager
                ? this.wsManager.getStatus()
                : {
                    total: this.wsProviders.length,
                    healthy: this.wsProviders.filter(p => this.endpointHealth.get(p.endpoint)?.healthy !== false).length,
                    legacy: true,
                },
            selfHealing: {
                enabled: this.healingInterval !== null,
                intervalMs: this.healingIntervalMs,
                unhealthyEndpoints: unhealthyEndpoints.length,
            },
            rateLimits: {},
        };

        // Add unhealthy endpoint details if any
        if (unhealthyEndpoints.length > 0) {
            stats.selfHealing.endpoints = unhealthyEndpoints;
        }

        // Add rate limit info
        this.requestCounts.forEach((data, endpoint) => {
            stats.rateLimits[this._maskEndpoint(endpoint)] = {
                count: data.count,
                remaining: this.maxRequestsPerMinute - data.count,
                resetIn: Math.max(0, data.resetTime - Date.now()),
            };
        });

        return stats;
    }

    /**
     * Get current gas price from network
     * Caches result to avoid redundant calls within the same block
     */
    async getGasPrice() {
        const now = Date.now();

        // Return cached value if fresh (less than 3 seconds old)
        if (this.cachedGasPrice && (now - this.lastGasUpdate < 3000)) {
            return this.cachedGasPrice;
        }

        try {
            const gasPrice = await this.withRetry(async (provider) => {
                const feeData = await provider.getFeeData();
                return feeData.gasPrice;
            });

            this.cachedGasPrice = gasPrice;
            this.lastGasUpdate = now;

            return gasPrice;
        } catch (error) {
            log.error('Failed to fetch gas price', { error: error.message });
            // Fallback to config if RPC fails
            return ethers.parseUnits(config.trading.gasPriceGwei.toString(), 'gwei');
        }
    }

    /**
     * Sleep utility
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Cleanup resources
     */
    async cleanup() {
        log.info('Cleaning up RPC Manager...');

        // Stop self-healing
        this.stopSelfHealing();

        // Disconnect WebSocket manager if using resilient mode
        if (this.wsManager) {
            try {
                await this.wsManager.disconnect();
            } catch (error) {
                log.error('Error disconnecting WebSocket manager', { error: error.message });
            }
        }

        // Close legacy WebSocket connections if any
        for (const { provider } of this.wsProviders) {
            try {
                await provider.destroy();
            } catch (error) {
                log.error('Error closing WebSocket provider', { error: error.message });
            }
        }
    }
}

// Export singleton instance
const rpcManager = new RPCManager();
export default rpcManager;
