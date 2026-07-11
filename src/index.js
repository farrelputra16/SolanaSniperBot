import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { config, validateConfig } from './config.js';
import { initDatabase } from './database.js';
import * as db from './database.js';
import { onSignal } from './telegram.js';
import { processSignal } from './router.js';
import { createWebServer, startWebServer } from './web-server.js';
import { warmupConnection } from './gmgn.js';

async function loadTelegramId() {
  const savedTid = await db.getSetting('telegram_id', '');
  if (savedTid) db.setTelegramId(savedTid);
}

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║     The Scoop Sc(rape)r v1.0                ║');
  console.log('╚══════════════════════════════════════════╝\n');

  const errors = validateConfig();
  const criticalErrors = errors.filter(e => !e.includes('TELEGRAM'));
  if (criticalErrors.length > 0) {
    for (const err of criticalErrors) console.error(`❌ ${err}`);
    process.exit(1);
  }
  if (errors.length > 0) {
    for (const err of errors) console.warn(`⚠️  ${err}`);
  }

  if (!existsSync(join(process.cwd(), 'data'))) mkdirSync(join(process.cwd(), 'data'), { recursive: true });

  await initDatabase();
  await loadTelegramId();
  warmupConnection().then(() => console.log('   GMGN: 🔥 Connection warmed up')).catch(() => {});

  onSignal(async (sourceChannel, text, message, senderUsername) => {
    await processSignal(sourceChannel, text, message, senderUsername);
  });

  const app = createWebServer();
  startWebServer(app);

  // Auto-connect Telegram from saved session or .env
  try {
    const savedSession = await db.getSetting('telegram_session', '');
    if (savedSession && config.telegram.apiId && config.telegram.apiHash) {
      const { initTelegramWithSession, startListeners, getClient } = await import('./telegram.js');
      const savedDc = await db.getSetting('telegram_dc', '0');
      if (savedDc && savedDc !== '0') {
        const { default: telegram } = await import('telegram');
        config.telegram.dcId = parseInt(savedDc);
      }
      await initTelegramWithSession(config.telegram.apiId, config.telegram.apiHash, savedSession);
      const c = getClient();
      const me = c ? await c.getMe() : null;
      if (me) { db.setTelegramId(String(me.id)); await db.setSetting('telegram_id', String(me.id)); }
      console.log('   Telegram: ✅ Connected via saved session');
      await startListeners();
    } else if (config.telegram.apiId && config.telegram.apiHash) {
      const { initTelegram, startListeners, getClient } = await import('./telegram.js');
      await initTelegram();
      const c = getClient();
      const me = c ? await c.getMe() : null;
      if (me) { db.setTelegramId(String(me.id)); await db.setSetting('telegram_id', String(me.id)); }
      console.log('   Telegram: ✅ Connected via .env');
      await startListeners();
    } else {
      console.warn('   Telegram: ⏸️  No session — login from dashboard');
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