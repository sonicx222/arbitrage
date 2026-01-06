/**
 * Centralized Log Formatter
 *
 * Provides consistent, readable log formatting across the entire application.
 *
 * Design Principles:
 * 1. Single source of truth for log formats
 * 2. Clear visual hierarchy with emojis for quick scanning
 * 3. Consistent field ordering and formatting
 * 4. Appropriate detail level (not too verbose, not too sparse)
 */

/**
 * Format currency values consistently
 * @param {number} value - Dollar amount
 * @param {number} decimals - Decimal places (default 2)
 * @returns {string} Formatted string like "$123.45"
 */
export function formatUSD(value, decimals = 2) {
    if (value === null || value === undefined || isNaN(value)) return '$--.--';
    return `$${value.toFixed(decimals)}`;
}

/**
 * Format percentage values consistently
 * @param {number} value - Percentage value
 * @param {number} decimals - Decimal places (default 2)
 * @returns {string} Formatted string like "1.25%"
 */
export function formatPercent(value, decimals = 2) {
    if (value === null || value === undefined || isNaN(value)) return '--.--';
    return `${value.toFixed(decimals)}%`;
}

/**
 * Format price values with appropriate precision
 * @param {number} price - Price value
 * @returns {string} Formatted price
 */
export function formatPrice(price) {
    if (price === null || price === undefined || isNaN(price)) return 'N/A';
    if (price < 0.0001) return price.toExponential(4);
    if (price < 1) return price.toFixed(6);
    if (price < 1000) return price.toFixed(4);
    return price.toFixed(2);
}

/**
 * Shorten DEX names for compact display
 * @param {string} dexName - Full DEX name
 * @returns {string} Shortened name
 */
export function shortDex(dexName) {
    const shortcuts = {
        'pancakeswap': 'PCS',
        'biswap': 'BiS',
        'apeswap': 'Ape',
        'babyswap': 'Baby',
        'mdex': 'MDEX',
        'uniswap': 'Uni',
        'uniswap_v2': 'UniV2',
        'uniswap_v3': 'UniV3',
        'sushiswap': 'Sushi',
        'quickswap': 'Quick',
        'camelot': 'Cam',
        'aerodrome': 'Aero',
        'baseswap': 'Base',
        'traderjoe': 'TJ',
        'pangolin': 'Pang',
        'curve': 'Curve',
    };
    return shortcuts[dexName?.toLowerCase()] || dexName?.substring(0, 5) || 'N/A';
}

/**
 * Format chain name consistently
 * @param {string|number} chainId - Chain ID or name
 * @returns {string} Formatted chain name
 */
export function formatChain(chainId) {
    const chains = {
        56: 'BSC',
        1: 'ETH',
        137: 'Polygon',
        42161: 'Arbitrum',
        8453: 'Base',
        43114: 'Avalanche',
    };
    return chains[chainId] || chainId?.toString() || 'Unknown';
}

/**
 * Format token path for triangular arbitrage
 * @param {Array<string>} path - Token symbols array
 * @returns {string} Formatted path like "WBNB→CAKE→USDT→WBNB"
 */
export function formatPath(path) {
    if (!path || !Array.isArray(path)) return 'N/A';
    return path.join('→');
}

/**
 * Format DEX path for cross-DEX triangular
 * @param {Array<string>} dexPath - DEX names array
 * @returns {string} Formatted path like "PCS→BiS→PCS"
 */
export function formatDexPath(dexPath) {
    if (!dexPath || !Array.isArray(dexPath)) return 'N/A';
    return dexPath.map(d => shortDex(d)).join('→');
}

/**
 * Format duration in milliseconds
 * @param {number} ms - Milliseconds
 * @returns {string} Formatted duration
 */
export function formatDuration(ms) {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
}

// ============================================================================
// OPPORTUNITY FORMATTERS
// ============================================================================

/**
 * Format a cross-DEX opportunity for logging
 * @param {Object} opp - Opportunity object
 * @returns {string} Formatted log line
 */
export function formatCrossDexOpportunity(opp) {
    const profit = opp.profitCalculation?.netProfitUSD || opp.profitUSD || 0;
    const profitPct = opp.profitCalculation?.netProfitPercent || opp.netProfitPercentage || 0;

    return `${opp.pairKey} | ${shortDex(opp.buyDex)}@${formatPrice(opp.buyPrice)} → ${shortDex(opp.sellDex)}@${formatPrice(opp.sellPrice)} | ${formatUSD(profit)} (${formatPercent(profitPct)})`;
}

/**
 * Format a triangular opportunity for logging
 * @param {Object} opp - Opportunity object
 * @returns {string} Formatted log line
 */
export function formatTriangularOpportunity(opp) {
    const profit = opp.profitCalculation?.netProfitUSD || opp.profitUSD || 0;
    const profitPct = opp.profitCalculation?.netProfitPercent || opp.estimatedProfitPercent || 0;

    return `${formatPath(opp.path)} | ${shortDex(opp.dexName)} | ${formatUSD(profit)} (${formatPercent(profitPct)})`;
}

/**
 * Format a cross-DEX triangular opportunity for logging
 * @param {Object} opp - Opportunity object
 * @returns {string} Formatted log line
 */
export function formatCrossDexTriangularOpportunity(opp) {
    const profit = opp.profitCalculation?.netProfitUSD || opp.profitUSD || 0;
    const profitPct = opp.profitCalculation?.netProfitPercent || opp.estimatedProfitPercent || 0;

    return `${formatPath(opp.path)} | ${formatDexPath(opp.dexPath)} | ${formatUSD(profit)} (${formatPercent(profitPct)})`;
}

