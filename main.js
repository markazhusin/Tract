import QRCode from 'qrcode';
import {
  clearSessionPeerId,
  decryptMessage,
  encryptMessage,
  fetchIdentityFromServer,
  fetchPeerPublicKey,
  getLegacyIdentityMetadata,
  getOrCreateSessionPeerId,
  getPublicKeyHex,
  getStoredIdentityMetadata,
  registerIdentity,
  unlockIdentity,
  updateStoredDisplayName,
  unlockSimpleIdentity,
  uploadIdentityToServer
} from './app/core/keypair.js';
import { Multiplexer } from './app/core/multiplexer.js';
import { getSignaling } from './app/core/local-signaling.js';
import { WebRTCTransport } from './app/transports/webrtc.js';
import { messageDB } from './app/core/database.js';
import {
  initPwa,
  notifyNewMessage,
  setNotificationsEnabled,
  syncNotificationsToggle,
  updatePwaBadge
} from './app/pwa.js';
import {
  initAppLock,
  getLockMode,
  configureLock,
  disableLock
} from './app/core/applock.js';

const SIGNALING_URL_KEY = 'tract.signaling.url';
const ROOM_ID_KEY = 'tract.room.id';
const SESSION_PASSWORD_KEY = 'tract.session.unlockPassword';
const REMEMBER_PASSWORD_KEY = 'tract.session.rememberedPassword';
/** Внутреннее единое пространство. В UI комнат больше нет. */
const DEFAULT_ROOM_ID = 'tract-public';
const SESSION_ID_PATTERN = /^[a-f0-9]{12}-[a-f0-9]{4}$/i;
const LOGIN_PATTERN = /^@[a-z0-9_]{3,32}$/i;

const state = {
  keyPair: null,
  profile: null,
  myPeerId: null,
  transport: null,
  multiplexer: null,
  receivedPacketIds: new Set(),
  currentChatId: null,
  contacts: new Map(),
  groups: new Map(),
  activeCall: null,
  unreadCounts: new Map(),
  micMuted: false,
  selectedMessageIds: new Set(),
  ringTone: null,
  remoteAudioNeedsUnlock: false,
  remoteAudioRetryTimer: null,
  contactFilter: ''
};

function defaultSignalingUrl() {
  if (import.meta.env.DEV) {
    return window.location.origin.replace(/\/$/, '');
  }
  const origin = window.location.origin;
  if (!origin || origin === 'null' || origin.startsWith('file')) {
    return 'http://127.0.0.1:8877';
  }
  return origin.replace(/\/$/, '');
}

function isLocalDevOrigin(origin) {
  return /localhost|127\.0\.0\.1/.test(origin || '');
}

function syncSignalingFromEnvironment() {
  const params = new URLSearchParams(window.location.search);
  const origin = window.location.origin.replace(/\/$/, '');
  const fromInviteSignal = Boolean(params.get('signal'));

  if (!fromInviteSignal) {
    const stored = localStorage.getItem(SIGNALING_URL_KEY);

    if (import.meta.env.DEV) {
      localStorage.setItem(SIGNALING_URL_KEY, origin);
    } else if (isLocalDevOrigin(origin)) {
      const use8877 = !stored || !/127\.0\.0\.1:8877|localhost:8877/.test(stored);
      if (use8877) {
        localStorage.setItem(SIGNALING_URL_KEY, 'http://127.0.0.1:8877');
      }
    } else if (!stored || isLocalDevOrigin(stored)) {
      localStorage.setItem(SIGNALING_URL_KEY, origin);
    }
  }

  let room = localStorage.getItem(ROOM_ID_KEY);
  if (!room && !params.get('room')) {
    room = DEFAULT_ROOM_ID;
    localStorage.setItem(ROOM_ID_KEY, room);
  } else if (room === 'default-room') {
    localStorage.setItem(ROOM_ID_KEY, DEFAULT_ROOM_ID);
  }
}

function resolveSignalingUrl() {
  return (localStorage.getItem(SIGNALING_URL_KEY) || defaultSignalingUrl()).replace(/\/$/, '');
}

function resolveRoomId() {
  return localStorage.getItem(ROOM_ID_KEY) || DEFAULT_ROOM_ID;
}

/**
 * Одна и та же ссылка для всех: без ?signal=&room= — всё подставляется из адреса страницы
 * (туннель Cloudflare или ваш сервер = и есть signaling).
 */
function buildAppShareLink() {
  const u = new URL(window.location.href.split('#')[0]);
  u.search = '';
  return u.href;
}

async function updateInviteArtifacts() {
  syncSignalingFromEnvironment();
  const link = buildAppShareLink();
  const input = $('inviteLink');
  if (input) input.value = link;

  const qr = $('inviteQr');
  const hint = $('inviteHint');
  if (!link) {
    if (qr) qr.removeAttribute('src');
    if (hint) hint.textContent = '';
    return;
  }

  if (hint) hint.textContent = '';
  if (qr) {
    try {
      qr.src = await QRCode.toDataURL(link, {
        width: 196,
        margin: 1,
        color: { dark: '#0a0a0a', light: '#f4f4f4' }
      });
    } catch (e) {
      console.error('QR generation failed:', e);
    }
  }
}

let inboxTimer = null;

async function pullInbox() {
  if (!state.profile || !state.transport?.signaling) return;
  const signaling = state.transport.signaling;
  try {
    const data = await signaling.pullInbox(state.profile.userId);
    const msgs = data?.messages || [];
    if (!msgs.length) return;
    const ackIds = [];
    for (const entry of msgs) {
      if (entry.type !== 'app_packet' || !entry.payload) continue;
      await processIncomingPacket(entry.payload, entry.from);
      if (entry.id) ackIds.push(entry.id);
    }
    if (ackIds.length && signaling.ackInbox) {
      await signaling.ackInbox(state.profile.userId, ackIds);
    }
  } catch (e) {
    console.warn('Inbox pull error:', e);
  }
}

function getTotalUnread() {
  return [...state.unreadCounts.values()].reduce((a, b) => a + b, 0);
}

function refreshDocTitle() {
  const n = getTotalUnread();
  document.title = n > 0 ? `(${n}) Tract` : 'Tract';
  updatePwaBadge(n);
}

function $(id) {
  return document.getElementById(id);
}

function normalizeLogin(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  return raw.startsWith('@') ? raw : `@${raw}`;
}

function isValidLogin(value) {
  return LOGIN_PATTERN.test(value);
}

// Try to play remote audio on any user interaction during a call
document.addEventListener('click', () => {
  if (state.activeCall && state.remoteAudioNeedsUnlock) {
    const peerId = state.activeCall.remotePeerId;
    if (peerId) state.transport?.refreshRemoteAudio?.(peerId);
    tryPlayRemoteAudio(3).catch(() => {});
  }
}, true);

document.addEventListener('touchstart', () => {
  if (state.activeCall && state.remoteAudioNeedsUnlock) {
    const peerId = state.activeCall.remotePeerId;
    if (peerId) state.transport?.refreshRemoteAudio?.(peerId);
    tryPlayRemoteAudio(3).catch(() => {});
  }
}, true);

function stopRemoteAudioRetry() {
  if (state.remoteAudioRetryTimer) {
    window.clearInterval(state.remoteAudioRetryTimer);
    state.remoteAudioRetryTimer = null;
  }
}

async function tryPlayRemoteAudio(maxAttempts = 1) {
  const el = $('remoteAudio');
  if (!el?.srcObject) return false;
  el.muted = false;
  el.volume = 1;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await el.play();
      state.remoteAudioNeedsUnlock = false;
      if (state.activeCall?.status === 'active') updateCallBar();
      return true;
    } catch (e) {
      if (attempt < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 350));
      } else {
        console.warn('Remote audio play:', e);
        state.remoteAudioNeedsUnlock = true;
        if (state.activeCall?.status === 'active') updateCallBar();
      }
    }
  }
  return false;
}

function scheduleRemoteAudioRetry(peerId) {
  stopRemoteAudioRetry();
  if (!state.activeCall || state.activeCall.status !== 'active') return;

  let tries = 0;
  state.remoteAudioRetryTimer = window.setInterval(() => {
    tries += 1;
    if (!state.activeCall || state.activeCall.status !== 'active' || tries > 20) {
      stopRemoteAudioRetry();
      return;
    }
    state.transport?.refreshRemoteAudio?.(peerId);
    tryPlayRemoteAudio(1).then((ok) => {
      if (ok) stopRemoteAudioRetry();
    });
  }, 500);
}

let _remoteAudioStream = null;

async function bindRemoteAudioStream(stream, peerId = null) {
  const el = $('remoteAudio');
  if (!el || !stream) return;

  // Accumulate tracks into a single persistent stream so replacing srcObject
  // doesn't kill playback (browsers may block play() on new stream objects)
  if (!_remoteAudioStream) {
    _remoteAudioStream = new MediaStream();
    el.srcObject = _remoteAudioStream;
  }
  for (const track of stream.getAudioTracks()) {
    if (!_remoteAudioStream.getTrackById(track.id)) {
      _remoteAudioStream.addTrack(track);
    }
  }

  const played = await tryPlayRemoteAudio(6);
  if (!played && state.activeCall?.status === 'active') {
    const audioPeerId = peerId || state.activeCall.remotePeerId;
    if (audioPeerId) scheduleRemoteAudioRetry(audioPeerId);
  }
}

async function playRemoteAudioIfReady(peerId = null) {
  const audioPeerId = peerId || state.activeCall?.remotePeerId;
  if (audioPeerId) {
    state.transport?.refreshRemoteAudio?.(audioPeerId);
  }
  const played = await tryPlayRemoteAudio(4);
  if (!played && state.activeCall?.status === 'active' && audioPeerId) {
    scheduleRemoteAudioRetry(audioPeerId);
  }
  return played;
}

window.unlockRemoteAudio = async () => {
  const peerId = state.activeCall?.remotePeerId
    || state.contacts.get(state.activeCall?.peerUserId || '')?.activePeerId;
  if (peerId) state.transport?.refreshRemoteAudio?.(peerId);
  const played = await tryPlayRemoteAudio(4);
  if (!played) {
    setStatus('warn', 'Нажмите «Включить звук» на панели звонка или разрешите звук для сайта');
  }
};

// ==================== VIEW NAVIGATION ====================
let currentView = 'chats';

window.switchView = (viewName) => {
  const views = ['chats', 'contacts', 'settings'];
  if (!views.includes(viewName)) return;
  
  currentView = viewName;
  
  // Update view visibility
  for (const v of views) {
    const viewElement = $(`view${v.charAt(0).toUpperCase() + v.slice(1)}`);
    const tabBtn = $(`tab${v.charAt(0).toUpperCase() + v.slice(1)}`);
    if (viewElement) {
      viewElement.classList.remove('active', 'prev');
      if (v === viewName) {
        viewElement.classList.add('active');
      } else if (views.indexOf(v) < views.indexOf(viewName)) {
        viewElement.classList.add('prev');
      }
    }
    if (tabBtn) {
      tabBtn.classList.toggle('active', v === viewName);
    }
  }
  
  // Sync profile info to all views
  renderProfileCards();
  updateSettingsPanel();
};

function getContactInitials(displayName) {
  const clean = (displayName || '?').replace(/^@/, '');
  const parts = clean.split(' ');
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase();
}

function getAvatarStorageKey(userId) {
  return `tract.avatar.${userId}`;
}

function getAvatarHistoryStorageKey(userId) {
  return `tract.avatar.history.${userId}`;
}

function getAvatarUrl(userId) {
  if (!userId) return null;
  const contact = state.contacts.get(userId);
  if (contact?.avatarUrl) return contact.avatarUrl;
  return localStorage.getItem(getAvatarStorageKey(userId));
}

function getOriginalAvatarUrl(userId) {
  if (!userId) return null;
  const key = 'tract.avatar.original.' + userId;
  const stored = localStorage.getItem(key);
  if (stored) return stored;
  return getAvatarUrl(userId);
}

const _originalCache = new Map();
async function fetchOriginalFromServer(userId) {
  if (_originalCache.has(userId)) return _originalCache.get(userId);
  const serverUrl = resolveSignalingUrl();
  if (!serverUrl) return null;
  try {
    const res = await fetch(new URL('/profile/avatar/' + encodeURIComponent(userId), serverUrl).toString());
    if (!res.ok) return null;
    const data = await res.json();
    const original = data.avatarOriginal || data.avatarData;
    _originalCache.set(userId, original);
    return original;
  } catch {
    return null;
  }
}

function enableAvatarPeek(el, userId) {
  const isTouch = 'ontouchstart' in window;
  let startY = 0;
  let isDragging = false;
  let ratio = 0;
  let originalSrc = null;
  let animFrame = null;

  function apply(r) {
    ratio = r;
    const img = el.querySelector('img');
    if (!img) return;
    const radius = (1 - r) * 50;
    img.style.borderRadius = radius + '%';
    if (r > 0.5 && originalSrc && img.src !== originalSrc) {
      img.src = originalSrc;
    } else if (r <= 0.5 && originalSrc) {
      const normal = getAvatarUrl(userId);
      if (normal && img.src !== normal) img.src = normal;
    }
  }

  function animateOut(from) {
    if (animFrame) cancelAnimationFrame(animFrame);
    const startTime = performance.now();
    function tick(now) {
      const t = Math.min(1, (now - startTime) / 200);
      const eased = 1 - Math.pow(1 - t, 3);
      const r = from * (1 - eased);
      apply(r);
      if (t < 1) animFrame = requestAnimationFrame(tick);
      else { apply(0); isDragging = false; }
    }
    animFrame = requestAnimationFrame(tick);
  }

  if (isTouch) {
    el.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
      startY = e.touches[0].clientY;
      isDragging = true;
      ratio = 0;
      if (!originalSrc) {
        fetchOriginalFromServer(userId).then(src => { originalSrc = src; });
      }
    }, { passive: true });

    el.addEventListener('touchmove', (e) => {
      if (!isDragging || e.touches.length !== 1) return;
      const dy = e.touches[0].clientY - startY;
      if (dy <= 0) { apply(0); return; }
      apply(Math.min(1, dy / 150));
    }, { passive: true });

    el.addEventListener('touchend', () => {
      if (!isDragging) return;
      if (ratio > 0) animateOut(ratio);
      else isDragging = false;
    }, { passive: true });
  } else {
    el.addEventListener('mousedown', (e) => {
      if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
      startY = e.clientY;
      isDragging = true;
      ratio = 0;
      if (!originalSrc) {
        fetchOriginalFromServer(userId).then(src => { originalSrc = src; });
      }
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dy = e.clientY - startY;
      if (dy <= 0) { apply(0); return; }
      apply(Math.min(1, dy / 150));
    });

    document.addEventListener('mouseup', () => {
      if (!isDragging) return;
      if (ratio > 0) animateOut(ratio);
      else isDragging = false;
    });
  }
}

function getAvatarHistory(userId) {
  const stored = localStorage.getItem(getAvatarHistoryStorageKey(userId));
  if (!stored) return [];
  try {
    return JSON.parse(stored) || [];
  } catch {
    return [];
  }
}

function saveAvatarHistory(userId, avatars = []) {
  if (!userId) return;
  if (!avatars.length) {
    localStorage.removeItem(getAvatarHistoryStorageKey(userId));
    localStorage.removeItem(getAvatarStorageKey(userId));
    return;
  }
  localStorage.setItem(getAvatarHistoryStorageKey(userId), JSON.stringify(avatars));
  const latest = avatars[avatars.length - 1];
  if (latest?.avatarData) {
    localStorage.setItem(getAvatarStorageKey(userId), latest.avatarData);
  }
  if (latest?.originalData) {
    localStorage.setItem('tract.avatar.original.' + userId, latest.originalData);
  } else {
    localStorage.removeItem('tract.avatar.original.' + userId);
  }
}

function setAvatarHtml(el, userId, initials) {
  const url = getAvatarUrl(userId);
  if (url) {
    el.innerHTML = `<img src="${escapeHtml(url)}" alt="" style="width:100%;height:100%;object-fit:cover;object-position:center;display:block;">`;
  } else {
    el.textContent = initials;
  }
}

async function uploadAvatarToServer(userId, avatarData, originalData = null) {
  if (!userId || !avatarData) return null;
  const serverUrl = resolveSignalingUrl();
  if (!serverUrl) return null;

  try {
    const body = { userId, avatarData };
    if (originalData) body.avatarOriginal = originalData;
    const response = await fetch(new URL('/profile/avatar', serverUrl).toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new Error(`Upload failed ${response.status}`);
    }
    const data = await response.json();
    return {
      avatarData: data.avatarData || avatarData,
      avatars: Array.isArray(data.avatars) ? data.avatars : [{ id: 'current', avatarData }]
    };
  } catch (error) {
    console.warn('Avatar upload failed:', error);
    return null;
  }
}

async function deleteAvatarFromServer(userId) {
  if (!userId) return null;
  const serverUrl = resolveSignalingUrl();
  if (!serverUrl) return null;

  try {
    const response = await fetch(new URL(`/profile/avatar/${encodeURIComponent(userId)}`, serverUrl).toString(), {
      method: 'DELETE'
    });
    if (!response.ok) {
      throw new Error(`Delete failed ${response.status}`);
    }
    const data = await response.json();
    return data;
  } catch (error) {
    console.warn('Avatar deletion failed:', error);
    return null;
  }
}

async function fetchAvatarGalleryFromServer(userId) {
  if (!userId) return [];
  const serverUrl = resolveSignalingUrl();
  if (!serverUrl) return [];

  try {
    const response = await fetch(new URL(`/profile/avatar/${encodeURIComponent(userId)}`, serverUrl).toString());
    if (!response.ok) {
      return [];
    }
    const data = await response.json();
    if (Array.isArray(data.avatars) && data.avatars.length) {
      return data.avatars;
    }
    if (data.avatarData) {
      return [{ id: 'current', avatarData: data.avatarData, uploadedAt: Date.now() }];
    }
    return [];
  } catch (error) {
    console.warn('Avatar fetch failed:', error);
    return [];
  }
}

async function fetchAvatarFromServer(userId) {
  const avatars = await fetchAvatarGalleryFromServer(userId);
  return avatars.length ? avatars[avatars.length - 1].avatarData : null;
}

async function loadOwnAvatar() {
  if (!state.profile) return null;

  // Show cached avatar immediately
  const existing = localStorage.getItem(getAvatarStorageKey(state.profile.userId));
  if (existing) {
    renderProfileCards();
    renderContacts();
  }

  // Fetch latest from server and update if available
  try {
    const avatars = await fetchAvatarGalleryFromServer(state.profile.userId);
    if (avatars.length) {
      const latestAvatar = avatars[avatars.length - 1].avatarData;
      saveAvatarHistory(state.profile.userId, avatars);
      localStorage.setItem(getAvatarStorageKey(state.profile.userId), latestAvatar);
      renderProfileCards();
      renderContacts();
      return latestAvatar;
    }
  } catch (e) {
    console.warn('loadOwnAvatar server fetch failed, using cache:', e);
  }

  return existing || null;
}

