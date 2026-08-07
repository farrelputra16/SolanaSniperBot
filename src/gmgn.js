import * as crypto from 'crypto';
import https from 'https';
import { config } from './config.js';
import * as db from './database.js';

const { apiKey: envApiKey, privateKey: envPrivateKey, host } = config.gmgn;

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  timeout: 15000,
});

let _algorithmCache = new Map();

function detectAlgorithm(key) {
  if (!key) return null;
  const cached = _algorithmCache.get(key);
  if (cached) return cached;
  try {
    const k = crypto.createPrivateKey(key.trim());
    const algo = k.asymmetricKeyType === 'ed25519' ? 'Ed25519' : 'RSA-SHA256';
    _algorithmCache.set(key, algo);
    return algo;
  } catch {
    return null;
  }
}

function buildAuthQuery() {
  return { timestamp: Math.floor(Date.now() / 1000), client_id: crypto.randomUUID() };
}

function signMessage(message, privateKey) {
  const algo = detectAlgorithm(privateKey);
  if (!algo) throw new Error('Private key invalid or not found');
  const msgBuf = Buffer.from(message, 'utf-8');
  if (algo === 'Ed25519') {
    const sig = crypto.sign(null, msgBuf, privateKey.trim());
    return sig.toString('base64');
  }
  const sig = crypto.sign('sha256', msgBuf, {
    key: privateKey.trim(),
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  });
  return sig.toString('base64');
}

const _credsCache = new Map();
const CREDS_CACHE_TTL = 15000;

export async function getUserCredentials(telegramId) {
  if (telegramId == null) return { apiKey: envApiKey, privateKey: envPrivateKey };
  const cached = _credsCache.get(telegramId);
  if (cached && Date.now() - cached.ts < CREDS_CACHE_TTL) return cached.data;
  const userKey = await db.getUserSetting('gmgn_api_key_usr', '', telegramId);
  const userPk = await db.getUserSetting('gmgn_private_key_usr', '', telegramId);
  const data = {
    apiKey: userKey || envApiKey,
    privateKey: (userPk || envPrivateKey || '').replace(/\\n/g, '\n'),
  };
  _credsCache.set(telegramId, { data, ts: Date.now() });
  return data;
}

// ───── GMGN Rate Limiter ─────
// GMGN 2026 dual-tier limits: RPS(base) = 5 / weight, RPS(traded) = 15 / weight.
// Budget on the BASE tier so bursts queue smoothly instead of 429-storming.
// Raise the budget with GMGN_MAX_RPS (e.g. 15 if the key has traded in 24h).
const GMGN_MAX_RPS = Math.max(1, parseInt(process.env.GMGN_MAX_RPS || '5', 10));

const _ENDPOINT_WEIGHTS = [
  ['token/holders', 2], ['token/traders', 3],
  ['user/wallet_token_balance', 3], ['user/wallet_holdings', 3], ['user/wallet_stats', 3],
  ['user/wallet_created_token', 3], ['user/wallet_activity', 1],
  ['user/kol', 1], ['user/smartmoney', 1],
  ['trade/quote', 3], ['trade/query_order', 3],
  ['order/strategy/cancel', 2], ['order/strategy', 3],
  ['gas-price', 3],
  ['market/token_signal', 3], ['trenches', 2], ['market/kline', 1],
  ['token/info', 1], ['token/security', 1], ['token/pool', 1],
  ['market/rank', 1], ['trade/swap', 1], ['trade/multi_swap', 1],
];

function endpointWeight(path) {
  for (const [k, w] of _ENDPOINT_WEIGHTS) {
    if (path.includes(k)) return w;
  }
  return 1;
}

let _bucketTokens = GMGN_MAX_RPS;
let _bucketLast = Date.now();

async function rateLimit(path) {
  const w = endpointWeight(path);
  for (;;) {
    const now = Date.now();
    _bucketTokens = Math.min(GMGN_MAX_RPS, _bucketTokens + ((now - _bucketLast) / 1000) * GMGN_MAX_RPS);
    _bucketLast = now;
    if (_bucketTokens >= w) { _bucketTokens -= w; return; }
    const deficit = w - _bucketTokens;
    await new Promise(r => setTimeout(r, Math.min(100, Math.ceil((deficit / GMGN_MAX_RPS) * 1000))));
  }
}

