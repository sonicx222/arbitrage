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
│   └── profitCalculator.js   # Net profit calculations
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
│   └── gasOptimizer.js       # Gas price optimization
│
├── monitoring/               # Blockchain monitoring
│   ├── blockMonitor.js       # New block detection
│   └── alertManager.js       # Opportunity alerts
│
├── utils/                    # Utilities
│   ├── logger.js             # Winston logging
│   └── rpcManager.js         # RPC connection management
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

Per-chain block monitoring:
- WebSocket subscription for new blocks
- HTTP polling fallback
- Block processing timeout handling
- Reconnection logic

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

---

## Data Flow

### Price Update Flow

```
1. BlockMonitor detects new block
2. PriceFetcher queries DEX reserves (multicall)
3. Prices stored in CacheManager
4. ArbitrageDetector scans for opportunities
5. TriangularDetector builds paths
6. ProfitCalculator validates profitability
7. Opportunities emitted to main thread
8. CrossChainDetector aggregates cross-chain
9. AlertManager sends notifications
```

### Execution Flow

```
1. ExecutionManager receives opportunity
2. Pre-flight validation
3. GasOptimizer determines gas price
4. TransactionBuilder constructs TX
5. Simulation via eth_call
6. Live execution (if enabled)
7. Result tracking and statistics
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
}
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

*Last Updated: 2026-01-06*
