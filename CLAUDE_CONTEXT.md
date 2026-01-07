# Claude Context Document

This document provides context for AI assistants working on this project. It captures architecture decisions, implementation status, and planned work.

## Project Overview

**Name:** Multi-Chain Arbitrage Bot
**Original Scope:** BSC-only arbitrage detection
**Current Scope:** Multi-chain arbitrage detection across 6 blockchains
**Version:** 2.4.0
**Status:** Phase 12 complete - Contract Deployment Infrastructure
**Last Major Update:** 2026-01-07 - Multi-chain deployment scripts, Hardhat tests, deployment guide

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
contracts/
├── FlashArbitrage.sol          # Flash arbitrage smart contract
└── interfaces/
    └── IPancakeV2Pair.sol      # DEX interfaces

scripts/
├── deploy.js                   # BSC-only deployment (legacy)
└── deploy-multichain.js        # Multi-chain deployment script

tests/
├── contract/
│   └── FlashArbitrage.test.cjs # Hardhat contract tests
└── unit/                       # Unit tests (Jest)

docs/
├── ARCHITECTURE.md             # System architecture
├── CHAINS.md                   # Per-chain configuration
├── CONFIG.md                   # Environment variables
├── DEPLOYMENT.md               # Contract deployment guide
├── PROFIT_AND_GAS.md          # Profit calculation analysis
└── MEMPOOL_ANALYSIS.md        # Mempool monitoring

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
│   ├── stablecoinDetector.js   # Stablecoin depeg & arbitrage detection
│   ├── opportunityScorer.js    # [NEW] Weighted scoring for opportunity prioritization
│   ├── v2v3Arbitrage.js        # [NEW] V2/V3 cross-arbitrage detection
│   ├── priceImpactCalculator.js # [NEW] Precise price impact using reserves
│   ├── jitLiquidityDetector.js # [NEW] Just-in-time liquidity detection
│   └── profitCalculator.js     # Enhanced profit calculation
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
│   ├── executionSimulator.js   # [NEW] Advanced execution simulation with MEV analysis
│   ├── blockTimePredictor.js   # [NEW] Block time tracking and prediction
│   ├── gasOptimizer.js         # Gas price optimization
│   └── l2GasCalculator.js      # L2-specific gas calculations
├── monitoring/
│   ├── blockMonitor.js         # Block event subscription
│   ├── adaptivePoller.js       # [NEW] Dynamic polling based on volatility
│   ├── newPairMonitor.js       # [NEW] Factory event monitoring for new pairs
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

#### Phase 9: Profitability Optimization ✅ (2026-01-07)
- [x] **Opportunity Scorer** - Weighted scoring system for prioritization
- [x] **V2/V3 Cross-Arbitrage** - Detect price discrepancies between AMM versions
- [x] **Price Impact Calculator** - Precise impact using reserves and AMM formulas
- [x] **Execution Simulator** - Advanced simulation with MEV risk analysis
- [x] **Comprehensive Tests** - 746 tests total (133 new tests added)

#### Phase 10: Advanced Monitoring ✅ (2026-01-07)
- [x] **New Pair Monitor** - DEX factory event monitoring for arbitrage on new listings
- [x] **Block Time Predictor** - Optimal transaction submission timing
- [x] **Comprehensive Tests** - 798 tests total (52 new tests added)

#### Phase 11: JIT Liquidity Detection ✅ (2026-01-07)
- [x] **JIT Liquidity Detector** - Detect just-in-time liquidity additions/removals
- [x] **JIT Pattern Recognition** - Identify mint/burn patterns within block windows
- [x] **JIT Arbitrage Opportunities** - Find price discrepancies during JIT events
- [x] **Comprehensive Tests** - 831 tests total (33 new tests added)

#### Phase 12: Contract Deployment Infrastructure ✅ (2026-01-07)
- [x] **Hardhat Contract Tests** - Comprehensive test suite for FlashArbitrage.sol
- [x] **Multi-Chain Deployment Script** - Deploy to BSC, Ethereum, Polygon, Arbitrum, Base
- [x] **Hardhat Configuration** - All 10 networks (5 mainnet + 5 testnet)
- [x] **Deployment Documentation** - Complete guide with troubleshooting

### Recent Implementation Details

#### Phase 12 Features (2026-01-07)

**1. Hardhat Contract Tests (`tests/contract/FlashArbitrage.test.cjs`)**
- Deployment verification tests (owner, routers, pause state)
- Router whitelist management (add, remove, batch operations)
- Pause/unpause functionality
- Emergency withdraw (BNB and tokens)
- Cross-DEX arbitrage validation (paths, routers, amounts)
- Triangular arbitrage validation
- Simulation tests
- Integration tests (require forked mainnet)
- Requires `RUN_HARDHAT_TESTS=true` to run

