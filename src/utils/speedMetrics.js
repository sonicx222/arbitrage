import log from './logger.js';

/**
 * SpeedMetrics - High-resolution performance measurement for arbitrage pipeline
 *
 * Features:
 * 1. Per-phase latency tracking
 * 2. Rolling statistics (P50, P95, P99)
 * 3. Bottleneck identification
 * 4. Performance regression detection
 */
class SpeedMetrics {
    constructor(options = {}) {
        this.historySize = options.historySize || 1000;
        this.warnThresholdMs = options.warnThresholdMs || 500;

        // Phase histories
        this.phases = {
            // Detection phases
            gasPrice: [],
            pairFilter: [],
            crossDexDetection: [],
            triangularDetection: [],
            profitCalculation: [],
            totalDetection: [],

            // Execution phases
            validation: [],
            preSimulation: [],
            flashPairResolution: [],
            gasOptimization: [],
            txBuild: [],
            simulation: [],
            totalExecution: [],
        };

        // Current trace (for nested timing)
        this.currentTrace = null;

        // Aggregate stats
        this.stats = {
            totalMeasurements: 0,
            slowDetections: 0,
            slowExecutions: 0,
        };
    }

    /**
     * Start a new timing trace
     *
     * @param {string} traceId - Unique identifier for this trace
     * @returns {Object} Trace object with phase timing methods
     */
    startTrace(traceId = null) {
        const trace = {
            id: traceId || `trace_${Date.now()}`,
            startTime: performance.now(),
            phases: {},
            markers: [],
        };

        this.currentTrace = trace;
        return trace;
    }

    /**
     * Mark a phase start within current trace
     *
     * @param {string} phaseName - Name of the phase
     */
    markPhaseStart(phaseName) {
        if (!this.currentTrace) return;
        this.currentTrace.phases[phaseName] = {
            start: performance.now(),
            end: null,
            duration: null,
        };
    }

    /**
     * Mark a phase end within current trace
     *
     * @param {string} phaseName - Name of the phase
     * @returns {number} Duration in milliseconds
     */
    markPhaseEnd(phaseName) {
        if (!this.currentTrace || !this.currentTrace.phases[phaseName]) return 0;

        const phase = this.currentTrace.phases[phaseName];
        phase.end = performance.now();
        phase.duration = phase.end - phase.start;

        // Add to history
        if (this.phases[phaseName]) {
            this.phases[phaseName].push(phase.duration);
            if (this.phases[phaseName].length > this.historySize) {
                this.phases[phaseName].shift();
            }
        }

        return phase.duration;
    }

    /**
     * End current trace and get summary
     *
     * @param {string} totalPhaseName - Phase name for total duration
     * @returns {Object} Trace summary
     */
    endTrace(totalPhaseName = 'total') {
        if (!this.currentTrace) return null;

        const trace = this.currentTrace;
        trace.endTime = performance.now();
        trace.totalDuration = trace.endTime - trace.startTime;

        // Add total to history
        if (this.phases[totalPhaseName]) {
            this.phases[totalPhaseName].push(trace.totalDuration);
            if (this.phases[totalPhaseName].length > this.historySize) {
                this.phases[totalPhaseName].shift();
            }
        }

        // Update stats
        this.stats.totalMeasurements++;
        if (totalPhaseName.includes('Detection') && trace.totalDuration > this.warnThresholdMs) {
            this.stats.slowDetections++;
        }
        if (totalPhaseName.includes('Execution') && trace.totalDuration > this.warnThresholdMs) {
            this.stats.slowExecutions++;
        }

        // Log if slow
        if (trace.totalDuration > this.warnThresholdMs) {
            log.warn('Slow trace detected', {
                id: trace.id,
                totalMs: trace.totalDuration.toFixed(2),
                phases: this._getTracePhaseSummary(trace),
            });
        }

        this.currentTrace = null;
        return trace;
    }

