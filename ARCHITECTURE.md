# Architecture Documentation

## Overview

The Multi-Chain Arbitrage Bot is a sophisticated DeFi arbitrage detection and execution system designed for 24/7 continuous operation across multiple EVM-compatible blockchains.

**Version:** v3.0.0 (Multi-Chain) with v2.1 RPC Resilience
**Supported Chains:** BSC, Ethereum, Polygon, Arbitrum, Base, Avalanche

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Multi-Chain Arbitrage Bot                          │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐       │
│  │   BSC       │  │  Ethereum   │  │   Polygon   │  │  Arbitrum   │  ...  │
│  │  Worker     │  │   Worker    │  │   Worker    │  │   Worker    │       │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘       │
│         │                │                │                │              │
│  ┌──────┴────────────────┴────────────────┴────────────────┴──────┐       │
│  │                     Worker Coordinator                         │       │
│  └────────────────────────────┬───────────────────────────────────┘       │
│                               │                                           │
│  ┌────────────────────────────┴───────────────────────────────────┐       │
│  │                    Cross-Chain Detector                        │       │
│  └────────────────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Core Components

### 1. RPC Manager (v2.1 - Resilient)

The RPC Manager provides fault-tolerant blockchain connectivity with features designed for 24/7 operation.

**Location:** `src/utils/rpcManager.js`

#### Key Features (v2.1)

1. **True Round-Robin Load Distribution**
   - Requests distributed evenly across ALL healthy providers
   - No priority for premium providers (prevents single-point rate limits)
   - Automatic failover on provider failure

2. **Global Request Budget**
   - Tracks total requests across all endpoints
   - Prevents aggregate overload (80% of combined limits, max 1000/min)
   - Configurable via `MAX_RPC_RPM` env variable

3. **Request Throttling**
   - Minimum interval between requests (default 50ms)
   - Prevents request bursts that trigger rate limits
   - Configurable via `rpc.requestDelay` in config

4. **Endpoint Cooldowns**
   - Rate-limited endpoints enter 60-second cooldown
   - Faster recovery than full health checks
   - Automatic cooldown clearing on emergency reset

5. **Self-Healing**
   - Background health checks every 5 minutes
   - Automatic recovery of previously failed endpoints
   - Event-based recovery notifications

#### RPC Providers by Chain

**BSC:**
- https://bsc-dataseed.binance.org (Binance official)
- https://bsc-dataseed1.defibit.io (DeFiBit)
- https://bsc-dataseed1.ninicoin.io (NiniCoin)
- https://bsc.publicnode.com (PublicNode)
- https://bsc-rpc.publicnode.com (PublicNode RPC)

**Ethereum:**
- https://eth.llamarpc.com (LlamaRPC)
- https://ethereum.publicnode.com (PublicNode)
- https://rpc.ankr.com/eth (Ankr)

**Polygon:**
- https://polygon-rpc.com (Official)
- https://polygon.llamarpc.com (LlamaRPC)
- https://polygon-mainnet.public.blastapi.io (BlastAPI)

**Arbitrum:**
- https://arb1.arbitrum.io/rpc (Official)
- https://arbitrum.llamarpc.com (LlamaRPC)
- https://arbitrum-one.public.blastapi.io (BlastAPI)

**Base:**
- https://mainnet.base.org (Official)
- https://base.llamarpc.com (LlamaRPC)
- https://base-mainnet.public.blastapi.io (BlastAPI)

**Avalanche:**
- https://api.avax.network/ext/bc/C/rpc (Official)
- https://avalanche.public-rpc.com (Public RPC)
- https://avalanche-c-chain.publicnode.com (PublicNode)

### 2. Price Fetcher (v2.1 - Optimized)

The Price Fetcher retrieves token prices via multicall batches with optimizations for rate limit management.

**Location:** `src/data/priceFetcher.js`

#### Key Features (v2.1)

1. **Reduced Batch Sizes**
   - Default: 50 calls/batch (down from 200)
   - Configurable via `MULTICALL_BATCH_SIZE` env variable
   - Smaller batches = better load distribution

2. **Inter-Batch Delays**
   - Default: 100ms between batches
   - Configurable via `MULTICALL_BATCH_DELAY` env variable
   - Prevents burst requests that trigger rate limits

3. **Cache-Aware Fetching**
   - Skips RPC calls for pairs with fresh event-driven data
   - Uses sync events from WebSocket for real-time updates
   - Significantly reduces RPC usage during normal operation

4. **Priority-Aware**
   - Respects AdaptivePrioritizer tier frequencies
   - High-opportunity pairs checked more frequently
   - Low-activity pairs checked less often

### 3. Cache Manager (v2.1 - Extended TTL)

**Location:** `src/data/cacheManager.js`

#### Key Features (v2.1)

1. **Extended Price Cache TTL**
   - Default: 60 seconds (up from 30)
   - Configurable via `PRICE_CACHE_TTL` env variable
   - Better tolerance for RPC rate limit periods

2. **Stale Data Acceptance**
   - Default: Accept data up to 3 blocks old
   - Configurable via `MAX_STALE_BLOCKS` env variable
   - Graceful degradation during RPC issues

3. **Persistent Pair Cache**
   - Pair addresses saved to disk
   - Survives restarts, reducing startup RPC calls
   - Located in `data/pair-cache.json`

### 4. Event-Driven Detector

Real-time price monitoring via WebSocket subscriptions to DEX events.

**Location:** `src/monitoring/eventDrivenDetector.js`

#### Key Features

1. **Sync Event Subscriptions (V2)**
   - Real-time reserve updates from Uniswap V2-style DEXes
   - ~10-50x faster than block polling
   - Direct cache updates without RPC calls

