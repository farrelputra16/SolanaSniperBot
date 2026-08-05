import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.MONGO_URI = '';
delete process.env.GMGN_API_KEY;
delete process.env.GMGN_PRIVATE_KEY;

mock.module('../config.js', {
  namedExports: {
    config: { gmgn: { apiKey: '', privateKey: '', host: '' }, telegram: {}, server: {}, solana: {} },
    validateConfig: () => [],
  },
});
mock.module('../database.js', {
  namedExports: {},
});

test('generateSolanaWallet returns a valid address + derivable private key', async () => {
  const { generateSolanaWallet, deriveAddressFromPrivateKey } = await import('../gmgn.js');
  const w = generateSolanaWallet();
  assert.match(w.address, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  assert.equal(deriveAddressFromPrivateKey(w.privateKey), w.address);
});

test('isValidVanitySuffix accepts base58 endings, rejects bad chars', async () => {
  const { isValidVanitySuffix } = await import('../gmgn.js');
  assert.equal(isValidVanitySuffix('D1ck'), true);
  assert.equal(isValidVanitySuffix('G04t'), false); // '0' is not in Solana's base58 alphabet
  assert.equal(isValidVanitySuffix('a'), true);
  assert.equal(isValidVanitySuffix(''), false);
  assert.equal(isValidVanitySuffix('ABCDE'), false);
  assert.equal(isValidVanitySuffix('0lOI'), false);
  assert.equal(isValidVanitySuffix('has space'), false);
});

test('generateVanityWallet address ends with the suffix and key derives back', async () => {
  const { generateVanityWallet, deriveAddressFromPrivateKey } = await import('../gmgn.js');
  const w = await generateVanityWallet('Xx');
  assert.ok(w.address.endsWith('Xx'), `expected ${w.address} to end with Xx`);
  assert.ok(w.attempts > 0);
  assert.equal(deriveAddressFromPrivateKey(w.privateKey), w.address);
});

test('generateVanityWallet can be cancelled via AbortSignal', async () => {
  const { generateVanityWallet } = await import('../gmgn.js');
  const ac = new AbortController();
  const p = generateVanityWallet('ZZZZ', { signal: ac.signal });
  ac.abort();
  await assert.rejects(p, /cancelled/);
});
