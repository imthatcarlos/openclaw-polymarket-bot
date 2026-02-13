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

  // Only trade current window, skip if >3 min in
  if (timeIntoWindow > 180) return null;

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
