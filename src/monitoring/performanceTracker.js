import rpcManager from '../utils/rpcManager.js';
import cacheManager from '../data/cacheManager.js';
import log from '../utils/logger.js';

/**
 * Performance Tracker - Monitors system performance and RPC usage
 */
class PerformanceTracker {
    constructor() {
        this.metrics = {
            blocksProcessed: 0,
            opportunitiesFound: 0,
            rpcCallsTotal: 0,
            cacheHits: 0,
            cacheMisses: 0,
            averageBlockProcessingTime: 0,
            startTime: Date.now(),
        };

        this.blockProcessingTimes = [];
        this.maxSamples = 100; // Keep last 100 block processing times

        // Generate hourly reports (unref to not block process exit)
        this.reportInterval = setInterval(() => {
            this.generateReport();
        }, 3600000); // 1 hour
        this.reportInterval.unref();

        log.info('Performance Tracker initialized');
    }

    /**
     * Record block processing metrics
     */
    recordBlockProcessing(blockNumber, duration, opportunitiesCount) {
        this.metrics.blocksProcessed++;
        this.metrics.opportunitiesFound += opportunitiesCount;

        // Track processing time
        this.blockProcessingTimes.push(duration);
        if (this.blockProcessingTimes.length > this.maxSamples) {
            this.blockProcessingTimes.shift();
        }

        // Calculate average
        const sum = this.blockProcessingTimes.reduce((a, b) => a + b, 0);
        this.metrics.averageBlockProcessingTime = sum / this.blockProcessingTimes.length;

        log.debug(`Block ${blockNumber} processed in ${duration}ms`, {
            opportunities: opportunitiesCount,
        });
    }

    /**
     * Get current metrics
     */
    getMetrics() {
        const rpcStats = rpcManager.getStats();
        const cacheStats = cacheManager.getStats();
        const uptime = Date.now() - this.metrics.startTime;

        return {
            uptime: {
                ms: uptime,
                formatted: this.formatUptime(uptime),
            },
            blocks: {
                processed: this.metrics.blocksProcessed,
                averageProcessingTime: `${this.metrics.averageBlockProcessingTime.toFixed(0)}ms`,
            },
            opportunities: {
                total: this.metrics.opportunitiesFound,
                perHour: (this.metrics.opportunitiesFound / (uptime / 3600000)).toFixed(2),
            },
            rpc: rpcStats,
            cache: cacheStats,
        };
    }

    /**
     * Generate and log performance report
     */
    generateReport() {
        const metrics = this.getMetrics();

        log.performance({
            uptime: metrics.uptime.formatted,
            blocksProcessed: metrics.blocks.processed,
            averageBlockTime: metrics.blocks.averageProcessingTime,
            opportunitiesFound: metrics.opportunities.total,
            opportunitiesPerHour: metrics.opportunities.perHour,
            rpcEndpoints: {
                http: `${metrics.rpc.http.healthy}/${metrics.rpc.http.total}`,
                ws: `${metrics.rpc.ws.healthy}/${metrics.rpc.ws.total}`,
            },
            cacheHitRate: metrics.cache.prices.hitRate,
        });
    }

    /**
     * Format uptime in human-readable format
     */
    formatUptime(ms) {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) {
            return `${days}d ${hours % 24}h ${minutes % 60}m`;
        } else if (hours > 0) {
            return `${hours}h ${minutes % 60}m`;
        } else if (minutes > 0) {
            return `${minutes}m ${seconds % 60}s`;
        } else {
            return `${seconds}s`;
        }
    }

    /**
     * Cleanup
     */
    cleanup() {
        if (this.reportInterval) {
            clearInterval(this.reportInterval);
        }
    }
}

// Export singleton instance
const performanceTracker = new PerformanceTracker();
export default performanceTracker;
