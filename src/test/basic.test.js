import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, unlinkSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { initDatabase, qrun, qall, qget, persist } from '../database.js';

const TEST_DB_PATH = join(process.cwd(), 'data', 'test-sniper.db');

describe('Database', () => {
  before(async () => {
    const dir = join(process.cwd(), 'data');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    await initDatabase();
  });

  after(() => {
    try { rmSync(join(process.cwd(), 'data'), { recursive: true, force: true }); } catch {}
  });

  it('should create tables', () => {
    const tables = qall("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    const names = tables.map(t => t.name);
    assert.ok(names.includes('channels'));
    assert.ok(names.includes('rules'));
    assert.ok(names.includes('signals'));
    assert.ok(names.includes('trades'));
    assert.ok(names.includes('wallets'));
    assert.ok(names.includes('forwarding'));
    assert.ok(names.includes('settings'));
    assert.ok(names.includes('scraper_log'));
  });

  it('should insert and query channel', () => {
    qrun("INSERT OR IGNORE INTO channels (channel_username, display_name) VALUES ('test_channel', 'Test')");
    persist();
    const ch = qget('SELECT * FROM channels WHERE channel_username = ?', ['test_channel']);
    assert.ok(ch);
    assert.equal(ch.channel_username, 'test_channel');
    assert.equal(ch.display_name, 'Test');
  });

  it('should insert and query rule with sender_filter', () => {
    qrun("INSERT OR IGNORE INTO channels (channel_username) VALUES ('rule_test_chan')");
    const ch = qget("SELECT id FROM channels WHERE channel_username = 'rule_test_chan'");
    qrun('INSERT INTO rules (channel_id, name, sender_filter) VALUES (?, ?, ?)', [ch.id, 'test-rule', '@trader1']);
    const rule = qget('SELECT * FROM rules WHERE name = ?', ['test-rule']);
    assert.equal(rule.sender_filter, '@trader1');
  });

  it('should insert signal with sender_username', () => {
    qrun(`INSERT INTO signals (token_address, source_channel, sender_username, status)
      VALUES ('abc123', 'test_channel', 'trader1', 'pending')`);
    const sig = qget("SELECT * FROM signals WHERE sender_username = 'trader1'");
    assert.ok(sig);
    assert.equal(sig.sender_username, 'trader1');
  });

  it('should log scraper activity', () => {
    qrun("INSERT INTO scraper_log (channel_username, level, message) VALUES ('test_channel', 'info', 'test message')");
    const logs = qall('SELECT * FROM scraper_log ORDER BY created_at DESC');
    assert.ok(logs.length > 0);
    assert.equal(logs[0].message, 'test message');
  });
});

describe('Config', () => {
  it('should load config module without errors', async () => {
    const { config, validateConfig } = await import('../config.js');
    assert.ok(config);
    assert.equal(typeof config.server.port, 'number');
    assert.equal(typeof validateConfig, 'function');
  });
});

describe('GMGN Module', () => {
  it('should export all functions', async () => {
    const gmgn = await import('../gmgn.js');
    assert.equal(typeof gmgn.extractAddresses, 'function');
    assert.equal(typeof gmgn.getTrending, 'function');
    assert.equal(typeof gmgn.getTokenInfo, 'function');
    assert.equal(typeof gmgn.getTokenSecurity, 'function');
    assert.equal(typeof gmgn.executeSwap, 'function');
    assert.equal(typeof gmgn.getOrder, 'function');
  });

  it('should extract Solana addresses from text', async () => {
    const { extractAddresses } = await import('../gmgn.js');
    const text = 'Check this token: 5Q544fKrFoe6JvYKvKT9E7NzJzYpvzJQyKkPfCUxqWtL';
    const result = extractAddresses(text);
    assert.ok(result.length > 0);
    assert.equal(result[0].chain, 'sol');
    assert.equal(result[0].address.length, 44);
  });
});

describe('Web Server', () => {
  it('should create Express app without errors', async () => {
    const { createWebServer } = await import('../web-server.js');
    const app = createWebServer();
    assert.ok(app);
    assert.equal(typeof app.listen, 'function');
  });
});
