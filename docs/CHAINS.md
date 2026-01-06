# Supported Chains

## Overview

The Multi-Chain Arbitrage Bot supports 6 EVM-compatible blockchains, each with its own DEXes, tokens, and configuration.

| Chain | Chain ID | Native Token | Block Time | Status |
|-------|----------|--------------|------------|--------|
| BSC | 56 | BNB | ~3s | Primary |
| Ethereum | 1 | ETH | ~12s | Enabled |
| Polygon | 137 | MATIC | ~2s | Enabled |
| Arbitrum | 42161 | ETH | ~0.25s | Enabled |
| Base | 8453 | ETH | ~2s | Enabled |
| Avalanche | 43114 | AVAX | ~2s | Enabled |

---

## BSC (Binance Smart Chain)

**Chain ID:** 56
**Config File:** `src/config/chains/bsc.js`

### DEXes

| DEX | Type | Fee | TVL Rank | Status |
|-----|------|-----|----------|--------|
| PancakeSwap | UniswapV2 | 0.25% | 1 | Enabled |
| Biswap | UniswapV2 | 0.10% | 2 | Enabled |
| ApeSwap | UniswapV2 | 0.20% | 3 | Enabled |
| BabySwap | UniswapV2 | 0.30% | 4 | Enabled |
| MDEX | UniswapV2 | 0.30% | 5 | Enabled |
| KnightSwap | UniswapV2 | 0.20% | 6 | Disabled |
| SushiSwap | UniswapV2 | 0.30% | 7 | Disabled |

### Key Tokens

WBNB, USDT, BUSD, USDC, ETH, BTCB, DAI, CAKE, XRP, DOT, LINK, UNI, DOGE, ADA

### Flash Loan Providers

- **PancakeSwap**: 0.25% fee

### Environment Variables

```bash
BSC_ENABLED=true
BSC_ALCHEMY_HTTP=
BSC_ALCHEMY_WS=
BSC_RPC_HTTP_1=
BSC_MIN_PROFIT=0.5
BSC_MAX_SLIPPAGE=1.0
BSC_GAS_PRICE=5
BSC_EXECUTION_ENABLED=false
BSC_PRIVATE_KEY=
```

---

## Ethereum Mainnet

**Chain ID:** 1
**Config File:** `src/config/chains/ethereum.js`

### DEXes

| DEX | Type | Fee | TVL Rank | Status |
|-----|------|-----|----------|--------|
| Uniswap V2 | UniswapV2 | 0.30% | 1 | Enabled |
| Uniswap V3 | UniswapV3 | Variable | 1 | Enabled |
| SushiSwap | UniswapV2 | 0.30% | 2 | Enabled |
| Curve | Curve | Variable | 3 | Disabled |

### Key Tokens

WETH, USDT, USDC, DAI, WBTC, UNI, LINK, AAVE, CRV, MKR, SHIB, PEPE

### Flash Loan Providers

- **Aave V3**: 0.09% fee
- **Balancer**: 0% fee (preferred)

### Environment Variables

```bash
ETH_ENABLED=true
ETH_ALCHEMY_HTTP=
ETH_ALCHEMY_WS=
ETH_RPC_HTTP_1=
ETH_MIN_PROFIT=0.3
ETH_MAX_SLIPPAGE=0.5
ETH_GAS_PRICE=30
ETH_MAX_GAS_PRICE=100
ETH_EXECUTION_ENABLED=false
ETH_PRIVATE_KEY=
```

### Special Considerations

- Highest gas costs of all chains
- Requires larger minimum profit thresholds
- Consider Flashbots for MEV protection
- EIP-1559 transaction format supported

---

## Polygon (Matic)

**Chain ID:** 137
**Config File:** `src/config/chains/polygon.js`

### DEXes

| DEX | Type | Fee | TVL Rank | Status |
|-----|------|-----|----------|--------|
| QuickSwap | UniswapV2 | 0.30% | 1 | Enabled |
| SushiSwap | UniswapV2 | 0.30% | 2 | Enabled |
| Uniswap V3 | UniswapV3 | Variable | 1 | Enabled |
| ApeSwap | UniswapV2 | 0.20% | 3 | Enabled |

### Key Tokens

WMATIC, USDT, USDC, DAI, WETH, WBTC, QUICK, AAVE, LINK, UNI