async function ensureAvatarForContact(userId, contact = state.contacts.get(userId)) {
  if (!userId || !state.profile) return null;
  if (contact?.avatarUrl) return contact.avatarUrl;

  const avatars = await fetchAvatarGalleryFromServer(userId);
  if (!avatars.length) return null;

  const latest = avatars[avatars.length - 1].avatarData;
  await upsertContact(userId, {
    ...contact,
    avatarUrl: latest,
    avatars
  });
  return latest;
}

// ==================== AVATAR VIEWER & CROP (Telegram-style) ====================

window.handleAvatarUpload = async (event) => {
  const file = event.target.files?.[0];
  if (!file || !state.profile) return;
  event.target.value = '';

  const dataUrl = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.readAsDataURL(file);
  });

  const originalData = dataUrl;

  openAvatarCropModal(dataUrl, async (croppedDataUrl) => {
    const avatarData = croppedDataUrl;
    // Save both cropped and original
    saveAvatarHistory(state.profile.userId, [{ id: 'current', avatarData, originalData, uploadedAt: Date.now() }]);
    localStorage.setItem(getAvatarStorageKey(state.profile.userId), avatarData);
    if (originalData) localStorage.setItem('tract.avatar.original.' + state.profile.userId, originalData);
    if (state.transport) {
      state.transport.options.avatarData = avatarData;
    }
    const result = await uploadAvatarToServer(state.profile.userId, avatarData, originalData);
    if (result?.avatars?.length) {
      saveAvatarHistory(state.profile.userId, result.avatars);
    }
    if (state.transport?.signaling) {
      state.transport.signaling.post('/peer/heartbeat', {
        peerId: state.myPeerId,
        roomId: state.transport.options.roomId,
        avatarData
      }).catch(() => {});
    }
    renderProfileCards();
    renderContacts();
    // Re-open viewer with updated avatar
    openAvatarViewer();
  });
};

function openAvatarViewer() {
  const existing = document.getElementById('avatarViewerModal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'avatarViewerModal';
  modal.style.cssText = [
    'position:fixed', 'inset:0', 'background:rgba(0,0,0,0.92)', 'z-index:300',
    'display:flex', 'flex-direction:column', 'align-items:center',
    'justify-content:center', 'gap:20px', 'padding:24px',
    'animation:fadeIn 0.2s ease'
  ].join(';');

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.innerHTML = '&times;';
  closeBtn.style.cssText = [
    'position:absolute', 'top:16px', 'right:20px', 'background:none',
    'border:none', 'color:#fff', 'font-size:32px', 'cursor:pointer',
    'z-index:1', 'width:44px', 'height:44px', 'display:flex',
    'align-items:center', 'justify-content:center', 'border-radius:50%'
  ].join(';');
  closeBtn.onclick = () => modal.remove();

  // Avatar display
  const avatarUrl = getAvatarUrl(state.profile.userId);
  const displayImg = document.createElement('div');
  displayImg.style.cssText = [
    'width:min(60vw,300px)', 'height:min(60vw,300px)', 'border-radius:50%',
    'overflow:hidden', 'background:var(--panel-input)', 'flex-shrink:0',
    'display:flex', 'align-items:center', 'justify-content:center',
    'font-size:72px', 'color:var(--text)', 'box-shadow:0 8px 40px rgba(0,0,0,0.5)'
  ].join(';');

  if (avatarUrl) {
    displayImg.innerHTML = `<img src="${escapeHtml(avatarUrl)}" style="width:100%;height:100%;object-fit:cover;">`;
  } else {
    displayImg.textContent = getContactInitials(state.profile.displayName);
  }

  // Gallery: previous avatars from localStorage history
  const historyKey = getAvatarHistoryStorageKey(state.profile.userId);
  let history = [];
  try {
    history = JSON.parse(localStorage.getItem(historyKey) || '[]');
  } catch {}

  const galleryRow = document.createElement('div');
  galleryRow.style.cssText = [
    'display:flex', 'gap:10px', 'overflow-x:auto', 'padding:8px 4px',
    'max-width:min(80vw,400px)', 'scrollbar-width:none'
  ].join(';');

  for (const item of history) {
    if (!item.avatarData) continue;
    const thumb = document.createElement('div');
    thumb.style.cssText = [
      'width:48px', 'height:48px', 'min-width:48px', 'border-radius:50%',
      'overflow:hidden', 'cursor:pointer', 'border:2px solid rgba(255,255,255,0.2)',
      'transition:border-color 0.2s'
    ].join(';');
    thumb.innerHTML = `<img src="${item.avatarData}" style="width:100%;height:100%;object-fit:cover;">`;
    thumb.onmouseenter = () => { thumb.style.borderColor = 'rgba(183,255,249,0.8)'; };
    thumb.onmouseleave = () => { thumb.style.borderColor = 'rgba(255,255,255,0.2)'; };
    thumb.onclick = () => {
      displayImg.innerHTML = `<img src="${item.avatarData}" style="width:100%;height:100%;object-fit:cover;">`;
    };
    galleryRow.appendChild(thumb);
  }

  // Buttons
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:12px;flex-wrap:wrap;justify-content:center;';

  const setPhotoBtn = document.createElement('button');
  setPhotoBtn.textContent = 'Установить новое фото';
  setPhotoBtn.style.cssText = [
    'padding:12px 28px', 'border-radius:10px', 'background:var(--accent,#B7FFF9)',
    'color:#141515', 'font-size:15px', 'font-weight:600', 'border:none',
    'cursor:pointer', 'transition:opacity 0.2s'
  ].join(';');
  setPhotoBtn.onmouseenter = () => { setPhotoBtn.style.opacity = '0.85'; };
  setPhotoBtn.onmouseleave = () => { setPhotoBtn.style.opacity = '1'; };
  setPhotoBtn.onclick = () => {
    modal.remove();
    document.getElementById('avatarUploadInput').click();
  };

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Закрыть';
  cancelBtn.style.cssText = [
    'padding:12px 28px', 'border-radius:10px', 'background:rgba(255,255,255,0.1)',
    'color:#f5f5f5', 'font-size:15px', 'border:none', 'cursor:pointer',
    'transition:opacity 0.2s'
  ].join(';');
  cancelBtn.onmouseenter = () => { cancelBtn.style.opacity = '0.7'; };
  cancelBtn.onmouseleave = () => { cancelBtn.style.opacity = '1'; };
  cancelBtn.onclick = () => modal.remove();

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(setPhotoBtn);

  // Delete button (only if avatar exists)
  if (avatarUrl) {
    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = 'Удалить фото';
    deleteBtn.style.cssText = [
      'padding:12px 28px', 'border-radius:10px', 'background:rgba(229,101,101,0.15)',
      'color:var(--danger)', 'font-size:15px', 'border:none', 'cursor:pointer',
      'transition:opacity 0.2s'
    ].join(';');
    deleteBtn.onmouseenter = () => { deleteBtn.style.opacity = '0.7'; };
    deleteBtn.onmouseleave = () => { deleteBtn.style.opacity = '1'; };
    deleteBtn.onclick = async () => {
      modal.remove();
      const result = await deleteAvatarFromServer(state.profile.userId);
      if (result) {
        localStorage.removeItem(getAvatarStorageKey(state.profile.userId));
        localStorage.removeItem(getAvatarHistoryStorageKey(state.profile.userId));
        localStorage.removeItem('tract.avatar.original.' + state.profile.userId);
        if (state.transport) {
          state.transport.options.avatarData = null;
          state.transport.signaling.post('/peer/heartbeat', {
            peerId: state.myPeerId,
            roomId: state.transport.options.roomId,
            avatarData: ''
          }).catch(() => {});
        }
        renderProfileCards();
        renderContacts();
      }
    };
    btnRow.appendChild(deleteBtn);
  }

  modal.appendChild(closeBtn);
  modal.appendChild(displayImg);
  if (history.length > 1) modal.appendChild(galleryRow);
  modal.appendChild(btnRow);
  document.body.appendChild(modal);

  // Swipe down to close
  let touchStartY = 0;
  modal.addEventListener('touchstart', (e) => {
    if (e.target === modal || e.target === displayImg) {
      touchStartY = e.touches[0].clientY;
    }
  }, { passive: true });
  modal.addEventListener('touchend', (e) => {
    if (touchStartY && e.changedTouches[0].clientY - touchStartY > 80) {
      modal.remove();
    }
    touchStartY = 0;
  }, { passive: true });

  // Close on backdrop click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });
}

function openAvatarCropModal(imageSrc, onConfirm) {
  const existing = document.getElementById('avatarCropModal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'avatarCropModal';
  modal.style.cssText = [
    'position:fixed', 'inset:0', 'background:rgba(0,0,0,0.92)', 'z-index:310',
    'display:flex', 'flex-direction:column', 'align-items:center',
    'justify-content:center', 'gap:16px', 'padding:20px',
    'animation:fadeIn 0.2s ease'
  ].join(';');

  const title = document.createElement('div');
  title.textContent = 'Переместите и измените размер';
  title.style.cssText = 'color:rgba(255,255,255,0.7);font-size:13px;font-weight:400;text-align:center;';

  const canvas = document.createElement('canvas');
  canvas.style.cssText = [
    'display:block', 'border-radius:12px', 'touch-action:none',
    'cursor:move', 'max-width:min(90vw,360px)', 'max-height:60vh'
  ].join(';');

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:12px;margin-top:4px;';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Отмена';
  cancelBtn.style.cssText = 'padding:12px 28px;border-radius:10px;background:rgba(255,255,255,0.1);color:#f5f5f5;font-size:15px;border:none;cursor:pointer;';

  const confirmBtn = document.createElement('button');
  confirmBtn.textContent = 'Готово';
  confirmBtn.style.cssText = 'padding:12px 28px;border-radius:10px;background:var(--accent,#B7FFF9);color:#141515;font-size:15px;font-weight:600;border:none;cursor:pointer;';

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(confirmBtn);
  modal.appendChild(title);
  modal.appendChild(canvas);
  modal.appendChild(btnRow);
  document.body.appendChild(modal);

  const img = new Image();
  img.onload = () => {
    const maxW = Math.min(window.innerWidth * 0.9, 360);
    const maxH = window.innerHeight * 0.55;
    const scale = Math.min(maxW / img.width, maxH / img.height);
    const W = Math.round(img.width * scale);
    const H = Math.round(img.height * scale);

    canvas.width = W;
    canvas.height = H;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';

    const ctx = canvas.getContext('2d');

    const minDim = Math.min(W, H);
    let cropR = minDim * 0.44;
    let cropX = W / 2;
    let cropY = H / 2;

    function draw() {
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(img, 0, 0, W, H);
      // Dark overlay with circular hole
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, H);
      ctx.arc(cropX, cropY, cropR, 0, Math.PI * 2);
      ctx.clip('evenodd');
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
      // Circle border
      ctx.strokeStyle = 'rgba(183,255,249,0.9)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(cropX, cropY, cropR, 0, Math.PI * 2);
      ctx.stroke();
    }

    draw();

    let dragging = false;
    let lastX = 0, lastY = 0;
    let lastPinchDist = null;
    let cleanupFns = [];

    function canvasPos(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (clientX - rect.left) * (W / rect.width),
        y: (clientY - rect.top) * (H / rect.height)
      };
    }

    function clampCrop() {
      cropX = Math.max(cropR, Math.min(W - cropR, cropX));
      cropY = Math.max(cropR, Math.min(H - cropR, cropY));
    }

    function cleanup() {
      cleanupFns.forEach(fn => fn());
      cleanupFns = [];
    }

    // Click/tap to center circle
    canvas.addEventListener('click', (e) => {
      const p = canvasPos(e.clientX, e.clientY);
      cropX = p.x;
      cropY = p.y;
      clampCrop();
      draw();
    });

    // Mouse drag
    const onMouseDown = (e) => {
      dragging = true;
      const p = canvasPos(e.clientX, e.clientY);
      lastX = p.x; lastY = p.y;
    };
    canvas.addEventListener('mousedown', onMouseDown);
    cleanupFns.push(() => canvas.removeEventListener('mousedown', onMouseDown));

    const onMouseMove = (e) => {
      if (!dragging) return;
      const p = canvasPos(e.clientX, e.clientY);
      cropX += p.x - lastX;
      cropY += p.y - lastY;
      lastX = p.x; lastY = p.y;
      clampCrop();
      draw();
    };
    document.addEventListener('mousemove', onMouseMove);
    cleanupFns.push(() => document.removeEventListener('mousemove', onMouseMove));

    const onMouseUp = () => { dragging = false; };
    document.addEventListener('mouseup', onMouseUp);
    cleanupFns.push(() => document.removeEventListener('mouseup', onMouseUp));

    // Wheel resize
    const onWheel = (e) => {
      e.preventDefault();
      cropR = Math.max(20, Math.min(minDim * 0.5, cropR - e.deltaY * 0.4));
      clampCrop();
      draw();
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    cleanupFns.push(() => canvas.removeEventListener('wheel', onWheel));

    // Touch events
    let touchDragId = null;
    const onTouchStart = (e) => {
      if (e.touches.length === 1) {
        dragging = true;
        touchDragId = e.touches[0].identifier;
        const p = canvasPos(e.touches[0].clientX, e.touches[0].clientY);
        lastX = p.x; lastY = p.y;
        lastPinchDist = null;
      } else if (e.touches.length === 2) {
        dragging = false;
        touchDragId = null;
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        lastPinchDist = Math.sqrt(dx * dx + dy * dy);
      }
    };
    canvas.addEventListener('touchstart', onTouchStart, { passive: true });
    cleanupFns.push(() => canvas.removeEventListener('touchstart', onTouchStart));

    const onTouchMove = (e) => {
      if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (lastPinchDist !== null) {
          const oldR = cropR;
          cropR = Math.max(20, Math.min(minDim * 0.5, cropR + (dist - lastPinchDist) * 0.5));
          clampCrop();
          draw();
        }
        lastPinchDist = dist;
        return;
      }
      if (!dragging || e.touches.length !== 1) return;
      const touch = e.touches[0];
      if (touch.identifier !== touchDragId) return;
      const p = canvasPos(touch.clientX, touch.clientY);
      cropX += p.x - lastX;
      cropY += p.y - lastY;
      lastX = p.x; lastY = p.y;
      clampCrop();
      draw();
    };
    canvas.addEventListener('touchmove', onTouchMove, { passive: true });
    cleanupFns.push(() => canvas.removeEventListener('touchmove', onTouchMove));

    const onTouchEnd = (e) => {
      if (e.touches.length < 2) lastPinchDist = null;
      if (e.touches.length === 0) { dragging = false; touchDragId = null; }
    };
    canvas.addEventListener('touchend', onTouchEnd, { passive: true });
    cleanupFns.push(() => canvas.removeEventListener('touchend', onTouchEnd));

    cancelBtn.onclick = () => { cleanup(); modal.remove(); };

    confirmBtn.onclick = () => {
      cleanup();
      const size = 256;
      const out = document.createElement('canvas');
      out.width = size;
      out.height = size;
      const oc = out.getContext('2d');
      const imgScaleX = img.width / W;
      const imgScaleY = img.height / H;
      const srcX = (cropX - cropR) * imgScaleX;
      const srcY = (cropY - cropR) * imgScaleY;
      const srcW = cropR * 2 * imgScaleX;
      const srcH = cropR * 2 * imgScaleY;
      oc.beginPath();
      oc.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
      oc.clip();
      oc.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, size, size);
      const result = out.toDataURL('image/jpeg', 0.88);
      modal.remove();
      onConfirm(result);
    };
  };
  img.src = imageSrc;
}

function renderProfileCards() {
  if (!state.profile) return;
  
  const initials = getContactInitials(state.profile.displayName);
  
  const avatarSettings = $('profileAvatarSettings');
  const nameSettings = $('profileNameSettings');
  const idSettings = $('profileUserIdSettings');
  if (avatarSettings) {
    setAvatarHtml(avatarSettings, state.profile.userId, initials);
    enableAvatarPeek(avatarSettings, state.profile.userId);
    avatarSettings.onclick = () => openAvatarViewer();
    avatarSettings.style.cursor = 'pointer';
  }
  if (nameSettings) nameSettings.textContent = state.profile.displayName;
  if (idSettings) idSettings.textContent = state.profile.userId;
}

function updateSettingsPanel() {
  if (!state.profile) return;
  const el = $('settingUserId');
  if (el) el.textContent = state.profile.userId;
  const peerIdEl = $('settingPeerId');
  if (peerIdEl) peerIdEl.textContent = state.myPeerId || '...';
  // Sync hideOnline toggle
  const toggle = $('hideOnlineToggle');
  if (toggle) {
    const hidden = Boolean(localStorage.getItem('tract.hideOnline'));
    toggle.checked = hidden;
    updateHideOnlineLabel(hidden);
  }
  syncNotificationsToggle();
  updateLockStatusLabel();
}

function updateLockStatusLabel() {
  const el = $('lockStatusValue');
  if (!el) return;
  const mode = getLockMode();
  el.textContent = mode === 'passcode' ? 'Код-пароль'
    : mode === 'calculator' ? 'Калькулятор'
    : 'Выкл';
}

