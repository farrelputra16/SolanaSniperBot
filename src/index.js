import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { config, validateConfig } from './config.js';
import { initDatabase } from './database.js';
import * as db from './database.js';
import { onSignal, onForward, forwardToChat } from './telegram.js';
import { processSignal } from './router.js';
import { createWebServer, startWebServer } from './web-server.js';

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║     Solana Sniper Bot v1.0                ║');
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
  if (!existsSync(join(process.cwd(), 'session'))) mkdirSync(join(process.cwd(), 'session'), { recursive: true });

  await initDatabase();

  onSignal(async (sourceChannel, text, message, senderUsername) => {
    await processSignal(sourceChannel, text, message, senderUsername);
  });

  onForward(async (sourceChannel, message) => {
    if (!message || !message.text) return;
    const forwards = db.qall(`SELECT f.* FROM forwarding f
      JOIN channels c ON c.id = f.channel_id
      WHERE c.channel_username = ? AND f.active = 1`, [sourceChannel]);
    for (const f of forwards) {
      await forwardToChat(f.target_chat_id || f.target_chat_username, message.text);
    }
  });

  // Telegram is optional — start web server even if Telegram fails
  if (config.telegram.apiId && config.telegram.apiHash) {
    try {
      const { initTelegram, startListeners } = await import('./telegram.js');
      await initTelegram();
      await startListeners();
      console.log('   Telegram: ✅ Connected');
    } catch (err) {
      console.warn('   Telegram: ⚠️  ' + err.message);
      console.log('   Run: npm run setup-telegram');
    }
  } else {
    console.warn('   Telegram: ⏸️  Not configured (dashboard-only mode)');
  }

  const app = createWebServer();
  startWebServer(app);

  console.log(`\n✅ Sniper Bot running!`);
  console.log(`   Dashboard: http://${config.server.host}:${config.server.port}`);
  if (!config.telegram.apiId) {
    console.log('\n📋 Quick Start:');
    console.log('   1. Set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env');
    console.log('   2. Run: npm run setup-telegram');
    console.log('   3. Restart: npm start');
  }
  console.log('   Press Ctrl+C to stop\n');
}

process.on('uncaughtException', (err) => console.error('[FATAL]', err));
process.on('unhandledRejection', (err) => console.error('[FATAL]', err));

main();
