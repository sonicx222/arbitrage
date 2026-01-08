import EventEmitter from 'events';
import log from '../utils/logger.js';

/**
 * Execution Simulator
 *
 * Provides advanced simulation capabilities for arbitrage execution:
 * - Realistic execution flow modeling
 * - Competition and MEV risk analysis
 * - Block timing simulation
 * - Historical success rate tracking
 * - Gas price sensitivity analysis
 *
 * This helps predict actual execution success beyond simple eth_call.
 */
class ExecutionSimulator extends EventEmitter {
    constructor(config = {}) {
        super();

        // Simulation parameters
        this.blockTime = config.blockTime || 3000; // ms (3s for BSC)
        this.avgTxPropagation = config.avgTxPropagation || 500; // ms

        // MEV risk thresholds
        this.mevRiskThresholds = {
            low: 0.1,      // < 10% of profit at risk
            medium: 0.3,   // < 30% of profit at risk
            high: 0.5,     // < 50% of profit at risk
        };

        // Competition modeling parameters
        this.competitorConfig = {
            avgCompetitors: config.avgCompetitors || 3,
            avgGasMultiplier: config.avgGasMultiplier || 1.2,
            reactionTime: config.reactionTime || 100, // ms
        };

        // Historical tracking
        this.simulationHistory = [];
        this.maxHistory = config.maxHistory || 500;

        // Success factors (learned from history)
        this.successFactors = {
            profitThreshold: 2.0,      // Min profit % for high success
            liquidityRatio: 0.05,      // Max trade/liquidity ratio
            gasBufferPercent: 20,      // Gas price buffer above base
            blockAge: 0,               // Max blocks since opportunity
        };

        // Statistics
        this.stats = {
            totalSimulations: 0,
            predictedSuccess: 0,
            predictedFailure: 0,
            avgSuccessProbability: 0,
            mevRiskDistribution: { low: 0, medium: 0, high: 0 },
        };

        log.info('Execution Simulator initialized', {
            blockTime: `${this.blockTime}ms`,
            avgCompetitors: this.competitorConfig.avgCompetitors,
        });
    }

    /**
     * Run comprehensive execution simulation
     *
     * @param {Object} opportunity - Arbitrage opportunity
     * @param {Object} options - Simulation options
     * @returns {Object} Simulation results
     */
    simulate(opportunity, options = {}) {
        this.stats.totalSimulations++;
        const startTime = Date.now();

        const {
            gasPrice = 3000000000n, // 3 gwei default
            currentBlock = 0,
            nativePrice = 500,
        } = options;

        // 1. Calculate execution timing
        const timingAnalysis = this._analyzeExecutionTiming(opportunity, currentBlock);

        // 2. Estimate competition risk
        const competitionAnalysis = this._analyzeCompetition(opportunity, gasPrice);

        // 3. Calculate MEV risk
        const mevAnalysis = this._analyzeMEVRisk(opportunity, nativePrice);

        // 4. Analyze price stability
        const priceStability = this._analyzePriceStability(opportunity);

        // 5. Estimate slippage risk
        const slippageRisk = this._analyzeSlippageRisk(opportunity);

        // 6. Calculate overall success probability
        const successProbability = this._calculateSuccessProbability({
            timing: timingAnalysis,
            competition: competitionAnalysis,
            mev: mevAnalysis,
            priceStability,
            slippageRisk,
            opportunity,
        });

        // 7. Generate recommendation
        const recommendation = this._generateRecommendation(
            successProbability,
            competitionAnalysis,
            mevAnalysis,
            opportunity
        );

        // 8. Calculate adjusted expected value
        const adjustedEV = this._calculateAdjustedExpectedValue(
            opportunity,
            successProbability,
            mevAnalysis
        );

        const result = {
            opportunity: {
                type: opportunity.type,
                pair: opportunity.pairKey || opportunity.path?.join('-'),
                profitUSD: opportunity.profitCalculation?.netProfitUSD ||
                          opportunity.estimatedProfitUSD || 0,
            },
            timing: timingAnalysis,
            competition: competitionAnalysis,
            mevRisk: mevAnalysis,
            priceStability,
            slippageRisk,
            successProbability,
            recommendation,
            adjustedEV,
            simulationDuration: Date.now() - startTime,
            timestamp: Date.now(),
        };

        // Record in history
        this._recordSimulation(result);

        // Update stats
        this._updateStats(result);

        // Emit event
        this.emit('simulationComplete', result);

        return result;
    }

