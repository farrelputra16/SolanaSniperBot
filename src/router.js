import { extractAddresses, getTokenInfo, getTokenSecurity, executeSwap, getOrder, getUserCredentials, getWalletHoldings, getWalletTokenBalance } from './gmgn.js';
import { getDexScreenerInfo } from './dexscreener.js';
import * as db from './database.js';
import { config } from './config.js';
import { sendToChat } from './telegram.js';
import { liveEvents } from './web-server.js';

const CURRENCY_ADDRESSES = {
  sol: 'So11111111111111111111111111111111111111112',
};
const STABLECOIN_ADDRESSES = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'mSoLzYCxHdYgWUCh4PkK7Z4dUsk5zEZmz8m6Z6w1jJ',   // mSOL
]);

const _seenCAs = new Map();  // key: channel:address, value: timestamp
const SEEN_CA_TTL = 300000; // 5 min
let _dedupStats = { total_caught: 0, total_ignored: 0, per_channel: {} };

export function getDedupStats() { return _dedupStats; }

function bumpDedup(channel, type) {
  let entry = _dedupStats.per_channel[channel];
  if (!entry || typeof entry !== 'object') entry = _dedupStats.per_channel[channel] = { caught: 0, ignored: 0 };
  if (type === 'caught') { entry.caught++; _dedupStats.total_caught++; }
  else { entry.ignored++; _dedupStats.total_ignored++; }
}

function getCacheSize() { return _seenCAs.size; }
const _channelDedupCache = new Map(); // key: channel, value: { enabled, ts }
const CHANNEL_DEDUP_TTL = 30000; // 30s

async function isIgnoreDuplicate(channel) {
  const cached = _channelDedupCache.get(channel);
  if (cached && Date.now() - cached.ts < CHANNEL_DEDUP_TTL) return cached.enabled;
  const channels = await db.getAllChannels();
  const ch = channels.find(c => c.channel_username === channel);
  const enabled = !!(ch && ch.ignore_duplicate);
  _channelDedupCache.set(channel, { enabled, ts: Date.now() });
  return enabled;
}

let _rulesCache = null;
let _rulesCacheTs = 0;
const _walletCache = new Map();

async function getCachedRules() {
  const now = Date.now();
  if (_rulesCache && (now - _rulesCacheTs) < 5000) return _rulesCache;
  _rulesCache = await db.getAutoBuyRules();
  _rulesCacheTs = now;
  return _rulesCache;
}

function getCachedWallet(key, fetcher) {
  const hit = _walletCache.get(key);
  if (hit && Date.now() - hit.ts < 30000) return hit.data;
  const data = fetcher();
  if (data && typeof data.then === 'function') {
    return data.then(w => {
      if (w) _walletCache.set(key, { data: w, ts: Date.now() });
      return w;
    });
  }
  if (data) _walletCache.set(key, { data, ts: Date.now() });
  return data;
}

// Background wallet cache warmer — keeps cache hot so blind buy never waits on DB
let _warmingTimer = null;
export function startWalletWarmer() {
  if (_warmingTimer) return;
  _warmingTimer = setInterval(async () => {
    try {
      const [active, groups] = await Promise.all([
        db.getActiveWallet(),
        db.getWalletGroups(),
      ]);
      if (active) _walletCache.set('active', { data: active, ts: Date.now() });
      for (const g of (groups || [])) {
        getCachedWallet(`group:${g.id}`, () => db.getGroupWallets(g.id));
      }
    } catch {}
  }, 25000);
}

export async function processSignal(sourceChannel, text, message, senderUsername) {
  const t0 = Date.now();

  const [found, allRules] = await Promise.all([
    Promise.resolve().then(() => extractAddresses(text)),
    getCachedRules(),
  ]);
  if (found.length === 0) return;
  db.addScraperLog(sourceChannel, 'info', `CA ${found.map(f=>f.address).join(', ')}`).catch(() => {});
  const captureLatency = Date.now() - t0;
  console.log(`📡 CA captured in ${captureLatency}ms | ${found.length} address(es)`);

  // Pre-warm wallet cache for faster blind buy
  for (const rule of allRules) {
    if (rule.blind_buy || rule.auto_buy) resolveWallets(rule).catch(() => {});
  }

  await Promise.allSettled(found.map(({ address, chain }) =>
    processAddress(address, chain, sourceChannel, text, senderUsername, allRules, t0)
  ));
}

