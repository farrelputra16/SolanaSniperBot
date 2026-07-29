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
const _pendingSignals = new Map();

// ───── Helpers ─────
function esc(s) { return s ? String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]) : ''; }

function fmtCur(v) { if (!v) return '$0'; if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M'; if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K'; return '$' + Number(v).toLocaleString(); }

function addrShort(a) { return a ? a.slice(0, 4) + '..' + a.slice(-4) : '?'; }

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
    .text('📊 Signals', 'menu_signals').text('📈 Stats', 'menu_stats')
    .row()
    .text('❓ Help', 'menu_help');
  if (isTgConnected()) kb.row().text('🔌 Disconnect', 'menu_disconnect');

  const conn = isTgConnected() ? '🟢 Connected' : '🔴 Disconnected';
  const [channels, wallets, signals] = await Promise.all([
    db.getAllChannels().catch(() => []),
    db.getAllWallets().catch(() => []),
    db.getRecentSignals(1).catch(() => []),
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
${signals.length ? '📊 ' + signals.length + ' signal' : ''}
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
/signals — Recent signals
/stats — Bot statistics
/disconnect — Disconnect Telegram
/cancel — Cancel current action
━━━━━━━━━━━━━━━━
💡 Tap 📡 Channels to add signal sources
💡 Add wallets under 💰 Wallets before trading
💡 Configure auto-buy per channel in ⚙️ settings`;

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
async function showChannelSetup(ctx, id) {
  await db.setTelegramId(adminId);
  const ch = await db.getChannelWithRule(id);
  if (!ch) return ctx.answerCallbackQuery({ text: 'Not found' });
  const r = ch.rule || {};
  const name = btnText(ch.display_name || ch.channel_username);

  const lines = [
    `⚙️ <b>${esc(name)}</b>`,
    `Status: ${ch.active ? '🟢 Active' : '🔴 Paused'} · Track: ${ch.track_mode || 'admin'}`,
    `━━━━━━━━━━━━━━━━`,
    `💵 <b>Auto-buy:</b> ${r.auto_buy ? '🟢 ON' : '🔴 OFF'}  |  ${r.buy_amount_sol || 0.01} SOL`,
    `🌀 <b>Blind:</b> ${r.blind_buy ? '🟢 ON' : '🔴 OFF'}  |  💼 ${r.wallet_group_id ? (r.wallet_group_id > 0 ? 'Group ' + r.wallet_group_id : 'Wallet ' + Math.abs(r.wallet_group_id)) : 'Active wallet'}`,
    `━━━━━━━━━━━━━━━━`,
    `<b>📊 Filters</b>`,
    `  Min MC: ${r.min_market_cap ? fmtCur(r.min_market_cap) : '—'}`,
    `  Max MC: ${r.max_market_cap ? fmtCur(r.max_market_cap) : '—'}`,
    `  Min Liq: ${r.min_liquidity ? fmtCur(r.min_liquidity) : '—'}`,
    `  Max Liq: ${r.max_liquidity ? fmtCur(r.max_liquidity) : '—'}`,
    `━━━━━━━━━━━━━━━━`,
    `🎯 TP: ${r.take_profit_percent ? r.take_profit_percent + '%' : '—'}  |  🛑 SL: ${r.stop_loss_percent ? r.stop_loss_percent + '%' : '—'}`,
  ].join('\n');

  const kb = new InlineKeyboard()
    .text(r.auto_buy ? '💵 Buy ON' : '💵 Buy OFF', `r_buy_${ch.id}`)
    .text('💰 Amount', `r_amt_${ch.id}`)
    .row()
    .text(r.blind_buy ? '🌀 Blind ON' : '🌀 Blind OFF', `r_blind_${ch.id}`)
    .text('💼 Group', `r_grp_${ch.id}`)
    .row()
    .text('📊 Filters', `r_filt_${ch.id}`)
    .text('🎯 TP/SL', `r_tpsl_${ch.id}`)
    .row()
    .text(ch.active ? '🔇 Pause' : '🔊 Activate', `ch_t_${ch.id}`)
    .text('🗑 Remove', `ch_rem_${ch.id}`)
    .row()
    .text('🔙 Back', 'menu_channels');

  ctx.editMessageText(lines, { parse_mode: 'HTML', reply_markup: kb }).catch(() => ctx.reply(lines, { parse_mode: 'HTML', reply_markup: kb }));
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

  const lines = [
    `🎯 <b>TP/SL — ${esc(name)}</b>`,
    `━━━━━━━━━━━━━━━━`,
    `Take Profit: ${r.take_profit_percent ? r.take_profit_percent + '%' : '—'}`,
    `Stop Loss: ${r.stop_loss_percent ? r.stop_loss_percent + '%' : '—'}`,
    `━━━━━━━━━━━━━━━━`,
    `Tap to toggle, or set a percentage value.`,
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
    } else if (field === 'wallet_group_id') {
      rule[field] = parseInt(val) || 0;
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
    const kb = new InlineKeyboard().text('➕ Add Wallet', 'wallet_add').row().text('🔙 Menu', 'menu_main');
    const text = `💰 <b>Wallets</b>
━━━━━━━━━━━━━━━━
No wallets yet.

Add your first wallet to start trading.`;
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
    lines.push(`<b>${esc(label)}</b>\n<code>${esc(w.address)}</code>\n💳 ${sol != null ? sol.toFixed(4) + ' SOL' : '?'}`);
  }

  const kb = new InlineKeyboard();
  for (const w of wallets) {
    const label = btnText(w.label || addrShort(w.address));
    kb.text(`${label}`, `wallet_v_${w.id}`).text('🗑', `wallet_d_${w.id}`).row();
  }
  kb.text('➕ Add Wallet', 'wallet_add').row().text('🔙 Menu', 'menu_main');

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

// ───── Signals ─────
async function showSignals(ctx) {
  await db.setTelegramId(adminId);
  const signals = await db.getRecentSignals(10);
  if (!signals.length) {
    const kb = new InlineKeyboard().text('🔙 Menu', 'menu_main');
    return ctx.reply('📊 <b>Signals</b>\n\nNo signals yet.\nSignals appear here when a CA is detected from your channels.', { parse_mode: 'HTML', reply_markup: kb });
  }
  const lines = signals.map((s, i) => {
    const sym = s.token_symbol || addrShort(s.token_address);
    const latency = s.latency_ms != null ? (s.latency_ms < 1000 ? `${s.latency_ms}ms` : `${(s.latency_ms / 1000).toFixed(1)}s`) : '?';
    return `<b>#${i + 1}</b> <code>${esc(s.token_address)}</code>\n${esc(sym)} | 💰 ${fmtCur(s.market_cap)} MC | 💧 ${fmtCur(s.liquidity)} Liq\n📡 ${esc(s.source_channel || '-')} · ⏱ ${latency}`;
  });
  const chunks = [];
  for (let i = 0; i < lines.length; i += 4) chunks.push(lines.slice(i, i + 4).join('\n\n'));
  for (const chunk of chunks) await ctx.reply(chunk, { parse_mode: 'HTML' });
  const kb = new InlineKeyboard().text('🔙 Menu', 'menu_main');
  await ctx.reply('━━━━━━━━━━━━━━━━\n🔙 Tap Menu to go back', { parse_mode: 'HTML', reply_markup: kb });
}

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

