import log from '../utils/logger.js';
import slippageManager from './slippageManager.js';

/**
 * Opportunity Scorer
 *
 * Calculates a composite score for arbitrage opportunities to prioritize
 * execution. Considers multiple factors:
 *
 * 1. Profit potential (40% weight) - Expected net profit in USD
 * 2. Liquidity quality (25% weight) - Pool depth for reliable execution
 * 3. Execution probability (20% weight) - Historical success by type
 * 4. Time sensitivity (10% weight) - Opportunity freshness
 * 5. Token quality (5% weight) - Token type stability
 *
 * Higher scores = better opportunities to execute first.
 */
class OpportunityScorer {
    constructor(config = {}) {
        // Weight configuration (must sum to 1.0)
        this.weights = {
            profit: config.profitWeight || 0.40,
            liquidity: config.liquidityWeight || 0.25,
            execution: config.executionWeight || 0.20,
            time: config.timeWeight || 0.10,
            tokenQuality: config.tokenQualityWeight || 0.05,
        };

        // Validate weights sum to 1.0
        const totalWeight = Object.values(this.weights).reduce((a, b) => a + b, 0);
        if (Math.abs(totalWeight - 1.0) > 0.001) {
            log.warn('Opportunity scorer weights do not sum to 1.0', { totalWeight });
        }

        // Profit score thresholds (USD)
        this.profitThresholds = {
            excellent: 50,    // $50+ = 100 score
            great: 20,        // $20-50 = 80-100
            good: 10,         // $10-20 = 60-80
            acceptable: 5,    // $5-10 = 40-60
            minimum: 1,       // $1-5 = 20-40
        };

        // Liquidity score thresholds (USD)
        this.liquidityThresholds = {
            excellent: 500000,  // $500k+ = 100 score
            great: 100000,      // $100k-500k = 80-100
            good: 50000,        // $50k-100k = 60-80
            acceptable: 10000,  // $10k-50k = 40-60
            minimum: 5000,      // $5k-10k = 20-40
        };

        // Execution probability by opportunity type (historical data)
        this.executionProbability = {
            'triangular': 0.90,           // Same DEX, very reliable
            'cross-dex': 0.75,            // Two DEX, good reliability
            'cross-dex-triangular': 0.65, // Three swaps, cross-DEX
            'stable-arb': 0.85,           // Stablecoin arbitrage
            'stable-depeg': 0.80,         // Stablecoin depeg
            'v2-v3-arb': 0.70,            // V2/V3 cross-arbitrage
            'multi-hop': 0.50,            // 4+ hops, risky
            'cross-chain': 0.40,          // Cross-chain, lowest reliability
        };

        // Time decay settings
        this.maxAge = 10000; // 10 seconds max age
        this.freshThreshold = 1000; // <1 second = fresh

        // Token quality scoring
        this.tokenQualityMultipliers = {
            stablecoin: 1.0,   // Most reliable
            native: 0.95,      // Very reliable
            blueChip: 0.85,    // Reliable
            volatile: 0.70,    // Less reliable
            meme: 0.50,        // Risky
            unknown: 0.60,     // Unknown = cautious
        };

        // Score history for tracking
        this.scoreHistory = [];
        this.maxHistorySize = 1000;

        log.info('Opportunity Scorer initialized', {
            weights: this.weights,
            profitThresholds: this.profitThresholds,
        });
    }