### Flash Loan Providers

- **Aave V3**: 0.09% fee
- **Balancer**: 0% fee

### Environment Variables

```bash
POLYGON_ENABLED=true
POLYGON_ALCHEMY_HTTP=
POLYGON_ALCHEMY_WS=
POLYGON_RPC_HTTP_1=
POLYGON_MIN_PROFIT=0.3
POLYGON_MAX_SLIPPAGE=1.0
POLYGON_GAS_PRICE=50
POLYGON_EXECUTION_ENABLED=false
POLYGON_PRIVATE_KEY=
```

### Special Considerations

- Very low native token price (MATIC ~$0.50)
- Gas costs essentially negligible
- Frequent reorgs possible
- Consider gas station for accurate fees

---

## Arbitrum One

**Chain ID:** 42161
**Config File:** `src/config/chains/arbitrum.js`

### DEXes

| DEX | Type | Fee | TVL Rank | Status |
|-----|------|-----|----------|--------|
| Uniswap V3 | UniswapV3 | Variable | 1 | Enabled |
| SushiSwap | UniswapV2 | 0.30% | 2 | Enabled |
| Camelot | UniswapV2 | 0.30% | 3 | Enabled |
| TraderJoe | UniswapV2 | 0.30% | 4 | Enabled |

### Key Tokens

WETH, USDT, USDC, USDC.e, DAI, WBTC, ARB, GMX, LINK, UNI, MAGIC, RDNT

### Flash Loan Providers

- **Aave V3**: 0.09% fee
- **Balancer**: 0% fee (preferred)

### Environment Variables

```bash
ARBITRUM_ENABLED=true
ARBITRUM_ALCHEMY_HTTP=
ARBITRUM_ALCHEMY_WS=
ARBITRUM_RPC_HTTP_1=
ARBITRUM_MIN_PROFIT=0.2
ARBITRUM_MAX_SLIPPAGE=0.5
ARBITRUM_GAS_PRICE=0.1
ARBITRUM_MAX_GAS_PRICE=1
ARBITRUM_EXECUTION_ENABLED=false
ARBITRUM_PRIVATE_KEY=
```

### Special Considerations

- **L2 with L1 data fees**: Total cost = L2 execution + L1 data posting
- Very fast block times (~250ms)
- Sequencer-ordered (first-come-first-served)
- Gas price in sub-gwei values (use `parseFloat`)
- Consider ArbGasInfo precompile for accurate fees

---

## Base

**Chain ID:** 8453
**Config File:** `src/config/chains/base.js`

### DEXes

| DEX | Type | Fee | TVL Rank | Status |
|-----|------|-----|----------|--------|
| Uniswap V3 | UniswapV3 | Variable | 1 | Enabled |
| Aerodrome | Solidly | 0.30% | 1 | Enabled |
| BaseSwap | UniswapV2 | 0.30% | 2 | Enabled |
| SushiSwap | UniswapV2 | 0.30% | 3 | Enabled |

### Key Tokens

WETH, USDC, USDbC, DAI, cbETH, AERO, BSWAP, TOSHI, DEGEN, BRETT

### Flash Loan Providers

- **Aave V3**: 0.09% fee

### Environment Variables

```bash
BASE_ENABLED=true
BASE_ALCHEMY_HTTP=
BASE_ALCHEMY_WS=
BASE_RPC_HTTP_1=
BASE_MIN_PROFIT=0.2
BASE_MAX_SLIPPAGE=0.5
BASE_GAS_PRICE=0.01
BASE_MAX_GAS_PRICE=1
BASE_EXECUTION_ENABLED=false
BASE_PRIVATE_KEY=
```

### Special Considerations

- **L2 with L1 data fees** (Optimism stack)
- Uses GasPriceOracle contract for L1 fee estimation
- Very low L2 gas prices
- Coinbase-backed chain
- Growing DeFi ecosystem

---

## Avalanche C-Chain

**Chain ID:** 43114
**Config File:** `src/config/chains/avalanche.js`

### DEXes

| DEX | Type | Fee | TVL Rank | Status |
|-----|------|-----|----------|--------|
| TraderJoe | UniswapV2 | 0.30% | 1 | Enabled |
| Pangolin | UniswapV2 | 0.30% | 2 | Enabled |
| SushiSwap | UniswapV2 | 0.30% | 3 | Enabled |
| Uniswap V3 | UniswapV3 | Variable | 2 | Enabled |

