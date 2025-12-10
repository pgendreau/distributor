import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import { MerkleTree } from "merkletreejs";
import { ethers } from "ethers";

const CSV_URL =
  "https://raw.githubusercontent.com/pgendreau/aavegotchi-ptd/refs/heads/main/TotalDistributionAmounts.csv";

interface Claim {
  address: string;
  amount: bigint;
}

interface ProofData {
  amount: string;
  proof: string[];
}

interface OutputData {
  merkleRoot: string;
  totalAmount: string;
  totalClaimants: number;
  claims: Record<string, ProofData>;
}

async function fetchCSV(): Promise<string> {
  console.log("Fetching CSV from:", CSV_URL);
  const response = await axios.get(CSV_URL);
  return response.data;
}

function parseCSV(csvContent: string): Claim[] {
  const lines = csvContent.trim().split("\n");
  const header = lines[0].split(",");

  const walletIndex = header.indexOf("wallet");
  const rewardIndex = header.indexOf("rewardTotal");

  if (walletIndex === -1 || rewardIndex === -1) {
    throw new Error("CSV missing required columns: wallet or rewardTotal");
  }

  const claims: Claim[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(",");
    const wallet = values[walletIndex].trim().toLowerCase();
    const rewardStr = values[rewardIndex].trim();
    const rewardFloat = parseFloat(rewardStr);

    if (rewardFloat <= 0) {
      console.log(`Skipping zero reward for: ${wallet}`);
      continue;
    }

    claims.push({
      address: ethers.getAddress(wallet),
      amount: ethers.parseEther(rewardStr),
    });
  }

  return claims;
}

function getLeafHash(address: string, amount: bigint): Buffer {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const encoded = abiCoder.encode(["address", "uint256"], [address, amount]);
  const innerHash = ethers.keccak256(encoded);
  const outerHash = ethers.keccak256(ethers.concat([innerHash]));
  return Buffer.from(outerHash.slice(2), "hex");
}

function generateTree(claims: Claim[]): {
  tree: MerkleTree;
  proofs: Record<string, ProofData>;
} {
  const leaves = claims.map((claim) => getLeafHash(claim.address, claim.amount));

  const tree = new MerkleTree(
    leaves,
    (data: Buffer) => Buffer.from(ethers.keccak256(data).slice(2), "hex"),
    { sortPairs: true }
  );

  const proofs: Record<string, ProofData> = {};
  for (const claim of claims) {
    const leaf = getLeafHash(claim.address, claim.amount);
    proofs[claim.address] = {
      amount: claim.amount.toString(),
      proof: tree.getHexProof(leaf),
    };
  }

  return { tree, proofs };
}

async function main() {
  console.log("=== Merkle Tree Generator ===\n");

  const csvContent = await fetchCSV();
  const claims = parseCSV(csvContent);

  console.log(`Parsed ${claims.length} claims (excluding zero rewards)\n`);

  const total = claims.reduce((sum, c) => sum + c.amount, 0n);
  console.log(`Total distribution: ${ethers.formatEther(total)} ETH\n`);

  console.log("Generating Merkle tree...");
  const { tree, proofs } = generateTree(claims);

  const merkleRoot = tree.getHexRoot();
  console.log(`Merkle Root: ${merkleRoot}\n`);

  const output: OutputData = {
    merkleRoot,
    totalAmount: total.toString(),
    totalClaimants: claims.length,
    claims: proofs,
  };

  const outputDir = path.join(__dirname, "..", "output");
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const outputPath = path.join(outputDir, "proofs.json");
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

  console.log(`✅ Proofs written to: ${outputPath}`);
  console.log(`   Total claimants: ${claims.length}`);
  console.log(`   Merkle root: ${merkleRoot}`);
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
