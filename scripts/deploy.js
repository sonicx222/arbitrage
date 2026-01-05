/**
 * Deployment Script for FlashArbitrage Contract
 *
 * Usage:
 *   npm run deploy         # Deploy to BSC mainnet
 *   npm run deploy:testnet # Deploy to BSC testnet
 *
 * Required Environment Variables:
 *   - PRIVATE_KEY: Deployer wallet private key
 *   - BSC_RPC_URL: RPC endpoint (optional, defaults to public)
 *   - BSCSCAN_API_KEY: For contract verification (optional)
 */

const hre = require("hardhat");

// DEX Router addresses on BSC mainnet
const DEX_ROUTERS = {
  pancakeswap: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
  biswap: "0x3a6d8CA2b07040D826A7E02798e0964253350dD8",
  babyswap: "0x325E343f1dE602396E256B67eFd1F61C3A6B38Bd",
  apeswap: "0xcF0feBd3f17CEf5b47b0cD257aCf6025c5BFf3b7",
  mdex: "0x7DAe51BD3E3376B8c7c4900E9107f12Be3AF1bA8",
  knightswap: "0x05E61E0cDcD2170a76F9568a110CEe3AFdD6c46f",
  sushiswap: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
};

// DEX Router addresses on BSC testnet
const DEX_ROUTERS_TESTNET = {
  pancakeswap: "0xD99D1c33F9fC3444f8101754aBC46c52416550D1",
};

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = hre.network.name;
  const isTestnet = network === "bscTestnet";

  console.log("=".repeat(60));
  console.log("FlashArbitrage Contract Deployment");
  console.log("=".repeat(60));
  console.log(`Network: ${network}`);
  console.log(`Deployer: ${deployer.address}`);

  // Get deployer balance
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`Balance: ${hre.ethers.formatEther(balance)} BNB`);

  if (balance === 0n) {
    throw new Error("Deployer has no BNB for gas fees");
  }

  // Select routers based on network
  const routers = isTestnet ? DEX_ROUTERS_TESTNET : DEX_ROUTERS;
  const routerAddresses = Object.values(routers);

  console.log(`\nWhitelisting ${routerAddresses.length} DEX routers:`);
  Object.entries(routers).forEach(([name, address]) => {
    console.log(`  - ${name}: ${address}`);
  });

  // Deploy contract
  console.log("\nDeploying FlashArbitrage contract...");

  const FlashArbitrage = await hre.ethers.getContractFactory("FlashArbitrage");
  const flashArbitrage = await FlashArbitrage.deploy(routerAddresses);

  await flashArbitrage.waitForDeployment();
  const contractAddress = await flashArbitrage.getAddress();

  console.log(`\nContract deployed to: ${contractAddress}`);

  // Verify deployment
  console.log("\nVerifying deployment...");
  const owner = await flashArbitrage.owner();
  const paused = await flashArbitrage.paused();

  console.log(`  Owner: ${owner}`);
  console.log(`  Paused: ${paused}`);

  // Check router whitelist
  console.log("\nVerifying router whitelist:");
  for (const [name, address] of Object.entries(routers)) {
    const isWhitelisted = await flashArbitrage.isRouterWhitelisted(address);
    console.log(`  ${name}: ${isWhitelisted ? "OK" : "FAILED"}`);
  }

  // Output deployment info
  console.log("\n" + "=".repeat(60));
  console.log("DEPLOYMENT COMPLETE");
  console.log("=".repeat(60));
  console.log(`\nAdd this to your .env file:`);
  console.log(`FLASH_CONTRACT_ADDRESS=${contractAddress}`);

  // Verify on BscScan if API key is available
  if (process.env.BSCSCAN_API_KEY && !isTestnet) {
    console.log("\nVerifying contract on BscScan...");
    try {
      await hre.run("verify:verify", {
        address: contractAddress,
        constructorArguments: [routerAddresses],
      });
      console.log("Contract verified on BscScan!");
    } catch (error) {
      console.log("BscScan verification failed:", error.message);
      console.log("You can manually verify later with:");
      console.log(
        `npx hardhat verify --network ${network} ${contractAddress} "${routerAddresses.join('","')}"`
      );
    }
  }

  return contractAddress;
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