2. **Swap Event Tracking**
   - Whale transaction detection
   - Volume analysis for opportunity scoring
   - Configurable minimum swap size

3. **V3 Swap Events**
   - sqrtPriceX96 and tick data from V3 swaps
   - Direct price calculation without RPC quotes
   - Fee tier awareness

4. **Resilient WebSocket**
   - Automatic reconnection on failure
   - Circuit breaker pattern
   - Multi-endpoint failover

### 5. Arbitrage Detection

Multiple detection strategies for comprehensive opportunity identification.

**Components:**
- `arbitrageDetector.js` - V2 cross-DEX detection
- `v2v3Arbitrage.js` - V2/V3 price differential detection
- `statisticalArbitrageDetector.js` - Statistical patterns
- `reserveDifferentialAnalyzer.js` - Reserve-based analysis
- `MultiHopDetector.js` - Multi-hop path finding

### 6. DEX Configuration (v2.1 - Expanded)

56 DEXes across 6 chains with specialized support for different AMM types.

**Supported DEX Types:**
- `uniswapV2` - Constant product AMM (PancakeSwap, SushiSwap, etc.)
- `uniswapV3` - Concentrated liquidity (Uniswap V3, KyberSwap)
- `curve` - StableSwap pools (Curve, Ellipsis)
- `balancer` - Weighted pools (Balancer V2)
- `solidly` - ve(3,3) DEXes (Aerodrome, Chronos, Velodrome)
- `maverick` - Directional liquidity
- `gmx` - Oracle-based perpetuals
- `woofi` - PMM-style
- `dodo` - Proactive market maker

## Environment Variables

### RPC Resilience (v2.1)

```bash
# Multicall batch configuration
MULTICALL_BATCH_SIZE=50       # Calls per batch (default: 50)
MULTICALL_BATCH_DELAY=100     # ms between batches (default: 100)

# Cache configuration
PRICE_CACHE_TTL=60            # Seconds to cache prices (default: 60)
MAX_STALE_BLOCKS=3            # Accept data N blocks old (default: 3)

# Rate limiting
MAX_RPC_RPM=300               # Max requests per minute per endpoint
```

### Chain-Specific Alchemy Endpoints

```bash
# BSC
ALCHEMY_RPC_URL=https://...
ALCHEMY_WS_URL=wss://...

# Ethereum
ETH_ALCHEMY_HTTP=https://...
ETH_ALCHEMY_WS=wss://...

# Polygon
POLYGON_ALCHEMY_HTTP=https://...
POLYGON_ALCHEMY_WS=wss://...

# Arbitrum
ARBITRUM_ALCHEMY_HTTP=https://...
ARBITRUM_ALCHEMY_WS=wss://...

# Base
BASE_ALCHEMY_HTTP=https://...
BASE_ALCHEMY_WS=wss://...

# Avalanche
AVALANCHE_ALCHEMY_HTTP=https://...
AVALANCHE_ALCHEMY_WS=wss://...
```

## Data Flow

### Normal Operation (Event-Driven)

```
1. WebSocket receives Sync/Swap events
   ↓
2. EventDrivenDetector updates price cache directly
   ↓
3. ArbitrageDetector analyzes affected pairs
   ↓
4. Opportunities emitted for execution/alerting
```

### Fallback Operation (RPC Polling)

```
1. BlockMonitor detects new block
   ↓
2. PriceFetcher checks cache for fresh data
   ↓
3. Only stale pairs fetched via multicall
   ↓
4. Results cached and analyzed
```

### RPC Request Flow (v2.1)

```
1. Request initiated
   ↓
2. Throttle check (minimum interval)
   ↓
3. Global budget check
   ↓
4. Get healthy provider (round-robin)
   ↓
5. Per-endpoint rate limit check
   ↓
6. Execute request
   ↓
7. On success: reset health counters
   On rate limit: set cooldown, failover
   On error: increment failures
```

## 24/7 Operation Guidelines

### Rate Limit Prevention

1. **Use all configured providers** - Don't rely on single Alchemy endpoint
2. **Reduce batch sizes** if hitting limits - Try `MULTICALL_BATCH_SIZE=30`
3. **Increase delays** during high load - Try `MULTICALL_BATCH_DELAY=200`
4. **Monitor global budget** via dashboard stats

### Recovery from Rate Limits

The system automatically:
1. Puts rate-limited endpoint in 60s cooldown
2. Fails over to next healthy provider
3. Continues operation without interruption
4. Re-tests endpoint after cooldown

### Monitoring Health

Check RPC status via dashboard or logs:
```
RPC Stats: {
  http: { total: 5, healthy: 5 },
  ws: { connected: true, endpoint: '...' },
  selfHealing: { enabled: true, unhealthyEndpoints: 0 },
  globalBudget: { count: 150, max: 1000 }
}
```

## Testing

```bash
# Run all tests
npm test

# Run specific test suites
npm test -- --testPathPattern="rpcManager"
npm test -- --testPathPattern="priceFetcher"
npm test -- --testPathPattern="chainConfigs"
```

## Performance Characteristics

- **Memory:** ~100-200 MB (varies with cache size)
- **CPU:** < 10% during normal operation
- **RPC Calls:** ~50-100/min with event-driven mode (vs ~300-500 polling)
- **Latency:** <100ms opportunity detection (event-driven)

## Version History

### v2.1 (RPC Resilience)
- True round-robin provider rotation
- Global request budgeting
- Configurable batch sizes and delays
- Extended cache TTL
- Endpoint cooldown system

### v2.0 (DEX Expansion)
- 56 DEXes across 6 chains
- Liquid Staking Token support
- Specialized AMM handlers

### v1.0 (Initial)
- BSC single-chain
- Basic V2 arbitrage detection