window.openLockSettings = () => {
  const currentMode = getLockMode();
  let selectedMode = currentMode === 'off' ? 'passcode' : currentMode;

  const backdrop = document.createElement('div');
  backdrop.className = 'lock-modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'lock-modal';
  backdrop.appendChild(modal);

  const render = () => {
    const isCalc = selectedMode === 'calculator';
    const codeHint = isCalc
      ? 'Секретная комбинация цифр. В калькуляторе наберите её, нажмите =, затем +.'
      : 'Ровно 4 цифры — как в Telegram.';
    modal.innerHTML = `
      <h3>Блокировка приложения</h3>
      <p class="hint">Защитите вход код-паролем или замаскируйте приложение под калькулятор.</p>

      <div class="lock-mode-options">
        <label class="lock-mode-option ${selectedMode === 'passcode' ? 'active' : ''}">
          <input type="radio" name="lockMode" value="passcode" ${selectedMode === 'passcode' ? 'checked' : ''}>
          <div>
            <div class="toggle-label">Код-пароль</div>
            <div class="toggle-sublabel">4 цифры при запуске</div>
          </div>
        </label>
        <label class="lock-mode-option ${selectedMode === 'calculator' ? 'active' : ''}">
          <input type="radio" name="lockMode" value="calculator" ${selectedMode === 'calculator' ? 'checked' : ''}>
          <div>
            <div class="toggle-label">Маскировка «Калькулятор»</div>
            <div class="toggle-sublabel">Приложение выглядит как калькулятор</div>
          </div>
        </label>
      </div>

      <label>${isCalc ? 'Секретная комбинация' : 'Код-пароль (4 цифры)'}</label>
      <input type="password" inputmode="numeric" id="lockCodeInput" autocomplete="off" placeholder="${isCalc ? 'напр. 1958' : '••••'}">
      <p class="hint" style="margin:6px 0 0;">${codeHint}</p>

      <label>Код самоуничтожения (необязательно)</label>
      <input type="password" inputmode="numeric" id="lockWipeInput" autocomplete="off" placeholder="стереть всё">
      <p class="hint" style="margin:6px 0 0;">При вводе этого кода всё содержимое удаляется без следа.</p>

      <div id="lockModalError" style="color:var(--danger);font-size:13px;margin-top:12px;min-height:16px;"></div>

      <div class="lock-modal-actions">
        ${currentMode !== 'off' ? '<button type="button" class="btn subtle" id="lockDisableBtn">Выключить</button>' : ''}
        <button type="button" class="btn subtle" id="lockCancelBtn">Отмена</button>
        <button type="button" class="btn primary" id="lockSaveBtn">Сохранить</button>
      </div>
    `;

    modal.querySelectorAll('input[name="lockMode"]').forEach((r) => {
      r.addEventListener('change', (e) => { selectedMode = e.target.value; render(); });
    });

    const close = () => backdrop.remove();
    $('lockCancelBtn').onclick = close;
    backdrop.onclick = (e) => { if (e.target === backdrop) close(); };

    const disableBtn = $('lockDisableBtn');
    if (disableBtn) disableBtn.onclick = async () => {
      await disableLock();
      updateLockStatusLabel();
      close();
      setStatus('ok', 'Блокировка выключена');
    };

    $('lockSaveBtn').onclick = async () => {
      const code = $('lockCodeInput').value.trim();
      const wipe = $('lockWipeInput').value.trim();
      const errEl = $('lockModalError');
      errEl.textContent = '';

      if (!/^\d+$/.test(code)) { errEl.textContent = 'Код должен состоять из цифр.'; return; }
      if (selectedMode === 'passcode' && code.length !== 4) { errEl.textContent = 'Код-пароль — ровно 4 цифры.'; return; }
      if (wipe && !/^\d+$/.test(wipe)) { errEl.textContent = 'Код уничтожения должен состоять из цифр.'; return; }
      if (selectedMode === 'passcode' && wipe && wipe.length !== 4) { errEl.textContent = 'Код уничтожения — ровно 4 цифры.'; return; }
      if (wipe && wipe === code) { errEl.textContent = 'Коды должны различаться.'; return; }

      try {
        await configureLock({ mode: selectedMode, code, wipeCode: wipe || undefined });
        updateLockStatusLabel();
        close();
        // Reload so the disguise (title/icon/manifest) and the lock screen actually
        // engage — they are applied by the <head> boot script and initAppLock().
        location.reload();
      } catch (e) {
        errEl.textContent = 'Не удалось сохранить.';
      }
    };
  };

  // Must be in the DOM before render() runs, since render() wires handlers by id.
  document.body.appendChild(backdrop);
  render();
};

async function init() {
  // Front door: if an app lock is set, gate everything behind it before any
  // real content is rendered (the <head> boot script already hid #app/#authGate).
  await initAppLock();

  applyInviteParams();
  syncSignalingFromEnvironment();
  window.addEventListener('resize', updateMobileLayout);
  initSwipeGestures();
  initPwa({
    onOpenChat: (chatId) => openChatFromDeepLink(chatId),
    // Block disruptive SW-update reloads while a call is in progress.
    isBusy: () => Boolean(state.activeCall)
  });
  syncNotificationsToggle();

  // Toggle send/mic button and wire click
  const input = $('messageInput');
  const sendBtn = $('sendBtn');
  if (input && sendBtn) {
    const updateSendBtn = () => {
      const icon = sendBtn.querySelector('.material-icons');
      if (!icon) return;
      icon.textContent = input.value.trim().length > 0 ? 'send' : 'mic';
    };
    input.addEventListener('input', updateSendBtn);
    sendBtn.addEventListener('click', () => {
      if (input.value.trim().length > 0) {
        sendCurrentMessage();
      }
    });
    // Voice recording — hold mic button
    initVoiceRecording(sendBtn, input);
  }

  const identity = getStoredIdentityMetadata();
  const legacyIdentity = getLegacyIdentityMetadata();
  const sessionPw = localStorage.getItem(REMEMBER_PASSWORD_KEY) || sessionStorage.getItem(SESSION_PASSWORD_KEY);

  if (identity && sessionPw) {
    try {
      const banned = await checkUserBanned(identity.userId);
      if (banned) {
        sessionStorage.removeItem(SESSION_PASSWORD_KEY);
        localStorage.removeItem(REMEMBER_PASSWORD_KEY);
        showLogin();
        $('authError').textContent = 'Аккаунт заблокирован';
        return;
      }
      const auth = await unlockIdentity(sessionPw);
      await bootstrapAuthenticatedSession(auth);
      return;
    } catch (error) {
      console.error('Auto-login failed:', error);
      // Only clear session storage on decrypt error, keep localStorage password for retry
      if (error.name === 'OperationError') {
        sessionStorage.removeItem(SESSION_PASSWORD_KEY);
        localStorage.removeItem(REMEMBER_PASSWORD_KEY);
      } else {
        sessionStorage.removeItem(SESSION_PASSWORD_KEY);
      }
    }
  }

  if (window._pendingInviteCode) {
    const code = window._pendingInviteCode;
    window._pendingInviteCode = null;
    showRegister(code);
    return;
  }

  if (identity) {
    const loginInput = $('loginName');
    if (loginInput) loginInput.value = identity.userId.replace(/^@/, '');
    showLogin();
  } else if (legacyIdentity) {
    $('regName').value = legacyIdentity.profile.displayName.replace(/^@/, '');
    $('regInviteCode').value = 'legacy-migration';
    $('regInviteCode').readOnly = true;
    showRegister();
  } else {
    showLogin();
  }

  setStatus('offline', 'Аккаунт не разблокирован');
  renderContacts();
  renderProfile();
  renderChatHeader();
  updateMobileLayout();
}

function applyInviteParams() {
  const params = new URLSearchParams(window.location.search);
  const signal = params.get('signal');
  const room = params.get('room');
  const invite = params.get('invite');

  if (signal) {
    localStorage.setItem(SIGNALING_URL_KEY, signal);
  }
  if (room) {
    localStorage.setItem(ROOM_ID_KEY, room);
  }

  if (invite) {
    window._pendingInviteCode = invite;
    const url = new URL(window.location);
    url.searchParams.delete('invite');
    window.history.replaceState({}, '', url);
  }
}

function consumeChatDeepLink() {
  const params = new URLSearchParams(window.location.search);
  const chatId = params.get('chat');
  if (!chatId) return null;
  params.delete('chat');
  const next = params.toString();
  const url = `${window.location.pathname}${next ? `?${next}` : ''}${window.location.hash}`;
  window.history.replaceState({}, '', url);
  return normalizeLogin(chatId);
}

async function openChatFromDeepLink(chatId) {
  if (!chatId || !state.profile) return;
  if (!state.contacts.has(chatId) && !state.groups.has(chatId)) return;
  await openChat(chatId);
  const sidebar = $('sidebar');
  if (sidebar && window.matchMedia('(max-width: 768px)').matches) {
    sidebar.classList.add('chat-open');
  }
}

window.toggleNotifications = async () => {
  const toggle = $('notificationsToggle');
  if (!toggle) return;
  const result = await setNotificationsEnabled(toggle.checked);
  if (!result.ok) {
    if (result.reason === 'denied') {
      setStatus('warn', 'Разрешите уведомления в настройках браузера для этого сайта');
    } else if (result.reason === 'unsupported') {
      setStatus('warn', 'Браузер не поддерживает уведомления');
    } else {
      setStatus('warn', 'Уведомления не включены');
    }
  }
};

function openGate(mode, copy = {}) {
  $('authGate').hidden = false;
  $('registerPanel').hidden = mode !== 'register';
  $('loginPanel').hidden = mode !== 'login';
  $('authTitle').textContent = copy.title || (mode === 'login' ? 'Вход в Tract' : 'Регистрация в Tract');
  $('authError').textContent = '';
}

function closeGate() {
  // Stamp post-auth DOM from template (only on first login)
  if (!$('app')) {
    const tmpl = document.getElementById('postAuth');
    if (tmpl) {
      const clone = tmpl.content.cloneNode(true);
      tmpl.remove();
      document.body.appendChild(clone);
    }
  }
  $('authGate').hidden = true;
  $('app').hidden = false;
}

window.onLoginNameInput = () => {
  const input = $('loginName');
  const passwordField = $('loginPasswordField');
  const loginBtn = $('loginBtn');
  if (!input || !passwordField) return;

  const raw = input.value.replace(/^@+/, '');
  input.value = raw;
  const login = normalizeLogin(raw);

  // Reveal the password field as soon as the login is syntactically valid.
  // We deliberately do NOT ask the server whether the account exists: that
  // blocked login on any request failure (the regression) and leaked login
  // attempts / allowed account enumeration. Existence + ban are checked at submit.
  passwordField.hidden = !isValidLogin(login);
  if (loginBtn) loginBtn.textContent = 'Войти';
  $('authError').textContent = '';
};

window.showRegister = (inviteCode) => {
  $('authGate').hidden = false;
  $('registerPanel').hidden = false;
  $('loginPanel').hidden = true;
  $('authTitle').textContent = 'Регистрация в Tract';
  $('authError').textContent = '';
  if (inviteCode) {
    $('regInviteCode').value = inviteCode;
    $('regInviteCode').readOnly = true;
  }
};
window.showLogin = () => {
  $('authGate').hidden = false;
  $('registerPanel').hidden = true;
  $('loginPanel').hidden = false;
  $('authTitle').textContent = 'Вход в Tract';
  $('authError').textContent = '';
  $('loginPasswordField').hidden = true;
  $('loginPassword').value = '';
  $('loginName').value = '';
  $('loginName').focus();
  // Trigger check if pre-filled
  if (window.onLoginNameInput) setTimeout(window.onLoginNameInput, 100);
};

window.registerAccount = async () => {
  if (!window.isSecureContext) {
    $('authError').textContent =
      'Нужен HTTPS (или localhost). Запустите npm run start и откройте https://…:5173 — браузер спросит про сертификат, это нормально.';
    return;
  }

  const inviteCode = ($('regInviteCode')?.value || '').trim();
  const rawLogin = ($('regName')?.value || '').replace(/^@+/, '');
  const login = normalizeLogin(rawLogin);
  const password = $('regPassword')?.value || '';
  const confirm = $('regPasswordConfirm')?.value || '';

  if (!inviteCode) {
    $('authError').textContent = 'Введите код приглашения';
    return;
  }

  if (inviteCode === 'legacy-migration') {
    $('authError').textContent = 'Миграция больше не поддерживается. Используйте новый аккаунт.';
    return;
  }

  if (!isValidLogin(login)) {
    $('authError').textContent = 'ID должен быть вида @login: латиница, цифры или _, 3-32 символа';
    return;
  }

  if (password.length < 6) {
    $('authError').textContent = 'Пароль должен быть не короче 6 символов';
    return;
  }

  if (password !== confirm) {
    $('authError').textContent = 'Пароли не совпадают';
    return;
  }

  $('authError').textContent = '';

  try {
    const serverUrl = resolveSignalingUrl();
    const useResp = await fetch(new URL('/admin/invite/use', serverUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: inviteCode, userId: login })
    });
    if (!useResp.ok) {
      const errData = await useResp.json().catch(() => ({}));
      $('authError').textContent = errData.error || 'Недействительный код приглашения';
      return;
    }

    const auth = await registerIdentity(password, login, { reuseLegacy: false, userId: login });
    sessionStorage.setItem(SESSION_PASSWORD_KEY, password);
    localStorage.setItem(REMEMBER_PASSWORD_KEY, password);
    await uploadIdentityToServer(serverUrl);
    await bootstrapAuthenticatedSession(auth);
  } catch (error) {
    console.error('Register failed:', error);
    $('authError').textContent = 'Не удалось создать аккаунт';
  }
};

window.loginAccount = async () => {
  if (!window.isSecureContext) {
    $('authError').textContent =
      'Нужен HTTPS (или localhost). Откройте страницу по https:// (см. npm run start).';
    return;
  }
  const storedIdentity = getStoredIdentityMetadata();
  const rawLogin = ($('loginName')?.value || '').replace(/^@+/, '');
  const login = normalizeLogin(rawLogin);
  const password = $('loginPassword').value;

  if (!isValidLogin(login)) {
    $('authError').textContent = 'Введите логин вида @login';
    return;
  }

  const banned = await checkUserBanned(login);
  if (banned) {
    $('authError').textContent = 'Аккаунт заблокирован';
    return;
  }

  if (!password) {
    $('authError').textContent = 'Введите пароль';
    return;
  }

  if (storedIdentity && storedIdentity.simple && normalizeLogin(storedIdentity.userId) === login) {
    try {
      const auth = unlockSimpleIdentity();
      await uploadIdentityToServer(resolveSignalingUrl());
      await bootstrapAuthenticatedSession(auth);
    } catch (e) {
      console.error('Simple login failed:', e);
      $('authError').textContent = 'Не удалось войти';
    }
    return;
  }

  $('authError').textContent = '';

  let auth;
  try {
    const sameLocalLogin = storedIdentity?.userId && normalizeLogin(storedIdentity.userId) === login;
    if (sameLocalLogin) {
      auth = await unlockIdentity(password);
    } else {
      const serverUrl = resolveSignalingUrl();
      const fetched = await fetchIdentityFromServer(serverUrl, login);
      if (fetched) {
        auth = await unlockIdentity(password);
      } else {
        $('authError').textContent = 'Аккаунт не найден';
        return;
      }
    }
  } catch (error) {
    console.error('Login decrypt failed:', error);
    if (error.name === 'OperationError') {
      $('authError').textContent = 'Неверный пароль';
    } else if (error.message?.includes('Identity not found')) {
      $('authError').textContent = 'Аккаунт не найден';
    } else {
      $('authError').textContent = `Ошибка: ${error.message || 'неизвестная'}`;
    }
    return;
  }

  try {
    sessionStorage.setItem(SESSION_PASSWORD_KEY, password);
    localStorage.setItem(REMEMBER_PASSWORD_KEY, password);
    await uploadIdentityToServer(resolveSignalingUrl());
    await bootstrapAuthenticatedSession(auth);
  } catch (error) {
    console.error('Login session start failed:', error);
    $('authError').textContent = `Ошибка: ${error.message || 'не удалось открыть сессию'}`;
  }
};

async function bootstrapAuthenticatedSession(auth) {
  state.keyPair = auth.keyPair;
  state.profile = auth.profile;
  state.myPeerId = getOrCreateSessionPeerId(state.profile.userId);
  state.currentChatId = null;
  state.selectedMessageIds.clear();
  await messageDB.initForUser(state.profile.userId);

  if (state.transport) {
    await state.transport.stop();
  }

  state.contacts.clear();
  state.groups.clear();
  await syncContactsFromServer();
  await restoreContacts();
  await loadGroups();
  await loadOwnAvatar();

  // Template must be cloned BEFORE accessing post-auth DOM elements
  closeGate();

  const selfId = $('selfId');
  if (selfId) selfId.textContent = state.profile.userId;
  const selfPeerId = $('selfPeerId');
  if (selfPeerId) selfPeerId.textContent = state.myPeerId;
  const nameInput = $('displayNameInput');
  if (nameInput) nameInput.value = state.profile.displayName;
  const regPw = $('regPassword');
  if (regPw) regPw.value = '';
  const regPwConfirm = $('regPasswordConfirm');
  if (regPwConfirm) regPwConfirm.value = '';
  const loginPw = $('loginPassword');
  if (loginPw) loginPw.value = '';

  renderProfile();
  renderContacts();
  renderChatHeader();
  $('messages').innerHTML = '<div class="empty-chat">Найдите контакт по логину над списком чатов</div>';
  setStatus('offline', 'Аккаунт разблокирован, сеть не подключена');
  await updateInviteArtifacts();
  updateMobileLayout();

  if (state.profile?.userId === '@creator') {
    const panel = $('adminPanel');
    const section = $('adminSection');
    if (panel) panel.style.display = '';
    if (section) section.style.display = 'flex';
    loadAdminUsers();
  }

  // Periodic contact & group sync across devices
  if (window._contactSyncTimer) clearInterval(window._contactSyncTimer);
  window._contactSyncTimer = setInterval(async () => {
    await syncContactsFromServer();
    await loadGroups();
    renderContacts();
  }, 30000);

  queueMicrotask(() => {
    connectHandshake().catch((e) => console.warn('Auto-connect:', e));
  });

  const deepLinkChat = consumeChatDeepLink();
  if (deepLinkChat) {
    openChatFromDeepLink(deepLinkChat).catch(() => {});
  }
}

window.logoutAccount = async () => {
  const adminPanel = $('adminPanel');
  const adminSection = $('adminSection');
  if (adminPanel) adminPanel.style.display = 'none';
  if (adminSection) adminSection.style.display = 'none';
  sessionStorage.removeItem(SESSION_PASSWORD_KEY);
  localStorage.removeItem(REMEMBER_PASSWORD_KEY);
  clearInterval(inboxTimer);
  inboxTimer = null;
  stopRingTone();
  const ra = $('remoteAudio');
  if (ra) ra.srcObject = null;
  _remoteAudioStream = null;
  state.activeCall = null;
  state.micMuted = false;
  state.unreadCounts.clear();
  refreshDocTitle();
  updateCallBar();
  if (state.transport) {
    await state.transport.stop();
  }
  state.transport = null;
  state.multiplexer = null;
  state.keyPair = null;
  state.profile = null;
  state.currentChatId = null;
  state.selectedMessageIds.clear();
  state.contacts.clear();
  if (window._contactSyncTimer) {
    clearInterval(window._contactSyncTimer);
    window._contactSyncTimer = null;
  }
  if (window._contactSyncDebounce) {
    clearTimeout(window._contactSyncDebounce);
    window._contactSyncDebounce = null;
  }
  await messageDB.initForUser(null);
  clearSessionPeerId();
  renderContacts();
  renderProfile();
  renderChatHeader();
  $('messages').innerHTML = '<div class="empty-chat">Сессия завершена</div>';
  setStatus('offline', 'Вы вышли из аккаунта');
  $('app').hidden = true;
  const identity = getStoredIdentityMetadata();
  const legacyIdentity = getLegacyIdentityMetadata();
  if (identity) {
    const loginInput = $('loginName');
    if (loginInput) loginInput.value = identity.userId.replace(/^@/, '');
    showLogin();
  } else if (legacyIdentity) {
    $('regName').value = legacyIdentity.profile.displayName.replace(/^@/, '');
    $('regInviteCode').value = 'legacy-migration';
    $('regInviteCode').readOnly = true;
    showRegister();
  } else {
    showLogin();
  }
};

