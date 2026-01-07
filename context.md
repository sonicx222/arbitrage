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
┌─────────────────────────────────────────────────────────────────────────────┐
│                              ArbitrageBot                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────┐       ┌─────────────────────────────┐                  │
│  │  Block Monitor  │       │  EventDrivenDetector        │                  │
│  │  (~3s polling)  │       │  (Real-time Sync events)    │                  │
│  └────────┬────────┘       │  + Block update tracking    │                  │
│           │                └──────────────┬──────────────┘                  │
│           │                               │                                  │
│           │                               ▼                                  │
│           │                ┌──────────────────────────────────┐             │
│           │                │ ReserveDifferentialAnalyzer      │             │
│           │                │  (Cross-DEX lag detection)       │             │
│           │                └──────────────┬───────────────────┘             │
│           │                               │                                  │
│           └───────────────┬───────────────┘                                 │
│                           │                                                  │
│                           ▼                                                  │
│           ┌───────────────────────────────────────────────┐                 │
│           │         PriceFetcher (OPTIMIZED)              │                 │
│           │  • Cache-aware: skips fresh event data        │                 │
│           │  • Priority-aware: respects tier frequencies  │                 │
│           │  • Stats tracking for optimization monitoring │                 │
│           └───────────────┬───────────────────────────────┘                 │
│                           │                                                  │
│                           ▼                                                  │
│           ┌─────────────────────────────┐                                   │
│           │   AdaptivePrioritizer       │                                   │
│           │   (Tier-based monitoring)   │◄──────────────────┐               │
│           └──────────────┬──────────────┘                   │               │
│                          │                                   │               │
│                          ▼                                   │               │
│           ┌─────────────────────────────┐                   │               │
│           │    ArbitrageDetector        │───(opportunities)─┘               │
│           │    (Multi-type detection)   │                                   │
│           └──────────────┬──────────────┘                                   │
│                          │                                                   │
│                          ▼                                                   │
│           ┌─────────────────────────────┐                                   │
│           │    ExecutionManager         │                                   │
│           └─────────────────────────────┘                                   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Test Coverage

| Module | Tests | Status |
|--------|-------|--------|
| eventDrivenDetector.test.js | 24 | PASS |
| adaptivePrioritizer.test.js | 35 | PASS |
| reserveDifferentialAnalyzer.test.js | 25 | PASS |

### Status Endpoint Changes

The `/status` API now includes:
- `priceFetcher`: Stats from PriceFetcher (cache hits, RPC calls, hit rate)
- `eventDriven`: Stats from EventDrivenDetector (including blocks tracked)
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

#### 5. Architecture Optimization - Cache-Aware Price Fetching (HIGH IMPACT)
**Files:**
- `src/data/priceFetcher.js` (MODIFIED - cache-aware fetching)
- `src/monitoring/eventDrivenDetector.js` (MODIFIED - block update tracking)
- `src/index.js` (MODIFIED - optimized handleNewBlock)
- `tests/integration/botFlow.test.js` (MODIFIED - updated assertions)

**How it works:**
- **Cache-Aware Fetching**: PriceFetcher now checks cache for fresh event-driven data before making RPC calls
- **Block Update Tracking**: EventDrivenDetector tracks which pairs received Sync events per block
- **Priority Integration**: Respects AdaptivePrioritizer tier frequencies when deciding which pairs to fetch
- **Optimized Block Handler**: handleNewBlock passes event-updated pairs to skip redundant RPC calls

**New Methods:**
```javascript
// priceFetcher.js - Cache-aware fetching
async fetchAllPrices(blockNumber, options = {}) {
    const { excludePairs = new Set(), respectPriority = true } = options;
    // Separates fresh cache data from pairs needing RPC fetch
    const { freshPrices, pairsToFetch } = this._separateFreshFromStale(...);
    // Only fetches pairs without fresh data
}

// eventDrivenDetector.js - Block update tracking
getPairsUpdatedInBlock(blockNumber) // Returns Set of pair keys updated in block
wasPairUpdatedInBlock(pairKey, blockNumber) // Quick check for specific pair

// index.js - Optimized flow
const eventUpdatedPairs = eventDrivenDetector.getPairsUpdatedInBlock(blockNumber);
const prices = await priceFetcher.fetchAllPrices(blockNumber, {
    excludePairs: eventUpdatedPairs,
    respectPriority: true,
});
```

