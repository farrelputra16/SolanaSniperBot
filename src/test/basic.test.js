import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'fs';
import { join } from 'path';
import * as db from '../database.js';

describe('Database', () => {
  before(async () => {
    const dir = join(process.cwd(), 'data');
    try { mkdirSync(dir, { recursive: true }); } catch {}
    await db.initDatabase();
  });

  it('should insert and query channel', async () => {
    await db.addChannel('test_channel', 'Test');
    const channels = await db.getAllChannels();
    const ch = channels.find(c => c.channel_username === 'test_channel');
    assert.ok(ch);
    assert.equal(ch.channel_username, 'test_channel');
    assert.equal(ch.display_name, 'Test');
  });

  it('should insert and query rule with sender_filter', async () => {
    await db.addChannel('rule_test_chan', 'RuleTest');
    const channels = await db.getAllChannels();
    const ch = channels.find(c => c.channel_username === 'rule_test_chan');
    assert.ok(ch);
    await db.upsertChannelRule({
      channel_id: ch.id,
      sender_filter: '@trader1',
      buy_amount_sol: 0.01,
      slippage: 30,
      anti_mev: true,
    });
    const rules = await db.getChannelRules();
    const rule = rules.find(r => r.channel_id === ch.id);
    assert.ok(rule);
    assert.equal(rule.track_only, 0);
  });

  it('should insert signal with sender_username', async () => {
    await db.saveSignal({
      token_address: 'abc123',
      source_channel: 'test_channel',
      sender_username: 'trader1',
      chain: 'sol',
    });
    const signals = await db.getRecentSignals(10);
    const sig = signals.find(s => s.token_address === 'abc123');
    assert.ok(sig);
    assert.equal(sig.sender_username, 'trader1');
  });

  it('should log scraper activity', async () => {
    await db.addScraperLog('test_channel', 'info', 'test message');
    const logs = await db.getScraperLogs(10);
    assert.ok(logs.length > 0);
    const found = logs.find(l => l.message === 'test message');
    assert.ok(found);
  });

  it('should add and activate wallets', async () => {
    await db.addWallet('wallet1addr', 'Wallet 1', 'privkey1');
    await db.addWallet('wallet2addr', 'Wallet 2', 'privkey2');
    const all = await db.getAllWallets();
    assert.ok(all.length >= 2);
    const w1 = all.find(w => w.address === 'wallet1addr');
    assert.ok(w1);
    assert.equal(w1.private_key, 'privkey1');
    const active = await db.getActiveWallet();
    assert.ok(active);
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
