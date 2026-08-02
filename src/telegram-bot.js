import { Bot, InlineKeyboard } from 'grammy';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import * as db from './database.js';
import * as tg from './telegram.js';
import { liveEvents } from './web-server.js';

function env(key, dv) {
  if (process.env[key] !== undefined) return process.env[key];
  try {
    const p = join(process.cwd(), '.env');
    if (existsSync(p)) {
      for (const line of readFileSync(p, 'utf-8').split('\n')) {
        const m = line.match(/^\s*([^#=]+?)\s*=\s*(.+?)\s*$/);
        if (m && m[1] === key) return m[2].replace(/^['"]|['"]$/g, '');
      }
    }
  } catch {}
  return dv;
}

const TOKEN = env('TELEGRAM_BOT_TOKEN');
let bot = null;
let adminId = env('BOT_ADMIN_IDS') ? String(env('BOT_ADMIN_IDS')).split(',')[0].trim() : null;

export function setAdminId(id) { if (id) adminId = id; }
export function isBotActive() { return !!bot; }

// ───── State ─────
const _awaitingLink = new Set();
const _awaitingPosTPSL = new Map(); // uid -> { tradeId, type: 'tp' | 'sl' }
const _extPos = new Map(); // idx -> { wallet, token, symbol, balance, usd }
let _extPosIdx = 0;

// ───── Helpers ─────
function esc(s) { return s ? String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]) : ''; }

function fmtCur(v) { if (!v) return '$0'; if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M'; if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K'; return '$' + Number(v).toLocaleString(); }

function addrShort(a) { return a ? a.slice(0, 4) + '..' + a.slice(-4) : '?'; }

function unpackTokenInfo(i) {
  const raw = i?.data || i?.info || i || {};
  const priceRaw = raw.price_usd != null ? raw.price_usd : (raw.price && typeof raw.price === 'object' ? raw.price.price : raw.price);
  const price = parseFloat(priceRaw);
  const supply = parseFloat(raw.circulating_supply) || parseFloat(raw.total_supply);
  const mcapRaw = raw.market_cap != null ? raw.market_cap : (price && supply ? price * supply : NaN);
  const mcap = parseFloat(mcapRaw);
  return { price: isNaN(price) ? null : price, mcap: isNaN(mcap) ? null : mcap, symbol: raw.symbol || '' };
}

function ago(ts) { if (!ts) return 'never'; const s = Math.floor((Date.now() / 1000 - ts)); if (s < 60) return s + 's'; if (s < 3600) return Math.floor(s / 60) + 'm'; return Math.floor(s / 3600) + 'h'; }

function btnText(s) {
  if (!s) return '?';
  const cleaned = String(s)
    .replace(/[\x00-\x1F\x7F-\x9F]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .slice(0, 30);
  return cleaned || '?';
}

function isTgConnected() { try { const c = tg.getClient(); return c?.connected === true; } catch { return false; } }

function confirmKb(action) {
  return new InlineKeyboard()
    .text('✅ Yes', `confirm_${action}`).text('❌ No', 'menu_main');
}

// ───── Main Menu ─────
async function showMainMenu(ctx, edit) {
  const kb = new InlineKeyboard()
    .text('📡 Channels', 'menu_channels').text('💰 Wallets', 'menu_wallets')
    .row()
    .text('📈 Positions', 'menu_positions').text('📜 History', 'menu_history')
    .row()
    .text('📈 Stats', 'menu_stats').text('❓ Help', 'menu_help');
  if (isTgConnected()) kb.row().text('🔌 Disconnect', 'menu_disconnect');

  const conn = isTgConnected() ? '🟢 Connected' : '🔴 Disconnected';
  const [channels, wallets] = await Promise.all([
    db.getAllChannels().catch(() => []),
    db.getAllWallets().catch(() => []),
  ]);
  const activeChs = channels.filter(c => c.active).length;

  let totalSol = 0;
  if (wallets.length) {
    const balances = await Promise.allSettled(wallets.map(w => fetchSolBalance(w.address)));
    for (const b of balances) { if (b.status === 'fulfilled' && b.value != null) totalSol += b.value; }
  }

  const text = `🤖 <b>SniperBot</b>
━━━━━━━━━━━━━━━━
${conn}
📡 ${activeChs}/${channels.length} channels active
💰 ${wallets.length} wallets · ${totalSol > 0 ? totalSol.toFixed(2) + ' SOL' : '—'}
━━━━━━━━━━━━━━━━

<b>Menu</b> — tap to open:`;

  const opts = { parse_mode: 'HTML', reply_markup: kb, ...(edit ? {} : {}) };
  if (edit) {
    try { await ctx.editMessageText(text, opts); } catch { await ctx.reply(text, opts); }
  } else {
    await ctx.reply(text, opts);
  }
}

async function showHelp(ctx, edit) {
  const text = `❓ <b>Help — Commands</b>
━━━━━━━━━━━━━━━━
/start — Open main menu
/help — Show this help
/channels — Manage signal channels
/wallets — View & manage wallets
/balance — Show wallet balances
/history — Recent trade history
/stats — Bot statistics
/disconnect — Disconnect Telegram
/cancel — Cancel current action
━━━━━━━━━━━━━━━━
💡 Tap 📡 Channels to add signal sources
💡 Add wallets under 💰 Wallets before trading
💡 Configure auto-buy per channel in ⚙️ settings

<b>Blind Buy</b> — when enabled, the bot buys <b>every</b> signal with no MC, liquidity, or security checks. High risk — only use on trusted alpha channels. Keep Blind Buy OFF for safer filtered trading.`;

  const kb = new InlineKeyboard().text('🔙 Menu', 'menu_main');
  const opts = { parse_mode: 'HTML', reply_markup: kb, ...(edit ? {} : {}) };
  if (edit) {
    try { await ctx.editMessageText(text, opts); } catch { await ctx.reply(text, opts); }
  } else {
    await ctx.reply(text, opts);
  }
}

async function cmdDisconnect(ctx) {
  if (isTgConnected()) {
    await tg.destroyClient();
    await db.setSetting('telegram_session', '');
    const kb = new InlineKeyboard().text('🔙 Menu', 'menu_main');
    ctx.reply('🔌 <b>Disconnected</b>\nLogin from dashboard to reconnect.', { parse_mode: 'HTML', reply_markup: kb });
  }
}

// ───── Add Channel: Enter Link ─────
async function promptLink(ctx) {
  _awaitingLink.add(String(ctx.from.id));
  const kb = new InlineKeyboard().text('🔙 Back', 'add_ch');
  await ctx.reply('🔗 <b>Add Channel by Link</b>\n\nPaste an invite link or username:\n\n<code>https://t.me/+abc123</code>\n<code>@channel_name</code>\n<code>channel_name</code>\n\nOr /cancel to go back.', { parse_mode: 'HTML', reply_markup: kb });
}

async function handleLinkInput(ctx, text) {
  _awaitingLink.delete(String(ctx.from.id));
  const identifier = text.replace(/^https?:\/\/t\.me\//, '').replace(/^@/, '').trim();
  if (!identifier) return ctx.reply('❌ Invalid link. Try again.', { parse_mode: 'HTML' });
  if (!isTgConnected()) return ctx.reply('❌ Telegram not connected. Login from web dashboard first.', { parse_mode: 'HTML' });
  const msg = await ctx.reply(`⏳ Joining <b>${esc(identifier)}</b>...`, { parse_mode: 'HTML' });
  try {
    await db.setTelegramId(adminId);
    await db.addChannel(identifier, identifier);
    const chs = await db.getAllChannels();
    const ch = chs.find(c => c.channel_username === identifier);
    const ok = await tg.addChannelListener(identifier, 'admin');
    if (ch) {
      if (ok) await db.toggleChannel(ch.id, 1);
      else await db.toggleChannel(ch.id, 0);
    }
    const kb = new InlineKeyboard().text('📋 My Channels', 'menu_channels').text('🔙 Menu', 'menu_main');
    ctx.api.editMessageText(msg.chat.id, msg.message_id,
      `✅ <b>${esc(identifier)}</b> added${ok ? '\n🔈 Now listening for signals' : '\n⚠️ Added to DB but could not join — check permissions'}`,
      { parse_mode: 'HTML', reply_markup: kb });
  } catch (e) {
    ctx.api.editMessageText(msg.chat.id, msg.message_id, `❌ ${esc(e.message)}`, { parse_mode: 'HTML' });
  }
}

// ───── Add Channel: From Joined ─────
async function showJoinedChannels(ctx, page = 0) {
  const msg = await ctx.reply('📡 Fetching joined channels...', { parse_mode: 'HTML' });
  try {
    if (!isTgConnected()) {
      const kb = new InlineKeyboard().text('🔙 Menu', 'menu_main');
      return ctx.api.editMessageText(msg.chat.id, msg.message_id,
        '❌ Telegram not connected. Login from web dashboard first.', { parse_mode: 'HTML', reply_markup: kb });
    }
    const joined = await tg.getJoinedChannels();
    if (!joined || !joined.length) {
      return ctx.api.editMessageText(msg.chat.id, msg.message_id, 'No channels found.', { parse_mode: 'HTML' });
    }
    const existing = await db.getAllChannels();
    const existingNames = new Set(existing.map(c => c.channel_username));
    const newChs = joined.filter(ch => { const n = ch.username || ''; return n && !existingNames.has(n); });
    if (!newChs.length) {
      const kb = new InlineKeyboard().text('🔙 Menu', 'menu_main');
      return ctx.api.editMessageText(msg.chat.id, msg.message_id, 'All channels already added.', { parse_mode: 'HTML', reply_markup: kb });
    }
    const totalPages = Math.ceil(newChs.length / 8);
    const p = Math.min(page, totalPages - 1);
    const slice = newChs.slice(p * 8, (p + 1) * 8);
    const kb = new InlineKeyboard();
    for (const ch of slice) {
      const n = ch.username || '';
      const title = btnText(ch.title || n);
      kb.text(title, `ja_${n}`).row();
    }
    if (totalPages > 1) {
      if (p > 0) kb.text('⬅️', `jp_${p - 1}`);
      kb.text(`${p + 1}/${totalPages}`, 'nop');
      if (p < totalPages - 1) kb.text('➡️', `jp_${p + 1}`);
      kb.row();
    }
    kb.text('🔙 Back', 'add_ch');
    ctx.api.editMessageText(msg.chat.id, msg.message_id,
      `📡 <b>${newChs.length}</b> new channels found\nTap a channel to add it:`, { parse_mode: 'HTML', reply_markup: kb });
  } catch (e) {
    ctx.api.editMessageText(msg.chat.id, msg.message_id, `❌ ${e.message?.slice?.(0, 200) || 'Error'}`, { parse_mode: 'HTML' });
  }
}

async function addJoinedChannel(ctx, identifier) {
  await ctx.answerCallbackQuery({ text: 'Adding...' });
  if (!isTgConnected()) return ctx.reply('❌ Telegram not connected. Login from web dashboard first.', { parse_mode: 'HTML' });
  try {
    await db.setTelegramId(adminId);
    await db.addChannel(identifier, identifier);
    const chs = await db.getAllChannels();
    const ch = chs.find(c => c.channel_username === identifier);
    const ok = await tg.addChannelListener(identifier, 'admin');
    if (ch) { if (ok) await db.toggleChannel(ch.id, 1); else await db.toggleChannel(ch.id, 0); }
    const kb = new InlineKeyboard().text('📋 My Channels', 'menu_channels').text('🔙 Menu', 'menu_main');
    ctx.reply(`✅ <b>${esc(identifier)}</b> added${ok ? ' 🔈 Listening' : ''}`, { parse_mode: 'HTML', reply_markup: kb });
  } catch (e) {
    ctx.reply(`❌ ${esc(e.message)}`, { parse_mode: 'HTML' });
  }
}

// ───── Channels List ─────
const CH_PAGE_SIZE = 5;

async function showChannels(ctx, page = 0, edit = true) {
  await db.setTelegramId(adminId);
  const all = await db.getAllChannels();
  const total = all.length;
  const totalPages = Math.max(1, Math.ceil(total / CH_PAGE_SIZE));
  const p = Math.min(page, totalPages - 1);
  const slice = all.slice(p * CH_PAGE_SIZE, (p + 1) * CH_PAGE_SIZE);
  const active = all.filter(c => c.active).length;

  const kb = new InlineKeyboard();
  for (const ch of slice) {
    const name = btnText(ch.display_name || ch.channel_username);
    const icon = ch.active ? '🟢' : '🔴';
    kb.text(`${icon} ${name}`, `ch_t_${ch.id}`)
      .text('⚙️', `ch_s_${ch.id}`)
      .text('🗑', `ch_r_${ch.id}`)
      .row();
  }
  if (totalPages > 1) {
    if (p > 0) kb.text('⬅️', `ch_p_${p - 1}`);
    kb.text(`${p + 1}/${totalPages}`, 'nop');
    if (p < totalPages - 1) kb.text('➡️', `ch_p_${p + 1}`);
    kb.row();
  }
  kb.text('🔄 Refresh', 'ch_ref').text('➕ Add', 'add_ch').text('🔙 Menu', 'menu_main');

  const text = `📡 <b>Channels</b>  ${active}/${total} active
━━━━━━━━━━━━━━━━
🟢 = listening | 🔴 = paused
⚙️ = settings | 🗑 = remove`;

  const opts = { parse_mode: 'HTML', reply_markup: kb };
  if (edit) {
    try { await ctx.editMessageText(text, opts); } catch { await ctx.reply(text, opts); }
  } else {
    await ctx.reply(text, opts);
  }
}

// ───── Channel Setup / Rule Editor ─────
function fmtFee(v) {
  if (v == null || v <= 0) return '—';
  return v < 0.01 ? v.toFixed(5) : v.toFixed(3);
}
async function showChannelSetup(ctx, id) {
  await db.setTelegramId(adminId);
  const ch = await db.getChannelWithRule(id);
  if (!ch) return ctx.answerCallbackQuery({ text: 'Not found' });
  const r = ch.rule || {};
  const name = btnText(ch.display_name || ch.channel_username);

  let tpLevels = [];
  try { tpLevels = typeof r.tp_levels === 'string' ? JSON.parse(r.tp_levels) : (r.tp_levels || []); } catch {}
  let slLevels = [];
  try { slLevels = typeof r.sl_levels === 'string' ? JSON.parse(r.sl_levels) : (r.sl_levels || []); } catch {}

  const multi = r.wallet_group_id ? (r.wallet_group_id > 0 ? 'Group ' + r.wallet_group_id : 'Wallet ' + Math.abs(r.wallet_group_id)) : 'Default only';
  const sellOrders = [];
  if (r.take_profit_percent) sellOrders.push(`‣ TP | ${r.take_profit_percent}% • 100%`);
  if (r.stop_loss_percent) sellOrders.push(`‣ SL | −${Math.abs(r.stop_loss_percent)}% • 100%`);
  for (const tp of tpLevels) {
    if (tp.percent) sellOrders.push(`‣ TP | ${tp.percent}% • ${tp.sell_ratio || 100}%`);
  }
  for (const sl of slLevels) {
    if (sl.percent) sellOrders.push(`‣ SL | −${Math.abs(sl.percent)}% • ${sl.sell_ratio || 100}%`);
  }
  const sellBlock = sellOrders.length
    ? `\nSell Limit Orders\n${sellOrders.join('\n')}`
    : '\nSell Limit Orders\n‣ <i>None configured</i>';

  const lines = [
    `‎@${esc(name)} 🔗 SOL`,
    `ID: ${ch.id}`,
    ``,
    `📌 <b>Auto Buy</b>`,
    `Active: ${r.auto_buy ? '🟢 Active' : '🔴 Paused'}`,
    `Amount: ${r.buy_amount_sol || 0.01} SOL`,
    `Slippage: ${r.slippage || 30}%`,
    `Gas Price: ${fmtFee(r.priority_fee)} SOL + ${fmtFee(r.tip_fee)} SOL tip`,
    `Anti-MEV: ${r.anti_mev ? '🟢 ON' : '🔴 OFF'}`,
    `Multi: ${multi}`,
    `Min MarketCap: ${r.min_market_cap ? '$' + fmtCur(r.min_market_cap) : 'Disabled'}`,
    `Max MarketCap: ${r.max_market_cap ? '$' + fmtCur(r.max_market_cap) : 'Disabled'}`,
    `Min Liquidity: ${r.min_liquidity ? '$' + fmtCur(r.min_liquidity) : 'Disabled'}`,
    `Max Liquidity: ${r.max_liquidity ? '$' + fmtCur(r.max_liquidity) : 'Disabled'}`,
    ``,
    `📌 <b>Sell</b>`,
    `Auto Sell: ${r.take_profit_percent || r.stop_loss_percent || tpLevels.length || slLevels.length ? '🟢' : '🔴'}`,
    sellBlock,
    ``,
    `Duplicate Filter: ${ch.ignore_duplicate ? '🟢 Ignore repeats' : '🔴 Off'}`,
  ];
  if (r.blind_buy) lines.push(
    ``,
    `⚠️ Blind Buy active — all filters bypassed. High risk.`
  );

  const kb = new InlineKeyboard()
    .text(r.auto_buy ? '💵 ON' : '💵 OFF', `r_buy_${ch.id}`)
    .text('💰 Amount', `r_amt_${ch.id}`)
    .text('🌀 Blind', `r_blind_${ch.id}`)
    .row()
    .text('📊 Filters', `r_filt_${ch.id}`)
    .text('🎯 TP/SL', `r_tpsl_${ch.id}`)
    .text('💼 Group', `r_grp_${ch.id}`)
    .row()
    .text(`⚡ ${fmtFee(r.priority_fee)}`, `f_fee_${ch.id}`)
    .text(`💸 ${fmtFee(r.tip_fee)}`, `f_tip_${ch.id}`)
    .text(`📏 ${r.slippage || 30}%`, `r_slip_${ch.id}`)
    .row()
    .text(`${r.anti_mev ? '🛡️' : '🔲'} MEV`, `r_anti_${ch.id}`)
    .text(`${r.track_only ? '👁️' : '🔲'} Track`, `r_track_${ch.id}`)
    .text(`${ch.ignore_duplicate ? '🔄' : '🔲'} Dedup`, `ch_dedup_${ch.id}`)
    .text(ch.active ? '🔇 Pause' : '🔊 Activate', `ch_t_${ch.id}`)
    .row()
    .text('🗑 Remove', `ch_rem_${ch.id}`)
    .text('🔙 Back', 'menu_channels');

  ctx.editMessageText(lines.join('\n'), { parse_mode: 'HTML', reply_markup: kb }).catch(() => ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: kb }));
}

async function showFilterEditor(ctx, id) {
  await db.setTelegramId(adminId);
  const ch = await db.getChannelWithRule(id);
  if (!ch) return ctx.answerCallbackQuery({ text: 'Not found' });
  const r = ch.rule || {};
  const name = btnText(ch.display_name || ch.channel_username);

  const lines = [
    `📊 <b>Filters — ${esc(name)}</b>`,
    `━━━━━━━━━━━━━━━━`,
    `Min MC: ${r.min_market_cap ? fmtCur(r.min_market_cap) : '—'}`,
    `Max MC: ${r.max_market_cap ? fmtCur(r.max_market_cap) : '—'}`,
    `Min Liq: ${r.min_liquidity ? fmtCur(r.min_liquidity) : '—'}`,
    `Max Liq: ${r.max_liquidity ? fmtCur(r.max_liquidity) : '—'}`,
    `━━━━━━━━━━━━━━━━`,
    `Tap ❌ to toggle OFF. Tap ✅ to set a new value.`,
  ].join('\n');

  const kb = new InlineKeyboard()
    .text(`✅ Min MC`, `f_mcmin_${ch.id}`)
    .text(`✅ Max MC`, `f_mcmax_${ch.id}`)
    .row()
    .text(`✅ Min Liq`, `f_liqmin_${ch.id}`)
    .text(`✅ Max Liq`, `f_liqmax_${ch.id}`)
    .row()
    .text('🔙 Back', `ch_s_${ch.id}`);

  ctx.editMessageText(lines, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {});
}

async function showTPSEditor(ctx, id) {
  await db.setTelegramId(adminId);
  const ch = await db.getChannelWithRule(id);
  if (!ch) return ctx.answerCallbackQuery({ text: 'Not found' });
  const r = ch.rule || {};
  const name = btnText(ch.display_name || ch.channel_username);

  let tpLevels = [];
  try { tpLevels = typeof r.tp_levels === 'string' ? JSON.parse(r.tp_levels) : (r.tp_levels || []); } catch {}
  let slLevels = [];
  try { slLevels = typeof r.sl_levels === 'string' ? JSON.parse(r.sl_levels) : (r.sl_levels || []); } catch {}

  const levelLines = [];
  if (r.take_profit_percent) levelLines.push(`TP: ${r.take_profit_percent}% • 100%`);
  for (const tp of tpLevels) if (tp.percent) levelLines.push(`TP: ${tp.percent}% • ${tp.sell_ratio || 100}%`);
  if (r.stop_loss_percent) levelLines.push(`SL: −${Math.abs(r.stop_loss_percent)}% • 100%`);
  for (const sl of slLevels) if (sl.percent) levelLines.push(`SL: −${Math.abs(sl.percent)}% • ${sl.sell_ratio || 100}%`);

  const lines = [
    `🎯 <b>TP/SL — ${esc(name)}</b>`,
    `━━━━━━━━━━━━━━━━`,
    ...(levelLines.length ? levelLines : [`<i>No TP/SL configured</i>`]),
    `━━━━━━━━━━━━━━━━`,
    `Single TP/SL can be set here. Multi-level TP/SL (e.g. +100% sell 50%, +200% sell 70%) is configured in the web dashboard.`,
  ].join('\n');

  const kb = new InlineKeyboard()
    .text(`🎯 TP: ${r.take_profit_percent ? r.take_profit_percent + '%' : 'OFF'}`, `t_tp_${ch.id}`)
    .text(`🛑 SL: ${r.stop_loss_percent ? r.stop_loss_percent + '%' : 'OFF'}`, `t_sl_${ch.id}`)
    .row()
    .text('🔙 Back', `ch_s_${ch.id}`);

  ctx.editMessageText(lines, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {});
}

const _awaitingRuleInput = new Map();

function startRuleInput(ctx, chId, field, prompt) {
  const uid = String(ctx.from.id);
  _awaitingRuleInput.set(uid, { chId, field });
  ctx.reply(prompt, { parse_mode: 'HTML' }).catch(() => {});
}

async function handleRuleInput(ctx, text) {
  const uid = String(ctx.from.id);
  const state = _awaitingRuleInput.get(uid);
  if (!state) return;
  _awaitingRuleInput.delete(uid);
  const { chId, field } = state;
  try {
    await db.setTelegramId(adminId);
    const ch = await db.getChannelWithRule(chId);
    if (!ch) return ctx.reply('❌ Channel not found.', { parse_mode: 'HTML' });
    let rule = ch.rule || {};

    const val = text.trim();
    if (['min_market_cap', 'max_market_cap', 'min_liquidity', 'max_liquidity'].includes(field)) {
      rule[field] = val ? parseFloat(val) : null;
      if (isNaN(rule[field])) rule[field] = null;
    } else if (field === 'buy_amount_sol') {
      rule[field] = parseFloat(val) || 0.01;
    } else if (field === 'take_profit_percent' || field === 'stop_loss_percent') {
      rule[field] = val ? parseFloat(val) : null;
      if (isNaN(rule[field])) rule[field] = null;
      if (field === 'take_profit_percent') rule.tp_levels = [];
      if (field === 'stop_loss_percent') rule.sl_levels = [];
    } else if (field === 'slippage') {
      rule[field] = Math.min(100, Math.max(0, parseInt(val) || 30));
    } else if (field === 'wallet_group_id') {
      rule[field] = parseInt(val) || 0;
    } else if (field === 'priority_fee' || field === 'tip_fee') {
      rule[field] = parseFloat(val) || null;
      if (rule[field] != null && rule[field] < 0.00001) rule[field] = null;
    } else if (field === 'auto_buy' || field === 'blind_buy') {
      rule[field] = val === '1' || val.toLowerCase() === 'on' || val.toLowerCase() === 'true';
    }

    const cleanRule = { ...rule };
    delete cleanRule.channel_id;
    await db.upsertChannelRule({ channel_id: Number(chId), ...cleanRule });
    const kb = new InlineKeyboard().text('⚙️ Back to Setup', `ch_s_${chId}`);
    ctx.reply(`✅ <b>${field.replace(/_/g, ' ')}</b> updated to <b>${esc(val || '—')}</b>`, { parse_mode: 'HTML', reply_markup: kb });
    showChannelSetup(ctx, parseInt(chId));
  } catch (e) {
    ctx.reply(`❌ ${esc(e.message)}`, { parse_mode: 'HTML' });
  }
}

// ───── SOL Balance (GMGN → RPC fallback) ─────
async function fetchSolBalance(address) {
  try {
    const { getWalletTokenBalance } = await import('./gmgn.js');
    const raw = await getWalletTokenBalance('sol', address, 'So11111111111111111111111111111111111111112');
    const entry = raw?.data?.balances?.[0] || {};
    const b = Number(entry.balance ?? 0);
    const d = entry.decimal ?? 9;
    if (b > 0) return b / Math.pow(10, d);
  } catch {}
  try {
    const r = await fetch('https://api.mainnet-beta.solana.com', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [address] }),
      signal: AbortSignal.timeout(5000),
    });
    const j = await r.json();
    if (j.result?.value != null) return j.result.value / 1e9;
  } catch {}
  return null;
}

