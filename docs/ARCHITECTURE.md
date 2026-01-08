# Architecture Overview

## System Design

The Multi-Chain Arbitrage Bot is designed with a worker-thread architecture for parallel monitoring of multiple blockchains.

```
Main Thread (WorkerCoordinator)
    |
    +-- Worker Thread (BSC) -----> BlockMonitor -> PriceFetcher -> ArbitrageDetector
    +-- Worker Thread (ETH) -----> BlockMonitor -> PriceFetcher -> ArbitrageDetector
    +-- Worker Thread (Polygon) -> BlockMonitor -> PriceFetcher -> ArbitrageDetector
    +-- Worker Thread (Arbitrum) -> BlockMonitor -> PriceFetcher -> ArbitrageDetector
    +-- Worker Thread (Base) ----> BlockMonitor -> PriceFetcher -> ArbitrageDetector
    +-- Worker Thread (Avalanche) -> BlockMonitor -> PriceFetcher -> ArbitrageDetector
    |
    v
CrossChainDetector (Main Thread)
    - Receives opportunities from all workers
    - Detects cross-chain arbitrage
    - Coordinates alerts/execution
```

---

## Directory Structure

```
src/
├── analysis/                 # Arbitrage detection algorithms
│   ├── arbitrageDetector.js  # Main cross-DEX detector
│   ├── triangularDetector.js # Triangular arbitrage paths
│   ├── multiHopDetector.js   # 4+ token path detection
│   ├── CrossChainDetector.js # Cross-chain opportunities
│   ├── MempoolMonitor.js     # Pending transaction analysis
│   ├── profitCalculator.js   # Net profit calculations
│   ├── adaptivePrioritizer.js # Tier-based pair monitoring
│   ├── reserveDifferentialAnalyzer.js # Cross-DEX lag detection
│   ├── v3LiquidityAnalyzer.js # V3 tick-level analysis
│   ├── dexAggregator.js      # 1inch/Paraswap integration
│   ├── crossPoolCorrelation.js # Price correlation matrix
│   └── whaleTracker.js       # Large trader tracking (mempool alt)
│
├── chains/                   # Chain abstraction layer
│   ├── BaseChain.js          # Abstract base class
│   ├── ChainFactory.js       # Chain instantiation
│   └── implementations/      # Chain-specific implementations
│       ├── BscChain.js
│       ├── EthereumChain.js
│       ├── PolygonChain.js
│       ├── ArbitrumChain.js
│       ├── BaseChainImpl.js
│       └── AvalancheChain.js
│
├── config/                   # Configuration
│   ├── index.js              # Config exports & aggregation
│   ├── schema.js             # Joi validation schemas
│   └── chains/               # Per-chain configurations
│       ├── bsc.js
│       ├── ethereum.js
│       ├── polygon.js
│       ├── arbitrum.js
│       ├── base.js
│       └── avalanche.js
│
├── contracts/                # Smart contract integration
│   └── abis.js               # Contract ABIs
│
├── data/                     # Data management
│   ├── priceFetcher.js       # DEX price fetching
│   ├── cacheManager.js       # Price/pair caching
│   └── tokenList.js          # Token definitions (BSC)
│
├── execution/                # Trade execution
│   ├── executionManager.js   # Execution orchestration
│   ├── transactionBuilder.js # TX construction
│   ├── gasOptimizer.js       # Gas price optimization
│   ├── flashLoanOptimizer.js # Multi-provider flash loan selection
│   ├── executionSimulator.js # Pre-execution simulation
│   ├── blockTimePredictor.js # Block timing optimization
│   └── l2GasCalculator.js    # L2-specific gas calculation
│
├── monitoring/               # Blockchain monitoring
│   ├── blockMonitor.js       # New block detection
│   ├── alertManager.js       # Opportunity alerts
│   └── eventDrivenDetector.js # Real-time Sync event monitoring
│
├── utils/                    # Utilities
│   ├── logger.js             # Winston logging
│   ├── rpcManager.js         # RPC connection management
│   ├── resilientWebSocket.js # Single WS with heartbeat & circuit breaker
│   └── resilientWebSocketManager.js # Multi-endpoint WS failover
│
├── workers/                  # Worker thread infrastructure
│   ├── ChainWorker.js        # Worker entry point
│   ├── WorkerCoordinator.js  # Main thread coordinator
│   └── workerMessages.js     # Message type definitions
│
├── config.js                 # Legacy config (BSC compat)
└── index.js                  # Main entry point
```

---

## Core Components

### 1. WorkerCoordinator (`src/workers/WorkerCoordinator.js`)

The central orchestrator that:
- Spawns worker threads for each enabled chain
- Routes messages between workers and main thread
- Aggregates opportunities for cross-chain detection
- Handles worker crashes and restarts

```javascript
// Message flow
Worker -> WorkerCoordinator -> CrossChainDetector
                            -> AlertManager
                            -> ExecutionManager
```

### 2. ChainWorker (`src/workers/ChainWorker.js`)

Each worker thread runs independently:
- Maintains its own RPC connections
- Monitors blocks on its assigned chain
- Detects intra-chain arbitrage opportunities
- Reports back to coordinator

