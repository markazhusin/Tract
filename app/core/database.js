export class MessageDatabase {
  constructor() {
    this.db = null;
  }

  async initDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('TractDB', 3);

      request.onerror = () => reject(request.error);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        if (db.objectStoreNames.contains('messages')) {
          db.deleteObjectStore('messages');
        }

        if (db.objectStoreNames.contains('contacts')) {
          db.deleteObjectStore('contacts');
        }

        if (db.objectStoreNames.contains('settings')) {
          db.deleteObjectStore('settings');
        }

        const messageStore = db.createObjectStore('messages', {
          keyPath: 'id',
          autoIncrement: true
        });
        messageStore.createIndex('chatId', 'chatId', { unique: false });
        messageStore.createIndex('timestamp', 'timestamp', { unique: false });

        db.createObjectStore('contacts', { keyPath: 'id' });
        db.createObjectStore('settings', { keyPath: 'key' });
      };

      request.onsuccess = () => resolve(request.result);
    });
  }

  async getDB() {
    if (!this.db) {
      this.db = await this.initDB();
    }
    return this.db;
  }

  async saveMessage(packet, chatId, isSent, meta = {}) {
    const db = await this.getDB();
    const transaction = db.transaction(['messages'], 'readwrite');
    const store = transaction.objectStore('messages');
    const message = {
      ...packet,
      chatId,
      isSent,
      isOutgoing: meta.isOutgoing ?? Boolean(isSent),
      timestamp: packet.timestamp || Date.now()
    };

    return new Promise((resolve, reject) => {
      const request = store.add(message);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getMessages(chatId) {
    const db = await this.getDB();
    const transaction = db.transaction(['messages'], 'readonly');
    const store = transaction.objectStore('messages');
    const index = store.index('chatId');

    return new Promise((resolve, reject) => {
      const request = index.getAll(chatId);
      request.onsuccess = () => resolve(request.result.sort((a, b) => a.timestamp - b.timestamp));
      request.onerror = () => reject(request.error);
    });
  }

  async hasMessagePacket(packetId) {
    if (!packetId) return false;
    const db = await this.getDB();
    const transaction = db.transaction(['messages'], 'readonly');
    const store = transaction.objectStore('messages');

    return new Promise((resolve, reject) => {
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(false);
          return;
        }
        if (cursor.value?.packetId === packetId) {
          resolve(true);
          return;
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  }

  async getUndeliveredMessages(chatId) {
    const all = await this.getMessages(chatId);
    return all.filter((m) => m.isOutgoing && !m.isSent);
  }

  async markMessageSent(messageId) {
    const db = await this.getDB();
    const transaction = db.transaction(['messages'], 'readwrite');
    const store = transaction.objectStore('messages');

    return new Promise((resolve, reject) => {
      const req = store.get(messageId);
      req.onsuccess = () => {
        const msg = req.result;
        if (!msg) return resolve(false);
        msg.isSent = true;
        const putReq = store.put(msg);
        putReq.onsuccess = () => resolve(true);
        putReq.onerror = () => reject(putReq.error);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async deleteMessages(messageIds) {
    if (!messageIds?.length) return;
    const db = await this.getDB();
    const transaction = db.transaction(['messages'], 'readwrite');
    const store = transaction.objectStore('messages');

    await Promise.all(messageIds.map((id) => new Promise((resolve, reject) => {
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    })));
  }

  async deleteMessagesByPacketIds(chatId, packetIds) {
    const ids = new Set((packetIds || []).filter(Boolean));
    if (!ids.size) return;
    const messages = await this.getMessages(chatId);
    const localIds = messages
      .filter((message) => ids.has(message.packetId))
      .map((message) => message.id)
      .filter((id) => id !== undefined);
    await this.deleteMessages(localIds);
  }

  async deleteChat(chatId) {
    const db = await this.getDB();
    const transaction = db.transaction(['messages'], 'readwrite');
    const store = transaction.objectStore('messages');
    const index = store.index('chatId');

    return new Promise((resolve, reject) => {
      const request = index.openCursor(IDBKeyRange.only(chatId));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        cursor.delete();
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  }

  async saveContact(contactId, contactData) {
    const db = await this.getDB();
    const transaction = db.transaction(['contacts'], 'readwrite');
    const store = transaction.objectStore('contacts');
    const contact = {
      id: contactId,
      updatedAt: Date.now(),
      ...contactData
    };

    return new Promise((resolve, reject) => {
      const request = store.put(contact);
      request.onsuccess = () => resolve(contact);
      request.onerror = () => reject(request.error);
    });
  }

  async getContacts() {
    const db = await this.getDB();
    const transaction = db.transaction(['contacts'], 'readonly');
    const store = transaction.objectStore('contacts');

    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async deleteContact(contactId) {
    const db = await this.getDB();
    const transaction = db.transaction(['contacts'], 'readwrite');
    const store = transaction.objectStore('contacts');

    return new Promise((resolve, reject) => {
      const request = store.delete(contactId);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async saveSetting(key, value) {
    const db = await this.getDB();
    const transaction = db.transaction(['settings'], 'readwrite');
    const store = transaction.objectStore('settings');

    return new Promise((resolve, reject) => {
      const request = store.put({ key, value });
      request.onsuccess = () => resolve(value);
      request.onerror = () => reject(request.error);
    });
  }

  async getSetting(key) {
    const db = await this.getDB();
    const transaction = db.transaction(['settings'], 'readonly');
    const store = transaction.objectStore('settings');

    return new Promise((resolve, reject) => {
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result?.value);
      request.onerror = () => reject(request.error);
    });
  }
}

export const messageDB = new MessageDatabase();
