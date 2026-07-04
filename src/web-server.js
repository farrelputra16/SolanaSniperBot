import express from 'express';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import * as db from './database.js';
import * as gmgn from './gmgn.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');

export function createWebServer() {
  const app = express();
  app.use(express.json());
  app.use(express.static(join(__dirname, 'public')));

  // ───── Channels (Scraper Setup) ─────
  app.get('/api/channels', (req, res) => {
    const channels = db.getAllChannels();
    const rules = db.qall('SELECT * FROM rules');
    const enriched = channels.map(c => {
      const rule = rules.find(r => r.channel_id === c.id);
      return { ...c, rule: rule || null };
    });
    res.json(enriched);
  });

  app.get('/api/channels/:id', (req, res) => {
    const c = db.getChannel(req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    const rule = db.qget('SELECT * FROM rules WHERE channel_id = ?', [c.id]);
    let tpLevels = [];
    try { tpLevels = rule?.tp_levels ? JSON.parse(rule.tp_levels) : []; } catch {}
    res.json({ ...c, rule: rule ? { ...rule, tp_levels: tpLevels } : null });
  });

  app.post('/api/channels', async (req, res) => {
    const { username, display_name } = req.body;
    if (!username) return res.status(400).json({ error: 'username required' });
    const clean = username.replace('@', '').trim();
    db.addChannel(clean, display_name || clean);
    try {
      const { addChannelListener } = await import('./telegram.js');
      await addChannelListener(clean);
    } catch {}
    res.json({ success: true, username: clean });
  });

  app.put('/api/channels/:id/rules', (req, res) => {
    const ch = db.getChannel(req.params.id);
    if (!ch) return res.status(404).json({ error: 'channel not found' });
    db.upsertChannelRule({ ...req.body, channel_id: req.params.id });
    res.json({ success: true });
  });

  app.delete('/api/channels/:id', (req, res) => { db.removeChannel(req.params.id); res.json({ success: true }); });
  app.patch('/api/channels/:id/toggle', (req, res) => {
    const ch = db.getChannel(req.params.id);
    if (!ch) return res.status(404).json({ error: 'not found' });
    db.toggleChannel(req.params.id, !ch.active);
    res.json({ success: true, active: !ch.active });
  });

  // ───── Rules ─────
  app.get('/api/rules', (req, res) => res.json(db.getRulesWithChannels()));
  app.delete('/api/rules/:id', (req, res) => { db.deleteRule(req.params.id); res.json({ success: true }); });

  // ───── Wallets (Import/Export) ─────
  app.get('/api/wallets', (req, res) => res.json(db.getAllWallets()));
  app.post('/api/wallets/import', (req, res) => {
    const list = req.body.wallets || [];
    if (!list.length) return res.status(400).json({ error: 'wallets array required' });
    db.importWallets(list);
    res.json({ success: true, imported: list.length });
  });
  app.post('/api/wallets', (req, res) => {
    if (!req.body.address) return res.status(400).json({ error: 'address required' });
    db.addWallet(req.body.address, req.body.label);
    res.json({ success: true });
  });
  app.delete('/api/wallets/:id', (req, res) => { db.removeWallet(req.params.id); res.json({ success: true }); });
  app.post('/api/wallets/:id/activate', (req, res) => { db.setActiveWallet(req.params.id); res.json({ success: true }); });

  // ───── Wallet Groups ─────
  app.get('/api/wallet-groups', (req, res) => res.json(db.getWalletGroups()));
  app.post('/api/wallet-groups', (req, res) => { const id = db.createWalletGroup(req.body.name, req.body.description); res.json({ success: true, id }); });
  app.delete('/api/wallet-groups/:id', (req, res) => { db.deleteWalletGroup(req.params.id); res.json({ success: true }); });
  app.get('/api/wallet-groups/:id/wallets', (req, res) => res.json(db.getGroupWallets(req.params.id)));
  app.post('/api/wallet-groups/:id/wallets', (req, res) => { db.addWalletToGroup(req.params.id, req.body.wallet_id); res.json({ success: true }); });
  app.delete('/api/wallet-groups/:id/wallets/:walletId', (req, res) => { db.removeWalletFromGroup(req.params.id, req.params.walletId); res.json({ success: true }); });

  // ───── Positions ─────
  app.get('/api/positions', (req, res) => res.json(db.getOpenTrades()));
  app.get('/api/positions/all', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const all = db.getTradeHistory(limit);
    if (req.query.type === 'open') return res.json(all.filter(t => t.status === 'open'));
    if (req.query.type === 'closed') return res.json(all.filter(t => t.status === 'closed'));
    res.json(all);
  });
  app.get('/api/positions/:id', (req, res) => {
    const t = db.getTrade(req.params.id);
    if (!t) return res.status(404).json({ error: 'not found' });
    const orders = db.qall('SELECT * FROM strategy_orders WHERE trade_id = ?', [t.id]);
    res.json({ ...t, strategy_orders: orders });
  });
  app.post('/api/positions/:id/close', async (req, res) => {
    const trade = db.getTrade(req.params.id);
    if (!trade) return res.status(404).json({ error: 'not found' });
    if (trade.status === 'closed') return res.status(400).json({ error: 'already closed' });
    try {
      const result = await gmgn.executeSell(trade.chain, trade.wallet_address, trade.token_address, req.body.percent || 100, { slippage: req.body.slippage || config.sniper.defaultSlippage });
      const orderId = result.data?.order_id || result.order_id;
      db.closeTrade(req.params.id, { sell_amount_sol: req.body.sell_amount_sol, sell_price: req.body.sell_price, sell_price_usd: req.body.sell_price_usd, sell_tx: req.body.sell_tx || '', sell_order_id: orderId });
      res.json({ success: true, order_id: orderId });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.get('/api/trades', (req, res) => res.json(db.getTradeHistory(Math.min(parseInt(req.query.limit) || 50, 200))));

  // ───── Strategy Orders ─────
  app.get('/api/orders', (req, res) => res.json(db.getStrategyOrders()));
  app.get('/api/orders/active', (req, res) => res.json(db.getActiveStrategyOrders()));

  app.post('/api/orders/limit-sell', async (req, res) => {
    const { chain, wallet_address, token_address, target_price, percent, token_symbol } = req.body;
    if (!wallet_address || !token_address || !target_price) return res.status(400).json({ error: 'required: wallet_address, token_address, target_price' });
    try {
      const result = await gmgn.createLimitSell(chain || 'sol', wallet_address, token_address, target_price, percent || 100);
      const oid = result.data?.order_id || result.order_id;
      const localId = db.saveStrategyOrder({ wallet_address, token_address, token_symbol: token_symbol || '', chain: chain || 'sol', order_type: 'limit_order', sub_order_type: 'take_profit', check_price: target_price, amount_in_percent: percent || 100, group_tag: 'LimitOrder', remote_order_id: oid });
      res.json({ success: true, id: localId, remote_order_id: oid });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/orders/buy-with-tp-sl', async (req, res) => {
    const { chain, wallet_address, token_address, amount_lamports, take_profit_percent, stop_loss_percent, slippage, token_symbol } = req.body;
    if (!wallet_address || !token_address) return res.status(400).json({ error: 'wallet_address and token_address required' });
    try {
      const result = await gmgn.executeBuyWithTP(chain || 'sol', wallet_address, token_address, amount_lamports, { takeProfitPercent: take_profit_percent, stopLossPercent: stop_loss_percent, slippage });
      const oid = result.data?.order_id || result.order_id;
      const tradeId = db.createTrade({ wallet_address, token_address, token_symbol: token_symbol || '', chain: chain || 'sol', buy_amount_sol: amount_lamports / 1e9, buy_order_id: oid, take_profit_percent, stop_loss_percent, status: 'open' });
      res.json({ success: true, trade_id: tradeId, order_id: oid });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/orders/:id', async (req, res) => {
    const o = db.qget('SELECT * FROM strategy_orders WHERE id = ?', [req.params.id]);
    if (!o) return res.status(404).json({ error: 'not found' });
    try { if (o.remote_order_id) await gmgn.cancelStrategyOrder(o.chain, o.wallet_address, o.remote_order_id); } catch {}
    db.cancelStrategyOrderLocal(req.params.id);
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

  // ───── Token Info (simplified — just for position details) ─────
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

  // ───── Telegram Sessions (non-blocking background login) ─────
  const pendingLogins = {};

  function getCleanSession(s) {
    return {
      ...s,
      api_hash: s.api_hash ? s.api_hash.slice(0, 8) + '...' : '',
      session_string: s.session_string ? '***' : '',
    };
  }

  app.get('/api/telegram/sessions', (req, res) => {
    res.json(db.getTelegramSessions().map(getCleanSession));
  });

  app.get('/api/telegram/sessions/:id', (req, res) => {
    const s = db.getTelegramSession(req.params.id);
    if (!s) return res.status(404).json({ error: 'not found' });
    res.json(getCleanSession(s));
  });

  app.post('/api/telegram/sessions', (req, res) => {
    const { name, api_id, api_hash, phone } = req.body;
    if (!api_id || !api_hash) return res.status(400).json({ error: 'api_id and api_hash required' });
    if (!phone) return res.status(400).json({ error: 'phone required' });

    const id = db.createTelegramSession({ name, api_id: parseInt(api_id), api_hash, phone, status: 'connecting' });
    res.json({ success: true, id, status: 'connecting' });

    // Start login in background — does NOT block the HTTP response
    startTelegramLogin(id, parseInt(api_id), api_hash, phone);
  });

  async function startTelegramLogin(id, apiId, apiHash, phone) {
    console.log('[Telegram] Starting login for session', id);
    try {
      const { loginNewSession } = await import('./telegram.js');

      // Overall timeout: 60s for the entire login process
      const loginPromise = loginNewSession(apiId, apiHash, phone, async () => {
        console.log('[Telegram] phoneCode CALLED for session', id);
        try {
          db.updateTelegramSession(id, { status: 'needs_otp' });
          console.log('[Telegram] Status updated to needs_otp for session', id);
        } catch (dbErr) {
          console.error('[Telegram] DB update failed in phoneCode:', dbErr.message);
        }
        return new Promise((resolve, reject) => {
          pendingLogins[id] = { resolve, reject, timeout: setTimeout(() => {
            console.log('[Telegram] OTP timeout for session', id);
            delete pendingLogins[id];
            reject(new Error('OTP timeout after 2 minutes'));
          }, 120000) };
        });
      });

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Login timeout — Telegram connection took too long')), 60000)
      );

      const sessionStr = await Promise.race([loginPromise, timeoutPromise]);
      console.log('[Telegram] Login complete for session', id);
      db.updateTelegramSession(id, { session_string: sessionStr, status: 'active', phone });
      delete pendingLogins[id];
      // Auto-activate
      try {
        const { initTelegramWithSession, startListeners } = await import('./telegram.js');
        await initTelegramWithSession(apiId, apiHash, sessionStr);
        db.setActiveTelegramSession(id);
        try { await startListeners(); } catch {}
        console.log('[Telegram] Auto-activated session', id);
      } catch (activateErr) {
        console.error('[Telegram] Auto-activate failed:', activateErr.message);
      }
    } catch (err) {
      console.error('[Telegram] Login failed for session', id, ':', err.message);
      db.updateTelegramSession(id, { status: 'error', error_message: err.message });
      delete pendingLogins[id];
    }
  }

  app.post('/api/telegram/sessions/:id/otp', (req, res) => {
    const login = pendingLogins[req.params.id];
    if (!login) return res.status(400).json({ error: 'No pending OTP request for this session' });
    if (!req.body.code) return res.status(400).json({ error: 'code required' });
    clearTimeout(login.timeout);
    login.resolve(req.body.code);
    delete pendingLogins[req.params.id];
    res.json({ success: true, message: 'OTP submitted' });
  });

  app.post('/api/telegram/sessions/:id/activate', async (req, res) => {
    const session = db.getTelegramSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'session not found' });
    if (!session.session_string) return res.status(400).json({ error: 'Session not yet connected (no session string)' });

    try {
      const { initTelegramWithSession, startListeners } = await import('./telegram.js');
      await initTelegramWithSession(session.api_id, session.api_hash, session.session_string);
      db.setActiveTelegramSession(session.id);
      db.updateTelegramSession(session.id, { status: 'active' });
      try { await startListeners(); } catch {}
      res.json({ success: true, message: 'Telegram activated' });
    } catch (err) {
      db.updateTelegramSession(session.id, { status: 'error', error_message: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/telegram/sessions/:id', async (req, res) => {
    const session = db.getTelegramSession(req.params.id);
    if (session?.status === 'active') {
      const { destroyClient } = await import('./telegram.js');
      await destroyClient();
    }
    db.deleteTelegramSession(req.params.id);
    delete pendingLogins[req.params.id];
    res.json({ success: true });
  });

  // ───── Scraper ─────
  app.get('/api/scraper/status', (req, res) => res.json(db.getScraperStatus()));
  app.get('/api/scraper/logs', (req, res) => res.json(db.getScraperLogs(Math.min(parseInt(req.query.limit) || 200, 500))));

  // ───── Settings ─────
  app.get('/api/settings', (req, res) => {
    const rows = db.getAllSettings();
    const s = {};
    for (const r of rows) s[r.key] = r.value;
    s.default_buy_amount = String(config.sniper.defaultBuyAmount);
    s.default_slippage = String(config.sniper.defaultSlippage);
    s.default_anti_mev = String(config.sniper.defaultAntiMev);
    s.gmgn_api_key = config.gmgn.apiKey ? config.gmgn.apiKey.slice(0, 12) + '...' : '';
    const activeTg = db.getActiveTelegramSession();
    s.telegram_configured = String(!!activeTg);
    res.json(s);
  });
  app.post('/api/settings', (req, res) => {
    for (const [k, v] of Object.entries(req.body)) db.setSetting(k, String(v));
    res.json({ success: true });
  });

  // ───── Status ─────
  app.get('/api/status', (req, res) => {
    res.json({
      channelCount: db.getActiveChannels().length,
      openTrades: db.getOpenTrades().length,
      todaySignals: db.getSignalCountToday(),
      walletCount: db.getAllWallets().length,
      hasActiveWallet: !!db.getActiveWallet(),
      activeOrders: db.getActiveStrategyOrders().length,
      walletGroups: db.getWalletGroups().length,
      uptime: process.uptime(),
    });
  });

  // ───── Setup ─────
  app.get('/api/setup', (req, res) => {
    const activeSession = db.getActiveTelegramSession();
    res.json({
      gmgnConfigured: !!config.gmgn.apiKey && !!config.gmgn.privateKey,
      telegramConfigured: !!activeSession,
      telegramActive: activeSession?.status === 'active',
      telegramSession: !!activeSession?.session_string,
      telegramSessions: db.getTelegramSessions().length,
      hasChannels: db.getActiveChannels().length > 0,
      hasWallets: db.getAllWallets().length > 0,
    });
  });

  // ───── Activity ─────
  app.get('/api/activity', (req, res) => {
    res.json({
      signals: db.getRecentSignals(8),
      trades: db.getTradeHistory(8),
      logs: db.getScraperLogs(8),
    });
  });

  return app;
}

export function startWebServer(app) {
  app.listen(config.server.port, config.server.host, () => {
    console.log(`[Web] Dashboard: http://${config.server.host}:${config.server.port}`);
  });
}
