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

function auth(ctx) {
  if (!adminId) { ctx.reply('⏳ Bot not ready', { parse_mode: 'HTML' }); return false; }
  if (String(ctx.from.id) !== String(adminId)) { ctx.reply('⛔ Unauthorized', { parse_mode: 'HTML' }); return false; }
  return true;
}

function mainMenu(extra) {
  const kb = new InlineKeyboard()
    .text('📡 Add Channel', 'add_ch').text('📋 My Channels', 'menu_channels')
    .row()
    .text('📊 Signals', 'menu_signals').text('💰 Balance', 'menu_balance')
    .row()
    .text('📈 Stats', 'menu_stats');
  return { text: '🤖 <b>SniperBot</b>\nPick an option below:', opts: { parse_mode: 'HTML', reply_markup: kb, ...extra } };
}

// ───── Main menu ─────
async function showMainMenu(ctx, edit) {
  const { text, opts } = mainMenu();
  if (edit) {
    try { await ctx.editMessageText(text, opts); } catch { await ctx.reply(text, opts); }
  } else {
    await ctx.reply(text, opts);
  }
}

// ───── Add Channel: Enter Link ─────
async function promptLink(ctx) {
  _awaitingLink.add(String(ctx.from.id));
  const kb = new InlineKeyboard().text('🔙 Back', 'menu_main');
  await ctx.reply('🔗 <b>Send the invite link or channel username</b>\n\nExamples:\n<code>https://t.me/+abc123</code>\n<code>@channel</code>\n<code>channel</code>\n\nOr /cancel to abort.', { parse_mode: 'HTML', reply_markup: kb });
}

async function handleLinkInput(ctx, text) {
  _awaitingLink.delete(String(ctx.from.id));
  const identifier = text.replace(/^https?:\/\/t\.me\//, '').replace(/^@/, '').trim();
  if (!identifier) return ctx.reply('❌ Invalid. Try again with /addchannel or tap Add Channel.', { parse_mode: 'HTML' });
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
      `✅ <b>${esc(identifier)}</b> added${ok ? '\n🔈 Listening for signals' : '\n⚠️ Could not join — check the link'}`,
      { parse_mode: 'HTML', reply_markup: kb });
  } catch (e) {
    ctx.api.editMessageText(msg.chat.id, msg.message_id, `❌ ${esc(e.message)}`, { parse_mode: 'HTML' });
  }
}

// ───── Add Channel: From Joined ─────
async function showJoinedChannels(ctx, page = 0) {
  const msg = await ctx.reply('📡 Fetching joined channels...', { parse_mode: 'HTML' });
  try {
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
    const PAGE = 8;
    const totalPages = Math.ceil(newChs.length / PAGE);
    const p = Math.min(page, totalPages - 1);
    const slice = newChs.slice(p * PAGE, (p + 1) * PAGE);
    const kb = new InlineKeyboard();
    for (const ch of slice) {
      const n = ch.username || '';
      const title = ch.title || n;
      kb.text(`${esc(title)}`, `join_add_${esc(n)}`).row();
    }
    if (totalPages > 1) {
      if (p > 0) kb.text('⬅️', `join_page_${p - 1}`);
      kb.text(`${p + 1}/${totalPages}`, 'ch_nop');
      if (p < totalPages - 1) kb.text('➡️', `join_page_${p + 1}`);
      kb.row();
    }
    kb.text('🔙 Menu', 'menu_main');
    ctx.api.editMessageText(msg.chat.id, msg.message_id,
      `📡 <b>${newChs.length}</b> new channels found\nTap a channel to add it:`, { parse_mode: 'HTML', reply_markup: kb });
  } catch (e) {
    ctx.api.editMessageText(msg.chat.id, msg.message_id, `❌ ${esc(e.message)}`, { parse_mode: 'HTML' });
  }
}

async function addJoinedChannel(ctx, identifier) {
  await ctx.answerCallbackQuery({ text: 'Adding...' });
  try {
    await db.setTelegramId(adminId);
    await db.addChannel(identifier, identifier);
    const chs = await db.getAllChannels();
    const ch = chs.find(c => c.channel_username === identifier);
    const ok = await tg.addChannelListener(identifier, 'admin');
    if (ch) { if (ok) await db.toggleChannel(ch.id, 1); else await db.toggleChannel(ch.id, 0); }
    ctx.reply(`✅ <b>${esc(identifier)}</b> added${ok ? ' 🔈' : ''}`, { parse_mode: 'HTML' });
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
  const kb = new InlineKeyboard();
  for (const ch of slice) {
    const name = ch.display_name || ch.channel_username;
    const icon = ch.active ? '🟢' : '🔴';
    kb.text(`${icon} ${esc(name.length > 20 ? name.slice(0, 20) + '..' : name)}`, `ch_toggle_${ch.id}`)
      .text('⚙️', `ch_setup_${ch.id}`)
      .text('🗑', `ch_remove_${ch.id}`)
      .row();
  }
  if (totalPages > 1) {
    if (p > 0) kb.text('⬅️', `ch_page_${p - 1}`);
    kb.text(`${p + 1}/${totalPages}`, 'ch_nop');
    if (p < totalPages - 1) kb.text('➡️', `ch_page_${p + 1}`);
    kb.row();
  }
  kb.text('🔄 Refresh', 'ch_refresh').text('🔙 Menu', 'menu_main');
  const text = `📋 <b>Channels</b> — ${total} total\nTap 🟢🔴 to toggle, ⚙️ setup, 🗑 remove`;
  if (edit) {
    try { await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb }); } catch { await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb }); }
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  }
}