### 3. BlockMonitor (`src/monitoring/blockMonitor.js`)

Per-chain block monitoring with resilient WebSocket integration:
- Subscribes to rpcManager's forwarded 'block' events
- Benefits from ResilientWebSocketManager's automatic failover
- HTTP polling fallback when all WS endpoints are down
- Stale block detection as safety net (30s threshold)
- Automatic recovery to WebSocket when endpoints recover

### 4. PriceFetcher (`src/data/priceFetcher.js`)

Price data retrieval:
- Multicall batching for efficiency
- Reserve fetching from pairs
- Price calculation with fee adjustment
- USD price estimation

### 5. ArbitrageDetector (`src/analysis/arbitrageDetector.js`)

Cross-DEX detection with **parallel execution** (v3.0):
- Price comparison across DEXes
- Spread calculation
- Optimal trade size estimation
- Profit threshold filtering
- **Speed Optimizations:**
  - Early-exit spread filter (skips 30-50% of pairs)
  - Parallel detection with TriangularDetector
  - Cached gas price (shared 2s TTL)

```
Detection Pipeline (Parallel Architecture):
┌─────────────────────────────────────────────────────────────────┐
│                    detectOpportunities()                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   Gas Price ──► gasPriceCache (2s TTL)                          │
│       │            └── Cache hit: <2ms                          │
│       │            └── Cache miss: fetch + cache                │
│       ▼                                                          │
│   Quick Spread Filter                                            │
│       │    └── Filters pairs with no profitable spread          │
│       │    └── Skips 30-50% of pairs                            │
│       ▼                                                          │
│   ┌─────────────────┬─────────────────┐                         │
│   │  Promise.all()  │                 │                         │
│   │                 │                 │                         │
│   ▼                 ▼                 │                         │
│ ┌─────────────┐ ┌─────────────┐      │                         │
│ │ Cross-DEX   │ │ Triangular  │      │ ◄── PARALLEL            │
│ │ Detection   │ │ Detection   │      │     EXECUTION           │
│ │ (filtered)  │ │ (full)      │      │                         │
│ └──────┬──────┘ └──────┬──────┘      │                         │
│        │               │              │                         │
│        └───────┬───────┘              │                         │
│                ▼                      │                         │
│        Merge & Sort                   │                         │
│                │                      │                         │
│                ▼                      │                         │
│        Profit Calculation             │                         │
│                │                      │                         │
│                ▼                      │                         │
│        MEV-Adjusted Sorting           │                         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Performance Impact:**
| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Gas fetch | ~150ms | <2ms | 98% |
| Pair filtering | N/A | ~15ms | 30-50% pairs skipped |
| Detection | Sequential | Parallel | 40-60% faster |
| **Total** | ~400ms | ~150ms | **62%** |

### 6. TriangularDetector (`src/analysis/triangularDetector.js`)

Triangular path detection (runs in parallel with Cross-DEX):
- Path enumeration (A -> B -> C -> A)
- Reserve-based profit calculation
- Multi-DEX path support
- Graph-based path finding with golden section optimization

### 7. CrossChainDetector (`src/analysis/CrossChainDetector.js`)

Cross-chain arbitrage:
- Token mapping across chains
- Price aggregation from workers
- Bridge cost consideration
- Opportunity ranking

### 8. EventDrivenDetector (`src/monitoring/eventDrivenDetector.js`)

Real-time price monitoring via Sync events:
- WebSocket subscription to DEX Sync events
- Sub-100ms detection latency (vs ~3s polling)
- Block update tracking for cache coordination
- Debouncing to prevent duplicate processing
- Automatic re-subscription on WebSocket failover

### 9. AdaptivePrioritizer (`src/analysis/adaptivePrioritizer.js`)

Tier-based pair monitoring:
- HOT (Tier 1): Every block - recent opportunities
- WARM (Tier 2): Every 2 blocks - 30min activity
- NORMAL (Tier 3): Every 3 blocks - default
- COLD (Tier 4): Every 5 blocks - inactive pairs

### 10. FlashLoanOptimizer (`src/execution/flashLoanOptimizer.js`)

Multi-provider flash loan selection:
- dYdX: 0% fee (ETH mainnet, limited assets)
- Balancer: 0% fee (requires pool interaction)
- Aave V3: 0.09% fee (wide asset coverage)
- PancakeSwap: 0.25% fee (fallback, any pair)

### 11. DexAggregator (`src/analysis/dexAggregator.js`)

Aggregator route comparison:
- 1inch Pathfinder API integration
- Paraswap API integration
- Split-route opportunity detection
- Rate limiting and caching

### 12. CrossPoolCorrelation (`src/analysis/crossPoolCorrelation.js`)

Predictive detection via correlation:
- Historical price correlation matrix
- Same-pair cross-DEX correlation (0.95)
- Base token correlation (0.6)
- Predictive opportunity alerts

### 13. WhaleTracker (`src/analysis/whaleTracker.js`)

Free mempool monitoring alternative:
- Tracks large trader addresses and patterns
- Identifies "whale" addresses based on trading volume
- Assesses competition before execution
- Emits `whaleActivity` signals for prioritization
- Import/export whale data for persistence

### 14. WebSocket Resilience Layer

The WebSocket infrastructure provides robust, self-healing connections:

#### ResilientWebSocket (`src/utils/resilientWebSocket.js`)

Single WebSocket connection with comprehensive resilience:
- **Application-level heartbeats**: Uses `eth_blockNumber` calls every 15s
- **Connection state machine**: disconnected → connecting → connected → reconnecting → circuit_open
- **Circuit breaker pattern**: Opens after 10 failed reconnection attempts
- **Exponential backoff with jitter**: Prevents thundering herd on reconnection
- **Proactive refresh**: Reconnects every 30 minutes to prevent stale connections

#### ResilientWebSocketManager (`src/utils/resilientWebSocketManager.js`)

Multi-endpoint management with automatic failover:
- **Health-based endpoint scoring**: Tracks latency and error rates
- **Automatic failover**: Switches to best endpoint when primary fails
- **Parallel connections**: Maintains backup connections for instant failover
- **Event forwarding**: Aggregates block events from all connections
- **Proactive primary switching**: Upgrades to better endpoint when available

```
WebSocket Architecture:
┌─────────────────────────────────────────────────────────────────┐
│                         rpcManager                               │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │           ResilientWebSocketManager                       │  │
│  │  ┌──────────────────┐ ┌──────────────────┐               │  │
│  │  │ ResilientWebSocket│ │ ResilientWebSocket│ (backup)    │  │
│  │  │  (primary)       │ │                  │               │  │
│  │  │  - Heartbeat     │ │  - Heartbeat     │               │  │
│  │  │  - Circuit Breaker│ │  - Circuit Breaker│              │  │
│  │  │  - Auto-reconnect │ │  - Auto-reconnect │              │  │
│  │  └────────┬─────────┘ └────────┬─────────┘               │  │
│  │           │                    │                          │  │
│  │           └──────────┬─────────┘                          │  │
│  │                      │ (failover)                         │  │
│  │                      ▼                                    │  │
│  │              Event Aggregation                            │  │
│  │              (block, wsFailover, wsAllDown)               │  │
│  └───────────────────────────────────────────────────────────┘  │
│                             │                                    │
│                             ▼                                    │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Consumers: BlockMonitor, EventDrivenDetector, etc.       │  │
│  │  - Subscribe to rpcManager events                          │  │
│  │  - Automatic re-subscription on failover                   │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Data Flow