// ───── Wallets ─────
async function showWallets(ctx, edit = true) {
  await db.setTelegramId(adminId);
  const wallets = await db.getAllWallets();
  if (!wallets.length) {
    const kb = new InlineKeyboard().text('➕ Add Wallet', 'wallet_add').text('👥 Groups', 'menu_groups').row().text('🔙 Menu', 'menu_main');
    const text = `💰 <b>Wallets</b>\n━━━━━━━━━━━━━━━━\nNo wallets yet.\n\nAdd your first wallet to start trading.`;
    const opts = { parse_mode: 'HTML', reply_markup: kb };
    if (edit) {
      try { await ctx.editMessageText(text, opts); } catch { await ctx.reply(text, opts); }
    } else {
      await ctx.reply(text, opts);
    }
    return;
  }

  const lines = [`💰 <b>Wallets</b>  ${wallets.length} total`, `━━━━━━━━━━━━━━━━`];
  for (const w of wallets) {
    const label = w.label || addrShort(w.address);
    let sol = await fetchSolBalance(w.address);
    const star = w.active ? '⭐ ' : '';
    lines.push(`${star}<b>${esc(label)}</b>\n<code>${esc(w.address)}</code>\n💳 ${sol != null ? sol.toFixed(4) + ' SOL' : '?'}`);
  }
  lines.push(`━━━━━━━━━━━━━━━━`, `⭐ = active buy wallet. Tap ⭐ on a wallet to select it as the buy wallet.`);

  const kb = new InlineKeyboard();
  for (const w of wallets) {
    const label = btnText(w.label || addrShort(w.address));
    kb.text(`${label}`, `wallet_v_${w.id}`)
      .text(w.active ? '⭐' : '☆', `wallet_act_${w.id}`)
      .text('🗑', `wallet_d_${w.id}`).row();
  }
  kb.text('➕ Add Wallet', 'wallet_add').text('👥 Groups', 'menu_groups').row().text('🔙 Menu', 'menu_main');

  const opts = { parse_mode: 'HTML', reply_markup: kb };
  const text = lines.join('\n\n');
  if (edit) {
    try { await ctx.editMessageText(text, opts); } catch { await ctx.reply(text, opts); }
  } else {
    await ctx.reply(text, opts);
  }
}

