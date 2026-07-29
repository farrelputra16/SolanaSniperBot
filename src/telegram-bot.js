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

function auth(ctx) {
  if (!adminId) return ctx.reply('⏳ Bot not ready — no admin configured', { parse_mode: 'HTML' }), false;
  if (String(ctx.from.id) !== String(adminId)) return ctx.reply('⛔ Unauthorized', { parse_mode: 'HTML' }), false;
  return true;
}

function esc(s) { return s ? String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]) : ''; }

function fmtCur(v) { if (!v) return '$0'; if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M'; if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K'; return '$' + Number(v).toLocaleString(); }

function addrShort(a) { return a ? a.slice(0, 4) + '..' + a.slice(-4) : '?'; }

function ago(ts) { if (!ts) return 'never'; const s = Math.floor((Date.now() / 1000 - ts)); if (s < 60) return s + 's'; if (s < 3600) return Math.floor(s / 60) + 'm'; return Math.floor(s / 3600) + 'h'; }

function sb(v) { if (v === 'success' || v === 'completed') return '✅ Done'; if (v === 'pending') return '⏳ Pending'; if (v === 'failed') return '❌ Failed'; return v || '?'; }

const PAGE_SIZE = 5;

async function channelsKeyboard(page = 0) {
  const all = await db.getAllChannels();
  const total = all.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const p = Math.min(page, totalPages - 1);
  const slice = all.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);
  const kb = new InlineKeyboard();
  for (const ch of slice) {
    const name = ch.display_name || ch.channel_username;
    const status = ch.active ? '🟢' : '🔴';
    kb.text(`${status} ${esc(name)}`, `ch_toggle_${ch.id}`).text('🗑', `ch_remove_${ch.id}`).row();
  }
  if (totalPages > 1) {
    const nav = [];
    if (p > 0) nav.push(kb.text('⬅️', `ch_page_${p - 1}`));
    nav.push(kb.text(`${p + 1}/${totalPages}`, 'ch_nop'));
    if (p < totalPages - 1) nav.push(kb.text('➡️', `ch_page_${p + 1}`));
    kb.row();
  }
  kb.text('🔄 Refresh', 'ch_refresh');
  return { kb, total, page: p };
}

