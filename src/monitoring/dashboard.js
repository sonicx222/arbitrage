import http from 'http';
import config from '../config.js';
import log from '../utils/logger.js';

/**
 * Simple HTTP Dashboard for health checks and metrics
 *
 * Endpoints:
 * - /health - Basic health check (returns 200 OK)
 * - /metrics - JSON metrics (opportunities, executions, profits)
 * - /status - Detailed bot status
 */
class Dashboard {
    constructor() {
        this.port = process.env.PORT || 8080;
        this.server = null;
        this.bot = null;

        // Metrics tracking
        this.metrics = {
            startTime: Date.now(),
            blocksProcessed: 0,
            opportunitiesFound: 0,
            simulationsRun: 0,
            executionsRun: 0,
            totalProfitUSD: 0,
            lastBlockTime: null,
            lastOpportunityTime: null,
            errors: 0,
        };
    }

    /**
     * Start the dashboard server
     *
     * @param {Object} bot - Reference to the main ArbitrageBot instance
     */
    start(bot) {
        this.bot = bot;

        this.server = http.createServer((req, res) => {
            this.handleRequest(req, res);
        });

        this.server.listen(this.port, () => {
            log.info(`Dashboard listening on port ${this.port}`);
        });

        this.server.on('error', (error) => {
            log.error('Dashboard server error', { error: error.message });
        });
    }

    /**
     * Handle incoming HTTP requests
     */
    handleRequest(req, res) {
        // Set CORS headers for local development
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json');

        try {
            switch (req.url) {
                case '/health':
                    this.handleHealth(req, res);
                    break;

                case '/metrics':
                    this.handleMetrics(req, res);
                    break;

                case '/status':
                    this.handleStatus(req, res);
                    break;

                case '/':
                    this.handleRoot(req, res);
                    break;

                default:
                    res.writeHead(404);
                    res.end(JSON.stringify({ error: 'Not found' }));
            }
        } catch (error) {
            log.error('Dashboard request error', { error: error.message });
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'Internal server error' }));
        }
    }

    /**
     * Health check endpoint
     */
    handleHealth(req, res) {
        const isHealthy = this.bot?.isRunning ?? false;

        res.writeHead(isHealthy ? 200 : 503);
        res.end(JSON.stringify({
            status: isHealthy ? 'healthy' : 'unhealthy',
            uptime: Math.floor((Date.now() - this.metrics.startTime) / 1000),
        }));
    }

    /**
     * Metrics endpoint
     */
    handleMetrics(req, res) {
        const uptime = Date.now() - this.metrics.startTime;

        const metrics = {
            uptime_seconds: Math.floor(uptime / 1000),
            blocks_processed: this.metrics.blocksProcessed,
            opportunities_found: this.metrics.opportunitiesFound,
            simulations_run: this.metrics.simulationsRun,
            executions_run: this.metrics.executionsRun,
            total_profit_usd: this.metrics.totalProfitUSD,
            errors: this.metrics.errors,
            opportunities_per_hour: this.calculateRate(this.metrics.opportunitiesFound, uptime),
            last_block_seconds_ago: this.metrics.lastBlockTime
                ? Math.floor((Date.now() - this.metrics.lastBlockTime) / 1000)
                : null,
        };

        res.writeHead(200);
        res.end(JSON.stringify(metrics, null, 2));
    }

    /**
     * Detailed status endpoint
     */
    handleStatus(req, res) {
        const botStatus = this.bot?.getStatus?.() || {};

        const status = {
            version: '2.0.0',
            mode: config.execution?.mode || 'detection-only',
            execution_enabled: config.execution?.enabled || false,
            triangular_enabled: config.triangular?.enabled !== false,

            bot: {
                running: this.bot?.isRunning ?? false,
                processing: this.bot?.processingBlock ?? false,
            },

            network: {
                name: config.network.name,
                chainId: config.network.chainId,
            },

            dexes: Object.entries(config.dex)
                .filter(([_, dex]) => dex.enabled)
                .map(([name]) => name),

            tokens: {
                total: Object.keys(config.tokens).length,
                base: config.baseTokens,
            },

            metrics: this.metrics,

            ...botStatus,
        };

        res.writeHead(200);
        res.end(JSON.stringify(status, null, 2));
    }

    /**
     * Root endpoint - basic info
     */
    handleRoot(req, res) {
        res.writeHead(200);
        res.end(JSON.stringify({
            name: 'BSC Arbitrage Bot',
            version: '2.0.0',
            endpoints: ['/health', '/metrics', '/status'],
        }));
    }

    /**
     * Calculate rate per hour
     */
    calculateRate(count, uptimeMs) {
        if (uptimeMs === 0) return 0;
        return ((count / uptimeMs) * 3600000).toFixed(2);
    }

    /**
     * Record a processed block
     */
    recordBlock() {
        this.metrics.blocksProcessed++;
        this.metrics.lastBlockTime = Date.now();
    }

    /**
     * Record found opportunities
     */
    recordOpportunities(count) {
        this.metrics.opportunitiesFound += count;
        if (count > 0) {
            this.metrics.lastOpportunityTime = Date.now();
        }
    }

    /**
     * Record a simulation
     */
    recordSimulation(success) {
        this.metrics.simulationsRun++;
        if (!success) this.metrics.errors++;
    }

    /**
     * Record an execution
     */
    recordExecution(success, profitUSD = 0) {
        this.metrics.executionsRun++;
        if (success) {
            this.metrics.totalProfitUSD += profitUSD;
        } else {
            this.metrics.errors++;
        }
    }

    /**
     * Record an error
     */
    recordError() {
        this.metrics.errors++;
    }

    /**
     * Stop the dashboard server
     */
    stop() {
        if (this.server) {
            this.server.close(() => {
                log.info('Dashboard server stopped');
            });
        }
    }

    /**
     * Get current metrics
     */
    getMetrics() {
        return { ...this.metrics };
    }
}

// Export singleton instance
const dashboard = new Dashboard();
export default dashboard;
