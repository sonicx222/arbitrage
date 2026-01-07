# FlashArbitrage Contract Deployment Guide

This guide covers deploying the FlashArbitrage smart contract to various blockchain networks.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Environment Setup](#environment-setup)
3. [Supported Networks](#supported-networks)
4. [Testnet Deployment](#testnet-deployment)
5. [Mainnet Deployment](#mainnet-deployment)
6. [Post-Deployment](#post-deployment)
7. [Contract Verification](#contract-verification)
8. [Troubleshooting](#troubleshooting)

---

## Prerequisites

### Required Software

- Node.js v18+ (v20 LTS recommended)
- npm or yarn
- Git

### Required Funds

Each network requires native tokens for gas:

| Network | Token | Testnet Faucet |
|---------|-------|----------------|
| BSC Testnet | tBNB | https://testnet.bnbchain.org/faucet-smart |
| Sepolia | SepoliaETH | https://sepoliafaucet.com |
| Mumbai | MATIC | https://faucet.polygon.technology |
| Arbitrum Sepolia | ETH | https://faucet.quicknode.com/arbitrum/sepolia |
| Base Sepolia | ETH | https://faucet.quicknode.com/base/sepolia |

### Estimated Deployment Costs

| Network | Estimated Gas | Approximate Cost |
|---------|--------------|------------------|
| BSC | ~2.5M gas | ~0.008 BNB ($2-3) |
| Ethereum | ~2.5M gas | ~0.075 ETH ($250+) |
| Polygon | ~2.5M gas | ~0.15 MATIC ($0.10) |
| Arbitrum | ~2.5M gas | ~0.0003 ETH ($1) |
| Base | ~2.5M gas | ~0.0003 ETH ($1) |

---

## Environment Setup

### 1. Clone and Install

```bash
git clone <repository-url>
cd arbitrage
npm install
```

### 2. Configure Environment Variables

Create or update your `.env` file:

```bash
# Required: Deployer private key (without 0x prefix)
PRIVATE_KEY=your_private_key_here

# Optional: RPC URLs (defaults to public RPCs)
BSC_RPC_URL=https://bsc-dataseed.binance.org
ETH_RPC_URL=https://eth.llamarpc.com
POLYGON_RPC_URL=https://polygon-rpc.com
ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc
BASE_RPC_URL=https://mainnet.base.org

# Optional: Block explorer API keys (for verification)
BSCSCAN_API_KEY=your_bscscan_api_key
ETHERSCAN_API_KEY=your_etherscan_api_key
POLYGONSCAN_API_KEY=your_polygonscan_api_key
ARBISCAN_API_KEY=your_arbiscan_api_key
BASESCAN_API_KEY=your_basescan_api_key
```

### 3. Compile Contracts

```bash
npx hardhat compile
```

Expected output:
```
Compiled 1 Solidity file successfully
```

---

## Supported Networks

### Testnets

| Network | Chain ID | Command |
|---------|----------|---------|
| BSC Testnet | 97 | `--network bscTestnet` |
| Sepolia | 11155111 | `--network sepolia` |
| Mumbai | 80001 | `--network mumbai` |
| Arbitrum Sepolia | 421614 | `--network arbitrumSepolia` |
| Base Sepolia | 84532 | `--network baseSepolia` |

### Mainnets

| Network | Chain ID | Command |
|---------|----------|---------|
| BSC | 56 | `--network bsc` |
| Ethereum | 1 | `--network ethereum` |
| Polygon | 137 | `--network polygon` |
| Arbitrum | 42161 | `--network arbitrum` |
| Base | 8453 | `--network base` |

---

## Testnet Deployment

### Step 1: Get Testnet Tokens

Use the faucets listed in [Prerequisites](#prerequisites) to fund your deployer wallet.

### Step 2: Deploy to Testnet

**BSC Testnet (Recommended for first deployment):**
```bash
npx hardhat run scripts/deploy-multichain.js --network bscTestnet
```

**Alternative testnets:**
```bash
# Sepolia (Ethereum testnet)
npx hardhat run scripts/deploy-multichain.js --network sepolia

# Base Sepolia
npx hardhat run scripts/deploy-multichain.js --network baseSepolia

# Arbitrum Sepolia
npx hardhat run scripts/deploy-multichain.js --network arbitrumSepolia
```

### Step 3: Verify Deployment

The deployment script outputs:
- Contract address
- Transaction hash
- Router whitelist verification
- Environment variable to add

Example output:
```
======================================================================
FlashArbitrage Multi-Chain Deployment
======================================================================
Network:      BSC Testnet (bscTestnet)
Chain ID:     97
Deployer:     0x1234...5678
Balance:      0.5 BNB

Whitelisting 1 DEX routers:
  - pancakeswap     0xD99D1c33F9fC3444f8101754aBC46c52416550D1

Deploying FlashArbitrage contract...

Contract deployed in 15.23s
Address: 0xABCD...EF01

======================================================================
DEPLOYMENT COMPLETE
======================================================================

Add this to your .env file:
BSCTESTNET_FLASH_CONTRACT=0xABCD...EF01

View on explorer:
https://testnet.bscscan.com/address/0xABCD...EF01
```

### Step 4: Test the Contract

Run the Hardhat tests against your deployed contract:
```bash
# Set the contract address
export FLASH_CONTRACT_ADDRESS=0xABCD...EF01

# Run tests
RUN_HARDHAT_TESTS=true npx hardhat test tests/contract/FlashArbitrage.test.cjs --network bscTestnet
```

---

## Mainnet Deployment

> **WARNING**: Mainnet deployment uses real funds. Double-check everything!

### Pre-Deployment Checklist

- [ ] Contract has been tested on testnet
- [ ] Deployer wallet has sufficient native tokens
- [ ] Private key is secure and not exposed
- [ ] RPC URL is reliable (consider using Alchemy/Infura)
- [ ] Gas prices are reasonable for the network

### Deploy to Mainnet

```bash
# BSC Mainnet (lowest gas cost)
npx hardhat run scripts/deploy-multichain.js --network bsc

# Polygon Mainnet (low gas cost)
npx hardhat run scripts/deploy-multichain.js --network polygon

# Arbitrum One (low gas cost)
npx hardhat run scripts/deploy-multichain.js --network arbitrum

# Base Mainnet (low gas cost)
npx hardhat run scripts/deploy-multichain.js --network base

# Ethereum Mainnet (high gas cost - deploy last)
npx hardhat run scripts/deploy-multichain.js --network ethereum
```

### Recommended Deployment Order

1. **BSC** - Lowest gas, most liquidity
2. **Polygon** - Low gas, good liquidity
3. **Arbitrum** - Low gas, growing DeFi ecosystem
4. **Base** - Low gas, new ecosystem
5. **Ethereum** - High gas, only if necessary

---

## Post-Deployment

### 1. Update Environment Variables

Add the deployed contract addresses to your `.env`:
```bash
BSC_FLASH_CONTRACT=0x...
POLYGON_FLASH_CONTRACT=0x...
ARBITRUM_FLASH_CONTRACT=0x...
BASE_FLASH_CONTRACT=0x...
```

### 2. Fund the Contract (Optional)

For non-flash-loan operations, you may need to fund the contract:
```bash
# Using cast (foundry)
cast send $CONTRACT_ADDRESS --value 0.1ether --rpc-url $RPC_URL --private-key $PRIVATE_KEY
```

### 3. Configure Additional Routers

If you need to whitelist additional DEX routers:
```javascript
// Using ethers.js
const flashArbitrage = await ethers.getContractAt("FlashArbitrage", contractAddress);
await flashArbitrage.setRouterWhitelist("0xNewRouter...", true);
```

### 4. Enable in Bot Configuration

Update your chain configuration to use the deployed contract:
```javascript
// src/config/chains/bsc.js
execution: {
    enabled: true,
    mode: 'live', // or 'simulation'
    contractAddress: process.env.BSC_FLASH_CONTRACT,
    // ...
}
```

---

## Contract Verification

### Automatic Verification

If you have the block explorer API key set, verification happens automatically during deployment.

### Manual Verification

If automatic verification fails:

```bash
# BSC
npx hardhat verify --network bsc $CONTRACT_ADDRESS "[\"0xRouter1\",\"0xRouter2\",...]"

# Polygon
npx hardhat verify --network polygon $CONTRACT_ADDRESS "[\"0xRouter1\",\"0xRouter2\",...]"

# Arbitrum
npx hardhat verify --network arbitrum $CONTRACT_ADDRESS "[\"0xRouter1\",\"0xRouter2\",...]"
```

### Get Constructor Arguments

The deployment script outputs the router addresses. You can also query them:
```bash
# Using cast
cast call $CONTRACT_ADDRESS "isRouterWhitelisted(address)(bool)" $ROUTER_ADDRESS
```

---

## Troubleshooting

### Common Issues

#### "Insufficient funds"
- Check your wallet balance on the target network
- Ensure you're using the correct network

#### "Nonce too low"
- Wait for pending transactions to confirm
- Or reset your account nonce in MetaMask

#### "Gas estimation failed"
- The constructor might be reverting
- Check that router addresses are valid

#### "Contract already verified"
- This is not an error - the contract is already verified

#### "Compiler version mismatch"
- Ensure `hardhat.config.cjs` specifies `0.8.19`
- Run `npx hardhat clean` and recompile

### Network-Specific Issues

#### BSC
- Use 3-5 gwei gas price
- Public RPCs may rate-limit

#### Ethereum
- Gas prices fluctuate significantly
- Use https://etherscan.io/gastracker to check prices

#### Polygon
- May require higher gas price during congestion
- Mumbai testnet can be unstable

#### Arbitrum/Base
- Gas prices are very low
- Block times are fast, don't spam transactions

---

## Security Considerations

1. **Private Key Safety**
   - Never commit `.env` to version control
   - Use hardware wallets for mainnet deployments
   - Consider using a fresh deployer wallet

2. **Contract Ownership**
   - The deployer becomes the contract owner
   - Only the owner can pause/unpause
   - Only the owner can withdraw funds

3. **Router Whitelisting**
   - Only whitelist trusted DEX routers
   - Malicious routers could drain funds
   - Verify router addresses on block explorers

4. **Profit Minimums**
   - The contract enforces MIN_PROFIT_WEI (0.001 WBNB)
   - This prevents unprofitable transactions
   - Adjust via contract upgrade if needed

---

## Quick Reference

```bash
# Compile
npx hardhat compile

# Deploy to testnet
npx hardhat run scripts/deploy-multichain.js --network bscTestnet

# Deploy to mainnet
npx hardhat run scripts/deploy-multichain.js --network bsc

# Run tests
RUN_HARDHAT_TESTS=true npx hardhat test tests/contract/FlashArbitrage.test.cjs

# Verify contract
npx hardhat verify --network bsc $CONTRACT_ADDRESS "[...]"

# Check network config
npx hardhat accounts --network bsc
```

---

*Last updated: 2026-01-07*
