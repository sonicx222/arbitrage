import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import config from '../config.js';
import log from './logger.js';
import { ResilientWebSocketManager } from './resilientWebSocketManager.js';
import gasPriceCache from './gasPriceCache.js';

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
    /**
     * Create an RPC Manager instance
     * FIX v3.3: Accept optional chainConfig for multi-chain support
     * @param {Object} chainConfig - Optional chain-specific config (defaults to main config for BSC)
     */
    constructor(chainConfig = null) {
        super();

        // FIX v3.3: Use chain-specific config if provided, otherwise default to main config
        const rpcConfig = chainConfig?.rpc || config.rpc;
        const networkConfig = chainConfig || config.network || config;

        this.chainId = networkConfig.chainId || config.network?.chainId || 56;
        this.chainName = networkConfig.name || config.network?.name || 'Unknown Chain';

        this.httpEndpoints = rpcConfig.http || [];
        this.wsEndpoints = rpcConfig.ws || [];

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
        this.maxRequestsPerMinute = rpcConfig.maxRequestsPerMinute || 300;

        // v2.1: Global request budget to prevent aggregate overload
        this.globalRequestBudget = {
            count: 0,
            resetTime: Date.now() + 60000,
            // Conservative: 80% of sum of all endpoint limits, capped at 1000/min
            maxPerMinute: Math.min(
                Math.floor((rpcConfig.maxRequestsPerMinute || 300) * (this.httpEndpoints.length || 1) * 0.8),
                1000
            ),
        };

        // v2.1: Request throttling for burst prevention
        this.lastRequestTime = 0;
        this.minRequestIntervalMs = rpcConfig.requestDelay || 50; // Min ms between requests

        // v2.1: Cooldown tracking for rate-limited endpoints
        this.endpointCooldowns = new Map(); // endpoint -> cooldownUntil timestamp

        // FIX v3.8: Monthly capacity tracking for Alchemy endpoints
        // When monthly limit is hit, we need much longer cooldowns (hours, not minutes)
        this.monthlyLimitEndpoints = new Map(); // endpoint -> timestamp when monthly limit detected

        // FIX v3.8: Alchemy endpoint identification for special handling
        this.alchemyEndpoints = new Set();

        // FIX v3.7: Pending request tracking for atomic rate limiting
        // Tracks requests that are reserved but not yet completed
        this.pendingRequests = new Map(); // endpoint -> count of pending requests

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

        // FIX v3.3: Include chain context in log
        log.info(`[${this.chainName}] RPC Manager initialized with ${this.httpProviders.length} HTTP and ${this.wsEndpoints.length} WebSocket endpoints`, {
            chainId: this.chainId,
            chainName: this.chainName,
            selfHealing: true,
            healingInterval: '5 minutes',
            resilientWebSocket: true,
            globalBudget: `${this.globalRequestBudget.maxPerMinute}/min`,
            throttling: `${this.minRequestIntervalMs}ms min interval`,
        });
    }

    /**
     * Initialize HTTP and WebSocket providers
     * FIX v3.8: Identify Alchemy endpoints for special rate limit handling
     */
    initializeProviders() {
        // HTTP Providers - FIX v3.8: Reorder to prioritize free/public nodes
        // Sort endpoints: public nodes first, Alchemy last (to preserve monthly quota)
        const sortedEndpoints = [...this.httpEndpoints].sort((a, b) => {
            const aIsAlchemy = a.includes('alchemy.com');
            const bIsAlchemy = b.includes('alchemy.com');
            if (aIsAlchemy && !bIsAlchemy) return 1; // Alchemy goes to end
            if (!aIsAlchemy && bIsAlchemy) return -1;
            return 0;
        });

        sortedEndpoints.forEach((endpoint, index) => {
            try {
                const provider = new ethers.JsonRpcProvider(endpoint);
                this.httpProviders.push({ endpoint, provider, index });
                this.endpointHealth.set(endpoint, { healthy: true, lastCheck: Date.now(), failures: 0 });

                // FIX v3.8: Track Alchemy endpoints for special handling
                if (endpoint.includes('alchemy.com')) {
                    this.alchemyEndpoints.add(endpoint);
                    log.debug(`Alchemy endpoint registered (will be used conservatively): ${this._maskEndpoint(endpoint)}`);
                }

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

            // FIX v3.3: Pass chainId and chainName for proper multi-chain logging
            await this.wsManager.initialize(this.wsEndpoints, this.chainId, this.chainName);
            this.wsManagerInitialized = true;

            log.debug(`[${this.chainName}] ResilientWebSocketManager ready`, {
                chainId: this.chainId,
            });
        } catch (error) {
            log.error('Failed to initialize ResilientWebSocketManager', { error: error.message });
            // Fall back to legacy initialization
            this._initLegacyWsProviders();
        }
    }

    /**
     * Legacy WebSocket initialization (fallback if ResilientWebSocketManager fails)
     * FIX v3.6: Store handler references for proper cleanup
     * @private
     */
    _initLegacyWsProviders() {
        log.warn(`[${this.chainName}] Using legacy WebSocket initialization`);

        this.wsEndpoints.forEach((endpoint, index) => {
            try {
                // FIX v3.3: Use instance chainId instead of global config
                const provider = new ethers.WebSocketProvider(endpoint, this.chainId);

                // FIX v3.6: Create named handlers so they can be removed on cleanup
                const handlers = {
                    wsError: (error) => {
                        log.debug(`WebSocket error on ${endpoint}: ${error.message}`);
                        this.markEndpointUnhealthy(endpoint);
                    },
                    wsClose: () => {
                        log.debug(`WebSocket closed: ${endpoint}`);
                        this.markEndpointUnhealthy(endpoint);
                    },
                    providerError: (error) => {
                        log.debug(`Provider error on ${endpoint}: ${error.message}`);
                        this.markEndpointUnhealthy(endpoint);
                    },
                };

                // Set up error handlers
                if (provider._websocket) {
                    provider._websocket.on('error', handlers.wsError);
                    provider._websocket.on('close', handlers.wsClose);
                }

                provider.on('error', handlers.providerError);

                // FIX v3.6: Store handlers reference for cleanup
                this.wsProviders.push({ endpoint, provider, index, handlers });
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
     * FIX v3.8: Enhanced to:
     * - Avoid Alchemy endpoints when monthly limit is reached
     * - Prioritize public/free endpoints over paid Alchemy
     * - Apply longer cooldowns for Alchemy rate limits
     *
     * Providers are filtered by:
     * 1. Health status (not marked unhealthy)
     * 2. Not in cooldown (recently rate-limited)
     * 3. Under per-endpoint rate limit
     * 4. FIX v3.8: Not at monthly capacity limit
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

            // FIX v3.8: Skip Alchemy endpoints that hit monthly capacity
            // These need to be avoided for much longer (24 hours)
            const monthlyLimitTime = this.monthlyLimitEndpoints.get(p.endpoint);
            if (monthlyLimitTime) {
                const hoursSinceLimitHit = (now - monthlyLimitTime) / (1000 * 60 * 60);
                if (hoursSinceLimitHit < 24) {
                    return false; // Skip for 24 hours after monthly limit
                } else {
                    // Clear the monthly limit flag after 24 hours
                    this.monthlyLimitEndpoints.delete(p.endpoint);
                }
            }

            // Skip if at rate limit (but don't mark unhealthy yet)
            if (!this.canMakeRequest(p.endpoint, false)) return false;

            return true;
        });

        // FIX v3.8: Prefer non-Alchemy providers when both are available
        // This helps preserve Alchemy monthly quota
        const nonAlchemyProviders = availableProviders.filter(p => !this.alchemyEndpoints.has(p.endpoint));
        const providersToUse = nonAlchemyProviders.length > 0 ? nonAlchemyProviders : availableProviders;

        if (providersToUse.length === 0) {
            // Try to find ANY provider that's at least healthy (ignore rate limits)
            // FIX v3.8: But still skip monthly-limited Alchemy endpoints
            const healthyProviders = this.httpProviders.filter(p => {
                if (this.endpointHealth.get(p.endpoint)?.healthy === false) return false;
                // Don't include monthly-limited Alchemy in emergency recovery
                if (this.monthlyLimitEndpoints.has(p.endpoint)) return false;
                return true;
            });

            if (healthyProviders.length > 0) {
                // Clear cooldowns and reset rate limits - emergency recovery
                log.warn('All providers at rate limit, emergency reset...');
                this.endpointCooldowns.clear();
                this.requestCounts.clear();

                // FIX v3.8: Prefer non-Alchemy even in emergency
                const emergencyNonAlchemy = healthyProviders.filter(p => !this.alchemyEndpoints.has(p.endpoint));
                return emergencyNonAlchemy.length > 0 ? emergencyNonAlchemy[0] : healthyProviders[0];
            }

            // Last resort: reset all health status (but keep monthly limits)
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

            // FIX v3.8: Still prefer non-monthly-limited providers
            const resetProviders = this.httpProviders.filter(p => !this.monthlyLimitEndpoints.has(p.endpoint));
            return resetProviders.length > 0 ? resetProviders[0] : this.httpProviders[0];
        }

        // v2.1 FIX: True round-robin across ALL available providers
        // Use global counter modulo available length to handle dynamic provider availability
        // The counter increments globally, but we always select based on current available set
        const selectedIndex = this.currentHttpIndex % providersToUse.length;
        this.currentHttpIndex++;

        // Prevent counter overflow (reset when very large)
        if (this.currentHttpIndex > 1000000) {
            this.currentHttpIndex = 0;
        }

        return providersToUse[selectedIndex];
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
     * FIX v3.7: Proper atomic reservation system to prevent TOCTOU race conditions
     * Uses pending request tracking to account for in-flight requests.
     * When checking without increment, considers both completed and pending requests.
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

        // FIX v3.7: Calculate total requests including pending (in-flight) requests
        const globalPending = this._getTotalPendingRequests();
        const effectiveGlobalCount = this.globalRequestBudget.count + globalPending;

        if (effectiveGlobalCount >= this.globalRequestBudget.maxPerMinute) {
            if (incrementCount) {
                log.rpc('Global request budget exhausted (including pending)', {
                    completed: this.globalRequestBudget.count,
                    pending: globalPending,
                    max: this.globalRequestBudget.maxPerMinute,
                });
            }
            return false;
        }

        // Check per-endpoint rate limit
        let rateLimitData = this.requestCounts.get(endpoint);

        // FIX v3.6: Atomic initialization - always create entry to prevent race
        if (!rateLimitData) {
            rateLimitData = {
                count: 0,
                resetTime: now + 60000, // Reset after 1 minute
            };
            this.requestCounts.set(endpoint, rateLimitData);
        }

        // Check if reset time has passed
        if (now > rateLimitData.resetTime) {
            rateLimitData.count = 0;
            rateLimitData.resetTime = now + 60000;
            // FIX v3.7: Also reset pending count on time reset
            this.pendingRequests.delete(endpoint);
        }

        // FIX v3.7: Calculate effective count including pending requests for this endpoint
        const endpointPending = this.pendingRequests.get(endpoint) || 0;
        const effectiveEndpointCount = rateLimitData.count + endpointPending;

        if (effectiveEndpointCount < this.maxRequestsPerMinute) {
            if (incrementCount) {
                // FIX v3.7: Increment pending count immediately (reservation)
                // This will be moved to completed count when request finishes
                this.pendingRequests.set(endpoint, endpointPending + 1);
            }
            return true;
        }

        return false;
    }

    /**
     * Complete a request reservation - move from pending to completed
     * FIX v3.7: Call this after a request completes (success or failure)
     *
     * @param {string} endpoint - The endpoint URL
     * @param {boolean} success - Whether the request succeeded
     */
    completeRequest(endpoint, success = true) {
        // Decrement pending count
        const pending = this.pendingRequests.get(endpoint) || 0;
        if (pending > 0) {
            this.pendingRequests.set(endpoint, pending - 1);
        }

        // Increment completed count on success
        if (success) {
            const rateLimitData = this.requestCounts.get(endpoint);
            if (rateLimitData) {
                rateLimitData.count++;
            }
            this.globalRequestBudget.count++;
        }
    }

    /**
     * Cancel a request reservation (request was not actually made)
     * FIX v3.7: Use this when a reserved request is cancelled
     *
     * @param {string} endpoint - The endpoint URL
     */
    cancelRequestReservation(endpoint) {
        const pending = this.pendingRequests.get(endpoint) || 0;
        if (pending > 0) {
            this.pendingRequests.set(endpoint, pending - 1);
        }
    }

    /**
     * Get total pending requests across all endpoints
     * @private
     * @returns {number}
     */
    _getTotalPendingRequests() {
        let total = 0;
        for (const count of this.pendingRequests.values()) {
            total += count;
        }
        return total;
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
     * FIX v3.7: Uses atomic request reservation system
     * FIX v3.9: Immediate rollover on rate limits - don't waste retries on 429s
     */
    async withRetry(fn, maxRetries = config.rpc.retryAttempts) {
        let lastError = new Error('No successful RPC attempts');
        let currentProviderData = null; // Track provider for error handling
        let reservedEndpoint = null; // FIX v3.7: Track reserved endpoint for cleanup
        let rateLimitRollovers = 0; // FIX v3.9: Track consecutive rate limit rollovers

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                // v2.1: Apply throttling between requests
                await this.throttle();

                currentProviderData = this.getHttpProvider();
                const { provider, endpoint } = currentProviderData;

                // FIX v3.7: Make reservation atomically
                // Check rate limiting and reserve slot in one operation
                if (!this.canMakeRequest(endpoint, true)) {
                    log.rpc(`Rate limit reached for ${this._maskEndpoint(endpoint)}, switching provider`);
                    lastError = new Error(`Rate limit reached for ${endpoint}`);
                    await this.sleep(config.rpc.requestDelay * 2); // Longer wait on rate limit
                    continue;
                }

                // FIX v3.7: Track reserved endpoint for cleanup on error
                reservedEndpoint = endpoint;

                // Execute the function
                const result = await fn(provider);

                // FIX v3.7: Complete the reservation on success
                this.completeRequest(endpoint, true);
                reservedEndpoint = null;

                // Mark endpoint as healthy on success
                const health = this.endpointHealth.get(endpoint);
                if (health) {
                    health.healthy = true;
                    health.failures = 0;
                }

                // FIX v3.9: Reset rollover counter on success
                rateLimitRollovers = 0;

                return result;

            } catch (error) {
                lastError = error;

                // Get the endpoint that was actually used for this failed request
                const failedEndpoint = currentProviderData?.endpoint;

                // FIX v3.7: Complete the reservation on failure (still counts against rate limit)
                if (reservedEndpoint) {
                    this.completeRequest(reservedEndpoint, false);
                    reservedEndpoint = null;
                }

                // v2.1: Enhanced rate limit detection and handling
                const isRateLimitError = this._isRateLimitError(error);
                // FIX v3.8: Detect monthly capacity errors separately
                const isMonthlyLimit = this._isMonthlyCapacityError(error);

                if (failedEndpoint && isMonthlyLimit) {
                    // FIX v3.8: Monthly capacity limit - needs very long cooldown
                    // Mark endpoint as monthly-limited (24 hour exclusion)
                    this.monthlyLimitEndpoints.set(failedEndpoint, Date.now());
                    this.setEndpointCooldown(failedEndpoint, 24 * 60 * 60 * 1000); // 24 hours
                    this.markEndpointUnhealthy(failedEndpoint);
                    log.error(`⚠️ Monthly capacity limit hit on ${this._maskEndpoint(failedEndpoint)}! Endpoint disabled for 24h`, {
                        endpoint: this._maskEndpoint(failedEndpoint),
                        isAlchemy: this.alchemyEndpoints.has(failedEndpoint),
                        recommendation: 'Consider upgrading Alchemy plan or adding more RPC endpoints',
                    });

                    // FIX v3.9: Don't count monthly limits against retry attempts
                    // Immediately roll to next provider without penalty
                    attempt--;
                    continue;
                }

                if (failedEndpoint && isRateLimitError) {
                    // FIX v3.9: IMMEDIATE ROLLOVER - put in cooldown and switch instantly
                    // Don't waste retry attempts on rate-limited endpoints
                    const cooldownMs = this.alchemyEndpoints.has(failedEndpoint)
                        ? 5 * 60 * 1000  // 5 minutes for Alchemy
                        : 30 * 1000;      // FIX v3.9: Reduced to 30s for faster recovery
                    this.setEndpointCooldown(failedEndpoint, cooldownMs);

                    rateLimitRollovers++;

                    log.rpc(`🔄 Rate limit rollover ${rateLimitRollovers}: ${this._maskEndpoint(failedEndpoint)} → next provider (${cooldownMs/1000}s cooldown)`);

                    // FIX v3.9: Don't count rate limit rollovers against retry attempts
                    // as long as we have other providers available
                    const availableProviders = this.httpProviders.filter(p => {
                        const cooldownUntil = this.endpointCooldowns.get(p.endpoint) || 0;
                        return Date.now() >= cooldownUntil;
                    }).length;

                    if (availableProviders > 0 && rateLimitRollovers < this.httpProviders.length) {
                        // Still have providers available - don't count this as a retry
                        attempt--;
                        // Minimal delay - just switch to next provider
                        await this.sleep(50);
                    } else {
                        // All providers rate-limited or too many rollovers
                        // Wait before actual retry
                        log.warn(`All providers rate-limited, waiting before retry...`, {
                            rateLimitRollovers,
                            availableProviders,
                        });
                        const delay = config.rpc.retryDelay * Math.pow(2, attempt);
                        await this.sleep(delay);
                    }
                    continue;
                }

                log.rpc(`Request failed (attempt ${attempt + 1}/${maxRetries})`, {
                    error: error.message,
                    endpoint: failedEndpoint ? this._maskEndpoint(failedEndpoint) : 'unknown',
                });

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
               msg.includes('capacity exceeded') ||
               msg.includes('monthly capacity');
    }

    /**
     * FIX v3.8: Check if an error indicates monthly capacity limit (Alchemy-specific)
     * Monthly limits require much longer cooldowns than per-minute rate limits
     * @private
     */
    _isMonthlyCapacityError(error) {
        if (!error) return false;

        const msg = error.message?.toLowerCase() || '';
        return msg.includes('monthly capacity') ||
               msg.includes('monthly limit') ||
               msg.includes('upgrade your scaling policy') ||
               msg.includes('billing') ||
               // Alchemy-specific patterns from the error logs
               (msg.includes('capacity limit exceeded') && msg.includes('dashboard.alchemy.com'));
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
     *
     * FIX v3.2: Also cleans up expired cooldowns to prevent Map accumulation
     */
    async healUnhealthyEndpoints() {
        const now = Date.now();
        const unhealthyEndpoints = [];

        // FIX v3.2: Cleanup expired cooldowns during healing cycle
        // Collect expired cooldown keys first to avoid mutation during iteration
        const expiredCooldowns = [];
        for (const [endpoint, cooldownUntil] of this.endpointCooldowns) {
            if (now > cooldownUntil) {
                expiredCooldowns.push(endpoint);
            }
        }
        for (const endpoint of expiredCooldowns) {
            this.endpointCooldowns.delete(endpoint);
        }

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
     * SPEED OPT v3.6: Uses shared gasPriceCache for cross-component efficiency
     * - Eliminates redundant RPC calls across detection/execution phases
     * - Request coalescing prevents concurrent fetches
     * - Expected improvement: -100-200ms per detection cycle
     */
    async getGasPrice() {
        try {
            // SPEED OPT: Use shared cache with request coalescing
            // This eliminates throttle delay for cached values
            const cached = await gasPriceCache.getGasPrice(async () => {
                // Only hit RPC when cache is stale
                return await this.withRetry(async (provider) => {
                    return await provider.getFeeData();
                });
            });

            return cached.gasPrice;
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
     * FIX v3.6: Properly remove event handlers before destroying providers
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

        // FIX v3.6: Remove handlers and close legacy WebSocket connections
        for (const { provider, handlers } of this.wsProviders) {
            try {
                // Remove event handlers to prevent memory leaks
                if (handlers) {
                    if (provider._websocket) {
                        provider._websocket.off('error', handlers.wsError);
                        provider._websocket.off('close', handlers.wsClose);
                    }
                    provider.off('error', handlers.providerError);
                }
                await provider.destroy();
            } catch (error) {
                log.error('Error closing WebSocket provider', { error: error.message });
            }
        }

        // Clear the providers array
        this.wsProviders = [];
    }
}

// Export singleton instance (for backward compatibility with BSC)
const rpcManager = new RPCManager();
export default rpcManager;

// FIX v3.3: Export class for multi-chain support (each chain creates its own instance)
export { RPCManager };
