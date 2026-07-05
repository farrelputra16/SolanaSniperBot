import { homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { createInterface } from 'readline';

const GLOBAL_ENV = join(homedir(), '.config', 'gmgn', '.env');

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

const globalEnv = loadEnvFile(GLOBAL_ENV);
const localEnv = loadEnvFile(join(process.cwd(), '.env'));

const merged = { ...globalEnv, ...localEnv, ...process.env };

function get(key, defaultVal) {
  return merged[key] ?? defaultVal;
}

export const config = {
  gmgn: {
    apiKey: get('GMGN_API_KEY'),
    privateKey: get('GMGN_PRIVATE_KEY'),
    host: 'https://openapi.gmgn.ai',
  },
  telegram: {
    apiId: parseInt(get('TELEGRAM_API_ID', '0')),
    apiHash: get('TELEGRAM_API_HASH', ''),
    session: get('TELEGRAM_SESSION', ''),
    dcId: parseInt(get('TELEGRAM_DC', '0')),
  },
  sniper: {
    defaultBuyAmount: parseFloat(get('DEFAULT_BUY_AMOUNT', '0.01')),
    defaultSlippage: parseInt(get('DEFAULT_SLIPPAGE', '30')),
    defaultAntiMev: get('DEFAULT_ANTI_MEV', 'true') === 'true',
  },
  server: {
    port: parseInt(get('PORT', '3000')),
    host: get('HOST', '0.0.0.0'),
    password: get('DASHBOARD_PASSWORD', ''),
  },
};

export function validateConfig() {
  const errors = [];
  if (!config.gmgn.apiKey) errors.push('GMGN_API_KEY not found');
  if (!config.gmgn.privateKey) errors.push('GMGN_PRIVATE_KEY not found');
  if (!config.telegram.apiId || !config.telegram.apiHash) {
    errors.push('TELEGRAM_API_ID and TELEGRAM_API_HASH not set — dashboard-only mode');
  }
  return errors;
}

export async function promptApiCredentials() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const q = (q) => new Promise((r) => rl.question(q, r));
  const apiId = await q('Enter TELEGRAM_API_ID: ');
  const apiHash = await q('Enter TELEGRAM_API_HASH: ');
  rl.close();
  return { apiId: parseInt(apiId), apiHash };
}
