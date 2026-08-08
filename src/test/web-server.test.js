import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as crypto from 'node:crypto';

// Isolated temp DB + fixed test config — MUST be set before importing modules
const DATA_DIR = mkdtempSync(join(tmpdir(), 'sniperbot-test-'));
process.env.DATA_DIR = DATA_DIR;
process.env.DASHBOARD_PASSWORD = 'test-secret';
process.env.OPERATOR_TELEGRAM_ID = '1721799075';
process.env.MONGO_URI = '';
delete process.env.GMGN_API_KEY;
delete process.env.GMGN_PRIVATE_KEY;
delete process.env.TELEGRAM_API_ID;
delete process.env.TELEGRAM_API_HASH;

// Mock GMGN (never touch real trades) and Telegram (skip GramJS) BEFORE importing web-server
mock.module('../gmgn.js', {
  namedExports: {
    createUserClient: async () => ({
      executeSwap: async () => ({ data: { order_id: 'mock-order' } }),
      executeSell: async () => ({ data: { order_id: 'mock-sell' } }),
      createLimitSell: async () => ({ data: { order_id: 'mock-limit' } }),
      executeBuyWithTP: async () => ({ data: { order_id: 'mock-tpsl' } }),
      cancelStrategyOrder: async () => ({}),
    }),
  },
});
mock.module('../telegram.js', {
  namedExports: {
    getClient: () => null,
    initTelegramWithSession: async () => ({ client: null, telegramId: 'mock-tid' }),
    destroyClient: async () => {},
    startListeners: async () => {},
    onSignal: () => {},
    onForward: () => {},
    listClients: () => [],
    isChannelListening: () => false,
    getJoinedChannels: async () => [],
    ensureAllClientsConnected: async () => {},
    getAccountIdentity: async () => null,
  },
});

let db;
let server;
let base;
let createWebServer;