    /**
     * Analyze execution timing factors
     *
     * @private
     */
    _analyzeExecutionTiming(opportunity, currentBlock) {
        const opportunityBlock = opportunity.blockNumber || currentBlock;
        const blockAge = currentBlock - opportunityBlock;

        // Time since opportunity detected
        const opportunityAge = opportunity.timestamp
            ? Date.now() - opportunity.timestamp
            : 0;

        // Expected time to execution
        const txPrepTime = 50; // ms to build tx
        const propagationTime = this.avgTxPropagation;
        const expectedBlockWait = this.blockTime / 2; // Average wait for next block
        const totalExpectedTime = txPrepTime + propagationTime + expectedBlockWait;

        // Staleness factor (0-1, higher is worse)
        const stalenessFactor = Math.min(1, blockAge / 3);

        // Time pressure (opportunity may expire)
        const timePressure = opportunityAge > 5000 ? 'high' :
                            opportunityAge > 2000 ? 'medium' : 'low';

        return {
            blockAge,
            opportunityAgeMs: opportunityAge,
            expectedExecutionTimeMs: totalExpectedTime,
            stalenessFactor,
            timePressure,
            isStale: blockAge > 2,
        };
    }

    /**
     * Analyze competition for the opportunity
     *
     * @private
     */
    _analyzeCompetition(opportunity, gasPrice) {
        const profitUSD = opportunity.profitCalculation?.netProfitUSD ||
                         opportunity.estimatedProfitUSD || 0;

        // Estimate number of competitors based on profit size
        // Higher profit = more competition
        const baseCompetitors = this.competitorConfig.avgCompetitors;
        const profitFactor = Math.min(2, profitUSD / 50); // Scale with profit
        const estimatedCompetitors = Math.round(baseCompetitors * (1 + profitFactor));

        // Calculate competitive gas price
        // Competitors will typically bid 10-50% higher
        const competitorGasPrice = BigInt(Math.floor(
            Number(gasPrice) * this.competitorConfig.avgGasMultiplier
        ));

        // Our gas buffer needed to win
        const requiredGasBuffer = Number(competitorGasPrice - gasPrice);
        const gasBufferPercent = (requiredGasBuffer / Number(gasPrice)) * 100;

        // Win probability based on gas price
        const gasPriceAdvantage = Number(gasPrice) / Number(competitorGasPrice);
        const winProbability = Math.pow(gasPriceAdvantage, estimatedCompetitors);

        return {
            estimatedCompetitors,
            competitorGasPrice: competitorGasPrice.toString(),
            requiredGasBuffer,
            gasBufferPercent,
            winProbability,
            competitionLevel: estimatedCompetitors > 5 ? 'high' :
                             estimatedCompetitors > 2 ? 'medium' : 'low',
        };
    }