// ───── Commands ─────
function registerCommands() {
  bot.command('start', async ctx => {
    if (!auth(ctx)) return;
    ctx.reply(`🤖 <b>SniperBot</b>

Manage your sniper from here.

<b>Commands:</b>
/addchannel &lt;link&gt; — add &amp; join a channel
/channels — list &amp; manage channels
/signals — recent signals
/stats — scraper statistics
/balance — wallet balances
/help — this message

<b>Signals &amp; trades</b> are forwarded here automatically.`, { parse_mode: 'HTML' });
  });

  bot.command('help', async ctx => {
    if (!auth(ctx)) return;
    ctx.reply(`<b>Commands</b>

/addchannel &lt;link|username&gt;
  Add a Telegram channel to scrape. Supports invite links (t.me/+...) and public usernames (\@channel).

/channels
  List all channels. Tap 🟢/🔴 to toggle, 🗑 to remove.

/signals
  Last 10 token signals with MC, Liq, and latency.

/stats
  Scraper performance: signals caught, ignored, uptime.

/balance
  Wallet balances for all imported wallets.

/start
  Show this bot's main menu.`, { parse_mode: 'HTML' });
  });

  bot.command('addchannel', async ctx => {
    if (!auth(ctx)) return;
    const text = ctx.message?.text || '';
    const parts = text.split(/\s+/).slice(1).filter(Boolean);
    if (!parts.length) return ctx.reply('Usage: /addchannel &lt;link or @username&gt;\n\nExample:\n/addchannel https://t.me/+abc123\n/addchannel @mychannel', { parse_mode: 'HTML' });
    const identifier = parts[0].replace(/^https?:\/\/t\.me\//, '').replace(/^@/, '').trim();
    if (!identifier) return ctx.reply('Invalid identifier');
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
      ctx.api.editMessageText(msg.chat.id, msg.message_id,
        `✅ <b>${esc(identifier)}</b> added${ok ? ' 🔈 listening' : ' ⏸️ not found'}`, { parse_mode: 'HTML' });
    } catch (e) {
      ctx.api.editMessageText(msg.chat.id, msg.message_id, `❌ Error: ${esc(e.message)}`, { parse_mode: 'HTML' });
    }
  });

  bot.command('channels', async ctx => {
    if (!auth(ctx)) return;
    const { kb, total, page } = await channelsKeyboard(0);
    ctx.reply(`📡 <b>Channels</b> — ${total} total`, { parse_mode: 'HTML', reply_markup: kb });
  });

  bot.command('signals', async ctx => {
    if (!auth(ctx)) return;
    await db.setTelegramId(adminId);
    const signals = await db.getRecentSignals(10);
    if (!signals.length) return ctx.reply('No signals yet');
    const lines = signals.map((s, i) => {
      const sym = s.token_symbol || addrShort(s.token_address);
      return `<b>${i + 1}. ${esc(sym)}</b>\n  💰 ${fmtCur(s.market_cap)} MC | 💧 ${fmtCur(s.liquidity)} Liq\n  📡 ${esc(s.source_channel || '-')} | ⏱ ${s.latency_ms || '?'}ms\n  <code>${esc(s.token_address)}</code>`;
    });
    const chunks = [];
    for (let i = 0; i < lines.length; i += 5) chunks.push(lines.slice(i, i + 5).join('\n\n'));
    for (const chunk of chunks) await ctx.reply(chunk, { parse_mode: 'HTML' });
  });

  bot.command('stats', async ctx => {
    if (!auth(ctx)) return;
    await db.setTelegramId(adminId);
    const [status, logCount] = await Promise.all([
      db.getScraperStatus().catch(() => ({})),
      db.getSignalCountToday().catch(() => 0),
    ]);
    const dedup = (await import('./router.js')).getDedupStats();
    const msg = `📊 <b>Scraper Stats</b>\n\n`
      + `📡 Total CA caught: <b>${dedup.total_caught || 0}</b>\n`
      + `⏭️ Dedup ignored: <b>${dedup.total_ignored || 0}</b>\n`
      + `📈 Today: <b>${logCount}</b>\n`
      + `⏱ Uptime: <b>${status.uptime ? Math.floor(status.uptime / 60) + 'm' : 'N/A'}</b>`;
    ctx.reply(msg, { parse_mode: 'HTML' });
  });

  bot.command('balance', async ctx => {
    if (!auth(ctx)) return;
    await db.setTelegramId(adminId);
    const wallets = await db.getAllWallets();
    if (!wallets.length) return ctx.reply('No wallets. Add one from the dashboard.');
    const { getWalletTokenBalance } = await import('./gmgn.js');
    const lines = [];
    for (const w of wallets) {
      const label = w.label || addrShort(w.address);
      let bal = '?';
      try {
        const data = await getWalletTokenBalance('sol', w.address, 'So11111111111111111111111111111111111111112');
        bal = data?.balance ? (Number(data.balance) / 1e9).toFixed(3) + ' SOL' : '0 SOL';
      } catch {}
      lines.push(`<b>${esc(label)}</b>\n<code>${esc(w.address)}</code>\n💳 ${bal}`);
    }
    ctx.reply(lines.join('\n\n'), { parse_mode: 'HTML' });
  });

  // ───── Callback queries ─────
  bot.on('callback_query:data', async ctx => {
    if (!auth(ctx)) return;
    const data = ctx.callbackQuery.data;
    await db.setTelegramId(adminId);

    if (data === 'ch_refresh') {
      const { kb, total } = await channelsKeyboard(0);
      return ctx.editMessageText(`📡 <b>Channels</b> — ${total} total`, { parse_mode: 'HTML', reply_markup: kb });
    }
    if (data === 'ch_nop') return ctx.answerCallbackQuery();

    const toggleMatch = data.match(/^ch_toggle_(\d+)$/);
    if (toggleMatch) {
      const id = parseInt(toggleMatch[1]);
      const ch = await db.getChannel(id);
      if (!ch) return ctx.answerCallbackQuery({ text: 'Not found' });
      const newActive = ch.active ? 0 : 1;
      await db.toggleChannel(id, newActive);
      if (newActive) await tg.addChannelListener(ch.channel_username, ch.track_mode).catch(() => {});
      else await tg.removeChannelListener(ch.channel_username).catch(() => {});
      const { kb, total } = await channelsKeyboard(0);
      ctx.editMessageText(`📡 <b>Channels</b> — ${total} total`, { parse_mode: 'HTML', reply_markup: kb });
      return ctx.answerCallbackQuery({ text: newActive ? '🔈 Listening' : '🔇 Paused' });
    }

    const removeMatch = data.match(/^ch_remove_(\d+)$/);
    if (removeMatch) {
      const id = parseInt(removeMatch[1]);
      const ch = await db.getChannel(id);
      if (!ch) return ctx.answerCallbackQuery({ text: 'Not found' });
      await tg.removeChannelListener(ch.channel_username).catch(() => {});
      await db.removeChannel(id);
      const { kb, total } = await channelsKeyboard(0);
      ctx.editMessageText(`📡 <b>Channels</b> — ${total} total`, { parse_mode: 'HTML', reply_markup: kb });
      return ctx.answerCallbackQuery({ text: 'Removed' });
    }

    const pageMatch = data.match(/^ch_page_(\d+)$/);
    if (pageMatch) {
      const page = parseInt(pageMatch[1]);
      const { kb, total } = await channelsKeyboard(page);
      ctx.editMessageText(`📡 <b>Channels</b> — ${total} total`, { parse_mode: 'HTML', reply_markup: kb });
      return ctx.answerCallbackQuery();
    }
  });
}

// ───── Live event forwarding ─────
function attachLiveForwarding() {
  liveEvents.on('signal', data => {
    if (!adminId || data._tid && data._tid !== adminId) return;
    const sym = data.token_symbol || addrShort(data.token_address);
    const text = `📡 <b>${esc(sym)}</b>\n<code>${esc(data.token_address)}</code>\n📡 ${esc(data.source_channel || '')} | ⏱ ${data.latency_ms || '?'}ms\n💰 ${fmtCur(data.market_cap)} MC`;
    bot.api.sendMessage(adminId, text, { parse_mode: 'HTML' }).catch(() => {});
  });

  liveEvents.on('trade', data => {
    if (!adminId || data._tid && data._tid !== adminId) return;
    const sym = data.token_symbol || addrShort(data.token_address);
    const status = data.status === 'pending' ? '⏳' : data.status === 'success' ? '✅' : '❌';
    const text = `${status} <b>${esc(sym)}</b>\n<code>${esc(data.token_address)}</code>\n💰 ${data.amount || '?'} SOL | ⏱ ${data.buy_latency_ms || '?'}ms\n📡 ${esc(data.source_channel || '')}`;
    bot.api.sendMessage(adminId, text, { parse_mode: 'HTML' }).catch(() => {});
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

export function isBotActive() { return !!bot; }
