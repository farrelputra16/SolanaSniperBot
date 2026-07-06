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
const _tokenCache = new Map();

async function getCachedRules() {
  const now = Date.now();
  if (_rulesCache && (now - _rulesCacheTs) < 5000) return _rulesCache;
  _rulesCache = await db.getAutoBuyRules();
  _rulesCacheTs = now;
  return _rulesCache;
}

function getTokenCached(chain, address) {
  const key = `${chain}:${address}`;
  const hit = _tokenCache.get(key);
  if (!hit) return null;
  _tokenCache.delete(key);
  return hit;
}

function setTokenCache(chain, address, info, security) {
  _tokenCache.set(`${chain}:${address}`, { info, security, ts: Date.now() });
  if (_tokenCache.size > 500) {
    const oldest = _tokenCache.entries().next().value;
    if (oldest) _tokenCache.delete(oldest[0]);
  }
}

export async function processSignal(sourceChannel, text, message, senderUsername) {
  const t0 = Date.now();

  const found = extractAddresses(text);
  if (found.length === 0) return;
  db.addScraperLog(sourceChannel, 'info', `CA ${found.map(f=>f.address).join(', ')}`).catch(() => {});
  const tCapture = Date.now();
  const captureLatency = tCapture - t0;
  console.log(`📡 CA captured in ${captureLatency}ms | ${found.length} address(es)`);

  const allRules = await getCachedRules();

  // Clean expired cache entries (lazy)
  const now = Date.now();
  for (const [k, v] of _tokenCache) if (now - v.ts > 30000) _tokenCache.delete(k);

  await Promise.allSettled(found.map(({ address, chain }) =>
    processAddress(address, chain, sourceChannel, text, senderUsername, allRules, t0)
  ));
}

async function processAddress(address, chain, sourceChannel, text, senderUsername, allRules, t0) {
  // 1. Match rules by channel ONLY — no data needed
  const matchingRules = allRules.filter(r => r.channel_username === sourceChannel);
  const hasRules = matchingRules.length > 0;

  // 2. Execute buys IMMEDIATELY (if any rule matches channel)
  for (const rule of matchingRules) {
    executeAutoBuy(address, chain, { token_address: address, chain, source_channel: sourceChannel, price: 0, token_symbol: '' }, rule, sourceChannel, t0);
  }

  // 3. Fetch data in background for display/cache
  let tokenInfo, tokenSecurity;
  const cached = getTokenCached(chain, address);
  const isCacheHit = !!cached;

  if (cached) {
    tokenInfo = cached.info;
    tokenSecurity = cached.security;
    Promise.all([getTokenInfo(chain, address), getTokenSecurity(chain, address)])
      .then(([info, sec]) => setTokenCache(chain, address, info, sec))
      .catch(() => {});
  } else {
    [tokenInfo, tokenSecurity] = await Promise.all([
      getTokenInfo(chain, address),
      getTokenSecurity(chain, address).catch(() => null),
    ]);
    setTokenCache(chain, address, tokenInfo, tokenSecurity);
  }

  const data = parseTokenData(tokenInfo, tokenSecurity, chain, address, sourceChannel, text);
  data.sender_username = senderUsername || '';
  data.latency_ms = captureLatency;

  db.saveSignal(data).catch(() => {});
  liveEvents.emit('signal', {
    token_symbol: data.token_symbol, token_address: address, source_channel: sourceChannel,
    market_cap: data.market_cap, latency_ms: captureLatency,
    sender_username: senderUsername, created_at: Math.floor(Date.now() / 1000),
  });

  const totalLatency = Date.now() - t0;
  console.log(`⚡ SIGNAL ${data.token_symbol||address} | capture=${captureLatency}ms fetch=${totalLatency}ms ${hasRules?'🟢 swap ✅':'⏸️'}${isCacheHit?' 🟡 cache-hit':''}`);

  forwardSignal(sourceChannel, address, data, text, null);
}

