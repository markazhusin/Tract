import QRCode from 'qrcode';
import {
  clearSessionPeerId,
  fetchIdentityFromServer,
  getLegacyIdentityMetadata,
  getOrCreateSessionPeerId,
  getStoredIdentityMetadata,
  registerIdentity,
  unlockIdentity,
  updateStoredDisplayName,
  unlockSimpleIdentity,
  uploadIdentityToServer
} from './app/core/keypair.js';
import { Multiplexer } from './app/core/multiplexer.js';
import { WebRTCTransport } from './app/transports/webrtc.js';
import { messageDB } from './app/core/database.js';

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
  activeCall: null,
  unreadCounts: new Map(),
  micMuted: false,
  selectedMessageIds: new Set(),
  ringTone: null
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

function refreshDocTitle() {
  const n = [...state.unreadCounts.values()].reduce((a, b) => a + b, 0);
  document.title = n > 0 ? `(${n}) Tract` : 'Tract';
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

async function bindRemoteAudioStream(stream) {
  const el = $('remoteAudio');
  if (!el || !stream) return;
  el.srcObject = stream;
  el.muted = false;
  el.volume = 1;
  try {
    await el.play();
  } catch (e) {
    console.warn('Remote audio play:', e);
    setStatus('warn', 'Ткните по странице или снова нажмите «Ответить» — браузер мог заблокировать звук');
  }
}

async function playRemoteAudioIfReady() {
  const el = $('remoteAudio');
  if (!el?.srcObject) return;
  el.muted = false;
  el.volume = 1;
  try {
    await el.play();
  } catch {
    setStatus('warn', 'Разрешите звук для сайта в настройках вкладки');
  }
}

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
}

function setAvatarHtml(el, userId, initials) {
  const url = getAvatarUrl(userId);
  if (url) {
    el.innerHTML = `<img src="${escapeHtml(url)}" alt="">`;
  } else {
    el.textContent = initials;
  }
}

