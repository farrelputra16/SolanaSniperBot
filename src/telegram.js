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

    const opts = { connectionRetries: 10, autoReconnect: true, reconnectRetries: Infinity, retryDelay: 3000 };
    if (config.telegram.dcId) opts.dcId = config.telegram.dcId;
    client = new TelegramClient(stringSession, apiId, apiHash, opts);
    _reconnectCreds = { apiId, apiHash, sessionStr, dcId: config.telegram.dcId };

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
    _globalHandlerInstalled = false;
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
          title: d.title || d.name || '',
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
  let _globalHandlerInstalled = false;
  const _listeners = new Set();
  const _channelMeta = new Map(); // chatId → { identifier, trackMode }
  let _reconnectCreds = null;
  let _reconnecting = false;
  let _pingFailures = 0;

  // Force a full re-login from the saved session. Used by the watchdog so the
  // scraper survives idle disconnects instead of silently going dead.
  export async function reconnectTelegram() {
    if (!_reconnectCreds || _reconnecting) return false;
    _reconnecting = true;
    try {
      console.warn('[Telegram] Connection lost — reconnecting...');
      await destroyClient();
      const { apiId, apiHash, sessionStr } = _reconnectCreds;
      await initTelegramWithSession(apiId, apiHash, sessionStr);
      installGlobalHandler();
      await startListeners();
      console.log('[Telegram] ✅ Reconnected');
      return true;
    } catch (err) {
      console.error('[Telegram] Reconnect failed:', err.message);
      return false;
    } finally {
      _reconnecting = false;
    }
  }

  export function startKeepAlive() {
    if (_pingInterval) clearInterval(_pingInterval);
    _pingInterval = setInterval(async () => {
      try {
        if (_reconnecting) return;
        if (!client || !client.connected) {
          // Connection dropped — don't just skip, actively recover.
          await reconnectTelegram();
          return;
        }
        // GramJS is already reconnecting internally — don't fight it with a full teardown.
        if (client._sender?.isReconnecting) return;
        await client.invoke(new (await import('telegram')).Api.Ping({ pingId: BigInt(Date.now()) }));
        _pingFailures = 0;
      } catch {
        // Connected flag may lie if the socket is half-dead; reconnect on repeated ping failures.
        _pingFailures++;
        if (_pingFailures >= 3) {
          _pingFailures = 0;
          await reconnectTelegram();
        }
      }
    }, 15000);
  }

  export function stopKeepAlive() {
    if (_pingInterval) { clearInterval(_pingInterval); _pingInterval = null; }
  }

  export function getClient() {
    return client;
  }

  export function isChannelListening(identifier) {
    for (const [chatId, meta] of _channelMeta) {
      if (meta.identifier === identifier) return _listeners.has(chatId);
    }
    return false;
  }

  function installGlobalHandler() {
    if (_globalHandlerInstalled || !client) return;
    client.addEventHandler(globalMessageHandler, new NewMessage({}));
    _globalHandlerInstalled = true;
  }

  async function globalMessageHandler(event) {
    try {
      const msg = event.message;
      if (!msg || !msg.text) return;
      const rawId = msg.chatId || msg.peerId?.channelId || msg.peerId?.chatId || msg.peerId?.userId;
      let chatId = String(rawId ?? '');
      if (chatId.startsWith('-100')) chatId = chatId.slice(4);
      if (!chatId || !_listeners.has(chatId)) return;

      const meta = _channelMeta.get(chatId);
      if (!meta) return;
      const identifier = meta.identifier;

      // Admin-only tracking for groups: accept channel posts, or messages sent by the group's
      // owner/creator or an admin (msg.post is only true for broadcast posts — group admin
      // messages are regular messages, so the old `!msg.post` check dropped them all).
      if (!meta.isBroadcast && meta.trackMode === 'admin') {
        const isAdminSender = await isGroupAdminSender(chatId, msg);
        if (isAdminSender === false) return;
      }

      const text = msg.text;

      if (onForwardCallback) {
        onForwardCallback(identifier, msg);
      }

      if (onSignalCallback) {
        onSignalCallback(identifier, text, msg, null);
        getSenderUsername(msg).then(username => {
          if (username) console.log(`[Signal] ${identifier} @${username}`);
        }).catch(() => {});
      }
    } catch (err) {
      console.error('[Telegram] Message handler error:', err.message);
    }
  }

  let _adminCache = new Map();
  const ADMIN_CACHE_TTL = 60000;

  function _peerId(p) {
    if (p == null) return '';
    if (typeof p === 'object') {
      const v = p.value ?? p.userId ?? p.channelId ?? p.chatId;
      return v != null ? String(v) : '';
    }
    return String(p);
  }

  // Returns: true = sender is owner/creator or admin, false = regular member, null = unknown
  async function isGroupAdminSender(chatId, msg) {
    try {
      if (msg.post) return true;
      const sender = await msg.getSender();
      if (!sender) return null;
      if (sender.broadcast === true) return true;
      const sid = _peerId(sender.id);
      if (!sid) return null;

      const cached = _adminCache.get(chatId);
      if (cached && Date.now() - cached.ts < ADMIN_CACHE_TTL) return cached.ids.has(sid);

      const { Api } = await import('telegram');
      const ids = new Set();
      try {
        const parts = await client.getParticipants(chatId, { filter: new Api.ChannelParticipantsAdmins() });
        for (const p of parts) {
          const uid = _peerId(p.userId);
          if (uid) ids.add(uid);
        }
      } catch (e) {
        console.warn(`[Telegram] Admin list fetch failed for ${chatId}: ${e.message}`);
      }
      _adminCache.set(chatId, { ids, ts: Date.now() });
      return ids.has(sid);
    } catch {
      return null;
    }
  }

  function resolveIdentifier(chatId) {
    const meta = _channelMeta.get(chatId);
    return meta ? meta.identifier : null;
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

  export async function startListeners() {
    if (!client) throw new Error('Telegram not initialized');

    installGlobalHandler();

    const channels = await db.getActiveChannels();

    for (const ch of channels) {
      const identifier = ch.channel_username || ch.channel_id?.toString();
      if (identifier) await addChannelListener(identifier, ch.track_mode).catch(() => {});
    }

    console.log(`[Telegram] Listening ${channels.length} channel(s)`);
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

  export async function addChannelListener(identifier, trackMode) {
    if (!client) return false;
    try {
      const entity = await resolveAndJoin(identifier);
      const label = entity.username || `t.me/+${identifier.replace('+', '')}`;
      const chatId = String(entity.id);
      const isBroadcast = entity.broadcast === true;
      const effectiveMode = isBroadcast ? 'admin' : (trackMode || 'admin');
      installGlobalHandler();
      _listeners.add(chatId);
      _channelMeta.set(chatId, { identifier, trackMode: effectiveMode, isBroadcast });
      console.log(`[Telegram] Listening: ${label} (${effectiveMode}${isBroadcast?' broadcast':' group'})`);
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
    for (const [chatId, meta] of _channelMeta) {
      if (meta.identifier === identifier) {
        _listeners.delete(chatId);
        _channelMeta.delete(chatId);
        console.log(`[Telegram] Stopped listening: ${identifier}`);
        db.addScraperLog(identifier, 'info', `Stopped listening: ${identifier}`);
        return;
      }
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

  export function setEntityId(identifier, id) {
    const chatId = String(id);
    if (!_channelMeta.has(chatId)) _channelMeta.set(chatId, { identifier, trackMode: 'admin' });
  }

  export function updateTrackMode(chatId, trackMode) {
    const meta = _channelMeta.get(chatId);
    if (meta) _channelMeta.set(chatId, { ...meta, trackMode });
  }

  export async function sendToChat(target, text) {
    if (!client) return;
    try {
      let chatId = target;
      for (const [cid, meta] of _channelMeta) {
        if (meta.identifier === target) { chatId = cid; break; }
      }
      await client.sendMessage(chatId, { message: text });
    } catch (err) {
      console.error('[Telegram] Send error:', err.message);
    }
  }
