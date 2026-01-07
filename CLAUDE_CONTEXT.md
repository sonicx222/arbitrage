# Claude Context Document

This document provides context for AI assistants working on this project. It captures architecture decisions, implementation status, and planned work.

## Project Overview

**Name:** Multi-Chain Arbitrage Bot
**Original Scope:** BSC-only arbitrage detection
**Current Scope:** Multi-chain arbitrage detection across 6 blockchains
**Version:** 2.0.0
**Status:** Phase 8 complete - Enhanced detection features implemented
**Last Major Update:** 2026-01-07 - V3 support, stablecoin detector, adaptive polling

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
│   ├── MempoolMonitor.js       # Pending transaction analysis
│   └── stablecoinDetector.js   # [NEW] Stablecoin depeg & arbitrage detection
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
│       ├── bsc.js              # Includes V3 config
│       ├── ethereum.js         # Includes V3 config
│       ├── polygon.js          # Includes V3 config
│       ├── arbitrum.js         # Includes V3 config
│       ├── base.js             # Includes V3 config
│       └── avalanche.js        # Includes V3 config
├── contracts/
│   └── abis.js                 # ABIs including V3 pool/factory/quoter
├── data/
│   ├── cacheManager.js         # LRU cache for prices
│   ├── priceFetcher.js         # DEX price fetching (V2)
│   ├── v3PriceFetcher.js       # [NEW] Uniswap V3 price fetching
│   └── tokenList.js            # Token definitions
├── dexes/
│   ├── BaseDEX.js              # Abstract DEX class
│   └── implementations/
│       ├── UniswapV2.js        # Uniswap V2 fork support
│       └── UniswapV3.js        # Uniswap V3 concentrated liquidity
├── execution/
│   ├── executionManager.js     # Trade execution
│   ├── gasOptimizer.js         # Gas price optimization
│   ├── l2GasCalculator.js      # L2-specific gas calculations
│   └── profitCalculator.js     # Profit/loss calculations
├── monitoring/
│   ├── blockMonitor.js         # Block event subscription
│   ├── adaptivePoller.js       # [NEW] Dynamic polling based on volatility
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

#### Phase 7: Documentation ✅
- [x] CLAUDE_CONTEXT.md (this file)
- [x] TODO.md (task tracking)
- [x] Chain configuration tests (77 tests)
- [x] docs/ARCHITECTURE.md - System design and component overview
- [x] docs/CHAINS.md - Per-chain details and configuration
- [x] docs/CONFIG.md - Environment variables and settings reference
- [x] docs/PROFIT_AND_GAS.md - Profit calculation analysis and future extensions
- [x] docs/NEXT_IMPLEMENTATION_PLAN.md - Future enhancements roadmap

#### Phase 8: Enhanced Detection Features ✅ (2026-01-07)
- [x] **Uniswap V3 Price Fetching** - Full V3 concentrated liquidity support
- [x] **V3 Chain Configurations** - All 6 chains updated with V3 DEX configs
- [x] **Stablecoin Depeg Detector** - Cross-DEX and triangular stable arbitrage
- [x] **Adaptive Polling** - Dynamic intervals based on market volatility
- [x] **Comprehensive Tests** - 613 tests total (78 new tests added)

### Recent Implementation Details

#### Phase 8 Features (2026-01-07)

**1. V3 Price Fetcher (`src/data/v3PriceFetcher.js`)**
- sqrtPriceX96 to price conversion with decimal adjustment
- Multi-fee tier support (100, 500, 3000, 10000 bps)
- Pool discovery via factory contract
- Multicall batching for efficiency
- Liquidity estimation in USD

**2. Stablecoin Detector (`src/analysis/stablecoinDetector.js`)**
- Monitors stablecoin prices for deviations from $1.00 peg
- Detects cross-DEX arbitrage between same stablecoin
- Finds triangular stable paths (USDT→USDC→DAI→USDT)
- Emits `severeDepeg` events at 1%+ deviation
- Per-chain stablecoin configuration

**3. Adaptive Poller (`src/monitoring/adaptivePoller.js`)**
- Dynamic polling interval: 500ms - 5000ms
- Volatility calculation from price change history
- Intensity modes: AGGRESSIVE, NORMAL, CONSERVATIVE
- RPC rate limit protection (300 RPM default)
- Chain-aware block time constraints
- Opportunity burst detection