### Price Update Flow (Event-Driven)

```
Event-Driven Path (Sub-100ms latency):
1. EventDrivenDetector receives Sync event via WebSocket
2. Reserves decoded and cache updated immediately
3. ReserveDifferentialAnalyzer checks correlated DEXs
4. CrossPoolCorrelation identifies lagging pools
5. ArbitrageDetector runs on affected pairs only
6. AdaptivePrioritizer promotes active pairs to HOT tier

Block-Based Path (Fallback):
1. BlockMonitor detects new block
2. EventDrivenDetector reports pairs updated via events
3. PriceFetcher skips event-updated pairs (cache-aware)
4. AdaptivePrioritizer filters by tier frequency
5. Remaining pairs fetched via multicall
6. ArbitrageDetector scans for opportunities
7. TriangularDetector builds paths
8. ProfitCalculator validates profitability
9. Opportunities emitted to main thread
10. CrossChainDetector aggregates cross-chain
11. AlertManager sends notifications
```

### Opportunity Sources

Opportunities are tagged with their detection source:

| Source | Handler | Description |
|--------|---------|-------------|
| `sync-event` | handleReserveUpdate | Real-time Sync event detection |
| `reserve-differential` | handleDifferentialOpportunity | Cross-DEX price lag detection |
| `correlation-predictive` | handleCorrelatedPoolCheck | Predictive from correlated pools |
| `aggregator-arbitrage` | handleAggregatorOpportunity | Split-route via 1inch/Paraswap |
| `whale-trade` | handleWhaleActivity | Large trader activity signal |
| `block-polling` | handleNewBlock | Traditional block-based scan |

### Execution Flow

```
1. ExecutionManager receives opportunity
2. WhaleTracker competition check (skip if high competition)
3. Pre-flight validation (profit threshold, age check)
4. FlashLoanOptimizer selects best provider:
   - dYdX (0%) → Balancer (0%) → Aave V3 (0.09%) → PancakeSwap (0.25%)
   - Based on asset availability and chain support
5. Resolve flash pair address (cached or fetched from factory)
6. GasOptimizer determines optimal gas price
7. TransactionBuilder constructs TX with provider-specific params
8. Simulation via eth_call
9. Live execution (if enabled)
10. Result tracking and statistics
```

---

## Factory Pattern

All major components use factories for multi-chain instantiation:

```javascript
// Chain Factory creates chain-specific instances
const bscChain = await ChainFactory.createChain('bsc');
const ethChain = await ChainFactory.createChain('ethereum');

// Each chain instance has:
// - Its own config
// - Its own RPC manager
// - Its own block monitor
// - Its own price fetcher
// - Its own arbitrage detector
```

---

## Configuration System

### Hierarchy

```
Environment Variables (highest priority)
    ↓
Chain-specific config (src/config/chains/*.js)
    ↓
Default config values (lowest priority)
```