**2. Multi-Chain Deployment Script (`scripts/deploy-multichain.js`)**
- Supports 10 networks: BSC, Ethereum, Polygon, Arbitrum, Base (mainnet + testnet)
- Chain-specific DEX router configurations
- Automatic router whitelisting on deployment
- Contract verification on block explorers (with API keys)
- Detailed deployment output with transaction info
- JSON deployment info for record keeping

**3. Hardhat Configuration (`hardhat.config.cjs`)**
- All 10 network configurations with RPC URLs
- Etherscan API key support for all chains
- Custom chain configurations for Base networks
- Optimized compiler settings (0.8.19, optimizer, viaIR)

**4. Deployment Documentation (`docs/DEPLOYMENT.md`)**
- Prerequisites and environment setup
- Testnet faucets and cost estimates
- Step-by-step testnet deployment guide
- Mainnet deployment guide with checklist
- Post-deployment configuration
- Contract verification instructions
- Troubleshooting section

#### Phase 11 Features (2026-01-07)

**1. JIT Liquidity Detector (`src/analysis/jitLiquidityDetector.js`)**
- Detects Just-In-Time liquidity events (add liquidity → trade → remove liquidity)
- Tracks Mint events and matches with Burn events within configurable block window
- Identifies concentrated liquidity positions (narrow tick ranges)
- Calculates fees earned by JIT providers
- Emits `potentialJIT` for concentrated mints and `jitDetected` for confirmed patterns
- Pool analysis: JIT frequency, unique providers, activity levels
- JIT prediction: estimates likelihood based on historical data and trade size
- JIT arbitrage detection: finds price discrepancies during JIT events
- 33 unit tests

#### Phase 10 Features (2026-01-07)

**1. New Pair Monitor (`src/monitoring/newPairMonitor.js`)**
- Monitors DEX factory contracts for PairCreated events
- Tracks new pairs for 24-hour monitoring window
- Emits `newPairDetected` when any new pair found
- Emits `newPairOpportunity` when known token paired with unknown token
- Configurable: minLiquidityUSD, minSpreadPercent, monitoringWindow
- Per-chain factory address configuration
- Known token registry for opportunity flagging
- 21 unit tests

**2. Block Time Predictor (`src/execution/blockTimePredictor.js`)**
- Tracks block timestamps per chain to predict next block arrival
- Expected block times: ETH 12s, BSC 3s, Polygon 2s, Arbitrum 250ms, Base 2s
- Calculates average block time from rolling sample window
- Standard deviation for confidence assessment
- Optimal submission window: 200-500ms before predicted block
- Confidence levels: high (low variance), medium, low (high variance)
- `waitForOptimalWindow()` method with maxWait timeout
- Event emission for block recording
- 31 unit tests

#### Phase 9 Features (2026-01-07)

**1. Opportunity Scorer (`src/analysis/opportunityScorer.js`)**
- Weighted multi-factor scoring: profit (40%), liquidity (25%), execution (20%), time (10%), token quality (5%)
- Tier classification: S/A/B/C/D with corresponding recommendations
- Dynamic weight adjustment
- Integration with profitCalculator for consistent scoring
- 43 unit tests

**2. V2/V3 Cross-Arbitrage (`src/analysis/v2v3Arbitrage.js`)**
- Detects price discrepancies between V2 pools and V3 fee tiers
- Supports all 6 chains with V2/V3 DEX mappings
- Fee tier optimization (finds best V3 tier for execution)
- Calculates optimal trade size considering both pool types
- 27 unit tests

**3. Price Impact Calculator (`src/analysis/priceImpactCalculator.js`)**
- V2 constant product formula: `2 * amountIn / (reserveIn + amountIn)`
- V3 concentrated liquidity impact estimation
- Multi-hop cumulative impact calculation
- Optimal trade size finder via binary search
- Severity classification: minimal/low/moderate/high/extreme
- Trade viability analysis
- 30 unit tests

**4. Execution Simulator (`src/execution/executionSimulator.js`)**
- Comprehensive simulation beyond simple eth_call
- MEV risk analysis (frontrunning, backrunning, sandwich)
- Competition modeling with gas price strategy
- Block timing and staleness tracking
- Risk-adjusted expected value calculation
- Action recommendations: EXECUTE/EXECUTE_WITH_CAUTION/EVALUATE/SKIP
- Historical tracking for learning
- 33 unit tests

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
- **Total Tests:** 831
- **Passing:** 831
- **Skipped:** 1 (Hardhat flash loan test - requires RUN_HARDHAT_TESTS=true)
- **Test Suites:** 34

