# Kaiser — Polymarket IPO Dashboard

Live dashboard for tracking Polymarket prediction markets around major IPO events (SpaceX, OpenAI, etc.). Shows real-time bid/ask prices, 24h price changes, and a tier matrix calculator for position sizing.

## Features

- Live bid/ask prices from Polymarket Gamma API (polls every 20s)
- 24h price change per market (from Polymarket CLOB history API)
- Tier matrix calculator with profit factor sliders, anchor mode, and free mode
- Position P&L tracking (per-user wallet, stored in browser only)
- Snapshot save/load for frozen price scenarios
- Collapsible event sections, slug manager to add/remove markets
- Resolved event archive
- Deployment-ready: admin token auth, Caddy reverse proxy config

## Quick start

```bash
npm install
cp .env.example .env
# edit .env if needed
node bot.js
# open http://localhost:3001
```

## Configuration

Edit `bot.config.json` to change the tracked event slugs, poll interval, or port.

```json
{
  "port": 3001,
  "pollSeconds": 20,
  "eventSlugs": [
    "spacex-ipo-closing-market-cap",
    "openai-ipo-closing-market-cap"
  ]
}
```

Add any Polymarket event URL in the dashboard's URL bar — it will be parsed and added automatically.

## Wallet / positions

Enter your public Polygon wallet address in the dashboard. It is stored in your browser's `localStorage` only — it never touches the server. Each visitor sees their own positions.

## Deployment

1. Set `ADMIN_TOKEN` in `.env` (protects the slug management endpoint)
2. Edit `Caddyfile` — replace `yourdomain.com` with your domain
3. Run under PM2: `pm2 start bot.js --name kaiser && pm2 save`
4. Run Caddy: `caddy run --config Caddyfile` (auto-obtains TLS cert)
5. Open ports 80 and 443

## Generating Polymarket CLOB credentials (optional)

Only needed for open-order display. Two methods:

**With private key:**
```bash
PRIVATE_KEY=0x... node gen-creds.mjs
```

**With WalletConnect (mobile wallet):**
```bash
WALLETCONNECT_PROJECT_ID=abc123 node gen-creds-wc.mjs
```

Credentials are written to `.env` automatically.