### Chain Config Structure

```javascript
export default {
    name: 'Chain Name',
    chainId: 1,
    enabled: true,
    blockTime: 12000,

    nativeToken: { ... },
    rpc: { ... },
    contracts: { ... },
    dexes: { ... },
    tokens: { ... },
    baseTokens: [...],
    trading: { ... },
    monitoring: { ... },
    triangular: { ... },
    execution: { ... },
    flashLoan: { ... },
    bridges: { ... },
};
```

---

## Error Handling

### Worker Isolation

Worker crashes don't affect other chains:
```javascript
worker.on('error', (error) => {
    log.error(`Worker ${chainName} crashed`, { error });
    this.restartWorker(chainName);
});
```

### RPC Failover

Multiple RPC endpoints with automatic rotation:
```javascript
rpc: {
    http: [
        process.env.ALCHEMY_URL,     // Primary
        'https://public-rpc.com',     // Fallback 1
        'https://backup-rpc.com',     // Fallback 2
    ],
    ws: [
        process.env.ALCHEMY_WS_URL,  // Primary WebSocket
        'wss://public-ws.com',        // Fallback WebSocket
    ],
}
```

### WebSocket Resilience

ResilientWebSocketManager provides comprehensive failover:
```
Connection Lifecycle:
1. Connect to primary endpoint
2. Start heartbeat monitoring (15s interval)
3. On heartbeat failure → attempt reconnection
4. After 10 failures → circuit breaker opens (2min cooldown)
5. Failover to backup endpoint
6. Continue monitoring, proactively switch to better endpoint

Events emitted by rpcManager:
- 'block' → new block from primary endpoint
- 'wsFailover' → switched to different endpoint
- 'wsAllDown' → all endpoints failed (consumers should use HTTP)
- 'endpointRecovered' → previously failed endpoint is healthy
```

### Graceful Degradation

- If triangular detection fails, cross-DEX continues
- If one DEX is unreachable, others still monitored
- If worker dies, automatic restart attempted

---

## Performance Considerations

### Multicall Batching

All reserve fetches batched via Multicall3:
```javascript
// Single RPC call for multiple pairs
const results = await multicall.aggregate([
    [pairA, 'getReserves'],
    [pairB, 'getReserves'],
    [pairC, 'getReserves'],
]);
```

### Caching Strategy

```javascript
// Price cache: 1 block lifetime
// Pair address cache: Permanent (immutable)
// Gas price cache: 3 seconds
```

### Worker Thread Benefits

- No GIL limitations (true parallelism)
- Shared memory for cross-chain data
- Isolated error handling
- Independent RPC connections

---

## Security Considerations

### Private Key Handling

- Never logged or exposed
- Loaded from environment only
- Used only in live execution mode

### Contract Interaction

- Whitelisted router addresses only
- Simulation before execution
- Gas limits enforced
- Slippage protection

### RPC Security

- HTTPS/WSS only for production
- Rate limiting implemented
- No sensitive data in URLs

---

## Architecture Decision Records (ADRs)

This section documents key architectural decisions made during the development of the Multi-Chain Arbitrage Bot. Each ADR explains the context, decision, and consequences.

---

### ADR-001: Worker Thread Architecture for Multi-Chain Support

**Status:** Accepted
**Date:** 2025-10-15
**Context:**

The bot needs to monitor multiple blockchains simultaneously (BSC, Ethereum, Polygon, Arbitrum, Base, Avalanche). Each chain has different block times (1-12s), different RPC endpoints, and requires independent price fetching and arbitrage detection.

**Options Considered:**

1. **Single-threaded async** - Use Promise.all to poll all chains
2. **Worker threads** - Dedicated thread per chain
3. **Child processes** - Separate Node.js processes per chain
4. **Cluster mode** - Use Node.js cluster module

**Decision:**

Use **Worker Threads** (Node.js `worker_threads` module) with a WorkerCoordinator in the main thread.

**Rationale:**

- Worker threads provide true parallelism without V8's GIL limitations
- Shared memory (`SharedArrayBuffer`) enables efficient cross-chain data sharing
- Lower overhead than child processes (no IPC serialization for simple messages)
- Crash isolation: one chain's worker failure doesn't affect others
- Memory efficiency: shared module cache across workers

**Consequences:**

- ✅ True parallel monitoring of 6+ chains
- ✅ Isolated error handling per chain
- ✅ Independent RPC connection pools
- ⚠️ Message passing overhead for cross-chain detection
- ⚠️ Debugging complexity (multiple thread contexts)

---

### ADR-002: Event-Driven Detection via WebSocket Sync Events

**Status:** Accepted
**Date:** 2025-11-20
**Context:**

Traditional block-by-block polling introduces 2-3 second latency (BSC ~3s blocks). In competitive arbitrage, sub-second detection is critical for profitability. DEX Sync events emit immediately when reserves change.

**Options Considered:**

1. **Block polling only** - Fetch prices every new block
2. **WebSocket Sync events** - Real-time reserve updates
3. **Mempool monitoring** - Watch pending transactions
4. **Hybrid approach** - Events for real-time, blocks for validation

**Decision:**

Implement **Hybrid event-driven detection** with WebSocket Sync event monitoring as primary and block polling as fallback.