### New Test Files (Phase 11)
- `tests/unit/jitLiquidityDetector.test.js` - 33 tests for JIT liquidity detection

### New Test Files (Phase 10)
- `tests/unit/newPairMonitor.test.js` - 21 tests for new pair detection
- `tests/unit/blockTimePredictor.test.js` - 31 tests for block time prediction

### New Test Files (Phase 9)
- `tests/unit/opportunityScorer.test.js` - 43 tests for opportunity scoring
- `tests/unit/v2v3Arbitrage.test.js` - 27 tests for V2/V3 cross-arbitrage
- `tests/unit/priceImpactCalculator.test.js` - 30 tests for price impact
- `tests/unit/executionSimulator.test.js` - 33 tests for execution simulation

### Test Files (Phase 8)
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

### Core System
1. **Entry Point:** `src/index.js` - ArbitrageBot class, startup flow
2. **Worker System:** `src/workers/WorkerCoordinator.js` - Multi-chain orchestration
3. **Chain Base:** `src/chains/BaseChain.js` - Chain interface contract
4. **Config Example:** `src/config/chains/bsc.js` - Chain configuration structure (includes V3)

### Detection & Analysis
5. **Detection:** `src/analysis/CrossChainDetector.js` - Cross-chain logic
6. **V3 Pricing:** `src/data/v3PriceFetcher.js` - Uniswap V3 concentrated liquidity
7. **Stablecoins:** `src/analysis/stablecoinDetector.js` - Depeg and stable arbitrage
8. **Scoring:** `src/analysis/opportunityScorer.js` - Opportunity prioritization
9. **V2/V3 Arb:** `src/analysis/v2v3Arbitrage.js` - Cross-AMM arbitrage
10. **Impact:** `src/analysis/priceImpactCalculator.js` - Price impact calculations
11. **JIT Detection:** `src/analysis/jitLiquidityDetector.js` - Just-in-time liquidity events

### Execution & Monitoring
12. **Simulation:** `src/execution/executionSimulator.js` - Advanced execution modeling
13. **Block Timing:** `src/execution/blockTimePredictor.js` - Optimal submission timing
14. **Polling:** `src/monitoring/adaptivePoller.js` - Dynamic polling intervals
15. **New Pairs:** `src/monitoring/newPairMonitor.js` - Factory event monitoring
16. **ABIs:** `src/contracts/abis.js` - All contract ABIs including V3

### Deployment (Phase 12)
17. **Smart Contract:** `contracts/FlashArbitrage.sol` - Flash arbitrage contract
18. **Deployment Script:** `scripts/deploy-multichain.js` - Multi-chain deployment
19. **Contract Tests:** `tests/contract/FlashArbitrage.test.cjs` - Hardhat tests
20. **Hardhat Config:** `hardhat.config.cjs` - Network configurations
21. **Deployment Guide:** `docs/DEPLOYMENT.md` - Complete deployment instructions

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

### Priority 1 (Next Steps - Deployment)
- [x] ~~Contract deployment infrastructure~~ - Completed Phase 12
- [ ] **Deploy to BSC Testnet** - Requires network access to download Solidity compiler
- [ ] **Run Hardhat Tests** - `RUN_HARDHAT_TESTS=true npx hardhat test`
- [ ] **Deploy to BSC Mainnet** - After testnet verification
- [ ] **Live Simulation Testing** - With real prices on mainnet

### Deployment Commands (Ready to Run)
```bash
# 1. Compile contracts (requires network for compiler download)
npx hardhat compile

# 2. Run contract tests
RUN_HARDHAT_TESTS=true npx hardhat test tests/contract/FlashArbitrage.test.cjs

# 3. Deploy to testnet
npx hardhat run scripts/deploy-multichain.js --network bscTestnet

# 4. Deploy to mainnet
npx hardhat run scripts/deploy-multichain.js --network bsc
```

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

## Opportunity Scorer Configuration

### Scoring Weights (Default)
| Factor | Weight | Description |
|--------|--------|-------------|
| Profit | 40% | Net profit potential |
| Liquidity | 25% | Pool liquidity sufficiency |
| Execution | 20% | Success probability |
| Time | 10% | Freshness/staleness |
| Token Quality | 5% | Token characteristics |

### Tier Classification
| Tier | Score Range | Recommendation |
|------|-------------|----------------|
| S | ≥0.85 | Execute immediately |
| A | ≥0.70 | High priority |
| B | ≥0.55 | Consider execution |
| C | ≥0.40 | Low priority |
| D | <0.40 | Skip |

