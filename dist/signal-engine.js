/**
 * Signal Engine v8 — Black-Scholes Latency Arbitrage
 *
 * Strategy: Exploit price delta between Binance spot and Polymarket odds.
 * Fair value now calculated via Black-Scholes binary option model instead
 * of linear approximation. Gives proper volatility-adjusted probabilities
 * and time decay modeling.
 *
 * Inspired by: @lunatik_corp's $1.5K→$33K playbook using BS for binary options.
 */
import { binaryOptionFairValue } from "./black-scholes.js";
export const DEFAULT_CONFIG = {
    // Arb: trigger when BTC moves >0.06% ($40+) from window open
    minDeltaPercent: 0.06,
    minDeltaAbsolute: 40,
    minEdgeCents: 8, // need 8¢+ edge
    maxTokenPrice: 0.55, // skip if market already >55% for our direction
    // Conservative fair value: 0.50 + (deltaPct * 1.5 * timeWeight)
    fairValueBase: 0.50,
    fairValueMultiplier: 1.5, // was 2.5, too aggressive — market was right on all 3 losses
    fairValueCap: 0.75, // was 0.80, cap lower
    // Trade params
    maxPrice: 0.65,
    positionSize: 50, // max cap per trade
    bankroll: 500, // total bankroll for Kelly calc
    kellyFraction: 0.25, // quarter Kelly (conservative)
    minPositionSize: 5, // minimum $5 bet
    dryRun: false,
    // 90 second cooldown between trades (less than 2 windows but prevents rapid-fire)
    cooldownMs: 90_000,
    // Compounding & risk
    compoundFraction: 0.5, // reinvest 50% of profits
    maxPositionSize: 200, // never bet more than $200 per trade
    pnlFloor: -100, // auto-pause at -$100
};
export function generateSignal(windowOpenPrice, currentPrice, marketUpPrice, marketDownPrice, timeInWindow, // seconds into 5-min window (0-300)
config = DEFAULT_CONFIG) {
    const reasons = [];
    let direction = null;
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
    const timeScale = 1 + (1 - timeInWindow / 240); // 2.0 at 0s, 1.0 at 240s
    const scaledMinPct = config.minDeltaPercent * timeScale;
    const scaledMinAbs = config.minDeltaAbsolute * timeScale;
    if (absDeltaPct < scaledMinPct || absDelta < scaledMinAbs) {
        reasons.push(`Move too small for ${timeInWindow}s in (need >${scaledMinPct.toFixed(3)}% / $${scaledMinAbs.toFixed(0)}, got ${absDeltaPct.toFixed(3)}% / $${absDelta.toFixed(0)})`);
        return { direction: null, confidence: 0, reasons, priceDelta, marketPrices, timeInWindow, timestamp: Date.now() };
    }
    // ── Time remaining ──
    const timeRemainingSeconds = Math.max(300 - timeInWindow, 1);
    const timeWeight = 0.5 + (timeInWindow / 300) * 0.5; // for logging
    // ── Black-Scholes Fair Value ──
    // Use annualized vol estimate. BTC ~50% annual vol baseline,
    // but short-term realized vol can be much higher.
    // TODO: feed real price history for dynamic vol estimation
    const annualizedVol = 0.50; // conservative BTC annual vol
    const bs = binaryOptionFairValue(currentPrice, windowOpenPrice, timeRemainingSeconds, annualizedVol);
    // fairValue = probability that price ends in our direction
    const fairValue = delta > 0 ? bs.fairUp : bs.fairDown;
    // ── Direction & edge ──
    const arbDirection = delta > 0 ? "UP" : "DOWN";
    const tokenPrice = arbDirection === "UP" ? marketUpPrice : marketDownPrice;
    marketPrices.impliedProb = tokenPrice; // token price ≈ implied probability
    const edge = fairValue - tokenPrice;
    reasons.push(`Market: UP=$${marketUpPrice.toFixed(2)} DOWN=$${marketDownPrice.toFixed(2)}`);
    reasons.push(`BS Fair: $${fairValue.toFixed(3)} (d2=${bs.d2.toFixed(2)}, σ=${annualizedVol}, ${timeRemainingSeconds}s left) | Token: $${tokenPrice.toFixed(2)} | Edge: ${(edge * 100).toFixed(1)}¢`);
    // ── Filters ──
    if (tokenPrice >= config.maxTokenPrice) {
        reasons.push(`SKIP: Market already priced in (${tokenPrice.toFixed(2)} >= ${config.maxTokenPrice})`);
        return { direction: null, confidence: 0, reasons, priceDelta, marketPrices, timeInWindow, timestamp: Date.now() };
    }
    // Market agreement filter — but override on massive deltas (>$150)
    // Rationale: small deltas ($55-$110) reverse often, trust market. Huge deltas ($150+) hold.
    if (tokenPrice < 0.50 && absDelta < 150) {
        reasons.push(`SKIP: Market disagrees (token $${tokenPrice.toFixed(2)} < $0.50 — market doesn't see this direction)`);
        return { direction: null, confidence: 0, reasons, priceDelta, marketPrices, timeInWindow, timestamp: Date.now() };
    }
    if (tokenPrice < 0.50 && absDelta >= 150) {
        reasons.push(`⚡ DELTA OVERRIDE: Market disagrees but delta $${absDelta.toFixed(0)} > $150 — trusting the move`);
    }
    if (edge < config.minEdgeCents / 100) {
        reasons.push(`SKIP: Edge too small (${(edge * 100).toFixed(1)}¢ < ${config.minEdgeCents}¢)`);
        return { direction: null, confidence: 0, reasons, priceDelta, marketPrices, timeInWindow, timestamp: Date.now() };
    }
    // ── Signal! ──
    direction = arbDirection;
    confidence = Math.min(0.95, 0.6 + edge);
    // Kelly Criterion: F = (p - P) / (1 - P)
    // p = our fair value estimate, P = market token price
    const kellyFull = (fairValue - tokenPrice) / (1 - tokenPrice);
    const kellyBet = Math.max(config.minPositionSize, Math.min(config.positionSize, config.bankroll * kellyFull * config.kellyFraction));
    reasons.push(`🎯 LATENCY ARB: ${arbDirection} | BTC ${delta > 0 ? "up" : "down"} $${absDelta.toFixed(0)} but market at ${(tokenPrice * 100).toFixed(0)}%`);
    reasons.push(`Kelly: F=${(kellyFull * 100).toFixed(1)}% × ${config.kellyFraction} bankroll → $${kellyBet.toFixed(2)}`);
    return { direction, confidence, reasons, priceDelta, marketPrices, timeInWindow, timestamp: Date.now(), kellySize: kellyBet };
}
