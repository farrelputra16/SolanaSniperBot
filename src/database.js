import Database from 'better-sqlite3';
import { join } from 'path';

let db;

export function initDatabase() {
  db = new Database(join(process.cwd(), 'data', 'sniper.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createTables();
  return db;
}

export function getDatabase() {
  if (!db) initDatabase();
  return db;
}

function createTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_username TEXT NOT NULL UNIQUE,
      display_name TEXT,
      added_at INTEGER DEFAULT (unixepoch()),
      active BOOLEAN DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
      name TEXT DEFAULT 'default',
      min_market_cap REAL,
      max_market_cap REAL,
      min_liquidity REAL,
      min_volume_24h REAL,
      max_rug_ratio REAL DEFAULT 0.3,
      require_smart_money BOOLEAN DEFAULT 0,
      min_smart_degen INTEGER DEFAULT 0,
      max_bundler_rate REAL DEFAULT 0.3,
      auto_buy BOOLEAN DEFAULT 0,
      buy_amount_sol REAL DEFAULT 0.01,
      slippage INTEGER DEFAULT 30,
      anti_mev BOOLEAN DEFAULT 1,
      take_profit_percent REAL,
      stop_loss_percent REAL,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS forwarding (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
      target_chat_id TEXT,
      target_chat_username TEXT,
      active BOOLEAN DEFAULT 1,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT NOT NULL UNIQUE,
      label TEXT,
      balance_sol REAL DEFAULT 0,
      active BOOLEAN DEFAULT 1,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_address TEXT NOT NULL,
      token_symbol TEXT,
      token_name TEXT,
      chain TEXT DEFAULT 'sol',
      source_channel TEXT,
      source_text TEXT,
      price REAL,
      market_cap REAL,
      liquidity REAL,
      volume_24h REAL,
      rug_ratio REAL,
      smart_degen_count INTEGER DEFAULT 0,
      auto_buy_triggered BOOLEAN DEFAULT 0,
      status TEXT DEFAULT 'pending',
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_id INTEGER REFERENCES signals(id),
      wallet_address TEXT,
      token_address TEXT NOT NULL,
      token_symbol TEXT,
      chain TEXT DEFAULT 'sol',
      buy_amount_sol REAL,
      buy_price REAL,
      buy_price_usd REAL,
      buy_tx TEXT,
      buy_order_id TEXT,
      buy_status TEXT DEFAULT 'pending',
      take_profit_percent REAL,
      stop_loss_percent REAL,
      tp_order_id TEXT,
      sl_order_id TEXT,
      sell_amount_sol REAL,
      sell_price REAL,
      sell_price_usd REAL,
      sell_tx TEXT,
      sell_order_id TEXT,
      pnl REAL,
      pnl_percent REAL,
      status TEXT DEFAULT 'open',
      created_at INTEGER DEFAULT (unixepoch()),
      closed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

// ─── Channel queries ───
export function getActiveChannels() {
  return db.prepare('SELECT * FROM channels WHERE active = 1').all();
}

export function addChannel(username, displayName) {
  const stmt = db.prepare('INSERT OR IGNORE INTO channels (channel_username, display_name) VALUES (?, ?)');
  return stmt.run(username, displayName);
}

export function removeChannel(id) {
  db.prepare('DELETE FROM channels WHERE id = ?').run(id);
}

export function toggleChannel(id, active) {
  db.prepare('UPDATE channels SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
}

// ─── Rule queries ───
export function getRulesForChannel(channelId) {
  return db.prepare('SELECT * FROM rules WHERE channel_id = ?').all(channelId);
}

export function getAutoBuyRules() {
  return db.prepare('SELECT r.*, c.channel_username FROM rules r JOIN channels c ON c.id = r.channel_id WHERE r.auto_buy = 1 AND c.active = 1').all();
}

export function setRule(rule) {
  if (rule.id) {
    const stmt = db.prepare(`UPDATE rules SET
      name=?, min_market_cap=?, max_market_cap=?, min_liquidity=?, min_volume_24h=?,
      max_rug_ratio=?, require_smart_money=?, min_smart_degen=?, max_bundler_rate=?,
      auto_buy=?, buy_amount_sol=?, slippage=?, anti_mev=?,
      take_profit_percent=?, stop_loss_percent=?
      WHERE id=?`);
    return stmt.run(
      rule.name, rule.min_market_cap, rule.max_market_cap, rule.min_liquidity, rule.min_volume_24h,
      rule.max_rug_ratio, rule.require_smart_money ? 1 : 0, rule.min_smart_degen, rule.max_bundler_rate,
      rule.auto_buy ? 1 : 0, rule.buy_amount_sol, rule.slippage, rule.anti_mev ? 1 : 0,
      rule.take_profit_percent, rule.stop_loss_percent, rule.id
    );
  }
  const stmt = db.prepare(`INSERT INTO rules
    (channel_id, name, min_market_cap, max_market_cap, min_liquidity, min_volume_24h,
     max_rug_ratio, require_smart_money, min_smart_degen, max_bundler_rate,
     auto_buy, buy_amount_sol, slippage, anti_mev, take_profit_percent, stop_loss_percent)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  return stmt.run(
    rule.channel_id, rule.name, rule.min_market_cap, rule.max_market_cap, rule.min_liquidity, rule.min_volume_24h,
    rule.max_rug_ratio, rule.require_smart_money ? 1 : 0, rule.min_smart_degen, rule.max_bundler_rate,
    rule.auto_buy ? 1 : 0, rule.buy_amount_sol, rule.slippage, rule.anti_mev ? 1 : 0,
    rule.take_profit_percent, rule.stop_loss_percent
  );
}

// ─── Forwarding ───
export function getActiveForwarding() {
  return db.prepare(`SELECT f.*, c.channel_username FROM forwarding f
    JOIN channels c ON c.id = f.channel_id WHERE f.active = 1 AND c.active = 1`).all();
}

export function setForwarding(channelId, targetChatId, targetUsername) {
  const existing = db.prepare('SELECT id FROM forwarding WHERE channel_id = ?').get(channelId);
  if (existing) {
    db.prepare('UPDATE forwarding SET target_chat_id=?, target_chat_username=?, active=1 WHERE id=?')
      .run(targetChatId, targetUsername, existing.id);
  } else {
    db.prepare('INSERT INTO forwarding (channel_id, target_chat_id, target_chat_username) VALUES (?,?,?)')
      .run(channelId, targetChatId, targetUsername);
  }
}

// ─── Trades ───
export function createTrade(data) {
  const stmt = db.prepare(`INSERT INTO trades
    (signal_id, wallet_address, token_address, token_symbol, chain,
     buy_amount_sol, buy_price, buy_price_usd, buy_tx, buy_order_id,
     take_profit_percent, stop_loss_percent, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  return stmt.run(
    data.signal_id, data.wallet_address, data.token_address, data.token_symbol, data.chain,
    data.buy_amount_sol, data.buy_price, data.buy_price_usd, data.buy_tx, data.buy_order_id,
    data.take_profit_percent, data.stop_loss_percent, data.status || 'open'
  );
}

export function updateTrade(id, data) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(data)) {
    sets.push(`${k}=?`);
    vals.push(v);
  }
  vals.push(id);
  db.prepare(`UPDATE trades SET ${sets.join(',')} WHERE id=?`).run(...vals);
}

export function getOpenTrades() {
  return db.prepare("SELECT * FROM trades WHERE status = 'open'").all();
}

export function getTradeHistory(limit = 50) {
  return db.prepare('SELECT * FROM trades ORDER BY created_at DESC LIMIT ?').all(limit);
}

// ─── Signals ───
export function saveSignal(data) {
  const stmt = db.prepare(`INSERT INTO signals
    (token_address, token_symbol, token_name, chain, source_channel, source_text,
     price, market_cap, liquidity, volume_24h, rug_ratio, smart_degen_count, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  return stmt.run(
    data.token_address, data.token_symbol, data.token_name, data.chain,
    data.source_channel, data.source_text, data.price, data.market_cap,
    data.liquidity, data.volume_24h, data.rug_ratio, data.smart_degen_count,
    data.status || 'pending'
  );
}

export function getRecentSignals(limit = 50) {
  return db.prepare('SELECT * FROM signals ORDER BY created_at DESC LIMIT ?').all(limit);
}

// ─── Settings ───
export function getSetting(key, defaultVal = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : defaultVal;
}

export function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}
