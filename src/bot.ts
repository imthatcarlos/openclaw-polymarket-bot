/**
 * Polymarket BTC 5-Min Trading Bot v3
 * Pure latency arbitrage — event-driven on WebSocket price ticks
 */

import express from "express";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import { PriceEngine } from "./price-engine.js";
import { findCurrentMarket, checkMarketOutcome, type MarketInfo } from "./market-engine.js";
import { generateSignal, DEFAULT_CONFIG, type Signal, type SignalConfig } from "./signal-engine.js";
import { ClobClient } from "@polymarket/clob-client";
import { ethers } from "ethers";

// ── Config ──────────────────────────────────────────────────
const PROXY_URL = process.env.PROXY_URL || "https://polymarket-proxy-production.up.railway.app";
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const STATE_FILE = new URL("../state.json", import.meta.url).pathname;
const PM_FILE = new URL("../post-mortems.jsonl", import.meta.url).pathname;
const BOT_PORT = parseInt(process.env.BOT_PORT || "3847");

// ── Types ───────────────────────────────────────────────────
interface Trade {
  timestamp: number;
  market: string;
  windowStart: number;
  direction: "UP" | "DOWN";
  price: number;
  size: number;
  cost: number;
  confidence: number;
  reasons: string[];
  result: "win" | "loss" | "pending" | "dry-run";
  pnl: number;
  orderId?: string;
  // Arb context
  btcAtEntry: number;
  btcWindowOpen: number;
  deltaAtEntry: number;
  timeInWindow: number;
  tokenPriceAtEntry: number;
  fairValueAtEntry: number;
  hourUTC: number;
}

interface BotState {
  config: SignalConfig;
  trades: Trade[];
  totalPnL: number;
  wins: number;
  losses: number;
  winStreak: number;
  skips: number;
  paused: boolean;
}

// ── Loss Pattern Categorization ─────────────────────────────
function categorizeLoss(trade: Trade): string {
  if (trade.timeInWindow < 120) return "ARB_TOO_EARLY";
  if (trade.timeInWindow >= 120 && trade.timeInWindow < 200) return "ARB_MID_WINDOW";
  if (Math.abs(trade.deltaAtEntry) < 50) return "ARB_SMALL_MOVE";
  if (trade.tokenPriceAtEntry > 0.52) return "ARB_MARKET_KNEW";
  return "ARB_REVERSAL";
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
        winStreak: s.winStreak ?? 0,
        skips: s.skips ?? 0,
        paused: s.paused ?? false,
      };
    } catch {}
  }
  return { config: { ...DEFAULT_CONFIG }, trades: [], totalPnL: 0, wins: 0, losses: 0, winStreak: 0, skips: 0, paused: false };
}

function saveState() {
  try {
    writeFileSync(STATE_FILE, JSON.stringify({
      config: state.config,
      trades: state.trades.slice(-200),
      totalPnL: state.totalPnL,
      wins: state.wins,
      losses: state.losses,
      winStreak: state.winStreak,
      skips: state.skips,
      paused: state.paused,
    }, null, 2));
  } catch {}
}

const state = loadState();
const priceEngine = new PriceEngine();
let clobClient: any = null;
let lastTradeTime = 0;
let windowOpenPrices: Map<number, number> = new Map();
let tradedWindows: Set<number> = new Set();
let startedAt = Date.now();
let lastSignal: Signal | null = null;
let tickCount = 0;
let checkCount = 0;

// Populate tradedWindows from existing trades
for (const t of state.trades) {
  if (t.windowStart) tradedWindows.add(t.windowStart);
}