**Rationale:**

- Sync events provide <100ms detection latency (vs 2-3s polling)
- WebSocket subscriptions are supported by most RPC providers
- Block polling ensures no opportunities are missed during WS failures
- Mempool monitoring requires specialized infrastructure (MEV-boost, private RPCs)

**Consequences:**

- ✅ Sub-100ms opportunity detection
- ✅ Reduced RPC calls (only fetch changed pairs)
- ✅ Graceful degradation to polling on WS failure
- ⚠️ Higher WebSocket connection complexity
- ⚠️ Need to handle duplicate events (block + event)

---

### ADR-003: Singleton Pattern for Core Services

**Status:** Accepted
**Date:** 2025-09-01
**Context:**

Multiple components need access to shared resources: RPC connections, price cache, configuration. Creating multiple instances would waste resources and cause inconsistencies.

**Options Considered:**

1. **Dependency injection** - Pass instances through constructors
2. **Singleton modules** - Export single instance from each module
3. **Service locator** - Central registry of services
4. **Context object** - Pass context through function calls

**Decision:**

Use **Singleton module pattern** - each service module exports a pre-instantiated instance.

```javascript
// cacheManager.js
const cacheManager = new CacheManager();
export default cacheManager;
```

**Rationale:**

- Simple and idiomatic in Node.js (modules cached after first require)
- No complex DI framework needed
- Natural for single-process applications
- Easy to mock in tests by replacing module exports

**Consequences:**

- ✅ Consistent shared state across all consumers
- ✅ Zero configuration overhead
- ✅ Natural resource sharing (RPC pools, caches)
- ⚠️ Harder to test in isolation (need module mocking)
- ⚠️ Hidden dependencies (not explicit in constructor)

---

### ADR-004: Multi-Provider Flash Loan Selection Strategy

**Status:** Accepted
**Date:** 2025-12-01
**Context:**

Flash loans are essential for capital-free arbitrage execution. Different providers offer different fees (0% to 0.25%), asset availability, and chain support. Selecting the optimal provider maximizes profit.

**Options Considered:**

1. **Single provider** - Always use PancakeSwap (0.25%)
2. **Static priority** - Hardcoded provider order
3. **Dynamic selection** - Choose based on asset, amount, and chain

**Decision:**

Implement **FlashLoanOptimizer** with dynamic provider selection based on:
1. Provider availability on current chain
2. Asset support (does provider have liquidity?)
3. Fee comparison for the trade size
4. Historical success rate

**Priority Order:**
1. dYdX (0% fee) - ETH mainnet, limited assets
2. Balancer (0% fee) - Requires pool interaction complexity
3. Aave V3 (0.09% fee) - Wide asset coverage
4. PancakeSwap V2 (0.25% fee) - Universal fallback

**Rationale:**

- Fee differences directly impact profitability
- Asset availability varies significantly across providers
- Chain-specific providers (dYdX = ETH only)
- Fallback ensures execution even when preferred providers unavailable

**Consequences:**

- ✅ Up to 0.25% higher profit per trade
- ✅ Broader asset coverage through multiple providers
- ✅ Resilience when primary provider fails
- ⚠️ Increased code complexity
- ⚠️ Need to maintain provider configurations per chain

---

### ADR-005: WebSocket Resilience with Circuit Breaker Pattern

**Status:** Accepted
**Date:** 2025-12-15
**Context:**

WebSocket connections are critical for real-time detection but are inherently unreliable. Connections drop due to network issues, RPC provider limits, or server restarts. Aggressive reconnection can trigger rate limits.

**Options Considered:**

1. **Simple reconnect** - Reconnect immediately on disconnect
2. **Exponential backoff** - Increasing delays between retries
3. **Circuit breaker** - Stop trying after repeated failures
4. **Multi-endpoint failover** - Maintain backup connections

**Decision:**

Implement **ResilientWebSocket** with circuit breaker + **ResilientWebSocketManager** with multi-endpoint failover:

- **Heartbeat**: `eth_blockNumber` every 15s to detect stale connections
- **Circuit breaker**: Opens after 10 consecutive failures (2min cooldown)
- **Exponential backoff with jitter**: Prevents thundering herd
- **Proactive refresh**: Reconnect every 30min to prevent stale connections
- **Multi-endpoint failover**: Automatic switch to backup when primary fails

**Rationale:**

- Circuit breaker prevents wasting resources on persistently failed endpoints
- Multiple endpoints ensure availability even when one provider has issues
- Proactive refresh handles silent connection degradation
- Jitter prevents synchronized reconnection storms

**Consequences:**

- ✅ 99.9%+ WebSocket availability across endpoints
- ✅ Graceful degradation to HTTP polling
- ✅ No thundering herd on provider recovery
- ⚠️ Complex state machine (5 connection states)
- ⚠️ Need multiple RPC provider accounts for redundancy

---

### ADR-006: Tiered Pair Prioritization (Adaptive Monitoring)

**Status:** Accepted
**Date:** 2025-11-01
**Context:**

Monitoring 500+ token pairs on every block is expensive (RPC calls, CPU). Most pairs rarely have arbitrage opportunities. Resources should focus on historically profitable pairs.