    /**
     * Analyze MEV extraction risk
     *
     * @private
     */
    _analyzeMEVRisk(opportunity, nativePrice) {
        const profitUSD = opportunity.profitCalculation?.netProfitUSD ||
                         opportunity.estimatedProfitUSD || 0;
        const tradeSize = opportunity.profitCalculation?.tradeSizeUSD ||
                         opportunity.optimalTradeSizeUSD || 0;

        // MEV types and their risk factors
        const mevTypes = {
            frontrunning: {
                applicable: profitUSD > 5, // Worth frontrunning above $5
                riskFactor: 0.4,
                description: 'Bot may detect and frontrun your trade',
            },
            backrunning: {
                applicable: tradeSize > 500, // Backrunning larger trades
                riskFactor: 0.3,
                description: 'Bot may backrun to capture residual profit',
            },
            sandwich: {
                applicable: tradeSize > 1000 && profitUSD > 10,
                riskFactor: 0.5,
                description: 'Risk of sandwich attack on both sides',
            },
        };

        // Calculate total MEV risk
        let totalRisk = 0;
        const applicableRisks = [];

        for (const [type, config] of Object.entries(mevTypes)) {
            if (config.applicable) {
                applicableRisks.push({
                    type,
                    ...config,
                });
                totalRisk += config.riskFactor;
            }
        }

        // Normalize risk to 0-1
        const normalizedRisk = Math.min(1, totalRisk);

        // Potential MEV loss
        const potentialMEVLossUSD = profitUSD * normalizedRisk;

        // Risk level
        const riskLevel = normalizedRisk < this.mevRiskThresholds.low ? 'low' :
                         normalizedRisk < this.mevRiskThresholds.medium ? 'medium' :
                         normalizedRisk < this.mevRiskThresholds.high ? 'high' : 'extreme';

        return {
            applicableRisks,
            totalRisk: normalizedRisk,
            potentialMEVLossUSD,
            riskLevel,
            profitAfterMEV: profitUSD - potentialMEVLossUSD,
            recommendation: this._getMEVRecommendation(riskLevel, profitUSD),
        };
    }

    /**
     * Get MEV protection recommendation
     *
     * @private
     */
    _getMEVRecommendation(riskLevel, profitUSD) {
        if (riskLevel === 'low') {
            return 'Standard execution acceptable';
        }
        if (riskLevel === 'medium') {
            return profitUSD > 20
                ? 'Consider private mempool (Flashbots)'
                : 'Use higher gas price buffer';
        }
        if (riskLevel === 'high' || riskLevel === 'extreme') {
            return 'Use private execution (Flashbots) or reduce trade size';
        }
        return 'Evaluate trade carefully';
    }

    /**
     * Analyze price stability
     *
     * @private
     */
    _analyzePriceStability(opportunity) {
        // Check if we have price history
        const priceHistory = opportunity.priceHistory || [];
        const hasHistory = priceHistory.length > 0;

        if (!hasHistory) {
            // Estimate stability from liquidity
            const rawLiquidity = opportunity.minLiquidityUSD ||
                                opportunity.buyLiquidityUSD || 10000;

            // FIX v3.2: Validate liquidity to prevent NaN propagation
            const liquidity = Number.isFinite(rawLiquidity) && rawLiquidity > 0
                ? rawLiquidity
                : 10000;

            const stabilityScore = Math.min(1, liquidity / 100000);
            return {
                hasHistory: false,
                stabilityScore,
                volatility: 1 - stabilityScore,
                assessment: stabilityScore > 0.7 ? 'stable' :
                           stabilityScore > 0.3 ? 'moderate' : 'volatile',
            };
        }

        // Calculate volatility from history
        const changes = [];
        for (let i = 1; i < priceHistory.length; i++) {
            const change = Math.abs(priceHistory[i] - priceHistory[i - 1]) / priceHistory[i - 1];
            changes.push(change);
        }

        const avgChange = changes.reduce((a, b) => a + b, 0) / changes.length || 0;
        const volatility = avgChange;
        const stabilityScore = Math.max(0, 1 - volatility * 10); // Scale volatility

        return {
            hasHistory: true,
            dataPoints: priceHistory.length,
            avgPriceChange: avgChange,
            volatility,
            stabilityScore,
            assessment: stabilityScore > 0.7 ? 'stable' :
                       stabilityScore > 0.3 ? 'moderate' : 'volatile',
        };
    }

