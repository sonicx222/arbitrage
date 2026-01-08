# Multi-Chain Arbitrage Bot

A professional-grade, multi-chain arbitrage monitoring and detection system supporting BSC, Ethereum, Polygon, Arbitrum, Base, and Avalanche. Features parallel worker threads, cross-chain arbitrage detection, and flash loan execution.

## Features

### Core Features
- **Multi-Chain Support**: Monitor 6 chains simultaneously (BSC, Ethereum, Polygon, Arbitrum, Base, Avalanche)
- **Worker Thread Architecture**: Parallel processing with isolated workers per chain
- **Cross-DEX Arbitrage**: Detect price differences across DEXes within each chain
- **Triangular Arbitrage**: Find A → B → C → A opportunities within single DEXes
- **Cross-Chain Detection**: Identify same-asset price discrepancies across chains
- **Multi-Hop Paths**: Detect 4+ token arbitrage routes
- **Mempool Monitoring**: Track pending transactions for frontrunning opportunities
- **Flash Loan Execution**: Execute profitable trades using flash loans
- **Rate Limit Optimization**: Intelligent RPC management with failover
- **Multi-Channel Alerts**: Console, Discord, Telegram notifications

### Infrastructure Features
- **Self-Healing RPC Pool**: Automatically re-tests unhealthy RPC endpoints every 5 minutes and recovers them when they become available again
- **EIP-1559 Gas Pricing**: Native support for EIP-1559 gas pricing on Ethereum, Polygon, Arbitrum, Base, and Avalanche chains with automatic fallback to legacy pricing on BSC
- **Dynamic Slippage Adjustment**: Token-specific slippage rates based on volatility and liquidity
- **Stale Block Detection**: Automatically reconnects WebSocket connections when no blocks are received for 30+ seconds
- **Dynamic Native Token Pricing**: Real-time native token price updates from DEX reserves for accurate gas cost calculations

### Reliability Features (v3.4)
- **Race Condition Prevention**: Atomic event queue processing prevents dropped or duplicate events
- **Memory Leak Protection**: Bounded Maps with automatic eviction, cleanup intervals for all caches
- **BigInt Precision Safety**: Safe conversion helpers prevent silent precision loss on large values
- **Event Listener Guards**: Prevents duplicate handler registration and listener accumulation
- **Handler Reference Storage**: Named handlers stored for proper cleanup on shutdown/restart
- **Worker Lifecycle Management**: Worker event listeners properly removed on restart/terminate
- **Graceful Shutdown**: Waits for in-flight operations, saves persistent cache, proper cleanup

## Supported Chains & DEXes

| Chain | DEXes | Block Time |
|-------|-------|------------|
| BSC | PancakeSwap, Biswap, ApeSwap, BabySwap, MDEX | 3s |
| Ethereum | Uniswap V2/V3, SushiSwap, Curve | 12s |
| Polygon | QuickSwap, SushiSwap, Uniswap V3, ApeSwap | 2s |
| Arbitrum | Uniswap V3, SushiSwap, Camelot, TraderJoe | 0.25s |
| Base | Uniswap V3, Aerodrome, BaseSwap, SushiSwap | 2s |
| Avalanche | TraderJoe, Pangolin, SushiSwap, Uniswap V3 | 2s |

## Quick Start

### Prerequisites

- Node.js 18+ LTS
- npm or yarn
- RPC endpoints for desired chains (Alchemy, Infura, or public endpoints)

### Installation

```bash
# Clone repository
git clone <repo-url>
cd arbitrage

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit configuration
nano .env
```

### Configuration

Edit `.env` file with your RPC endpoints and preferences:

```env
# BSC Configuration (enabled by default)
ALCHEMY_RPC_URL=https://bsc-mainnet.g.alchemy.com/v2/YOUR_KEY
ALCHEMY_WS_URL=wss://bsc-mainnet.g.alchemy.com/v2/YOUR_KEY

# Enable additional chains
ETH_ENABLED=true
ETH_ALCHEMY_HTTP=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY

POLYGON_ENABLED=true
POLYGON_ALCHEMY_HTTP=https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY

ARBITRUM_ENABLED=true
ARBITRUM_ALCHEMY_HTTP=https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY

# Trading parameters
MIN_PROFIT_PERCENTAGE=0.5
MAX_SLIPPAGE=1.0

# Alerts
DISCORD_WEBHOOK_URL=your_webhook_url
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
```

### Running

