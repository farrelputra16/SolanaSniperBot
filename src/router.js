import { extractAddresses, getTokenInfo, getTokenSecurity, executeSwap, getOrder } from './gmgn.js';
import { getDatabase, saveSignal, getAutoBuyRules, createTrade, updateTrade } from './database.js';
import { config } from './config.js';
import { forwardToChat, sendToChat } from './telegram.js';

const CHAIN_DISPLAY = { sol: 'Solana', bsc: 'BSC', base: 'Base', eth: 'Ethereum' };
const CURRENCY_ADDRESSES = {
  sol: 'So11111111111111111111111111111111111111112',
};

export async function processSignal(sourceChannel, text, message) {
  console.log(`[Router] Memproses signal dari ${sourceChannel}`);

  const found = extractAddresses(text);

  for (const { address, chain } of found) {
    console.log(`[Router] Address ditemukan: ${address} (${chain})`);

    let tokenInfo, tokenSecurity;

    try {
      [tokenInfo, tokenSecurity] = await Promise.all([
        getTokenInfo(chain, address),
        getTokenSecurity(chain, address),
      ]);
    } catch (err) {
      console.error(`[Router] Gagal fetch data untuk ${address}:`, err.message);
      await forwardSignal(sourceChannel, address, null, text, err.message);
      continue;
    }

    const data = parseTokenData(tokenInfo, tokenSecurity, chain, address, sourceChannel, text);

    saveSignal(data);

    const skipReasons = evaluateSecurity(data, tokenSecurity);
    if (skipReasons.length > 0) {
      console.log(`[Router] SKIP ${address}: ${skipReasons.join(', ')}`);
      await forwardSignal(sourceChannel, address, data, text, `SKIP: ${skipReasons.join(', ')}`);
      continue;
    }

    console.log(`[Router] ✅ ${address} lolos filter — ${data.token_symbol || 'UNKNOWN'}`);
    await forwardSignal(sourceChannel, address, data, text, null);

    const rules = getAutoBuyRules();
    const matchingRules = rules.filter((r) => {
      if (r.channel_username !== sourceChannel) return false;
      if (r.min_market_cap && data.market_cap < r.min_market_cap) return false;
      if (r.max_market_cap && data.market_cap > r.max_market_cap) return false;
      if (r.min_liquidity && data.liquidity < r.min_liquidity) return false;
      if (r.min_volume_24h && data.volume_24h < r.min_volume_24h) return false;
      if (r.max_rug_ratio && data.rug_ratio > r.max_rug_ratio) return false;
      if (r.require_smart_money && data.smart_degen_count < (r.min_smart_degen || 1)) return false;
      if (r.max_bundler_rate && data.bundler_rate > r.max_bundler_rate) return false;
      return true;
    });

    for (const rule of matchingRules) {
      console.log(`[Router] Auto-buy ${address} (${rule.buy_amount_sol} SOL) — rule: ${rule.name}`);
      await executeAutoBuy(address, chain, data, rule, sourceChannel);
    }
  }
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

function evaluateSecurity(data, security) {
  const reasons = [];
  const sec = security?.data || security || {};

  if (sec.is_honeypot === 'yes') reasons.push('honeypot');
  if (data.rug_ratio > 0.3 && data.rug_ratio !== -1) reasons.push(`rug_ratio ${data.rug_ratio.toFixed(2)} > 0.3`);
  if (data.bundler_rate > 0.3) reasons.push(`bundler ${(data.bundler_rate * 100).toFixed(0)}%`);
  if (data.top10_rate > 0.5) reasons.push(`top10_holder ${(data.top10_rate * 100).toFixed(0)}%`);

  if (sec.creator_token_status === 'creator_hold') reasons.push('dev masih hold');

  return reasons;
}

async function forwardSignal(sourceChannel, address, data, text, error) {
  const db = getDatabase();
  const forwards = db.prepare(`SELECT f.* FROM forwarding f
    JOIN channels c ON c.id = f.channel_id
    WHERE c.channel_username = ? AND f.active = 1`).all(sourceChannel);

  if (forwards.length === 0) return;

  let msg;
  if (error && !data) {
    msg = `⚠️ ${sourceChannel}\n${address}\nError: ${error}`;
  } else if (error) {
    msg = `⚠️ ${sourceChannel} | ${data.token_symbol || address}\n🔗 gmgn.ai/chain/sol/token/${address}\n❌ ${error}`;
  } else {
    msg = formatSignalMessage(sourceChannel, address, data);
  }

  for (const f of forwards) {
    await forwardToChat(f.target_chat_id || f.target_chat_username, msg);
  }
}

function formatSignalMessage(source, address, data) {
  let msg = `📡 *${source}*\n`;
  msg += `\`${address}\`\n`;
  msg += `💰 ${data.token_symbol || '?'} | $${data.market_cap ? data.market_cap.toFixed(0) : '?'} MC\n`;
  msg += `💧 $${data.liquidity ? data.liquidity.toFixed(0) : '?'} Liq | Vol $${data.volume_24h ? data.volume_24h.toFixed(0) : '?'}\n`;
  if (data.rug_ratio >= 0) msg += `🛡️ Rug: ${(data.rug_ratio * 100).toFixed(0)}% | SM: ${data.smart_degen_count}\n`;
  msg += `🔗 gmgn.ai/chain/sol/token/${address}`;
  return msg;
}

async function executeAutoBuy(address, chain, data, rule, sourceChannel) {
  const wallet = getDatabase().prepare('SELECT address FROM wallets WHERE active = 1 LIMIT 1').get();
  if (!wallet) {
    console.log('[Router] Tidak ada wallet aktif untuk auto-buy');
    return;
  }

  const buyAmtLamports = Math.floor(rule.buy_amount_sol * 1_000_000_000);

  try {
    console.log(`[Router] Execute swap: ${buyAmtLamports} lamports -> ${address}`);

    const result = await executeSwap(chain, wallet.address, CURRENCY_ADDRESSES[chain], address, buyAmtLamports, {
      slippage: rule.slippage,
      antiMev: rule.anti_mev,
    });

    const orderId = result.data?.order_id || result.order_id;
    console.log(`[Router] Swap submitted: order_id=${orderId}`);

    const signalId = getDatabase().prepare(
      'SELECT id FROM signals WHERE token_address = ? ORDER BY created_at DESC LIMIT 1'
    ).get(address)?.id;

    const trade = createTrade({
      signal_id: signalId,
      wallet_address: wallet.address,
      token_address: address,
      token_symbol: data.token_symbol,
      chain,
      buy_amount_sol: rule.buy_amount_sol,
      buy_price: data.price,
      buy_price_usd: data.price,
      buy_order_id: orderId,
      take_profit_percent: rule.take_profit_percent,
      stop_loss_percent: rule.stop_loss_percent,
    });

    pollOrder(orderId, chain, trade.id);

    await notifyBuy(wallet.address, address, data, rule, orderId, sourceChannel);
  } catch (err) {
    console.error(`[Router] Gagal auto-buy ${address}:`, err.message);
    await sendToChat(sourceChannel, `❌ Gagal buy ${data.token_symbol || address}: ${err.message}`);
  }
}

async function pollOrder(orderId, chain, tradeId) {
  let attempts = 0;
  const maxAttempts = 10;

  while (attempts < maxAttempts) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const result = await getOrder(chain, orderId);
      const status = result.data?.status || result.status;
      const report = result.data?.report || result.report;

      if (status === 'confirmed' || status === 'successful') {
        updateTrade(tradeId, {
          buy_status: 'confirmed',
          buy_tx: report?.hash || result.data?.hash,
          buy_price_usd: report?.price_usd ? parseFloat(report.price_usd) : undefined,
        });
        console.log(`[Router] ✅ Buy confirmed: ${orderId}`);
        return;
      }

      if (status === 'failed' || status === 'expired') {
        updateTrade(tradeId, { buy_status: 'failed', status: 'failed' });
        console.log(`[Router] ❌ Buy failed: ${orderId}`);
        return;
      }

      attempts++;
    } catch {
      attempts++;
    }
  }

  updateTrade(tradeId, { buy_status: 'timeout' });
  console.log(`[Router] ⏰ Buy polling timeout: ${orderId}`);
}

async function notifyBuy(wallet, address, data, rule, orderId, sourceChannel) {
  const lines = [
    `🟢 *AUTO BUY* ${data.token_symbol || address}`,
    `💰 ${rule.buy_amount_sol} SOL`,
    `🔗 https://solscan.io/tx/${orderId}`,
    `📊 gmgn.ai/chain/sol/token/${address}`,
  ];
  if (rule.take_profit_percent) lines.push(`📈 TP: ${rule.take_profit_percent}%`);
  if (rule.stop_loss_percent) lines.push(`📉 SL: ${rule.stop_loss_percent}%`);

  await sendToChat(sourceChannel, lines.join('\n'));
}