async function request(method, path, params = {}, body = null, signed = false, overrideCreds = null, skipRateLimit = false, retryCount = 0) {
  if (!skipRateLimit) await rateLimit(path);
  const creds = overrideCreds || { apiKey: envApiKey, privateKey: envPrivateKey };
  const authQuery = buildAuthQuery();
  const allParams = { ...params, ...authQuery };

  function buildSortedQS(obj) {
    return Object.entries(obj)
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([k, v]) => {
        if (Array.isArray(v)) return [...v].sort().map((i) => `${encodeURIComponent(k)}=${encodeURIComponent(String(i))}`);
        return [`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`];
      })
      .join('&');
  }

  const qs = buildSortedQS(allParams);
  const url = `${host}${path}?${qs}`;
  const headers = {
    'X-APIKEY': creds.apiKey,
    'Content-Type': 'application/json',
    'User-Agent': 'sniper-bot/1.0',
  };

  const bodyStr = body ? JSON.stringify(body) : '';

  if (signed && creds.privateKey) {
    const message = `${path}:${qs}:${bodyStr}:${authQuery.timestamp}`;
    headers['X-Signature'] = signMessage(message, creds.privateKey);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: bodyStr || undefined,
      signal: controller.signal,
      agent: httpsAgent,
    });
    clearTimeout(timeout);

    let json;
    try { json = await res.json(); } catch { json = {}; }

    if (res.status === 429 && json) {
      const resetAt = json.reset_at || Math.floor(Date.now() / 1000) + 30;
      if (method === 'POST') {
        const err = new Error(json.message || `RATE_LIMITED — reset at ${new Date(resetAt * 1000).toLocaleTimeString()}`);
        err.status = 429;
        err.body = json;
        err.code = json.code;
        throw err;
      }
      // Cap retries — an unbounded 429 retry loop hangs the whole app (slow token
      // info, empty external positions, wedged scraper). Fail fast after 3 tries.
      if (retryCount >= 3) {
        const err = new Error(`GMGN rate limited (429) after ${retryCount} retries — reset at ${new Date(resetAt * 1000).toISOString()}`);
        err.status = 429;
        err.body = json;
        err.code = json.code;
        throw err;
      }
      const wait = Math.max(1000, (resetAt - Math.floor(Date.now() / 1000)) * 1000);
      await new Promise(r => setTimeout(r, Math.min(wait, 5000)));
      return request(method, path, params, body, signed, overrideCreds, true, retryCount + 1);
    }

    if (!res.ok) {
      const err = new Error(json.message || json.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.code = json.code;
      err.body = json;
      if (res.status === 400) {
        const reqUrl = url.slice(0, 300);
        console.error(`[GMGN] 400 error — ${json.code} ${json.error} — ${json.message}\n  body: ${bodyStr ? bodyStr.slice(0, 500) : '(no body)'}\n  url: ${reqUrl}`);
      } else if (res.status === 401 || res.status === 403) {
        console.error(`[GMGN] Auth error — ${json.code} ${json.error} — ${json.message} — path=${path}`);
      }
      throw err;
    }

    return json;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') throw new Error('GMGN request timed out');
    throw err;
  }
}

// ───── Market Data ─────
export async function getTrending(chain = 'sol', interval = '1h', opts = {}) {
  const params = { chain, interval, ...opts };
  return request('GET', '/v1/market/rank', params);
}

export async function getTrenches(chain = 'sol', type = null, opts = {}) {
  const body = buildTrenchesBody(chain, type, opts);
  return request('POST', '/v1/trenches', {}, body);
}

export async function getTokenSignal(chain = 'sol', signalType = null, opts = {}) {
  const body = { chain, ...opts };
  if (signalType !== null) body.signal_type = signalType;
  if (opts.mcMin) body.mc_min = opts.mcMin;
  if (opts.mcMax) body.mc_max = opts.mcMax;
  return request('POST', '/v1/market/token_signal', {}, body);
}

export async function getNewPairs(chain = 'sol', limit = 50) {
  return request('GET', '/defi/v1/token/new_pairs', { chain, limit });
}

// ───── Token Cache (30s TTL) ─────
const _tokenCache = new Map();
const TOKEN_CACHE_TTL = 30000;

function getCachedToken(chain, address) {
  const key = `${chain}:${address}`;
  const hit = _tokenCache.get(key);
  if (hit) {
    if (Date.now() - hit.ts < TOKEN_CACHE_TTL) {
      hit.revalidating = true;
      return hit.data;
    }
    if (hit.revalidating) return hit.data;
  }
  return null;
}

