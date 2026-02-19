/**
 * Polymarket BTC 15-Min Trading Bot v8.1 — "Last Look"
 * 
 * Strategy: Trade in the LAST 120 seconds of each 15-min window when the
 * outcome is nearly certain. At 780s+, if BTC has moved significantly from
 * the window open price, the settlement direction is almost locked in.
 * 
 * We use Bybit real-time price as primary signal and the on-chain Chainlink
 * push feed (Polygon) as secondary confirmation. Both track the same
 * underlying exchanges that Chainlink Data Streams uses for settlement.
 * 
 * Even buying at $0.80-0.85 is profitable when you KNOW the outcome.
 * The edge isn't speed — it's timing. We wait until uncertainty is gone.
 */

import express from "express";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import { PriceEngine } from "./price-engine.js";
import { findCurrentMarket, checkMarketOutcome, type MarketInfo } from "./market-engine.js";
import { ClobClient } from "@polymarket/clob-client";
import { ethers } from "ethers";

// ── Config ──────────────────────────────────────────────────
const PROXY_URL = process.env.PROXY_URL || "https://polymarket-proxy-production.up.railway.app";
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const STATE_FILE = new URL("../state.json", import.meta.url).pathname;
const PM_FILE = new URL("../post-mortems.jsonl", import.meta.url).pathname;
const BOT_PORT = parseInt(process.env.BOT_PORT || "3847");
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const WALLET_ADDRESS = process.env.WALLET_ADDRESS || "0x1a1E1b82Da7E91E9567a40b0f952748b586389F9";
const CHAINLINK_BTC_USD_POLYGON = "0xc907E116054Ad103354f2D350FD2514433D57F6f";

// ── Last Look Config ────────────────────────────────────────
interface LastLookConfig {
  // Timing: only trade in the last N seconds of window
  entryWindowStart: number;    // Earliest entry (default 780 = last 120s of 15-min window)
  entryWindowEnd: number;      // Latest entry (default 870 = stop 30s before close)
  
  // Signal thresholds
  minDeltaAbsolute: number;    // Min BTC move in $ (default $50)
  minDeltaPercent: number;     // Min BTC move in % (default 0.07%)
  
  // Pricing
  maxEntryPrice: number;       // Max price to pay for winning side (default $0.88)
  
  // Position sizing
  positionSize: number;        // Base size floor (default $50)
  maxPositionSize: number;     // Cap (default $500)
  compoundFraction: number;    // % of wallet per trade (default 0.20 = 20%)
  
  // Confirmation
  requireChainlinkConfirm: boolean;  // Require on-chain CL feed to agree (default true)
  maxChainlinkAge: number;           // Max age of CL price in seconds (default 60)
  
  // Safety
  cooldownMs: number;          // Min time between trades (default 30000)
  pnlFloor: number;            // Auto-pause at this P&L (default -$100)
  dryRun: boolean;
}

const DEFAULT_CONFIG: LastLookConfig = {
  entryWindowStart: 780,
  entryWindowEnd: 870,
  minDeltaAbsolute: 50,
  minDeltaPercent: 0.07,
  maxEntryPrice: 0.88,
  positionSize: 50,
  maxPositionSize: 500,
  compoundFraction: 0.20,
  requireChainlinkConfirm: true,
  maxChainlinkAge: 60,
  cooldownMs: 30000,
  pnlFloor: -100,
  dryRun: true,
};

// ── Types ───────────────────────────────────────────────────
interface Trade {
  timestamp: number;
  market: string;
  windowStart: number;
  direction: "UP" | "DOWN";
  price: number;
  size: number;
  cost: number;
  result: "win" | "loss" | "pending" | "dry-run";
  pnl: number;
  orderId?: string;
  conditionId?: string;
  walletBefore?: number;
  walletAfter?: number;
  btcAtEntry: number;
  btcWindowOpen: number;
  deltaAtEntry: number;
  timeInWindow: number;
  chainlinkPrice: number;
  chainlinkAge: number;
  bestAskAtEntry: number;
  hourUTC: number;
  reasons: string[];
}

interface BotState {
  config: LastLookConfig;
  trades: Trade[];
  totalPnL: number;
  wins: number;
  losses: number;
  skips: number;
  paused: boolean;
  sessionStartBalance?: number;
}

// ── Wallet Helpers ──────────────────────────────────────────
let provider: ethers.providers.Provider | null = null;
let signer: ethers.Wallet | null = null;