**Data Flow (Optimized):**
```
Block Event
    │
    ▼
Get event-updated pairs from EventDrivenDetector
    │
    ▼
Call priceFetcher.fetchAllPrices() with:
  - excludePairs: pairs already updated via Sync events
  - respectPriority: check AdaptivePrioritizer tier frequencies
    │
    ▼
_separateFreshFromStale() categorizes pairs:
  - Fresh from cache (sync-event source) → skip RPC
  - Skipped by priority → use stale cache
  - Need fetch → batch RPC call
    │
    ▼
Merge fresh cache + fetched data → unified prices object
    │
    ▼
Run arbitrage detection on combined prices
```

**Expected Impact:**
- -30-50% reduction in RPC calls when event-driven detection is active
- +20-30% efficiency from priority-based skipping
- Lower latency for block processing

---

## Session 2: Additional Optimizations (2026-01-07)

### Implementations Completed

#### 6. Flash Loan Optimization (MEDIUM IMPACT)
**Files:**
- `src/execution/flashLoanOptimizer.js` (NEW)
- `tests/unit/flashLoanOptimizer.test.js` (NEW - 26 tests)

**How it works:**
- Selects optimal flash loan provider based on fee and asset availability
- Providers ordered by fee: dYdX (0%), Balancer (0%), Aave V3 (0.09%), PancakeSwap (0.25%)
- Automatically selects best available provider for each asset/chain combination
- Tracks estimated savings vs default provider

**Expected Impact:** +20-40% cost savings on flash loan fees

#### 7. DEX Aggregator Integration (MEDIUM IMPACT)
**Files:**
- `src/analysis/dexAggregator.js` (NEW)
- `tests/unit/dexAggregator.test.js` (NEW - 28 tests)

**How it works:**
- Integrates with 1inch and Paraswap routing APIs
- Compares direct DEX price vs aggregator quote
- Finds split-route arbitrage opportunities
- Rate limiting (1 req/sec) and caching (3s TTL)

**Expected Impact:** +15-30% more opportunities via split-route detection

#### 8. Cross-Pool Correlation (MEDIUM IMPACT)
**Files:**
- `src/analysis/crossPoolCorrelation.js` (NEW)
- `tests/unit/crossPoolCorrelation.test.js` (NEW - 32 tests)

**How it works:**
- Builds price correlation matrix from historical data
- Same-pair correlation: WBNB/USDT:pancakeswap ↔ WBNB/USDT:biswap (0.95 score)
- Base token correlation: WBNB/USDT ↔ WBNB/BUSD (0.6 score)
- Emits `checkCorrelated` events for predictive detection

**Expected Impact:** +20-30% more opportunities from predictive detection

---

## Pending Implementations

| Task | Status | Reason |
|------|--------|--------|
| Mempool Monitoring | PENDING | Requires paid Alchemy plan (~$49/mo) |
| Time-of-Day Patterns | FUTURE | Needs historical data collection |
| ML Price Prediction | FUTURE | Requires 3-6 months historical data |

---

## Cost Analysis

| Feature | Cost | Status |
|---------|------|--------|
| Event-Driven Detection | FREE (uses existing WebSocket) | Implemented |
| Adaptive Prioritization | FREE (pure code logic) | Implemented |
| Reserve Differential | FREE (pure code logic) | Implemented |
| V3 Deep Integration | FREE (more RPC calls, within limits) | Implemented |
| Flash Loan Optimization | FREE (pure code logic) | Implemented |
| DEX Aggregator | FREE (1inch/Paraswap free tier) | Implemented |
| Cross-Pool Correlation | FREE (pure code logic) | Implemented |
| Mempool Monitoring | PAID (~$49/mo Alchemy Growth) | Not planned |

---

## Files Modified This Session

### New Files (Session 1)
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

### New Files (Session 2)
- `src/execution/flashLoanOptimizer.js`
- `src/analysis/dexAggregator.js`
- `src/analysis/crossPoolCorrelation.js`
- `tests/unit/flashLoanOptimizer.test.js`
- `tests/unit/dexAggregator.test.js`
- `tests/unit/crossPoolCorrelation.test.js`

### Modified Files (Session 1 & 2)
- `src/index.js` - Integrated new components, optimized handleNewBlock with cache-aware fetching
- `src/config.js` - Added eventDriven configuration
- `src/data/priceFetcher.js` - Added cache-aware fetching, priority integration, stats tracking
- `src/monitoring/eventDrivenDetector.js` - Added block update tracking (getPairsUpdatedInBlock)
- `src/analysis/v2v3Arbitrage.js` - Integrated v3LiquidityAnalyzer for fee tier arbitrage detection
- `tests/integration/botFlow.test.js` - Updated assertions for new fetchAllPrices signature
- `docs/ARCHITECTURE.md` - Updated with new components