    /**
     * Calculate composite score for an opportunity
     *
     * @param {Object} opportunity - Arbitrage opportunity
     * @returns {Object} Score breakdown and final score (0-100)
     */
    calculateScore(opportunity) {
        const scores = {
            profit: this._scoreProfitPotential(opportunity),
            liquidity: this._scoreLiquidity(opportunity),
            execution: this._scoreExecutionProbability(opportunity),
            time: this._scoreTimeSensitivity(opportunity),
            tokenQuality: this._scoreTokenQuality(opportunity),
        };

        // Calculate weighted final score
        const finalScore = (
            scores.profit * this.weights.profit +
            scores.liquidity * this.weights.liquidity +
            scores.execution * this.weights.execution +
            scores.time * this.weights.time +
            scores.tokenQuality * this.weights.tokenQuality
        );

        // Determine priority tier
        const tier = this._getTier(finalScore);

        const result = {
            finalScore: Math.round(finalScore * 100) / 100,
            tier,
            scores,
            weights: this.weights,
            recommendation: this._getRecommendation(finalScore, opportunity),
        };

        // Track in history
        this._recordScore(opportunity, result);

        return result;
    }

    /**
     * Score profit potential (0-100)
     * Uses logarithmic scaling for diminishing returns
     *
     * @private
     */
    _scoreProfitPotential(opportunity) {
        const profit = opportunity.profitCalculation?.netProfitUSD ||
                      opportunity.netProfitUSD ||
                      opportunity.profitUSD ||
                      0;

        if (profit <= 0) return 0;

        // Logarithmic scaling: log10(profit + 1) * 40
        // $1 = 12, $10 = 40, $100 = 80, $1000 = 120 (capped at 100)
        const rawScore = Math.log10(profit + 1) * 40;
        return Math.min(100, Math.max(0, rawScore));
    }

    /**
     * Score liquidity quality (0-100)
     * Higher liquidity = more reliable execution
     *
     * @private
     */
    _scoreLiquidity(opportunity) {
        const minLiquidity = opportunity.minLiquidityUSD ||
                            opportunity.liquidityUSD ||
                            this._estimateLiquidity(opportunity);

        if (minLiquidity >= this.liquidityThresholds.excellent) return 100;
        if (minLiquidity >= this.liquidityThresholds.great) {
            return 80 + (minLiquidity - this.liquidityThresholds.great) /
                   (this.liquidityThresholds.excellent - this.liquidityThresholds.great) * 20;
        }
        if (minLiquidity >= this.liquidityThresholds.good) {
            return 60 + (minLiquidity - this.liquidityThresholds.good) /
                   (this.liquidityThresholds.great - this.liquidityThresholds.good) * 20;
        }
        if (minLiquidity >= this.liquidityThresholds.acceptable) {
            return 40 + (minLiquidity - this.liquidityThresholds.acceptable) /
                   (this.liquidityThresholds.good - this.liquidityThresholds.acceptable) * 20;
        }
        if (minLiquidity >= this.liquidityThresholds.minimum) {
            return 20 + (minLiquidity - this.liquidityThresholds.minimum) /
                   (this.liquidityThresholds.acceptable - this.liquidityThresholds.minimum) * 20;
        }

        // Below minimum - still score but low
        return Math.max(0, minLiquidity / this.liquidityThresholds.minimum * 20);
    }

    /**
     * Estimate liquidity from opportunity data
     *
     * @private
     */
    _estimateLiquidity(opportunity) {
        // Try to get from reserves
        if (opportunity.reserves && opportunity.reserves.length > 0) {
            const reserveValues = opportunity.reserves.map(r => {
                const inVal = BigInt(r.in || 0);
                const outVal = BigInt(r.out || 0);
                // Rough estimate assuming $1 per unit (conservative)
                return Number(inVal + outVal) / 1e18;
            });
            return Math.min(...reserveValues);
        }

        // Try from trade size (estimate pool is 10x trade size)
        const tradeSize = opportunity.optimalTradeSizeUSD || opportunity.tradeSizeUSD || 0;
        if (tradeSize > 0) {
            return tradeSize * 10;
        }

        return 5000; // Default conservative estimate
    }