function getProvider(): ethers.providers.Provider {
  if (!provider) {
    provider = new ethers.providers.StaticJsonRpcProvider(RPC_URL, { name: "polygon", chainId: 137 });
  }
  return provider;
}

async function getWalletBalance(): Promise<number> {
  try {
    const p = getProvider();
    const usdc = new ethers.Contract(USDC_ADDRESS, ["function balanceOf(address) view returns (uint256)"], p);
    const bal = await usdc.balanceOf(WALLET_ADDRESS);
    return parseFloat(ethers.utils.formatUnits(bal, 6));
  } catch (e: any) {
    console.error("[wallet] Balance check failed:", e.message);
    return -1;
  }
}

async function getDynamicGas(): Promise<{ gasPrice: any }> {
  const prov = signer!.provider! as any;
  const gasPrice = await prov.getGasPrice();
  const bumped = gasPrice.mul(130).div(100);
  return { gasPrice: bumped };
}

async function redeemPosition(conditionId: string): Promise<boolean> {
  if (!signer) return false;
  try {
    const ctf = new ethers.Contract(CTF_ADDRESS, [
      "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external"
    ], signer);
    const tx = await ctf.redeemPositions(
      USDC_ADDRESS, ethers.constants.HashZero, conditionId, [1, 2],
      { ...(await getDynamicGas()), gasLimit: 300000 }
    );
    console.log(`[redeem] TX: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`[redeem] ${receipt.status === 1 ? "SUCCESS" : "FAILED"}`);
    return receipt.status === 1;
  } catch (e: any) {
    console.error(`[redeem] Failed: ${e.message}`);
    return false;
  }
}

// ── Chainlink On-Chain Price Feed ───────────────────────────
let chainlinkFeed: ethers.Contract | null = null;
let lastChainlinkPrice = 0;
let lastChainlinkTimestamp = 0;
let lastChainlinkFetchTime = 0;

async function getChainlinkPrice(): Promise<{ price: number; age: number }> {
  // Cache for 5s to avoid hammering RPC
  if (Date.now() - lastChainlinkFetchTime < 5000 && lastChainlinkPrice > 0) {
    return { price: lastChainlinkPrice, age: Math.floor(Date.now() / 1000) - lastChainlinkTimestamp };
  }
  
  try {
    if (!chainlinkFeed) {
      const p = getProvider();
      chainlinkFeed = new ethers.Contract(CHAINLINK_BTC_USD_POLYGON, [
        "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
        "function decimals() view returns (uint8)"
      ], p);
    }
    const [, price, , updatedAt] = await chainlinkFeed.latestRoundData();
    const dec = await chainlinkFeed.decimals();
    lastChainlinkPrice = parseFloat(ethers.utils.formatUnits(price, dec));
    lastChainlinkTimestamp = updatedAt.toNumber();
    lastChainlinkFetchTime = Date.now();
    const age = Math.floor(Date.now() / 1000) - lastChainlinkTimestamp;
    return { price: lastChainlinkPrice, age };
  } catch (e: any) {
    console.error("[chainlink] Feed error:", e.message);
    return { price: lastChainlinkPrice, age: 999 };
  }
}

// ── State ───────────────────────────────────────────────────
function loadState(): BotState {
  if (existsSync(STATE_FILE)) {
    try {
      const s = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
      return {
        config: { ...DEFAULT_CONFIG, ...s.config },
        trades: s.trades ?? [],
        totalPnL: s.totalPnL ?? 0,
        wins: s.wins ?? 0,
        losses: s.losses ?? 0,
        skips: s.skips ?? 0,
        paused: s.paused ?? false,
        sessionStartBalance: s.sessionStartBalance ?? undefined,
      };
    } catch {}
  }
  return { config: { ...DEFAULT_CONFIG }, trades: [], totalPnL: 0, wins: 0, losses: 0, skips: 0, paused: false };
}

function saveState() {
  try {
    writeFileSync(STATE_FILE, JSON.stringify({
      config: state.config,
      trades: state.trades.slice(-200),
      totalPnL: state.totalPnL,
      wins: state.wins,
      losses: state.losses,
      skips: state.skips,
      paused: state.paused,
      sessionStartBalance: state.sessionStartBalance,
    }, null, 2));
  } catch {}
}

const state = loadState();
const priceEngine = new PriceEngine();
let clobClient: any = null;
let startedAt = Date.now();
let tickCount = 0;
let checkCount = 0;
let lastTradeTime = 0;
let windowOpenPrices: Map<number, number> = new Map();
let tradedWindows: Set<number> = new Set();
let lastSignalLog = "";

// Populate tradedWindows from existing trades
for (const t of state.trades) {
  if (t.windowStart) tradedWindows.add(t.windowStart);
}

// ── CLOB Client ─────────────────────────────────────────────
async function initClobClient() {
  if (!process.env.EVM_PRIVATE_KEY) {
    console.log("[bot] No EVM_PRIVATE_KEY — dry run only");
    return null;
  }
  try {
    const p = getProvider();
    signer = new ethers.Wallet(process.env.EVM_PRIVATE_KEY, p);
    console.log(`[bot] Wallet: ${signer.address}`);
    const client = new ClobClient(PROXY_URL, 137, signer);
    const creds = await client.createOrDeriveApiKey();
    if ((creds as any).key && !(creds as any).apiKey) (creds as any).apiKey = (creds as any).key;
    const authed = new ClobClient(PROXY_URL, 137, signer, creds, 0, signer.address);
    console.log("[bot] CLOB client authenticated ✅");
    return authed;
  } catch (e: any) {
    console.error("[bot] CLOB init error:", e.message);
    return null;
  }
}

// ── Settlement ──────────────────────────────────────────────
async function settleTrades() {
  const pending = state.trades.filter(t => t.result === "pending");
  for (const trade of pending) {
    if (Date.now() / 1000 < trade.windowStart + 960) continue; // 15-min window + 60s buffer

    const winner = await checkMarketOutcome(trade.windowStart);
    if (!winner || winner === "pending") continue;

    const won = (trade.direction === "UP" && winner === "Up") ||
                (trade.direction === "DOWN" && winner === "Down");

    if (won) {
      trade.result = "win";
      state.wins++;

      if (trade.conditionId) {
        console.log(`[settle] Redeeming winning position...`);
        await redeemPosition(trade.conditionId);
      }

      const balAfter = await getWalletBalance();
      trade.walletAfter = balAfter;
      if (trade.walletBefore != null && trade.walletBefore >= 0 && balAfter >= 0) {
        trade.pnl = balAfter - trade.walletBefore;
      } else {
        trade.pnl = trade.size * 1.0 - trade.cost;
      }
      console.log(`[settle] ✅ WIN ${trade.direction} | Bought ${trade.size} @ $${trade.price.toFixed(2)} | P&L: +$${trade.pnl.toFixed(2)} | ${state.wins}W/${state.losses}L`);
    } else {
      trade.result = "loss";
      state.losses++;

      const balAfter = await getWalletBalance();
      trade.walletAfter = balAfter;
      if (trade.walletBefore != null && trade.walletBefore >= 0 && balAfter >= 0) {
        trade.pnl = balAfter - trade.walletBefore;
      } else {
        trade.pnl = -trade.cost;
      }
      console.log(`[settle] ❌ LOSS ${trade.direction} | Cost: $${trade.cost.toFixed(2)} | P&L: $${trade.pnl.toFixed(2)} | ${state.wins}W/${state.losses}L`);

      try {
        appendFileSync(PM_FILE, JSON.stringify({
          timestamp: new Date().toISOString(),
          strategy: "last-look-v8",
          direction: trade.direction,
          cost: trade.cost,
          price: trade.price,
          btcDelta: trade.deltaAtEntry,
          timeInWindow: trade.timeInWindow,
          chainlinkPrice: trade.chainlinkPrice,
          bestAsk: trade.bestAskAtEntry,
          reasons: trade.reasons,
        }) + "\n");
      } catch {}
    }

    state.totalPnL += trade.pnl;

    const currentBal = trade.walletAfter ?? await getWalletBalance();
    if (state.sessionStartBalance != null && currentBal >= 0) {
      const sessionPnL = currentBal - state.sessionStartBalance;
      console.log(`[settle] Session P&L: $${sessionPnL.toFixed(2)} (wallet: $${currentBal.toFixed(2)})`);
    }

    saveState();

    // Circuit breaker
    if (state.totalPnL <= state.config.pnlFloor) {
      console.log(`[circuit-breaker] 🛑 P&L $${state.totalPnL.toFixed(2)} hit floor $${state.config.pnlFloor}. Auto-pausing.`);
      state.paused = true;
      saveState();
      return;
    }
  }
}

// ── Core Tick Handler ───────────────────────────────────────
let checking = false;

async function onTick(price: number) {
  if (state.paused || checking) return;
  tickCount++;

  const now = Math.floor(Date.now() / 1000);
  const currentWindowStart = Math.floor(now / 900) * 900;
  const timeInWindow = now - currentWindowStart;

  // Track window open price
  if (!windowOpenPrices.has(currentWindowStart)) {
    windowOpenPrices.set(currentWindowStart, price);
    for (const [k] of windowOpenPrices) {
      if (k < currentWindowStart - 3600) windowOpenPrices.delete(k);
    }
  }

  // Periodic tick log
  if (tickCount % 120 === 1) {
    const pending = state.trades.filter(t => t.result === "pending").length;
    console.log(`[tick] #${tickCount} price=$${price.toFixed(2)} window=${timeInWindow}s | pending=${pending}`);
  }

  // ── TIMING GATE: Only trade in last 60 seconds ──
  if (timeInWindow < state.config.entryWindowStart || timeInWindow > state.config.entryWindowEnd) return;

  // Already traded this window
  if (tradedWindows.has(currentWindowStart)) return;

  // Cooldown
  if (Date.now() - lastTradeTime < state.config.cooldownMs) return;

  const windowOpenPrice = windowOpenPrices.get(currentWindowStart);
  if (!windowOpenPrice) return;

  // Quick delta pre-check
  const delta = price - windowOpenPrice;
  const absDelta = Math.abs(delta);
  const deltaPct = (absDelta / windowOpenPrice) * 100;
  if (absDelta < state.config.minDeltaAbsolute || deltaPct < state.config.minDeltaPercent) return;

  // We have a signal candidate — do the full check
  checking = true;
  checkCount++;

  try {
    // Settle old trades first
    await settleTrades();

    const direction: "UP" | "DOWN" = delta > 0 ? "UP" : "DOWN";
    const reasons: string[] = [];

    reasons.push(`BTC: $${price.toFixed(0)} | Open: $${windowOpenPrice.toFixed(0)} | Δ: ${delta > 0 ? "+" : ""}$${delta.toFixed(0)} (${(delta/windowOpenPrice*100).toFixed(3)}%) | ${timeInWindow}s into window`);

    // ── Chainlink confirmation ──
    const cl = await getChainlinkPrice();
    const clDelta = cl.price - windowOpenPrice;
    const clAgrees = (direction === "UP" && clDelta > 0) || (direction === "DOWN" && clDelta < 0);
    
    reasons.push(`Chainlink: $${cl.price.toFixed(2)} (${cl.age}s old) | Δ: ${clDelta > 0 ? "+" : ""}$${clDelta.toFixed(0)} | ${clAgrees ? "✅ AGREES" : "⚠️ DISAGREES"}`);

    if (state.config.requireChainlinkConfirm) {
      if (cl.age > state.config.maxChainlinkAge) {
        reasons.push(`SKIP: Chainlink too stale (${cl.age}s > ${state.config.maxChainlinkAge}s)`);
        logSignal(reasons);
        checking = false;
        return;
      }
      if (!clAgrees) {
        reasons.push(`SKIP: Chainlink disagrees with Bybit direction`);
        logSignal(reasons);
        state.skips++;
        checking = false;
        return;
      }
      // Require CL delta to be at least 50% of Bybit delta — weak CL = unreliable move
      const clDeltaRatio = Math.abs(clDelta) / Math.abs(delta);
      if (clDeltaRatio < 0.5) {
        reasons.push(`SKIP: Chainlink delta too weak (${(clDeltaRatio * 100).toFixed(0)}% of Bybit, need ≥50%) | CL Δ: $${Math.abs(clDelta).toFixed(0)} vs Bybit Δ: $${Math.abs(delta).toFixed(0)}`);
        logSignal(reasons);
        state.skips++;
        checking = false;
        return;
      }
      reasons.push(`CL delta ratio: ${(clDeltaRatio * 100).toFixed(0)}% of Bybit ✅`);
    }

    // ── Get market + orderbook ──
    const market = await findCurrentMarket();
    if (!market) {
      reasons.push("SKIP: Market not found");
      logSignal(reasons);
      checking = false;
      return;
    }

    priceEngine.subscribeMarket(market.upTokenId, market.downTokenId);

    // Update with live book data
    const pb = priceEngine.polyBook;
    const bookAge = Date.now() - pb.lastUpdate;
    if (pb.lastUpdate > 0 && bookAge < 10000) {
      market.upBestAsk = pb.upBestAsk;
      market.downBestAsk = pb.downBestAsk;
      market.upBestBid = pb.upBestBid;
      market.downBestBid = pb.downBestBid;
      market.upAskDepth = pb.upAskDepth;
      market.downAskDepth = pb.downAskDepth;
    }

    const bestAsk = direction === "UP" ? market.upBestAsk : market.downBestAsk;
    const askDepth = direction === "UP" ? market.upAskDepth : market.downAskDepth;

    reasons.push(`Book: UP bid=$${market.upBestBid.toFixed(2)} ask=$${market.upBestAsk.toFixed(2)} | DOWN bid=$${market.downBestBid.toFixed(2)} ask=$${market.downBestAsk.toFixed(2)}`);

    // ── Price check: is entry price acceptable? ──
    let bidPrice: number;
    if (bestAsk > 0 && bestAsk <= state.config.maxEntryPrice) {
      // Bid 2¢ above best ask to guarantee fill (cross the spread aggressively)
      bidPrice = Math.min(bestAsk + 0.02, state.config.maxEntryPrice);
      const expectedProfit = (1.0 - bidPrice) * 100;
      reasons.push(`Entry: $${bidPrice.toFixed(2)} (ask $${bestAsk.toFixed(2)} + 2¢, ${askDepth.toFixed(0)} depth) | Profit: ${expectedProfit.toFixed(0)}¢/token`);
    } else if (bestAsk > state.config.maxEntryPrice) {
      reasons.push(`SKIP: Ask $${bestAsk.toFixed(2)} > max $${state.config.maxEntryPrice} — too expensive`);
      logSignal(reasons);
      state.skips++;
      checking = false;
      return;
    } else {
      // No ask data — use mid + 15¢ to aggressively cross spread
      // At 240s+ with $50+ delta, mid is unreliable. Overpay slightly to guarantee fill.
      const midPrice = direction === "UP" ? market.upPrice : market.downPrice;
      bidPrice = Math.min(parseFloat((midPrice + 0.15).toFixed(2)), state.config.maxEntryPrice);
      reasons.push(`Entry: $${bidPrice.toFixed(2)} (mid $${midPrice.toFixed(2)} + 15¢, no ask data) | Profit: ${((1.0 - bidPrice) * 100).toFixed(0)}¢/token`);
    }

    // ── Confidence check: is profit margin worth the risk? ──
    const profitPerToken = 1.0 - bidPrice;
    if (profitPerToken < 0.10) {
      reasons.push(`SKIP: Profit margin too thin (${(profitPerToken * 100).toFixed(0)}¢ < 10¢)`);
      logSignal(reasons);
      state.skips++;
      checking = false;
      return;
    }

    // ── Position sizing ──
    let walletBalance = await getWalletBalance();
    if (walletBalance < 0) walletBalance = 500;

    const tradeSize = Math.min(
      Math.max(walletBalance * state.config.compoundFraction, state.config.positionSize),
      state.config.maxPositionSize
    );
    const size = Math.floor(tradeSize / bidPrice);
    if (size < 1) { checking = false; return; }
    const cost = size * bidPrice;

    reasons.push(`Size: ${size} tokens × $${bidPrice.toFixed(2)} = $${cost.toFixed(2)} (${(state.config.compoundFraction * 100).toFixed(0)}% of $${walletBalance.toFixed(0)})`);
    reasons.push(`🎯 LAST LOOK: ${direction} | ${timeInWindow}s in | Δ$${absDelta.toFixed(0)} | CL confirms | Profit margin: ${(profitPerToken * 100).toFixed(0)}¢/token`);

    console.log(`\n[bot] 🎯 ${direction} | ${size} tokens @ $${bidPrice.toFixed(2)} = $${cost.toFixed(2)} | ${timeInWindow}s into window (${900 - timeInWindow}s left)`);
    reasons.forEach(r => console.log(`  → ${r}`));

    // ── Execute ──
    const trade: Trade = {
      timestamp: Date.now(),
      market: market.slug,
      windowStart: currentWindowStart,
      direction,
      price: bidPrice,
      size,
      cost,
      result: state.config.dryRun ? "dry-run" : "pending",
      pnl: 0,
      conditionId: market.conditionId,
      btcAtEntry: price,
      btcWindowOpen: windowOpenPrice,
      deltaAtEntry: delta,
      timeInWindow,
      chainlinkPrice: cl.price,
      chainlinkAge: cl.age,
      bestAskAtEntry: bestAsk,
      hourUTC: new Date().getUTCHours(),
      reasons,
    };

    if (!state.config.dryRun && clobClient) {
      const balBefore = await getWalletBalance();
      trade.walletBefore = balBefore;

      if (balBefore >= 0 && balBefore < cost) {
        const availableCost = Math.floor((balBefore - 1) * 100) / 100;
        if (availableCost < 5) {
          console.log(`[bot] ❌ Wallet too low: $${balBefore.toFixed(2)}`);
          checking = false;
          return;
        }
        trade.size = Math.floor(availableCost / bidPrice);
        trade.cost = trade.size * bidPrice;
        console.log(`[bot] ⚠️ Sized down: $${cost.toFixed(2)} → $${trade.cost.toFixed(2)} (wallet: $${balBefore.toFixed(2)})`);
      }

      const tokenId = direction === "UP" ? market.upTokenId : market.downTokenId;

      try {
        const order = await clobClient.createOrder({
          tokenID: tokenId,
          price: bidPrice,
          side: "BUY" as any,
          size: trade.size,
        });
        const result = await clobClient.postOrder(order);
        const orderId = result?.orderID || result?.id || null;

        if (!orderId || orderId === "unknown") {
          console.error(`[bot] ❌ Order not placed: ${result?.error || "unknown"}`);
          checking = false;
          return;
        }

        trade.orderId = orderId;
        console.log(`[bot] 📋 Order: ${orderId}`);

        // Wait for fill (we're crossing the spread, should fill fast)
        await new Promise(r => setTimeout(r, 3000));

        try {
          const orderStatus = await clobClient.getOrder(orderId);
          const matched = parseInt(orderStatus?.size_matched || "0");
          const status = orderStatus?.status || "unknown";

          if (matched === 0) {
            console.error(`[bot] ❌ Not filled (status=${status}). Canceling.`);
            try { await clobClient.cancelOrder({ orderID: orderId }); } catch {}
            checking = false;
            return;
          }

          trade.size = matched;
          trade.cost = matched * bidPrice;
          console.log(`[bot] ✅ Filled: ${matched} tokens (status=${status})`);
        } catch (e: any) {
          console.log(`[bot] ⚠️ Can't verify fill (${e.message}), proceeding`);
        }
      } catch (e: any) {
        console.error(`[bot] ❌ Order failed: ${e?.response?.data?.error || e.message}`);
        checking = false;
        return;
      }
    } else {
      console.log("[bot] 🏜️ DRY RUN — would have placed order");
    }

    state.trades.push(trade);
    if (state.trades.length > 200) state.trades.shift();
    tradedWindows.add(currentWindowStart);
    lastTradeTime = Date.now();
    saveState();

  } catch (e: any) {
    console.error(`[bot] Error: ${e.message}`);
  }

  checking = false;
}

function logSignal(reasons: string[]) {
  const sig = reasons.join(" | ").slice(0, 120);
  // Only log if different from last (avoid spam)
  if (sig !== lastSignalLog) {
    console.log(`[signal] ${reasons[reasons.length - 1]}`);
    lastSignalLog = sig;
  }
}

// ── Dry Run Settlement ──────────────────────────────────────
async function settleDryRuns() {
  const pending = state.trades.filter(t => t.result === "dry-run" && t.windowStart > 0);
  for (const trade of pending) {
    if (Date.now() / 1000 < trade.windowStart + 960) continue; // 15-min window + 60s buffer

    const winner = await checkMarketOutcome(trade.windowStart);
    if (!winner || winner === "pending") continue;

    const won = (trade.direction === "UP" && winner === "Up") ||
                (trade.direction === "DOWN" && winner === "Down");

    if (won) {
      trade.pnl = trade.size * 1.0 - trade.cost;
      state.wins++;
      console.log(`[dry-settle] ✅ WIN ${trade.direction} @ $${trade.price.toFixed(2)} | ${trade.size} tokens | +$${trade.pnl.toFixed(2)} (${(trade.pnl / trade.cost * 100).toFixed(0)}% return) | Δ$${trade.deltaAtEntry.toFixed(0)} @ ${trade.timeInWindow}s`);
    } else {
      trade.pnl = -trade.cost;
      state.losses++;
      console.log(`[dry-settle] ❌ LOSS ${trade.direction} @ $${trade.price.toFixed(2)} | -$${trade.cost.toFixed(2)} | Δ$${trade.deltaAtEntry.toFixed(0)} @ ${trade.timeInWindow}s`);
      try {
        appendFileSync(PM_FILE, JSON.stringify({
          timestamp: new Date().toISOString(),
          strategy: "last-look-v8-dry",
          direction: trade.direction,
          delta: trade.deltaAtEntry,
          timeInWindow: trade.timeInWindow,
          price: trade.price,
          chainlinkPrice: trade.chainlinkPrice,
        }) + "\n");
      } catch {}
    }
    trade.result = won ? "win" : "loss";
    state.totalPnL += trade.pnl;
    saveState();
  }
}

// ── Settlement loop (backup) ────────────────────────────────
setInterval(async () => {
  if (!state.paused) {
    if (state.config.dryRun) {
      await settleDryRuns();
    } else {
      await settleTrades();
    }
    saveState();
  }
}, 30_000);

// ── HTTP API ────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.get("/status", async (_req, res) => {
  const nowSec = Math.floor(Date.now() / 1000);
  const cwStart = Math.floor(nowSec / 900) * 900;
  const timeInWindow = nowSec - cwStart;
  const wop = windowOpenPrices.get(cwStart);
  const wallet = await getWalletBalance();
  const sessionPnL = state.sessionStartBalance != null && wallet >= 0
    ? wallet - state.sessionStartBalance : null;
  const cl = await getChainlinkPrice();

  res.json({
    version: "v8.1-last-look-15m",
    running: true,
    paused: state.paused,
    dryRun: state.config.dryRun,
    uptime: `${Math.floor((Date.now() - startedAt) / 60000)}m`,
    price: {
      bybit: priceEngine.lastBinancePrice.toFixed(2),
      chainlink: `$${cl.price.toFixed(2)} (${cl.age}s old)`,
      windowOpen: wop ? `$${wop.toFixed(2)}` : null,
      delta: wop ? `$${(priceEngine.lastBinancePrice - wop).toFixed(0)} (${(((priceEngine.lastBinancePrice - wop) / wop) * 100).toFixed(3)}%)` : null,
      timeInWindow: `${timeInWindow}s`,
      inTradeWindow: timeInWindow >= state.config.entryWindowStart && timeInWindow <= state.config.entryWindowEnd,
    },
    ticks: { total: tickCount, checks: checkCount },
    stats: {
      trades: state.trades.filter(t => t.result !== "dry-run").length,
      dryRunTrades: state.trades.length,
      wins: state.wins,
      losses: state.losses,
      pending: state.trades.filter(t => t.result === "pending" || t.result === "dry-run").length,
      winRate: state.wins + state.losses > 0
        ? `${((state.wins / (state.wins + state.losses)) * 100).toFixed(1)}%` : "N/A",
      totalPnL: `$${state.totalPnL.toFixed(2)}`,
      wallet: wallet >= 0 ? `$${wallet.toFixed(2)}` : "error",
      sessionPnL: sessionPnL != null ? `$${sessionPnL.toFixed(2)}` : "unknown",
    },
    config: state.config,
    recentTrades: state.trades.slice(-5).reverse().map(t => ({
      time: new Date(t.timestamp).toISOString(),
      direction: t.direction,
      price: `$${t.price.toFixed(2)}`,
      size: t.size,
      cost: `$${t.cost.toFixed(2)}`,
      result: t.result,
      pnl: `$${t.pnl.toFixed(2)}`,
      delta: `$${t.deltaAtEntry?.toFixed(0) ?? "?"}`,
      timeInWindow: `${t.timeInWindow ?? "?"}s`,
      chainlink: t.chainlinkPrice ? `$${t.chainlinkPrice.toFixed(2)}` : "N/A",
    })),
  });
});