### Modified Files (Session 3 - Integration)
- `src/execution/executionManager.js` - Integrated FlashLoanOptimizer for provider selection
- `src/index.js` - Added CrossPoolCorrelation and DexAggregator integration, new handlers

---

## Key Design Decisions

1. **Event-driven as enhancement, not replacement**: Block monitoring still runs for fallback and block number tracking. Event-driven detection is additive.

2. **Tier-based prioritization**: Rather than binary include/exclude, we use a tiered system that adjusts frequency rather than completely excluding pairs.

3. **Debouncing strategy**: Rapid events from the same pair are debounced to prevent overwhelming the detection pipeline.

4. **Singleton pattern**: All new components (EventDrivenDetector, AdaptivePrioritizer, ReserveDifferentialAnalyzer, V3LiquidityAnalyzer) use singleton exports for easy integration.

5. **Cross-DEX lag detection**: ReserveDifferentialAnalyzer detects when one DEX has updated prices but correlated DEXs haven't yet - the "lag window" is when arbitrage is most profitable.

6. **V3 fee tier arbitrage**: V3LiquidityAnalyzer detects price differences between fee tiers of the same pair (0.01%, 0.05%, 0.3%, 1%) - a new opportunity type unique to V3.

7. **Cache-aware fetching**: PriceFetcher now checks for fresh event-driven data before making RPC calls. This makes the event-driven architecture truly complementary to block polling - events provide immediate updates, and block polling only fills gaps for pairs without events.

8. **Block update tracking**: EventDrivenDetector tracks which pairs received Sync events in each block. This allows handleNewBlock to pass this information to priceFetcher, avoiding redundant RPC calls for data already in cache.

---

## Performance Expectations

| Metric | Before | After (Expected) |
|--------|--------|------------------|
| Detection latency | ~3000ms | <100ms (events) |
| Opportunities/hour | Baseline | +100-300% |
| RPC calls/block | ~250 | ~100-150 (cache-aware + prioritization) |
| Cache hit rate | 0% | 30-50% (event data reuse) |
| False positive rate | ~20% | <15% |

---

## Session 3: Module Integration (2026-01-07)

### Objective
Wire the new optimization modules (FlashLoanOptimizer, DexAggregator, CrossPoolCorrelation) into the main bot flow, respecting the fast event-driven architecture.

### Integration Completed

#### FlashLoanOptimizer → ExecutionManager
**Files Modified:**
- `src/execution/executionManager.js`

**Changes:**
- Import and initialize `flashLoanOptimizer` with chain ID
- Modified `_resolveFlashPair()` to use `flashLoanOptimizer.selectBestProvider()`
- Opportunities now include `flashLoanProvider` and `flashLoanFee` fields

**Flow:**
```javascript
// In execute():
opportunity = await this._resolveFlashPair(opportunity);
// opportunity.flashLoanProvider = 'aave_v3' (or 'dydx', 'balancer', 'pancakeswap')
// opportunity.flashLoanFee = 0.0009 (or 0, 0, 0.0025)
```

#### CrossPoolCorrelation → EventDrivenDetector Flow
**Files Modified:**
- `src/index.js`

**Changes:**
- Start `crossPoolCorrelation.start()` in `startSingleChain()`
- Record price updates via `crossPoolCorrelation.recordPriceUpdate()` on each Sync event
- Listen for `checkCorrelated` events for predictive detection
- New handler `handleCorrelatedPoolCheck()` for predictive arbitrage detection
- Stop and log stats on shutdown

**Flow:**
```
Sync Event → reserveUpdate
    │
    ├─→ reserveDifferentialAnalyzer.processReserveUpdate()
    │
    ├─→ crossPoolCorrelation.recordPriceUpdate()
    │       │
    │       └─→ crossPoolCorrelation.processReserveUpdate()
    │               │
    │               └─→ [checkCorrelated event]
    │                       │
    │                       └─→ handleCorrelatedPoolCheck()
    │                               │
    │                               └─→ Predictive arbitrage detection
    │
    └─→ handleReserveUpdate() (standard detection)
```

#### DexAggregator → Opportunity Detection
**Files Modified:**
- `src/index.js`

**Changes:**
- Initialize `dexAggregator.initialize(chainId)` in `startSingleChain()`
- Listen for `opportunity` events from aggregator
- New handler `handleAggregatorOpportunity()` for split-route arbitrage
- Log stats on shutdown

