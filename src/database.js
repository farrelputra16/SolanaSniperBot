import initSqlJs from 'sql.js';
import { join } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';

let db = null;
const DB_PATH = join(process.cwd(), 'data', 'sniper.db');

export async function initDatabase() {
  const SQL = await initSqlJs();
  const dataDir = join(process.cwd(), 'data');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  if (existsSync(DB_PATH)) db = new SQL.Database(readFileSync(DB_PATH));
  else db = new SQL.Database();
  createTables();
  migrate();
  persist();
  return db;
}

function migrate() {
  for (const sql of [
    "ALTER TABLE rules ADD COLUMN sender_filter TEXT DEFAULT ''",
    "ALTER TABLE signals ADD COLUMN sender_username TEXT DEFAULT ''",
    "ALTER TABLE rules ADD COLUMN tp_levels TEXT DEFAULT '[]'",
    "ALTER TABLE rules ADD COLUMN priority_fee INTEGER",
    "ALTER TABLE rules ADD COLUMN tip_fee INTEGER",
    "ALTER TABLE rules ADD COLUMN wallet_group_id INTEGER DEFAULT 0",
  ]) { try { db.run(sql); } catch {} }
}

function createTables() {
  db.run(`
    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_username TEXT NOT NULL UNIQUE,
      display_name TEXT,
      added_at INTEGER DEFAULT (strftime('%s','now')),
      active INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER REFERENCES channels(id),
      name TEXT DEFAULT 'default',
      min_market_cap REAL, max_market_cap REAL,
      min_liquidity REAL, max_liquidity REAL,
      auto_buy INTEGER DEFAULT 0,
      buy_amount_sol REAL DEFAULT 0.01,
      slippage INTEGER DEFAULT 30,
      anti_mev INTEGER DEFAULT 1,
      take_profit_percent REAL, stop_loss_percent REAL,
      tp_levels TEXT DEFAULT '[]',
      priority_fee INTEGER, tip_fee INTEGER,
      wallet_group_id INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS forwarding (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER REFERENCES channels(id),
      target_chat_id TEXT, target_chat_username TEXT,
      active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT NOT NULL UNIQUE, label TEXT,
      balance_sol REAL DEFAULT 0, active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_address TEXT NOT NULL, token_symbol TEXT, token_name TEXT,
      chain TEXT DEFAULT 'sol', source_channel TEXT, source_text TEXT,
      price REAL, market_cap REAL, liquidity REAL, volume_24h REAL,
      rug_ratio REAL, smart_degen_count INTEGER DEFAULT 0,
      bundler_rate REAL, top10_rate REAL, creator_status TEXT,
      auto_buy_triggered INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_id INTEGER, wallet_address TEXT,
      token_address TEXT NOT NULL, token_symbol TEXT,
      chain TEXT DEFAULT 'sol',
      buy_amount_sol REAL, buy_price REAL, buy_price_usd REAL,
      buy_tx TEXT, buy_order_id TEXT, buy_status TEXT DEFAULT 'pending',
      take_profit_percent REAL, stop_loss_percent REAL,
      tp_order_id TEXT, sl_order_id TEXT,
      sell_amount_sol REAL, sell_price REAL, sell_price_usd REAL,
      sell_tx TEXT, sell_order_id TEXT,
      pnl REAL, pnl_percent REAL,
      status TEXT DEFAULT 'open',
      created_at INTEGER DEFAULT (strftime('%s','now')),
      closed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT
    );
    CREATE TABLE IF NOT EXISTS scraper_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_username TEXT, level TEXT DEFAULT 'info',
      message TEXT, created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS strategy_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_id INTEGER, wallet_address TEXT,
      token_address TEXT NOT NULL, token_symbol TEXT,
      chain TEXT DEFAULT 'sol',
      order_type TEXT DEFAULT 'limit_order',
      sub_order_type TEXT DEFAULT 'take_profit',
      check_price REAL, amount_in_percent INTEGER DEFAULT 100,
      group_tag TEXT, remote_order_id TEXT,
      status TEXT DEFAULT 'active',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS wallet_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, description TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS wallet_group_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER REFERENCES wallet_groups(id),
      wallet_id INTEGER REFERENCES wallets(id),
      UNIQUE(group_id, wallet_id)
    );
  `);
}

export function persist() {
  if (!db) return;
  const dataDir = join(process.cwd(), 'data');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  writeFileSync(DB_PATH, Buffer.from(db.export()));
}

