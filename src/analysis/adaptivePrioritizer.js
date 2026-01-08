import { EventEmitter } from 'events';
import log from '../utils/logger.js';
import config from '../config.js';

/**
 * Adaptive Pair Prioritizer
 *
 * Dynamically adjusts pair monitoring priority based on recent activity:
 * - Pairs with recent opportunities are promoted to higher tiers (more frequent checking)
 * - Inactive pairs decay to lower tiers (less frequent checking)
 * - Maximizes opportunity detection within RPC budget constraints
 *
 * Tiers:
 *   1 (HOT):    Every block - pairs with opportunities in last 5 minutes
 *   2 (WARM):   Every 2 blocks - pairs with opportunities in last 30 minutes
 *   3 (NORMAL): Every 3 blocks - high volume pairs
 *   4 (COLD):   Every 5 blocks - lower volume pairs
 *
 * Expected improvement: +40-60% opportunity detection with same RPC calls
 */
class AdaptivePrioritizer extends EventEmitter {
    constructor(options = {}) {
        super();

        // Tier configuration
        this.tiers = {
            1: { name: 'HOT', frequency: 1, maxAge: 5 * 60 * 1000 },      // 5 min
            2: { name: 'WARM', frequency: 2, maxAge: 30 * 60 * 1000 },    // 30 min
            3: { name: 'NORMAL', frequency: 3, maxAge: Infinity },         // Default tier
            4: { name: 'COLD', frequency: 5, maxAge: Infinity },           // Low priority
        };

        // Pair -> { tier, lastOpportunity, lastChecked, opportunityCount, volumeScore }
        this.pairPriority = new Map();

        // Configuration
        this.decayIntervalMs = options.decayIntervalMs || 60000; // Check for decay every minute
        this.minOpportunitiesForPromotion = options.minOpportunitiesForPromotion || 1;
        this.volumeThresholdHigh = options.volumeThresholdHigh || 100000; // USD
        this.volumeThresholdLow = options.volumeThresholdLow || 10000;   // USD

        // Statistics
        this.stats = {
            promotions: 0,
            demotions: 0,
            checksSkipped: 0,
            checksPerformed: 0,
            tierDistribution: { 1: 0, 2: 0, 3: 0, 4: 0 },
        };

        // Decay timer
        this.decayTimer = null;

        // FIX v3.3: Changed to debug level - logs on every module import in multi-chain mode
        log.debug('AdaptivePrioritizer module loaded', {
            tiers: Object.keys(this.tiers).length,
            decayInterval: this.decayIntervalMs,
        });
    }

    /**
     * Start the prioritizer (begins decay timer)
     */
    start() {
        if (this.decayTimer) {
            return;
        }

        this.decayTimer = setInterval(() => {
            this.decayTiers();
        }, this.decayIntervalMs);

        // Don't prevent process exit
        this.decayTimer.unref();

        // FIX v3.3: Log at info level on explicit start, not constructor
        log.info('AdaptivePrioritizer started', {
            tiers: Object.keys(this.tiers).length,
            decayInterval: this.decayIntervalMs,
        });
    }

    /**
     * Stop the prioritizer
     */
    stop() {
        if (this.decayTimer) {
            clearInterval(this.decayTimer);
            this.decayTimer = null;
        }
        log.debug('AdaptivePrioritizer stopped');
    }

    /**
     * Register a pair for priority tracking
     *
     * FIX v3.7: Auto-start decay timer on first registration
     * This prevents the bug where pairs stay HOT forever if start() is never called
     *
     * @param {string} pairKey - Unique pair identifier (e.g., "WBNB/USDT:pancakeswap")
     * @param {Object} options - { volumeUSD, liquidityUSD }
     */
    registerPair(pairKey, options = {}) {
        // FIX v3.7: Auto-start on first registration to prevent timer leak
        // This ensures decay mechanism runs even if start() is never explicitly called
        if (!this.decayTimer && this.pairPriority.size === 0) {
            this.start();
        }

        if (this.pairPriority.has(pairKey)) {
            return;
        }

        // Determine initial tier based on volume/liquidity
        let initialTier = 3; // Default to NORMAL

        if (options.volumeUSD && options.volumeUSD > this.volumeThresholdHigh) {
            initialTier = 2; // High volume starts as WARM
        } else if (options.liquidityUSD && options.liquidityUSD < this.volumeThresholdLow) {
            initialTier = 4; // Low liquidity starts as COLD
        }

        this.pairPriority.set(pairKey, {
            tier: initialTier,
            lastOpportunity: null,
            lastChecked: Date.now(),
            opportunityCount: 0,
            volumeScore: options.volumeUSD || 0,
            liquidityUSD: options.liquidityUSD || 0,
        });

        this.updateTierDistribution();
    }

