# Polymarket BTC 5-Min Trading Bot v4

Automated trading bot for [Polymarket's](https://polymarket.com) 5-minute Bitcoin Up/Down prediction markets. Pure latency arbitrage with doubling position sizing.

## How It Works

Every 5 minutes, Polymarket opens a binary market: "Will BTC go up or down in the next 5 minutes?" This bot monitors BTC price in real-time via Binance WebSocket and places trades when the market hasn't yet priced in a BTC move.

### Signal Engine — Pure Latency Arb (v4)

The bot exploits the latency gap between BTC spot price (Binance) and Polymarket token prices. When BTC makes a sharp move within a 5-minute window but the Polymarket market hasn't caught up, there's free edge.

**How it decides:**
1. Track BTC price delta from window open (Binance WebSocket, every tick)
2. Calculate fair value: `0.50 + (deltaPct × 2.5 × timeWeight)`
3. Compare to current Polymarket token price
4. Trade if edge > 8¢ and market token < $0.55

**Filters:**
- Min BTC move: 0.06% or $40 absolute
- Time-scaled threshold: needs 2x bigger move early in window (stale open price risk)
- Trade window: 30s-240s into each 5-min window
- Market-already-priced filter: skip if token ≥ $0.55
- 90s cooldown between trades

### Position Sizing — Doubling Strategy

Instead of fixed sizing, the bot doubles on each consecutive win and resets to base on any loss:

| Streak | Bet Size |
|--------|----------|
| 0 (base/after loss) | $100 |
| 1 win | $200 |
| 2 wins | $400 |
| 3 wins | $800 |
| 4 wins | $1,600 |
| 5 wins | $3,200 |
| 6 wins | $6,400 |
| 7+ wins | $10,000 (cap) |

**Why this works:** With a 72%+ win rate, long streaks are common. A 10-win streak starting at $100 yields ~$70K. Losses are always at base ($100) or wherever the streak breaks, limiting downside.

**Backtested on 49 actual trades:** $53,785 P&L with $10K cap (started at $50 base).

### Architecture

```
┌─────────────────────────────────────────┐
│  Persistent Node.js Process             │
│                                         │
│  ┌──────────┐  ┌──────────────────┐     │
│  │ Binance  │  │  Signal Engine   │     │
│  │ WebSocket├──┤  Pure Latency    │     │
│  │ (ticks)  │  │  Arbitrage       │     │
│  └──────────┘  └────────┬─────────┘     │
│                         │               │
│  ┌──────────┐  ┌────────▼─────────┐     │
│  │ CoinGecko│  │  Trade Executor  │     │
│  │ (30s xck)│  │  Polymarket CLOB │     │
│  └──────────┘  └────────┬─────────┘     │
│                         │               │
│  ┌──────────┐  ┌────────▼─────────┐     │
│  │ HTTP API │  │  Auto-Settlement │     │
│  │ :3847    │  │  + Post-Mortems  │     │
│  └──────────┘  └──────────────────┘     │
└─────────────────────────────────────────┘
         │
         ▼ (via EU proxy)
   Polymarket CLOB API
```

## Setup

### Prerequisites

- Node.js 20+
- A Polygon wallet with USDC.e balance
- USDC.e approved for Polymarket's CTF Exchange and Neg Risk Exchange contracts

### Environment Variables

Create a `.env` file:

```bash
# Required
EVM_PRIVATE_KEY=        # Polygon wallet private key

# Proxy (required from US — Polymarket CLOB is geo-blocked)
PROXY_URL=              # EU proxy URL
PROXY_SECRET=           # Proxy authentication secret

# Optional
RPC_URL=                # Polygon RPC endpoint (default: polygon-rpc.com)
BOT_PORT=               # HTTP API port (default: 3847)
```

### USDC.e Approvals

```bash
EVM_PRIVATE_KEY=0x... RPC_URL=... npx tsx skill/scripts/approve-usdc.ts
```

### Install & Run

```bash
npm install

# Start (loads .env automatically)
export $(cat .env | xargs) && npx tsx src/bot.ts

# Or background:
export $(cat .env | xargs) && nohup npx tsx src/bot.ts > bot.log 2>&1 &
```

## HTTP API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/status` | GET | Bot state, streak, signal, stats, P&L |
| `/trades` | GET | Recent trade history (last 50) |
| `/stats/hourly` | GET | Win rate and P&L by hour (UTC) |
| `/post-mortems` | GET | Loss pattern analysis |
| `/pause` | POST | Pause trading |
| `/resume` | POST | Resume trading |
| `/config` | POST | Update config live (JSON body) |
| `/stop` | POST | Graceful shutdown |

### Config Parameters

```bash
curl -X POST http://127.0.0.1:3847/config \
  -H "Content-Type: application/json" \
  -d '{"positionSize": 100, "maxPositionSize": 10000}'
```

| Param | Default | Description |
|-------|---------|-------------|
| `positionSize` | 100 | Base bet size (USD) |
| `maxPositionSize` | 10000 | Max bet size cap |
| `pnlFloor` | -100 | Circuit breaker — auto-pause if P&L drops below |
| `minDeltaPercent` | 0.06 | Min BTC % move to trigger |
| `minDeltaAbsolute` | 40 | Min BTC $ move to trigger |
| `minEdgeCents` | 8 | Min edge vs market price (cents) |
| `maxTokenPrice` | 0.55 | Skip if market already priced in |
| `cooldownMs` | 90000 | Min ms between trades |
| `maxPrice` | 0.65 | Max bid price per token |
| `dryRun` | false | Simulate without placing orders |

## Signal Evolution

| Version | Strategy | Result |
|---------|----------|--------|
| v1-v2 | StochRSI + Momentum + EMA20 | ~50% win rate, no edge |
| v3 | Pure latency arb (event-driven) | 72% win rate |
| v4 | Pure latency arb + doubling sizing | 72% WR, optimized P&L via streak sizing |

Key insight: Technical indicators (RSI, momentum, mean-reversion) had no edge on 5-minute windows. Latency arbitrage consistently wins because Polymarket token prices lag BTC spot.

## Project Structure

```
├── src/
│   ├── bot.ts              # Main process, HTTP API, doubling logic
│   ├── price-engine.ts     # Binance WebSocket + CoinGecko cross-check
│   ├── market-engine.ts    # Polymarket market discovery + settlement
│   ├── signal-engine.ts    # Pure latency arb signal generation
│   └── indicators.ts       # Technical indicator calculations
├── skill/                  # OpenClaw skill (v1 standalone)
├── state.json              # Persisted state (trades, P&L, streak)
├── post-mortems.jsonl      # Auto-logged loss analysis
└── .env                    # Secrets (not committed)
```

## EU Proxy

Polymarket's CLOB API is geo-blocked from the US. The bot routes requests through an EU proxy (Netherlands) deployed on Railway. Configure via `PROXY_URL` and `PROXY_SECRET`.

## Risk Warning

- Binary outcomes — you can lose your entire position on every trade
- Doubling amplifies both wins AND losses
- The circuit breaker (`pnlFloor`) is your safety net — don't disable it
- This is experimental software — use at your own risk
- Not financial advice

## License

MIT