const _awaitingWalletKey = new Set();

async function promptWalletKey(ctx) {
  _awaitingWalletKey.add(String(ctx.from.id));
  const kb = new InlineKeyboard().text('🔙 Back', 'menu_wallets');
  ctx.reply('🔑 <b>Add Wallet</b>\n\nSend the <b>Base58 private key</b>.\nOptionally add a label after a space.\n\nExample:\n<code>abc123def456... my_wallet</code>\n\nOr /cancel to abort.', { parse_mode: 'HTML', reply_markup: kb });
}

async function handleWalletKeyInput(ctx, text) {
  _awaitingWalletKey.delete(String(ctx.from.id));
  const parts = text.trim().split(/\s+/);
  const pk = parts[0];
  const label = parts.slice(1).join(' ') || null;
  if (!pk || pk.length < 40) return ctx.reply('❌ Invalid private key format.', { parse_mode: 'HTML' });
  try {
    await db.setTelegramId(adminId);
    const { deriveAddressFromPrivateKey } = await import('./gmgn.js');
    const address = deriveAddressFromPrivateKey(pk);
    await db.addWallet(address, label, pk);
    const kb = new InlineKeyboard().text('💰 Wallets', 'menu_wallets').text('🔙 Menu', 'menu_main');
    ctx.reply(`✅ <b>Wallet added!</b>\n<code>${esc(address)}</code>\nLabel: ${esc(label || '—')}`, { parse_mode: 'HTML', reply_markup: kb });
    showWallets(ctx, false);
  } catch (e) {
    ctx.reply(`❌ ${esc(e.message)}`, { parse_mode: 'HTML' });
  }
}

async function showWalletDetail(ctx, id) {
  await db.setTelegramId(adminId);
  const w = await db.getWallet(id);
  if (!w) return ctx.answerCallbackQuery({ text: 'Not found' });
  const { getWalletHoldings } = await import('./gmgn.js');
  const label = w.label || addrShort(w.address);
  let sol = await fetchSolBalance(w.address);
  let holdingsText = '';
  try {
    const h = await getWalletHoldings('sol', w.address, { limit: 5 });
    const list = h?.data?.list || [];
    if (list.length) {
      if (sol != null) {
        const solIdx = list.findIndex(t => t.token_address === 'So11111111111111111111111111111111111111112');
        if (solIdx >= 0) list.splice(solIdx, 1);
      }
      if (list.length) {
        holdingsText = '\n\n<b>📊 Holdings (top 5)</b>\n' + list.slice(0, 5).map(t =>
          `  ${t.symbol || addrShort(t.token_address)}: ${fmtCur(Number(t.usd_value) || 0)}`
        ).join('\n');
      }
    }
  } catch {}

  const lines = [
    `💰 <b>${esc(label)}</b>`,
    `<code>${esc(w.address)}</code>`,
    `━━━━━━━━━━━━━━━━`,
    `💳 <b>${sol != null ? sol.toFixed(4) + ' SOL' : '?'}</b>`,
    holdingsText,
  ].filter(Boolean).join('\n');

  const kb = new InlineKeyboard()
    .text('🔄 Refresh', `wallet_v_${w.id}`)
    .text('🗑 Remove', `wallet_d_${w.id}`)
    .row()
    .text('🔙 Wallets', 'menu_wallets');

  ctx.editMessageText(lines, { parse_mode: 'HTML', reply_markup: kb }).catch(() => ctx.reply(lines, { parse_mode: 'HTML', reply_markup: kb }));
}