    /**
     * Analyze slippage risk
     *
     * FIX v3.2: Added validation to prevent Infinity/NaN propagation
     * when liquidity is 0, NaN, or Infinity
     *
     * @private
     */
    _analyzeSlippageRisk(opportunity) {
        const rawTradeSize = opportunity.profitCalculation?.tradeSizeUSD ||
                            opportunity.optimalTradeSizeUSD || 0;
        const rawLiquidity = opportunity.minLiquidityUSD ||
                            opportunity.buyLiquidityUSD || 10000;

        // FIX v3.2: Validate inputs to prevent Infinity/NaN propagation
        const tradeSize = Number.isFinite(rawTradeSize) && rawTradeSize >= 0
            ? rawTradeSize
            : 0;
        const liquidity = Number.isFinite(rawLiquidity) && rawLiquidity > 0
            ? rawLiquidity
            : 10000; // Default to safe fallback

        // Trade as percentage of liquidity (now guaranteed finite)
        const tradeRatio = tradeSize / liquidity;

        // Expected slippage (rough estimation)
        // Impact roughly doubles for each 2% of pool traded
        const expectedSlippage = tradeRatio * 2;

        // Slippage risk score (0-1)
        const slippageRisk = Math.min(1, expectedSlippage / 0.1); // Normalize to 10%

        return {
            tradeSize,
            liquidity,
            tradeRatio,
            tradeRatioPercent: tradeRatio * 100,
            expectedSlippage,
            expectedSlippagePercent: expectedSlippage * 100,
            riskLevel: slippageRisk < 0.3 ? 'low' :
                      slippageRisk < 0.6 ? 'medium' : 'high',
            slippageRisk,
        };
    }

    /**
     * Calculate overall success probability
     *
     * @private
     */
    _calculateSuccessProbability(analysis) {
        const { timing, competition, mev, priceStability, slippageRisk, opportunity } = analysis;

        // Weight factors for each component
        const weights = {
            timing: 0.15,
            competition: 0.25,
            mev: 0.20,
            priceStability: 0.15,
            slippage: 0.15,
            profit: 0.10,
        };

        // Timing score (inverted staleness)
        const timingScore = 1 - timing.stalenessFactor;

        // Competition score (win probability)
        const competitionScore = competition.winProbability;

        // MEV score (inverted risk)
        const mevScore = 1 - mev.totalRisk;

        // Price stability score
        const stabilityScore = priceStability.stabilityScore;

        // Slippage score (inverted risk)
        const slippageScore = 1 - slippageRisk.slippageRisk;

        // Profit score (higher profit = more reliable)
        const profitUSD = opportunity.profitCalculation?.netProfitUSD ||
                         opportunity.estimatedProfitUSD || 0;
        const profitScore = Math.min(1, profitUSD / 20); // Scale to $20

        // Weighted average
        const probability =
            (timingScore * weights.timing) +
            (competitionScore * weights.competition) +
            (mevScore * weights.mev) +
            (stabilityScore * weights.priceStability) +
            (slippageScore * weights.slippage) +
            (profitScore * weights.profit);

        return {
            probability: Math.max(0, Math.min(1, probability)),
            probabilityPercent: Math.max(0, Math.min(100, probability * 100)),
            components: {
                timing: { score: timingScore, weight: weights.timing },
                competition: { score: competitionScore, weight: weights.competition },
                mev: { score: mevScore, weight: weights.mev },
                priceStability: { score: stabilityScore, weight: weights.priceStability },
                slippage: { score: slippageScore, weight: weights.slippage },
                profit: { score: profitScore, weight: weights.profit },
            },
            confidence: this._getConfidenceLevel(probability),
        };
    }

    /**
     * Get confidence level from probability
     *
     * @private
     */
    _getConfidenceLevel(probability) {
        if (probability >= 0.8) return 'high';
        if (probability >= 0.6) return 'medium';
        if (probability >= 0.4) return 'low';
        return 'very_low';
    }