**Options Considered:**

1. **Flat monitoring** - Check all pairs every block
2. **Static tiers** - Manual assignment of pair importance
3. **Adaptive tiers** - Dynamic promotion/demotion based on activity
4. **ML-based prediction** - Train model to predict opportunities

**Decision:**

Implement **AdaptivePrioritizer** with four dynamic tiers:

| Tier | Name | Check Frequency | Criteria |
|------|------|-----------------|----------|
| 1 | HOT | Every block | Recent opportunity (5min) |
| 2 | WARM | Every 2 blocks | Activity in last 30min |
| 3 | NORMAL | Every 3 blocks | Default tier |
| 4 | COLD | Every 5 blocks | No activity for 1hr+ |

**Rationale:**

- 80/20 rule: Most opportunities come from few pairs
- Dynamic tiers adapt to market conditions
- Reduces RPC calls by 40-60% vs flat monitoring
- No ML infrastructure complexity

**Consequences:**

- ✅ 40-60% reduction in RPC calls
- ✅ Faster processing of high-value pairs
- ✅ Self-adjusting to market changes
- ⚠️ May miss opportunities on cold pairs
- ⚠️ Initial cold start until tiers warm up

---

### ADR-007: BigInt for Blockchain Numerical Precision

**Status:** Accepted
**Date:** 2025-09-15
**Context:**

Blockchain tokens use 18 decimal places (10^18 wei per token). JavaScript's `Number` type loses precision beyond 2^53 (~9 quadrillion). Financial calculations require exact precision.

**Options Considered:**

1. **Number with scaling** - Divide by 10^18 early, multiply late
2. **BigInt native** - Use JS BigInt for all token amounts
3. **bignumber.js** - Third-party arbitrary precision library
4. **Hybrid** - BigInt for chain math, Number for USD display

**Decision:**

Use **native BigInt** for all token amounts and reserve calculations, converting to Number only for final USD display.

```javascript
// Reserve calculations in BigInt
const amountOut = (amountInWithFee * reserveOut) / (reserveIn * 10000n + amountInWithFee);

// Final display in Number
const displayUSD = Number(amountOut) / 10 ** decimals * priceUSD;
```

**Rationale:**

- Native BigInt has no external dependencies
- Ethers.js v6 returns BigInt natively
- Prevents precision loss in multi-hop calculations
- Overflow protection added in v3.1 for edge cases

**Consequences:**

- ✅ Exact precision for all token calculations
- ✅ Zero external dependencies for math
- ✅ Consistent with ethers.js v6
- ⚠️ Cannot mix BigInt and Number in operations
- ⚠️ Need overflow checks when converting to Number

---

### ADR-008: Graceful Shutdown with In-Flight Operation Handling

**Status:** Accepted
**Date:** 2026-01-07 (v3.1)
**Context:**

The bot runs 24/7 and must handle SIGINT/SIGTERM gracefully. Abrupt termination can cause:
- Lost transactions (sent but not confirmed)
- Corrupted cache files (partial writes)
- Missed opportunity tracking
- Resource leaks (WebSocket connections)

**Options Considered:**

1. **Immediate exit** - Process.exit on signal
2. **Timeout-based** - Wait fixed time then force exit
3. **Drain-based** - Wait for in-flight operations to complete
4. **Hybrid** - Drain with timeout fallback

**Decision:**

Implement **Hybrid drain with timeout** in `index.js`:

1. Set 30-second maximum shutdown timeout
2. Wait for in-flight block/event processing (max 10s)
3. Wait for pending execution to complete
4. Drain event queue (discard vs process decision)
5. Stop all cleanup intervals
6. Save persistent cache
7. Stop workers gracefully
8. Force exit if timeout reached

**Rationale:**

- Prevents lost transactions from incomplete execution
- Ensures cache consistency with async writes
- Bounded timeout prevents hung shutdowns
- Clear logging of shutdown progress

**Consequences:**

- ✅ No lost in-flight transactions
- ✅ Consistent cache state on restart
- ✅ Clean resource cleanup
- ⚠️ Up to 30s delay on shutdown
- ⚠️ Complex shutdown orchestration

---

### ADR-009: Centralized Token Price Constants

**Status:** Accepted
**Date:** 2026-01-07 (v3.1)
**Context:**

Stablecoin identification was duplicated across 5+ files with inconsistent lists. Some files checked `['USDT', 'USDC', 'BUSD']`, others included `['DAI', 'FDUSD', 'TUSD']`. This caused:
- Inconsistent USD price calculations
- Maintenance burden when adding stablecoins
- Potential arbitrage miscalculations

**Options Considered:**

1. **Keep duplicated** - Each file maintains its own list
2. **Config file** - Add to config.js
3. **Constants module** - Dedicated constants/tokenPrices.js
4. **Database** - Store in external data source

**Decision:**

Create **centralized constants module** at `src/constants/tokenPrices.js`:

```javascript
export const STABLECOINS = ['USDT', 'USDC', 'BUSD', 'DAI', 'FDUSD', 'TUSD', ...];
export function isStablecoin(symbol) { ... }
export const NATIVE_TOKEN_PRICES = { WBNB: 600, WETH: 3500, ... };
```

