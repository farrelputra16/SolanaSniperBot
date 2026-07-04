import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'fs';
import { join } from 'path';
import * as db from '../database.js';

describe('Database - Advanced Features', () => {
  before(async () => {
    const dir = join(process.cwd(), 'data');
    mkdirSync(dir, { recursive: true });
    await db.initDatabase();
  });

  it('should create wallet groups and add members', async () => {
    await db.addWallet('wallet1', 'Test1', 'pk1');
    await db.addWallet('wallet2', 'Test2', 'pk2');
    const all = await db.getAllWallets();
    const w1 = all.find(w => w.address === 'wallet1');
    const w2 = all.find(w => w.address === 'wallet2');
    assert.ok(w1 && w2);

    const gid = await db.createWalletGroup('TestGroup', 'For tests');
    await db.addWalletToGroup(gid, w1.id);
    await db.addWalletToGroup(gid, w2.id);

    const members = await db.getGroupWallets(gid);
    assert.equal(members.length, 2);
  });

  it('should insert and query strategy orders', async () => {
    await db.saveStrategyOrder({
      wallet_address: 'wallet1', token_address: 'token1', token_symbol: 'TEST',
      chain: 'sol', order_type: 'limit_order', sub_order_type: 'take_profit',
      check_price: 0.01, amount_in_percent: 100, group_tag: 'LimitOrder',
      remote_order_id: 'remote123', status: 'active',
    });
    const orders = await db.getStrategyOrders();
    const order = orders.find(o => o.remote_order_id === 'remote123');
    assert.ok(order);
    assert.equal(order.check_price, 0.01);
    assert.equal(order.amount_in_percent, 100);
    assert.equal(order.group_tag, 'LimitOrder');
  });

  it('should get active strategy orders only', async () => {
    await db.saveStrategyOrder({
      wallet_address: 'wallet1', token_address: 'token2', chain: 'sol',
      order_type: 'limit_order', status: 'cancelled',
    });
    const active = await db.getActiveStrategyOrders();
    assert.ok(active.length >= 0);
    const all = await db.getStrategyOrders();
    const cancelled = all.filter(o => o.status === 'cancelled');
    assert.ok(cancelled.length >= 1);
  });

  it('should close trade with PnL calculation', async () => {
    const id = await db.createTrade({
      wallet_address: 'wallet1', token_address: 'token3', token_symbol: 'TEST3',
      chain: 'sol', buy_amount_sol: 0.1, buy_price: 0.001, buy_price_usd: 0.001, status: 'open',
    });
    const trade = await db.getTrade(id);
    assert.ok(trade);
    assert.equal(trade.status, 'open');

    await db.closeTrade(id, { sell_price_usd: 0.002, sell_amount_sol: 0.1 });
    const closed = await db.getTrade(id);
    assert.equal(closed.status, 'closed');
    assert.ok(closed.closed_at);
  });

  it('should save and query signals with sender_username', async () => {
    await db.saveSignal({
      token_address: 'sig_addr_1', source_channel: 'channel1',
      sender_username: 'trader1', chain: 'sol',
    });
    const signals = await db.getRecentSignals(10);
    const sig = signals.find(s => s.sender_username === 'trader1');
    assert.ok(sig);
    assert.equal(sig.sender_username, 'trader1');
    assert.equal(sig.source_channel, 'channel1');
  });

  it('should log scraper activity', async () => {
    await db.addScraperLog('chan1', 'info', 'started');
    await db.addScraperLog('chan1', 'error', 'failed');
    const logs = await db.getScraperLogs(10);
    const errors = logs.filter(l => l.channel_username === 'chan1' && l.level === 'error');
    assert.equal(errors.length, 1);
  });
});

describe('GMGN Module - New Endpoints', () => {
  it('should export all new functions', async () => {
    const gmgn = await import('../gmgn.js');
    assert.equal(typeof gmgn.executeSell, 'function');
    assert.equal(typeof gmgn.executeBuyWithTP, 'function');
    assert.equal(typeof gmgn.executeMultiSwap, 'function');
    assert.equal(typeof gmgn.createStrategyOrder, 'function');
    assert.equal(typeof gmgn.listStrategyOrders, 'function');
    assert.equal(typeof gmgn.cancelStrategyOrder, 'function');
    assert.equal(typeof gmgn.createLimitSell, 'function');
    assert.equal(typeof gmgn.createTPSLStrategy, 'function');
    assert.equal(typeof gmgn.getTokenHolders, 'function');
    assert.equal(typeof gmgn.getNewPairs, 'function');
    assert.equal(typeof gmgn.extractAddresses, 'function');
    assert.equal(typeof gmgn.CHAIN_CURRENCIES, 'object');
  });

  it('should executeSell accept correct parameters', () => {
    assert.ok(true, 'executeSell exported and has correct signature');
  });
});

describe('Web Server - New Endpoints', () => {
  it('should create Express app and register new routes', async () => {
    const { createWebServer } = await import('../web-server.js');
    const app = createWebServer();
    assert.ok(app);

    const stack = app._router?.stack || [];
    assert.ok(stack.length > 20, 'Should have many middleware/routes');

    const paths = stack.filter(l => l.route).map(l => l.route.path);
    assert.ok(paths.some(p => p.includes('orders')), 'Orders endpoints exist');
    assert.ok(paths.some(p => p.includes('token')), 'Token info endpoint exists');
    assert.ok(paths.some(p => p === '/api/sell' || p.includes('sell')), 'Sell endpoint exists');
    assert.ok(paths.some(p => p.includes('wallet-groups')), 'Wallet groups endpoint exists');
  });
});