```bash
# Development mode (auto-reload)
npm run dev

# Production mode
npm start

# Run tests
npm test
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Main Thread (Coordinator)                    │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │   Worker    │  │   Cross-    │  │       Dashboard        │  │
│  │ Coordinator │  │   Chain     │  │       & Alerts         │  │
│  └──────┬──────┘  │  Detector   │  └─────────────────────────┘  │
│         │         └──────┬──────┘                                │
└─────────┼────────────────┼───────────────────────────────────────┘
          │                │
    ┌─────┴─────┬──────────┼─────────┬─────────┬─────────┐
    │           │          │         │         │         │
┌───▼───┐  ┌───▼───┐  ┌───▼───┐ ┌───▼───┐ ┌───▼───┐ ┌───▼───┐
│  BSC  │  │  ETH  │  │Polygon│ │ Arb   │ │ Base  │ │ AVAX  │
│Worker │  │Worker │  │Worker │ │Worker │ │Worker │ │Worker │
└───────┘  └───────┘  └───────┘ └───────┘ └───────┘ └───────┘
    │           │          │         │         │         │
    └───────────┴──────────┴─────────┴─────────┴─────────┘
                              │
                    ┌─────────▼─────────┐
                    │   Opportunities   │
                    │   & Execution     │
                    └───────────────────┘
```

### Worker Thread Design

Each chain runs in its own worker thread with:
- **Isolated RPC connections**: One chain's RPC issues don't affect others
- **Independent block monitoring**: Each chain processes at its native block time
- **Automatic restart**: Crashed workers restart automatically
- **Error isolation**: Failures are contained within worker boundaries

## Detection Methods

### 1. Cross-DEX Arbitrage
Buy on one DEX, sell on another within the same chain.
- Monitors price differences across all enabled DEXes
- Calculates optimal trade size using AMM formula
- Factors in DEX fees and gas costs

### 2. Triangular Arbitrage
A → B → C → A path within a single DEX.
- Builds token graphs for each DEX
- Finds profitable cycles using modified Bellman-Ford
- Supports paths up to 4 tokens

### 3. Cross-Chain Arbitrage
Same asset priced differently across chains.
- Tracks token prices across all chains
- Accounts for bridge fees and times
- Identifies opportunities when spread exceeds bridge costs

### 4. Multi-Hop Detection
4+ token arbitrage paths.
- Iterative deepening search for profitable cycles
- Prunes unprofitable paths early
- Returns top opportunities by profit

### 5. Mempool Monitoring (MEV)
Large swap frontrunning opportunities.
- Monitors pending transactions via WebSocket
- Decodes Uniswap V2/V3 swap methods
- Identifies large swaps that will move prices
- Requires archive/MEV-enabled RPC (Flashbots, Blocknative, etc.)

## Project Structure

```
arbitrage/
├── src/
│   ├── index.js                 # Main entry point
│   ├── config/
│   │   ├── index.js             # Configuration aggregator
│   │   └── chains/              # Per-chain configurations
│   │       ├── bsc.js
│   │       ├── ethereum.js
│   │       ├── polygon.js
│   │       ├── arbitrum.js
│   │       ├── base.js
│   │       └── avalanche.js
│   ├── chains/
│   │   ├── BaseChain.js         # Abstract chain class
│   │   ├── ChainFactory.js      # Chain instantiation
│   │   └── implementations/     # Chain-specific implementations
│   ├── workers/
│   │   ├── WorkerCoordinator.js # Manages all workers
│   │   ├── ChainWorker.js       # Worker thread entry
│   │   └── workerMessages.js    # IPC message types
│   ├── analysis/
│   │   ├── arbitrageDetector.js # Cross-DEX detection
│   │   ├── triangularDetector.js# Triangular arbitrage
│   │   ├── profitCalculator.js  # Profit calculations
│   │   ├── CrossChainDetector.js# Cross-chain detection
│   │   ├── MultiHopDetector.js  # Multi-hop paths
│   │   └── MempoolMonitor.js    # Mempool monitoring
│   ├── data/
│   │   ├── priceFetcher.js      # Price fetching
│   │   ├── cacheManager.js      # Price caching
│   │   └── tokenList.js         # Token definitions
│   ├── monitoring/
│   │   ├── blockMonitor.js      # Block subscription
│   │   ├── dashboard.js         # Status dashboard
│   │   └── performanceTracker.js
│   ├── execution/
│   │   ├── executionManager.js  # Trade execution
│   │   ├── transactionBuilder.js
│   │   └── gasOptimizer.js
│   └── utils/
│       ├── rpcManager.js        # RPC failover
│       └── logger.js            # Logging
├── tests/                       # Jest tests
├── contracts/                   # Flash loan contracts
└── docs/                        # Documentation
```

## Gas Pricing

The bot supports both legacy (type 0) and EIP-1559 (type 2) gas pricing:

### EIP-1559 Chains
- **Ethereum** (chainId: 1): 1.5 Gwei priority fee, 2x base fee headroom
- **Polygon** (chainId: 137): 30 Gwei priority fee, 1.5x base fee headroom
- **Arbitrum** (chainId: 42161): 0.01 Gwei priority fee, 1.5x headroom
- **Base** (chainId: 8453): 0.001 Gwei priority fee, 1.5x headroom
- **Avalanche** (chainId: 43114): 1 Gwei priority fee, 1.5x headroom