// Auto-save display name on input (debounced)
let _displayNameTimer = null;
$('displayNameInput')?.addEventListener('input', () => {
  clearTimeout(_displayNameTimer);
  _displayNameTimer = setTimeout(saveOwnProfile, 400);
});
// Save immediately when the field loses focus (covers fast edits + view switches).
$('displayNameInput')?.addEventListener('blur', () => {
  clearTimeout(_displayNameTimer);
  saveOwnProfile();
});

async function saveOwnProfile() {
  if (!state.profile) return;
  const displayName = $('displayNameInput').value.trim() || 'Anonymous';
  if (state.profile.displayName === displayName) return;
  state.profile.displayName = displayName;
  updateStoredDisplayName(displayName);
  await uploadIdentityToServer(resolveSignalingUrl());
  renderProfile();
  if (state.transport?.signaling) {
    state.transport.options.displayName = displayName;
    state.transport.signaling.post('/peer/heartbeat', {
      peerId: state.myPeerId,
      roomId: state.transport.options.roomId,
      displayName
    }).catch(() => {});
  }
  await updateInviteArtifacts();
}

function updateHideOnlineLabel(hidden) {
  const label = $('hideOnlineLabel');
  if (label) label.textContent = hidden ? 'Скрыт' : 'Виден';
}

window.toggleHideOnline = () => {
  const toggle = $('hideOnlineToggle');
  if (!toggle) return;
  const hidden = toggle.checked;
  if (hidden) {
    localStorage.setItem('tract.hideOnline', '1');
  } else {
    localStorage.removeItem('tract.hideOnline');
  }
  updateHideOnlineLabel(hidden);
  // Update heartbeat so server knows our preference
  if (state.transport?.signaling) {
    state.transport.options.hideOnline = hidden;
    state.transport.signaling.post('/peer/heartbeat', {
      peerId: state.myPeerId,
      roomId: state.transport.options.roomId,
      displayName: state.profile?.displayName,
      hideOnline: hidden,
      lastSeen: hidden ? null : Date.now()
    }).catch(() => {});
  }
};

let inboxSyncBound = false;

function bindInboxSync() {
  if (inboxSyncBound) return;
  inboxSyncBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !state.profile) return;
    getSignaling()?.pollNow().catch(() => {});
    pullUserInbox().catch(() => {});
    // Clear unread for currently open chat when app comes back to foreground
    if (state.currentChatId) {
      state.unreadCounts.delete(state.currentChatId);
      refreshDocTitle();
      renderContacts();
    }
  });
}

async function pullUserInbox() {
  if (!state.profile) return;
  const signaling = getSignaling();
  if (!signaling) return;

  try {
    const { messages = [] } = await signaling.pullInbox(state.profile.userId);
    const ackIds = [];

    for (const entry of messages) {
      if (entry.type !== 'app_packet' || !entry.payload) continue;
      await processIncomingPacket(entry.payload, entry.from);
      if (entry.id) ackIds.push(entry.id);
    }

    await signaling.ackInbox(state.profile.userId, ackIds);
  } catch (error) {
    console.warn('Inbox pull failed:', error);
  }
}

async function processIncomingPacket(packet, fromPeerId) {
  if (packet.type === 'message_control') {
    await handleMessageControl(packet, fromPeerId);
    return;
  }

  if (packet.type === 'call') {
    await handleCallControl(packet, fromPeerId);
    return;
  }

  if (packet.type === 'group_event') {
    await handleGroupEvent(packet);
    return;
  }

  if (packet.type !== 'text' && packet.type !== 'voice') return;

  // Decrypt E2E
  let content = packet.content;
  if (packet.encrypted && packet.iv && packet.senderPublicKey) {
    try {
      content = await decryptMessage(packet.content, packet.iv, packet.senderPublicKey, state.keyPair);
    } catch (e) {
      console.warn('Decrypt failed:', e);
    }
  }

  // Deduplicate by packet.packetId (added on send). If missing, use fingerprint.
  let pktId = packet.packetId;
  if (!pktId) {
    pktId = `${packet.senderId||fromPeerId}:${packet.timestamp}:${content}`;
  }
  if (state.receivedPacketIds.has(pktId)) {
    return;
  }
  state.receivedPacketIds.add(pktId);

  if (packet.senderId === state.profile?.userId) return;
  if (packet.packetId && await messageDB.hasMessagePacket(packet.packetId)) return;

  const isGroup = packet.recipientId && packet.recipientId.startsWith('#');
  const chatId = isGroup ? packet.recipientId : (packet.senderId || findUserIdByPeerId(fromPeerId) || fromPeerId);
  const displayPacket = { ...packet, content, encrypted: false };
  const savedId = await messageDB.saveMessage(displayPacket, chatId, false, { isOutgoing: false });
  displayPacket._dbId = savedId;

  if (isGroup) {
    if (state.currentChatId !== chatId) {
      state.unreadCounts.set(chatId, (state.unreadCounts.get(chatId) || 0) + 1);
      refreshDocTitle();
      const group = state.groups.get(chatId);
      const senderLabel = packet.senderName || packet.senderId || '';
      notifyNewMessage({
        chatId,
        title: group?.name || chatId,
        body: senderLabel ? `${senderLabel}: ${truncate(String(content || ''), 120)}` : truncate(String(content || ''), 120)
      });
    }
    if (state.currentChatId === chatId) {
      addMessageToUI(displayPacket, false);
    }
    return;
  }

  const existingContact = state.contacts.get(chatId);
  const resolvedDisplayName = packet.senderName && packet.senderName !== chatId
    ? packet.senderName
    : (existingContact?.displayName || chatId);

  const appHidden = document.hidden || document.visibilityState !== 'visible';
  if (state.currentChatId !== chatId || appHidden) {
    state.unreadCounts.set(chatId, (state.unreadCounts.get(chatId) || 0) + 1);
    refreshDocTitle();
    notifyNewMessage({
      chatId,
      title: getContactLabel(existingContact) || resolvedDisplayName || chatId,
      body: truncate(String(content || ''), 120)
    });
  }

  if (state.currentChatId === chatId) {
    addMessageToUI(displayPacket, false);
  }

  const roomId = state.transport?.options?.roomId || resolveRoomId();
  const wasNew = !state.contacts.has(chatId);

  const contactPatch = {
    displayName: resolvedDisplayName,
    activePeerId: fromPeerId,
    online: true,
    roomId,
    lastMsg: displayPacket.type === 'voice' ? '🎙 Голосовое' : content,
    lastTime: packet.timestamp
  };
  if (packet.senderPublicKey) {
    contactPatch.publicKeyHex = packet.senderPublicKey;
  }
  await upsertContact(chatId, contactPatch);

  if (wasNew) {
    state.transport?.setAllowedUserIds?.(Array.from(state.contacts.keys()));
  }
}

window.connectHandshake = async () => {
  if (!state.profile || !state.keyPair) {
    const stored = getStoredIdentityMetadata();
    if (stored && stored.simple) {
      try {
        const auth = unlockSimpleIdentity();
        await bootstrapAuthenticatedSession(auth);
      } catch (e) {
        console.warn('Auto-unlock simple identity failed:', e);
        if (getStoredIdentityMetadata()) showLogin(); else showRegister();
      }
      return;
    }

    if (getStoredIdentityMetadata()) showLogin(); else showRegister();
    return;
  }

  syncSignalingFromEnvironment();
  const serverUrl = resolveSignalingUrl();
  const roomId = resolveRoomId();
  if (!serverUrl || !roomId) {
    setStatus('error', 'Не удалось определить адрес сети');
    return;
  }

  localStorage.setItem(SIGNALING_URL_KEY, serverUrl);
  localStorage.setItem(ROOM_ID_KEY, roomId);

  if (state.transport) {
    await state.transport.stop();
  }

  for (const [contactId, contact] of state.contacts) {
    state.contacts.set(contactId, { ...contact, online: false, activePeerId: null });
  }
  renderContacts();
  renderChatHeader();

  state.multiplexer = new Multiplexer(state.keyPair);
  const hideOnline = Boolean(localStorage.getItem('tract.hideOnline'));
  const myPublicKeyHex = getPublicKeyHex(state.keyPair);
  state.transport = new WebRTCTransport(state.myPeerId, {
    serverUrl,
    roomId,
    userId: state.profile.userId,
    displayName: state.profile.displayName,
    publicKeyHex: myPublicKeyHex,
    hideOnline,
    allowedUserIds: new Set(state.contacts.keys())
  });
  state.multiplexer.register(state.transport);

  // Register signaling relay transport so packets can be relayed via server
  // (allows offline message delivery — server queues signals until peer polls)
  try {
    const { SignalingRelayTransport } = await import('./app/transports/signaling-relay.js');
    state.signalingRelay = new SignalingRelayTransport(state.myPeerId, {
      serverUrl,
      roomId,
      userId: state.profile.userId,
      displayName: state.profile.displayName,
      publicKeyHex: myPublicKeyHex
    });
    state.multiplexer.register(state.signalingRelay);
  } catch (e) {
    console.warn('Failed to register signaling relay transport:', e);
  }

  state.transport.onPeerDiscovery(async (_peerId, peerMeta) => {
    if (peerMeta.userId === state.profile.userId) return;
    if (!state.contacts.has(peerMeta.userId)) return;

    const patch = {
      displayName: peerMeta.displayName || peerMeta.userId,
      activePeerId: peerMeta.peerId,
      online: !peerMeta.hideOnline,
      hideOnline: Boolean(peerMeta.hideOnline),
      lastSeen: peerMeta.lastSeen || null,
      roomId,
      publicKeyHex: peerMeta.publicKey || state.contacts.get(peerMeta.userId)?.publicKeyHex
      // NB: never set lastMsg here — the chat preview must come only from a real
      // delivered/sent message, not from a presence event.
    };

    if (peerMeta.avatar) {
      patch.avatarUrl = peerMeta.avatar;
      const key = getAvatarStorageKey(peerMeta.userId);
      if (localStorage.getItem(key) !== peerMeta.avatar) {
        localStorage.setItem(key, peerMeta.avatar);
      }
    }

    await upsertContact(peerMeta.userId, patch);

    const chatId = peerMeta.userId;

    // Resend any pending (undelivered) messages for this user
    try {
      const pending = await messageDB.getUndeliveredMessages(chatId);
      for (const msg of pending) {
        // Route through deliverOutgoingMessage so the resend is E2E-encrypted too,
        // never plaintext. It re-resolves the peer and marks the message delivered.
        await deliverOutgoingMessage(chatId, msg).catch((e) => {
          console.warn('[onPeerDiscovery] resend failed:', e?.message || e);
        });
      }
      await flushPendingMessageControls(chatId, peerMeta.peerId);
      await flushPendingCallControls(chatId, peerMeta.peerId);
    } catch (e) {
      console.warn('[onPeerDiscovery] pending flush failed:', e);
    }

    if (state.activeCall?.status === 'ringing' && state.activeCall.role === 'caller' && state.activeCall.peerUserId === chatId) {
      state.activeCall.remotePeerId = peerMeta.peerId;
      try {
        await flushPendingCallControls(chatId, peerMeta.peerId);
        await state.transport.startAudioCallWithLocalMedia(peerMeta.peerId, { asOfferer: true }).catch((e) => {
          console.warn('Caller audio setup failed when peer appeared:', e);
        });
      } catch (e) {
        console.warn('Pending call invite failed when peer appeared:', e);
      }
    }
  });

  state.transport.onPeerOffline(async (peerId, peerMeta) => {
    const userId = peerMeta?.userId || findUserIdByPeerId(peerId);
    if (!userId) return;
    const contact = state.contacts.get(userId);
    if (!contact) return;

    await upsertContact(userId, {
      ...contact,
      activePeerId: null,
      online: false,
      lastSeen: Date.now()
    });
  });

  state.transport.onPeerConnected(async (peerId) => {
    const userId = findUserIdByPeerId(peerId);
    if (!userId) return;
    try {
      const pending = await messageDB.getUndeliveredMessages(userId);
      for (const msg of pending) {
        const delivered = await state.transport.send(msg.data, peerId).catch(() => false);
        if (delivered) {
          await messageDB.markMessageSent(msg.data.id || msg.data.packetId);
        }
      }
    } catch (e) {
      console.warn('onPeerConnected retry failed:', e);
    }
  });

  state.transport.onRemoteAudioStream((peerId, stream) => {
    bindRemoteAudioStream(stream, peerId);
  });

  state.multiplexer.onMessage(async (packet, fromPeerId) => {
    await processIncomingPacket(packet, fromPeerId);
  });

  // Single-device enforcement: if another session logs in with same userId,
  // server sends us force_logout via SSE.
  const signalingForKick = getSignaling();
  if (signalingForKick) {
    signalingForKick.onSignal('force_logout', () => {
      setStatus('warning', 'Выполнен вход с другого устройства. Сессия завершена.');
      setTimeout(() => window.logoutAccount(), 1500);
    });
  }

  try {
    await state.transport.ready;
    await updateInviteArtifacts();
    pullInbox().catch((e) => console.warn('Inbox pull after connect:', e));
    clearInterval(inboxTimer);
    inboxTimer = setInterval(() => pullInbox().catch(() => {}), 3000);
  } catch (error) {
    console.error('Handshake connect failed:', error);
  }
};

async function checkUserExists(userId) {
  const serverUrl = resolveSignalingUrl();
  if (!serverUrl) return false;
  try {
    const response = await fetch(new URL(`/identity/${encodeURIComponent(userId)}`, serverUrl));
    return response.ok;
  } catch {
    return false;
  }
}

async function checkUserBanned(userId) {
  const serverUrl = resolveSignalingUrl();
  if (!serverUrl) return false;
  try {
    const response = await fetch(new URL(`/admin/check-banned/${encodeURIComponent(userId)}`, serverUrl));
    if (!response.ok) return false;
    const data = await response.json();
    return data.banned || false;
  } catch {
    return false;
  }
}

// Fields that are safe to sync to the server for multi-device support.
// Message previews (lastMsg/lastTime), presence and runtime peer info are
// intentionally excluded — the host must never see what was said or when.
const SYNCED_CONTACT_FIELDS = ['id', 'displayName', 'alias', 'publicKeyHex', 'blocked', 'createdAt', 'updatedAt'];

function sanitizeContactForServer(contact) {
  const out = {};
  for (const field of SYNCED_CONTACT_FIELDS) {
    if (contact[field] !== undefined) out[field] = contact[field];
  }
  return out;
}

async function syncContactsToServer() {
  if (!state.profile) return;
  const serverUrl = resolveSignalingUrl();
  if (!serverUrl) return;
  const contacts = Array.from(state.contacts.values()).map(sanitizeContactForServer);
  try {
    await fetch(new URL('/contacts/save', serverUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: state.profile.userId, contacts })
    });
  } catch (e) {
    console.warn('Contact sync to server failed:', e);
  }
}

async function syncContactsFromServer() {
  if (!state.profile) return;
  const serverUrl = resolveSignalingUrl();
  if (!serverUrl) return;
  try {
    const response = await fetch(new URL(`/contacts/load/${encodeURIComponent(state.profile.userId)}`, serverUrl));
    if (!response.ok) return;
    const { contacts = [] } = await response.json();
    for (const contact of contacts) {
      if (!contact || contact.id === state.profile.userId) continue;
      const existing = state.contacts.get(contact.id);
      if (existing) {
        if ((contact.updatedAt || 0) > (existing.updatedAt || 0)) {
          await upsertContact(contact.id, { ...existing, ...contact });
        }
      } else {
        await upsertContact(contact.id, contact);
      }
    }
  } catch (e) {
    console.warn('Contact sync from server failed:', e);
  }
}

// ==================== GROUP CHAT ====================

async function loadGroups() {
  if (!state.profile) return;
  const serverUrl = resolveSignalingUrl();
  if (!serverUrl) return;
  try {
    const response = await fetch(new URL(`/groups/${encodeURIComponent(state.profile.userId)}`, serverUrl));
    if (!response.ok) return;
    const { groups = [] } = await response.json();
    for (const group of groups) {
      state.groups.set(group.groupId, group);
    }
  } catch (e) {
    console.warn('Load groups failed:', e);
  }
}

let groupCreationMembers = new Set();
let groupCreationAvatar = null;

window.openNewMessage = () => {
  const page = $('newMessagePage');
  if (!page) return;
  page.classList.add('open');
  renderNewMessageContacts();
};

window.closeNewMessage = () => {
  $('newMessagePage')?.classList.remove('open');
};

function renderNewMessageContacts() {
  const container = $('newMessageContactList');
  if (!container) return;
  container.innerHTML = '';
  for (const [id, contact] of state.contacts) {
    const initials = getContactInitials(contact.displayName || id);
    const btn = document.createElement('button');
    btn.className = 'contact-item';
    btn.innerHTML = `
      <div class="contact-avatar contact-avatar-clickable">${getAvatarHtml(id, initials)}</div>
      <div class="contact-info">
        <div class="contact-name-row">
          <span class="contact-name">${escapeHtml(getContactLabel(contact))}</span>
        </div>
        <span class="contact-preview">${getOnlineStatusText(contact)}</span>
      </div>
    `;
    btn.onclick = () => {
      closeNewMessage();
      openChat(id);
    };
    container.appendChild(btn);
  }
}

window.openCreateGroup = () => {
  closeNewMessage();
  const page = $('createGroupPage');
  if (!page) return;
  groupCreationMembers = new Set();
  groupCreationAvatar = null;
  $('groupNameInput').value = '';
  $('groupAvatarPreview').textContent = 'G';
  $('groupAvatarPreview').innerHTML = 'G';
  $('createGroupStep2').hidden = true;
  $('createGroupStep1').hidden = false;
  $('createGroupNextBtn').textContent = 'Далее';
  page.classList.add('open');
  renderCreateGroupContacts();
};

window.closeCreateGroup = () => {
  $('createGroupPage')?.classList.remove('open');
};

function renderCreateGroupContacts() {
  const container = $('createGroupContactList');
  if (!container) return;
  container.innerHTML = '';
  for (const [id, contact] of state.contacts) {
    const initials = getContactInitials(contact.displayName || id);
    const checked = groupCreationMembers.has(id) ? 'checked' : '';
    const item = document.createElement('div');
    item.className = 'contact-checkbox-item';
    item.innerHTML = `
      <div class="checkbox ${checked}"></div>
      <div class="contact-avatar">${getAvatarHtml(id, initials)}</div>
      <div class="contact-info">
        <div class="contact-name-row">
          <span class="contact-name">${escapeHtml(getContactLabel(contact))}</span>
        </div>
      </div>
    `;
    item.onclick = () => {
      if (groupCreationMembers.has(id)) {
        groupCreationMembers.delete(id);
      } else {
        groupCreationMembers.add(id);
      }
      renderCreateGroupContacts();
      updateCreateGroupSelectedCount();
    };
    container.appendChild(item);
  }
}

