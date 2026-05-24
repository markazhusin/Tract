const NOTIFICATIONS_KEY = 'tract.notifications.enabled';
const ICON = '/icons/icon.svg';
const BADGE = '/icons/badge.svg';

let swRegistration = null;

export function initPwa({ onOpenChat } = {}) {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      swRegistration = reg;
      if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            worker.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      });
    }).catch((err) => console.warn('[PWA] service worker:', err));

    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'OPEN_CHAT' && event.data.chatId) {
        onOpenChat?.(event.data.chatId);
      }
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) syncNotificationsToggle();
  });
}

export function isNotificationsEnabled() {
  return localStorage.getItem(NOTIFICATIONS_KEY) === 'true';
}

export function getNotificationPermission() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

export async function setNotificationsEnabled(enabled) {
  if (!enabled) {
    localStorage.setItem(NOTIFICATIONS_KEY, 'false');
    syncNotificationsToggle();
    return { ok: true };
  }

  if (!('Notification' in window)) {
    return { ok: false, reason: 'unsupported' };
  }

  let permission = Notification.permission;
  if (permission === 'default') {
    permission = await Notification.requestPermission();
  }

  if (permission !== 'granted') {
    localStorage.setItem(NOTIFICATIONS_KEY, 'false');
    syncNotificationsToggle();
    return { ok: false, reason: permission };
  }

  localStorage.setItem(NOTIFICATIONS_KEY, 'true');
  syncNotificationsToggle();
  return { ok: true };
}

export async function updatePwaBadge(count) {
  const total = Math.max(0, Number(count) || 0);
  const badgeCount = total > 99 ? 99 : total;

  try {
    if ('setAppBadge' in navigator) {
      if (badgeCount > 0) await navigator.setAppBadge(badgeCount);
      else await navigator.clearAppBadge();
    }
  } catch {
    /* ignore */
  }

  const reg = swRegistration || (await navigator.serviceWorker?.getRegistration?.());
  reg?.active?.postMessage({ type: 'BADGE', count: badgeCount });
}

export async function notifyNewMessage({ chatId, title, body }) {
  if (!isNotificationsEnabled()) return;
  if (Notification.permission !== 'granted') return;
  if (!document.hidden && document.hasFocus()) return;

  const options = {
    body: body || 'Новое сообщение',
    tag: `tract-chat-${chatId}`,
    renotify: true,
    icon: ICON,
    badge: BADGE,
    data: { chatId }
  };

  try {
    const reg = swRegistration || (await navigator.serviceWorker?.ready);
    if (reg?.showNotification) {
      await reg.showNotification(title || 'Tract', options);
      return;
    }
  } catch {
    /* fallback below */
  }

  try {
    new Notification(title || 'Tract', options);
  } catch (err) {
    console.warn('[PWA] notification:', err);
  }
}

export function syncNotificationsToggle() {
  const toggle = document.getElementById('notificationsToggle');
  const label = document.getElementById('notificationsStatusLabel');
  if (!toggle) return;

  const supported = 'Notification' in window;
  const enabled = supported && isNotificationsEnabled() && Notification.permission === 'granted';
  toggle.checked = enabled;
  toggle.disabled = !supported;

  if (label) {
    if (!supported) label.textContent = 'Не поддерживается';
    else if (Notification.permission === 'denied') label.textContent = 'Запрещено в браузере';
    else if (enabled) label.textContent = 'Включены';
    else label.textContent = 'Выключены';
  }
}