    /**
     * Generate execution recommendation
     *
     * @private
     */
    _generateRecommendation(successProbability, competition, mev, opportunity) {
        const probability = successProbability.probability;
        const profitUSD = opportunity.profitCalculation?.netProfitUSD ||
                         opportunity.estimatedProfitUSD || 0;

        // Decision matrix
        if (probability >= 0.7 && mev.riskLevel !== 'high') {
            return {
                action: 'EXECUTE',
                reason: 'High success probability with acceptable MEV risk',
                gasStrategy: 'standard',
                urgency: 'normal',
            };
        }

        if (probability >= 0.5 && profitUSD > 10) {
            return {
                action: 'EXECUTE_WITH_CAUTION',
                reason: 'Moderate success probability but profit justifies attempt',
                gasStrategy: 'aggressive',
                urgency: 'high',
            };
        }

        if (competition.estimatedCompetitors > 5) {
            return {
                action: 'SKIP',
                reason: 'Too much competition',
                gasStrategy: 'n/a',
                urgency: 'none',
            };
        }

        if (mev.riskLevel === 'extreme') {
            return {
                action: 'SKIP',
                reason: 'MEV risk too high',
                gasStrategy: 'n/a',
                urgency: 'none',
            };
        }

        if (probability < 0.3) {
            return {
                action: 'SKIP',
                reason: 'Success probability too low',
                gasStrategy: 'n/a',
                urgency: 'none',
            };
        }

        return {
            action: 'EVALUATE',
            reason: 'Borderline opportunity - review manually',
            gasStrategy: 'conservative',
            urgency: 'low',
        };
    }

    /**
     * Calculate risk-adjusted expected value
     *
     * @private
     */
    _calculateAdjustedExpectedValue(opportunity, successProbability, mevAnalysis) {
        const profitUSD = opportunity.profitCalculation?.netProfitUSD ||
                         opportunity.estimatedProfitUSD || 0;
        const gasCostUSD = opportunity.profitCalculation?.gasCostUSD || 0.5;

        const probability = successProbability.probability;
        const mevLoss = mevAnalysis.potentialMEVLossUSD;

        // Expected value = (profit * P(success)) - (cost * P(failure)) - MEV_risk
        const expectedValue = (profitUSD * probability) -
                             (gasCostUSD * (1 - probability)) -
                             (mevLoss * probability);

        return {
            rawProfit: profitUSD,
            successProbability: probability,
            gasCostOnFailure: gasCostUSD,
            mevRisk: mevLoss,
            expectedValue,
            isPositiveEV: expectedValue > 0,
            evRatio: profitUSD > 0 ? expectedValue / profitUSD : 0,
        };
    }

    /**
     * Record simulation in history
     *
     * @private
     */
    _recordSimulation(result) {
        this.simulationHistory.push({
            timestamp: result.timestamp,
            type: result.opportunity.type,
            profitUSD: result.opportunity.profitUSD,
            successProbability: result.successProbability.probability,
            recommendation: result.recommendation.action,
            adjustedEV: result.adjustedEV.expectedValue,
        });

        // Trim history
        if (this.simulationHistory.length > this.maxHistory) {
            this.simulationHistory = this.simulationHistory.slice(-this.maxHistory);
        }
    }

    /**
     * Update statistics
     *
     * @private
     */
    _updateStats(result) {
        const probability = result.successProbability.probability;

        if (probability >= 0.5) {
            this.stats.predictedSuccess++;
        } else {
            this.stats.predictedFailure++;
        }

        // Update MEV risk distribution
        const mevLevel = result.mevRisk.riskLevel;
        if (mevLevel in this.stats.mevRiskDistribution) {
            this.stats.mevRiskDistribution[mevLevel]++;
        }

        // Update average success probability
        this.stats.avgSuccessProbability =
            ((this.stats.avgSuccessProbability * (this.stats.totalSimulations - 1)) +
             probability) / this.stats.totalSimulations;
    }