function parseTokenData(info, security, chain, address, sourceChannel, text, dexFallback) {
  const tokenData = info.data || info || {};
  const securityData = security?.data || security || {};

  // GMGN returns price as either `price_usd`, a `price` object ({price, ...}), or a plain number
  const rawPrice = tokenData.price_usd != null ? tokenData.price_usd
    : (tokenData.price && typeof tokenData.price === 'object' ? tokenData.price.price : tokenData.price);
  const price = parseFloat(rawPrice) || dexFallback?.priceUsd || 0;

  const supply = parseFloat(tokenData.circulating_supply) || parseFloat(tokenData.total_supply);
  const market_cap = parseFloat(tokenData.market_cap)
    || (price && supply ? price * supply : 0)
    || dexFallback?.marketCap || 0;

  return {
    token_symbol: tokenData.symbol || dexFallback?.tokenSymbol || '',
    token_name: tokenData.name || dexFallback?.tokenName || '',
    price,
    market_cap,
    liquidity: parseFloat(tokenData.liquidity) || dexFallback?.liquidity || 0,
    volume_24h: parseFloat(tokenData.volume_24h) || dexFallback?.volume24h || 0,
    rug_ratio: securityData.rug_ratio !== undefined ? securityData.rug_ratio : -1,
    smart_degen_count: securityData.smart_degen_count || tokenData.smart_degen_count || 0,
    bundler_rate: securityData.bundler_rate || 0,
    top10_rate: securityData.top10_rate || 0,
    creator_status: securityData.creator_status || tokenData.creator_status || '',
    is_honeypot: securityData.is_honeypot !== undefined ? String(securityData.is_honeypot) : '',
  };
}

