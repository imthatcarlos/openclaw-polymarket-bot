/**
 * Signal Engine v5 — dual strategy:
 * 1. Latency arb: exploit price delta between Binance spot and Polymarket odds
 * 2. Technical: trend-aligned StochRSI (tightened, with cooldown)
 */

import { calcStochRSI } from "./indicators.js";

export type Direction = "UP" | "DOWN" | null;
export type Strategy = "latency-arb" | "technical" | null;

export interface Signal {
  direction: Direction;
  strategy: Strategy;
  confidence: number;
  reasons: string[];
  stochRSI: { k: number; d: number; rsi: number };
  momentum: { mom3: number; mom5: number; mom10: number; accel: number; trendUp: boolean; ema20: number };
  priceDelta: { absolute: number; percent: number; windowOpenPrice: number; currentPrice: number } | null;
  timestamp: number;
}

export interface SignalConfig {
  // Technical thresholds
  oversoldThreshold: number;
  overboughtThreshold: number;
  extremeOversold: number;
  extremeOverbought: number;
  minConfidence: number;
  maxPrice: number;
  dryRun: boolean;
  positionSize: number;

  // Latency arb
  minPriceDeltaPercent: number;  // min % move from window open to trigger
  minPriceDeltaAbsolute: number; // min $ move from window open to trigger
  arbMinConfidence: number;      // confidence threshold for arb trades

  // Cooldown
  cooldownWindows: number;       // skip N windows after a trade
}

export const DEFAULT_CONFIG: SignalConfig = {
  oversoldThreshold: 25,
  overboughtThreshold: 75,
  extremeOversold: 10,
  extremeOverbought: 90,
  minConfidence: 0.75,
  maxPrice: 0.65,
  dryRun: false,
  positionSize: 25,

  // Latency arb: trigger when BTC moves >0.08% ($55+ at $69K) from window open
  minPriceDeltaPercent: 0.08,
  minPriceDeltaAbsolute: 40,
  arbMinConfidence: 0.7,

  // Skip 2 windows after each trade (10 min cooldown)
  cooldownWindows: 2,
};