## Price Impact Calculator

### V2 Constant Product Formula
```javascript
// Price impact = 2 * amountIn / (reserveIn + amountIn)
// For 1% of pool, impact ≈ 2%

calculateV2Impact(amountIn, reserveIn, reserveOut, fee = 0.003) {
    const amountInWithFee = amountIn * (1 - fee);
    const amountOut = (amountInWithFee * reserveOut) /
                      (reserveIn + amountInWithFee);
    const spotPrice = reserveOut / reserveIn;
    const executionPrice = amountOut / amountIn;
    return (spotPrice - executionPrice) / spotPrice;
}
```

### Impact Severity Thresholds
| Severity | Impact Range | Recommendation |
|----------|--------------|----------------|
| Minimal | ≤0.1% | Full trade OK |
| Low | ≤0.5% | Acceptable |
| Moderate | ≤1.0% | Consider splitting |
| High | ≤2.0% | Reduce size |
| Extreme | >5.0% | Avoid trade |

## Execution Simulator

### MEV Risk Types
| Type | Trigger | Risk Factor |
|------|---------|-------------|
| Frontrunning | Profit > $5 | 40% |
| Backrunning | Trade > $500 | 30% |
| Sandwich | Trade > $1000 & Profit > $10 | 50% |

### Success Probability Factors
| Component | Weight | Description |
|-----------|--------|-------------|
| Timing | 15% | Block age and staleness |
| Competition | 25% | Other bots racing |
| MEV | 20% | Extraction risk |
| Price Stability | 15% | Volatility |
| Slippage | 15% | Impact risk |
| Profit | 10% | Higher profit = more reliable |

### Recommendation Actions
- **EXECUTE**: High probability (≥70%), acceptable MEV risk
- **EXECUTE_WITH_CAUTION**: Moderate probability (≥50%), high profit
- **EVALUATE**: Borderline - manual review recommended
- **SKIP**: Low probability (<30%), high competition, or extreme MEV

## V2/V3 Cross-Arbitrage

### Supported Chain Mappings
| Chain | V2 DEXes | V3 DEXes |
|-------|----------|----------|
| BSC | PancakeSwap, Biswap | PancakeSwap V3 |
| Ethereum | Uniswap V2, SushiSwap | Uniswap V3 |
| Polygon | QuickSwap, SushiSwap | Uniswap V3 |
| Arbitrum | SushiSwap, Camelot | Uniswap V3 |
| Base | Aerodrome, BaseSwap | Uniswap V3 |
| Avalanche | TraderJoe, Pangolin | Uniswap V3 |

### Detection Logic
1. Get best V2 price across all V2 DEXes
2. Get best V3 price across all fee tiers
3. Compare effective prices (including fees)
4. If spread > minSpreadPercent (default 0.15%), flag opportunity
5. Calculate optimal trade size considering both pool types

## New Pair Monitor Configuration

### Default Settings
| Parameter | Default | Description |
|-----------|---------|-------------|
| minLiquidityUSD | $1,000 | Minimum liquidity to consider |
| minSpreadPercent | 0.5% | Minimum spread for opportunity |
| monitoringWindow | 24 hours | How long to track new pairs |
| maxRecentPairs | 500 | Max pairs to keep in memory |

### Events Emitted
| Event | Trigger | Data |
|-------|---------|------|
| `newPairDetected` | Any new pair found | chainId, dexName, token0, token1, pairAddress |
| `newPairOpportunity` | Known token + unknown token | pairInfo, knownToken, spread |

### Factory Addresses (Set via `setFactories()`)
Configure per-chain factory addresses for event subscription.

## Block Time Predictor Configuration

### Expected Block Times
| Chain | Chain ID | Block Time |
|-------|----------|------------|
| Ethereum | 1 | 12,000ms |
| BSC | 56 | 3,000ms |
| Polygon | 137 | 2,000ms |
| Arbitrum | 42161 | 250ms |
| Base | 8453 | 2,000ms |
| Avalanche | 43114 | 2,000ms |

### Default Settings
| Parameter | Default | Description |
|-----------|---------|-------------|
| sampleSize | 50 | Block history to keep |
| optimalLeadTime | 400ms | Target time before block |
| minConfidenceSamples | 10 | Min samples for high confidence |

### Confidence Levels
| Level | Criteria | Description |
|-------|----------|-------------|
| High | StdDev < 10% of avg | Very consistent blocks |
| Medium | StdDev < 25% of avg | Normal variance |
| Low | Insufficient data | Need more samples |

