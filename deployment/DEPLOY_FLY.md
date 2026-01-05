# Deploying to Fly.io

## Prerequisites

- Fly CLI installed (`curl -L https://fly.io/install.sh | sh`)
- Fly.io account (free tier)
- Git installed

## Step 1: Install Fly CLI

```bash
curl -L https://fly.io/install.sh | sh
```

Add to PATH (follow instructions from installer):
```bash
export PATH="$HOME/.fly/bin:$PATH"
```

## Step 2: Login to Fly.io

```bash
fly auth login
```

This will open your browser for authentication.

## Step 3: Launch the Application

```bash
# Initialize (only needed once)
fly launch --no-deploy

# Review and confirm the fly.toml configuration
# Choose app name and region (Singapore recommended for BSC)
```

## Step 4: Set Secrets

Set environment variables as secrets:

```bash
# Required
fly secrets set RPC_ENDPOINTS="https://bsc-dataseed.binance.org,https://bsc-dataseed1.defibit.io"
fly secrets set WS_ENDPOINTS="wss://bsc-ws-node.nariox.org:443"
fly secrets set MIN_PROFIT_PERCENTAGE="0.5"

# Optional: Discord webhook
fly secrets set DISCORD_WEBHOOK_URL="your-discord-webhook-url"

# Optional: Telegram
fly secrets set TELEGRAM_BOT_TOKEN="your-bot-token"
fly secrets set TELEGRAM_CHAT_ID="your-chat-id"
```

## Step 5: Deploy

```bash
fly deploy
```

## Step 6: Monitor

```bash
# View logs
fly logs

# Check status
fly status

# SSH into machine
fly ssh console

# View resource usage
fly scale show
```

## Updating the App

```bash
# Pull latest code
git pull

# Deploy
fly deploy
```

## Troubleshooting

### Out of Memory

If you see OOM errors:

```bash
# Check memory usage
fly scale show

# The free tier gives 256MB
# Reduce MAX_PAIRS_TO_MONITOR in secrets:
fly secrets set MAX_PAIRS_TO_MONITOR="15"
```

### Connection Issues

```bash
# Restart the app
fly apps restart bsc-arbitrage-bot

# Check health
fly checks list
```

### Rate Limits

Add more RPC endpoints:

```bash
fly secrets set RPC_ENDPOINTS="endpoint1,endpoint2,endpoint3,endpoint4,endpoint5"
```

## Cost

Fly.io free tier includes:
- 3 shared-CPU-1x VMs with 256MB RAM (always running)
- 160GB outbound data transfer

This bot uses approximately:
- 1 VM
- 80-150MB RAM
- ~1-2GB data/month

**Total cost: $0/month** (within free tier)

## Stopping the App

```bash
# Stop (keeps the app, stops charging if over free tier)
fly scale count 0

# Destroy completely
fly apps destroy bsc-arbitrage-bot
```
