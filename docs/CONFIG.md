# Configuration Reference

## Overview

Configuration is managed through a hierarchy of sources:
1. Environment variables (highest priority)
2. Chain-specific config files (`src/config/chains/*.js`)
3. Default values (lowest priority)

---

## Environment Variables

### Global Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `MULTI_CHAIN_MODE` | Enable multi-chain monitoring | `true` |
| `LOG_LEVEL` | Logging verbosity (error, warn, info, debug) | `info` |
| `NODE_ENV` | Environment (development, production) | `development` |

### Per-Chain Variables

Replace `{CHAIN}` with: `ETH`, `BSC`, `POLYGON`, `ARBITRUM`, `BASE`, `AVALANCHE`

#### Enabling/Disabling

| Variable | Description | Default |
|----------|-------------|---------|
| `{CHAIN}_ENABLED` | Enable this chain | `true` (except explicit false) |

#### RPC Configuration

| Variable | Description | Example |
|----------|-------------|---------|
| `{CHAIN}_ALCHEMY_HTTP` | Alchemy HTTP endpoint | `https://eth-mainnet.g.alchemy.com/v2/...` |
| `{CHAIN}_ALCHEMY_WS` | Alchemy WebSocket endpoint | `wss://eth-mainnet.g.alchemy.com/v2/...` |
| `{CHAIN}_RPC_HTTP_1` | Additional HTTP RPC | `https://...` |
| `{CHAIN}_RPC_WS_1` | Additional WebSocket RPC | `wss://...` |
| `{CHAIN}_MAX_RPC_RPM` | Max requests per minute | `300` |

#### Trading Parameters

| Variable | Description | Default |
|----------|-------------|---------|
| `{CHAIN}_MIN_PROFIT` | Minimum profit percentage | Chain-specific |
| `{CHAIN}_MAX_SLIPPAGE` | Maximum slippage percentage | Chain-specific |
| `{CHAIN}_GAS_PRICE` | Default gas price (gwei) | Chain-specific |
| `{CHAIN}_MAX_GAS_PRICE` | Maximum gas price (gwei) | Chain-specific |

#### Execution Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `{CHAIN}_EXECUTION_ENABLED` | Enable live execution | `false` |
| `{CHAIN}_EXECUTION_MODE` | Mode: simulation or live | `simulation` |
| `{CHAIN}_FLASH_CONTRACT` | Flash loan contract address | `null` |
| `{CHAIN}_PRIVATE_KEY` | Wallet private key | `null` |
| `{CHAIN}_MIN_PROFIT_USD` | Minimum profit in USD | Chain-specific |
| `{CHAIN}_SLIPPAGE_TOLERANCE` | Execution slippage tolerance | Chain-specific |

#### Monitoring Settings

| Variable | Description | Default |
|----------|-------------|---------|
| `{CHAIN}_MAX_PAIRS` | Maximum pairs to monitor | Chain-specific |
| `{CHAIN}_CACHE_SIZE` | Price cache size | Chain-specific |
| `{CHAIN}_BLOCK_TIMEOUT` | Block processing timeout (ms) | Chain-specific |

#### Triangular Arbitrage

| Variable | Description | Default |
|----------|-------------|---------|
| `{CHAIN}_TRIANGULAR_ENABLED` | Enable triangular detection | `true` |
| `{CHAIN}_TRIANGULAR_MIN_LIQUIDITY` | Min liquidity USD | Chain-specific |
| `{CHAIN}_TRIANGULAR_MAX_TRADE` | Max trade size USD | Chain-specific |

---

## Chain-Specific Defaults

### BSC (Primary Chain)

```javascript
{
    blockTime: 3000,                    // 3 seconds
    trading: {
        minProfitPercentage: 0.5,       // 0.5%
        maxSlippage: 1.0,               // 1%
        gasPriceGwei: 5,
        estimatedGasLimit: 350000,
    },
    monitoring: {
        maxPairsToMonitor: 250,
        cacheSize: 2000,
        blockProcessingTimeout: 2500,
    },
    triangular: {
        minLiquidityUSD: 5000,
        maxTradeSizeUSD: 5000,
    },
    execution: {
        minProfitUSD: 1.0,
        maxGasPriceGwei: 10,
        slippageTolerance: 1.0,
    },
}
```

### Ethereum

