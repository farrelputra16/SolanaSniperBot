import { TelegramClient } from 'gramjs';
import { StringSession } from 'gramjs/sessions/index.js';
import { NewMessage } from 'gramjs/events/index.js';
import { config } from './config.js';
import { getDatabase } from './database.js';

let client = null;
let onSignalCallback = null;
let onForwardCallback = null;

export function onSignal(cb) {
  onSignalCallback = cb;
}

export function onForward(cb) {
  onForwardCallback = cb;
}

export async function initTelegram() {
  const { apiId, apiHash, session } = config.telegram;
  if (!apiId || !apiHash) {
    throw new Error('TELEGRAM_API_ID dan TELEGRAM_API_HASH belum dikonfigurasi');
  }

  const stringSession = new StringSession(session);

  client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => {
      throw new Error('Session tidak valid. Jalankan: npm run setup-telegram');
    },
    phoneCode: async () => '',
    onError: (err) => console.error('[Telegram]', err),
  });

  const me = await client.getMe();
  console.log(`[Telegram] Terhubung sebagai @${me.username || me.id}`);
  return client;
}

export async function loginNewSession(apiId, apiHash, phoneNumber, onCode) {
  const stringSession = new StringSession('');
  const tempClient = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  let codeResolver;
  const codePromise = new Promise((r) => { codeResolver = r; });
  let passwordResolver;
  const passwordPromise = new Promise((r) => { passwordResolver = r; });

  await tempClient.start({
    phoneNumber: () => Promise.resolve(phoneNumber),
    phoneCode: () => onCode ? onCode() : codePromise,
    password: () => passwordPromise,
    onError: (err) => console.error(err),
  });

  const sessionStr = stringSession.save();
  await tempClient.destroy();
  return sessionStr;
}

export function getClient() {
  return client;
}

export async function startListeners() {
  if (!client) throw new Error('Telegram belum initialized');

  const channels = getDatabase().prepare('SELECT channel_username FROM channels WHERE active = 1').all();

  for (const ch of channels) {
    await addChannelListener(ch.channel_username);
  }

  console.log(`[Telegram] Listening ${channels.length} channel(s)`);
}

async function handleMessage(sourceChannel, event) {
  const message = event.message;
  if (!message || !message.text) return;

  const text = message.text;
  console.log(`[Signal] ${sourceChannel}: ${text.slice(0, 120)}`);

  if (onForwardCallback) {
    onForwardCallback(sourceChannel, message);
  }

  if (onSignalCallback) {
    onSignalCallback(sourceChannel, text, message);
  }
}

export async function addChannelListener(channelUsername) {
  if (!client) return false;
  try {
    const entity = await client.getEntity(channelUsername);
    client.addEventHandler(
      (event) => handleMessage(channelUsername, event),
      new NewMessage({ chats: [entity.id] })
    );
    console.log(`[Telegram] Listening: ${channelUsername}`);
    return true;
  } catch (err) {
    console.error(`[Telegram] Gagal listen ${channelUsername}:`, err.message);
    return false;
  }
}

export async function forwardToChat(targetChatId, text) {
  if (!client) return;
  try {
    await client.sendMessage(targetChatId, { message: text });
  } catch (err) {
    console.error('[Telegram] Forward error:', err.message);
  }
}

export async function sendToChat(target, text) {
  if (!client) return;
  try {
    await client.sendMessage(target, { message: text });
  } catch (err) {
    console.error('[Telegram] Send error:', err.message);
  }
}
