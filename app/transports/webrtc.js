import { initSignaling } from '../core/local-signaling.js';

const DISCOVERY_INTERVAL = 1000;

export class WebRTCTransport {
  name = 'WebRTC';
  peers = new Map();
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
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }]
    });

    const peerState = {
      pc,
      channel: null,
      connected: false,
      iceCandidates: [],
      audioTransceiver: null,
      localAudioStream: null,
      expectVoiceAnswer: false
    };

    peerState.audioTransceiver = pc.addTransceiver('audio', { direction: 'recvonly' });

    pc.ontrack = (event) => {
      const track = event.track;
      if (!track || track.kind !== 'audio') return;

      let stream = event.streams[0];
      if (!stream) {
        stream = new MediaStream([track]);
      }

      const emit = () => this.onRemoteAudioStreamCallback?.(peerId, stream);
      emit();
      track.addEventListener('unmute', () => emit(), { once: true });
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

  expectVoiceAnswer(peerId) {
    const peerState = this.peers.get(peerId);
    if (peerState) {
      peerState.expectVoiceAnswer = true;
    }
  }

  async startAudioCallWithLocalMedia(peerId, { asOfferer }) {
    await this.ready;

    if (!this.peers.has(peerId) && this.onlinePeers.has(peerId)) {
      this.connectToPeer(peerId);
    }

    const peerState = await this.waitForPeerState(peerId, 12000);
    if (!peerState?.pc || !peerState.audioTransceiver) {
      throw new Error('Peer connection not ready for audio');
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: false
    });

    peerState.localAudioStream = stream;
    const track = stream.getAudioTracks()[0];
    await peerState.audioTransceiver.sender.replaceTrack(track);
    try {
      peerState.audioTransceiver.sender.setStreams([stream]);
    } catch (e) {
      console.warn('setStreams:', e);
    }
    peerState.audioTransceiver.direction = 'sendrecv';

    if (asOfferer) {
      const offer = await peerState.pc.createOffer();
      await peerState.pc.setLocalDescription(offer);
      await this.signaling.sendSignal(peerId, 'offer', peerState.pc.localDescription.sdp);
    }
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

    try {
      await peerState.audioTransceiver?.sender.replaceTrack(null);
      if (peerState.audioTransceiver) {
        peerState.audioTransceiver.direction = 'recvonly';
      }
    } catch (e) {
      console.warn('stopLocalAudio replaceTrack:', e);
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
      if (peerState && peerState.pc && peerState.audioTransceiver) {
        return peerState;
      }
      await new Promise((r) => setTimeout(r, 30));
    }
    return this.peers.get(peerId);
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

    if (peerState.pc.remoteDescription) {
      try {
        await peerState.pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));

        if (!peerState.localAudioStream) {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
            video: false
          });
          peerState.localAudioStream = stream;
          await peerState.audioTransceiver.sender.replaceTrack(stream.getAudioTracks()[0]);
          try {
            peerState.audioTransceiver.sender.setStreams([stream]);
          } catch (e) {
            console.warn('setStreams:', e);
          }
          peerState.audioTransceiver.direction = 'sendrecv';
        }

        await this.flushIceCandidates(peerState);

        const answer = await peerState.pc.createAnswer();
        await peerState.pc.setLocalDescription(answer);
        await this.signaling.sendSignal(peerId, 'answer', peerState.pc.localDescription.sdp);
      } catch (err) {
        console.error('WebRTC renegotiation error:', err);
      }
      return;
    }

    try {
      await peerState.pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));

      await this.flushIceCandidates(peerState);

      const answer = await peerState.pc.createAnswer();
      await peerState.pc.setLocalDescription(answer);
      await this.signaling.sendSignal(peerId, 'answer', answer.sdp);
    } catch (err) {
      console.error('WebRTC answer error:', err);
      this.closePeer(peerId);
    }
  }

  async handleRemoteAnswer(peerId, sdp) {
    const peer = this.peers.get(peerId);
    if (!peer) return;

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
      if (peer && peer.channel && peer.channel.readyState === 'open') {
        return peer;
      }

      // Initiate connection if peer is online and not yet connected
      if (!this.peers.has(peerId) && this.onlinePeers.has(peerId)) {
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
