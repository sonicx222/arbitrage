import { EventEmitter } from 'events';
import log from '../utils/logger.js';

/**
 * WhaleTracker - Tracks large trader addresses to predict market movements
 *
 * This is a FREE alternative to mempool monitoring that provides:
 * 1. Detection of addresses that frequently move prices
 * 2. Historical pattern analysis of whale behavior
 * 3. Predictive signals when whales are active
 *
 * Unlike mempool monitoring (which sees pending TXs), this tracks confirmed
 * transactions and builds patterns over time.
 */
class WhaleTracker extends EventEmitter {
    constructor(options = {}) {
        super();

        // Configuration
        this.minTradeUSD = options.minTradeUSD || 10000; // Minimum to consider "whale"
        this.minTradesForWhale = options.minTradesForWhale || 5; // Min trades to classify
        this.historyLength = options.historyLength || 100; // Trades to keep per address
        this.maxTrackedAddresses = options.maxTrackedAddresses || 500;
        this.activityWindowMs = options.activityWindowMs || 300000; // 5 minutes

        // Tracked addresses and their trading history
        this.addresses = new Map(); // address -> { trades, stats, isWhale }

        // Recent trades by pair for quick lookup
        this.tradesByPair = new Map(); // pairKey -> [{ address, trade }]

        // Statistics
        this.stats = {
            addressesTracked: 0,
            whalesIdentified: 0,
            tradesRecorded: 0,
            signalsEmitted: 0,
        };

        // FIX v3.1: Periodic cleanup interval for tradesByPair
        this.cleanupInterval = null;
        this._startCleanup();

        log.info('WhaleTracker initialized', {
            minTradeUSD: this.minTradeUSD,
            minTradesForWhale: this.minTradesForWhale,
        });
    }

    /**
     * Record a trade from blockchain data (Swap events, etc.)
     *
     * @param {Object} trade - Trade data
     * @param {string} trade.address - Trader address (from)
     * @param {string} trade.pairKey - Token pair (e.g., "WBNB/USDT")
     * @param {string} trade.dexName - DEX name
     * @param {number} trade.amountUSD - Trade size in USD
     * @param {string} trade.direction - 'buy' or 'sell'
     * @param {number} trade.blockNumber - Block number
     * @param {string} trade.txHash - Transaction hash
     */
    recordTrade(trade) {
        if (!trade.address || !trade.pairKey || !trade.amountUSD) return;

        const address = trade.address.toLowerCase();
        const now = Date.now();

        // Get or create address entry
        let addressData = this.addresses.get(address);
        if (!addressData) {
            if (this.addresses.size >= this.maxTrackedAddresses) {
                this._evictOldestAddress();
            }

            addressData = {
                trades: [],
                stats: {
                    totalTradesCount: 0,
                    totalVolumeUSD: 0,
                    avgTradeUSD: 0,
                    largeTradesCount: 0,
                    favoredPairs: new Map(),
                    favoredDexes: new Map(),
                    lastTradeTime: 0,
                },
                isWhale: false,
                firstSeen: now,
                lastUpdated: now,
            };
            this.addresses.set(address, addressData);
            this.stats.addressesTracked++;
        }

        // Add trade to history
        const tradeRecord = {
            ...trade,
            timestamp: now,
        };

        addressData.trades.push(tradeRecord);
        if (addressData.trades.length > this.historyLength) {
            addressData.trades.shift();
        }

        // Update stats
        this._updateAddressStats(addressData, trade);

        // Check if this address qualifies as whale
        const wasWhale = addressData.isWhale;
        addressData.isWhale = this._isWhale(addressData);

        if (!wasWhale && addressData.isWhale) {
            this.stats.whalesIdentified++;
            log.info('New whale identified', {
                address: address.slice(0, 10) + '...',
                totalVolumeUSD: addressData.stats.totalVolumeUSD.toFixed(0),
                tradesCount: addressData.stats.totalTradesCount,
            });
        }

        // Record in pair-based index
        this._recordTradeByPair(trade.pairKey, address, tradeRecord);

        this.stats.tradesRecorded++;

        // Emit signal if this is a whale trade
        if (addressData.isWhale && trade.amountUSD >= this.minTradeUSD) {
            this._emitWhaleSignal(address, addressData, tradeRecord);
        }
    }

    /**
     * Update address statistics
     * @private
     */
    _updateAddressStats(addressData, trade) {
        const stats = addressData.stats;

        stats.totalTradesCount++;
        stats.totalVolumeUSD += trade.amountUSD;
        stats.avgTradeUSD = stats.totalVolumeUSD / stats.totalTradesCount;
        stats.lastTradeTime = Date.now();

        if (trade.amountUSD >= this.minTradeUSD) {
            stats.largeTradesCount++;
        }

        // Track favored pairs
        const pairCount = stats.favoredPairs.get(trade.pairKey) || 0;
        stats.favoredPairs.set(trade.pairKey, pairCount + 1);

        // Track favored DEXs
        if (trade.dexName) {
            const dexCount = stats.favoredDexes.get(trade.dexName) || 0;
            stats.favoredDexes.set(trade.dexName, dexCount + 1);
        }
    }