function setCachedToken(chain, address, data) {
  const key = `${chain}:${address}`;
  const existing = _tokenCache.get(key);
  if (existing && existing.revalidating) {
    existing.data = data;
    existing.ts = Date.now();
    existing.revalidating = false;
    return;
  }
  _tokenCache.set(key, { data, ts: Date.now(), revalidating: false });
}

// ───── Token Data ─────
export async function getTokenInfo(chain, address) {
  const cached = getCachedToken(chain, address);
  if (cached && cached.info) return cached.info;
  const data = await request('GET', '/v1/token/info', { chain, address });
  const existing = getCachedToken(chain, address);
  setCachedToken(chain, address, { ...existing, info: data });
  return data;
}

export async function getTokenSecurity(chain, address) {
  const cached = getCachedToken(chain, address);
  if (cached && cached.security) return cached.security;
  const data = await request('GET', '/v1/token/security', { chain, address });
  const existing = getCachedToken(chain, address);
  setCachedToken(chain, address, { ...existing, security: data });
  return data;
}

export async function getTokenHolders(chain, address, opts = {}) {
  const params = { chain, address, order_by: opts.orderBy || 'amount_percentage', direction: opts.direction || 'desc', limit: opts.limit || 50 };
  return request('GET', '/v1/token/holders', params);
}

export async function getKOLTrades(chain = 'sol', limit = 100) {
  return request('GET', '/v1/user/kol', { chain, limit });
}

export async function getSmartMoneyTrades(chain = 'sol', limit = 100) {
  return request('GET', '/v1/user/smartmoney', { chain, limit });
}

// ───── Swap / Trade ─────
export async function getQuote(chain, from, inputToken, outputToken, amount, slippage = 30) {
  return request('GET', '/v1/trade/quote', {
    chain, from_address: from, input_token: inputToken, output_token: outputToken,
    input_amount: String(amount), slippage,
  });
}

export async function executeSwap(chain, from, inputToken, outputToken, amount, opts = {}, creds = null) {
  const body = {
    chain,
    from_address: from,
    input_token: inputToken,
    output_token: outputToken,
    input_amount: String(amount),
  };
  if (opts.slippage != null) body.slippage = Number(opts.slippage);
  else body.slippage = Number(config.sniper.defaultSlippage);
  if (opts.autoSlippage) body.auto_slippage = true;
  if (opts.minOutputAmount) body.min_output_amount = opts.minOutputAmount;
  if (opts.antiMev !== undefined) body.is_anti_mev = opts.antiMev;
  if (opts.priorityFee) body.priority_fee = String(opts.priorityFee);
  if (opts.tipFee) body.tip_fee = String(opts.tipFee);
  if (opts.percent !== undefined) body.input_amount_bps = String(Math.round(opts.percent * 100));
  if (opts.sellRatioType) body.sell_ratio_type = opts.sellRatioType;
  if (opts.conditionOrders) body.condition_orders = opts.conditionOrders;

  return request('POST', '/v1/trade/swap', {}, body, true, creds);
}

export async function executeSell(chain, from, tokenAddress, percent = 100, opts = {}, creds = null) {
  const body = {
    chain,
    from_address: from,
    input_token: tokenAddress,
    output_token: 'So11111111111111111111111111111111111111112',
    input_amount: '0',
    input_amount_bps: String(Math.round(percent * 100)),
  };
  if (opts.slippage != null) body.slippage = Number(opts.slippage);
  else body.slippage = Number(config.sniper.defaultSlippage);
  if (opts.antiMev !== undefined) body.is_anti_mev = opts.antiMev;
  if (opts.priorityFee) body.priority_fee = String(opts.priorityFee);
  if (opts.tipFee) body.tip_fee = String(opts.tipFee);
  if (opts.sellRatioType) body.sell_ratio_type = opts.sellRatioType;
  if (opts.conditionOrders) body.condition_orders = opts.conditionOrders;
  return request('POST', '/v1/trade/swap', {}, body, true, creds);
}

