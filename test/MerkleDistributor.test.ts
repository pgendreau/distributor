import { expect } from "chai";
import { ethers } from "hardhat";
import axios from "axios";
import { MerkleTree } from "merkletreejs";
import { MerkleDistributor } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time, setBalance } from "@nomicfoundation/hardhat-network-helpers";

const CSV_URL =
  "https://raw.githubusercontent.com/pgendreau/aavegotchi-ptd/refs/heads/main/TotalDistributionAmounts.csv";

interface Claim {
  address: string;
  amount: bigint;
}

interface ClaimWithProof extends Claim {
  proof: string[];
}

describe("MerkleDistributor", function () {
  this.timeout(30000);

  const CLAIM_PERIOD = 90 * 24 * 60 * 60;

  let owner: SignerWithAddress;
  let dao: SignerWithAddress;
  let distributor: MerkleDistributor;

  let claims: Claim[];
  let claimsWithProof: Map<string, ClaimWithProof>;
  let merkleRoot: string;
  let totalAmount: bigint;

  function getLeafHash(address: string, amount: bigint): Buffer {
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const encoded = abiCoder.encode(["address", "uint256"], [address, amount]);
    const innerHash = ethers.keccak256(encoded);
    const outerHash = ethers.keccak256(ethers.concat([innerHash]));
    return Buffer.from(outerHash.slice(2), "hex");
  }

  async function fetchAndParseCSV(): Promise<Claim[]> {
    const response = await axios.get(CSV_URL);
    const lines = response.data.trim().split("\n");
    const header = lines[0].split(",");

    const walletIndex = header.indexOf("wallet");
    const rewardIndex = header.indexOf("rewardTotal");

    const parsedClaims: Claim[] = [];
    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(",");
      const wallet = values[walletIndex].trim().toLowerCase();
      const rewardStr = values[rewardIndex].trim();
      const rewardFloat = parseFloat(rewardStr);

      if (rewardFloat <= 0) continue;

      parsedClaims.push({
        address: ethers.getAddress(wallet),
        amount: ethers.parseEther(rewardStr),
      });
    }
    return parsedClaims;
  }

  function buildMerkleTree(claimsList: Claim[]): {
    root: string;
    claimsMap: Map<string, ClaimWithProof>;
  } {
    const leaves = claimsList.map((c) => getLeafHash(c.address, c.amount));
    const tree = new MerkleTree(
      leaves,
      (data: Buffer) => Buffer.from(ethers.keccak256(data).slice(2), "hex"),
      { sortPairs: true }
    );

    const claimsMap = new Map<string, ClaimWithProof>();
    for (const claim of claimsList) {
      const leaf = getLeafHash(claim.address, claim.amount);
      claimsMap.set(claim.address, {
        ...claim,
        proof: tree.getHexProof(leaf),
      });
    }

    return { root: tree.getHexRoot(), claimsMap };
  }

  before(async function () {
    claims = await fetchAndParseCSV();
    totalAmount = claims.reduce((sum, c) => sum + c.amount, 0n);
    const { root, claimsMap } = buildMerkleTree(claims);
    merkleRoot = root;
    claimsWithProof = claimsMap;
  });

  beforeEach(async function () {
    [owner, dao] = await ethers.getSigners();
    await setBalance(dao.address, totalAmount + ethers.parseEther("100"));

    const Factory = await ethers.getContractFactory("MerkleDistributor");
    distributor = await Factory.deploy(dao.address, owner.address);
    await distributor.waitForDeployment();
  });

  describe("Deployment", function () {
    it("should set the correct DAO address", async function () {
      expect(await distributor.dao()).to.equal(dao.address);
    });

    it("should set the correct owner address", async function () {
      expect(await distributor.owner()).to.equal(owner.address);
    });

    it("should have zero merkle root initially", async function () {
      expect(await distributor.merkleRoot()).to.equal(ethers.ZeroHash);
    });

    it("should have zero claim start time initially", async function () {
      expect(await distributor.claimStartTime()).to.equal(0n);
    });
  });

  describe("openClaims", function () {
    it("should allow DAO to open claims with live CSV total", async function () {
      const tx = await distributor.connect(dao).openClaims(merkleRoot, { value: totalAmount });
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);
      
      await expect(tx)
        .to.emit(distributor, "ClaimsOpened")
        .withArgs(merkleRoot, totalAmount, block!.timestamp);

      expect(await distributor.merkleRoot()).to.equal(merkleRoot);
      expect(await distributor.totalDistribution()).to.equal(totalAmount);
    });

    it("should revert if called by non-DAO", async function () {
      await expect(
        distributor.connect(owner).openClaims(merkleRoot, { value: totalAmount })
      ).to.be.revertedWithCustomError(distributor, "OnlyDAO");
    });

    it("should revert if called with zero ETH", async function () {
      await expect(
        distributor.connect(dao).openClaims(merkleRoot, { value: 0 })
      ).to.be.revertedWithCustomError(distributor, "InvalidDepositAmount");
    });

    it("should revert if called twice", async function () {
      await distributor.connect(dao).openClaims(merkleRoot, { value: totalAmount });
      await setBalance(dao.address, totalAmount + ethers.parseEther("100"));
      await expect(
        distributor.connect(dao).openClaims(merkleRoot, { value: totalAmount })
      ).to.be.revertedWithCustomError(distributor, "ClaimsAlreadyOpened");
    });
  });

  describe("claim", function () {
    beforeEach(async function () {
      await distributor.connect(dao).openClaims(merkleRoot, { value: totalAmount });
    });

    it("should verify all claims from live CSV", async function () {
      const sampleSize = Math.min(20, claims.length);
      for (let i = 0; i < sampleSize; i++) {
        const claim = claimsWithProof.get(claims[i].address)!;
        const isValid = await distributor.verifyClaim(claim.address, claim.amount, claim.proof);
        expect(isValid, `Claim for ${claim.address} should be valid`).to.be.true;
      }
    });

    it("should allow claiming with real proof from live CSV", async function () {
      const [firstClaim] = claims;
      const claim = claimsWithProof.get(firstClaim.address)!;

      const claimant = await ethers.getImpersonatedSigner(claim.address);
      await setBalance(claim.address, ethers.parseEther("1"));

      const balanceBefore = await ethers.provider.getBalance(claim.address);
      const tx = await distributor.connect(claimant).claim(claim.amount, claim.proof);
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
      const balanceAfter = await ethers.provider.getBalance(claim.address);

      expect(balanceAfter - balanceBefore + gasUsed).to.equal(claim.amount);
      expect(await distributor.claimed(claim.address)).to.be.true;
    });

    it("should emit Claimed event", async function () {
      const [firstClaim] = claims;
      const claim = claimsWithProof.get(firstClaim.address)!;

      const claimant = await ethers.getImpersonatedSigner(claim.address);
      await setBalance(claim.address, ethers.parseEther("1"));

      await expect(distributor.connect(claimant).claim(claim.amount, claim.proof))
        .to.emit(distributor, "Claimed")
        .withArgs(claim.address, claim.amount);
    });

    it("should send correct ETH amounts to multiple claimants from CSV", async function () {
      const sampleSize = Math.min(5, claims.length);

      for (let i = 0; i < sampleSize; i++) {
        const claim = claimsWithProof.get(claims[i].address)!;
        const claimant = await ethers.getImpersonatedSigner(claim.address);
        await setBalance(claim.address, ethers.parseEther("1"));

        const balanceBefore = await ethers.provider.getBalance(claim.address);
        const tx = await distributor.connect(claimant).claim(claim.amount, claim.proof);
        const receipt = await tx.wait();
        const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
        const balanceAfter = await ethers.provider.getBalance(claim.address);

        expect(balanceAfter - balanceBefore + gasUsed).to.equal(
          claim.amount,
          `User ${claim.address} should receive exactly ${ethers.formatEther(claim.amount)} ETH`
        );
        expect(await distributor.claimed(claim.address)).to.be.true;
      }
    });

    it("should revert if claims not opened yet", async function () {
      const Factory = await ethers.getContractFactory("MerkleDistributor");
      const newDist = await Factory.deploy(dao.address, owner.address);

      const [firstClaim] = claims;
      const claim = claimsWithProof.get(firstClaim.address)!;
      const claimant = await ethers.getImpersonatedSigner(claim.address);
      await setBalance(claim.address, ethers.parseEther("1"));

      await expect(
        newDist.connect(claimant).claim(claim.amount, claim.proof)
      ).to.be.revertedWithCustomError(newDist, "ClaimsNotOpened");
    });

    it("should revert with invalid proof", async function () {
      const [firstClaim] = claims;
      const claim = claimsWithProof.get(firstClaim.address)!;
      const claimant = await ethers.getImpersonatedSigner(claim.address);
      await setBalance(claim.address, ethers.parseEther("1"));

      const invalidProof = [ethers.keccak256(ethers.toUtf8Bytes("invalid"))];
      await expect(
        distributor.connect(claimant).claim(claim.amount, invalidProof)
      ).to.be.revertedWithCustomError(distributor, "InvalidProof");
    });

    it("should revert if claiming wrong amount", async function () {
      const [firstClaim] = claims;
      const claim = claimsWithProof.get(firstClaim.address)!;
      const claimant = await ethers.getImpersonatedSigner(claim.address);
      await setBalance(claim.address, ethers.parseEther("1"));

      const wrongAmount = claim.amount + 1n;
      await expect(
        distributor.connect(claimant).claim(wrongAmount, claim.proof)
      ).to.be.revertedWithCustomError(distributor, "InvalidProof");
    });

    it("should revert if user already claimed", async function () {
      const [firstClaim] = claims;
      const claim = claimsWithProof.get(firstClaim.address)!;
      const claimant = await ethers.getImpersonatedSigner(claim.address);
      await setBalance(claim.address, ethers.parseEther("1"));

      await distributor.connect(claimant).claim(claim.amount, claim.proof);
      await expect(
        distributor.connect(claimant).claim(claim.amount, claim.proof)
      ).to.be.revertedWithCustomError(distributor, "AlreadyClaimed");
    });

    it("should revert if non-claimant uses someone else's proof", async function () {
      if (claims.length < 2) this.skip();

      const claim1 = claimsWithProof.get(claims[0].address)!;
      const claim2 = claimsWithProof.get(claims[1].address)!;

      const claimant1 = await ethers.getImpersonatedSigner(claim1.address);
      await setBalance(claim1.address, ethers.parseEther("1"));

      await expect(
        distributor.connect(claimant1).claim(claim1.amount, claim2.proof)
      ).to.be.revertedWithCustomError(distributor, "InvalidProof");
    });

    it("should revert if claim period has expired", async function () {
      await time.increase(CLAIM_PERIOD + 1);

      const [firstClaim] = claims;
      const claim = claimsWithProof.get(firstClaim.address)!;
      const claimant = await ethers.getImpersonatedSigner(claim.address);
      await setBalance(claim.address, ethers.parseEther("1"));

      await expect(
        distributor.connect(claimant).claim(claim.amount, claim.proof)
      ).to.be.revertedWithCustomError(distributor, "ClaimPeriodExpired");
    });

    it("should allow claim just before deadline", async function () {
      await time.increase(CLAIM_PERIOD - 60);

      const [firstClaim] = claims;
      const claim = claimsWithProof.get(firstClaim.address)!;
      const claimant = await ethers.getImpersonatedSigner(claim.address);
      await setBalance(claim.address, ethers.parseEther("1"));

      await expect(distributor.connect(claimant).claim(claim.amount, claim.proof)).to.not.be
        .reverted;
    });

    it("should revert when contract is paused", async function () {
      await distributor.connect(owner).pause();

      const [firstClaim] = claims;
      const claim = claimsWithProof.get(firstClaim.address)!;
      const claimant = await ethers.getImpersonatedSigner(claim.address);
      await setBalance(claim.address, ethers.parseEther("1"));

      await expect(
        distributor.connect(claimant).claim(claim.amount, claim.proof)
      ).to.be.revertedWithCustomError(distributor, "EnforcedPause");
    });
  });

  describe("withdrawRemaining", function () {
    beforeEach(async function () {
      await distributor.connect(dao).openClaims(merkleRoot, { value: totalAmount });

      const [firstClaim] = claims;
      const claim = claimsWithProof.get(firstClaim.address)!;
      const claimant = await ethers.getImpersonatedSigner(claim.address);
      await setBalance(claim.address, ethers.parseEther("1"));
      await distributor.connect(claimant).claim(claim.amount, claim.proof);
    });

    it("should allow DAO to withdraw remaining after claim period", async function () {
      await time.increase(CLAIM_PERIOD + 1);

      const contractBalance = await ethers.provider.getBalance(await distributor.getAddress());
      const daoBalanceBefore = await ethers.provider.getBalance(dao.address);

      const tx = await distributor.connect(dao).withdrawRemaining();
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

      const daoBalanceAfter = await ethers.provider.getBalance(dao.address);
      expect(daoBalanceAfter - daoBalanceBefore + gasUsed).to.equal(contractBalance);
    });

    it("should emit RemainingWithdrawn event", async function () {
      await time.increase(CLAIM_PERIOD + 1);

      const remaining = await ethers.provider.getBalance(await distributor.getAddress());
      await expect(distributor.connect(dao).withdrawRemaining())
        .to.emit(distributor, "RemainingWithdrawn")
        .withArgs(dao.address, remaining);
    });

    it("should revert if called before claim period ends", async function () {
      await expect(
        distributor.connect(dao).withdrawRemaining()
      ).to.be.revertedWithCustomError(distributor, "ClaimPeriodNotExpired");
    });

    it("should revert if called by non-DAO", async function () {
      await time.increase(CLAIM_PERIOD + 1);
      await expect(
        distributor.connect(owner).withdrawRemaining()
      ).to.be.revertedWithCustomError(distributor, "OnlyDAO");
    });

    it("should allow withdraw at exactly claim period end", async function () {
      await time.increase(CLAIM_PERIOD);
      await expect(distributor.connect(dao).withdrawRemaining()).to.not.be.reverted;
    });
  });

  describe("Emergency Functions", function () {
    beforeEach(async function () {
      await distributor.connect(dao).openClaims(merkleRoot, { value: totalAmount });
    });

    it("should allow owner to pause", async function () {
      await distributor.connect(owner).pause();
      expect(await distributor.paused()).to.be.true;
    });

    it("should allow owner to unpause", async function () {
      await distributor.connect(owner).pause();
      await distributor.connect(owner).unpause();
      expect(await distributor.paused()).to.be.false;
    });

    it("should revert if non-owner tries to pause", async function () {
      await expect(
        distributor.connect(dao).pause()
      ).to.be.revertedWithCustomError(distributor, "OwnableUnauthorizedAccount");
    });

    it("should revert if non-owner tries to unpause", async function () {
      await distributor.connect(owner).pause();
      await expect(
        distributor.connect(dao).unpause()
      ).to.be.revertedWithCustomError(distributor, "OwnableUnauthorizedAccount");
    });

    it("should allow claims after unpause", async function () {
      await distributor.connect(owner).pause();
      await distributor.connect(owner).unpause();

      const [firstClaim] = claims;
      const claim = claimsWithProof.get(firstClaim.address)!;
      const claimant = await ethers.getImpersonatedSigner(claim.address);
      await setBalance(claim.address, ethers.parseEther("1"));

      await expect(distributor.connect(claimant).claim(claim.amount, claim.proof)).to.not.be
        .reverted;
    });
  });

  describe("View Functions", function () {
    it("should return false for isClaimPeriodActive before claims opened", async function () {
      expect(await distributor.isClaimPeriodActive()).to.be.false;
    });

    it("should return true for isClaimPeriodActive after claims opened", async function () {
      await distributor.connect(dao).openClaims(merkleRoot, { value: totalAmount });
      expect(await distributor.isClaimPeriodActive()).to.be.true;
    });

    it("should return false for isClaimPeriodActive after period ends", async function () {
      await distributor.connect(dao).openClaims(merkleRoot, { value: totalAmount });
      await time.increase(CLAIM_PERIOD + 1);
      expect(await distributor.isClaimPeriodActive()).to.be.false;
    });

    it("should return correct timeRemaining", async function () {
      await distributor.connect(dao).openClaims(merkleRoot, { value: totalAmount });
      const remaining = await distributor.timeRemaining();
      expect(remaining).to.be.closeTo(BigInt(CLAIM_PERIOD), 5n);
    });

    it("should return 0 for timeRemaining after period ends", async function () {
      await distributor.connect(dao).openClaims(merkleRoot, { value: totalAmount });
      await time.increase(CLAIM_PERIOD + 1);
      expect(await distributor.timeRemaining()).to.equal(0n);
    });
  });
});
