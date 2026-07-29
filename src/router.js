import { extractAddresses, getTokenInfo, getTokenSecurity, executeSwap, getOrder } from './gmgn.js';
import { getDexScreenerInfo } from './dexscreener.js';
import * as db from './database.js';
import { config } from './config.js';
import { sendToChat } from './telegram.js';
import { liveEvents } from './web-server.js';

const CURRENCY_ADDRESSES = {
  sol: 'So11111111111111111111111111111111111111112',
};

const _seenCAs = new Map();  // key: channel:address, value: timestamp
const SEEN_CA_TTL = 300000; // 5 min
let _dedupStats = { total_caught: 0, total_ignored: 0, per_channel: {} };

export function getDedupStats() { return _dedupStats; }

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

  return {
    token_symbol: tokenData.symbol || dexFallback?.tokenSymbol || '',
    token_name: tokenData.name || dexFallback?.tokenName || '',
    price: parseFloat(tokenData.price_usd) || dexFallback?.priceUsd || 0,
    market_cap: parseFloat(tokenData.market_cap) || dexFallback?.marketCap || 0,
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

  // Forward CA immediately — placeholder, data comes later
  forwardSignal(sourceChannel, address, null, text, null);

  // Dedup check runs in parallel — doesn't block blind buy
  const ignoreDup = await isIgnoreDuplicate(sourceChannel);
  if (ignoreDup) {
    const key = `${sourceChannel}:${address}`;
    const seen = _seenCAs.get(key);
    if (seen && Date.now() - seen < SEEN_CA_TTL) {
      _dedupStats.total_ignored++;
      _dedupStats.per_channel[sourceChannel] = (_dedupStats.per_channel[sourceChannel]?.ignored || 0) + 1;
      return;
    }
    _seenCAs.set(key, Date.now());
    if (_seenCAs.size > 1000) {
      const threshold = Date.now() - SEEN_CA_TTL;
      for (const [k, ts] of _seenCAs) if (ts < threshold) _seenCAs.delete(k);
    }
  }
  _dedupStats.total_caught++;
  if (!_dedupStats.per_channel[sourceChannel]) _dedupStats.per_channel[sourceChannel] = { caught: 0, ignored: 0 };
  _dedupStats.per_channel[sourceChannel].caught = (_dedupStats.per_channel[sourceChannel].caught || 0) + 1;

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
  getDexScreenerInfo(chain, address).then(dexData => {
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
      _tid: db.getTelegramId(), id: signalId, token_symbol: update.token_symbol, token_address: address, source_channel: sourceChannel,
      market_cap: update.market_cap, price: update.price, liquidity: update.liquidity, volume_24h: update.volume_24h,
      rug_ratio: -1, smart_degen_count: 0, catched_mc: catchedMc,
      latency_ms: Date.now() - t0, sender_username: senderUsername, created_at: now,
    });
    forwardSignal(sourceChannel, address, update, text, null);
  }).catch(() => {});

  Promise.all([getTokenInfo(chain, address).catch(() => null), getTokenSecurity(chain, address).catch(() => null)])
    .then(([info, security]) => {
      if (!info || (info.code && info.code !== 0)) return;
      const gmgnData = parseTokenData(info, security, chain, address, sourceChannel, text, null);
      gmgnData.sender_username = senderUsername || '';
      gmgnData.latency_ms = Date.now() - t0;
      const gmgnLatency = Date.now() - t0;
      if (signalId) db.updateSignal(signalId, gmgnData).catch(() => {});
      liveEvents.emit('signal_update', {
        _tid: db.getTelegramId(), id: signalId, token_symbol: gmgnData.token_symbol, token_address: address, source_channel: sourceChannel,
        market_cap: gmgnData.market_cap, price: gmgnData.price, liquidity: gmgnData.liquidity, volume_24h: gmgnData.volume_24h,
        rug_ratio: gmgnData.rug_ratio, smart_degen_count: gmgnData.smart_degen_count,
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
      msg = `⚠️ ${sourceChannel}\n${address}\nError: ${error}`;
    } else if (!data) {
      msg = `📡 ${sourceChannel}\n\`${address}\`\n⏳ Fetching data...\n🔗 gmgn.ai/chain/sol/token/${address}`;
    } else if (error) {
      msg = `⚠️ ${sourceChannel} | ${data.token_symbol || address}\n\`${address}\`\n🔗 gmgn.ai/chain/sol/token/${address}\n❌ ${error}`;
    } else {
      msg = `📡 *${sourceChannel}*\n\`${address}\`\n💰 ${data.token_symbol || '?'} | 🎯 Catched at $${data.market_cap ? data.market_cap.toFixed(0) : '?'} MC\n💧 $${data.liquidity ? data.liquidity.toFixed(0) : '?'} Liq\n🔗 gmgn.ai/chain/sol/token/${address}`;
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

async function executeAutoBuy(address, chain, rule, sourceChannel, t0) {
  if (!rule.auto_buy && !rule.blind_buy) return;
  if (rule.track_only) return;

  const wallets = await resolveWallets(rule);
  if (wallets.length === 0) {
    db.addScraperLog(sourceChannel, 'error', `Auto-buy ${address} failed: no wallets`).catch(() => {});
    return;
  }

  const totalLamports = Math.floor(rule.buy_amount_sol * 1_000_000_000);
  const perWallet = Math.floor(totalLamports / wallets.length);
  const tBuy = Date.now();

  await Promise.allSettled(wallets.map(async (wallet) => {
    try {
      console.log(`[Router] Swap ${perWallet} lamports -> ${address} (${wallet.address})`);

      const conditionOrders = [];
      if (rule.take_profit_percent) conditionOrders.push({ order_type: 'profit_stop', side: 'sell', price_scale: String(rule.take_profit_percent), sell_ratio: '100' });
      if (rule.stop_loss_percent) conditionOrders.push({ order_type: 'loss_stop', side: 'sell', price_scale: String(Math.abs(rule.stop_loss_percent)), sell_ratio: '100' });

      const hasFee = rule.priority_fee && rule.tip_fee;
      if (conditionOrders.length && !hasFee) {
        db.addScraperLog(sourceChannel, 'warn', `TP/SL set for ${address} but no priority_fee+tip_fee — skipping condition orders (swap only)`).catch(() => {});
        conditionOrders.length = 0;
      }

      const result = await executeSwap(chain, wallet.address, CURRENCY_ADDRESSES[chain], address, perWallet, {
        slippage: rule.slippage,
        antiMev: !!rule.anti_mev,
        priorityFee: rule.priority_fee || undefined,
        tipFee: rule.tip_fee || undefined,
        conditionOrders: conditionOrders.length > 0 ? conditionOrders : undefined,
      });

      const orderRes = result.data || result;
      const orderId = orderRes.order_id;
      const strategyId = orderRes.strategy_order_id;
      const buyLatency = Date.now() - tBuy;
      const totalLatency = Date.now() - t0;
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

      pollOrder(orderId, chain, tradeId);
      notifyBuy(wallet.address, address, rule, orderId, sourceChannel, perWallet / 1e9);
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

async function pollOrder(orderId, chain, tradeId) {
  let attempts = 0;
  const maxAttempts = 15;

  while (attempts < maxAttempts) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const result = await getOrder(chain, orderId);
      const status = result.data?.status || result.status;

      if (status === 'confirmed' || status === 'successful') {
        const report = result.data?.report || result.report;
        await db.updateTrade(tradeId, {
          buy_status: 'confirmed',
          buy_tx: report?.hash || result.data?.hash || result.hash,
          buy_price_usd: report?.price_usd ? parseFloat(report.price_usd) : undefined,
        });
        liveEvents.emit('trade_update', { _tid: db.getTelegramId(), trade_id: tradeId, status: 'confirmed', buy_tx: report?.hash || result.data?.hash || result.hash });
        console.log(`[Router] ✅ Buy confirmed: ${orderId}`);
        return;
      }

      if (status === 'failed' || status === 'expired') {
        await db.updateTrade(tradeId, { buy_status: 'failed', status: 'failed' });
        liveEvents.emit('trade_update', { _tid: db.getTelegramId(), trade_id: tradeId, status: 'failed' });
        console.log(`[Router] ❌ Buy failed: ${orderId}`);
        return;
      }

      attempts++;
    } catch {
      attempts++;
    }
  }

  await db.updateTrade(tradeId, { buy_status: 'timeout' });
  liveEvents.emit('trade_update', { _tid: db.getTelegramId(), trade_id: tradeId, status: 'timeout' });
  console.log(`[Router] ⏰ Buy polling timeout: ${orderId} (order still may confirm later)`);
}

function notifyBuy(wallet, address, rule, orderId, sourceChannel, amountSol) {
  const lines = [
    `🟢 *AUTO BUY* ${address.slice(0, 8)}...`,
    `💰 ${amountSol} SOL | ${wallet.slice(0, 6)}...${wallet.slice(-4)}`,
    `🔗 https://solscan.io/tx/${orderId}`,
    `📊 gmgn.ai/chain/sol/token/${address}`,
  ];
  if (rule.take_profit_percent) lines.push(`📈 TP: ${rule.take_profit_percent}%`);
  if (rule.stop_loss_percent) lines.push(`📉 SL: ${rule.stop_loss_percent}%`);
  sendToChat(sourceChannel, lines.join('\n')).catch(() => {});
}