export function qall(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

export function qget(sql, params = []) { const rows = qall(sql, params); return rows.length > 0 ? rows[0] : null; }
export function qrun(sql, params = []) { db.run(sql, params); }

// ───── Channels ─────
export function getActiveChannels() { return qall('SELECT * FROM channels WHERE active = 1'); }
export function getAllChannels() {
  return qall(`SELECT c.*,
    (SELECT COUNT(*) FROM signals s WHERE s.source_channel = c.channel_username) as signal_count,
    (SELECT MAX(created_at) FROM signals s WHERE s.source_channel = c.channel_username) as last_signal_at
    FROM channels c ORDER BY c.added_at DESC`);
}
export function addChannel(username, displayName) {
  qrun('INSERT OR IGNORE INTO channels (channel_username, display_name) VALUES (?,?)', [username, displayName || username]);
  persist();
}
export function removeChannel(id) { qrun('DELETE FROM channels WHERE id = ?', [id]); qrun('DELETE FROM rules WHERE channel_id = ?', [id]); persist(); }
export function toggleChannel(id, active) { qrun('UPDATE channels SET active = ? WHERE id = ?', [active ? 1 : 0, id]); persist(); }
export function getChannel(id) { return qget('SELECT * FROM channels WHERE id = ?', [id]); }
export function getChannelWithRule(id) {
  return qget(`SELECT c.*, r.*, r.id as rule_id FROM channels c LEFT JOIN rules r ON r.channel_id = c.id WHERE c.id = ?`, [id]);
}

// ───── Rules (combined with channels) ─────
export function getChannelRules() {
  return qall(`SELECT c.id as channel_id, c.channel_username, c.display_name, c.active, c.added_at, c.signal_count, c.last_signal_at,
    r.id as rule_id, r.* FROM (${getAllChannels().raw ? '' : ''}) c LEFT JOIN rules r ON r.channel_id = c.id ORDER BY c.added_at DESC`);
}

// HACK: Get channel rules using a different approach
export function getRulesWithChannels() {
  return qall(`SELECT r.*, c.channel_username, c.display_name, c.active as channel_active
    FROM rules r RIGHT JOIN channels c ON c.id = r.channel_id ORDER BY c.channel_username`);
}

export function upsertChannelRule(data) {
  const existing = qget('SELECT id FROM rules WHERE channel_id = ?', [data.channel_id]);
  if (existing) {
    qrun(`UPDATE rules SET min_market_cap=?, max_market_cap=?, min_liquidity=?, max_liquidity=?,
      auto_buy=?, buy_amount_sol=?, slippage=?, anti_mev=?,
      take_profit_percent=?, stop_loss_percent=?, tp_levels=?, priority_fee=?, tip_fee=?, wallet_group_id=?
      WHERE id=?`,
      [data.min_market_cap, data.max_market_cap, data.min_liquidity, data.max_liquidity,
       data.auto_buy ? 1 : 0, data.buy_amount_sol, data.slippage, data.anti_mev ? 1 : 0,
       data.take_profit_percent, data.stop_loss_percent, JSON.stringify(data.tp_levels || []),
       data.priority_fee, data.tip_fee, data.wallet_group_id || 0, existing.id]);
  } else {
    qrun(`INSERT INTO rules (channel_id, min_market_cap, max_market_cap, min_liquidity, max_liquidity,
      auto_buy, buy_amount_sol, slippage, anti_mev, take_profit_percent, stop_loss_percent,
      tp_levels, priority_fee, tip_fee, wallet_group_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [data.channel_id, data.min_market_cap, data.max_market_cap, data.min_liquidity, data.max_liquidity,
       data.auto_buy ? 1 : 0, data.buy_amount_sol, data.slippage, data.anti_mev ? 1 : 0,
       data.take_profit_percent, data.stop_loss_percent, JSON.stringify(data.tp_levels || []),
       data.priority_fee, data.tip_fee, data.wallet_group_id || 0]);
  }
  persist();
}

export function deleteRule(id) { qrun('DELETE FROM rules WHERE id = ?', [id]); persist(); }

// ───── Forwarding ─────
export function getAllForwarding() {
  return qall(`SELECT f.*, c.channel_username FROM forwarding f JOIN channels c ON c.id = f.channel_id`);
}
export function setForwarding(channelId, targetChatId, targetUsername) {
  const ex = qget('SELECT id FROM forwarding WHERE channel_id = ?', [channelId]);
  if (ex) qrun('UPDATE forwarding SET target_chat_id=?, target_chat_username=?, active=1 WHERE id=?', [targetChatId, targetUsername, ex.id]);
  else qrun('INSERT INTO forwarding (channel_id, target_chat_id, target_chat_username) VALUES (?,?,?)', [channelId, targetChatId, targetUsername]);
  persist();
}
export function deleteForward(id) { qrun('DELETE FROM forwarding WHERE id = ?', [id]); persist(); }

// ───── Signals ─────
export function saveSignal(data) {
  qrun(`INSERT INTO signals (token_address,token_symbol,token_name,chain,source_channel,source_text,
    price,market_cap,liquidity,volume_24h,rug_ratio,smart_degen_count,bundler_rate,top10_rate,creator_status,status,sender_username)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [data.token_address, data.token_symbol, data.token_name, data.chain, data.source_channel,
     data.source_text, data.price, data.market_cap, data.liquidity, data.volume_24h,
     data.rug_ratio, data.smart_degen_count, data.bundler_rate, data.top10_rate,
     data.creator_status, data.status || 'pending', data.sender_username || '']);
  persist();
}
export function getRecentSignals(limit = 50) { return qall('SELECT * FROM signals ORDER BY created_at DESC LIMIT ?', [limit]); }
export function getSignalCountToday() { return qget("SELECT COUNT(*) as c FROM signals WHERE created_at > strftime('%s','now','-1 day')").c; }

// ───── Trades ─────
export function createTrade(data) {
  qrun(`INSERT INTO trades (signal_id,wallet_address,token_address,token_symbol,chain,
    buy_amount_sol,buy_price,buy_price_usd,buy_tx,buy_order_id,
    take_profit_percent,stop_loss_percent,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [data.signal_id, data.wallet_address, data.token_address, data.token_symbol, data.chain,
     data.buy_amount_sol, data.buy_price, data.buy_price_usd, data.buy_tx, data.buy_order_id,
     data.take_profit_percent, data.stop_loss_percent, data.status || 'open']);
  persist();
  return qget('SELECT last_insert_rowid() as id').id;
}
export function updateTrade(id, data) {
  const keys = Object.keys(data);
  qrun(`UPDATE trades SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`, [...keys.map(k => data[k]), id]);
  persist();
}
export function getOpenTrades() {
  return qall(`SELECT t.*, s.token_symbol as signal_symbol, s.source_channel
    FROM trades t LEFT JOIN signals s ON s.id = t.signal_id WHERE t.status = 'open' ORDER BY t.created_at DESC`);
}
export function getTradeHistory(limit = 100) {
  return qall(`SELECT t.*, s.token_symbol as signal_symbol, s.source_channel
    FROM trades t LEFT JOIN signals s ON s.id = t.signal_id ORDER BY t.created_at DESC LIMIT ?`, [limit]);
}
export function getTrade(id) {
  return qget(`SELECT t.*, s.token_symbol as signal_symbol, s.source_channel
    FROM trades t LEFT JOIN signals s ON s.id = t.signal_id WHERE t.id = ?`, [id]);
}
export function closeTrade(id, sellData) {
  const trade = getTrade(id);
  if (!trade) return;
  const pnl = sellData.sell_price_usd && trade.buy_price_usd
    ? (sellData.sell_price_usd - trade.buy_price_usd) * (trade.buy_amount_sol / trade.buy_price_usd) : null;
  const pnlPercent = sellData.sell_price_usd && trade.buy_price_usd
    ? ((sellData.sell_price_usd - trade.buy_price_usd) / trade.buy_price_usd) * 100 : null;
  qrun(`UPDATE trades SET sell_amount_sol=?, sell_price=?, sell_price_usd=?,
    sell_tx=?, sell_order_id=?, pnl=?, pnl_percent=?, status='closed', closed_at=strftime('%s','now') WHERE id=?`,
    [sellData.sell_amount_sol, sellData.sell_price, sellData.sell_price_usd,
     sellData.sell_tx, sellData.sell_order_id, pnl, pnlPercent, id]);
  persist();
}

// ───── Wallets ─────
export function getAllWallets() { return qall('SELECT * FROM wallets ORDER BY created_at DESC'); }
export function getActiveWallet() { return qget('SELECT * FROM wallets WHERE active = 1 LIMIT 1'); }
export function addWallet(address, label) {
  const ex = qget('SELECT id FROM wallets');
  qrun('INSERT OR IGNORE INTO wallets (address, label, active) VALUES (?,?,?)', [address, label || '', ex ? 0 : 1]);
  persist();
}
export function importWallets(wallets) {
  for (const w of wallets) addWallet(w.address, w.label);
}
export function removeWallet(id) { qrun('DELETE FROM wallets WHERE id = ?', [id]); persist(); }
export function setActiveWallet(id) { qrun('UPDATE wallets SET active = 0'); qrun('UPDATE wallets SET active = 1 WHERE id = ?', [id]); persist(); }

// ───── Wallet Groups ─────
export function getWalletGroups() {
  return qall(`SELECT wg.*, (SELECT COUNT(*) FROM wallet_group_members wgm WHERE wgm.group_id = wg.id) as member_count FROM wallet_groups wg ORDER BY wg.name`);
}
export function createWalletGroup(name, description) { qrun('INSERT INTO wallet_groups (name, description) VALUES (?,?)', [name, description || '']); persist(); return qget('SELECT last_insert_rowid() as id').id; }
export function deleteWalletGroup(id) { qrun('DELETE FROM wallet_groups WHERE id = ?', [id]); qrun('DELETE FROM wallet_group_members WHERE group_id = ?', [id]); persist(); }
export function getGroupWallets(groupId) { return qall(`SELECT w.* FROM wallets w JOIN wallet_group_members wgm ON wgm.wallet_id = w.id WHERE wgm.group_id = ?`, [groupId]); }
export function addWalletToGroup(groupId, walletId) { qrun('INSERT OR IGNORE INTO wallet_group_members (group_id, wallet_id) VALUES (?,?)', [groupId, walletId]); persist(); }
export function removeWalletFromGroup(groupId, walletId) { qrun('DELETE FROM wallet_group_members WHERE group_id = ? AND wallet_id = ?', [groupId, walletId]); persist(); }

// ───── Strategy Orders ─────
export function saveStrategyOrder(data) {
  qrun(`INSERT INTO strategy_orders (trade_id,wallet_address,token_address,token_symbol,chain,
    order_type,sub_order_type,check_price,amount_in_percent,group_tag,remote_order_id,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [data.trade_id, data.wallet_address, data.token_address, data.token_symbol, data.chain,
     data.order_type, data.sub_order_type, data.check_price, data.amount_in_percent ?? 100,
     data.group_tag, data.remote_order_id, data.status || 'active']);
  persist(); return qget('SELECT last_insert_rowid() as id').id;
}
export function getStrategyOrders(limit = 50) { return qall('SELECT * FROM strategy_orders ORDER BY created_at DESC LIMIT ?', [limit]); }
export function getActiveStrategyOrders() { return qall("SELECT * FROM strategy_orders WHERE status = 'active' ORDER BY created_at DESC"); }
export function updateStrategyOrder(id, data) {
  const keys = Object.keys(data);
  qrun(`UPDATE strategy_orders SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`, [...keys.map(k => data[k]), id]);
  persist();
}
export function cancelStrategyOrderLocal(id) { qrun("UPDATE strategy_orders SET status = 'cancelled' WHERE id = ?", [id]); persist(); }

// ───── Settings ─────
export function getAllSettings() { return qall('SELECT * FROM settings'); }
export function getSetting(key, dv = null) { const r = qget('SELECT value FROM settings WHERE key = ?', [key]); return r ? r.value : dv; }
export function setSetting(key, value) { qrun('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', [key, String(value)]); persist(); }

// ───── Scraper Log ─────
export function addScraperLog(ch, level, msg) { qrun('INSERT INTO scraper_log (channel_username, level, message) VALUES (?,?,?)', [ch, level, msg]); persist(); }
export function getScraperLogs(limit = 100) { return qall('SELECT * FROM scraper_log ORDER BY created_at DESC LIMIT ?', [limit]); }
export function getScraperStatus() {
  return qall(`SELECT c.channel_username, c.display_name, c.active,
    (SELECT COUNT(*) FROM scraper_log sl WHERE sl.channel_username = c.channel_username AND sl.level = 'error') as error_count,
    (SELECT COUNT(*) FROM scraper_log sl WHERE sl.channel_username = c.channel_username) as total_logs,
    (SELECT MAX(created_at) FROM scraper_log sl WHERE sl.channel_username = c.channel_username) as last_activity_at,
    (SELECT COUNT(*) FROM signals s WHERE s.source_channel = c.channel_username) as signal_count,
    (SELECT MAX(created_at) FROM signals s WHERE s.source_channel = c.channel_username) as last_signal_at
    FROM channels c ORDER BY c.channel_username`);
}
