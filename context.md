# Arbitrage Bot Development Context

## Last Updated: 2026-01-07

## Overview

This document serves as conversation history and context for the DeFi arbitrage trading bot project. It tracks implementation progress, design decisions, and next steps.

---

## Recent Session: Detection Optimization (2026-01-07)

### Objective
Research and implement professional-level optimizations to significantly increase arbitrage opportunity detection.

### Research Completed
Created comprehensive research document: `DETECTION_OPTIMIZATION_RESEARCH.md`

**Key Findings:**
- System operates in **reactive, polling-based mode** (3s block intervals)
- Professional arbitrage bots use **event-driven detection** (sub-second response)
- 12 improvement areas identified with confidence tracking

### Implementations Completed

#### 1. Event-Driven Detection via Sync Events (HIGH IMPACT)
**Files:**
- `src/monitoring/eventDrivenDetector.js` (NEW)
- `src/index.js` (MODIFIED - integrated)
- `src/config.js` (MODIFIED - added config options)
- `tests/unit/eventDrivenDetector.test.js` (NEW - 24 tests)

**How it works:**
- Subscribes to Uniswap V2 Sync events on high-priority pairs
- When reserves change, immediately updates cache and triggers detection
- Reduces detection latency from ~3 seconds to <100ms

**Configuration:**
```env
EVENT_DRIVEN_ENABLED=true          # Enable/disable (default: true)
EVENT_DRIVEN_MAX_PAIRS=100         # Max pairs to subscribe
EVENT_DRIVEN_BATCH_SIZE=50         # Subscription batch size
EVENT_DRIVEN_DEBOUNCE_MS=100       # Debounce rapid events
```

**Expected Impact:** +100-300% more opportunities detected

#### 2. Adaptive Pair Prioritization (MEDIUM IMPACT)
**Files:**
- `src/analysis/adaptivePrioritizer.js` (NEW)
- `src/index.js` (MODIFIED - integrated)
- `tests/unit/adaptivePrioritizer.test.js` (NEW - 35 tests)

**How it works:**
- Tracks which pairs had recent arbitrage opportunities
- Promotes active pairs to higher monitoring tiers (more frequent checking)
- Demotes inactive pairs to lower tiers (less frequent checking)

**Tier System:**
| Tier | Name   | Frequency      | Trigger                           |
|------|--------|----------------|-----------------------------------|
| 1    | HOT    | Every block    | Opportunity in last 5 minutes     |
| 2    | WARM   | Every 2 blocks | Opportunity in last 30 minutes    |
| 3    | NORMAL | Every 3 blocks | High volume pairs (default)       |
| 4    | COLD   | Every 5 blocks | Low volume/inactive pairs         |

**Expected Impact:** +40-60% more opportunities with same RPC budget

#### 3. Reserve Differential Analysis (MEDIUM IMPACT)
**Files:**
- `src/analysis/reserveDifferentialAnalyzer.js` (NEW)
- `src/index.js` (MODIFIED - integrated with event-driven flow)
- `tests/unit/reserveDifferentialAnalyzer.test.js` (NEW - 25 tests)

**How it works:**
- Tracks reserve changes across blocks for each pair/DEX combination
- When reserves change significantly on one DEX, checks correlated DEXs for price lag
- Identifies cross-DEX arbitrage opportunities from price lag BEFORE the lagging DEX updates
- Emits `correlatedOpportunity` events when spread exceeds profitable threshold

**Key Thresholds:**
```env
RESERVE_CHANGE_THRESHOLD=0.5        # Significant change threshold (%)
RESERVE_LARGE_CHANGE_THRESHOLD=2.0  # Large change threshold (%)
RESERVE_HISTORY_AGE=30000           # Max history age (ms)
```

**Detection Flow:**
1. EventDrivenDetector receives Sync event with new reserves
2. ReserveDifferentialAnalyzer processes the update
3. Calculates change magnitude vs previous reserves
4. If significant change, checks ALL correlated DEXs for same pair
5. If spread > min profit threshold → emits `correlatedOpportunity`

