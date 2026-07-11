import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { config } from './config.js';
import * as db from './database.js';

let client = null;
let onSignalCallback = null;
let onForwardCallback = null;
export let joinedChannelsCache = null;
let joinedChannelsCacheTime = 0;

export function onSignal(cb) {
  onSignalCallback = cb;
}

export function onForward(cb) {
  onForwardCallback = cb;
}

export async function initTelegram() {
  const { apiId, apiHash, session } = config.telegram;
  if (!apiId || !apiHash) throw new Error('Telegram API ID/Hash not configured');
  if (!session) throw new Error('No session string — login from dashboard');
  try { new (await import('telegram/sessions/index.js')).StringSession(session); } catch { throw new Error('Session invalid — login ulang dari dashboard'); }
  return initTelegramWithSession(apiId, apiHash, session);
}

export async function initTelegramWithSession(apiId, apiHash, sessionStr) {
  if (client) await destroyClient();
  if (!sessionStr) throw new Error('No session string');

  let stringSession;
  try { stringSession = new StringSession(sessionStr); } catch { throw new Error('Invalid session format'); }

  const opts = { connectionRetries: 3 };
  if (config.telegram.dcId) opts.dcId = config.telegram.dcId;
  client = new TelegramClient(stringSession, apiId, apiHash, opts);

  await client.connect();
  const me = await client.getMe();
  if (!me) { await destroyClient(); throw new Error('Session expired — login ulang'); }

  console.log(`[Telegram] Connected as @${me.username || me.id}`);
  startKeepAlive();
  return client;
}

export async function destroyClient() {
  stopKeepAlive();
  if (client) {
    try {
      client.removeAllEventHandlers?.();
      await client.destroy();
    } catch {}
    client = null;
  }
}

