import { initSignaling } from '../core/local-signaling.js';

const DISCOVERY_INTERVAL = 1000;

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

export class WebRTCTransport {
  name = 'WebRTC';
  peers = new Map();
  voicePeers = new Map();
  discoveredPeers = new Set();
  onlinePeers = new Set();
  peerDirectory = new Map();
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

    this.signaling.onSignal('voice_offer', ({ from, payload }) => {
      this.handleVoiceOffer(from, payload).catch((err) => {
        console.error('Voice offer error:', err);
      });
    });

    this.signaling.onSignal('voice_answer', ({ from, payload }) => {
      this.handleVoiceAnswer(from, payload).catch((err) => {
        console.error('Voice answer error:', err);
      });
    });

    this.signaling.onSignal('voice_ice', ({ from, payload }) => {
      this.handleVoiceIce(from, payload).catch((err) => {
        console.warn('Voice ICE error:', err);
      });
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
      if (!this.discoveredPeers.has(peer.peerId)) {
        this.discoveredPeers.add(peer.peerId);
      }

      if (!this.onlinePeers.has(peer.peerId)) {
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
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    const peerState = {
      pc,
      channel: null,
      connected: false,
      iceCandidates: []
    };

    this.peers.set(peerId, peerState);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signaling.sendSignal(peerId, 'ice', event.candidate).catch((error) => {
          console.warn('ICE send failed:', error);
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        peerState.connected = true;
      }
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
        this.closePeer(peerId);
      }
    };

    return peerState;
  }

  getOrCreateVoicePeer(peerId) {
    let voice = this.voicePeers.get(peerId);
    if (voice) return voice;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    voice = {
      pc,
      localStream: null,
      pendingIce: [],
      pendingRemoteOffer: null,
      offerWaiters: []
    };

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      this.signaling.sendSignal(peerId, 'voice_ice', event.candidate.toJSON()).catch(() => {});
    };

    pc.ontrack = (event) => {
      const track = event.track;
      if (!track || track.kind !== 'audio') return;
      const stream = event.streams[0] || new MediaStream([track]);
      track.enabled = true;
      this.onRemoteAudioStreamCallback?.(peerId, stream);
      track.addEventListener('unmute', () => {
        this.onRemoteAudioStreamCallback?.(peerId, stream);
      }, { once: true });
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        this.emitVoiceRemoteAudio(peerId);
      }
    };

