import { ethers } from "hardhat";

async function main() {
  const [deployer, dao] = await ethers.getSigners();
  const ownerAddress = await deployer.getAddress();
  const daoAddress = dao ? await dao.getAddress() : "0x62de034b1a69ef853c9d0d8a33d26df5cf26682e";

  console.log("Deploying MerkleDistributor...");
  console.log("Deployer (Owner):", ownerAddress);
  console.log("DAO:", daoAddress);

  const MerkleDistributor = await ethers.getContractFactory("MerkleDistributor");
  const distributor = await MerkleDistributor.deploy(daoAddress, ownerAddress);

  await distributor.waitForDeployment();

  const address = await distributor.getAddress();
  console.log("\n✅ MerkleDistributor deployed to:", address);
  console.log("   DAO address:", daoAddress);
  console.log("   Owner address:", ownerAddress);

  return { address, daoAddress, ownerAddress };
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
