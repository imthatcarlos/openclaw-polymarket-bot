/**
 * Market Engine — finds and tracks Polymarket 5-min BTC markets
 * Uses EU proxy to bypass US geo-block
 */

export interface MarketInfo {
  slug: string;
  question: string;
  conditionId: string;
  endDate: string;
  windowStart: number;
  windowEnd: number;
  upTokenId: string;
  downTokenId: string;
  upPrice: number;
  downPrice: number;
  upBestBid: number;   // highest buy offer on this token's book
  downBestBid: number; // highest buy offer on this token's book
  acceptingOrders: boolean;
}

const PROXY_URL = process.env.PROXY_URL || "https://polymarket-proxy-production.up.railway.app";
const PROXY_SECRET = process.env.PROXY_SECRET || "";
const GAMMA_BASE = "https://gamma-api.polymarket.com";

async function proxiedFetch(targetUrl: string): Promise<Response> {
  return fetch(PROXY_URL, {
    headers: {
      "x-target-url": targetUrl,
      "x-proxy-secret": PROXY_SECRET,
    },
  });
}

export async function findCurrentMarket(): Promise<MarketInfo | null> {
  const now = Math.floor(Date.now() / 1000);
  const currentWindowStart = Math.floor(now / 300) * 300;
  const timeIntoWindow = now - currentWindowStart;

  // Only trade current window, skip if >4 min in (arb can trade later)
  if (timeIntoWindow > 240) return null;

  const slug = `btc-updown-5m-${currentWindowStart}`;

  try {
    const res = await proxiedFetch(`${GAMMA_BASE}/events/slug/${slug}`);
    if (!res.ok) return null;

    const event = await res.json() as any;
    if (!event?.id || !event?.markets?.length) return null;

    const market = event.markets[0];
    const clobTokenIds: string[] = JSON.parse(market.clobTokenIds || "[]");
    const outcomes: string[] = JSON.parse(market.outcomes || "[]");
    const outcomePrices: string[] = JSON.parse(market.outcomePrices || '["0.5","0.5"]');

    if (clobTokenIds.length < 2) return null;

    const upIdx = outcomes.findIndex((o: string) => /up/i.test(o));
    const downIdx = outcomes.findIndex((o: string) => /down/i.test(o));

    const upTokenId = clobTokenIds[upIdx >= 0 ? upIdx : 0];
    const downTokenId = clobTokenIds[downIdx >= 0 ? downIdx : 1];
    const upMid = parseFloat(outcomePrices[upIdx >= 0 ? upIdx : 0]);
    const downMid = parseFloat(outcomePrices[downIdx >= 0 ? downIdx : 1]);

    // Fetch orderbook best bids for each token
    // In binary markets, effective ask for token A = 1 - best bid on token B
    let upBestBid = 0;
    let downBestBid = 0;
    try {
      const upBookRes = await proxiedFetch(`https://clob.polymarket.com/book?token_id=${upTokenId}`);
      if (upBookRes.ok) {
        const book = await upBookRes.json() as any;
        const bids = book?.bids || [];
        if (bids.length > 0) {
          // Best bid = highest price (bids sorted descending by CLOB, but let's be safe)
          upBestBid = Math.max(...bids.map((b: any) => parseFloat(b.price)));
        }
      }
      const downBookRes = await proxiedFetch(`https://clob.polymarket.com/book?token_id=${downTokenId}`);
      if (downBookRes.ok) {
        const book = await downBookRes.json() as any;
        const bids = book?.bids || [];
        if (bids.length > 0) {
          downBestBid = Math.max(...bids.map((b: any) => parseFloat(b.price)));
        }
      }
    } catch (e) {
      // Fall back to mid prices if orderbook fetch fails
    }

    return {
      slug,
      question: market.question,
      conditionId: market.conditionId,
      endDate: market.endDate,
      windowStart: currentWindowStart,
      windowEnd: currentWindowStart + 300,
      upTokenId,
      downTokenId,
      upPrice: upMid,
      downPrice: downMid,
      upBestBid,
      downBestBid,
      acceptingOrders: market.acceptingOrders ?? true,
    };
  } catch (e) {
    return null;
  }
}

/**
 * Check market outcome after resolution
 * outcomePrices: ["1","0"] = Up won, ["0","1"] = Down won
 */
export async function checkMarketOutcome(windowStart: number): Promise<"Up" | "Down" | "pending" | null> {
  const slug = `btc-updown-5m-${windowStart}`;
  try {
    const res = await proxiedFetch(`${GAMMA_BASE}/events/slug/${slug}`);
    if (!res.ok) return null;
    const event = await res.json() as any;
    const market = event?.markets?.[0];
    if (!market) return null;
    const prices = JSON.parse(market.outcomePrices || "[]");
    if (prices[0] === "1") return "Up";
    if (prices[1] === "1") return "Down";
    return "pending";
  } catch {
    return null;
  }
}