### Legacy Chains
- **BSC** (chainId: 56): Uses traditional `gasPrice` parameter

The `gasPriceManager` module automatically selects the appropriate gas pricing strategy based on chain ID, with caching to minimize RPC calls.

## Configuration Reference

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DEBUG_MODE` | Enable debug logging | `false` |
| `DYNAMIC_GAS` | Use dynamic gas pricing | `false` |
| `MIN_PROFIT_PERCENTAGE` | Minimum profit threshold | `0.5` |
| `MAX_SLIPPAGE` | Maximum slippage tolerance | `1.0` |
| `WORKERS_ENABLED` | Use worker threads | `true` |
| `CROSS_CHAIN_ENABLED` | Enable cross-chain detection | `false` |
| `MEMPOOL_ENABLED` | Enable mempool monitoring | `false` |

### Per-Chain Environment Variables

Each chain supports its own configuration via `{CHAIN}_` prefix:
- `ETH_ENABLED`, `POLYGON_ENABLED`, etc.
- `ETH_ALCHEMY_HTTP`, `POLYGON_ALCHEMY_HTTP`, etc.
- `ETH_MIN_PROFIT`, `POLYGON_MIN_PROFIT`, etc.

## Testing

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test file
npm test -- tests/unit/arbitrageDetector.test.js

# Run integration tests
npm run test:integration
```

## Deployment

### Docker

```bash
docker build -t arbitrage-bot .
docker run -d --env-file .env arbitrage-bot
```

### Fly.io

```bash
fly auth login
fly launch
fly deploy
```

### Railway

1. Connect GitHub repository
2. Add environment variables in Railway dashboard
3. Deploy automatically on push

## Performance

- **Memory**: 150-300 MB (depends on chains enabled)
- **CPU**: < 10% per chain worker
- **Network**: ~5-10 MB/hour per chain
- **RPC Calls**: ~100-200 RPM per chain (well under free tier limits)

## Troubleshooting

### No Opportunities Found
- Check RPC connectivity: `node scripts/test-connection.js`
- Lower `MIN_PROFIT_PERCENTAGE` temporarily
- Ensure DEXes are enabled in chain config
- Check token liquidity

### Worker Crashes
- Check logs for specific errors
- Verify RPC endpoint health
- Increase `WORKER_TIMEOUT` if processing is slow

### Rate Limit Errors
- Add more RPC endpoints
- Reduce `MAX_PAIRS_TO_MONITOR`
- Use paid RPC tier for high-volume monitoring
- RPC endpoints will automatically recover via self-healing (check logs for "Self-healing: Endpoint recovered")

### WebSocket Connection Issues
- The bot now includes stale block detection - if no blocks are received for 30 seconds, it will automatically reconnect
- WebSocket errors and close events trigger automatic reconnection with exponential backoff
- Check logs for "WebSocket error detected, triggering reconnection" messages

## Contributing

1. Fork the repository
2. Create a feature branch
3. Add tests for new features
4. Submit a pull request

## License

MIT License - see LICENSE file for details

## Version History

### v3.4.0 - Bug Fixes & Reliability
- **Fixed**: Race condition in event processing with atomic queue handling
- **Fixed**: Promise.race orphaned timeout promises in execution manager
- **Fixed**: BigInt overflow/precision loss with safe conversion helpers
- **Fixed**: Unbounded Map growth with size limits and eviction
- **Fixed**: Division by zero guards in profit calculations
- **Fixed**: Event listener accumulation on WebSocket failover
- **Fixed**: Duplicate event handler registration
- **Added**: Handler reference storage pattern for proper event listener cleanup
- **Added**: WorkerCoordinator listener cleanup on worker restart/terminate
- **Added**: ArbitrageBot event handler cleanup in stop() methods
- **Added**: ADR-013 and ADR-014 documenting event handler and singleton patterns

### v3.3.0 - Multi-Chain Isolation
- **Fixed**: Chain isolation - each chain now uses its own RPC/BlockMonitor instances
- **Fixed**: Log context - all logs include chain name for multi-chain mode
- **Changed**: Constructor logs reduced to debug level to reduce noise

### v3.2.0 - Memory & Cleanup
- **Fixed**: Memory leaks in debounce maps and block update tracking
- **Fixed**: Cleanup intervals now properly started and stopped
- **Added**: Validation for block numbers to prevent invalid Map keys

### v3.1.0 - Input Validation
- **Added**: Comprehensive input validation across all modules
- **Fixed**: Timeout handling for transaction confirmations
- **Fixed**: Graceful shutdown with in-flight operation handling

## Disclaimer

This software is for educational and research purposes. Cryptocurrency trading involves significant risk. Always do your own research and never trade with more than you can afford to lose.