app.get("/wallet", async (_req, res) => {
  const bal = await getWalletBalance();
  const sessionPnL = state.sessionStartBalance != null && bal >= 0
    ? bal - state.sessionStartBalance : null;
  res.json({
    balance: bal >= 0 ? `$${bal.toFixed(2)}` : "error",
    sessionStartBalance: state.sessionStartBalance != null ? `$${state.sessionStartBalance.toFixed(2)}` : "unknown",
    sessionPnL: sessionPnL != null ? `$${sessionPnL.toFixed(2)}` : "unknown",
  });
});

app.get("/trades", (_req, res) => res.json(state.trades.slice(-50).reverse()));

app.get("/stats/hourly", (_req, res) => {
  const hourly: Record<number, { trades: number; wins: number; losses: number; pnl: number }> = {};
  for (let h = 0; h < 24; h++) hourly[h] = { trades: 0, wins: 0, losses: 0, pnl: 0 };
  for (const t of state.trades) {
    if (t.result === "pending") continue;
    const h = t.hourUTC ?? new Date(t.timestamp).getUTCHours();
    hourly[h].trades++;
    if (t.result === "win") hourly[h].wins++;
    if (t.result === "loss") hourly[h].losses++;
    hourly[h].pnl += t.pnl;
  }
  const active = Object.entries(hourly)
    .filter(([_, v]) => v.trades > 0)
    .map(([h, v]) => ({
      hour: `${h.toString().padStart(2, "0")}:00 UTC`,
      ...v,
      winRate: v.wins + v.losses > 0 ? `${((v.wins / (v.wins + v.losses)) * 100).toFixed(0)}%` : "N/A",
      pnl: `$${v.pnl.toFixed(2)}`,
    }));
  res.json({ hourly: active });
});

