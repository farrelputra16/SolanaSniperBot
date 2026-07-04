# Solana Sniper Bot

GMGN-powered Telegram signal scraper with auto-buy engine, web dashboard, and multi-channel forwarding. Like Maestro, but free and fully customizable.

## Architecture

```
Telegram Channels (MTProto)  →  GMGN API (market data + swap)  →  Web Dashboard
         │                              │
         ├─ Extract token addresses      ├─ Quality filter (rug ratio, liquidity, etc.)
         ├─ Forward raw signals          ├─ Auto-buy via GMGN swap API
         └─ Pass to filter engine        └─ TP/SL management
```

## Features

- **Multi-channel scraping** — Monitor unlimited Telegram channels for token signals
- **GMGN quality filter** — Auto-filter by market cap, liquidity, rug ratio, smart money count, bundler rate
- **Auto-buy** — Execute buys via GMGN swap API (bypasses RPC/Jupiter — GMGN handles routing)
- **TP/SL** — Take profit and stop loss via GMGN condition orders
- **Signal forwarding** — Forward filtered signals to any Telegram chat
- **Web dashboard** — Full management UI (channels, rules, wallets, trades, settings)
- **Zero infrastructure** — No Solana RPC, no Jupiter API, no custom nodes needed

## Prerequisites

| Item | How to get |
|------|-----------|
| **GMGN API Key** | Already configured (`~/.config/gmgn/.env`) |
| **Telegram API ID + Hash** | https://my.telegram.org/apps |
| **Node.js 18+** | `node -v` |

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy and fill environment
cp .env.example .env

# 3. Setup Telegram session (login once)
npm run setup-telegram

# 4. Start the bot
npm start
```

Open http://localhost:3000 to access the dashboard.

## Setup Details

### 1. Telegram API Credentials

Go to https://my.telegram.org/apps, create an app, and copy `api_id` and `api_hash`.

### 2. GMGN API Key

Already configured. The bot reads `~/.config/gmgn/.env` automatically.

### 3. Wallet

Add your Solana wallet address in the Web Dashboard > Wallets section. Only wallets already bound to your GMGN API Key will work for auto-buy.

## Usage Flow

1. **Add channels** via Dashboard > Channels
2. **Set filter rules** per channel (min MC, max rug ratio, etc.)
3. **Enable auto-buy** on any rule — bot buys automatically when signal passes
4. **Set up forwarding** filtered signals to your private Telegram
5. **Monitor trades** in Dashboard > Trades

## Cost

| Component | Cost |
|-----------|------|
| GMGN API | Free |
| Telegram MTProto | Free |
| Hosting | $0–10/mo (VPS optional) |
| Swap fees | Only GMGN swap fee per trade |

## Tech Stack

- **Node.js** — Runtime
- **GramJS** — Telegram MTProto client (pure JS, no native deps)
- **Express** — Web server + API
- **better-sqlite3** — Embedded database
- **GMGN OpenAPI** — Market data + swap execution

## Project Structure

```
src/
├── index.js         # Entry point
├── config.js        # Environment config
├── database.js      # SQLite models
├── gmgn.js          # GMGN API client + swap
├── telegram.js      # MTProto telegram client
├── router.js        # Signal processing + auto-buy
├── setup-telegram.js# Telegram login wizard
├── web-server.js    # Express API
└── public/          # Web dashboard frontend
```
