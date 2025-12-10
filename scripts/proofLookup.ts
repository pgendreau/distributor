#!/usr/bin/env node
import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";

interface ClaimData {
  amount: string;
  proof: string[];
}

interface ProofsData {
  merkleRoot: string;
  totalAmount: string;
  totalClaimants: number;
  claims: Record<string, ClaimData>;
}

const PROOFS_FILE = path.join(__dirname, "..", "output", "proofs.json");

function loadProofs(): ProofsData {
  if (!fs.existsSync(PROOFS_FILE)) {
    console.error("Error: proofs.json not found. Run 'npm run generate-tree' first.");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(PROOFS_FILE, "utf-8"));
}

function lookupProof(address: string): void {
  const proofs = loadProofs();

  let normalizedAddress: string;
  try {
    normalizedAddress = ethers.getAddress(address.toLowerCase());
  } catch {
    console.error("Error: Invalid Ethereum address");
    process.exit(1);
  }

  const claim = proofs.claims[normalizedAddress];

  if (!claim) {
    console.error(`\n❌ Address ${normalizedAddress} is not eligible for any claim.\n`);
    process.exit(1);
  }

  console.log("\n=== Claim Information ===\n");
  console.log(`Address:      ${normalizedAddress}`);
  console.log(`Amount:       ${ethers.formatEther(claim.amount)} ETH`);
  console.log(`Amount (Wei): ${claim.amount}`);
  console.log(`\nMerkle Root: ${proofs.merkleRoot}`);
  console.log(`\nProof Array (${claim.proof.length} elements):`);
  console.log(JSON.stringify(claim.proof, null, 2));

  const iface = new ethers.Interface([
    "function claim(uint256 amount, bytes32[] calldata proof)",
  ]);
  const calldata = iface.encodeFunctionData("claim", [claim.amount, claim.proof]);

  console.log("\n=== Transaction Data ===\n");
  console.log(`Function: claim(uint256,bytes32[])`);
  console.log(`Amount:   ${claim.amount}`);
  console.log(`Proof:    ${JSON.stringify(claim.proof)}`);
  console.log(`\nEncoded calldata:\n${calldata}\n`);
}

function showStats(): void {
  const proofs = loadProofs();

  console.log("\n=== Distribution Statistics ===\n");
  console.log(`Merkle Root:     ${proofs.merkleRoot}`);
  console.log(`Total Amount:    ${ethers.formatEther(proofs.totalAmount)} ETH`);
  console.log(`Total Claimants: ${proofs.totalClaimants}`);

  const sortedClaims = Object.entries(proofs.claims)
    .map(([addr, data]) => ({ address: addr, amount: BigInt(data.amount) }))
    .sort((a, b) => (b.amount > a.amount ? 1 : -1))
    .slice(0, 5);

  console.log(`\nTop 5 Claimants:`);
  sortedClaims.forEach((claim, i) => {
    console.log(`  ${i + 1}. ${claim.address}: ${ethers.formatEther(claim.amount.toString())} ETH`);
  });
  console.log("");
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(`
Merkle Distributor Proof Lookup Tool

Usage:
  npx ts-node frontend/proofLookup.ts <address>   - Look up proof for address
  npx ts-node frontend/proofLookup.ts --stats     - Show distribution statistics
`);
    process.exit(0);
  }

  if (args[0] === "--stats") {
    showStats();
  } else {
    lookupProof(args[0]);
  }
}

main();
