#!/usr/bin/env node
/**
 * flow-bid.mjs — Bid $150 USDC on the $FLOW CCA auction (Base)
 *
 * CCA contract: 0x942967af43ab0001dbb43eab2456a2a0daea45b6
 * Auction starts: block 42,673,326 (~7h 34min from deploy)
 * Duration: 270 blocks (~9 min)
 * Collateral: USDC (Base) 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913
 */

import { createWalletClient, createPublicClient, http, parseUnits, encodeAbiParameters, encodeFunctionData } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const CCA       = '0x942967af43ab0001dbb43eab2456a2a0daea45b6';
const USDC      = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const START_BLOCK = 42_673_326n;
const FLOOR_PRICE = 1_980_704_062_800n;          // on-chain units (Q96 tick)
const MAX_BID_PRICE = BigInt('0x441c64ca23c51c4c6250dc8001ee94fd24');
const BID_AMOUNT  = parseUnits('150', 6);         // 150 USDC

const DRY_RUN = process.env.DRY_RUN === '1';
const PK = process.env.EVM_PRIVATE_KEY;
if (!PK) { console.error('EVM_PRIVATE_KEY not set'); process.exit(1); }

const account = privateKeyToAccount(PK);
const publicClient = createPublicClient({ chain: base, transport: http('https://mainnet.base.org') });
const walletClient = createWalletClient({ chain: base, account, transport: http('https://mainnet.base.org') });

const USDC_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: '', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [{ type: 'bool' }] },
];

const CCA_ABI = [
  {
    name: 'submitBid',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'maxPrice',      type: 'uint256' },
      { name: 'amount',        type: 'uint128' },
      { name: 'owner',         type: 'address' },
      { name: 'prevTickPrice', type: 'uint256' },
      { name: 'hookData',      type: 'bytes'   },
    ],
    outputs: [{ name: 'bidId', type: 'uint256' }],
  },
];

async function main() {
  console.log(`Wallet: ${account.address}`);

  // --- Balance check ---
  const usdcBalance = await publicClient.readContract({ address: USDC, abi: USDC_ABI, functionName: 'balanceOf', args: [account.address] });
  console.log(`USDC balance: $${(Number(usdcBalance) / 1e6).toFixed(2)}`);
  if (usdcBalance < BID_AMOUNT) {
    console.error(`❌ Insufficient USDC: have $${(Number(usdcBalance)/1e6).toFixed(2)}, need $150`);
    process.exit(1);
  }

  // --- Pre-flight summary ---
  console.log(`\n📊 Pre-flight`);
  console.log(`  Bid amount:    $${Number(BID_AMOUNT)/1e6}`);
  console.log(`  Max price:     ${MAX_BID_PRICE.toString()} (Q96 ceiling — fills at clearing)`);
  console.log(`  Floor price:   ${FLOOR_PRICE.toString()}`);
  console.log(`  Auction start: block ${START_BLOCK}`);
  console.log(`  Duration:      270 blocks (~9 min)\n`);

  if (DRY_RUN) { console.log('[DRY RUN] Stopping here.'); return; }

  // --- Step 1: Approve if needed ---
  const allowance = await publicClient.readContract({ address: USDC, abi: USDC_ABI, functionName: 'allowance', args: [account.address, CCA] });
  if (allowance < BID_AMOUNT) {
    console.log(`Approving $150 USDC to CCA...`);
    const approveTx = await walletClient.writeContract({ address: USDC, abi: USDC_ABI, functionName: 'approve', args: [CCA, BID_AMOUNT] });
    console.log(`Approve tx: ${approveTx}`);
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
    console.log(`Approval confirmed ✅`);
  } else {
    console.log(`Allowance already sufficient ✅`);
  }

  // --- Step 2: Wait for startBlock ---
  let currentBlock = await publicClient.getBlockNumber();
  console.log(`Current block: ${currentBlock}, waiting for ${START_BLOCK}...`);

  while (currentBlock < START_BLOCK) {
    const blocksLeft = START_BLOCK - currentBlock;
    const secsLeft = Number(blocksLeft) * 2;
    process.stdout.write(`\r  ${blocksLeft} blocks left (~${Math.floor(secsLeft/60)}m ${secsLeft%60}s)   `);
    await new Promise(r => setTimeout(r, 2000)); // poll every 2s
    currentBlock = await publicClient.getBlockNumber();
  }
  console.log(`\n🟢 Auction open! Submitting bid...`);

  // --- Step 3: Submit bid ---
  const bidTx = await walletClient.writeContract({
    address: CCA,
    abi: CCA_ABI,
    functionName: 'submitBid',
    args: [MAX_BID_PRICE, BID_AMOUNT, account.address, FLOOR_PRICE, '0x'],
  });
  console.log(`Bid tx: ${bidTx}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: bidTx });
  console.log(`\n✅ Bid confirmed! Block ${receipt.blockNumber}, status: ${receipt.status}`);
  console.log(`TX: https://basescan.org/tx/${bidTx}`);
}

main().catch(e => { console.error('Error:', e.message || e); process.exit(1); });
