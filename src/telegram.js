import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { config } from './config.js';
import * as db from './database.js';

let onSignalCallback = null;
let onForwardCallback = null;

// Per-user MTProto client registry. Each logged-in Telegram account gets its own
// client + listeners so multiple users can scrape simultaneously without clobbering
// each other. (The old single global `client` + `active_telegram_id` destroyed user
// A's session the moment user B logged in — Bug 1.)
const _clients = new Map(); // telegramId → ClientState

function makeState(telegramId) {
  return {
    telegramId,
    client: null,
    apiId: 0,
    apiHash: '',
    sessionStr: '',
    dcId: 0,
    listeners: new Set(),
    channelMeta: new Map(),
    adminCache: new Map(),
    reconnectCreds: null,
    reconnecting: false,
    pingFailures: 0,
    senderReconnectingSince: 0,
    keepAliveTimer: null,
    joinedChannelsCache: null,
    joinedChannelsCacheTime: 0,
    globalHandlerInstalled: false,
    me: null,
  };
}

// Resolve a ClientState with legacy fallback (used by read-only queries). Prefers the
// explicit tid, then the ALS-pinned telegram_id (web request / bot update scope), then
// the single connected client (legacy env-only mode). Returns null when ambiguous.
function getState(tid) {
  const id = tid || db.getTelegramId();
  if (id) {
    const s = _clients.get(id);
    if (s) return s;
  }
  if (_clients.size === 1) return [..._clients.values()][0];
  return null;
}

// Strict resolution — only the user's OWN registered client. Never falls back to
// another user's client, so destructive/listener operations can't touch the wrong
// account in multi-user mode.
function getStateExact(tid) {
  const id = tid || db.getTelegramId();
  return id ? (_clients.get(id) || null) : null;
}

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
  try { new StringSession(session); } catch { throw new Error('Session invalid — login ulang dari dashboard'); }
  const r = await initTelegramWithSession(apiId, apiHash, session, { dcId: config.telegram.dcId });
  return r.client;
}

export async function initTelegramWithSession(apiId, apiHash, sessionStr, opts = {}) {
  if (!sessionStr) throw new Error('No session string');

  let stringSession;
  try { stringSession = new StringSession(sessionStr); } catch { throw new Error('Invalid session format'); }

  const clientOpts = { connectionRetries: 10, autoReconnect: true, reconnectRetries: Infinity, retryDelay: 3000 };
  if (opts.dcId) clientOpts.dcId = opts.dcId;
  const client = new TelegramClient(stringSession, apiId, apiHash, clientOpts);

  await client.connect();
  const me = await client.getMe();
  if (!me) {
    try { await client.destroy(); } catch {}
    throw new Error('Session expired — login ulang');
  }
  const telegramId = String(me.id);

  // Replace ONLY this user's previous client — never another user's.
  const prev = _clients.get(telegramId);
  if (prev && prev.client && prev.client !== client) {
    stopKeepAlive(prev);
    prev.client.removeAllEventHandlers?.();
    await prev.client.destroy().catch(() => {});
  }

  const state = makeState(telegramId);
  state.client = client;
  state.apiId = apiId;
  state.apiHash = apiHash;
  state.sessionStr = sessionStr;
  state.dcId = opts.dcId || 0;
  state.reconnectCreds = { apiId, apiHash, sessionStr, dcId: opts.dcId || 0 };
  state.me = me;
  _clients.set(telegramId, state);
  startKeepAlive(state);

  console.log(`[Telegram] Connected as @${me.username || me.id} (${telegramId})`);
  return { client, telegramId };
}

export async function destroyClient(tid) {
  const id = tid || db.getTelegramId();
  const state = id ? _clients.get(id) : null;
  if (!state) return;
  stopKeepAlive(state);
  if (state.client) {
    try {
      state.client.removeAllEventHandlers?.();
      await state.client.destroy();
    } catch {}
  }
  _clients.delete(state.telegramId);
}

export function getClient(tid) {
  const state = getState(tid);
  return state?.client || null;
}

export function listClients() {
  return [..._clients.values()];
}

