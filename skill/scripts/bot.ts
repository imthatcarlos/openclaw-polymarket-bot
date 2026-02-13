#!/usr/bin/env tsx
/**
 * Polymarket BTC 5-Min Trading Bot
 * Uses Stochastic RSI to predict short-term BTC direction
 * and places orders on Polymarket 5-min BTC up/down markets.
 */

import { ClobClient } from "@polymarket/clob-client";
import { ethers } from "ethers";
import { readFileSync, writeFileSync } from "fs";

// ── Dedup: track which 5-min windows we've already traded ───
const TRADED_FILE = "/root/.openclaw/workspace/polymarket-btc-skill/.traded-windows.json";
function getTradedWindows(): Record<string, boolean> {
  try { return JSON.parse(readFileSync(TRADED_FILE, "utf8")); } catch { return {}; }
}
function markWindowTraded(slug: string) {
  const windows = getTradedWindows();
  windows[slug] = true;
  // Keep only last 50 entries to avoid unbounded growth
  const keys = Object.keys(windows);
  if (keys.length > 50) { for (const k of keys.slice(0, keys.length - 50)) delete windows[k]; }
  writeFileSync(TRADED_FILE, JSON.stringify(windows));
}

// ── Config ──────────────────────────────────────────────────
const DRY_RUN = process.argv.includes("--dry-run");
const POSITION_SIZE = 5; // ~$5 per trade
const PRICE = 0.5; // limit price
const HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;
const BINANCE_URL = "https://api.binance.us/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=60";
const COINGECKO_URL = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&precision=2";
// Market slug is deterministic: btc-updown-5m-{unix_timestamp} where timestamp = start of 5-min window
const GAMMA_EVENTS_URL = "https://gamma-api.polymarket.com/events";

// ── Proxy (EU region to bypass US geo-block) ────────────────
const PROXY_URL = "https://polymarket-proxy-production.up.railway.app";
const PROXY_SECRET = process.env.PROXY_SECRET || "";

async function proxiedFetch(targetUrl: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers || {});
  headers.set("x-target-url", targetUrl);
  headers.set("x-proxy-secret", PROXY_SECRET);
  return fetch(PROXY_URL, { ...init, headers });
}

// ── Indicators ──────────────────────────────────────────────

function calcRSI(closes: number[], period = 14): number[] {
  const rsi: number[] = [];
  if (closes.length < period + 1) return rsi;

  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff; else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;

  rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period;
    rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return rsi;
}

function sma(arr: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = period - 1; i < arr.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += arr[j];
    result.push(sum / period);
  }
  return result;
}