async function processAddress(address, chain, sourceChannel, text, senderUsername, allRules, t0) {
  const matchingRules = allRules.filter(r => r.channel_username === sourceChannel);
  const blindRules = matchingRules.filter(r => r.blind_buy);
  const normalRules = matchingRules.filter(r => !r.blind_buy && r.auto_buy);

  // BLIND BUY: fire IMMEDIATELY — zero delay, no await, no dedup check
  for (const rule of blindRules) {
    executeAutoBuy(address, chain, rule, sourceChannel, t0);
  }

  // Dedup check runs in parallel — doesn't block blind buy
  const ignoreDup = await isIgnoreDuplicate(sourceChannel);
  if (ignoreDup) {
    const key = `${sourceChannel}:${address}`;
    const seen = _seenCAs.get(key);
    if (seen && Date.now() - seen < SEEN_CA_TTL) {
      bumpDedup(sourceChannel, 'ignored');
      return;
    }
    _seenCAs.set(key, Date.now());
    if (_seenCAs.size > 1000) {
      const threshold = Date.now() - SEEN_CA_TTL;
      for (const [k, ts] of _seenCAs) if (ts < threshold) _seenCAs.delete(k);
    }
  }
  bumpDedup(sourceChannel, 'caught');

  // Save signal — appears on dashboard
  const now = Math.floor(Date.now() / 1000);
  const placeholder = { token_address: address, token_symbol: '', chain, source_channel: sourceChannel, source_text: text, price: 0, market_cap: 0, liquidity: 0, sender_username: senderUsername || '', latency_ms: Date.now() - t0 };
  const signalId = await db.saveSignal(placeholder).catch(() => null);
  db.trimSignals(5).catch(()=>{});

  liveEvents.emit('signal', {
    _tid: db.getTelegramId(), token_symbol: '', id: signalId, token_address: address, source_channel: sourceChannel,
    market_cap: 0, liquidity: 0, latency_ms: Date.now() - t0,
    sender_username: senderUsername, created_at: now,
  });

  // Fetch data from DexScreener (fast) + GMGN (detailed) — both fire-and-forget, non-blocking
  const dexPromise = getDexScreenerInfo(chain, address).catch(() => null);
  dexPromise.then(dexData => {
    if (!dexData || !signalId) return;
    const catchedMc = dexData.marketCap || 0;
    const update = {
      token_symbol: dexData.tokenSymbol || '',
      token_name: dexData.tokenName || '',
      price: dexData.priceUsd || 0,
      market_cap: dexData.marketCap || 0,
      liquidity: dexData.liquidity || 0,
      volume_24h: dexData.volume24h || 0,
      sender_username: senderUsername || '',
      latency_ms: Date.now() - t0,
      catched_mc: catchedMc,
    };
    db.updateSignal(signalId, update).catch(() => {});
    liveEvents.emit('signal_update', {
      _tid: db.getTelegramId(), id: signalId, src: 'dex', token_symbol: update.token_symbol, token_name: update.token_name, token_address: address, source_channel: sourceChannel,
      market_cap: update.market_cap, price: update.price, liquidity: update.liquidity, volume_24h: update.volume_24h,
      rug_ratio: -1, smart_degen_count: 0, catched_mc: catchedMc,
      latency_ms: Date.now() - t0, sender_username: senderUsername, created_at: now,
    });
    forwardSignal(sourceChannel, address, update, text, null);
  }).catch(() => {});

  Promise.all([getTokenInfo(chain, address).catch(() => null), getTokenSecurity(chain, address).catch(() => null), dexPromise])
    .then(([info, security, dexData]) => {
      if (!info || (info.code && info.code !== 0)) return;
      const gmgnData = parseTokenData(info, security, chain, address, sourceChannel, text, dexData);
      gmgnData.sender_username = senderUsername || '';
      gmgnData.latency_ms = Date.now() - t0;
      const gmgnLatency = Date.now() - t0;
      if (signalId) db.updateSignal(signalId, gmgnData).catch(() => {});
      liveEvents.emit('signal_update', {
        _tid: db.getTelegramId(), id: signalId, src: 'gmgn', token_symbol: gmgnData.token_symbol, token_name: gmgnData.token_name, token_address: address, source_channel: sourceChannel,
        market_cap: gmgnData.market_cap, price: gmgnData.price, liquidity: gmgnData.liquidity, volume_24h: gmgnData.volume_24h,
        rug_ratio: gmgnData.rug_ratio, smart_degen_count: gmgnData.smart_degen_count,
        is_honeypot: gmgnData.is_honeypot, creator_status: gmgnData.creator_status, bundler_rate: gmgnData.bundler_rate, top10_rate: gmgnData.top10_rate,
        latency_ms: gmgnLatency, sender_username: senderUsername, created_at: now,
      });

      // Normal auto-buy with filter check — only executes after GMGN data arrives
      for (const rule of normalRules) {
        if (passesFilter(rule, gmgnData)) {
          executeAutoBuy(address, chain, rule, sourceChannel, t0);
        }
      }

      console.log(`⚡ SIGNAL ${gmgnData.token_symbol||address} | GMGN=${gmgnLatency}ms ${normalRules.filter(r => passesFilter(r, gmgnData)).length?'🟢 swap ✅':'⏸️'}`);
    })
    .catch(() => console.warn(`[Router] GMGN failed for ${address}, DexScreener data used.`));
}

function passesFilter(rule, tokenData) {
  if (rule.blind_buy) return true;
  if (rule.min_market_cap != null && tokenData.market_cap < rule.min_market_cap) return false;
  if (rule.max_market_cap != null && tokenData.market_cap > rule.max_market_cap) return false;
  if (rule.min_liquidity != null && tokenData.liquidity < rule.min_liquidity) return false;
  if (rule.max_liquidity != null && tokenData.liquidity > rule.max_liquidity) return false;
  return true;
}

function forwardSignal(sourceChannel, address, data, text, error) {
  db.getSetting('forward_to_chat', '').then(target => {
    if (!target) return;
    let msg;
    if (error && !data) {
      msg = `⚠️ ${sourceChannel}\n\`${address}\`\n${error}`;
    } else if (error) {
      msg = `⚠️ ${sourceChannel} | ${data.token_symbol || address}\n\`${address}\`\n${error}`;
    } else if (!data) {
      return;
    } else {
      const hasVol = data.volume_24h > 0;
      msg = `📡 *${sourceChannel}*\n\`${address}\`\n💰 *${data.token_symbol || '?'}* · 🎯 Catched at $${data.market_cap ? data.market_cap.toFixed(0) : '?'} MC\n💧 $${data.liquidity ? data.liquidity.toFixed(0) : '?'} Liq${hasVol ? ` · 📊 $${data.volume_24h > 1000 ? (data.volume_24h / 1000).toFixed(1) + 'K' : data.volume_24h.toFixed(0)} Vol` : ''}`;
    }
    sendToChat(target, msg).catch(() => {});
  }).catch(() => {});
}