function parseTokenData(info, security, chain, address, sourceChannel, text) {
  const data = info?.data || info || {};
  const sec = security?.data || security || {};
  const price = data.price?.price ? parseFloat(data.price.price) : (data.price ? parseFloat(data.price) : 0);
  const circSupply = data.circulating_supply ? parseFloat(data.circulating_supply) : 0;

  return {
    token_address: address,
    token_symbol: data.symbol || 'UNKNOWN',
    token_name: data.name || '',
    chain,
    source_channel: sourceChannel,
    source_text: text,
    price,
    market_cap: price * circSupply || 0,
    liquidity: data.liquidity ? parseFloat(data.liquidity) : 0,
    volume_24h: data.price?.volume_24h ? parseFloat(data.price.volume_24h) : 0,
    rug_ratio: sec.rug_ratio !== undefined ? parseFloat(sec.rug_ratio) : -1,
    smart_degen_count: data.wallet_tags_stat?.smart_wallets || 0,
    bundler_rate: sec.bundler_trader_amount_rate !== undefined ? parseFloat(sec.bundler_trader_amount_rate) : 0,
    top10_rate: sec.top_10_holder_rate !== undefined ? parseFloat(sec.top_10_holder_rate) : 0,
    creator_status: sec.creator_token_status || '',
    is_honeypot: sec.is_honeypot,
  };
}

async function forwardSignal(sourceChannel, address, data, text, error) {
  const target = await db.getSetting('forward_to_chat', '');
  if (!target) return;

  let msg;
  if (error && !data) {
    msg = `⚠️ ${sourceChannel}\n${address}\nError: ${error}`;
  } else if (error) {
    msg = `⚠️ ${sourceChannel} | ${data.token_symbol || address}\n🔗 gmgn.ai/chain/sol/token/${address}\n❌ ${error}`;
  } else {
    msg = `📡 *${sourceChannel}*\n`;
    msg += `\`${address}\`\n`;
    msg += `💰 ${data.token_symbol || '?'} | $${data.market_cap ? data.market_cap.toFixed(0) : '?'} MC\n`;
    msg += `💧 $${data.liquidity ? data.liquidity.toFixed(0) : '?'} Liq\n`;
    msg += `🛡️ Rug: ${data.rug_ratio >= 0 ? (data.rug_ratio * 100).toFixed(0) : '?'}% | SM: ${data.smart_degen_count}\n`;
    msg += `🔗 gmgn.ai/chain/sol/token/${address}`;
  }

  try {
    await sendToChat(target, msg);
  } catch (err) {
    console.error(`[Router] Forward error: ${err.message}`);
  }
}

function evaluateSecurity(data, security) {
  const reasons = [];
  const sec = security?.data || security || {};
  if (sec.is_honeypot === 'yes') reasons.push('honeypot');
  if (data.rug_ratio > 0.3 && data.rug_ratio !== -1) reasons.push(`rug_ratio ${data.rug_ratio.toFixed(2)}`);
  if (data.bundler_rate > 0.3) reasons.push(`bundler ${(data.bundler_rate * 100).toFixed(0)}%`);
  if (data.top10_rate > 0.5) reasons.push(`top10_holder ${(data.top10_rate * 100).toFixed(0)}%`);
  if (sec.creator_token_status === 'creator_hold') reasons.push('dev hold');
  return reasons;
}

