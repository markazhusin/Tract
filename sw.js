/* Service Worker: receive push/message from page and show notifications / badges */
'use strict';

self.addEventListener('install', (evt) => {
  self.skipWaiting();
});

self.addEventListener('activate', (evt) => {
  evt.waitUntil(self.clients.claim());
});

self.addEventListener('push', (evt) => {
  try {
    const data = evt.data ? evt.data.json() : {};
    const title = data.title || 'Новое сообщение';
    const options = {
      body: data.body || '',
      tag: data.tag || undefined,
      data: data || {},
      renotify: true,
      silent: false
    };
    evt.waitUntil(self.registration.showNotification(title, options));
  } catch (e) {
    console.warn('Push event handling failed', e);
  }
});

self.addEventListener('notificationclick', (evt) => {
  evt.notification.close();
  const targetUrl = evt.notification?.data?.url || '/';
  evt.waitUntil(self.clients.matchAll({ type: 'window' }).then((clients) => {
    for (const client of clients) {
      if (client.url === targetUrl && 'focus' in client) return client.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
  }));
});

self.addEventListener('message', (evt) => {
  const data = evt.data || {};
  if (data && data.type === 'notify') {
    const title = data.title || 'Новое сообщение';
    const options = { body: data.body || '', tag: data.tag || undefined, data: data.data || {} };
    self.registration.showNotification(title, options).catch(() => {});
  }
  if (data && data.type === 'badge') {
    const n = Number(data.count) || 0;
    if (self.registration.setAppBadge) {
      if (n > 0) self.registration.setAppBadge(n).catch(() => {});
      else self.registration.clearAppBadge?.().catch(() => {});
    }
  }
});