    /**
     * Record an opportunity for a pair (promotes it to higher tier)
     * @param {string} pairKey - Pair identifier
     * @param {Object} opportunity - Opportunity details
     */
    recordOpportunity(pairKey, opportunity = {}) {
        let pairData = this.pairPriority.get(pairKey);

        if (!pairData) {
            // Auto-register if not tracked
            this.registerPair(pairKey, {
                volumeUSD: opportunity.volumeUSD,
                liquidityUSD: opportunity.liquidityUSD,
            });
            pairData = this.pairPriority.get(pairKey);
        }

        const oldTier = pairData.tier;
        pairData.lastOpportunity = Date.now();
        pairData.opportunityCount++;

        // Promote to HOT tier immediately
        if (pairData.tier > 1) {
            pairData.tier = 1;
            this.stats.promotions++;

            log.debug(`Pair promoted: ${pairKey}`, {
                from: this.tiers[oldTier].name,
                to: this.tiers[1].name,
                opportunityCount: pairData.opportunityCount,
            });

            this.emit('tierChange', {
                pairKey,
                oldTier,
                newTier: 1,
                reason: 'opportunity',
            });
        }

        this.updateTierDistribution();
    }

    /**
     * Check if a pair should be monitored on this block
     * @param {string} pairKey - Pair identifier
     * @param {number} blockNumber - Current block number
     * @returns {boolean} - True if pair should be checked
     */
    shouldCheckPair(pairKey, blockNumber) {
        const pairData = this.pairPriority.get(pairKey);

        if (!pairData) {
            // Unknown pair - always check (and register)
            this.registerPair(pairKey);
            return true;
        }

        const tier = pairData.tier;
        const frequency = this.tiers[tier].frequency;

        // Check if this block aligns with the pair's frequency
        const shouldCheck = (blockNumber % frequency) === 0;

        if (shouldCheck) {
            pairData.lastChecked = Date.now();
            this.stats.checksPerformed++;
        } else {
            this.stats.checksSkipped++;
        }

        return shouldCheck;
    }

    /**
     * Get pairs that should be checked on this block
     * @param {Array<string>} allPairs - All available pairs
     * @param {number} blockNumber - Current block number
     * @returns {Array<string>} - Pairs to check
     */
    getPairsToCheck(allPairs, blockNumber) {
        const pairsToCheck = [];

        for (const pairKey of allPairs) {
            if (this.shouldCheckPair(pairKey, blockNumber)) {
                pairsToCheck.push(pairKey);
            }
        }

        return pairsToCheck;
    }

    /**
     * Get all pairs in a specific tier
     * @param {number} tierNumber - Tier number (1-4)
     * @returns {Array<string>} - Pair keys
     */
    getPairsByTier(tierNumber) {
        const pairs = [];
        for (const [pairKey, data] of this.pairPriority) {
            if (data.tier === tierNumber) {
                pairs.push(pairKey);
            }
        }
        return pairs;
    }

    /**
     * Get the priority tier for a pair
     * @param {string} pairKey - Pair identifier
     * @returns {number} - Tier number (1-4)
     */
    getTier(pairKey) {
        const data = this.pairPriority.get(pairKey);
        return data ? data.tier : 3; // Default to NORMAL
    }

    /**
     * Decay tiers for pairs without recent opportunities
     * @private
     */
    decayTiers() {
        const now = Date.now();
        let demotions = 0;

        for (const [pairKey, data] of this.pairPriority) {
            if (data.tier === 4) continue; // Already at lowest tier

            const tierConfig = this.tiers[data.tier];
            const timeSinceOpportunity = data.lastOpportunity
                ? now - data.lastOpportunity
                : Infinity;

            // Check if pair should be demoted
            if (timeSinceOpportunity > tierConfig.maxAge) {
                const oldTier = data.tier;
                data.tier = Math.min(data.tier + 1, 4);

                if (data.tier !== oldTier) {
                    demotions++;
                    this.stats.demotions++;

                    log.debug(`Pair demoted: ${pairKey}`, {
                        from: this.tiers[oldTier].name,
                        to: this.tiers[data.tier].name,
                        timeSinceOpportunity: Math.round(timeSinceOpportunity / 1000) + 's',
                    });

                    this.emit('tierChange', {
                        pairKey,
                        oldTier,
                        newTier: data.tier,
                        reason: 'decay',
                    });
                }
            }
        }

        if (demotions > 0) {
            this.updateTierDistribution();
        }
    }

