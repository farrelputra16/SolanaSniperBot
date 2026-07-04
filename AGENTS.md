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
4. **GMGN request resilience** — `request()` retries on 429 with reset-at header, 15s fetch timeout, abort controller.
5. **Telegram keep-alive** — `startKeepAlive()` pings every 30s, prevents reconnect delay.
6. **Wallet distribution** — `buy_amount_sol = total`, divided equally across wallets in group.
7. **Order polling** — background, 15 attempts × 2s = 30s max, non-blocking.
8. **Token cache** — `_tokenCache` map, 30s TTL, stale-while-revalidate pattern. Skips duplicate GMGN calls for same CA within 30s.
9. **Parallel wallet swap** — `Promise.allSettled()` for multi-wallet buys, not sequential.

## Telegram Channel Join (Invite Links)
For private channels (`https://t.me/+hash`):
1. Try `ImportChatInvite` first
2. Fallback `CheckChatInvite`
3. Fallback dialog search
Public channels resolve via `getEntity(username)`.
Handler dedup via `_listeners` Map — removes old handler before adding new one per chatId.

## Telegram Login (Dashboard)
Login flow is done via the web dashboard, not CLI:
1. **POST /api/telegram/start** — { apiId, apiHash, phone } → sends OTP, returns loginToken
2. **POST /api/telegram/verify-code** — { loginToken, code } → if 2FA needed, returns { twoFactor: true }
3. **POST /api/telegram/verify-password** — { loginToken, password } → completes login
4. Session string saved to DB via `db.setSetting('telegram_session', ...)`
5. On startup: check DB for saved session → `initTelegramWithSession()` → `startListeners()`
6. Fallback to `.env` credentials if no saved session
7. Flood wait errors caught → returns `waitSeconds` in response

## Auth System
- Optional password via `DASHBOARD_PASSWORD` env
- Primary auth: Telegram login → `authToken` returned after verify-code/password
- Session token stored in `SESSIONS` Map with `{ expires, telegramId }`
- Client sends `x-auth-token` header (dynamic, read from localStorage per request)
- On page refresh: `/api/telegram/status` returns fresh token if Telegram client connected
- Cleanup interval runs only when server is active (in `startWebServer`)
- Telegram data isolated per user via `telegram_id` column in all tables

## Wallet System
- Wallets = OUR buy wallets (imported with private key for signing)
- Wallet groups = distribute buy across multiple wallets
- `wallet_group_id` in rule: positive = group, negative = single wallet, 0/absent = active wallet
- Balance via GMGN `wallet_token_balance` → fallback Solana RPC
- Generate wallet via `generateSolanaWallet()` (ed25519 keypair)

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
`strategy_order_id` captured from swap response and saved to `strategy_orders` table.

## Real-time Events (SSE)
- `GET /api/events` — Server-Sent Events stream
- Events: `signal`, `trade`, `status`
- Pushed from `router.js` via `liveEvents` EventEmitter
- Frontend subscribes via `EventSource`, updates signal/trade tables in-place

## Token Detail
- `GET /api/token/detail?chain=sol&address=...` — fetches info + security + holders
- Frontend modal shows: price, MC now, catched MC, liquidity, volume, smart money, honeypot, rug ratio, bundler rate, top10 holders, dev status, top holders table
- Signal rows use `onclick="openTokenDetail(address, caughtMC)"`

## Base58 Validation
- `extractAddresses()` uses `isValidSolAddress()` which decodes base58 and verifies `decoded.length === 32`
- Eliminates false positive address matches

## Conventions
- No TypeScript
- Fire-and-forget DB writes in hot path (`.catch(()=>{})`)
- `Promise.allSettled()` for parallel API calls, never sequential
- Wallet addresses stored as-is (private keys in `private_key` column, plaintext — no encryption yet)
- Error handling: catch + log only, never block the main flow
- Negative `wallet_group_id` = abs value = single wallet ID
- All tables have `telegram_id` TEXT column for multi-user isolation

## Testing
```
npm test           # runs all tests
rm -rf data && npm test  # clean slate
```
Tests use SQLite, write to `data/sniper.db`. Delete before run to avoid stale state.
