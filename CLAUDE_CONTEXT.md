# Claude Context Document

This document provides context for AI assistants working on this project. It captures architecture decisions, implementation status, and planned work.

## Project Overview

**Name:** Multi-Chain Arbitrage Bot
**Original Scope:** BSC-only arbitrage detection
**Current Scope:** Multi-chain arbitrage detection across 6 blockchains
**Status:** Phase 6 complete, Phase 7 (documentation) in progress

## Architecture

### High-Level Design

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

### Key Design Patterns

1. **Worker Threads over Cluster**: Worker threads share memory and are easier to coordinate
2. **Factory Pattern**: Modules converted from singletons to factories for per-chain instantiation
3. **Error Isolation**: Worker crashes auto-restart without affecting other chains
4. **Chain Config Files**: Each chain has its own config with DEXes, tokens, RPC endpoints

### Directory Structure

```
src/
├── index.js                    # Main entry point with ArbitrageBot class
├── config.js                   # Legacy BSC config (deprecated, use chains/)
├── alerts/
│   └── alertManager.js         # Telegram/Discord notifications
├── analysis/
│   ├── arbitrageDetector.js    # Cross-DEX arbitrage detection
│   ├── triangularDetector.js   # Triangular arbitrage (A->B->C->A)
│   ├── CrossChainDetector.js   # Cross-chain price discrepancies
│   ├── MultiHopDetector.js     # 4+ token paths
│   └── MempoolMonitor.js       # Pending transaction analysis
├── chains/
│   ├── BaseChain.js            # Abstract base class for all chains
│   ├── ChainFactory.js         # Creates chain instances
│   └── implementations/        # Per-chain implementations
│       ├── BSCChain.js
│       ├── EthereumChain.js
│       ├── PolygonChain.js
│       ├── ArbitrumChain.js
│       ├── BaseChainImpl.js
│       └── AvalancheChain.js
├── config/
│   ├── schema.js               # Config validation with Joi
│   └── chains/                 # Per-chain configurations
│       ├── bsc.js
│       ├── ethereum.js
│       ├── polygon.js
│       ├── arbitrum.js
│       ├── base.js
│       └── avalanche.js
├── data/
│   ├── cacheManager.js         # LRU cache for prices
│   ├── priceFetcher.js         # DEX price fetching
│   └── tokenList.js            # Token definitions
├── dexes/
│   ├── BaseDEX.js              # Abstract DEX class
│   └── implementations/
│       ├── UniswapV2.js        # Uniswap V2 fork support
│       └── UniswapV3.js        # Uniswap V3 concentrated liquidity
├── execution/
│   ├── executionManager.js     # Trade execution
│   ├── gasOptimizer.js         # Gas price optimization
│   └── profitCalculator.js     # Profit/loss calculations
├── monitoring/
│   ├── blockMonitor.js         # Block event subscription
│   └── performanceTracker.js   # System metrics
├── utils/
│   ├── logger.js               # Winston logging
│   └── rpcManager.js           # RPC endpoint management with failover
└── workers/
    ├── ChainWorker.js          # Worker thread entry point
    ├── WorkerCoordinator.js    # Main thread worker management
    └── workerMessages.js       # Message type definitions
```

## Implementation Status

### Completed Phases

#### Phase 1: Foundation Refactoring ✅
- BaseChain abstract class
- ChainFactory for instantiation
- Config schema validation
- BSC config migration

#### Phase 2: Worker Thread Infrastructure ✅
- ChainWorker entry point
- WorkerCoordinator management
- Worker message protocol
- Auto-restart on crash

#### Phase 3: Chain Configurations ✅
- All 6 chains configured (BSC, Ethereum, Polygon, Arbitrum, Base, Avalanche)
- Chain implementations created
- DEX base classes (UniswapV2, UniswapV3)

#### Phase 4: Cross-Chain Detection ✅
- CrossChainDetector implementation
- Token registry for multi-chain mapping
- Bridge cost consideration

#### Phase 5: Advanced Detection ✅
- MultiHopDetector for 4+ token paths
- Graph-based pathfinding

#### Phase 6: Mempool Monitoring ✅
- MempoolMonitor for pending transactions
- Large swap detection
- Sandwich opportunity identification

### Current Phase

#### Phase 7: Documentation (Complete)
- [x] CLAUDE_CONTEXT.md (this file)
- [x] TODO.md (task tracking)
- [x] Chain configuration tests (77 tests)
- [x] docs/ARCHITECTURE.md - System design and component overview
- [x] docs/CHAINS.md - Per-chain details and configuration
- [x] docs/CONFIG.md - Environment variables and settings reference
- [x] docs/PROFIT_AND_GAS.md - Profit calculation analysis and future extensions
- [ ] README.md update for multi-chain (optional)

### Recent Fixes (2026-01-06)
- Fixed `getEnabledChains()` return type bugs in index.js (object vs array)
- Created all 5 missing chain implementations (Ethereum, Polygon, Arbitrum, Base, Avalanche)
- Fixed Windows path handling for main module detection
- Fixed invalid DAI token address in Ethereum config
- Fixed L2 gas price parsing (parseInt -> parseFloat for sub-1 gwei values)

