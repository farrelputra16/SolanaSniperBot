import { homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { createInterface } from 'readline';

const GLOBAL_ENV = join(homedir(), '.config', 'gmgn', '.env');

function loadEnvFile(filepath) {
  if (!existsSync(filepath)) return {};
  const content = readFileSync(filepath, 'utf-8');
  const env = {};
  const lines = content.split('\n');
  let currentKey = null;
  let currentVal = null;
  let inQuotes = false;
  let quoteChar = null;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (currentKey !== null) {
      // We're inside a multi-line value
      if (inQuotes) {
        currentVal += '\n' + trimmed;
        if (trimmed.endsWith(quoteChar)) {
          inQuotes = false;
          currentVal = currentVal.slice(1, -1); // strip surrounding quotes
          currentVal = currentVal.replace(/\\n/g, '\n');
          env[currentKey] = currentVal;
          currentKey = null;
          currentVal = null;
        }
      } else {
        // Unquoted multi-line (PEM without quotes)
        currentVal += '\n' + trimmed;
        if (trimmed.includes('-----END')) {
          currentVal = currentVal.replace(/\\n/g, '\n');
          env[currentKey] = currentVal;
          currentKey = null;
          currentVal = null;
        }
      }
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (!val) continue;
    // Check if value starts a multi-line block
    if ((val.startsWith('"') && !val.endsWith('"')) || (val.startsWith("'") && !val.endsWith("'"))) {
      currentKey = key;
      currentVal = val;
      inQuotes = true;
      quoteChar = val[0];
      continue;
    }
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    else if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
    val = val.replace(/\\n/g, '\n');
    env[key] = val;
  }
  // If we have an unclosed multi-line value, still save it
  if (currentKey !== null && currentVal !== null) {
    if (inQuotes) currentVal = currentVal.slice(1);
    currentVal = currentVal.replace(/\\n/g, '\n');
    env[currentKey] = currentVal;
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
