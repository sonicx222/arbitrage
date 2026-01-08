# Professional-Level Speed Optimization Plan

## Executive Summary

This document provides a systematic analysis of the arbitrage detection, simulation, and execution pipeline with specific optimizations to achieve professional-grade latency. Target: **Sub-50ms detection latency** for event-driven opportunities.

---

## Current Pipeline Analysis

### Detection Latency Breakdown

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        DETECTION PHASE (~250-400ms)                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Block Event                                                                │
│      │                                                                      │
│      ▼                                                                      │
│  ┌──────────────────┐                                                       │
│  │ Dynamic Gas Fetch│ ← BOTTLENECK: 100-200ms RPC call                     │
│  │ (line 42-48)     │                                                       │
│  └────────┬─────────┘                                                       │
│           │                                                                 │
│           ▼                                                                 │
│  ┌──────────────────┐                                                       │
│  │ Sequential Pairs │ ← INEFFICIENCY: O(n) loop, ~2ms per pair             │
│  │ (line 56-63)     │   For 200 pairs = 400ms                              │
│  └────────┬─────────┘                                                       │
│           │                                                                 │
│           ▼                                                                 │
│  ┌──────────────────┐                                                       │
│  │ Triangular Det.  │ ← SEQUENTIAL: Runs after cross-DEX                   │
│  │ (line 67-68)     │   50-200ms for graph traversal                       │
│  └────────┬─────────┘                                                       │
│           │                                                                 │
│           ▼                                                                 │
│  ┌──────────────────┐                                                       │
│  │ Profit Batch     │ ← COMPUTE: ~30-100ms                                 │
│  │ (line 74)        │                                                       │
│  └──────────────────┘                                                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Execution Latency Breakdown

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       EXECUTION PHASE (~300-700ms)                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Opportunity                                                                │
│      │                                                                      │
│      ▼                                                                      │
│  ┌──────────────────┐                                                       │
│  │ Validation       │ ← I/O: Block number check (~5-50ms)                  │
│  │ (line 115)       │                                                       │
│  └────────┬─────────┘                                                       │
│           │                                                                 │
│           ▼                                                                 │
│  ┌──────────────────┐                                                       │
│  │ Pre-Simulation   │ ← COMPUTE: ~30-80ms                                  │
│  │ (line 128)       │   Gas fetch + MEV analysis                           │
│  └────────┬─────────┘                                                       │
│           │                                                                 │
│           ▼                                                                 │
│  ┌──────────────────┐                                                       │
│  │ Flash Pair Res.  │ ← BOTTLENECK: 50-200ms if not cached                 │
│  │ (line 142)       │                                                       │
│  └────────┬─────────┘                                                       │
│           │                                                                 │
│           ▼                                                                 │
│  ┌──────────────────┐                                                       │
│  │ Gas Optimizer    │ ← BOTTLENECK: 50-150ms RPC calls                     │
│  │ (line 145-148)   │                                                       │
│  └────────┬─────────┘                                                       │
│           │                                                                 │
│           ▼                                                                 │
│  ┌──────────────────┐                                                       │
│  │ TX Build         │ ← COMPUTE: ~5-20ms                                   │
│  │ (line 158)       │                                                       │
│  └────────┬─────────┘                                                       │
│           │                                                                 │
│           ▼                                                                 │
│  ┌──────────────────┐                                                       │
│  │ eth_call Sim     │ ← RPC: 100-300ms                                     │
│  │ (line 163)       │                                                       │
│  └──────────────────┘                                                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Optimization Hypotheses

### Detection Phase (P0 - Critical)

| ID | Hypothesis | Confidence | Expected Impact | Effort | Implementation |
|----|------------|------------|-----------------|--------|----------------|
| D1 | **Cache gas price with 1-3s TTL** | 95% | -100-200ms | Low | GasCache class |
| D2 | **Run cross-DEX + triangular in parallel** | 90% | -40-60% time | Medium | Promise.all() |
| D3 | **Early-exit negative spread pairs** | 95% | -30-50% pairs | Low | Pre-filter |
| D4 | **Precompute DEX fee map** | 90% | -5-10ms | Low | Static lookup |
| D5 | **Skip event-updated pairs in detection** | 85% | -50% RPC | Medium | Cache-aware |

### Simulation Phase (P1 - High)

| ID | Hypothesis | Confidence | Expected Impact | Effort | Implementation |
|----|------------|------------|-----------------|--------|----------------|
| S1 | **Skip full simulation for <$3 profit** | 90% | -30% sims | Low | Threshold check |
| S2 | **Batch pre-simulation analysis** | 85% | -40% time | Medium | Array.map |
| S3 | **Cache competition scores by pair** | 80% | -20ms/opp | Low | Map cache |
| S4 | **Parallel analysis methods** | 85% | -30% time | Medium | Promise.all() |

### Execution Phase (P0 - Critical)

| ID | Hypothesis | Confidence | Expected Impact | Effort | Implementation |
|----|------------|------------|-----------------|--------|----------------|
| E1 | **Pre-resolve top 50 flash pairs** | 90% | -50-200ms | Medium | Warm cache |
| E2 | **Cache gas price in optimizer** | 95% | -100ms | Low | Shared cache |
| E3 | **Parallel validation + gas check** | 85% | -30% time | Low | Promise.all() |
| E4 | **Transaction template prebuilding** | 80% | -20ms | Medium | Template cache |
| E5 | **Multicall simulation batching** | 85% | -60% multi | High | Batch eth_call |

---

## P0 Implementations

### 1. Gas Price Cache (D1, E2)

**Location:** `src/utils/gasPriceCache.js`