function resolveWalletsSync(rule) {
  if (rule.wallet_group_id && rule.wallet_group_id > 0) {
    const cached = _walletCache.get(`group:${rule.wallet_group_id}`);
    if (cached && Date.now() - cached.ts < 30000) return cached.data || [];
  }
  if (rule.wallet_group_id && rule.wallet_group_id < 0) {
    const cached = _walletCache.get(`wallet:${Math.abs(rule.wallet_group_id)}`);
    if (cached && Date.now() - cached.ts < 30000) return cached.data ? [cached.data] : [];
  }
  const cached = _walletCache.get('active');
  if (cached && Date.now() - cached.ts < 30000) return cached.data ? [cached.data] : [];
  return null;
}

function resolveWallets(rule) {
  const sync = resolveWalletsSync(rule);
  if (sync) return Promise.resolve(sync);
  if (rule.wallet_group_id && rule.wallet_group_id > 0) {
    return Promise.resolve(getCachedWallet(`group:${rule.wallet_group_id}`, () => db.getGroupWallets(rule.wallet_group_id)));
  }
  if (rule.wallet_group_id && rule.wallet_group_id < 0) {
    return Promise.resolve(getCachedWallet(`wallet:${Math.abs(rule.wallet_group_id)}`, () => db.getWallet(Math.abs(rule.wallet_group_id))))
      .then(w => w ? [w] : []);
  }
  return Promise.resolve(getCachedWallet('active', () => db.getActiveWallet()))
    .then(w => w ? [w] : []);
}

function blindBuyWallet() {
  const hit = _walletCache.get('active');
  return hit && Date.now() - hit.ts < 30000 ? hit.data : null;
}