### Key Tokens

WAVAX, USDT, USDC, USDC.e, DAI, WETH.e, WBTC.e, JOE, PNG, QI, sAVAX, GMX

### Flash Loan Providers

- **Aave V3**: 0.09% fee
- **BENQI**: 0% fee

### Environment Variables

```bash
AVALANCHE_ENABLED=true
AVALANCHE_ALCHEMY_HTTP=
AVALANCHE_ALCHEMY_WS=
AVALANCHE_RPC_HTTP_1=
AVALANCHE_MIN_PROFIT=0.3
AVALANCHE_MAX_SLIPPAGE=1.0
AVALANCHE_GAS_PRICE=25
AVALANCHE_EXECUTION_ENABLED=false
AVALANCHE_PRIVATE_KEY=
```

### Special Considerations

- Separate from Avalanche X-Chain and P-Chain
- Uses AVAX for gas (~$35)
- Many bridged tokens use `.e` suffix (WETH.e, USDC.e)
- Native USDC vs bridged USDC.e distinction important

---

## Chain Comparison

### Gas Cost Comparison (Approximate)

| Chain | Swap Gas | Gas Price | Cost per Swap |
|-------|----------|-----------|---------------|
| Ethereum | 150k | 30 gwei | ~$15.00 |
| BSC | 100k | 5 gwei | ~$0.30 |
| Polygon | 100k | 50 gwei | ~$0.003 |
| Arbitrum | 180k | 0.1 gwei | ~$0.05 |
| Base | 160k | 0.01 gwei | ~$0.01 |
| Avalanche | 110k | 25 nAVAX | ~$0.10 |

### Block Time Comparison

```
Arbitrum:  ████ 0.25s (fastest)
Polygon:   ████████ 2s
Base:      ████████ 2s
Avalanche: ████████ 2s
BSC:       ████████████ 3s
Ethereum:  ████████████████████████████████████████████████ 12s
```

### Liquidity Ranking

1. **Ethereum** - Deepest liquidity, highest gas
2. **BSC** - Good liquidity, low gas
3. **Arbitrum** - Growing rapidly, very low gas
4. **Polygon** - Established, lowest gas
5. **Avalanche** - DeFi native ecosystem
6. **Base** - Newest, growing fast

---

## Enabling/Disabling Chains

### Enable All Chains (Default)

All chains are enabled by default. To disable specific chains:

```bash
# Disable Ethereum (high gas)
ETH_ENABLED=false

# Disable Polygon
POLYGON_ENABLED=false
```

### Single-Chain Mode

For testing or resource-constrained environments:

```bash
MULTI_CHAIN_MODE=false
# Only BSC will run
```

### Recommended Configurations

**Development/Testing:**
```bash
BSC_ENABLED=true
# All others disabled
MULTI_CHAIN_MODE=false
```

**Production (Low Resources):**
```bash
BSC_ENABLED=true
POLYGON_ENABLED=true
BASE_ENABLED=true
# Ethereum disabled (high gas)
ETH_ENABLED=false
```

**Production (Full):**
```bash
# All chains enabled (default)
# Configure RPC endpoints for each
```

---

## RPC Endpoint Recommendations

### Free Tier RPCs

| Chain | Public RPCs |
|-------|-------------|
| BSC | bsc-dataseed.binance.org |
| Ethereum | eth.llamarpc.com |
| Polygon | polygon-rpc.com |
| Arbitrum | arb1.arbitrum.io/rpc |
| Base | mainnet.base.org |
| Avalanche | api.avax.network/ext/bc/C/rpc |

### Recommended Providers (Paid)

1. **Alchemy** - Best for Ethereum, Polygon, Arbitrum, Base
2. **QuickNode** - All chains
3. **Infura** - Ethereum, Polygon
4. **Ankr** - All chains, free tier available
5. **BlastAPI** - All chains, generous free tier

### Rate Limits

Configure per chain:
```javascript
rpc: {
    maxRequestsPerMinute: 300,  // Adjust based on provider
    requestDelay: 50,           // ms between requests
}
```

---

*Last Updated: 2026-01-06*