**4. V3 ABIs Added (`src/contracts/abis.js`)**
- V3_POOL_ABI: slot0, liquidity, token0/1, fee
- V3_FACTORY_ABI: getPool, createPool
- V3_QUOTER_ABI: quoteExactInputSingle
- V3_FEE_TIERS: LOWEST(100), LOW(500), MEDIUM(3000), HIGH(10000)
- V3_FACTORY_ADDRESSES: All 6 supported chains

### Previous Fixes (2026-01-06)
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

| Chain | Chain ID | V2 DEXes | V3 DEXes |
|-------|----------|----------|----------|
| BSC | 56 | PancakeSwap, Biswap, ApeSwap, BabySwap, MDEX | PancakeSwap V3 |
| Ethereum | 1 | Uniswap V2, SushiSwap | Uniswap V3 |
| Polygon | 137 | QuickSwap, SushiSwap | Uniswap V3 |
| Arbitrum | 42161 | SushiSwap, Camelot | Uniswap V3 |
| Base | 8453 | Aerodrome, BaseSwap | Uniswap V3 |
| Avalanche | 43114 | TraderJoe, Pangolin, SushiSwap | Uniswap V3 |

### V3 Fee Tiers by Chain

| Chain | Fee Tiers (bps) | Notes |
|-------|-----------------|-------|
| BSC | 100, 500, 2500, 10000 | PancakeSwap V3 uses 2500 instead of 3000 |
| Ethereum | 100, 500, 3000, 10000 | Standard Uniswap V3 |
| Polygon | 100, 500, 3000, 10000 | Standard Uniswap V3 |
| Arbitrum | 100, 500, 3000, 10000 | Standard Uniswap V3 |
| Base | 100, 500, 3000, 10000 | Standard Uniswap V3 |
| Avalanche | 100, 500, 3000, 10000 | Uniswap V3 fork |

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
- **Total Tests:** 613
- **Passing:** 612
- **Skipped:** 1 (Hardhat flash loan test - requires RUN_HARDHAT_TESTS=true)
- **Test Suites:** 27

### New Test Files (Phase 8)
- `tests/unit/v3PriceFetcher.test.js` - 25 tests for V3 price fetching
- `tests/unit/stablecoinDetector.test.js` - 24 tests for stablecoin detection
- `tests/unit/adaptivePoller.test.js` - 29 tests for adaptive polling

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
4. **Config Example:** `src/config/chains/bsc.js` - Chain configuration structure (includes V3)
5. **Detection:** `src/analysis/CrossChainDetector.js` - Cross-chain logic
6. **V3 Pricing:** `src/data/v3PriceFetcher.js` - Uniswap V3 concentrated liquidity
7. **Stablecoins:** `src/analysis/stablecoinDetector.js` - Depeg and stable arbitrage
8. **Polling:** `src/monitoring/adaptivePoller.js` - Dynamic polling intervals
9. **ABIs:** `src/contracts/abis.js` - All contract ABIs including V3

## Environment Variables

```bash
# Required
TELEGRAM_BOT_TOKEN=xxx          # For alerts
TELEGRAM_CHAT_ID=xxx            # For alerts

# Optional - General
NODE_ENV=production|test        # Environment mode
RUN_HARDHAT_TESTS=true          # Enable Hardhat integration tests
LOG_LEVEL=debug|info|warn|error # Logging verbosity

# Optional - V3 Configuration (per chain)
BSC_V3_ENABLED=true|false       # Enable V3 price fetching on BSC
ETH_V3_ENABLED=true|false       # Enable V3 price fetching on Ethereum
# ... similar for each chain

# Optional - Adaptive Polling
POLL_MIN_INTERVAL=500           # Minimum polling interval (ms)
POLL_MAX_INTERVAL=5000          # Maximum polling interval (ms)
MAX_RPC_PER_MINUTE=300          # Rate limit for RPC calls
```

## Singleton Modules with Timers

These modules have `setInterval` timers with `.unref()`:

| Module | File | Timer Purpose |
|--------|------|---------------|
| performanceTracker | `src/monitoring/performanceTracker.js:24` | Hourly reports |
| blockMonitor | `src/monitoring/blockMonitor.js:73` | HTTP polling fallback |
| WorkerCoordinator | `src/workers/WorkerCoordinator.js:366` | Heartbeat monitoring |
| ChainWorker | `src/workers/ChainWorker.js:138` | Worker heartbeat |
| adaptivePoller | `src/monitoring/adaptivePoller.js` | RPC counter reset (1 min) |

## Future Enhancements (Backlog)

See `docs/NEXT_IMPLEMENTATION_PLAN.md` for detailed roadmap.

### Priority 1 (Next Implementation)
- [ ] New pool/pair detection (factory event monitoring)
- [ ] V2/V3 cross-arbitrage (same pair, different AMM type)
- [ ] Block time prediction for optimal submission timing
- [ ] Just-in-time liquidity detection

### Priority 2 (Medium-Term)
- [ ] Flash loan integration for capital-efficient execution
- [ ] MEV protection (Flashbots, private mempools)
- [ ] Real-time profit tracking dashboard
- [ ] Curve Finance integration (stable pools)

### Priority 3 (Long-Term)
- [ ] Machine learning for opportunity prediction
- [ ] Cross-chain bridge automation
- [ ] Multi-signature wallet support
- [ ] Concentrated liquidity position optimization

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

## V3 Price Fetcher Technical Details

### sqrtPriceX96 Conversion
```javascript
// Convert sqrtPriceX96 to human-readable price
sqrtPriceX96ToPrice(sqrtPriceX96, decimals0, decimals1) {
    const Q96 = 2n ** 96n;
    const sqrtPrice = Number(sqrtPriceX96) / Number(Q96);
    const price = sqrtPrice * sqrtPrice;
    const decimalAdjustment = Math.pow(10, decimals0 - decimals1);
    return price * decimalAdjustment;
}
```

### Fee Tier Constants
- LOWEST: 100 bps (0.01%) - Stablecoin pairs
- LOW: 500 bps (0.05%) - Stable pairs, high volume
- MEDIUM: 3000 bps (0.30%) - Most pairs
- HIGH: 10000 bps (1.00%) - Exotic/volatile pairs

### V3 Factory Addresses
```javascript
V3_FACTORY_ADDRESSES = {
    1: '0x1F98431c8aD98523631AE4a59f267346ea31F984',      // Ethereum
    56: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',     // BSC (PancakeSwap)
    137: '0x1F98431c8aD98523631AE4a59f267346ea31F984',    // Polygon
    42161: '0x1F98431c8aD98523631AE4a59f267346ea31F984',  // Arbitrum
    8453: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',   // Base
    43114: '0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD',  // Avalanche
}
```

## Stablecoin Detector Configuration

### Default Thresholds
- `depegThreshold`: 0.2% - Minor deviation alert
- `arbitrageThreshold`: 0.3% - Cross-DEX opportunity
- `severeDepegThreshold`: 1.0% - Critical alert

### Supported Stablecoins per Chain
- BSC: USDT, USDC, BUSD, FDUSD, DAI, TUSD
- Ethereum: USDT, USDC, DAI, FRAX, LUSD
- Polygon: USDT, USDC, DAI
- Arbitrum: USDT, USDC, DAI, FRAX
- Base: USDC, DAI, USDbC
- Avalanche: USDT, USDC, DAI

## Adaptive Poller Configuration

### Intensity Modes
| Mode | Interval Multiplier | Use Case |
|------|---------------------|----------|
| AGGRESSIVE | 0.5x | High volatility, opportunity bursts |
| NORMAL | 1.0x | Standard market conditions |
| CONSERVATIVE | 1.5x | Low volatility, rate limit protection |

### Chain Block Time Constraints
| Chain | Block Time | Min Interval |
|-------|------------|--------------|
| BSC | 3s | 1500ms |
| Ethereum | 12s | 6000ms |
| Polygon | 2s | 1000ms |
| Arbitrum | 0.25s | 125ms |
| Base | 2s | 1000ms |
| Avalanche | 2s | 1000ms |

---

*Last updated: 2026-01-07*
*Document maintained for AI assistant context continuity*