async function executeAutoBuy(address, chain, data, rule, sourceChannel, t0) {
  if (rule.track_only) {
    console.log(`[Router] Track-only ${address} — skipping auto-buy`);
    return;
  }

  let wallets = [];
  if (rule.wallet_group_id && rule.wallet_group_id > 0) {
    wallets = await db.getGroupWallets(rule.wallet_group_id);
    if (wallets.length === 0) {
      console.log('[Router] Wallet group', rule.wallet_group_id, 'is empty');
      db.addScraperLog(sourceChannel, 'error', `Auto-buy ${address} failed: wallet group empty`).catch(() => {});
      return;
    }
  } else if (rule.wallet_group_id && rule.wallet_group_id < 0) {
    const wallet = await db.getWallet(Math.abs(rule.wallet_group_id));
    if (!wallet) {
      console.log('[Router] Wallet', Math.abs(rule.wallet_group_id), 'not found');
      db.addScraperLog(sourceChannel, 'error', `Auto-buy ${address} failed: wallet not found`).catch(() => {});
      return;
    }
    wallets = [wallet];
  } else {
    const wallet = await db.getActiveWallet();
    if (!wallet) {
      console.log('[Router] No active wallet for auto-buy');
      db.addScraperLog(sourceChannel, 'error', `Auto-buy ${address} failed: no active wallet`).catch(() => {});
      return;
    }
    wallets = [wallet];
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

      const result = await executeSwap(chain, wallet.address, CURRENCY_ADDRESSES[chain], address, perWallet, {
        slippage: rule.slippage,
        antiMev: rule.anti_mev,
        priorityFee: rule.priority_fee || undefined,
        tipFee: rule.tip_fee || undefined,
        conditionOrders: conditionOrders.length > 0 ? conditionOrders : undefined,
      });

      const orderRes = result.data || result;
      const orderId = orderRes.order_id;
      const strategyId = orderRes.strategy_order_id;
      const buyLatency = Date.now() - tBuy;
      console.log(`[Router] Swap submitted: ${orderId}${strategyId ? ' strategy='+strategyId : ''}`);
      db.addScraperLog(sourceChannel, 'info', `Auto-buy ${data.token_symbol || address}: order=${orderId}`).catch(() => {});

      const tradeId = await db.createTrade({
        wallet_address: wallet.address,
        token_address: address,
        token_symbol: data.token_symbol,
        chain,
        buy_amount_sol: perWallet / 1e9,
        buy_price: data.price,
        buy_price_usd: data.price,
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
          token_symbol: data.token_symbol,
          chain,
          order_type: 'condition_order',
          sub_order_type: 'mix_trade',
          group_tag: 'STMix',
          remote_order_id: strategyId,
        }).catch(() => {});
      }

      liveEvents.emit('trade', {
        token_symbol: data.token_symbol, token_address: address, wallet: wallet.address,
        amount: perWallet / 1e9, signal_latency_ms: t0 ? Date.now() - t0 : 0,
        buy_latency_ms: buyLatency, status: 'pending',
      });
      pollOrder(orderId, chain, tradeId);
      notifyBuy(wallet.address, address, data, rule, orderId, sourceChannel, perWallet / 1e9);
    } catch (err) {
      console.error(`[Router] Gagal auto-buy ${address} (${wallet.address}):`, err.message);
      db.addScraperLog(sourceChannel, 'error', `Auto-buy ${data.token_symbol || address} failed: ${err.message}`).catch(() => {});
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
        console.log(`[Router] ✅ Buy confirmed: ${orderId}`);
        return;
      }

      if (status === 'failed' || status === 'expired') {
        await db.updateTrade(tradeId, { buy_status: 'failed', status: 'failed' });
        console.log(`[Router] ❌ Buy failed: ${orderId}`);
        return;
      }

      attempts++;
    } catch {
      attempts++;
    }
  }

  await db.updateTrade(tradeId, { buy_status: 'timeout' });
  console.log(`[Router] ⏰ Buy polling timeout: ${orderId}`);
}

async function notifyBuy(wallet, address, data, rule, orderId, sourceChannel, amountSol) {
  const lines = [
    `🟢 *AUTO BUY* ${data.token_symbol || address}`,
    `💰 ${amountSol} SOL | ${wallet.slice(0, 6)}...${wallet.slice(-4)}`,
    `🔗 https://solscan.io/tx/${orderId}`,
    `📊 gmgn.ai/chain/sol/token/${address}`,
  ];
  if (rule.take_profit_percent) lines.push(`📈 TP: ${rule.take_profit_percent}%`);
  if (rule.stop_loss_percent) lines.push(`📉 SL: ${rule.stop_loss_percent}%`);

  try {
    await sendToChat(sourceChannel, lines.join('\n'));
  } catch {}
}