window.createGroupNextStep = () => {
  $('createGroupStep1').hidden = true;
  $('createGroupStep2').hidden = false;
  $('createGroupNextBtn').textContent = 'Готово';
  updateCreateGroupSelectedCount();
};

function updateCreateGroupSelectedCount() {
  const el = $('groupSelectedCount');
  if (el) {
    const count = groupCreationMembers.size;
    el.textContent = count > 0 ? `Выбрано участников: ${count}` : 'Участники не выбраны (можно добавить позже)';
  }
}

window.handleGroupAvatar = (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  event.target.value = '';
  const reader = new FileReader();
  reader.onload = (e) => {
    groupCreationAvatar = e.target.result;
    const preview = $('groupAvatarPreview');
    if (preview) preview.innerHTML = `<img src="${e.target.result}" style="width:100%;height:100%;object-fit:cover;object-position:center;display:block;">`;
  };
  reader.readAsDataURL(file);
};

window.finishCreateGroup = async () => {
  if (!state.profile) return;
  const name = ($('groupNameInput')?.value || '').trim() || 'Unnamed Group';
  const groupId = `#${crypto.randomUUID()}`;
  const members = Array.from(groupCreationMembers).map((userId) => ({
    userId,
    role: 'member',
    addedAt: Date.now()
  }));
  members.push({ userId: state.profile.userId, role: 'admin', addedAt: Date.now() });

  const serverUrl = resolveSignalingUrl();
  if (!serverUrl) return;

  try {
    const response = await fetch(new URL('/groups/create', serverUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        groupId,
        name,
        avatarData: groupCreationAvatar || null,
        createdBy: state.profile.userId,
        members
      })
    });
    if (!response.ok) throw new Error('Create group failed');
    const data = await response.json();
    state.groups.set(groupId, data.group);
    closeCreateGroup();
    await openChat(groupId);
  } catch (e) {
    console.warn('Create group error:', e);
    setStatus('error', 'Не удалось создать группу');
  }
};

window.openGroupInfo = () => {
  const group = state.groups.get(state.currentChatId);
  if (!group) return;
  const page = $('groupInfoPage');
  if (!page) return;
  const initials = getContactInitials(group.name);
  const avatarEl = $('groupInfoAvatar');
  if (avatarEl) {
    if (group.avatarData) {
      avatarEl.innerHTML = `<img src="${group.avatarData}" style="width:100%;height:100%;object-fit:cover;object-position:center;display:block;">`;
    } else {
      avatarEl.textContent = initials;
    }
  }
  const nameEl = $('groupInfoName');
  if (nameEl) nameEl.textContent = group.name;
  const countEl = $('groupInfoMemberCount');
  if (countEl) {
    const count = group.members.length;
    countEl.textContent = `${count} ${count === 1 ? 'участник' : 'участников'}`;
  }
  const numEl = $('groupInfoMembersNum');
  if (numEl) numEl.textContent = group.members.length;
  const deleteBtn = $('deleteGroupBtn');
  if (deleteBtn) {
    const isAdmin = group.members.some((m) => m.userId === state.profile?.userId && m.role === 'admin');
    deleteBtn.style.display = isAdmin ? '' : 'none';
  }

  const listEl = $('groupInfoMemberList');
  if (listEl) {
    listEl.innerHTML = '';
    for (const member of group.members) {
      const contact = state.contacts.get(member.userId);
      const displayName = contact?.displayName || member.userId;
      const initials = getContactInitials(displayName);
      const roleLabel = member.role === 'admin' ? 'создатель' : '';
      const item = document.createElement('div');
      item.className = 'profile-page-row';
      item.style.padding = '10px 16px';
      item.innerHTML = `
        <div class="contact-avatar" style="width:36px;height:36px;min-width:36px;font-size:14px;">${getAvatarHtml(member.userId, initials)}</div>
        <div class="profile-page-row-content">
          <div style="font-size:15px;">${escapeHtml(displayName)}</div>
          ${roleLabel ? `<div style="font-size:12px;color:var(--muted);">${roleLabel}</div>` : ''}
        </div>
      `;
      listEl.appendChild(item);
    }
  }
  page.classList.add('open');
};

window.closeGroupInfo = () => {
  $('groupInfoPage')?.classList.remove('open');
};

window.leaveGroup = async () => {
  const group = state.groups.get(state.currentChatId);
  if (!group || !state.profile) return;
  const serverUrl = resolveSignalingUrl();
  if (serverUrl) {
    try {
      await fetch(new URL('/groups/leave', serverUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId: state.currentChatId, userId: state.profile.userId })
      });
    } catch (e) {
      console.warn('Leave group API call failed:', e);
    }
  }
  state.groups.delete(state.currentChatId);
  state.unreadCounts.delete(state.currentChatId);
  await messageDB.deleteChat(state.currentChatId);
  closeGroupInfo();
  await goBackFromChat();
};

window.deleteGroup = async () => {
  const group = state.groups.get(state.currentChatId);
  if (!group || !state.profile) return;
  if (group.members.filter((m) => m.role === 'admin').length === 0 ||
    !group.members.some((m) => m.userId === state.profile.userId && m.role === 'admin')) {
    setStatus('error', 'Только создатель может удалить группу');
    return;
  }
  if (!confirm('Удалить группу для всех участников? Это действие необратимо.')) return;
  const serverUrl = resolveSignalingUrl();
  if (serverUrl) {
    try {
      const resp = await fetch(new URL('/groups/delete', serverUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId: state.currentChatId, userId: state.profile.userId })
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        setStatus('error', err.error || 'Не удалось удалить группу');
        return;
      }
    } catch (e) {
      console.warn('Delete group failed:', e);
      setStatus('error', 'Ошибка сети при удалении группы');
      return;
    }
  }
  state.groups.delete(state.currentChatId);
  state.unreadCounts.delete(state.currentChatId);
  await messageDB.deleteChat(state.currentChatId);
  closeGroupInfo();
  await goBackFromChat();
};

window.onContactSearch = (value) => {
  state.contactFilter = value || '';
  renderContacts();
};

window.addContactById = async () => {
  const primaryInput = $('addUserId');
  const sourceInput = primaryInput;
  const raw = (sourceInput?.value || '').replace(/^@+/, '');
  const userId = normalizeLogin(raw);
  if (!userId || !state.profile) return;
  if (!isValidLogin(userId)) {
    setStatus('warn', 'Введите логин вида @login');
    return;
  }
  if (userId === state.profile.userId) return;

  const exists = await checkUserExists(userId);
  if (!exists) {
    setStatus('error', 'Пользователь с таким логином не найден');
    return;
  }

  // Create or update contact with temporary displayName (will be updated from peer discovery)
  const existing = state.contacts.get(userId);
  await upsertContact(userId, {
    displayName: existing?.displayName || userId,
    lastMsg: existing?.lastMsg || '',
    activePeerId: null,
    online: false
  });

  ensureAvatarForContact(userId).catch(() => {});

  // Pass array (not iterator) to setAllowedUserIds
  state.transport?.setAllowedUserIds?.(Array.from(state.contacts.keys()));

  // Try to find peer and update displayName from server
  if (state.transport) {
    const peer = await state.transport.findPeerByUserId(userId).catch(() => null);
    if (peer) {
      await upsertContact(userId, {
        displayName: peer.displayName || userId,
        activePeerId: peer.peerId,
        online: !peer.hideOnline,
        hideOnline: Boolean(peer.hideOnline),
        lastSeen: peer.lastSeen || null,
        roomId: peer.roomId,
        publicKeyHex: peer.publicKey || existing?.publicKeyHex
      });
    }
  }

  if (primaryInput) primaryInput.value = '';
  renderContacts();
  await openChat(userId);
  syncContactsToServer().catch(() => {});
};

window.copyAppShareLink = async () => {
  await navigator.clipboard.writeText(buildAppShareLink());
};

window.copyInviteLink = window.copyAppShareLink;

// ==================== SUPERUSER ADMIN FUNCTIONS ====================

window.generateInvite = async () => {
  if (!state.profile) return;
  const serverUrl = resolveSignalingUrl();
  if (!serverUrl) return;
  try {
    const resp = await fetch(new URL('/admin/invite/create', serverUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: state.profile.userId })
    });
    if (!resp.ok) throw new Error('Failed to create invite');
    const data = await resp.json();
    const inviteUrl = `${window.location.origin}/?invite=${data.code}`;
    const resultEl = $('adminInviteResult');
    if (resultEl) {
      resultEl.innerHTML = `<a href="${inviteUrl}" target="_blank" style="color:var(--accent);">${inviteUrl}</a>
        <button class="btn subtle" style="font-size:11px;padding:2px 8px;margin-top:4px;" onclick="navigator.clipboard.writeText('${inviteUrl}')">Копировать</button>`;
    }
    loadAdminUsers();
  } catch (e) {
    console.warn('Generate invite failed:', e);
  }
};

async function loadAdminUsers() {
  if (!state.profile) return;
  const serverUrl = resolveSignalingUrl();
  if (!serverUrl) return;
  try {
    const resp = await fetch(new URL('/admin/users', serverUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: state.profile.userId })
    });
    if (!resp.ok) return;
    const data = await resp.json();
    const list = $('adminUserList');
    if (!list) return;
    list.innerHTML = '';
    for (const user of data.users || []) {
      if (user.userId === state.profile.userId) continue;
      const item = document.createElement('div');
      item.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 4px;border-bottom:1px solid var(--line);font-size:13px;';
      const avatarDiv = document.createElement('div');
      avatarDiv.style.cssText = 'width:28px;height:28px;border-radius:50%;overflow:hidden;background:var(--panel-input);display:flex;align-items:center;justify-content:center;font-size:12px;flex-shrink:0;';
      if (user.hasAvatar) {
        avatarDiv.innerHTML = `<img src="${new URL(`/profile/avatar/${encodeURIComponent(user.userId)}`, serverUrl)}" style="width:100%;height:100%;object-fit:cover;">`;
      } else {
        avatarDiv.textContent = (user.displayName || user.userId).charAt(1).toUpperCase() || '?';
      }
      const info = document.createElement('div');
      info.style.cssText = 'flex:1;min-width:0;';
      const nameSpan = document.createElement('div');
      nameSpan.textContent = user.displayName || user.userId;
      nameSpan.style.cssText = 'font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      const idSpan = document.createElement('div');
      idSpan.textContent = user.userId;
      idSpan.style.cssText = 'font-size:11px;color:var(--muted);';
      info.appendChild(nameSpan);
      info.appendChild(idSpan);
      const statusSpan = document.createElement('span');
      statusSpan.style.cssText = `font-size:11px;${user.online ? 'color:var(--online);' : 'color:var(--muted);'}`;
      statusSpan.textContent = user.online ? 'online' : 'offline';
      const banBtn = document.createElement('button');
      banBtn.style.cssText = 'font-size:11px;padding:2px 8px;border-radius:8px;border:1px solid;';
      if (user.banned) {
        banBtn.textContent = 'Разбан';
        banBtn.style.borderColor = 'var(--online)';
        banBtn.style.color = 'var(--online)';
        banBtn.onclick = () => unbanUser(user.userId);
      } else {
        banBtn.textContent = 'Бан';
        banBtn.style.borderColor = 'var(--danger)';
        banBtn.style.color = 'var(--danger)';
        banBtn.onclick = () => banUser(user.userId);
      }
      item.appendChild(avatarDiv);
      item.appendChild(info);
      item.appendChild(statusSpan);
      item.appendChild(banBtn);
      list.appendChild(item);
    }
  } catch (e) {
    console.warn('Load admin users failed:', e);
  }
}

async function banUser(targetUserId) {
  if (!state.profile || !confirm(`Заблокировать ${targetUserId}?`)) return;
  const serverUrl = resolveSignalingUrl();
  if (!serverUrl) return;
  try {
    await fetch(new URL('/admin/ban', serverUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: state.profile.userId, targetUserId })
    });
    loadAdminUsers();
  } catch (e) {
    console.warn('Ban failed:', e);
  }
}

async function unbanUser(targetUserId) {
  if (!state.profile) return;
  const serverUrl = resolveSignalingUrl();
  if (!serverUrl) return;
  try {
    await fetch(new URL('/admin/unban', serverUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: state.profile.userId, targetUserId })
    });
    loadAdminUsers();
  } catch (e) {
    console.warn('Unban failed:', e);
  }
}

window.renameCurrentContact = async () => {
  openChatMenu();
};

window.clearCurrentHistory = async (scope = 'me') => {
  if (!state.currentChatId) return;
  const chatId = state.currentChatId;
  if (scope === 'all') {
    await sendMessageControl({ action: 'clear_chat' }, chatId);
  }
  await clearPendingCallControls(chatId);
  await messageDB.deleteChat(chatId);
  state.selectedMessageIds.clear();
  const contact = state.contacts.get(chatId);
  if (contact) {
    await upsertContact(chatId, {
      ...contact,
      lastMsg: '',
      lastTime: 0
    });
  }
  await renderChatHistory(chatId);
  closeChatMenu();
};

window.selectCurrentChatMessages = () => {};

window.clearMessageSelection = () => {
  state.selectedMessageIds.clear();
  updateSelectionUI();
};

window.deleteSelectedMessages = async (scope = 'me') => {
  if (!state.currentChatId || state.selectedMessageIds.size === 0) return;
  const chatId = state.currentChatId;
  const ids = Array.from(state.selectedMessageIds);
  const messages = await messageDB.getMessages(chatId);
  const selected = messages.filter((message) => ids.includes(message.id));
  const packetIds = selected.map((message) => message.packetId).filter(Boolean);

  if (scope === 'all') {
    const isGroup = chatId.startsWith('#');
    if (isGroup) {
      const serverUrl = resolveSignalingUrl();
      if (serverUrl) {
        try {
          await fetch(new URL('/groups/delete-messages', serverUrl), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              groupId: chatId,
              userId: state.profile.userId,
              packetIds
            })
          });
        } catch (e) {
          console.warn('Group delete for everyone failed:', e);
        }
      }
    } else {
      await sendMessageControl({ action: 'delete_messages', packetIds }, chatId);
    }
  }

  await messageDB.deleteMessages(ids);
  state.selectedMessageIds.clear();
  await renderChatHistory(chatId);
};

async function sendMessageControl(payload, chatId = state.currentChatId) {
  if (!chatId || !state.profile) return false;
  const packet = {
    type: 'message_control',
    senderId: state.profile.userId,
    timestamp: Date.now(),
    recipientId: chatId,
    ...payload
  };
  const targetPeerId = await resolvePeerForUser(chatId);

  // Route through the multiplexer: it tries the Signaling relay first (delivers to
  // online peers via their poll queue and persists to the inbox for offline ones)
  // and falls back to the WebRTC data channel. The packet carries recipientId, so
  // the relay can address the recipient even when targetPeerId is unknown.
  try {
    await state.multiplexer.send(packet, targetPeerId);
    return true;
  } catch (error) {
    console.warn('Message control send failed, queuing:', error);
    await queuePendingMessageControl(chatId, packet);
    return true;
  }
}

function pendingControlsKey(chatId) {
  return `pendingMessageControls:${chatId}`;
}

async function queuePendingMessageControl(chatId, packet) {
  const key = pendingControlsKey(chatId);
  const pending = await messageDB.getSetting(key) || [];
  pending.push({
    ...packet,
    controlId: packet.controlId || crypto.randomUUID()
  });
  await messageDB.saveSetting(key, pending);
}

const MAX_PENDING_CALL_AGE_MS = 120000;

async function clearPendingCallControls(chatId) {
  if (!chatId) return;
  await messageDB.saveSetting(pendingCallControlsKey(chatId), []);
}

async function sendCallControl(action, callId, userId, peerId = null, extra = {}) {
  if (!userId || !state.profile) return false;
  const packet = {
    type: 'call',
    action,
    callId,
    senderId: state.profile.userId,
    recipientId: userId,
    ...extra
  };

  let targetPeerId = peerId;
  if (!targetPeerId) {
    targetPeerId = await resolvePeerForUser(userId).catch(() => null);
  }

  try {
    if (state.signalingRelay) {
      await state.signalingRelay.ready;
      await state.signalingRelay.send(packet, targetPeerId, userId);
      return true;
    }
  } catch (error) {
    console.warn('Call control relay failed:', error);
  }

  if (!targetPeerId) {
    await queuePendingCallControl(userId, packet);
    return true;
  }

  try {
    await state.multiplexer.send(packet, targetPeerId);
    return true;
  } catch (error) {
    await queuePendingCallControl(userId, packet);
    return true;
  }
}

function pendingCallControlsKey(chatId) {
  return `pendingCallControls:${chatId}`;
}

async function queuePendingCallControl(chatId, packet) {
  const key = pendingCallControlsKey(chatId);
  const pending = await messageDB.getSetting(key) || [];
  pending.push({
    ...packet,
    controlId: packet.controlId || crypto.randomUUID(),
    queuedAt: Date.now()
  });
  await messageDB.saveSetting(key, pending);
}

function filterFreshCallControls(pending) {
  const now = Date.now();
  const fresh = (pending || []).filter((p) => now - (p.queuedAt || 0) < MAX_PENDING_CALL_AGE_MS);
  const nonInvites = fresh.filter((p) => p.action !== 'invite');
  const invites = fresh.filter((p) => p.action === 'invite');
  const latestInvite = invites.length ? invites[invites.length - 1] : null;
  return [...nonInvites, ...(latestInvite ? [latestInvite] : [])];
}

async function flushPendingCallControls(chatId, targetPeerId) {
  if (!state.multiplexer || !chatId || !targetPeerId) return;
  const key = pendingCallControlsKey(chatId);
  const pending = filterFreshCallControls(await messageDB.getSetting(key) || []);
  if (!pending.length) {
    await messageDB.saveSetting(key, []);
    return;
  }

  const remaining = [];
  for (const packet of pending) {
    const { controlId, queuedAt, ...outgoing } = packet;
    try {
      if (state.signalingRelay) {
        await state.signalingRelay.ready;
        await state.signalingRelay.send({ ...outgoing, recipientId: chatId }, targetPeerId, chatId);
      } else {
        await state.multiplexer.send(outgoing, targetPeerId);
      }
    } catch (error) {
      remaining.push(packet);
    }
  }
  await messageDB.saveSetting(key, remaining);
}

