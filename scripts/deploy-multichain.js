/**
 * Multi-Chain Deployment Script for FlashArbitrage Contract
 *
 * Deploys the FlashArbitrage contract to multiple chains with
 * chain-specific DEX router configurations.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-multichain.js --network <network>
 *
 * Supported networks:
 *   - bsc, bscTestnet
 *   - ethereum, sepolia
 *   - polygon, mumbai
 *   - arbitrum, arbitrumSepolia
 *   - base, baseSepolia
 *
 * Required Environment Variables:
 *   - PRIVATE_KEY: Deployer wallet private key
 *   - <CHAIN>_RPC_URL: RPC endpoint for each chain (optional)
 *   - <CHAIN>SCAN_API_KEY: For contract verification (optional)
 */

const hre = require("hardhat");

// Chain configurations with DEX routers and wrapped native tokens
const CHAIN_CONFIGS = {
  // BSC Mainnet
  bsc: {
    name: "BSC Mainnet",
    chainId: 56,
    nativeToken: "BNB",
    wrappedNative: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", // WBNB
    flashLoanFeeBps: 25, // PancakeSwap: 0.25%
    routers: {
      pancakeswap: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
      biswap: "0x3a6d8CA2b07040D826A7E02798e0964253350dD8",
      apeswap: "0xcF0feBd3f17CEf5b47b0cD257aCf6025c5BFf3b7",
      babyswap: "0x325E343f1dE602396E256B67eFd1F61C3A6B38Bd",
      sushiswap: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
      thena: "0xd4ae6eCA985340Dd434D38F470aCCce4DC78D109",
      nomiswap: "0xD654953D746f0b114d1F85332Dc43446ac79413d",
    },
    explorerUrl: "https://bscscan.com",
  },

  // BSC Testnet
  bscTestnet: {
    name: "BSC Testnet",
    chainId: 97,
    nativeToken: "BNB",
    wrappedNative: "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd", // WBNB Testnet
    flashLoanFeeBps: 25, // PancakeSwap: 0.25%
    routers: {
      pancakeswap: "0xD99D1c33F9fC3444f8101754aBC46c52416550D1",
    },
    explorerUrl: "https://testnet.bscscan.com",
  },

  // Ethereum Mainnet
  ethereum: {
    name: "Ethereum Mainnet",
    chainId: 1,
    nativeToken: "ETH",
    wrappedNative: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
    flashLoanFeeBps: 30, // Uniswap V2: 0.30%
    routers: {
      uniswapV2: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
      uniswapV3: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
      sushiswap: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F",
    },
    explorerUrl: "https://etherscan.io",
  },

  // Sepolia Testnet
  sepolia: {
    name: "Sepolia Testnet",
    chainId: 11155111,
    nativeToken: "ETH",
    wrappedNative: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14", // WETH Sepolia
    flashLoanFeeBps: 30, // Uniswap V2: 0.30%
    routers: {
      uniswapV2: "0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008",
    },
    explorerUrl: "https://sepolia.etherscan.io",
  },

  // Polygon Mainnet
  polygon: {
    name: "Polygon Mainnet",
    chainId: 137,
    nativeToken: "MATIC",
    wrappedNative: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", // WMATIC
    flashLoanFeeBps: 30, // QuickSwap/Uniswap: 0.30%
    routers: {
      quickswap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
      sushiswap: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
      uniswapV3: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
      apeswap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
      dystopia: "0xbE75Dd16D029c6B32B7aD57A0FD9C1c20Dd2862e",
      meshswap: "0x10f4A785F458Bc144e3706575924889954946639",
      jetswap: "0x5C6EC38fb0e2609672BDf628B1fD605A523E5923",
    },
    explorerUrl: "https://polygonscan.com",
  },

  // Mumbai Testnet (Polygon)
  mumbai: {
    name: "Mumbai Testnet",
    chainId: 80001,
    nativeToken: "MATIC",
    wrappedNative: "0x9c3C9283D3e44854697Cd22D3Faa240Cfb032889", // WMATIC Mumbai
    flashLoanFeeBps: 30,
    routers: {
      quickswap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    },
    explorerUrl: "https://mumbai.polygonscan.com",
  },

  // Arbitrum One
  arbitrum: {
    name: "Arbitrum One",
    chainId: 42161,
    nativeToken: "ETH",
    wrappedNative: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", // WETH
    flashLoanFeeBps: 30, // Uniswap: 0.30%
    routers: {
      uniswapV3: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
      sushiswap: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
      camelot: "0xc873fEcbd354f5A56E00E710B90EF4201db2448d",
      traderjoe: "0xbeE5c10Cf6E4F68f831E11C1D9E59B43560B3571",
      ramses: "0xAAA87963EFeB6f7E0a2711F397663105Acb1805e",
      zyberswap: "0x16e71B13fE6079B4312063F7E81F76d165Ad32Ad",
      arbidex: "0x7238FB45146BD8FcB2c463Dc119A53494be57Aac",
    },
    explorerUrl: "https://arbiscan.io",
  },

  // Arbitrum Sepolia Testnet
  arbitrumSepolia: {
    name: "Arbitrum Sepolia",
    chainId: 421614,
    nativeToken: "ETH",
    wrappedNative: "0x980B62Da83eFf3D4576C647993b0c1D7faf17c73", // WETH Arbitrum Sepolia
    flashLoanFeeBps: 30,
    routers: {
      uniswapV3: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
    },
    explorerUrl: "https://sepolia.arbiscan.io",
  },

  // Base Mainnet
  base: {
    name: "Base Mainnet",
    chainId: 8453,
    nativeToken: "ETH",
    wrappedNative: "0x4200000000000000000000000000000000000006", // WETH
    flashLoanFeeBps: 30, // Uniswap: 0.30%
    routers: {
      uniswapV3: "0x2626664c2603336E57B271c5C0b26F421741e481",
      aerodrome: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
      baseswap: "0x327Df1E6de05895d2ab08513aaDD9313Fe505d86",
      sushiswap: "0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891",
      alienbase: "0x8c1A3cF8f83074169FE5D7aD50B978e1cD6b37c7",
      swapbased: "0xaaa3b1F1bd7BCc97fD1917c18ADE665C5D31F066",
      rocketswap: "0x4cf76043B3f97ba06917cBd90F9e3A2AAC1B306e",
      uniswapV2: "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24",
    },
    explorerUrl: "https://basescan.org",
  },

  // Base Sepolia Testnet
  baseSepolia: {
    name: "Base Sepolia",
    chainId: 84532,
    nativeToken: "ETH",
    wrappedNative: "0x4200000000000000000000000000000000000006", // WETH Base Sepolia
    flashLoanFeeBps: 30,
    routers: {
      uniswapV3: "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4",
    },
    explorerUrl: "https://sepolia.basescan.org",
  },
};

