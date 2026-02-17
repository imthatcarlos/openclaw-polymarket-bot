/**
 * Polymarket BTC 5-Min Trading Bot v7 — "Panic Catcher"
 *
 * Strategy: Place cheap limit orders on BOTH sides at window open.
 * When BTC moves hard, panic sellers dump the losing side to pennies.
 * Our standing limit order fills at $0.05-0.08. If it wins → 12-19x return.
 * If it loses → we risked $0.05-0.08 per token. Asymmetric payoff.
 *
 * No directional prediction needed. No latency race with MMs.
 * We ARE the liquidity that panic sellers hit.
 */
import express from "express";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import { PriceEngine } from "./price-engine.js";
import { findCurrentMarket, checkMarketOutcome } from "./market-engine.js";
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
const DEFAULT_PANIC_CONFIG = {
    bidPrice: 0.06,
    maxBidPrice: 0.10,
    sizePerSide: 15,
    maxTotalExposure: 100,
    placeAtSecond: 5,
    cancelAtSecond: 270,
    minSpread: 0.03,
    dryRun: true, // Start in dry run!
    pnlFloor: -50,
};
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
    const prov = signer.provider;
    const gasPrice = await prov.getGasPrice();
    const bumped = gasPrice.mul(130).div(100);
    return { gasPrice: bumped };
}
async function redeemPosition(conditionId) {
    if (!signer)
        return false;
    try {
        const ctf = new ethers.Contract(CTF_ADDRESS, [
            "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external"
        ], signer);
        const tx = await ctf.redeemPositions(USDC_ADDRESS, ethers.constants.HashZero, conditionId, [1, 2], { ...(await getDynamicGas()), gasLimit: 300000 });
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
                config: { ...DEFAULT_PANIC_CONFIG, ...s.config },
                trades: s.trades ?? [],
                totalPnL: s.totalPnL ?? 0,
                wins: s.wins ?? 0,
                losses: s.losses ?? 0,
                skips: s.skips ?? 0,
                paused: s.paused ?? false,
                sessionStartBalance: s.sessionStartBalance ?? undefined,
                activeOrders: s.activeOrders ?? [],
            };
        }
        catch { }
    }
    return { config: { ...DEFAULT_PANIC_CONFIG }, trades: [], totalPnL: 0, wins: 0, losses: 0, skips: 0, paused: false, activeOrders: [] };
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
            activeOrders: state.activeOrders,
        }, null, 2));
    }
    catch { }
}
const state = loadState();
const priceEngine = new PriceEngine();
let clobClient = null;
let startedAt = Date.now();
let tickCount = 0;
let lastWindowPlaced = 0; // Track which window we've placed orders for
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
// ── Place Orders on Both Sides ──────────────────────────────
async function placeOrders(market, btcPrice) {
    const cfg = state.config;
    const windowStart = market.windowStart;
    // Calculate total current exposure
    const currentExposure = state.activeOrders
        .filter(o => o.status === "placed" || o.status === "filled")
        .reduce((sum, o) => sum + o.cost, 0);
    if (currentExposure + cfg.sizePerSide * 2 > cfg.maxTotalExposure) {
        console.log(`[panic] Skip: exposure $${currentExposure.toFixed(2)} + $${(cfg.sizePerSide * 2).toFixed(2)} > max $${cfg.maxTotalExposure}`);
        state.skips++;
        return;
    }
    // Check wallet
    const wallet = await getWalletBalance();
    if (wallet >= 0 && wallet < cfg.sizePerSide * 2 + 5) {
        console.log(`[panic] Skip: wallet $${wallet.toFixed(2)} too low for $${(cfg.sizePerSide * 2).toFixed(2)} orders`);
        return;
    }
    const bidPrice = cfg.bidPrice;
    const tokensPerSide = Math.floor(cfg.sizePerSide / bidPrice);
    const costPerSide = tokensPerSide * bidPrice;
    console.log(`\n[panic] 🎯 Window ${windowStart} | Placing BOTH sides @ $${bidPrice}`);
    console.log(`  → UP: ${tokensPerSide} tokens × $${bidPrice} = $${costPerSide.toFixed(2)}`);
    console.log(`  → DOWN: ${tokensPerSide} tokens × $${bidPrice} = $${costPerSide.toFixed(2)}`);
    console.log(`  → Total risk: $${(costPerSide * 2).toFixed(2)} | Max win: $${(tokensPerSide - costPerSide).toFixed(2)} per side`);
    console.log(`  → BTC: $${btcPrice.toFixed(0)} | Book: UP bid=$${market.upBestBid} ask=$${market.upBestAsk} | DOWN bid=$${market.downBestBid} ask=$${market.downBestAsk}`);
    // Place UP limit order
    const upOrder = await placeSingleOrder(market, "UP", market.upTokenId, bidPrice, tokensPerSide, costPerSide, btcPrice);
    if (upOrder)
        state.activeOrders.push(upOrder);
    // Place DOWN limit order
    const downOrder = await placeSingleOrder(market, "DOWN", market.downTokenId, bidPrice, tokensPerSide, costPerSide, btcPrice);
    if (downOrder)
        state.activeOrders.push(downOrder);
    lastWindowPlaced = windowStart;
    saveState();
}
async function placeSingleOrder(market, direction, tokenId, bidPrice, size, cost, btcPrice) {
    const order = {
        windowStart: market.windowStart,
        direction,
        tokenId,
        orderId: null,
        bidPrice,
        size,
        cost,
        status: "placed",
        fillSize: 0,
        fillCost: 0,
        placedAt: Date.now(),
    };
    if (state.config.dryRun) {
        order.orderId = `dry-${direction}-${market.windowStart}`;
        console.log(`[panic] 🏜️ DRY RUN: ${direction} ${size} tokens @ $${bidPrice}`);
        return order;
    }
    if (!clobClient) {
        console.log(`[panic] ❌ No CLOB client`);
        return null;
    }
    try {
        const clobOrder = await clobClient.createOrder({
            tokenID: tokenId,
            price: bidPrice,
            side: "BUY",
            size: size,
        });
        const result = await clobClient.postOrder(clobOrder);
        const orderId = result?.orderID || result?.id || null;
        if (!orderId || orderId === "unknown") {
            const errMsg = result?.error || result?.data?.error || "unknown";
            console.error(`[panic] ❌ ${direction} order failed: ${errMsg}`);
            return null;
        }
        order.orderId = orderId;
        console.log(`[panic] ✅ ${direction} order placed: ${orderId}`);
        return order;
    }
    catch (e) {
        const errData = e?.response?.data?.error || e.message;
        console.error(`[panic] ❌ ${direction} order error: ${errData}`);
        return null;
    }
}
// ── Check Fills on Active Orders ────────────────────────────
async function checkFills() {
    if (!clobClient)
        return;
    for (const order of state.activeOrders) {
        if (order.status !== "placed" || !order.orderId || order.orderId.startsWith("dry-"))
            continue;
        try {
            const orderStatus = await clobClient.getOrder(order.orderId);
            const matched = parseInt(orderStatus?.size_matched || "0");
            if (matched > 0 && order.fillSize === 0) {
                // Newly filled!
                order.fillSize = matched;
                order.fillCost = matched * order.bidPrice;
                order.status = "filled";
                console.log(`[panic] 🔥 FILL: ${order.direction} ${matched} tokens @ $${order.bidPrice} = $${order.fillCost.toFixed(2)} (window ${order.windowStart})`);
                // Get wallet balance before potential settlement
                const walBefore = await getWalletBalance();
                // Record as trade
                const trade = {
                    timestamp: Date.now(),
                    market: `btc-updown-5m-${order.windowStart}`,
                    windowStart: order.windowStart,
                    direction: order.direction,
                    price: order.bidPrice,
                    size: matched,
                    cost: order.fillCost,
                    result: "pending",
                    pnl: 0,
                    orderId: order.orderId,
                    walletBefore: walBefore,
                    btcAtEntry: priceEngine.lastBinancePrice,
                    btcWindowOpen: priceEngine.lastBinancePrice, // approximate
                    hourUTC: new Date().getUTCHours(),
                };
                state.trades.push(trade);
                if (state.trades.length > 200)
                    state.trades.shift();
                saveState();
                // Cancel the OTHER side's order for this window (we have a fill, reduce exposure)
                const otherSide = state.activeOrders.find(o => o.windowStart === order.windowStart && o.direction !== order.direction && o.status === "placed");
                if (otherSide && otherSide.orderId && !otherSide.orderId.startsWith("dry-")) {
                    try {
                        await clobClient.cancelOrder({ orderID: otherSide.orderId });
                        otherSide.status = "canceled";
                        console.log(`[panic] Canceled ${otherSide.direction} order (other side filled)`);
                    }
                    catch { }
                }
            }
        }
        catch (e) {
            // Ignore individual order check failures
        }
    }
}
// ── Cancel Expired Orders ───────────────────────────────────
async function cancelExpiredOrders() {
    const now = Math.floor(Date.now() / 1000);
    for (const order of state.activeOrders) {
        if (order.status !== "placed")
            continue;
        const timeInWindow = now - order.windowStart;
        // Cancel if past cancel time or window has ended
        if (timeInWindow >= state.config.cancelAtSecond || timeInWindow >= 300) {
            if (order.orderId && !order.orderId.startsWith("dry-") && clobClient) {
                try {
                    await clobClient.cancelOrder({ orderID: order.orderId });
                    console.log(`[panic] Canceled unfilled ${order.direction} order (window ${order.windowStart}, ${timeInWindow}s in)`);
                }
                catch { }
            }
            order.status = "expired";
        }
    }
    // Cleanup old orders (keep last 100)
    if (state.activeOrders.length > 100) {
        state.activeOrders = state.activeOrders.slice(-100);
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
        // Find conditionId from active orders
        const relatedOrder = state.activeOrders.find(o => o.windowStart === trade.windowStart && o.direction === trade.direction);
        if (won) {
            trade.result = "win";
            state.wins++;
            // Find conditionId from market
            try {
                const market = await findMarketByWindow(trade.windowStart);
                if (market?.conditionId) {
                    console.log(`[settle] Redeeming winning position...`);
                    await redeemPosition(market.conditionId);
                }
            }
            catch { }
            const balAfter = await getWalletBalance();
            trade.walletAfter = balAfter;
            if (trade.walletBefore != null && trade.walletBefore >= 0 && balAfter >= 0) {
                trade.pnl = balAfter - trade.walletBefore;
            }
            else {
                // Approximate: won tokens * $1 - cost
                trade.pnl = trade.size * 1.0 - trade.cost;
            }
            console.log(`[settle] ✅ WIN ${trade.direction} | Bought ${trade.size} @ $${trade.price} ($${trade.cost.toFixed(2)}) → $${trade.size.toFixed(2)} payout | P&L: +$${trade.pnl.toFixed(2)}`);
        }
        else {
            trade.result = "loss";
            state.losses++;
            const balAfter = await getWalletBalance();
            trade.walletAfter = balAfter;
            trade.pnl = -trade.cost; // Tokens worthless
            console.log(`[settle] ❌ LOSS ${trade.direction} | Lost $${trade.cost.toFixed(2)} (${trade.size} tokens @ $${trade.price})`);
            // Post-mortem
            try {
                appendFileSync(PM_FILE, JSON.stringify({
                    timestamp: new Date().toISOString(),
                    strategy: "panic-catcher",
                    direction: trade.direction,
                    cost: trade.cost,
                    price: trade.price,
                    size: trade.size,
                    windowStart: trade.windowStart,
                    hourUTC: trade.hourUTC,
                }) + "\n");
            }
            catch { }
        }
        state.totalPnL += trade.pnl;
        saveState();
        const currentBal = trade.walletAfter ?? await getWalletBalance();
        if (state.sessionStartBalance != null && currentBal >= 0) {
            const sessionPnL = currentBal - state.sessionStartBalance;
            console.log(`[settle] Session P&L: $${sessionPnL.toFixed(2)} (wallet: $${currentBal.toFixed(2)})`);
        }
        // Circuit breaker
        const floor = state.config.pnlFloor;
        if (state.totalPnL <= floor) {
            console.log(`[circuit-breaker] 🛑 P&L $${state.totalPnL.toFixed(2)} hit floor $${floor}. Auto-pausing.`);
            state.paused = true;
            saveState();
            return;
        }
    }
}
async function findMarketByWindow(windowStart) {
    // Temporarily override time-based check in findCurrentMarket by fetching directly
    const slug = `btc-updown-5m-${windowStart}`;
    try {
        const PROXY_SECRET = process.env.PROXY_SECRET || "";
        const res = await fetch(PROXY_URL, {
            headers: { "x-target-url": `https://gamma-api.polymarket.com/events/slug/${slug}`, "x-proxy-secret": PROXY_SECRET },
        });
        if (!res.ok)
            return null;
        const event = await res.json();
        const market = event?.markets?.[0];
        if (!market)
            return null;
        return { conditionId: market.conditionId };
    }
    catch {
        return null;
    }
}
// ── Dry Run Simulation ──────────────────────────────────────
// In dry run, simulate fills when price moves enough to make one side cheap
function simulateDryRunFills(btcPrice) {
    const now = Math.floor(Date.now() / 1000);
    for (const order of state.activeOrders) {
        if (order.status !== "placed" || !order.orderId?.startsWith("dry-"))
            continue;
        const windowStart = order.windowStart;
        const timeInWindow = now - windowStart;
        // Need a window open price to calculate delta
        const windowOpen = priceEngine.windowOpenPrices?.get(windowStart);
        if (!windowOpen)
            continue;
        const delta = btcPrice - windowOpen;
        const deltaPct = Math.abs(delta / windowOpen) * 100;
        // Simulate: if BTC moved >0.15% (~$100), the losing side's asks crash to our bid level
        // UP crashes when BTC drops, DOWN crashes when BTC rises
        // At 0.15%, real orderbook shows losing side asks dropping to $0.10-0.20 range
        // Our $0.06 limit would realistically fill at ~0.20%+ moves
        const wouldFill = (order.direction === "UP" && delta < 0 && deltaPct > 0.15) ||
            (order.direction === "DOWN" && delta > 0 && deltaPct > 0.15);
        if (wouldFill && timeInWindow >= 30 && timeInWindow <= 270) {
            order.status = "filled";
            order.fillSize = order.size;
            order.fillCost = order.cost;
            console.log(`[dry-run] 🔥 SIMULATED FILL: ${order.direction} ${order.size} tokens @ $${order.bidPrice} (BTC Δ: ${delta > 0 ? '+' : ''}$${delta.toFixed(0)}, ${deltaPct.toFixed(2)}%)`);
            // Record trade
            const trade = {
                timestamp: Date.now(),
                market: `btc-updown-5m-${windowStart}`,
                windowStart,
                direction: order.direction,
                price: order.bidPrice,
                size: order.size,
                cost: order.cost,
                result: "dry-run",
                pnl: 0,
                orderId: order.orderId,
                btcAtEntry: btcPrice,
                btcWindowOpen: windowOpen,
                hourUTC: new Date().getUTCHours(),
            };
            // In dry run, calculate hypothetical outcome
            // The fill is on the LOSING side (panic). Does it reverse?
            // We'll check at settlement. For now mark as dry-run.
            state.trades.push(trade);
            if (state.trades.length > 200)
                state.trades.shift();
            // Cancel other side
            const otherSide = state.activeOrders.find(o => o.windowStart === windowStart && o.direction !== order.direction && o.status === "placed");
            if (otherSide) {
                otherSide.status = "canceled";
                console.log(`[dry-run] Canceled ${otherSide.direction} (other side filled)`);
            }
        }
    }
}
// Settle dry-run trades
async function settleDryRuns() {
    const dryPending = state.trades.filter(t => t.result === "dry-run" && t.windowStart > 0);
    for (const trade of dryPending) {
        if (Date.now() / 1000 < trade.windowStart + 360)
            continue;
        const winner = await checkMarketOutcome(trade.windowStart);
        if (!winner || winner === "pending")
            continue;
        const won = (trade.direction === "UP" && winner === "Up") ||
            (trade.direction === "DOWN" && winner === "Down");
        if (won) {
            trade.pnl = trade.size * 1.0 - trade.cost; // tokens worth $1 each
            state.wins++;
            console.log(`[dry-settle] ✅ WIN ${trade.direction} @ $${trade.price} | ${trade.size} tokens | P&L: +$${trade.pnl.toFixed(2)} (${(trade.pnl / trade.cost * 100).toFixed(0)}% return)`);
        }
        else {
            trade.pnl = -trade.cost;
            state.losses++;
            console.log(`[dry-settle] ❌ LOSS ${trade.direction} @ $${trade.price} | Lost $${trade.cost.toFixed(2)}`);
        }
        trade.result = won ? "win" : "loss";
        state.totalPnL += trade.pnl;
        saveState();
    }
}
// ── Core Tick Handler ───────────────────────────────────────
let processing = false;
async function onTick(price) {
    if (state.paused || processing)
        return;
    tickCount++;
    const now = Math.floor(Date.now() / 1000);
    const currentWindowStart = Math.floor(now / 300) * 300;
    const timeInWindow = now - currentWindowStart;
    // Track window open prices for dry run simulation
    if (!priceEngine.windowOpenPrices)
        priceEngine.windowOpenPrices = new Map();
    if (!priceEngine.windowOpenPrices.has(currentWindowStart)) {
        priceEngine.windowOpenPrices.set(currentWindowStart, price);
        // Cleanup old
        for (const [k] of priceEngine.windowOpenPrices) {
            if (k < currentWindowStart - 3600)
                priceEngine.windowOpenPrices.delete(k);
        }
    }
    // Log periodic tick
    if (tickCount % 120 === 1) {
        const activeCount = state.activeOrders.filter(o => o.status === "placed").length;
        const pendingCount = state.trades.filter(t => t.result === "pending" || (t.result === "dry-run" && Date.now() / 1000 < t.windowStart + 360)).length;
        console.log(`[tick] #${tickCount} price=$${price.toFixed(2)} window=${timeInWindow}s | active_orders=${activeCount} pending_trades=${pendingCount}`);
    }
    // Dry run fill simulation
    if (state.config.dryRun) {
        simulateDryRunFills(price);
    }
    // Only process order placement/management every few seconds to avoid hammering APIs
    if (tickCount % 5 !== 0)
        return;
    processing = true;
    try {
        // 1. Settle completed trades
        if (state.config.dryRun) {
            await settleDryRuns();
        }
        else {
            await settleTrades();
        }
        // 2. Check fills on active orders
        if (!state.config.dryRun) {
            await checkFills();
        }
        // 3. Cancel expired orders  
        await cancelExpiredOrders();
        // 4. Place new orders if it's time
        if (timeInWindow >= state.config.placeAtSecond &&
            timeInWindow <= 60 && // Only place in first 60s
            lastWindowPlaced !== currentWindowStart) {
            const market = await findCurrentMarket();
            if (market) {
                // Subscribe to WS for live data
                priceEngine.subscribeMarket(market.upTokenId, market.downTokenId);
                // Update market with live book if available
                const pb = priceEngine.polyBook;
                const bookAge = Date.now() - pb.lastUpdate;
                if (pb.lastUpdate > 0 && bookAge < 10000) {
                    market.upBestAsk = pb.upBestAsk;
                    market.downBestAsk = pb.downBestAsk;
                    market.upBestBid = pb.upBestBid;
                    market.downBestBid = pb.downBestBid;
                }
                console.log(`[book] UP: bid=$${market.upBestBid.toFixed(2)} ask=$${market.upBestAsk.toFixed(2)} | DOWN: bid=$${market.downBestBid.toFixed(2)} ask=$${market.downBestAsk.toFixed(2)}`);
                await placeOrders(market, price);
            }
            else {
                state.skips++;
            }
        }
    }
    catch (e) {
        console.error(`[bot] Error: ${e.message}`);
    }
    processing = false;
}
// ── Settlement loop (backup) ────────────────────────────────
setInterval(async () => {
    if (!state.paused) {
        if (state.config.dryRun) {
            await settleDryRuns();
        }
        else {
            await settleTrades();
            await checkFills();
        }
        await cancelExpiredOrders();
        saveState();
    }
}, 30_000);
// ── HTTP API ────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.get("/status", async (_req, res) => {
    const nowSec = Math.floor(Date.now() / 1000);
    const cwStart = Math.floor(nowSec / 300) * 300;
    const timeInWindow = nowSec - cwStart;
    const wallet = await getWalletBalance();
    const sessionPnL = state.sessionStartBalance != null && wallet >= 0
        ? wallet - state.sessionStartBalance : null;
    const activeOrders = state.activeOrders.filter(o => o.status === "placed");
    const filledOrders = state.activeOrders.filter(o => o.status === "filled");
    res.json({
        version: "v7-panic-catcher",
        running: true,
        paused: state.paused,
        dryRun: state.config.dryRun,
        uptime: `${Math.floor((Date.now() - startedAt) / 60000)}m`,
        price: {
            btc: priceEngine.lastBinancePrice.toFixed(2),
            timeInWindow: `${timeInWindow}s`,
        },
        ticks: tickCount,
        orders: {
            active: activeOrders.length,
            filled: filledOrders.length,
            activeDetail: activeOrders.map(o => ({
                window: o.windowStart,
                direction: o.direction,
                price: `$${o.bidPrice}`,
                size: o.size,
                cost: `$${o.cost.toFixed(2)}`,
            })),
        },
        stats: {
            trades: state.trades.filter(t => t.result !== "dry-run").length,
            dryRunTrades: state.trades.filter(t => t.result === "dry-run" || t.result === "win" || t.result === "loss").length,
            wins: state.wins,
            losses: state.losses,
            pending: state.trades.filter(t => t.result === "pending").length,
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
            price: `$${t.price}`,
            size: t.size,
            cost: `$${t.cost.toFixed(2)}`,
            result: t.result,
            pnl: `$${t.pnl.toFixed(2)}`,
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
app.get("/trades", (_req, res) => {
    res.json(state.trades.slice(-50).reverse());
});
app.get("/orders", (_req, res) => {
    res.json({
        active: state.activeOrders.filter(o => o.status === "placed"),
        filled: state.activeOrders.filter(o => o.status === "filled").slice(-20),
        canceled: state.activeOrders.filter(o => o.status === "canceled" || o.status === "expired").slice(-20),
    });
});
app.get("/stats/hourly", (_req, res) => {
    const hourly = {};
    for (let h = 0; h < 24; h++)
        hourly[h] = { trades: 0, wins: 0, losses: 0, pnl: 0 };
    for (const t of state.trades) {
        if (t.result === "pending")
            continue;
        const h = t.hourUTC ?? new Date(t.timestamp).getUTCHours();
        hourly[h].trades++;
        if (t.result === "win")
            hourly[h].wins++;
        if (t.result === "loss")
            hourly[h].losses++;
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
    }
    catch {
        res.json({ count: 0, recent: [] });
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
    const allowed = Object.keys(DEFAULT_PANIC_CONFIG);
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
    console.log("  Polymarket BTC 5-Min Bot v7 — Panic Catcher");
    console.log(`  Mode: ${state.config.dryRun ? "🏜️ DRY RUN" : "💰 LIVE"}`);
    console.log(`  Bid price: $${state.config.bidPrice}/token`);
    console.log(`  Size per side: $${state.config.sizePerSide}`);
    console.log(`  Max exposure: $${state.config.maxTotalExposure}`);
    console.log(`  P&L floor: $${state.config.pnlFloor}`);
    console.log(`  History: ${state.trades.length} trades, ${state.wins}W/${state.losses}L, $${state.totalPnL.toFixed(2)} P&L`);
    console.log("═══════════════════════════════════════════════\n");
    if (!state.config.dryRun) {
        clobClient = await initClobClient();
    }
    // Session start balance
    if (state.sessionStartBalance != null && state.sessionStartBalance > 0) {
        console.log(`[bot] Session start balance (preserved): $${state.sessionStartBalance.toFixed(2)}`);
    }
    else {
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