**Flow:**
```javascript
// When aggregator finds better route:
dexAggregator.on('opportunity', async (opportunity) => {
    await this.handleAggregatorOpportunity(opportunity);
});
```

### New Handler Methods

#### handleCorrelatedPoolCheck()
Handles predictive detection when correlated pools update:
- Only processes high-correlation pools (score >= 0.7)
- Builds prices object from cache for correlated pairs
- Runs arbitrage detection proactively
- Tags opportunities with `source: 'correlation-predictive'`

#### handleAggregatorOpportunity()
Handles split-route opportunities from aggregator APIs:
- Logs opportunity details (aggregator, spread, route)
- Records with adaptive prioritizer
- Sends alerts
- Note: Execution not yet implemented (requires different TX building)

### Status Endpoint Changes

The `/status` API now includes:
- `correlation`: Stats from CrossPoolCorrelation (pools tracked, correlation checks)
- `aggregator`: Stats from DexAggregator (quotes requested, opportunities found)
- `whaleTracker`: Stats from WhaleTracker (addresses tracked, whales identified, signals emitted)

### Test Results
- **1061 tests passing** (1 skipped)
- All integration-related tests pass

---

## Session 4: Whale Tracker Integration (2026-01-07)

### Objective
Wire the WhaleTracker (mempool mitigation) into the main bot flow to use whale competition assessment before executing opportunities.

### Integration Completed

#### WhaleTracker → Main Bot Flow
**Files Modified:**
- `src/index.js`

**Changes:**
- Import and set up `whaleTracker` singleton
- Added `handleWhaleActivity()` handler for whale signals
- Added `shouldExecuteWithWhaleCheck()` method for competition assessment
- Integrated whale check before execution in all opportunity handlers:
  - `handleDifferentialOpportunity()` - Reserve differential opportunities
  - `handleCorrelatedPoolCheck()` - Correlation-based predictive detection
  - `handleReserveUpdate()` - Event-driven Sync event opportunities
  - `handleNewBlock()` - Block-polling opportunities
- Added whale tracker stats to `getStatus()` endpoint
- Added whale tracker stats logging on shutdown

**Flow:**
```
Opportunity Detected
    │
    ▼
shouldExecuteWithWhaleCheck(opportunity)
    │
    ├─→ whaleTracker.assessCompetition(pairKey, direction)
    │       │
    │       ├─→ level: 'high', recommendation: 'caution' → SKIP EXECUTION
    │       │
    │       ├─→ level: 'medium' → LOG + PROCEED
    │       │
    │       └─→ level: 'low'/'none' → PROCEED
    │
    └─→ executionManager.execute(opportunity)
```

**Note on Full Functionality:**
Currently, WhaleTracker can:
- Import known whale addresses via `importWhales()`
- Emit `whaleActivity` events when known whales trade
- Assess competition via `assessCompetition()`

~~Full automatic whale detection requires Swap event processing (to get trader addresses), which is a future enhancement. Currently Sync events only provide reserve data, not trader addresses.~~ **IMPLEMENTED** - See Session 5 below.

### Status Endpoint Changes

The `/status` API now includes:
- `whaleTracker`: Stats from WhaleTracker (addresses tracked, whales identified, signals emitted)

---

## Session 5: Swap Event Processing for Whale Tracking (2026-01-07)

### Objective
Implement Swap event processing in EventDrivenDetector to capture trader addresses and feed them to WhaleTracker for automatic whale detection.

### Implementation Completed

#### Swap Event Processing → EventDrivenDetector
**Files Modified:**
- `src/monitoring/eventDrivenDetector.js`
- `tests/unit/eventDrivenDetector.test.js`

**Changes:**
- Added `SWAP_TOPIC` constant for Uniswap V2 Swap events
- Added swap event configuration (`swapEventsEnabled`, `minSwapUSD`)
- Added swap statistics tracking (`swapEventsReceived`, `swapEventsProcessed`, `lastSwapTime`)
- Implemented `subscribeToSwapEvents()` for WebSocket subscription
- Implemented `handleSwapEvent()` for processing Swap events
- Implemented `decodeSwapEvent()` for parsing event data (sender, recipient, amounts)
- Implemented `calculateSwapValue()` for USD value and direction calculation

