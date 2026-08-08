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
8. DC selection: dropdown in login form (Auto / US / Europe / Singapore), saved to `tg_dc` localStorage + `telegram_dc` DB setting

## Telegram Bot (grammy)
- `TELEGRAM_BOT_TOKEN` env enables bot. Single admin via `BOT_ADMIN_IDS` or first user.
- Commands: `/start`, `/help`, `/channels`, `/positions`, `/signals`, `/wallets`, `/balance`, `/stats`, `/disconnect`, `/cancel`
- **Positions** (`showPositions`/`showPositionDetail`/`executePositionSell`): list open trades with live P&L (parallel `getTokenInfo`), per-position detail with Sell 25/50/100% (inline confirm), Set TP/SL via `_awaitingPosTPSL` text input.
  - Sell ≥100% → `closeTrade`; partial sell → `updateTrade` reduces `buy_amount_sol`, keeps position open.
  - Partial/100% sell uses `executeSell(..., creds)` from `getUserCredentials(t.telegram_id || adminId)`.
- **Wallet selection**: in `/wallets` each row has ☆ button → `db.setActiveWallet(w.id)` (used when rule `wallet_group_id` is 0/absent). ⭐ marks the active wallet.
- TP/SL set on positions is stored locally via `updateTrade` (take_profit_percent/stop_loss_percent); GMGN condition orders are still set at buy time via channel rule.

## Auth System
- Optional password via `DASHBOARD_PASSWORD` env
- Primary auth: Telegram login → `authToken` returned after verify-code/password
- Session token stored in `SESSIONS` Map with `{ expires, telegramId }`
- Client sends `x-auth-token` header (dynamic, read from localStorage per request)
- On page refresh: `/api/telegram/status` returns fresh token if Telegram client connected
- Cleanup interval runs only when server is active (in `startWebServer`)
- Telegram data isolated per user via `telegram_id` column in all tables
- **Operator/admin is NOT based on the API ID.** Multiple accounts can log in with the
  same `TELEGRAM_API_ID`, but the operator is ONE specific `telegram_id` configured via
  `OPERATOR_TELEGRAM_ID` env. If unset → nobody is an operator → every user is strictly
  isolated (web + bot) and can log in simultaneously on different devices.

## Wallet System
- Wallets = OUR buy wallets (imported with private key for signing)
- Wallet groups = distribute buy across multiple wallets
- `wallet_group_id` in rule: positive = group, negative = single wallet, 0/absent = active wallet
- SOL balance: Solana RPC `getBalance` first (parallel, no GMGN rate cost) → GMGN `wallet_token_balance` fallback; 8s cache on `/api/wallets/portfolio`
- Generate wallet via `generateSolanaWallet()` (ed25519 keypair)

## GMGN API Patterns
- **Rate limiter**: global weighted token bucket in `request()` — base-tier budget `GMGN_MAX_RPS` (default 5, set to 15 if the key traded in 24h), each endpoint consumes `weight` tokens (wallet/order endpoints weight 3, token/market/swap weight 1). Bursts queue instead of 429-storming.
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

### Multi-Level TP/SL (rules)
- Rule columns `tp_levels` / `sl_levels` (JSON `[{percent, sell_ratio}]`) hold multiple exit levels.
- Router `executeAutoBuy` builds one `profit_stop`/`loss_stop` condition order per level, e.g. `+100% sell 50%`, `+200% sell 70%`.
- Levels take precedence: if `tp_levels` non-empty the legacy `take_profit_percent` is ignored (same for `sl_levels` vs `stop_loss_percent`).
- Bot single TP/SL input clears the corresponding levels array to avoid conflicts.

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

## AsyncLocalStorage (telegram_id scoping — DO NOT BREAK)
- `database.js` uses `AsyncLocalStorage` (`_tgScope`). `_tid()` and `getTelegramId()` read the ALS store FIRST, then fall back to the global `_currentTgId`.
- `db.runWithTelegramId(tid, fn)` pins the tid for the ENTIRE async chain inside `fn` (awaits + fire-and-forget `.then()`). Nested calls override the outer scope. `db.setTelegramId()` only mutates the GLOBAL fallback — inside an ALS scope it is effectively ignored by `_tid()`.
- Scraper hot path: `processSignal()` wraps the whole pipeline in `runWithTelegramId(ownerId, ...)` (owner = `active_telegram_id`, 10s cached via `getActiveScraperId()`). Signals, saveSignal, trades, and fire-and-forget `.then()` callbacks all inherit the pinned owner — immune to web requests flipping the global mid-flight.
- Web requests: the `/api` middleware wraps each request in `runWithTelegramId(req.telegramId, ...)` so concurrent requests from different users never interleave scopes.
- Telegram bot: `bot.use(...)` wraps every update in `runWithTelegramId(adminId, ...)`.
- Re-scoping to a trade's real owner (closeTrade, reconcile, backfill, pollOrder) MUST use `asOwner(t.telegram_id, fn)` in router.js (wraps in `runWithTelegramId`), NOT `db.setTelegramId()` — the latter no longer works inside an ALS scope.
- Rules/wallet caches (`_ck()`) key on `db.getTelegramId()` which now returns the ALS-pinned owner.

## Testing
```
npm test           # runs all tests
rm -rf data && npm test  # clean slate
```
Tests use SQLite, write to `data/sniper.db`. Delete before run to avoid stale state.
