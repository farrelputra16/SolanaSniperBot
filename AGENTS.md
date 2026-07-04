# SniperBot — Agent Rules

## Project Identity
Solana Telegram signal scraper + auto-buy engine via GMGN API. Node.js, GramJS (MTProto), Express, better-sqlite3.

## Architecture
```
Telegram MTProto → regex CA extraction → GMGN REST API (info+security) → filter → auto-buy
```
- **No Solana RPC** — all data + swap via GMGN OpenAPI
- **No Jupiter API** — GMGN handles routing
- **Database**: SQLite (better-sqlite3) with WAL mode, or optional MongoDB

## Key Files

| File | Purpose |
|------|---------|
| `src/index.js` | Entry point, wiring |
| `src/telegram.js` | GramJS MTProto client, message handlers, channel join |
| `src/gmgn.js` | GMGN REST client (market data, swap, portfolio, wallet gen) |
| `src/router.js` | Signal processing, filter engine, auto-buy execution |
| `src/web-server.js` | Express API, auth middleware, wallet portfolio |
| `src/database.js` | SQLite models with MongoDB fallback |
| `src/public/index.html` | Single-page dashboard frontend |

## Hot Path (Scraping Speed Critical)
```
Message → handleMessage() → processSignal()
  → extractAddresses() → Promise.all(getTokenInfo, getTokenSecurity)
  → parseTokenData() → match rules → executeSwap()
```

### Speed Optimizations (DO NOT BREAK)
1. **Rules cache** — `getCachedRules()` in router.js, 5s TTL. Never query DB per signal.
2. **Parallel addresses** — `Promise.allSettled()` across all CAs in one message.
3. **Fire-and-forget** — `db.addScraperLog()` and `db.saveSignal()` NEVER awaited (`.catch(()=>{})`).
4. **GMGN auth cache** — `_authCache` in gmgn.js, reuses timestamp+client_id within same second.
5. **Telegram keep-alive** — `startKeepAlive()` pings every 30s, prevents reconnect delay.
6. **Wallet distribution** — `buy_amount_sol = total`, divided equally across wallets in group.
7. **Order polling** — background, 15 attempts × 2s = 30s max, non-blocking.

## Telegram Channel Join (Invite Links)
For private channels (`https://t.me/+hash`):
1. Try `ImportChatInvite` first
2. Fallback `CheckChatInvite`
3. Fallback dialog search
Public channels resolve via `getEntity(username)`.

## Telegram Login (Dashboard)
Login flow is done via the web dashboard, not CLI:
1. **POST /api/telegram/start** — { apiId, apiHash, phone } → sends OTP, returns loginToken
2. **POST /api/telegram/verify-code** — { loginToken, code } → if 2FA needed, returns { twoFactor: true }
3. **POST /api/telegram/verify-password** — { loginToken, password } → completes login
4. Session string saved to DB via `db.setSetting('telegram_session', ...)`
5. On startup: check DB for saved session → `initTelegram()` → `startListeners()`
6. Fallback to `.env` credentials if no saved session

## Auth System
- Optional password via `DASHBOARD_PASSWORD` env
- Login → crypto.randomUUID() session token (24h expiry, extended per request)
- Client sends `x-auth-token` header
- Cleanup interval runs only when server is active (in `startWebServer`)

## Wallet System
- Wallets = OUR buy wallets (imported with private key for signing)
- Wallet groups = distribute buy across multiple wallets
- `wallet_group_id` in rule: positive = group, negative = single wallet, 0/absent = active wallet
- Balance via GMGN `wallet_token_balance` → fallback Solana RPC

## GMGN API Patterns
- Exist auth (API key only): `token/info`, `token/security`, `user/wallet_token_balance`, `user/info`, `user/wallet_stats`, `user/wallet_activity`
- Critical auth (+ signature): `trade/swap`, `trade/multi_swap`, `user/wallet_holdings`
- Signing uses `GMGN_PRIVATE_KEY` (RSA or Ed25519 auto-detected)

## Condition Orders (TP/SL)
```json
[{"order_type":"profit_stop","side":"sell","price_scale":"100","sell_ratio":"50"}]
```
Types: `profit_stop`, `loss_stop`, `profit_stop_trace`, `loss_stop_trace`
Requires `--priority-fee` + `--tip-fee` on SOL.

## Conventions
- No TypeScript
- Fire-and-forget DB writes in hot path (`.catch(()=>{})`)
- `Promise.allSettled()` for parallel API calls, never sequential
- Wallet addresses stored as-is (private keys in `private_key` column, plaintext — no encryption yet)
- Error handling: catch + log only, never block the main flow
- Negative `wallet_group_id` = abs value = single wallet ID

## Testing
```
npm test           # runs all tests
rm -rf data && npm test  # clean slate
```
Tests use SQLite, write to `data/sniper.db`. Delete before run to avoid stale state.
