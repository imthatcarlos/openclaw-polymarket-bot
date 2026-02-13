#!/bin/bash
cd "$(dirname "$0")"

if [ -f .bot.pid ]; then
  PID=$(cat .bot.pid)
  if kill -0 "$PID" 2>/dev/null; then
    echo "Stopping bot (PID $PID)..."
    kill "$PID"
    rm -f .bot.pid
    echo "Stopped."
  else
    echo "Bot not running (stale PID)."
    rm -f .bot.pid
  fi
else
  echo "No PID file found."
fi