// ───── Channel Setup ─────
async function showChannelSetup(ctx, id) {
  await db.setTelegramId(adminId);
  const ch = await db.getChannelWithRule(id);
  if (!ch) return ctx.answerCallbackQuery({ text: 'Not found' });
  const r = ch.rule || {};
  const name = ch.display_name || ch.channel_username;
  const lines = [
    `⚙️ <b>${esc(name)}</b>`,
    `Status: ${ch.active ? '🟢 Active' : '🔴 Paused'}`,
    `Track: ${ch.track_mode || 'admin'}`,
    r.auto_buy ? `Buy: ${r.buy_amount_sol || 0.01} SOL` : 'Auto-buy: Off',
    r.blind_buy ? '🌀 Blind buy: On' : '',
    r.min_market_cap ? `Min MC: ${fmtCur(r.min_market_cap)}` : '',
    r.max_market_cap ? `Max MC: ${fmtCur(r.max_market_cap)}` : '',
    r.min_liquidity ? `Min Liq: ${fmtCur(r.min_liquidity)}` : '',
    r.max_liquidity ? `Max Liq: ${fmtCur(r.max_liquidity)}` : '',
    r.take_profit_percent ? `TP: ${r.take_profit_percent}%` : '',
    r.stop_loss_percent ? `SL: ${r.stop_loss_percent}%` : '',
  ].filter(Boolean).join('\n');
  const kb = new InlineKeyboard()
    .text(ch.active ? '🔇 Pause' : '🔊 Activate', `ch_toggle_${ch.id}`)
    .text('🗑 Remove', `ch_remove_${ch.id}`)
    .row()
    .text('🔙 Back', 'menu_channels');
  ctx.editMessageText(lines, { parse_mode: 'HTML', reply_markup: kb });
}

// ───── Signals ─────
async function showSignals(ctx) {
  await db.setTelegramId(adminId);
  const signals = await db.getRecentSignals(10);
  if (!signals.length) {
    const kb = new InlineKeyboard().text('🔙 Menu', 'menu_main');
    return ctx.reply('No signals yet.', { parse_mode: 'HTML', reply_markup: kb });
  }
  const lines = signals.map((s, i) => {
    const sym = s.token_symbol || addrShort(s.token_address);
    return `<b>${i + 1}.</b> <code>${esc(s.token_address)}</code>\n  ${esc(sym)} | 💰 ${fmtCur(s.market_cap)} MC | 💧 ${fmtCur(s.liquidity)} Liq\n  📡 ${esc(s.source_channel || '-')} | ⏱ ${s.latency_ms || '?'}ms`;
  });
  const chunks = [];
  for (let i = 0; i < lines.length; i += 5) chunks.push(lines.slice(i, i + 5).join('\n\n'));
  for (const chunk of chunks) await ctx.reply(chunk, { parse_mode: 'HTML' });
  const kb = new InlineKeyboard().text('🔙 Menu', 'menu_main');
  await ctx.reply('— end —', { parse_mode: 'HTML', reply_markup: kb });
}

// ───── Balance ─────
async function showBalance(ctx) {
  await db.setTelegramId(adminId);
  const wallets = await db.getAllWallets();
  if (!wallets.length) {
    const kb = new InlineKeyboard().text('🔙 Menu', 'menu_main');
    return ctx.reply('No wallets. Add one from the dashboard.', { parse_mode: 'HTML', reply_markup: kb });
  }
  const { getWalletTokenBalance } = await import('./gmgn.js');
  const lines = [];
  for (const w of wallets) {
    const label = w.label || addrShort(w.address);
    let bal = '?';
    try {
      const raw = await getWalletTokenBalance('sol', w.address, 'So11111111111111111111111111111111111111112');
      const data = raw?.data || raw || {};
      const b = data.balance ?? data.amount ?? 0;
      bal = Number(b) > 0 ? (Number(b) / 1e9).toFixed(3) + ' SOL' : '0 SOL';
    } catch {}
    lines.push(`<b>${esc(label)}</b>\n<code>${esc(w.address)}</code>\n💳 ${bal}`);
  }
  lines.push('');
  const kb = new InlineKeyboard().text('🔙 Menu', 'menu_main');
  ctx.reply(lines.join('\n'), { parse_mode: 'HTML', reply_markup: kb });
}