    /**
     * Force re-evaluation of a pair's tier based on volume
     * @param {string} pairKey - Pair identifier
     * @param {number} volumeUSD - Recent volume in USD
     */
    updateVolume(pairKey, volumeUSD) {
        const data = this.pairPriority.get(pairKey);
        if (!data) return;

        data.volumeScore = volumeUSD;

        // Adjust tier based on volume (but don't override opportunity-based promotion)
        if (!data.lastOpportunity) {
            if (volumeUSD > this.volumeThresholdHigh && data.tier > 2) {
                const oldTier = data.tier;
                data.tier = 2;
                this.emit('tierChange', { pairKey, oldTier, newTier: 2, reason: 'volume' });
            } else if (volumeUSD < this.volumeThresholdLow && data.tier < 4) {
                const oldTier = data.tier;
                data.tier = 4;
                this.emit('tierChange', { pairKey, oldTier, newTier: 4, reason: 'volume' });
            }
        }
    }

    /**
     * Manually set a pair's tier (for testing or override)
     * @param {string} pairKey - Pair identifier
     * @param {number} tier - Target tier (1-4)
     */
    setTier(pairKey, tier) {
        if (tier < 1 || tier > 4) {
            throw new Error(`Invalid tier: ${tier}. Must be 1-4.`);
        }

        let data = this.pairPriority.get(pairKey);
        if (!data) {
            this.registerPair(pairKey);
            data = this.pairPriority.get(pairKey);
        }

        const oldTier = data.tier;
        data.tier = tier;

        if (oldTier !== tier) {
            this.emit('tierChange', { pairKey, oldTier, newTier: tier, reason: 'manual' });
            this.updateTierDistribution();
        }
    }

    /**
     * Update tier distribution statistics
     * @private
     */
    updateTierDistribution() {
        this.stats.tierDistribution = { 1: 0, 2: 0, 3: 0, 4: 0 };

        for (const data of this.pairPriority.values()) {
            this.stats.tierDistribution[data.tier]++;
        }
    }

    /**
     * Get statistics
     * @returns {Object} Statistics
     */
    getStats() {
        const skipRate = this.stats.checksPerformed + this.stats.checksSkipped > 0
            ? (this.stats.checksSkipped / (this.stats.checksPerformed + this.stats.checksSkipped) * 100).toFixed(1)
            : 0;

        return {
            ...this.stats,
            totalPairs: this.pairPriority.size,
            skipRate: `${skipRate}%`,
            tierNames: {
                1: `HOT (${this.stats.tierDistribution[1]})`,
                2: `WARM (${this.stats.tierDistribution[2]})`,
                3: `NORMAL (${this.stats.tierDistribution[3]})`,
                4: `COLD (${this.stats.tierDistribution[4]})`,
            },
        };
    }

    /**
     * Get detailed pair information
     * @param {string} pairKey - Pair identifier
     * @returns {Object|null} Pair priority data
     */
    getPairInfo(pairKey) {
        const data = this.pairPriority.get(pairKey);
        if (!data) return null;

        return {
            ...data,
            tierName: this.tiers[data.tier].name,
            frequency: this.tiers[data.tier].frequency,
            timeSinceLastOpportunity: data.lastOpportunity
                ? Date.now() - data.lastOpportunity
                : null,
        };
    }

    /**
     * Export priority data for persistence
     * @returns {Object} Serializable priority data
     */
    export() {
        const data = {};
        for (const [key, value] of this.pairPriority) {
            data[key] = { ...value };
        }
        return data;
    }

    /**
     * Import priority data from persistence
     * @param {Object} data - Previously exported data
     */
    import(data) {
        for (const [key, value] of Object.entries(data)) {
            this.pairPriority.set(key, {
                tier: value.tier || 3,
                lastOpportunity: value.lastOpportunity || null,
                lastChecked: Date.now(),
                opportunityCount: value.opportunityCount || 0,
                volumeScore: value.volumeScore || 0,
                liquidityUSD: value.liquidityUSD || 0,
            });
        }
        this.updateTierDistribution();
        log.info(`Imported priority data for ${this.pairPriority.size} pairs`);
    }

    /**
     * Reset all pairs to default tier
     */
    reset() {
        for (const data of this.pairPriority.values()) {
            data.tier = 3;
            data.lastOpportunity = null;
            data.opportunityCount = 0;
        }
        this.stats.promotions = 0;
        this.stats.demotions = 0;
        this.stats.checksSkipped = 0;
        this.stats.checksPerformed = 0;
        this.updateTierDistribution();
        log.info('AdaptivePrioritizer reset');
    }
}

// Export singleton instance
const adaptivePrioritizer = new AdaptivePrioritizer({
    decayIntervalMs: parseInt(process.env.PRIORITIZER_DECAY_INTERVAL || '60000'),
    volumeThresholdHigh: parseInt(process.env.PRIORITIZER_HIGH_VOLUME || '100000'),
    volumeThresholdLow: parseInt(process.env.PRIORITIZER_LOW_VOLUME || '10000'),
});

export default adaptivePrioritizer;
export { AdaptivePrioritizer };
