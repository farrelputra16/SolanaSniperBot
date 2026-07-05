import { MongoClient } from 'mongodb';

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || '';
const DB_NAME = 'scoopscraper';

let mdb = null;
let collections = {};

// ───── SQLite fallback (for tests / no-MONGO env) ─────
let sqliteDb = null;
let sqliteMode = false;
let _currentTgId = '';

export function setTelegramId(id) { _currentTgId = id || ''; }
export function getTelegramId() { return _currentTgId; }
function _tid() { return _currentTgId; }

async function ensureSqlite() {
  if (sqliteDb) return;
  const Database = (await import('better-sqlite3')).default;
  const { join } = await import('path');
  const { existsSync, mkdirSync } = await import('fs');
  const dir = join(process.cwd(), 'data');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  sqliteDb = new Database(join(dir, 'sniper.db'));
  sqliteDb.pragma('journal_mode = WAL');
}

function sqliteNow() { return Math.floor(Date.now() / 1000); }

export async function initDatabase() {
  if (MONGO_URI) {
    try {
      const client = new MongoClient(MONGO_URI);
      await client.connect();
      mdb = client.db(DB_NAME);
      collections = {
        channels: mdb.collection('channels'),
        rules: mdb.collection('rules'),
        signals: mdb.collection('signals'),
        trades: mdb.collection('trades'),
        scraper_logs: mdb.collection('scraper_logs'),
        wallets: mdb.collection('wallets'),
        wallet_groups: mdb.collection('wallet_groups'),
        wallet_group_members: mdb.collection('wallet_group_members'),
        strategy_orders: mdb.collection('strategy_orders'),
        settings: mdb.collection('settings'),
        counters: mdb.collection('counters'),
      };
      for (const c of Object.values(collections)) {
        try { await c.createIndex('id', { unique: true }); } catch {}
      }
      try { await collections.channels.createIndex({ channel_username: 1 }, { unique: true, sparse: true }); } catch {}
      try { await collections.signals.createIndex({ created_at: -1 }); } catch {}
      try { await collections.trades.createIndex({ status: 1 }); } catch {}
      try { await collections.wallets.createIndex({ address: 1 }, { unique: true, sparse: true }); } catch {}
      try { await collections.wallet_group_members.createIndex({ group_id: 1, wallet_id: 1 }, { unique: true }); } catch {}
      console.log('[DB] Connected to MongoDB');
      return;
    } catch (e) {
      console.error('[DB] MongoDB connection failed:', e.message, '— falling back to SQLite');
    }
  }

  // SQLite fallback
  sqliteMode = true;
  await ensureSqlite();
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS channels (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_username TEXT UNIQUE, display_name TEXT DEFAULT '', active INTEGER DEFAULT 1, added_at INTEGER DEFAULT (strftime('%s','now')));
    CREATE TABLE IF NOT EXISTS rules (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id INTEGER UNIQUE, min_market_cap REAL, max_market_cap REAL, min_liquidity REAL, max_liquidity REAL, auto_buy INTEGER DEFAULT 0, buy_amount_sol REAL DEFAULT 0.01, slippage INTEGER DEFAULT 30, anti_mev INTEGER DEFAULT 1, take_profit_percent REAL, stop_loss_percent REAL, tp_levels TEXT DEFAULT '[]', priority_fee INTEGER, tip_fee INTEGER, wallet_group_id INTEGER DEFAULT 0, track_only INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS signals (id INTEGER PRIMARY KEY AUTOINCREMENT, token_address TEXT, token_symbol TEXT, token_name TEXT, chain TEXT DEFAULT 'sol', source_channel TEXT, source_text TEXT, price REAL, market_cap REAL, liquidity REAL, volume_24h REAL, rug_ratio REAL, smart_degen_count INTEGER DEFAULT 0, bundler_rate REAL, top10_rate REAL, creator_status TEXT, is_honeypot TEXT, sender_username TEXT DEFAULT '', created_at INTEGER DEFAULT (strftime('%s','now')));
    CREATE TABLE IF NOT EXISTS trades (id INTEGER PRIMARY KEY AUTOINCREMENT, signal_id INTEGER, wallet_address TEXT, token_address TEXT, token_symbol TEXT, chain TEXT DEFAULT 'sol', buy_amount_sol REAL, buy_price REAL, buy_price_usd REAL, buy_order_id TEXT, buy_status TEXT DEFAULT 'pending', buy_tx TEXT DEFAULT '', take_profit_percent REAL, stop_loss_percent REAL, source_channel TEXT DEFAULT '', status TEXT DEFAULT 'open', pnl REAL, pnl_percent REAL, sell_amount_sol REAL, sell_price REAL, sell_price_usd REAL, sell_tx TEXT, sell_order_id TEXT, closed_at INTEGER, created_at INTEGER DEFAULT (strftime('%s','now')));
    CREATE TABLE IF NOT EXISTS wallets (id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT UNIQUE, label TEXT DEFAULT '', private_key TEXT DEFAULT '', active INTEGER DEFAULT 0, created_at INTEGER DEFAULT (strftime('%s','now')));
    CREATE TABLE IF NOT EXISTS wallet_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, description TEXT DEFAULT '');
    CREATE TABLE IF NOT EXISTS wallet_group_members (group_id INTEGER, wallet_id INTEGER, UNIQUE(group_id, wallet_id));
    CREATE TABLE IF NOT EXISTS strategy_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, trade_id INTEGER, wallet_address TEXT, token_address TEXT, token_symbol TEXT, chain TEXT DEFAULT 'sol', order_type TEXT, sub_order_type TEXT, check_price REAL, amount_in_percent REAL DEFAULT 100, group_tag TEXT, remote_order_id TEXT, status TEXT DEFAULT 'active', created_at INTEGER DEFAULT (strftime('%s','now')));
    CREATE TABLE IF NOT EXISTS scraper_log (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_username TEXT, level TEXT, message TEXT, created_at INTEGER DEFAULT (strftime('%s','now')));
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  `);
  // Migrations
  for (const sql of [
    "ALTER TABLE rules ADD COLUMN track_only INTEGER DEFAULT 0",
    "ALTER TABLE signals ADD COLUMN latency_ms INTEGER DEFAULT 0",
    "ALTER TABLE trades ADD COLUMN signal_latency_ms INTEGER DEFAULT 0",
    "ALTER TABLE trades ADD COLUMN buy_latency_ms INTEGER DEFAULT 0",
    "ALTER TABLE channels ADD COLUMN telegram_id TEXT DEFAULT ''",
    "ALTER TABLE rules ADD COLUMN telegram_id TEXT DEFAULT ''",
    "ALTER TABLE signals ADD COLUMN telegram_id TEXT DEFAULT ''",
    "ALTER TABLE trades ADD COLUMN telegram_id TEXT DEFAULT ''",
    "ALTER TABLE wallets ADD COLUMN telegram_id TEXT DEFAULT ''",
    "ALTER TABLE wallet_groups ADD COLUMN telegram_id TEXT DEFAULT ''",
    "ALTER TABLE strategy_orders ADD COLUMN telegram_id TEXT DEFAULT ''",
    "ALTER TABLE scraper_log ADD COLUMN telegram_id TEXT DEFAULT ''",
  ]) { try { sqliteDb.exec(sql); } catch {} }
  try { sqliteDb.exec("ALTER TABLE wallets ADD COLUMN private_key TEXT DEFAULT ''"); } catch {}
  try { sqliteDb.exec("ALTER TABLE settings ADD COLUMN telegram_id TEXT DEFAULT ''"); } catch {}
  console.log('[DB] Using SQLite');
}

// ───── Helpers ─────
async function nextId(seqName) {
  if (!sqliteMode && mdb) {
    const counter = await collections.counters.findOneAndUpdate(
      { _id: seqName },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: 'after' }
    );
    return (counter?.seq || 1);
  }
  const row = sqliteDb.prepare(`INSERT INTO ${seqName} (id) VALUES (NULL)`).run();
  return Number(row.lastInsertRowid);
}

// ───── Channels ─────
export async function getActiveChannels() {
  if (!sqliteMode && mdb) return collections.channels.find({ active: 1 }).toArray();
  return sqliteDb.prepare('SELECT * FROM channels WHERE active = 1').all();
}
export async function getAllChannels() {
  if (!sqliteMode && mdb) {
    return collections.channels.aggregate([
      { $lookup: { from: 'signals', localField: 'channel_username', foreignField: 'source_channel', as: 'sd' } },
      { $addFields: { signal_count: { $size: '$sd' }, last_signal_at: { $max: '$sd.created_at' } } },
      { $project: { sd: 0 } }, { $sort: { added_at: -1 } }
    ]).toArray();
  }
  return sqliteDb.prepare(`SELECT c.*, (SELECT COUNT(*) FROM signals s WHERE s.source_channel = c.channel_username) as signal_count, (SELECT MAX(created_at) FROM signals s WHERE s.source_channel = c.channel_username) as last_signal_at FROM channels c ORDER BY c.added_at DESC`).all();
}
export async function addChannel(username, displayName) {
  if (!sqliteMode && mdb) {
    try { await collections.channels.insertOne({ channel_username: username, display_name: displayName || username, active: 1, added_at: sqliteNow() }); } catch (e) { if (e.code !== 11000) throw e; }
    return;
  }
  try { sqliteDb.prepare('INSERT OR IGNORE INTO channels (channel_username, display_name, telegram_id) VALUES (?,?,?)').run(username, displayName || username, _tid()); } catch {}
}
export async function removeChannel(id) {
  if (!sqliteMode && mdb) { await collections.channels.deleteOne({ id: Number(id) }); await collections.rules.deleteOne({ channel_id: Number(id) }); return; }
  sqliteDb.prepare('DELETE FROM channels WHERE id = ?').run(Number(id));
  sqliteDb.prepare('DELETE FROM rules WHERE channel_id = ?').run(Number(id));
}
export async function toggleChannel(id, active) {
  if (!sqliteMode && mdb) { await collections.channels.updateOne({ id: Number(id) }, { $set: { active: active ? 1 : 0 } }); return; }
  sqliteDb.prepare('UPDATE channels SET active = ? WHERE id = ?').run(active ? 1 : 0, Number(id));
}
export async function getChannel(id) {
  if (!sqliteMode && mdb) return collections.channels.findOne({ id: Number(id) });
  return sqliteDb.prepare('SELECT * FROM channels WHERE id = ?').get(Number(id)) || null;
}
export async function getChannelWithRule(id) {
  if (!sqliteMode && mdb) {
    const ch = await collections.channels.findOne({ id: Number(id) });
    if (!ch) return null;
    const rule = await collections.rules.findOne({ channel_id: Number(id) });
    return { ...ch, rule: rule || null };
  }
  const ch = sqliteDb.prepare('SELECT * FROM channels WHERE id = ?').get(Number(id));
  if (!ch) return null;
  const rule = sqliteDb.prepare('SELECT * FROM rules WHERE channel_id = ?').get(Number(id));
  return { ...ch, rule: rule || null };
}

// ───── Rules ─────
export async function getChannelRules() {
  if (!sqliteMode && mdb) return collections.rules.find().toArray();
  return sqliteDb.prepare('SELECT * FROM rules').all();
}
export async function getRulesWithChannels() {
  if (!sqliteMode && mdb) {
    return collections.rules.aggregate([
      { $lookup: { from: 'channels', localField: 'channel_id', foreignField: 'id', as: 'ch' } },
      { $unwind: { path: '$ch', preserveNullAndEmptyArrays: true } }
    ]).toArray();
  }
  return sqliteDb.prepare('SELECT r.*, c.channel_username, c.display_name, c.active as channel_active FROM rules r RIGHT JOIN channels c ON c.id = r.channel_id ORDER BY c.channel_username').all();
}
export async function upsertChannelRule(data) {
  const channelId = Number(data.channel_id);
  if (!sqliteMode && mdb) {
    const doc = {
      channel_id: channelId,
      min_market_cap: data.min_market_cap ?? null,
      max_market_cap: data.max_market_cap ?? null,
      min_liquidity: data.min_liquidity ?? null,
      max_liquidity: data.max_liquidity ?? null,
      auto_buy: data.auto_buy ? 1 : 0,
      buy_amount_sol: data.buy_amount_sol ?? 0.01,
      slippage: data.slippage ?? 30,
      anti_mev: data.anti_mev ? 1 : 0,
      take_profit_percent: data.take_profit_percent ?? null,
      stop_loss_percent: data.stop_loss_percent ?? null,
      tp_levels: data.tp_levels || [],
      priority_fee: data.priority_fee ?? null,
      tip_fee: data.tip_fee ?? null,
      wallet_group_id: data.wallet_group_id || 0,
      track_only: data.track_only ? 1 : 0,
    };
    const existing = await collections.rules.findOne({ channel_id: channelId });
    if (existing) await collections.rules.updateOne({ _id: existing._id }, { $set: doc });
    else await collections.rules.insertOne(doc);
    return;
  }
  const existing = sqliteDb.prepare('SELECT id FROM rules WHERE channel_id = ?').get(channelId);
  const tpStr = JSON.stringify(data.tp_levels || []);
  if (existing) {
    sqliteDb.prepare(`UPDATE rules SET min_market_cap=?, max_market_cap=?, min_liquidity=?, max_liquidity=?,
      auto_buy=?, buy_amount_sol=?, slippage=?, anti_mev=?,
      take_profit_percent=?, stop_loss_percent=?, tp_levels=?, priority_fee=?, tip_fee=?,
      wallet_group_id=?, track_only=? WHERE id=?`).run(
      data.min_market_cap ?? null, data.max_market_cap ?? null, data.min_liquidity ?? null, data.max_liquidity ?? null,
      data.auto_buy ? 1 : 0, data.buy_amount_sol ?? 0.01, data.slippage ?? 30, data.anti_mev ? 1 : 0,
      data.take_profit_percent ?? null, data.stop_loss_percent ?? null, tpStr,
      data.priority_fee ?? null, data.tip_fee ?? null, data.wallet_group_id || 0,
      data.track_only ? 1 : 0, existing.id);
  } else {
    sqliteDb.prepare(`INSERT INTO rules (channel_id, min_market_cap, max_market_cap, min_liquidity, max_liquidity,
      auto_buy, buy_amount_sol, slippage, anti_mev, take_profit_percent, stop_loss_percent,
      tp_levels, priority_fee, tip_fee, wallet_group_id, track_only)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      channelId, data.min_market_cap ?? null, data.max_market_cap ?? null, data.min_liquidity ?? null, data.max_liquidity ?? null,
      data.auto_buy ? 1 : 0, data.buy_amount_sol ?? 0.01, data.slippage ?? 30, data.anti_mev ? 1 : 0,
      data.take_profit_percent ?? null, data.stop_loss_percent ?? null, tpStr,
      data.priority_fee ?? null, data.tip_fee ?? null, data.wallet_group_id || 0,
      data.track_only ? 1 : 0);
  }
}
export async function deleteRule(id) {
  if (!sqliteMode && mdb) { await collections.rules.deleteOne({ id: Number(id) }); return; }
  sqliteDb.prepare('DELETE FROM rules WHERE id = ?').run(Number(id));
}
export async function getAutoBuyRules() {
  if (!sqliteMode && mdb) {
    const rules = await collections.rules.find({ auto_buy: 1 }).toArray();
    const results = [];
    for (const r of rules) {
      const ch = await collections.channels.findOne({ id: r.channel_id });
      if (ch) results.push({ ...r, channel_username: ch.channel_username });
    }
    return results;
  }
  return sqliteDb.prepare('SELECT r.*, c.channel_username FROM rules r JOIN channels c ON c.id = r.channel_id WHERE r.auto_buy = 1').all();
}

