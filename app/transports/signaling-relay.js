import { initSignaling } from '../core/local-signaling.js';

export class SignalingRelayTransport {
  name = 'Signaling';
  onMessageCallback = null;

  constructor(myPeerId, options) {
    this.myPeerId = myPeerId;
    this.options = options;
    this.ready = this.initialize();
  }

  async initialize() {
    this.signaling = await initSignaling(this.myPeerId, this.options);
    this.signaling.onSignal('app_packet', ({ from, payload }) => {
      try {
        this.onMessageCallback?.(payload, from);
      } catch (e) {
        console.warn('Signaling relay onMessage handler error:', e);
      }
    });
  }

  onMessage(cb) {
    this.onMessageCallback = cb;
  }

  async send(packet, targetPeerId, toUserId = null) {
    await this.ready;
    const recipientUserId = toUserId || packet.recipientId || packet.toUserId || null;
    if (!targetPeerId && !recipientUserId) {
      throw new Error('Signaling relay requires targetPeerId or toUserId');
    }
    await this.signaling.sendSignal(targetPeerId || '', 'app_packet', packet, {
      toUserId: recipientUserId
    });
  }

  async stop() {
    // nothing specific to stop for signaling
  }
}
