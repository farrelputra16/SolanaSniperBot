import * as crypto from 'crypto';
import { config } from './config.js';

const { apiKey, privateKey, host } = config.gmgn;

let algorithm = null;

function detectAlgorithm() {
  if (algorithm) return algorithm;
  if (!privateKey) return null;
  try {
    const key = crypto.createPrivateKey(privateKey.trim());
    algorithm = key.asymmetricKeyType === 'ed25519' ? 'Ed25519' : 'RSA-SHA256';
    return algorithm;
  } catch {
    return null;
  }
}

function buildAuthQuery() {
  return { timestamp: Math.floor(Date.now() / 1000), client_id: crypto.randomUUID() };
}

function signMessage(message) {
  const algo = detectAlgorithm();
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

async function request(method, path, params = {}, body = null, signed = false) {
  const authQuery = buildAuthQuery();
  const allParams = { ...params, ...authQuery };

  function buildSortedQS(obj) {
    return Object.entries(obj)
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([k, v]) => {
        if (Array.isArray(v)) return v.sort().map((i) => `${encodeURIComponent(k)}=${encodeURIComponent(String(i))}`);
        return [`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`];
      })
      .join('&');
  }

  const qs = buildSortedQS(allParams);
  const url = `${host}${path}?${qs}`;
  const headers = {
    'X-APIKEY': apiKey,
    'Content-Type': 'application/json',
    'User-Agent': 'sniper-bot/1.0',
  };

  if (signed && privateKey) {
    const bodyStr = body ? JSON.stringify(body) : '';
    const sortedQs = buildSortedQS(allParams);
    const message = `${path}:${sortedQs}:${bodyStr}:${authQuery.timestamp}`;
    headers['X-Signature'] = signMessage(message);
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await res.json();

  if (!res.ok) {
    const err = new Error(json.message || json.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = json.code;
    err.body = json;
    throw err;
  }

  return json;
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

// ───── Token Data ─────
export async function getTokenInfo(chain, address) {
  return request('GET', '/v1/token/info', { chain, address });
}

export async function getTokenSecurity(chain, address) {
  return request('GET', '/v1/token/security', { chain, address });
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
    chain, from, input_token: inputToken, output_token: outputToken,
    amount: String(amount), slippage: String(slippage),
  });
}

export async function executeSwap(chain, from, inputToken, outputToken, amount, opts = {}) {
  const body = {
    chain,
    from,
    input_token: inputToken,
    output_token: outputToken,
    amount: String(amount),
    slippage: String(opts.slippage ?? config.sniper.defaultSlippage),
    anti_mev: opts.antiMev !== undefined ? opts.antiMev : config.sniper.defaultAntiMev,
  };
  if (opts.autoSlippage) body.auto_slippage = true;
  if (opts.priorityFee) body.priority_fee = String(opts.priorityFee);
  if (opts.tipFee) body.tip_fee = String(opts.tipFee);
  if (opts.percent !== undefined) body.percent = opts.percent;
  if (opts.sellRatioType) body.sell_ratio_type = opts.sellRatioType;
  if (opts.conditionOrders) body.condition_orders = opts.conditionOrders;

  return request('POST', '/v1/trade/swap', {}, body, true);
}

export async function executeSell(chain, from, tokenAddress, percent = 100, opts = {}) {
  const body = {
    chain,
    from,
    input_token: tokenAddress,
    output_token: 'So11111111111111111111111111111111111111112',
    amount: '0',
    percent: percent > 0 ? percent : 100,
    slippage: String(opts.slippage ?? config.sniper.defaultSlippage),
    anti_mev: opts.antiMev !== undefined ? opts.antiMev : config.sniper.defaultAntiMev,
  };
  if (opts.sellRatioType) body.sell_ratio_type = opts.sellRatioType;
  return request('POST', '/v1/trade/swap', {}, body, true);
}

export async function executeBuyWithTP(chain, from, tokenAddress, amountLamports, opts = {}) {
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
  });
}

export async function executeMultiSwap(chain, accounts, inputToken, outputToken, inputAmounts, opts = {}) {
  const body = {
    chain,
    accounts: Array.isArray(accounts) ? accounts : [accounts],
    input_token: inputToken,
    output_token: outputToken,
    input_amount: inputAmounts,
    slippage: String(opts.slippage ?? config.sniper.defaultSlippage),
    anti_mev: opts.antiMev !== undefined ? opts.antiMev : config.sniper.defaultAntiMev,
  };
  return request('POST', '/v1/trade/multi_swap', {}, body, true);
}

export async function getOrder(chain, orderId) {
  return request('GET', '/v1/trade/query_order', { chain, order_id: orderId });
}

// ───── Strategy Orders (Limit / TP-SL) ─────
export async function createStrategyOrder(chain, from, baseToken, quoteToken, opts = {}) {
  const body = {
    chain,
    from,
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
  const body = { chain, from, order_id: orderId };
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

  for (const addr of solMatches) {
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
  const params = { chain, wallet, limit: opts.limit || 50, order_by: opts.orderBy || 'usd_value', direction: opts.direction || 'desc' };
  if (opts.sellOut) params['sell_out'] = true;
  return request('GET', '/v1/user/wallet_holdings', params);
}

export async function getWalletStats(chain, wallet, period = '7d') {
  return request('GET', '/v1/user/wallet_stats', { chain, wallet, period });
}

export async function getWalletTokenBalance(chain, wallet, token) {
  return request('GET', '/v1/user/wallet_token_balance', { chain, wallet, token });
}

export async function getWalletActivity(chain, wallet, opts = {}) {
  const params = { chain, wallet, limit: opts.limit || 20 };
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

export { CHAIN_CURRENCIES };
