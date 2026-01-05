# BSC Arbitrage Bot (Node.js)

A rate-limit-resistant arbitrage monitoring bot for BNB Chain (BSC) DEXs. Monitors price differences across PancakeSwap and Biswap without using paid services.

## Features

- 🚀 **Event-driven WebSocket architecture** - Real-time block monitoring
- 💰 **Smart arbitrage detection** - Identifies profitable opportunities across DEXs
- 🔄 **Rate limit optimization** - Operates within free RPC tier limits
- 📊 **Multi-channel alerts** - Console, Discord, Telegram notifications
- 🎯 **Direct smart contract interaction** - No reliance on centralized APIs
- 🌐 **Free 24/7 hosting** - Deploy on Fly.io, Railway, or Oracle Cloud

## Quick Start

### Prerequisites

- Node.js 18+ LTS
- npm or yarn
- Git

### Installation

```bash
# Clone repository
git clone <repo-url>
cd Arbitrage_Bot_V2

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit configuration
nano .env
```

### Configuration

Edit `.env` file with your preferences:

- `MIN_PROFIT_PERCENTAGE`: Minimum profit threshold (default: 0.5%)
- `RPC_ENDPOINTS`: Add more free BSC RPC endpoints for redundancy
- `DISCORD_WEBHOOK_URL`: Discord webhook for alerts (optional)

### Running Locally

```bash
# Development mode (auto-reload)
npm run dev

# Production mode
npm start
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Main Orchestrator                    │
└───────────────┬─────────────────────────────────────────┘
                │
    ┌───────────┴───────────┬──────────────┬──────────────┐
    │                       │              │              │
┌───▼────────┐   ┌─────────▼──────┐  ┌───▼──────┐  ┌────▼─────────┐
│  Block     │   │  Price Cache   │  │ Arbitrage│  │  Alerting    │
│  Monitor   │   │  Manager       │  │ Detector │  │  System      │
│ (WebSocket)│   │ (Smart Contract│  │          │  │              │
└────────────┘   │   Direct Read) │  └──────────┘  └──────────────┘
                 └────────────────┘
```

## Rate Limit Strategy

The bot uses multiple strategies to stay within free RPC limits:

1. **WebSocket subscription** - Only ~20 updates/min aligned with BSC block time
2. **Batch operations** - Multicall pattern reduces individual calls
3. **Intelligent caching** - Block-based cache invalidation
4. **Endpoint rotation** - Distributes load across 5+ free providers
5. **Client-side throttling** - Pre-emptive rate limiting

**Expected usage**: ~40-60 requests/min (vs 120,000/hour free tier limit)

## Deployment

### Option 1: Fly.io (Recommended)

```bash
# Install Fly CLI
curl -L https://fly.io/install.sh | sh

# Login and deploy
fly auth login
fly launch
fly deploy
```

### Option 2: Railway

1. Connect GitHub repository
2. Deploy automatically on push

### Option 3: Oracle Cloud

See `deployment/oracle/setup.sh` for automated setup script.

## Testing

```bash
# Run all tests
npm test

# Test RPC connectivity
node scripts/test-connection.js

# Validate price accuracy
node scripts/validate-prices.js --pair WBNB/BUSD
```

## Monitoring

View real-time logs:

```bash
# Local
npm start

# Fly.io
fly logs

# Railway
railway logs

# Oracle Cloud
ssh ubuntu@<server-ip>
sudo journalctl -u arbitrage-bot -f
```

## Project Structure

```
Arbitrage_Bot_V2/
├── src/
│   ├── index.js                 # Main entry point
│   ├── config.js                # Configuration
│   ├── contracts/
│   │   └── abis.js              # Smart contract ABIs
│   ├── utils/
│   │   ├── rpcManager.js        # RPC connection manager
│   │   └── logger.js            # Winston logger
│   ├── monitoring/
│   │   ├── blockMonitor.js      # WebSocket block monitor
│   │   └── performanceTracker.js
│   ├── data/
│   │   ├── priceFetcher.js      # Smart contract price fetcher
│   │   └── cacheManager.js      # Price caching
│   ├── analysis/
│   │   ├── arbitrageDetector.js # Opportunity detection
│   │   └── opportunityScorer.js # Opportunity ranking
│   └── alerts/
│       └── alertManager.js      # Multi-channel alerts
├── tests/                       # Jest tests
├── scripts/                     # Utility scripts
├── deployment/                  # Deployment configs
├── logs/                        # Log files
├── package.json
├── .env.example
└── README.md
```

## Configuration Reference

### DEXs Monitored

- **PancakeSwap V2** (0.25% fee)
- **Biswap** (0.1% fee)

### Tokens Supported

- WBNB (Wrapped BNB)
- BUSD (Binance USD)
- USDT (Tether USD)
- USDC (USD Coin)
- CAKE (PancakeSwap)
- BSW (Biswap)

Add more tokens in `src/config.js`.

## Troubleshooting

### Rate Limit Errors

If you see HTTP 429 errors:
1. Add more RPC endpoints to `.env`
2. Reduce `MAX_PAIRS_TO_MONITOR`
3. Check endpoint health with `node scripts/test-connection.js`

### WebSocket Disconnections

The bot automatically reconnects with exponential backoff. If issues persist:
1. Try different WS endpoints in `.env`
2. Check firewall/network settings

### No Opportunities Found

This is normal during low volatility periods. Consider:
1. Lowering `MIN_PROFIT_PERCENTAGE` (but watch for false positives)
2. Adding more token pairs
3. Monitoring during high-volume times

## Performance

- **Memory**: 80-150 MB
- **CPU**: < 5% (idle), < 20% (processing)
- **Network**: ~1-2 MB/hour

## Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Add tests for new features
4. Submit a pull request

## License

MIT License - see LICENSE file for details

## Disclaimer

This bot is for educational and monitoring purposes only. Trading cryptocurrencies involves risk. Always do your own research and never invest more than you can afford to lose.

## Support

For issues and questions:
- Open a GitHub issue
- Check documentation in `deployment/` folder
- Review implementation plan in brain artifacts
