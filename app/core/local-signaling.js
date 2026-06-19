export class HostedSignaling {
  constructor(peerId, options = {}) {
    this.peerId = peerId;
    this.options = options;
    this.serverUrl = options.serverUrl;
    this.roomId = options.roomId;
    this.listeners = new Map();
    this.pollTimer = null;
    this.heartbeatTimeout = null;
    this.heartbeatFailureCount = 0;
    this.eventSource = null;
    this.stopped = false;
  }

  async start() {
    await this.register();
    this.startEventSource();
    this.startPolling();
    this.startPresence();
    this.bindLifecycle();
  }

  async register() {
    await this.post('/peer/register', {
      peerId: this.peerId,
      roomId: this.roomId,
      userId: this.options.userId,
      displayName: this.options.displayName,
      deviceId: this.options.deviceId || null,
      publicKeyHex: this.options.publicKeyHex || null,
      avatarData: this.options.avatarData || null,
      hideOnline: this.options.hideOnline || false,
      lastSeen: this.options.lastSeen || null
    });
  }

  startPolling() {
    this.pollTimer = setInterval(() => {
      this.pollSignals().catch((error) => {
        console.warn('Signal polling failed:', error);
      });
    }, DEFAULT_POLL_INTERVAL);

    this.pollSignals().catch((error) => {
      console.warn('Initial signal poll failed:', error);
    });
  }

  startPresence() {
    // Initial heartbeat schedule – runs immediately on start
    this.scheduleHeartbeat();
  }

  scheduleHeartbeat() {
    // Clear any existing timeout
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = null;
    }
    this.post('/peer/heartbeat', {
      peerId: this.peerId,
      roomId: this.roomId,
      displayName: this.options.displayName,
      publicKeyHex: this.options.publicKeyHex || null,
      hideOnline: this.options.hideOnline || false,
      lastSeen: this.options.hideOnline ? null : Date.now()
    })
    .then(() => {
      // Heartbeat succeeded – update UI to online
      if (typeof window !== 'undefined' && window.setConnectionHealth) {
        window.setConnectionHealth('online');
      }
      // Schedule next heartbeat at 5‑second interval
      this.heartbeatTimeout = setTimeout(() => this.scheduleHeartbeat(), 5000);
    })
    .catch((error) => {
      console.warn('Heartbeat failed:', error);
      this.heartbeatFailureCount++;
      // Exponential back‑off – up to 30 s maximum
      const delay = Math.min(5000 * Math.pow(2, this.heartbeatFailureCount), 30000);
      this.heartbeatTimeout = setTimeout(() => this.scheduleHeartbeat(), delay);
      if (typeof window !== 'undefined' && window.setConnectionHealth) {
        window.setConnectionHealth('error');
      }
    });
  }

  async post(path, body) {
    const response = await fetch(new URL(path, this.serverUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`Request failed: ${response.status}`);
    }

    return response;
  }

  async listPeers() {
    const url = new URL('/peers/discover', this.serverUrl);
    url.searchParams.set('roomId', this.roomId);
    url.searchParams.set('peerId', this.peerId);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Peer discovery failed: ${response.status}`);
    }

    const { peers = [] } = await response.json();
    return peers;
  }

  async findPeerByUserId(userId) {
    const url = new URL(`/peers/by-user/${encodeURIComponent(userId)}`, this.serverUrl);
    url.searchParams.set('roomId', this.roomId);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Peer lookup failed: ${response.status}`);
    }

    const { peer } = await response.json();
    return peer;
  }

  async sendSignal(to, type, payload, meta = {}) {
    const body = {
      from: this.peerId,
      to: to || undefined,
      roomId: this.roomId,
      type,
      payload
    };
    if (meta.toUserId) {
      body.toUserId = meta.toUserId;
    }
    await this.post('/signal', body);
  }

  async pullInbox(userId) {
    const response = await fetch(new URL('/inbox/pull', this.serverUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId })
    });
    if (!response.ok) {
      throw new Error(`Inbox pull failed: ${response.status}`);
    }
    return response.json();
  }

  async ackInbox(userId, ids) {
    if (!ids?.length) return;
    await this.post('/inbox/ack', { userId, ids });
  }

  pollNow() {
    return this.pollSignals();
  }

  onSignal(type, callback) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type).add(callback);
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.pollTimer);
    clearTimeout(this.heartbeatTimeout);
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    await this.post('/peer/unregister', {
      peerId: this.peerId,
      roomId: this.roomId
    }).catch(() => {});
  }
}

let globalSignaling = null;

export async function initSignaling(peerId, options) {
  if (
    !globalSignaling ||
    globalSignaling.stopped ||
    globalSignaling.peerId !== peerId ||
    globalSignaling.serverUrl !== options.serverUrl ||
    globalSignaling.roomId !== options.roomId
  ) {
    if (globalSignaling) {
      await globalSignaling.stop();
    }

    globalSignaling = new HostedSignaling(peerId, options);
    await globalSignaling.start();
  }

  return globalSignaling;
}

export function getSignaling() {
  return globalSignaling;
}