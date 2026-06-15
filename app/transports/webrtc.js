import { initSignaling } from '../core/local-signaling.js';

const DISCOVERY_INTERVAL = 1000;

// Default ICE config. Multiple STUN for candidate discovery + public TURN relays
// (OpenRelay/Metered) so calls still connect through VPNs, symmetric NAT and
// restrictive firewalls. TURN over TCP/TLS on 443 punches through almost anything.
// For production privacy, run your own coturn and supply it via the server /ice
// endpoint (env) or the ?ice= URL param.
const DEFAULT_ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.relay.metered.ca:80' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
];

// Mutable cache — replaced by server-provided TURN (self-hosted coturn) when available.
let cachedIceServers = DEFAULT_ICE_SERVERS;

function parseIceParam() {
  const out = [];
  try {
    const params = new URLSearchParams(window.location.search);
    const iceParam = params.get('ice');
    if (iceParam) {
      for (const entry of iceParam.split(',')) {
        const trimmed = entry.trim();
        if (!trimmed) continue;
        if (trimmed.includes('turn:')) {
          const parts = trimmed.replace('turn:', '').split('@');
          if (parts.length === 2) {
            const [credentials, host] = parts;
            const [username, credential] = credentials.split(':');
            out.push({ urls: `turn:${host}`, username, credential });
          }
        } else {
          out.push({ urls: trimmed });
        }
      }
    }
  } catch {}
  return out;
}

function getIceServers() {
  const override = parseIceParam();
  if (override.length) return override;
  return cachedIceServers;
}

// Fetch self-hosted TURN from the signaling server (set via env). Merged on top of
// the public defaults so calls prefer the operator's relay but keep fallbacks.
async function loadIceServersFromServer(serverUrl) {
  if (!serverUrl) return;
  try {
    const resp = await fetch(new URL('/ice', serverUrl), { signal: AbortSignal.timeout?.(4000) });
    if (!resp.ok) return;
    const data = await resp.json();
    if (Array.isArray(data.iceServers) && data.iceServers.length) {
      cachedIceServers = [...data.iceServers, ...DEFAULT_ICE_SERVERS];
    }
  } catch {}
}

export class WebRTCTransport {
  name = 'WebRTC';
  peers = new Map();
  discoveredPeers = new Set();
  onlinePeers = new Set();
  peerDirectory = new Map();
  peerMetaFingerprints = new Map();
  onMessageCallback = null;
  onPeerDiscoveryCallback = null;
  onPeerOfflineCallback = null;
  onPeerConnectedCallback = null;
  onRemoteAudioStreamCallback = null;
  discoveryTimer = null;

  constructor(myPeerId, options) {
    this.myPeerId = myPeerId;
    this.options = options;
    this.ready = this.initialize();
  }

  async initialize() {
    // Load operator-provided TURN (self-hosted coturn) before any call setup.
    await loadIceServersFromServer(this.options?.serverUrl);
    this.signaling = await initSignaling(this.myPeerId, this.options);
    this.registerSignalingListeners();
    await this.refreshPeers();
    this.startPeerDiscovery();
  }

  registerSignalingListeners() {
    this.signaling.onSignal('offer', ({ from, payload }) => {
      this.handleRemoteOffer(from, payload);
    });

    this.signaling.onSignal('answer', ({ from, payload }) => {
      this.handleRemoteAnswer(from, payload);
    });

    this.signaling.onSignal('ice', ({ from, payload }) => {
      this.handleIceCandidate(from, payload);
    });
  }

  startPeerDiscovery() {
    this.discoveryTimer = setInterval(() => {
      this.refreshPeers().catch((error) => {
        console.warn('Peer refresh failed:', error);
      });
    }, DISCOVERY_INTERVAL);
  }