async function main() {
  const networkName = hre.network.name;
  const chainConfig = CHAIN_CONFIGS[networkName];

  if (!chainConfig) {
    console.error(`Unsupported network: ${networkName}`);
    console.log("\nSupported networks:");
    Object.entries(CHAIN_CONFIGS).forEach(([name, config]) => {
      console.log(`  - ${name} (${config.name}, chainId: ${config.chainId})`);
    });
    process.exit(1);
  }

  const [deployer] = await hre.ethers.getSigners();
  const balance = await hre.ethers.provider.getBalance(deployer.address);

  console.log("=".repeat(70));
  console.log("FlashArbitrage Multi-Chain Deployment");
  console.log("=".repeat(70));
  console.log(`Network:      ${chainConfig.name} (${networkName})`);
  console.log(`Chain ID:     ${chainConfig.chainId}`);
  console.log(`Deployer:     ${deployer.address}`);
  console.log(`Balance:      ${hre.ethers.formatEther(balance)} ${chainConfig.nativeToken}`);
  console.log(`Explorer:     ${chainConfig.explorerUrl}`);

  if (balance === 0n) {
    throw new Error(`Deployer has no ${chainConfig.nativeToken} for gas fees`);
  }

  // Get router addresses
  const routerAddresses = Object.values(chainConfig.routers);

  console.log(`\nWhitelisting ${routerAddresses.length} DEX routers:`);
  Object.entries(chainConfig.routers).forEach(([name, address]) => {
    console.log(`  - ${name.padEnd(15)} ${address}`);
  });

  console.log(`\nChain-specific configuration:`);
  console.log(`  - Wrapped Native:  ${chainConfig.wrappedNative}`);
  console.log(`  - Flash Loan Fee:  ${chainConfig.flashLoanFeeBps} bps (${chainConfig.flashLoanFeeBps / 100}%)`);

  // Deploy contract with chain-specific parameters
  console.log("\nDeploying FlashArbitrage contract...");
  const startTime = Date.now();

  const FlashArbitrage = await hre.ethers.getContractFactory("FlashArbitrage");
  const flashArbitrage = await FlashArbitrage.deploy(
    routerAddresses,
    chainConfig.wrappedNative,
    chainConfig.flashLoanFeeBps
  );

  await flashArbitrage.waitForDeployment();
  const contractAddress = await flashArbitrage.getAddress();
  const deploymentTime = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log(`\nContract deployed in ${deploymentTime}s`);
  console.log(`Address: ${contractAddress}`);

  // Get deployment transaction
  const deployTx = flashArbitrage.deploymentTransaction();
  if (deployTx) {
    const receipt = await deployTx.wait();
    console.log(`Transaction: ${deployTx.hash}`);
    console.log(`Gas Used: ${receipt.gasUsed.toString()}`);
  }

  // Verify deployment
  console.log("\nVerifying deployment...");
  const owner = await flashArbitrage.owner();
  const paused = await flashArbitrage.paused();
  const wrappedNative = await flashArbitrage.wrappedNative();
  const flashLoanFeeBps = await flashArbitrage.flashLoanFeeBps();

  console.log(`  Owner:           ${owner}`);
  console.log(`  Paused:          ${paused}`);
  console.log(`  Wrapped Native:  ${wrappedNative}`);
  console.log(`  Flash Loan Fee:  ${flashLoanFeeBps} bps`);

  // Verify router whitelist
  console.log("\nVerifying router whitelist:");
  let allWhitelisted = true;
  for (const [name, address] of Object.entries(chainConfig.routers)) {
    const isWhitelisted = await flashArbitrage.isRouterWhitelisted(address);
    const status = isWhitelisted ? "OK" : "FAILED";
    console.log(`  ${name.padEnd(15)} ${status}`);
    if (!isWhitelisted) allWhitelisted = false;
  }

  if (!allWhitelisted) {
    console.warn("\nWARNING: Some routers failed to whitelist!");
  }

  // Output deployment summary
  console.log("\n" + "=".repeat(70));
  console.log("DEPLOYMENT COMPLETE");
  console.log("=".repeat(70));

  const envVarName = networkName.toUpperCase().replace(/-/g, "_");
  console.log(`\nAdd this to your .env file:`);
  console.log(`${envVarName}_FLASH_CONTRACT=${contractAddress}`);

  console.log(`\nView on explorer:`);
  console.log(`${chainConfig.explorerUrl}/address/${contractAddress}`);

  // Attempt contract verification
  const apiKeyEnvVar = getApiKeyEnvVar(networkName);
  if (process.env[apiKeyEnvVar]) {
    console.log("\nVerifying contract on block explorer...");
    try {
      await hre.run("verify:verify", {
        address: contractAddress,
        constructorArguments: [routerAddresses, chainConfig.wrappedNative, chainConfig.flashLoanFeeBps],
      });
      console.log("Contract verified successfully!");
    } catch (error) {
      if (error.message.includes("Already Verified")) {
        console.log("Contract already verified!");
      } else {
        console.log("Verification failed:", error.message);
        console.log("\nManual verification command:");
        console.log(
          `npx hardhat verify --network ${networkName} ${contractAddress} "[${routerAddresses
            .map((r) => `\\"${r}\\"`)
            .join(",")}]"`
        );
      }
    }
  } else {
    console.log(`\nSkipping verification (no ${apiKeyEnvVar} found)`);
    console.log("Manual verification command:");
    console.log(
      `npx hardhat verify --network ${networkName} ${contractAddress} "[${routerAddresses
        .map((r) => `\\"${r}\\"`)
        .join(",")}]"`
    );
  }

  // Save deployment info
  const deploymentInfo = {
    network: networkName,
    chainId: chainConfig.chainId,
    contractAddress,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    routers: chainConfig.routers,
    transactionHash: deployTx?.hash,
  };

  console.log("\nDeployment Info (JSON):");
  console.log(JSON.stringify(deploymentInfo, null, 2));

  return contractAddress;
}

function getApiKeyEnvVar(networkName) {
  const mapping = {
    bsc: "BSCSCAN_API_KEY",
    bscTestnet: "BSCSCAN_API_KEY",
    ethereum: "ETHERSCAN_API_KEY",
    sepolia: "ETHERSCAN_API_KEY",
    polygon: "POLYGONSCAN_API_KEY",
    mumbai: "POLYGONSCAN_API_KEY",
    arbitrum: "ARBISCAN_API_KEY",
    arbitrumSepolia: "ARBISCAN_API_KEY",
    base: "BASESCAN_API_KEY",
    baseSepolia: "BASESCAN_API_KEY",
  };
  return mapping[networkName] || "UNKNOWN_API_KEY";
}

main()
  .then((address) => {
    console.log(`\nDeployment successful: ${address}`);
    process.exit(0);
  })
  .catch((error) => {
    console.error("\nDeployment failed:", error);
    process.exit(1);
  });
