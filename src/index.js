import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { config, validateConfig } from './config.js';
import { initDatabase } from './database.js';
import * as db from './database.js';
import { onSignal } from './telegram.js';
import { processSignal, startWalletWarmer, backfillPendingTrades, backfillTradeMetadata } from './router.js';
import { createWebServer, startWebServer } from './web-server.js';
import { warmupConnection } from './gmgn.js';
import { startBot, setAdminId } from './telegram-bot.js';

async function loadTelegramId() {
  const savedTid = await db.getSetting('telegram_id', '');
  if (savedTid) db.setTelegramId(savedTid);
}

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║     The Scoop Sc(rape)r v1.0                ║');
  console.log('╚══════════════════════════════════════════╝\n');

  const errors = validateConfig();
  // All config is optional — users can set credentials via dashboard
  if (errors.length > 0) {
    for (const err of errors) console.warn(`ℹ️  ${err}`);
  }

  let dataDir = process.env.DATA_DIR || '';
  if (dataDir) {
    try {
      if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    } catch { dataDir = ''; }
  }
  if (!dataDir) dataDir = join(process.cwd(), 'data');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  await initDatabase();
  await loadTelegramId();

  warmupConnection().then(() => console.log('   GMGN: 🔥 Connection warmed up')).catch(() => {});
  startWalletWarmer();
  backfillPendingTrades().catch(() => {});
  backfillTradeMetadata().catch(() => {});

  onSignal(async (sourceChannel, text, message, senderUsername) => {
    await processSignal(sourceChannel, text, message, senderUsername);
  });

  const app = createWebServer();
  startWebServer(app);

  // Auto-connect Telegram from saved session or .env
  try {
    let apiId = config.telegram.apiId;
    let apiHash = config.telegram.apiHash;
    if (!apiId || !apiHash) {
      apiId = parseInt(await db.getSetting('telegram_api_id', '0')) || 0;
      apiHash = await db.getSetting('telegram_api_hash', '');
    }
    const savedSession = await db.getSetting('telegram_session', '');
    const savedDc = parseInt(await db.getSetting('telegram_dc', '0')) || 0;
    if (savedDc > 0) config.telegram.dcId = savedDc;

    if (savedSession && apiId && apiHash) {
      const { initTelegramWithSession, startListeners, getClient } = await import('./telegram.js');
      await initTelegramWithSession(apiId, apiHash, savedSession);
      const c = getClient();
      const me = c ? await c.getMe() : null;
      if (me) { db.setTelegramId(String(me.id)); await db.setSetting('telegram_id', String(me.id)); setAdminId(String(me.id)); }
      console.log('   Telegram: ✅ Connected via saved session');
      await startListeners();
      startBot().catch(e => console.warn('[Bot]', e.message));
    } else if (apiId && apiHash) {
      const { initTelegram, startListeners, getClient } = await import('./telegram.js');
      await initTelegram();
      const c = getClient();
      const me = c ? await c.getMe() : null;
      if (me) { db.setTelegramId(String(me.id)); await db.setSetting('telegram_id', String(me.id)); setAdminId(String(me.id)); }
      console.log('   Telegram: ✅ Connected via .env');
      await startListeners();
      startBot().catch(e => console.warn('[Bot]', e.message));
    } else {
      console.warn('   Telegram: ⏸️  No session — login from dashboard');
      startBot().catch(() => {});
    }
  } catch (err) {
    const msg = err?.message || '';
    if (msg && msg !== 'dashboard-only mode') {
      console.warn('   Telegram: ⏸️  ' + msg);
    }
    // Only clear corrupted session on explicit session errors
    if (msg.includes('Session') || msg.includes('AUTH_KEY') || msg.includes('connection') || msg.includes('expired')) {
      try { await db.setSetting('telegram_session', ''); } catch {}
    }
  }

  console.log(`\n✅ The Scoop Sc(rape)r running!`);
  console.log(`   Dashboard: http://${config.server.host}:${config.server.port}`);
  console.log('   Press Ctrl+C to stop\n');
}

process.on('uncaughtException', (err) => console.error('[FATAL]', err));
process.on('unhandledRejection', (err) => console.error('[FATAL]', err));

main();