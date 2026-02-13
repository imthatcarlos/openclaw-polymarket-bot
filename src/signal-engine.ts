/**
 * Signal Engine v3 — trend-aligned signals only, no counter-trend bets
 * Lessons from live trading: counter-trend bets (UP in downtrend) lose.
 */

import { calcStochRSI } from "./indicators.js";

export type Direction = "UP" | "DOWN" | null;

export interface Signal {
  direction: Direction;
  confidence: number;
  reasons: string[];
  stochRSI: { k: number; d: number; rsi: number };
  momentum: { mom3: number; mom5: number; mom10: number; accel: number; trendUp: boolean; ema20: number };
  timestamp: number;
}

export interface SignalConfig {
  oversoldThreshold: number;
  overboughtThreshold: number;
  extremeOversold: number;
  extremeOverbought: number;
  minConfidence: number;
  maxPrice: number;
  dryRun: boolean;
  positionSize: number;
}

export const DEFAULT_CONFIG: SignalConfig = {
  oversoldThreshold: 25,
  overboughtThreshold: 75,
  extremeOversold: 10,
  extremeOverbought: 90,
  minConfidence: 0.6,
  maxPrice: 0.65,
  dryRun: false,
  positionSize: 5,
};

export function generateSignal(
  closes: number[],
  config: SignalConfig = DEFAULT_CONFIG
): Signal {
  const { lastK, lastD, lastRSI } = calcStochRSI(closes, 14, 14, 3, 3);
  const reasons: string[] = [];
  let direction: Direction = null;
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

  reasons.push(`K=${lastK.toFixed(1)} D=${lastD.toFixed(1)} RSI=${lastRSI.toFixed(1)}`);
  reasons.push(`Mom3=${mom3.toFixed(3)}% Mom5=${mom5.toFixed(3)}% Accel=${momAccel > 0 ? "+" : ""}${momAccel.toFixed(4)}%`);
  reasons.push(`EMA20=$${ema20.toFixed(2)} Trend=${trendUp ? "UP" : "DOWN"}`);

  // Signal logic: trend-aligned, with trend-following at extremes
  if (lastK < config.oversoldThreshold && lastK > lastD) {
    // Bullish crossover from oversold — only if uptrend
    if (trendUp && mom5 > -0.05) {
      direction = "UP";
      confidence = 0.65;
      reasons.push("Oversold K/D crossover + uptrend confirmed");
      if (lastRSI < 30) { confidence += 0.1; reasons.push("RSI confirms oversold"); }
      if (momAccel > 0) { confidence += 0.1; reasons.push("Momentum accelerating"); }
    } else {
      reasons.push(`Oversold crossover but downtrend — skipping (don't catch falling knives)`);
    }
  } else if (lastK > config.overboughtThreshold && lastK < lastD) {
    // Bearish crossover from overbought — only if downtrend
    if (!trendUp && mom5 < 0.05) {
      direction = "DOWN";
      confidence = 0.65;
      reasons.push("Overbought K/D crossover + downtrend confirmed");
      if (lastRSI > 70) { confidence += 0.1; reasons.push("RSI confirms overbought"); }
      if (momAccel < 0) { confidence += 0.1; reasons.push("Momentum decelerating"); }
    } else if (trendUp && mom5 > 0.05 && mom3 > 0) {
      // Trend-following: overbought but strong uptrend — ride the wave
      direction = "UP";
      confidence = 0.65;
      reasons.push(`Overbought but strong uptrend — trend-follow UP (Mom5=${mom5.toFixed(3)}%)`);
      if (momAccel > 0) { confidence += 0.1; reasons.push("Momentum still accelerating"); }
    } else {
      reasons.push(`Overbought crossover but uptrend without strong momentum — skipping`);
    }
  } else if (lastK < config.extremeOversold) {
    // Extreme oversold
    if (trendUp && mom3 > 0 && momAccel > 0) {
      direction = "UP";
      confidence = 0.75;
      reasons.push(`Extreme oversold (K=${lastK.toFixed(1)}) + uptrend + momentum accelerating`);
    } else if (!trendUp && mom5 < -0.05 && mom3 < 0) {
      // Trend-following: extreme oversold in strong downtrend — ride it down
      direction = "DOWN";
      confidence = 0.65;
      reasons.push(`Extreme oversold but strong downtrend — trend-follow DOWN (Mom5=${mom5.toFixed(3)}%)`);
    } else {
      reasons.push(`Extreme oversold but no confirmation`);
    }
  } else if (lastK > config.extremeOverbought) {
    // Extreme overbought
    if (!trendUp && mom3 < 0 && momAccel < 0) {
      direction = "DOWN";
      confidence = 0.75;
      reasons.push(`Extreme overbought (K=${lastK.toFixed(1)}) + downtrend + momentum decelerating`);
    } else if (trendUp && mom5 > 0.05 && mom3 > 0) {
      // Trend-following: extreme overbought in strong uptrend — ride it up
      direction = "UP";
      confidence = 0.7;
      reasons.push(`Extreme overbought but strong uptrend — trend-follow UP (Mom5=${mom5.toFixed(3)}%)`);
      if (momAccel > 0) { confidence += 0.1; reasons.push("Momentum accelerating into pump"); }
    } else {
      reasons.push(`Extreme overbought but no confirmation`);
    }
  } else {
    reasons.push("Neutral zone — no signal");
  }

  confidence = Math.max(0, Math.min(1, confidence));

  return {
    direction: confidence >= config.minConfidence ? direction : null,
    confidence,
    reasons,
    stochRSI: { k: lastK, d: lastD, rsi: lastRSI },
    momentum,
    timestamp: Date.now(),
  };
}