export function generateSignal(
  closes: number[],
  windowOpenPrice: number | null,
  currentPrice: number,
  marketUpPrice: number | null,
  marketDownPrice: number | null,
  config: SignalConfig = DEFAULT_CONFIG
): Signal {
  const { lastK, lastD, lastRSI } = calcStochRSI(closes, 14, 14, 3, 3);
  const reasons: string[] = [];
  let direction: Direction = null;
  let strategy: Strategy = null;
  let confidence = 0;

  // Momentum calculations
  const mom3 = closes.length > 3 ? ((closes[closes.length - 1] - closes[closes.length - 4]) / closes[closes.length - 4] * 100) : 0;
  const mom5 = closes.length > 5 ? ((closes[closes.length - 1] - closes[closes.length - 6]) / closes[closes.length - 6] * 100) : 0;
  const mom10 = closes.length > 10 ? ((closes[closes.length - 1] - closes[closes.length - 11]) / closes[closes.length - 11] * 100) : 0;
  const momAccel = mom3 - mom5;

  // EMA20 trend
  let ema20 = closes.slice(0, 20).reduce((a, b) => a + b, 0) / 20;
  for (let i = 20; i < closes.length; i++) ema20 = (closes[i] - ema20) * 2 / 21 + ema20;
  const trendUp = closes[closes.length - 1] > ema20;

  const momentum = { mom3, mom5, mom10, accel: momAccel, trendUp, ema20 };

  // ── STRATEGY 1: Latency Arbitrage ─────────────────────────
  // If BTC has already moved significantly from window open, the market outcome
  // is partially decided. If Polymarket odds haven't caught up, there's an edge.
  let priceDelta: Signal["priceDelta"] = null;

  if (windowOpenPrice && currentPrice && marketUpPrice !== null && marketDownPrice !== null) {
    const delta = currentPrice - windowOpenPrice;
    const deltaPct = (delta / windowOpenPrice) * 100;
    priceDelta = { absolute: delta, percent: deltaPct, windowOpenPrice, currentPrice };

    reasons.push(`Window Δ: ${delta > 0 ? "+" : ""}$${delta.toFixed(2)} (${deltaPct > 0 ? "+" : ""}${deltaPct.toFixed(3)}%)`);

    const absDelta = Math.abs(delta);
    const absDeltaPct = Math.abs(deltaPct);

    // Time into window (0-300s). Later = more reliable signal (less time for reversal)
    const now = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(now / 300) * 300;
    const timeInWindow = now - windowStart;
    const timeWeight = Math.max(0.5, timeInWindow / 300); // 0.5 at start, 1.0 at end

    if (absDeltaPct >= config.minPriceDeltaPercent && absDelta >= config.minPriceDeltaAbsolute) {
      const arbDirection: Direction = delta > 0 ? "UP" : "DOWN";
      // Conservative fair value: base 0.50 + small multiplier, scaled by time in window
      // A move at minute 4 is worth more than a move at minute 1
      const rawFair = 0.50 + (absDeltaPct * 2 * timeWeight);
      const expectedFairPrice = Math.min(rawFair, 0.85); // cap at 85%, never assume certainty
      const currentTokenPrice = arbDirection === "UP" ? marketUpPrice : marketDownPrice;

      // Edge = how much cheaper the token is vs our fair value estimate
      const edge = expectedFairPrice - currentTokenPrice;

      // POST-MORTEM LESSON (trade #12): Market priced DOWN at 0.49 for a -0.155% move.
      // Our old model said 0.95 fair. Market was right. Now we:
      // 1. Only arb if market implies <55% for our direction (token < 0.55)
      // 2. Require 10¢+ edge (was 5¢)
      // 3. Time-weight: early-window moves get discounted
      const marketAlreadyPriced = currentTokenPrice >= 0.55;

      if (edge > 0.10 && !marketAlreadyPriced) {
        direction = arbDirection;
        strategy = "latency-arb";
        confidence = Math.min(0.9, config.arbMinConfidence + (edge * 0.5));
        reasons.push(`LATENCY ARB: BTC ${delta > 0 ? "UP" : "DOWN"} $${absDelta.toFixed(0)} from open (${timeInWindow}s into window)`);
        reasons.push(`Token: $${currentTokenPrice.toFixed(2)} vs fair: $${expectedFairPrice.toFixed(2)} (edge: ${(edge * 100).toFixed(0)}¢, time-weight: ${timeWeight.toFixed(2)})`);
      } else if (marketAlreadyPriced) {
        reasons.push(`Price moved $${absDelta.toFixed(0)} but market already priced in (token: $${currentTokenPrice.toFixed(2)} ≥ $0.55)`);
      } else {
        reasons.push(`Price moved $${absDelta.toFixed(0)} but edge too small (${(edge * 100).toFixed(0)}¢ < 10¢ min)`);
      }
    }
  }

  // ── STRATEGY 2: Technical (StochRSI) — only if no arb signal ──
  if (!direction) {
    reasons.push(`K=${lastK.toFixed(1)} D=${lastD.toFixed(1)} RSI=${lastRSI.toFixed(1)}`);
    reasons.push(`Mom3=${mom3.toFixed(3)}% Mom5=${mom5.toFixed(3)}% EMA20=${trendUp ? "UP" : "DOWN"}`);

    // ── Anti-exhaustion filter ──
    // If K has been pinned extreme for 3+ consecutive candles, a reversal is imminent.
    // Check last 3 closes via StochRSI proxy: if current K is extreme AND momentum
    // is decelerating, the move is exhausted.
    const kExhaustedLow = lastK < 15 && mom3 > mom5;  // oversold but momentum flattening
    const kExhaustedHigh = lastK > 85 && mom3 < mom5;  // overbought but momentum flattening

    if (kExhaustedLow) reasons.push("⚠️ Exhaustion: K pinned low but momentum fading");
    if (kExhaustedHigh) reasons.push("⚠️ Exhaustion: K pinned high but momentum fading");

    // ── Deceleration veto ──
    // If momentum is decelerating against the trade direction, skip.
    // For UP: accel should be positive (speeding up). For DOWN: accel should be negative.
    const upDecelVeto = momAccel < -0.02;   // momentum decelerating — bad for UP
    const downDecelVeto = momAccel > 0.02;  // momentum decelerating — bad for DOWN

    // Tightened rules: NO trend-follow at extremes (that was losing)
    // Only mean-reversion with trend confirmation + exhaustion/decel guards
    if (lastK < config.oversoldThreshold && lastK > lastD) {
      if (kExhaustedLow) {
        reasons.push("Oversold but exhausted — skipping (reversal imminent, don't chase)");
      } else if (upDecelVeto) {
        reasons.push("Oversold crossover but momentum decelerating — veto");
      } else if (trendUp && mom5 > -0.05) {
        direction = "UP";
        strategy = "technical";
        confidence = 0.65;
        reasons.push("Oversold K/D crossover + uptrend confirmed");
        if (lastRSI < 30) { confidence += 0.1; reasons.push("RSI confirms oversold"); }
        if (momAccel > 0.01) { confidence += 0.1; reasons.push("Momentum accelerating"); }
      } else {
        reasons.push("Oversold but downtrend — skipping (no falling knives)");
      }
    } else if (lastK > config.overboughtThreshold && lastK < lastD) {
      if (kExhaustedHigh) {
        reasons.push("Overbought but exhausted — skipping (reversal imminent)");
      } else if (downDecelVeto) {
        reasons.push("Overbought crossover but momentum decelerating — veto");
      } else if (!trendUp && mom5 < 0.05) {
        direction = "DOWN";
        strategy = "technical";
        confidence = 0.65;
        reasons.push("Overbought K/D crossover + downtrend confirmed");
        if (lastRSI > 70) { confidence += 0.1; reasons.push("RSI confirms overbought"); }
        if (momAccel < -0.01) { confidence += 0.1; reasons.push("Momentum accelerating down"); }
      } else {
        reasons.push("Overbought but uptrend — skipping");
      }
    } else {
      reasons.push("Neutral zone — no technical signal");
    }
  }

  confidence = Math.max(0, Math.min(1, confidence));

  return {
    direction: confidence >= config.minConfidence ? direction : null,
    strategy: confidence >= config.minConfidence ? strategy : null,
    confidence,
    reasons,
    stochRSI: { k: lastK, d: lastD, rsi: lastRSI },
    momentum,
    priceDelta,
    timestamp: Date.now(),
  };
}