async function tryStartCallerAudio(chatId) {
  if (state.activeCall?.role !== 'caller' || state.activeCall?.peerUserId !== chatId) return;
  const peerId = state.activeCall.remotePeerId || await resolvePeerForUser(chatId).catch(() => null);
  if (!peerId) return;
  state.activeCall.remotePeerId = peerId;
  await flushPendingCallControls(chatId, peerId);
  await state.transport.startAudioCallWithLocalMedia(peerId, { asOfferer: true }).catch((e) => {
    console.warn('Caller audio setup failed:', e);
  });
}

async function flushPendingMessageControls(chatId, targetPeerId) {
  if (!state.multiplexer || !targetPeerId) return;
  const key = pendingControlsKey(chatId);
  const pending = await messageDB.getSetting(key) || [];
  if (!pending.length) return;

  const remaining = [];
  for (const packet of pending) {
    try {
      if (state.signalingRelay) {
        await state.signalingRelay.ready;
        await state.signalingRelay.send({ ...packet, recipientId: chatId }, targetPeerId, chatId);
      } else {
        await state.multiplexer.send(packet, targetPeerId);
      }
    } catch (error) {
      remaining.push(packet);
    }
  }
  await messageDB.saveSetting(key, remaining);
}

window.deleteCurrentChat = async () => {
  if (!state.currentChatId) return;
  const chatId = state.currentChatId;
  await messageDB.deleteChat(chatId);
  state.selectedMessageIds.clear();
  if (!state.groups.has(chatId)) {
    const contact = state.contacts.get(chatId);
    if (contact) {
      await upsertContact(chatId, { ...contact, lastMsg: '', lastTime: 0 });
    }
  }
  state.currentChatId = null;
  renderContacts();
  renderChatHeader();
  updateSelectionUI();
  $('messages').innerHTML = '<div class="empty-chat">История очищена</div>';
  closeChatMenu();
  updateMobileLayout();
};

async function resolvePeerForUser(userId) {
  const contact = state.contacts.get(userId);
  let targetPeerId = contact?.activePeerId;

  // If we have a cached peerId, verify it's still valid by checking onlinePeers
  if (targetPeerId && state.transport?.onlinePeers) {
    if (!state.transport.onlinePeers.has(targetPeerId)) {
      // Cached peerId is stale — clear it and try fresh lookup
      targetPeerId = null;
    }
  }

  if (!targetPeerId && state.transport?.findPeerByUserId) {
    const resolvedPeer = await state.transport.findPeerByUserId(userId).catch(() => null);
    if (resolvedPeer?.peerId) {
      targetPeerId = resolvedPeer.peerId;
      await upsertContact(userId, {
        ...contact,
        activePeerId: targetPeerId,
        online: true
      });
    }
  }

  return targetPeerId || null;
}

window.sendCurrentMessage = async () => {
  const input = $('messageInput');
  const text = input.value.trim();
  if (!text || !state.currentChatId || !state.multiplexer || !state.profile) return;

  const chatId = state.currentChatId;
  const isGroup = state.groups.has(chatId);

  if (!isGroup) {
    const contact = state.contacts.get(chatId);
    if (contact?.blocked) {
      setStatus('warning', 'Контакт заблокирован. Сначала разблокируйте.');
      return;
    }
  }

  const packet = {
    packetId: crypto.randomUUID(),
    type: 'text',
    content: text,
    senderId: state.profile.userId,
    senderName: state.profile.displayName,
    senderPublicKey: getPublicKeyHex(state.keyPair),
    timestamp: Date.now()
  };

  input.value = '';
  // Update send button back to mic
  const btn = $('sendBtn');
  if (btn) {
    const icon = btn.querySelector('.material-icons');
    if (icon) icon.textContent = 'mic';
  }

  const dbKey = await messageDB.saveMessage(packet, chatId, false, { isOutgoing: true });
  packet._dbId = dbKey;

  if (!isGroup) {
    const contact = state.contacts.get(chatId);
    await upsertContact(chatId, {
      ...contact,
      lastMsg: text,
      lastTime: packet.timestamp
    });
  }

  if (state.currentChatId === chatId) {
    addMessageToUI(packet, true, { pending: true });
  }

  // deliverOutgoingMessage performs E2E encryption before the packet ever touches
  // a transport — we must NEVER put the plaintext packet on the wire ourselves.
  // If the peer is offline the message simply stays saved as undelivered and is
  // retried from onPeerDiscovery, so no separate queue is needed here.
  deliverOutgoingMessage(chatId, packet).catch((error) => {
    console.warn('Send failed, will retry when peer is online:', error);
  });
};

async function deliverOutgoingMessage(chatId, packet) {
  const group = state.groups.get(chatId);

  if (group) {
    const serverUrl = resolveSignalingUrl();
    if (!serverUrl) return;

    const members = group.members.filter((m) => m.userId !== state.profile.userId);
    const perRecipient = {};

    for (const member of members) {
      const contact = state.contacts.get(member.userId);
      let pubKey = contact?.publicKeyHex;
      if (!pubKey) {
        pubKey = await fetchPeerPublicKey(serverUrl, member.userId);
      }
      if (pubKey) {
        try {
          const { ciphertext, iv } = await encryptMessage(packet.content, pubKey, state.keyPair);
          perRecipient[member.userId] = { content: ciphertext, iv };
        } catch (e) {
          console.warn(`Encrypt for ${member.userId} failed:`, e);
        }
      }
    }

    const { content: _plaintext, ...packetMeta } = packet;
    try {
      const response = await fetch(new URL('/groups/message', serverUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          groupId: chatId,
          fromUserId: state.profile.userId,
          packet: {
            ...packetMeta,
            senderId: state.profile.userId,
            senderName: state.profile.displayName,
            senderPublicKey: getPublicKeyHex(state.keyPair),
            recipientId: chatId,
            perRecipient
          }
        })
      });
      if (response.ok) {
        await messageDB.markMessageSent(packet._dbId || packet.id);
        markMessageDelivered(packet._dbId || packet.id);
      }
    } catch (e) {
      console.warn('Group send failed:', e);
    }
    return;
  }

  const contact = state.contacts.get(chatId);
  packet.recipientId = chatId;
  const targetPeerId = await resolvePeerForUser(chatId);

  // Encrypt first (E2E) — this happens regardless of how we deliver, so the relay
  // never carries plaintext.
  const encryptedPacket = { ...packet };
  let recipientPubKey = contact?.publicKeyHex;
  if (!recipientPubKey) {
    recipientPubKey = await fetchPeerPublicKey(resolveSignalingUrl(), chatId);
  }
  if (recipientPubKey) {
    try {
      const { ciphertext, iv } = await encryptMessage(packet.content, recipientPubKey, state.keyPair);
      encryptedPacket.content = ciphertext;
      encryptedPacket.iv = iv;
      encryptedPacket.encrypted = true;
      encryptedPacket.senderPublicKey = getPublicKeyHex(state.keyPair);
    } catch (e) {
      console.warn('Encrypt failed, sending plaintext:', e);
    }
  }

  try {
    if (targetPeerId) {
      // Known peer: multiplexer (Signaling relay first, WebRTC fallback).
      await state.multiplexer.send(encryptedPacket, targetPeerId);
    } else if (state.signalingRelay) {
      // Peer not currently resolvable. Still deliver via the relay addressed by
      // userId — the server forwards to the peer's poll queue and persists to its
      // inbox, so the message arrives without us having to wait for a fresh
      // peer-discovery event. (A null multiplexer target would broadcast to all.)
      await state.signalingRelay.ready;
      await state.signalingRelay.send(encryptedPacket, null, chatId);
    } else {
      return; // no transport available — stays undelivered, retried on discovery
    }
    await messageDB.markMessageSent(packet._dbId || packet.id);
    const previewText = packet.type === 'voice' ? '🎙 Голосовое' : packet.content;
    await upsertContact(chatId, {
      ...contact,
      lastMsg: previewText,
      lastTime: packet.timestamp,
      ...(targetPeerId ? { activePeerId: targetPeerId, online: true } : {})
    });
    markMessageDelivered(packet._dbId || packet.id);
  } catch (error) {
    console.warn('Send failed, will retry when peer is online:', error);
  }
}

function renderProfile() {
  const isAuthenticated = Boolean(state.profile);
  if (!isAuthenticated) return;

  // Don't clobber the field while the user is editing it — otherwise a re-render
  // triggered mid-typing would wipe the unsaved name (felt like "name won't save").
  const nameInput = $('displayNameInput');
  if (nameInput && document.activeElement !== nameInput) {
    nameInput.value = state.profile.displayName;
  }
  renderProfileCards();
  updateSettingsPanel();
}

// Clear a chat's local history and reset its preview. Mirrors the "Удалить чат"
// menu action but works for any chat id (used by the swipe-to-delete gesture).
async function deleteChatById(id) {
  if (!id) return;
  await messageDB.deleteChat(id);
  state.unreadCounts.delete(id);
  if (!state.groups.has(id)) {
    const contact = state.contacts.get(id);
    if (contact) await upsertContact(id, { ...contact, lastMsg: '', lastTime: 0 });
  }
  if (state.currentChatId === id) {
    state.currentChatId = null;
    state.selectedMessageIds.clear();
    renderChatHeader();
    const messages = $('messages');
    if (messages) messages.innerHTML = '<div class="empty-chat">История очищена</div>';
    updateMobileLayout();
  }
  renderContacts();
  refreshDocTitle();
}

// Wrap a chat list row so a right-to-left swipe reveals an iOS-style Delete action.
function makeSwipeToDelete(itemEl, id) {
  const row = document.createElement('div');
  row.className = 'swipe-row';

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'swipe-delete';
  del.textContent = 'Удалить';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!confirm('Удалить чат и всю переписку?')) return;
    deleteChatById(id);
  });

  row.appendChild(del);
  row.appendChild(itemEl);

  const OPEN = 88;     // px the row slides to expose the action
  const THRESHOLD = 44;
  let startX = 0, startY = 0, dx = 0;
  let dragging = false, decided = false, horizontal = false, open = false;

  const close = () => { open = false; row.classList.remove('open'); itemEl.style.transform = ''; };
  const openRow = () => { open = true; row.classList.add('open'); itemEl.style.transform = `translateX(${-OPEN}px)`; };

  itemEl.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    dragging = true; decided = false; horizontal = false; dx = 0;
    row.classList.add('swiping');
  }, { passive: true });

  itemEl.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    if (!decided) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      decided = true;
      horizontal = Math.abs(dx) > Math.abs(dy);
    }
    if (!horizontal) return; // vertical intent → let the list scroll
    e.preventDefault();
    let x = (open ? -OPEN : 0) + dx;
    if (x > 0) x = 0;
    if (x < -OPEN - 24) x = -OPEN - 24;
    itemEl.style.transform = `translateX(${x}px)`;
  }, { passive: false });

  const end = () => {
    if (!dragging) return;
    dragging = false;
    row.classList.remove('swiping');
    if (horizontal) {
      const finalX = (open ? -OPEN : 0) + dx;
      if (finalX <= -THRESHOLD) openRow(); else close();
    }
  };
  itemEl.addEventListener('touchend', end, { passive: true });
  itemEl.addEventListener('touchcancel', end, { passive: true });

  // While open, the first tap closes the row instead of opening the chat.
  itemEl.addEventListener('click', (e) => {
    if (open) { e.stopPropagation(); e.preventDefault(); close(); }
  }, true);

  return row;
}

function renderContacts() {
  const container1 = $('contacts');
  const container2 = $('contactsList');

  const renderContactItem = ([id, contact], isActive, showPreview = true, swipeable = false) => {
    const unread = state.unreadCounts.get(id) || 0;
    const initials = getContactInitials(contact.displayName || id);
    const preview = contact.blocked
      ? 'Заблокирован'
      : contact.lastMsg
        ? truncate(contact.lastMsg, 40)
        : '';
    const time = contact.lastTime ? formatDate(contact.lastTime) : '';

    const btn = document.createElement('button');
    btn.className = `contact-item ${isActive ? 'active' : ''}`;

    if (!showPreview) {
      btn.innerHTML = `
      <div class="contact-avatar contact-avatar-clickable">${getAvatarHtml(id, initials)}</div>
      <div class="contact-info">
        <div class="contact-name-row">
          <span class="contact-name">${escapeHtml(getContactLabel(contact))}</span>
        </div>
        <span class="contact-preview">${contact.online ? 'в сети' : 'не в сети'}</span>
      </div>
    `;
    } else {
      btn.innerHTML = `
      <div class="contact-avatar contact-avatar-clickable">${getAvatarHtml(id, initials)}</div>
      <div class="contact-info">
        <div class="contact-name-row">
          <span class="contact-name${unread > 0 ? ' has-unread' : ''}">${escapeHtml(getContactLabel(contact))}</span>
          <span class="contact-time">${time}</span>
        </div>
        ${preview ? `<span class="contact-preview${unread > 0 ? ' has-unread' : ''}">${escapeHtml(preview)}</span>` : ''}
      </div>
      ${unread > 0 ? `<div class="contact-right"><div class="contact-badge">${unread > 99 ? '99+' : unread}</div></div>` : ''}
    `;
    }

    const avatarEl = btn.querySelector('.contact-avatar-clickable');
    if (avatarEl) {
      avatarEl.addEventListener('click', (e) => {
        e.stopPropagation();
        openContactProfile(id);
      });
    }

    btn.onclick = () => openChat(id);
    return swipeable ? makeSwipeToDelete(btn, id) : btn;
  };

  const renderGroupItem = ([groupId, group], isActive, swipeable = false) => {
    const unread = state.unreadCounts.get(groupId) || 0;
    const initials = getContactInitials(group.name);
    const preview = 'Группа';
    const time = '';
    const btn = document.createElement('button');
    btn.className = `contact-item ${isActive ? 'active' : ''}`;
    btn.innerHTML = `
      <div class="contact-avatar contact-avatar-clickable" style="background:var(--online);">${group.avatarData ? `<img src="${group.avatarData}" style="width:100%;height:100%;object-fit:cover;">` : initials}</div>
      <div class="contact-info">
        <div class="contact-name-row">
          <span class="contact-name${unread > 0 ? ' has-unread' : ''}">${escapeHtml(group.name)}</span>
          <span class="contact-time">${time}</span>
        </div>
        <span class="contact-preview">${preview}</span>
      </div>
      ${unread > 0 ? `<div class="contact-right"><div class="contact-badge">${unread > 99 ? '99+' : unread}</div></div>` : ''}
    `;
    btn.onclick = () => openChat(groupId);
    return swipeable ? makeSwipeToDelete(btn, groupId) : btn;
  };

  const render = (container, grouped) => {
    if (!container) return;
    container.innerHTML = '';

    const q = state.contactFilter.toLowerCase().replace(/^@+/, '').trim();
    const matchesFilter = ([id, contact]) => {
      if (!q) return true;
      const label = getContactLabel(contact).toLowerCase();
      const userId = id.toLowerCase().replace(/^@+/, '');
      return label.includes(q) || userId.includes(q);
    };

    const items = Array.from(state.contacts.entries())
      .filter(([id]) => !isSelfContactId(id))
      .filter(matchesFilter);

    const allGroups = Array.from(state.groups.entries());
    const groupItems = q
      ? allGroups.filter(([, g]) => g.name?.toLowerCase().includes(q))
      : allGroups;

    if (items.length === 0 && groupItems.length === 0) {
      container.innerHTML = '<div class="empty" style="padding: 16px; text-align: center; color: var(--muted); font-size: 13px;">Нет контактов</div>';
      return;
    }

    if (!grouped) {
      for (const gItem of groupItems) {
        container.appendChild(renderGroupItem(gItem, gItem[0] === state.currentChatId, true));
      }
      if (groupItems.length > 0 && items.length > 0) {
        const divider = document.createElement('div');
        divider.style.cssText = 'height:1px;background:var(--line);margin:4px 12px;';
        container.appendChild(divider);
      }
      items.sort(([, left], [, right]) => {
        if (Boolean(right.online) !== Boolean(left.online)) {
          return Number(Boolean(right.online)) - Number(Boolean(left.online));
        }
        return (right.updatedAt || 0) - (left.updatedAt || 0);
      });
      for (const item of items) {
        container.appendChild(renderContactItem(item, item[0] === state.currentChatId, true, true));
      }
      return;
    }

    const groups = new Map();
    for (const item of items) {
      const label = getContactLabel(item[1]);
      const groupKey = getContactGroupKey(label);
      const list = groups.get(groupKey) || [];
      list.push(item);
      groups.set(groupKey, list);
    }

    const sortedGroupKeys = Array.from(groups.keys()).sort((left, right) => {
      if (left === '#') return 1;
      if (right === '#') return -1;
      return left.localeCompare(right, undefined, { sensitivity: 'base' });
    });

    for (const groupKey of sortedGroupKeys) {
      const heading = document.createElement('div');
      heading.className = 'contact-group-header';
      heading.textContent = groupKey;
      container.appendChild(heading);

      const groupItems = groups.get(groupKey) || [];
      groupItems.sort(([, a], [, b]) => compareContactLabels(a, b));
      for (const item of groupItems) {
        container.appendChild(renderContactItem(item, item[0] === state.currentChatId, false));
      }
    }
  };

  render(container1, false);
  render(container2, true);
}