    this.voicePeers.set(peerId, voice);
    return voice;
  }

  notifyVoiceOfferWaiters(voice) {
    const waiters = voice.offerWaiters.splice(0);
    for (const resolve of waiters) resolve(true);
  }

  waitForVoiceOffer(voice, timeoutMs = 2500) {
    if (voice.pendingRemoteOffer) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => resolve(false), timeoutMs);
      voice.offerWaiters.push(() => {
        window.clearTimeout(timer);
        resolve(true);
      });
    });
  }

  async getLocalAudioStream() {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false
      });
    } catch (error) {
      console.warn('Audio constraints not supported, retrying:', error);
      return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    }
  }

  attachLocalAudioToVoicePeer(voice) {
    if (voice.localStream) return voice.localStream;
    throw new Error('Local audio stream missing');
  }

  async addLocalAudioToVoicePeer(peerId) {
    const voice = this.getOrCreateVoicePeer(peerId);
    if (voice.localStream) return voice.localStream;

    const stream = await this.getLocalAudioStream();
    voice.localStream = stream;
    for (const track of stream.getAudioTracks()) {
      voice.pc.addTrack(track, stream);
    }
    return stream;
  }

  async flushVoiceIce(voice) {
    const pending = voice.pendingIce.splice(0);
    for (const candidate of pending) {
      try {
        await voice.pc.addIceCandidate(candidate);
      } catch (err) {
        console.warn('Voice ICE add error:', err);
      }
    }
  }

  emitVoiceRemoteAudio(peerId) {
    const voice = this.voicePeers.get(peerId);
    if (!voice?.pc) return;

    const receivers = voice.pc.getReceivers?.() || [];
    for (const receiver of receivers) {
      const track = receiver.track;
      if (track?.kind === 'audio' && track.readyState !== 'ended') {
        this.onRemoteAudioStreamCallback?.(peerId, new MediaStream([track]));
        return;
      }
    }
  }

  async applyVoiceRemoteOffer(voice, peerId, sdp) {
    const offer = new RTCSessionDescription({ type: 'offer', sdp });
    if (voice.pc.signalingState === 'have-local-offer') {
      await voice.pc.setLocalDescription({ type: 'rollback' });
    }
    await voice.pc.setRemoteDescription(offer);
    await this.flushVoiceIce(voice);
  }

  async handleVoiceOffer(peerId, sdp) {
    const voice = this.getOrCreateVoicePeer(peerId);
    voice.pendingRemoteOffer = sdp;
    this.notifyVoiceOfferWaiters(voice);

    if (voice.localStream) {
      await this.applyVoiceRemoteOffer(voice, peerId, sdp);
      const answer = await voice.pc.createAnswer();
      await voice.pc.setLocalDescription(answer);
      await this.signaling.sendSignal(peerId, 'voice_answer', voice.pc.localDescription.sdp);
      queueMicrotask(() => this.emitVoiceRemoteAudio(peerId));
    }
  }

  async handleVoiceAnswer(peerId, sdp) {
    const voice = this.voicePeers.get(peerId);
    if (!voice) return;

    if (voice.pc.signalingState !== 'have-local-offer') {
      return;
    }

    await voice.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
    await this.flushVoiceIce(voice);
    queueMicrotask(() => this.emitVoiceRemoteAudio(peerId));
  }

  async handleVoiceIce(peerId, candidate) {
    const voice = this.voicePeers.get(peerId);
    if (!voice) return;

    const ice = new RTCIceCandidate(candidate);
    if (!voice.pc.remoteDescription) {
      voice.pendingIce.push(ice);
      return;
    }

    try {
      await voice.pc.addIceCandidate(ice);
    } catch (err) {
      console.warn('Voice ICE add error:', err);
    }
  }

  expectVoiceAnswer(peerId) {
    this.getOrCreateVoicePeer(peerId);
  }

  refreshRemoteAudio(peerId) {
    this.emitVoiceRemoteAudio(peerId);
  }

  async startAudioCallWithLocalMedia(peerId, { asOfferer }) {
    await this.ready;
    const voice = this.getOrCreateVoicePeer(peerId);
    await this.addLocalAudioToVoicePeer(peerId);

    if (asOfferer) {
      const offer = await voice.pc.createOffer();
      await voice.pc.setLocalDescription(offer);
      await this.signaling.sendSignal(peerId, 'voice_offer', voice.pc.localDescription.sdp);
      return;
    }

    const gotOffer = await this.waitForVoiceOffer(voice, 2500);
    if (gotOffer && voice.pendingRemoteOffer) {
      await this.applyVoiceRemoteOffer(voice, peerId, voice.pendingRemoteOffer);
      voice.pendingRemoteOffer = null;
      const answer = await voice.pc.createAnswer();
      await voice.pc.setLocalDescription(answer);
      await this.signaling.sendSignal(peerId, 'voice_answer', voice.pc.localDescription.sdp);
      queueMicrotask(() => this.emitVoiceRemoteAudio(peerId));
      return;
    }

    const offer = await voice.pc.createOffer();
    await voice.pc.setLocalDescription(offer);
    await this.signaling.sendSignal(peerId, 'voice_offer', voice.pc.localDescription.sdp);
  }

  async stopLocalAudio(peerId) {
    this.closeVoicePeer(peerId);
  }

  setLocalMicMuted(peerId, muted) {
    const voice = this.voicePeers.get(peerId);
    if (!voice?.localStream) return;
    for (const track of voice.localStream.getAudioTracks()) {
      track.enabled = !muted;
    }
  }

  closeVoicePeer(peerId) {
    const voice = this.voicePeers.get(peerId);
    if (!voice) return;

    try {
      for (const track of voice.localStream?.getTracks?.() || []) {
        track.stop();
      }
    } catch {}

    try {
      voice.pc.close();
    } catch {}

    this.voicePeers.delete(peerId);
  }

  async connectToPeer(peerId) {
    if (this.peers.has(peerId)) return;

    const peerState = this.createPeerConnection(peerId);
    const channel = peerState.pc.createDataChannel('tract', { ordered: true });
    this.setupDataChannel(channel, peerId);

    try {
      const offer = await peerState.pc.createOffer();
      await peerState.pc.setLocalDescription(offer);
      await this.signaling.sendSignal(peerId, 'offer', offer.sdp);
    } catch (err) {
      console.error('WebRTC initiate error:', err);
      this.closePeer(peerId);
    }
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

  async handleRemoteOffer(peerId, sdp) {
    const existingPeer = this.peers.get(peerId);
    const peerState = existingPeer || this.createPeerConnection(peerId);

    if (!existingPeer) {
      peerState.pc.ondatachannel = (event) => {
        this.setupDataChannel(event.channel, peerId);
      };
    }

    try {
      if (peerState.pc.signalingState === 'have-local-offer') {
        await peerState.pc.setLocalDescription({ type: 'rollback' });
      }

      await peerState.pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
      await this.flushIceCandidates(peerState);
      const answer = await peerState.pc.createAnswer();
      await peerState.pc.setLocalDescription(answer);
      await this.signaling.sendSignal(peerId, 'answer', peerState.pc.localDescription.sdp);
    } catch (err) {
      console.error('WebRTC offer handling error:', err);
      if (!peerState.pc.remoteDescription) {
        this.closePeer(peerId);
      }
    }
  }

  async handleRemoteAnswer(peerId, sdp) {
    const peer = this.peers.get(peerId);
    if (!peer || peer.pc.signalingState !== 'have-local-offer') return;

    try {
      await peer.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
      await this.flushIceCandidates(peer);
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
      console.warn('ICE add error:', err);
    }
  }

  setupDataChannel(channel, peerId) {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.channel = channel;
    }

    channel.onopen = () => {
      if (peer) peer.connected = true;
      this.onPeerConnectedCallback?.(peerId);
    };

    channel.onclose = () => {
      if (peer) peer.connected = false;
    };

    channel.onmessage = (event) => {
      try {
        const packet = JSON.parse(event.data);
        this.onMessageCallback?.(packet, peerId);
      } catch (err) {
        console.error('Failed to parse message:', err);
      }
    };

    channel.onerror = (err) => {
      console.error('DataChannel error:', err);
    };
  }

  async send(packet, targetPeerId) {
    await this.ready;

    if (!targetPeerId) {
      for (const peerId of this.peers.keys()) {
        await this.send(packet, peerId);
      }
      return;
    }

    const existingPeer = this.peers.get(targetPeerId);
    if (existingPeer?.channel?.readyState === 'open') {
      existingPeer.channel.send(JSON.stringify(packet));
      return;
    }

    if (existingPeer?.channel?.readyState === 'connecting') {
      const peer = await this.waitForOpenPeer(targetPeerId, 500);
      if (peer) {
        peer.channel.send(JSON.stringify(packet));
        return;
      }
    }

    if (!this.peers.has(targetPeerId) && this.onlinePeers.has(targetPeerId)) {
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
      if (peer?.channel?.readyState === 'open') {
        return peer;
      }
      if (!this.peers.has(peerId) && this.onlinePeers.has(peerId)) {
        this.connectToPeer(peerId);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return null;
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
    for (const peerId of Array.from(this.voicePeers.keys())) {
      this.closeVoicePeer(peerId);
    }
    for (const peerId of Array.from(this.peers.keys())) {
      this.closePeer(peerId);
    }
    await this.signaling?.stop?.();
  }

  closePeer(peerId) {
    this.closeVoicePeer(peerId);
    const peer = this.peers.get(peerId);
    if (!peer) return;

    try {
      peer.channel?.close();
    } catch {}

    try {
      peer.pc?.close();
    } catch {}

    this.peers.delete(peerId);
  }
}
