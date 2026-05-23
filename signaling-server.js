import http from 'http';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IDENTITY_STORE_PATH = path.join(__dirname, 'data', 'identity-store.json');

const app = express();
const server = http.createServer(app);
const peers = new Map();
const signalingChannels = new Map();
const sseClients = new Map(); // key (roomId:peerId) -> Set<res>
const identityStore = new Map();
const PEER_TTL_MS = 15000;

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

function ensureQueue(key) {
  if (!signalingChannels.has(key)) {
    signalingChannels.set(key, []);
  }
  return signalingChannels.get(key);
}

function safeWrite(res, data) {
  try { res.write(data); } catch (e) { /* client may have disconnected */ }
}

function cleanupExpiredPeers() {
  const now = Date.now();
  for (const [key, peer] of peers) {
    if (now - peer.timestamp <= PEER_TTL_MS) continue;
    peers.delete(key);
    signalingChannels.delete(key);
    console.log(`[Signaling] Timeout: ${peer.roomId}/${peer.peerId}`);
  }
}

app.post('/peer/register', (req, res) => {
  const { peerId, roomId, userId, displayName, avatarData, hideOnline, lastSeen } = req.body;
  if (!peerId || !roomId || !userId) {
    return res.status(400).json({ error: 'peerId, roomId and userId are required' });
  }

  const key = peerKey(roomId, peerId);
  peers.set(key, {
    peerId,
    roomId,
    userId,
    displayName: displayName || userId,
    avatar: avatarData || null,
    hideOnline: Boolean(hideOnline),
    lastSeen: hideOnline ? null : (lastSeen || null),
    address: req.socket.remoteAddress,
    timestamp: Date.now()
  });
  ensureQueue(key);

  res.json({ status: 'ok' });
});

app.post('/peer/heartbeat', (req, res) => {
  const { peerId, roomId, displayName, avatarData, hideOnline, lastSeen } = req.body;
  const key = peerKey(roomId, peerId);
  const peer = peers.get(key);

  if (!peer) {
    return res.status(404).json({ error: 'peer not found' });
  }

  peer.timestamp = Date.now();
  if (displayName) peer.displayName = displayName;
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
  signalingChannels.delete(key);
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
  const { from, to, roomId, type, payload } = req.body;
  if (!from || !to || !roomId || !type) {
    return res.status(400).json({ error: 'from, to, roomId and type are required' });
  }

  const targetKey = peerKey(roomId, to);
  const clients = sseClients.get(targetKey);

  if (clients && clients.size > 0) {
    const message = JSON.stringify({ from, type, payload });
    for (const client of clients) {
      safeWrite(client, `data: ${message}\n\n`);
    }
  } else {
    // Fallback: queue for HTTP polling
    const queue = ensureQueue(targetKey);
    queue.push({
      from,
      to,
      roomId,
      type,
      payload,
      timestamp: Date.now()
    });
  }

  res.json({ status: 'queued' });
});

app.get('/signal/poll/:peerId', (req, res) => {
  cleanupExpiredPeers();
  const { peerId } = req.params;
  const { roomId } = req.query;
  const key = peerKey(roomId, peerId);
  const queue = ensureQueue(key);
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
  identityStore.set(userId, { blob: identityBlob, updatedAt: Date.now() });
  saveIdentityStore();
  console.log(`[Identity] Stored for ${userId}`);
  res.json({ status: 'ok' });
});

app.get('/identity/:userId', (req, res) => {
  const { userId } = req.params;
  const record = identityStore.get(userId);
  if (!record) {
    return res.status(404).json({ error: 'identity not found' });
  }
  res.json({ identityBlob: record.blob, updatedAt: record.updatedAt });
});

const distDir = path.join(__dirname, 'dist');
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
