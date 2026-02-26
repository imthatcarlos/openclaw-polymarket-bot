#!/usr/bin/env node
/**
 * flow-bid.mjs — Bid $150 USDC on the $FLOW CCA auction via Flow API + viem
 *
 * Auction: 0x942967af43ab0001dbb43eab2456a2a0daea45b6 (Base)
 * Starts:  block 42,673,326
 * AuctionManager: 0xF762AC1553c29Ef36904F9E7F71C627766D878b4
 */

import { createWalletClient, createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const AUCTION   = '0x942967af43ab0001dbb43eab2456a2a0daea45b6';
const FLOW_API  = 'https://api.flow.bid';
const START_BLOCK = 42_673_326n;
const BID_AMOUNT_USD = 150;
const MAX_FDV_USD = 10_000_000; // $10M ceiling — fills at whatever clears

const DRY_RUN = process.env.DRY_RUN === '1';
const PK = process.env.EVM_PRIVATE_KEY;
if (!PK) { console.error('EVM_PRIVATE_KEY not set'); process.exit(1); }

const account = privateKeyToAccount(PK.startsWith('0x') ? PK : `0x${PK}`);
const rpc = http('https://mainnet.base.org');
const publicClient  = createPublicClient({ chain: base, transport: rpc });
const walletClient  = createWalletClient({ chain: base, account, transport: rpc });

async function main() {
  console.log(`Wallet: ${account.address}`);

  // --- Safety check ---
  console.log('\nRunning safety check...');
  const safety = await fetch(`${FLOW_API}/launches/${AUCTION}/safety`).then(r => r.json());
  const highRisks = safety.risks?.filter(r => r.level === 'HIGH') ?? [];
  const medRisks  = safety.risks?.filter(r => r.level === 'MEDIUM') ?? [];
  console.log(`  HIGH risks: ${highRisks.length} | MEDIUM: ${medRisks.length}`);
  highRisks.forEach(r => console.log(`  ⚠️  [HIGH] ${r.message}`));
  medRisks.forEach(r => console.log(`  🟡 [MED] ${r.message}`));
  if (!safety.rawMetrics?.tokenWasDeployed) {
    console.error('❌ Token was NOT deployed via Flow — aborting');
    process.exit(1);
  }

  // --- Build transactions via Flow API ---
  console.log(`\nBuilding bid transactions ($${BID_AMOUNT_USD} at max FDV $${MAX_FDV_USD.toLocaleString()})...`);
  const buildRes = await fetch(`${FLOW_API}/bids/build-tx`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bidder: account.address,
      auctionAddress: AUCTION,
      maxFdvUsd: MAX_FDV_USD,
      amount: BID_AMOUNT_USD,
    }),
  });
  if (!buildRes.ok) {
    const err = await buildRes.json().catch(() => ({}));
    console.error('❌ build-tx failed:', err.error || buildRes.status);
    process.exit(1);
  }
  const { transactions } = await buildRes.json();
  console.log(`  Got ${transactions.length} transactions`);
  transactions.forEach(tx => console.log(`  Step ${tx.step}: ${tx.description} → ${tx.to}`));

  // --- Pre-flight summary ---
  console.log(`\n📊 Pre-flight`);
  console.log(`  Bid:         $${BID_AMOUNT_USD} USDC`);
  console.log(`  Max FDV:     $${MAX_FDV_USD.toLocaleString()} (fills at clearing)`);
  console.log(`  Auction:     ${AUCTION}`);
  console.log(`  Start block: ${START_BLOCK}`);

  if (DRY_RUN) { console.log('\n[DRY RUN] Stopping here.'); return; }

  // --- Wait for startBlock ---
  let currentBlock = await publicClient.getBlockNumber();
  if (currentBlock < START_BLOCK) {
    console.log(`\nCurrent block ${currentBlock}, waiting for ${START_BLOCK}...`);
    while (currentBlock < START_BLOCK) {
      const blocksLeft = START_BLOCK - currentBlock;
      process.stdout.write(`\r  ${blocksLeft} blocks left (~${Math.round(Number(blocksLeft)*2)}s)   `);
      await new Promise(r => setTimeout(r, 2000));
      currentBlock = await publicClient.getBlockNumber();
    }
    console.log('\n🟢 Auction open!');
  } else {
    console.log(`\n🟢 Auction already open (block ${currentBlock})`);
  }

  // --- Submit transactions sequentially ---
  for (const tx of transactions.sort((a, b) => a.step - b.step)) {
    console.log(`\nSubmitting step ${tx.step}: ${tx.description}...`);
    const hash = await walletClient.sendTransaction({
      to: tx.to,
      data: tx.data,
      value: BigInt(tx.value ?? '0'),
    });
    console.log(`  TX: https://basescan.org/tx/${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  Confirmed block ${receipt.blockNumber} ✅`);
  }

  console.log(`\n🎉 Bid placed! View: https://flow.bid/base/${AUCTION}`);

  // --- Confirm via API ---
  await new Promise(r => setTimeout(r, 5000));
  const bids = await fetch(`${FLOW_API}/user/${account.address}/bids`).then(r => r.json());
  const myBid = bids.bids?.find(b => b.auctionAddress?.toLowerCase() === AUCTION.toLowerCase());
  if (myBid) {
    console.log(`✅ Bid confirmed on-chain: bidId=${myBid.bidId}, amount=${myBid.amountBid} USDC`);
  }
}

main().catch(e => { console.error('Error:', e.message || e); process.exit(1); });