    /**
     * Measure a synchronous operation
     *
     * @param {string} phaseName - Phase name
     * @param {Function} fn - Function to measure
     * @returns {*} Result of the function
     */
    measure(phaseName, fn) {
        const start = performance.now();
        try {
            return fn();
        } finally {
            const duration = performance.now() - start;
            if (this.phases[phaseName]) {
                this.phases[phaseName].push(duration);
                if (this.phases[phaseName].length > this.historySize) {
                    this.phases[phaseName].shift();
                }
            }
        }
    }

    /**
     * Measure an async operation
     *
     * @param {string} phaseName - Phase name
     * @param {Function} asyncFn - Async function to measure
     * @returns {Promise<*>} Result of the function
     */
    async measureAsync(phaseName, asyncFn) {
        const start = performance.now();
        try {
            return await asyncFn();
        } finally {
            const duration = performance.now() - start;
            if (this.phases[phaseName]) {
                this.phases[phaseName].push(duration);
                if (this.phases[phaseName].length > this.historySize) {
                    this.phases[phaseName].shift();
                }
            }
        }
    }

    /**
     * Get percentile from sorted array
     * @private
     */
    _percentile(arr, p) {
        if (arr.length === 0) return 0;
        const sorted = [...arr].sort((a, b) => a - b);
        const index = Math.ceil((p / 100) * sorted.length) - 1;
        return sorted[Math.max(0, index)];
    }

    /**
     * Get statistics for a phase
     *
     * @param {string} phaseName - Phase name
     * @returns {Object} Statistics
     */
    getPhaseStats(phaseName) {
        const history = this.phases[phaseName] || [];
        if (history.length === 0) {
            return { count: 0, avg: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0 };
        }

        const sum = history.reduce((a, b) => a + b, 0);
        return {
            count: history.length,
            avg: (sum / history.length).toFixed(2),
            p50: this._percentile(history, 50).toFixed(2),
            p95: this._percentile(history, 95).toFixed(2),
            p99: this._percentile(history, 99).toFixed(2),
            min: Math.min(...history).toFixed(2),
            max: Math.max(...history).toFixed(2),
        };
    }

    /**
     * Get summary of all phases
     */
    getAllStats() {
        const result = {};
        for (const phaseName of Object.keys(this.phases)) {
            const stats = this.getPhaseStats(phaseName);
            if (stats.count > 0) {
                result[phaseName] = stats;
            }
        }
        return {
            phases: result,
            aggregate: this.stats,
        };
    }

    /**
     * Identify bottlenecks (phases with highest avg latency)
     *
     * @param {number} topN - Number of bottlenecks to return
     * @returns {Array} Top bottlenecks
     */
    identifyBottlenecks(topN = 3) {
        const phaseStats = [];
        for (const [phaseName, history] of Object.entries(this.phases)) {
            if (history.length > 0) {
                const avg = history.reduce((a, b) => a + b, 0) / history.length;
                phaseStats.push({ phase: phaseName, avgMs: avg, count: history.length });
            }
        }

        return phaseStats
            .sort((a, b) => b.avgMs - a.avgMs)
            .slice(0, topN)
            .map(p => ({ ...p, avgMs: p.avgMs.toFixed(2) }));
    }

    /**
     * Get trace phase summary for logging
     * @private
     */
    _getTracePhaseSummary(trace) {
        const summary = {};
        for (const [phase, data] of Object.entries(trace.phases)) {
            if (data.duration !== null) {
                summary[phase] = `${data.duration.toFixed(2)}ms`;
            }
        }
        return summary;
    }

    /**
     * Reset all metrics
     */
    reset() {
        for (const phaseName of Object.keys(this.phases)) {
            this.phases[phaseName] = [];
        }
        this.stats = {
            totalMeasurements: 0,
            slowDetections: 0,
            slowExecutions: 0,
        };
    }

    /**
     * Export metrics for analysis
     */
    export() {
        return {
            timestamp: Date.now(),
            phases: { ...this.phases },
            stats: { ...this.stats },
            bottlenecks: this.identifyBottlenecks(5),
        };
    }
}

// Export singleton instance
const speedMetrics = new SpeedMetrics();
export default speedMetrics;

// Also export class for custom instances
export { SpeedMetrics };
