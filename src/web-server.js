import express from 'express';
import { join } from 'path';
import { fileURLToPath } from 'url';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { config } from './config.js';
import * as db from './database.js';
import * as gmgn from './gmgn.js';
import { getDexScreenerInfo } from './dexscreener.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');
export const liveEvents = new EventEmitter();
liveEvents.setMaxListeners(100);

const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days — survives restarts & idle
const SESSIONS = new Map();
// Operator = ONE specific Telegram account (telegram_id) allowed to see all users' data.
// Configured via OPERATOR_TELEGRAM_ID env. NOT the shared API ID — many accounts can log
// in with the same TELEGRAM_API_ID, but only the configured telegram_id is an operator.
// Unset = nobody is an operator → every user is strictly isolated to their own data.
const OPERATOR_TELEGRAM_ID = (config.server.operatorTelegramId || '').toString();
const TOKEN_INFO_TTL = 30 * 1000; // 30s — dashboard P&L polling reuses one GMGN call per token
const _tokenInfoCache = new Map();
function isOperator(s) { return OPERATOR_TELEGRAM_ID !== '' && s != null && String(s.telegramId) === OPERATOR_TELEGRAM_ID; }

function extractQuote(q) {
  const d = q?.data || q || {};
  const txQuote = (d.tx && d.tx.quote) || {};
  const pi = d.price_impact_pct ?? d.price_impact ?? txQuote.priceImpactPct ?? txQuote.priceImpact ?? null;
  const impactPct = pi && typeof pi === 'object' ? (pi.price_pct ?? pi.percent ?? null) : pi;
  return {
    ok: (q?.code ?? d.code) === 0,
    inputAmount: d.input_amount != null ? d.input_amount : null,
    outputAmount: d.output_amount != null ? d.output_amount : (d.amount_out != null ? d.amount_out : null),
    priceImpactPct: impactPct != null ? Number(impactPct) : null,
    error: q?.message || q?.reason || null,
  };
}

let _sessionsLoaded = null;
async function loadSessions() {
  const rows = await db.getAllWebSessions().catch(() => []);
  const now = Date.now();
  for (const row of rows || []) {
    const s = { telegramId: row.telegram_id || '', phone: row.phone || '', source: row.source || 'guest', apiId: row.api_id != null ? String(row.api_id) : '', expires: Number(row.expires) || 0 };
    if (s.expires > now) SESSIONS.set(row.token, s);
    else db.deleteWebSession(row.token).catch(() => {});
  }
}
function ensureSessionsLoaded() {
  if (!_sessionsLoaded) _sessionsLoaded = loadSessions();
  return _sessionsLoaded;
}
async function resolveSession(token) {
  if (!token) return null;
  await ensureSessionsLoaded();
  const cached = SESSIONS.get(token);
  if (cached) return cached;
  const row = await db.getWebSession(token).catch(() => null);
  if (row && Number(row.expires) > Date.now()) {
    const s = { telegramId: row.telegram_id || '', phone: row.phone || '', source: row.source || 'guest', apiId: row.api_id != null ? String(row.api_id) : '', expires: Number(row.expires) };
    SESSIONS.set(token, s);
    return s;
  }
  return null;
}
function setSession(token, data) {
  const s = {
    expires: Number(data.expires) || Date.now() + SESSION_TTL,
    telegramId: data.telegramId || '',
    phone: data.phone || '',
    source: data.source || 'guest',
    apiId: data.apiId != null ? String(data.apiId) : '',
  };
  SESSIONS.set(token, s);
  _sessionWriteTs.set(token, Date.now());
  db.saveWebSession(token, s).catch(() => {});
  return s;
}
function invalidateSession(token, s) {
  if (!s) return;
  if (SESSIONS.get(token)) SESSIONS.delete(token);
  db.deleteWebSession(token).catch(() => {});
}

// Throttle web-session persistence — extending expiry must NOT write SQLite on every
// /api request (dashboard polls every 2s). Persist at most once per token per minute;
// the in-memory SESSIONS map serves the interval in between.
const _sessionWriteTs = new Map();
function touchSession(token, s) {
  const last = _sessionWriteTs.get(token) || 0;
  if (Date.now() - last < 60000) return;
  _sessionWriteTs.set(token, Date.now());
  db.saveWebSession(token, s).catch(() => {});
}

export function getTelegramId(token) {
  const s = SESSIONS.get(token);
  return s && typeof s === 'object' ? s.telegramId : null;
}

