/**
 * FlashArbitrage Contract Tests
 *
 * Tests the flash arbitrage smart contract functionality using Hardhat
 * with a forked BSC mainnet for realistic testing.
 *
 * Run with: RUN_HARDHAT_TESTS=true npx hardhat test tests/contract/FlashArbitrage.test.cjs
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");

// Skip tests unless explicitly enabled
const SKIP_HARDHAT_TESTS = !process.env.RUN_HARDHAT_TESTS;

// BSC Mainnet addresses
const ADDRESSES = {
    WBNB: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    USDT: "0x55d398326f99059fF775485246999027B3197955",
    BUSD: "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56",
    CAKE: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82",

    // DEX Routers
    PANCAKESWAP_ROUTER: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
    BISWAP_ROUTER: "0x3a6d8CA2b07040D826A7E02798e0964253350dD8",
    APESWAP_ROUTER: "0xcF0feBd3f17CEf5b47b0cD257aCf6025c5BFf3b7",

    // PancakeSwap Factory
    PANCAKESWAP_FACTORY: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73",

    // Common pairs
    WBNB_USDT_PAIR: "0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE",
    WBNB_BUSD_PAIR: "0x58F876857a02D6762E0101bb5C46A8c1ED44Dc16",
};

// Chain-specific configuration for BSC
const CHAIN_CONFIG = {
    wrappedNative: ADDRESSES.WBNB,
    flashLoanFeeBps: 25, // PancakeSwap: 0.25%
};

// Helper to get pair address from factory
async function getPairAddress(factory, token0, token1) {
    const factoryContract = await ethers.getContractAt(
        ["function getPair(address, address) view returns (address)"],
        factory
    );
    return factoryContract.getPair(token0, token1);
}

// Helper to impersonate account and fund with BNB
async function impersonateAndFund(address, bnbAmount = "10") {
    await ethers.provider.send("hardhat_impersonateAccount", [address]);
    const signer = await ethers.getSigner(address);

    // Fund with BNB for gas
    const [funder] = await ethers.getSigners();
    await funder.sendTransaction({
        to: address,
        value: ethers.parseEther(bnbAmount),
    });

    return signer;
}

describe("FlashArbitrage Contract", function () {
    // Skip all tests if not explicitly enabled
    before(function () {
        if (SKIP_HARDHAT_TESTS) {
            console.log("Skipping Hardhat tests. Set RUN_HARDHAT_TESTS=true to run.");
            this.skip();
        }
    });

    let flashArbitrage;
    let owner;
    let otherAccount;

    const ROUTERS = [
        ADDRESSES.PANCAKESWAP_ROUTER,
        ADDRESSES.BISWAP_ROUTER,
        ADDRESSES.APESWAP_ROUTER,
    ];

    beforeEach(async function () {
        if (SKIP_HARDHAT_TESTS) this.skip();

        [owner, otherAccount] = await ethers.getSigners();

        // Deploy contract with chain-specific configuration
        const FlashArbitrage = await ethers.getContractFactory("FlashArbitrage");
        flashArbitrage = await FlashArbitrage.deploy(
            ROUTERS,
            CHAIN_CONFIG.wrappedNative,
            CHAIN_CONFIG.flashLoanFeeBps
        );
        await flashArbitrage.waitForDeployment();
    });

    describe("Deployment", function () {
        it("should set the correct owner", async function () {
            expect(await flashArbitrage.owner()).to.equal(owner.address);
        });

        it("should whitelist initial routers", async function () {
            for (const router of ROUTERS) {
                expect(await flashArbitrage.isRouterWhitelisted(router)).to.be.true;
            }
        });

        it("should not be paused initially", async function () {
            expect(await flashArbitrage.paused()).to.be.false;
        });

        it("should have correct wrapped native address", async function () {
            expect(await flashArbitrage.wrappedNative()).to.equal(CHAIN_CONFIG.wrappedNative);
            // WBNB() should return same value for backward compatibility
            expect(await flashArbitrage.WBNB()).to.equal(CHAIN_CONFIG.wrappedNative);
        });

        it("should have correct flash loan fee", async function () {
            expect(await flashArbitrage.flashLoanFeeBps()).to.equal(CHAIN_CONFIG.flashLoanFeeBps);
        });

        it("should have correct MIN_PROFIT_WEI", async function () {
            expect(await flashArbitrage.MIN_PROFIT_WEI()).to.equal(ethers.parseEther("0.001"));
        });
    });

    describe("Router Whitelist Management", function () {
        it("should allow owner to whitelist new router", async function () {
            const newRouter = "0x1234567890123456789012345678901234567890";

            await expect(flashArbitrage.setRouterWhitelist(newRouter, true))
                .to.emit(flashArbitrage, "RouterWhitelisted")
                .withArgs(newRouter, true);

            expect(await flashArbitrage.isRouterWhitelisted(newRouter)).to.be.true;
        });

        it("should allow owner to remove router from whitelist", async function () {
            await flashArbitrage.setRouterWhitelist(ADDRESSES.PANCAKESWAP_ROUTER, false);
            expect(await flashArbitrage.isRouterWhitelisted(ADDRESSES.PANCAKESWAP_ROUTER)).to.be.false;
        });

        it("should allow batch whitelist updates", async function () {
            const routers = [
                "0x1111111111111111111111111111111111111111",
                "0x2222222222222222222222222222222222222222",
            ];
            const statuses = [true, true];

            await flashArbitrage.batchSetRouterWhitelist(routers, statuses);

            expect(await flashArbitrage.isRouterWhitelisted(routers[0])).to.be.true;
            expect(await flashArbitrage.isRouterWhitelisted(routers[1])).to.be.true;
        });

        it("should reject batch whitelist with mismatched lengths", async function () {
            const routers = ["0x1111111111111111111111111111111111111111"];
            const statuses = [true, false];

            await expect(
                flashArbitrage.batchSetRouterWhitelist(routers, statuses)
            ).to.be.revertedWith("Length mismatch");
        });

        it("should reject non-owner whitelist changes", async function () {
            await expect(
                flashArbitrage.connect(otherAccount).setRouterWhitelist(
                    "0x1234567890123456789012345678901234567890",
                    true
                )
            ).to.be.revertedWithCustomError(flashArbitrage, "Unauthorized");
        });
    });

    describe("Pause Functionality", function () {
        it("should allow owner to pause", async function () {
            await expect(flashArbitrage.setPaused(true))
                .to.emit(flashArbitrage, "Paused")
                .withArgs(true);

            expect(await flashArbitrage.paused()).to.be.true;
        });

        it("should allow owner to unpause", async function () {
            await flashArbitrage.setPaused(true);
            await flashArbitrage.setPaused(false);
            expect(await flashArbitrage.paused()).to.be.false;
        });

        it("should reject non-owner pause", async function () {
            await expect(
                flashArbitrage.connect(otherAccount).setPaused(true)
            ).to.be.revertedWithCustomError(flashArbitrage, "Unauthorized");
        });
    });

    describe("Emergency Withdraw", function () {
        it("should withdraw BNB to owner", async function () {
            // Send some BNB to the contract
            await owner.sendTransaction({
                to: await flashArbitrage.getAddress(),
                value: ethers.parseEther("1"),
            });

            const ownerBalanceBefore = await ethers.provider.getBalance(owner.address);

            await expect(flashArbitrage.emergencyWithdraw(ethers.ZeroAddress))
                .to.emit(flashArbitrage, "EmergencyWithdraw");

            const ownerBalanceAfter = await ethers.provider.getBalance(owner.address);
            expect(ownerBalanceAfter).to.be.gt(ownerBalanceBefore);
        });

        it("should reject non-owner emergency withdraw", async function () {
            await expect(
                flashArbitrage.connect(otherAccount).emergencyWithdraw(ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(flashArbitrage, "Unauthorized");
        });
    });

    describe("Cross-DEX Arbitrage Validation", function () {
        it("should reject zero borrow amount", async function () {
            await expect(
                flashArbitrage.executeCrossDexArbitrage(
                    ADDRESSES.WBNB_USDT_PAIR,
                    0, // Zero amount
                    ADDRESSES.WBNB,
                    [ADDRESSES.WBNB, ADDRESSES.USDT, ADDRESSES.WBNB],
                    [ADDRESSES.PANCAKESWAP_ROUTER, ADDRESSES.BISWAP_ROUTER],
                    0
                )
            ).to.be.revertedWithCustomError(flashArbitrage, "ZeroAmount");
        });

        it("should reject invalid path length", async function () {
            await expect(
                flashArbitrage.executeCrossDexArbitrage(
                    ADDRESSES.WBNB_USDT_PAIR,
                    ethers.parseEther("1"),
                    ADDRESSES.WBNB,
                    [ADDRESSES.WBNB], // Too short
                    [],
                    0
                )
            ).to.be.revertedWithCustomError(flashArbitrage, "InvalidPath");
        });

        it("should reject path that doesn't start with borrow token", async function () {
            await expect(
                flashArbitrage.executeCrossDexArbitrage(
                    ADDRESSES.WBNB_USDT_PAIR,
                    ethers.parseEther("1"),
                    ADDRESSES.WBNB,
                    [ADDRESSES.USDT, ADDRESSES.BUSD, ADDRESSES.USDT], // Starts with USDT, not WBNB
                    [ADDRESSES.PANCAKESWAP_ROUTER, ADDRESSES.BISWAP_ROUTER],
                    0
                )
            ).to.be.revertedWithCustomError(flashArbitrage, "InvalidPath");
        });

        it("should reject path that doesn't end with borrow token", async function () {
            await expect(
                flashArbitrage.executeCrossDexArbitrage(
                    ADDRESSES.WBNB_USDT_PAIR,
                    ethers.parseEther("1"),
                    ADDRESSES.WBNB,
                    [ADDRESSES.WBNB, ADDRESSES.USDT, ADDRESSES.BUSD], // Ends with BUSD, not WBNB
                    [ADDRESSES.PANCAKESWAP_ROUTER, ADDRESSES.BISWAP_ROUTER],
                    0
                )
            ).to.be.revertedWithCustomError(flashArbitrage, "InvalidPath");
        });

        it("should reject mismatched routers and path", async function () {
            await expect(
                flashArbitrage.executeCrossDexArbitrage(
                    ADDRESSES.WBNB_USDT_PAIR,
                    ethers.parseEther("1"),
                    ADDRESSES.WBNB,
                    [ADDRESSES.WBNB, ADDRESSES.USDT, ADDRESSES.WBNB],
                    [ADDRESSES.PANCAKESWAP_ROUTER], // Only 1 router for 2 swaps
                    0
                )
            ).to.be.revertedWithCustomError(flashArbitrage, "InvalidPath");
        });

        it("should reject non-whitelisted router", async function () {
            const badRouter = "0x1234567890123456789012345678901234567890";

            await expect(
                flashArbitrage.executeCrossDexArbitrage(
                    ADDRESSES.WBNB_USDT_PAIR,
                    ethers.parseEther("1"),
                    ADDRESSES.WBNB,
                    [ADDRESSES.WBNB, ADDRESSES.USDT, ADDRESSES.WBNB],
                    [ADDRESSES.PANCAKESWAP_ROUTER, badRouter],
                    0
                )
            ).to.be.revertedWithCustomError(flashArbitrage, "RouterNotWhitelisted");
        });

        it("should reject when paused", async function () {
            await flashArbitrage.setPaused(true);

            await expect(
                flashArbitrage.executeCrossDexArbitrage(
                    ADDRESSES.WBNB_USDT_PAIR,
                    ethers.parseEther("1"),
                    ADDRESSES.WBNB,
                    [ADDRESSES.WBNB, ADDRESSES.USDT, ADDRESSES.WBNB],
                    [ADDRESSES.PANCAKESWAP_ROUTER, ADDRESSES.BISWAP_ROUTER],
                    0
                )
            ).to.be.revertedWithCustomError(flashArbitrage, "ContractPaused");
        });

        it("should reject non-owner execution", async function () {
            await expect(
                flashArbitrage.connect(otherAccount).executeCrossDexArbitrage(
                    ADDRESSES.WBNB_USDT_PAIR,
                    ethers.parseEther("1"),
                    ADDRESSES.WBNB,
                    [ADDRESSES.WBNB, ADDRESSES.USDT, ADDRESSES.WBNB],
                    [ADDRESSES.PANCAKESWAP_ROUTER, ADDRESSES.BISWAP_ROUTER],
                    0
                )
            ).to.be.revertedWithCustomError(flashArbitrage, "Unauthorized");
        });
    });

    describe("Triangular Arbitrage Validation", function () {
        it("should reject invalid triangular path length", async function () {
            await expect(
                flashArbitrage.executeTriangularArbitrage(
                    ADDRESSES.WBNB_USDT_PAIR,
                    ethers.parseEther("1"),
                    ADDRESSES.WBNB,
                    [ADDRESSES.WBNB, ADDRESSES.USDT, ADDRESSES.WBNB], // Only 3 tokens
                    ADDRESSES.PANCAKESWAP_ROUTER,
                    0
                )
            ).to.be.revertedWithCustomError(flashArbitrage, "InvalidPath");
        });

        it("should reject triangular path not starting with borrow token", async function () {
            await expect(
                flashArbitrage.executeTriangularArbitrage(
                    ADDRESSES.WBNB_USDT_PAIR,
                    ethers.parseEther("1"),
                    ADDRESSES.WBNB,
                    [ADDRESSES.USDT, ADDRESSES.BUSD, ADDRESSES.CAKE, ADDRESSES.USDT],
                    ADDRESSES.PANCAKESWAP_ROUTER,
                    0
                )
            ).to.be.revertedWithCustomError(flashArbitrage, "InvalidPath");
        });

        it("should reject triangular path not ending with borrow token", async function () {
            await expect(
                flashArbitrage.executeTriangularArbitrage(
                    ADDRESSES.WBNB_USDT_PAIR,
                    ethers.parseEther("1"),
                    ADDRESSES.WBNB,
                    [ADDRESSES.WBNB, ADDRESSES.USDT, ADDRESSES.BUSD, ADDRESSES.CAKE],
                    ADDRESSES.PANCAKESWAP_ROUTER,
                    0
                )
            ).to.be.revertedWithCustomError(flashArbitrage, "InvalidPath");
        });

        it("should reject non-whitelisted router for triangular", async function () {
            const badRouter = "0x1234567890123456789012345678901234567890";

            await expect(
                flashArbitrage.executeTriangularArbitrage(
                    ADDRESSES.WBNB_USDT_PAIR,
                    ethers.parseEther("1"),
                    ADDRESSES.WBNB,
                    [ADDRESSES.WBNB, ADDRESSES.USDT, ADDRESSES.BUSD, ADDRESSES.WBNB],
                    badRouter,
                    0
                )
            ).to.be.revertedWithCustomError(flashArbitrage, "RouterNotWhitelisted");
        });
    });

    describe("Simulate Arbitrage", function () {
        it("should return simulation results", async function () {
            const path = [ADDRESSES.WBNB, ADDRESSES.USDT, ADDRESSES.WBNB];
            const routers = [ADDRESSES.PANCAKESWAP_ROUTER, ADDRESSES.PANCAKESWAP_ROUTER];
            const amountIn = ethers.parseEther("1");

            const [expectedOut, flashFee, netProfit] = await flashArbitrage.simulateArbitrage(
                path,
                routers,
                amountIn
            );

            // Should return meaningful values
            expect(expectedOut).to.be.gt(0);
            expect(flashFee).to.be.gt(0);
            // Net profit will likely be negative due to fees
            console.log(`Simulation: Out=${ethers.formatEther(expectedOut)}, Fee=${ethers.formatEther(flashFee)}, Profit=${ethers.formatEther(netProfit)}`);
        });
    });

    describe("Receive BNB", function () {
        it("should accept BNB transfers", async function () {
            const contractAddress = await flashArbitrage.getAddress();

            await owner.sendTransaction({
                to: contractAddress,
                value: ethers.parseEther("1"),
            });

            const balance = await ethers.provider.getBalance(contractAddress);
            expect(balance).to.equal(ethers.parseEther("1"));
        });
    });
});

// Integration tests that require forked mainnet
describe("FlashArbitrage Integration Tests", function () {
    before(function () {
        if (SKIP_HARDHAT_TESTS) {
            console.log("Skipping integration tests. Set RUN_HARDHAT_TESTS=true to run.");
            this.skip();
        }
    });

    let flashArbitrage;
    let owner;

    const ROUTERS = [
        ADDRESSES.PANCAKESWAP_ROUTER,
        ADDRESSES.BISWAP_ROUTER,
    ];

    beforeEach(async function () {
        if (SKIP_HARDHAT_TESTS) this.skip();

        [owner] = await ethers.getSigners();

        const FlashArbitrage = await ethers.getContractFactory("FlashArbitrage");
        flashArbitrage = await FlashArbitrage.deploy(
            ROUTERS,
            CHAIN_CONFIG.wrappedNative,
            CHAIN_CONFIG.flashLoanFeeBps
        );
        await flashArbitrage.waitForDeployment();
    });

    describe("Flash Swap Execution", function () {
        it("should revert with InsufficientProfit for unprofitable trade", async function () {
            // This test attempts a real flash swap that won't be profitable
            // It should revert in the callback when profit validation fails

            const borrowAmount = ethers.parseEther("10");
            const minProfit = ethers.parseEther("1"); // Require 1 WBNB profit (unrealistic)

            // Attempting a round-trip swap that will have fees eating into profit
            await expect(
                flashArbitrage.executeCrossDexArbitrage(
                    ADDRESSES.WBNB_USDT_PAIR,
                    borrowAmount,
                    ADDRESSES.WBNB,
                    [ADDRESSES.WBNB, ADDRESSES.USDT, ADDRESSES.WBNB],
                    [ADDRESSES.PANCAKESWAP_ROUTER, ADDRESSES.PANCAKESWAP_ROUTER],
                    minProfit
                )
            ).to.be.reverted; // Will revert with InsufficientProfit or similar
        });

        it("should execute successful arbitrage when profitable", async function () {
            // This test would require finding an actual arbitrage opportunity
            // which is rare in a static fork. Skipping for now.
            this.skip();
        });
    });
});
