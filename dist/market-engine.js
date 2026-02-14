/**
 * Market Engine — finds and tracks Polymarket 5-min BTC markets
 * Uses EU proxy to bypass US geo-block
 */
const PROXY_URL = process.env.PROXY_URL || "https://polymarket-proxy-production.up.railway.app";
const PROXY_SECRET = process.env.PROXY_SECRET || "";
const GAMMA_BASE = "https://gamma-api.polymarket.com";
async function proxiedFetch(targetUrl) {
    return fetch(PROXY_URL, {
        headers: {
            "x-target-url": targetUrl,
            "x-proxy-secret": PROXY_SECRET,
        },
    });
}
export async function findCurrentMarket() {
    const now = Math.floor(Date.now() / 1000);
    const currentWindowStart = Math.floor(now / 300) * 300;
    const timeIntoWindow = now - currentWindowStart;
    // Only trade current window, skip if >4 min in (arb can trade later)
    if (timeIntoWindow > 240)
        return null;
    const slug = `btc-updown-5m-${currentWindowStart}`;
    try {
        const res = await proxiedFetch(`${GAMMA_BASE}/events/slug/${slug}`);
        if (!res.ok)
            return null;
        const event = await res.json();
        if (!event?.id || !event?.markets?.length)
            return null;
        const market = event.markets[0];
        const clobTokenIds = JSON.parse(market.clobTokenIds || "[]");
        const outcomes = JSON.parse(market.outcomes || "[]");
        const outcomePrices = JSON.parse(market.outcomePrices || '["0.5","0.5"]');
        if (clobTokenIds.length < 2)
            return null;
        const upIdx = outcomes.findIndex((o) => /up/i.test(o));
        const downIdx = outcomes.findIndex((o) => /down/i.test(o));
        return {
            slug,
            question: market.question,
            conditionId: market.conditionId,
            endDate: market.endDate,
            windowStart: currentWindowStart,
            windowEnd: currentWindowStart + 300,
            upTokenId: clobTokenIds[upIdx >= 0 ? upIdx : 0],
            downTokenId: clobTokenIds[downIdx >= 0 ? downIdx : 1],
            upPrice: parseFloat(outcomePrices[upIdx >= 0 ? upIdx : 0]),
            downPrice: parseFloat(outcomePrices[downIdx >= 0 ? downIdx : 1]),
            acceptingOrders: market.acceptingOrders ?? true,
        };
    }
    catch (e) {
        return null;
    }
}
/**
 * Check market outcome after resolution
 * outcomePrices: ["1","0"] = Up won, ["0","1"] = Down won
 */
export async function checkMarketOutcome(windowStart) {
    const slug = `btc-updown-5m-${windowStart}`;
    try {
        const res = await proxiedFetch(`${GAMMA_BASE}/events/slug/${slug}`);
        if (!res.ok)
            return null;
        const event = await res.json();
        const market = event?.markets?.[0];
        if (!market)
            return null;
        const prices = JSON.parse(market.outcomePrices || "[]");
        if (prices[0] === "1")
            return "Up";
        if (prices[1] === "1")
            return "Down";
        return "pending";
    }
    catch {
        return null;
    }
}