async function removeWallet(ctx, id) {
  await db.setTelegramId(adminId);
  await db.removeWallet(id);
  ctx.answerCallbackQuery({ text: 'Removed' });
  showWallets(ctx, true);
}

// ───── Wallet Groups ─────
let _awaitingGroupName = new Set();
async function showGroups(ctx, edit = true) {
  await db.setTelegramId(adminId);
  const groups = await db.getWalletGroups();
  const lines = [`👥 <b>Wallet Groups</b>  ${groups.length} total`, `━━━━━━━━━━━━━━━━`];
  for (const g of groups) {
    lines.push(`<b>${esc(g.name)}</b> — ${g.member_count || 0} wallet${g.member_count !== 1 ? 's' : ''}`);
  }
  if (!groups.length) lines.push('No groups yet.');
  const kb = new InlineKeyboard();
  for (const g of groups) {
    kb.text(btnText(g.name), `grp_v_${g.id}`).text('🗑', `grp_d_${g.id}`).row();
  }
  kb.text('➕ Create Group', 'grp_add').row().text('🔙 Wallets', 'menu_wallets');
  const opts = { parse_mode: 'HTML', reply_markup: kb };
  const text = lines.join('\n');
  if (edit) {
    try { await ctx.editMessageText(text, opts); } catch { await ctx.reply(text, opts); }
  } else {
    await ctx.reply(text, opts);
  }
}
async function promptGroupName(ctx) {
  _awaitingGroupName.add(String(ctx.from.id));
  const kb = new InlineKeyboard().text('🔙 Back', 'menu_wallets');
  ctx.reply('👥 <b>Create Wallet Group</b>\n\nSend a name for the new group.\n\nOr /cancel to abort.', { parse_mode: 'HTML', reply_markup: kb });
}
async function handleGroupNameInput(ctx, text) {
  _awaitingGroupName.delete(String(ctx.from.id));
  const name = text.trim();
  if (!name) return ctx.reply('❌ Name cannot be empty.', { parse_mode: 'HTML' });
  await db.setTelegramId(adminId);
  await db.createWalletGroup(name);
  const kb = new InlineKeyboard().text('👥 Groups', 'menu_groups').text('🔙 Menu', 'menu_main');
  ctx.reply(`✅ Group <b>${esc(name)}</b> created!`, { parse_mode: 'HTML', reply_markup: kb });
  showGroups(ctx, false);
}

let _awaitingGroupWallets = new Set();
async function showGroupDetail(ctx, id) {
  await db.setTelegramId(adminId);
  const g = await db.getWalletGroups().then(gs => gs.find(gg => gg.id === id));
  if (!g) return ctx.answerCallbackQuery({ text: 'Not found' });
  const wallets = await db.getGroupWallets(id);
  const lines = [`👥 <b>${esc(g.name)}</b>`, `━━━━━━━━━━━━━━━━`];
  if (wallets.length) {
    for (const w of wallets) {
      lines.push(`<code>${esc(w.address)}</code>${w.label ? ' — ' + esc(w.label) : ''}`);
    }
  } else {
    lines.push('No wallets in this group.');
  }
  const text = lines.join('\n');
  const kb = new InlineKeyboard()
    .text('➕ Add Wallet', `grp_aw_${g.id}`)
    .row()
    .text('🔙 Groups', 'menu_groups');
  ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb }));
}
async function promptGroupWalletAdd(ctx, groupId) {
  _awaitingGroupWallets.add(String(ctx.from.id));
  _pendingGroupId = groupId;
  const kb = new InlineKeyboard().text('🔙 Back', 'menu_groups');
  ctx.reply('➕ <b>Add Wallet to Group</b>\n\nSend the wallet ID number to add.\n\nGet wallet IDs from 💰 Wallets menu.\n\nOr /cancel to abort.', { parse_mode: 'HTML', reply_markup: kb });
}
let _pendingGroupId = null;
async function handleGroupWalletInput(ctx, text) {
  _awaitingGroupWallets.delete(String(ctx.from.id));
  const walletId = parseInt(text.trim());
  if (isNaN(walletId)) return ctx.reply('❌ Enter a valid wallet ID number.', { parse_mode: 'HTML' });
  await db.setTelegramId(adminId);
  if (_pendingGroupId) {
    await db.addWalletToGroup(_pendingGroupId, walletId);
    _pendingGroupId = null;
    const kb = new InlineKeyboard().text('👥 Groups', 'menu_groups').text('🔙 Menu', 'menu_main');
    ctx.reply(`✅ Wallet #${walletId} added to group!`, { parse_mode: 'HTML', reply_markup: kb });
  }
}
async function removeGroup(ctx, id) {
  await db.setTelegramId(adminId);
  await db.deleteWalletGroup(id);
  ctx.answerCallbackQuery({ text: 'Removed' });
  showGroups(ctx, true);
}

// ───── Signals ─────

// ───── Stats ─────
async function showStats(ctx) {
  await db.setTelegramId(adminId);
  const [channels, wallets, status, logCount, dedup] = await Promise.all([
    db.getAllChannels().catch(() => []),
    db.getAllWallets().catch(() => []),
    db.getScraperStatus().catch(() => ({})),
    db.getSignalCountToday().catch(() => 0),
    import('./router.js').then(m => m.getDedupStats()).catch(() => ({})),
  ]);
  const activeChs = channels.filter(c => c.active).length;
  const uptime = status.uptime ? Math.floor(status.uptime / 60) + 'm' : 'N/A';

  const kb = new InlineKeyboard()
    .text('🔄 Refresh', 'menu_stats')
    .text('🔙 Menu', 'menu_main');

  ctx.reply(
    `📊 <b>SniperBot Stats</b>
━━━━━━━━━━━━━━━━
📡 <b>Channels:</b> ${activeChs}/${channels.length} active
💰 <b>Wallets:</b> ${wallets.length}
📈 <b>Signals today:</b> ${logCount}
━━━━━━━━━━━━━━━━
📡 <b>CA caught:</b> ${dedup.total_caught || 0}
⏭️ <b>Ignored:</b> ${dedup.total_ignored || 0}
⏱ <b>Uptime:</b> ${uptime}
🟢 <b>TG:</b> ${isTgConnected() ? 'Connected' : 'Disconnected'}
━━━━━━━━━━━━━━━━
Tap 🔄 to refresh`,
    { parse_mode: 'HTML', reply_markup: kb });
}

// ───── Signal Forwarding ─────

// ───── Positions ─────
async function showPositions(ctx, edit = true) {
  await db.setTelegramId(adminId);
  const { reconcileOpenPositions, getExternalPositions } = await import('./router.js');
  await reconcileOpenPositions().catch(() => {});
  const trades = await db.getOpenTrades();
  const externals = await getExternalPositions(trades).catch(() => []);
  const total = trades.length + externals.length;
  if (!total) {
    const kb = new InlineKeyboard().text('🔙 Menu', 'menu_main');
    const text = '📈 <b>Positions</b>\n━━━━━━━━━━━━━━━━\nNo open positions.\n\nTrades appear here after auto-buy executes. Wallet holdings show up automatically as external positions.';
    const opts = { parse_mode: 'HTML', reply_markup: kb };
    if (edit) { try { await ctx.editMessageText(text, opts); } catch { await ctx.reply(text, opts); } }
    else { await ctx.reply(text, opts); }
    return;
  }

  _extPos.clear();
  const { getTokenInfo } = await import('./gmgn.js');
  const lines = [`📈 <b>Positions</b>  ${total} open`, `━━━━━━━━━━━━━━━━`];
  const infoData = (await Promise.allSettled(trades.map(t =>
    getTokenInfo(t.chain || 'sol', t.token_address).then(i => unpackTokenInfo(i)).catch(() => ({ price: null, mcap: null, symbol: '' }))
  ))).map(r => r.status === 'fulfilled' ? r.value : { price: null, mcap: null, symbol: '' });
  trades.forEach((t, idx) => {
    const { price, mcap } = infoData[idx];
    const sym = t.token_symbol || addrShort(t.token_address);
    const buyMc = price && mcap && t.buy_price_usd ? (t.buy_price_usd / price) * mcap : null;
    const pnl = price && t.buy_price_usd ? ((price - t.buy_price_usd) / t.buy_price_usd * 100) : null;
    const pnlStr = pnl != null ? (pnl >= 0 ? '🟢 +' : '🔴 ') + pnl.toFixed(1) + '%' : '—';
    const mcStr = mcap ? fmtCur(mcap) : '?';
    const buyStr = buyMc ? ` · Buy ${fmtCur(buyMc)}` : '';
    const tpSl = [t.take_profit_percent ? `TP ${t.take_profit_percent}%` : '', t.stop_loss_percent ? `SL ${t.stop_loss_percent}%` : ''].filter(Boolean).join(' / ');
    lines.push(`<b>${esc(sym)}</b> | 💰 ${t.buy_amount_sol || '?'} SOL\n📈 MC: ${mcStr}${buyStr} · <b>P&amp;L:</b> ${pnlStr}${tpSl ? `\n<b>${esc(tpSl)}</b>` : ''}`);
  });

  const extInfoData = (await Promise.allSettled(externals.map(t =>
    getTokenInfo(t.chain || 'sol', t.token_address).then(i => unpackTokenInfo(i)).catch(() => ({ price: null, mcap: null, symbol: '' }))
  ))).map(r => r.status === 'fulfilled' ? r.value : { price: null, mcap: null, symbol: '' });
  externals.forEach((t, idx) => {
    const info = extInfoData[idx];
    const sym = info.symbol || t.token_symbol || addrShort(t.token_address);
    const idxNum = _extPosIdx++;
    _extPos.set(idxNum, { wallet: t.wallet_address, token: t.token_address, symbol: sym, balance: t.token_balance, usd: t.usd_value, pnl: t.pnl_percent });
    const balStr = t.token_balance != null ? Number(t.token_balance).toFixed(2) + ' ' + sym : (t.usd_value != null ? '$' + Number(t.usd_value).toFixed(2) : '?');
    const mcStr = info.mcap ? fmtCur(info.mcap) : '?';
    const buyStr = t.buy_market_cap ? ` · Buy ${fmtCur(t.buy_market_cap)}` : '';
    const pnlStr = t.pnl_percent != null ? (t.pnl_percent >= 0 ? '🟢 +' : '🔴 ') + t.pnl_percent.toFixed(1) + '%' : '—';
    const usdStr = t.usd_value != null ? ' · 💵 $' + Number(t.usd_value).toFixed(2) : '';
    lines.push(`<b>${esc(sym)}</b> <span class="tg-spoiler">🧰 external</span> | ${balStr}\n📈 MC: ${mcStr}${buyStr} · <b>P&amp;L:</b> ${pnlStr}${usdStr}`);
  });

  const kb = new InlineKeyboard();
  for (let i = 0; i < trades.length; i++) {
    const sym = btnText(trades[i].token_symbol || addrShort(trades[i].token_address));
    kb.text(`${i+1}. ${sym}`, `pos_v_${trades[i].id}`).row();
  }
  for (const [idx, e] of _extPos) {
    kb.text(`🧰 ${btnText(e.symbol)}`, `pose_v_${idx}`).row();
  }
  kb.text('🔄 Refresh', 'menu_positions').text('🔙 Menu', 'menu_main');

  const opts = { parse_mode: 'HTML', reply_markup: kb };
  const text = lines.join('\n\n');
  if (edit) { try { await ctx.editMessageText(text, opts); } catch { await ctx.reply(text, opts); } }
  else { await ctx.reply(text, opts); }
}