function getAvatarHtml(userId, initials) {
  const url = getAvatarUrl(userId);
  if (url) {
    return `<img src="${escapeHtml(url)}" alt="" style="width:100%;height:100%;object-fit:cover;object-position:center;display:block;">`;
  }
  return initials;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(s, max) {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

async function openChat(id) {
  state.currentChatId = id;
  state.selectedMessageIds.clear();
  closeChatMenu();
  state.unreadCounts.delete(id);
  refreshDocTitle();
  renderContacts();
  renderChatHeader();
  await renderChatHistory(id);
  updateMobileLayout();
  if (state.groups.has(id)) {
    $('btnCall').hidden = true;
  }
}

window.goBackFromChat = () => {
  state.currentChatId = null;
  state.selectedMessageIds.clear();
  closeChatMenu();
  renderContacts();
  renderChatHeader();
  updateSelectionUI();
  $('messages').innerHTML = '<div class="empty-chat">Выберите чат</div>';
  updateMobileLayout();
};

async function hangupCallAudio(peerId) {
  stopRemoteAudioRetry();
  state.remoteAudioNeedsUnlock = false;
  const ra = $('remoteAudio');
  if (ra) ra.srcObject = null;
  _remoteAudioStream = null;
  if (state.transport && peerId) {
    await state.transport.stopLocalAudio(peerId);
  }
}

function startRingTone(kind) {
  stopRingTone();
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;

  try {
    const ctx = new AudioContextClass();
    const masterGain = ctx.createGain();
    masterGain.gain.value = kind === 'incoming' ? 0.07 : 0.04;
    masterGain.connect(ctx.destination);

    let stopped = false;

    if (kind === 'incoming') {
      // Incoming ringtone: two-tone melodic pattern (like a phone)
      // 440Hz for 0.15s, then 540Hz for 0.15s, repeat every 2s
      const playIncomingPulse = () => {
        if (stopped) return;
        const now = ctx.currentTime;
        const osc1 = ctx.createOscillator();
        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(440, now);
        osc1.connect(masterGain);
        osc1.start(now);
        osc1.stop(now + 0.15);

        const osc2 = ctx.createOscillator();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(540, now + 0.2);
        osc2.connect(masterGain);
        osc2.start(now + 0.2);
        osc2.stop(now + 0.35);
      };

      ctx.resume?.().catch(() => {});
      playIncomingPulse();
      const timer = window.setInterval(playIncomingPulse, 2000);
      state.ringTone = {
        stop: () => {
          stopped = true;
          window.clearInterval(timer);
          ctx.close().catch(() => {});
        }
      };
    } else if (kind === 'outgoing') {
      // Outgoing ringing (гудки): classic beep-beep pattern
      // 420Hz for 0.35s, silence 0.25s, 420Hz for 0.35s, silence 2s → repeat
      const playOutgoingPulse = () => {
        if (stopped) return;
        const now = ctx.currentTime;
        const osc1 = ctx.createOscillator();
        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(420, now);
        osc1.connect(masterGain);
        osc1.start(now);
        osc1.stop(now + 0.35);

        const osc2 = ctx.createOscillator();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(420, now + 0.6);
        osc2.connect(masterGain);
        osc2.start(now + 0.6);
        osc2.stop(now + 0.95);
      };

      ctx.resume?.().catch(() => {});
      playOutgoingPulse();
      const timer = window.setInterval(playOutgoingPulse, 3200);
      state.ringTone = {
        stop: () => {
          stopped = true;
          window.clearInterval(timer);
          ctx.close().catch(() => {});
        }
      };
    }
  } catch (error) {
    console.warn('Ring tone failed:', error);
  }
}

function playConnectingTone() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  try {
    const ctx = new AudioContextClass();
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.06, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    gain.connect(ctx.destination);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(380, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(720, ctx.currentTime + 0.25);
    osc.connect(gain);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.5);
    ctx.resume?.().catch(() => {});
    setTimeout(() => ctx.close().catch(() => {}), 600);
  } catch {}
}

function stopRingTone() {
  if (!state.ringTone) return;
  state.ringTone.stop();
  state.ringTone = null;
}

async function handleGroupEvent(packet) {
  const { action, groupId } = packet;
  if (!groupId) return;

  if (action === 'deleted') {
    const wasCurrent = state.currentChatId === groupId;
    state.groups.delete(groupId);
    state.unreadCounts.delete(groupId);
    await messageDB.deleteChat(groupId);
    if (wasCurrent) {
      closeGroupInfo();
      await goBackFromChat();
    } else {
      renderContacts();
    }
  }
}

async function handleCallControl(packet, fromPeerId) {
  const { action, callId } = packet;
  const peerUserId = packet.senderId || findUserIdByPeerId(fromPeerId);

  if (action === 'invite' && peerUserId && callId) {
    if (state.activeCall?.status === 'active') return;
    if (state.activeCall?.callId === callId) return;
    if (state.activeCall?.status === 'incoming' && state.activeCall.peerUserId === peerUserId) return;
    if (state.activeCall?.status === 'ringing' && state.activeCall.role === 'caller' && state.activeCall.peerUserId === peerUserId) {
      return;
    }

    if (fromPeerId) {
      state.transport?.expectVoiceAnswer?.(fromPeerId);
    }

    const existingContact = state.contacts.get(peerUserId);
    const resolvedDisplayName = packet.senderName && packet.senderName !== peerUserId
      ? packet.senderName
      : (existingContact?.displayName || peerUserId);

    const wasNew = !state.contacts.has(peerUserId);
    await upsertContact(peerUserId, {
      displayName: resolvedDisplayName,
      activePeerId: fromPeerId,
      online: true,
      roomId: state.transport?.options?.roomId
      // No lastMsg here — an incoming call must not become the chat preview.
    });

    if (wasNew) {
      state.transport?.setAllowedUserIds?.(Array.from(state.contacts.keys()));
    }

    if (state.activeCall?.status === 'active') return;

    state.activeCall = {
      callId,
      peerUserId,
      remotePeerId: fromPeerId,
      status: 'incoming',
      role: 'callee'
    };
    try {
      navigator.vibrate?.(100);
    } catch {}
    startRingTone('incoming');
    updateCallBar();
    updateMobileLayout();

    // Show system notification if app is in background
    const resolvedName = existingContact?.displayName || packet.senderName || peerUserId;
    notifyNewMessage({
      chatId: peerUserId,
      title: 'Входящий звонок',
      body: `${resolvedName} звонит вам`
    });
    return;
  }

  if (action === 'accept' && callId && state.activeCall?.role === 'caller' && state.activeCall.callId === callId) {
    stopRingTone();
    playConnectingTone();
    state.activeCall.status = 'active';
    const peerId = state.activeCall.remotePeerId || fromPeerId;
    if (peerId) {
      state.activeCall.remotePeerId = peerId;
      state.transport?.expectVoiceAnswer?.(peerId);
    }
    updateCallBar();
    queueMicrotask(() => playRemoteAudioIfReady(peerId));
    return;
  }

  if (action === 'reject' && callId && state.activeCall?.callId === callId) {
    stopRingTone();
    await clearPendingCallControls(state.activeCall.peerUserId);
    state.activeCall = null;
    updateCallBar();
    return;
  }

  if (action === 'end' && callId && state.activeCall?.callId === callId) {
    stopRingTone();
    const endedChatId = state.activeCall.peerUserId;
    await hangupCallAudio(fromPeerId);
    await clearPendingCallControls(endedChatId);
    state.activeCall = null;
    state.micMuted = false;
    updateCallBar();
  }
}

async function handleMessageControl(packet, fromPeerId) {
  const isGroup = packet.recipientId && packet.recipientId.startsWith('#');
  const chatId = isGroup ? packet.recipientId : (packet.senderId || findUserIdByPeerId(fromPeerId) || fromPeerId);
  if (packet.action === 'delete_messages') {
    await messageDB.deleteMessagesByPacketIds(chatId, packet.packetIds || []);
    if (state.currentChatId === chatId) {
      state.selectedMessageIds.clear();
      await renderChatHistory(chatId);
    }
  } else if (packet.action === 'clear_chat') {
    await clearPendingCallControls(chatId);
    await messageDB.deleteChat(chatId);
    if (state.currentChatId === chatId) {
      state.selectedMessageIds.clear();
      await renderChatHistory(chatId);
    }
    if (!isGroup) {
      const contact = state.contacts.get(chatId);
      if (contact) {
        await upsertContact(chatId, {
          ...contact,
          lastMsg: '',
          lastTime: 0
        });
      }
    }
  }
}

function updateSelectionUI() {
  const count = state.selectedMessageIds.size;
  const bar = $('selectionBar');
  const countEl = $('selectionCount');
  if (bar) bar.hidden = count === 0;
  if (countEl) countEl.textContent = String(count);

  for (const node of document.querySelectorAll('.msg')) {
    const id = Number(node.dataset.messageId);
    node.classList.toggle('selected', state.selectedMessageIds.has(id));
  }
}

window.toggleChatMenu = () => {
  const menu = $('chatMenu');
  if (!menu || !state.currentChatId) return;
  menu.hidden = !menu.hidden;
};

function openChatMenu() {
  const menu = $('chatMenu');
  if (menu) menu.hidden = false;
}

function closeChatMenu() {
  const menu = $('chatMenu');
  if (menu) menu.hidden = true;
}

function updateCallBar() {
  const bar = $('callBar');
  if (!bar) return;

  const ac = state.activeCall;
  const chat = $('chat');
  if (!ac) {
    bar.hidden = true;
    if (chat) chat.classList.remove('call-bar-visible');
    updateMobileLayout();
    renderChatHeader();
    return;
  }

  bar.hidden = false;
  if (chat) chat.classList.add('call-bar-visible');
  updateMobileLayout();
  const label = $('callBarLabel');
  const actions = $('callBarActions');
  const contact = state.contacts.get(ac.peerUserId);
  const name = contact ? getContactLabel(contact) : ac.peerUserId;

  if (ac.status === 'incoming') {
    if (label) label.textContent = `Входящий звонок · ${name}`;
    if (actions) {
      actions.innerHTML = `
        <button type="button" class="btn primary" id="callAnswerBtn">Ответить</button>
        <button type="button" class="btn subtle" id="callDeclineBtn">Отклонить</button>
      `;
      $('callAnswerBtn').onclick = () => window.answerVoiceCall();
      $('callDeclineBtn').onclick = () => window.declineVoiceCall();
    }
    renderChatHeader();
    return;
  }

  if (ac.status === 'ringing') {
    if (label) label.textContent = `Звоним · ${name}`;
    if (actions) {
      actions.innerHTML = `<button type="button" class="btn subtle" id="callCancelBtn">Отменить</button>`;
      $('callCancelBtn').onclick = () => window.endVoiceCall();
    }
    renderChatHeader();
    return;
  }

  if (ac.status === 'active') {
    if (label) {
      label.textContent = state.remoteAudioNeedsUnlock
        ? `Звонок · ${name} · нажмите «Включить звук»`
        : `Звонок · ${name}`;
    }
    if (actions) {
      const micLabel = state.micMuted ? 'Включить мик' : 'Выключить мик';
      const unlockBtn = state.remoteAudioNeedsUnlock
        ? '<button type="button" class="btn primary" id="callUnlockAudioBtn">Включить звук</button>'
        : '';
      actions.innerHTML = `
        ${unlockBtn}
        <button type="button" class="btn subtle" id="callMuteBtn">${micLabel}</button>
        <button type="button" class="btn subtle" id="callEndBtn">Завершить</button>
      `;
      const unlockEl = $('callUnlockAudioBtn');
      if (unlockEl) unlockEl.onclick = () => window.unlockRemoteAudio();
      $('callMuteBtn').onclick = () => window.toggleCallMic();
      $('callEndBtn').onclick = () => window.endVoiceCall();
    }
  }

  renderChatHeader();
}

window.toggleCallMic = () => {
  const ac = state.activeCall;
  if (!ac || ac.status !== 'active' || !state.transport) return;
  const contact = state.contacts.get(ac.peerUserId);
  const peerId = contact?.activePeerId || ac.remotePeerId;
  if (!peerId) return;
  state.micMuted = !state.micMuted;
  state.transport.setLocalMicMuted(peerId, state.micMuted);
  updateCallBar();
};

function updateMobileLayout() {
  const app = $('app');
  const sidebar = $('sidebar');
  if (!app || !sidebar) return;
  
  const narrow = window.matchMedia('(max-width: 768px)').matches;
  
  if (narrow) {
    // On mobile: sidebar visible by default, hide when chat is open or call is active
    sidebar.classList.toggle('chat-open', !!(state.currentChatId || state.activeCall));
  } else {
    sidebar.classList.remove('chat-open');
  }
}

// Microphone access requires a secure context. Over plain HTTP on a LAN IP
// (e.g. http://192.168.x.x) browsers hide navigator.mediaDevices entirely, which
// silently breaks call audio in BOTH directions. Detect and report it clearly.
function callMediaUnavailableReason() {
  if (!window.isSecureContext) {
    return 'Звонкам нужен HTTPS. Откройте приложение по https:// или через localhost (не по IP по http).';
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return 'Браузер не даёт доступ к микрофону в этом контексте.';
  }
  return null;
}

window.startVoiceCall = async () => {
  if (!state.currentChatId || !state.transport || !state.multiplexer || !state.profile) return;
  if (state.activeCall) return;

  const mediaError = callMediaUnavailableReason();
  if (mediaError) {
    setStatus('error', mediaError);
    alert(mediaError);
    return;
  }

  const chatId = state.currentChatId;
  await clearPendingCallControls(chatId);

  const callId = crypto.randomUUID();
  state.activeCall = {
    callId,
    peerUserId: chatId,
    remotePeerId: null,
    status: 'ringing',
    role: 'caller'
  };
  startRingTone('outgoing');
  updateCallBar();

  let targetPeerId = await resolvePeerForUser(chatId).catch(() => null);
  if (targetPeerId) {
    state.activeCall.remotePeerId = targetPeerId;
  } else {
    setStatus('warn', 'Собеседник не найден онлайн — приглашение будет отправлено при появлении.');
  }

  const invited = await sendCallControl('invite', callId, chatId, targetPeerId, {
    senderName: state.profile.displayName
  });

  if (!invited) {
    stopRingTone();
    state.activeCall = null;
    updateCallBar();
    setStatus('error', 'Не удалось позвонить');
    return;
  }

  if (!targetPeerId) {
    targetPeerId = await resolvePeerForUser(chatId).catch(() => null);
    if (targetPeerId) state.activeCall.remotePeerId = targetPeerId;
  }

  if (targetPeerId) {
    await tryStartCallerAudio(chatId);
  }
};

window.answerVoiceCall = async () => {
  const ac = state.activeCall;
  if (!ac || ac.status !== 'incoming' || !state.transport || !state.multiplexer || !state.profile) return;

  const mediaError = callMediaUnavailableReason();
  if (mediaError) {
    setStatus('error', mediaError);
    alert(mediaError);
    return;
  }

  const contact = state.contacts.get(ac.peerUserId);
  const peerId = contact?.activePeerId || ac.remotePeerId;
  if (!peerId) return;

  try {
    stopRingTone();
    playConnectingTone();
    ac.status = 'active';
    updateCallBar();

    // Ensure peer connection exists with data channel and audio transceiver
    // (callee does NOT renegotiate here — only the caller sends audio offer)
    await state.transport.startAudioCallWithLocalMedia(peerId, { asOfferer: false });

    // Notify caller that we accepted
    await state.multiplexer.send(
      {
        type: 'call',
        action: 'accept',
        callId: ac.callId,
        senderId: state.profile.userId
      },
      peerId
    );

    await playRemoteAudioIfReady(peerId);

    // Add callee's microphone after a delay to avoid SDP glare with caller's audio offer
    setTimeout(async () => {
      try {
        if (state.activeCall?.status === 'active') {
          await state.transport.addLocalMic(peerId);
        }
      } catch (e) {
        console.warn('Add mic failed:', e);
      }
    }, 1500);
  } catch (e) {
    console.warn('Answer failed:', e);
    stopRingTone();
    state.activeCall = null;
    updateCallBar();
    setStatus('error', 'Не удалось ответить');
  }
};

window.declineVoiceCall = async () => {
  const ac = state.activeCall;
  if (!ac || ac.status !== 'incoming' || !state.profile) return;

  stopRingTone();
  const contact = state.contacts.get(ac.peerUserId);
  const peerId = contact?.activePeerId || ac.remotePeerId;
  const chatId = ac.peerUserId;
  state.activeCall = null;
  updateCallBar();
  await sendCallControl('reject', ac.callId, chatId, peerId);
  await clearPendingCallControls(chatId);
};

window.endVoiceCall = async () => {
  const ac = state.activeCall;
  stopRingTone();
  if (!ac || !state.multiplexer || !state.profile) {
    state.activeCall = null;
    state.micMuted = false;
    updateCallBar();
    return;
  }

  const contact = state.contacts.get(ac.peerUserId);
  const peerId = contact?.activePeerId || ac.remotePeerId;
  const chatId = ac.peerUserId;
  state.activeCall = null;
  state.micMuted = false;
  updateCallBar();
  await sendCallControl('end', ac.callId, chatId, peerId);
  await clearPendingCallControls(chatId);
  await hangupCallAudio(peerId);
};

function renderChatHeader() {
  const title = $('chatTitle');
  const subtitle = $('chatSubtitle');
  const btnCall = $('btnCall');
  const btnMenu = $('btnChatMenu');
  const headerAvatar = $('chatHeaderAvatar');

  const group = state.groups.get(state.currentChatId);

  if (btnCall) {
    btnCall.hidden = !state.currentChatId || Boolean(state.activeCall) || Boolean(state.contacts.get(state.currentChatId)?.blocked) || Boolean(group);
  }
  if (btnMenu) btnMenu.hidden = !state.currentChatId;

  if (!state.currentChatId) {
    if (title) {
      title.textContent = 'Чаты';
      title.classList.remove('clickable');
      title.onclick = null;
    }
    if (subtitle) subtitle.textContent = 'Выберите диалог';
    if (headerAvatar) { headerAvatar.innerHTML = ''; headerAvatar.hidden = true; }
    closeChatMenu();
    return;
  }

  if (group) {
    const initials = getContactInitials(group.name);
    if (headerAvatar) {
      headerAvatar.hidden = false;
      headerAvatar.innerHTML = group.avatarData
        ? `<img src="${group.avatarData}" style="width:100%;height:100%;object-fit:cover;">`
        : initials;
      headerAvatar.onclick = () => openGroupInfo();
    }
    if (title) {
      title.textContent = group.name;
      title.classList.remove('clickable');
      title.onclick = null;
    }
    const headerMain = $('chatHeaderMain');
    if (headerMain) {
      headerMain.style.cursor = 'pointer';
      headerMain.onclick = () => openGroupInfo();
    }
    if (subtitle) {
      const count = group.members.length;
      subtitle.textContent = `${count} ${count === 1 ? 'участник' : 'участников'}`;
    }
    return;
  }

  const contact = state.contacts.get(state.currentChatId);
  const label = getContactLabel(contact);

  if (headerAvatar) {
    headerAvatar.hidden = false;
    const initials = getContactInitials(label);
    headerAvatar.innerHTML = getAvatarHtml(state.currentChatId, initials);
    headerAvatar.onclick = () => openContactProfile(state.currentChatId);
  }

  if (title) {
    title.textContent = label;
    title.classList.remove('clickable');
    title.onclick = null;
  }

  const headerMain = $('chatHeaderMain');
  if (headerMain && contact) {
    headerMain.style.cursor = 'pointer';
    headerMain.onclick = () => openContactProfile(state.currentChatId);
  } else if (headerMain) {
    headerMain.style.cursor = '';
    headerMain.onclick = null;
  }

  if (subtitle) {
    if (contact?.blocked) {
      subtitle.textContent = 'Заблокирован';
    } else {
      subtitle.textContent = getOnlineStatusText(contact);
    }
  }
}

async function restoreContacts() {
  const savedContacts = await messageDB.getContacts();
  for (const contact of savedContacts) {
    if (isStaleStoredContact(contact)) {
      await messageDB.deleteContact(contact.id);
      continue;
    }

    state.contacts.set(contact.id, {
      ...contact,
      online: false
    });
  }

  renderContacts();
  for (const contact of state.contacts.values()) {
    if (!contact.avatarUrl && !getAvatarUrl(contact.id)) {
      ensureAvatarForContact(contact.id).catch(() => {});
    }
  }
}

async function renderChatHistory(chatId) {
  state.selectedMessageIds.clear();
  const messages = await messageDB.getMessages(chatId);
  const container = $('messages');
  container.innerHTML = '';

  if (messages.length === 0) {
    container.innerHTML = '<div class="empty-chat">Сообщений пока нет</div>';
    updateSelectionUI();
    return;
  }

  for (const message of messages) {
    const isOutgoing = message.isOutgoing ?? (
      message.senderId
        ? message.senderId === state.profile?.userId
        : Boolean(message.isSent)
    );
    const pending = isOutgoing && !message.isSent;
    addMessageToUI(message, isOutgoing, { pending });
  }
  updateSelectionUI();
}

function addMessageToUI(packet, isSent, options = {}) {
  const div = $('messages');
  const empty = div.querySelector('.empty-chat');
  if (empty) empty.remove();
  const message = document.createElement('div');
  message.className = `msg ${isSent ? 'sent' : 'received'}${options.pending ? ' pending' : ''}`;
  const messageId = packet.id ?? packet._dbId;
  if (messageId !== undefined) {
    message.dataset.messageId = String(messageId);
  }

  const isGroup = state.groups.has(state.currentChatId);
  const senderName = !isSent && isGroup && packet.senderName && packet.senderName !== state.profile?.userId
    ? escapeHtml(packet.senderName)
    : '';

  if (packet.type === 'voice' && packet.content && packet.mimeType) {
    const src = `data:${packet.mimeType};base64,${packet.content}`;
    message.innerHTML = `
      ${senderName ? `<span class="msg-sender">${senderName}</span>` : ''}
      <div class="voice-msg">
        <audio controls preload="metadata" src="${src}" style="max-width:220px;height:36px;"></audio>
      </div>
      <time>${formatTime(packet.timestamp)}</time>
    `;
  } else {
    message.innerHTML = `
      ${senderName ? `<span class="msg-sender">${senderName}</span>` : ''}
      <span>${escapeHtml(String(packet.content ?? ''))}</span>
      <time>${formatTime(packet.timestamp)}</time>
    `;
  }

  message.onclick = () => {
    if (messageId === undefined) return;
    const id = Number(messageId);
    if (state.selectedMessageIds.has(id)) {
      state.selectedMessageIds.delete(id);
    } else {
      state.selectedMessageIds.add(id);
    }
    updateSelectionUI();
  };
  div.appendChild(message);
  updateSelectionUI();
  div.scrollTop = div.scrollHeight;
}

async function upsertContact(userId, patch) {
  const current = state.contacts.get(userId) || { id: userId };
  const next = {
    ...current,
    ...patch,
    id: userId,
    updatedAt: Date.now()
  };

  state.contacts.set(userId, next);
  await messageDB.saveContact(userId, next);
  renderContacts();
  renderChatHeader();

  // Debounced sync to server for multi-device support
  if (window._contactSyncDebounce) clearTimeout(window._contactSyncDebounce);
  window._contactSyncDebounce = setTimeout(() => {
    syncContactsToServer().catch(() => {});
  }, 2000);

  return next;
}

function getContactLabel(contact) {
  return contact?.alias || contact?.displayName || contact?.id || '';
}

function getOnlineStatusText(contact) {
  if (!contact) return 'не в сети';
  if (contact.hideOnline) return 'был(а) недавно';
  if (contact.online) return 'в сети';
  if (contact.lastSeen) {
    return `был(а) ${formatRelativeTime(contact.lastSeen)}`;
  }
  return 'не в сети';
}

// Returns own online status text for profile page
function getOwnOnlineStatusText() {
  const hideOnline = Boolean(localStorage.getItem('tract.hideOnline'));
  if (hideOnline) return 'был(а) недавно';
  return 'в сети';
}

function getContactGroupKey(label) {
  const normalized = String(label || '').trim().replace(/^@/, '');
  if (!normalized) return '#';
  const first = normalized.charAt(0).toUpperCase();
  if (/[A-Za-zА-ЯЁ]/.test(first)) return first;
  return '#';
}

function compareContactLabels(left, right) {
  const a = getContactLabel(left).toLowerCase();
  const b = getContactLabel(right).toLowerCase();
  return a.localeCompare(b, undefined, { sensitivity: 'base' });
}

window.openContactProfile = (userId) => {
  if (!userId) return;

  const contact = state.contacts.get(userId) || { id: userId, online: false };
  const avatarEl = $('profileModalAvatar');
  const nameEl = $('profileModalName');
  const idEl = $('profileModalId');
  const statusEl = $('profileModalStatus');
  const callBtn = $('profileCallBtn');
  const blockBtn = $('profileBlockBtn');
  const blockLabel = $('profileBlockLabel');
  const deleteBtn = $('profileDeleteBtn');

  if (!avatarEl || !nameEl || !idEl || !statusEl || !callBtn || !blockBtn) return;

  nameEl.textContent = getContactLabel(contact);
  idEl.textContent = userId;

  const blocked = Boolean(contact.blocked);
  if (blocked) {
    statusEl.textContent = 'Заблокирован';
    statusEl.className = 'profile-page-status';
  } else {
    const statusText = getOnlineStatusText(contact);
    statusEl.textContent = statusText;
    statusEl.className = `profile-page-status${contact.online && !contact.hideOnline ? ' online' : ''}`;
  }

  const avatarUrl = getAvatarUrl(userId);
  if (avatarUrl) {
    avatarEl.innerHTML = `<img src="${escapeHtml(avatarUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;object-position:center;display:block;">`;
    enableAvatarPeek(avatarEl, userId);
  } else {
    avatarEl.textContent = getContactInitials(getContactLabel(contact));
  }

  // Setup expanded hero
  const originalUrl = getOriginalAvatarUrl(userId);
  const hero = $('profileHero');
  const heroBg = $('profileHeroBg');
  const heroName = $('profileHeroName');
  const heroId = $('profileHeroId');
  if (hero) {
    hero.classList.remove('expanded');
    if (heroBg) {
      if (originalUrl) {
        heroBg.style.backgroundImage = `url(${escapeHtml(originalUrl)})`;
      } else {
        heroBg.style.background = 'var(--accent)';
      }
    }
    if (heroName) heroName.textContent = getContactLabel(contact);
    if (heroId) heroId.textContent = userId;

    // Collapsed base height for smooth transition
    const collapsedH = hero.scrollHeight + 'px';
    hero.style.height = collapsedH;

    function setExpanded(expand) {
      if (expand) {
        hero.classList.add('expanded');
        hero.style.height = '';
        const scroll = hero.closest('.profile-page-scroll');
        if (scroll) scroll.scrollTop = 0;
      } else {
        hero.classList.remove('expanded');
        hero.style.height = collapsedH;
      }
    }

    // Toggle expand on click/tap
    hero.onclick = (e) => {
      if (e.target.closest('.profile-hero-info')) return;
      setExpanded(!hero.classList.contains('expanded'));
    };

    // Pull-down gesture: smooth drag → expand
    const expandedLayer = $('profileHeroExpanded');
    let dragStartY = 0;
    let isDragging = false;
    hero.addEventListener('touchstart', (e) => {
      if (hero.classList.contains('expanded')) return;
      dragStartY = e.touches[0].clientY;
      isDragging = false;
      hero.style.transition = 'none';
      if (expandedLayer) expandedLayer.setAttribute('dragging', '');
    }, { passive: true });
    hero.addEventListener('touchmove', (e) => {
      if (hero.classList.contains('expanded')) return;
      const dy = e.touches[0].clientY - dragStartY;
      if (dy > 10) isDragging = true;
      if (!isDragging) return;
      e.preventDefault();
      const progress = Math.min(dy / 120, 1);
      const maxH = Math.max(window.innerHeight * 0.5, 220);
      const baseH = parseFloat(collapsedH);
      hero.style.height = (baseH + (maxH - baseH) * progress) + 'px';
      if (expandedLayer) expandedLayer.style.opacity = progress;
    }, { passive: false });
    hero.addEventListener('touchend', () => {
      if (!isDragging) return;
      isDragging = false;
      hero.style.transition = '';
      if (expandedLayer) {
        expandedLayer.removeAttribute('dragging');
        expandedLayer.style.opacity = '';
      }
      const prog = expandedLayer ? parseFloat(expandedLayer.style.opacity || '0') : 0;
      setExpanded(prog > 0.35);
    });
  }

  callBtn.disabled = blocked;
  callBtn.style.opacity = blocked ? '0.4' : '';
  if (blockLabel) blockLabel.textContent = blocked ? 'Разблок' : 'Блок';
  blockBtn.querySelector('.material-icons').textContent = blocked ? 'lock_open' : 'block';

  // Delete button always visible
  if (deleteBtn) {
    deleteBtn.style.display = '';
  }

  state.profileViewUserId = userId;
  const page = $('contactProfilePage');
  if (page) page.classList.add('open');
};

window.closeContactProfile = () => {
  const hero = $('profileHero');
  if (hero) hero.classList.remove('expanded');
  const page = $('contactProfilePage');
  if (page) page.classList.remove('open');
  state.profileViewUserId = null;
};

window.startVoiceCallFromProfile = async () => {
  const userId = state.profileViewUserId;
  if (!userId) return;
  closeContactProfile();
  await openChat(userId);
  await startVoiceCall();
};

window.toggleContactBlockFromProfile = async () => {
  const userId = state.profileViewUserId;
  if (!userId) return;
  const contact = state.contacts.get(userId) || { id: userId };
  await upsertContact(userId, {
    ...contact,
    blocked: !Boolean(contact.blocked)
  });
  openContactProfile(userId);
};

window.deleteContactFromProfile = async () => {
  const userId = state.profileViewUserId;
  if (!userId) return;
  closeContactProfile();
  // Delete messages and contact from DB
  await messageDB.deleteChat(userId);
  await messageDB.deleteContact(userId);
  // Remove from in-memory state
  state.contacts.delete(userId);
  state.unreadCounts.delete(userId);
  if (state.currentChatId === userId) {
    state.currentChatId = null;
    state.selectedMessageIds.clear();
    $('messages').innerHTML = '<div class="empty-chat">Контакт удалён</div>';
    renderChatHeader();
    updateSelectionUI();
    updateMobileLayout();
  }
  state.transport?.setAllowedUserIds?.(Array.from(state.contacts.keys()));
  refreshDocTitle();
  renderContacts();
};

function setStatus(kind, text) {
  const node = $('networkStatus');
  if (!node) return;
  if (node.hidden) return;
  
  // Remove old status classes and add new one
  node.className = 'status-indicator';
  node.classList.add(kind);
  
  const statusText = $('statusText');
  if (statusText) {
    statusText.textContent = text;
  } else {
    // Fallback if structure is different
    node.textContent = text;
  }
}

function isSelfContactId(userId) {
  return Boolean(state.profile && userId === state.profile.userId);
}

function isStaleStoredContact(contact) {
  if (!contact?.id) return true;
  if (contact.isSelf || contact.name === 'Я') return true;
  return SESSION_ID_PATTERN.test(contact.id);
}

function findUserIdByPeerId(peerId) {
  for (const [userId, contact] of state.contacts) {
    if (contact.activePeerId === peerId) {
      return userId;
    }
  }
  return null;
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });
}