    /**
     * Batch simulate multiple opportunities
     *
     * @param {Array} opportunities - Array of opportunities
     * @param {Object} options - Simulation options
     * @returns {Array} Sorted simulation results
     */
    batchSimulate(opportunities, options = {}) {
        const results = opportunities.map(opp => this.simulate(opp, options));

        // Sort by expected value (descending)
        results.sort((a, b) =>
            b.adjustedEV.expectedValue - a.adjustedEV.expectedValue
        );

        return results;
    }

    /**
     * Get opportunities worth executing
     *
     * @param {Array} opportunities - Array of opportunities
     * @param {Object} options - Simulation options
     * @returns {Array} Filtered opportunities
     */
    getExecutableOpportunities(opportunities, options = {}) {
        const results = this.batchSimulate(opportunities, options);

        return results.filter(result =>
            result.recommendation.action === 'EXECUTE' ||
            result.recommendation.action === 'EXECUTE_WITH_CAUTION'
        ).map(result => ({
            ...result,
            originalOpportunity: opportunities.find(
                opp => (opp.pairKey || opp.path?.join('-')) ===
                       result.opportunity.pair
            ),
        }));
    }

    /**
     * Update success factors based on actual execution results
     *
     * @param {Object} executionResult - Actual execution result
     * @param {Object} simulationResult - Previous simulation result
     */
    updateFromExecution(executionResult, simulationResult) {
        // This method would be called after actual execution to learn from results
        // For now, log for future ML integration
        log.debug('Execution feedback received', {
            predicted: simulationResult.successProbability.probability,
            actual: executionResult.success ? 1 : 0,
            profit: executionResult.profit || 0,
        });

        this.emit('executionFeedback', {
            predicted: simulationResult,
            actual: executionResult,
        });
    }

    /**
     * Get simulation statistics
     */
    getStats() {
        const history = this.simulationHistory;
        const avgEV = history.length > 0
            ? history.reduce((sum, s) => sum + s.adjustedEV, 0) / history.length
            : 0;

        return {
            totalSimulations: this.stats.totalSimulations,
            predictedSuccess: this.stats.predictedSuccess,
            predictedFailure: this.stats.predictedFailure,
            avgSuccessProbability: (this.stats.avgSuccessProbability * 100).toFixed(1) + '%',
            mevRiskDistribution: this.stats.mevRiskDistribution,
            historySize: history.length,
            avgExpectedValue: avgEV.toFixed(2),
            recommendationBreakdown: this._getRecommendationBreakdown(),
        };
    }

    /**
     * Get recommendation breakdown from history
     *
     * @private
     */
    _getRecommendationBreakdown() {
        const breakdown = { EXECUTE: 0, EXECUTE_WITH_CAUTION: 0, EVALUATE: 0, SKIP: 0 };

        for (const sim of this.simulationHistory) {
            if (sim.recommendation in breakdown) {
                breakdown[sim.recommendation]++;
            }
        }

        return breakdown;
    }

    /**
     * Clear simulation history
     */
    clearHistory() {
        this.simulationHistory = [];
        this.stats = {
            totalSimulations: 0,
            predictedSuccess: 0,
            predictedFailure: 0,
            avgSuccessProbability: 0,
            mevRiskDistribution: { low: 0, medium: 0, high: 0 },
        };
        log.info('Simulation history cleared');
    }

    /**
     * Export history for analysis
     */
    exportHistory() {
        return {
            history: [...this.simulationHistory],
            stats: this.getStats(),
            successFactors: { ...this.successFactors },
            exportedAt: Date.now(),
        };
    }
}

// Export class (not singleton - may need per-chain instances)
export { ExecutionSimulator };

// Export default singleton for convenience
const executionSimulator = new ExecutionSimulator();
export default executionSimulator;