app.get("/post-mortems", (_req, res) => {
  try {
    const lines = readFileSync(PM_FILE, "utf-8").trim().split("\n").filter(Boolean);
    const pms = lines.map(l => JSON.parse(l));
    res.json({ count: pms.length, recent: pms.slice(-10).reverse() });
  } catch {
    res.json({ count: 0, recent: [] });
  }
});

app.post("/pause", (_req, res) => {
  state.paused = true; saveState();
  console.log("[bot] ⏸️ Paused");
  res.json({ ok: true, paused: true });
});

app.post("/resume", (_req, res) => {
  state.paused = false; saveState();
  console.log("[bot] ▶️ Resumed");
  res.json({ ok: true, paused: false });
});

app.post("/config", (req, res) => {
  const allowed = Object.keys(DEFAULT_CONFIG);
  const applied: Record<string, any> = {};
  for (const key of allowed) {
    if (key in req.body) {
      (state.config as any)[key] = req.body[key];
      applied[key] = req.body[key];
    }
  }
  saveState();
  console.log("[bot] Config updated:", applied);
  res.json({ ok: true, applied, config: state.config });
});

app.post("/stop", (_req, res) => {
  res.json({ ok: true });
  setTimeout(shutdown, 500);
});

// ── Lifecycle ───────────────────────────────────────────────
async function start() {
  console.log("═══════════════════════════════════════════════");
  console.log("  Polymarket BTC 5-Min Bot v8 — Last Look");
  console.log(`  Mode: ${state.config.dryRun ? "🏜️ DRY RUN" : "💰 LIVE"}`);
  console.log(`  Entry window: ${state.config.entryWindowStart}-${state.config.entryWindowEnd}s (last ${900 - state.config.entryWindowStart}s)`);
  console.log(`  Min delta: $${state.config.minDeltaAbsolute} / ${state.config.minDeltaPercent}%`);
  console.log(`  Max entry price: $${state.config.maxEntryPrice}`);
  console.log(`  Position: ${(state.config.compoundFraction * 100).toFixed(0)}% of wallet ($${state.config.positionSize}-$${state.config.maxPositionSize})`);
  console.log(`  Chainlink confirm: ${state.config.requireChainlinkConfirm ? "ON" : "OFF"}`);
  console.log(`  P&L floor: $${state.config.pnlFloor}`);
  console.log(`  History: ${state.trades.length} trades, ${state.wins}W/${state.losses}L, $${state.totalPnL.toFixed(2)} P&L`);
  console.log("═══════════════════════════════════════════════\n");

  // Test Chainlink feed
  const cl = await getChainlinkPrice();
  console.log(`[chainlink] BTC/USD on Polygon: $${cl.price.toFixed(2)} (${cl.age}s old) ✅`);

  if (!state.config.dryRun) {
    clobClient = await initClobClient();
  }

  if (state.sessionStartBalance != null && state.sessionStartBalance > 0) {
    console.log(`[bot] Session start balance (preserved): $${state.sessionStartBalance.toFixed(2)}`);
  } else {
    const startBal = await getWalletBalance();
    if (startBal >= 0) {
      state.sessionStartBalance = startBal;
      console.log(`[bot] Session start balance: $${startBal.toFixed(2)}`);
    }
  }

  await priceEngine.bootstrap();
  priceEngine.connectBinance();
  priceEngine.connectPolymarket();
  priceEngine.startCoinGeckoPolling();

  priceEngine.on("tick", ({ source, price }: { source: string; price: number }) => {
    if (source === "binance") {
      onTick(price);
    }
  });

  app.listen(BOT_PORT, "127.0.0.1", () => {
    console.log(`[api] http://127.0.0.1:${BOT_PORT}`);
  });
}

function shutdown() {
  console.log("[bot] Shutting down...");
  priceEngine.stop();
  saveState();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

start().catch(e => {
  console.error("[bot] Fatal:", e);
  process.exit(1);
});
