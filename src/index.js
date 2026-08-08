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

  onSignal(async (sourceChannel, text, message, senderUsername, ownerId) => {
    await processSignal(sourceChannel, text, message, senderUsername, ownerId);
  });

  const app = createWebServer();
  startWebServer(app);

  // Auto-connect Telegram: EVERY saved per-user session, then fall back to .env.
  // Multiple accounts can now scrape simultaneously without clobbering each other.
  try {
    const { initTelegramWithSession, startListeners, getClient } = await import('./telegram.js');
    const sessions = await db.getAllTelegramSessions(true).catch(() => []);
    let connectedAny = false;
    let operatorId = null;

    for (const us of sessions || []) {
      const tid = String(us.telegram_id || '');
      const apiId = parseInt(us.api_id) || 0;
      const apiHash = us.api_hash || '';
      const sessionStr = us.session || '';
      if (!tid || !apiId || !apiHash || !sessionStr) continue;
      try {
        await initTelegramWithSession(apiId, apiHash, sessionStr, { dcId: parseInt(us.dc) || 0 });
        await startListeners(tid);
        connectedAny = true;
        // Operator (bot admin) = the configured operator telegram_id, NOT a shared API ID.
        // Many accounts can share one TELEGRAM_API_ID; only the operator account gets admin.
        const opTid = (config.server.operatorTelegramId || '').toString();
        if (opTid && String(us.telegram_id) === opTid) operatorId = tid;
        else if (!operatorId) operatorId = tid; // fallback: first connected account becomes bot admin
        console.log(`   Telegram: ✅ Connected ${tid}`);
      } catch (err) {
        console.warn(`   Telegram: ⏸️  (${tid}) ${err.message || ''}`);
        if (/AUTH_KEY|expired|revoked|invalid|401/i.test(err.message || '')) {
          try { await db.deleteTelegramSession(tid); } catch {}
        }
      }
    }

    // Legacy .env fallback — single account, no per-user session saved yet.
    if (!connectedAny && config.telegram.apiId && config.telegram.apiHash && config.telegram.session) {
      try {
        const { initTelegram } = await import('./telegram.js');
        await initTelegram();
        const c = getClient();
        const me = c ? await c.getMe() : null;
        const tid = String(me?.id || '');
        if (tid) {
          db.setTelegramId(tid);
          await db.setSetting('telegram_id', tid);
          if (!operatorId) operatorId = tid;
          await startListeners(tid);
        }
        connectedAny = true;
        console.log('   Telegram: ✅ Connected via .env');
      } catch (err) {
        console.warn('   Telegram: ⏸️  ' + (err.message || ''));
        if (/AUTH_KEY|expired|revoked|invalid|401/i.test(err.message || '')) {
          try { await db.setSetting('telegram_session', ''); } catch {}
        }
      }
    }

    if (operatorId) setAdminId(operatorId);
    startBot().catch(e => console.warn('[Bot]', e.message));
  } catch (err) {
    const msg = err?.message || '';
    if (msg) console.warn('   Telegram: ⏸️  ' + msg);
    startBot().catch(e => console.warn('[Bot]', e.message));
  }

  console.log(`\n✅ The Scoop Sc(rape)r running!`);
  console.log(`   Dashboard: http://${config.server.host}:${config.server.port}`);
  console.log('   Press Ctrl+C to stop\n');
}

process.on('uncaughtException', (err) => {
  if (isBenignBotError(err)) return;
  console.error('[FATAL]', err);
});
process.on('unhandledRejection', (err) => {
  if (isBenignBotError(err)) return;
  console.error('[FATAL]', err);
});

// Benign Telegram bot errors (e.g. answering a callback query that already
// expired) must not spam [FATAL]. Real errors still log.
function isBenignBotError(err) {
  if (!err) return false;
  const msg = err.message || String(err) || '';
  if (err.name === 'GrammyError' && /query is too old|query id is invalid/i.test(msg)) return true;
  return false;
}

main();