    /**
     * Score execution probability (0-100)
     * Based on historical success rates by opportunity type
     *
     * @private
     */
    _scoreExecutionProbability(opportunity) {
        const type = opportunity.type || 'unknown';
        const baseProbability = this.executionProbability[type] || 0.50;

        // Adjust for additional factors
        let adjustedProbability = baseProbability;

        // Slippage adjustment - high slippage = lower success
        const slippage = opportunity.profitCalculation?.slippageRate ||
                        opportunity.slippageRate ||
                        0.01;
        if (slippage > 0.02) adjustedProbability *= 0.9;
        if (slippage > 0.03) adjustedProbability *= 0.85;

        // Gas cost ratio adjustment
        const profit = opportunity.profitCalculation?.netProfitUSD || opportunity.profitUSD || 0;
        const gasCost = opportunity.profitCalculation?.gasCostUSD || opportunity.gasCostUSD || 0;
        const gasRatio = gasCost / (profit + gasCost + 0.01);
        if (gasRatio > 0.3) adjustedProbability *= 0.95; // High gas ratio = tighter margins

        return Math.min(100, adjustedProbability * 100);
    }

    /**
     * Score time sensitivity (0-100)
     * Fresher opportunities score higher
     *
     * @private
     */
    _scoreTimeSensitivity(opportunity) {
        const timestamp = opportunity.timestamp || Date.now();
        const age = Date.now() - timestamp;

        if (age <= 0) return 100; // Future timestamp? Treat as fresh

        if (age < this.freshThreshold) {
            // Very fresh: 90-100
            return 90 + (1 - age / this.freshThreshold) * 10;
        }

        if (age < this.maxAge) {
            // Aging: decay from 90 to 0
            return 90 * (1 - (age - this.freshThreshold) / (this.maxAge - this.freshThreshold));
        }

        // Stale opportunity
        return 0;
    }

    /**
     * Score token quality (0-100)
     * More stable tokens = higher scores
     *
     * @private
     */
    _scoreTokenQuality(opportunity) {
        const tokens = this._extractTokens(opportunity);
        if (tokens.length === 0) return 50; // Default middle score

        // Get quality for each token
        const qualities = tokens.map(token => {
            const type = slippageManager.getTokenType(token);
            return this.tokenQualityMultipliers[type] || this.tokenQualityMultipliers.unknown;
        });

        // Use minimum quality (weakest link)
        const minQuality = Math.min(...qualities);
        return minQuality * 100;
    }

    /**
     * Extract token symbols from opportunity
     *
     * @private
     */
    _extractTokens(opportunity) {
        const tokens = [];

        // From path (triangular)
        if (opportunity.path && Array.isArray(opportunity.path)) {
            tokens.push(...opportunity.path);
        }

        // From pair key
        if (opportunity.pairKey) {
            const parts = opportunity.pairKey.split('/');
            tokens.push(...parts);
        }

        // From tokenA/tokenB
        if (opportunity.tokenA) tokens.push(opportunity.tokenA);
        if (opportunity.tokenB) tokens.push(opportunity.tokenB);

        // Deduplicate
        return [...new Set(tokens)];
    }

    /**
     * Get tier classification from score
     *
     * @private
     */
    _getTier(score) {
        if (score >= 80) return 'EXCELLENT';
        if (score >= 60) return 'GOOD';
        if (score >= 40) return 'ACCEPTABLE';
        if (score >= 20) return 'MARGINAL';
        return 'POOR';
    }

    /**
     * Get execution recommendation based on score
     *
     * @private
     */
    _getRecommendation(score, opportunity) {
        if (score >= 80) {
            return {
                action: 'EXECUTE_IMMEDIATELY',
                priority: 1,
                reason: 'High-quality opportunity with strong profit potential',
            };
        }

        if (score >= 60) {
            return {
                action: 'EXECUTE',
                priority: 2,
                reason: 'Good opportunity worth executing',
            };
        }

        if (score >= 40) {
            return {
                action: 'EXECUTE_IF_IDLE',
                priority: 3,
                reason: 'Acceptable opportunity if no better options',
            };
        }

        if (score >= 20) {
            return {
                action: 'MONITOR',
                priority: 4,
                reason: 'Marginal opportunity - monitor for improvement',
            };
        }

        return {
            action: 'SKIP',
            priority: 5,
            reason: 'Poor opportunity - too risky or low profit',
        };
    }

