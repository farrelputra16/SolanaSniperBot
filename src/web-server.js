import express from 'express';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { getDatabase } from './database.js';
import { addChannelListener } from './telegram.js';

const __dirname = join(fileURLToPath(import.meta.url), '..');

export function createWebServer() {
  const app = express();
  app.use(express.json());
  app.use(express.static(join(__dirname, 'public')));

  // ─── API Routes ───

  // Channels
  app.get('/api/channels', (req, res) => {
    const db = getDatabase();
    res.json(db.prepare('SELECT * FROM channels ORDER BY added_at DESC').all());
  });

  app.post('/api/channels', async (req, res) => {
    const { username, display_name } = req.body;
    if (!username) return res.status(400).json({ error: 'username required' });
    const clean = username.replace('@', '').trim();
    const db = getDatabase();
    db.prepare('INSERT OR IGNORE INTO channels (channel_username, display_name) VALUES (?, ?)').run(clean, display_name || clean);
    try {
      await addChannelListener(clean);
    } catch (err) {
      console.error('Failed to listen:', err.message);
    }
    res.json({ success: true });
  });

  app.delete('/api/channels/:id', (req, res) => {
    const db = getDatabase();
    db.prepare('DELETE FROM channels WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  });

  app.patch('/api/channels/:id/toggle', (req, res) => {
    const db = getDatabase();
    const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.id);
    if (!ch) return res.status(404).json({ error: 'not found' });
    db.prepare('UPDATE channels SET active = ? WHERE id = ?').run(ch.active ? 0 : 1, req.params.id);
    res.json({ success: true, active: !ch.active });
  });

  // Rules
  app.get('/api/rules', (req, res) => {
    const db = getDatabase();
    const rules = db.prepare(`
      SELECT r.*, c.channel_username FROM rules r
      JOIN channels c ON c.id = r.channel_id
      ORDER BY c.channel_username
    `).all();
    res.json(rules);
  });

  app.get('/api/rules/:channelId', (req, res) => {
    const db = getDatabase();
    res.json(db.prepare('SELECT * FROM rules WHERE channel_id = ?').all(req.params.channelId));
  });

  app.post('/api/rules', (req, res) => {
    const db = getDatabase();
    const r = req.body;
    if (r.id) {
      db.prepare(`UPDATE rules SET
        name=?, min_market_cap=?, max_market_cap=?, min_liquidity=?, min_volume_24h=?,
        max_rug_ratio=?, require_smart_money=?, min_smart_degen=?, max_bundler_rate=?,
        auto_buy=?, buy_amount_sol=?, slippage=?, anti_mev=?,
        take_profit_percent=?, stop_loss_percent=?
        WHERE id=?`).run(
        r.name, r.min_market_cap, r.max_market_cap, r.min_liquidity, r.min_volume_24h,
        r.max_rug_ratio, r.require_smart_money ? 1 : 0, r.min_smart_degen || 0, r.max_bundler_rate,
        r.auto_buy ? 1 : 0, r.buy_amount_sol, r.slippage, r.anti_mev ? 1 : 0,
        r.take_profit_percent, r.stop_loss_percent, r.id
      );
    } else {
      db.prepare(`INSERT INTO rules
        (channel_id, name, min_market_cap, max_market_cap, min_liquidity, min_volume_24h,
         max_rug_ratio, require_smart_money, min_smart_degen, max_bundler_rate,
         auto_buy, buy_amount_sol, slippage, anti_mev, take_profit_percent, stop_loss_percent)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        r.channel_id, r.name, r.min_market_cap, r.max_market_cap, r.min_liquidity, r.min_volume_24h,
        r.max_rug_ratio, r.require_smart_money ? 1 : 0, r.min_smart_degen || 0, r.max_bundler_rate,
        r.auto_buy ? 1 : 0, r.buy_amount_sol, r.slippage, r.anti_mev ? 1 : 0,
        r.take_profit_percent, r.stop_loss_percent
      );
    }
    res.json({ success: true });
  });

  app.delete('/api/rules/:id', (req, res) => {
    const db = getDatabase();
    db.prepare('DELETE FROM rules WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  });

  // Forwarding
  app.get('/api/forwarding', (req, res) => {
    const db = getDatabase();
    res.json(db.prepare(`
      SELECT f.*, c.channel_username FROM forwarding f
      JOIN channels c ON c.id = f.channel_id
    `).all());
  });

  app.post('/api/forwarding', (req, res) => {
    const { channel_id, target_chat_id, target_chat_username } = req.body;
    const db = getDatabase();
    const existing = db.prepare('SELECT id FROM forwarding WHERE channel_id = ?').get(channel_id);
    if (existing) {
      db.prepare('UPDATE forwarding SET target_chat_id=?, target_chat_username=?, active=1 WHERE id=?')
        .run(target_chat_id, target_chat_username, existing.id);
    } else {
      db.prepare('INSERT INTO forwarding (channel_id, target_chat_id, target_chat_username) VALUES (?,?,?)')
        .run(channel_id, target_chat_id, target_chat_username);
    }
    res.json({ success: true });
  });

  app.delete('/api/forwarding/:id', (req, res) => {
    const db = getDatabase();
    db.prepare('DELETE FROM forwarding WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  });

  // Wallets
  app.get('/api/wallets', (req, res) => {
    const db = getDatabase();
    res.json(db.prepare('SELECT * FROM wallets ORDER BY created_at DESC').all());
  });

  app.post('/api/wallets', (req, res) => {
    const { address, label } = req.body;
    if (!address) return res.status(400).json({ error: 'address required' });
    const db = getDatabase();
    db.prepare('INSERT OR IGNORE INTO wallets (address, label) VALUES (?, ?)').run(address, label || '');
    res.json({ success: true });
  });

  app.delete('/api/wallets/:id', (req, res) => {
    const db = getDatabase();
    db.prepare('DELETE FROM wallets WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  });

  // Signals
  app.get('/api/signals', (req, res) => {
    const db = getDatabase();
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    res.json(db.prepare('SELECT * FROM signals ORDER BY created_at DESC LIMIT ?').all(limit));
  });

  // Trades
  app.get('/api/trades', (req, res) => {
    const db = getDatabase();
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    res.json(db.prepare(`
      SELECT t.*, s.token_symbol as signal_symbol, s.source_channel
      FROM trades t LEFT JOIN signals s ON s.id = t.signal_id
      ORDER BY t.created_at DESC LIMIT ?
    `).all(limit));
  });

  // Settings
  app.get('/api/settings', (req, res) => {
    const db = getDatabase();
    const rows = db.prepare('SELECT * FROM settings').all();
    const settings = {};
    for (const r of rows) settings[r.key] = r.value;
    settings.default_buy_amount = String(config.sniper.defaultBuyAmount);
    settings.default_slippage = String(config.sniper.defaultSlippage);
    res.json(settings);
  });

  app.post('/api/settings', (req, res) => {
    const db = getDatabase();
    for (const [key, value] of Object.entries(req.body)) {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
    }
    res.json({ success: true });
  });

  // Status
  app.get('/api/status', (req, res) => {
    const db = getDatabase();
    const channelCount = db.prepare('SELECT COUNT(*) as c FROM channels WHERE active=1').get().c;
    const openTrades = db.prepare("SELECT COUNT(*) as c FROM trades WHERE status='open'").get().c;
    const todaySignals = db.prepare("SELECT COUNT(*) as c FROM signals WHERE created_at > unixepoch('now', '-1 day')").get().c;
    res.json({ channelCount, openTrades, todaySignals, uptime: process.uptime() });
  });

  return app;
}

export function startWebServer(app) {
  const { port, host } = config.server;
  app.listen(port, host, () => {
    console.log(`[Web] Dashboard: http://${host}:${port}`);
  });
}