async function executeAutoBuy(address, chain, rule, sourceChannel, t0) {
  if (!rule.auto_buy && !rule.blind_buy) return;
  if (rule.track_only) return;
  if (rule.telegram_id) db.setTelegramId(rule.telegram_id);

  if (rule.blind_buy) {
    const wallet = blindBuyWallet();
    if (!wallet) {
      db.addScraperLog(sourceChannel, 'error', `Blind buy ${address} failed: no cached wallet`).catch(() => {});
      return;
    }
    const lamports = Math.floor(rule.buy_amount_sol * 1_000_000_000);
    executeSwap(chain, wallet.address, CURRENCY_ADDRESSES[chain], address, lamports, {
      slippage: rule.slippage,
      antiMev: !!rule.anti_mev,
      priorityFee: rule.priority_fee && rule.priority_fee >= 0 ? rule.priority_fee : undefined,
      tipFee: rule.tip_fee && rule.tip_fee >= 0 ? rule.tip_fee : undefined,
    }).then(result => {
      const o = result.data || result;
      console.log(`⚡ BLIND ${address.slice(0,8)}... | ${Date.now()-t0}ms | order=${o.order_id}`);
      db.addScraperLog(sourceChannel, 'info', `Blind buy ${address}: order=${o.order_id}`).catch(() => {});
      db.setTelegramId(rule.telegram_id);
      db.createTrade({
        wallet_address: wallet.address, token_address: address, token_symbol: 'PENDING',
        chain, buy_amount_sol: lamports / 1e9, buy_price: 0, buy_price_usd: 0,
        buy_order_id: o.order_id, signal_latency_ms: Date.now() - t0, buy_latency_ms: 0,
        source_channel: sourceChannel,
      }).then(tid => { if (tid && o.order_id) pollOrder(o.order_id, chain, tid, null, rule.telegram_id); }).catch(() => {});
    }).catch(err => {
      console.error(`[Router] Blind buy ${address} gagal:`, err.message);
      db.addScraperLog(sourceChannel, 'error', `Blind buy ${address} gagal: ${err.message}`).catch(() => {});
    });
    return;
  }

  const wallets = await resolveWallets(rule);
  if (wallets.length === 0) {
    db.addScraperLog(sourceChannel, 'error', `Auto-buy ${address} failed: no wallets`).catch(() => {});
    return;
  }

  const creds = await getUserCredentials(rule.telegram_id);

  const totalLamports = Math.floor(rule.buy_amount_sol * 1_000_000_000);
  const perWallet = Math.floor(totalLamports / wallets.length);
  const tBuy = Date.now();

  await Promise.allSettled(wallets.map(async (wallet) => {
    try {
      console.log(`[Router] Swap ${perWallet} lamports -> ${address} (${wallet.address})`);

      const conditionOrders = [];
      let tpLevels = [];
      let slLevels = [];
      try { tpLevels = typeof rule.tp_levels === 'string' ? JSON.parse(rule.tp_levels) : (Array.isArray(rule.tp_levels) ? rule.tp_levels : []); } catch {}
      try { slLevels = typeof rule.sl_levels === 'string' ? JSON.parse(rule.sl_levels) : (Array.isArray(rule.sl_levels) ? rule.sl_levels : []); } catch {}
      for (const tp of tpLevels) {
        if (tp && Number(tp.percent) > 0) conditionOrders.push({ order_type: 'profit_stop', side: 'sell', price_scale: String(tp.percent), sell_ratio: String(tp.sell_ratio || 100) });
      }
      if (tpLevels.length === 0 && rule.take_profit_percent) conditionOrders.push({ order_type: 'profit_stop', side: 'sell', price_scale: String(rule.take_profit_percent), sell_ratio: '100' });
      for (const sl of slLevels) {
        if (sl && Number(sl.percent) > 0) conditionOrders.push({ order_type: 'loss_stop', side: 'sell', price_scale: String(Math.abs(sl.percent)), sell_ratio: String(sl.sell_ratio || 100) });
      }
      if (slLevels.length === 0 && rule.stop_loss_percent) conditionOrders.push({ order_type: 'loss_stop', side: 'sell', price_scale: String(Math.abs(rule.stop_loss_percent)), sell_ratio: '100' });
      if (conditionOrders.length > 10) {
        db.addScraperLog(sourceChannel, 'warn', `TP/SL levels capped at 10 (GMGN limit)`).catch(() => {});
        conditionOrders.length = 10;
      }

      const feeOk = chain === 'sol' ? (rule.priority_fee >= 0.00001 && rule.tip_fee >= 0.00001) : (rule.priority_fee > 0 && rule.tip_fee > 0);
      if (conditionOrders.length && !feeOk) {
        db.addScraperLog(sourceChannel, 'warn', `TP/SL skipped: priority_fee/tip_fee too low or missing (SOL min 0.00001)`).catch(() => {});
        conditionOrders.length = 0;
      }

      const result = await executeSwap(chain, wallet.address, CURRENCY_ADDRESSES[chain], address, perWallet, {
        slippage: rule.slippage,
        antiMev: !!rule.anti_mev,
        priorityFee: rule.priority_fee && rule.priority_fee >= 0 ? rule.priority_fee : undefined,
        tipFee: rule.tip_fee && rule.tip_fee >= 0 ? rule.tip_fee : undefined,
        conditionOrders: conditionOrders.length > 0 ? conditionOrders : undefined,
        sellRatioType: conditionOrders.length > 0 ? 'hold_amount' : undefined,
      }, creds);

      const orderRes = result.data || result;
      const orderId = orderRes.order_id;
      const strategyId = orderRes.strategy_order_id;
      const buyLatency = Date.now() - tBuy;
      console.log(`⚡ SIGNAL ${address.slice(0,8)}... | capture=${Date.now()-t0}ms | swap-exec=${buyLatency}ms | order=${orderId}`);
      db.addScraperLog(sourceChannel, 'info', `Auto-buy ${address}: order=${orderId}`).catch(() => {});

      const tradeId = await db.createTrade({
        wallet_address: wallet.address,
        token_address: address,
        token_symbol: 'PENDING',
        chain,
        buy_amount_sol: perWallet / 1e9,
        buy_price: 0,
        buy_price_usd: 0,
        buy_order_id: orderId,
        signal_latency_ms: t0 ? Date.now() - t0 : 0,
        buy_latency_ms: buyLatency,
        take_profit_percent: rule.take_profit_percent,
        stop_loss_percent: rule.stop_loss_percent,
        source_channel: sourceChannel,
      });

      if (strategyId) {
        db.saveStrategyOrder({
          trade_id: tradeId,
          wallet_address: wallet.address,
          token_address: address,
          token_symbol: 'PENDING',
          chain,
          order_type: 'condition_order',
          sub_order_type: 'mix_trade',
          group_tag: 'STMix',
          remote_order_id: strategyId,
        }).catch(() => {});
      }

      liveEvents.emit('trade', {
        _tid: db.getTelegramId(), token_symbol: 'PENDING', token_address: address, wallet: wallet.address,
        amount: perWallet / 1e9, signal_latency_ms: t0 ? Date.now() - t0 : 0,
        buy_latency_ms: buyLatency, status: 'pending', trade_id: tradeId,
      });

      pollOrder(orderId, chain, tradeId, creds, rule.telegram_id);
    } catch (err) {
      const errCode = err.code ? `[${err.code}] ` : '';
      let detail = err.body?.message || err.body?.error || err.message || '';
      if (!detail || detail === err.message) {
        try { detail = JSON.stringify(err.response?.data || err.data || err).slice(0,300); } catch {}
      }
      if (!detail || detail === '{}') detail = err.message || 'Unknown error';
      console.error(`[Router] Gagal auto-buy ${address} (${wallet.address}):`, detail);
      db.addScraperLog(sourceChannel, 'error', `Swap ${address} gagal: ${String(detail).slice(0,200)}`).catch(() => {});
    }
  }));
}