export async function loginNewSession(apiId, apiHash, phoneNumber, onCode, onPassword) {
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
      console.log('[Telegram] start() asking for 2FA password');
      if (!onPassword) {
        console.log('[Telegram] ERROR: no onPassword callback provided!');
        return Promise.resolve('');
      }
      return onPassword();
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

export async function setProfilePhoto(client, photoPath) {
  try {
    const { existsSync, readFileSync } = await import('fs');
    if (!existsSync(photoPath)) {
      console.log('[Telegram] Profile photo not found:', photoPath);
      return false;
    }
    const { Api } = await import('telegram');
    const buf = readFileSync(photoPath);
    const uploaded = await client.uploadFile({
      file: buf,
      workers: 1,
    });
    await client.invoke(new Api.photos.UploadProfilePhoto({
      file: uploaded,
    }));
    console.log('[Telegram] Profile photo updated from', photoPath);
    return true;
  } catch (err) {
    console.error('[Telegram] Failed to set profile photo:', err.message);
    return false;
  }
}

export async function getJoinedChannels() {
  // Check cache FIRST — works even if client disconnected
  const now = Date.now();
  if (joinedChannelsCache && (now - joinedChannelsCacheTime) < 60000) {
    console.log(`[Telegram] Returning ${joinedChannelsCache.length} cached joined channels`);
    return joinedChannelsCache;
  }
  if (!client) throw new Error('Telegram not connected');
  try {
    const dialogs = await client.getDialogs({ limit: 100 });
    const channels = dialogs
      .filter(d => d.isChannel)
      .map(d => ({
        id: d.id?.value?.toString() || String(d.id),
        name: d.name || d.title || 'Unknown',
        username: d.entity?.username || null,
        participants: d.entity?.participantsCount || 0,
      }))
      .sort((a, b) => b.participants - a.participants);
    console.log(`[Telegram] Fetched ${channels.length} joined channels (limited to 100)`);
    joinedChannelsCache = channels;
    joinedChannelsCacheTime = now;
    return channels;
  } catch (err) {
    console.error('[Telegram] Failed to fetch joined channels:', err.message);
    throw err;
  }
}

// Pre-fetch joined channels into cache right after Telegram connects (non-blocking)
export function warmJoinedChannelsCache() {
  if (!client) return;
  getJoinedChannels().catch(() => {});
}

let _pingInterval = null;
const _listeners = new Map();

export function startKeepAlive() {
  if (_pingInterval) clearInterval(_pingInterval);
  _pingInterval = setInterval(async () => {
    if (!client || !client.connected) return;
    try {
      await client.invoke(new (await import('telegram')).Api.Ping({ pingId: BigInt(Date.now()) }));
    } catch {}
  }, 30000);
}

export function stopKeepAlive() {
  if (_pingInterval) { clearInterval(_pingInterval); _pingInterval = null; }
}

export function getClient() {
  return client;
}

export async function startListeners() {
  if (!client) throw new Error('Telegram not initialized');

  const channels = await db.getActiveChannels();

  for (const ch of channels) {
    const identifier = ch.channel_username || ch.channel_id?.toString();
    if (identifier) await addChannelListener(identifier).catch(() => {});
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

  if (onForwardCallback) {
    onForwardCallback(sourceChannel, message);
  }

  if (onSignalCallback) {
    // Fire signal ASAP, sender in background
    onSignalCallback(sourceChannel, text, message, null);
    getSenderUsername(event).then(username => {
      if (username) console.log(`[Signal] ${sourceChannel} @${username}`);
    }).catch(() => {});
  }
}

export async function resolveAndJoin(identifier) {
  if (!client) throw new Error('Telegram not connected');
  const { Api } = await import('telegram');

  if (!identifier.startsWith('+')) return client.getEntity(identifier);

  const hash = identifier.slice(1);
  let chatTitle = hash;

  // Try 1: ImportChatInvite
  try {
    const imported = await client.invoke(new Api.messages.ImportChatInvite({ hash }));
    if (imported.chats?.length) {
      chatTitle = imported.chats[0].title || hash;
      const entity = await client.getEntity(imported.chats[0]);
      console.log(`[Telegram] Joined: ${chatTitle}`);
      return entity;
    }
  } catch (e) {
    console.log(`[Telegram] ImportChatInvite: ${e.errorMessage || e.message}`);
  }

  // Try 2: CheckChatInvite
  try {
    const check = await client.invoke(new Api.messages.CheckChatInvite({ hash }));
    const chat = check.chat || check.chats?.[0];
    if (chat) {
      chatTitle = chat.title || hash;
      const entity = await client.getEntity(chat);
      if (entity) {
        console.log(`[Telegram] Resolved via CheckChatInvite: ${chatTitle}`);
        return entity;
      }
    }
  } catch (e) {
    console.log(`[Telegram] CheckChatInvite: ${e.errorMessage || e.message}`);
  }

  // Try 3: search all dialogs
  try {
    const dialogs = await client.getDialogs({ limit: 200 });
    for (const d of dialogs) {
      if (!d.isChannel) continue;
      const title = d.entity?.title || '';
      if (title.includes(chatTitle.slice(0, 12)) || (d.id?.value && String(d.id.value).includes(hash.slice(-6)))) {
        const entity = d.entity || await client.getEntity(d.id);
        console.log(`[Telegram] Found in dialogs: ${title}`);
        return entity;
      }
    }
    // Fallback: return the first channel if only one exists
    const channels = dialogs.filter(d => d.isChannel);
    if (channels.length === 1) {
      console.log(`[Telegram] Using only channel: ${channels[0].entity?.title || 'Unknown'}`);
      return channels[0].entity || await client.getEntity(channels[0].id);
    }
  } catch (e) {
    console.log(`[Telegram] Dialog search: ${e.message}`);
  }

  throw new Error(`Could not resolve invite link. Make sure your Telegram account has joined the channel`);
}

export async function addChannelListener(identifier) {
  if (!client) return false;
  try {
    const entity = await resolveAndJoin(identifier);
    const label = entity.username || `t.me/+${identifier.replace('+', '')}`;
    const chatId = String(entity.id);
    // Remove old listener for this chat before adding new one
    if (_listeners.has(chatId)) {
      client.removeEventHandler(_listeners.get(chatId));
      _listeners.delete(chatId);
    }
    setEntityId(identifier, entity.id);
    const handler = async (event) => handleMessage(identifier, event);
    client.addEventHandler(handler, new NewMessage({ chats: [entity.id] }));
    _listeners.set(chatId, handler);
    console.log(`[Telegram] Listening: ${label}`);
    db.addScraperLog(identifier, 'info', `Listening: ${label}`);
    return true;
  } catch (err) {
    console.error(`[Telegram] Listen failed ${identifier}:`, err.message);
    db.addScraperLog(identifier, 'error', `Listen failed: ${err.message}`);
    return false;
  }
}

export async function removeChannelListener(identifier) {
  if (!client) return;
  let chatId = _entityIdMap.get(identifier);
  if (!chatId) {
    try {
      const entity = await resolveAndJoin(identifier);
      chatId = String(entity.id);
    } catch {
      return;
    }
  }
  chatId = String(chatId);
  if (_listeners.has(chatId)) {
    client.removeEventHandler(_listeners.get(chatId));
    _listeners.delete(chatId);
    _entityIdMap.delete(identifier);
    const label = identifier || chatId;
    console.log(`[Telegram] Stopped listening: ${label}`);
    db.addScraperLog(identifier, 'info', `Stopped listening: ${label}`);
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

const _entityIdMap = new Map();

export function setEntityId(identifier, id) {
  _entityIdMap.set(identifier, id);
}

export async function sendToChat(target, text) {
  if (!client) return;
  try {
    const chatId = _entityIdMap.get(target) || target;
    await client.sendMessage(chatId, { message: text });
  } catch (err) {
    console.error('[Telegram] Send error:', err.message);
  }
}
