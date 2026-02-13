# Polymarket BTC 5-Min Trading Bot

## Architecture
**v2**: Persistent Node.js process with WebSocket price feeds and HTTP control API.
Runs as a background process, not a cron job.

## Quick Start
```bash
cd /root/.openclaw/workspace/polymarket-bot

# Start the bot (background process)
bash start.sh

# Check status
curl -s http://127.0.0.1:3847/status

# Stop
bash stop.sh
```

## HTTP API (port 3847)
- `GET /status` — signal, stats, P&L, connections
- `GET /trades` — recent trade history with outcomes
- `POST /pause` / `POST /resume` — pause/resume trading
- `POST /config` — tune thresholds live (JSON body)
- `POST /stop` — graceful shutdown

## Algorithm (v3 — trend-aligned only)
1. Binance WebSocket streams 1-min BTC candles in real-time
2. Every 15s, calculate StochRSI(14,14,3,3) + momentum (Mom3/Mom5/Mom10) + EMA20 trend
3. Signal rules (NO counter-trend bets):
   - **K < 15 + K > D + uptrend + mom5 > -0.05%** → BUY Up
   - **K > 85 + K < D + downtrend + mom5 < 0.05%** → BUY Down
   - **K < 10 + uptrend + mom3 > 0 + momentum accelerating** → BUY Up (extreme)
   - **K > 90 + downtrend + mom3 < 0 + momentum decelerating** → BUY Down (extreme)
   - Everything else → Skip
4. Only trades current 5-min window (skips if >3 min elapsed)
5. One trade per window (in-memory dedup)
6. Auto-settles pending trades after window closes via Gamma API

## Cron: Trade Report
Fires every 5 min at :00/:05/:10... (with 10s delay for settlement).
Hits the HTTP API and announces summary to Carlos.

```
Schedule: 0-55/5 * * * * UTC
Cron ID: 0f7c320a-0888-4015-99a3-5f439e026206
Delivery: announce
```

## Environment
- `EVM_PRIVATE_KEY` — Polygon wallet private key
- `PROXY_URL` — EU proxy for Polymarket CLOB (default: polymarket-proxy-production.up.railway.app)
- `PROXY_SECRET` — Proxy auth secret
- `RPC_URL` — Polygon RPC (default: Alchemy)
- `BOT_PORT` — HTTP API port (default: 3847)

## Infrastructure
- **EU Proxy**: Railway service in Netherlands, bypasses US geo-block on Polymarket CLOB
- Wallet address, CLOB API key, and proxy secret are configured via `.env`

## Risk
- Binary outcomes — you can lose your entire position per trade
- $5 position size by default
- Experimental. Not financial advice.