// ───── Wallets ─────
export async function getAllWallets() {
  if (!sqliteMode && mdb) return collections.wallets.find().sort({ created_at: -1 }).toArray();
  return sqliteDb.prepare('SELECT * FROM wallets ORDER BY created_at DESC').all();
}
export async function getActiveWallet() {
  if (!sqliteMode && mdb) return collections.wallets.findOne({ active: 1 });
  return sqliteDb.prepare('SELECT * FROM wallets WHERE active = 1 LIMIT 1').get() || null;
}
export async function addWallet(address, label, privateKey) {
  if (!sqliteMode && mdb) {
    const existing = await collections.wallets.findOne({});
    try {
      await collections.wallets.insertOne({
        address, label: label || '', private_key: privateKey || '',
        active: existing ? 0 : 1, created_at: sqliteNow()
      });
    } catch (e) { if (e.code !== 11000) throw e; }
    return;
  }
  const ex = sqliteDb.prepare('SELECT id FROM wallets LIMIT 1').get();
  sqliteDb.prepare('INSERT OR IGNORE INTO wallets (address, label, private_key, active, telegram_id) VALUES (?,?,?,?,?)').run(address, label || '', privateKey || '', ex ? 0 : 1, _tid());
}
export async function importWallets(wallets) {
  if (!sqliteMode && mdb) {
    const existing = await collections.wallets.findOne({});
    for (let i = 0; i < wallets.length; i++) {
      try {
        await collections.wallets.insertOne({
          address: wallets[i].address, label: wallets[i].label || '',
          private_key: wallets[i].private_key || '',
          active: (!existing && i === 0) ? 1 : 0, created_at: sqliteNow()
        });
      } catch (e) { if (e.code !== 11000) throw e; }
    }
    return;
  }
  const ex = sqliteDb.prepare('SELECT id FROM wallets').get();
  const stmt = sqliteDb.prepare('INSERT OR IGNORE INTO wallets (address, label, private_key, active) VALUES (?,?,?,?)');
  for (let i = 0; i < wallets.length; i++) {
    stmt.run(wallets[i].address, wallets[i].label || '', wallets[i].private_key || '', (ex && i > 0) ? 0 : 1);
  }
}
export async function removeWallet(id) {
  if (!sqliteMode && mdb) { await collections.wallets.deleteOne({ id: Number(id) }); return; }
  sqliteDb.prepare('DELETE FROM wallets WHERE id = ?').run(Number(id));
}
export async function setActiveWallet(id) {
  if (!sqliteMode && mdb) {
    await collections.wallets.updateMany({}, { $set: { active: 0 } });
    await collections.wallets.updateOne({ id: Number(id) }, { $set: { active: 1 } });
    return;
  }
  sqliteDb.prepare('UPDATE wallets SET active = 0').run();
  sqliteDb.prepare('UPDATE wallets SET active = 1 WHERE id = ?').run(Number(id));
}
export async function getWallet(id) {
  if (!sqliteMode && mdb) return collections.wallets.findOne({ id: Number(id) });
  return sqliteDb.prepare('SELECT * FROM wallets WHERE id = ?').get(Number(id)) || null;
}
export async function getWalletByAddress(address) {
  if (!sqliteMode && mdb) return collections.wallets.findOne({ address });
  return sqliteDb.prepare('SELECT * FROM wallets WHERE address = ?').get(address) || null;
}