export async function executeBuyWithTP(chain, from, tokenAddress, amountLamports, opts = {}, creds = null) {
  const conditions = [];
  if (opts.takeProfitPercent) {
    conditions.push({ order_type: 'profit_stop', side: 'sell', price_scale: String(opts.takeProfitPercent), sell_ratio: '100' });
  }
  if (opts.stopLossPercent) {
    conditions.push({ order_type: 'loss_stop', side: 'sell', price_scale: String(Math.abs(opts.stopLossPercent)), sell_ratio: '100' });
  }
  if (opts.takeProfitPartialPercent) {
    conditions.push({ order_type: 'profit_stop', side: 'sell', price_scale: String(opts.takeProfitPartialPercent), sell_ratio: String(opts.takeProfitPartialRatio || '50') });
  }

  return executeSwap(chain, from, 'So11111111111111111111111111111111111111112', tokenAddress, amountLamports, {
    ...opts,
    conditionOrders: conditions.length > 0 ? conditions : undefined,
    sellRatioType: 'hold_amount',
  }, creds);
}

export async function executeMultiSwap(chain, accounts, inputToken, outputToken, inputAmounts, opts = {}) {
  const body = {
    chain,
    accounts: Array.isArray(accounts) ? accounts : [accounts],
    input_token: inputToken,
    output_token: outputToken,
    input_amount: inputAmounts,
  };
  if (opts.slippage != null) body.slippage = Number(opts.slippage);
  else body.slippage = Number(config.sniper.defaultSlippage);
  if (opts.antiMev !== undefined) body.is_anti_mev = opts.antiMev;
  if (opts.priorityFee) body.priority_fee = String(opts.priorityFee);
  if (opts.tipFee) body.tip_fee = String(opts.tipFee);
  if (opts.sellRatioType) body.sell_ratio_type = opts.sellRatioType;
  if (opts.conditionOrders) body.condition_orders = opts.conditionOrders;
  return request('POST', '/v1/trade/multi_swap', {}, body, true);
}

export async function getOrder(chain, orderId, creds = null) {
  return request('GET', '/v1/trade/query_order', { chain, order_id: orderId }, null, true, creds);
}

// ───── Strategy Orders (Limit / TP-SL) ─────
export async function createStrategyOrder(chain, from, baseToken, quoteToken, opts = {}) {
  const body = {
    chain,
    from_address: from,
    base_token: baseToken,
    quote_token: quoteToken,
    order_type: opts.orderType || 'limit_order',
    sub_order_type: opts.subOrderType || 'take_profit',
    check_price: String(opts.checkPrice),
    amount_in_percent: opts.amountInPercent ?? 100,
  };
  if (opts.frequency) body.frequency = opts.frequency;
  if (opts.repeatCount) body.repeat_count = opts.repeatCount;
  if (opts.groupTag) body.group_tag = opts.groupTag;
  return request('POST', '/v1/order/strategy/create', {}, body, true);
}

export async function listStrategyOrders(chain, groupTag = null) {
  const params = { chain };
  if (groupTag) params.group_tag = groupTag;
  return request('GET', '/v1/order/strategy/list', params);
}

export async function cancelStrategyOrder(chain, from, orderId) {
  const body = { chain, from_address: from, order_id: orderId };
  return request('POST', '/v1/order/strategy/cancel', {}, body, true);
}

// ───── Limit Sell (Convenience) ─────
export async function createLimitSell(chain, from, tokenAddress, targetPriceUsd, percent = 100) {
  return createStrategyOrder(chain, from, tokenAddress, 'So11111111111111111111111111111111111111112', {
    orderType: 'limit_order',
    subOrderType: 'take_profit',
    checkPrice: targetPriceUsd,
    amountInPercent: percent,
    groupTag: 'LimitOrder',
  });
}

export async function createTPSLStrategy(chain, from, tokenAddress, tpPercent, slPercent, buyAmountLamports) {
  return executeBuyWithTP(chain, from, tokenAddress, buyAmountLamports, {
    takeProfitPercent: tpPercent,
    stopLossPercent: slPercent,
    slippage: config.sniper.defaultSlippage,
  });
}

// ───── Token Address Extraction ─────
const BASE58_REGEX = /[1-9A-HJ-NP-Za-km-z]{32,88}/g;
const EVM_ADDRESS_REGEX = /0x[a-fA-F0-9]{40}/g;

export function extractAddresses(text) {
  const addresses = [];
  const solMatches = text.match(BASE58_REGEX) || [];
  const evmMatches = text.match(EVM_ADDRESS_REGEX) || [];

  // Filter out addresses found inside URLs
  const urlRegex = /https?:\/\/\S+/g;
  const urls = text.match(urlRegex) || [];
  const urlSet = new Set();
  for (const u of urls) {
    const m = u.match(BASE58_REGEX);
    if (m) for (const a of m) urlSet.add(a);
  }

  for (const addr of solMatches) {
    if (urlSet.has(addr)) continue;
    if (isValidSolAddress(addr)) {
      addresses.push({ address: addr, chain: 'sol' });
    }
  }
  for (const addr of evmMatches) {
    addresses.push({ address: addr.toLowerCase(), chain: 'bsc' });
  }
  return addresses;
}