```javascript
// Singleton gas price cache with 2s TTL
// Prevents redundant RPC calls across detection + execution
class GasPriceCache {
    constructor() {
        this.cache = null;
        this.timestamp = 0;
        this.ttlMs = 2000; // 2 seconds
        this.pendingFetch = null;
    }

    async getGasPrice(provider) {
        const now = Date.now();

        // Return cached if fresh
        if (this.cache && (now - this.timestamp) < this.ttlMs) {
            return this.cache;
        }

        // Coalesce concurrent requests
        if (this.pendingFetch) {
            return this.pendingFetch;
        }

        this.pendingFetch = this._fetchGasPrice(provider);
        const result = await this.pendingFetch;
        this.pendingFetch = null;
        return result;
    }

    async _fetchGasPrice(provider) {
        const feeData = await provider.getFeeData();
        this.cache = {
            gasPrice: feeData.gasPrice,
            maxFeePerGas: feeData.maxFeePerGas,
            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
            timestamp: Date.now(),
        };
        this.timestamp = Date.now();
        return this.cache;
    }
}
```

**Expected improvement:** -100-200ms per detection cycle

### 2. Parallel Detection (D2)

**Location:** `src/analysis/arbitrageDetector.js` (line 55-70)

```javascript
// Before: Sequential
for (const [pairKey, dexPrices] of pairs) { ... }
const triangularOpps = this._detectTriangularOpportunities(...);

// After: Parallel
const [crossDexResults, triangularOpps] = await Promise.all([
    this._detectCrossDexBatch(pairs, gasPrice, blockNumber),
    this.triangularEnabled
        ? triangularDetector.findAllOpportunities(prices, blockNumber)
        : [],
]);
```

**Expected improvement:** -40-60% detection time

### 3. Early-Exit Filter (D3)

**Location:** `src/analysis/arbitrageDetector.js` (before checkOpportunity)

```javascript
// Pre-filter pairs with obvious negative spread
_quickSpreadFilter(pairs, minSpreadPercent = 0.3) {
    return pairs.filter(([pairKey, dexPrices]) => {
        const prices = Object.values(dexPrices).map(d => d.price);
        if (prices.length < 2) return false;

        const min = Math.min(...prices);
        const max = Math.max(...prices);
        const spread = ((max - min) / min) * 100;

        return spread >= minSpreadPercent;
    });
}
```

**Expected improvement:** -30-50% pairs processed

### 4. Flash Pair Preloading (E1)

**Location:** `src/execution/executionManager.js`

```javascript
async warmFlashPairCache() {
    const topPairs = this._getTopTradedPairs(50);
    const preloadPromises = topPairs.map(pair =>
        this._resolveFlashPair({ ...pair, flashPair: 'RESOLVE_PAIR' })
            .catch(() => null) // Ignore errors
    );
    await Promise.all(preloadPromises);
    log.info('Flash pair cache warmed', { pairs: topPairs.length });
}
```

**Expected improvement:** -50-200ms on first execution

---

## Benchmark Metrics

### Target Latencies

| Phase | Current | Target | Improvement |
|-------|---------|--------|-------------|
| Event-driven detection | ~25ms | <15ms | 40% |
| Block-based detection | ~250ms | <100ms | 60% |
| Pre-simulation | ~80ms | <30ms | 62% |
| Transaction build | ~20ms | <10ms | 50% |
| eth_call simulation | ~200ms | ~150ms | 25% |
| **Total (event-driven)** | ~350ms | <150ms | 57% |
| **Total (block-based)** | ~550ms | <250ms | 55% |

### Measurement Points

```javascript
const metrics = {
    detectionStart: performance.now(),
    gasPriceFetched: null,
    pairsFiltered: null,
    crossDexComplete: null,
    triangularComplete: null,
    profitCalculated: null,
    detectionEnd: null,

    executionStart: null,
    validationComplete: null,
    preSimComplete: null,
    flashPairResolved: null,
    gasOptimized: null,
    txBuilt: null,
    simulated: null,
    executionEnd: null,
};
```

---

## Implementation Priority

### Week 1: P0 Critical (80% of gains)

1. [x] Gas price cache implementation
2. [x] Parallel cross-DEX + triangular detection
3. [x] Early-exit spread filter
4. [x] Flash pair cache preloading
5. [ ] Benchmark utilities

### Week 2: P1 High Impact

1. [ ] Pre-simulation threshold skip
2. [ ] Parallel analysis methods in simulator
3. [ ] Competition score caching
4. [ ] Transaction templates

### Week 3: P2 Fine-tuning

1. [ ] Multicall simulation batching
2. [ ] Hot path inlining
3. [ ] Memory allocation optimization
4. [ ] Profiler-guided optimization

---

## Risk Assessment

| Optimization | Risk | Mitigation |
|--------------|------|------------|
| Gas cache staleness | Medium | 2s TTL with fallback |
| Parallel detection race conditions | Low | Stateless functions |
| Early-exit false negatives | Low | Conservative threshold |
| Flash pair cache invalidation | Low | Permanent addresses |

---

## Validation Criteria

### Success Metrics

- [ ] Event-driven detection <15ms (P50)
- [ ] Block-based detection <100ms (P50)
- [ ] Total execution <250ms (P50)
- [ ] No increase in false negatives
- [ ] All existing tests pass

### Rollback Plan

Each optimization is implemented as a separate module with feature flags:

```javascript
config.speedOptimizations = {
    gasPriceCache: true,
    parallelDetection: true,
    earlyExitFilter: true,
    flashPairWarmup: true,
};
```

---

*Document Version: 1.0*
*Created: 2026-01-08*
*Status: Implementation Phase*
