import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import config from '../config.js';
import log from './logger.js';

/**
 * Smart RPC Manager with automatic failover, rate limiting, health checking,
 * and self-healing recovery for temporarily failed endpoints.
 */
class RPCManager extends EventEmitter {
    constructor() {
        super();

        this.httpEndpoints = config.rpc.http;
        this.wsEndpoints = config.rpc.ws;

        // HTTP providers pool
        this.httpProviders = [];
        this.currentHttpIndex = 0;

        // WebSocket providers pool
        this.wsProviders = [];
        this.currentWsIndex = 0;

        // Rate limiting
        this.requestCounts = new Map(); // endpoint -> { count, resetTime }
        this.maxRequestsPerMinute = config.rpc.maxRequestsPerMinute;

        // Health tracking
        this.endpointHealth = new Map(); // endpoint -> { healthy, lastCheck, failures, unhealthySince }

        // Self-healing configuration
        this.healingInterval = null;
        this.healingIntervalMs = 5 * 60 * 1000; // 5 minutes
        this.minRecoveryTimeMs = 60 * 1000; // Minimum 1 minute before retry

        // Initialize providers
        this.initializeProviders();

        // Start self-healing background task
        this.startSelfHealing();

        log.info(`RPC Manager initialized with ${this.httpProviders.length} HTTP and ${this.wsProviders.length} WebSocket endpoints`, {
            selfHealing: true,
            healingInterval: '5 minutes',
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

        // WebSocket Providers - with error handling
        this.wsEndpoints.forEach((endpoint, index) => {
            try {
                const provider = new ethers.WebSocketProvider(endpoint, config.network.chainId);

                // Set up error handlers immediately to prevent crashes
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

                // Also handle provider-level errors
                provider.on('error', (error) => {
                    log.debug(`Provider error on ${endpoint}: ${error.message}`);
                    this.markEndpointUnhealthy(endpoint);
                });

                this.wsProviders.push({ endpoint, provider, index });
                this.endpointHealth.set(endpoint, { healthy: true, lastCheck: Date.now(), failures: 0 });

                log.debug(`WebSocket Provider ${index} initialized: ${endpoint}`);
            } catch (error) {
                log.error(`Failed to initialize WebSocket provider ${index}: ${endpoint}`, { error: error.message });
            }
        });
    }

    /**
     * Get a healthy HTTP provider with priority for Alchemy
     */
    getHttpProvider() {
        // Priority for Alchemy
        const alchemyUrl = config.rpc.alchemy.http;
        if (alchemyUrl && this.endpointHealth.get(alchemyUrl)?.healthy) {
            const providerData = this.httpProviders.find(p => p.endpoint === alchemyUrl);
            if (providerData) return providerData;
        }

        const healthyProviders = this.httpProviders.filter(p =>
            this.endpointHealth.get(p.endpoint)?.healthy !== false
        );

        if (healthyProviders.length === 0) {
            // Reset all if none healthy
            log.warn('All HTTP providers marked unhealthy, resetting...');
            this.httpProviders.forEach(p => {
                const health = this.endpointHealth.get(p.endpoint);
                if (health) health.healthy = true;
            });
            return this.httpProviders[0];
        }

        // Round-robin for non-priority providers
        this.currentHttpIndex = (this.currentHttpIndex + 1) % healthyProviders.length;
        return healthyProviders[this.currentHttpIndex];
    }

    /**
     * Get a healthy WebSocket provider with priority for Alchemy
     */
    getWsProvider() {
        // Priority for Alchemy
        const alchemyUrl = config.rpc.alchemy.ws;
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

    /**
     * Check if we can make a request to an endpoint (rate limiting)
     */
    canMakeRequest(endpoint) {
        const now = Date.now();
        const rateLimitData = this.requestCounts.get(endpoint);

        if (!rateLimitData) {
            // First request to this endpoint
            this.requestCounts.set(endpoint, {
                count: 1,
                resetTime: now + 60000, // Reset after 1 minute
            });
            return true;
        }

        // Check if reset time has passed
        if (now > rateLimitData.resetTime) {
            rateLimitData.count = 1;
            rateLimitData.resetTime = now + 60000;
            return true;
        }

        // Check if under limit
        if (rateLimitData.count < this.maxRequestsPerMinute) {
            rateLimitData.count++;
            return true;
        }

        return false;
    }

    /**
     * Execute a function with retry logic and automatic failover
     */
    async withRetry(fn, maxRetries = config.rpc.retryAttempts) {
        let lastError = new Error('No successful RPC attempts');

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const providerData = this.getHttpProvider();
                const { provider, endpoint } = providerData;

                // Check rate limiting
                if (!this.canMakeRequest(endpoint)) {
                    log.rpc(`Rate limit reached for ${endpoint}, switching provider`);
                    lastError = new Error(`Rate limit reached for ${endpoint}`);
                    await this.sleep(config.rpc.requestDelay);
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

                log.rpc(`Request failed (attempt ${attempt + 1}/${maxRetries})`, {
                    error: error.message
                });

                // Check if it's a rate limit error
                if (error.code === 429 || error.message.includes('429') || error.message.includes('rate limit')) {
                    const providerData = this.getHttpProvider();
                    this.markEndpointUnhealthy(providerData.endpoint);
                    log.rpc(`Rate limit hit on ${providerData.endpoint}, marking unhealthy`);
                }

                // Exponential backoff
                const delay = config.rpc.retryDelay * Math.pow(2, attempt);
                await this.sleep(delay);
            }
        }

        throw new Error(`RPC request failed after ${maxRetries} attempts: ${lastError.message}`);
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

        // Collect unhealthy endpoint info
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
            ws: {
                total: this.wsProviders.length,
                healthy: this.wsProviders.filter(p => this.endpointHealth.get(p.endpoint)?.healthy !== false).length,
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

        // Close WebSocket connections
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