async function uploadAvatarToServer(userId, avatarData) {
  if (!userId || !avatarData) return null;
  const serverUrl = resolveSignalingUrl();
  if (!serverUrl) return null;

  try {
    const response = await fetch(new URL('/profile/avatar', serverUrl).toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, avatarData })
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

async function deleteAvatarFromServer(userId, avatarId) {
  if (!userId || !avatarId) return null;
  const serverUrl = resolveSignalingUrl();
  if (!serverUrl) return null;

  try {
    const response = await fetch(new URL(`/profile/avatar/${encodeURIComponent(userId)}/${encodeURIComponent(avatarId)}`, serverUrl).toString(), {
      method: 'DELETE'
    });
    if (!response.ok) {
      throw new Error(`Delete failed ${response.status}`);
    }
    const data = await response.json();
    return {
      avatarData: data.avatarData || null,
      avatars: Array.isArray(data.avatars) ? data.avatars : []
    };
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
  const avatars = await fetchAvatarGalleryFromServer(state.profile.userId);
  if (avatars.length) {
    saveAvatarHistory(state.profile.userId, avatars);
    renderProfileCards();
    renderContacts();
    return avatars[avatars.length - 1].avatarData;
  }

  const existing = localStorage.getItem(getAvatarStorageKey(state.profile.userId));
  if (existing) {
    renderProfileCards();
    renderContacts();
    return existing;
  }
  return null;
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

window.handleAvatarUpload = async (event) => {
  const file = event.target.files?.[0];
  if (!file || !state.profile) return;
  event.target.value = '';

  const dataUrl = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.readAsDataURL(file);
  });

  openAvatarCropModal(dataUrl, async (croppedDataUrl) => {
    const avatarData = croppedDataUrl;
    saveAvatarHistory(state.profile.userId, [{ id: 'current', avatarData, uploadedAt: Date.now() }]);
    if (state.transport) {
      state.transport.options.avatarData = avatarData;
    }
    const result = await uploadAvatarToServer(state.profile.userId, avatarData);
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
  });
};

function openAvatarCropModal(imageSrc, onConfirm) {
  const existing = document.getElementById('avatarCropModal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'avatarCropModal';
  modal.style.cssText = [
    'position:fixed', 'inset:0', 'background:rgba(0,0,0,0.9)', 'z-index:300',
    'display:flex', 'flex-direction:column', 'align-items:center',
    'justify-content:center', 'gap:16px', 'padding:20px'
  ].join(';');

  const title = document.createElement('div');
  title.textContent = 'Перетащите круг · колесо/пинч — размер';
  title.style.cssText = 'color:#f5f5f5;font-size:14px;font-weight:500;text-align:center;';

  // Single canvas for everything
  const canvas = document.createElement('canvas');
  canvas.style.cssText = [
    'display:block', 'border-radius:8px', 'touch-action:none',
    'cursor:move', 'max-width:min(340px,90vw)', 'max-height:min(340px,60vh)'
  ].join(';');

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:12px;';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Отмена';
  cancelBtn.style.cssText = 'padding:10px 24px;border-radius:8px;background:rgba(255,255,255,0.1);color:#f5f5f5;font-size:15px;border:none;cursor:pointer;';

  const confirmBtn = document.createElement('button');
  confirmBtn.textContent = 'Готово';
  confirmBtn.style.cssText = 'padding:10px 24px;border-radius:8px;background:#B7FFF9;color:#141515;font-size:15px;font-weight:600;border:none;cursor:pointer;';

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(confirmBtn);
  modal.appendChild(title);
  modal.appendChild(canvas);
  modal.appendChild(btnRow);
  document.body.appendChild(modal);

  const img = new Image();
  img.onload = () => {
    const maxSize = Math.min(340, window.innerWidth * 0.9, window.innerHeight * 0.55);
    const scale = Math.min(maxSize / img.width, maxSize / img.height);
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
      // Draw image
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(img, 0, 0, W, H);
      // Dark overlay outside circle
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.arc(cropX, cropY, cropR, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      // Circle border
      ctx.strokeStyle = 'rgba(183,255,249,0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cropX, cropY, cropR, 0, Math.PI * 2);
      ctx.stroke();
    }

    draw();

    // ---- Pointer events (mouse + touch unified) ----
    let dragging = false;
    let lastX = 0, lastY = 0;
    let lastPinchDist = null;

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

    canvas.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      const p = canvasPos(e.clientX, e.clientY);
      lastX = p.x; lastY = p.y;
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const p = canvasPos(e.clientX, e.clientY);
      cropX += p.x - lastX;
      cropY += p.y - lastY;
      lastX = p.x; lastY = p.y;
      clampCrop();
      draw();
    });

    window.addEventListener('mouseup', () => { dragging = false; });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      cropR = Math.max(20, Math.min(minDim * 0.5, cropR - e.deltaY * 0.4));
      clampCrop();
      draw();
    }, { passive: false });

    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (e.touches.length === 1) {
        dragging = true;
        const p = canvasPos(e.touches[0].clientX, e.touches[0].clientY);
        lastX = p.x; lastY = p.y;
        lastPinchDist = null;
      } else if (e.touches.length === 2) {
        dragging = false;
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        lastPinchDist = Math.sqrt(dx * dx + dy * dy);
      }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (lastPinchDist !== null) {
          cropR = Math.max(20, Math.min(minDim * 0.5, cropR + (dist - lastPinchDist) * 0.5));
          clampCrop();
          draw();
        }
        lastPinchDist = dist;
        return;
      }
      if (!dragging || e.touches.length !== 1) return;
      const p = canvasPos(e.touches[0].clientX, e.touches[0].clientY);
      cropX += p.x - lastX;
      cropY += p.y - lastY;
      lastX = p.x; lastY = p.y;
      clampCrop();
      draw();
    }, { passive: false });

    canvas.addEventListener('touchend', (e) => {
      if (e.touches.length < 2) lastPinchDist = null;
      if (e.touches.length === 0) dragging = false;
    });

    cancelBtn.onclick = () => modal.remove();

    confirmBtn.onclick = () => {
      const size = 256;
      const out = document.createElement('canvas');
      out.width = size;
      out.height = size;
      const oc = out.getContext('2d');
      oc.beginPath();
      oc.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
      oc.clip();
      // Map canvas crop coords back to original image coords
      const imgScaleX = img.width / W;
      const imgScaleY = img.height / H;
      const srcX = (cropX - cropR) * imgScaleX;
      const srcY = (cropY - cropR) * imgScaleY;
      const srcW = cropR * 2 * imgScaleX;
      const srcH = cropR * 2 * imgScaleY;
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
  if (avatarSettings) setAvatarHtml(avatarSettings, state.profile.userId, initials);
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
}