// ───── Two-phase Signal Forwarding ─────
function attachLiveForwarding() {
  liveEvents.on('signal', async data => {
    if (!adminId || (data._tid && data._tid !== adminId)) return;
    const sym = data.token_symbol || addrShort(data.token_address);
    const latency = data.latency_ms != null ? (data.latency_ms < 1000 ? `${data.latency_ms}ms` : `${(data.latency_ms / 1000).toFixed(1)}s`) : '?';
    try {
      const msg = await bot.api.sendMessage(adminId,
        `📡 <b>${esc(sym)}</b>\n<code>${esc(data.token_address)}</code>\n📡 ${esc(data.source_channel || '')} · ⏱ ${latency}\n💰 <i>Fetching data...</i>`,
        { parse_mode: 'HTML' });
      if (data.id != null) _pendingSignals.set(String(data.id), { chatId: msg.chat.id, messageId: msg.message_id });
    } catch {}
  });

  liveEvents.on('signal_update', async data => {
    if (!adminId || (data._tid && data._tid !== adminId)) return;
    const sid = String(data.id);
    const pending = _pendingSignals.get(sid);
    if (!pending) return;
    const sym = data.token_symbol || addrShort(data.token_address);
    const latency = data.latency_ms != null ? (data.latency_ms < 1000 ? `${data.latency_ms}ms` : `${(data.latency_ms / 1000).toFixed(1)}s`) : '?';
    const hasVol = data.volume_24h > 0;
    const lvl = data.volume_24h > 500000 ? '🔥' : data.volume_24h > 100000 ? '⚡' : '';
    try {
      await bot.api.editMessageText(pending.chatId, pending.messageId,
        `📡 <b>${esc(sym)}</b>\n<code>${esc(data.token_address)}</code>\n📡 ${esc(data.source_channel || '')} · ⏱ ${latency}\n💰 ${fmtCur(data.market_cap)} MC · 💧 ${fmtCur(data.liquidity)} Liq${hasVol ? ` · 📊 ${fmtCur(data.volume_24h)} Vol ${lvl}` : ''}`,
        { parse_mode: 'HTML' });
    } catch {}
    setTimeout(() => _pendingSignals.delete(sid), 30000);
  });

  liveEvents.on('trade', async data => {
    if (!adminId || (data._tid && data._tid !== adminId)) return;
    const sym = data.token_symbol || addrShort(data.token_address);
    const icon = data.status === 'pending' ? '⏳' : data.status === 'success' ? '✅' : '❌';
    const latency = data.buy_latency_ms != null ? (data.buy_latency_ms < 1000 ? `${data.buy_latency_ms}ms` : `${(data.buy_latency_ms / 1000).toFixed(1)}s`) : '?';
    try {
      await bot.api.sendMessage(adminId,
        `${icon} <b>${esc(sym)}</b>\n<code>${esc(data.token_address)}</code>\n💰 ${data.amount || '?'} SOL · ⏱ ${latency}\n📡 ${esc(data.source_channel || '')}`,
        { parse_mode: 'HTML' });
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
    const kb = new InlineKeyboard().text('🔙 Menu', 'menu_main');
    ctx.reply('Cancelled.', { parse_mode: 'HTML', reply_markup: kb });
    showMainMenu(ctx, false);
  });

  bot.command('channels', async ctx => { if (!auth(ctx)) return; showChannels(ctx, 0, false); });
  bot.command('signals', async ctx => { if (!auth(ctx)) return; showSignals(ctx); });
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
    if (d === 'menu_signals') { ctx.answerCallbackQuery(); return showSignals(ctx); }
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

    const rFiltMatch = d.match(/^r_filt_(\d+)$/);
    if (rFiltMatch) { ctx.answerCallbackQuery(); return showFilterEditor(ctx, parseInt(rFiltMatch[1])); }

    const rTpslMatch = d.match(/^r_tpsl_(\d+)$/);
    if (rTpslMatch) { ctx.answerCallbackQuery(); return showTPSEditor(ctx, parseInt(rTpslMatch[1])); }

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
        const clean = { ...rule }; delete clean.channel_id;
        await db.upsertChannelRule({ channel_id: Number(id), ...clean });
        ctx.answerCallbackQuery({ text: 'SL OFF' });
        return showTPSEditor(ctx, parseInt(id));
      }
      ctx.answerCallbackQuery();
      return startRuleInput(ctx, id, 'stop_loss_percent', '🛑 <b>Stop Loss</b>\n\nEnter percentage.\nExample: <code>20</code> for 20%');
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

    const walletDelMatch = d.match(/^wallet_d_(\d+)$/);
    if (walletDelMatch) {
      ctx.answerCallbackQuery({ text: 'Removed' });
      return removeWallet(ctx, parseInt(walletDelMatch[1]));
    }
  });
}

function auth(ctx) {
  if (!adminId) adminId = String(ctx.from.id);
  if (String(ctx.from.id) !== String(adminId)) { ctx.reply('⛔ Unauthorized', { parse_mode: 'HTML' }); return false; }
  return true;
}

// ───── Start ─────
export async function startBot() {
  if (!TOKEN) return console.warn('[Bot] No TELEGRAM_BOT_TOKEN — bot disabled');
  bot = new Bot(TOKEN);
  registerCommands();
  attachLiveForwarding();
  bot.catch(err => {
    const desc = err.error?.description || err.message;
    const on = err.ctx?.msg?.text || err.ctx?.callbackQuery?.data || '';
    console.error('[Bot] Error:', desc, '| ctx:', on.slice(0, 100));
  });
  bot.start({ drop_pending_updates: true }).catch(err => console.error('[Bot] Start error:', err.message));
  console.log('[Bot] ✅ Telegram bot active');
}
