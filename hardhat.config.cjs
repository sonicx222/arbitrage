require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.19",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
    },
  },

  networks: {
    // Local/Testing
    hardhat: {
      forking: {
        url: process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org",
        blockNumber: process.env.FORK_BLOCK_NUMBER
          ? parseInt(process.env.FORK_BLOCK_NUMBER)
          : undefined,
      },
      chainId: 56,
    },

    // BSC Networks
    bsc: {
      url: process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org",
      chainId: 56,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: 3000000000, // 3 gwei
    },
    bscTestnet: {
      url: process.env.BSC_TESTNET_RPC_URL || "https://data-seed-prebsc-1-s1.binance.org:8545",
      chainId: 97,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: 10000000000, // 10 gwei
    },

    // Ethereum Networks
    ethereum: {
      url: process.env.ETH_RPC_URL || process.env.ETH_ALCHEMY_HTTP || "https://eth.llamarpc.com",
      chainId: 1,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "https://rpc.sepolia.org",
      chainId: 11155111,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },

    // Polygon Networks
    polygon: {
      url: process.env.POLYGON_RPC_URL || process.env.POLYGON_ALCHEMY_HTTP || "https://polygon-rpc.com",
      chainId: 137,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: 50000000000, // 50 gwei
    },
    mumbai: {
      url: process.env.MUMBAI_RPC_URL || "https://rpc-mumbai.maticvigil.com",
      chainId: 80001,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },

    // Arbitrum Networks
    arbitrum: {
      url: process.env.ARBITRUM_RPC_URL || process.env.ARBITRUM_ALCHEMY_HTTP || "https://arb1.arbitrum.io/rpc",
      chainId: 42161,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    arbitrumSepolia: {
      url: process.env.ARBITRUM_SEPOLIA_RPC_URL || "https://sepolia-rollup.arbitrum.io/rpc",
      chainId: 421614,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },

    // Base Networks
    base: {
      url: process.env.BASE_RPC_URL || process.env.BASE_ALCHEMY_HTTP || "https://mainnet.base.org",
      chainId: 8453,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      chainId: 84532,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },

  paths: {
    sources: "./contracts",
    tests: "./tests/contract",
    cache: "./cache",
    artifacts: "./artifacts",
  },

  mocha: {
    timeout: 120000, // 2 minutes for forked mainnet tests
  },

  etherscan: {
    apiKey: {
      // BSC
      bsc: process.env.BSCSCAN_API_KEY || "",
      bscTestnet: process.env.BSCSCAN_API_KEY || "",
      // Ethereum
      mainnet: process.env.ETHERSCAN_API_KEY || "",
      sepolia: process.env.ETHERSCAN_API_KEY || "",
      // Polygon
      polygon: process.env.POLYGONSCAN_API_KEY || "",
      polygonMumbai: process.env.POLYGONSCAN_API_KEY || "",
      // Arbitrum
      arbitrumOne: process.env.ARBISCAN_API_KEY || "",
      arbitrumSepolia: process.env.ARBISCAN_API_KEY || "",
      // Base
      base: process.env.BASESCAN_API_KEY || "",
      baseSepolia: process.env.BASESCAN_API_KEY || "",
    },
    customChains: [
      {
        network: "base",
        chainId: 8453,
        urls: {
          apiURL: "https://api.basescan.org/api",
          browserURL: "https://basescan.org",
        },
      },
      {
        network: "baseSepolia",
        chainId: 84532,
        urls: {
          apiURL: "https://api-sepolia.basescan.org/api",
          browserURL: "https://sepolia.basescan.org",
        },
      },
    ],
  },
};
