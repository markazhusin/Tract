export class Multiplexer {
  constructor(keyPair) { 
    this.keyPair = keyPair; 
    this.transports = new Map();
    this.onMessageCallback = null;
  }
  
  register(t) { 
    this.transports.set(t.name, t); 
    
    // Если transport поддерживает onMessage, регистрируем callback
    if (typeof t.onMessage === 'function') {
      t.onMessage((packet, peerId) => {
        if (this.onMessageCallback) {
          this.onMessageCallback(packet, peerId);
        }
      });
    }
    
    console.log(`+ ${t.name}`); 
  }
  
  onMessage(callback) {
    this.onMessageCallback = callback;
  }
  
  async send(p, targetPeerId) {
    // Never log message content — only the packet type/action.
    const preview = `[${p?.type ?? 'msg'}${p?.action ? `:${p.action}` : ''}]`;
    console.log('Отправка:', preview);
    let lastError = null;

    const transports = [...this.transports.values()];
    if (p?.type === 'text' || p?.type === 'call' || p?.type === 'message_control') {
      transports.sort((a, b) => {
        if (a.name === 'Signaling') return -1;
        if (b.name === 'Signaling') return 1;
        return 0;
      });
    }

    for (const t of transports) {
      try {
        await t.send(p, targetPeerId);
        return;
      } catch (e) {
        lastError = e;
      }
    }

    throw lastError || new Error('No transport delivered the packet');
  }
}