/**
 * Format any opportunity based on type
 * @param {Object} opp - Opportunity object
 * @returns {Object} { icon: string, text: string }
 */
export function formatOpportunity(opp) {
    switch (opp.type) {
        case 'cross-dex':
            return { icon: '📊', text: formatCrossDexOpportunity(opp) };
        case 'triangular':
            return { icon: '🔺', text: formatTriangularOpportunity(opp) };
        case 'cross-dex-triangular':
            return { icon: '🔷', text: formatCrossDexTriangularOpportunity(opp) };
        case 'multi-hop':
            return { icon: '🔗', text: `${formatPath(opp.path)} | ${formatUSD(opp.profitUSD)}` };
        case 'cross-chain':
            return { icon: '🌐', text: `${opp.token} | ${formatChain(opp.buyChain)}→${formatChain(opp.sellChain)} | ${formatUSD(opp.profitUSD)}` };
        default:
            return { icon: '💰', text: `Unknown type: ${opp.type}` };
    }
}

// ============================================================================
// SUMMARY FORMATTERS
// ============================================================================

/**
 * Format opportunity summary for a detection cycle
 * @param {Array} opportunities - Array of opportunities
 * @param {number} duration - Processing time in ms
 * @returns {string} Summary line
 */
export function formatOpportunitySummary(opportunities, duration) {
    if (!opportunities || opportunities.length === 0) {
        return null; // Don't log if no opportunities
    }

    const counts = {
        crossDex: opportunities.filter(o => o.type === 'cross-dex').length,
        triangular: opportunities.filter(o => o.type === 'triangular').length,
        crossDexTri: opportunities.filter(o => o.type === 'cross-dex-triangular').length,
        multiHop: opportunities.filter(o => o.type === 'multi-hop').length,
    };

    const parts = [];
    if (counts.crossDex > 0) parts.push(`Cross:${counts.crossDex}`);
    if (counts.triangular > 0) parts.push(`Tri:${counts.triangular}`);
    if (counts.crossDexTri > 0) parts.push(`X-Tri:${counts.crossDexTri}`);
    if (counts.multiHop > 0) parts.push(`Multi:${counts.multiHop}`);

    const topProfit = Math.max(...opportunities.map(o =>
        o.profitCalculation?.netProfitUSD || o.profitUSD || 0
    ));

    return `Found ${opportunities.length} opportunities (${formatDuration(duration)}) | ${parts.join(' | ')} | Top: ${formatUSD(topProfit)}`;
}

/**
 * Format block processing summary
 * @param {number} blockNumber - Block number
 * @param {number} pairCount - Number of pairs scanned
 * @param {number} oppCount - Opportunities found
 * @param {number} duration - Processing time in ms
 * @returns {string} Summary line
 */
export function formatBlockSummary(blockNumber, pairCount, oppCount, duration) {
    if (oppCount > 0) {
        return `Block ${blockNumber} | ${pairCount} pairs | ${oppCount} opps | ${formatDuration(duration)}`;
    }
    return null; // Don't log blocks with no opportunities (reduces noise)
}

// ============================================================================
// LOG MESSAGE TEMPLATES
// ============================================================================

/**
 * Standard log message templates for consistency
 */
export const LogTemplates = {
    // Startup messages
    STARTUP: (version) => `Arbitrage Bot v${version} starting...`,
    STARTUP_COMPLETE: (chains, dexes, tokens) =>
        `Bot ready | Chains: ${chains} | DEXes: ${dexes} | Tokens: ${tokens}`,

    // Chain messages
    CHAIN_STARTED: (chainName, chainId) => `${chainName} (${chainId}) monitoring started`,
    CHAIN_STOPPED: (chainName) => `${chainName} monitoring stopped`,
    CHAIN_ERROR: (chainName, error) => `${chainName} error: ${error}`,

    // Worker messages
    WORKER_STARTED: (chainId) => `Worker started for chain ${formatChain(chainId)}`,
    WORKER_STOPPED: (chainId) => `Worker stopped for chain ${formatChain(chainId)}`,
    WORKER_ERROR: (chainId, error) => `Worker ${formatChain(chainId)} error: ${error}`,

    // Execution messages
    EXEC_SIMULATING: (type, pair) => `Simulating ${type}: ${pair}`,
    EXEC_SIM_SUCCESS: (profit) => `Simulation passed | Expected profit: ${formatUSD(profit)}`,
    EXEC_SIM_FAILED: (reason) => `Simulation failed: ${reason}`,
    EXEC_TX_SENT: (hash) => `Transaction sent: ${hash.substring(0, 18)}...`,
    EXEC_TX_CONFIRMED: (hash, profit) => `Transaction confirmed | Profit: ${formatUSD(profit)}`,
    EXEC_TX_FAILED: (hash, reason) => `Transaction failed: ${reason}`,

    // Shutdown messages
    SHUTDOWN_STARTED: (signal) => `Shutdown initiated (${signal})`,
    SHUTDOWN_COMPLETE: (uptime) => `Bot stopped gracefully | Uptime: ${formatDuration(uptime)}`,
};

export default {
    formatUSD,
    formatPercent,
    formatPrice,
    shortDex,
    formatChain,
    formatPath,
    formatDexPath,
    formatDuration,
    formatOpportunity,
    formatCrossDexOpportunity,
    formatTriangularOpportunity,
    formatCrossDexTriangularOpportunity,
    formatOpportunitySummary,
    formatBlockSummary,
    LogTemplates,
};
