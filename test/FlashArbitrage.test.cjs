/**
 * FlashArbitrage Smart Contract Tests
 *
 * Run with: npx hardhat test test/FlashArbitrage.test.cjs
 *
 * These tests use Hardhat's mainnet fork to test the contract
 * against real BSC mainnet state.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("FlashArbitrage Contract", function () {
    let flashArbitrage;
    let owner;
    let addr1;

    // BSC Mainnet addresses
    const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
    const BUSD = "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56";
    const USDT = "0x55d398326f99059fF775485246999027B3197955";

    // DEX Routers
    const PANCAKE_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
    const BISWAP_ROUTER = "0x3a6d8cA2b07040D826A7E02798e0964253350dD8";
    const APESWAP_ROUTER = "0xcF0feBd3f17CEf5b47b0cD257aCf6025c5BFf3b7";

    // PancakeSwap pairs
    const WBNB_BUSD_PAIR = "0x58F876857a02D6762E0101bb5C46A8c1ED44Dc16";
    const WBNB_USDT_PAIR = "0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE";

    beforeEach(async function () {
        [owner, addr1] = await ethers.getSigners();

        const FlashArbitrage = await ethers.getContractFactory("FlashArbitrage");
        flashArbitrage = await FlashArbitrage.deploy(WBNB);
        await flashArbitrage.waitForDeployment();
    });

    describe("Deployment", function () {
        it("Should set the right owner", async function () {
            expect(await flashArbitrage.owner()).to.equal(owner.address);
        });

        it("Should set the WBNB address correctly", async function () {
            expect(await flashArbitrage.WBNB()).to.equal(WBNB);
        });

        it("Should not be paused initially", async function () {
            expect(await flashArbitrage.paused()).to.equal(false);
        });

        it("Should have zero pending profit initially", async function () {
            expect(await flashArbitrage.pendingProfit()).to.equal(0);
        });
    });

    describe("Router Whitelist Management", function () {
        it("Should whitelist a router successfully", async function () {
            await flashArbitrage.setRouterWhitelist(PANCAKE_ROUTER, true);
            expect(await flashArbitrage.whitelistedRouters(PANCAKE_ROUTER)).to.equal(true);
        });

        it("Should whitelist multiple routers", async function () {
            await flashArbitrage.setRouterWhitelist(PANCAKE_ROUTER, true);
            await flashArbitrage.setRouterWhitelist(BISWAP_ROUTER, true);
            await flashArbitrage.setRouterWhitelist(APESWAP_ROUTER, true);

            expect(await flashArbitrage.whitelistedRouters(PANCAKE_ROUTER)).to.equal(true);
            expect(await flashArbitrage.whitelistedRouters(BISWAP_ROUTER)).to.equal(true);
            expect(await flashArbitrage.whitelistedRouters(APESWAP_ROUTER)).to.equal(true);
        });

        it("Should remove a router from whitelist", async function () {
            await flashArbitrage.setRouterWhitelist(PANCAKE_ROUTER, true);
            expect(await flashArbitrage.whitelistedRouters(PANCAKE_ROUTER)).to.equal(true);

            await flashArbitrage.setRouterWhitelist(PANCAKE_ROUTER, false);
            expect(await flashArbitrage.whitelistedRouters(PANCAKE_ROUTER)).to.equal(false);
        });

        it("Should revert if non-owner tries to whitelist", async function () {
            await expect(
                flashArbitrage.connect(addr1).setRouterWhitelist(PANCAKE_ROUTER, true)
            ).to.be.revertedWith("OnlyOwner");
        });

        it("Should emit event on whitelist change", async function () {
            await expect(flashArbitrage.setRouterWhitelist(PANCAKE_ROUTER, true))
                .to.emit(flashArbitrage, "RouterWhitelistUpdated")
                .withArgs(PANCAKE_ROUTER, true);
        });
    });

    describe("Pause Functionality", function () {
        it("Should pause the contract", async function () {
            await flashArbitrage.setPaused(true);
            expect(await flashArbitrage.paused()).to.equal(true);
        });

        it("Should unpause the contract", async function () {
            await flashArbitrage.setPaused(true);
            await flashArbitrage.setPaused(false);
            expect(await flashArbitrage.paused()).to.equal(false);
        });

        it("Should emit event on pause state change", async function () {
            await expect(flashArbitrage.setPaused(true))
                .to.emit(flashArbitrage, "PauseStateChanged")
                .withArgs(true);
        });

        it("Should revert if non-owner tries to pause", async function () {
            await expect(
                flashArbitrage.connect(addr1).setPaused(true)
            ).to.be.revertedWith("OnlyOwner");
        });
    });

    describe("Access Control for Arbitrage Execution", function () {
        beforeEach(async function () {
            // Whitelist routers for these tests
            await flashArbitrage.setRouterWhitelist(PANCAKE_ROUTER, true);
            await flashArbitrage.setRouterWhitelist(BISWAP_ROUTER, true);
        });

        it("Should revert if non-owner tries to execute cross-dex arbitrage", async function () {
            await expect(
                flashArbitrage.connect(addr1).executeCrossDexArbitrage(
                    WBNB_BUSD_PAIR,
                    ethers.parseEther("1"),
                    WBNB,
                    [WBNB, BUSD],
                    [PANCAKE_ROUTER, BISWAP_ROUTER],
                    0
                )
            ).to.be.revertedWith("OnlyOwner");
        });

        it("Should revert if non-owner tries to execute triangular arbitrage", async function () {
            await expect(
                flashArbitrage.connect(addr1).executeTriangularArbitrage(
                    WBNB_BUSD_PAIR,
                    ethers.parseEther("1"),
                    WBNB,
                    [WBNB, BUSD, USDT, WBNB],
                    PANCAKE_ROUTER,
                    0
                )
            ).to.be.revertedWith("OnlyOwner");
        });

        it("Should revert execution when paused", async function () {
            await flashArbitrage.setPaused(true);

            await expect(
                flashArbitrage.executeCrossDexArbitrage(
                    WBNB_BUSD_PAIR,
                    ethers.parseEther("1"),
                    WBNB,
                    [WBNB, BUSD],
                    [PANCAKE_ROUTER, BISWAP_ROUTER],
                    0
                )
            ).to.be.revertedWith("ContractPaused");
        });
    });

    describe("Router Whitelist Validation", function () {
        it("Should revert if non-whitelisted router is used", async function () {
            await expect(
                flashArbitrage.executeCrossDexArbitrage(
                    WBNB_BUSD_PAIR,
                    ethers.parseEther("1"),
                    WBNB,
                    [WBNB, BUSD],
                    [PANCAKE_ROUTER, BISWAP_ROUTER],
                    0
                )
            ).to.be.revertedWith("RouterNotWhitelisted");
        });

        it("Should revert if only first router is whitelisted", async function () {
            await flashArbitrage.setRouterWhitelist(PANCAKE_ROUTER, true);
            // BISWAP_ROUTER not whitelisted

            await expect(
                flashArbitrage.executeCrossDexArbitrage(
                    WBNB_BUSD_PAIR,
                    ethers.parseEther("1"),
                    WBNB,
                    [WBNB, BUSD],
                    [PANCAKE_ROUTER, BISWAP_ROUTER],
                    0
                )
            ).to.be.revertedWith("RouterNotWhitelisted");
        });
    });

    describe("Path Validation", function () {
        beforeEach(async function () {
            await flashArbitrage.setRouterWhitelist(PANCAKE_ROUTER, true);
            await flashArbitrage.setRouterWhitelist(BISWAP_ROUTER, true);
        });

        it("Should revert for invalid path length (cross-dex)", async function () {
            // Path must have at least 2 tokens
            await expect(
                flashArbitrage.executeCrossDexArbitrage(
                    WBNB_BUSD_PAIR,
                    ethers.parseEther("1"),
                    WBNB,
                    [WBNB], // Only 1 token - invalid
                    [PANCAKE_ROUTER],
                    0
                )
            ).to.be.revertedWith("InvalidPath");
        });

        it("Should revert for invalid path length (triangular)", async function () {
            // Triangular must have exactly 4 tokens (A->B->C->A)
            await expect(
                flashArbitrage.executeTriangularArbitrage(
                    WBNB_BUSD_PAIR,
                    ethers.parseEther("1"),
                    WBNB,
                    [WBNB, BUSD, USDT], // Only 3 tokens - invalid
                    PANCAKE_ROUTER,
                    0
                )
            ).to.be.revertedWith("InvalidPath");
        });

        it("Should revert for mismatched routers count (cross-dex)", async function () {
            // For 2-token path, need 1 router
            await expect(
                flashArbitrage.executeCrossDexArbitrage(
                    WBNB_BUSD_PAIR,
                    ethers.parseEther("1"),
                    WBNB,
                    [WBNB, BUSD],
                    [PANCAKE_ROUTER, BISWAP_ROUTER, PANCAKE_ROUTER], // 3 routers for 2-token path
                    0
                )
            ).to.be.revertedWith("InvalidPath");
        });
    });

    describe("Emergency Functions", function () {
        it("Should allow owner to withdraw BNB", async function () {
            // Send some BNB to contract
            await owner.sendTransaction({
                to: await flashArbitrage.getAddress(),
                value: ethers.parseEther("1"),
            });

            const contractBalance = await ethers.provider.getBalance(
                await flashArbitrage.getAddress()
            );
            expect(contractBalance).to.equal(ethers.parseEther("1"));

            const ownerBalanceBefore = await ethers.provider.getBalance(owner.address);

            const tx = await flashArbitrage.emergencyWithdraw(ethers.ZeroAddress);
            const receipt = await tx.wait();
            const gasUsed = receipt.gasUsed * receipt.gasPrice;

            const ownerBalanceAfter = await ethers.provider.getBalance(owner.address);

            // Owner balance should increase by 1 BNB minus gas
            expect(ownerBalanceAfter).to.be.closeTo(
                ownerBalanceBefore + ethers.parseEther("1") - gasUsed,
                ethers.parseEther("0.001") // Allow small rounding error
            );
        });

        it("Should allow owner to withdraw ERC20 tokens", async function () {
            // Get WBNB contract
            const wbnb = await ethers.getContractAt("IERC20", WBNB);

            // Wrap some BNB to WBNB and send to contract
            const iwbnb = await ethers.getContractAt(
                ["function deposit() payable", "function balanceOf(address) view returns (uint256)"],
                WBNB
            );

            // Deposit BNB to get WBNB
            await iwbnb.deposit({ value: ethers.parseEther("1") });

            // Transfer WBNB to contract
            await wbnb.transfer(await flashArbitrage.getAddress(), ethers.parseEther("1"));

            const contractWbnbBefore = await wbnb.balanceOf(await flashArbitrage.getAddress());
            expect(contractWbnbBefore).to.equal(ethers.parseEther("1"));

            const ownerWbnbBefore = await wbnb.balanceOf(owner.address);

            await flashArbitrage.emergencyWithdraw(WBNB);

            const ownerWbnbAfter = await wbnb.balanceOf(owner.address);
            expect(ownerWbnbAfter - ownerWbnbBefore).to.equal(ethers.parseEther("1"));
        });

        it("Should revert emergency withdraw for non-owner", async function () {
            await expect(
                flashArbitrage.connect(addr1).emergencyWithdraw(ethers.ZeroAddress)
            ).to.be.revertedWith("OnlyOwner");
        });

        it("Should emit event on emergency withdraw", async function () {
            await owner.sendTransaction({
                to: await flashArbitrage.getAddress(),
                value: ethers.parseEther("1"),
            });

            await expect(flashArbitrage.emergencyWithdraw(ethers.ZeroAddress))
                .to.emit(flashArbitrage, "EmergencyWithdraw")
                .withArgs(ethers.ZeroAddress, ethers.parseEther("1"));
        });
    });

    describe("Receive Function", function () {
        it("Should accept BNB transfers", async function () {
            await expect(
                owner.sendTransaction({
                    to: await flashArbitrage.getAddress(),
                    value: ethers.parseEther("1"),
                })
            ).to.not.be.reverted;

            const balance = await ethers.provider.getBalance(
                await flashArbitrage.getAddress()
            );
            expect(balance).to.equal(ethers.parseEther("1"));
        });
    });

    describe("Gas Estimation", function () {
        beforeEach(async function () {
            await flashArbitrage.setRouterWhitelist(PANCAKE_ROUTER, true);
            await flashArbitrage.setRouterWhitelist(BISWAP_ROUTER, true);
        });

        it("Should estimate gas for whitelist operation", async function () {
            const gasEstimate = await flashArbitrage.setRouterWhitelist.estimateGas(
                APESWAP_ROUTER,
                true
            );
            // Whitelist should be relatively cheap
            expect(gasEstimate).to.be.lt(100000);
        });

        it("Should estimate gas for pause operation", async function () {
            const gasEstimate = await flashArbitrage.setPaused.estimateGas(true);
            // Pause should be very cheap
            expect(gasEstimate).to.be.lt(50000);
        });
    });

    // Note: Full flash loan execution tests are difficult to run
    // because they require actual profitable arbitrage opportunities
    // which rarely exist or are immediately captured by MEV bots.
    // These tests are best run on a controlled testnet or with mocked prices.
});

describe("FlashArbitrage View Functions", function () {
    let flashArbitrage;
    let owner;

    const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
    const PANCAKE_ROUTER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";

    beforeEach(async function () {
        [owner] = await ethers.getSigners();

        const FlashArbitrage = await ethers.getContractFactory("FlashArbitrage");
        flashArbitrage = await FlashArbitrage.deploy(WBNB);
        await flashArbitrage.waitForDeployment();
    });

    it("Should return correct owner", async function () {
        expect(await flashArbitrage.owner()).to.equal(owner.address);
    });

    it("Should return correct WBNB address", async function () {
        expect(await flashArbitrage.WBNB()).to.equal(WBNB);
    });

    it("Should return correct paused state", async function () {
        expect(await flashArbitrage.paused()).to.equal(false);

        await flashArbitrage.setPaused(true);
        expect(await flashArbitrage.paused()).to.equal(true);
    });

    it("Should return correct whitelist state", async function () {
        expect(await flashArbitrage.whitelistedRouters(PANCAKE_ROUTER)).to.equal(false);

        await flashArbitrage.setRouterWhitelist(PANCAKE_ROUTER, true);
        expect(await flashArbitrage.whitelistedRouters(PANCAKE_ROUTER)).to.equal(true);
    });
});