// ───── History ─────
async function showHistory(ctx, edit = true) {
  await db.setTelegramId(adminId);
  const trades = await db.getTradeHistory(12);
  if (!trades.length) {
    const kb = new InlineKeyboard().text('🔙 Menu', 'menu_main');
    const text = '📜 <b>History</b>\n━━━━━━━━━━━━━━━━\nNo trades yet.';
    const opts = { parse_mode: 'HTML', reply_markup: kb };
    if (edit) { try { await ctx.editMessageText(text, opts); } catch { await ctx.reply(text, opts); } }
    else { await ctx.reply(text, opts); }
    return;
  }
  const { getTokenInfo } = await import('./gmgn.js');
  const infoData = (await Promise.allSettled(trades.map(t =>
    getTokenInfo(t.chain || 'sol', t.token_address).then(i => unpackTokenInfo(i)).catch(() => ({ price: null, mcap: null, symbol: '' }))
  ))).map(r => r.status === 'fulfilled' ? r.value : { price: null, mcap: null, symbol: '' });
  const lines = [`📜 <b>Trade History</b>  (last ${trades.length})`, `━━━━━━━━━━━━━━━━`];
  trades.forEach((t, idx) => {
    const info = infoData[idx];
    const sym = info.symbol || t.token_symbol || addrShort(t.token_address);
    const price = info.price;
    const mcNow = info.mcap;
    const buyMc = price && mcNow && t.buy_price_usd ? (t.buy_price_usd / price) * mcNow : null;
    const pnl = price && t.buy_price_usd ? ((price - t.buy_price_usd) / t.buy_price_usd * 100) : null;
    const state = t.status === 'closed' ? '🔒 Closed' : '🟢 Open';
    const pnlStr = t.status === 'closed'
      ? (t.pnl_percent != null ? (t.pnl_percent >= 0 ? '🟢 +' : '🔴 ') + t.pnl_percent.toFixed(1) + '%' : (t.buy_status === 'failed' ? '❌ failed' : '—'))
      : (pnl != null ? (pnl >= 0 ? '🟢 +' : '🔴 ') + pnl.toFixed(1) + '%' : '—');
    const when = ago(t.created_at);
    lines.push(`<b>${esc(sym)}</b> | 💰 ${t.buy_amount_sol || '?'} SOL · ${state}\n${buyMc ? `💵 Buy ${fmtCur(buyMc)}` : ''}${mcNow ? ` · 📈 ${fmtCur(mcNow)}` : ''} · <b>P&amp;L:</b> ${pnlStr} · ⏱ ${when}`);
  });
  const kb = new InlineKeyboard().text('📈 Positions', 'menu_positions').text('🔄 Refresh', 'menu_history').row().text('🔙 Menu', 'menu_main');
  const opts = { parse_mode: 'HTML', reply_markup: kb };
  const text = lines.join('\n\n');
  if (edit) { try { await ctx.editMessageText(text, opts); } catch { await ctx.reply(text, opts); } }
  else { await ctx.reply(text, opts); }
}

async function showPositionDetail(ctx, id) {
  await db.setTelegramId(adminId);
  const t = await db.getTrade(id);
  if (!t) return ctx.answerCallbackQuery({ text: 'Not found' });

  const { getTokenInfo } = await import('./gmgn.js');
  let price = null;
  let mcap = null;
  try {
    const info = await getTokenInfo(t.chain || 'sol', t.token_address);
    const unpacked = unpackTokenInfo(info);
    price = unpacked.price;
    mcap = unpacked.mcap;
  } catch {}
  const buyMc = price && mcap && t.buy_price_usd ? (t.buy_price_usd / price) * mcap : null;
  const pnl = price && t.buy_price_usd ? ((price - t.buy_price_usd) / t.buy_price_usd * 100) : null;
  const pnlStr = pnl != null ? (pnl >= 0 ? '🟢 +' : '🔴 ') + pnl.toFixed(2) + '%' : '—';

  const lines = [
    `📈 <b>${esc(t.token_symbol || addrShort(t.token_address))}</b>`,
    `━━━━━━━━━━━━━━━━`,
    `💳 Wallet: <code>${esc(t.wallet_address?.slice(0,8))}...</code>`,
    `<code>${esc(t.token_address)}</code>`,
    `━━━━━━━━━━━━━━━━`,
    `💰 <b>${t.buy_amount_sol || '?'} SOL</b>`,
    `💵 Buy MC: ${buyMc ? fmtCur(buyMc) : '?'}`,
    `📈 MC Now: ${mcap ? fmtCur(mcap) : '?'}`,
    `📊 P&amp;L: ${pnlStr}`,
    `🎯 TP: ${t.take_profit_percent ? t.take_profit_percent + '%' : '—'}`,
    `🛑 SL: ${t.stop_loss_percent ? t.stop_loss_percent + '%' : '—'}`,
    `📡 ${esc(t.source_channel || '')}`,
    `⏱ ${ago(t.created_at)}`,
  ].join('\n');

  const kb = new InlineKeyboard()
    .text('🔴 Sell 25%', `pos_s_${t.id}_25`)
    .text('🔴 Sell 50%', `pos_s_${t.id}_50`)
    .text('🔴 Sell 100%', `pos_s_${t.id}_100`)
    .row()
    .text(`🎯 Set TP`, `pos_tp_${t.id}`)
    .text(`🛑 Set SL`, `pos_sl_${t.id}`)
    .row()
    .text('🔄 Refresh', `pos_v_${t.id}`)
    .text('🔙 Positions', 'menu_positions');

  ctx.editMessageText(lines, { parse_mode: 'HTML', reply_markup: kb }).catch(() => ctx.reply(lines, { parse_mode: 'HTML', reply_markup: kb }));
}

async function executePositionSell(ctx, tradeId, percent, confirm = false) {
  await db.setTelegramId(adminId);
  const t = await db.getTrade(tradeId);
  if (!t) return ctx.answerCallbackQuery({ text: 'Not found' });
  if (t.status === 'closed') return ctx.answerCallbackQuery({ text: 'Already closed' });

  if (!confirm) {
    const kb = new InlineKeyboard()
      .text(`✅ Confirm Sell ${percent}%`, `pos_confirm_sell_${tradeId}_${percent}`)
      .text('❌ Cancel', `pos_v_${tradeId}`);
    ctx.editMessageText(
      `⚠️ <b>Confirm Sell</b>\n\nSell <b>${percent}%</b> of <b>${esc(t.token_symbol || addrShort(t.token_address))}</b>?\nWallet: <code>${esc(t.wallet_address?.slice(0,8))}...</code>\nAmount: ${(t.buy_amount_sol * percent / 100).toFixed(4)} SOL`,
      { parse_mode: 'HTML', reply_markup: kb }
    ).catch(() => {});
    return;
  }

  try {
    const { executeSell, getUserCredentials } = await import('./gmgn.js');
    const creds = await getUserCredentials(t.telegram_id || adminId);
    const result = await executeSell(t.chain || 'sol', t.wallet_address, t.token_address, percent, { slippage: 30 }, creds);
    const orderId = result.data?.order_id || result.order_id;

    if (percent >= 100) {
      await db.closeTrade(t.id, { sell_order_id: orderId, sell_amount_sol: t.buy_amount_sol, status: 'closed' });
    } else {
      const remaining = Math.max(0, t.buy_amount_sol * (100 - percent) / 100);
      await db.updateTrade(t.id, { buy_amount_sol: remaining, sell_order_id: orderId, sell_amount_sol: t.buy_amount_sol * percent / 100 });
    }

    ctx.editMessageText(
      `✅ <b>Sell Executed</b>\n\n${percent}% of <b>${esc(t.token_symbol || addrShort(t.token_address))}</b>\nOrder: <code>${esc(orderId)}</code>${percent < 100 ? `\nRemaining: ${(t.buy_amount_sol * (100 - percent) / 100).toFixed(4)} SOL` : ''}`,
      { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('📈 Positions', 'menu_positions').text('🔙 Menu', 'menu_main') }
    ).catch(() => {});
  } catch (err) {
    ctx.answerCallbackQuery({ text: `Sell failed: ${err.message.slice(0,60)}` });
  }
}