async function pollOrder(orderId, chain, tradeId, creds = null, telegramId = null) {
  let attempts = 0;
  const maxAttempts = 15;
  if (telegramId) db.setTelegramId(telegramId);

  while (attempts < maxAttempts) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const result = await getOrder(chain, orderId, creds);
      const status = (result.data?.status || result.status || '').toLowerCase();

      if (status === 'confirmed' || status === 'successful' || status === 'success' || status === 'filled') {
        const report = result.data?.report || result.report;
        const buyTx = report?.hash || result.data?.hash || result.hash;

        if (telegramId) db.setTelegramId(telegramId);
        let priceUsd = report?.price_usd ? parseFloat(report.price_usd) : undefined;
        let symbol;
        let infoPrice;
        let infoMcap;
        try {
          const t = await db.getTrade(tradeId);
          if (t) {
            symbol = t.token_symbol && t.token_symbol !== 'PENDING' ? t.token_symbol : undefined;
            if (t.token_address) {
              const info = await getTokenInfo(t.chain || chain, t.token_address);
              const raw = info?.data || info?.info || info || {};
              if (!symbol) symbol = raw.symbol || raw.base_token?.symbol;
              infoPrice = parseFloat(raw.price_usd ?? raw.price?.price ?? raw.price);
              const infoSupply = parseFloat(raw.circulating_supply) || parseFloat(raw.total_supply);
              infoMcap = parseFloat(raw.market_cap) || (infoPrice && infoSupply ? infoPrice * infoSupply : NaN);
              if (priceUsd == null && !isNaN(infoPrice)) priceUsd = infoPrice;
            }
          }
        } catch {}

        const upd = { buy_status: 'confirmed', buy_tx: buyTx };
        if (priceUsd != null) upd.buy_price_usd = priceUsd;
        if (symbol) upd.token_symbol = symbol;
        if (priceUsd != null && infoMcap && infoPrice) upd.buy_market_cap = (priceUsd / infoPrice) * infoMcap;
        await db.updateTrade(tradeId, upd);
        liveEvents.emit('trade_update', { _tid: telegramId || db.getTelegramId(), trade_id: tradeId, status: 'confirmed', buy_tx: buyTx, token_symbol: symbol });
        console.log(`[Router] ✅ Buy confirmed: ${orderId}`);
        return;
      }

      if (status === 'failed' || status === 'expired') {
        if (telegramId) db.setTelegramId(telegramId);
        await db.updateTrade(tradeId, { buy_status: 'failed', status: 'failed' });
        liveEvents.emit('trade_update', { _tid: telegramId || db.getTelegramId(), trade_id: tradeId, status: 'failed' });
        console.log(`[Router] ❌ Buy failed: ${orderId}`);
        return;
      }

      if (!status || status === 'pending' || status === 'processed') {
        attempts++;
        continue;
      }

      attempts++;
    } catch (err) {
      console.log(`[Router] pollOrder ${orderId} error (attempt ${attempts+1}): ${err.message}`);
      attempts++;
    }
  }

  if (telegramId) db.setTelegramId(telegramId);
  await db.updateTrade(tradeId, { buy_status: 'timeout' });
  liveEvents.emit('trade_update', { _tid: telegramId || db.getTelegramId(), trade_id: tradeId, status: 'timeout' });
  console.log(`[Router] ⏰ Buy polling timeout: ${orderId} (order still may confirm later)`);
}