**Integration with Event-Driven Architecture:**
```javascript
// In setupEventDrivenHandlers():
eventDrivenDetector.on('reserveUpdate', async (data) => {
    // First, run reserve differential analysis
    const differentialResult = reserveDifferentialAnalyzer.processReserveUpdate(data);
    // Then run standard arbitrage detection
    await this.handleReserveUpdate(data);
});

reserveDifferentialAnalyzer.on('correlatedOpportunity', async (data) => {
    await this.handleDifferentialOpportunity(data);
});
```

**Expected Impact:** +20-40% more opportunities from cross-DEX lag detection

### Architecture Changes

```
┌────────────────────────────────────────────────────────────────────┐
│                         ArbitrageBot                                │
├────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────┐    ┌─────────────────────────────┐            │
│  │  Block Monitor  │    │  EventDrivenDetector (NEW)  │            │
│  │  (~3s polling)  │    │  (Real-time Sync events)    │            │
│  └────────┬────────┘    └──────────────┬──────────────┘            │
│           │                            │                            │
│           │                            ▼                            │
│           │             ┌──────────────────────────────────┐       │
│           │             │ ReserveDifferentialAnalyzer (NEW)│       │
│           │             │  (Cross-DEX lag detection)       │       │
│           │             └──────────────┬───────────────────┘       │
│           │                            │                            │
│           └────────────┬───────────────┘                           │
│                        │                                            │
│                        ▼                                            │
│           ┌─────────────────────────────┐                          │
│           │   AdaptivePrioritizer (NEW) │                          │
│           │   (Tier-based monitoring)   │                          │
│           └──────────────┬──────────────┘                          │
│                          │                                          │
│                          ▼                                          │
│           ┌─────────────────────────────┐                          │
│           │    ArbitrageDetector        │                          │
│           │    (Multi-type detection)   │                          │
│           └──────────────┬──────────────┘                          │
│                          │                                          │
│                          ▼                                          │
│           ┌─────────────────────────────┐                          │
│           │    ExecutionManager         │                          │
│           └─────────────────────────────┘                          │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

### Test Coverage

| Module | Tests | Status |
|--------|-------|--------|
| eventDrivenDetector.test.js | 24 | PASS |
| adaptivePrioritizer.test.js | 35 | PASS |
| reserveDifferentialAnalyzer.test.js | 25 | PASS |

### Status Endpoint Changes

The `/status` API now includes:
- `eventDriven`: Stats from EventDrivenDetector
- `prioritizer`: Stats from AdaptivePrioritizer
- `differential`: Stats from ReserveDifferentialAnalyzer
- `detectionStats`: Breakdown of opportunities by source (events vs blocks vs differential)

---

#### 4. V3 Deep Integration (MEDIUM IMPACT)
**Files:**
- `src/analysis/v3LiquidityAnalyzer.js` (NEW)
- `src/analysis/v2v3Arbitrage.js` (MODIFIED - integrated)
- `tests/unit/v3LiquidityAnalyzer.test.js` (NEW - 38 tests)

**How it works:**
- Analyzes tick-level liquidity concentration around current price
- Calculates accurate swap output considering tick crossing
- Detects fee tier arbitrage (same pair, different V3 fee tiers)
- Finds optimal execution path across fee tiers for given trade size

**Key Features:**
1. **Tick-level liquidity analysis** - Fetch and analyze liquidity in ticks around current price
2. **Cross-tick output calculation** - Accurate output that handles liquidity changes at tick boundaries
3. **Fee tier arbitrage** - Detects opportunities between 0.01%, 0.05%, 0.3%, and 1% fee tiers
4. **Optimal tier selection** - Finds best fee tier considering trade size, liquidity, and price impact
5. **Slippage estimation** - Estimates slippage based on active liquidity and concentration score

**Configuration:**
```env
V3_TICK_WINDOW=100              # Ticks to analyze around current price
V3_MIN_LIQUIDITY_USD=1000       # Minimum liquidity to consider
V3_FEE_TIER_THRESHOLD=0.1       # Min spread for fee tier arb (%)
V3_CACHE_MAX_AGE=30000          # Cache max age (ms)
```

**Integration with v2v3Arbitrage:**
```javascript
// In v2v3Arbitrage.analyzeOpportunities():
// Now also checks for V3 fee tier arbitrage
const feeTierOpp = this._checkFeeTierArbitrage(pairKey, v3PairPrices, blockNumber);
if (feeTierOpp) {
    opportunities.push(feeTierOpp);
    this.stats.feeTierArbitrages++;
}
```

**Expected Impact:** +25-50% more opportunities via better execution paths and fee tier arbitrage

---

## Pending Implementations

(None - all planned FREE optimizations have been implemented)

---

## Cost Analysis

| Feature | Cost | Status |
|---------|------|--------|
| Event-Driven Detection | FREE (uses existing WebSocket) | Implemented |
| Adaptive Prioritization | FREE (pure code logic) | Implemented |
| Reserve Differential | FREE (pure code logic) | Implemented |
| V3 Deep Integration | FREE (more RPC calls, within limits) | Implemented |
| Mempool Monitoring | PAID (~$49/mo Alchemy Growth) | Not planned |

---

## Files Modified This Session

### New Files
- `src/monitoring/eventDrivenDetector.js`
- `src/analysis/adaptivePrioritizer.js`
- `src/analysis/reserveDifferentialAnalyzer.js`
- `src/analysis/v3LiquidityAnalyzer.js`
- `tests/unit/eventDrivenDetector.test.js`
- `tests/unit/adaptivePrioritizer.test.js`
- `tests/unit/reserveDifferentialAnalyzer.test.js`
- `tests/unit/v3LiquidityAnalyzer.test.js`
- `DETECTION_OPTIMIZATION_RESEARCH.md`
- `context.md` (this file)

### Modified Files
- `src/index.js` - Integrated new components (EventDrivenDetector, AdaptivePrioritizer, ReserveDifferentialAnalyzer)
- `src/config.js` - Added eventDriven configuration
- `src/analysis/v2v3Arbitrage.js` - Integrated v3LiquidityAnalyzer for fee tier arbitrage detection

---

## Key Design Decisions

1. **Event-driven as enhancement, not replacement**: Block monitoring still runs for fallback and block number tracking. Event-driven detection is additive.

2. **Tier-based prioritization**: Rather than binary include/exclude, we use a tiered system that adjusts frequency rather than completely excluding pairs.

3. **Debouncing strategy**: Rapid events from the same pair are debounced to prevent overwhelming the detection pipeline.

4. **Singleton pattern**: All new components (EventDrivenDetector, AdaptivePrioritizer, ReserveDifferentialAnalyzer, V3LiquidityAnalyzer) use singleton exports for easy integration.

5. **Cross-DEX lag detection**: ReserveDifferentialAnalyzer detects when one DEX has updated prices but correlated DEXs haven't yet - the "lag window" is when arbitrage is most profitable.

6. **V3 fee tier arbitrage**: V3LiquidityAnalyzer detects price differences between fee tiers of the same pair (0.01%, 0.05%, 0.3%, 1%) - a new opportunity type unique to V3.

---

## Performance Expectations

| Metric | Before | After (Expected) |
|--------|--------|------------------|
| Detection latency | ~3000ms | <100ms (events) |
| Opportunities/hour | Baseline | +100-300% |
| RPC calls/block | ~250 | ~200 (prioritization) |
| False positive rate | ~20% | <15% |

---

## Next Steps

1. **Run live testing** to validate improvements from all 4 implemented optimizations
2. Monitor detection metrics (opportunities/hour, detection latency, false positive rate)
3. Consider Mempool Monitoring if profitable enough to justify $49/mo cost
4. Optional future enhancements (see DETECTION_OPTIMIZATION_RESEARCH.md for more ideas)

---

## Environment Notes

- Platform: Windows
- Node.js: ESM modules
- Primary chain: BSC (56)
- Multi-chain support: Available but not primary focus this session