const CHAIN_CURRENCIES = {
  sol: { SOL: 'So11111111111111111111111111111111111111112', USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
};

// ───── Internal Helpers ─────
function buildTrenchesBody(chain, type, opts) {
  const selectedTypes = type
    ? (Array.isArray(type) ? type : [type])
    : ['new_creation', 'near_completion', 'completed'];
  const body = { version: 'v2' };
  for (const t of selectedTypes) {
    body[t] = {
      filters: ['offchain', 'onchain'],
      launchpad_platform: opts.platforms || [],
      quote_address_type: [0, 1, 3, 4, 5, 13],
      launchpad_platform_v2: true,
      limit: opts.limit || 80,
      ...(opts.minLiquidity ? { min_liquidity: opts.minLiquidity } : {}),
      ...(opts.maxRugRatio ? { max_rug_ratio: opts.maxRugRatio } : {}),
      ...(opts.minSmartDegen ? { min_smart_degen_count: opts.minSmartDegen } : {}),
    };
  }
  return body;
}

// ───── Portfolio ─────
export async function getPortfolioInfo() {
  return request('GET', '/v1/user/info');
}

export async function getWalletHoldings(chain, wallet, opts = {}) {
  const params = { chain, wallet_address: wallet, limit: opts.limit || 50, order_by: opts.orderBy || 'usd_value', direction: opts.direction || 'desc' };
  if (opts.sellOut) params['sell_out'] = true;
  return request('GET', '/v1/user/wallet_holdings', params, null, true, opts.creds || null);
}

export async function getWalletStats(chain, wallet, period = '7d') {
  return request('GET', '/v1/user/wallet_stats', { chain, wallet_address: wallet, period });
}

export async function getWalletTokenBalance(chain, wallet, token) {
  return request('GET', '/v1/user/wallet_token_balance', { chain, wallet_address: wallet, token_address: token });
}

export async function getWalletActivity(chain, wallet, opts = {}) {
  const params = { chain, wallet_address: wallet, limit: opts.limit || 20 };
  if (opts.token) params.token = opts.token;
  if (opts.cursor) params.cursor = opts.cursor;
  return request('GET', '/v1/user/wallet_activity', params);
}

const BS58_ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BS58_MAP = {};
for (let i = 0; i < BS58_ALPHA.length; i++) BS58_MAP[BS58_ALPHA[i]] = i;

function bs58Encode(buf) {
  let n = 0n;
  for (const b of buf) n = (n << 8n) + BigInt(b);
  const r = [];
  while (n > 0n) { r.unshift(BS58_ALPHA[Number(n % 58n)]); n /= 58n; }
  return r.join('') || '1';
}

function bs58Decode(s) {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(BS58_MAP[c]);
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
  return Buffer.from(bytes);
}

function isValidSolAddress(addr) {
  if (addr.length < 32 || addr.length > 44) return false;
  try {
    const decoded = bs58Decode(addr);
    return decoded.length === 32;
  } catch { return false; }
}

export function addressFromPEM(pem) {
  try {
    const pub = crypto.createPublicKey(pem.trim());
    const der = pub.export({ format: 'der', type: 'spki' });
    const pubkey = Buffer.from(der).subarray(-32);
    if (pubkey.length !== 32) return null;
    return bs58Encode(pubkey);
  } catch { return null; }
}

// ───── Wallet Generate ─────
export function generateSolanaWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  const pub = Buffer.from(publicKey).subarray(-32);
  const seed = Buffer.from(privateKey).subarray(-32);
  return { address: bs58Encode(pub), privateKey: bs58Encode(Buffer.concat([seed, pub])) };
}

export function isValidVanityPart(s) {
  return !!s && typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{1,4}$/.test(s);
}

export function isValidVanitySuffix(s) { return isValidVanityPart(s); }
export function isValidVanityPrefix(s) { return isValidVanityPart(s); }