  async refreshPeers() {
    const peers = (await this.signaling.listPeers()).filter((peer) => this.isAllowedPeer(peer));
    const nextOnline = new Set(peers.map((peer) => peer.peerId));

    for (const peer of peers) {
      this.peerDirectory.set(peer.peerId, peer);

      const fp = JSON.stringify({ hideOnline: peer.hideOnline, lastSeen: peer.lastSeen, displayName: peer.displayName, avatar: peer.avatar });
      const prevFp = this.peerMetaFingerprints.get(peer.peerId);

      if (!this.discoveredPeers.has(peer.peerId)) {
        this.discoveredPeers.add(peer.peerId);
        this.peerMetaFingerprints.set(peer.peerId, fp);
        this.onPeerDiscoveryCallback?.(peer.peerId, peer);
      } else if (fp !== prevFp) {
        this.peerMetaFingerprints.set(peer.peerId, fp);
        this.onPeerDiscoveryCallback?.(peer.peerId, peer);
      }

      this.onlinePeers.add(peer.peerId);
      if (this.shouldInitiateConnection(peer.peerId) && !this.peers.has(peer.peerId)) {
        this.connectToPeer(peer.peerId);
      }
    }

    for (const peerId of Array.from(this.onlinePeers)) {
      if (nextOnline.has(peerId)) continue;
      this.onlinePeers.delete(peerId);
      this.peerMetaFingerprints.delete(peerId);
      const peerMeta = this.peerDirectory.get(peerId);
      this.peerDirectory.delete(peerId);
      this.closePeer(peerId);
      this.onPeerOfflineCallback?.(peerId, peerMeta);
    }
  }

  isAllowedPeer(peer) {
    const allowed = this.options.allowedUserIds;
    if (!allowed || allowed.size === 0) return false;
    return allowed.has(peer.userId);
  }

  setAllowedUserIds(userIds) {
    this.options.allowedUserIds = new Set(userIds || []);
    this.refreshPeers().catch((error) => {
      console.warn('Allowed peer refresh failed:', error);
    });
  }

  shouldInitiateConnection(peerId) {
    return this.myPeerId > peerId;
  }

  createPeerConnection(peerId) {
    const pc = new RTCPeerConnection({
      iceServers: getIceServers(),
      iceCandidatePoolSize: 4,
      // Gather both UDP and relayed candidates so VPN/symmetric-NAT peers connect.
      bundlePolicy: 'max-bundle'
    });

    const peerState = {
      pc,
      channel: null,
      connected: false,
      iceCandidates: [],
      audioTransceiver: null,
      localAudioStream: null,
      // Perfect Negotiation state.
      // The peer with the lexicographically smaller id is "polite": on a glare
      // collision it yields (rolls back its own offer); the impolite peer ignores
      // the incoming offer and keeps its own. This deterministic split removes the
      // intermittent-connect and one-way-silence bugs caused by both sides rolling back.
      polite: this.myPeerId < peerId,
      makingOffer: false,
      ignoreOffer: false
    };

    this.peers.set(peerId, peerState);

    // Single source of truth for (re)negotiation. Adding the data channel or an
    // audio track fires this automatically; we never craft offers by hand anymore.
    pc.onnegotiationneeded = async () => {
      try {
        peerState.makingOffer = true;
        await pc.setLocalDescription();
        await this.signaling.sendSignal(peerId, 'offer', pc.localDescription.sdp);
      } catch (err) {
        console.error('Negotiation offer failed:', err);
      } finally {
        peerState.makingOffer = false;
      }
    };

    pc.ontrack = (event) => {
      const track = event.track;
      if (!track || track.kind !== 'audio') return;

      console.log('[call] remote audio track received from', peerId);
      let stream = event.streams[0];
      if (!stream) {
        stream = new MediaStream([track]);
      }

      const emit = () => this.emitRemoteAudioStream(peerId, stream);
      emit();
      track.addEventListener('unmute', () => emit(), { once: true });
      track.addEventListener('ended', () => {
        queueMicrotask(() => this.emitRemoteAudioStream(peerId));
      }, { once: true });
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signaling.sendSignal(peerId, 'ice', event.candidate).catch((error) => {
          console.warn('ICE send failed:', error);
        });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('[call] connection state', peerId, '→', pc.connectionState);
      if (pc.connectionState === 'connected') {
        peerState.connected = true;
      }

      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
        this.closePeer(peerId);
      }
    };