```javascript
{
    blockTime: 12000,                   // 12 seconds
    trading: {
        minProfitPercentage: 0.3,
        maxSlippage: 0.5,
        gasPriceGwei: 30,
        estimatedGasLimit: 400000,
    },
    monitoring: {
        maxPairsToMonitor: 150,
        cacheSize: 1500,
        blockProcessingTimeout: 10000,
    },
    triangular: {
        minLiquidityUSD: 50000,         // Higher due to gas costs
        maxTradeSizeUSD: 10000,
    },
    execution: {
        minProfitUSD: 10.0,             // Higher due to gas costs
        maxGasPriceGwei: 100,
        slippageTolerance: 0.5,
    },
}
```

### Polygon

```javascript
{
    blockTime: 2000,                    // 2 seconds
    trading: {
        minProfitPercentage: 0.3,
        maxSlippage: 1.0,
        gasPriceGwei: 50,
        estimatedGasLimit: 350000,
    },
    monitoring: {
        maxPairsToMonitor: 200,
        cacheSize: 1500,
        blockProcessingTimeout: 1800,
    },
    triangular: {
        minLiquidityUSD: 5000,
        maxTradeSizeUSD: 5000,
    },
    execution: {
        minProfitUSD: 1.0,
        maxGasPriceGwei: 200,
        slippageTolerance: 1.0,
    },
}
```

### Arbitrum

```javascript
{
    blockTime: 250,                     // 0.25 seconds (fastest)
    trading: {
        minProfitPercentage: 0.2,
        maxSlippage: 0.5,
        gasPriceGwei: 0.1,              // Sub-gwei values
        estimatedGasLimit: 500000,
    },
    monitoring: {
        maxPairsToMonitor: 200,
        cacheSize: 1500,
        blockProcessingTimeout: 200,
    },
    triangular: {
        minLiquidityUSD: 10000,
        maxTradeSizeUSD: 10000,
    },
    execution: {
        minProfitUSD: 2.0,
        maxGasPriceGwei: 1,
        slippageTolerance: 0.5,
    },
}
```

### Base

```javascript
{
    blockTime: 2000,                    // 2 seconds
    trading: {
        minProfitPercentage: 0.2,
        maxSlippage: 0.5,
        gasPriceGwei: 0.01,             // Very low gas
        estimatedGasLimit: 400000,
    },
    monitoring: {
        maxPairsToMonitor: 150,
        cacheSize: 1000,
        blockProcessingTimeout: 1500,
    },
    triangular: {
        minLiquidityUSD: 5000,
        maxTradeSizeUSD: 5000,
    },
    execution: {
        minProfitUSD: 1.0,
        maxGasPriceGwei: 1,
        slippageTolerance: 0.5,
    },
}
```

### Avalanche

```javascript
{
    blockTime: 2000,                    // 2 seconds
    trading: {
        minProfitPercentage: 0.3,
        maxSlippage: 1.0,
        gasPriceGwei: 25,               // nAVAX
        estimatedGasLimit: 350000,
    },
    monitoring: {
        maxPairsToMonitor: 200,
        cacheSize: 1500,
        blockProcessingTimeout: 1800,
    },
    triangular: {
        minLiquidityUSD: 5000,
        maxTradeSizeUSD: 5000,
    },
    execution: {
        minProfitUSD: 1.0,
        maxGasPriceGwei: 50,
        slippageTolerance: 1.0,
    },
}
```

---

## Sample .env File