async function init() {
  applyInviteParams();
  syncSignalingFromEnvironment();
  window.addEventListener('resize', updateMobileLayout);
  initSwipeGestures();

  const identity = getStoredIdentityMetadata();
  const legacyIdentity = getLegacyIdentityMetadata();
  const sessionPw = localStorage.getItem(REMEMBER_PASSWORD_KEY) || sessionStorage.getItem(SESSION_PASSWORD_KEY);

  if (identity && sessionPw) {
    try {
      const auth = await unlockIdentity(sessionPw);
      await bootstrapAuthenticatedSession(auth);
      return;
    } catch {
      sessionStorage.removeItem(SESSION_PASSWORD_KEY);
    }
  }

  if (identity) {
    $('loginUserId').textContent = identity.userId;
    const loginInput = $('loginName');
    if (loginInput) loginInput.value = identity.userId;
    openGate('login', {
      title: 'Вход в Tract',
      hint: 'Введите логин и пароль.'
    });
  } else if (legacyIdentity) {
    $('registerName').value = legacyIdentity.profile.displayName;
    openGate('register', {
      title: 'Завершение миграции аккаунта',
      hint: `Найдена старая локальная identity ${legacyIdentity.profile.userId}. Задайте пароль, чтобы сохранить этот аккаунт в новой модели входа.`
    });
  } else {
    openGate('login', {
      title: 'Вход в Tract',
      hint: 'Введите логин и пароль. Если у вас ещё нет аккаунта, нажмите "Новый аккаунт".'
    });
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

  if (signal) {
    localStorage.setItem(SIGNALING_URL_KEY, signal);
  }
  if (room) {
    localStorage.setItem(ROOM_ID_KEY, room);
  }
}

function openGate(mode, copy = {}) {
  $('authGate').hidden = false;
  $('registerPanel').hidden = mode !== 'register';
  $('loginPanel').hidden = mode !== 'login';
  $('authTitle').textContent = copy.title || (mode === 'login' ? 'Вход в Tract' : 'Регистрация в Tract');
  $('authHint').textContent = copy.hint || '';
  $('authError').textContent = '';
}

function closeGate() {
  $('authGate').hidden = true;
}

window.showRegister = () => openGate('register', {
  title: 'Регистрация в Tract',
  hint: 'Создайте логин вида @login и пароль.'
});
window.showLogin = () => {
  const identity = getStoredIdentityMetadata();
  $('loginUserId').textContent = identity?.userId || '@login';
  const loginInput = $('loginName');
  if (loginInput && identity?.userId) loginInput.value = identity.userId;
  openGate('login', {
    title: 'Вход в Tract',
    hint: 'Введите логин и пароль.'
  });
};

window.registerAccount = async () => {
  if (!window.isSecureContext) {
    $('authError').textContent =
      'Нужен HTTPS (или localhost). Запустите npm run start и откройте https://…:5173 — браузер спросит про сертификат, это нормально.';
    return;
  }

  const login = normalizeLogin($('registerName').value);
  const password = $('registerPassword').value;
  const confirm = $('registerPasswordConfirm').value;

  if (!isValidLogin(login)) {
    $('authError').textContent = 'Логин должен быть вида @login: латиница, цифры или _, 3-32 символа';
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
    const auth = await registerIdentity(password, login, { reuseLegacy: true, userId: login });
    sessionStorage.setItem(SESSION_PASSWORD_KEY, password);
    localStorage.setItem(REMEMBER_PASSWORD_KEY, password);
    await uploadIdentityToServer(resolveSignalingUrl());
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
  const login = normalizeLogin($('loginName')?.value || $('loginUserId')?.textContent);
  const password = $('loginPassword').value;

  if (!isValidLogin(login)) {
    $('authError').textContent = 'Введите логин вида @login';
    return;
  }

  if (!password) {
    $('authError').textContent = 'Введите пароль';
    return;
  }

  if (storedIdentity && storedIdentity.simple && normalizeLogin(storedIdentity.userId) === login) {
    // simple identity: no password required
    try {
      const auth = unlockSimpleIdentity();
      await uploadIdentityToServer(resolveSignalingUrl());
      await bootstrapAuthenticatedSession(auth);
    } catch (e) {
      console.error('Simple login failed:', e);
      $('authError').textContent = 'Не удалось войти в простой аккаунт';
    }
    return;
  }

  $('authError').textContent = '';

  try {
    const sameLocalLogin = storedIdentity?.userId && normalizeLogin(storedIdentity.userId) === login;
    let auth;
    if (sameLocalLogin) {
      auth = await unlockIdentity(password);
    } else {
      const serverUrl = resolveSignalingUrl();
      const fetched = await fetchIdentityFromServer(serverUrl, login);
      if (fetched) {
        auth = await unlockIdentity(password);
      } else {
        $('authError').textContent = 'Аккаунт не найден на сервере. Сначала создайте аккаунт.';
        return;
      }
    }
    sessionStorage.setItem(SESSION_PASSWORD_KEY, password);
    localStorage.setItem(REMEMBER_PASSWORD_KEY, password);
    await uploadIdentityToServer(resolveSignalingUrl());
    await bootstrapAuthenticatedSession(auth);
  } catch (error) {
    console.error('Login failed:', error);
    $('authError').textContent = 'Неверный пароль';
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
  await restoreContacts();
  await loadOwnAvatar();

  const selfId = $('selfId');
  if (selfId) selfId.textContent = state.profile.userId;
  const selfPeerId = $('selfPeerId');
  if (selfPeerId) selfPeerId.textContent = state.myPeerId;
  $('displayNameInput').value = state.profile.displayName;
  $('registerPassword').value = '';
  $('registerPasswordConfirm').value = '';
  $('loginPassword').value = '';

  closeGate();
  renderProfile();
  renderContacts();
  renderChatHeader();
  $('messages').innerHTML = '<div class="empty-chat">Найдите контакт по логину над списком чатов</div>';
  setStatus('offline', 'Аккаунт разблокирован, сеть не подключена');
  await updateInviteArtifacts();
  updateMobileLayout();
  queueMicrotask(() => {
    connectHandshake().catch((e) => console.warn('Auto-connect:', e));
  });
}

window.logoutAccount = async () => {
  sessionStorage.removeItem(SESSION_PASSWORD_KEY);
  localStorage.removeItem(REMEMBER_PASSWORD_KEY);
  stopRingTone();
  const ra = $('remoteAudio');
  if (ra) ra.srcObject = null;
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
  await messageDB.initForUser(null);
  clearSessionPeerId();
  renderContacts();
  renderProfile();
  renderChatHeader();
  $('messages').innerHTML = '<div class="empty-chat">Сессия завершена</div>';
  setStatus('offline', 'Вы вышли из аккаунта');
  const identity = getStoredIdentityMetadata();
  const legacyIdentity = getLegacyIdentityMetadata();
  if (identity) {
    $('loginUserId').textContent = identity.userId;
    const loginInput = $('loginName');
    if (loginInput) loginInput.value = identity.userId;
    openGate('login', {
      title: 'Вход в Tract',
      hint: 'Введите пароль, чтобы снова войти в аккаунт.'
    });
  } else if (legacyIdentity) {
    openGate('register', {
      title: 'Завершение миграции аккаунта',
      hint: `Найдена старая локальная identity ${legacyIdentity.profile.userId}. Задайте пароль для продолжения.`
    });
  } else {
    openGate('register', {
      title: 'Регистрация в Tract',
      hint: 'Создайте новый локальный аккаунт.'
    });
  }
};

window.saveOwnProfile = async () => {
  if (!state.profile) return;
  const displayName = $('displayNameInput').value.trim() || 'Anonymous';
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
};

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

window.connectHandshake = async () => {
  if (!state.profile || !state.keyPair) {
    const stored = getStoredIdentityMetadata();
    if (stored && stored.simple) {
      try {
        const auth = unlockSimpleIdentity();
        await bootstrapAuthenticatedSession(auth);
      } catch (e) {
        console.warn('Auto-unlock simple identity failed:', e);
        openGate(getStoredIdentityMetadata() ? 'login' : 'register');
      }
      return;
    }

    openGate(getStoredIdentityMetadata() ? 'login' : 'register');
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
  state.transport = new WebRTCTransport(state.myPeerId, {
    serverUrl,
    roomId,
    userId: state.profile.userId,
    displayName: state.profile.displayName,
    avatarData: getAvatarUrl(state.profile.userId),
    hideOnline,
    lastSeen: hideOnline ? null : Date.now(),
    allowedUserIds: new Set(Array.from(state.contacts.keys()))
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
      displayName: state.profile.displayName
    });
    state.multiplexer.register(state.signalingRelay);
  } catch (e) {
    console.warn('Failed to register signaling relay transport:', e);
  }

  state.transport.onPeerDiscovery(async (_peerId, peerMeta) => {
    if (peerMeta.userId === state.profile.userId) return;

    const isNew = !state.contacts.has(peerMeta.userId);
    const existingContact = state.contacts.get(peerMeta.userId) || {};

    // Resolve best displayName: prefer server metadata if it differs from userId
    const resolvedDisplayName =
      (peerMeta.displayName && peerMeta.displayName !== peerMeta.userId)
        ? peerMeta.displayName
        : (existingContact.displayName && existingContact.displayName !== peerMeta.userId)
          ? existingContact.displayName
          : peerMeta.displayName || peerMeta.userId;

    await upsertContact(peerMeta.userId, {
      displayName: resolvedDisplayName,
      activePeerId: peerMeta.peerId,
      avatarUrl: peerMeta.avatar || existingContact.avatarUrl || null,
      online: true,
      hideOnline: Boolean(peerMeta.hideOnline),
      lastSeen: peerMeta.lastSeen || existingContact.lastSeen || null,
      roomId,
      lastMsg: existingContact.lastMsg || 'Онлайн'
    });

    // If this is a new contact, update WebRTC allowedUserIds so it can connect
    if (isNew) {
      state.transport.setAllowedUserIds(Array.from(state.contacts.keys()));
    }

    const chatId = peerMeta.userId;

    // Resend any pending (undelivered) messages for this user
    try {
      const pending = await messageDB.getUndeliveredMessages(chatId);
      for (const msg of pending) {
        try {
          await state.multiplexer.send(msg, peerMeta.peerId);
          await messageDB.markMessageSent(msg.id);
          markMessageDelivered(msg.id);
        } catch (e) {
          console.warn('[onPeerDiscovery] resend failed:', e?.message || e);
        }
      }
      await flushPendingMessageControls(chatId, peerMeta.peerId);
      await flushPendingCallControls(chatId, peerMeta.peerId);
    } catch (e) {
      console.warn('[onPeerDiscovery] pending flush failed:', e);
    }

    if (state.activeCall?.status === 'ringing' && state.activeCall.role === 'caller' && state.activeCall.peerUserId === chatId) {
      if (state.activeCall.remotePeerId !== peerMeta.peerId) {
        state.activeCall.remotePeerId = peerMeta.peerId;
      }
      try {
        const audioPromise = state.transport.startAudioCallWithLocalMedia(peerMeta.peerId, { asOfferer: false }).catch((e) => {
          console.warn('Caller audio setup failed when peer appeared:', e);
        });
        await state.multiplexer.send(
          {
            type: 'call',
            action: 'invite',
            callId: state.activeCall.callId,
            senderId: state.profile.userId,
            senderName: state.profile.displayName
          },
          peerMeta.peerId
        );
        await audioPromise;
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
    // Retry pending messages now that data channel is open
    try {
      const pending = await messageDB.getUndeliveredMessages(userId);
      for (const msg of pending) {
        try {
          await state.multiplexer.send(msg, peerId);
          await messageDB.markMessageSent(msg.id);
          markMessageDelivered(msg.id);
        } catch (e) {
          console.warn('onPeerConnected send failed:', e);
        }
      }
      await flushPendingCallControls(userId, peerId);
    } catch (e) {
      console.warn('onPeerConnected retry failed:', e);
    }
  });

  state.transport.onRemoteAudioStream((_peerId, stream) => {
    bindRemoteAudioStream(stream);
  });

  state.multiplexer.onMessage(async (packet, fromPeerId) => {
    if (packet.type === 'message_control') {
      await handleMessageControl(packet, fromPeerId);
      return;
    }

    if (packet.type === 'call') {
      await handleCallControl(packet, fromPeerId);
      return;
    }

    if (packet.type !== 'text') return;

    // Deduplicate by packet.packetId (added on send). If missing, use fingerprint.
    let pktId = packet.packetId;
    if (!pktId) {
      pktId = `${packet.senderId||fromPeerId}:${packet.timestamp}:${packet.content}`;
    }
    if (state.receivedPacketIds.has(pktId)) {
      return;
    }
    state.receivedPacketIds.add(pktId);

    if (packet.senderId === state.profile?.userId) return;
    if (packet.packetId && await messageDB.hasMessagePacket(packet.packetId)) return;

    const chatId = packet.senderId || findUserIdByPeerId(fromPeerId) || fromPeerId;
    const savedId = await messageDB.saveMessage(packet, chatId, false, { isOutgoing: false });
    packet._dbId = savedId;

    if (state.currentChatId !== chatId) {
      state.unreadCounts.set(chatId, (state.unreadCounts.get(chatId) || 0) + 1);
      refreshDocTitle();
    }
    // If viewing this chat, render incoming message
    if (state.currentChatId === chatId) {
      addMessageToUI(packet, false);
    }

    // Auto-add or update contact with real displayName from packet
    const existingContact = state.contacts.get(chatId);
    const resolvedDisplayName = packet.senderName && packet.senderName !== chatId
      ? packet.senderName
      : (existingContact?.displayName || chatId);

    const wasNew = !state.contacts.has(chatId);
    await upsertContact(chatId, {
      displayName: resolvedDisplayName,
      activePeerId: fromPeerId,
      online: true,
      roomId,
      lastMsg: packet.content,
      lastTime: packet.timestamp
    });

    // If contact was auto-created, update allowedUserIds
    if (wasNew) {
      state.transport?.setAllowedUserIds?.(Array.from(state.contacts.keys()));
    }
  });

  try {
    await state.transport.ready;
    await updateInviteArtifacts();
  } catch (error) {
    console.error('Handshake connect failed:', error);
  }
};

window.addContactById = async () => {
  const primaryInput = $('addUserId');
  const sourceInput = primaryInput;
  const userId = normalizeLogin(sourceInput?.value);
  if (!userId || !state.profile) return;
  if (!isValidLogin(userId)) {
    setStatus('warn', 'Введите логин вида @login');
    return;
  }
  if (userId === state.profile.userId) return;

  // Create or update contact with temporary displayName (will be updated from peer discovery)
  const existing = state.contacts.get(userId);
  await upsertContact(userId, {
    displayName: existing?.displayName || userId,
    lastMsg: existing?.lastMsg || 'Контакт добавлен',
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
        online: true,
        roomId: peer.roomId
      });
    }
  }

  if (primaryInput) primaryInput.value = '';
  renderContacts();
  await openChat(userId);
};

window.copyAppShareLink = async () => {
  await navigator.clipboard.writeText(buildAppShareLink());
};

window.copyInviteLink = window.copyAppShareLink;

window.renameCurrentContact = async () => {
  openChatMenu();
};

window.clearCurrentHistory = async (scope = 'me') => {
  if (!state.currentChatId) return;
  const chatId = state.currentChatId;
  if (scope === 'all') {
    await sendMessageControl({ action: 'clear_chat' }, chatId);
  }
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
    await sendMessageControl({ action: 'delete_messages', packetIds }, chatId);
  }

  await messageDB.deleteMessages(ids);
  state.selectedMessageIds.clear();
  await renderChatHistory(chatId);
};

async function sendMessageControl(payload, chatId = state.currentChatId) {
  if (!chatId || !state.multiplexer || !state.profile) return false;
  const packet = {
    type: 'message_control',
    senderId: state.profile.userId,
    timestamp: Date.now(),
    ...payload
  };
  const targetPeerId = await resolvePeerForUser(chatId);
  if (!targetPeerId) {
    await queuePendingMessageControl(chatId, packet);
    return true;
  }
  try {
    await state.multiplexer.send(packet, targetPeerId);
  } catch (error) {
    await queuePendingMessageControl(chatId, packet);
  }
  return true;
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

async function sendCallControl(action, callId, userId, peerId = null) {
  if (!userId || !state.multiplexer || !state.profile) return false;
  const packet = {
    type: 'call',
    action,
    callId,
    senderId: state.profile.userId
  };

  let targetPeerId = peerId;
  if (!targetPeerId) {
    targetPeerId = await resolvePeerForUser(userId).catch(() => null);
  }

  if (!targetPeerId) {
    await queuePendingCallControl(userId, packet);
    return false;
  }

  try {
    await state.multiplexer.send(packet, targetPeerId);
    return true;
  } catch (error) {
    await queuePendingCallControl(userId, packet);
    return false;
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
    controlId: packet.controlId || crypto.randomUUID()
  });
  await messageDB.saveSetting(key, pending);
}

async function flushPendingCallControls(chatId, targetPeerId) {
  if (!state.multiplexer || !chatId || !targetPeerId) return;
  const key = pendingCallControlsKey(chatId);
  const pending = await messageDB.getSetting(key) || [];
  if (!pending.length) return;

  const remaining = [];
  for (const packet of pending) {
    try {
      await state.multiplexer.send(packet, targetPeerId);
    } catch (error) {
      remaining.push(packet);
    }
  }
  await messageDB.saveSetting(key, remaining);
}

async function flushPendingMessageControls(chatId, targetPeerId) {
  if (!state.multiplexer || !targetPeerId) return;
  const key = pendingControlsKey(chatId);
  const pending = await messageDB.getSetting(key) || [];
  if (!pending.length) return;

  const remaining = [];
  for (const packet of pending) {
    try {
      await state.multiplexer.send(packet, targetPeerId);
    } catch (error) {
      remaining.push(packet);
    }
  }
  await messageDB.saveSetting(key, remaining);
}

window.deleteCurrentChat = async () => {
  if (!state.currentChatId) return;
  const chatId = state.currentChatId;
  // Only delete messages, keep the contact
  await messageDB.deleteChat(chatId);
  state.selectedMessageIds.clear();
  const contact = state.contacts.get(chatId);
  if (contact) {
    await upsertContact(chatId, { ...contact, lastMsg: '', lastTime: 0 });
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
  const contact = state.contacts.get(state.currentChatId);
  if (contact?.blocked) {
    setStatus('warning', 'Контакт заблокирован. Сначала разблокируйте.');
    return;
  }

  const packet = {
    packetId: crypto.randomUUID(),
    type: 'text',
    content: text,
    senderId: state.profile.userId,
    senderName: state.profile.displayName,
    timestamp: Date.now()
  };

  input.value = '';
  const dbKey = await messageDB.saveMessage(packet, chatId, false, { isOutgoing: true });
  packet._dbId = dbKey;
  await upsertContact(chatId, {
    ...contact,
    lastMsg: text,
    lastTime: packet.timestamp
  });
  if (state.currentChatId === chatId) {
    addMessageToUI(packet, true, { pending: true });
  }

  deliverOutgoingMessage(chatId, packet).catch((error) => {
    console.warn('Deferred send failed:', error);
  });
};

async function deliverOutgoingMessage(chatId, packet) {
  try {
    const contact = state.contacts.get(chatId);
    const targetPeerId = await resolvePeerForUser(chatId);

    if (!targetPeerId) {
      // Peer is offline — message stays as pending (isSent: false) in DB.
      // It will be retried automatically when the peer comes online via
      // onPeerDiscovery / onPeerConnected callbacks.
      console.log('[deliver] peer offline, message queued as pending:', chatId);
      return;
    }

    await state.multiplexer.send(packet, targetPeerId);
    await messageDB.markMessageSent(packet._dbId || packet.id);
    await upsertContact(chatId, {
      ...contact,
      activePeerId: targetPeerId,
      online: true,
      lastMsg: packet.content,
      lastTime: packet.timestamp
    });
    markMessageDelivered(packet._dbId || packet.id);
  } catch (error) {
    // Transport failed — message stays pending, will retry on reconnect
    console.warn('[deliver] send failed, message stays pending:', error?.message || error);
  }
}

function markMessageDelivered(messageId) {
  if (messageId === undefined) return;
  const node = document.querySelector(`.msg[data-message-id="${CSS.escape(String(messageId))}"]`);
  node?.classList.remove('pending');
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

  if (hint) {
    hint.textContent = '';
  }

  if (qr) {
    try {
      qr.src = await QRCode.toDataURL(link, {
        width: 196,
        margin: 1,
        color: {
          dark: '#0a0a0a',
          light: '#f4f4f4'
        }
      });
    } catch (error) {
      console.error('QR generation failed:', error);
    }
  }
}

function renderProfile() {
  const isAuthenticated = Boolean(state.profile);
  
  if (!isAuthenticated) {
    return;
  }

  $('displayNameInput').value = state.profile.displayName;
  renderProfileCards();
  updateSettingsPanel();
}

function renderContacts() {
  const container1 = $('contacts');
  const container2 = $('contactsList');
  
  const renderContactItem = ([id, contact], isActive) => {
    const unread = state.unreadCounts.get(id) || 0;
    const initials = getContactInitials(contact.displayName || id);
    const preview = contact.blocked
      ? 'Заблокирован'
      : contact.lastMsg
        ? truncate(contact.lastMsg, 40)
        : (contact.online ? 'В сети' : 'Не в сети');
    const time = contact.lastTime ? formatDate(contact.lastTime) : '';

    const btn = document.createElement('button');
    btn.className = `contact-item ${isActive ? 'active' : ''}`;
    btn.innerHTML = `
      <div class="contact-avatar contact-avatar-clickable">${getAvatarHtml(id, initials)}</div>
      <div class="contact-info">
        <div class="contact-name-row">
          <span class="contact-name${unread > 0 ? ' has-unread' : ''}">${escapeHtml(getContactLabel(contact))}</span>
          <span class="contact-time">${time}</span>
        </div>
        <span class="contact-preview${unread > 0 ? ' has-unread' : ''}">${escapeHtml(preview)}</span>
      </div>
      ${unread > 0 ? `<div class="contact-right"><div class="contact-badge">${unread > 99 ? '99+' : unread}</div></div>` : ''}
    `;

    // Avatar click → open profile
    const avatarEl = btn.querySelector('.contact-avatar-clickable');
    if (avatarEl) {
      avatarEl.addEventListener('click', (e) => {
        e.stopPropagation();
        openContactProfile(id);
      });
    }

    btn.onclick = () => openChat(id);
    return btn;
  };

  const render = (container, grouped) => {
    if (!container) return;
    container.innerHTML = '';

    const items = Array.from(state.contacts.entries())
      .filter(([id]) => !isSelfContactId(id));

    if (items.length === 0) {
      container.innerHTML = '<div class="empty" style="padding: 16px; text-align: center; color: var(--muted); font-size: 13px;">Нет контактов</div>';
      return;
    }

    if (!grouped) {
      items.sort(([, left], [, right]) => {
        if (Boolean(right.online) !== Boolean(left.online)) {
          return Number(Boolean(right.online)) - Number(Boolean(left.online));
        }
        return (right.updatedAt || 0) - (left.updatedAt || 0);
      });
      for (const item of items) {
        container.appendChild(renderContactItem(item, item[0] === state.currentChatId));
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
        container.appendChild(renderContactItem(item, item[0] === state.currentChatId));
      }
    }
  };
  
  render(container1, false);
  render(container2, true);
}

function getAvatarHtml(userId, initials) {
  const url = getAvatarUrl(userId);
  if (url) {
    return `<img src="${escapeHtml(url)}" alt="">`;
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
  const ra = $('remoteAudio');
  if (ra) ra.srcObject = null;
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
    const gain = ctx.createGain();
    gain.gain.value = kind === 'incoming' ? 0.08 : 0.045;
    gain.connect(ctx.destination);

    let stopped = false;
    const playPulse = () => {
      if (stopped) return;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(kind === 'incoming' ? 880 : 520, now);
      osc.frequency.exponentialRampToValueAtTime(kind === 'incoming' ? 660 : 620, now + 0.18);
      osc.connect(gain);
      osc.start(now);
      osc.stop(now + 0.32);
    };

    ctx.resume?.().catch(() => {});
    playPulse();
    const intervalMs = kind === 'incoming' ? 900 : 1300;
    const timer = window.setInterval(playPulse, intervalMs);
    state.ringTone = {
      stop: () => {
        stopped = true;
        window.clearInterval(timer);
        ctx.close().catch(() => {});
      }
    };
  } catch (error) {
    console.warn('Ring tone failed:', error);
  }
}

function stopRingTone() {
  if (!state.ringTone) return;
  state.ringTone.stop();
  state.ringTone = null;
}

async function handleCallControl(packet, fromPeerId) {
  const { action, callId } = packet;
  const peerUserId = packet.senderId || findUserIdByPeerId(fromPeerId);

  if (action === 'invite' && peerUserId && callId) {
    const existingContact = state.contacts.get(peerUserId);
    const resolvedDisplayName = packet.senderName && packet.senderName !== peerUserId
      ? packet.senderName
      : (existingContact?.displayName || peerUserId);

    const wasNew = !state.contacts.has(peerUserId);
    await upsertContact(peerUserId, {
      displayName: resolvedDisplayName,
      activePeerId: fromPeerId,
      online: true,
      roomId: state.transport?.options?.roomId,
      lastMsg: existingContact?.lastMsg || 'Звонок'
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
    return;
  }

  if (action === 'accept' && callId && state.activeCall?.role === 'caller' && state.activeCall.callId === callId) {
    stopRingTone();
    state.activeCall.status = 'active';
    updateCallBar();
    queueMicrotask(() => playRemoteAudioIfReady());
    return;
  }

  if (action === 'reject' && callId && state.activeCall?.callId === callId) {
    stopRingTone();
    state.activeCall = null;
    updateCallBar();
    return;
  }

  if (action === 'end' && callId && state.activeCall?.callId === callId) {
    stopRingTone();
    await hangupCallAudio(fromPeerId);
    state.activeCall = null;
    state.micMuted = false;
    updateCallBar();
  }
}

async function handleMessageControl(packet, fromPeerId) {
  const chatId = packet.senderId || findUserIdByPeerId(fromPeerId) || fromPeerId;
  if (packet.action === 'delete_messages') {
    await messageDB.deleteMessagesByPacketIds(chatId, packet.packetIds || []);
  } else if (packet.action === 'clear_chat') {
    await messageDB.deleteChat(chatId);
  } else {
    return;
  }

  if (state.currentChatId === chatId) {
    state.selectedMessageIds.clear();
    await renderChatHistory(chatId);
  }

  const contact = state.contacts.get(chatId);
  if (contact) {
    await upsertContact(chatId, {
      ...contact,
      lastMsg: '',
      lastTime: 0
    });
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
    if (label) label.textContent = `Звонок · ${name}`;
    if (actions) {
      const micLabel = state.micMuted ? 'Включить мик' : 'Выключить мик';
      actions.innerHTML = `
        <button type="button" class="btn subtle" id="callMuteBtn">${micLabel}</button>
        <button type="button" class="btn subtle" id="callEndBtn">Завершить</button>
      `;
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

window.startVoiceCall = async () => {
  if (!state.currentChatId || !state.transport || !state.multiplexer || !state.profile) return;
  const contact = state.contacts.get(state.currentChatId);
  if (state.activeCall) return;

  const callId = crypto.randomUUID();
  state.activeCall = {
    callId,
    peerUserId: state.currentChatId,
    remotePeerId: contact?.activePeerId || null,
    status: 'ringing',
    role: 'caller'
  };
  startRingTone('outgoing');
  updateCallBar();

  const targetPeerId = await resolvePeerForUser(state.currentChatId).catch(() => null);
  if (targetPeerId) {
    state.activeCall.remotePeerId = targetPeerId;
  } else {
    setStatus('warn', 'Собеседник не найден онлайн — приглашение будет отправлено при появлении.');
  }

  if (targetPeerId) {
    const audioSetup = state.transport.startAudioCallWithLocalMedia(targetPeerId, { asOfferer: true })
      .catch((e) => {
        if (state.activeCall?.callId !== callId) return;
        console.warn('Caller audio setup failed:', e);
      });

    try {
      await state.multiplexer.send(
        {
          type: 'call',
          action: 'invite',
          callId,
          senderId: state.profile.userId,
          senderName: state.profile.displayName
        },
        targetPeerId
      );
    } catch (e) {
      console.warn('Invite failed:', e);
      stopRingTone();
      state.activeCall = null;
      updateCallBar();
      setStatus('error', 'Не удалось позвонить');
      return;
    }

    await audioSetup;
  }
};

window.answerVoiceCall = async () => {
  const ac = state.activeCall;
  if (!ac || ac.status !== 'incoming' || !state.transport || !state.multiplexer || !state.profile) return;

  const contact = state.contacts.get(ac.peerUserId);
  const peerId = contact?.activePeerId || ac.remotePeerId;
  if (!peerId) return;

  try {
    stopRingTone();
    ac.status = 'active';
    updateCallBar();

    // Start audio (callee sends renegotiation offer with sendrecv)
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

    await playRemoteAudioIfReady();
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
  state.activeCall = null;
  updateCallBar();
  await sendCallControl('reject', ac.callId, ac.peerUserId, peerId);
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
  state.activeCall = null;
  state.micMuted = false;
  updateCallBar();
  await sendCallControl('end', ac.callId, ac.peerUserId, peerId);
  await hangupCallAudio(peerId);
};

function renderChatHeader() {
  const title = $('chatTitle');
  const subtitle = $('chatSubtitle');
  const btnCall = $('btnCall');
  const btnMenu = $('btnChatMenu');
  const headerAvatar = $('chatHeaderAvatar');

  if (btnCall) {
    btnCall.hidden = !state.currentChatId || Boolean(state.activeCall) || Boolean(state.contacts.get(state.currentChatId)?.blocked);
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
  message.innerHTML = `
    <span>${escapeHtml(packet.content)}</span>
    <time>${formatTime(packet.timestamp)}</time>
  `;
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
  return next;
}

function getContactLabel(contact) {
  return contact?.alias || contact?.displayName || contact?.id || '';
}

// Returns online status text respecting the contact's hideOnline preference
function getOnlineStatusText(contact) {
  if (!contact) return 'не в сети';
  if (contact.hideOnline) return 'был(а) недавно';
  if (contact.online) return 'в сети';
  if (contact.lastSeen) {
    return `был(а) ${formatDate(contact.lastSeen)}`;
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
  const gallery = $('profileAvatarGallery');
  const nameEl = $('profileModalName');
  const idEl = $('profileModalId');
  const statusEl = $('profileModalStatus');
  const callBtn = $('profileCallBtn');
  const blockBtn = $('profileBlockBtn');
  const blockLabel = $('profileBlockLabel');
  const deleteBtn = $('profileDeleteBtn');
  const deleteAvatarBtn = $('profileDeleteAvatarBtn');

  if (!avatarEl || !nameEl || !idEl || !statusEl || !callBtn || !blockBtn || !gallery) return;

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
    avatarEl.innerHTML = `<img src="${escapeHtml(avatarUrl)}" alt="">`;
  } else {
    avatarEl.textContent = getContactInitials(getContactLabel(contact));
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