### Optimal Submission Logic
1. Predict next block time from average
2. Calculate time until predicted block
3. Return delay to achieve 200-500ms lead time
4. If block too close/far, submit immediately

## JIT Liquidity Detector Configuration

### What is JIT Liquidity?
Just-In-Time (JIT) liquidity is when liquidity providers add concentrated liquidity immediately before a large trade to capture fees, then remove it afterward. This creates:
- Better execution prices during JIT (lower slippage)
- Arbitrage opportunities between JIT-affected and unaffected pools
- Predictive patterns for trading

### Default Settings
| Parameter | Default | Description |
|-----------|---------|-------------|
| jitWindowBlocks | 2 | Max blocks between mint and burn |
| minLiquidityUSD | $10,000 | Minimum liquidity to track |
| minAddRemoveRatio | 0.8 | Min ratio of liquidity removed vs added |
| maxTickRange | 200 | Max tick range for "concentrated" |
| maxRecentEvents | 100 | Recent JIT events to keep |

### Events Emitted
| Event | Trigger | Data |
|-------|---------|------|
| `potentialJIT` | Large concentrated mint | mint details, confidence |
| `jitDetected` | Confirmed mint+burn pattern | full JIT record with fees |

### JIT Detection Logic
1. Track all Mint events with sufficient liquidity
2. When Burn event occurs, search for matching Mint within window
3. Match criteria: same pool, owner, tick range
4. Validate: block duration ≤ window, liquidity ratio ≥ threshold
5. Calculate fees earned = tokens removed - tokens added

### JIT Frequency Classification
| Level | JIT Count | Recommendation |
|-------|-----------|----------------|
| High | > 10 | Expect better execution during JIT windows |
| Medium | > 3 | Monitor for JIT opportunities |
| Low | ≤ 3 | Standard execution expected |

### JIT Prediction
Predicts likelihood of JIT for pending large trades based on:
- Historical JIT frequency for the pool
- Trade size (larger trades attract more JIT)
- Number of unique JIT providers

## Deployment Configuration

### Supported Networks
| Network | Chain ID | Type | Command |
|---------|----------|------|---------|
| BSC | 56 | Mainnet | `--network bsc` |
| BSC Testnet | 97 | Testnet | `--network bscTestnet` |
| Ethereum | 1 | Mainnet | `--network ethereum` |
| Sepolia | 11155111 | Testnet | `--network sepolia` |
| Polygon | 137 | Mainnet | `--network polygon` |
| Mumbai | 80001 | Testnet | `--network mumbai` |
| Arbitrum | 42161 | Mainnet | `--network arbitrum` |
| Arbitrum Sepolia | 421614 | Testnet | `--network arbitrumSepolia` |
| Base | 8453 | Mainnet | `--network base` |
| Base Sepolia | 84532 | Testnet | `--network baseSepolia` |

### DEX Routers Per Chain (Auto-Whitelisted)
| Chain | DEXes Configured |
|-------|------------------|
| BSC | PancakeSwap, Biswap, ApeSwap, BabySwap, SushiSwap, THENA, NomiSwap |
| Ethereum | Uniswap V2, Uniswap V3, SushiSwap |
| Polygon | QuickSwap, SushiSwap, Uniswap V3, ApeSwap, Dystopia, MeshSwap, JetSwap |
| Arbitrum | Uniswap V3, SushiSwap, Camelot, TraderJoe, Ramses, Zyberswap, ArbiDex |
| Base | Uniswap V3, Aerodrome, BaseSwap, SushiSwap, AlienBase, SwapBased, RocketSwap, Uniswap V2 |

### Required Environment Variables for Deployment
```bash
# Required
PRIVATE_KEY=your_deployer_private_key

# Optional - Custom RPC URLs
BSC_RPC_URL=https://bsc-dataseed.binance.org
ETH_RPC_URL=https://eth.llamarpc.com
POLYGON_RPC_URL=https://polygon-rpc.com
ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc
BASE_RPC_URL=https://mainnet.base.org

# Optional - Block explorer API keys (for verification)
BSCSCAN_API_KEY=your_key
ETHERSCAN_API_KEY=your_key
POLYGONSCAN_API_KEY=your_key
ARBISCAN_API_KEY=your_key
BASESCAN_API_KEY=your_key
```

### Post-Deployment Environment Variables
After deploying, add the contract addresses:
```bash
BSC_FLASH_CONTRACT=0x...
POLYGON_FLASH_CONTRACT=0x...
ARBITRUM_FLASH_CONTRACT=0x...
BASE_FLASH_CONTRACT=0x...
```

---

*Last updated: 2026-01-07*
*Document maintained for AI assistant context continuity*
