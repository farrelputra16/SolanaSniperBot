import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { config, validateConfig } from './config.js';
import { initDatabase, getDatabase } from './database.js';
import { initTelegram, startListeners, onSignal, onForward, forwardToChat } from './telegram.js';
import { processSignal } from './router.js';
import { createWebServer, startWebServer } from './web-server.js';

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║     Solana Sniper Bot v1.0                ║');
  console.log('╚══════════════════════════════════════════╝\n');

  const errors = validateConfig();
  if (errors.length > 0) {
    for (const err of errors) {
      console.error(`❌ ${err}`);
    }
    console.log('\n📋 Setup:');
    console.log('  1. Copy .env.example ke .env dan isi konfigurasi');
    console.log('  2. Jalankan: npm run setup-telegram');
    console.log('  3. Jalankan: npm start\n');
    process.exit(1);
  }

  if (!existsSync(join(process.cwd(), 'data'))) mkdirSync(join(process.cwd(), 'data'), { recursive: true });
  if (!existsSync(join(process.cwd(), 'session'))) mkdirSync(join(process.cwd(), 'session'), { recursive: true });

  initDatabase();

  onSignal(async (sourceChannel, text) => {
    await processSignal(sourceChannel, text);
  });

  onForward(async (sourceChannel, message) => {
    if (!message || !message.text) return;
    const forwards = getDatabase().prepare(`SELECT f.* FROM forwarding f
      JOIN channels c ON c.id = f.channel_id
      WHERE c.channel_username = ? AND f.active = 1`).all(sourceChannel);

    for (const f of forwards) {
      await forwardToChat(f.target_chat_id || f.target_chat_username, message.text);
    }
  });

  try {
    await initTelegram();
    await startListeners();
  } catch (err) {
    console.error('❌ Telegram:', err.message);
    console.log('\nJalankan: npm run setup-telegram\n');
    process.exit(1);
  }

  const app = createWebServer();
  startWebServer(app);

  console.log(`\n✅ Sniper Bot running!`);
  console.log(`   Dashboard: http://${config.server.host}:${config.server.port}`);
  console.log('   Press Ctrl+C to stop\n');
}

process.on('uncaughtException', (err) => console.error('[FATAL]', err));
process.on('unhandledRejection', (err) => console.error('[FATAL]', err));

main();