// ── CLOB Client (via EU proxy) ──────────────────────────────
async function initClobClient() {
  if (!process.env.EVM_PRIVATE_KEY) {
    console.log("[bot] No EVM_PRIVATE_KEY — dry run only");
    return null;
  }
  try {
    const provider = new ethers.providers.StaticJsonRpcProvider(RPC_URL, { name: "polygon", chainId: 137 });
    const signer = new ethers.Wallet(process.env.EVM_PRIVATE_KEY, provider);
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
    if (Date.now() / 1000 < trade.windowStart + 360) continue;

    const winner = await checkMarketOutcome(trade.windowStart);
    if (!winner || winner === "pending") continue;

    const won = (trade.direction === "UP" && winner === "Up") ||
                (trade.direction === "DOWN" && winner === "Down");

    if (won) {
      trade.result = "win";
      trade.pnl = trade.size * 0.9 - trade.cost;
      state.wins++;
      state.winStreak = (state.winStreak ?? 0) + 1;
      const br = Math.max((state.config.bankroll ?? 500) + state.totalPnL + trade.pnl, state.config.positionSize);
      const wr = state.wins / Math.max(state.wins + state.losses, 1);
      const ko = Math.max((wr * 0.7 - (1 - wr)) / 0.7, 0);
      const nextSize = Math.min(Math.max(br * ko * (state.config.kellyFraction ?? 0.25), state.config.positionSize), state.config.maxPositionSize ?? 10000);
      console.log(`[kelly] ✅ Win | bankroll=$${br.toFixed(0)} | WR=${(wr*100).toFixed(1)}% | next=$${nextSize.toFixed(0)}`);
    } else {
      trade.result = "loss";
      trade.pnl = -trade.cost;
      state.losses++;
      state.winStreak = 0;
      const br = Math.max((state.config.bankroll ?? 500) + state.totalPnL + trade.pnl, state.config.positionSize);
      const wr = state.wins / Math.max(state.wins + state.losses, 1);
      const ko = Math.max((wr * 0.7 - (1 - wr)) / 0.7, 0);
      const nextSize = Math.min(Math.max(br * ko * (state.config.kellyFraction ?? 0.25), state.config.positionSize), state.config.maxPositionSize ?? 10000);
      console.log(`[kelly] ❌ Loss | bankroll=$${br.toFixed(0)} | WR=${(wr*100).toFixed(1)}% | next=$${nextSize.toFixed(0)}`);

      // Auto post-mortem
      const postMortem = {
        timestamp: new Date().toISOString(),
        trade: {
          market: trade.market,
          direction: trade.direction,
          cost: trade.cost,
          confidence: trade.confidence,
          btcAtEntry: trade.btcAtEntry,
          btcWindowOpen: trade.btcWindowOpen,
          deltaAtEntry: trade.deltaAtEntry,
          timeInWindow: trade.timeInWindow,
          tokenPriceAtEntry: trade.tokenPriceAtEntry,
          fairValueAtEntry: trade.fairValueAtEntry,
          reasons: trade.reasons,
        },
        pattern: categorizeLoss(trade),
        totalPnL: state.totalPnL + trade.pnl,
        record: `${state.wins}W/${state.losses}L`,
      };
      try {
        appendFileSync(PM_FILE, JSON.stringify(postMortem) + "\n");
        console.log(`[post-mortem] ${postMortem.pattern}: ${trade.direction} $${trade.cost.toFixed(2)} | Δ=$${trade.deltaAtEntry.toFixed(0)} @ ${trade.timeInWindow}s`);
      } catch {}
    }

    state.totalPnL += trade.pnl;
    console.log(`[settle] ${trade.market} | ${trade.direction} | ${trade.result.toUpperCase()} | P&L: $${trade.pnl.toFixed(2)} | Total: $${state.totalPnL.toFixed(2)}`);
    saveState();

    // Post-settlement circuit breaker
    const floor = state.config.pnlFloor ?? -100;
    if (state.totalPnL <= floor) {
      console.log(`[circuit-breaker] 🛑 P&L $${state.totalPnL.toFixed(2)} hit floor $${floor} after settlement. Auto-pausing.`);
      state.paused = true;
      saveState();
      return; // stop settling further trades
    }
  }
}

// ── Core: called on every price tick ────────────────────────
let checking = false;