    /**
     * Score and sort multiple opportunities
     *
     * @param {Array} opportunities - Array of opportunities
     * @returns {Array} Sorted opportunities with scores
     */
    scoreAndSort(opportunities) {
        const scored = opportunities.map(opp => ({
            ...opp,
            scoring: this.calculateScore(opp),
        }));

        // Sort by final score descending
        scored.sort((a, b) => b.scoring.finalScore - a.scoring.finalScore);

        return scored;
    }

    /**
     * Filter opportunities by minimum score threshold
     *
     * @param {Array} opportunities - Array of opportunities with scores
     * @param {number} minScore - Minimum score threshold (default 40)
     * @returns {Array} Filtered opportunities
     */
    filterByScore(opportunities, minScore = 40) {
        return opportunities.filter(opp => {
            const score = opp.scoring?.finalScore || this.calculateScore(opp).finalScore;
            return score >= minScore;
        });
    }

    /**
     * Get top N opportunities by score
     *
     * @param {Array} opportunities - Array of opportunities
     * @param {number} n - Number of top opportunities to return
     * @returns {Array} Top N opportunities
     */
    getTopOpportunities(opportunities, n = 5) {
        const scored = this.scoreAndSort(opportunities);
        return scored.slice(0, n);
    }

    /**
     * Record score to history for analysis
     *
     * @private
     */
    _recordScore(opportunity, result) {
        this.scoreHistory.push({
            timestamp: Date.now(),
            type: opportunity.type,
            finalScore: result.finalScore,
            tier: result.tier,
            profit: opportunity.profitCalculation?.netProfitUSD || opportunity.profitUSD,
        });

        // Trim history
        if (this.scoreHistory.length > this.maxHistorySize) {
            this.scoreHistory = this.scoreHistory.slice(-this.maxHistorySize);
        }
    }

    /**
     * Get scoring statistics
     *
     * @returns {Object} Statistics about scoring performance
     */
    getStats() {
        if (this.scoreHistory.length === 0) {
            return {
                totalScored: 0,
                tierDistribution: {},
                averageScore: 0,
            };
        }

        // Tier distribution
        const tierDistribution = {};
        let totalScore = 0;

        for (const record of this.scoreHistory) {
            tierDistribution[record.tier] = (tierDistribution[record.tier] || 0) + 1;
            totalScore += record.finalScore;
        }

        // Convert to percentages
        const total = this.scoreHistory.length;
        for (const tier of Object.keys(tierDistribution)) {
            tierDistribution[tier] = {
                count: tierDistribution[tier],
                percentage: ((tierDistribution[tier] / total) * 100).toFixed(1) + '%',
            };
        }

        return {
            totalScored: total,
            tierDistribution,
            averageScore: (totalScore / total).toFixed(2),
            weights: this.weights,
        };
    }

    /**
     * Reset score history
     */
    resetHistory() {
        this.scoreHistory = [];
        log.info('Opportunity scorer history reset');
    }

    /**
     * Update weight configuration
     *
     * @param {Object} newWeights - New weight configuration
     */
    updateWeights(newWeights) {
        Object.assign(this.weights, newWeights);

        // Validate weights sum to 1.0
        const totalWeight = Object.values(this.weights).reduce((a, b) => a + b, 0);
        if (Math.abs(totalWeight - 1.0) > 0.001) {
            log.warn('Updated weights do not sum to 1.0, normalizing', { totalWeight });
            // Normalize
            for (const key of Object.keys(this.weights)) {
                this.weights[key] /= totalWeight;
            }
        }

        log.info('Opportunity scorer weights updated', { weights: this.weights });
    }
}

// Export singleton instance
const opportunityScorer = new OpportunityScorer();
export default opportunityScorer;