**Technical Details:**
```javascript
// Swap event topic (Uniswap V2 style)
// event Swap(address indexed sender, uint amount0In, uint amount1In,
//            uint amount0Out, uint amount1Out, address indexed to)
this.SWAP_TOPIC = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';

// Configuration
this.swapEventsEnabled = config.eventDriven?.swapEvents !== false;
this.minSwapUSD = config.eventDriven?.minSwapUSD || 1000;
```

**Event Flow:**
```
WebSocket receives Swap event
    │
    ▼
handleSwapEvent() → decodeSwapEvent()
    │
    ├─→ Extract sender/recipient from indexed topics
    │
    ├─→ Decode amounts from data field
    │
    ├─→ calculateSwapValue() → USD value + direction
    │
    ├─→ Filter by minSwapUSD threshold
    │
    └─→ emit('swapDetected', { sender, recipient, amountUSD, direction, ... })
```

#### WhaleTracker Integration → index.js
**Files Modified:**
- `src/index.js`

**Changes:**
- Added event listener for `swapDetected` events from EventDrivenDetector
- Implemented `handleSwapForWhaleTracking()` method
- Records both sender and recipient addresses (recipient with opposite direction)

**Integration Flow:**
```
eventDrivenDetector.emit('swapDetected')
    │
    ▼
handleSwapForWhaleTracking(swapData)
    │
    ├─→ whaleTracker.recordTrade(sender, ...)
    │
    └─→ whaleTracker.recordTrade(recipient, ...) // if different from sender
```

### Test Coverage

Added 10 new tests for Swap event processing:
- `should have correct Swap event topic hash`
- `should correctly decode Swap event data`
- `should return null for invalid swap event data`
- `should return null for insufficient data length`
- `should calculate swap value and direction correctly for buy`
- `should calculate swap value and direction correctly for sell`
- `should emit swapDetected event on valid swap`
- `should update swap statistics`
- `should ignore swaps below minimum USD threshold`
- `should ignore swaps from unknown pairs`
- `should include swap event stats in getStats`

**Total tests:** 35 tests for eventDrivenDetector.test.js (all passing)

### Architecture Impact

Now the system has **full automatic whale detection**:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Event-Driven Architecture                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  WebSocket Provider                                                  │
│       │                                                              │
│       ├─────────────────────────────────────────────────────────┐   │
│       │                                                         │   │
│       ▼                                                         ▼   │
│  ┌─────────────────┐                                ┌─────────────┐ │
│  │  Sync Events    │                                │ Swap Events │ │
│  │  (Reserves)     │                                │ (Traders)   │ │
│  └────────┬────────┘                                └──────┬──────┘ │
│           │                                                │        │
│           ▼                                                ▼        │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │              EventDrivenDetector                               │ │
│  │  • reserveUpdate events → Arbitrage Detection                  │ │
│  │  • swapDetected events → WhaleTracker                          │ │
│  └───────────────────────────────┬────────────────────────────────┘ │
│                                  │                                  │
│                                  ▼                                  │
│                       ┌────────────────────┐                        │
│                       │   WhaleTracker     │                        │
│                       │ • Auto-detect whales│                       │
│                       │ • Competition check │                       │
│                       │ • Activity signals  │                       │
│                       └────────────────────┘                        │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Expected Impact

- **Automatic whale detection**: No longer requires manual whale address imports
- **Real-time trader tracking**: Every Swap event feeds trader data to WhaleTracker
- **Better competition assessment**: More data for `assessCompetition()` decisions
- **MEV bot detection**: Tracking recipients helps identify arbitrage/MEV contracts

---

## Session 6: V3 Event-Driven Detection (2026-01-07)

### Objective
Add V3 Swap event support to EventDrivenDetector for real-time price updates from V3 pools.

### Implementation Completed

#### V3 Swap Event Processing
**Files Modified:**
- `src/monitoring/eventDrivenDetector.js`
- `src/index.js`
- `tests/unit/eventDrivenDetector.test.js`

**Key Differences V2 vs V3:**

| Feature | V2 | V3 |
|---------|----|----|
| Price updates | Sync event (reserves only) | Swap event (includes sqrtPriceX96, tick) |
| Swap amounts | uint256 (always positive) | int256 (signed: +IN, -OUT) |
| Fee tiers | Single fixed fee | Multiple (0.01%, 0.05%, 0.25%, 1%) |
| Price data | Calculated from reserves | Direct from sqrtPriceX96 |
| Event topic | `0x1c411e...` (Sync) | `0xc42079...` (V3 Swap) |