```bash
# ===========================================
# GLOBAL SETTINGS
# ===========================================
MULTI_CHAIN_MODE=true
LOG_LEVEL=info
NODE_ENV=production

# ===========================================
# BSC CONFIGURATION
# ===========================================
BSC_ENABLED=true
BSC_ALCHEMY_HTTP=https://bnb-mainnet.g.alchemy.com/v2/YOUR_KEY
BSC_ALCHEMY_WS=wss://bnb-mainnet.g.alchemy.com/v2/YOUR_KEY
BSC_MIN_PROFIT=0.5
BSC_MAX_SLIPPAGE=1.0
BSC_GAS_PRICE=5
BSC_MAX_GAS_PRICE=10
BSC_EXECUTION_ENABLED=false
# BSC_PRIVATE_KEY=0x...

# ===========================================
# ETHEREUM CONFIGURATION
# ===========================================
ETH_ENABLED=true
ETH_ALCHEMY_HTTP=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
ETH_ALCHEMY_WS=wss://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
ETH_MIN_PROFIT=0.3
ETH_MAX_SLIPPAGE=0.5
ETH_GAS_PRICE=30
ETH_MAX_GAS_PRICE=100
ETH_EXECUTION_ENABLED=false

# ===========================================
# POLYGON CONFIGURATION
# ===========================================
POLYGON_ENABLED=true
POLYGON_ALCHEMY_HTTP=https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY
POLYGON_ALCHEMY_WS=wss://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY
POLYGON_MIN_PROFIT=0.3
POLYGON_GAS_PRICE=50
POLYGON_EXECUTION_ENABLED=false

# ===========================================
# ARBITRUM CONFIGURATION
# ===========================================
ARBITRUM_ENABLED=true
ARBITRUM_ALCHEMY_HTTP=https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY
ARBITRUM_ALCHEMY_WS=wss://arb-mainnet.g.alchemy.com/v2/YOUR_KEY
ARBITRUM_MIN_PROFIT=0.2
ARBITRUM_GAS_PRICE=0.1
ARBITRUM_EXECUTION_ENABLED=false

# ===========================================
# BASE CONFIGURATION
# ===========================================
BASE_ENABLED=true
BASE_ALCHEMY_HTTP=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
BASE_ALCHEMY_WS=wss://base-mainnet.g.alchemy.com/v2/YOUR_KEY
BASE_MIN_PROFIT=0.2
BASE_GAS_PRICE=0.01
BASE_EXECUTION_ENABLED=false

# ===========================================
# AVALANCHE CONFIGURATION
# ===========================================
AVALANCHE_ENABLED=true
AVALANCHE_RPC_HTTP_1=https://api.avax.network/ext/bc/C/rpc
AVALANCHE_MIN_PROFIT=0.3
AVALANCHE_GAS_PRICE=25
AVALANCHE_EXECUTION_ENABLED=false

# ===========================================
# ALERTS (Optional)
# ===========================================
# TELEGRAM_BOT_TOKEN=
# TELEGRAM_CHAT_ID=
# DISCORD_WEBHOOK_URL=
```

---

## Configuration Validation

The system uses Joi schemas for configuration validation. Invalid configurations will throw errors at startup.

### Required Fields

Each chain config must have:
- `name` (string)
- `chainId` (number)
- `enabled` (boolean)
- `blockTime` (number)
- `nativeToken` object
- `rpc` object with at least one HTTP endpoint
- `dexes` object with at least one DEX
- `tokens` object with at least one token
- `baseTokens` array

### Validation Errors

Common validation errors and fixes:

```
Error: "chainId" must be a number
Fix: Ensure chainId is numeric, not a string

Error: "rpc.http" must contain at least 1 items
Fix: Add at least one RPC endpoint (env var or hardcoded)

Error: "dexes.xxx.router" must be a valid address
Fix: Ensure router address is valid 0x... format
```

---

## Runtime Configuration Changes

Some settings can be changed at runtime via the dashboard or API:

### Dynamically Adjustable
- Minimum profit thresholds
- Slippage tolerance
- Gas price limits
- Execution mode (simulation/live)

### Requires Restart
- RPC endpoints
- Chain enable/disable
- DEX enable/disable
- Token list changes

---

## Performance Tuning

### High-Performance Setup

```bash
# Increase monitoring capacity
BSC_MAX_PAIRS=500
BSC_CACHE_SIZE=5000

# Shorter timeouts for fast chains
ARBITRUM_BLOCK_TIMEOUT=100

# More aggressive profit thresholds
BSC_MIN_PROFIT=0.3
```

### Low-Resource Setup

```bash
# Reduce monitoring capacity
BSC_MAX_PAIRS=100
BSC_CACHE_SIZE=500

# Single chain only
MULTI_CHAIN_MODE=false
ETH_ENABLED=false
POLYGON_ENABLED=false
ARBITRUM_ENABLED=false
BASE_ENABLED=false
AVALANCHE_ENABLED=false
```

---

## Security Best Practices

### Private Keys

1. **Never commit private keys** to version control
2. Use environment variables or secret managers
3. Use separate wallets for testing vs production
4. Consider hardware wallet integration for live trading

### RPC Security

1. Use HTTPS/WSS only
2. Keep API keys secret
3. Use rate limiting
4. Consider private RPCs for execution

### Configuration Files

1. Add `.env` to `.gitignore`
2. Use `.env.example` for documentation
3. Encrypt sensitive configs in production
4. Audit environment variable access

---

*Last Updated: 2026-01-06*
