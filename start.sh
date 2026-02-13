#!/bin/bash
cd "$(dirname "$0")"

# Kill existing if running
if [ -f .bot.pid ] && kill -0 "$(cat .bot.pid)" 2>/dev/null; then
  echo "Bot already running (PID $(cat .bot.pid)). Stop first."
  exit 1
fi

echo "Starting Polymarket BTC Bot v2..."
nohup npx tsx src/bot.ts >> bot.log 2>&1 &
echo $! > .bot.pid
echo "Started (PID $!). Logs: tail -f bot.log"
echo "API: curl http://127.0.0.1:3847/status"
