# Polymarket BTC 5-Min Trading Bot v6.2

Automated trading bot for [Polymarket's](https://polymarket.com) 5-minute Bitcoin Up/Down prediction markets. Pure latency arbitrage with Kelly criterion sizing, orderbook-aware pricing, and wallet-verified P&L.

## How It Works

Every 5 minutes, Polymarket opens a binary market: "Will BTC go up or down in the next 5 minutes?" This bot monitors BTC price in real-time via Binance WebSocket and places trades when the market hasn't yet priced in a BTC move.

### Signal Engine — Pure Latency Arb

The bot exploits the latency gap between BTC spot price (Binance) and Polymarket token prices. When BTC makes a sharp move within a 5-minute window but the Polymarket market hasn't caught up, there's free edge.

**How it decides:**
1. Track BTC price delta from window open (Binance WebSocket, every tick)
2. Calculate Black-Scholes fair value for the binary option
3. Fetch real orderbook ask price from CLOB API
4. Trade only if fair value beats ask price by at least 6¢ edge
5. Skip if no liquidity at a reasonable price

**Filters:**
- Min BTC move: 0.04% or $50 absolute
- Time-scaled threshold: needs bigger move early in window
- Trade window: 30s-240s into each 5-min window
- Market-already-priced filter: skip if token ≥ $0.65
- Edge check: skip if fair value doesn't beat orderbook ask by 5¢+
- 60s cooldown between trades

### Position Sizing — Quarter Kelly

Uses Kelly criterion for position sizing with a conservative quarter-Kelly fraction:

- `f* = (p*b - q) / b` where p=win rate, b=payout ratio, q=loss rate
- Applied fraction: 25% of full Kelly
- Floor: $100 per trade
- Cap: $10,000 per trade
- Sizes down to available wallet balance (min $5) instead of skipping

### Order Execution

- **Orderbook-aware pricing (v6.2)**: Fetches real ask prices from Polymarket CLOB API instead of guessing
- **Fill verification**: Rejects orders with "unknown" IDs, checks `size_matched > 0`
- **Auto-cancel**: Unfilled orders are canceled immediately

### Settlement & Redemption

- **Auto-settle**: Queries Gamma API after window closes to determine win/loss
- **Auto-redeem**: Winning positions redeemed via CTF `redeemPositions` contract call
- **Dynamic gas**: Fetches current Polygon gas price + 30% buffer (no hardcoded caps)
- **Wallet-based P&L**: Tracks `walletBefore`/`walletAfter` per trade, session P&L from balance delta

## Architecture

```
Binance WebSocket → Price Engine → Signal Engine → CLOB Order → Settlement → Auto-Redeem
                                        ↓
                                  Orderbook Check
                                  (real ask price)
                                        ↓
                                   Edge Filter
                                (fair value > ask?)
```

**Persistent Node.js process** with HTTP control API at `:3847`.

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/status` | GET | Full bot status, signal, config |
| `/trades` | GET | Trade history |
| `/wallet` | GET | Live balance, session P&L |
| `/stats/hourly` | GET | Hourly performance breakdown |
| `/post-mortems` | GET | Loss analysis log |
| `/config` | POST | Update config without restart |
| `/pause` | POST | Pause trading |
| `/resume` | POST | Resume trading |
| `/stop` | POST | Graceful shutdown |

## Setup

```bash
cp .env.example .env
# Fill in: EVM_PRIVATE_KEY, WALLET_ADDRESS, PROXY_URL, PROXY_SECRET, RPC_URL
npm install
```

## Running

```bash
# Load env and start
export $(cat .env | xargs) && npx tsx src/bot.ts

# For persistence (survives session close)
nohup bash -c 'cd /path/to/bot && export $(cat .env | xargs) && npx tsx src/bot.ts' > /tmp/polymarket-bot.log 2>&1 &
```

## Signal Evolution

| Version | Strategy | Result |
|---------|----------|--------|
| v1-v2 | Technical indicators (RSI, StochRSI) | ~50% WR, no edge |
| v3 | Pure latency arb | ~72.5% WR |
| v4 | + Doubling position sizing | Peak +$1,681, gave it all back |
| v5 | + Kelly criterion sizing | +$148 real (7 trades), +$428 phantom |
| v6 | + Wallet verification, order fill check, auto-redeem | Fixed phantom trades |
| v6.2 | + Orderbook ask pricing, edge check, dynamic gas | Current |

## Key Lessons

- **Phantom trades**: Orders can return 400 but bot logged them as placed. Always verify `size_matched > 0`.
- **Auto-redeem is critical**: Winning tokens lock USDC in CTF contract. Must redeem to free capital.
- **Polygon gas spikes**: Hardcoded gas caps cause stuck TXs. Always fetch current gas dynamically.
- **Orderbook > mid price**: Gamma API `outcomePrices` is mid-market, not executable. Fetch real asks from CLOB.
- **Overnight is king**: UTC 03-05, 11-12 had 100% win rates. UTC 13 (8am ET) was worst.

## Requirements

- EU proxy for Polymarket CLOB API (geo-blocked in US)
- Polygon wallet with USDC.e + MATIC for gas
- USDC.e approved on CTF Exchange + Neg Risk Exchange contracts
