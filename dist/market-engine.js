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
    const currentWindowStart = Math.floor(now / 900) * 900;
    const timeIntoWindow = now - currentWindowStart;
    // Only trade current window, skip if >4 min in (arb can trade later)
    if (timeIntoWindow > 295)
        return null; // Allow trades up to 295s (v8 Last Look needs 240-290s)
    const slug = `btc-updown-15m-${currentWindowStart}`;
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
        const upTokenId = clobTokenIds[upIdx >= 0 ? upIdx : 0];
        const downTokenId = clobTokenIds[downIdx >= 0 ? downIdx : 1];
        const upMid = parseFloat(outcomePrices[upIdx >= 0 ? upIdx : 0]);
        const downMid = parseFloat(outcomePrices[downIdx >= 0 ? downIdx : 1]);
        // Fetch orderbook for both tokens — get best bids AND best asks
        let upBestBid = 0, downBestBid = 0;
        let upBestAsk = 0, downBestAsk = 0;
        let upAskDepth = 0, downAskDepth = 0;
        try {
            const upBookRes = await proxiedFetch(`https://clob.polymarket.com/book?token_id=${upTokenId}`);
            if (upBookRes.ok) {
                const book = await upBookRes.json();
                const bids = book?.bids || [];
                const asks = book?.asks || [];
                if (bids.length > 0) {
                    upBestBid = Math.max(...bids.map((b) => parseFloat(b.price)));
                }
                if (asks.length > 0) {
                    // Best ask = lowest price
                    const sortedAsks = asks.map((a) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
                        .sort((a, b) => a.price - b.price);
                    upBestAsk = sortedAsks[0].price;
                    upAskDepth = sortedAsks[0].size;
                }
            }
            const downBookRes = await proxiedFetch(`https://clob.polymarket.com/book?token_id=${downTokenId}`);
            if (downBookRes.ok) {
                const book = await downBookRes.json();
                const bids = book?.bids || [];
                const asks = book?.asks || [];
                if (bids.length > 0) {
                    downBestBid = Math.max(...bids.map((b) => parseFloat(b.price)));
                }
                if (asks.length > 0) {
                    const sortedAsks = asks.map((a) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
                        .sort((a, b) => a.price - b.price);
                    downBestAsk = sortedAsks[0].price;
                    downAskDepth = sortedAsks[0].size;
                }
            }
        }
        catch (e) {
            // Fall back to mid prices if orderbook fetch fails
        }
        return {
            slug,
            question: market.question,
            conditionId: market.conditionId,
            endDate: market.endDate,
            windowStart: currentWindowStart,
            windowEnd: currentWindowStart + 900,
            upTokenId,
            downTokenId,
            upPrice: upMid,
            downPrice: downMid,
            upBestBid,
            downBestBid,
            upBestAsk,
            downBestAsk,
            upAskDepth,
            downAskDepth,
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
    const slug = `btc-updown-15m-${windowStart}`;
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