async function showExternalPositionDetail(ctx, idx) {
  const e = _extPos.get(parseInt(idx));
  if (!e) return ctx.answerCallbackQuery({ text: 'Expired, refresh positions' });
  await db.setTelegramId(adminId);
  const { getTokenInfo } = await import('./gmgn.js');
  let price = null, mcap = null;
  try {
    const unpacked = unpackTokenInfo(await getTokenInfo('sol', e.token));
    price = unpacked.price;
    mcap = unpacked.mcap;
  } catch {}
  const balStr = e.balance != null ? Number(e.balance).toFixed(2) : '?';
  const usdStr = e.usd != null ? ' · 💵 $' + Number(e.usd).toFixed(2) : '';
  const pnlStr = e.pnl != null ? (e.pnl >= 0 ? '🟢 +' : '🔴 ') + e.pnl.toFixed(2) + '%' : '—';
  const lines = [
    `🧰 <b>${esc(e.symbol)}</b> <span class="tg-spoiler">external</span>`,
    `━━━━━━━━━━━━━━━━`,
    `💳 Wallet: <code>${esc(e.wallet.slice(0,8))}...</code>`,
    `<code>${esc(e.token)}</code>`,
    `━━━━━━━━━━━━━━━━`,
    `🪙 Balance: <b>${balStr}</b>${usdStr}`,
    `📈 MC Now: ${mcap ? fmtCur(mcap) : '?'}${price ? ` · Price ${price < 0.01 ? price.toFixed(8) : price.toFixed(5)}` : ''}`,
    `📊 P&amp;L: ${pnlStr}`,
    `📡 Held in your wallet (not a bot buy)`,
  ].join('\n');

  const kb = new InlineKeyboard()
    .text('🔴 Sell 25%', `pose_s_${idx}_25`)
    .text('🔴 Sell 50%', `pose_s_${idx}_50`)
    .text('🔴 Sell 100%', `pose_s_${idx}_100`)
    .row()
    .text('🔄 Refresh', `pose_v_${idx}`)
    .text('🔙 Positions', 'menu_positions');

  ctx.editMessageText(lines, { parse_mode: 'HTML', reply_markup: kb }).catch(() => ctx.reply(lines, { parse_mode: 'HTML', reply_markup: kb }));
}

async function executeExternalSell(ctx, idx, percent, confirm = false) {
  const e = _extPos.get(parseInt(idx));
  if (!e) return ctx.answerCallbackQuery({ text: 'Expired, refresh positions' });

  if (!confirm) {
    const kb = new InlineKeyboard()
      .text(`✅ Confirm Sell ${percent}%`, `pose_c_${idx}_${percent}`)
      .text('❌ Cancel', `pose_v_${idx}`);
    ctx.editMessageText(
      `⚠️ <b>Confirm Sell</b>\n\nSell <b>${percent}%</b> of <b>${esc(e.symbol)}</b>?\nWallet: <code>${esc(e.wallet.slice(0,8))}...</code>\nBalance: ${Number(e.balance != null ? e.balance : 0).toFixed(2)} ${esc(e.symbol)}`,
      { parse_mode: 'HTML', reply_markup: kb }
    ).catch(() => {});
    return;
  }

  ctx.answerCallbackQuery({ text: 'Selling...' }).catch(() => {});
  try {
    const { executeSell, getUserCredentials } = await import('./gmgn.js');
    const creds = await getUserCredentials(adminId);
    const result = await executeSell('sol', e.wallet, e.token, percent, { slippage: 30 }, creds);
    const orderId = result?.data?.order_id || result?.order_id;
    ctx.editMessageText(
      `✅ <b>Sell order submitted</b>\n\n🧰 ${esc(e.symbol)} · ${percent}%\n💳 <code>${esc(e.wallet.slice(0,8))}...</code>\n${orderId ? `🆔 <code>${esc(orderId)}</code>` : ''}\n\nIt may take a few seconds to confirm.`,
      { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('📈 Positions', 'menu_positions') }
    ).catch(() => {});
  } catch (err) {
    ctx.editMessageText(`❌ <b>Sell failed</b>\n\n${esc(err.message.slice(0,200))}`, { parse_mode: 'HTML' }).catch(() => {});
  }
}

async function handlePositionTPSLInput(ctx, text) {
  const uid = String(ctx.from.id);
  const state = _awaitingPosTPSL.get(uid);
  if (!state) return;
  _awaitingPosTPSL.delete(uid);

  await db.setTelegramId(adminId);
  const t = await db.getTrade(state.tradeId);
  if (!t) return ctx.reply('❌ Position not found.', { parse_mode: 'HTML' });

  const pct = parseFloat(text.trim());
  if (isNaN(pct) || pct <= 0 || pct > 1000) {
    return ctx.reply('❌ Invalid percentage. Enter a number (1-1000).', { parse_mode: 'HTML' });
  }

  const field = state.type === 'tp' ? 'take_profit_percent' : 'stop_loss_percent';
  await db.updateTrade(t.id, { [field]: pct });

  const label = state.type === 'tp' ? 'Take Profit' : 'Stop Loss';
  ctx.reply(`✅ <b>${label}</b> set to <b>${pct}%</b> for <b>${esc(t.token_symbol || addrShort(t.token_address))}</b>`, {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard().text('📈 View Position', `pos_v_${t.id}`).text('🔙 Positions', 'menu_positions'),
  });
}

const _sigMsg = new Map(); // signalId -> { chatId, msgId } — signal cards get edited to full detail

function _sigHeader(d) {
  return `📡 <b>${esc(d.source_channel || '')}</b>\n<code>${esc(d.token_address)}</code>`;
}

function _sigDetail(d) {
  const sym = d.token_symbol ? `<b>${esc(d.token_symbol)}</b>` : '<b>?</b>';
  const name = d.token_name ? ` · <i>${esc(d.token_name)}</i>` : '';
  const price = d.price ? `$${Number(d.price).toLocaleString(undefined, { maximumFractionDigits: 10 })}` : '?';
  const mc = d.market_cap ? fmtCur(d.market_cap) : '?';
  const liq = d.liquidity ? fmtCur(d.liquidity) : '?';
  const vol = d.volume_24h ? fmtCur(d.volume_24h) : null;
  const rug = d.rug_ratio != null && d.rug_ratio >= 0 ? `🛡 Rug ${d.rug_ratio.toFixed(1)}%` : null;
  const smart = d.smart_degen_count != null && d.smart_degen_count > 0 ? `👥 ${d.smart_degen_count} smart` : null;
  const hp = d.is_honeypot && d.is_honeypot !== 'false' && d.is_honeypot !== '0' && d.is_honeypot !== '' ? '🍯 Honeypot' : null;
  const rows = [`💵 ${price} · 🎯 ${mc} MC`];
  if (liq || vol) rows.push([liq ? `💧 ${liq}` : null, vol ? `📊 ${vol}` : null].filter(Boolean).join(' · '));
  const sec = [rug, smart, hp].filter(Boolean);
  if (sec.length) rows.push(sec.join(' · '));
  return `${_sigHeader(d)}\n${sym}${name}\n${rows.join('\n')}`;
}

function attachLiveForwarding() {
  liveEvents.on('trade', async data => {
    if (!adminId || (data._tid && data._tid !== adminId)) return;
    const sym = data.token_symbol || addrShort(data.token_address);
    try {
      await bot.api.sendMessage(adminId,
        `⏳ <b>${esc(sym)}</b>\n<code>${esc(data.token_address)}</code>\n💰 ${data.amount || '?'} SOL\n📡 ${esc(data.source_channel || '')}`,
        { parse_mode: 'HTML' });
    } catch {}
  });

  // CA caught → instant line, then edited into a full detail card as DexScreener (fast) / GMGN land
  liveEvents.on('signal', async data => {
    if (!adminId) return;
    const key = `${data.id || ''}${data.token_address}`;
    if (_sigMsg.has(key)) return;
    try {
      const sent = await bot.api.sendMessage(adminId, _sigHeader(data), { parse_mode: 'HTML' });
      _sigMsg.set(key, { chatId: adminId, msgId: sent.message_id });
      if (_sigMsg.size > 200) {
        const first = _sigMsg.keys().next().value;
        if (first != null) _sigMsg.delete(first);
      }
    } catch {}
  });

  liveEvents.on('signal_update', async data => {
    if (!adminId) return;
    const key = `${data.id || ''}${data.token_address}`;
    const rec = _sigMsg.get(key);
    if (!rec) return;
    try {
      await bot.api.editMessageText(rec.chatId, rec.msgId, _sigDetail(data), { parse_mode: 'HTML' });
      if (data.src === 'gmgn') _sigMsg.delete(key);
    } catch {}
  });

  liveEvents.on('trade_update', async data => {
    if (!adminId || (data._tid && data._tid !== adminId)) return;
    let t = null;
    try { t = await db.getTrade(data.trade_id); } catch {}
    const sym = (t && t.token_symbol && t.token_symbol !== 'PENDING') ? t.token_symbol : (t ? addrShort(t.token_address) : '?');
    const addr = t ? t.token_address : '';
    const icon = data.status === 'confirmed' ? '✅' : data.status === 'failed' ? '❌' : '⏳';
    const line = data.status === 'confirmed' ? 'Buy confirmed' : data.status === 'failed' ? 'Buy failed' : 'Buy status';
    try {
      let msg = `${icon} <b>${esc(line)}</b>\n<b>${esc(sym)}</b>`;
      if (addr) msg += `\n<code>${esc(addr)}</code>`;
      if (data.status === 'confirmed' && data.buy_tx) msg += `\n🔗 <a href="https://solscan.io/tx/${esc(data.buy_tx)}">View transaction</a>`;
      await bot.api.sendMessage(adminId, msg, { parse_mode: 'HTML' });
    } catch {}
  });
}

