/**
 * Signal Engine v7 — Pure Latency Arbitrage
 * 
 * Strategy: Exploit price delta between Binance spot and Polymarket odds.
 * When BTC moves significantly from window open price but Polymarket odds
 * haven't caught up, there's an edge.
 * 
 * Dropped: All technical indicators (StochRSI, momentum, mean-reversion).
 * Technical signals were ~50% win rate on 5-min windows = no edge.
 * Latency arb has been consistently winning.
 */

export type Direction = "UP" | "DOWN" | null;

export interface Signal {
  direction: Direction;
  confidence: number;
  reasons: string[];
  priceDelta: {
    absolute: number;
    percent: number;
    windowOpenPrice: number;
    currentPrice: number;
  } | null;
  marketPrices: {
    upPrice: number;
    downPrice: number;
    impliedProb: number; // market's implied probability for our direction
  } | null;
  timeInWindow: number;
  timestamp: number;
}

export interface SignalConfig {
  // Arb thresholds
  minDeltaPercent: number;     // min % BTC move from window open
  minDeltaAbsolute: number;    // min $ BTC move from window open
  minEdgeCents: number;        // min edge in cents (our fair value - token price)
  maxTokenPrice: number;       // skip if market already priced in (token >= this)
  
  // Fair value model
  fairValueBase: number;       // base probability (0.50 = coin flip)
  fairValueMultiplier: number; // how much each % move adds
  fairValueCap: number;        // max fair value estimate
  
  // Trade params
  maxPrice: number;            // max bid price
  positionSize: number;
  dryRun: boolean;
  
  // Cooldown
  cooldownMs: number;          // min ms between trades
}

export const DEFAULT_CONFIG: SignalConfig = {
  // Arb: trigger when BTC moves >0.06% ($40+) from window open
  minDeltaPercent: 0.06,
  minDeltaAbsolute: 40,
  minEdgeCents: 8,            // need 8¢+ edge
  maxTokenPrice: 0.55,        // skip if market already >55% for our direction

  // Conservative fair value: 0.50 + (deltaPct * 2.5 * timeWeight)
  fairValueBase: 0.50,
  fairValueMultiplier: 2.5,
  fairValueCap: 0.80,         // never estimate >80% certainty

  // Trade params
  maxPrice: 0.65,
  positionSize: 25,
  dryRun: false,

  // 90 second cooldown between trades (less than 2 windows but prevents rapid-fire)
  cooldownMs: 90_000,
};

export function generateSignal(
  windowOpenPrice: number,
  currentPrice: number,
  marketUpPrice: number,
  marketDownPrice: number,
  timeInWindow: number,       // seconds into 5-min window (0-300)
  config: SignalConfig = DEFAULT_CONFIG
): Signal {
  const reasons: string[] = [];
  let direction: Direction = null;
  let confidence = 0;

  const delta = currentPrice - windowOpenPrice;
  const deltaPct = (delta / windowOpenPrice) * 100;
  const absDelta = Math.abs(delta);
  const absDeltaPct = Math.abs(deltaPct);

  const priceDelta = { absolute: delta, percent: deltaPct, windowOpenPrice, currentPrice };
  const marketPrices = {
    upPrice: marketUpPrice,
    downPrice: marketDownPrice,
    impliedProb: 0,
  };

  reasons.push(`BTC: $${currentPrice.toFixed(0)} | Δ: ${delta > 0 ? "+" : ""}$${delta.toFixed(0)} (${deltaPct > 0 ? "+" : ""}${deltaPct.toFixed(3)}%) | ${timeInWindow}s into window`);

  // ── Check minimum move (time-scaled) ──
  // Earlier in window = needs bigger move (more time for reversal)
  // At 30s: 2x threshold, at 150s: ~1.3x, at 240s: 1x
  const timeScale = 1 + (1 - timeInWindow / 240);  // 2.0 at 0s, 1.0 at 240s
  const scaledMinPct = config.minDeltaPercent * timeScale;
  const scaledMinAbs = config.minDeltaAbsolute * timeScale;

  if (absDeltaPct < scaledMinPct || absDelta < scaledMinAbs) {
    reasons.push(`Move too small for ${timeInWindow}s in (need >${scaledMinPct.toFixed(3)}% / $${scaledMinAbs.toFixed(0)}, got ${absDeltaPct.toFixed(3)}% / $${absDelta.toFixed(0)})`);
    return { direction: null, confidence: 0, reasons, priceDelta, marketPrices, timeInWindow, timestamp: Date.now() };
  }

  // ── Time weighting ──
  // Later in window = move more likely to hold = higher fair value
  // At 30s: weight 0.6, at 150s: weight 0.8, at 240s: weight 0.98
  const timeWeight = 0.5 + (timeInWindow / 300) * 0.5;

  // ── Fair value estimate ──
  const rawFair = config.fairValueBase + (absDeltaPct * config.fairValueMultiplier * timeWeight);
  const fairValue = Math.min(rawFair, config.fairValueCap);

  // ── Direction & edge ──
  const arbDirection: Direction = delta > 0 ? "UP" : "DOWN";
  const tokenPrice = arbDirection === "UP" ? marketUpPrice : marketDownPrice;
  marketPrices.impliedProb = tokenPrice; // token price ≈ implied probability

  const edge = fairValue - tokenPrice;

  reasons.push(`Market: UP=$${marketUpPrice.toFixed(2)} DOWN=$${marketDownPrice.toFixed(2)}`);
  reasons.push(`Fair: $${fairValue.toFixed(3)} (tw=${timeWeight.toFixed(2)}) | Token: $${tokenPrice.toFixed(2)} | Edge: ${(edge * 100).toFixed(1)}¢`);

  // ── Filters ──
  if (tokenPrice >= config.maxTokenPrice) {
    reasons.push(`SKIP: Market already priced in (${tokenPrice.toFixed(2)} >= ${config.maxTokenPrice})`);
    return { direction: null, confidence: 0, reasons, priceDelta, marketPrices, timeInWindow, timestamp: Date.now() };
  }

  if (edge < config.minEdgeCents / 100) {
    reasons.push(`SKIP: Edge too small (${(edge * 100).toFixed(1)}¢ < ${config.minEdgeCents}¢)`);
    return { direction: null, confidence: 0, reasons, priceDelta, marketPrices, timeInWindow, timestamp: Date.now() };
  }

  // ── Signal! ──
  direction = arbDirection;
  confidence = Math.min(0.95, 0.6 + edge);
  reasons.push(`🎯 LATENCY ARB: ${arbDirection} | BTC ${delta > 0 ? "up" : "down"} $${absDelta.toFixed(0)} but market at ${(tokenPrice * 100).toFixed(0)}%`);

  return { direction, confidence, reasons, priceDelta, marketPrices, timeInWindow, timestamp: Date.now() };
}
