# Profit Calculation & Gas Price Analysis

## Current Implementation Analysis

### Overview

The arbitrage bot's profit calculation system is designed for single-chain operation on BSC, with multi-chain support added but not fully optimized for chain-specific gas models. This document analyzes the current implementation and proposes extensions for proper multi-chain gas handling.

---

## Current Architecture

### 1. Profit Calculator (`src/analysis/profitCalculator.js`)

The profit calculator supports two arbitrage types:

#### Cross-DEX Arbitrage
```
Net Profit = Gross Profit - Flash Loan Fee - Gas Cost - Slippage Buffer
```

#### Triangular Arbitrage
- Uses Uniswap V2 AMM formula for accurate price impact calculation
- Binary search optimization for optimal trade size
- Accounts for 3 swaps instead of 2

#### Key Parameters
| Parameter | Value | Notes |
|-----------|-------|-------|
| Flash Loan Fee | 0.25% | PancakeSwap V2 |
| Slippage Buffer | 1% | Safety margin |
| Min Profit USD | $1.00 | Configurable |
| Min Profit % | 0.5% | Configurable |

#### Gas Estimation Constants
```javascript
gasEstimates = {
    flashLoanOverhead: 150000n,  // Base flash loan cost
    perSwap: 100000n,            // Gas per swap
    profitValidation: 10000n,    // On-chain profit check
}
```

**Issue**: These are BSC-specific estimates and don't account for:
- L2 data availability costs (Arbitrum, Base)
- Different EVM implementations
- Varying swap complexity by DEX type

### 2. Gas Optimizer (`src/execution/gasOptimizer.js`)

#### Tiered Gas Pricing Strategy
| Profit Tier | Threshold | Multiplier | Strategy |
|-------------|-----------|------------|----------|
| High | $50+ | 1.20x | Pay premium for speed |
| Medium | $10-50 | 1.00x | Market rate |
| Low | $1-10 | 0.95x | Accept slower inclusion |

#### Current Limitations
1. **Single gas price model** - Uses `provider.getFeeData()` which returns:
   - `gasPrice` for legacy transactions
   - No EIP-1559 support (maxFeePerGas, maxPriorityFeePerGas)

2. **No chain-specific handling** - Same logic for all chains despite vastly different gas economics

3. **Static gas limits** - Hardcoded estimates don't adapt to actual execution costs

### 3. RPC Manager Gas Fetching (`src/utils/rpcManager.js`)

```javascript
async getGasPrice() {
    const feeData = await provider.getFeeData();
    return feeData.gasPrice;
}
```

**Issue**: This simplistic approach ignores:
- EIP-1559 base fee + priority fee model
- L2-specific fee structures
- MEV protection considerations

---

## Chain-Specific Gas Economics

### Current vs Required Handling

| Chain | Current Handling | Required Handling |
|-------|------------------|-------------------|
| **Ethereum** | Legacy gasPrice | EIP-1559 (baseFee + priorityFee) |
| **BSC** | Legacy gasPrice | Legacy (correct) |
| **Polygon** | Legacy gasPrice | EIP-1559 + gas station API |
| **Arbitrum** | Legacy gasPrice | L1 data fee + L2 execution fee |
| **Base** | Legacy gasPrice | L1 data fee + L2 execution fee |
| **Avalanche** | Legacy gasPrice | Dynamic fee (C-Chain specific) |

### L2 Fee Structure (Arbitrum, Base, Optimism)

L2s have a **two-component fee structure**:

```
Total Fee = L2 Execution Fee + L1 Data Fee

L2 Execution Fee = L2 Gas Used × L2 Gas Price
L1 Data Fee = L1 Data Size × L1 Gas Price × Scalar
```

The L1 data fee is **significant** and can be 50-90% of total costs during high L1 gas periods.

#### Arbitrum Specifics
- Uses ArbGasInfo precompile at `0x000000000000000000000000000000000000006C`
- Provides `getPricesInWei()` for accurate fee estimation
- L1 base fee affects costs significantly