**V3 Swap Event Signature:**
```solidity
event Swap(
    address indexed sender,
    address indexed recipient,
    int256 amount0,      // Positive = tokens IN, Negative = tokens OUT
    int256 amount1,      // Positive = tokens IN, Negative = tokens OUT
    uint160 sqrtPriceX96, // sqrt(price) * 2^96
    uint128 liquidity,   // Current liquidity in range
    int24 tick           // Current tick after swap
);
```

**New Components:**
1. **V3 Pool Registry** - Separate registry for V3 pools (`v3PoolRegistry`, `addressToV3PoolInfo`)
2. **V3 Swap Topic** - `SWAP_TOPIC_V3 = 0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67`
3. **V3 Event Decoder** - `decodeSwapEventV3()` handles signed int256 amounts
4. **V3 Price Calculator** - `calculateSwapValueV3()` extracts price from sqrtPriceX96
5. **Signed Integer Parsing** - `_parseSignedInt256()`, `_parseSignedInt24()` for two's complement

**V3-Specific Stats:**
```javascript
stats: {
    v3SwapEventsReceived: 0,
    v3SwapEventsProcessed: 0,
    v3PriceUpdates: 0,
    lastV3SwapTime: null,
}
```

**Configuration:**
```env
EVENT_DRIVEN_V3_ENABLED=true        # Enable V3 event monitoring
EVENT_DRIVEN_MAX_V3_POOLS=50        # Max V3 pools to subscribe
```

**Integration Flow:**
```
V3 Swap Event
    │
    ▼
handleSwapEventV3()
    │
    ├─→ decodeSwapEventV3() → Parse signed amounts, sqrtPriceX96
    │
    ├─→ calculateSwapValueV3() → USD value, direction, price from sqrt
    │
    ├─→ emit('v3PriceUpdate') → Price/liquidity for correlation tracking
    │
    └─→ emit('swapDetected') → Whale tracking (if > minSwapUSD)
```

**index.js Handler:**
```javascript
eventDrivenDetector.on('v3PriceUpdate', async (data) => {
    // Record for cross-pool correlation
    crossPoolCorrelation.recordPriceUpdate({ ... });
    // Run differential analysis
    reserveDifferentialAnalyzer.processReserveUpdate({ ... });
});
```

### Test Coverage
- **19 new V3 tests** added to `eventDrivenDetector.test.js`
- Total: **54 tests passing** for event-driven detector

### Why V3 Events are More Valuable

1. **Direct Price Data**: V3 Swap events include `sqrtPriceX96` - no need to calculate from reserves
2. **Better Precision**: Concentrated liquidity means price data is exact within active range
3. **Fee Tier Info**: Can track which fee tier pools are active
4. **Liquidity Signal**: `liquidity` field shows available depth at current price
5. **Tick Data**: `tick` reveals exact position in price range

### Architecture Impact

```
┌──────────────────────────────────────────────────────────────────────┐
│                    EventDrivenDetector                                │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  WebSocket Provider                                                   │
│       │                                                               │
│       ├─────────────────────────────┬─────────────────────────┐      │
│       │                             │                         │      │
│       ▼                             ▼                         ▼      │
│  ┌─────────────────┐       ┌─────────────────┐      ┌──────────────┐ │
│  │  V2 Sync Events │       │  V2 Swap Events │      │ V3 Swap Events│ │
│  │  (Reserves)     │       │  (Traders)      │      │ (Price+Traders)│
│  └────────┬────────┘       └────────┬────────┘      └───────┬──────┘ │
│           │                         │                       │        │
│           ▼                         ▼                       ▼        │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │              Event Processing & Emission                        │  │
│  │  • reserveUpdate (V2 price updates)                            │  │
│  │  • swapDetected (V2+V3 whale tracking)                         │  │
│  │  • v3PriceUpdate (V3 price + tick + liquidity)                 │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Next Steps

1. **Run live testing** to validate improvements from all 8 implemented optimizations
2. Monitor detection metrics (opportunities/hour, detection latency, false positive rate)
3. Monitor new metrics:
   - `correlation.correlationChecks` - How often correlation-based detection triggers
   - `aggregator.opportunitiesFound` - Split-route opportunities detected
   - `execution.flashLoanProvider` - Which providers are being selected
4. Consider Mempool Monitoring if profitable enough to justify $49/mo cost
5. Optional future enhancements (see DETECTION_OPTIMIZATION_RESEARCH.md for more ideas)

---

## Environment Notes

- Platform: Windows
- Node.js: ESM modules
- Primary chain: BSC (56)
- Multi-chain support: Available but not primary focus this session