export async function backfillPendingTrades() {
  try {
    const stuck = await db.getStuckTrades();
    if (!stuck.length) return;
    const byUser = {};
    for (const t of stuck) {
      const tid = t.telegram_id || '';
      (byUser[tid] = byUser[tid] || []).push(t);
    }
    for (const [tid, trades] of Object.entries(byUser)) {
      db.setTelegramId(tid);
      const creds = await getUserCredentials(tid || null);
      console.log(`[Router] Backfilling ${trades.length} stale pending trades (user ${tid || 'env'})...`);
      for (const t of trades) {
        pollOrder(t.buy_order_id, t.chain || 'sol', t.id, creds, tid || null).catch(() => {});
      }
    }
  } catch (e) {
    console.log(`[Router] backfillPendingTrades error: ${e.message}`);
  }
}

export async function backfillTradeMetadata() {
  try {
    const trades = await db.getAllTrades(500);
    const needSym = trades.filter(t => !t.token_symbol || t.token_symbol === 'PENDING' || !t.buy_market_cap);
    if (!needSym.length) return { updated: 0 };
    let updated = 0;
    for (const t of needSym) {
      if (!t.token_address) continue;
      let raw;
      try {
        const info = await getTokenInfo(t.chain || 'sol', t.token_address);
        raw = info?.data || info?.info || info || {};
      } catch { continue; }
      const symbol = raw.symbol || raw.base_token?.symbol;
      const priceRaw = raw.price_usd != null ? raw.price_usd : (raw.price && typeof raw.price === 'object' ? raw.price.price : raw.price);
      const price = parseFloat(priceRaw);
      const supply = parseFloat(raw.circulating_supply) || parseFloat(raw.total_supply);
      const mcap = parseFloat(raw.market_cap) || (price && supply ? price * supply : NaN);
      const upd = {};
      if (symbol && (!t.token_symbol || t.token_symbol === 'PENDING')) upd.token_symbol = symbol;
      if (t.buy_price_usd && price && mcap && !t.buy_market_cap) upd.buy_market_cap = (t.buy_price_usd / price) * mcap;
      if (!Object.keys(upd).length) continue;
      db.setTelegramId(t.telegram_id);
      await db.updateTrade(t.id, upd);
      updated++;
      console.log(`[Router] Enriched trade ${t.id}: ${symbol} buy_mcap=${upd.buy_market_cap ? upd.buy_market_cap.toFixed(0) : 'n/a'}`);
    }
    return { updated };
  } catch (e) {
    console.log(`[Router] backfillTradeMetadata error: ${e.message}`);
    return { updated: 0 };
  }
}

