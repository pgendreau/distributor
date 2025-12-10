import { ethers } from "hardhat";

async function main() {
  const [deployer, dao] = await ethers.getSigners();

  console.log("Deploying MerkleDistributor...");
  console.log("Deployer (Owner):", deployer.address);
  console.log("DAO:", dao ? dao.address : deployer.address);

  const daoAddress = dao ? dao.address : deployer.address;
  const ownerAddress = deployer.address;

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
