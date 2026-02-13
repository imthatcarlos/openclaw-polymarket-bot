# Polymarket BTC 5-Min Trading Bot

Automated trading bot for [Polymarket's](https://polymarket.com) 5-minute Bitcoin Up/Down prediction markets. Runs as a persistent background process with real-time WebSocket price feeds and an HTTP control API.

## How It Works

Every 5 minutes, Polymarket opens a binary market: "Will BTC go up or down in the next 5 minutes?" This bot monitors BTC price action in real-time and places trades when it detects high-conviction signals.

### Signal Engine

The bot combines multiple technical indicators with strict trend-alignment rules:

- **Stochastic RSI (14,14,3,3)** on 1-minute candles from Binance WebSocket
- **Momentum** (3-min, 5-min, 10-min rate of change + acceleration)
- **EMA20** for trend direction

**Core rule: never bet against the trend.**

| Condition | Signal | Requirements |
|-----------|--------|-------------|
| K < 15, K crossing above D | **UP** | Uptrend (price > EMA20) + Mom5 > -0.05% |
| K > 85, K crossing below D | **DOWN** | Downtrend (price < EMA20) + Mom5 < 0.05% |
| K < 10 (extreme oversold) | **UP** | Uptrend + Mom3 > 0 + momentum accelerating |
| K > 90 (extreme overbought) | **DOWN** | Downtrend + Mom3 < 0 + momentum decelerating |
| Everything else | **SKIP** | No trade placed |

**Entry window**: Only trades within the first 3 minutes of each 5-minute window. One trade per window max.

**Auto-settlement**: After each window closes, the bot queries resolved market outcomes via the Gamma API and updates P&L automatically.

### Architecture

```
┌─────────────────────────────────────────┐
│  Persistent Node.js Process             │
│                                         │
│  ┌──────────┐  ┌──────────────────┐     │
│  │ Binance  │  │  Signal Engine   │     │
│  │ WebSocket├──┤  StochRSI + Mom  │     │
│  │ (1m BTC) │  │  + EMA20 trend   │     │
│  └──────────┘  └────────┬─────────┘     │
│                         │               │
│  ┌──────────┐  ┌────────▼─────────┐     │
│  │ CoinGecko│  │  Trade Executor  │     │
│  │ (30s poll)│  │  Polymarket CLOB │     │
│  └──────────┘  └────────┬─────────┘     │
│                         │               │
│  ┌──────────┐  ┌────────▼─────────┐     │
│  │ HTTP API │  │  Auto-Settlement │     │
│  │ :3847    │  │  Gamma API       │     │
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

Create a `.env` file or export these:

```bash
# Required
EVM_PRIVATE_KEY=        # Polygon wallet private key

# Proxy (required if running from US — Polymarket CLOB is geo-blocked)
PROXY_URL=              # EU proxy URL for Polymarket CLOB API
PROXY_SECRET=           # Proxy authentication secret

# Optional
RPC_URL=                # Polygon RPC endpoint (default: polygon-rpc.com)
BOT_PORT=               # HTTP API port (default: 3847)
```

### USDC.e Approvals

Before trading, approve USDC.e spending for Polymarket's exchange contracts:

```bash
EVM_PRIVATE_KEY=0x... RPC_URL=... npx tsx skill/scripts/approve-usdc.ts
```

This approves both:
- CTF Exchange: `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E`
- Neg Risk Exchange: `0xC5d563A36AE78145C45a50134d48A1215220f80a`

### Install & Run

```bash
npm install

# Start (background process)
bash start.sh

# Check status
curl http://127.0.0.1:3847/status

# Stop
bash stop.sh
```

## HTTP API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/status` | GET | Bot state, current signal, stats, P&L |
| `/trades` | GET | Recent trade history with outcomes |
| `/pause` | POST | Pause trading (keeps process running) |
| `/resume` | POST | Resume trading |
| `/config` | POST | Update thresholds live (JSON body) |
| `/stop` | POST | Graceful shutdown |

### Example: Update Config

```bash
curl -X POST http://127.0.0.1:3847/config \
  -H "Content-Type: application/json" \
  -d '{"positionSize": 10, "dryRun": false}'
```

Tunable parameters:
- `positionSize` — USD per trade (default: 5)
- `dryRun` — true/false
- `oversoldThreshold` — StochRSI K threshold for UP signals (default: 15)
- `overboughtThreshold` — StochRSI K threshold for DOWN signals (default: 85)
- `extremeOversold` / `extremeOverbought` — triple-confirmation zones (default: 10/90)
- `minConfidence` — minimum confidence to execute (default: 0.6)
- `maxPrice` — max bid price per token (default: 0.65)

## Project Structure

```
├── src/
│   ├── bot.ts              # Main process — lifecycle, trading loop, HTTP API
│   ├── price-engine.ts     # Binance WebSocket + CoinGecko cross-check
│   ├── market-engine.ts    # Polymarket market discovery + settlement
│   ├── signal-engine.ts    # StochRSI + momentum + trend signals
│   └── indicators.ts       # RSI, SMA, Stochastic RSI calculations
├── skill/
│   ├── SKILL.md            # OpenClaw skill documentation
│   └── scripts/
│       ├── bot.ts          # v1 standalone script (cron-compatible)
│       └── approve-usdc.ts # USDC.e approval helper
├── start.sh                # Start bot as background process
├── stop.sh                 # Stop bot
├── state.json              # Persisted state (trades, P&L, config)
└── bot.log                 # Runtime logs
```

## EU Proxy

Polymarket's CLOB API is geo-blocked from the US. The bot routes requests through an EU proxy (configurable via `PROXY_URL` and `PROXY_SECRET`). The proxy transparently forwards requests to `clob.polymarket.com` and `gamma-api.polymarket.com`.

## Risk Warning

- **Binary outcomes** — you can lose your entire position on every trade
- **5-minute markets are volatile** — signals can be noisy on short timeframes
- **This is experimental software** — use at your own risk
- **Not financial advice**

## License

MIT
