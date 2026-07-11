import { extractAddresses, getTokenInfo, getTokenSecurity, executeSwap, getOrder } from './gmgn.js';
import * as db from './database.js';
import { config } from './config.js';
import { sendToChat } from './telegram.js';
import { liveEvents } from './web-server.js';

const CURRENCY_ADDRESSES = {
  sol: 'So11111111111111111111111111111111111111112',
};

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
  if (hit && Date.now() - hit.ts < 10000) return hit.data;
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

export async function processSignal(sourceChannel, text, message, senderUsername) {
  const t0 = Date.now();

  const found = extractAddresses(text);
  if (found.length === 0) return;
  db.addScraperLog(sourceChannel, 'info', `CA ${found.map(f=>f.address).join(', ')}`).catch(() => {});
  const captureLatency = Date.now() - t0;
  console.log(`📡 CA captured in ${captureLatency}ms | ${found.length} address(es)`);

  const allRules = await getCachedRules();

  await Promise.allSettled(found.map(({ address, chain }) =>
    processAddress(address, chain, sourceChannel, text, senderUsername, allRules, t0)
  ));
}

async function processAddress(address, chain, sourceChannel, text, senderUsername, allRules, t0) {
  const matchingRules = allRules.filter(r => r.channel_username === sourceChannel);

  for (const rule of matchingRules) {
    executeAutoBuy(address, chain, rule, sourceChannel, t0);
  }

  // Save signal IMMEDIATELY — minimal data, appears on dashboard right away
  const now = Math.floor(Date.now() / 1000);
  const placeholder = { token_address: address, token_symbol: '', chain, source_channel: sourceChannel, source_text: text, price: 0, market_cap: 0, sender_username: senderUsername || '', latency_ms: Date.now() - t0 };
  const signalId = await db.saveSignal(placeholder).catch(() => null);

  liveEvents.emit('signal', {
    token_symbol: '', id: signalId, token_address: address, source_channel: sourceChannel,
    market_cap: 0, latency_ms: Date.now() - t0,
    sender_username: senderUsername, created_at: now,
  });

  // Fire-and-forget: fetch token data, update signal + trades
  Promise.all([getTokenInfo(chain, address), getTokenSecurity(chain, address).catch(() => null)])
    .then(([info, security]) => {
      const data = parseTokenData(info, security, chain, address, sourceChannel, text);
      data.sender_username = senderUsername || '';
      data.latency_ms = Date.now() - t0;

      if (signalId) db.updateSignal(signalId, data).catch(() => {});

      liveEvents.emit('signal_update', {
        id: signalId, token_symbol: data.token_symbol, token_address: address, source_channel: sourceChannel,
        market_cap: data.market_cap, price: data.price, liquidity: data.liquidity, volume_24h: data.volume_24h,
        rug_ratio: data.rug_ratio, smart_degen_count: data.smart_degen_count,
        latency_ms: data.latency_ms, sender_username: senderUsername, created_at: now,
      });

      forwardSignal(sourceChannel, address, data, text, null);

      const totalLatency = Date.now() - t0;
      console.log(`⚡ SIGNAL ${data.token_symbol||address} | fetch=${totalLatency}ms ${matchingRules.length?'🟢 swap ✅':'⏸️'}`);
    })
    .catch(() => {
      if (signalId) db.updateSignal(signalId, { token_symbol: 'UNKNOWN' }).catch(() => {});
    });
}

function forwardSignal(sourceChannel, address, data, text, error) {
  db.getSetting('forward_to_chat', '').then(target => {
    if (!target) return;
    let msg;
    if (error && !data) {
      msg = `⚠️ ${sourceChannel}\n${address}\nError: ${error}`;
    } else if (error) {
      msg = `⚠️ ${sourceChannel} | ${data.token_symbol || address}\n🔗 gmgn.ai/chain/sol/token/${address}\n❌ ${error}`;
    } else {
      msg = `📡 *${sourceChannel}*\n\`${address}\`\n💰 ${data.token_symbol || '?'} | $${data.market_cap ? data.market_cap.toFixed(0) : '?'} MC\n💧 $${data.liquidity ? data.liquidity.toFixed(0) : '?'} Liq\n🔗 gmgn.ai/chain/sol/token/${address}`;
    }
    sendToChat(target, msg).catch(() => {});
  }).catch(() => {});
}

function resolveWallets(rule) {
  if (rule.wallet_group_id && rule.wallet_group_id > 0) {
    return getCachedWallet(`group:${rule.wallet_group_id}`, () => db.getGroupWallets(rule.wallet_group_id));
  }
  if (rule.wallet_group_id && rule.wallet_group_id < 0) {
    return getCachedWallet(`wallet:${Math.abs(rule.wallet_group_id)}`, () => db.getWallet(Math.abs(rule.wallet_group_id)))
      .then(w => w ? [w] : []);
  }
  return getCachedWallet('active', () => db.getActiveWallet())
    .then(w => w ? [w] : []);
}

async function executeAutoBuy(address, chain, rule, sourceChannel, t0) {
  if (!rule.auto_buy || rule.track_only) return;

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
        token_symbol: 'PENDING', token_address: address, wallet: wallet.address,
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
  const maxAttempts = 30;

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
        liveEvents.emit('trade_update', { trade_id: tradeId, status: 'confirmed', buy_tx: report?.hash || result.data?.hash || result.hash });
        console.log(`[Router] ✅ Buy confirmed: ${orderId}`);
        return;
      }

      if (status === 'failed' || status === 'expired') {
        await db.updateTrade(tradeId, { buy_status: 'failed', status: 'failed' });
        liveEvents.emit('trade_update', { trade_id: tradeId, status: 'failed' });
        console.log(`[Router] ❌ Buy failed: ${orderId}`);
        return;
      }

      attempts++;
    } catch {
      attempts++;
    }
  }

  await db.updateTrade(tradeId, { buy_status: 'timeout' });
  liveEvents.emit('trade_update', { trade_id: tradeId, status: 'timeout' });
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
