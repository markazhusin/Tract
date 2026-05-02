import http from 'http';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const server = http.createServer(app);
const peers = new Map();
const signalingChannels = new Map();
const PEER_TTL_MS = 15000;

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
  const { peerId, roomId, userId, displayName } = req.body;
  if (!peerId || !roomId || !userId) {
    return res.status(400).json({ error: 'peerId, roomId and userId are required' });
  }

  const key = peerKey(roomId, peerId);
  peers.set(key, {
    peerId,
    roomId,
    userId,
    displayName: displayName || userId,
    address: req.socket.remoteAddress,
    timestamp: Date.now()
  });
  ensureQueue(key);

  res.json({ status: 'ok' });
});

app.post('/peer/heartbeat', (req, res) => {
  const { peerId, roomId, displayName } = req.body;
  const key = peerKey(roomId, peerId);
  const peer = peers.get(key);

  if (!peer) {
    return res.status(404).json({ error: 'peer not found' });
  }

  peer.timestamp = Date.now();
  if (displayName) {
    peer.displayName = displayName;
  }
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

app.post('/signal', (req, res) => {
  const { from, to, roomId, type, payload } = req.body;
  if (!from || !to || !roomId || !type) {
    return res.status(400).json({ error: 'from, to, roomId and type are required' });
  }

  const targetKey = peerKey(roomId, to);
  const queue = ensureQueue(targetKey);
  queue.push({
    from,
    to,
    roomId,
    type,
    payload,
    timestamp: Date.now()
  });

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
    timestamp: Date.now()
  });
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