// ───── Commands ─────
function registerCommands() {
  bot.command('start', async ctx => { if (!auth(ctx)) return; showMainMenu(ctx, false); });
  bot.command('help', async ctx => { if (!auth(ctx)) return; showHelp(ctx, false); });
  bot.command('cancel', async ctx => {
    const uid = String(ctx.from.id);
    _awaitingLink.delete(uid);
    _awaitingWalletKey.delete(uid);
    _awaitingRuleInput.delete(uid);
    _awaitingGroupName.delete(uid);
    _awaitingGroupWallets.delete(uid);
    _awaitingPosTPSL.delete(uid);
    _pendingGroupId = null;
    const kb = new InlineKeyboard().text('🔙 Menu', 'menu_main');
    ctx.reply('Cancelled.', { parse_mode: 'HTML', reply_markup: kb });
    showMainMenu(ctx, false);
  });

  bot.command('channels', async ctx => { if (!auth(ctx)) return; showChannels(ctx, 0, false); });
  bot.command('positions', async ctx => { if (!auth(ctx)) return; showPositions(ctx, false); });
  bot.command('history', async ctx => { if (!auth(ctx)) return; showHistory(ctx, false); });
  bot.command('wallets', async ctx => { if (!auth(ctx)) return; showWallets(ctx, false); });
  bot.command('balance', async ctx => { if (!auth(ctx)) return; showWallets(ctx, false); });
  bot.command('stats', async ctx => { if (!auth(ctx)) return; showStats(ctx); });
  bot.command('disconnect', async ctx => { if (!auth(ctx)) return; cmdDisconnect(ctx); });

  // ───── Text fallback ─────
  bot.on('message:text', async ctx => {
    if (!adminId) adminId = String(ctx.from.id);
    const uid = String(ctx.from.id);

    if (_awaitingLink.has(uid)) return handleLinkInput(ctx, ctx.message.text);
    if (_awaitingWalletKey.has(uid)) return handleWalletKeyInput(ctx, ctx.message.text);
    if (_awaitingRuleInput.has(uid)) return handleRuleInput(ctx, ctx.message.text);
    if (_awaitingGroupName.has(uid)) return handleGroupNameInput(ctx, ctx.message.text);
    if (_awaitingGroupWallets.has(uid)) return handleGroupWalletInput(ctx, ctx.message.text);
    if (_awaitingPosTPSL.has(uid)) return handlePositionTPSLInput(ctx, ctx.message.text);

    if (!auth(ctx)) return;
    showMainMenu(ctx, false);
  });

  // ───── Callback queries ─────
  bot.on('callback_query:data', async ctx => {
    if (!auth(ctx)) return;
    const d = ctx.callbackQuery.data;
    await db.setTelegramId(adminId);

    // Menu nav
    if (d === 'menu_main') return showMainMenu(ctx, true);
    if (d === 'menu_channels') return showChannels(ctx, 0, true);
    if (d === 'menu_wallets') return showWallets(ctx, true);
    if (d === 'menu_positions') { ctx.answerCallbackQuery(); return showPositions(ctx, true); }
    if (d === 'menu_history') { ctx.answerCallbackQuery(); return showHistory(ctx, true); }
    if (d === 'menu_groups') { ctx.answerCallbackQuery(); return showGroups(ctx, true); }
    if (d === 'menu_stats') { ctx.answerCallbackQuery(); return showStats(ctx); }
    if (d === 'menu_disconnect') { ctx.answerCallbackQuery({ text: 'Disconnecting...' }); return cmdDisconnect(ctx); }
    if (d === 'menu_help') { ctx.answerCallbackQuery(); return showHelp(ctx, true); }

    // Add channel
    if (d === 'add_ch') {
      const kb = new InlineKeyboard()
        .text('🔗 Enter Link', 'add_link').text('📡 From Joined', 'add_joined')
        .row().text('🔙 Menu', 'menu_main');
      return ctx.editMessageText('📡 <b>Add Channel</b>\n━━━━━━━━━━━━━━━━\nChoose how to add:', { parse_mode: 'HTML', reply_markup: kb });
    }
    if (d === 'add_link') { ctx.answerCallbackQuery(); return promptLink(ctx); }
    if (d === 'add_joined') { ctx.answerCallbackQuery(); return showJoinedChannels(ctx); }

    // Joined channel add
    if (d.startsWith('ja_')) { const id = d.slice(3); ctx.answerCallbackQuery(); return addJoinedChannel(ctx, id); }
    if (d.startsWith('jp_')) { const p = parseInt(d.slice(3)); ctx.answerCallbackQuery(); return showJoinedChannels(ctx, p); }

    // Channel list
    if (d === 'ch_ref') return showChannels(ctx, 0, true);
    if (d === 'nop') return ctx.answerCallbackQuery();

    // Toggle channel
    const toggleMatch = d.match(/^ch_t_(\d+)$/);
    if (toggleMatch) {
      const id = parseInt(toggleMatch[1]);
      const ch = await db.getChannel(id);
      if (!ch) return ctx.answerCallbackQuery({ text: 'Not found' });
      const newActive = ch.active ? 0 : 1;
      await db.toggleChannel(id, newActive);
      if (newActive) await tg.addChannelListener(ch.channel_username, ch.track_mode).catch(() => {});
      else await tg.removeChannelListener(ch.channel_username).catch(() => {});
      ctx.answerCallbackQuery({ text: newActive ? '🔈 Listening' : '🔇 Paused' });
      return showChannels(ctx, 0, true);
    }

    const setupMatch = d.match(/^ch_s_(\d+)$/);
    if (setupMatch) { ctx.answerCallbackQuery(); return showChannelSetup(ctx, parseInt(setupMatch[1])); }

    // Remove channel with confirm
    const removeMatch = d.match(/^ch_rem_(\d+)$/);
    if (removeMatch) {
      const id = parseInt(removeMatch[1]);
      const ch = await db.getChannel(id);
      if (!ch) return ctx.answerCallbackQuery({ text: 'Not found' });
      const name = btnText(ch.display_name || ch.channel_username);
      ctx.editMessageText(
        `🗑 <b>Remove channel?</b>\n\nAre you sure you want to remove <b>${esc(name)}</b>?`,
        { parse_mode: 'HTML', reply_markup: confirmKb(`ch_del_${id}`) });
      return;
    }
    const confirmChDel = d.match(/^confirm_ch_del_(\d+)$/);
    if (confirmChDel) {
      const id = parseInt(confirmChDel[1]);
      const ch = await db.getChannel(id);
      if (!ch) return ctx.answerCallbackQuery({ text: 'Not found' });
      await tg.removeChannelListener(ch.channel_username).catch(() => {});
      await db.removeChannel(id);
      ctx.answerCallbackQuery({ text: 'Removed' });
      return showChannels(ctx, 0, true);
    }

    const pageMatch = d.match(/^ch_p_(\d+)$/);
    if (pageMatch) { ctx.answerCallbackQuery(); return showChannels(ctx, parseInt(pageMatch[1]), true); }

    // ───── Channel Rule Editor ─────
    const rBuyMatch = d.match(/^r_buy_(\d+)$/);
    if (rBuyMatch) {
      const id = parseInt(rBuyMatch[1]);
      const ch = await db.getChannelWithRule(id);
      if (!ch) return ctx.answerCallbackQuery({ text: 'Not found' });
      const rule = ch.rule || {};
      rule.auto_buy = !rule.auto_buy;
      const clean = { ...rule }; delete clean.channel_id;
      await db.upsertChannelRule({ channel_id: id, ...clean });
      ctx.answerCallbackQuery({ text: rule.auto_buy ? 'Buy ON' : 'Buy OFF' });
      return showChannelSetup(ctx, id);
    }

    const rBlindMatch = d.match(/^r_blind_(\d+)$/);
    if (rBlindMatch) {
      const id = parseInt(rBlindMatch[1]);
      const ch = await db.getChannelWithRule(id);
      if (!ch) return ctx.answerCallbackQuery({ text: 'Not found' });
      const rule = ch.rule || {};
      rule.blind_buy = !rule.blind_buy;
      const clean = { ...rule }; delete clean.channel_id;
      await db.upsertChannelRule({ channel_id: id, ...clean });
      ctx.answerCallbackQuery({ text: rule.blind_buy ? 'Blind ON' : 'Blind OFF' });
      return showChannelSetup(ctx, id);
    }

    const rAmtMatch = d.match(/^r_amt_(\d+)$/);
    if (rAmtMatch) {
      const id = rAmtMatch[1];
      ctx.answerCallbackQuery();
      return startRuleInput(ctx, id, 'buy_amount_sol', '💰 <b>Buy Amount</b>\n\nEnter SOL amount per buy.\nExample: <code>0.05</code>');
    }

    const rGrpMatch = d.match(/^r_grp_(\d+)$/);
    if (rGrpMatch) {
      const id = rGrpMatch[1];
      ctx.answerCallbackQuery();
      return startRuleInput(ctx, id, 'wallet_group_id', '💼 <b>Wallet Group</b>\n\nEnter wallet group ID:\n0 = active wallet\nNegative = single wallet ID');
    }

    const rSlipMatch = d.match(/^r_slip_(\d+)$/);
    if (rSlipMatch) {
      const id = rSlipMatch[1];
      ctx.answerCallbackQuery();
      return startRuleInput(ctx, id, 'slippage', '📏 <b>Slippage</b>\n\nEnter slippage percentage (0–100).\nExample: <code>50</code> for 50%');
    }

    const rAntiMatch = d.match(/^r_anti_(\d+)$/);
    if (rAntiMatch) {
      const id = parseInt(rAntiMatch[1]);
      const ch = await db.getChannelWithRule(id);
      if (!ch) return ctx.answerCallbackQuery({ text: 'Not found' });
      const rule = ch.rule || {};
      rule.anti_mev = rule.anti_mev ? 0 : 1;
      const clean = { ...rule }; delete clean.channel_id;
      await db.upsertChannelRule({ channel_id: id, ...clean });
      ctx.answerCallbackQuery({ text: rule.anti_mev ? 'MEV ON' : 'MEV OFF' });
      return showChannelSetup(ctx, id);
    }

    const rTrackMatch = d.match(/^r_track_(\d+)$/);
    if (rTrackMatch) {
      const id = parseInt(rTrackMatch[1]);
      const ch = await db.getChannelWithRule(id);
      if (!ch) return ctx.answerCallbackQuery({ text: 'Not found' });
      const rule = ch.rule || {};
      rule.track_only = rule.track_only ? 0 : 1;
      if (rule.track_only) rule.auto_buy = 0;
      const clean = { ...rule }; delete clean.channel_id;
      await db.upsertChannelRule({ channel_id: id, ...clean });
      ctx.answerCallbackQuery({ text: rule.track_only ? 'Track only ON' : 'Track only OFF' });
      return showChannelSetup(ctx, id);
    }

    const rDedupMatch = d.match(/^ch_dedup_(\d+)$/);
    if (rDedupMatch) {
      const id = parseInt(rDedupMatch[1]);
      const ch = await db.getChannel(id);
      if (!ch) return ctx.answerCallbackQuery({ text: 'Not found' });
      const newVal = ch.ignore_duplicate ? 0 : 1;
      await db.updateChannelSetting(id, 'ignore_duplicate', newVal);
      ctx.answerCallbackQuery({ text: newVal ? 'Ignore duplicates ON' : 'Ignore duplicates OFF' });
      return showChannelSetup(ctx, id);
    }

    const rFiltMatch = d.match(/^r_filt_(\d+)$/);
    if (rFiltMatch) { ctx.answerCallbackQuery(); return showFilterEditor(ctx, parseInt(rFiltMatch[1])); }

    const rTpslMatch = d.match(/^r_tpsl_(\d+)$/);
    if (rTpslMatch) { ctx.answerCallbackQuery(); return showTPSEditor(ctx, parseInt(rTpslMatch[1])); }

    // Fee toggles — inline in main setup
    const feeMap = { 'f_fee_': 'priority_fee', 'f_tip_': 'tip_fee' };
    for (const [prefix, field] of Object.entries(feeMap)) {
      if (d.startsWith(prefix)) {
        const id = parseInt(d.slice(prefix.length));
        const ch = await db.getChannelWithRule(id);
        if (!ch) return ctx.answerCallbackQuery({ text: 'Not found' });
        const rule = ch.rule || {};
        if (rule[field]) {
          rule[field] = null;
          const clean = { ...rule }; delete clean.channel_id;
          await db.upsertChannelRule({ channel_id: id, ...clean });
          ctx.answerCallbackQuery({ text: 'Cleared' });
          return showChannelSetup(ctx, id);
        } else {
          ctx.answerCallbackQuery();
          return startRuleInput(ctx, String(id), field, `⚡ <b>Enter ${field === 'priority_fee' ? 'Priority Fee' : 'Tip Fee'}</b>\n\nEnter amount in SOL.\nMin: <code>0.00001</code>\nExample: <code>0.0001</code>`);
        }
      }
    }

    // Filter toggles
    const fMap = {
      'f_mcmin_': 'min_market_cap',
      'f_mcmax_': 'max_market_cap',
      'f_liqmin_': 'min_liquidity',
      'f_liqmax_': 'max_liquidity',
    };
    for (const [prefix, field] of Object.entries(fMap)) {
      if (d.startsWith(prefix)) {
        const id = parseInt(d.slice(prefix.length));
        const ch = await db.getChannelWithRule(id);
        if (!ch) return ctx.answerCallbackQuery({ text: 'Not found' });
        const rule = ch.rule || {};
        if (rule[field]) {
          rule[field] = null;
          const clean = { ...rule }; delete clean.channel_id;
          await db.upsertChannelRule({ channel_id: id, ...clean });
          ctx.answerCallbackQuery({ text: 'Cleared' });
          return showFilterEditor(ctx, id);
        } else {
          ctx.answerCallbackQuery();
          return startRuleInput(ctx, String(id), field, `📊 <b>Enter ${field.replace(/_/g, ' ')}</b>\n\nEnter value:\nExample: <code>50000</code>`);
        }
      }
    }

    // TP/SL toggles
    const tpMatch = d.match(/^t_tp_(\d+)$/);
    if (tpMatch) {
      const id = tpMatch[1];
      const ch = await db.getChannelWithRule(id);
      if (!ch) return ctx.answerCallbackQuery({ text: 'Not found' });
      const rule = ch.rule || {};
      if (rule.take_profit_percent) {
        rule.take_profit_percent = null;
        rule.tp_levels = [];
        const clean = { ...rule }; delete clean.channel_id;
        await db.upsertChannelRule({ channel_id: Number(id), ...clean });
        ctx.answerCallbackQuery({ text: 'TP OFF' });
        return showTPSEditor(ctx, parseInt(id));
      }
      ctx.answerCallbackQuery();
      return startRuleInput(ctx, id, 'take_profit_percent', '🎯 <b>Take Profit</b>\n\nEnter percentage.\nExample: <code>50</code> for 50%');
    }

    const slMatch = d.match(/^t_sl_(\d+)$/);
    if (slMatch) {
      const id = slMatch[1];
      const ch = await db.getChannelWithRule(id);
      if (!ch) return ctx.answerCallbackQuery({ text: 'Not found' });
      const rule = ch.rule || {};
      if (rule.stop_loss_percent) {
        rule.stop_loss_percent = null;
        rule.sl_levels = [];
        const clean = { ...rule }; delete clean.channel_id;
        await db.upsertChannelRule({ channel_id: Number(id), ...clean });
        ctx.answerCallbackQuery({ text: 'SL OFF' });
        return showTPSEditor(ctx, parseInt(id));
      }
      ctx.answerCallbackQuery();
      return startRuleInput(ctx, id, 'stop_loss_percent', '🛑 <b>Stop Loss</b>\n\nEnter percentage.\nExample: <code>20</code> for 20%');
    }

    // ───── Positions ─────
    const posViewMatch = d.match(/^pos_v_(\d+)$/);
    if (posViewMatch) { ctx.answerCallbackQuery(); return showPositionDetail(ctx, parseInt(posViewMatch[1])); }

    const posSellMatch = d.match(/^pos_s_(\d+)_(\d+)$/);
    if (posSellMatch) { ctx.answerCallbackQuery(); return executePositionSell(ctx, parseInt(posSellMatch[1]), parseInt(posSellMatch[2]), false); }

    const posConfirmSellMatch = d.match(/^pos_confirm_sell_(\d+)_(\d+)$/);
    if (posConfirmSellMatch) { ctx.answerCallbackQuery({ text: 'Selling...' }); return executePositionSell(ctx, parseInt(posConfirmSellMatch[1]), parseInt(posConfirmSellMatch[2]), true); }

    const extViewMatch = d.match(/^pose_v_(\d+)$/);
    if (extViewMatch) { ctx.answerCallbackQuery(); return showExternalPositionDetail(ctx, parseInt(extViewMatch[1])); }

    const extSellMatch = d.match(/^pose_s_(\d+)_(\d+)$/);
    if (extSellMatch) { ctx.answerCallbackQuery(); return executeExternalSell(ctx, parseInt(extSellMatch[1]), parseInt(extSellMatch[2]), false); }

    const extConfirmSellMatch = d.match(/^pose_c_(\d+)_(\d+)$/);
    if (extConfirmSellMatch) { ctx.answerCallbackQuery({ text: 'Selling...' }); return executeExternalSell(ctx, parseInt(extConfirmSellMatch[1]), parseInt(extConfirmSellMatch[2]), true); }

    const posTPMatch = d.match(/^pos_tp_(\d+)$/);
    if (posTPMatch) {
      const tid = parseInt(posTPMatch[1]);
      _awaitingPosTPSL.set(String(ctx.from.id), { tradeId: tid, type: 'tp' });
      ctx.answerCallbackQuery();
      return ctx.reply('🎯 <b>Set Take Profit</b>\n\nEnter TP percentage.\nExample: <code>50</code> for 50%', { parse_mode: 'HTML' });
    }

    const posSLMatch = d.match(/^pos_sl_(\d+)$/);
    if (posSLMatch) {
      const tid = parseInt(posSLMatch[1]);
      _awaitingPosTPSL.set(String(ctx.from.id), { tradeId: tid, type: 'sl' });
      ctx.answerCallbackQuery();
      return ctx.reply('🛑 <b>Set Stop Loss</b>\n\nEnter SL percentage.\nExample: <code>20</code> for 20%', { parse_mode: 'HTML' });
    }

    // ───── Confirmations ─────
    if (d.startsWith('confirm_')) {
      ctx.answerCallbackQuery({ text: 'Cancelled' });
      return showMainMenu(ctx, true);
    }

    // ───── Wallets ─────
    if (d === 'wallet_add') { ctx.answerCallbackQuery(); return promptWalletKey(ctx); }

    const walletViewMatch = d.match(/^wallet_v_(\d+)$/);
    if (walletViewMatch) { ctx.answerCallbackQuery(); return showWalletDetail(ctx, parseInt(walletViewMatch[1])); }

    const walletActMatch = d.match(/^wallet_act_(\d+)$/);
    if (walletActMatch) {
      const w = await db.getWallet(parseInt(walletActMatch[1]));
      if (!w) return ctx.answerCallbackQuery({ text: 'Not found' });
      await db.setActiveWallet(w.id);
      ctx.answerCallbackQuery({ text: `⭐ ${w.label || addrShort(w.address)} active` });
      return showWallets(ctx, true);
    }

    const walletDelMatch = d.match(/^wallet_d_(\d+)$/);
    if (walletDelMatch) {
      ctx.answerCallbackQuery({ text: 'Removed' });
      return removeWallet(ctx, parseInt(walletDelMatch[1]));
    }

    // ───── Wallet Groups ─────
    if (d === 'grp_add') { ctx.answerCallbackQuery(); return promptGroupName(ctx); }

    const grpViewMatch = d.match(/^grp_v_(\d+)$/);
    if (grpViewMatch) { ctx.answerCallbackQuery(); return showGroupDetail(ctx, parseInt(grpViewMatch[1])); }

    const grpDelMatch = d.match(/^grp_d_(\d+)$/);
    if (grpDelMatch) {
      ctx.answerCallbackQuery({ text: 'Removed' });
      return removeGroup(ctx, parseInt(grpDelMatch[1]));
    }

    const grpAwMatch = d.match(/^grp_aw_(\d+)$/);
    if (grpAwMatch) { ctx.answerCallbackQuery(); return promptGroupWalletAdd(ctx, parseInt(grpAwMatch[1])); }
  });
}