### Priority 0 Implementation (2026-01-06)
- **Dynamic Token Pricing**: Added `getNativeTokenPrice()` and `getTokenPriceUSD()` to cacheManager.js. Updated profitCalculator.js to use dynamic pricing from cached DEX pair data instead of hardcoded values.
- **L2 Gas Fee Calculation**: Created `src/execution/l2GasCalculator.js` supporting Arbitrum (ArbGasInfo precompile) and Base (GasPriceOracle). Integrated into profitCalculator.js with `calculateNetProfitAsync()` method.
- **Execution Flow Wiring**: Connected opportunity detectors to executionManager in both single-chain and multi-chain modes. Added execution stats logging on shutdown.

## Supported Chains & DEXes

| Chain | Chain ID | DEXes |
|-------|----------|-------|
| BSC | 56 | PancakeSwap, Biswap, ApeSwap, BabySwap, MDEX |
| Ethereum | 1 | Uniswap V2/V3, SushiSwap, Curve |
| Polygon | 137 | QuickSwap, SushiSwap, Uniswap V3 |
| Arbitrum | 42161 | Uniswap V3, SushiSwap, Camelot |
| Base | 8453 | Uniswap V3, Aerodrome, BaseSwap |
| Avalanche | 43114 | TraderJoe, Pangolin, SushiSwap |

## Testing

### Test Configuration
- **Framework:** Jest with ES modules
- **Config:** `jest.config.js`
- **Setup:** `tests/setup.js` (timer wrapping, NODE_ENV=test)
- **Teardown:** `tests/teardown.js`

### Running Tests
```bash
npm test                           # Run all tests
npm test -- --detectOpenHandles    # Debug async leaks
RUN_HARDHAT_TESTS=true npm test    # Include Hardhat integration tests
```

### Test Status
- **Total Tests:** 410
- **Passing:** 409
- **Skipped:** 1 (Hardhat flash loan test - requires RUN_HARDHAT_TESTS=true)

### Known Test Behaviors
- `forceExit: true` is used because singleton modules with timers don't clean up perfectly
- All timers use `.unref()` to not block process exit
- Running with `--detectOpenHandles` proves no actual leaks exist
- The "Force exiting Jest" message is expected and harmless

## Key Files for Context

When resuming work, read these files first:

1. **Entry Point:** `src/index.js` - ArbitrageBot class, startup flow
2. **Worker System:** `src/workers/WorkerCoordinator.js` - Multi-chain orchestration
3. **Chain Base:** `src/chains/BaseChain.js` - Chain interface contract
4. **Config Example:** `src/config/chains/bsc.js` - Chain configuration structure
5. **Detection:** `src/analysis/CrossChainDetector.js` - Cross-chain logic

## Environment Variables

```bash
# Required
TELEGRAM_BOT_TOKEN=xxx          # For alerts
TELEGRAM_CHAT_ID=xxx            # For alerts

# Optional
NODE_ENV=production|test        # Environment mode
RUN_HARDHAT_TESTS=true          # Enable Hardhat integration tests
LOG_LEVEL=debug|info|warn|error # Logging verbosity
```

## Singleton Modules with Timers

These modules have `setInterval` timers with `.unref()`:

| Module | File | Timer Purpose |
|--------|------|---------------|
| performanceTracker | `src/monitoring/performanceTracker.js:24` | Hourly reports |
| blockMonitor | `src/monitoring/blockMonitor.js:73` | HTTP polling fallback |
| WorkerCoordinator | `src/workers/WorkerCoordinator.js:366` | Heartbeat monitoring |
| ChainWorker | `src/workers/ChainWorker.js:138` | Worker heartbeat |

## Future Enhancements (Backlog)

### Near-Term
- [ ] Complete Phase 7 documentation
- [ ] Add integration tests for multi-chain scenarios
- [ ] Implement actual trade execution (currently detection-only)

### Medium-Term
- [ ] Flash loan integration for capital-efficient execution
- [ ] MEV protection (Flashbots, private mempools)
- [ ] Real-time profit tracking dashboard

### Long-Term
- [ ] Machine learning for opportunity prediction
- [ ] Cross-chain bridge automation
- [ ] Multi-signature wallet support

## Common Issues & Solutions

### Tests don't exit cleanly
- All timers should use `.unref()`
- `forceExit: true` in jest.config.js handles remaining async operations
- Use `--detectOpenHandles` to verify no real leaks

### Worker crashes repeatedly
- Check RPC endpoint availability in chain config
- Verify chain ID matches the network
- Check `WorkerCoordinator.restartDelay` (default 5000ms)

### No opportunities detected
- Verify `minProfitPercent` threshold in config (default may be too high)
- Check liquidity thresholds
- Ensure DEX router addresses are correct

## Code Conventions

- ES Modules (import/export)
- Async/await for promises
- Winston for logging (`log.info`, `log.error`, etc.)
- EventEmitter pattern for component communication
- Factory pattern for multi-instance support
- `.unref()` on all long-running timers

## Git Workflow

- Main branch: `main`
- Commit messages include emoji prefix from Claude Code
- Tests must pass before merging

---

*Last updated: 2026-01-06*
*Document maintained for AI assistant context continuity*
