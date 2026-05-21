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
    const preview =
      p?.type === 'text' ? p.content : `[${p?.type ?? 'msg'}${p?.action ? `:${p.action}` : ''}]`;
    console.log('Отправка:', preview);
    let lastError = null;

    for (const t of this.transports.values()) {
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