// ───── Wallet Groups ─────
export async function getWalletGroups() {
  if (!sqliteMode && mdb) {
    return collections.wallet_groups.aggregate([
      { $lookup: { from: 'wallet_group_members', localField: 'id', foreignField: 'group_id', as: '_m' } },
      { $addFields: { member_count: { $size: '$_m' } } },
      { $project: { _m: 0 } }, { $sort: { name: 1 } }
    ]).toArray();
  }
  return sqliteDb.prepare('SELECT wg.*, (SELECT COUNT(*) FROM wallet_group_members wgm WHERE wgm.group_id = wg.id) as member_count FROM wallet_groups wg ORDER BY wg.name').all();
}
export async function createWalletGroup(name, description) {
  if (!sqliteMode && mdb) {
    const id = await nextId('wallet_groups');
    await collections.wallet_groups.insertOne({ id, name, description: description || '' });
    return id;
  }
  sqliteDb.prepare('INSERT INTO wallet_groups (name, description) VALUES (?,?)').run(name, description || '');
  return sqliteDb.prepare('SELECT last_insert_rowid() as id').get().id;
}
export async function deleteWalletGroup(id) {
  const nid = Number(id);
  if (!sqliteMode && mdb) { await collections.wallet_groups.deleteOne({ id: nid }); await collections.wallet_group_members.deleteMany({ group_id: nid }); return; }
  sqliteDb.prepare('DELETE FROM wallet_groups WHERE id = ?').run(nid);
  sqliteDb.prepare('DELETE FROM wallet_group_members WHERE group_id = ?').run(nid);
}
export async function getGroupWallets(groupId) {
  if (!sqliteMode && mdb) {
    const members = await collections.wallet_group_members.find({ group_id: Number(groupId) }).toArray();
    const walletIds = members.map(m => m.wallet_id);
    return collections.wallets.find({ id: { $in: walletIds } }).toArray();
  }
  return sqliteDb.prepare('SELECT w.* FROM wallets w JOIN wallet_group_members wgm ON wgm.wallet_id = w.id WHERE wgm.group_id = ?').all(Number(groupId));
}
export async function addWalletToGroup(groupId, walletId) {
  if (!sqliteMode && mdb) { try { await collections.wallet_group_members.insertOne({ group_id: Number(groupId), wallet_id: Number(walletId) }); } catch { return; } return; }
  sqliteDb.prepare('INSERT OR IGNORE INTO wallet_group_members (group_id, wallet_id) VALUES (?,?)').run(Number(groupId), Number(walletId));
}
export async function removeWalletFromGroup(groupId, walletId) {
  if (!sqliteMode && mdb) { await collections.wallet_group_members.deleteOne({ group_id: Number(groupId), wallet_id: Number(walletId) }); return; }
  sqliteDb.prepare('DELETE FROM wallet_group_members WHERE group_id = ? AND wallet_id = ?').run(Number(groupId), Number(walletId));
}