#### Base/Optimism Specifics
- Uses GasPriceOracle at `0x420000000000000000000000000000000000000F`
- Methods: `l1BaseFee()`, `overhead()`, `scalar()`, `decimals()`

### Native Token Price Impact

Current implementation hardcodes BNB price:
```javascript
this.bnbPriceUSD = 600;
```

**Issue**: Each chain has different native tokens with different prices:

| Chain | Native Token | Approx Price | Impact on Gas Cost |
|-------|--------------|--------------|-------------------|
| Ethereum | ETH | $3,500 | Very high gas costs |
| BSC | BNB | $600 | Moderate |
| Polygon | MATIC | $0.50 | Very low |
| Arbitrum | ETH | $3,500 | Low (L2 pricing) |
| Base | ETH | $3,500 | Low (L2 pricing) |
| Avalanche | AVAX | $35 | Low-moderate |

---

## Proposed Extensions

### Phase 1: Chain-Specific Gas Price Fetching

#### 1.1 Create `ChainGasOracle` Base Class

```javascript
// Proposed: src/gas/ChainGasOracle.js
class ChainGasOracle {
    constructor(chainId, provider) {
        this.chainId = chainId;
        this.provider = provider;
    }

    async getGasPrices() {
        // Returns { fast, standard, slow } in wei
    }

    async estimateTransactionCost(gasLimit, txData) {
        // Returns total cost in native token
    }

    async getNativeTokenPriceUSD() {
        // Returns current price from price oracle
    }
}
```

#### 1.2 Implement Chain-Specific Oracles

**Ethereum Oracle (EIP-1559)**
```javascript
class EthereumGasOracle extends ChainGasOracle {
    async getGasPrices() {
        const feeData = await this.provider.getFeeData();
        const baseFee = feeData.lastBaseFeePerGas;

        return {
            fast: {
                maxFeePerGas: baseFee * 2n + parseUnits('3', 'gwei'),
                maxPriorityFeePerGas: parseUnits('3', 'gwei'),
            },
            standard: {
                maxFeePerGas: baseFee * 15n / 10n + parseUnits('1.5', 'gwei'),
                maxPriorityFeePerGas: parseUnits('1.5', 'gwei'),
            },
            slow: {
                maxFeePerGas: baseFee + parseUnits('1', 'gwei'),
                maxPriorityFeePerGas: parseUnits('1', 'gwei'),
            },
        };
    }
}
```

**Arbitrum Oracle (L1 + L2 fees)**
```javascript
class ArbitrumGasOracle extends ChainGasOracle {
    constructor(chainId, provider) {
        super(chainId, provider);
        this.arbGasInfo = new Contract(
            '0x000000000000000000000000000000000000006C',
            ARB_GAS_INFO_ABI,
            provider
        );
    }

    async estimateTransactionCost(gasLimit, txData) {
        const [perL2Tx, perL1CalldataUnit, , , , perArbGasBase] =
            await this.arbGasInfo.getPricesInWei();

        const l2ExecutionCost = gasLimit * perArbGasBase;
        const l1DataCost = txData.length * perL1CalldataUnit;

        return l2ExecutionCost + l1DataCost + perL2Tx;
    }
}
```

**Base/Optimism Oracle**
```javascript
class OptimismGasOracle extends ChainGasOracle {
    constructor(chainId, provider) {
        super(chainId, provider);
        this.gasPriceOracle = new Contract(
            '0x420000000000000000000000000000000000000F',
            OP_GAS_ORACLE_ABI,
            provider
        );
    }

    async estimateTransactionCost(gasLimit, txData) {
        const l2GasPrice = await this.provider.getGasPrice();
        const l1BaseFee = await this.gasPriceOracle.l1BaseFee();
        const overhead = await this.gasPriceOracle.overhead();
        const scalar = await this.gasPriceOracle.scalar();
        const decimals = await this.gasPriceOracle.decimals();

        const l2Cost = gasLimit * l2GasPrice;
        const l1DataSize = txData.length + overhead;
        const l1Cost = l1DataSize * l1BaseFee * scalar / (10n ** decimals);

        return l2Cost + l1Cost;
    }
}
```