// Parses a vanity pattern string into { suffix, prefix }.
// Supported syntax: "end:abc", "suffix:abc", "start:abc", "begin:abc",
// "prefix:abc", comma/semicolon-separated combos ("start:abc,end:xyz"),
// or a bare base58 token which is treated as the ENDING (suffix).
// Returns null if nothing valid was found.
export function parseVanityPattern(str) {
  if (!str || typeof str !== 'string') return null;
  const s = str.trim();
  if (!s) return null;
  const parts = s.split(/[,;]/).map(x => x.trim()).filter(Boolean);
  let suffix = '', prefix = '';
  for (const p of parts) {
    const m = p.match(/^(start|begin|prefix|end|suffix)\s*[:=]\s*([1-9A-HJ-NP-Za-km-z]{1,4})$/i);
    if (m) {
      const val = m[2];
      if (/^(start|begin|prefix)$/i.test(m[1])) prefix = val;
      else suffix = val;
      continue;
    }
    if (isValidVanityPart(p) && !suffix) suffix = p;
  }
  if (!suffix && !prefix) return null;
  return { suffix, prefix };
}

// Generates a wallet whose base58 address ends with `suffix` and/or starts with
// `prefix` ("D1ck" ending, "6Gt" beginning, or both). Brute-forces keypairs.
// Lengths: 2 chars ≈ <1s, 3 chars ≈ ~15s, 4 chars ≈ several minutes; a combined
// prefix+suffix multiplies the expected time — pass an AbortSignal to cancel.
export async function generateVanityWallet(spec, { signal, onAttempt } = {}) {
  const cfg = typeof spec === 'string' ? { suffix: spec } : (spec || {});
  const suffix = cfg.suffix || '';
  const prefix = cfg.prefix || '';
  let target = 0n;
  let base = 1n;
  for (let i = 0; i < suffix.length; i++) { target = target * 58n + BigInt(BS58_MAP[suffix[i]]); base *= 58n; }

  return await new Promise((resolve, reject) => {
    let attempts = 0;
    const tick = () => {
      if (signal && signal.aborted) return reject(new Error('cancelled'));
      attempts++;
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'der' },
      });
      const pub = Buffer.from(publicKey).subarray(-32);
      let n = 0n;
      for (const b of pub) n = (n << 8n) | BigInt(b);
      let ok = !suffix || n % base === target;
      let addr = null;
      if (ok && prefix) {
        addr = bs58Encode(pub);
        ok = addr.startsWith(prefix);
      }
      if (ok) {
        if (!addr) addr = bs58Encode(pub);
        const seed = Buffer.from(privateKey).subarray(-32);
        return resolve({ address: addr, privateKey: bs58Encode(Buffer.concat([seed, pub])), attempts });
      }
      if (onAttempt && attempts % 250 === 0) onAttempt(attempts);
      if (attempts % 2500 === 0) setImmediate(tick);
      else tick();
    };
    setImmediate(tick);
  });
}

export function deriveAddressFromPrivateKey(pkBase58) {
  try {
    const decoded = bs58Decode(pkBase58);
    const pubkey = decoded.length === 64 ? decoded.subarray(32) : decoded;
    if (pubkey.length !== 32) return null;
    return bs58Encode(pubkey);
  } catch {
    return null;
  }
}

