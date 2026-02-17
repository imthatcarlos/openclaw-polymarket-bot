/**
 * Polymarket BTC 5-Min Trading Bot v6
 * Pure latency arbitrage — event-driven on WebSocket price ticks
 * P&L tracked via wallet balance, not calculated
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
const PM_FILE = new URL("../post-mortems.jsonl", import.meta.url).pathname;
const BOT_PORT = parseInt(process.env.BOT_PORT || "3847");
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const WALLET_ADDRESS = process.env.WALLET_ADDRESS || "0x1a1E1b82Da7E91E9567a40b0f952748b586389F9";
// ── Loss Pattern Categorization ─────────────────────────────
function categorizeLoss(trade) {
    if (trade.timeInWindow < 90)
        return "ARB_TOO_EARLY";
    if (trade.timeInWindow >= 90 && trade.timeInWindow <= 150)
        return "ARB_SWEET_SPOT";
    if (Math.abs(trade.deltaAtEntry) < 50)
        return "ARB_SMALL_MOVE";
    if (trade.tokenPriceAtEntry > 0.52)
        return "ARB_MARKET_KNEW";
    return "ARB_REVERSAL";
}
// ── Wallet Helpers ──────────────────────────────────────────
let provider = null;
let signer = null;
function getProvider() {
    if (!provider) {
        provider = new ethers.providers.StaticJsonRpcProvider(RPC_URL, { name: "polygon", chainId: 137 });
    }
    return provider;
}
async function getWalletBalance() {
    try {
        const p = getProvider();
        const usdc = new ethers.Contract(USDC_ADDRESS, ["function balanceOf(address) view returns (uint256)"], p);
        const bal = await usdc.balanceOf(WALLET_ADDRESS);
        return parseFloat(ethers.utils.formatUnits(bal, 6));
    }
    catch (e) {
        console.error("[wallet] Balance check failed:", e.message);
        return -1;
    }
}
async function getDynamicGas() {
    const provider = signer.provider;
    const gasPrice = await provider.getGasPrice();
    const bumped = gasPrice.mul(130).div(100); // 30% above current
    return { gasPrice: bumped };
}
async function redeemPosition(conditionId) {
    if (!signer)
        return false;
    try {
        const ctf = new ethers.Contract(CTF_ADDRESS, [
            "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external"
        ], signer);
        const tx = await ctf.redeemPositions(USDC_ADDRESS, ethers.constants.HashZero, conditionId, [1, 2], {
            ...(await getDynamicGas()),
            gasLimit: 300000,
        });
        console.log(`[redeem] TX: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`[redeem] ${receipt.status === 1 ? "SUCCESS" : "FAILED"}`);
        return receipt.status === 1;
    }
    catch (e) {
        console.error(`[redeem] Failed: ${e.message}`);
        return false;
    }
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
                winStreak: s.winStreak ?? 0,
                skips: s.skips ?? 0,
                paused: s.paused ?? false,
                sessionStartBalance: s.sessionStartBalance ?? undefined,
            };
        }
        catch { }
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
            sessionStartBalance: state.sessionStartBalance,
        }, null, 2));
    }
    catch { }
}
const state = loadState();
const priceEngine = new PriceEngine();
let clobClient = null;
let lastTradeTime = 0;
let windowOpenPrices = new Map();
let tradedWindows = new Set();
let startedAt = Date.now();
let lastSignal = null;
let tickCount = 0;
let checkCount = 0;
// Populate tradedWindows from existing trades
for (const t of state.trades) {
    if (t.windowStart)
        tradedWindows.add(t.windowStart);
}
// ── CLOB Client (via EU proxy) ──────────────────────────────
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
// ── Settlement ──────────────────────────────────────────────
async function settleTrades() {
    const pending = state.trades.filter(t => t.result === "pending");
    for (const trade of pending) {
        if (Date.now() / 1000 < trade.windowStart + 360)
            continue;
        const winner = await checkMarketOutcome(trade.windowStart);
        if (!winner || winner === "pending")
            continue;
        const won = (trade.direction === "UP" && winner === "Up") ||
            (trade.direction === "DOWN" && winner === "Down");
        if (won) {
            trade.result = "win";
            state.wins++;
            state.winStreak = (state.winStreak ?? 0) + 1;
            // Auto-redeem winning position to get USDC back
            if (trade.conditionId) {
                console.log(`[settle] Redeeming winning position...`);
                await redeemPosition(trade.conditionId);
            }
            // Measure P&L from wallet balance
            const balAfter = await getWalletBalance();
            trade.walletAfter = balAfter;
            if (trade.walletBefore != null && trade.walletBefore >= 0 && balAfter >= 0) {
                trade.pnl = balAfter - trade.walletBefore;
            }
            else {
                // Fallback to calculated P&L if balance check failed
                trade.pnl = trade.size * 0.9 - trade.cost;
                console.log(`[settle] ⚠️ Using calculated P&L (balance unavailable): $${trade.pnl.toFixed(2)}`);
            }
            console.log(`[kelly] ✅ Win | wallet=$${(trade.walletAfter ?? 0).toFixed(2)} | WR=${((state.wins / Math.max(state.wins + state.losses, 1)) * 100).toFixed(1)}%`);
        }
        else {
            trade.result = "loss";
            state.losses++;
            state.winStreak = 0;
            // On loss, tokens are worthless. P&L = what we spent
            const balAfter = await getWalletBalance();
            trade.walletAfter = balAfter;
            if (trade.walletBefore != null && trade.walletBefore >= 0 && balAfter >= 0) {
                trade.pnl = balAfter - trade.walletBefore;
            }
            else {
                trade.pnl = -trade.cost;
                console.log(`[settle] ⚠️ Using calculated P&L (balance unavailable): $${trade.pnl.toFixed(2)}`);
            }
            console.log(`[kelly] ❌ Loss | wallet=$${(trade.walletAfter ?? 0).toFixed(2)} | WR=${((state.wins / Math.max(state.wins + state.losses, 1)) * 100).toFixed(1)}%`);
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
            }
            catch { }
        }
        state.totalPnL += trade.pnl;
        // Update session P&L from wallet balance
        const currentBal = trade.walletAfter ?? await getWalletBalance();
        if (state.sessionStartBalance != null && currentBal >= 0) {
            const sessionPnL = currentBal - state.sessionStartBalance;
            console.log(`[settle] ${trade.market} | ${trade.direction} | ${trade.result.toUpperCase()} | Trade P&L: $${trade.pnl.toFixed(2)} | Session P&L: $${sessionPnL.toFixed(2)} (wallet: $${currentBal.toFixed(2)})`);
        }
        else {
            console.log(`[settle] ${trade.market} | ${trade.direction} | ${trade.result.toUpperCase()} | P&L: $${trade.pnl.toFixed(2)} | Total: $${state.totalPnL.toFixed(2)}`);
        }
        saveState();
        // Post-settlement circuit breaker — use session P&L from wallet if available
        const floor = state.config.pnlFloor ?? -100;
        const effectivePnL = (state.sessionStartBalance != null && currentBal >= 0)
            ? currentBal - state.sessionStartBalance
            : state.totalPnL;
        if (effectivePnL <= floor) {
            console.log(`[circuit-breaker] 🛑 Session P&L $${effectivePnL.toFixed(2)} hit floor $${floor} after settlement. Auto-pausing.`);
            state.paused = true;
            saveState();
            return;
        }
    }
}
// ── Core: called on every price tick ────────────────────────
let checking = false;
async function onTick(price) {
    if (state.paused || checking)
        return;
    tickCount++;
    // Log tick count every 60 ticks (~1 per sec from Bybit)
    if (tickCount % 60 === 1) {
        const now = Math.floor(Date.now() / 1000);
        const cws = Math.floor(now / 300) * 300;
        const tiw = now - cws;
        console.log(`[tick] #${tickCount} price=$${price.toFixed(2)} window=${tiw}s`);
    }
    // Always try to settle pending trades, regardless of price movement
    const hasPending = state.trades.some(t => t.result === "pending");
    if (hasPending) {
        checking = true;
        try {
            await settleTrades();
        }
        catch (e) { /* ignore */ }
        checking = false;
        saveState();
        // If still pending after settle attempt, skip signal generation
        if (state.trades.some(t => t.result === "pending"))
            return;
    }
    const now = Math.floor(Date.now() / 1000);
    const currentWindowStart = Math.floor(now / 300) * 300;
    const timeInWindow = now - currentWindowStart;
    // Track window open price
    if (!windowOpenPrices.has(currentWindowStart)) {
        windowOpenPrices.set(currentWindowStart, price);
        // Cleanup old
        for (const [k] of windowOpenPrices) {
            if (k < currentWindowStart - 3600)
                windowOpenPrices.delete(k);
        }
    }
    const windowOpenPrice = windowOpenPrices.get(currentWindowStart);
    const delta = Math.abs(price - windowOpenPrice);
    const deltaPct = (delta / windowOpenPrice) * 100;
    // Quick pre-check: skip if move too small (avoid expensive market lookup)
    if (deltaPct < state.config.minDeltaPercent || delta < state.config.minDeltaAbsolute)
        return;
    // Already traded this window
    if (tradedWindows.has(currentWindowStart))
        return;
    // Cooldown after trade completes (win or loss)
    if (Date.now() - lastTradeTime < state.config.cooldownMs)
        return;
    // Sweet spot window: 90-150s
    // Too early (<90s): BTC hasn't committed, signal unreliable
    // Sweet spot (90-150s): Move confirmed, MMs haven't fully repriced (especially overnight)
    // Too late (>150s): MMs caught up, orderbook already reflects the move
    if (timeInWindow < 90 || timeInWindow > 150)
        return;
    // Overnight filter: only trade UTC 22-06 when MM repricing is slower
    const hourUTC = new Date().getUTCHours();
    const isOvernight = hourUTC >= 22 || hourUTC <= 6;
    if (!isOvernight) {
        // During active hours, MMs reprice instantly — no edge
        if (tickCount % 300 === 1)
            console.log(`[skip] Active hours (UTC ${hourUTC}), overnight-only mode`);
        return;
    }
    checking = true;
    checkCount++;
    try {
        // Settle old trades
        await settleTrades();
        // Get market prices
        const market = await findCurrentMarket();
        if (!market) {
            checking = false;
            return;
        }
        // Subscribe to Polymarket WS for this market's tokens (idempotent per window)
        priceEngine.subscribeMarket(market.upTokenId, market.downTokenId);
        // Use live Polymarket WS orderbook if available, else fall back to REST data
        const pb = priceEngine.polyBook;
        const bookAge = Date.now() - pb.lastUpdate;
        if (pb.lastUpdate > 0 && bookAge < 10000) {
            // Live data from Polymarket WS (< 10s old)
            market.upBestAsk = pb.upBestAsk;
            market.downBestAsk = pb.downBestAsk;
            market.upBestBid = pb.upBestBid;
            market.downBestBid = pb.downBestBid;
            market.upAskDepth = pb.upAskDepth;
            market.downAskDepth = pb.downAskDepth;
            console.log(`[book] LIVE UP: bid=$${pb.upBestBid} ask=$${pb.upBestAsk} | DOWN: bid=$${pb.downBestBid} ask=$${pb.downBestAsk} | mid: UP=$${market.upPrice} DOWN=$${market.downPrice} (${bookAge}ms ago)`);
        }
        else {
            // Fallback to REST-fetched data from market engine
            console.log(`[book] REST UP: bid=$${market.upBestBid} ask=$${market.upBestAsk}(${market.upAskDepth.toFixed(0)}) | DOWN: bid=$${market.downBestBid} ask=$${market.downBestAsk}(${market.downAskDepth.toFixed(0)}) | mid: UP=$${market.upPrice} DOWN=$${market.downPrice}`);
        }
        // Generate signal
        const signal = generateSignal(windowOpenPrice, price, market.upPrice, market.downPrice, timeInWindow, state.config);
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
        // Execute trade — use real orderbook best ask to cross the spread
        const tokenPrice = signal.direction === "UP" ? market.upPrice : market.downPrice;
        const bestAsk = signal.direction === "UP" ? market.upBestAsk : market.downBestAsk;
        const askDepth = signal.direction === "UP" ? market.upAskDepth : market.downAskDepth;
        let bidPrice;
        if (bestAsk > 0 && bestAsk <= state.config.maxPrice) {
            // Use real best ask from orderbook — this is the price to cross the spread
            bidPrice = bestAsk;
            console.log(`[bid] mid=$${tokenPrice.toFixed(2)} | bestAsk=$${bestAsk} (${askDepth.toFixed(0)} tokens) → bidding $${bidPrice}`);
        }
        else {
            // Fallback: mid + 5¢ if orderbook data unavailable
            bidPrice = Math.min(parseFloat((tokenPrice + 0.05).toFixed(2)), state.config.maxPrice);
            console.log(`[bid] mid=$${tokenPrice.toFixed(2)} | no ask data → fallback bidding $${bidPrice}`);
        }
        // Kelly-adjacent sizing: bet a fraction of bankroll based on edge
        // Kelly f* = (p*b - q) / b where p=win%, b=payout ratio, q=loss%
        // With 72% WR and ~0.7 payout: full Kelly ~32%. We use quarter Kelly for safety.
        const minBet = state.config.positionSize; // floor (default $100)
        const maxBet = state.config.maxPositionSize ?? 10000;
        const compoundPct = state.config.compoundFraction ?? 0.35; // 35% of wallet per trade
        // Use ACTUAL wallet balance for sizing — compound on real money
        let walletBalance = await getWalletBalance();
        if (walletBalance < 0)
            walletBalance = state.config.bankroll ?? 500; // fallback
        const tradeSize = Math.min(Math.max(walletBalance * compoundPct, minBet), maxBet);
        console.log(`[compound] wallet=$${walletBalance.toFixed(0)} × ${(compoundPct * 100).toFixed(0)}% = $${tradeSize.toFixed(2)} (floor $${minBet}, cap $${maxBet})`);
        const size = Math.floor(tradeSize / bidPrice);
        if (size < 1) {
            checking = false;
            return;
        }
        const cost = size * bidPrice;
        const tokenId = signal.direction === "UP" ? market.upTokenId : market.downTokenId;
        const fairValue = signal.priceDelta ?
            Math.min(state.config.fairValueBase + (Math.abs(signal.priceDelta.percent) * state.config.fairValueMultiplier * (0.5 + timeInWindow / 600)), state.config.fairValueCap) : 0;
        console.log(`\n[bot] 🎯 ${signal.direction} | ${size} tokens @ $${bidPrice} = $${cost.toFixed(2)} | ${timeInWindow}s into window`);
        signal.reasons.forEach(r => console.log(`  → ${r}`));
        const trade = {
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
            // Snapshot wallet balance BEFORE the order
            const balBefore = await getWalletBalance();
            trade.walletBefore = balBefore;
            // If balance is less than planned cost, size down to what we have (keep $1 buffer for rounding)
            if (balBefore >= 0 && balBefore < cost) {
                const availableCost = Math.floor((balBefore - 1) * 100) / 100;
                if (availableCost < 5) {
                    console.log(`[bot] ❌ Wallet too low: $${balBefore.toFixed(2)}, need at least $5`);
                    checking = false;
                    return;
                }
                const newSize = Math.floor(availableCost / bidPrice);
                const newCost = newSize * bidPrice;
                console.log(`[bot] ⚠️ Sizing down: $${cost.toFixed(2)} → $${newCost.toFixed(2)} (wallet: $${balBefore.toFixed(2)})`);
                trade.size = newSize;
                trade.cost = newCost;
                // Update locals for order
                Object.assign(trade, { size: newSize, cost: newCost });
            }
            try {
                const order = await clobClient.createOrder({
                    tokenID: tokenId,
                    price: bidPrice,
                    side: "BUY",
                    size: trade.size,
                });
                const result = await clobClient.postOrder(order);
                const orderId = result?.orderID || result?.id || null;
                // CRITICAL: Verify the order actually went through
                if (!orderId || orderId === "unknown") {
                    const errMsg = result?.error || result?.data?.error || "unknown order ID";
                    console.error(`[bot] ❌ Order NOT placed: ${errMsg}`);
                    checking = false;
                    return;
                }
                trade.orderId = orderId;
                trade.conditionId = market.conditionId;
                console.log(`[bot] 📋 Order on book: ${orderId}`);
                // Wait briefly for matching then verify fill
                await new Promise(r => setTimeout(r, 3000));
                try {
                    const orderStatus = await clobClient.getOrder(orderId);
                    const matched = parseInt(orderStatus?.size_matched || "0");
                    const status = orderStatus?.status || "unknown";
                    if (matched === 0) {
                        // Order not filled — cancel it and skip
                        console.error(`[bot] ❌ Order NOT filled (size_matched=0, status=${status}). Canceling.`);
                        try {
                            await clobClient.cancelOrder({ orderID: orderId });
                        }
                        catch { }
                        checking = false;
                        return;
                    }
                    // Partially or fully filled
                    trade.size = matched;
                    trade.cost = matched * bidPrice;
                    console.log(`[bot] ✅ Order filled: ${matched}/${trade.size} tokens matched (status=${status})`);
                }
                catch (e) {
                    // If we can't verify, assume it went through but log warning
                    console.log(`[bot] ⚠️ Could not verify fill (${e.message}), proceeding with trade`);
                }
            }
            catch (e) {
                const errData = e?.response?.data?.error || e.message;
                console.error(`[bot] ❌ Order failed: ${errData}`);
                checking = false;
                return;
            }
        }
        else {
            console.log("[bot] 🏜️ DRY RUN");
        }
        state.trades.push(trade);
        if (state.trades.length > 200)
            state.trades.shift();
        tradedWindows.add(currentWindowStart);
        lastTradeTime = Date.now();
        saveState();
    }
    catch (e) {
        console.error(`[bot] Error: ${e.message}`);
    }
    checking = false;
}
// ── Settlement loop (for trades where we missed the tick) ───
setInterval(async () => {
    if (!state.paused)
        await settleTrades();
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
            sessionStartBalance: state.sessionStartBalance != null ? `$${state.sessionStartBalance.toFixed(2)}` : "unknown",
        },
        config: {
            positionSize: state.config.positionSize,
            maxPositionSize: state.config.maxPositionSize ?? 10000,
            pnlFloor: state.config.pnlFloor ?? -100,
            winStreak: state.winStreak ?? 0,
            effectiveSize: `${((state.config.compoundFraction ?? 0.35) * 100).toFixed(0)}% of wallet`,
            sizingMode: "compound",
            compoundPct: state.config.compoundFraction ?? 0.35,
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
app.get("/wallet", async (_req, res) => {
    const bal = await getWalletBalance();
    const sessionPnL = state.sessionStartBalance != null && bal >= 0
        ? bal - state.sessionStartBalance
        : null;
    res.json({
        balance: bal >= 0 ? `$${bal.toFixed(2)}` : "error",
        sessionStartBalance: state.sessionStartBalance != null ? `$${state.sessionStartBalance.toFixed(2)}` : "unknown",
        sessionPnL: sessionPnL != null ? `$${sessionPnL.toFixed(2)}` : "unknown",
        calculatedPnL: `$${state.totalPnL.toFixed(2)}`,
    });
});
app.get("/trades", (_req, res) => {
    res.json(state.trades.slice(-50).reverse());
});
app.get("/stats/hourly", (_req, res) => {
    const hourly = {};
    for (let h = 0; h < 24; h++)
        hourly[h] = { trades: 0, wins: 0, losses: 0, pnl: 0 };
    for (const t of state.trades) {
        if (t.result === "dry-run" || t.result === "pending")
            continue;
        const h = t.hourUTC ?? new Date(t.timestamp).getUTCHours();
        hourly[h].trades++;
        if (t.result === "win")
            hourly[h].wins++;
        if (t.result === "loss")
            hourly[h].losses++;
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
        const patterns = {};
        for (const pm of pms) {
            const p = pm.pattern || "UNKNOWN";
            patterns[p] = (patterns[p] || 0) + 1;
        }
        res.json({ count: pms.length, patterns, recent: pms.slice(-5).reverse() });
    }
    catch {
        res.json({ count: 0, patterns: {}, recent: [] });
    }
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
    const allowed = [...Object.keys(DEFAULT_CONFIG), "bankroll", "kellyFraction", "minPositionSize", "compoundFraction", "maxPositionSize", "pnlFloor"];
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
    if (!state.config.dryRun) {
        clobClient = await initClobClient();
    }
    // Record session start balance from wallet (preserve if already set in state.json)
    if (state.sessionStartBalance != null && state.sessionStartBalance > 0) {
        console.log(`[bot] Session start balance (preserved): $${state.sessionStartBalance.toFixed(2)} USDC.e`);
    }
    else {
        const startBal = await getWalletBalance();
        if (startBal >= 0) {
            state.sessionStartBalance = startBal;
            console.log(`[bot] Session start balance: $${startBal.toFixed(2)} USDC.e`);
        }
        else {
            console.log(`[bot] ⚠️ Could not read wallet balance at start`);
        }
    }
    await priceEngine.bootstrap();
    priceEngine.connectBinance();
    priceEngine.connectPolymarket();
    priceEngine.startCoinGeckoPolling();
    // Event-driven: check on every price tick from Bybit WebSocket
    priceEngine.on("tick", ({ source, price }) => {
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
