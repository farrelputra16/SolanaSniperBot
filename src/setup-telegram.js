import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, homedir } from 'path';
import { createInterface } from 'readline';

const rl = createInterface({ input: process.stdin, output: process.stdout });
const q = (query) => new Promise((r) => rl.question(query, r));

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║    Telegram Session Setup                 ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log();
  console.log('Dapatkan API ID dan API Hash dari: https://my.telegram.org/apps');
  console.log();

  const apiId = parseInt(await q('TELEGRAM_API_ID: '));
  const apiHash = await q('TELEGRAM_API_HASH: ');
  const phone = await q('Nomor telepon (format internasional, +62xxx): ');

  console.log('\nMenyambungkan ke Telegram...\n');

  const { loginNewSession } = await import('./telegram.js');
  const { config } = await import('./config.js');

  let sessionStr;
  try {
    sessionStr = await loginNewSession(apiId, apiHash, phone, async () => {
      return await q('Masukkan kode OTP dari Telegram: ');
    });
  } catch (err) {
    console.error('\nGagal login:', err.message);
    process.exit(1);
  }

  const envPath = join(process.cwd(), '.env');
  let envContent = '';
  if (existsSync(envPath)) {
    envContent = readFileSync(envPath, 'utf-8');
  }

  if (!envContent.includes('TELEGRAM_API_ID')) {
    envContent += `\nTELEGRAM_API_ID=${apiId}\n`;
  }
  if (!envContent.includes('TELEGRAM_API_HASH')) {
    envContent += `TELEGRAM_API_HASH=${apiHash}\n`;
  }
  if (!envContent.includes('TELEGRAM_SESSION')) {
    envContent += `TELEGRAM_SESSION=${sessionStr}\n`;
  }

  writeFileSync(envPath, envContent);
  console.log('\n✅ Konfigurasi tersimpan di .env');
  console.log('Jalankan: npm start');
  rl.close();
}

main();