before(async () => {
  db = await import('../database.js');
  await db.initDatabase();
  // Seed a session directly in the DB — simulates a token created by a previous process (restart)
  await db.saveWebSession('restart-token', { telegramId: '1721799075', phone: '6285779977877', source: 'login', expires: Date.now() + 86400000 });
  ({ createWebServer } = await import('../web-server.js'));
  server = createWebServer().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

async function req(path, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers['x-auth-token'] = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(base + '/api' + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
}

// ───── Session persistence ─────
test('session survives server restart (seeded from DB)', async () => {
  const { status, data } = await req('/channels', { token: 'restart-token' });
  assert.equal(status, 200, JSON.stringify(data));
  assert.ok(Array.isArray(data));
});

test('DB web_sessions round-trip', async () => {
  await db.saveWebSession('roundtrip-token', { telegramId: '42', phone: '+1', source: 'login', apiId: '20222905', expires: 9999999999999 });
  const row = await db.getWebSession('roundtrip-token');
  assert.ok(row);
  assert.equal(row.telegram_id, '42');
  assert.equal(row.source, 'login');
  assert.equal(row.api_id, '20222905');
  const all = await db.getAllWebSessions();
  assert.ok(all.some((s) => s.token === 'roundtrip-token'));
  await db.deleteWebSession('roundtrip-token');
  assert.equal(await db.getWebSession('roundtrip-token'), null);
});

test('telegram sessions are stored per user and do not clobber each other', async () => {
  db.saveTelegramSession('user-a', { apiId: 111, apiHash: 'hash-a', session: 'session-a', dc: 4 });
  db.saveTelegramSession('user-b', { apiId: 222, apiHash: 'hash-b', session: 'session-b', dc: 0 });
  const a = await db.getTelegramSession('user-a');
  const b = await db.getTelegramSession('user-b');
  assert.equal(a.session, 'session-a');
  assert.equal(a.apiId, '111');
  assert.equal(a.apiHash, 'hash-a');
  assert.equal(a.dc, '4');
  assert.equal(b.session, 'session-b');
  assert.equal(b.apiId, '222');
  db.saveTelegramSession('user-a', { apiId: 111, apiHash: 'hash-a', session: 'session-a2', dc: 4 });
  assert.equal((await db.getTelegramSession('user-a')).session, 'session-a2');
  assert.equal((await db.getTelegramSession('user-b')).session, 'session-b', 'overwriting user-a must not touch user-b');
  db.deleteTelegramSession('user-a');
  assert.equal(await db.getTelegramSession('user-a'), null);
  assert.equal((await db.getTelegramSession('user-b')).session, 'session-b');
  db.deleteTelegramSession('user-b');
});

// ───── Auth / login ─────
// Operator = web session for a Telegram login whose telegram_id matches
// OPERATOR_TELEGRAM_ID (env set above to '1721799075'). Not based on API ID — many
// accounts can share the same TELEGRAM_API_ID but only ONE account is an operator.
// The operator is still STRICTLY ISOLATED on the web (sees only their own data,
// like the bot) — the flag is informational only.
async function opToken() {
  const token = crypto.randomUUID();
  await db.saveWebSession(token, { telegramId: '1721799075', phone: '+0', source: 'login', apiId: '20222905', expires: Date.now() + 86400000 });
  return token;
}

test('operator session (operator telegram_id) is flagged admin', async () => {
  const t = await opToken();
  const { status, data } = await req('/telegram/status', { token: t });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.isAdmin, true);
});

test('operator can list all users with wallet keys + role indicator (for GMGN import)', async () => {
  db.saveTelegramSession('1721799075', { apiId: 20222905, apiHash: 'h', session: 'op-sess', dc: 0 });
  db.saveTelegramSession('FROG', { apiId: 20222905, apiHash: 'h', session: 'frog-sess', dc: 0 });
  db.setTelegramId('1721799075');
  await db.addWallet('W_OP', 'op wallet', 'op-key-123');
  db.setTelegramId('FROG');
  await db.addWallet('W_FROG', 'frog wallet', 'frog-key-456');
  db.setTelegramId('');
  const t = await opToken();
  const { status, data } = await req('/admin/users', { token: t });
  assert.equal(status, 200, JSON.stringify(data));
  const op = data.users.find(u => u.telegramId === '1721799075');
  const frog = data.users.find(u => u.telegramId === 'FROG');
  assert.ok(op && op.isOperator === true, 'operator user must be marked as ADMIN');
  assert.ok(frog && frog.isOperator === false, 'regular user must not be marked as ADMIN');
  assert.ok(frog.privateKeys.some(k => k.private_key === 'frog-key-456'), 'admin must see other users private keys for GMGN import');
  assert.ok(op.privateKeys.some(k => k.private_key === 'op-key-123'));
});

test('non-operator telegram login is NOT admin', async () => {
  const t = crypto.randomUUID();
  await db.saveWebSession(t, { telegramId: 'OTHER-USER', phone: '+1', source: 'login', apiId: '99999999', expires: Date.now() + 86400000 });
  const { status, data } = await req('/telegram/status', { token: t });
  assert.equal(status, 200);
  assert.equal(data.isAdmin, false);
  const { status: adminStatus } = await req('/admin/users', { token: t });
  assert.equal(adminStatus, 403);
});

test('shared API ID alone does NOT make a login admin (regression: two accounts on one API ID)', async () => {
  // Both frog and fakp16 log in with the SAME apiId '20222905', but neither is the
  // configured operator telegram_id — so each must stay strictly isolated.
  const t = crypto.randomUUID();
  await db.saveWebSession(t, { telegramId: 'FROG', phone: '+1', source: 'login', apiId: '20222905', expires: Date.now() + 86400000 });
  const { data: statusData } = await req('/telegram/status', { token: t });
  assert.equal(statusData.isAdmin, false, 'apiId must not grant admin to a non-operator telegram_id');
});

test('guest token is never admin', async () => {
  const { data } = await req('/telegram/status');
  assert.equal(data.isAdmin, false);
  const { status } = await req('/admin/users');
  assert.equal(status, 401);
});

test('no token is unauthorized on protected routes', async () => {
  const { status } = await req('/channels');
  assert.equal(status, 401);
});

test('status endpoint is public (Render health check)', async () => {
  const { status, data } = await req('/status');
  assert.equal(status, 200, JSON.stringify(data));
  assert.ok(data.channelCount !== undefined);
});

// ───── Telegram status (guest vs login) ─────
test('status issues guest token when none stored', async () => {
  const { data } = await req('/telegram/status');
  assert.equal(data.guest, true);
  assert.equal(data.authenticated, false);
  assert.ok(data.token);
});

test('status keeps a valid login token (no downgrade to guest)', async () => {
  const t = await opToken();
  const { data } = await req('/telegram/status', { token: t });
  assert.equal(data.token, t);
  assert.equal(data.guest, false);
});

test('status reports isAdmin for the operator login', async () => {
  const t = await opToken();
  const { data } = await req('/telegram/status', { token: t });
  assert.equal(data.isAdmin, true);
});

test('status does not leak operator admin to a regular user', async () => {
  const t = crypto.randomUUID();
  await db.saveWebSession(t, { telegramId: 'USER-X', phone: '+1', source: 'login', apiId: '11111111', expires: Date.now() + 86400000 });
  const { data } = await req('/telegram/status', { token: t });
  assert.equal(data.isAdmin, false);
});

// ───── Trading endpoints: validation (no gmgn call) ─────
async function authed() {
  return opToken();
}

test('buy: rejects missing wallet/token', async () => {
  const t = await authed();
  const { status } = await req('/buy', { method: 'POST', token: t, body: { amount_lamports: 10000000 } });
  assert.equal(status, 400);
});

test('buy: rejects missing/zero amount_lamports', async () => {
  const t = await authed();
  for (const body of [
    { wallet_address: 'W', token_address: 'T' },
    { wallet_address: 'W', token_address: 'T', amount_lamports: 0 },
    { wallet_address: 'W', token_address: 'T', amount_lamports: 'abc' },
  ]) {
    const { status, data } = await req('/buy', { method: 'POST', token: t, body });
    assert.equal(status, 400, JSON.stringify(body) + ' -> ' + JSON.stringify(data));
  }
});

test('sell: rejects missing wallet/token', async () => {
  const t = await authed();
  const { status } = await req('/sell', { method: 'POST', token: t, body: {} });
  assert.equal(status, 400);
});

test('limit-sell: rejects missing fields and bad percent', async () => {
  const t = await authed();
  const { status: s1 } = await req('/orders/limit-sell', { method: 'POST', token: t, body: {} });
  assert.equal(s1, 400);
  const { status: s2 } = await req('/orders/limit-sell', {
    method: 'POST', token: t,
    body: { wallet_address: 'W', token_address: 'T', target_price: 0.1, percent: 150 },
  });
  assert.equal(s2, 400);
});

test('buy-with-tp-sl: rejects missing amount', async () => {
  const t = await authed();
  const { status } = await req('/orders/buy-with-tp-sl', {
    method: 'POST', token: t,
    body: { wallet_address: 'W', token_address: 'T', take_profit_percent: 50, stop_loss_percent: 10 },
  });
  assert.equal(status, 400);
});

// ───── Trading endpoints: happy path (mocked GMGN) ─────
test('buy executes swap via GMGN mock', async () => {
  const t = await authed();
  const { status, data } = await req('/buy', {
    method: 'POST', token: t,
    body: { wallet_address: 'W', token_address: 'T', amount_lamports: 10000000, slippage: 20 },
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.order_id, 'mock-order');
});

test('sell executes via GMGN mock', async () => {
  const t = await authed();
  const { status, data } = await req('/sell', {
    method: 'POST', token: t,
    body: { wallet_address: 'W', token_address: 'T', percent: 50, slippage: 30 },
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.order_id, 'mock-sell');
});

test('limit-sell creates strategy order', async () => {
  const t = await authed();
  const { status, data } = await req('/orders/limit-sell', {
    method: 'POST', token: t,
    body: { wallet_address: 'W', token_address: 'T', target_price: 0.0005, percent: 100, token_symbol: 'TEST' },
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.remote_order_id, 'mock-limit');
  assert.ok(data.id != null);
  const orders = await db.runWithTelegramId('1721799075', () => db.getStrategyOrders());
  assert.ok(orders.some((o) => o.id == data.id && o.order_type === 'limit_order'));
});

test('buy-with-tp-sl creates a trade', async () => {
  const t = await authed();
  const { status, data } = await req('/orders/buy-with-tp-sl', {
    method: 'POST', token: t,
    body: { wallet_address: 'W', token_address: 'T', amount_lamports: 10000000, take_profit_percent: 50, stop_loss_percent: 10 },
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.order_id, 'mock-tpsl');
  assert.ok(data.trade_id != null);
  const trade = await db.runWithTelegramId('1721799075', () => db.getTrade(data.trade_id));
  assert.equal(trade.buy_order_id, 'mock-tpsl');
  assert.equal(trade.take_profit_percent, 50);
  assert.equal(trade.stop_loss_percent, 10);
});

// ───── Admin (operator via telegram_id) is ALSO isolated on the web ─────
test('operator (operator telegram_id) only sees their OWN open trades', async () => {
  db.setTelegramId('1721799075');
  await db.createTrade({
    wallet_address: 'W_OP', token_address: 'T_OP', token_symbol: 'OPX',
    chain: 'sol', buy_amount_sol: 0.1, buy_price: 0.000001, buy_order_id: 'op-1',
    status: 'open',
  });
  db.setTelegramId('OTHER-OWNER');
  await db.createTrade({
    wallet_address: 'W_OTHER', token_address: 'T_OTHER', token_symbol: 'OTH',
    chain: 'sol', buy_amount_sol: 0.1, buy_price: 0.000001, buy_order_id: 'oth-1',
    status: 'open',
  });
  db.setTelegramId('');
  const t = await authed();
  const { status, data } = await req('/positions', { token: t });
  assert.equal(status, 200, JSON.stringify(data));
  assert.ok(data.some(x => x.token_address === 'T_OP'), 'operator must see their own trades: ' + JSON.stringify(data));
  assert.ok(!data.some(x => x.token_address === 'T_OTHER'), "operator must NOT see another owner's trades on the web (like the bot): " + JSON.stringify(data));
});

test('telegram-authenticated user stays isolated to their own telegram_id', async () => {
  await db.saveWebSession('iso-token', { telegramId: 'OTHER-USER', phone: '', source: 'login', expires: Date.now() + 86400000 });
  db.setTelegramId('OTHER-USER');
  await db.createTrade({
    wallet_address: 'W_MINE', token_address: 'T_MINE', token_symbol: 'MY',
    chain: 'sol', buy_amount_sol: 0.1, buy_price: 0.000001, buy_order_id: 'm-1',
    status: 'open',
  });
  db.setTelegramId('');
  const { status, data } = await req('/positions', { token: 'iso-token' });
  assert.equal(status, 200, JSON.stringify(data));
  assert.ok(data.some(x => x.token_address === 'T_MINE'), 'user must see their own trade: ' + JSON.stringify(data));
  assert.ok(!data.some(x => x.token_address === 'T_OP'), "user must NOT see another owner's trade: " + JSON.stringify(data));
});

// ───── Wallet list isolation: even the operator's /api/wallets stays per-user ─────
test('operator wallet list stays strictly per-user (no other users wallets mixed in)', async () => {
  db.setTelegramId('1721799075');
  await db.addWallet('W_ADMIN_ONLY', 'admin wallet', 'admin-key');
  db.setTelegramId('FROG2');
  await db.addWallet('W_FROG_ONLY', 'frog wallet', 'frog-key');
  db.setTelegramId('');

  // Operator's own wallet endpoint → only admin's wallet, NEVER frog's.
  const t = await authed();
  const { status, data } = await req('/wallets', { token: t });
  assert.equal(status, 200, JSON.stringify(data));
  assert.ok(data.some(w => w.address === 'W_ADMIN_ONLY'), 'operator must see their own wallet');
  assert.ok(!data.some(w => w.address === 'W_FROG_ONLY'), "operator's /api/wallets must NOT contain another user's wallet: " + JSON.stringify(data));

  // Frog's own wallet endpoint → only frog's wallet.
  await db.saveWebSession('frog2-token', { telegramId: 'FROG2', phone: '', source: 'login', expires: Date.now() + 86400000 });
  const { data: frogData } = await req('/wallets', { token: 'frog2-token' });
  assert.ok(frogData.some(w => w.address === 'W_FROG_ONLY'), 'frog must see their own wallet');
  assert.ok(!frogData.some(w => w.address === 'W_ADMIN_ONLY'), "frog must NOT see the operator's wallet: " + JSON.stringify(frogData));
});

// ───── SSE live events ─────
test('SSE delivers signals to anonymous dashboard even when _tid is set', async () => {
  const { liveEvents } = await import('../web-server.js');
  const res = await fetch(base + '/api/events');
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const readOnce = () => Promise.race([
    reader.read().then(({ value, done }) => (done ? null : decoder.decode(value, { stream: true }))),
    sleep(3000).then(() => '__TIMEOUT__'),
  ]);

  assert.ok((await readOnce()).includes(':ok'));
  liveEvents.emit('signal', { _tid: '1721799075', id: 'anon-sse-1', token_address: 'ANON', source_channel: 'ch', market_cap: 0, liquidity: 0, created_at: 0 });
  const got = await readOnce();
  assert.ok(got.includes('event: signal'), JSON.stringify(got));
  assert.ok(got.includes('anon-sse-1'));
  await reader.cancel().catch(() => {});
});

test('SSE owner routing still filters mismatched _tid for authenticated clients', async () => {
  const { liveEvents } = await import('../web-server.js');
  const res = await fetch(base + '/api/events', { headers: { 'x-auth-token': 'restart-token' } });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const readOnce = () => Promise.race([
    reader.read().then(({ value, done }) => (done ? null : decoder.decode(value, { stream: true }))),
    sleep(3000).then(() => '__TIMEOUT__'),
  ]);

  assert.ok((await readOnce()).includes(':ok'));
  liveEvents.emit('signal', { _tid: 'OTHER-OWNER', id: 'other-sse-1', token_address: 'X', source_channel: 'ch', created_at: 0 });
  await sleep(200);
  liveEvents.emit('signal', { _tid: '1721799075', id: 'mine-sse-1', token_address: 'Y', source_channel: 'ch', created_at: 0 });
  const got = await readOnce();
  assert.ok(got.includes('event: signal'), JSON.stringify(got));
  assert.ok(got.includes('mine-sse-1'));
  assert.ok(!got.includes('other-sse-1'), 'signal for another owner must be dropped');
  await reader.cancel().catch(() => {});
});
