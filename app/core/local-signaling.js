const DEFAULT_POLL_INTERVAL = 1000;
const DEFAULT_PRESENCE_INTERVAL = 1000;

export class HostedSignaling {
  constructor(peerId, options = {}) {
    this.peerId = peerId;
    this.options = options;
    this.serverUrl = options.serverUrl;
    this.roomId = options.roomId;
    this.listeners = new Map();
    this.pollTimer = null;
    this.presenceTimer = null;
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
    this.presenceTimer = setInterval(() => {
      this.post('/peer/heartbeat', {
        peerId: this.peerId,
        roomId: this.roomId,
        displayName: this.options.displayName,
        hideOnline: this.options.hideOnline || false,
        lastSeen: this.options.hideOnline ? null : Date.now()
      }).catch((error) => {
        console.warn('Heartbeat failed:', error);
      });
    }, DEFAULT_PRESENCE_INTERVAL);
  }

  startEventSource() {
    const url = new URL(`/events/${encodeURIComponent(this.peerId)}`, this.serverUrl);
    url.searchParams.set('roomId', this.roomId);
    this.eventSource = new EventSource(url);

    this.eventSource.onmessage = (event) => {
      if (event.data === 'connected' || event.data.startsWith(':')) return;
      try {
        const message = JSON.parse(event.data);
        if (!message || !message.type) return;
        const callbacks = this.listeners.get(message.type);
        if (!callbacks) return;
        for (const cb of callbacks) cb(message);
      } catch (e) {
        console.warn('SSE message error:', e);
      }
    };

    this.eventSource.onerror = () => {
      // EventSource auto-reconnects; polling is backup
    };
  }

  bindLifecycle() {
    const unregister = () => {
      const payload = JSON.stringify({
        peerId: this.peerId,
        roomId: this.roomId
      });
      navigator.sendBeacon?.(`${this.serverUrl}/peer/unregister`, new Blob([payload], {
        type: 'application/json'
      }));
    };

    window.addEventListener('beforeunload', unregister);
    window.addEventListener('pagehide', unregister);
  }

  async pollSignals() {
    if (this.stopped) return;

    const url = new URL(`/signal/poll/${encodeURIComponent(this.peerId)}`, this.serverUrl);
    url.searchParams.set('roomId', this.roomId);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Signal poll failed: ${response.status}`);
    }

    const { messages = [] } = await response.json();
    for (const message of messages) {
      const callbacks = this.listeners.get(message.type);
      if (!callbacks) continue;

      for (const callback of callbacks) {
        callback(message);
      }
    }
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
    clearInterval(this.presenceTimer);
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    await this.post('/peer/unregister', {
      peerId: this.peerId,
      roomId: this.roomId
    }).catch(() => {});
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