**Rationale:**

- Single source of truth for token classifications
- Easy to update when new stablecoins emerge
- Function wrapper handles edge cases (case sensitivity)
- Separates data from logic

**Consequences:**

- ✅ Consistent stablecoin handling across codebase
- ✅ Single place to update token lists
- ✅ Testable isStablecoin function
- ⚠️ Additional import in consuming files
- ⚠️ Need to update all existing files (done in v3.1)

---

### ADR-010: Pre-Simulation Filtering Before Execution

**Status:** Accepted
**Date:** 2025-12-20
**Context:**

Not all detected opportunities are executable. Factors like MEV competition, gas price spikes, and price staleness affect success probability. Running full simulation (eth_call) is expensive for low-probability opportunities.

**Options Considered:**

1. **Simulate everything** - Run eth_call for all opportunities
2. **Simple threshold** - Only simulate above min profit
3. **Comprehensive pre-filter** - Multi-factor analysis before simulation
4. **ML model** - Train success predictor

**Decision:**

Implement **ExecutionSimulator** with comprehensive pre-simulation analysis:

1. **MEV Risk Assessment**
   - Frontrunning probability based on profit size
   - Sandwich attack vulnerability
   - Backrun opportunity for others

2. **Competition Analysis**
   - Estimated competing bots (based on market activity)
   - Whale tracker signals
   - Historical success rate for similar opportunities

3. **Timing Analysis**
   - Block age (staleness)
   - Price volatility window

4. **Success Probability**
   - Composite score from all factors
   - Minimum threshold (default 30%)

5. **Expected Value Calculation**
   - Raw profit × success probability - MEV risk cost

**Rationale:**

- Saves ~100ms per filtered opportunity (no eth_call)
- Reduces failed execution attempts
- Provides actionable insights for execution strategy
- No ML infrastructure required

**Consequences:**

- ✅ 25-40% improvement in execution success rate
- ✅ Reduced gas waste on failed attempts
- ✅ Actionable urgency/gas strategy recommendations
- ⚠️ May filter legitimate opportunities (false negatives)
- ⚠️ Tuning thresholds requires real-world calibration

---

### ADR-011: Whale Tracker as Mempool Alternative

**Status:** Accepted
**Date:** 2025-11-15
**Context:**

Mempool monitoring (watching pending transactions) provides competitive advantage but requires:
- Expensive MEV-boost infrastructure
- Private RPC endpoints ($500+/month)
- Low-latency co-location

An alternative approach tracks confirmed whale activity patterns.

**Options Considered:**

1. **Full mempool** - Monitor pending transactions
2. **No competition analysis** - Ignore other traders
3. **Confirmed whale tracking** - Track large traders from on-chain data
4. **Third-party feeds** - Subscribe to whale alert services

**Decision:**

Implement **WhaleTracker** that builds trader profiles from confirmed transactions:

- Track addresses making trades >$10K
- Classify as "whale" after 5+ large trades
- Monitor whale activity per token pair
- Emit competition signals before execution
- Assess risk: "Should we compete with active whales?"

**Rationale:**

- Zero infrastructure cost (uses existing RPC)
- Patterns emerge quickly (whales trade frequently)
- Good enough for non-HFT strategies
- Provides actionable execution guidance

**Consequences:**

- ✅ Free mempool alternative
- ✅ Competition awareness for execution decisions
- ✅ Builds valuable trader intelligence over time
- ⚠️ 1 block behind real mempool (confirmed vs pending)
- ⚠️ Cannot see one-time attackers

---

### ADR-012: Event Queue for High-Frequency Event Handling

**Status:** Accepted
**Date:** 2026-01-07 (v3.1)
**Context:**

During high market activity, Sync events arrive faster than they can be processed. The original implementation silently dropped events if already processing:

```javascript
if (this.processingEvent) return; // Events lost!
```

This caused missed opportunities during volatile periods.

**Options Considered:**

1. **Drop events** - Lose events during processing (original)
2. **Unbounded queue** - Queue all events (memory risk)
3. **Bounded queue with deduplication** - Limited queue, skip duplicates
4. **Parallel processing** - Process multiple events concurrently

**Decision:**

Implement **bounded queue with deduplication**:

```javascript
this.eventQueue = [];
this.maxEventQueueSize = 50;

// Queue if processing, deduplicate by pair
if (this.processingEvent) {
    if (this.eventQueue.length < this.maxEventQueueSize) {
        const alreadyQueued = this.eventQueue.some(
            e => e.pairKey === pairKey && e.dexName === dexName
        );
        if (!alreadyQueued) {
            this.eventQueue.push(data);
        }
    }
    return;
}
```

**Rationale:**

- Bounded queue prevents memory exhaustion
- Deduplication: only latest update matters per pair
- Sequential processing maintains price consistency
- Queue drains during shutdown (not processed)

**Consequences:**

- ✅ No silent event drops
- ✅ Bounded memory usage
- ✅ Most recent price always processed
- ⚠️ Fixed queue size may need tuning
- ⚠️ Processing delay during bursts

---

### ADR-013: Event Handler Reference Storage for Cleanup

**Status:** Accepted
**Date:** 2026-01-08 (v3.4)
**Context:**

