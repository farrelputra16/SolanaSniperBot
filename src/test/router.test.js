import { test, mock } from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'sniperbot-router-test-'));
process.env.DATA_DIR = DATA_DIR;
process.env.MONGO_URI = '';
delete process.env.GMGN_API_KEY;
delete process.env.GMGN_PRIVATE_KEY;

const saveSignalCalls = [];
const emitter = new EventEmitter();

mock.module('../gmgn.js', {
  namedExports: {
    extractAddresses: async (text) => {
      const m = text.trim().match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
      return m ? [{ address: m[0], chain: 'sol' }] : [];
    },
    getTokenInfo: async () => null,
    getTokenSecurity: async () => null,
    executeSwap: async () => ({ data: { order_id: 'mock' } }),
    getOrder: async () => null,
    getUserCredentials: async () => ({}),
    getWalletHoldings: async () => ({}),
    getWalletTokenBalance: async () => null,
  },
});
mock.module('../dexscreener.js', {
  namedExports: { getDexScreenerInfo: async () => null },
});
mock.module('../telegram.js', {
  namedExports: { sendToChat: async () => {} },
});
mock.module('../web-server.js', {
  namedExports: { liveEvents: emitter },
});
mock.module('../config.js', {
  namedExports: {
    config: { telegram: {}, server: {}, solana: {} },
    validateConfig: () => [],
  },
});
mock.module('../database.js', {
  namedExports: {
    getAllChannels: async () => [{ channel_username: 'ChanA', ignore_duplicate: 1 }],
    getAutoBuyRules: async () => [],
    addScraperLog: async () => {},
    saveSignal: async (sig) => { saveSignalCalls.push(sig); return saveSignalCalls.length; },
    trimSignals: async () => {},
    getTelegramId: () => 'test-tid',
    setTelegramId: () => {},
    runWithTelegramId: (_id, fn) => fn(),
    getSetting: async () => 'test-tid',
    getActiveWallet: async () => null,
    getWalletGroups: async () => [],
  },
});

test('dedup stats stay objects; signal still saved after ignore', async () => {
  const { processSignal, getDedupStats } = await import('../router.js');

  const CA1 = 'So11111111111111111111111111111111111111112';
  const CA2 = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  await processSignal('ChanA', `buy ${CA1}`, null, 'alice');
  assert.equal(getDedupStats().total_caught, 1, 'first CA counted as caught');
  assert.equal(getDedupStats().total_ignored, 0);

  await processSignal('ChanA', `buy ${CA1}`, null, 'alice');
  assert.equal(getDedupStats().total_ignored, 1, 'duplicate CA counted as ignored');
  assert.deepEqual(getDedupStats().per_channel.ChanA, { caught: 1, ignored: 1 }, 'per-channel stays an object');

  await processSignal('ChanA', `buy ${CA2}`, null, 'alice');
  assert.equal(getDedupStats().total_caught, 2, 'new CA counted after ignore');
  assert.deepEqual(getDedupStats().per_channel.ChanA, { caught: 2, ignored: 1 }, 'both counters live on the object');

  assert.equal(saveSignalCalls.length, 2, 'saveSignal fired for both caught CAs (no throw before signal emit)');
});