export async function reconcileOpenPositions() {
  try {
    const now = Date.now();
    if (now - _lastReconcile < RECONCILE_COOLDOWN) return { closed: 0, reopened: 0 };
    _lastReconcile = now;

    const [open, all] = await Promise.all([db.getOpenTrades(), db.getTradeHistory(500)]);
    let closed = 0;
    let reopened = 0;

    // Close confirmed trades whose token balance is confirmed 0 (sold on-chain)
    for (const t of open) {
      if (!t.wallet_address || !t.token_address || t.buy_status !== 'confirmed') continue;
      const ageMs = now - (t.created_at ? t.created_at * 1000 : 0);
      if (ageMs < 5 * 60000) continue;
      let held;
      try { held = await walletHoldsToken(t.wallet_address, t.token_address, t.chain || 'sol'); } catch { continue; }
      if (held === false) {
        try {
          db.setTelegramId(t.telegram_id);
          await db.closeTrade(t.id, { status: 'closed' });
          console.log(`[Router] Position ${t.id} confirmed sold (balance 0) — marked closed`);
          liveEvents.emit('trade_update', { _tid: t.telegram_id || db.getTelegramId(), trade_id: t.id, status: 'closed', reason: 'no_balance' });
          closed++;
        } catch {}
      }
    }

    // Reopen trades that were auto-closed (no sell order/tx) but still hold the token
    const verifyCutoff = now - 24 * 3600 * 1000;
    const reconcileClosed = all.filter(t => t.status === 'closed' && !t.sell_order_id && !t.sell_tx && (!t.reconcile_verified_at || t.reconcile_verified_at < verifyCutoff));
    for (const t of reconcileClosed) {
      if (!t.wallet_address || !t.token_address) continue;
      let held;
      try { held = await walletHoldsToken(t.wallet_address, t.token_address, t.chain || 'sol'); } catch { continue; }
      if (held === null) continue;
      try {
        db.setTelegramId(t.telegram_id);
        await db.updateTrade(t.id, { reconcile_verified_at: Date.now() });
        if (held === true) {
          await db.updateTrade(t.id, { status: 'open', closed_at: null });
          console.log(`[Router] Position ${t.id} still held — reopened`);
          liveEvents.emit('trade_update', { _tid: t.telegram_id || db.getTelegramId(), trade_id: t.id, status: 'open', reason: 'reopened' });
          reopened++;
        }
      } catch {}
    }
    return { closed, reopened };
  } catch (e) {
    console.log(`[Router] reconcileOpenPositions error: ${e.message}`);
    return { closed: 0, reopened: 0 };
  }
}

async function walletHoldsToken(wallet, token, chain = 'sol') {
  const r = await getWalletTokenBalance(chain, wallet, token);
  const d = r?.data || r || {};
  const entry = (d.balances || [])[0] || {};
  const raw = parseFloat(entry.balance);
  if (isNaN(raw)) return null;
  return raw > 0;
}

let _lastReconcile = 0;
const RECONCILE_COOLDOWN = 60000;

let _extCache = null;
let _extTs = 0;
const EXT_CACHE_TTL = 20000;

export async function getExternalPositions(openTrades = null, opts = {}) {
  try {
    if (_extCache && Date.now() - _extTs < EXT_CACHE_TTL) return _extCache;
    const open = openTrades || await db.getOpenTrades();
    const tracked = new Set(open.map(t => t.token_address).filter(Boolean));
    const wallets = opts.global ? await db.getAllWalletsGlobal() : await db.getAllWallets();
    const result = [];
    for (const w of wallets) {
      if (!w.address) continue;
      let holdings = [];
      try {
        const r = await getWalletHoldings('sol', w.address, { limit: 300 });
        holdings = r?.data?.list || r?.data?.holdings || r?.data || [];
      } catch { continue; }
      for (const h of holdings) {
        const tok = h.token || {};
        const addr = tok.token_address || tok.address || h.address || h.token_address;
        if (!addr || addr === CURRENCY_ADDRESSES.sol || STABLECOIN_ADDRESSES.has(addr) || tracked.has(addr)) continue;
        if (parseFloat(h.balance) <= 0) continue;
        tracked.add(addr);
        const supply = parseFloat(tok.total_supply) || parseFloat(tok.max_supply);
        const accuAmt = parseFloat(h.accu_amount);
        const accuCost = parseFloat(h.accu_cost);
        const avgCost = accuAmt > 0 && accuCost > 0 ? accuCost / accuAmt : NaN;
        const upnl = parseFloat(h.unrealized_profit_pnl);
        const entry = {
          id: `ext_${addr.slice(0, 12)}`,
          external: true,
          wallet_address: w.address,
          token_address: addr,
          token_symbol: tok.symbol || '',
          chain: 'sol',
          token_balance: parseFloat(h.balance) || null,
          usd_value: parseFloat(h.usd_value) || null,
          buy_price_usd: !isNaN(avgCost) ? avgCost : null,
          buy_market_cap: !isNaN(avgCost) && supply ? avgCost * supply : null,
          pnl_percent: !isNaN(upnl) ? upnl * 100 : null,
          status: 'open',
          buy_status: 'external',
          source_channel: 'External',
          created_at: Date.now(),
        };
        result.push(entry);
      }
    }
    _extCache = result;
    _extTs = Date.now();
    return result;
  } catch (e) {
    console.log(`[Router] getExternalPositions error: ${e.message}`);
    return [];
  }
}