function calcStochRSI(closes: number[], rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3) {
  const rsiValues = calcRSI(closes, rsiPeriod);
  if (rsiValues.length < stochPeriod) return { k: [], d: [], lastK: NaN, lastD: NaN };

  // Stochastic of RSI
  const rawK: number[] = [];
  for (let i = stochPeriod - 1; i < rsiValues.length; i++) {
    const window = rsiValues.slice(i - stochPeriod + 1, i + 1);
    const min = Math.min(...window);
    const max = Math.max(...window);
    rawK.push(max === min ? 50 : ((rsiValues[i] - min) / (max - min)) * 100);
  }

  const k = sma(rawK, kSmooth);
  const d = sma(k, dSmooth);

  return { k, d, lastK: k[k.length - 1] ?? NaN, lastD: d[d.length - 1] ?? NaN };
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  console.log(`\n🤖 Polymarket BTC 5-Min Bot ${DRY_RUN ? "(DRY RUN)" : "(LIVE)"}`);
  console.log(`   ${new Date().toISOString()}\n`);

  // 1. Fetch candles
  console.log("📊 Fetching 60 x 1-min BTC candles from Binance...");
  const res = await fetch(BINANCE_URL);
  const klines = await res.json() as any[];
  const closes = klines.map((k: any) => parseFloat(k[4]));
  console.log(`   Got ${closes.length} candles. Latest close: $${closes[closes.length - 1]}`);

  // Cross-check with CoinGecko
  const cgRes = await fetch(COINGECKO_URL);
  const cgData = await cgRes.json() as any;
  const cgPrice = cgData?.bitcoin?.usd;
  const binancePrice = closes[closes.length - 1];
  const priceDiff = Math.abs(binancePrice - cgPrice);
  const priceDiffPct = (priceDiff / binancePrice * 100).toFixed(3);
  console.log(`   CoinGecko:  $${cgPrice} (diff: $${priceDiff.toFixed(2)} / ${priceDiffPct}%)`);
  
  if (parseFloat(priceDiffPct) > 0.5) {
    console.log(`\n⚠️  Price sources diverge >0.5%. Skipping to avoid bad signal.`);
    return;
  }

  // 2-3. Calculate Stochastic RSI
  const { lastK, lastD } = calcStochRSI(closes, 14, 14, 3, 3);
  console.log(`\n📈 Stochastic RSI(14,14,3,3):`);
  console.log(`   K = ${lastK.toFixed(2)}, D = ${lastD.toFixed(2)}`);

  // 4. Momentum analysis
  const mom5 = closes.length > 5 ? ((closes[closes.length-1] - closes[closes.length-6]) / closes[closes.length-6] * 100) : 0;
  const mom10 = closes.length > 10 ? ((closes[closes.length-1] - closes[closes.length-11]) / closes[closes.length-11] * 100) : 0;
  
  // EMA 20 for trend direction
  let ema20 = closes.slice(0, 20).reduce((a, b) => a + b, 0) / 20;
  for (let i = 20; i < closes.length; i++) ema20 = (closes[i] - ema20) * 2/21 + ema20;
  const priceVsEma = closes[closes.length-1] - ema20;
  const trendUp = priceVsEma > 0;
  
  console.log(`\n📊 Momentum:`);
  console.log(`   Mom5: ${mom5.toFixed(3)}% | Mom10: ${mom10.toFixed(3)}%`);
  console.log(`   EMA20: ${ema20.toFixed(2)} | Price ${trendUp ? "ABOVE" : "BELOW"} (${priceVsEma > 0 ? "+" : ""}${priceVsEma.toFixed(2)})`);

  // 5. Rate of change (acceleration) — is momentum accelerating or decelerating?
  const mom3 = closes.length > 3 ? ((closes[closes.length-1] - closes[closes.length-4]) / closes[closes.length-4] * 100) : 0;
  const momAccel = mom3 - mom5; // positive = momentum accelerating, negative = decelerating
  console.log(`   Mom3: ${mom3.toFixed(3)}% | Acceleration: ${momAccel > 0 ? "+" : ""}${momAccel.toFixed(4)}%`);

  // 6. Combined signal: StochRSI + Momentum + Trend confirmation
  //    LESSON from live trades: counter-trend bets (UP in downtrend) lose.
  //    Only take trades WITH the prevailing trend, or strong mean-reversion at extremes.
  let signal: "UP" | "DOWN" | null = null;
  let reason = "";
  
  if (lastK < 15 && lastK > lastD) {
    // Bullish crossover from deeply oversold — only if trend supports it
    if (trendUp && mom5 > -0.05) {
      signal = "UP";
      reason = "deep oversold K/D crossover + uptrend confirmed";
    } else {
      console.log(`\n⏸️  Oversold crossover but downtrend (EMA: ${trendUp ? "UP" : "DOWN"}, Mom5: ${mom5.toFixed(3)}%). Don't catch falling knives.`);
      return;
    }
  } else if (lastK > 85 && lastK < lastD) {
    // Bearish crossover from deeply overbought — only if trend supports it
    if (!trendUp && mom5 < 0.05) {
      signal = "DOWN";
      reason = "deep overbought K/D crossover + downtrend confirmed";
    } else {
      console.log(`\n⏸️  Overbought crossover but uptrend (EMA: ${trendUp ? "UP" : "DOWN"}, Mom5: ${mom5.toFixed(3)}%). Don't short the rip.`);
      return;
    }
  } else if (lastK < 10) {
    // Extremely oversold (K<10) — only bet UP if multiple confirmations
    if (trendUp && mom3 > 0 && momAccel > 0) {
      signal = "UP";
      reason = `extremely oversold (K=${lastK.toFixed(1)}) + uptrend + momentum accelerating`;
    } else {
      console.log(`\n⏸️  Extremely oversold but no trend/momentum confirmation. Skipping.`);
      return;
    }
  } else if (lastK > 90) {
    // Extremely overbought (K>90) — only bet DOWN if multiple confirmations
    if (!trendUp && mom3 < 0 && momAccel < 0) {
      signal = "DOWN";
      reason = `extremely overbought (K=${lastK.toFixed(1)}) + downtrend + momentum decelerating`;
    } else {
      console.log(`\n⏸️  Extremely overbought but no trend/momentum confirmation. Skipping.`);
      return;
    }
  }

  if (!signal) {
    console.log(`\n⏸️  No signal (K=${lastK.toFixed(2)}, neutral zone or insufficient confirmation). Skipping.`);
    return;
  }
  console.log(`\n🎯 Signal: ${signal} (${reason})`);

  // 5. Find active market (deterministic slug: btc-updown-5m-{start_timestamp})
  const now = Math.floor(Date.now() / 1000);
  const currentWindowStart = Math.floor(now / 300) * 300;
  const nextWindowStart = currentWindowStart + 300;
  const timeIntoWindow = now - currentWindowStart;
  
  // Only trade the current window — skip if >3 min in (need time for price to move)
  if (timeIntoWindow > 180) {
    console.log(`   ⏭️ ${300 - timeIntoWindow}s left in window — too late, skipping.`);
    return;
  }
  const targetStart = currentWindowStart;
  const slug = `btc-updown-5m-${targetStart}`;
  
  // Dedup: skip if we already traded this window
  if (getTradedWindows()[slug]) {
    console.log(`\n⏭️ Already traded window ${slug}. Skipping.`);
    return;
  }

  console.log(`\n🔍 Looking for market: ${slug}`);
  console.log(`   Window: ${new Date(targetStart * 1000).toISOString()} → ${new Date((targetStart + 300) * 1000).toISOString()}`);
  
  const gammaRes = await proxiedFetch(`${GAMMA_EVENTS_URL}/slug/${slug}`);
  const event = await gammaRes.json() as any;
  const events = event?.id ? [event] : [];

  if (!events.length || !events[0].markets?.length) {
    console.log("   ❌ Market not found. It may not be created yet.");
    return;
  }

  const market = events[0].markets[0];
  console.log(`   Found: "${market.question}"`);
  console.log(`   End: ${market.endDate}`);

  // 6. Extract token IDs
  const clobTokenIds: string[] = JSON.parse(market.clobTokenIds);
  const outcomes: string[] = JSON.parse(market.outcomes);
  console.log(`   Outcomes: ${outcomes.join(", ")}`);

  // Map: first=Up, second=Down
  const tokenIndex = signal === "UP" ? 0 : 1;
  const tokenID = clobTokenIds[tokenIndex];
  const outcomeName = outcomes[tokenIndex];
  
  // Get current market prices
  const outcomePrices: string[] = JSON.parse(market.outcomePrices || '["0.5","0.5"]');
  const currentPrice = parseFloat(outcomePrices[tokenIndex]);
  // Bid slightly above current price to increase fill probability, cap at 0.65
  const bidPrice = Math.min(parseFloat((currentPrice + 0.02).toFixed(2)), 0.65);
  
  console.log(`   Betting on: ${outcomeName} → token ${tokenID.slice(0, 16)}...`);
  console.log(`   Current price: $${currentPrice.toFixed(2)} → bidding $${bidPrice.toFixed(2)}`);

  // 7. Place order
  const size = Math.floor(POSITION_SIZE / bidPrice); // number of tokens
  console.log(`\n💰 Order: BUY ${size} ${outcomeName} tokens @ $${bidPrice} ($${(size * bidPrice).toFixed(2)} total)`);

  if (DRY_RUN) {
    console.log("\n✅ DRY RUN — order NOT placed.");
    console.log("   Would have placed:");
    console.log(`   { tokenID: "${tokenID}", price: ${bidPrice}, side: "BUY", size: ${size} }`);
    return;
  }

  // Live trading
  if (!process.env.EVM_PRIVATE_KEY) {
    console.error("❌ EVM_PRIVATE_KEY not set!");
    process.exit(1);
  }

  const provider = new ethers.providers.JsonRpcProvider("https://polygon-rpc.com");
  const signer = new ethers.Wallet(process.env.EVM_PRIVATE_KEY!, provider);

  console.log(`   Wallet: ${signer.address}`);

  // Route all CLOB requests through EU proxy to bypass US geo-block
  const CLOB_HOST = `${PROXY_URL}`;
  
  const client = new ClobClient(CLOB_HOST, CHAIN_ID, signer);
  console.log("   Deriving API key (via EU proxy)...");
  let apiCreds: any;
  try {
    apiCreds = await client.createOrDeriveApiKey();
    console.log("   API key:", apiCreds.key || apiCreds.apiKey || "✓");
    if (apiCreds.key && !apiCreds.apiKey) apiCreds.apiKey = apiCreds.key;
  } catch (e: any) {
    console.error("   ❌ API key derivation failed:", e.message || e);
    return;
  }
  
  // EOA direct trading (signatureType 0), funds in EOA wallet
  const authedClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer, apiCreds, 0, signer.address);

  const order = await authedClient.createOrder({
    tokenID: tokenID,
    price: bidPrice,
    side: "BUY" as any,
    size: size,
  });

  const result = await authedClient.postOrder(order);
  console.log("\n✅ Order placed!", result);

  // Mark this window as traded so we don't double-bet
  markWindowTraded(slug);
}

main().catch((err) => {
  console.error("❌ Error:", err.message || err);
  process.exit(1);
});