    return peerState;
  }

  // Kept for API compatibility: ensure a peer connection exists so an incoming
  // audio offer has somewhere to land. Actual receive direction is negotiated
  // automatically once a remote audio track arrives.
  expectVoiceAnswer(peerId) {
    if (!this.peers.has(peerId) && this.onlinePeers.has(peerId)) {
      this.createPeerConnection(peerId);
    }
  }

  extractRemoteAudioStream(peerState) {
    if (!peerState?.pc) return null;

    const receivers = peerState.pc.getReceivers?.() || [];
    for (const receiver of receivers) {
      const track = receiver.track;
      if (track?.kind === 'audio' && track.readyState !== 'ended') {
        return new MediaStream([track]);
      }
    }

    return null;
  }

  emitRemoteAudioStream(peerId, stream = null) {
    const peerState = this.peers.get(peerId);
    if (!peerState) return;
    const resolved = stream || this.extractRemoteAudioStream(peerState);
    if (resolved) {
      this.onRemoteAudioStreamCallback?.(peerId, resolved);
    }
  }

  refreshRemoteAudio(peerId) {
    this.emitRemoteAudioStream(peerId);
  }

  // Acquire the local microphone and attach it to the peer connection.
  //
  // We deliberately reuse a SINGLE audio transceiver per peer (one m-line) and
  // only flip it to sendrecv via replaceTrack. Using addTrack on both sides would
  // create two competing audio m-lines and was the cause of one-way / no audio.
  // Reusing the transceiver guarantees one shared bidirectional audio stream.
  // onnegotiationneeded then renegotiates; Perfect Negotiation handles any glare.
  // Idempotent.
  async enableLocalAudio(peerId) {
    const peerState = this.peers.get(peerId);
    if (!peerState?.pc) throw new Error('No peer connection');

    const liveTrack = peerState.localAudioStream?.getAudioTracks?.()
      .find((t) => t.readyState === 'live');
    if (liveTrack && peerState.audioTransceiver?.sender?.track) {
      return; // already streaming mic
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: false
    }).catch(() => navigator.mediaDevices.getUserMedia({ audio: true, video: false }));

    peerState.localAudioStream = stream;
    const track = stream.getAudioTracks()[0];
    console.log('[call] local mic acquired for', peerId, '— track:', track?.label || 'audio');

    // Find an existing audio transceiver: our own, or one auto-created when the
    // remote peer's audio offer arrived first.
    let tr = peerState.audioTransceiver;
    if (!tr) {
      tr = peerState.pc.getTransceivers().find((t) => {
        if (t.currentDirection === 'stopped') return false;
        const kind = t.receiver?.track?.kind || t.sender?.track?.kind;
        return kind === 'audio' || (t.mid != null && t.receiver?.track?.kind === 'audio');
      });
    }

    if (tr) {
      await tr.sender.replaceTrack(track);
      try { tr.sender.setStreams(stream); } catch {}
      tr.direction = 'sendrecv';
    } else {
      tr = peerState.pc.addTransceiver(track, { direction: 'sendrecv', streams: [stream] });
    }
    peerState.audioTransceiver = tr;
  }

  async startAudioCallWithLocalMedia(peerId, { asOfferer }) {
    await this.ready;

    if (!this.peers.has(peerId)) {
      if (!this.onlinePeers.has(peerId)) {
        throw new Error('Peer not online');
      }
      const peerState = this.createPeerConnection(peerId);
      if (asOfferer) {
        // Creating the data channel triggers onnegotiationneeded → initial offer.
        const channel = peerState.pc.createDataChannel('tract', { ordered: true });
        this.setupDataChannel(channel, peerId);
      } else {
        peerState.pc.ondatachannel = (event) => {
          this.setupDataChannel(event.channel, peerId);
        };
      }
    }

    const peerState = await this.waitForPeerState(peerId, 12000);
    if (!peerState?.pc) {
      throw new Error('Peer connection not ready');
    }

    // Both sides enable their mic up front. Perfect Negotiation resolves the
    // simultaneous renegotiation cleanly, so audio flows in both directions.
    await this.enableLocalAudio(peerId);
  }

  // Retained for API compatibility (main.js calls it after a delay). Now idempotent:
  // enableLocalAudio already ran for both roles, so this is a safety net.
  async addLocalMic(peerId) {
    await this.enableLocalAudio(peerId);
  }

  async stopLocalAudio(peerId) {
    await this.ready;
    const peerState = this.peers.get(peerId);
    if (!peerState) return;

    if (peerState.localAudioStream) {
      for (const t of peerState.localAudioStream.getTracks()) {
        t.stop();
      }
      peerState.localAudioStream = null;
    }

    if (peerState.audioTransceiver?.sender) {
      try {
        await peerState.audioTransceiver.sender.replaceTrack(null);
      } catch (e) {
        console.warn('stopLocalAudio sender:', e);
      }
    }
  }

  setLocalMicMuted(peerId, muted) {
    const peerState = this.peers.get(peerId);
    if (!peerState?.localAudioStream) return;
    for (const track of peerState.localAudioStream.getAudioTracks()) {
      track.enabled = !muted;
    }
  }

  async waitForPeerState(peerId, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const peerState = this.peers.get(peerId);
      if (peerState && peerState.pc) {
        return peerState;
      }
      await new Promise((r) => setTimeout(r, 30));
    }
    return this.peers.get(peerId);
  }

  connectToPeer(peerId) {
    if (this.peers.has(peerId)) return;

    const peerState = this.createPeerConnection(peerId);
    // Creating the data channel fires onnegotiationneeded, which sends the offer.
    const channel = peerState.pc.createDataChannel('tract', { ordered: true });
    this.setupDataChannel(channel, peerId);
  }

  async flushIceCandidates(peerState) {
    const pending = peerState.iceCandidates;
    peerState.iceCandidates = [];
    for (const candidate of pending) {
      try {
        await peerState.pc.addIceCandidate(candidate);
      } catch (err) {
        console.warn('ICE add error:', err);
      }
    }
  }

  // Perfect Negotiation: a single offer/answer handler for both the initial
  // handshake and every later renegotiation (adding audio, etc.).
  async handleRemoteOffer(peerId, sdp) {
    const existingPeer = this.peers.get(peerId);
    const peerState = existingPeer || this.createPeerConnection(peerId);
    const pc = peerState.pc;

    if (!existingPeer) {
      peerState.pc.ondatachannel = (event) => {
        this.setupDataChannel(event.channel, peerId);
      };
    }

    // A collision is an incoming offer while we are mid-offer or not stable.
    const offerCollision = peerState.makingOffer || pc.signalingState !== 'stable';
    peerState.ignoreOffer = !peerState.polite && offerCollision;
    if (peerState.ignoreOffer) {
      // Impolite peer keeps its own offer; the polite side will roll back instead.
      return;
    }

    try {
      // setRemoteDescription performs an implicit rollback for the polite peer
      // when there is a pending local offer, so glare resolves automatically.
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
      await this.flushIceCandidates(peerState);
      await pc.setLocalDescription(); // creates the answer
      await this.signaling.sendSignal(peerId, 'answer', pc.localDescription.sdp);
      queueMicrotask(() => this.emitRemoteAudioStream(peerId));
    } catch (err) {
      console.error('WebRTC answer error:', err);
      if (!existingPeer) this.closePeer(peerId);
    }
  }

  async handleRemoteAnswer(peerId, sdp) {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    // Ignore stray answers that don't match a pending local offer.
    if (peer.pc.signalingState !== 'have-local-offer') return;

    try {
      await peer.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
      await this.flushIceCandidates(peer);
      queueMicrotask(() => this.emitRemoteAudioStream(peerId));
    } catch (err) {
      console.error('WebRTC answer apply error:', err);
    }
  }

  async handleIceCandidate(peerId, candidate) {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    const iceCandidate = new RTCIceCandidate(candidate);
    if (!peer.pc.remoteDescription) {
      peer.iceCandidates.push(iceCandidate);
      return;
    }

    try {
      await peer.pc.addIceCandidate(iceCandidate);
    } catch (err) {
      // Suppress the expected error for a candidate from an offer we intentionally ignored.
      if (!peer.ignoreOffer) {
        console.warn('ICE add error:', err);
      }
    }
  }

  setupDataChannel(channel, peerId) {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.channel = channel;
    }
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      if (peer) {
        peer.connected = true;
      }
      this.onPeerConnectedCallback?.(peerId);
    };

    channel.onclose = () => {
      if (peer) {
        peer.connected = false;
      }
    };

    channel.onmessage = (event) => {
      // Binary frame → a chunk for the active incoming file transfer.
      if (event.data instanceof ArrayBuffer) {
        this.handleFileChunk(peerId, event.data);
        return;
      }
      try {
        const packet = JSON.parse(event.data);
        if (packet && packet.type === 'file_start') {
          this.beginIncomingFile(peerId, packet);
          return;
        }
        if (packet && packet.type === 'file_end') {
          this.finishIncomingFile(peerId, packet);
          return;
        }
        this.onMessageCallback?.(packet, peerId);
      } catch (err) {
        console.error('Failed to parse message:', err);
      }
    };

    channel.onerror = (err) => {
      console.error('DataChannel error:', err);
    };
  }

  // ----- File transfer (P2P, chunked, DTLS-encrypted) -----

  beginIncomingFile(peerId, meta) {
    if (!this._incomingFiles) this._incomingFiles = new Map();
    this._incomingFiles.set(peerId, {
      meta,
      chunks: [],
      received: 0
    });
    this.onFileProgressCallback?.({ peerId, fileId: meta.fileId, name: meta.name, received: 0, total: meta.size, dir: 'in' });
  }

  handleFileChunk(peerId, buffer) {
    const entry = this._incomingFiles?.get(peerId);
    if (!entry) return;
    entry.chunks.push(buffer);
    entry.received += buffer.byteLength;
    this.onFileProgressCallback?.({
      peerId, fileId: entry.meta.fileId, name: entry.meta.name,
      received: entry.received, total: entry.meta.size, dir: 'in'
    });
  }

  finishIncomingFile(peerId, end) {
    const entry = this._incomingFiles?.get(peerId);
    if (!entry) return;
    this._incomingFiles.delete(peerId);
    const blob = new Blob(entry.chunks, { type: entry.meta.mimeType || 'application/octet-stream' });
    this.onFileReceivedCallback?.({
      peerId,
      meta: entry.meta,
      blob
    });
  }

  // Send a File/Blob to a peer in ordered chunks with backpressure.
  async sendFile(peerId, file, meta, onProgress) {
    await this.ready;
    let peer = this.peers.get(peerId);
    if (!peer || !peer.channel || peer.channel.readyState !== 'open') {
      this.connectToPeer(peerId);
      peer = await this.waitForOpenPeer(peerId, 4000);
    }
    if (!peer || !peer.channel || peer.channel.readyState !== 'open') {
      throw new Error('peer-unavailable');
    }
    const channel = peer.channel;
    const CHUNK = 16 * 1024; // 16 KB — safe for SCTP
    const HIGH_WATER = 4 * 1024 * 1024; // pause when buffer exceeds 4 MB
    channel.bufferedAmountLowThreshold = 1024 * 1024;

    const fileId = meta.fileId;
    channel.send(JSON.stringify({
      type: 'file_start',
      fileId,
      name: meta.name,
      size: file.size,
      mimeType: meta.mimeType,
      kind: meta.kind,
      senderId: meta.senderId,
      senderName: meta.senderName,
      timestamp: meta.timestamp
    }));

    let offset = 0;
    while (offset < file.size) {
      const slice = file.slice(offset, offset + CHUNK);
      const buf = await slice.arrayBuffer();
      // Backpressure: wait if the send buffer is too full.
      if (channel.bufferedAmount > HIGH_WATER) {
        await new Promise((resolve) => {
          const handler = () => { channel.removeEventListener('bufferedamountlow', handler); resolve(); };
          channel.addEventListener('bufferedamountlow', handler);
        });
      }
      channel.send(buf);
      offset += buf.byteLength;
      onProgress?.(offset, file.size);
    }

    channel.send(JSON.stringify({ type: 'file_end', fileId }));
  }

  onFileReceived(cb) { this.onFileReceivedCallback = cb; }
  onFileProgress(cb) { this.onFileProgressCallback = cb; }

  async send(packet, targetPeerId) {
    await this.ready;

    if (!targetPeerId) {
      for (const peerId of this.peers.keys()) {
        await this.send(packet, peerId);
      }
      return;
    }

    const existingPeer = this.peers.get(targetPeerId);
    if (existingPeer && existingPeer.channel && existingPeer.channel.readyState === 'open') {
      existingPeer.channel.send(JSON.stringify(packet));
      return;
    }

    if (existingPeer && existingPeer.channel && existingPeer.channel.readyState === 'connecting') {
      const peer = await this.waitForOpenPeer(targetPeerId, 500);
      if (peer) {
        peer.channel.send(JSON.stringify(packet));
        return;
      }
    }

    if (!this.peers.has(targetPeerId)) {
      this.connectToPeer(targetPeerId);
      const peer = await this.waitForOpenPeer(targetPeerId, 500);
      if (peer) {
        peer.channel.send(JSON.stringify(packet));
        return;
      }
    }

    throw new Error(`Peer ${targetPeerId} is not connected`);
  }

  async waitForOpenPeer(peerId, timeoutMs = 500) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const peer = this.peers.get(peerId);
      if (peer && peer.channel && peer.channel.readyState === 'open') {
        return peer;
      }

      // Initiate connection if peer is not yet connected
      if (!this.peers.has(peerId)) {
        this.connectToPeer(peerId);
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const peer = this.peers.get(peerId);
    if (!peer || !peer.channel || peer.channel.readyState !== 'open') {
      return null;
    }
    return peer;
  }

  onMessage(callback) {
    this.onMessageCallback = callback;
  }

  onPeerDiscovery(callback) {
    this.onPeerDiscoveryCallback = callback;
  }

  onPeerOffline(callback) {
    this.onPeerOfflineCallback = callback;
  }

  onPeerConnected(callback) {
    this.onPeerConnectedCallback = callback;
  }

  onRemoteAudioStream(callback) {
    this.onRemoteAudioStreamCallback = callback;
  }

  async findPeerByUserId(userId) {
    await this.ready;
    return this.signaling.findPeerByUserId(userId);
  }

  async stop() {
    clearInterval(this.discoveryTimer);
    for (const peerId of Array.from(this.peers.keys())) {
      this.closePeer(peerId);
    }
    await this.signaling?.stop?.();
  }

  closePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    try {
      if (peer.localAudioStream) {
        for (const t of peer.localAudioStream.getTracks()) {
          t.stop();
        }
      }
    } catch {}

    try {
      peer.channel?.close();
    } catch {}

    try {
      peer.pc?.close();
    } catch {}

    this.peers.delete(peerId);
  }
}
