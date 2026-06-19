// Native mesh transport — active ONLY inside the Tract iOS app shell, where a
// Swift MultipeerConnectivity layer carries packets device-to-device over
// peer-to-peer Wi-Fi + Bluetooth with NO internet and NO server.
//
// It conforms to the Multiplexer transport interface (name / send / onMessage).
// Every packet the app sends is already E2E-encrypted to the recipient's key, so
// we simply flood it to all nearby devices and let only the real recipient
// decrypt it. That flood-and-filter IS the mesh — exactly the manifesto's
// "каждое устройство — узел", no central point to capture.
//
// Bridge contract with the Swift side (see ios/Tract/WebView.swift):
//   JS → native:  window.webkit.messageHandlers.tractMesh.postMessage({ kind, ... })
//   native → JS:  window.__tractMeshDeliver(packetJson, fromPeerId)
//                 window.__tractMeshPeers(connectedCount)
export class NativeMeshTransport {
  name = 'NativeMesh';

  constructor() {
    this.onMessageCallback = null;
    this.onPeerCallback = null;
    this._peerCount = 0;

    // Incoming packet from a nearby device. Swift base64-encodes the UTF-8 JSON
    // (base64 is safe inside a JS string literal — no escaping pitfalls).
    window.__tractMeshDeliverB64 = (b64, fromPeerId) => {
      if (!this.onMessageCallback) return;
      try {
        const bin = atob(b64);
        const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        const json = new TextDecoder().decode(bytes);
        this.onMessageCallback(JSON.parse(json), fromPeerId || 'mesh');
      } catch (e) {
        console.warn('[NativeMesh] deliver decode failed:', e);
      }
    };

    // Connected-peer count updates (so the app knows the mesh is usable).
    window.__tractMeshPeers = (count) => {
      this._peerCount = Number(count) || 0;
    };

    // A nearby device was discovered: its app userId, public key and name. Lets
    // the app add them as a contact (with the key needed for E2E) without a server.
    window.__tractMeshPeer = (uid, publicKeyHex, name) => {
      if (this.onPeerCallback && uid) this.onPeerCallback({ userId: uid, publicKeyHex, displayName: name });
    };
  }

  // True only when running inside the native shell that injected the bridge.
  static isAvailable() {
    return !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.tractMesh);
  }

  // Tell the native layer who we are so it can advertise us to nearby devices.
  identify(userId, displayName, publicKeyHex) {
    this._post({
      kind: 'identify',
      userId: userId || '',
      displayName: displayName || '',
      publicKeyHex: publicKeyHex || ''
    });
  }

  isConnected() { return this._peerCount > 0; }
  peerCount() { return this._peerCount; }

  onMessage(cb) { this.onMessageCallback = cb; }
  onPeer(cb) { this.onPeerCallback = cb; }

  async send(packet, targetPeerId) {
    // targetPeerId is ignored on purpose: the mesh floods, the crypto filters.
    this._post({ kind: 'send', to: targetPeerId || '', packet: JSON.stringify(packet) });
  }

  _post(msg) {
    const bridge = window.webkit?.messageHandlers?.tractMesh;
    if (!bridge) throw new Error('native mesh bridge unavailable');
    bridge.postMessage(msg);
  }
}