export function createWebServer() {
  const app = express();
  app.use(express.json());
  app.use(express.static(join(__dirname, 'public')));

  // Telegram bot webhook endpoint (not under /api — no auth). Used instead of long
  // polling on Render (RENDER_EXTERNAL_URL) to avoid multi-instance 409 conflicts.
  app.post('/webhook/telegram/:secret', async (req, res) => {
    try {
      const { getBot, getWebhookSecret } = await import('./telegram-bot.js');
      const secret = getWebhookSecret();
      if (!secret || req.params.secret !== secret) return res.sendStatus(403);
      const header = req.headers['x-telegram-bot-api-secret-token'];
      if (header && header !== secret) return res.sendStatus(403);
      const b = getBot();
      if (!b) return res.sendStatus(404);
      await b.handleUpdate(req.body);
      res.sendStatus(200);
    } catch (err) {
      console.error('[Bot] Webhook error:', err?.message);
      res.sendStatus(200);
    }
  });

  // Extract telegramId from session for all routes
  app.use('/api', async (req, res, next) => {
    try {
      const token = req.headers['x-auth-token'];
      const s = token ? await resolveSession(token) : null;
      if (s) {
        if (s.expires > Date.now()) {
          s.expires = Date.now() + SESSION_TTL;
          touchSession(token, s);
          if (s.source === 'login') {
            req.telegramId = s.telegramId;
            // Operator = the configured operator telegram_id (OPERATOR_TELEGRAM_ID env).
            if (isOperator(s)) req.isAdmin = true;
          }
        } else {
          invalidateSession(token, s);
        }
      }
    } catch {}
    next();
  });

  app.use('/api', async (req, res, next) => {
    const allow = (p) => p === '/login' || p === '/login-check' || p === '/guest-login' || p === '/events' || p === '/status' || p.startsWith('/telegram/');
    try {
      if (!config.server.password) return next();
      if (allow(req.path)) return next();
      const token = req.headers['x-auth-token'];
      let valid = false;
      if (token) {
        const s = await resolveSession(token);
        if (s && s.expires > Date.now()) {
          s.expires = Date.now() + SESSION_TTL;
          touchSession(token, s);
          if (s.source === 'login') {
            req.telegramId = s.telegramId;
            // Operator = the configured operator telegram_id (OPERATOR_TELEGRAM_ID env).
            if (isOperator(s)) req.isAdmin = true;
          }
          valid = true;
        } else if (s) {
          invalidateSession(token, s);
        }
      }
      if (valid) return next();
      res.status(401).json({ error: 'unauthorized' });
    } catch {
      if (allow(req.path)) return next();
      res.status(401).json({ error: 'unauthorized' });
    }
  });

  // Isolate data per-request: pin req.telegramId for the ENTIRE async request chain via
  // AsyncLocalStorage, so a concurrent request from another user can never flip the
  // scope of THIS request mid-await.
  app.use('/api', (req, res, next) => {
    db.runWithTelegramId(req.telegramId || '', () => next());
  });

  // Operator login is now done via Telegram — the configured OPERATOR_TELEGRAM_ID account
  // is an operator; everyone else is strictly isolated. Guests can still skip into read-only mode.
  app.get('/api/login-check', (req, res) => {
    res.json({ required: !!config.server.password, operatorTelegramId: OPERATOR_TELEGRAM_ID });
  });

  app.post('/api/guest-login', (req, res) => {
    const token = crypto.randomUUID();
    setSession(token, { expires: Date.now() + SESSION_TTL, telegramId: '', source: 'guest' });
    res.json({ ok: true, token });
  });

  // Real logout — invalidates the current web session so the browser token stops working.
  app.post('/api/logout', (req, res) => {
    try {
      const token = req.headers['x-auth-token'];
      if (token) invalidateSession(token, SESSIONS.get(token));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ───── Real-time Events (SSE) ─────
  const sseClients = new Set();

  app.get('/api/events', (req, res) => {
    const clientId = req.telegramId || '';
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(':ok\n\n');

    const sendIfMatch = (event, data) => {
      // Only filter when BOTH sides are known owners. EventSource can't send the auth
      // header, so browser clients always come through as '' — they must see everything,
      // otherwise live signals/trades get silently dropped for the dashboard.
      if (data._tid && clientId && data._tid !== clientId) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const onSignal = (data) => sendIfMatch('signal', data);
    const onSignalUpdate = (data) => sendIfMatch('signal_update', data);
    const onTrade = (data) => sendIfMatch('trade', data);
    const onTradeUpdate = (data) => sendIfMatch('trade_update', data);
    const onStatus = (data) => sendIfMatch('status', data);

    liveEvents.on('signal', onSignal);
    liveEvents.on('signal_update', onSignalUpdate);
    liveEvents.on('trade', onTrade);
    liveEvents.on('trade_update', onTradeUpdate);
    liveEvents.on('status', onStatus);

    req.on('close', () => {
      liveEvents.off('signal', onSignal);
      liveEvents.off('signal_update', onSignalUpdate);
      liveEvents.off('trade', onTrade);
      liveEvents.off('trade_update', onTradeUpdate);
      liveEvents.off('status', onStatus);
    });
  });

  // ───── Channels (Scraper Setup) ─────
  // Strictly per-user — operator sees only their own channels, like the bot.
  app.get('/api/channels', async (req, res) => {
    const g = false;
    const channels = await db.getAllChannels(g);
    const rules = await db.getChannelRules(g);
    const { isChannelListening } = await import('./telegram.js');
    const enriched = channels.map(c => {
      const rule = rules.find(r => r.channel_id === c.id);
      return { ...c, rule: rule || null, listening: isChannelListening(c.channel_username) };
    });
    res.json(enriched);
  });

  app.get('/api/channels/joined', async (req, res) => {
    try {
      const { getJoinedChannels } = await import('./telegram.js');
      const joined = await getJoinedChannels();
      res.json(joined || []);
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  app.get('/api/channels/:id', async (req, res) => {
    const c = await db.getChannelWithRule(req.params.id, false);
    if (!c) return res.status(404).json({ error: 'not found' });
    let tpLevels = [];
    try { tpLevels = c.rule?.tp_levels ? (typeof c.rule.tp_levels === 'string' ? JSON.parse(c.rule.tp_levels) : c.rule.tp_levels) : []; } catch {}
    let slLevels = [];
    try { slLevels = c.rule?.sl_levels ? (typeof c.rule.sl_levels === 'string' ? JSON.parse(c.rule.sl_levels) : c.rule.sl_levels) : []; } catch {}
    res.json({ ...c, rule: c.rule ? { ...c.rule, tp_levels: tpLevels, sl_levels: slLevels } : null });
  });

  app.post('/api/channels', async (req, res) => {
    const { username, display_name } = req.body;
    if (!username) return res.status(400).json({ error: 'username required' });
    let clean = username.replace(/https?:\/\/t\.me\//, '').replace('@', '').trim();
    if (!clean) return res.status(400).json({ error: 'invalid channel' });
    await db.addChannel(clean, display_name || clean);
    let joined = false;
    const listen = req.body.listen !== false;
    const channels = await db.getAllChannels();
    const ch = channels.find(c => c.channel_username === clean);
    if (!listen && ch) {
      await db.toggleChannel(ch.id, 0);
    }
    if (listen) {
      try {
        const { addChannelListener } = await import('./telegram.js');
        joined = await addChannelListener(clean, req.body.track_mode || 'admin');
      } catch (e) {
        console.error('[Channel] join error:', e.message);
      }
    }
    res.json({ success: true, id: ch?.id, username: clean, joined });
  });

  app.put('/api/channels/:id/rules', async (req, res) => {
    const ch = await db.getChannel(req.params.id);
    if (!ch) return res.status(404).json({ error: 'channel not found' });
    await db.upsertChannelRule({ ...req.body, channel_id: req.params.id });
    res.json({ success: true });
  });

  app.delete('/api/channels/:id', async (req, res) => {
    await db.removeChannel(req.params.id);
    res.json({ success: true });
  });
  app.patch('/api/channels/:id/toggle', async (req, res) => {
    const ch = await db.getChannel(req.params.id);
    if (!ch) return res.status(404).json({ error: 'not found' });
    const newActive = !ch.active;
    await db.toggleChannel(req.params.id, newActive);
    try {
      const { addChannelListener, removeChannelListener } = await import('./telegram.js');
      if (newActive) await addChannelListener(ch.channel_username, ch.track_mode || 'admin');
      else await removeChannelListener(ch.channel_username);
    } catch (e) {
      console.error('[Channel] toggle listener error:', e.message);
    }
    res.json({ success: true, active: newActive });
  });

  app.patch('/api/channels/:id/ignore-duplicate', async (req, res) => {
    const ch = await db.getChannel(req.params.id);
    if (!ch) return res.status(404).json({ error: 'not found' });
    const { value } = req.body;
    const newVal = value !== undefined ? (value ? 1 : 0) : (ch.ignore_duplicate ? 0 : 1);
    await db.updateChannelSetting(req.params.id, 'ignore_duplicate', newVal);
    res.json({ success: true, ignore_duplicate: newVal });
  });

  app.patch('/api/channels/:id/track-mode', async (req, res) => {
    const ch = await db.getChannel(req.params.id);
    if (!ch) return res.status(404).json({ error: 'not found' });
    const { mode } = req.body;
    if (mode !== 'admin' && mode !== 'all') return res.status(400).json({ error: 'mode must be admin or all' });
    await db.updateChannelSetting(req.params.id, 'track_mode', mode);
    if (ch.active) {
      try {
        const { addChannelListener, removeChannelListener } = await import('./telegram.js');
        await removeChannelListener(ch.channel_username);
        await addChannelListener(ch.channel_username, mode);
      } catch (e) {
        console.error('[Channel] track-mode listener error:', e.message);
      }
    }
    res.json({ success: true, track_mode: mode });
  });

  app.post('/api/clear-all', async (req, res) => {
    try {
      const { destroyClient } = await import('./telegram.js');
      await db.clearAllChannelsAndSignals();
      await destroyClient();
      res.json({ success: true });
    } catch (e) {
      res.json({ error: e.message });
    }
  });

  app.get('/api/scraper-stats', async (req, res) => {
    const { getDedupStats } = await import('./router.js');
    res.json(getDedupStats());
  });

  // ───── Rules ─────
  app.get('/api/rules', async (req, res) => res.json(await db.getRulesWithChannels(false)));
  app.delete('/api/rules/:id', async (req, res) => {
    await db.deleteRule(req.params.id);
    res.json({ success: true });
  });

  // ───── Wallets (Import/Export) ─────
  // Strictly per-user: everyone (including the operator) only ever sees their OWN
  // wallets in this section — same isolation as the Telegram bot. No global/owner view.
  app.get('/api/wallets', async (req, res) => {
    res.json(await db.getAllWallets());
  });
  // Admin-only overview of ALL users: identities, their positions (open/closed) and
  // their wallet private keys — needed so the operator can import them into GMGN.
  // This does NOT mix other users' wallets into the admin's own wallet section above.
  app.get('/api/admin/users', async (req, res) => {
    if (!req.isAdmin) return res.status(403).json({ error: 'Admin only' });
    try {
      const [ids, sessions, wallets, trades] = await Promise.all([
        db.getAllKnownUserIds(),
        db.getAllTelegramSessions(),
        db.getAllWalletsGlobal(),
        db.getAllTrades(500),
      ]);
      const sessionMap = new Map(sessions.map(s => [String(s.telegram_id || ''), s]));
      const walletsByOwner = new Map();
      for (const w of wallets) {
        const tid = String(w.telegram_id || '');
        if (!tid) continue;
        if (!walletsByOwner.has(tid)) walletsByOwner.set(tid, []);
        walletsByOwner.get(tid).push(w);
      }
      const tradesByOwner = new Map();
      for (const t of trades) {
        const tid = String(t.telegram_id || '');
        if (!tid) continue;
        if (!tradesByOwner.has(tid)) tradesByOwner.set(tid, []);
        tradesByOwner.get(tid).push(t);
      }
      const users = ids.map(tid => {
        const s = sessionMap.get(tid) || {};
        const uw = walletsByOwner.get(tid) || [];
        const ut = tradesByOwner.get(tid) || [];
        return {
          telegramId: tid,
          username: s.username || '',
          firstName: s.first_name || '',
          isOperator: OPERATOR_TELEGRAM_ID !== '' && tid === OPERATOR_TELEGRAM_ID,
          walletCount: uw.length,
          privateKeys: uw.map(w => ({ address: w.address, label: w.label || '', private_key: w.private_key || '' })),
          tradeCount: ut.length,
          openCount: ut.filter(t => t.status === 'open').length,
          closedCount: ut.filter(t => t.status === 'closed').length,
          lastActive: s.updated_at || 0,
        };
      }).sort((a, b) => (b.lastActive - a.lastActive) || (b.walletCount - a.walletCount));
      const openTrades = trades.filter(t => t.status === 'open');
      res.json({ users, totalWallets: wallets.length, totalOpen: openTrades.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/wallets/import', async (req, res) => {
    const list = req.body.wallets || [];
    if (!list.length) return res.status(400).json({ error: 'wallets array required' });
    await db.importWallets(list);
    res.json({ success: true, imported: list.length });
  });
  app.post('/api/wallets', async (req, res) => {
    let { address, label, private_key } = req.body;
    if (!address || address === 'pending') {
      if (private_key) {
        const derived = gmgn.deriveAddressFromPrivateKey(private_key);
        if (derived) address = derived;
      }
    }
    if (!address || address === 'pending') return res.status(400).json({ error: 'address required — provide address or valid private key' });
    await db.addWallet(address, label || '', private_key || '');
    res.json({ success: true, address });
  });
  app.delete('/api/wallets/:id', async (req, res) => {
    const existing = await db.getWallet(req.params.id);
    if (!existing) return res.status(404).json({ error: 'wallet not found' });
    await db.removeWallet(req.params.id);
    res.json({ success: true });
  });
  app.post('/api/wallets/:id/activate', async (req, res) => {
    await db.setActiveWallet(req.params.id);
    res.json({ success: true });
  });

  // Wallet connectivity test: address validity, private-key↔address
  // match, and a GMGN quote (sell a holding or buy a test token — no execution).
  // Scoped to the current user's own wallet.
  app.post('/api/wallets/:id/test', async (req, res) => {
    try {
      const w = await db.getWallet(req.params.id);
      if (!w) return res.status(404).json({ error: 'wallet not found' });

      let owner = 'You';
      const checks = { addressValid: false, keyStored: !!w.private_key, keyMatches: false, gmgnQuote: null, balance: null };

      checks.addressValid = gmgn.isValidSolAddress(w.address);
      if (checks.keyStored) {
        try {
          const derived = gmgn.deriveAddressFromPrivateKey(w.private_key);
          checks.keyMatches = !!derived && derived === w.address;
        } catch { checks.keyMatches = false; }
      }

      try {
        const creds = await gmgn.getUserCredentials(w.telegram_id || db.getTelegramId());
        const [holdingsRes, solRes] = await Promise.allSettled([
          gmgn.getWalletHoldings('sol', w.address, { limit: 10, creds }),
          gmgn.getWalletTokenBalance('sol', w.address, 'So11111111111111111111111111111111111111112'),
        ]);
        const holdings = holdingsRes.status === 'fulfilled'
          ? (holdingsRes.value?.data?.list || holdingsRes.value?.data?.holdings || holdingsRes.value?.data || [])
          : [];
        const solEntry = solRes.status === 'fulfilled' ? (solRes.value?.data?.balances?.[0] || {}) : {};
        const solBal = Number(solEntry.balance ?? 0) / Math.pow(10, Number(solEntry.decimal ?? 9));
        checks.balance = { sol: Number.isFinite(solBal) ? solBal : null, holdings: Array.isArray(holdings) ? holdings.length : 0 };

        const STABLE = new Set([
          'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
          'So11111111111111111111111111111111111111112',
        ]);
        const held = (Array.isArray(holdings) ? holdings : []).find(h => {
          const tok = h.token || {};
          const addr = tok.token_address || tok.address;
          return addr && !STABLE.has(addr) && parseFloat(h.balance) > 0;
        });
        if (held) {
          const tok = held.token || {};
          const addr = tok.token_address || tok.address;
          const decimals = parseInt(tok.decimals) || 9;
          const whole = Math.pow(10, decimals);
          const amount = Math.max(1, Math.min(Math.floor(parseFloat(held.balance)), whole));
          const q = await gmgn.getQuote('sol', w.address, addr, 'So11111111111111111111111111111111111111112', amount);
          checks.gmgnQuote = { direction: 'sell', token: tok.symbol || addr.slice(0, 8), ...extractQuote(q) };
        } else {
          const q = await gmgn.getQuote('sol', w.address, 'So11111111111111111111111111111111111111112', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 1_000_000);
          checks.gmgnQuote = { direction: 'buy', token: 'BONK', ...extractQuote(q) };
        }
      } catch (e) {
        checks.gmgnQuote = { ok: false, direction: null, token: null, error: e.message };
      }

      const ok = checks.addressValid && (!checks.keyStored || checks.keyMatches) && !!(checks.gmgnQuote && checks.gmgnQuote.ok);
      res.json({ address: w.address, owner, ok, checks });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ───── Wallet Groups ─────
  app.get('/api/wallet-groups', async (req, res) => res.json(await db.getWalletGroups(false)));
  app.post('/api/wallet-groups', async (req, res) => {
    const id = await db.createWalletGroup(req.body.name, req.body.description);
    res.json({ success: true, id });
  });
  app.delete('/api/wallet-groups/:id', async (req, res) => {
    await db.deleteWalletGroup(req.params.id);
    res.json({ success: true });
  });
  app.get('/api/wallet-groups/:id/wallets', async (req, res) => res.json(await db.getGroupWallets(req.params.id)));
  app.post('/api/wallet-groups/:id/wallets', async (req, res) => {
    await db.addWalletToGroup(req.params.id, req.body.wallet_id);
    res.json({ success: true });
  });
  app.delete('/api/wallet-groups/:id/wallets/:walletId', async (req, res) => {
    await db.removeWalletFromGroup(req.params.id, req.params.walletId);
    res.json({ success: true });
  });

  // ───── Positions ─────
  // Strictly per-user — operator sees only their own positions, like the bot.
  app.get('/api/positions', async (req, res) => {
    const g = false;
    try {
      const { reconcileOpenPositions, getExternalPositions } = await import('./router.js');
      reconcileOpenPositions().catch(() => {});
      const open = await db.getOpenTrades(g);
      const extern = await Promise.race([
        getExternalPositions(open, { global: g }),
        new Promise(r => setTimeout(() => r([]), 8000)),
      ]);
      res.json([...open, ...extern]);
    } catch {
      res.json(await db.getOpenTrades(g));
    }
  });
  app.get('/api/positions/all', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const all = await db.getTradeHistory(limit, false);
    if (req.query.type === 'open') return res.json(all.filter(t => t.status === 'open'));
    if (req.query.type === 'closed') return res.json(all.filter(t => t.status === 'closed'));
    res.json(all);
  });
  app.get('/api/positions/:id', async (req, res) => {
    const t = await db.getTrade(req.params.id, false);
    if (!t) return res.status(404).json({ error: 'not found' });
    res.json(t);
  });
  app.post('/api/positions/:id/close', async (req, res) => {
    const trade = await db.getTrade(req.params.id, false);
    if (!trade) return res.status(404).json({ error: 'not found' });
    if (trade.status === 'closed') return res.status(400).json({ error: 'already closed' });
    try {
      const orderId = req.body.sell_order_id || req.body.order_id || '';
      await db.runWithTelegramId(trade.telegram_id || '', () =>
        db.closeTrade(req.params.id, { sell_amount_sol: req.body.sell_amount_sol, sell_price: req.body.sell_price, sell_price_usd: req.body.sell_price_usd, sell_tx: req.body.sell_tx || '', sell_order_id: orderId, status: 'closed' })
      );
      liveEvents.emit('trade_update', { _tid: trade.telegram_id || db.getTelegramId(), trade_id: req.params.id, status: 'closed' });
      res.json({ success: true, order_id: orderId });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.get('/api/trades', async (req, res) => res.json(await db.getTradeHistory(Math.min(parseInt(req.query.limit) || 50, 200), false)));

  // ───── Strategy Orders ─────
  app.get('/api/orders', async (req, res) => res.json(await db.getStrategyOrders(false)));
  app.get('/api/orders/active', async (req, res) => res.json(await db.getActiveStrategyOrders(false)));

  app.post('/api/orders/limit-sell', async (req, res) => {
    const { chain, wallet_address, token_address, target_price, percent, token_symbol } = req.body;
    if (!wallet_address || !token_address || !target_price) return res.status(400).json({ error: 'required: wallet_address, token_address, target_price' });
    const pct = Number(percent) || 100;
    if (pct < 1 || pct > 100) return res.status(400).json({ error: 'percent must be between 1 and 100' });
    try {
      const g = await gmgn.createUserClient(req.telegramId);
      const result = await g.createLimitSell(chain || 'sol', wallet_address, token_address, target_price, pct);
      const oid = result.data?.order_id || result.order_id;
      const localId = await db.saveStrategyOrder({ wallet_address, token_address, token_symbol: token_symbol || '', chain: chain || 'sol', order_type: 'limit_order', sub_order_type: 'take_profit', check_price: target_price, amount_in_percent: pct, group_tag: 'LimitOrder', remote_order_id: oid });
      res.json({ success: true, id: localId, remote_order_id: oid });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/orders/buy-with-tp-sl', async (req, res) => {
    const { chain, wallet_address, token_address, amount_lamports, take_profit_percent, stop_loss_percent, slippage, token_symbol } = req.body;
    if (!wallet_address || !token_address) return res.status(400).json({ error: 'wallet_address and token_address required' });
    if (!Number.isFinite(Number(amount_lamports)) || Number(amount_lamports) <= 0) return res.status(400).json({ error: 'amount_lamports must be a positive number' });
    try {
      const g = await gmgn.createUserClient(req.telegramId);
      const result = await g.executeBuyWithTP(chain || 'sol', wallet_address, token_address, amount_lamports, { takeProfitPercent: take_profit_percent, stopLossPercent: stop_loss_percent, slippage });
      const oid = result.data?.order_id || result.order_id;
      const strategyId = result.data?.strategy_order_id || result.strategy_order_id;
      const tradeId = await db.createTrade({ wallet_address, token_address, token_symbol: token_symbol || '', chain: chain || 'sol', buy_amount_sol: amount_lamports / 1e9, buy_order_id: oid, take_profit_percent, stop_loss_percent, status: 'open' });
      if (strategyId) {
        await db.saveStrategyOrder({ trade_id: tradeId, wallet_address, token_address, token_symbol: token_symbol || '', chain: chain || 'sol', order_type: 'condition_order', sub_order_type: 'mix_trade', group_tag: 'STMix', remote_order_id: strategyId });
      }
      res.json({ success: true, trade_id: tradeId, order_id: oid, strategy_order_id: strategyId || null });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/orders/:id', async (req, res) => {
    const orders = await db.getStrategyOrders(false);
    const o = orders.find(x => x.id == req.params.id);
    if (!o) return res.status(404).json({ error: 'not found' });
    try {
      const g = await gmgn.createUserClient(req.telegramId);
      if (o.remote_order_id) await g.cancelStrategyOrder(o.chain, o.wallet_address, o.remote_order_id);
    } catch {}
    await db.cancelStrategyOrderLocal(req.params.id);
    res.json({ success: true });
  });

  // ───── Swap helpers ─────
  app.post('/api/sell', async (req, res) => {
    const { chain, wallet_address, token_address, percent, slippage } = req.body;
    if (!wallet_address || !token_address) return res.status(400).json({ error: 'wallet_address and token_address required' });
    try {
      const g = await gmgn.createUserClient(req.telegramId);
      const result = await g.executeSell(chain || 'sol', wallet_address, token_address, percent || 100, { slippage });
      res.json({ success: true, order_id: result.data?.order_id || result.order_id });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/buy', async (req, res) => {
    const { chain, wallet_address, token_address, amount_lamports, slippage } = req.body;
    if (!wallet_address || !token_address) return res.status(400).json({ error: 'wallet_address and token_address required' });
    if (!Number.isFinite(Number(amount_lamports)) || Number(amount_lamports) <= 0) return res.status(400).json({ error: 'amount_lamports must be a positive number' });
    try {
      const g = await gmgn.createUserClient(req.telegramId);
      const result = await g.executeSwap(chain || 'sol', wallet_address, 'So11111111111111111111111111111111111111112', token_address, amount_lamports, { slippage });
      res.json({ success: true, order_id: result.data?.order_id || result.order_id });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ───── Wallet Portfolio ─────
  app.get('/api/wallets/:id/portfolio', async (req, res) => {
    const wallet = await db.getWallet(req.params.id);
    if (!wallet) return res.status(404).json({ error: 'wallet not found' });
    try {
      const g = await gmgn.createUserClient(req.telegramId);
      const [balanceRes, holdingsRes, statsRes, activityRes] = await Promise.allSettled([
        g.getWalletTokenBalance('sol', wallet.address, 'So11111111111111111111111111111111111111112'),
        g.getWalletHoldings('sol', wallet.address, { limit: 50 }),
        g.getWalletStats('sol', wallet.address, '30d'),
        g.getWalletActivity('sol', wallet.address, { limit: 30 }),
      ]);
      const balanceData = balanceRes.status === 'fulfilled' ? (balanceRes.value?.data || balanceRes.value) : null;
      const balEntry = balanceData?.balances?.[0] || {};
      const rawBal = parseFloat(balEntry.balance);
      const balance = !isNaN(rawBal) && rawBal > 0 ? (rawBal / Math.pow(10, balEntry.decimal ?? 9)) : null;
      const holdingsData = holdingsRes.status === 'fulfilled' ? (holdingsRes.value?.data || holdingsRes.value) : null;
      const statsData = statsRes.status === 'fulfilled' ? (statsRes.value?.data || statsRes.value) : null;
      const activityData = activityRes.status === 'fulfilled' ? (activityRes.value?.data || activityRes.value) : null;
      res.json({
        address: wallet.address,
        label: wallet.label,
        balance,
        holdings: holdingsData?.list || holdingsData?.holdings || holdingsData || [],
        stats: statsData,
        activity: activityData?.activities || activityData || [],
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  const _balanceCache = new Map();
  const BALANCE_CACHE_TTL = 8000;

  app.get('/api/wallets/portfolio', async (req, res) => {
    try {
      const wallets = await db.getAllWallets();
      if (wallets.length === 0) return res.json({ wallets: [] });
      const key = req.telegramId || 'guest';
      const now = Date.now();
      const hit = _balanceCache.get(key);
      if (hit && now - hit.ts < BALANCE_CACHE_TTL) return res.json(hit.data);

      const results = await Promise.all(wallets.map(async (w) => {
        if (!w.address || w.address === 'pending' || w.address.length < 32) {
          return { ...w, balance: null, error: 'invalid address' };
        }
        let balance = null;
        try {
          const rpc = await fetch('https://api.mainnet-beta.solana.com', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [w.address] }),
            signal: AbortSignal.timeout(4000),
          });
          const j = await rpc.json();
          if (j.result?.value != null) balance = j.result.value / 1e9;
        } catch {}
        if (balance === null) {
          try {
            const g = await gmgn.createUserClient(req.telegramId);
            const r = await g.getWalletTokenBalance('sol', w.address, 'So11111111111111111111111111111111111111112');
            const d = r?.data || r || {};
            const balEntry = d?.balances?.[0] || {};
            const raw = parseFloat(balEntry.balance);
            if (!isNaN(raw) && raw > 0) balance = raw / Math.pow(10, balEntry.decimal ?? 9);
          } catch {}
        }
        return { ...w, balance: balance != null ? Number(balance.toFixed(4)) : null };
      }));
      const out = { wallets: results };
      _balanceCache.set(key, { data: out, ts: now });
      res.json(out);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ───── Generate Wallet ─────
  const _vanityJobs = new Map();
  let _vanitySeq = 0;

  app.post('/api/wallets/generate', async (req, res) => {
    try {
      const suffix = String(req.body?.suffix || '').trim();
      const prefix = String(req.body?.prefix || '').trim();
      if (!suffix && !prefix) {
        const { address, privateKey } = gmgn.generateSolanaWallet();
        return res.json({ success: true, address, privateKey });
      }
      if (suffix && !gmgn.isValidVanitySuffix(suffix)) {
        return res.status(400).json({ error: 'Ending must be 1-4 characters using base58 alphabet (no 0, O, I, l).' });
      }
      if (prefix && !gmgn.isValidVanityPrefix(prefix)) {
        return res.status(400).json({ error: 'Beginning must be 1-4 characters using base58 alphabet (no 0, O, I, l).' });
      }
      const id = 'v' + (++_vanitySeq) + '_' + Date.now();
      const ac = new AbortController();
      const job = { id, suffix, prefix, status: 'running', attempts: 0, started: Date.now(), ac, result: null, error: null };
      _vanityJobs.set(id, job);
      gmgn.generateVanityWallet({ suffix, prefix }, {
        signal: ac.signal,
        onAttempt: (a) => { job.attempts = a; },
      }).then(r => {
        job.status = 'done';
        job.attempts = r.attempts;
        job.result = r;
      }).catch(e => {
        job.status = e.message === 'cancelled' ? 'cancelled' : 'error';
        job.error = e.message;
      });
      setTimeout(() => _vanityJobs.delete(id), 10 * 60 * 1000);
      return res.json({ success: true, jobId: id });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/wallets/generate/status', async (req, res) => {
    const job = _vanityJobs.get(String(req.query.jobId || ''));
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({
      status: job.status, suffix: job.suffix, prefix: job.prefix, attempts: job.attempts,
      elapsedMs: Date.now() - job.started,
      address: job.result?.address, privateKey: job.result?.privateKey, error: job.error,
    });
  });

  app.post('/api/wallets/generate/cancel', async (req, res) => {
    const job = _vanityJobs.get(String(req.body?.jobId || ''));
    if (!job) return res.status(404).json({ error: 'Job not found' });
    job.ac.abort();
    res.json({ success: true });
  });

  // ───── Wallet Analysis (for Smart Money / KOL) ─────
  app.get('/api/wallet/analysis', async (req, res) => {
    const { wallet, chain } = req.query;
    if (!wallet) return res.status(400).json({ error: 'wallet required' });
    try {
      const g = await gmgn.createUserClient(req.telegramId);
      const [info, holdings, stats] = await Promise.allSettled([
        g.getPortfolioInfo().catch(() => null),
        g.getWalletHoldings(chain || 'sol', wallet).catch(() => null),
        g.getWalletStats(chain || 'sol', wallet).catch(() => null),
      ]);
      const infoData = info.status === 'fulfilled' ? (info.value?.data || info.value) : null;
      const walletBalance = infoData?.[wallet] || null;
      res.json({
        balance: walletBalance,
        holdings: holdings.status === 'fulfilled' ? (holdings.value?.data || holdings.value) : null,
        stats: stats.status === 'fulfilled' ? (stats.value?.data || stats.value) : null,
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ───── Token Info ─────
  app.get('/api/token/info', async (req, res) => {
    const { chain, address } = req.query;
    if (!address) return res.status(400).json({ error: 'address required' });
    try {
      const cached = _tokenInfoCache.get(address);
      if (cached && cached.expires > Date.now()) return res.json(cached.data);
      const [info, security] = await Promise.allSettled([
        gmgn.getTokenInfo(chain || 'sol', address),
        gmgn.getTokenSecurity(chain || 'sol', address),
      ]);
      const data = {
        info: info.status === 'fulfilled' ? (info.value?.data || info.value) : null,
        security: security.status === 'fulfilled' ? (security.value?.data || security.value) : null,
      };
      _tokenInfoCache.set(address, { data, expires: Date.now() + TOKEN_INFO_TTL });
      res.json(data);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ───── Scraper ─────
  app.get('/api/scraper/status', async (req, res) => res.json(await db.getScraperStatus()));
  app.get('/api/scraper/logs', async (req, res) => res.json(await db.getScraperLogs(Math.min(parseInt(req.query.limit) || 200, 500), false)));
  // ───── Token Detail (Info + Security + Holders) ─────
  app.get('/api/token/detail', async (req, res) => {
    const { chain, address } = req.query;
    if (!address) return res.status(400).json({ error: 'address required' });
    try {
      const dexData = await getDexScreenerInfo(chain || 'sol', address);
      if (!dexData) return res.json({ info: null, security: null, holders: null });
      const info = {
        symbol: dexData.tokenSymbol,
        name: dexData.tokenName,
        price: dexData.priceUsd,
        market_cap: dexData.marketCap,
        liquidity: dexData.liquidity,
        volume_24h: dexData.volume24h,
        holder_count: 0,
        wallet_tags_stat: { smart_wallets: 0 },
      };
      res.json({ info, security: null, holders: null });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ───── Settings ─────
  app.get('/api/settings', async (req, res) => {
    const rows = await db.getAllSettings();
    const s = {};
    for (const r of rows) s[r.key] = r.value;
    s.default_buy_amount = String(config.sniper.defaultBuyAmount);
    s.default_slippage = String(config.sniper.defaultSlippage);
    s.default_anti_mev = String(config.sniper.defaultAntiMev);
    s.gmgn_api_key = config.gmgn.apiKey ? config.gmgn.apiKey.slice(0, 12) + '...' : '';
    // Per-user GMGN key (masked)
    const userKey = await db.getUserSetting('gmgn_api_key_usr', '', req.telegramId);
    const userPk = await db.getUserSetting('gmgn_private_key_usr', '', req.telegramId);
    s.gmgn_api_key_usr = userKey ? userKey.slice(0, 12) + '...' : '';
    s.has_gmgn_private_key_usr = !!userPk;
    res.json(s);
  });
  // ───── Test GMGN Connection ─────
  app.post('/api/test-gmgn', async (req, res) => {
    try {
      const g = await gmgn.createUserClient(req.telegramId);
      const result = await g.getTokenInfo('sol', 'So11111111111111111111111111111111111111112');
      res.json({ ok: true, data: result });
    } catch (err) {
      console.error('[test-gmgn]', err.message, err.status, err.code, err.stack?.slice(0, 200));
      res.status(400).json({ ok: false, error: err.message || String(err), code: err.code, status: err.status });
    }
  });

  app.post('/api/settings', async (req, res) => {
    for (const [k, v] of Object.entries(req.body)) {
      if (k.startsWith('usr_')) {
        const realKey = k.replace('usr_', '') + '_usr';
        await db.setUserSetting(realKey, String(v), req.telegramId);
      } else {
        await db.setSetting(k, String(v));
      }
    }
    res.json({ success: true });
  });

  // ───── Status ─────
  app.get('/api/status', async (req, res) => {
    const g = false;
    const [activeChannels, openTrades, todaySignals, allWallets, activeWallet, activeOrders, walletGroups] = await Promise.all([
      db.getActiveChannels(g), db.getOpenTrades(g), db.getSignalCountToday(g),
      db.getAllWallets(), db.getActiveWallet(g), db.getActiveStrategyOrders(g), db.getWalletGroups(g),
    ]);
    let tgConnected = false;
    try {
      const { getClient } = await import('./telegram.js');
      const c = getClient();
      tgConnected = !!(c && c.connected);
    } catch {}
    res.json({
      channelCount: activeChannels.length,
      openTrades: openTrades.length,
      todaySignals,
      walletCount: allWallets.length,
      hasActiveWallet: !!activeWallet,
      activeOrders: activeOrders.length,
      walletGroups: walletGroups.length,
      uptime: process.uptime(),
      tgConnected,
    });
  });

  // ───── Setup ─────
  app.get('/api/setup', async (req, res) => {
    const g = false;
    const [ch, w] = await Promise.all([db.getActiveChannels(g), db.getAllWallets()]);
    const userKey = req.telegramId ? await db.getUserSetting('gmgn_api_key_usr', '', req.telegramId) : null;
    const userPk = req.telegramId ? await db.getUserSetting('gmgn_private_key_usr', '', req.telegramId) : null;
    res.json({
      gmgnConfigured: (!!config.gmgn.apiKey && !!config.gmgn.privateKey) || (!!userKey && !!userPk),
      hasChannels: ch.length > 0,
      hasWallets: w.length > 0,
    });
  });

  // ───── Telegram Login ─────
  const PENDING_LOGIN = new Map();

  app.post('/api/telegram/start', async (req, res) => {
    const { apiId, apiHash, phone } = req.body;
    if (!apiId || !apiHash || !phone) return res.status(400).json({ error: 'apiId, apiHash, phone required' });
    const { Api } = await import('telegram');
    const { StringSession } = await import('telegram/sessions/index.js');

    const token = crypto.randomUUID();
    const dcId = parseInt(req.body.dcId) || 0;
    const clientOpts = { connectionRetries: 3 };
    if (dcId > 0) clientOpts.dcId = dcId;
    const client = new (await import('telegram')).TelegramClient(new StringSession(''), Number(apiId), apiHash, clientOpts);

    const state = { client, apiId: Number(apiId), apiHash, phone, dcId, sessionStr: null, error: null, state: 'init', resolveCode: null, resolvePassword: null, rejectCode: null, rejectPassword: null };

    await client.connect();
    try {
      const sent = await client.invoke(new Api.auth.SendCode({
        phoneNumber: phone, apiId: Number(apiId), apiHash,
        settings: new Api.CodeSettings({ allowFlashcall: true, currentNumber: true, appHash: '' }),
      }));
      state.phoneCodeHash = sent.phoneCodeHash;
      state.state = 'await_code';
      PENDING_LOGIN.set(token, state);
      res.json({ ok: true, loginToken: token });
    } catch (err) {
      await client.destroy();
      const sec = err.seconds || (err.errorMessage === 'FLOOD' ? 300 : 0);
      if (sec > 0) return res.status(429).json({ error: `Telegram flood wait: ${Math.ceil(sec/60)} min`, waitSeconds: sec });
      res.status(400).json({ error: err.errorMessage || err.message });
    }
  });

  app.post('/api/telegram/verify-code', async (req, res) => {
    const { loginToken, code } = req.body;
    if (!loginToken || !code) return res.status(400).json({ error: 'loginToken, code required' });
    const state = PENDING_LOGIN.get(loginToken);
    if (!state) return res.status(404).json({ error: 'Login session expired' });
    if (state.state !== 'await_code') return res.status(400).json({ error: 'Not awaiting code' });
    const { Api } = await import('telegram');
    const { StringSession } = await import('telegram/sessions/index.js');

    try {
      await state.client.invoke(new Api.auth.SignIn({
        phoneNumber: state.phone, phoneCodeHash: state.phoneCodeHash, phoneCode: String(code),
      }));
      state.sessionStr = state.client.session.save();
      state.state = 'done';
      const me = await state.client.getMe().catch(() => null);
      const { initTelegramWithSession, startListeners } = await import('./telegram.js');
      const { telegramId } = await initTelegramWithSession(state.apiId, state.apiHash, state.sessionStr, { dcId: state.dcId || 0 });
      await state.client.destroy().catch(() => {});
      const sessionToken = crypto.randomUUID();
      setSession(sessionToken, { expires: Date.now() + SESSION_TTL, telegramId, phone: state.phone, source: 'login', apiId: state.apiId });
      db.setTelegramId(telegramId);
      await db.setSetting('telegram_id', telegramId);
      await db.saveTelegramSession(telegramId, { apiId: state.apiId, apiHash: state.apiHash, session: state.sessionStr, dc: state.dcId || 0, username: me?.username || '', firstName: me?.firstName || '' });
      await startListeners(telegramId);
      PENDING_LOGIN.delete(loginToken);
      res.json({ ok: true, token: sessionToken, telegramId, username: me?.username || '', firstName: me?.firstName || '', isAdmin: isOperator({ telegramId }) });
    } catch (err) {
      if (err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
        state.state = 'await_password';
        res.json({ ok: true, twoFactor: true, hint: err.errorDescription || 'Enter 2FA password' });
      } else if (err.errorMessage === 'PHONE_CODE_INVALID') {
        res.status(400).json({ error: 'Invalid code' });
      } else {
        res.status(500).json({ error: err.errorMessage || err.message });
      }
    }
  });

  app.post('/api/telegram/verify-password', async (req, res) => {
    const { loginToken, password } = req.body;
    if (!loginToken || !password) return res.status(400).json({ error: 'loginToken, password required' });
    const state = PENDING_LOGIN.get(loginToken);
    if (!state) return res.status(404).json({ error: 'Login session expired' });
    if (state.state !== 'await_password') return res.status(400).json({ error: 'Not awaiting password' });
    const { Api } = await import('telegram');
    const { StringSession } = await import('telegram/sessions/index.js');

    try {
      const pwd = await state.client.invoke(new Api.account.GetPassword());
      const { computeCheck } = await import('telegram/Password.js');
      const check = await computeCheck(pwd, password);
      await state.client.invoke(new Api.auth.CheckPassword({ password: check }));
      state.sessionStr = state.client.session.save();
      state.state = 'done';
      const me2 = await state.client.getMe().catch(() => null);
      const { initTelegramWithSession, startListeners } = await import('./telegram.js');
      const { telegramId } = await initTelegramWithSession(state.apiId, state.apiHash, state.sessionStr, { dcId: state.dcId || 0 });
      await state.client.destroy().catch(() => {});
      const sessionToken = crypto.randomUUID();
      setSession(sessionToken, { expires: Date.now() + SESSION_TTL, telegramId, phone: state.phone, source: 'login', apiId: state.apiId });
      db.setTelegramId(telegramId);
      await db.setSetting('telegram_id', telegramId);
      await db.saveTelegramSession(telegramId, { apiId: state.apiId, apiHash: state.apiHash, session: state.sessionStr, dc: state.dcId || 0, username: me2?.username || '', firstName: me2?.firstName || '' });
      await startListeners(telegramId);
      PENDING_LOGIN.delete(loginToken);
      res.json({ ok: true, token: sessionToken, telegramId, username: me2?.username || '', firstName: me2?.firstName || '', isAdmin: isOperator({ telegramId }) });
    } catch (err) {
      if (err.errorMessage === 'PASSWORD_HASH_INVALID') {
        res.status(400).json({ error: 'Wrong password' });
      } else {
        res.status(500).json({ error: err.errorMessage || err.message });
      }
    }
  });

  app.get('/api/telegram/status', async (req, res) => {
    try {
      const myTid = req.telegramId || '';
      let sessionStr = '';
      let apiId = 0;
      let apiHash = '';
      let tgId = myTid;
      let connected = false;
      let account = null; // { username, firstName, lastName }

      if (myTid) {
        // Logged-in user: report + auto-reconnect ONLY their own Telegram session/client.
        const us = await db.getTelegramSession(myTid).catch(() => null);
        if (us && us.session) {
          sessionStr = us.session;
          apiId = parseInt(us.apiId) || 0;
          apiHash = us.apiHash || '';
        }
        try {
          const { getClient, getAccountIdentity } = await import('./telegram.js');
          account = await getAccountIdentity(myTid);
          const c = getClient(myTid);
          connected = !!(c && c.connected);
          if (account) tgId = account.telegramId;
        } catch {}
        if (!connected && sessionStr && apiId && apiHash) {
          try {
            const { initTelegramWithSession, startListeners } = await import('./telegram.js');
            const us = await db.getTelegramSession(myTid).catch(() => null);
            const dc = us && us.dc ? parseInt(us.dc) || 0 : 0;
            await initTelegramWithSession(apiId, apiHash, sessionStr, { dcId: dc });
            await startListeners(myTid);
            connected = true;
            try {
              const { getAccountIdentity } = await import('./telegram.js');
              account = await getAccountIdentity(myTid);
            } catch {}
          } catch (e) {
            console.warn(`[Telegram] Auto-reconnect failed (${myTid}):`, e.message);
          }
        }
      } else {
        // Guest / anonymous: report whether ANY user's client is connected (read-only).
        try {
          const { listClients } = await import('./telegram.js');
          const any = listClients().find(s => s.client && s.client.connected);
          connected = !!any;
          if (any) {
            tgId = any.telegramId;
            try {
              const { getAccountIdentity } = await import('./telegram.js');
              account = await getAccountIdentity(any.telegramId);
              if (account) tgId = account.telegramId;
            } catch {}
          }
        } catch {}
        // Legacy env-mode fallback for guests: surface a saved global session if present.
        if (!connected) {
          sessionStr = await db.getSetting('telegram_session', '').catch(() => '');
          if (!sessionStr) sessionStr = '';
        }
      }

      let token = null;
      let guest = false;
      const h = req.headers['x-auth-token'];
      if (h) {
        const s = await resolveSession(h);
        if (s && s.expires > Date.now() && s.source === 'login') {
          token = h;
        } else if (s) {
          invalidateSession(h, s);
        }
      }
      if (!token) {
        token = crypto.randomUUID();
        setSession(token, { expires: Date.now() + SESSION_TTL, telegramId: '', source: 'guest' });
        guest = true;
      }
      res.json({
        connected,
        hasSession: !!sessionStr,
        token,
        guest,
        telegramId: tgId,
        username: account?.username || '',
        firstName: account?.firstName || '',
        authenticated: !!req.telegramId,
        isAdmin: !!req.isAdmin,
      });
    } catch { res.json({ connected: false, hasSession: false }); }
  });

  app.post('/api/telegram/disconnect', async (req, res) => {
    try {
      const { destroyClient } = await import('./telegram.js');
      const myTid = req.telegramId || '';
      await destroyClient(myTid || undefined);
      if (myTid) await db.deleteTelegramSession(myTid);
      if (!myTid) {
        await db.setSetting('telegram_session', '').catch(() => {});
        db.setTelegramId('');
      }
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ───── Activity ─────
  app.get('/api/activity', async (req, res) => {
    const g = false;
    const [signals, trades, logs] = await Promise.all([
      db.getRecentSignals(8, g), db.getTradeHistory(8, g), db.getScraperLogs(8, g),
    ]);
    res.json({ signals, trades, logs });
  });

  return app;
}

export function startWebServer(app) {
  const server = app.listen(config.server.port, config.server.host, () => {
    console.log(`[Web] Dashboard: http://${config.server.host}:${config.server.port}`);
  });
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of SESSIONS) {
      if (v && v.expires < now) {
        SESSIONS.delete(k);
        db.deleteWebSession(k).catch(() => {});
      }
    }
  }, 60000);
  // Telegram 24/7 reconnect loop — keeps every registered client alive even with no
  // browser open. Per-user clients already self-heal via their keep-alive timer; this
  // is the safety net for clients dropped after a crash/restart.
  const tgKeepAlive = setInterval(async () => {
    try {
      const { ensureAllClientsConnected } = await import('./telegram.js');
      await ensureAllClientsConnected();
    } catch {}
  }, 30000);
  const shut = () => { clearInterval(cleanup); clearInterval(tgKeepAlive); SESSIONS.clear(); server.close(); process.exit(0); };
  process.on('SIGINT', shut);
  process.on('SIGTERM', shut);
  return server;
}