// ───── Signals ─────
export async function saveSignal(data) {
  if (!sqliteMode && mdb) {
    await collections.signals.insertOne({
      token_address: data.token_address, token_symbol: data.token_symbol || '',
      token_name: data.token_name || '', chain: data.chain || 'sol',
      source_channel: data.source_channel, source_text: data.source_text || '',
      price: data.price || 0, market_cap: data.market_cap || 0,
      liquidity: data.liquidity || 0, volume_24h: data.volume_24h || 0,
      rug_ratio: data.rug_ratio ?? -1, smart_degen_count: data.smart_degen_count || 0,
      bundler_rate: data.bundler_rate || 0, top10_rate: data.top10_rate || 0,
      creator_status: data.creator_status || '', is_honeypot: data.is_honeypot || '',
      sender_username: data.sender_username || '', created_at: sqliteNow()
    });
    return;
  }
  sqliteDb.prepare(`INSERT INTO signals (token_address, token_symbol, token_name, chain, source_channel, source_text, price, market_cap, liquidity, volume_24h, rug_ratio, smart_degen_count, bundler_rate, top10_rate, creator_status, is_honeypot, sender_username, latency_ms, telegram_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    data.token_address, data.token_symbol || '', data.token_name || '', data.chain || 'sol',
    data.source_channel, data.source_text || '', data.price || 0, data.market_cap || 0,
    data.liquidity || 0, data.volume_24h || 0, data.rug_ratio ?? -1, data.smart_degen_count || 0,
    data.bundler_rate || 0, data.top10_rate || 0, data.creator_status || '', data.is_honeypot || '',
    data.sender_username || '', data.latency_ms || 0, _tid(), sqliteNow()
  );
}
export async function getRecentSignals(limit) {
  if (!sqliteMode && mdb) return collections.signals.find().sort({ created_at: -1 }).limit(limit).toArray();
  return sqliteDb.prepare('SELECT * FROM signals ORDER BY created_at DESC LIMIT ?').all(limit);
}
export async function getSignalCountToday() {
  const start = sqliteNow() - 86400;
  if (!sqliteMode && mdb) return collections.signals.countDocuments({ created_at: { $gte: start } });
  return sqliteDb.prepare('SELECT COUNT(*) as cnt FROM signals WHERE created_at >= ?').get(start).cnt;
}

// ───── Trades ─────
export async function createTrade(data) {
  if (!sqliteMode && mdb) {
    const res = await collections.trades.insertOne({
      signal_id: data.signal_id || null,
      wallet_address: data.wallet_address || '', token_address: data.token_address || '',
      token_symbol: data.token_symbol || '', chain: data.chain || 'sol',
      buy_amount_sol: data.buy_amount_sol || 0, buy_price: data.buy_price || 0,
      buy_price_usd: data.buy_price_usd || 0, buy_order_id: data.buy_order_id || '',
      buy_status: data.buy_status || 'pending', buy_tx: data.buy_tx || '',
      take_profit_percent: data.take_profit_percent || null,
      stop_loss_percent: data.stop_loss_percent || null,
      source_channel: data.source_channel || '',
      status: data.status || 'open', pnl: null, pnl_percent: null,
      sell_amount_sol: null, sell_price: null, sell_price_usd: null, sell_tx: null,
      sell_order_id: null, closed_at: null, created_at: sqliteNow()
    });
    return res.insertedId.toString();
  }
  const info = sqliteDb.prepare(`INSERT INTO trades (signal_id,wallet_address,token_address,token_symbol,chain,buy_amount_sol,buy_price,buy_price_usd,buy_order_id,signal_latency_ms,buy_latency_ms,telegram_id,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    data.signal_id, data.wallet_address, data.token_address, data.token_symbol, data.chain,
    data.buy_amount_sol, data.buy_price, data.buy_price_usd, data.buy_order_id,
    data.signal_latency_ms || 0, data.buy_latency_ms || 0, _tid(),
    data.status || 'open', sqliteNow()
  );
  return Number(info.lastInsertRowid);
}
export async function getOpenTrades() {
  if (!sqliteMode && mdb) return collections.trades.find({ status: 'open' }).sort({ created_at: -1 }).toArray();
  return sqliteDb.prepare("SELECT * FROM trades WHERE status = 'open' ORDER BY created_at DESC").all();
}
export async function getTradeHistory(limit) {
  if (!sqliteMode && mdb) return collections.trades.find().sort({ created_at: -1 }).limit(limit).toArray();
  return sqliteDb.prepare('SELECT * FROM trades ORDER BY created_at DESC LIMIT ?').all(limit);
}
export async function getTrade(id) {
  if (!sqliteMode && mdb) return collections.trades.findOne({ id: Number(id) });
  return sqliteDb.prepare('SELECT * FROM trades WHERE id = ?').get(Number(id)) || null;
}
export async function closeTrade(id, data) {
  if (!sqliteMode && mdb) {
    await collections.trades.updateOne({ id: Number(id) }, { $set: { status: 'closed', closed_at: sqliteNow(), ...data } });
    return;
  }
  sqliteDb.prepare("UPDATE trades SET status='closed', closed_at=?, sell_amount_sol=?, sell_price=?, sell_price_usd=?, sell_tx=?, sell_order_id=? WHERE id=?").run(
    sqliteNow(), data.sell_amount_sol || null, data.sell_price || null, data.sell_price_usd || null, data.sell_tx || '', data.sell_order_id || '', Number(id)
  );
}
export async function updateTrade(id, data) {
  if (!sqliteMode && mdb) { await collections.trades.updateOne({ id: Number(id) }, { $set: data }); return; }
  const keys = Object.keys(data);
  sqliteDb.prepare(`UPDATE trades SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`).run(...keys.map(k => data[k]), Number(id));
}

// ───── Strategy Orders ─────
export async function saveStrategyOrder(data) {
  if (!sqliteMode && mdb) {
    const res = await collections.strategy_orders.insertOne({
      trade_id: data.trade_id || null, wallet_address: data.wallet_address || '',
      token_address: data.token_address || '', token_symbol: data.token_symbol || '',
      chain: data.chain || 'sol', order_type: data.order_type || '',
      sub_order_type: data.sub_order_type || '', check_price: data.check_price || 0,
      amount_in_percent: data.amount_in_percent || 100, group_tag: data.group_tag || '',
      remote_order_id: data.remote_order_id || '', status: data.status || 'active',
      created_at: sqliteNow()
    });
    return res.insertedId.toString();
  }
  const info = sqliteDb.prepare(`INSERT INTO strategy_orders (trade_id,wallet_address,token_address,token_symbol,chain,order_type,sub_order_type,check_price,amount_in_percent,group_tag,remote_order_id,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    data.trade_id, data.wallet_address, data.token_address, data.token_symbol, data.chain,
    data.order_type, data.sub_order_type, data.check_price, data.amount_in_percent || 100,
    data.group_tag, data.remote_order_id, data.status || 'active', sqliteNow()
  );
  return Number(info.lastInsertRowid);
}
export async function getStrategyOrders() {
  if (!sqliteMode && mdb) return collections.strategy_orders.find().sort({ created_at: -1 }).toArray();
  return sqliteDb.prepare('SELECT * FROM strategy_orders ORDER BY created_at DESC').all();
}
export async function getActiveStrategyOrders() {
  if (!sqliteMode && mdb) return collections.strategy_orders.find({ status: 'active' }).sort({ created_at: -1 }).toArray();
  return sqliteDb.prepare("SELECT * FROM strategy_orders WHERE status = 'active' ORDER BY created_at DESC").all();
}
export async function updateStrategyOrder(id, data) {
  if (!sqliteMode && mdb) { await collections.strategy_orders.updateOne({ id: Number(id) }, { $set: data }); return; }
  const keys = Object.keys(data);
  sqliteDb.prepare(`UPDATE strategy_orders SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`).run(...keys.map(k => data[k]), Number(id));
}
export async function cancelStrategyOrderLocal(id) {
  if (!sqliteMode && mdb) { await collections.strategy_orders.updateOne({ id: Number(id) }, { $set: { status: 'cancelled' } }); return; }
  sqliteDb.prepare("UPDATE strategy_orders SET status = 'cancelled' WHERE id = ?").run(Number(id));
}

// ───── Scraper Logs ─────
export async function addScraperLog(ch, level, msg) {
  try {
    if (!sqliteMode && mdb) {
      await collections.scraper_logs.insertOne({
        channel_username: String(ch || ''), level: String(level || 'info'),
        message: String(msg || ''), created_at: sqliteNow()
      });
      return;
    }
    sqliteDb.prepare('INSERT INTO scraper_log (channel_username, level, message, created_at) VALUES (?,?,?,?)').run(String(ch || ''), String(level || 'info'), String(msg || ''), sqliteNow());
  } catch (e) { console.error('[DB] addScraperLog error:', e.message); }
}
export async function getScraperLogs(limit) {
  if (!sqliteMode && mdb) return collections.scraper_logs.find().sort({ created_at: -1 }).limit(limit).toArray();
  return sqliteDb.prepare('SELECT * FROM scraper_log ORDER BY created_at DESC LIMIT ?').all(limit);
}
export async function getScraperStatus() {
  if (!sqliteMode && mdb) {
    const last = await collections.scraper_logs.find().sort({ created_at: -1 }).limit(1).toArray();
    const total = await collections.scraper_logs.countDocuments();
    return { lastLog: last[0] || null, totalLogs: total };
  }
  const last = sqliteDb.prepare('SELECT * FROM scraper_log ORDER BY created_at DESC LIMIT 1').get();
  const total = sqliteDb.prepare('SELECT COUNT(*) as cnt FROM scraper_log').get().cnt;
  return { lastLog: last || null, totalLogs: total };
}

// ───── Settings ─────
export async function getAllSettings() {
  if (!sqliteMode && mdb) {
    const docs = await collections.settings.find().toArray();
    const s = {};
    for (const d of docs) s[d.key] = d.value;
    return s;
  }
  return sqliteDb.prepare('SELECT * FROM settings').all();
}
export async function getSetting(key, dv = null) {
  if (!sqliteMode && mdb) { const d = await collections.settings.findOne({ key }); return d ? d.value : dv; }
  const r = sqliteDb.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : dv;
}
export async function setSetting(key, value) {
  if (!sqliteMode && mdb) { await collections.settings.updateOne({ key }, { $set: { key, value: String(value) } }, { upsert: true }); return; }
  sqliteDb.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)').run(key, String(value));
}

// ───── Legacy / Unused ─────
export async function getTelegramSessions() { return []; }
export async function getTelegramSession(id) { return null; }
export async function createTelegramSession(data) { return 0; }
export async function updateTelegramSession(id, data) {}
export async function deleteTelegramSession(id) {}
export async function getActiveTelegramSession() { return null; }
export async function setActiveTelegramSession(id) {}