### Phase 2: Dynamic Native Token Pricing

#### 2.1 Price Feed Integration

```javascript
// Proposed: src/data/NativeTokenPricer.js
class NativeTokenPricer {
    constructor() {
        this.prices = new Map();
        this.updateInterval = 60000; // 1 minute
    }

    async updatePrices() {
        // Option 1: Chainlink price feeds
        const feeds = {
            1: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',   // ETH/USD
            56: '0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE',  // BNB/USD
            137: '0xAB594600376Ec9fD91F8e885dADF0CE036862dE0', // MATIC/USD
            43114: '0x0A77230d17318075983913bC2145DB16C7366156', // AVAX/USD
        };

        // Option 2: DEX price from WETH/USDC pools
        // More decentralized, no oracle dependency
    }

    getPriceUSD(chainId) {
        return this.prices.get(chainId) || this._getFallbackPrice(chainId);
    }
}
```

### Phase 3: Accurate Gas Limit Estimation

#### 3.1 Chain-Specific Gas Limits

```javascript
// Proposed: src/config/gasLimits.js
export const gasLimits = {
    ethereum: {
        flashLoanOverhead: 180000n,
        perSwapUniV2: 100000n,
        perSwapUniV3: 150000n,
        perSwapCurve: 200000n,
    },
    bsc: {
        flashLoanOverhead: 150000n,
        perSwapPancakeV2: 100000n,
        perSwapPancakeV3: 140000n,
    },
    arbitrum: {
        flashLoanOverhead: 200000n,  // Higher due to L2 specifics
        perSwapUniV3: 180000n,
        perSwapCamelot: 120000n,
    },
    base: {
        flashLoanOverhead: 180000n,
        perSwapUniV3: 160000n,
        perSwapAerodrome: 130000n,  // Solidly-style
    },
    polygon: {
        flashLoanOverhead: 160000n,
        perSwapQuickswap: 100000n,
        perSwapUniV3: 150000n,
    },
    avalanche: {
        flashLoanOverhead: 160000n,
        perSwapTraderJoe: 110000n,
        perSwapPangolin: 100000n,
    },
};
```

#### 3.2 Historical Gas Usage Tracking

```javascript
// Track actual gas used vs estimated
class GasUsageTracker {
    constructor() {
        this.history = new Map(); // chainId -> { dex -> [actualGas] }
    }

    recordExecution(chainId, dexName, estimatedGas, actualGas) {
        // Store and analyze discrepancies
    }

    getAdjustedEstimate(chainId, dexName, baseEstimate) {
        const history = this.getHistory(chainId, dexName);
        if (history.length < 10) return baseEstimate;

        const avgRatio = history.reduce((sum, h) =>
            sum + (h.actual / h.estimated), 0) / history.length;

        return BigInt(Math.ceil(Number(baseEstimate) * avgRatio));
    }
}
```

### Phase 4: MEV Protection & Priority Fees

#### 4.1 Flashbots Integration (Ethereum)

```javascript
// Proposed: src/execution/FlashbotsExecutor.js
class FlashbotsExecutor {
    constructor(signer, flashbotsProvider) {
        this.signer = signer;
        this.flashbots = flashbotsProvider;
    }

    async executeBundle(transactions) {
        const signedBundle = await this.flashbots.signBundle(
            transactions.map(tx => ({
                signer: this.signer,
                transaction: tx,
            }))
        );

        const simulation = await this.flashbots.simulate(signedBundle, targetBlock);
        if (simulation.error) {
            throw new Error(`Simulation failed: ${simulation.error}`);
        }

        return await this.flashbots.sendBundle(signedBundle, targetBlock);
    }
}
```

#### 4.2 MEV Blocker RPCs

For chains without Flashbots, use MEV-protected RPCs:
- **Polygon**: Fastlane
- **BSC**: BloxRoute
- **Arbitrum**: Sequencer priority (first-come-first-served)