    /**
     * Check if address qualifies as a whale
     * @private
     */
    _isWhale(addressData) {
        const stats = addressData.stats;

        // Must have minimum number of trades
        if (stats.totalTradesCount < this.minTradesForWhale) return false;

        // Must have significant volume or large trades
        if (stats.largeTradesCount >= 3) return true;
        if (stats.totalVolumeUSD >= this.minTradeUSD * 10) return true;
        if (stats.avgTradeUSD >= this.minTradeUSD / 2) return true;

        return false;
    }

    /**
     * Record trade in pair-based index
     * @private
     */
    _recordTradeByPair(pairKey, address, trade) {
        let pairTrades = this.tradesByPair.get(pairKey);
        if (!pairTrades) {
            pairTrades = [];
            this.tradesByPair.set(pairKey, pairTrades);
        }

        pairTrades.push({ address, trade });

        // Keep only recent trades
        const cutoff = Date.now() - this.activityWindowMs;
        while (pairTrades.length > 0 && pairTrades[0].trade.timestamp < cutoff) {
            pairTrades.shift();
        }
    }

    /**
     * Emit whale activity signal
     * @private
     */
    _emitWhaleSignal(address, addressData, trade) {
        const signal = {
            type: 'whale-trade',
            address,
            pairKey: trade.pairKey,
            dexName: trade.dexName,
            direction: trade.direction,
            amountUSD: trade.amountUSD,
            blockNumber: trade.blockNumber,
            whaleStats: {
                totalVolume: addressData.stats.totalVolumeUSD,
                avgTrade: addressData.stats.avgTradeUSD,
                favoredPairs: [...addressData.stats.favoredPairs.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 3)
                    .map(([pair]) => pair),
            },
            timestamp: Date.now(),
        };

        this.stats.signalsEmitted++;
        this.emit('whaleActivity', signal);

        log.debug('Whale activity detected', {
            address: address.slice(0, 10) + '...',
            pair: trade.pairKey,
            amount: `$${trade.amountUSD.toFixed(0)}`,
        });
    }

    /**
     * Evict oldest tracked address when at capacity
     * @private
     */
    _evictOldestAddress() {
        let oldestAddress = null;
        let oldestTime = Infinity;

        for (const [address, data] of this.addresses) {
            if (data.lastUpdated < oldestTime && !data.isWhale) {
                oldestTime = data.lastUpdated;
                oldestAddress = address;
            }
        }

        if (oldestAddress) {
            this.addresses.delete(oldestAddress);
            this.stats.addressesTracked--;
        }
    }

    /**
     * Get recent whale activity for a pair
     *
     * @param {string} pairKey - Token pair
     * @param {number} windowMs - Time window (default: 5 minutes)
     * @returns {Object} Recent whale activity summary
     */
    getWhaleActivityForPair(pairKey, windowMs = this.activityWindowMs) {
        const pairTrades = this.tradesByPair.get(pairKey) || [];
        const cutoff = Date.now() - windowMs;

        const recentTrades = pairTrades.filter(t =>
            t.trade.timestamp >= cutoff &&
            this.addresses.get(t.address)?.isWhale
        );

        if (recentTrades.length === 0) {
            return {
                hasActivity: false,
                tradeCount: 0,
                totalVolumeUSD: 0,
                netDirection: 'neutral',
            };
        }

        let buyVolume = 0;
        let sellVolume = 0;

        for (const { trade } of recentTrades) {
            if (trade.direction === 'buy') {
                buyVolume += trade.amountUSD;
            } else {
                sellVolume += trade.amountUSD;
            }
        }

        return {
            hasActivity: true,
            tradeCount: recentTrades.length,
            totalVolumeUSD: buyVolume + sellVolume,
            buyVolumeUSD: buyVolume,
            sellVolumeUSD: sellVolume,
            netDirection: buyVolume > sellVolume * 1.2 ? 'buy' :
                sellVolume > buyVolume * 1.2 ? 'sell' : 'neutral',
            lastTradeMs: Date.now() - recentTrades[recentTrades.length - 1].trade.timestamp,
        };
    }

    /**
     * Check if there's significant whale competition for an opportunity
     *
     * @param {string} pairKey - Token pair
     * @param {string} direction - 'buy' or 'sell'
     * @returns {Object} Competition assessment
     */
    assessCompetition(pairKey, direction) {
        const activity = this.getWhaleActivityForPair(pairKey);

        if (!activity.hasActivity) {
            return {
                level: 'none',
                recommendation: 'proceed',
                reason: 'No recent whale activity',
            };
        }

        // Check if whales are trading in same direction
        const sameDirection = activity.netDirection === direction;
        const highVolume = activity.totalVolumeUSD > this.minTradeUSD * 5;
        const veryRecent = activity.lastTradeMs < 10000; // Last 10 seconds

        if (sameDirection && highVolume && veryRecent) {
            return {
                level: 'high',
                recommendation: 'caution',
                reason: 'Heavy whale activity in same direction',
                whaleVolume: activity.totalVolumeUSD,
            };
        }

        if (sameDirection && highVolume) {
            return {
                level: 'medium',
                recommendation: 'proceed-fast',
                reason: 'Whale activity may have moved price',
                whaleVolume: activity.totalVolumeUSD,
            };
        }

        return {
            level: 'low',
            recommendation: 'proceed',
            reason: 'Minimal relevant whale activity',
        };
    }

