#!/usr/bin/env tsx
/**
 * Approve Polymarket CTF Exchange to spend USDC.e from our EOA
 */
import { ethers } from "ethers";

const USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // bridged USDC on Polygon
const CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const NEG_RISK_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a";

async function main() {
  if (!process.env.EVM_PRIVATE_KEY) {
    console.error("❌ EVM_PRIVATE_KEY not set");
    process.exit(1);
  }

  const provider = new ethers.providers.StaticJsonRpcProvider(
    process.env.RPC_URL || "https://polygon-rpc.com",
    { name: "polygon", chainId: 137 }
  );
  const signer = new ethers.Wallet(process.env.EVM_PRIVATE_KEY!, provider);
  console.log(`Wallet: ${signer.address}`);

  const usdc = new ethers.Contract(USDC_E, [
    "function approve(address,uint256) returns (bool)",
    "function allowance(address,address) view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
  ], signer);

  const balance = await usdc.balanceOf(signer.address);
  console.log(`USDC.e balance: ${ethers.utils.formatUnits(balance, 6)}`);

  const maxApproval = ethers.constants.MaxUint256;

  // Approve CTF Exchange
  const allowance1 = await usdc.allowance(signer.address, CTF_EXCHANGE);
  if (allowance1.gt(0)) {
    console.log(`CTF Exchange allowance already set: ${ethers.utils.formatUnits(allowance1, 6)}`);
  } else {
    console.log("Approving CTF Exchange...");
    const tx1 = await usdc.approve(CTF_EXCHANGE, maxApproval, {
      maxPriorityFeePerGas: ethers.utils.parseUnits("30", "gwei"), maxFeePerGas: ethers.utils.parseUnits("2000", "gwei"), gasLimit: 100000,
    });
    console.log(`  tx: ${tx1.hash}`);
    const receipt1 = await tx1.wait();
    console.log("  status:", receipt1.status, receipt1.status === 1 ? "✓" : "✗");
    console.log("  gasUsed:", receipt1.gasUsed.toString());
  }

  // Approve Neg Risk Exchange (for some markets)
  const allowance2 = await usdc.allowance(signer.address, NEG_RISK_EXCHANGE);
  if (allowance2.gt(0)) {
    console.log(`Neg Risk Exchange allowance already set: ${ethers.utils.formatUnits(allowance2, 6)}`);
  } else {
    console.log("Approving Neg Risk Exchange...");
    const tx2 = await usdc.approve(NEG_RISK_EXCHANGE, maxApproval, {
      maxPriorityFeePerGas: ethers.utils.parseUnits("30", "gwei"), maxFeePerGas: ethers.utils.parseUnits("2000", "gwei"), gasLimit: 100000,
    });
    console.log(`  tx: ${tx2.hash}`);
    const receipt2 = await tx2.wait();
    console.log("  status:", receipt2.status, receipt2.status === 1 ? "✓" : "✗");
  }

  console.log("\n✅ Done! Ready to trade.");
}

main().catch(console.error);