// ───── Stats ─────
async function showStats(ctx) {
  await db.setTelegramId(adminId);
  const [status, logCount] = await Promise.all([
    db.getScraperStatus().catch(() => ({})),
    db.getSignalCountToday().catch(() => 0),
  ]);
  const { getDedupStats } = await import('./router.js');
  const dedup = getDedupStats();
  const kb = new InlineKeyboard().text('🔄 Refresh', 'menu_stats').text('🔙 Menu', 'menu_main');
  ctx.reply(
    `📊 <b>Scraper Stats</b>\n\n📡 CA caught: <b>${dedup.total_caught || 0}</b>\n⏭️ Ignored: <b>${dedup.total_ignored || 0}</b>\n📈 Today: <b>${logCount}</b>\n⏱ Uptime: <b>${status.uptime ? Math.floor(status.uptime / 60) + 'm' : 'N/A'}</b>`,
    { parse_mode: 'HTML', reply_markup: kb });
}

// ───── Two-phase Signal Forwarding ─────
function attachLiveForwarding() {
  liveEvents.on('signal', async data => {
    if (!adminId || (data._tid && data._tid !== adminId)) return;
    const sym = data.token_symbol || addrShort(data.token_address);
    try {
      const msg = await bot.api.sendMessage(adminId,
        `📡 <b>${esc(sym)}</b>\n<code>${esc(data.token_address)}</code>\n📡 ${esc(data.source_channel || '')} | ⏱ ${data.latency_ms || '?'}ms\n💰 <i>Fetching market data...</i>`,
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
    const hasVol = data.volume_24h > 0;
    try {
      await bot.api.editMessageText(pending.chatId, pending.messageId,
        `📡 <b>${esc(sym)}</b>\n<code>${esc(data.token_address)}</code>\n📡 ${esc(data.source_channel || '')} | ⏱ ${data.latency_ms || '?'}ms\n💰 ${fmtCur(data.market_cap)} MC | 💧 ${fmtCur(data.liquidity)} Liq${hasVol ? ` | 📊 ${fmtCur(data.volume_24h)} Vol` : ''}`,
        { parse_mode: 'HTML' });
    } catch {}
    // Keep pending for GMGN override; delete after 30s
    setTimeout(() => _pendingSignals.delete(sid), 30000);
  });

  liveEvents.on('trade', async data => {
    if (!adminId || (data._tid && data._tid !== adminId)) return;
    const sym = data.token_symbol || addrShort(data.token_address);
    const icon = data.status === 'pending' ? '⏳' : data.status === 'success' ? '✅' : '❌';
    try {
      await bot.api.sendMessage(adminId,
        `${icon} <b>${esc(sym)}</b>\n<code>${esc(data.token_address)}</code>\n💰 ${data.amount || '?'} SOL | ⏱ ${data.buy_latency_ms || '?'}ms\n📡 ${esc(data.source_channel || '')}`,
        { parse_mode: 'HTML' });
    } catch {}
  });
}

// ───── Commands ─────
function registerCommands() {
  bot.command('start', async ctx => { if (!auth(ctx)) return; showMainMenu(ctx, false); });
  bot.command('help', async ctx => { if (!auth(ctx)) return; showMainMenu(ctx, false); });
  bot.command('cancel', async ctx => {
    _awaitingLink.delete(String(ctx.from.id));
    ctx.reply('Cancelled.', { parse_mode: 'HTML' });
    showMainMenu(ctx, false);
  });

  bot.command('addchannel', async ctx => {
    if (!auth(ctx)) return;
    const text = ctx.message?.text || '';
    const parts = text.split(/\s+/).slice(1).filter(Boolean);
    if (!parts.length) return promptLink(ctx);
    const identifier = parts[0].replace(/^https?:\/\/t\.me\//, '').replace(/^@/, '').trim();
    if (!identifier) return ctx.reply('❌ Invalid link', { parse_mode: 'HTML' });
    const msg = await ctx.reply(`⏳ Joining <b>${esc(identifier)}</b>...`, { parse_mode: 'HTML' });
    try {
      await db.setTelegramId(adminId);
      await db.addChannel(identifier, identifier);
      const chs = await db.getAllChannels();
      const ch = chs.find(c => c.channel_username === identifier);
      const ok = await tg.addChannelListener(identifier, 'admin');
      if (ch) { if (ok) await db.toggleChannel(ch.id, 1); else await db.toggleChannel(ch.id, 0); }
      const kb = new InlineKeyboard().text('📋 My Channels', 'menu_channels').text('🔙 Menu', 'menu_main');
      ctx.api.editMessageText(msg.chat.id, msg.message_id,
        `✅ <b>${esc(identifier)}</b> added${ok ? '\n🔈 Listening' : '\n⚠️ Could not join'}`,
        { parse_mode: 'HTML', reply_markup: kb });
    } catch (e) { ctx.api.editMessageText(msg.chat.id, msg.message_id, `❌ ${esc(e.message)}`, { parse_mode: 'HTML' }); }
  });

  bot.command('channels', async ctx => { if (!auth(ctx)) return; showChannels(ctx, 0, false); });
  bot.command('signals', async ctx => { if (!auth(ctx)) return; showSignals(ctx); });
  bot.command('balance', async ctx => { if (!auth(ctx)) return; showBalance(ctx); });
  bot.command('stats', async ctx => { if (!auth(ctx)) return; showStats(ctx); });

  // ───── Text fallback (link input) ─────
  bot.on('message:text', async ctx => {
    if (!auth(ctx)) return;
    if (_awaitingLink.has(String(ctx.from.id))) return handleLinkInput(ctx, ctx.message.text);
    // Non-command message: show menu
    showMainMenu(ctx, false);
  });

  // ───── Callback queries ─────
  bot.on('callback_query:data', async ctx => {
    if (!auth(ctx)) return;
    const d = ctx.callbackQuery.data;
    await db.setTelegramId(adminId);

    // Menu navigation
    if (d === 'menu_main') return showMainMenu(ctx, true);
    if (d === 'menu_channels') return showChannels(ctx, 0, true);
    if (d === 'menu_signals') { ctx.answerCallbackQuery(); return showSignals(ctx); }
    if (d === 'menu_balance') { ctx.answerCallbackQuery(); return showBalance(ctx); }
    if (d === 'menu_stats') { ctx.answerCallbackQuery(); return showStats(ctx); }

    // Add channel
    if (d === 'add_ch') {
      const kb = new InlineKeyboard()
        .text('🔗 Enter Link', 'add_link').text('📡 From Joined', 'add_joined')
        .row().text('🔙 Menu', 'menu_main');
      return ctx.editMessageText('📡 <b>Add Channel</b>\n\nChoose how to add:', { parse_mode: 'HTML', reply_markup: kb });
    }
    if (d === 'add_link') { ctx.answerCallbackQuery(); return promptLink(ctx); }
    if (d === 'add_joined') { ctx.answerCallbackQuery(); return showJoinedChannels(ctx); }

    // Joined channel add
    if (d.startsWith('join_add_')) { const id = d.slice(9); ctx.answerCallbackQuery(); return addJoinedChannel(ctx, id); }
    if (d.startsWith('join_page_')) { const p = parseInt(d.slice(10)); ctx.answerCallbackQuery(); return showJoinedChannels(ctx, p); }

    // Channel list
    if (d === 'ch_refresh') return showChannels(ctx, 0, true);
    if (d === 'ch_nop') return ctx.answerCallbackQuery();

    const toggleMatch = d.match(/^ch_toggle_(\d+)$/);
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

    const setupMatch = d.match(/^ch_setup_(\d+)$/);
    if (setupMatch) { ctx.answerCallbackQuery(); return showChannelSetup(ctx, parseInt(setupMatch[1])); }

    const removeMatch = d.match(/^ch_remove_(\d+)$/);
    if (removeMatch) {
      const id = parseInt(removeMatch[1]);
      const ch = await db.getChannel(id);
      if (!ch) return ctx.answerCallbackQuery({ text: 'Not found' });
      await tg.removeChannelListener(ch.channel_username).catch(() => {});
      await db.removeChannel(id);
      ctx.answerCallbackQuery({ text: 'Removed' });
      return showChannels(ctx, 0, true);
    }

    const pageMatch = d.match(/^ch_page_(\d+)$/);
    if (pageMatch) { ctx.answerCallbackQuery(); return showChannels(ctx, parseInt(pageMatch[1]), true); }
  });
}

// ───── Start ─────
export async function startBot() {
  if (!TOKEN) return console.warn('[Bot] No TELEGRAM_BOT_TOKEN — bot disabled');
  bot = new Bot(TOKEN);
  registerCommands();
  attachLiveForwarding();
  bot.catch(err => console.error('[Bot] Error:', err.message));
  bot.start({ drop_pending_updates: true }).catch(err => console.error('[Bot] Start error:', err.message));
  console.log('[Bot] ✅ Telegram bot active');
}
