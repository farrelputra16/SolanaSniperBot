import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';

const rl = createInterface({ input: process.stdin, output: process.stdout });
const q = (query) => new Promise((r) => rl.question(query, r));

function loadEnvFile(filepath) {
  if (!existsSync(filepath)) return {};
  const content = readFileSync(filepath, 'utf-8');
  const env = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

async function main() {
  const env = loadEnvFile(join(process.cwd(), '.env'));

  console.log('╔══════════════════════════════════════════╗');
  console.log('║    Telegram Session Setup                 ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log();

  const apiId = parseInt(env.TELEGRAM_API_ID || await q('TELEGRAM_API_ID: '));
  const apiHash = env.TELEGRAM_API_HASH || await q('TELEGRAM_API_HASH: ');
  const phone = await q('Phone number (international format, e.g. +1234567890): ');

  console.log('\nConnecting to Telegram...\n');

  const { loginNewSession } = await import('./telegram.js');
  const { config } = await import('./config.js');

  let sessionStr;
  try {
    sessionStr = await loginNewSession(apiId, apiHash, phone, async () => {
      return await q('Enter OTP code from Telegram: ');
    });
  } catch (err) {
    console.error('\nLogin failed:', err.message);
    process.exit(1);
  }

  const envPath = join(process.cwd(), '.env');
  let envContent = '';
  if (existsSync(envPath)) {
    envContent = readFileSync(envPath, 'utf-8');
  }

  const replaceLine = (content, key, value) => {
    const escKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp('^' + escKey + '=.*$', 'm');
    if (regex.test(content)) {
      return content.replace(regex, key + '=' + value);
    }
    return content + '\n' + key + '=' + value + '\n';
  };

  envContent = replaceLine(envContent, 'TELEGRAM_API_ID', String(apiId));
  envContent = replaceLine(envContent, 'TELEGRAM_API_HASH', apiHash);
  envContent = replaceLine(envContent, 'TELEGRAM_SESSION', sessionStr);

  writeFileSync(envPath, envContent);
  console.log('\n✅ Configuration saved to .env');
  console.log('Run: npm start');
  rl.close();
}

main();
