import http from 'http';
import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IDENTITY_STORE_PATH = path.join(__dirname, 'data', 'identity-store.json');
const INBOX_STORE_PATH = path.join(__dirname, 'data', 'message-inbox.json');
const CONTACT_STORE_PATH = path.join(__dirname, 'data', 'contact-store.json');
const GROUP_STORE_PATH = path.join(__dirname, 'data', 'group-store.json');
const BAN_STORE_PATH = path.join(__dirname, 'data', 'ban-store.json');
const INVITE_STORE_PATH = path.join(__dirname, 'data', 'invite-store.json');

const SUPERUSER_ID = '@tract-admin';

const app = express();
const server = http.createServer(app);
const peers = new Map();
/** Ephemeral WebRTC signaling (offer/answer/ice) — per peerId, not persisted */
const peerSignals = new Map();
const sseClients = new Map(); // key (roomId:peerId) -> Set<res>
const identityStore = new Map();
/** Persistent inbox by @login userId — survives logout, peer timeout, redeploy */
const userInbox = new Map();
/** Persistent contact list by @login userId */
const contactStore = new Map();
/** Persistent group store */
const groupStore = new Map();
/** Banned user IDs (Set of @userId) */
const banStore = new Set();
/** One-time invite codes: code -> { usedBy, createdBy, createdAt, usedAt } */
const inviteStore = new Map();
const PEER_TTL_MS = 15000;
const MAX_INBOX_PER_USER = 5000;
const CALL_INBOX_TTL_MS = 90_000;

function loadIdentityStore() {
  try {
    if (fs.existsSync(IDENTITY_STORE_PATH)) {
      const data = JSON.parse(fs.readFileSync(IDENTITY_STORE_PATH, 'utf8'));
      for (const [userId, record] of Object.entries(data)) {
        identityStore.set(userId, record);
      }
      console.log(`[Identity] Loaded ${identityStore.size} identities from disk`);
    }
  } catch (err) {
    console.warn('[Identity] Failed to load from disk:', err.message);
  }
}