// ───── User-scoped client ─────
export async function createUserClient(telegramId) {
  const creds = await getUserCredentials(telegramId);
  const req = (method, path, params, body, signed) => request(method, path, params, body, signed, creds);
  return {
    getTokenInfo: (chain, address) => req('GET', '/v1/token/info', { chain, address }),
    getTokenSecurity: (chain, address) => req('GET', '/v1/token/security', { chain, address }),
    getTokenHolders: (chain, address, opts = {}) => req('GET', '/v1/token/holders', { chain, address, order_by: opts.orderBy || 'amount_percentage', direction: opts.direction || 'desc', limit: opts.limit || 50 }),
    executeSwap: (chain, from, inputToken, outputToken, amount, opts = {}) => {
      const body = {
        chain, from_address: from, input_token: inputToken, output_token: outputToken,
        input_amount: String(amount),
        slippage: opts.slippage != null ? Number(opts.slippage) : Number(config.sniper.defaultSlippage),
      };
      if (opts.autoSlippage) body.auto_slippage = true;
      if (opts.minOutputAmount) body.min_output_amount = opts.minOutputAmount;
      if (opts.antiMev !== undefined) body.is_anti_mev = opts.antiMev;
      if (opts.priorityFee) body.priority_fee = String(opts.priorityFee);
      if (opts.tipFee) body.tip_fee = String(opts.tipFee);
      if (opts.percent !== undefined) body.input_amount_bps = String(Math.round(opts.percent * 100));
      if (opts.sellRatioType) body.sell_ratio_type = opts.sellRatioType;
      if (opts.conditionOrders) body.condition_orders = opts.conditionOrders;
      return req('POST', '/v1/trade/swap', {}, body, true);
    },
    executeSell: (chain, from, tokenAddress, percent = 100, opts = {}) => {
      const body = {
        chain, from_address: from, input_token: tokenAddress,
        output_token: 'So11111111111111111111111111111111111111112',
        input_amount: '0', input_amount_bps: String(Math.round(percent * 100)),
        slippage: opts.slippage != null ? Number(opts.slippage) : Number(config.sniper.defaultSlippage),
      };
      if (opts.antiMev !== undefined) body.is_anti_mev = opts.antiMev;
      if (opts.priorityFee) body.priority_fee = String(opts.priorityFee);
      if (opts.tipFee) body.tip_fee = String(opts.tipFee);
      return req('POST', '/v1/trade/swap', {}, body, true);
    },
    getWalletTokenBalance: (chain, wallet, token) => req('GET', '/v1/user/wallet_token_balance', { chain, wallet_address: wallet, token_address: token }),
    getWalletHoldings: (chain, wallet, opts = {}) => req('GET', '/v1/user/wallet_holdings', { chain, wallet_address: wallet, limit: opts.limit || 50, order_by: opts.orderBy || 'usd_value', direction: opts.direction || 'desc' }, null, true),
    getWalletStats: (chain, wallet, period = '7d') => req('GET', '/v1/user/wallet_stats', { chain, wallet_address: wallet, period }),
    getWalletActivity: (chain, wallet, opts = {}) => req('GET', '/v1/user/wallet_activity', { chain, wallet_address: wallet, limit: opts.limit || 20 }),
    createLimitSell: (chain, from, tokenAddress, targetPriceUsd, percent = 100) => {
      const b = {
        chain, from_address: from, base_token: tokenAddress,
        quote_token: 'So11111111111111111111111111111111111111112',
        order_type: 'limit_order', sub_order_type: 'take_profit',
        check_price: String(targetPriceUsd), amount_in_percent: percent,
        group_tag: 'LimitOrder',
      };
      return req('POST', '/v1/order/strategy/create', {}, b, true);
    },
    cancelStrategyOrder: (chain, from, orderId) => req('POST', '/v1/order/strategy/cancel', {}, { chain, from_address: from, order_id: orderId }, true),
    getPortfolioInfo: () => req('GET', '/v1/user/info'),
    executeBuyWithTP: (chain, from, tokenAddress, amountLamports, opts = {}) => {
      const conditions = [];
      if (opts.takeProfitPercent) conditions.push({ order_type: 'profit_stop', side: 'sell', price_scale: String(opts.takeProfitPercent), sell_ratio: '100' });
      if (opts.stopLossPercent) conditions.push({ order_type: 'loss_stop', side: 'sell', price_scale: String(Math.abs(opts.stopLossPercent)), sell_ratio: '100' });
      if (opts.takeProfitPartialPercent) conditions.push({ order_type: 'profit_stop', side: 'sell', price_scale: String(opts.takeProfitPartialPercent), sell_ratio: String(opts.takeProfitPartialRatio || '50') });
      const swapBody = {
        chain, from_address: from, input_token: 'So11111111111111111111111111111111111111112',
        output_token: tokenAddress, input_amount: String(amountLamports),
        slippage: opts.slippage != null ? Number(opts.slippage) : Number(config.sniper.defaultSlippage),
        sell_ratio_type: 'hold_amount',
      };
      if (conditions.length) swapBody.condition_orders = conditions;
      if (opts.antiMev !== undefined) swapBody.is_anti_mev = opts.antiMev;
      if (opts.priorityFee) swapBody.priority_fee = String(opts.priorityFee);
      if (opts.tipFee) swapBody.tip_fee = String(opts.tipFee);
      return req('POST', '/v1/trade/swap', {}, swapBody, true);
    },
  };
}

// ───── Connection Warmup ─────
export async function warmupConnection() {
  try {
    await request('GET', '/v1/market/rank', { chain: 'sol', limit: 1 });
  } catch {}
}

export { CHAIN_CURRENCIES };