const MONTH_NAMES = ['янв.', 'фев.', 'мар.', 'апр.', 'мая', 'июн.', 'июл.', 'авг.', 'сен.', 'окт.', 'ноя.', 'дек.'];

function formatRelativeTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return 'только что';
  if (diffMin < 60) return `${diffMin} мин. назад`;
  if (diffHours < 24) return `${diffHours} ч. назад`;
  if (diffDays === 1) return 'вчера';
  if (diffDays < 7) return `${diffDays} дн. назад`;

  const day = date.getDate();
  const month = MONTH_NAMES[date.getMonth()] || '???';
  const year = date.getFullYear() !== new Date(now).getFullYear() ? ` ${date.getFullYear()}` : '';
  return `${day} ${month}${year}`;
}

function formatDate(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now - date;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  if (diffDays === 1) return 'Вчера';
  if (diffDays < 7) {
    return date.toLocaleDateString([], { weekday: 'short' });
  }
  return date.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

// ==================== SWIPE GESTURES ====================
// ==================== VOICE MESSAGES ====================

let _voiceRecorder = null;
let _voiceChunks = [];
let _voiceHolding = false;
let _voiceHoldTimer = null;

function initVoiceRecording(sendBtn, input) {
  const HOLD_THRESHOLD_MS = 250;

  const startRecording = async () => {
    if (!state.currentChatId || input.value.trim().length > 0) return;
    const reason = callMediaUnavailableReason();
    if (reason) { setStatus('error', reason); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg';
      _voiceRecorder = new MediaRecorder(stream, { mimeType });
      _voiceChunks = [];
      _voiceRecorder.ondataavailable = (e) => { if (e.data.size > 0) _voiceChunks.push(e.data); };
      _voiceRecorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (_voiceHolding === false) finishVoiceMessage(mimeType);
      };
      _voiceRecorder.start(100);
      _voiceHolding = true;
      sendBtn.classList.add('recording');
      setStatus('warning', '🎙 Запись...');
    } catch (e) {
      setStatus('error', 'Нет доступа к микрофону');
    }
  };

  const stopRecording = () => {
    clearTimeout(_voiceHoldTimer);
    if (!_voiceHolding) return;
    _voiceHolding = false;
    sendBtn.classList.remove('recording');
    if (_voiceRecorder && _voiceRecorder.state !== 'inactive') {
      _voiceRecorder.stop();
    } else {
      setStatus('offline', '');
    }
  };

  // Touch
  sendBtn.addEventListener('touchstart', (e) => {
    if (input.value.trim().length > 0) return;
    e.preventDefault();
    _voiceHoldTimer = setTimeout(startRecording, HOLD_THRESHOLD_MS);
  }, { passive: false });
  sendBtn.addEventListener('touchend', stopRecording, { passive: true });
  sendBtn.addEventListener('touchcancel', stopRecording, { passive: true });

  // Mouse (desktop)
  sendBtn.addEventListener('mousedown', () => {
    if (input.value.trim().length > 0) return;
    _voiceHoldTimer = setTimeout(startRecording, HOLD_THRESHOLD_MS);
  });
  sendBtn.addEventListener('mouseup', stopRecording);
  sendBtn.addEventListener('mouseleave', stopRecording);
}

async function finishVoiceMessage(mimeType) {
  if (!_voiceChunks.length || !state.currentChatId) {
    setStatus('offline', '');
    return;
  }
  const blob = new Blob(_voiceChunks, { type: mimeType });
  if (blob.size < 1000) { setStatus('offline', ''); return; } // too short, ignore
  const reader = new FileReader();
  reader.onloadend = async () => {
    const base64 = reader.result.split(',')[1];
    const chatId = state.currentChatId;
    const packet = {
      packetId: crypto.randomUUID(),
      type: 'voice',
      content: base64,
      mimeType,
      senderId: state.profile.userId,
      senderName: state.profile.displayName,
      senderPublicKey: getPublicKeyHex(state.keyPair),
      timestamp: Date.now()
    };
    const dbKey = await messageDB.saveMessage(packet, chatId, false, { isOutgoing: true });
    packet._dbId = dbKey;
    addMessageToUI(packet, true);
    await upsertContact(chatId, { ...state.contacts.get(chatId), lastMsg: '🎙 Голосовое', lastTime: packet.timestamp });
    renderContacts();
    await deliverOutgoingMessage(chatId, packet);
    setStatus('offline', '');
  };
  reader.readAsDataURL(blob);
}

function initSwipeGestures() {
  // Swipe right on chat area → go back to contact list (mobile)
  const chatEl = $('chat');
  if (chatEl) {
    let touchStartX = 0;
    let touchStartY = 0;

    chatEl.addEventListener('touchstart', (e) => {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }, { passive: true });

    chatEl.addEventListener('touchend', (e) => {
      if (!state.currentChatId) return;
      const dx = e.changedTouches[0].clientX - touchStartX;
      const dy = e.changedTouches[0].clientY - touchStartY;
      const isHorizontal = Math.abs(dx) > Math.abs(dy) * 1.5;
      const isRightSwipe = dx > 60 && isHorizontal;
      const startsFromEdge = touchStartX < 60;
      if ((isRightSwipe && startsFromEdge) || (isRightSwipe && dx > 120)) {
        if (window.matchMedia('(max-width: 768px)').matches) {
          goBackFromChat();
        }
      }
    }, { passive: true });
  }

  // Swipe on sidebar views area → switch tabs (Chats ↔ Contacts)
  const viewsEl = document.querySelector('.sidebar-views');
  if (viewsEl) {
    const TAB_ORDER = ['chats', 'contacts'];
    let touchStartX = 0;
    let touchStartY = 0;

    viewsEl.addEventListener('touchstart', (e) => {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }, { passive: true });

    viewsEl.addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].clientX - touchStartX;
      const dy = e.changedTouches[0].clientY - touchStartY;
      if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
      const idx = TAB_ORDER.indexOf(currentView);
      if (dx < 0 && idx < TAB_ORDER.length - 1) switchView(TAB_ORDER[idx + 1]);
      else if (dx > 0 && idx > 0) switchView(TAB_ORDER[idx - 1]);
    }, { passive: true });
  }

  // Swipe left on sidebar → open current chat (mobile)
  const sidebarEl = $('sidebar');
  if (sidebarEl) {
    let touchStartX = 0;
    let touchStartY = 0;

    sidebarEl.addEventListener('touchstart', (e) => {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }, { passive: true });

    sidebarEl.addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].clientX - touchStartX;
      const dy = e.changedTouches[0].clientY - touchStartY;
      const isHorizontal = Math.abs(dx) > Math.abs(dy) * 1.5;
      const isLeftSwipe = dx < -60 && isHorizontal;
      if (isLeftSwipe && window.matchMedia('(max-width: 768px)').matches && state.currentChatId) {
        const sidebar = $('sidebar');
        if (sidebar) sidebar.classList.add('chat-open');
      }
    }, { passive: true });
  }

  // Swipe right on profile page → close profile
  const profilePage = $('contactProfilePage');
  if (profilePage) {
    let touchStartX = 0;
    let touchStartY = 0;

    profilePage.addEventListener('touchstart', (e) => {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }, { passive: true });

    profilePage.addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].clientX - touchStartX;
      const dy = e.changedTouches[0].clientY - touchStartY;
      const isHorizontal = Math.abs(dx) > Math.abs(dy) * 1.5;
      const isRightSwipe = dx > 60 && isHorizontal;
      const startsFromEdge = touchStartX < 60;
      if ((isRightSwipe && startsFromEdge) || (isRightSwipe && dx > 120)) {
        closeContactProfile();
      }
    }, { passive: true });
  }
}

init();
