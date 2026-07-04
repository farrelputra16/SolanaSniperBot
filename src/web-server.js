import express from 'express';
import { join } from 'path';
import { fileURLToPath } from 'url';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { config } from './config.js';
import * as db from './database.js';
import * as gmgn from './gmgn.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');
export const liveEvents = new EventEmitter();
liveEvents.setMaxListeners(100);

const SESSIONS = new Map();

export function createWebServer() {
  const app = express();
  app.use(express.json());
  app.use(express.static(join(__dirname, 'public')));

  app.use('/api', (req, res, next) => {
    if (req.path === '/login' || req.path === '/login-check') return next();
    if (req.path.startsWith('/telegram/')) return next();
    if (req.path === '/events') return next();
    if (!config.server.password) return next();
    const token = req.headers['x-auth-token'];
    if (token && SESSIONS.has(token) && SESSIONS.get(token) > Date.now()) {
      SESSIONS.set(token, Date.now() + 3600000);
      return next();
    }
    res.status(401).json({ error: 'unauthorized' });
  });

  app.post('/api/login', (req, res) => {
    if (req.body.password === config.server.password) {
      const token = crypto.randomUUID();
      SESSIONS.set(token, Date.now() + 86400000);
      return res.json({ ok: true, token });
    }
    res.status(401).json({ error: 'wrong password' });
  });

  app.get('/api/login-check', (req, res) => {
    res.json({ required: !!config.server.password });
  });

  // ───── Real-time Events (SSE) ─────
  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(':ok\n\n');

    const onSignal = (data) => res.write(`event: signal\ndata: ${JSON.stringify(data)}\n\n`);
    const onTrade = (data) => res.write(`event: trade\ndata: ${JSON.stringify(data)}\n\n`);
    const onStatus = (data) => res.write(`event: status\ndata: ${JSON.stringify(data)}\n\n`);

    liveEvents.on('signal', onSignal);
    liveEvents.on('trade', onTrade);
    liveEvents.on('status', onStatus);

    req.on('close', () => {
      liveEvents.off('signal', onSignal);
      liveEvents.off('trade', onTrade);
      liveEvents.off('status', onStatus);
    });
  });

  // ───── Channels (Scraper Setup) ─────
  app.get('/api/channels', async (req, res) => {
    const channels = await db.getAllChannels();
    const rules = await db.getChannelRules();
    const enriched = channels.map(c => {
      const rule = rules.find(r => r.channel_id === c.id);
      return { ...c, rule: rule || null };
    });
    res.json(enriched);
  });

  app.get('/api/channels/:id', async (req, res) => {
    const c = await db.getChannelWithRule(req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    let tpLevels = [];
    try { tpLevels = c.rule?.tp_levels ? (typeof c.rule.tp_levels === 'string' ? JSON.parse(c.rule.tp_levels) : c.rule.tp_levels) : []; } catch {}
    res.json({ ...c, rule: c.rule ? { ...c.rule, tp_levels: tpLevels } : null });
  });

  app.post('/api/channels', async (req, res) => {
    const { username, display_name } = req.body;
    if (!username) return res.status(400).json({ error: 'username required' });
    let clean = username.replace(/https?:\/\/t\.me\//, '').replace('@', '').trim();
    if (!clean) return res.status(400).json({ error: 'invalid channel' });
    await db.addChannel(clean, display_name || clean);
    let joined = false;
    try {
      const { addChannelListener } = await import('./telegram.js');
      joined = await addChannelListener(clean);
    } catch (e) {
      console.error('[Channel] join error:', e.message);
    }
    const channels = await db.getAllChannels();
    const ch = channels.find(c => c.channel_username === clean);
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
    await db.toggleChannel(req.params.id, !ch.active);
    res.json({ success: true, active: !ch.active });
  });

  // ───── Rules ─────
  app.get('/api/rules', async (req, res) => res.json(await db.getRulesWithChannels()));
  app.delete('/api/rules/:id', async (req, res) => {
    await db.deleteRule(req.params.id);
    res.json({ success: true });
  });

  // ───── Wallets (Import/Export) ─────
  app.get('/api/wallets', async (req, res) => res.json(await db.getAllWallets()));
  app.post('/api/wallets/import', async (req, res) => {
    const list = req.body.wallets || [];
    if (!list.length) return res.status(400).json({ error: 'wallets array required' });
    await db.importWallets(list);
    res.json({ success: true, imported: list.length });
  });
  app.post('/api/wallets', async (req, res) => {
    if (!req.body.address) return res.status(400).json({ error: 'address required' });
    await db.addWallet(req.body.address, req.body.label, req.body.private_key);
    res.json({ success: true });
  });
  app.delete('/api/wallets/:id', async (req, res) => {
    await db.removeWallet(req.params.id);
    res.json({ success: true });
  });
  app.post('/api/wallets/:id/activate', async (req, res) => {
    await db.setActiveWallet(req.params.id);
    res.json({ success: true });
  });

  // ───── Wallet Groups ─────
  app.get('/api/wallet-groups', async (req, res) => res.json(await db.getWalletGroups()));
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
  app.get('/api/positions', async (req, res) => res.json(await db.getOpenTrades()));
  app.get('/api/positions/all', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const all = await db.getTradeHistory(limit);
    if (req.query.type === 'open') return res.json(all.filter(t => t.status === 'open'));
    if (req.query.type === 'closed') return res.json(all.filter(t => t.status === 'closed'));
    res.json(all);
  });
  app.get('/api/positions/:id', async (req, res) => {
    const t = await db.getTrade(req.params.id);
    if (!t) return res.status(404).json({ error: 'not found' });
    res.json(t);
  });
  app.post('/api/positions/:id/close', async (req, res) => {
    const trade = await db.getTrade(req.params.id);
    if (!trade) return res.status(404).json({ error: 'not found' });
    if (trade.status === 'closed') return res.status(400).json({ error: 'already closed' });
    try {
      const result = await gmgn.executeSell(trade.chain, trade.wallet_address, trade.token_address, req.body.percent || 100, { slippage: req.body.slippage || config.sniper.defaultSlippage });
      const orderId = result.data?.order_id || result.order_id;
      await db.closeTrade(req.params.id, { sell_amount_sol: req.body.sell_amount_sol, sell_price: req.body.sell_price, sell_price_usd: req.body.sell_price_usd, sell_tx: req.body.sell_tx || '', sell_order_id: orderId });
      res.json({ success: true, order_id: orderId });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.get('/api/trades', async (req, res) => res.json(await db.getTradeHistory(Math.min(parseInt(req.query.limit) || 50, 200))));

  // ───── Strategy Orders ─────
  app.get('/api/orders', async (req, res) => res.json(await db.getStrategyOrders()));
  app.get('/api/orders/active', async (req, res) => res.json(await db.getActiveStrategyOrders()));

  app.post('/api/orders/limit-sell', async (req, res) => {
    const { chain, wallet_address, token_address, target_price, percent, token_symbol } = req.body;
    if (!wallet_address || !token_address || !target_price) return res.status(400).json({ error: 'required: wallet_address, token_address, target_price' });
    try {
      const result = await gmgn.createLimitSell(chain || 'sol', wallet_address, token_address, target_price, percent || 100);
      const oid = result.data?.order_id || result.order_id;
      const localId = await db.saveStrategyOrder({ wallet_address, token_address, token_symbol: token_symbol || '', chain: chain || 'sol', order_type: 'limit_order', sub_order_type: 'take_profit', check_price: target_price, amount_in_percent: percent || 100, group_tag: 'LimitOrder', remote_order_id: oid });
      res.json({ success: true, id: localId, remote_order_id: oid });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/orders/buy-with-tp-sl', async (req, res) => {
    const { chain, wallet_address, token_address, amount_lamports, take_profit_percent, stop_loss_percent, slippage, token_symbol } = req.body;
    if (!wallet_address || !token_address) return res.status(400).json({ error: 'wallet_address and token_address required' });
    try {
      const result = await gmgn.executeBuyWithTP(chain || 'sol', wallet_address, token_address, amount_lamports, { takeProfitPercent: take_profit_percent, stopLossPercent: stop_loss_percent, slippage });
      const oid = result.data?.order_id || result.order_id;
      const tradeId = await db.createTrade({ wallet_address, token_address, token_symbol: token_symbol || '', chain: chain || 'sol', buy_amount_sol: amount_lamports / 1e9, buy_order_id: oid, take_profit_percent, stop_loss_percent, status: 'open' });
      res.json({ success: true, trade_id: tradeId, order_id: oid });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/orders/:id', async (req, res) => {
    const orders = await db.getStrategyOrders();
    const o = orders.find(x => x.id == req.params.id);
    if (!o) return res.status(404).json({ error: 'not found' });
    try { if (o.remote_order_id) await gmgn.cancelStrategyOrder(o.chain, o.wallet_address, o.remote_order_id); } catch {}
    await db.cancelStrategyOrderLocal(req.params.id);
    res.json({ success: true });
  });

  // ───── Swap helpers ─────
  app.post('/api/sell', async (req, res) => {
    const { chain, wallet_address, token_address, percent, slippage } = req.body;
    if (!wallet_address || !token_address) return res.status(400).json({ error: 'wallet_address and token_address required' });
    try {
      const result = await gmgn.executeSell(chain || 'sol', wallet_address, token_address, percent || 100, { slippage });
      res.json({ success: true, order_id: result.data?.order_id || result.order_id });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/buy', async (req, res) => {
    const { chain, wallet_address, token_address, amount_lamports, slippage } = req.body;
    if (!wallet_address || !token_address) return res.status(400).json({ error: 'wallet_address and token_address required' });
    try {
      const result = await gmgn.executeSwap(chain || 'sol', wallet_address, 'So11111111111111111111111111111111111111112', token_address, amount_lamports, { slippage });
      res.json({ success: true, order_id: result.data?.order_id || result.order_id });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ───── Wallet Portfolio ─────
  app.get('/api/wallets/:id/portfolio', async (req, res) => {
    const wallet = await db.getWallet(req.params.id);
    if (!wallet) return res.status(404).json({ error: 'wallet not found' });
    try {
      const [info, holdings, stats, activity] = await Promise.allSettled([
        gmgn.getPortfolioInfo(),
        gmgn.getWalletHoldings('sol', wallet.address),
        gmgn.getWalletStats('sol', wallet.address),
        gmgn.getWalletActivity('sol', wallet.address),
      ]);
      res.json({
        info: info.status === 'fulfilled' ? info.value?.data || info.value : null,
        holdings: holdings.status === 'fulfilled' ? holdings.value?.data || holdings.value : null,
        stats: stats.status === 'fulfilled' ? stats.value?.data || stats.value : null,
        activity: activity.status === 'fulfilled' ? activity.value?.data || activity.value : null,
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/wallets/portfolio', async (req, res) => {
    try {
      const wallets = await db.getAllWallets();
      if (wallets.length === 0) return res.json({ wallets: [] });
      const results = await Promise.all(wallets.map(async (w) => {
        let balance = null;
        try {
          const r = await gmgn.getWalletTokenBalance('sol', w.address, 'So11111111111111111111111111111111111111112');
          const d = r?.data || r || {};
          const raw = parseFloat(d.balance);
          balance = raw > 1e8 ? (raw / 1e9).toFixed(6) : raw ? raw.toFixed(6) : null;
        } catch {}
        if (balance == null) {
          try {
            const rpc = await fetch('https://api.mainnet-beta.solana.com', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [w.address] }),
            });
            const j = await rpc.json();
            if (j.result?.value != null) balance = (j.result.value / 1e9).toFixed(6);
          } catch {}
        }
        return { ...w, balance };
      }));
      res.json({ wallets: results });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ───── Generate Wallet ─────
  app.post('/api/wallets/generate', async (req, res) => {
    try {
      const { address, privateKey } = gmgn.generateSolanaWallet();
      res.json({ success: true, address, privateKey });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ───── Token Info ─────
  app.get('/api/token/info', async (req, res) => {
    const { chain, address } = req.query;
    if (!address) return res.status(400).json({ error: 'address required' });
    try {
      const [info, security] = await Promise.allSettled([
        gmgn.getTokenInfo(chain || 'sol', address),
        gmgn.getTokenSecurity(chain || 'sol', address),
      ]);
      res.json({
        info: info.status === 'fulfilled' ? info.value?.data || info.value : null,
        security: security.status === 'fulfilled' ? security.value?.data || security.value : null,
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ───── Scraper ─────
  app.get('/api/scraper/status', async (req, res) => res.json(await db.getScraperStatus()));
  app.get('/api/scraper/logs', async (req, res) => res.json(await db.getScraperLogs(Math.min(parseInt(req.query.limit) || 200, 500))));

  // ───── Settings ─────
  app.get('/api/settings', async (req, res) => {
    const rows = await db.getAllSettings();
    const s = {};
    for (const r of rows) s[r.key] = r.value;
    s.default_buy_amount = String(config.sniper.defaultBuyAmount);
    s.default_slippage = String(config.sniper.defaultSlippage);
    s.default_anti_mev = String(config.sniper.defaultAntiMev);
    s.gmgn_api_key = config.gmgn.apiKey ? config.gmgn.apiKey.slice(0, 12) + '...' : '';
    res.json(s);
  });
  app.post('/api/settings', async (req, res) => {
    for (const [k, v] of Object.entries(req.body)) await db.setSetting(k, String(v));
    res.json({ success: true });
  });

  // ───── Status ─────
  app.get('/api/status', async (req, res) => {
    const [activeChannels, openTrades, todaySignals, allWallets, activeWallet, activeOrders, walletGroups] = await Promise.all([
      db.getActiveChannels(), db.getOpenTrades(), db.getSignalCountToday(),
      db.getAllWallets(), db.getActiveWallet(), db.getActiveStrategyOrders(), db.getWalletGroups(),
    ]);
    res.json({
      channelCount: activeChannels.length,
      openTrades: openTrades.length,
      todaySignals,
      walletCount: allWallets.length,
      hasActiveWallet: !!activeWallet,
      activeOrders: activeOrders.length,
      walletGroups: walletGroups.length,
      uptime: process.uptime(),
    });
  });

  // ───── Setup ─────
  app.get('/api/setup', async (req, res) => {
    const [ch, w] = await Promise.all([db.getActiveChannels(), db.getAllWallets()]);
    res.json({
      gmgnConfigured: !!config.gmgn.apiKey && !!config.gmgn.privateKey,
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
    const client = new (await import('telegram')).TelegramClient(new StringSession(''), Number(apiId), apiHash, { connectionRetries: 3 });

    const state = { client, apiId: Number(apiId), apiHash, phone, sessionStr: null, error: null, state: 'init', resolveCode: null, resolvePassword: null, rejectCode: null, rejectPassword: null };

    await client.connect();
    const sent = await client.invoke(new Api.auth.SendCode({
      phoneNumber: phone, apiId: Number(apiId), apiHash,
      settings: new Api.CodeSettings({ allowFlashcall: true, currentNumber: true, appHash: '' }),
    }));
    state.phoneCodeHash = sent.phoneCodeHash;
    state.state = 'await_code';
    PENDING_LOGIN.set(token, state);
    res.json({ ok: true, loginToken: token });
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
      await db.setSetting('telegram_session', state.sessionStr);
      await initTelegramWithSession(state.apiId, state.apiHash, state.sessionStr);
      PENDING_LOGIN.delete(loginToken);
      res.json({ ok: true });
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
      await db.setSetting('telegram_session', state.sessionStr);
      await initTelegramWithSession(state.apiId, state.apiHash, state.sessionStr);
      PENDING_LOGIN.delete(loginToken);
      res.json({ ok: true });
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
      const { getClient } = await import('./telegram.js');
      const c = getClient();
      const connected = !!(c && c.connected);
      let sessionStr = await db.getSetting('telegram_session', '');
      res.json({ connected, hasSession: !!sessionStr, apiId: !!(config.telegram.apiId) });
    } catch { res.json({ connected: false, hasSession: false }); }
  });

  app.post('/api/telegram/disconnect', async (req, res) => {
    try {
      const { destroyClient } = await import('./telegram.js');
      await destroyClient();
      await db.setSetting('telegram_session', '');
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ───── Activity ─────
  app.get('/api/activity', async (req, res) => {
    const [signals, trades, logs] = await Promise.all([
      db.getRecentSignals(8), db.getTradeHistory(8), db.getScraperLogs(8),
    ]);
    res.json({ signals, trades, logs });
  });

  return app;
}

async function initTelegramWithSession(apiId, apiHash, sessionStr) {
  try {
    const { initTelegramWithSession, startListeners } = await import('./telegram.js');
    await initTelegramWithSession(apiId, apiHash, sessionStr);
    await startListeners();
    console.log('[Telegram] Reconnected with saved session');
  } catch (err) {
    console.warn('[Telegram] Reconnect failed:', err.message);
  }
}

export function startWebServer(app) {
  const server = app.listen(config.server.port, config.server.host, () => {
    console.log(`[Web] Dashboard: http://${config.server.host}:${config.server.port}`);
  });
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of SESSIONS) if (v < now) SESSIONS.delete(k);
  }, 60000);
  const shut = () => { clearInterval(cleanup); SESSIONS.clear(); server.close(); process.exit(0); };
  process.on('SIGINT', shut);
  process.on('SIGTERM', shut);
  return server;
}
