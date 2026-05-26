const CACHE = 'tract-pwa-v2';
const PRECACHE = ['/manifest.webmanifest', '/icons/icon.svg', '/icons/badge.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // For icons/manifest — cache-first (rarely changes)
  if (url.pathname.startsWith('/icons/') || url.pathname === '/manifest.webmanifest') {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
    return;
  }

  // Cache a response only if it's valid
  const cacheResponse = (response) => {
    if (!response || response.type === 'error' || response.status >= 400) return;
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(event.request, copy));
  };

  // For HTML — network-first (always fresh)
  if (url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(
      fetch(event.request).then((response) => {
        cacheResponse(response);
        return response;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // For everything else (JS, CSS, etc.) — network-first with cache fallback
  event.respondWith(
    fetch(event.request).then((response) => {
      cacheResponse(response);
      return response;
    }).catch(() => caches.match(event.request))
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const chatId = event.notification.data?.chatId;
  const targetUrl = chatId
    ? `${self.registration.scope}?chat=${encodeURIComponent(chatId)}`
    : self.registration.scope;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        client.postMessage({ type: 'OPEN_CHAT', chatId: chatId || null });
        if ('focus' in client) return client.focus();
      }
      return clients.openWindow(targetUrl);
    })
  );
});

self.addEventListener('message', (event) => {
  const { type, count } = event.data || {};
  if (type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (type !== 'BADGE' || !('setAppBadge' in navigator)) return;
  if (count > 0) {
    navigator.setAppBadge(Math.min(count, 99)).catch(() => {});
  } else {
    navigator.clearAppBadge().catch(() => {});
  }
});
