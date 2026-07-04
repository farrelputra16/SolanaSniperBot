import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { config } from './config.js';
import * as db from './database.js';

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
  return initTelegramWithSession(apiId, apiHash, session);
}

export async function initTelegramWithSession(apiId, apiHash, sessionStr) {
  if (client) {
    await destroyClient();
  }

  const stringSession = new StringSession(sessionStr);
  client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => {
      throw new Error('Session tidak valid');
    },
    phoneCode: async () => '',
    onError: (err) => console.error('[Telegram]', err),
  });

  const me = await client.getMe();
  console.log(`[Telegram] Terhubung sebagai @${me.username || me.id}`);
  return client;
}

export async function destroyClient() {
  if (client) {
    try {
      client.removeAllEventHandlers?.();
      await client.destroy();
    } catch {}
    client = null;
  }
}

export async function loginNewSession(apiId, apiHash, phoneNumber, onCode) {
  const stringSession = new StringSession('');
  const tempClient = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 3,
  });

  console.log('[Telegram] loginNewSession: calling start()...');
  await tempClient.start({
    phoneNumber: () => {
      console.log('[Telegram] start() asking for phone number');
      return Promise.resolve(phoneNumber);
    },
    phoneCode: () => {
      console.log('[Telegram] start() asking for phone code');
      if (!onCode) {
        console.log('[Telegram] ERROR: no onCode callback provided!');
        return Promise.resolve('');
      }
      return onCode();
    },
    password: () => {
      console.log('[Telegram] start() asking for 2FA password — not supported');
      return Promise.resolve('');
    },
    onError: (err) => {
      console.error('[Telegram] start() error:', err.message);
    },
  });
  console.log('[Telegram] loginNewSession: start() completed');

  const sessionStr = stringSession.save();
  await tempClient.destroy();
  return sessionStr;
}

export function getClient() {
  return client;
}

export async function startListeners() {
  if (!client) throw new Error('Telegram belum initialized');

  const channels = db.qall('SELECT channel_username FROM channels WHERE active = 1');

  for (const ch of channels) {
    await addChannelListener(ch.channel_username);
  }

  console.log(`[Telegram] Listening ${channels.length} channel(s)`);
}

async function getSenderUsername(event) {
  try {
    if (!event.message) return null;
    const sender = await event.message.getSender();
    if (!sender) return null;
    return sender.username || `${sender.firstName || ''} ${sender.lastName || ''}`.trim() || null;
  } catch {
    return null;
  }
}

async function handleMessage(sourceChannel, event) {
  const message = event.message;
  if (!message || !message.text) return;

  const text = message.text;
  const senderUsername = await getSenderUsername(event);

  console.log(`[Signal] ${sourceChannel}${senderUsername ? ' (@' + senderUsername + ')' : ''}: ${text.slice(0, 120)}`);

  if (onForwardCallback) {
    onForwardCallback(sourceChannel, message);
  }

  if (onSignalCallback) {
    onSignalCallback(sourceChannel, text, message, senderUsername);
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
    db.addScraperLog(channelUsername, 'info', 'Mulai listening');
    return true;
  } catch (err) {
    console.error(`[Telegram] Gagal listen ${channelUsername}:`, err.message);
    db.addScraperLog(channelUsername, 'error', `Gagal listen: ${err.message}`);
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