function auth(ctx) {
  if (!adminId) adminId = String(ctx.from.id);
  if (String(ctx.from.id) !== String(adminId)) { ctx.reply('⛔ Unauthorized', { parse_mode: 'HTML' }); return false; }
  return true;
}

// ───── Start ─────
function sleepMs(ms) { return new Promise(r => setTimeout(r, ms)); }

function isConflictError(err) {
  if (!err) return false;
  if (err.error_code === 409) return true;
  const msg = err.message || err.description || '';
  return msg.includes('409') && (msg.includes('Conflict') || msg.includes('terminated by other getUpdates request'));
}

export async function startBot() {
  if (!TOKEN) return console.warn('[Bot] No TELEGRAM_BOT_TOKEN — bot disabled');
  if (bot) return console.warn('[Bot] Already running — skipping duplicate start');
  bot = new Bot(TOKEN);
  registerCommands();
  attachLiveForwarding();
  bot.catch(err => {
    const desc = err.error?.description || err.message;
    const on = err.ctx?.msg?.text || err.ctx?.callbackQuery?.data || '';
    console.error('[Bot] Error:', desc, '| ctx:', on.slice(0, 100));
  });

  // Long polling only allows ONE instance per token. During a Render deploy the
  // old instance still polls for a few seconds → new instance gets 409 and grammy
  // permanently stops. Retry with backoff so we survive the overlap.
  let attempt = 0;
  for (;;) {
    try {
      await bot.start({ drop_pending_updates: true });
      break;
    } catch (err) {
      if (!isConflictError(err)) throw err;
      attempt++;
      const delay = Math.min(15000, 2000 * 2 ** Math.min(attempt - 1, 3));
      console.error(`[Bot] 409 conflict (another instance polling) — retry #${attempt} in ${(delay / 1000).toFixed(1)}s`);
      await sleepMs(delay);
    }
  }
  console.log('[Bot] ✅ Telegram bot active');
}