function saveIdentityStore() {
  try {
    const dir = path.dirname(IDENTITY_STORE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const data = Object.fromEntries(identityStore);
    fs.writeFileSync(IDENTITY_STORE_PATH, JSON.stringify(data), 'utf8');
  } catch (err) {
    console.warn('[Identity] Failed to save to disk:', err.message);
  }
}

loadIdentityStore();
loadInboxStore();

function loadInboxStore() {
  try {
    if (fs.existsSync(INBOX_STORE_PATH)) {
      const data = JSON.parse(fs.readFileSync(INBOX_STORE_PATH, 'utf8'));
      for (const [userId, entries] of Object.entries(data)) {
        userInbox.set(userId, Array.isArray(entries) ? entries : []);
      }
      console.log(`[Inbox] Loaded ${userInbox.size} user mailboxes from disk`);
    }
  } catch (err) {
    console.warn('[Inbox] Failed to load from disk:', err.message);
  }
}

function saveInboxStore() {
  try {
    const dir = path.dirname(INBOX_STORE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const data = Object.fromEntries(userInbox);
    fs.writeFileSync(INBOX_STORE_PATH, JSON.stringify(data), 'utf8');
  } catch (err) {
    console.warn('[Inbox] Failed to save to disk:', err.message);
  }
}

function loadContactStore() {
  try {
    if (fs.existsSync(CONTACT_STORE_PATH)) {
      const data = JSON.parse(fs.readFileSync(CONTACT_STORE_PATH, 'utf8'));
      for (const [userId, contacts] of Object.entries(data)) {
        contactStore.set(userId, contacts);
      }
      console.log(`[Contacts] Loaded ${contactStore.size} user contact lists from disk`);
    }
  } catch (err) {
    console.warn('[Contacts] Failed to load from disk:', err.message);
  }
}

function saveContactStore() {
  try {
    const dir = path.dirname(CONTACT_STORE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const data = Object.fromEntries(contactStore);
    fs.writeFileSync(CONTACT_STORE_PATH, JSON.stringify(data), 'utf8');
  } catch (err) {
    console.warn('[Contacts] Failed to save to disk:', err.message);
  }
}

loadContactStore();

function loadGroupStore() {
  try {
    if (fs.existsSync(GROUP_STORE_PATH)) {
      const data = JSON.parse(fs.readFileSync(GROUP_STORE_PATH, 'utf8'));
      for (const [groupId, group] of Object.entries(data)) {
        groupStore.set(groupId, group);
      }
      console.log(`[Groups] Loaded ${groupStore.size} groups from disk`);
    }
  } catch (err) {
    console.warn('[Groups] Failed to load from disk:', err.message);
  }
}

function saveGroupStore() {
  try {
    const dir = path.dirname(GROUP_STORE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const data = Object.fromEntries(groupStore);
    fs.writeFileSync(GROUP_STORE_PATH, JSON.stringify(data), 'utf8');
  } catch (err) {
    console.warn('[Groups] Failed to save to disk:', err.message);
  }
}

loadGroupStore();

function loadBanStore() {
  try {
    if (fs.existsSync(BAN_STORE_PATH)) {
      const data = JSON.parse(fs.readFileSync(BAN_STORE_PATH, 'utf8'));
      if (Array.isArray(data)) {
        for (const userId of data) banStore.add(userId);
      }
      console.log(`[Ban] Loaded ${banStore.size} banned users`);
    }
  } catch (err) {
    console.warn('[Ban] Failed to load from disk:', err.message);
  }
}

function saveBanStore() {
  try {
    const dir = path.dirname(BAN_STORE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(BAN_STORE_PATH, JSON.stringify(Array.from(banStore)), 'utf8');
  } catch (err) {
    console.warn('[Ban] Failed to save to disk:', err.message);
  }
}

function loadInviteStore() {
  try {
    if (fs.existsSync(INVITE_STORE_PATH)) {
      const data = JSON.parse(fs.readFileSync(INVITE_STORE_PATH, 'utf8'));
      for (const [code, info] of Object.entries(data)) {
        inviteStore.set(code, info);
      }
      console.log(`[Invite] Loaded ${inviteStore.size} invite codes`);
    }
  } catch (err) {
    console.warn('[Invite] Failed to load from disk:', err.message);
  }
}

function saveInviteStore() {
  try {
    const dir = path.dirname(INVITE_STORE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(INVITE_STORE_PATH, JSON.stringify(Object.fromEntries(inviteStore)), 'utf8');
  } catch (err) {
    console.warn('[Invite] Failed to save to disk:', err.message);
  }
}

loadBanStore();
loadInviteStore();

if (!inviteStore.has('admin-bootstrap')) {
  const adminCode = `inv-${crypto.randomUUID().slice(0, 8)}`;
  inviteStore.set(adminCode, { usedBy: null, createdBy: 'system', createdAt: Date.now() });
  saveInviteStore();
  console.log(`\n  === ADMIN BOOTSTRAP INVITE ===`);
  console.log(`  Register the superuser at: ${adminCode}`);
  console.log(`  URL: ?invite=${adminCode}`);
  console.log(`  ==============================\n`);
}

function resolvePeerUserId(roomId, peerId) {
  if (!peerId) return null;
  return peers.get(peerKey(roomId, peerId))?.userId || null;
}

function normalizeUserId(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
}

function removeInboxEntries(userId, predicate) {
  const normalized = normalizeUserId(userId);
  if (!normalized) return false;
  const inbox = userInbox.get(normalized) || [];
  const filtered = inbox.filter((entry) => !predicate(entry));
  if (filtered.length === inbox.length) return false;
  userInbox.set(normalized, filtered);
  saveInboxStore();
  return true;
}

function isPersistentAppPacket(type, payload) {
  if (type !== 'app_packet' || !payload || typeof payload !== 'object') return false;
  return payload.type === 'text' || payload.type === 'message_control' || payload.type === 'call';
}

function enqueueUserInbox(toUserId, entry) {
  const userId = normalizeUserId(toUserId);
  if (!userId) return null;

  if (!userInbox.has(userId)) userInbox.set(userId, []);
  const list = userInbox.get(userId);

  if (entry.payload?.packetId && list.some((e) => e.payload?.packetId === entry.payload.packetId)) {
    return null;
  }

  if (entry.payload?.type === 'call' && entry.payload?.callId) {
    const dup = list.some((e) => e.payload?.type === 'call' && e.payload?.callId === entry.payload.callId && e.payload?.action === entry.payload.action);
    if (dup) return null;
  }

  list.push(entry);
  while (list.length > MAX_INBOX_PER_USER) {
    list.shift();
  }
  saveInboxStore();
  return entry.id;
}

function filterInboxForDelivery(entries) {
  const now = Date.now();
  return entries.filter((entry) => {
    if (entry.payload?.type !== 'call') return true;
    return now - (entry.timestamp || 0) < CALL_INBOX_TTL_MS;
  });
}

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Accept');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }

  next();
});

app.use(express.json());

function peerKey(roomId, peerId) {
  return `${roomId}:${peerId}`;
}

function ensurePeerSignalQueue(key) {
  if (!peerSignals.has(key)) {
    peerSignals.set(key, []);
  }
  return peerSignals.get(key);
}

function safeWrite(res, data) {
  try { res.write(data); } catch (e) { /* client may have disconnected */ }
}

function cleanupExpiredPeers() {
  const now = Date.now();
  for (const [key, peer] of peers) {
    if (now - peer.timestamp <= PEER_TTL_MS) continue;
    peers.delete(key);
    peerSignals.delete(key);
    console.log(`[Signaling] Timeout: ${peer.roomId}/${peer.peerId}`);
  }

  for (const [userId, entries] of userInbox) {
    const fresh = filterInboxForDelivery(entries);
    if (fresh.length !== entries.length) {
      userInbox.set(userId, fresh);
      saveInboxStore();
    }
  }
}

app.post('/peer/register', (req, res) => {
  const { peerId, roomId, userId, displayName, publicKeyHex, avatarData, hideOnline, lastSeen } = req.body;
  if (!peerId || !roomId || !userId) {
    return res.status(400).json({ error: 'peerId, roomId and userId are required' });
  }

  const normalized = normalizeUserId(userId);
  if (banStore.has(normalized)) {
    return res.status(403).json({ error: 'user is banned' });
  }

  const key = peerKey(roomId, peerId);
  peers.set(key, {
    peerId,
    roomId,
    userId,
    displayName: displayName || userId,
    publicKey: publicKeyHex || null,
    avatar: avatarData || null,
    hideOnline: Boolean(hideOnline),
    lastSeen: hideOnline ? null : (lastSeen || null),
    address: req.socket.remoteAddress,
    timestamp: Date.now()
  });
  ensurePeerSignalQueue(key);

  res.json({ status: 'ok' });
});

app.post('/peer/heartbeat', (req, res) => {
  const { peerId, roomId, displayName, publicKeyHex, avatarData, hideOnline, lastSeen } = req.body;
  const key = peerKey(roomId, peerId);
  const peer = peers.get(key);

  if (!peer) {
    return res.status(404).json({ error: 'peer not found' });
  }

  peer.timestamp = Date.now();
  if (displayName) peer.displayName = displayName;
  if (publicKeyHex) peer.publicKey = publicKeyHex;
  if (avatarData) peer.avatar = avatarData;
  peer.hideOnline = Boolean(hideOnline);
  peer.lastSeen = hideOnline ? null : (lastSeen || peer.lastSeen || null);
  peers.set(key, peer);
  res.json({ status: 'ok' });
});

app.post('/peer/unregister', (req, res) => {
  const { peerId, roomId } = req.body;
  const key = peerKey(roomId, peerId);
  peers.delete(key);
  peerSignals.delete(key);
  res.json({ status: 'ok' });
});

app.post('/profile/avatar', (req, res) => {
  const { userId, avatarData } = req.body;
  if (!userId || !avatarData) {
    return res.status(400).json({ error: 'userId and avatarData are required' });
  }

  const record = identityStore.get(userId) || { updatedAt: Date.now() };
  record.avatarData = avatarData;
  record.updatedAt = Date.now();
  identityStore.set(userId, record);
  saveIdentityStore();

  res.json({ status: 'ok' });
});

app.get('/profile/avatar/:userId', (req, res) => {
  const { userId } = req.params;
  const record = identityStore.get(userId);
  if (!record || !record.avatarData) {
    return res.status(404).json({ avatarData: null });
  }
  res.json({ avatarData: record.avatarData });
});

app.get('/peers/discover', (req, res) => {
  cleanupExpiredPeers();
  const { roomId, peerId } = req.query;

  const roomPeers = Array.from(peers.values()).filter((peer) => {
    return peer.roomId === roomId && peer.peerId !== peerId;
  });

  res.json({ peers: roomPeers });
});

app.get('/peers/by-user/:userId', (req, res) => {
  cleanupExpiredPeers();
  const { userId } = req.params;
  const { roomId } = req.query;

  const match = Array.from(peers.values()).find((peer) => {
    return peer.userId === userId && (!roomId || peer.roomId === roomId);
  });

  res.json({ peer: match || null });
});

app.get('/events/:peerId', (req, res) => {
  const { peerId } = req.params;
  const { roomId } = req.query;
  const key = peerKey(roomId, peerId);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  safeWrite(res, ':ok\n\n');

  if (!sseClients.has(key)) sseClients.set(key, new Set());
  sseClients.get(key).add(res);

  const keepAlive = setInterval(() => safeWrite(res, ':keepalive\n\n'), 15000);

  const cleanup = () => {
    clearInterval(keepAlive);
    const set = sseClients.get(key);
    if (set) {
      set.delete(res);
      if (set.size === 0) sseClients.delete(key);
    }
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
});

app.post('/signal', (req, res) => {
  const { from, to, toUserId, roomId, type, payload } = req.body;
  if (!from || !roomId || !type) {
    return res.status(400).json({ error: 'from, roomId and type are required' });
  }
  if (!to && !toUserId) {
    return res.status(400).json({ error: 'to or toUserId is required' });
  }

  const recipientUserId = normalizeUserId(toUserId) || resolvePeerUserId(roomId, to);
  const fromUserId = resolvePeerUserId(roomId, from);

  if (payload?.type === 'message_control' && recipientUserId) {
    if (payload.action === 'delete_messages' && Array.isArray(payload.packetIds)) {
      removeInboxEntries(recipientUserId, (entry) => entry.payload?.packetId && payload.packetIds.includes(entry.payload.packetId));
    } else if (payload.action === 'clear_chat' && fromUserId) {
      removeInboxEntries(recipientUserId, (entry) => entry.type === 'app_packet' && entry.fromUserId === fromUserId && entry.toUserId === recipientUserId);
    }
  }

  if (isPersistentAppPacket(type, payload) && recipientUserId) {
    enqueueUserInbox(recipientUserId, {
      id: crypto.randomUUID(),
      from,
      fromUserId,
      toUserId: recipientUserId,
      type,
      payload,
      timestamp: Date.now()
    });
  }

  const targetPeerId = to || findOnlinePeerIdForUser(roomId, recipientUserId);
  if (targetPeerId) {
    const targetKey = peerKey(roomId, targetPeerId);
    const clients = sseClients.get(targetKey);

    if (clients && clients.size > 0) {
      const message = JSON.stringify({ from, type, payload });
      for (const client of clients) {
        safeWrite(client, `data: ${message}\n\n`);
      }
    } else if (!isPersistentAppPacket(type, payload)) {
      const queue = ensurePeerSignalQueue(targetKey);
      queue.push({ from, to: targetPeerId, roomId, type, payload, timestamp: Date.now() });
    }
  }

  res.json({ status: 'queued', persisted: Boolean(recipientUserId && isPersistentAppPacket(type, payload)) });
});

function findOnlinePeerIdForUser(roomId, userId) {
  if (!userId) return null;
  for (const peer of peers.values()) {
    if (peer.roomId === roomId && peer.userId === userId) {
      return peer.peerId;
    }
  }
  return null;
}

app.post('/inbox/pull', (req, res) => {
  const userId = normalizeUserId(req.body?.userId);
  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  const entries = filterInboxForDelivery(userInbox.get(userId) || []);
  userInbox.set(userId, entries);
  saveInboxStore();

  res.json({
    messages: entries.map((entry) => ({
      id: entry.id,
      from: entry.from,
      fromUserId: entry.fromUserId,
      type: entry.type,
      payload: entry.payload,
      timestamp: entry.timestamp
    }))
  });
});

app.post('/inbox/ack', (req, res) => {
  const userId = normalizeUserId(req.body?.userId);
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  const idSet = new Set(ids);
  const list = userInbox.get(userId) || [];
  userInbox.set(userId, list.filter((entry) => !idSet.has(entry.id)));
  saveInboxStore();
  res.json({ status: 'ok', removed: ids.length });
});

app.get('/signal/poll/:peerId', (req, res) => {
  cleanupExpiredPeers();
  const { peerId } = req.params;
  const { roomId } = req.query;
  const key = peerKey(roomId, peerId);
  const queue = ensurePeerSignalQueue(key);
  const messages = queue.splice(0, queue.length);

  res.json({ messages });
});

app.get('/health', (req, res) => {
  cleanupExpiredPeers();
  res.json({
    status: 'ok',
    peers: peers.size,
    rooms: new Set(Array.from(peers.values()).map((peer) => peer.roomId)).size,
    identities: identityStore.size,
    timestamp: Date.now()
  });
});

app.post('/identity/store', (req, res) => {
  const { userId, identityBlob } = req.body;
  if (!userId || !identityBlob) {
    return res.status(400).json({ error: 'userId and identityBlob are required' });
  }
  const normalized = normalizeUserId(userId);
  if (banStore.has(normalized)) {
    return res.status(403).json({ error: 'user is banned' });
  }
  identityStore.set(normalized, { blob: identityBlob, updatedAt: Date.now() });
  saveIdentityStore();
  console.log(`[Identity] Stored for ${normalized}`);
  res.json({ status: 'ok' });
});

app.get('/identity/:userId', (req, res) => {
  const { userId } = req.params;
  const normalized = normalizeUserId(userId);
  const record = identityStore.get(normalized);
  if (!record) {
    return res.status(404).json({ error: 'identity not found' });
  }
  if (banStore.has(normalized)) {
    return res.status(403).json({ error: 'user is banned' });
  }
  res.json({ identityBlob: record.blob, updatedAt: record.updatedAt });
});

// ==================== ADMIN / SUPERUSER ENDPOINTS ====================

function requireSuperuser(req, res) {
  const { userId } = req.body;
  if (!userId || normalizeUserId(userId) !== SUPERUSER_ID) {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  return true;
}

app.post('/admin/users', (req, res) => {
  if (!requireSuperuser(req, res)) return;

  const userList = [];
  for (const [userId, record] of identityStore) {
    const avatarData = record.avatarData || null;
    let displayName = null;
    try {
      const blob = record.blob ? JSON.parse(record.blob) : null;
      displayName = blob?.displayName || null;
    } catch {}
    const online = peers.has(userId);
    userList.push({
      userId,
      displayName,
      hasAvatar: !!avatarData,
      online,
      banned: banStore.has(userId)
    });
  }

  userList.sort((a, b) => a.userId.localeCompare(b.userId));
  res.json({ users: userList });
});

app.post('/admin/ban', (req, res) => {
  if (!requireSuperuser(req, res)) return;

  const { targetUserId } = req.body;
  if (!targetUserId) return res.status(400).json({ error: 'targetUserId required' });

  const normalized = normalizeUserId(targetUserId);
  if (!normalized || normalized === SUPERUSER_ID) {
    return res.status(400).json({ error: 'cannot ban superuser' });
  }

  banStore.add(normalized);
  saveBanStore();
  console.log(`[Admin] Banned ${normalized}`);
  res.json({ status: 'ok', banned: normalized });
});

app.post('/admin/unban', (req, res) => {
  if (!requireSuperuser(req, res)) return;

  const { targetUserId } = req.body;
  if (!targetUserId) return res.status(400).json({ error: 'targetUserId required' });

  const normalized = normalizeUserId(targetUserId);
  banStore.delete(normalized);
  saveBanStore();
  console.log(`[Admin] Unbanned ${normalized}`);
  res.json({ status: 'ok', unbanned: normalized });
});

app.get('/admin/check-banned/:userId', (req, res) => {
  const normalized = normalizeUserId(req.params.userId);
  res.json({ banned: normalized ? banStore.has(normalized) : false });
});

app.post('/admin/invite/create', (req, res) => {
  if (!requireSuperuser(req, res)) return;

  const code = `inv-${crypto.randomUUID().slice(0, 12)}`;
  inviteStore.set(code, { usedBy: null, createdBy: SUPERUSER_ID, createdAt: Date.now() });
  saveInviteStore();
  console.log(`[Admin] Created invite code ${code}`);
  res.json({ status: 'ok', code });
});

app.post('/admin/invite/use', (req, res) => {
  const { code, userId } = req.body;
  if (!code || !userId) return res.status(400).json({ error: 'code and userId required' });

  const invite = inviteStore.get(code);
  if (!invite) return res.status(404).json({ error: 'invite code not found' });
  if (invite.usedBy) return res.status(400).json({ error: 'invite code already used' });

  const normalized = normalizeUserId(userId);
  if (!normalized) return res.status(400).json({ error: 'invalid userId' });

  invite.usedBy = normalized;
  invite.usedAt = Date.now();
  inviteStore.set(code, invite);
  saveInviteStore();
  console.log(`[Admin] Invite code ${code} used by ${normalized}`);
  res.json({ status: 'ok' });
});

// ==================== CONTACTS ====================

app.post('/contacts/save', (req, res) => {
  const { userId, contacts } = req.body;
  if (!userId || !Array.isArray(contacts)) {
    return res.status(400).json({ error: 'userId and contacts array are required' });
  }
  contactStore.set(userId, contacts);
  saveContactStore();
  res.json({ status: 'ok', count: contacts.length });
});

app.get('/contacts/load/:userId', (req, res) => {
  const { userId } = req.params;
  const contacts = contactStore.get(userId) || [];
  res.json({ contacts });
});

function isGroupId(id) {
  return id && typeof id === 'string' && id.startsWith('#');
}

const GROUP_MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

app.post('/groups/create', (req, res) => {
  const { groupId, name, avatarData, createdBy, members } = req.body;
  if (!groupId || !createdBy) {
    return res.status(400).json({ error: 'groupId and createdBy are required' });
  }

  const memberList = Array.isArray(members) ? [...members] : [];
  if (!memberList.some((m) => m.userId === createdBy)) {
    memberList.push({ userId: createdBy, role: 'admin', addedAt: Date.now() });
  }

  const group = {
    groupId,
    name: name || 'Unnamed Group',
    avatarData: avatarData || null,
    createdBy,
    members: memberList,
    createdAt: Date.now()
  };

  groupStore.set(groupId, group);
  saveGroupStore();
  console.log(`[Groups] Created ${groupId} by ${createdBy}`);

  for (const member of memberList) {
    enqueueUserInbox(normalizeUserId(member.userId), {
      id: crypto.randomUUID(),
      type: 'app_packet',
      payload: { type: 'group_event', action: 'created', groupId, name: group.name, createdBy },
      timestamp: Date.now()
    });
  }

  res.json({ status: 'ok', group });
});

app.post('/groups/add-members', (req, res) => {
  const { groupId, members, addedBy } = req.body;
  const group = groupStore.get(groupId);
  if (!group) return res.status(404).json({ error: 'group not found' });

  const added = [];
  for (const m of (members || [])) {
    if (m.userId && !group.members.some((ex) => ex.userId === m.userId)) {
      group.members.push({ userId: m.userId, role: m.role || 'member', addedAt: Date.now() });
      added.push(m.userId);
    }
  }

  if (added.length) {
    groupStore.set(groupId, group);
    saveGroupStore();
    console.log(`[Groups] Added members to ${groupId}: ${added.join(', ')}`);
  }

  res.json({ status: 'ok', added, group });
});

app.get('/groups/:userId', (req, res) => {
  const { userId } = req.params;
  const userGroups = [];
  for (const group of groupStore.values()) {
    if (group.members.some((m) => m.userId === userId)) {
      userGroups.push(group);
    }
  }
  res.json({ groups: userGroups });
});

app.post('/groups/leave', (req, res) => {
  const { groupId, userId } = req.body;
  if (!groupId || !userId) {
    return res.status(400).json({ error: 'groupId and userId are required' });
  }

  const group = groupStore.get(groupId);
  if (!group) return res.status(404).json({ error: 'group not found' });

  const idx = group.members.findIndex((m) => m.userId === userId);
  if (idx === -1) return res.status(400).json({ error: 'not a group member' });

  group.members.splice(idx, 1);

  if (group.members.length === 0) {
    groupStore.delete(groupId);
    saveGroupStore();
    console.log(`[Groups] Deleted empty group ${groupId} after last member left`);
    return res.json({ status: 'ok', deleted: true });
  }

  groupStore.set(groupId, group);
  saveGroupStore();
  console.log(`[Groups] ${userId} left group ${groupId}`);

  for (const member of group.members) {
    enqueueUserInbox(normalizeUserId(member.userId), {
      id: crypto.randomUUID(),
      type: 'app_packet',
      payload: {
        type: 'group_event',
        action: 'member_left',
        groupId,
        userId,
        timestamp: Date.now()
      },
      timestamp: Date.now()
    });
  }

  res.json({ status: 'ok', deleted: false });
});

app.post('/groups/delete', (req, res) => {
  const { groupId, userId } = req.body;
  if (!groupId || !userId) {
    return res.status(400).json({ error: 'groupId and userId are required' });
  }

  const group = groupStore.get(groupId);
  if (!group) return res.status(404).json({ error: 'group not found' });

  const adminMembers = group.members.filter((m) => m.role === 'admin');
  const isAdmin = adminMembers.some((m) => m.userId === userId);
  if (!isAdmin) {
    return res.status(403).json({ error: 'only admins can delete the group' });
  }

  const memberIds = group.members.map((m) => m.userId);

  groupStore.delete(groupId);
  saveGroupStore();
  console.log(`[Groups] Deleted ${groupId} by ${userId}`);

  for (const memberId of memberIds) {
    const inbox = userInbox.get(normalizeUserId(memberId));
    if (inbox) {
      const filtered = inbox.filter((entry) => entry.groupId !== groupId);
      if (filtered.length !== inbox.length) {
        userInbox.set(normalizeUserId(memberId), filtered);
      }
    }

    enqueueUserInbox(normalizeUserId(memberId), {
      id: crypto.randomUUID(),
      type: 'app_packet',
      payload: {
        type: 'group_event',
        action: 'deleted',
        groupId,
        deletedBy: userId,
        timestamp: Date.now()
      },
      timestamp: Date.now()
    });
  }
  saveInboxStore();

  res.json({ status: 'ok' });
});

app.get('/group/:groupId', (req, res) => {
  const group = groupStore.get(req.params.groupId);
  if (!group) return res.status(404).json({ error: 'group not found' });
  res.json({ group });
});

app.post('/groups/message', (req, res) => {
  const { groupId, fromUserId, packet } = req.body;
  if (!groupId || !packet) {
    return res.status(400).json({ error: 'groupId and packet are required' });
  }

  const group = groupStore.get(groupId);
  if (!group) return res.status(404).json({ error: 'group not found' });

  if (!group.members.some((m) => m.userId === fromUserId)) {
    return res.status(403).json({ error: 'not a group member' });
  }

  const perRecipient = packet.perRecipient || {};
  const messageId = crypto.randomUUID();
  let deliveredCount = 0;

  for (const member of group.members) {
    if (member.userId === fromUserId) continue;

    const recipientCrypto = perRecipient[member.userId];
    if (!recipientCrypto) {
      console.warn(`[Groups] Skipping ${member.userId} because group message is not encrypted for them`);
      continue;
    }

    const memberPayload = { ...packet };
    delete memberPayload.perRecipient;
    memberPayload.content = recipientCrypto.content;
    memberPayload.iv = recipientCrypto.iv;
    memberPayload.encrypted = true;

    enqueueUserInbox(normalizeUserId(member.userId), {
      id: messageId,
      groupId,
      fromUserId: fromUserId || null,
      type: 'app_packet',
      payload: memberPayload,
      timestamp: Date.now()
    });
    deliveredCount += 1;
  }

  if (deliveredCount === 0) {
    return res.status(400).json({ error: 'No group recipients could be encrypted' });
  }

  res.json({ status: 'ok', messageId, deliveredCount });
});

app.post('/groups/delete-messages', (req, res) => {
  const { groupId, userId, packetIds } = req.body;
  if (!groupId || !Array.isArray(packetIds) || !packetIds.length) {
    return res.status(400).json({ error: 'groupId and packetIds array are required' });
  }

  const group = groupStore.get(groupId);
  if (!group) return res.status(404).json({ error: 'group not found' });

  if (!group.members.some((m) => m.userId === userId)) {
    return res.status(403).json({ error: 'not a group member' });
  }

  const pidSet = new Set(packetIds);

  for (const member of group.members) {
    const inbox = userInbox.get(normalizeUserId(member.userId));
    if (!inbox) continue;
    const filtered = inbox.filter((entry) => !(entry.payload?.packetId && pidSet.has(entry.payload.packetId)));
    if (filtered.length !== inbox.length) {
      userInbox.set(normalizeUserId(member.userId), filtered);
    }
    // Deliver deletion signal so online clients also remove locally
    enqueueUserInbox(normalizeUserId(member.userId), {
      type: 'app_packet',
      id: crypto.randomUUID(),
      groupId,
      fromUserId: userId,
      payload: {
        type: 'message_control',
        action: 'delete_messages',
        packetIds,
        senderId: userId,
        recipientId: groupId,
        timestamp: Date.now()
      },
      timestamp: Date.now()
    });
  }
  saveInboxStore();

  res.json({ status: 'ok', removed: packetIds.length });
});

const distDir = path.join(__dirname, 'dist');

app.use((req, res, next) => {
  if (req.path === '/sw.js') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Service-Worker-Allowed', '/');
  }
  if (req.path === '/manifest.webmanifest') {
    res.type('application/manifest+json');
  }
  next();
});

app.use(express.static(distDir));

app.get('*', (req, res, next) => {
  if (req.method !== 'GET') {
    return next();
  }
  res.sendFile(path.join(distDir, 'index.html'), (err) => {
    if (err) {
      if (!path.extname(req.path)) {
        res.status(404).type('text/plain').send('Build the app (npm run build) so dist/index.html exists, or use Vite dev on another port.');
      } else {
        next(err);
      }
    }
  });
});

const PORT = process.env.PORT || 8877;
server.listen(PORT, () => {
  console.log(`[Tract Signaling] listening on http://0.0.0.0:${PORT}`);
  console.log(`[Tract] Static (if built): ${distDir}`);
});

setInterval(cleanupExpiredPeers, 5000);
