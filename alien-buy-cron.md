# Alien Market $150 Buy Cron

Check if the polymarket bot wallet has enough USDC to execute the $150 YES buy on the alien market. If funded, execute the buy and report.

## Steps

1. Run dry-run preflight:
   ```
   cd /root/.openclaw/workspace/polymarket-bot && export $(cat .env | xargs) && EVM_PRIVATE_KEY=$EVM_PRIVATE_KEY DRY_RUN=1 BUY_AMOUNT=150 npx tsx src/buy-yes-aliens.ts 2>&1
   ```
   - Exit code 0 = funded, proceed
   - Exit code 2 = not funded yet, skip and remind

2. If funded (exit code 0 on dry run), execute real buy:
   ```
   cd /root/.openclaw/workspace/polymarket-bot && export $(cat .env | xargs) && EVM_PRIVATE_KEY=$EVM_PRIVATE_KEY BUY_AMOUNT=150 npx tsx src/buy-yes-aliens.ts 2>&1
   ```

3. Send Telegram to 451850101 with result:
   - On success: "✅ Alien market: bought ~XXX YES shares @ $0.XX — $150 deployed. New position: ~XXXX shares total."
   - On still-unfunded: "💸 Alien market buy pending — wallet still needs $XXX. Send USDC to 0x1a1E1b82Da7E91E9567a40b0f952748b586389F9 on Polygon."
   - On error: "❌ Alien buy failed: [error]"

4. If buy was successful, stop this cron (disable it).
