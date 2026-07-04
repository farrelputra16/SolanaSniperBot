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

async function getCachedRules() {
  const now = Date.now();
  if (_rulesCache && (now - _rulesCacheTs) < 5000) return _rulesCache;
  _rulesCache = await db.getAutoBuyRules();
  _rulesCacheTs = now;
  return _rulesCache;
}

export async function processSignal(sourceChannel, text, message, senderUsername) {
  const t0 = Date.now();
  db.addScraperLog(sourceChannel, 'info', `Signal${senderUsername ? ' @'+senderUsername : ''}: ${text.slice(0, 80)}`).catch(() => {});

  const found = extractAddresses(text);
  if (found.length === 0) return;

  const allRules = await getCachedRules();

  await Promise.allSettled(found.map(({ address, chain }) =>
    processAddress(address, chain, sourceChannel, text, senderUsername, allRules, t0)
  ));
}

async function processAddress(address, chain, sourceChannel, text, senderUsername, allRules, t0) {
  let tokenInfo, tokenSecurity;

  try {
    [tokenInfo, tokenSecurity] = await Promise.all([
      getTokenInfo(chain, address),
      getTokenSecurity(chain, address),
    ]);
  } catch (err) {
    console.error(`[Router] Fetch error ${address}:`, err.message);
    db.addScraperLog(sourceChannel, 'error', `Fetch error ${address}: ${err.message}`).catch(() => {});
    return;
  }

  const tFetch = Date.now();
  const signalLatency = tFetch - t0;

  const data = parseTokenData(tokenInfo, tokenSecurity, chain, address, sourceChannel, text);
  data.sender_username = senderUsername || '';
  data.latency_ms = signalLatency;

  db.saveSignal(data).catch(() => {});
  liveEvents.emit('signal', {
    token_symbol: data.token_symbol, token_address: address, source_channel: sourceChannel,
    market_cap: data.market_cap, latency_ms: signalLatency,
    sender_username: senderUsername, created_at: Math.floor(Date.now() / 1000),
  });

  const matchingRules = allRules.filter(r => {
    if (r.channel_username !== sourceChannel) return false;
    if (r.min_market_cap && data.market_cap < r.min_market_cap) return false;
    if (r.max_market_cap && data.market_cap > r.max_market_cap) return false;
    if (r.min_liquidity && data.liquidity < r.min_liquidity) return false;
    if (r.max_liquidity && data.liquidity > r.max_liquidity) return false;
    return true;
  });

  for (const rule of matchingRules) {
    executeAutoBuy(address, chain, data, rule, sourceChannel, t0);
  }

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

  for (const wallet of wallets) {
    try {
      console.log(`[Router] Swap ${perWallet} lamports -> ${address} (${wallet.address})`);

      const tBuy = Date.now();
      const result = await executeSwap(chain, wallet.address, CURRENCY_ADDRESSES[chain], address, perWallet, {
        slippage: rule.slippage,
        antiMev: rule.anti_mev,
      });

      const orderId = result.data?.order_id || result.order_id;
      const buyLatency = Date.now() - tBuy;
      console.log(`[Router] Swap submitted: ${orderId}`);
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
  }
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
        await db.updateTrade(tradeId, {
          buy_status: 'confirmed',
          buy_tx: result.data?.report?.hash || result.data?.hash,
          buy_price_usd: result.data?.report?.price_usd ? parseFloat(result.data.report.price_usd) : undefined,
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
