# Quick Start Guide

## Running the Bot Locally

The bot is ready to run! Here's how to get started:

### 1. Make sure you're in the project directory
```bash
cd /Users/pho/DEV/Arbitrage_Bot/Antigravity_Version/Arbitrage_Bot_V2
```

### 2. Run the bot
```bash
npm start
```

The bot will:
- Try to connect via WebSocket first  
- If WebSocket fails (common with free endpoints), automatically fall back to HTTP polling mode
- Start monitoring blocks every ~3 seconds
- Alert you when arbitrage opportunities are found

### 3. Expected Output

You should see:
```
🚀 BSC Arbitrage Bot starting...
✅ Bot is now running and monitoring for arbitrage opportunities
📊 Monitoring 6 tokens across 2 DEXs
Starting HTTP polling mode (polling every 3 seconds)
✅ Block Monitor started successfully (HTTP polling mode)
📦 New block: 73971XXX
```

### 4. When an Opportunity is Found

```
============================================================
🎯 ARBITRAGE OPPORTUNITY DETECTED
============================================================
Pair: WBNB/BUSD
Buy on pancakeswap: 310.500000
Sell on biswap: 312.750000
Net Profit: 0.36%
Fees: 0.35%
Liquidity: $150000
============================================================
```

### 5. Stop the Bot

Press `Ctrl+C` to stop.

## Known Issues & Solutions

### WebSocket Timeout

If you see `Error: read ETIMEDOUT` during startup, this is normal - free WebSocket endpoints are unreliable. The bot automatically falls back to HTTP polling mode which works perfectly.

### No Opportunities Found

This is normal during low volatility periods. The bot is working correctly, just waiting for price discrepancies. Consider:
- Lower `MIN_PROFIT_PERCENTAGE` in `.env` (try `0.3`)
- Wait during high-volume trading times (Asia/US market hours)

### Want Discord/Telegram Alerts?

Edit `.env` and add:
```
DISCORD_WEBHOOK_URL=your-webhook-here
```

Create a Discord webhook: Server Settings → Integrations → Webhooks → New Webhook

## Performance

- **Memory**: ~80-150 MB
- **CPU**: < 5% normally
- **Network**: ~1-2 MB/hour
- **RPC Calls**: ~40-60/minute (well under free limits)

## Deploying to Free Hosting (Optional)

### Deploy to Fly.io (Recommended)

```bash
# Install Fly CLI
curl -L https://fly.io/install.sh | sh

# Login
fly auth login

# Deploy
fly launch
fly secrets set RPC_ENDPOINTS="https://bsc-dataseed.binance.org,..."
fly deploy

# View logs
fly logs
```

See `deployment/DEPLOY_FLY.md` for full guide.

## Troubleshooting

### "No prices fetched for this block"

Some blocks may have no data - this is normal. The bot keeps running.

### Rate Limit Errors

If you see HTTP 429 errors:
1. The bot automatically rotates to another endpoint
2. Add more RPC endpoints in `.env` 
3. Reduce `MAX_PAIRS_TO_MONITOR=20`

### Bot Crashes

Check logs in `logs/error.log`. Common causes:
- All RPC endpoints down (very rare)
- Network connectivity issues
- Out of memory (unlikely with default settings)

## Next Steps

1. **Run locally first** to see how it works
2. **Configure alerts** if you want notifications
3. **Deploy to Fly.io** for 24/7 operation (free tier)

## Support

- Check `README.md` for full documentation
- Review `walkthrough.md` for architecture details
- See `deployment/DEPLOY_FLY.md` for deployment guide