async function onTick(price: number) {
  if (state.paused || checking) return;
  tickCount++;

  const now = Math.floor(Date.now() / 1000);
  const currentWindowStart = Math.floor(now / 300) * 300;
  const timeInWindow = now - currentWindowStart;

  // Track window open price
  if (!windowOpenPrices.has(currentWindowStart)) {
    windowOpenPrices.set(currentWindowStart, price);
    // Cleanup old
    for (const [k] of windowOpenPrices) {
      if (k < currentWindowStart - 3600) windowOpenPrices.delete(k);
    }
  }

  const windowOpenPrice = windowOpenPrices.get(currentWindowStart)!;
  const delta = Math.abs(price - windowOpenPrice);
  const deltaPct = (delta / windowOpenPrice) * 100;

  // Quick pre-check: skip if move too small (avoid expensive market lookup)
  if (deltaPct < state.config.minDeltaPercent || delta < state.config.minDeltaAbsolute) return;

  // Already traded this window
  if (tradedWindows.has(currentWindowStart)) return;

  // Don't place a new trade while any trade is pending settlement
  const hasPending = state.trades.some(t => t.result === "pending");
  if (hasPending) return;

  // Cooldown after trade completes (win or loss)
  if (Date.now() - lastTradeTime < state.config.cooldownMs) return;

  // Don't trade first 30s (window open price might be stale) or last 60s (resolution too close)
  if (timeInWindow < 30 || timeInWindow > 240) return;

  checking = true;
  checkCount++;

  try {
    // Settle old trades
    await settleTrades();

    // Get market prices
    const market = await findCurrentMarket();
    if (!market) { checking = false; return; }

    // Generate signal
    const signal = generateSignal(
      windowOpenPrice,
      price,
      market.upPrice,
      market.downPrice,
      timeInWindow,
      state.config
    );
    lastSignal = signal;

    if (!signal.direction) {
      state.skips++;
      checking = false;
      return;
    }

    // Circuit breaker: pause if P&L drops below floor
    const pnlFloor = state.config.pnlFloor ?? -100;
    if (state.totalPnL <= pnlFloor) {
      console.log(`[circuit-breaker] 🛑 P&L $${state.totalPnL.toFixed(2)} hit floor $${pnlFloor}. Auto-pausing.`);
      state.paused = true;
      saveState();
      checking = false;
      return;
    }

    // Execute trade — doubling on win streaks
    const tokenPrice = signal.direction === "UP" ? market.upPrice : market.downPrice;
    const bidPrice = Math.min(parseFloat((tokenPrice + 0.02).toFixed(2)), state.config.maxPrice);

    // Kelly-adjacent sizing: bet a fraction of bankroll based on edge
    // Kelly f* = (p*b - q) / b where p=win%, b=payout ratio, q=loss%
    // With 72% WR and ~0.7 payout: full Kelly ~32%. We use quarter Kelly for safety.
    const baseSize = state.config.positionSize;
    const maxPositionSize = state.config.maxPositionSize ?? 10000;
    const kellyFraction = state.config.kellyFraction ?? 0.25; // quarter Kelly
    const bankroll = state.config.bankroll ?? 500;
    
    // Effective bankroll = initial bankroll + cumulative P&L (never below baseSize)
    const effectiveBankroll = Math.max(bankroll + state.totalPnL, baseSize);
    const winRate = state.wins / Math.max(state.wins + state.losses, 1);
    const payoutRatio = 0.7; // avg ~70% return on winning trades at ~51¢ entry
    const kellyOptimal = Math.max((winRate * payoutRatio - (1 - winRate)) / payoutRatio, 0);
    const tradeSize = Math.min(
      Math.max(effectiveBankroll * kellyOptimal * kellyFraction, baseSize),
      maxPositionSize
    );
    console.log(`[kelly] bankroll=$${effectiveBankroll.toFixed(0)} × kelly=${(kellyOptimal*100).toFixed(1)}% × ${kellyFraction} = $${tradeSize.toFixed(2)} (floor $${baseSize}, cap $${maxPositionSize})`);

    const size = Math.floor(tradeSize / bidPrice);
    if (size < 1) { checking = false; return; }

    const cost = size * bidPrice;
    const tokenId = signal.direction === "UP" ? market.upTokenId : market.downTokenId;
    const fairValue = signal.priceDelta ? 
      Math.min(state.config.fairValueBase + (Math.abs(signal.priceDelta.percent) * state.config.fairValueMultiplier * (0.5 + timeInWindow / 600)), state.config.fairValueCap) : 0;

    console.log(`\n[bot] 🎯 ${signal.direction} | ${size} tokens @ $${bidPrice} = $${cost.toFixed(2)} | ${timeInWindow}s into window`);
    signal.reasons.forEach(r => console.log(`  → ${r}`));

    const trade: Trade = {
      timestamp: Date.now(),
      market: market.slug,
      windowStart: currentWindowStart,
      direction: signal.direction,
      price: bidPrice,
      size,
      cost,
      confidence: signal.confidence,
      reasons: signal.reasons,
      result: state.config.dryRun ? "dry-run" : "pending",
      pnl: 0,
      btcAtEntry: price,
      btcWindowOpen: windowOpenPrice,
      deltaAtEntry: price - windowOpenPrice,
      timeInWindow,
      tokenPriceAtEntry: tokenPrice,
      fairValueAtEntry: fairValue,
      hourUTC: new Date().getUTCHours(),
    };

    if (!state.config.dryRun && clobClient) {
      try {
        const order = await clobClient.createOrder({
          tokenID: tokenId,
          price: bidPrice,
          side: "BUY" as any,
          size,
        });
        const result = await clobClient.postOrder(order);
        trade.orderId = result?.orderID || result?.id || "unknown";
        console.log(`[bot] ✅ Order placed: ${trade.orderId}`);
      } catch (e: any) {
        console.error(`[bot] ❌ Order failed: ${e.message}`);
        checking = false;
        return;
      }
    } else {
      console.log("[bot] 🏜️ DRY RUN");
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

// ── Settlement loop (for trades where we missed the tick) ───
setInterval(async () => {
  if (!state.paused) await settleTrades();
}, 30_000);

// ── HTTP API ────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.get("/status", (_req, res) => {
  const nowSec = Math.floor(Date.now() / 1000);
  const cwStart = Math.floor(nowSec / 300) * 300;
  const wop = windowOpenPrices.get(cwStart);
  const timeInWindow = nowSec - cwStart;

  res.json({
    version: "v3-pure-arb",
    running: true,
    paused: state.paused,
    dryRun: state.config.dryRun,
    uptime: `${Math.floor((Date.now() - startedAt) / 60000)}m`,
    price: {
      binance: priceEngine.lastBinancePrice,
      windowOpen: wop ?? null,
      delta: wop ? `$${(priceEngine.lastBinancePrice - wop).toFixed(0)} (${(((priceEngine.lastBinancePrice - wop) / wop) * 100).toFixed(3)}%)` : null,
      timeInWindow: `${timeInWindow}s`,
    },
    ticks: { total: tickCount, checks: checkCount },
    signal: lastSignal ? {
      direction: lastSignal.direction,
      confidence: lastSignal.confidence ? `${(lastSignal.confidence * 100).toFixed(0)}%` : null,
      reasons: lastSignal.reasons,
    } : null,
    stats: {
      trades: state.trades.filter(t => t.result !== "dry-run").length,
      wins: state.wins,
      losses: state.losses,
      pending: state.trades.filter(t => t.result === "pending").length,
      skips: state.skips,
      winRate: state.wins + state.losses > 0
        ? `${((state.wins / (state.wins + state.losses)) * 100).toFixed(1)}%`
        : "N/A",
      totalPnL: `$${state.totalPnL.toFixed(2)}`,
    },
    config: {
      positionSize: state.config.positionSize,
      maxPositionSize: state.config.maxPositionSize ?? 10000,
      pnlFloor: state.config.pnlFloor ?? -100,
      winStreak: state.winStreak ?? 0,
      effectiveSize: (() => {
        const br = Math.max((state.config.bankroll ?? 500) + state.totalPnL, state.config.positionSize);
        const wr = state.wins / Math.max(state.wins + state.losses, 1);
        const ko = Math.max((wr * 0.7 - (1 - wr)) / 0.7, 0);
        const kf = state.config.kellyFraction ?? 0.25;
        return `$${Math.min(Math.max(br * ko * kf, state.config.positionSize), state.config.maxPositionSize ?? 10000).toFixed(0)}`;
      })(),
      sizingMode: "kelly",
      minDeltaPercent: state.config.minDeltaPercent,
      minDeltaAbsolute: state.config.minDeltaAbsolute,
      minEdgeCents: state.config.minEdgeCents,
      maxTokenPrice: state.config.maxTokenPrice,
      cooldownMs: state.config.cooldownMs,
    },
    recentTrades: state.trades.slice(-5).reverse().map(t => ({
      time: new Date(t.timestamp).toISOString(),
      direction: t.direction,
      cost: `$${t.cost.toFixed(2)}`,
      result: t.result,
      pnl: `$${t.pnl.toFixed(2)}`,
      delta: `$${t.deltaAtEntry?.toFixed(0) ?? "?"}`,
      timeInWindow: `${t.timeInWindow ?? "?"}s`,
    })),
  });
});

app.get("/trades", (_req, res) => {
  res.json(state.trades.slice(-50).reverse());
});

app.get("/stats/hourly", (_req, res) => {
  const hourly: Record<number, { trades: number; wins: number; losses: number; pnl: number }> = {};
  for (let h = 0; h < 24; h++) hourly[h] = { trades: 0, wins: 0, losses: 0, pnl: 0 };
  for (const t of state.trades) {
    if (t.result === "dry-run" || t.result === "pending") continue;
    const h = t.hourUTC ?? new Date(t.timestamp).getUTCHours();
    hourly[h].trades++;
    if (t.result === "win") hourly[h].wins++;
    if (t.result === "loss") hourly[h].losses++;
    hourly[h].pnl += t.pnl;
  }
  // Only show hours with trades
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
    const patterns: Record<string, number> = {};
    for (const pm of pms) {
      const p = pm.pattern || "UNKNOWN";
      patterns[p] = (patterns[p] || 0) + 1;
    }
    res.json({ count: pms.length, patterns, recent: pms.slice(-5).reverse() });
  } catch {
    res.json({ count: 0, patterns: {}, recent: [] });
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
  const allowed = [...Object.keys(DEFAULT_CONFIG), "bankroll", "kellyFraction", "minPositionSize", "compoundFraction", "maxPositionSize", "pnlFloor"];
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
  console.log("  Polymarket BTC 5-Min Bot v5 — Kelly Arb");
  console.log(`  Mode: ${state.config.dryRun ? "DRY RUN" : "LIVE"}`);
  console.log(`  Position: $${state.config.positionSize}/trade`);
  console.log(`  Min delta: ${state.config.minDeltaPercent}% / $${state.config.minDeltaAbsolute}`);
  console.log(`  Min edge: ${state.config.minEdgeCents}¢`);
  console.log(`  Cooldown: ${state.config.cooldownMs / 1000}s`);
  console.log(`  History: ${state.trades.length} trades, ${state.wins}W/${state.losses}L, $${state.totalPnL.toFixed(2)} P&L`);
  console.log("═══════════════════════════════════════════════\n");

  await priceEngine.bootstrap();
  priceEngine.connectBinance();
  priceEngine.startCoinGeckoPolling();

  // Event-driven: check on every price tick from Binance WebSocket
  priceEngine.on("tick", ({ source, price }: { source: string; price: number }) => {
    if (source === "binance") {
      onTick(price);
    }
  });

  if (!state.config.dryRun) {
    clobClient = await initClobClient();
  }

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