---

## Future Features Roadmap

### Short-Term (1-2 months)

1. **Dynamic Native Token Pricing**
   - Integrate Chainlink or DEX-based price feeds
   - Update prices every block or every minute
   - Cache with staleness checks

2. **Chain-Specific Gas Oracles**
   - Implement EIP-1559 for Ethereum/Polygon
   - Add L1 data fee calculation for L2s
   - Create gas oracle factory

3. **Improved Gas Estimation**
   - Chain-specific base estimates
   - DEX-specific multipliers
   - Historical accuracy tracking

### Medium-Term (3-6 months)

4. **MEV Protection**
   - Flashbots integration for Ethereum
   - Private transaction pools where available
   - Sandwich attack detection and avoidance

5. **Gas Price Prediction**
   - ML-based gas price forecasting
   - Optimal execution timing
   - Block space bidding strategies

6. **Cross-Chain Gas Optimization**
   - Route selection based on gas costs
   - Time-weighted gas averaging
   - Bridge cost integration

### Long-Term (6-12 months)

7. **Account Abstraction (ERC-4337)**
   - Sponsored transactions
   - Batched executions
   - Gas token payments

8. **Intent-Based Execution**
   - Integration with CoW Protocol
   - UniswapX integration
   - 1inch Fusion mode

9. **Real-Time Profitability Adjustment**
   - Streaming gas price updates
   - Dynamic trade size optimization
   - Risk-adjusted profit thresholds

---

## Implementation Priority Matrix

| Feature | Impact | Effort | Priority |
|---------|--------|--------|----------|
| L2 Data Fee Calculation | High | Medium | P0 |
| Dynamic Native Token Pricing | High | Low | P0 |
| EIP-1559 Support | Medium | Low | P1 |
| Chain-Specific Gas Limits | Medium | Low | P1 |
| Historical Gas Tracking | Medium | Medium | P2 |
| Flashbots Integration | High | High | P2 |
| Gas Price Prediction | Medium | High | P3 |
| Account Abstraction | Low | High | P3 |

---

## Configuration Reference

### Current Gas Configuration (per chain config)

```javascript
// src/config/chains/{chain}.js
trading: {
    gasPriceGwei: 5,           // Fallback gas price
    estimatedGasLimit: 350000, // Total gas estimate
},
execution: {
    maxGasPriceGwei: 10,       // Maximum allowed gas price
},
```

### Proposed Enhanced Configuration

```javascript
gas: {
    // Price strategy
    priceStrategy: 'eip1559' | 'legacy' | 'l2',

    // Limits per operation type
    limits: {
        flashLoanBase: 150000,
        perSwap: {
            uniswapV2: 100000,
            uniswapV3: 150000,
            curve: 200000,
        },
    },

    // Pricing bounds
    maxGasPriceGwei: 100,
    maxPriorityFeeGwei: 5,

    // L2 specific
    l2: {
        maxL1DataFeeUSD: 5,    // Max acceptable L1 fee
        dataFeeBuffer: 1.2,    // 20% buffer for L1 fee volatility
    },

    // MEV protection
    mev: {
        useFlashbots: true,    // Ethereum only
        usePrivatePool: true,  // Use MEV-protected RPCs
    },
}
```

---

## Testing Recommendations

### Unit Tests Needed

1. **Gas Oracle Tests**
   - Mock provider responses for each chain
   - Verify correct fee calculation
   - Test fallback behavior

2. **Profit Calculation Tests**
   - Verify L2 fee integration
   - Test with various native token prices
   - Boundary condition testing

3. **Integration Tests**
   - End-to-end profit calculation with real RPC
   - Gas estimation vs actual usage comparison
   - Cross-chain consistency checks

### Test Commands

```bash
# Run gas-related tests
npm test -- --grep "gas"

# Test with specific chain
CHAIN=arbitrum npm test -- --grep "L2 fees"

# Performance benchmarks
npm run benchmark:gas
```

---

*Last Updated: 2026-01-06*
*Version: 1.0.0*
