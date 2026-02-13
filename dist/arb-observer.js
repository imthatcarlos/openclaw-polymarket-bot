/**
 * Arb Observer — passive data collection
 * Logs Binance price delta vs Polymarket token prices every 15s per window.
 * No trades. Just watching for the edge.
 */
import { PriceEngine } from "./price-engine.js";
import { writeFileSync } from "fs";
const PROXY_URL = process.env.PROXY_URL || "https://polymarket-proxy-production.up.railway.app";
const PROXY_SECRET = process.env.PROXY_SECRET || "";
const GAMMA_BASE = "https://gamma-api.polymarket.com";
const DATA_FILE = new URL("../arb-data.jsonl", import.meta.url).pathname;
const priceEngine = new PriceEngine();
const windowOpenPrices = new Map();
let snapshotCount = 0;
let windowCount = 0;
async function getMarketPrices(windowStart) {
    const slug = `btc-updown-5m-${windowStart}`;
    try {
        const res = await fetch(PROXY_URL, {
            headers: { "x-target-url": `${GAMMA_BASE}/events/slug/${slug}`, "x-proxy-secret": PROXY_SECRET },
        });
        if (!res.ok)
            return null;
        const event = await res.json();
        const market = event?.markets?.[0];
        if (!market)
            return null;
        const prices = JSON.parse(market.outcomePrices || '["0.5","0.5"]');
        const outcomes = JSON.parse(market.outcomes || '["Up","Down"]');
        const upIdx = outcomes.findIndex((o) => /up/i.test(o));
        const downIdx = outcomes.findIndex((o) => /down/i.test(o));
        return {
            upPrice: parseFloat(prices[upIdx >= 0 ? upIdx : 0]),
            downPrice: parseFloat(prices[downIdx >= 0 ? downIdx : 1]),
            slug,
        };
    }
    catch {
        return null;
    }
}
// Rough fair value estimate based on how much BTC has moved
// If BTC is +$80 with 2 min left, Up is probably worth ~0.75+
function estimateFairPrice(deltaPct, timeLeftSec) {
    // More time left = more uncertainty = closer to 0.5
    // More delta = more certainty about direction
    const timeWeight = Math.max(0.3, 1 - (timeLeftSec / 300)); // 0.3 at start, 1.0 at end
    const deltaSignal = Math.min(Math.abs(deltaPct) * 8, 0.45); // cap at 0.45 (so max fair = 0.95)
    const upFair = deltaPct > 0
        ? 0.5 + deltaSignal * timeWeight
        : 0.5 - deltaSignal * timeWeight;
    return { up: Math.max(0.05, Math.min(0.95, upFair)), down: Math.max(0.05, Math.min(0.95, 1 - upFair)) };
}
async function snapshot() {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(now / 300) * 300;
    const timeIntoWindow = now - windowStart;
    const timeLeft = 300 - timeIntoWindow;
    // Track window open
    if (!windowOpenPrices.has(windowStart) && priceEngine.lastBinancePrice > 0) {
        windowOpenPrices.set(windowStart, priceEngine.lastBinancePrice);
        windowCount++;
        console.log(`\n── Window ${windowCount} | ${new Date(windowStart * 1000).toISOString()} ──`);
    }
    const openPrice = windowOpenPrices.get(windowStart);
    if (!openPrice || priceEngine.lastBinancePrice === 0)
        return;
    const delta = priceEngine.lastBinancePrice - openPrice;
    const deltaPct = (delta / openPrice) * 100;
    // Get Polymarket prices
    const market = await getMarketPrices(windowStart);
    const fair = estimateFairPrice(deltaPct, timeLeft);
    const snap = {
        ts: Date.now(),
        windowStart,
        timeIntoWindow,
        binancePrice: priceEngine.lastBinancePrice,
        windowOpenPrice: openPrice,
        priceDelta: delta,
        priceDeltaPct: deltaPct,
        upTokenPrice: market?.upPrice ?? null,
        downTokenPrice: market?.downPrice ?? null,
        fairUpPrice: fair.up,
        edgeUp: market ? fair.up - market.upPrice : null,
        edgeDown: market ? fair.down - market.downPrice : null,
        marketSlug: market?.slug ?? null,
    };
    // Log to file
    writeFileSync(DATA_FILE, JSON.stringify(snap) + "\n", { flag: "a" });
    snapshotCount++;
    // Pretty print
    const edgeStr = (edge) => edge === null ? "?" : (edge > 0 ? `+${(edge * 100).toFixed(0)}¢` : `${(edge * 100).toFixed(0)}¢`);
    const deltaStr = delta > 0 ? `+$${delta.toFixed(0)}` : `-$${Math.abs(delta).toFixed(0)}`;
    const hasEdge = (snap.edgeUp !== null && snap.edgeUp > 0.05) || (snap.edgeDown !== null && snap.edgeDown > 0.05);
    console.log(`  ${timeIntoWindow}s | BTC ${deltaStr} (${deltaPct > 0 ? "+" : ""}${deltaPct.toFixed(3)}%) | ` +
        `Up: $${market?.upPrice?.toFixed(2) ?? "?"} (fair: $${fair.up.toFixed(2)}, edge: ${edgeStr(snap.edgeUp)}) | ` +
        `Down: $${market?.downPrice?.toFixed(2) ?? "?"} (fair: $${fair.down.toFixed(2)}, edge: ${edgeStr(snap.edgeDown)})` +
        (hasEdge ? " 🔥 EDGE" : ""));
}
// Check settled results for completed windows
async function checkResults() {
    const now = Math.floor(Date.now() / 1000);
    for (const [windowStart, openPrice] of windowOpenPrices) {
        if (now < windowStart + 360)
            continue; // wait 60s after window end
        const slug = `btc-updown-5m-${windowStart}`;
        try {
            const res = await fetch(PROXY_URL, {
                headers: { "x-target-url": `${GAMMA_BASE}/events/slug/${slug}`, "x-proxy-secret": PROXY_SECRET },
            });
            const event = await res.json();
            const market = event?.markets?.[0];
            if (!market)
                continue;
            const prices = JSON.parse(market.outcomePrices || "[]");
            const winner = prices[0] === "1" ? "Up" : prices[1] === "1" ? "Down" : null;
            if (!winner)
                continue;
            console.log(`\n  ✅ Window ${slug} resolved: ${winner} (open: $${openPrice.toFixed(0)})`);
            windowOpenPrices.delete(windowStart);
        }
        catch { }
    }
}
async function main() {
    console.log("═══════════════════════════════════════════════");
    console.log("  Arb Observer — Passive Data Collection");
    console.log("  NO TRADES. Just watching.");
    console.log(`  Data: ${DATA_FILE}`);
    console.log("═══════════════════════════════════════════════\n");
    await priceEngine.bootstrap();
    priceEngine.connectBinance();
    priceEngine.startCoinGeckoPolling();
    // Snapshot every 30s (gentler on Gamma API)
    setInterval(snapshot, 30_000);
    setTimeout(snapshot, 3000);
    // Check results every 60s
    setInterval(checkResults, 60_000);
    // Summary every 5 min
    setInterval(() => {
        console.log(`\n  📊 ${snapshotCount} snapshots across ${windowCount} windows. Data: ${DATA_FILE}`);
    }, 300_000);
    console.log("Watching... (Ctrl+C to stop)\n");
}
process.on("SIGINT", () => {
    console.log(`\n\nDone. ${snapshotCount} snapshots saved to ${DATA_FILE}`);
    priceEngine.stop();
    process.exit(0);
});
main().catch(e => { console.error("Fatal:", e); process.exit(1); });
