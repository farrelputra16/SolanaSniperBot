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
  return {
    timestamp: Math.floor(Date.now() / 1000),
    client_id: crypto.randomUUID(),
  };
}

function signMessage(message) {
  const algo = detectAlgorithm();
  if (!algo) throw new Error('Private key tidak valid atau tidak ditemukan');
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
  const qs = Object.entries(allParams)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([k, v]) => {
      if (Array.isArray(v)) return v.sort().map((i) => `${encodeURIComponent(k)}=${encodeURIComponent(String(i))}`);
      return [`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`];
    })
    .join('&');

  const url = `${host}${path}?${qs}`;
  const headers = {
    'X-APIKEY': apiKey,
    'Content-Type': 'application/json',
    'User-Agent': 'sniper-bot/1.0',
  };

  if (signed && privateKey) {
    const bodyStr = body ? JSON.stringify(body) : '';
    const sortedQs = Object.entries(allParams)
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([k, v]) => {
        if (Array.isArray(v)) return v.sort().map((i) => `${encodeURIComponent(k)}=${encodeURIComponent(String(i))}`);
        return [`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`];
      })
      .join('&');
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

// ─── Market Data ───
export async function getTrending(chain = 'sol', interval = '1h', opts = {}) {
  const params = { chain, interval, ...opts };
  return request('GET', '/v1/market/rank', params);
}

export async function getTrenches(chain = 'sol', type = null, opts = {}) {
  const body = buildTrenchesBody(chain, type, opts);
  return request('POST', '/v1/trenches', {}, body);
}

export async function getTokenSignal(chain = 'sol') {
  return request('POST', '/v1/market/token_signal', {}, { chain });
}

export async function getTokenInfo(chain, address) {
  return request('GET', '/v1/token/info', { chain, address });
}

export async function getTokenSecurity(chain, address) {
  return request('GET', '/v1/token/security', { chain, address });
}

export async function getSmartMoneyTrades(chain = 'sol', limit = 100) {
  return request('GET', '/v1/user/smartmoney', { chain, limit });
}

export async function getKOLTrades(chain = 'sol', limit = 100) {
  return request('GET', '/v1/user/kol', { chain, limit });
}

// ─── Swap (signed) ───
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
    slippage: String(opts.slippage || config.sniper.defaultSlippage),
    anti_mev: opts.antiMev !== undefined ? opts.antiMev : config.sniper.defaultAntiMev,
  };
  if (opts.autoSlippage) body.auto_slippage = true;
  if (opts.priorityFee) body.priority_fee = String(opts.priorityFee);
  if (opts.tipFee) body.tip_fee = String(opts.tipFee);

  return request('POST', '/v1/trade/swap', {}, body, true);
}

export async function getOrder(chain, orderId) {
  return request('GET', '/v1/trade/query_order', { chain, order_id: orderId });
}

// ─── Helpers ───
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

// ─── Token Address Extraction ───
const BASE58_REGEX = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
const EVM_ADDRESS_REGEX = /0x[a-fA-F0-9]{40}/g;

export function extractAddresses(text) {
  const addresses = [];
  const solMatches = text.match(BASE58_REGEX) || [];
  const evmMatches = text.match(EVM_ADDRESS_REGEX) || [];

  for (const addr of solMatches) {
    if (addr.length >= 32 && addr.length <= 44) {
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
