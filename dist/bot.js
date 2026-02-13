/**
 * Polymarket BTC 5-Min Trading Bot v2
 * Persistent process with WebSocket price feeds + HTTP control API
 */
import express from "express";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import { PriceEngine } from "./price-engine.js";
import { findCurrentMarket, checkMarketOutcome } from "./market-engine.js";
import { generateSignal, DEFAULT_CONFIG } from "./signal-engine.js";
import { ClobClient } from "@polymarket/clob-client";
import { ethers } from "ethers";
// ── Config ──────────────────────────────────────────────────
const PROXY_URL = process.env.PROXY_URL || "https://polymarket-proxy-production.up.railway.app";
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const STATE_FILE = new URL("../state.json", import.meta.url).pathname;
const BOT_PORT = parseInt(process.env.BOT_PORT || "3847");
// ── Loss Pattern Categorization ─────────────────────────────
function categorizeLoss(trade) {
    const reasons = trade.reasons.join(" ");
    if (trade.strategy === "latency-arb") {
        if (reasons.includes("into window")) {
            const timeMatch = reasons.match(/(\d+)s into/);
            const secs = timeMatch ? parseInt(timeMatch[1]) : 999;
            if (secs < 180)
                return "ARB_TOO_EARLY"; // entered before 3 min, price reversed
            return "ARB_REVERSAL"; // late entry but still reversed
        }
        return "ARB_MISPRICED"; // fair value estimate was wrong
    }
    if (reasons.includes("Exhaustion"))
        return "EXHAUSTION_MISSED";
    if (reasons.includes("decelerat"))
        return "DECEL_MISSED";
    if (reasons.includes("downtrend") && trade.direction === "UP")
        return "COUNTER_TREND";
    if (reasons.includes("uptrend") && trade.direction === "DOWN")
        return "COUNTER_TREND";
    if (reasons.includes("Oversold") && trade.direction === "DOWN")
        return "FALLING_KNIFE";
    if (reasons.includes("Overbought") && trade.direction === "UP")
        return "CHASING_TOP";
    return "UNKNOWN";
}
// ── State ───────────────────────────────────────────────────
function loadState() {
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
            };
        }
        catch { }
    }
    return {
        config: { ...DEFAULT_CONFIG },
        trades: [],
        totalPnL: 0,
        wins: 0,
        losses: 0,
        skips: 0,
        paused: false,
    };
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
        }, null, 2));
    }
    catch { }
}
const state = loadState();
const priceEngine = new PriceEngine();
let clobClient = null;
let lastTradedWindow = 0;
let windowOpenPrices = new Map();
let startedAt = Date.now();
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
        // Use proxy for CLOB (geo-blocked from US)
        const client = new ClobClient(PROXY_URL, 137, signer);
        const creds = await client.createOrDeriveApiKey();
        if (creds.key && !creds.apiKey)
            creds.apiKey = creds.key;
        const authed = new ClobClient(PROXY_URL, 137, signer, creds, 0, signer.address);
        console.log("[bot] CLOB client authenticated ✅");
        return authed;
    }
    catch (e) {
        console.error("[bot] CLOB init error:", e.message);
        return null;
    }
}
// ── Settlement: check pending trades ────────────────────────
async function settleTrades() {
    const pending = state.trades.filter(t => t.result === "pending");
    for (const trade of pending) {
        // Only check after window has ended + 60s buffer
        if (Date.now() / 1000 < trade.windowStart + 360)
            continue;
        const winner = await checkMarketOutcome(trade.windowStart);
        if (!winner || winner === "pending")
            continue;
        const won = (trade.direction === "UP" && winner === "Up") ||
            (trade.direction === "DOWN" && winner === "Down");
        if (won) {
            trade.result = "win";
            trade.pnl = trade.size * 0.9 - trade.cost; // $1 * size * 0.9 (10% fee) - cost
            state.wins++;
        }
        else {
            trade.result = "loss";
            trade.pnl = -trade.cost;
            state.losses++;
        }
        state.totalPnL += trade.pnl;
        console.log(`[settle] ${trade.market} | ${trade.direction} | ${trade.result.toUpperCase()} | P&L: $${trade.pnl.toFixed(2)} | Total: $${state.totalPnL.toFixed(2)}`);
        // Post-mortem on every loss — log structured analysis for pattern detection
        if (trade.result === "loss") {
            const postMortem = {
                timestamp: new Date().toISOString(),
                trade: {
                    market: trade.market,
                    direction: trade.direction,
                    strategy: trade.strategy,
                    price: trade.price,
                    cost: trade.cost,
                    confidence: trade.confidence,
                    reasons: trade.reasons,
                },
                analysis: {
                    wasExhausted: trade.reasons.some(r => r.includes("Exhaustion")),
                    wasDecelerating: trade.reasons.some(r => r.includes("decelerat")),
                    wasLatencyArb: trade.strategy === "latency-arb",
                    timeInWindow: trade.reasons.find(r => r.includes("into window"))?.match(/(\d+)s into/)?.[1] || "unknown",
                    tokenPrice: trade.price,
                    pattern: categorizeLoss(trade),
                },
                totalPnL: state.totalPnL,
                winRate: `${state.wins}W/${state.losses}L (${((state.wins / (state.wins + state.losses)) * 100).toFixed(1)}%)`,
            };
            const PM_FILE = new URL("../post-mortems.jsonl", import.meta.url).pathname;
            try {
                appendFileSync(PM_FILE, JSON.stringify(postMortem) + "\n");
                console.log(`[post-mortem] Loss logged: ${postMortem.analysis.pattern}`);
            }
            catch { }
        }
        saveState();
    }
}
// ── Core Loop ───────────────────────────────────────────────
async function checkAndTrade() {
    if (state.paused)
        return;
    try {
        // Settle old trades first
        await settleTrades();
        const now = Math.floor(Date.now() / 1000);
        const currentWindowStart = Math.floor(now / 300) * 300;
        const timeIntoWindow = now - currentWindowStart;
        // Track window open price (first price we see in each window)
        if (!windowOpenPrices.has(currentWindowStart) && priceEngine.lastBinancePrice > 0) {
            windowOpenPrices.set(currentWindowStart, priceEngine.lastBinancePrice);
            // Cleanup old entries
            for (const [k] of windowOpenPrices) {
                if (k < currentWindowStart - 3600)
                    windowOpenPrices.delete(k);
            }
        }
        // Already traded this window
        if (lastTradedWindow === currentWindowStart)
            return;
        // Cooldown: skip N windows after last trade
        if (state.config.cooldownWindows > 0 && lastTradedWindow > 0) {
            const windowsSinceTrade = (currentWindowStart - lastTradedWindow) / 300;
            if (windowsSinceTrade <= state.config.cooldownWindows)
                return;
        }
        // Skip if >3 min in (for technical). Arb can trade later (up to 4 min)
        const maxTimeForTechnical = 180;
        const maxTimeForArb = 240;
        // Need enough candles
        const closes = priceEngine.getCloses();
        if (closes.length < 30) {
            console.log(`[bot] Waiting for candles (${closes.length}/30)`);
            return;
        }
        // Find market first (we need prices for arb signal)
        const market = timeIntoWindow <= maxTimeForArb ? await findCurrentMarket() : null;
        // Generate signal with market prices for latency arb
        const windowOpen = windowOpenPrices.get(currentWindowStart) || null;
        const signal = generateSignal(closes, windowOpen, priceEngine.lastBinancePrice, market?.upPrice ?? null, market?.downPrice ?? null, state.config);
        // Technical signals need earlier entry
        if (signal.strategy === "technical" && timeIntoWindow > maxTimeForTechnical) {
            state.skips++;
            return;
        }
        if (!signal.direction) {
            state.skips++;
            return;
        }
        if (!market) {
            console.log("[bot] Market not found");
            return;
        }
        // Calculate order
        const currentPrice = signal.direction === "UP" ? market.upPrice : market.downPrice;
        const bidPrice = Math.min(parseFloat((currentPrice + 0.02).toFixed(2)), state.config.maxPrice);
        const size = Math.floor(state.config.positionSize / bidPrice);
        if (size < 1)
            return;
        const cost = size * bidPrice;
        const tokenId = signal.direction === "UP" ? market.upTokenId : market.downTokenId;
        console.log(`\n[bot] 🎯 ${signal.direction} [${signal.strategy}] | conf=${(signal.confidence * 100).toFixed(0)}% | ${size} tokens @ $${bidPrice} = $${cost.toFixed(2)}`);
        signal.reasons.forEach(r => console.log(`  → ${r}`));
        const trade = {
            timestamp: Date.now(),
            market: market.slug,
            windowStart: currentWindowStart,
            direction: signal.direction,
            strategy: signal.strategy,
            price: bidPrice,
            size,
            cost,
            confidence: signal.confidence,
            reasons: signal.reasons,
            result: state.config.dryRun ? "dry-run" : "pending",
            pnl: 0,
        };
        if (!state.config.dryRun && clobClient) {
            try {
                const order = await clobClient.createOrder({
                    tokenID: tokenId,
                    price: bidPrice,
                    side: "BUY",
                    size,
                });
                const result = await clobClient.postOrder(order);
                trade.orderId = result?.orderID || result?.id || "unknown";
                console.log(`[bot] ✅ Order placed: ${trade.orderId}`);
            }
            catch (e) {
                console.error(`[bot] ❌ Order failed: ${e.message}`);
            }
        }
        else {
            console.log("[bot] 🏜️ DRY RUN");
        }
        state.trades.push(trade);
        if (state.trades.length > 200)
            state.trades.shift();
        lastTradedWindow = currentWindowStart;
        saveState();
    }
    catch (e) {
        console.error(`[bot] Error: ${e.message}`);
    }
}
// ── HTTP API ────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.get("/status", (_req, res) => {
    const closes = priceEngine.getCloses();
    const nowSec = Math.floor(Date.now() / 1000);
    const cwStart = Math.floor(nowSec / 300) * 300;
    const wop = windowOpenPrices.get(cwStart) || null;
    const lastSignal = closes.length >= 30 ? generateSignal(closes, wop, priceEngine.lastBinancePrice, null, null, state.config) : null;
    res.json({
        running: true,
        paused: state.paused,
        dryRun: state.config.dryRun,
        uptime: `${Math.floor((Date.now() - startedAt) / 60000)}m`,
        price: {
            binance: priceEngine.lastBinancePrice,
            coingecko: priceEngine.lastChainlinkPrice,
            candles: closes.length,
        },
        connections: priceEngine.connected,
        signal: lastSignal ? {
            direction: lastSignal.direction,
            strategy: lastSignal.strategy,
            confidence: `${(lastSignal.confidence * 100).toFixed(0)}%`,
            k: lastSignal.stochRSI.k.toFixed(1),
            d: lastSignal.stochRSI.d.toFixed(1),
            priceDelta: lastSignal.priceDelta ? `$${lastSignal.priceDelta.absolute.toFixed(2)} (${lastSignal.priceDelta.percent.toFixed(3)}%)` : null,
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
        recentTrades: state.trades.slice(-5).reverse().map(t => ({
            time: new Date(t.timestamp).toISOString(),
            direction: t.direction,
            cost: `$${t.cost.toFixed(2)}`,
            result: t.result,
            pnl: `$${t.pnl.toFixed(2)}`,
        })),
    });
});
app.get("/trades", (_req, res) => {
    res.json(state.trades.slice(-50).reverse());
});
app.post("/pause", (_req, res) => {
    state.paused = true;
    saveState();
    console.log("[bot] ⏸️ Paused");
    res.json({ ok: true, paused: true });
});
app.post("/resume", (_req, res) => {
    state.paused = false;
    saveState();
    console.log("[bot] ▶️ Resumed");
    res.json({ ok: true, paused: false });
});
app.post("/config", (req, res) => {
    const allowed = ["oversoldThreshold", "overboughtThreshold", "extremeOversold",
        "extremeOverbought", "minConfidence", "maxPrice", "dryRun", "positionSize",
        "cooldownWindows", "minPriceDeltaPercent", "minPriceDeltaAbsolute", "arbMinConfidence"];
    const applied = {};
    for (const key of allowed) {
        if (key in req.body) {
            state.config[key] = req.body[key];
            applied[key] = req.body[key];
        }
    }
    saveState();
    console.log("[bot] Config updated:", applied);
    res.json({ ok: true, applied, config: state.config });
});
app.get("/post-mortems", (_req, res) => {
    const PM_FILE = new URL("../post-mortems.jsonl", import.meta.url).pathname;
    try {
        const lines = readFileSync(PM_FILE, "utf-8").trim().split("\n").filter(Boolean);
        const pms = lines.map(l => JSON.parse(l));
        // Pattern frequency
        const patterns = {};
        for (const pm of pms) {
            const p = pm.analysis?.pattern || "UNKNOWN";
            patterns[p] = (patterns[p] || 0) + 1;
        }
        res.json({ count: pms.length, patterns, recent: pms.slice(-5).reverse() });
    }
    catch {
        res.json({ count: 0, patterns: {}, recent: [] });
    }
});
app.post("/stop", (_req, res) => {
    res.json({ ok: true });
    setTimeout(shutdown, 500);
});
// ── Lifecycle ───────────────────────────────────────────────
async function start() {
    console.log("═══════════════════════════════════════════════");
    console.log("  Polymarket BTC 5-Min Bot v2");
    console.log(`  Mode: ${state.config.dryRun ? "DRY RUN" : "LIVE"}`);
    console.log(`  Position: $${state.config.positionSize}/trade`);
    console.log(`  History: ${state.trades.length} trades, ${state.wins}W/${state.losses}L, $${state.totalPnL.toFixed(2)} P&L`);
    console.log("═══════════════════════════════════════════════\n");
    // Bootstrap price data
    await priceEngine.bootstrap();
    priceEngine.connectBinance();
    priceEngine.startCoinGeckoPolling();
    // Init CLOB client
    if (!state.config.dryRun) {
        clobClient = await initClobClient();
    }
    // Check every 15 seconds (WebSocket gives us fresh data continuously)
    setInterval(checkAndTrade, 15_000);
    setTimeout(checkAndTrade, 5000);
    // Start HTTP API
    app.listen(BOT_PORT, "127.0.0.1", () => {
        console.log(`[api] http://127.0.0.1:${BOT_PORT} — /status /trades /pause /resume /config /stop`);
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