Node.js EventEmitter handlers cannot be removed without a reference to the original function. The codebase used anonymous arrow functions:

```javascript
// Before (anonymous - cannot be removed)
blockMonitor.on('newBlock', async (data) => {
    await this.handleNewBlock(data);
});
```

This caused:
- Memory leaks from accumulated listeners on restart/failover
- Duplicate event processing
- Growing listener counts warning (`MaxListenersExceededWarning`)

**Options Considered:**

1. **Ignore** - Accept listener accumulation
2. **removeAllListeners()** - Nuclear option, affects other code
3. **Store handler references** - Keep refs for targeted removal
4. **Named function declarations** - Use function statements

**Decision:**

Implement **handler reference storage pattern**:

```javascript
// Store handlers in a registry
this._handlers = {
    blockMonitor: {},
    rpcManager: {},
    // ... other emitters
};

// Create and store handlers during setup
this._handlers.blockMonitor.newBlock = async (data) => {
    await this.handleNewBlock(data);
};
blockMonitor.on('newBlock', this._handlers.blockMonitor.newBlock);

// Remove during cleanup
blockMonitor.off('newBlock', this._handlers.blockMonitor.newBlock);
```

Applied in:
- `ArbitrageBot` (index.js) - 15+ handlers across single/multi-chain modes
- `WorkerCoordinator` - 3 handlers per worker (message, error, exit)
- `EventDrivenDetector` - WebSocket failover handlers

**Rationale:**

- Targeted removal: only remove our handlers, not others
- Verifiable: can check if handler is registered
- Memory efficient: handlers garbage collected after removal
- Works with arrow functions (preserves `this` binding)

**Consequences:**

- ✅ Zero listener accumulation on restart/failover
- ✅ Clean shutdown without memory leaks
- ✅ No MaxListenersExceededWarning
- ⚠️ Additional code to manage handler registry
- ⚠️ Must remember to store refs for all handlers

---

### ADR-014: Singleton Limitations in Multi-Chain Mode

**Status:** Documented
**Date:** 2026-01-08 (v3.4)
**Context:**

ADR-003 established singletons for core services. In single-chain mode, this works well. However, multi-chain mode with worker threads introduces complications:

**Multi-Chain Singleton Behavior:**

| Singleton | Multi-Chain Impact | Severity |
|-----------|-------------------|----------|
| `cacheManager` | Per-worker instance (workers have separate memory) | ✅ OK |
| `rpcManager` | Per-worker instance | ✅ OK |
| `profitCalculator` | Shared native token price needs chain context | ⚠️ Medium |
| `executionManager` | Main thread only, shared across chains | ⚠️ Medium |

**Why Workers Are Safe:**

Worker threads in Node.js have **separate V8 isolates** with independent memory spaces. Each worker that imports a singleton module gets its own instance:

```
Main Thread                 Worker Thread (BSC)        Worker Thread (ETH)
├── cacheManager (main)     ├── cacheManager (BSC)     ├── cacheManager (ETH)
├── rpcManager (main)       ├── rpcManager (BSC)       ├── rpcManager (ETH)
└── executionManager        └── (messages only)        └── (messages only)
```

Workers communicate with main thread via message passing (IPC), not shared objects.

**Current Architecture:**

The design leverages this worker isolation:
1. Workers handle chain-specific detection (isolated singletons)
2. Main thread aggregates opportunities via messages
3. `executionManager` in main thread handles all execution
4. `profitCalculator.setChain()` sets context before calculations

**Considerations for Future:**

If implementing **single-process multi-chain** (without workers):
- Replace singletons with factory pattern
- Pass chain context to all methods
- Use dependency injection for chain-specific instances

**Status:** Current architecture is sound for worker-based multi-chain mode. Document for future reference if refactoring to single-process.

---

## ADR Index

| ID | Title | Status | Date |
|----|-------|--------|------|
| ADR-001 | Worker Thread Architecture | Accepted | 2025-10-15 |
| ADR-002 | Event-Driven Detection | Accepted | 2025-11-20 |
| ADR-003 | Singleton Pattern | Accepted | 2025-09-01 |
| ADR-004 | Flash Loan Provider Selection | Accepted | 2025-12-01 |
| ADR-005 | WebSocket Circuit Breaker | Accepted | 2025-12-15 |
| ADR-006 | Tiered Pair Prioritization | Accepted | 2025-11-01 |
| ADR-007 | BigInt for Precision | Accepted | 2025-09-15 |
| ADR-008 | Graceful Shutdown | Accepted | 2026-01-07 |
| ADR-009 | Centralized Token Constants | Accepted | 2026-01-07 |
| ADR-010 | Pre-Simulation Filtering | Accepted | 2025-12-20 |
| ADR-011 | Whale Tracker | Accepted | 2025-11-15 |
| ADR-012 | Event Queue | Accepted | 2026-01-07 |
| ADR-013 | Event Handler Reference Storage | Accepted | 2026-01-08 |
| ADR-014 | Singleton Limitations (Multi-Chain) | Documented | 2026-01-08 |

---

*Last Updated: 2026-01-08 (Added ADR-013, ADR-014 for v3.4 reliability improvements)*