    /**
     * Get top whale addresses
     *
     * @param {number} limit - Maximum addresses to return
     * @returns {Array} Top whales by volume
     */
    getTopWhales(limit = 10) {
        const whales = [];

        for (const [address, data] of this.addresses) {
            if (data.isWhale) {
                whales.push({
                    address,
                    totalVolumeUSD: data.stats.totalVolumeUSD,
                    avgTradeUSD: data.stats.avgTradeUSD,
                    tradesCount: data.stats.totalTradesCount,
                    favoredPairs: [...data.stats.favoredPairs.entries()]
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 3),
                    lastActive: data.stats.lastTradeTime,
                });
            }
        }

        return whales
            .sort((a, b) => b.totalVolumeUSD - a.totalVolumeUSD)
            .slice(0, limit);
    }

    /**
     * Import known whale addresses (e.g., from historical data)
     *
     * @param {Array} addresses - Array of { address, stats } objects
     */
    importWhales(whaleData) {
        for (const whale of whaleData) {
            const address = whale.address.toLowerCase();

            if (!this.addresses.has(address)) {
                this.addresses.set(address, {
                    trades: [],
                    stats: {
                        totalTradesCount: whale.tradesCount || this.minTradesForWhale,
                        totalVolumeUSD: whale.volumeUSD || this.minTradeUSD * 10,
                        avgTradeUSD: whale.avgTradeUSD || this.minTradeUSD,
                        largeTradesCount: whale.largeTradesCount || 5,
                        favoredPairs: new Map(whale.favoredPairs || []),
                        favoredDexes: new Map(whale.favoredDexes || []),
                        lastTradeTime: whale.lastSeen || Date.now(),
                    },
                    isWhale: true,
                    firstSeen: whale.firstSeen || Date.now(),
                    lastUpdated: Date.now(),
                });

                this.stats.addressesTracked++;
                this.stats.whalesIdentified++;
            }
        }

        log.info('Imported whale addresses', { count: whaleData.length });
    }

    /**
     * Export whale data for persistence
     */
    exportWhales() {
        const whales = [];

        for (const [address, data] of this.addresses) {
            if (data.isWhale) {
                whales.push({
                    address,
                    tradesCount: data.stats.totalTradesCount,
                    volumeUSD: data.stats.totalVolumeUSD,
                    avgTradeUSD: data.stats.avgTradeUSD,
                    largeTradesCount: data.stats.largeTradesCount,
                    favoredPairs: [...data.stats.favoredPairs.entries()],
                    favoredDexes: [...data.stats.favoredDexes.entries()],
                    lastSeen: data.stats.lastTradeTime,
                    firstSeen: data.firstSeen,
                });
            }
        }

        return whales;
    }

    /**
     * Get statistics
     */
    getStats() {
        return {
            ...this.stats,
            activeWhales: [...this.addresses.values()].filter(d => d.isWhale).length,
            pairsTracked: this.tradesByPair.size,
        };
    }

    /**
     * Reset tracker
     */
    reset() {
        this.addresses.clear();
        this.tradesByPair.clear();
        this.stats = {
            addressesTracked: 0,
            whalesIdentified: 0,
            tradesRecorded: 0,
            signalsEmitted: 0,
        };
    }

    /**
     * Start periodic cleanup for tradesByPair
     * FIX v3.1: Prevents unbounded memory growth
     * @private
     */
    _startCleanup() {
        // Clean up every 5 minutes
        this.cleanupInterval = setInterval(() => {
            this._cleanupTradesByPair();
        }, 5 * 60 * 1000);
    }

    /**
     * Clean up empty or stale entries in tradesByPair
     * FIX v3.1: Removes pairs with no recent trades
     * @private
     */
    _cleanupTradesByPair() {
        const cutoff = Date.now() - this.activityWindowMs;
        let cleaned = 0;

        for (const [pairKey, trades] of this.tradesByPair.entries()) {
            // Remove stale trades
            const recentTrades = trades.filter(t => t.trade.timestamp > cutoff);

            if (recentTrades.length === 0) {
                // Remove empty pair entries
                this.tradesByPair.delete(pairKey);
                cleaned++;
            } else if (recentTrades.length !== trades.length) {
                // Update with only recent trades
                this.tradesByPair.set(pairKey, recentTrades);
            }
        }

        if (cleaned > 0) {
            log.debug(`WhaleTracker: Cleaned ${cleaned} stale pair entries`, {
                remaining: this.tradesByPair.size,
            });
        }
    }

    /**
     * Stop cleanup interval
     * FIX v3.1: Called during graceful shutdown
     */
    stop() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
            log.debug('WhaleTracker cleanup interval stopped');
        }
    }
}

// Export singleton instance
const whaleTracker = new WhaleTracker();
export default whaleTracker;
export { WhaleTracker };
