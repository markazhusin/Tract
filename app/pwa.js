const NOTIFICATIONS_KEY = 'tract.notifications.enabled';
const ICON = '/icons/icon.svg';
const BADGE = '/icons/badge.svg';

let swRegistration = null;
let swUpdateCheckTimer = null;
let isBusyFn = () => false;     // returns true when a reload would be disruptive (e.g. active call)
let pendingWorker = null;       // installed-but-waiting worker, applied when safe
let reloadingForUpdate = false; // guards against a double reload

const SW_UPDATE_INTERVAL = 300000; // 5min

export function initPwa({ onOpenChat, isBusy } = {}) {
  if (typeof isBusy === 'function') isBusyFn = isBusy;

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      swRegistration = reg;

      // A worker may already be waiting from a previous visit.
      if (reg.waiting && navigator.serviceWorker.controller) {
        handleSwUpdate(reg.waiting);
      }

      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            handleSwUpdate(worker);
          }
        });
      });

      swUpdateCheckTimer = setInterval(() => {
        reg.update().catch(() => {});
      }, SW_UPDATE_INTERVAL);
    }).catch((err) => console.warn('[PWA] service worker:', err));

    // Reload exactly once, when the new worker takes control.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloadingForUpdate) return;
      reloadingForUpdate = true;
      window.location.reload();
    });

    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'OPEN_CHAT' && event.data.chatId) {
        onOpenChat?.(event.data.chatId);
      }
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // App backgrounded — the safest moment to apply a pending update.
      applyPendingUpdateIfSafe();
    } else {
      syncNotificationsToggle();
      swRegistration?.update().catch(() => {});
    }
  });
}

// Tell the waiting worker to activate. controllerchange then triggers the reload.
function activateWorker(worker) {
  if (!worker) return;
  worker.postMessage({ type: 'SKIP_WAITING' });
}

function applyPendingUpdateIfSafe() {
  if (!pendingWorker) return;
  if (isBusyFn()) return; // never interrupt a call or other critical activity
  const worker = pendingWorker;
  pendingWorker = null;
  hideUpdateToast();
  activateWorker(worker);
}

function hideUpdateToast() {
  const toast = document.getElementById('swUpdateToast');
  if (toast) toast.classList.remove('visible');
}

function handleSwUpdate(worker) {
  if (!worker) return;
  pendingWorker = worker;

  // Offer the update; the user can apply it immediately by tapping the toast.
  const toast = document.getElementById('swUpdateToast');
  if (toast) {
    toast.classList.add('visible');
    const applyNow = (e) => {
      e?.stopPropagation?.();
      const w = pendingWorker;
      pendingWorker = null;
      hideUpdateToast();
      activateWorker(w);
    };
    toast.onclick = applyNow;
    const btn = toast.querySelector('.sw-update-btn');
    if (btn) btn.onclick = applyNow;
  }

  // Otherwise the update is applied the next time the app is backgrounded
  // (see the visibilitychange handler) or on the next launch — never as a
  // surprise reload in the active window, and never during a call.
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