// Return the display identity (username/firstName) for a connected account.
// Prefers the cached `me` captured at connect time; falls back to a live getMe().
// Returns null when the client isn't connected/resolved.
export async function getAccountIdentity(tid) {
  const state = getState(tid);
  if (!state) return null;
  let me = state.me;
  if (!me && state.client?.connected) {
    try { me = await state.client.getMe(); state.me = me; } catch {}
  }
  if (!me) return null;
  return {
    telegramId: String(me.id ?? state.telegramId),
    username: me.username || '',
    firstName: me.firstName || '',
    lastName: me.lastName || '',
  };
}

// Safety-net: reconnect any registered client that dropped. Runs on a timer from the
// web server so sessions stay alive even with no browser open.
export async function ensureAllClientsConnected() {
  for (const state of _clients.values()) {
    if (!state.client || !state.client.connected) {
      await reconnectTelegram(state.telegramId).catch(() => {});
    }
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

export async function getJoinedChannels(tid) {
  const state = getState(tid);
  if (!state) throw new Error('Telegram not connected');
  // Check cache FIRST — works even if client disconnected
  const now = Date.now();
  if (state.joinedChannelsCache && (now - state.joinedChannelsCacheTime) < 60000) {
    console.log(`[Telegram] (${state.telegramId}) Returning ${state.joinedChannelsCache.length} cached joined channels`);
    return state.joinedChannelsCache;
  }
  if (!state.client) throw new Error('Telegram not connected');
  try {
    const dialogs = await state.client.getDialogs({ limit: 100 });
    const channels = dialogs
      .filter(d => d.isChannel)
      .map(d => ({
        id: d.id?.value?.toString() || String(d.id),
        name: d.name || d.title || 'Unknown',
        title: d.title || d.name || '',
        username: d.entity?.username || null,
        participants: d.entity?.participantsCount || 0,
      }))
      .sort((a, b) => b.participants - a.participants);
    console.log(`[Telegram] (${state.telegramId}) Fetched ${channels.length} joined channels (limited to 100)`);
    state.joinedChannelsCache = channels;
    state.joinedChannelsCacheTime = now;
    return channels;
  } catch (err) {
    console.error(`[Telegram] (${state.telegramId}) Failed to fetch joined channels:`, err.message);
    throw err;
  }
}

// Pre-fetch joined channels into cache right after Telegram connects (non-blocking)
export function warmJoinedChannelsCache(tid) {
  const state = getState(tid);
  if (!state?.client) return;
  getJoinedChannels(state.telegramId).catch(() => {});
}

const ADMIN_CACHE_TTL = 60000;

export function startKeepAlive(state) {
  stopKeepAlive(state);
  state.keepAliveTimer = setInterval(async () => {
    try {
      if (state.reconnecting) return;
      if (!state.client || !state.client.connected) {
        // Connection dropped — don't just skip, actively recover.
        await reconnectTelegram(state.telegramId);
        return;
      }
      // GramJS is already reconnecting internally — don't fight it with a full teardown.
      if (state.client._sender?.isReconnecting) {
        // ...but cap it: if the internal reconnect stays stuck too long, force
        // a full reconnect instead of skipping keep-alive forever.
        if (!state.senderReconnectingSince) state.senderReconnectingSince = Date.now();
        if (Date.now() - state.senderReconnectingSince > 90000) {
          state.senderReconnectingSince = 0;
          await reconnectTelegram(state.telegramId);
        }
        return;
      }
      state.senderReconnectingSince = 0;
      await state.client.invoke(new (await import('telegram')).Api.Ping({ pingId: BigInt(Date.now()) }));
      state.pingFailures = 0;
    } catch {
      // Connected flag may lie if the socket is half-dead; reconnect on repeated ping failures.
      state.pingFailures++;
      if (state.pingFailures >= 3) {
        state.pingFailures = 0;
        await reconnectTelegram(state.telegramId);
      }
    }
  }, 15000);
}

export function stopKeepAlive(state) {
  if (state?.keepAliveTimer) { clearInterval(state.keepAliveTimer); state.keepAliveTimer = null; }
}

// Force a full re-login from the saved session. Used by the watchdog so the
// scraper survives idle disconnects instead of silently going dead.
export async function reconnectTelegram(tid) {
  const state = getStateExact(tid);
  if (!state || state.reconnecting) return false;
  state.reconnecting = true;
  state.senderReconnectingSince = 0;
  try {
    const creds = state.reconnectCreds || {};
    if (!creds.sessionStr || !creds.apiId || !creds.apiHash) return false;
    console.warn(`[Telegram] (${state.telegramId}) Connection lost — reconnecting...`);
    await destroyClient(state.telegramId);
    await initTelegramWithSession(creds.apiId, creds.apiHash, creds.sessionStr, { dcId: creds.dcId || 0 });
    const ns = _clients.get(state.telegramId);
    if (ns) {
      installGlobalHandler(ns);
      await startListeners(ns.telegramId);
    }
    console.log(`[Telegram] (${state.telegramId}) ✅ Reconnected`);
    return true;
  } catch (err) {
    console.error(`[Telegram] (${state.telegramId}) Reconnect failed:`, err.message);
    return false;
  } finally {
    state.reconnecting = false;
  }
}

export function isChannelListening(identifier, tid) {
  const state = getState(tid);
  if (!state) return false;
  for (const [chatId, meta] of state.channelMeta) {
    if (meta.identifier === identifier) return state.listeners.has(chatId);
  }
  return false;
}

function installGlobalHandler(state) {
  if (state.globalHandlerInstalled || !state.client) return;
  state.client.addEventHandler((event) => globalMessageHandler(state, event), new NewMessage({}));
  state.globalHandlerInstalled = true;
}

async function globalMessageHandler(state, event) {
  try {
    const msg = event.message;
    if (!msg || !msg.text) return;
    const rawId = msg.chatId || msg.peerId?.channelId || msg.peerId?.chatId || msg.peerId?.userId;
    let chatId = String(rawId ?? '');
    if (chatId.startsWith('-100')) chatId = chatId.slice(4);
    if (!chatId || !state.listeners.has(chatId)) return;

    const meta = state.channelMeta.get(chatId);
    if (!meta) return;
    const identifier = meta.identifier;

    // Admin-only tracking for groups: accept channel posts, or messages sent by the group's
    // owner/creator or an admin (msg.post is only true for broadcast posts — group admin
    // messages are regular messages, so the old `!msg.post` check dropped them all).
    if (!meta.isBroadcast && meta.trackMode === 'admin') {
      const isAdminSender = await isGroupAdminSender(state, chatId, msg);
      if (isAdminSender === false) return;
    }

    const text = msg.text;

    if (onForwardCallback) {
      onForwardCallback(identifier, msg);
    }

    if (onSignalCallback) {
      onSignalCallback(identifier, text, msg, null, state.telegramId);
      getSenderUsername(msg).then(username => {
        if (username) console.log(`[Signal] ${identifier} @${username}`);
      }).catch(() => {});
    }
  } catch (err) {
    console.error(`[Telegram] (${state.telegramId}) Message handler error:`, err.message);
  }
}

function _peerId(p) {
  if (p == null) return '';
  if (typeof p === 'object') {
    const v = p.value ?? p.userId ?? p.channelId ?? p.chatId;
    return v != null ? String(v) : '';
  }
  return String(p);
}

// Returns: true = sender is owner/creator or admin, false = regular member, null = unknown
async function isGroupAdminSender(state, chatId, msg) {
  try {
    if (msg.post) return true;
    const sender = await msg.getSender();
    if (!sender) return null;
    if (sender.broadcast === true) return true;
    const sid = _peerId(sender.id);
    if (!sid) return null;

    const cached = state.adminCache.get(chatId);
    if (cached && Date.now() - cached.ts < ADMIN_CACHE_TTL) return cached.ids.has(sid);

    const { Api } = await import('telegram');
    const ids = new Set();
    try {
      const parts = await state.client.getParticipants(chatId, { filter: new Api.ChannelParticipantsAdmins() });
      for (const p of parts) {
        const uid = _peerId(p.userId);
        if (uid) ids.add(uid);
      }
    } catch (e) {
      console.warn(`[Telegram] Admin list fetch failed for ${chatId}: ${e.message}`);
    }
    state.adminCache.set(chatId, { ids, ts: Date.now() });
    return ids.has(sid);
  } catch {
    return null;
  }
}

async function getSenderUsername(message) {
  try {
    if (!message) return null;
    const sender = await message.getSender();
    if (!sender) return null;
    return sender.username || `${sender.firstName || ''} ${sender.lastName || ''}`.trim() || null;
  } catch {
    return null;
  }
}

// Listen ONLY to this user's own channels. Each account scrapes its own sources —
// scoping the DB query to the state owner keeps concurrent logins fully isolated.
export async function startListeners(tid) {
  const state = getStateExact(tid);
  if (!state || !state.client) throw new Error('Telegram not initialized');

  installGlobalHandler(state);

  const channels = await db.runWithTelegramId(state.telegramId, () => db.getActiveChannels(false));

  for (const ch of channels) {
    const identifier = ch.channel_username || ch.channel_id?.toString();
    if (identifier) await addChannelListener(identifier, ch.track_mode, state.telegramId).catch(() => {});
  }

  console.log(`[Telegram] (${state.telegramId}) Listening ${channels.length} channel(s)`);
}

export async function resolveAndJoin(client, identifier) {
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

export async function addChannelListener(identifier, trackMode, tid) {
  const state = getStateExact(tid);
  if (!state || !state.client) return false;
  try {
    const entity = await resolveAndJoin(state.client, identifier);
    const label = entity.username || `t.me/+${identifier.replace('+', '')}`;
    const chatId = String(entity.id);
    const isBroadcast = entity.broadcast === true;
    const effectiveMode = isBroadcast ? 'admin' : (trackMode || 'admin');
    installGlobalHandler(state);
    state.listeners.add(chatId);
    state.channelMeta.set(chatId, { identifier, trackMode: effectiveMode, isBroadcast });
    console.log(`[Telegram] (${state.telegramId}) Listening: ${label} (${effectiveMode}${isBroadcast ? ' broadcast' : ' group'})`);
    db.addScraperLog(identifier, 'info', `Listening: ${label}`);
    return true;
  } catch (err) {
    console.error(`[Telegram] Listen failed ${identifier}:`, err.message);
    db.addScraperLog(identifier, 'error', `Listen failed: ${err.message}`);
    return false;
  }
}

export async function removeChannelListener(identifier, tid) {
  const state = getStateExact(tid);
  if (!state) return;
  for (const [chatId, meta] of state.channelMeta) {
    if (meta.identifier === identifier) {
      state.listeners.delete(chatId);
      state.channelMeta.delete(chatId);
      console.log(`[Telegram] (${state.telegramId}) Stopped listening: ${identifier}`);
      db.addScraperLog(identifier, 'info', `Stopped listening: ${identifier}`);
      return;
    }
  }
}

export async function forwardToChat(targetChatId, text, tid) {
  const state = getStateExact(tid);
  if (!state?.client) return;
  try {
    await state.client.sendMessage(targetChatId, { message: text });
  } catch (err) {
    console.error(`[Telegram] (${state.telegramId}) Forward error:`, err.message);
  }
}

export function setEntityId(identifier, id, tid) {
  const state = getStateExact(tid);
  if (!state) return;
  const chatId = String(id);
  if (!state.channelMeta.has(chatId)) state.channelMeta.set(chatId, { identifier, trackMode: 'admin' });
}

export function updateTrackMode(chatId, trackMode, tid) {
  const state = getStateExact(tid);
  if (!state) return;
  const meta = state.channelMeta.get(chatId);
  if (meta) state.channelMeta.set(chatId, { ...meta, trackMode });
}

export async function sendToChat(target, text, tid) {
  const state = getStateExact(tid);
  if (!state?.client) return;
  try {
    let chatId = target;
    for (const [cid, meta] of state.channelMeta) {
      if (meta.identifier === target) { chatId = cid; break; }
    }
    await state.client.sendMessage(chatId, { message: text });
  } catch (err) {
    console.error(`[Telegram] (${state.telegramId}) Send error:`, err.message);
  }
}
