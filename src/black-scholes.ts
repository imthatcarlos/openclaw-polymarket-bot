/**
 * Black-Scholes Binary Option Pricing
 * For 5-minute BTC up/down prediction markets
 * 
 * Binary call = e^(-rT) * N(d2)
 * where d2 = (ln(S/K) + (r - σ²/2)T) / (σ√T)
 * 
 * For BTC 5-min markets:
 * - S = current BTC price
 * - K = window open price (strike = "price at open")
 * - T = time remaining in window (in years)
 * - σ = annualized volatility (from recent price data)
 * - r = 0 (no risk-free rate for 5-min horizon)
 */

// Standard normal CDF approximation (Abramowitz & Stegun)
function normcdf(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.SQRT2;

  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return 0.5 * (1.0 + sign * y);
}

export interface BSPricing {
  fairUp: number;      // Fair probability that price ends UP
  fairDown: number;    // Fair probability that price ends DOWN
  d2: number;          // d2 parameter
  impliedVol: number;  // Annualized vol used
  timeRemaining: number; // Seconds left in window
}

/**
 * Calculate fair value of "UP" outcome using Black-Scholes binary option model
 * 
 * @param currentPrice - Current BTC price (S)
 * @param strikePrice - Window open price (K) 
 * @param timeRemainingSeconds - Seconds until window closes
 * @param annualizedVol - Annualized volatility (e.g., 0.50 for 50%)
 */
export function binaryOptionFairValue(
  currentPrice: number,
  strikePrice: number,
  timeRemainingSeconds: number,
  annualizedVol: number
): BSPricing {
  // Convert time to years (365.25 days * 24h * 3600s)
  const T = Math.max(timeRemainingSeconds / 31557600, 1e-10);
  
  // No risk-free rate for 5-min horizon
  const r = 0;
  
  const sigma = annualizedVol;
  const sqrtT = Math.sqrt(T);
  
  // d2 = (ln(S/K) + (r - σ²/2)T) / (σ√T)
  const d2 = (Math.log(currentPrice / strikePrice) + (r - (sigma * sigma) / 2) * T) / (sigma * sqrtT);
  
  // Binary call fair value = N(d2) (with r=0, discount factor = 1)
  const fairUp = normcdf(d2);
  const fairDown = 1 - fairUp;
  
  return {
    fairUp,
    fairDown,
    d2,
    impliedVol: annualizedVol,
    timeRemaining: timeRemainingSeconds,
  };
}

/**
 * Estimate annualized volatility from recent price ticks
 * Uses 1-minute returns over the last N minutes
 * 
 * @param prices - Array of prices at regular intervals
 * @param intervalSeconds - Time between each price (e.g., 60 for 1-min)
 */
export function estimateVolatility(prices: number[], intervalSeconds: number = 60): number {
  if (prices.length < 3) return 0.50; // Default 50% annual vol for BTC
  
  // Calculate log returns
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push(Math.log(prices[i] / prices[i - 1]));
  }
  
  // Standard deviation of returns
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  const stdDev = Math.sqrt(variance);
  
  // Annualize: multiply by sqrt(periods per year)
  const periodsPerYear = 31557600 / intervalSeconds;
  const annualizedVol = stdDev * Math.sqrt(periodsPerYear);
  
  // Clamp to reasonable range for BTC (20% - 150% annualized)
  return Math.max(0.20, Math.min(annualizedVol, 1.50));
}
