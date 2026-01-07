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

Cross-DEX detection:
- Price comparison across DEXes
- Spread calculation
- Optimal trade size estimation
- Profit threshold filtering

### 6. TriangularDetector (`src/analysis/triangularDetector.js`)

Triangular path detection:
- Path enumeration (A -> B -> C -> A)
- Reserve-based profit calculation
- Multi-DEX path support

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

*Last Updated: 2026-01-07 (Added WebSocket Resilience Layer)*
