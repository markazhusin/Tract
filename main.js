import QRCode from 'qrcode';
import {
  clearSessionPeerId,
  getLegacyIdentityMetadata,
  getOrCreateSessionPeerId,
  getStoredIdentityMetadata,
  registerIdentity,
  unlockIdentity,
  updateStoredDisplayName
} from './app/core/keypair.js';
import { Multiplexer } from './app/core/multiplexer.js';
import { WebRTCTransport } from './app/transports/webrtc.js';
import { messageDB } from './app/core/database.js';

const SIGNALING_URL_KEY = 'tract.signaling.url';
const ROOM_ID_KEY = 'tract.room.id';
const SESSION_PASSWORD_KEY = 'tract.session.unlockPassword';
/** Общая «комната» по умолчанию: все с одной ссылкой и «Подключиться» видят друг друга. */
const DEFAULT_ROOM_ID = 'tract-public';
const SESSION_ID_PATTERN = /^[a-f0-9]{12}-[a-f0-9]{4}$/i;

const state = {
  keyPair: null,
  profile: null,
  myPeerId: null,
  transport: null,
  multiplexer: null,
  currentChatId: null,
  contacts: new Map(),
  activeCall: null,
  unreadCounts: new Map(),
  micMuted: false
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
  const parts = (displayName || '?').split(' ');
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return displayName.slice(0, 2).toUpperCase();
}

function renderProfileCards() {
  if (!state.profile) return;
  
  const initials = getContactInitials(state.profile.displayName);
  
  // Profile card in Chats view
  const cardChats = $('profileCardChats');
  if (cardChats) {
    cardChats.hidden = false;
    const avatarChats = $('profileAvatarChats');
    const nameChats = $('profileNameChats');
    const idChats = $('profileUserIdChats');
    if (avatarChats) avatarChats.textContent = initials;
    if (nameChats) nameChats.textContent = state.profile.displayName;
    if (idChats) idChats.textContent = state.profile.userId;
  }
  
  // Profile card in Settings view
  const cardSettings = $('profileCardSettings');
  if (cardSettings) {
    const avatarSettings = $('profileAvatarSettings');
    const nameSettings = $('profileNameSettings');
    const idSettings = $('profileUserIdSettings');
    if (avatarSettings) avatarSettings.textContent = initials;
    if (nameSettings) nameSettings.textContent = state.profile.displayName;
    if (idSettings) idSettings.textContent = state.profile.userId;
  }
}

function updateSettingsPanel() {
  if (!state.profile) return;
  
  $('settingUserId').textContent = state.profile.userId;
  $('settingPeerId').textContent = state.myPeerId || '...';
  
  const status = state.transport ? 'В сети' : 'Не в сети';
  const statusEl = $('settingStatus');
  if (statusEl) statusEl.textContent = status;
}

async function init() {
  applyInviteParams();
  syncSignalingFromEnvironment();
  window.addEventListener('resize', updateMobileLayout);

  const identity = getStoredIdentityMetadata();
  const legacyIdentity = getLegacyIdentityMetadata();
  const sessionPw = sessionStorage.getItem(SESSION_PASSWORD_KEY);

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
    openGate('login', {
      title: 'Вход в Tract',
      hint: 'Введите пароль, чтобы разблокировать существующий локальный аккаунт.'
    });
  } else if (legacyIdentity) {
    $('registerName').value = legacyIdentity.profile.displayName;
    openGate('register', {
      title: 'Завершение миграции аккаунта',
      hint: `Найдена старая локальная identity ${legacyIdentity.profile.userId}. Задайте пароль, чтобы сохранить этот аккаунт в новой модели входа.`
    });
  } else {
    openGate('register', {
      title: 'Регистрация в Tract',
      hint: 'Сначала создаётся локальный аккаунт устройства. Если аккаунт уже есть, переключитесь на вход.'
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
  hint: 'Создайте локальный аккаунт устройства. Приватный ключ останется в браузере.'
});
window.showLogin = () => {
  const identity = getStoredIdentityMetadata();
  if (!identity) {
    $('authError').textContent = 'Старый локальный аккаунт нужно сначала зашифровать паролем через регистрацию.';
    return;
  }

  $('loginUserId').textContent = identity.userId;
  openGate('login', {
    title: 'Вход в Tract',
    hint: 'Введите пароль, чтобы разблокировать аккаунт.'
  });
};

window.registerAccount = async () => {
  if (!window.isSecureContext) {
    $('authError').textContent =
      'Нужен HTTPS (или localhost). Запустите npm run start и откройте https://…:5173 — браузер спросит про сертификат, это нормально.';
    return;
  }

  const displayName = $('registerName').value.trim() || 'Anonymous';
  const password = $('registerPassword').value;
  const confirm = $('registerPasswordConfirm').value;

  if (!password || password.length < 6) {
    $('authError').textContent = 'Пароль должен быть не короче 6 символов';
    return;
  }

  if (password !== confirm) {
    $('authError').textContent = 'Пароли не совпадают';
    return;
  }

  $('authError').textContent = '';

  try {
    const auth = await registerIdentity(password, displayName, { reuseLegacy: true });
    sessionStorage.setItem(SESSION_PASSWORD_KEY, password);
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

  const password = $('loginPassword').value;
  if (!password) {
    $('authError').textContent = 'Введите пароль';
    return;
  }

  $('authError').textContent = '';

  try {
    const auth = await unlockIdentity(password);
    sessionStorage.setItem(SESSION_PASSWORD_KEY, password);
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

  if (state.transport) {
    await state.transport.stop();
  }

  state.contacts.clear();
  await restoreContacts();

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
  $('messages').innerHTML = '<div class="empty-chat">Откройте чат или создайте invite link</div>';
  setStatus('offline', 'Аккаунт разблокирован, сеть не подключена');
  await updateInviteArtifacts();
  updateMobileLayout();
  queueMicrotask(() => {
    connectHandshake().catch((e) => console.warn('Auto-connect:', e));
  });
}

window.logoutAccount = async () => {
  sessionStorage.removeItem(SESSION_PASSWORD_KEY);
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
  state.contacts.clear();
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
  renderProfile();
  if (state.transport?.signaling) {
    state.transport.options.displayName = displayName;
  }
  await updateInviteArtifacts();
};

window.connectHandshake = async () => {
  if (!state.profile || !state.keyPair) {
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

  const btnConnect = $('btnConnect');
  const connectLabel = btnConnect?.textContent;
  if (btnConnect) {
    btnConnect.disabled = true;
    btnConnect.textContent = 'Подключение…';
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
  setStatus('offline', 'Подключение…');

  state.multiplexer = new Multiplexer(state.keyPair);
  state.transport = new WebRTCTransport(state.myPeerId, {
    serverUrl,
    roomId,
    userId: state.profile.userId,
    displayName: state.profile.displayName
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

    await upsertContact(peerMeta.userId, {
      displayName: peerMeta.displayName || peerMeta.userId,
      activePeerId: peerMeta.peerId,
      online: true,
      roomId,
      lastMsg: state.contacts.get(peerMeta.userId)?.lastMsg || 'Онлайн'
    });
  });

  state.transport.onPeerOffline(async (peerId, peerMeta) => {
    const userId = peerMeta?.userId || findUserIdByPeerId(peerId);
    if (!userId) return;
    const contact = state.contacts.get(userId);
    if (!contact) return;

    await upsertContact(userId, {
      ...contact,
      activePeerId: null,
      online: false
    });
  });

  state.transport.onRemoteAudioStream((_peerId, stream) => {
    bindRemoteAudioStream(stream);
  });

  state.multiplexer.onMessage(async (packet, fromPeerId) => {
    if (packet.type === 'call') {
      await handleCallControl(packet, fromPeerId);
      return;
    }

    if (packet.type !== 'text') {
      return;
    }

    const chatId = packet.senderId || findUserIdByPeerId(fromPeerId) || fromPeerId;
    await messageDB.saveMessage(packet, chatId, false);

    if (state.currentChatId !== chatId) {
      state.unreadCounts.set(chatId, (state.unreadCounts.get(chatId) || 0) + 1);
      refreshDocTitle();
    }

    await upsertContact(chatId, {
      displayName: packet.senderName || state.contacts.get(chatId)?.displayName || chatId,
      activePeerId: fromPeerId,
      online: true,
      roomId,
      lastMsg: packet.content
    });

    if (state.currentChatId === chatId) {
      addMessageToUI(packet, false);
    }
  });

  try {
    await state.transport.ready;
    setStatus('online', `В сети · ${roomId}`);
    await updateInviteArtifacts();
  } catch (error) {
    console.error('Handshake connect failed:', error);
    setStatus('error', 'Не удалось подключиться');
  } finally {
    if (btnConnect) {
      btnConnect.disabled = false;
      btnConnect.textContent = connectLabel || 'Подключиться';
    }
  }
};

window.addContactById = async () => {
  const userId = $('addUserId').value.trim();
  if (!userId || !state.profile) return;
  if (userId === state.profile.userId) return;

  await upsertContact(userId, {
    displayName: state.contacts.get(userId)?.displayName || userId,
    lastMsg: state.contacts.get(userId)?.lastMsg || 'Контакт добавлен вручную'
  });

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

  $('addUserId').value = '';
  renderContacts();
};

window.copyAppShareLink = async () => {
  const link = buildAppShareLink();
  await navigator.clipboard.writeText(link);
  setStatus('online', 'Ссылка скопирована — отправьте другу');
};

window.copyInviteLink = window.copyAppShareLink;

window.renameCurrentContact = async () => {
  if (!state.currentChatId) return;
  const contact = state.contacts.get(state.currentChatId);
  const alias = window.prompt('Новое имя контакта', contact.alias || contact.displayName || contact.id);
  if (alias === null) return;
  await upsertContact(state.currentChatId, {
    ...contact,
    alias: alias.trim()
  });
  renderChatHeader();
};

window.clearCurrentHistory = async () => {
  if (!state.currentChatId) return;
  if (!window.confirm('Удалить историю этого чата?')) return;
  await messageDB.deleteChat(state.currentChatId);
  const contact = state.contacts.get(state.currentChatId);
  if (contact) {
    await upsertContact(state.currentChatId, {
      ...contact,
      lastMsg: ''
    });
  }
  await renderChatHistory(state.currentChatId);
};

window.deleteCurrentChat = async () => {
  if (!state.currentChatId) return;
  if (!window.confirm('Удалить чат и контакт?')) return;
  await messageDB.deleteChat(state.currentChatId);
  await messageDB.deleteContact(state.currentChatId);
  state.contacts.delete(state.currentChatId);
  state.currentChatId = null;
  renderContacts();
  renderChatHeader();
  $('messages').innerHTML = '<div class="empty-chat">Чат удалён</div>';
};

window.sendCurrentMessage = async () => {
  const input = $('messageInput');
  const text = input.value.trim();
  if (!text || !state.currentChatId || !state.multiplexer || !state.profile) return;

  const contact = state.contacts.get(state.currentChatId);
  if (!contact?.activePeerId) {
    setStatus(
      'error',
      'Собеседник не в сети. Оба нажмите «Подключиться» и откройте одну ссылку (одна «комната» уже выбрана автоматически).'
    );
    return;
  }

  const packet = {
    type: 'text',
    content: text,
    senderId: state.profile.userId,
    senderName: state.profile.displayName,
    timestamp: Date.now()
  };

  try {
    await state.multiplexer.send(packet, contact.activePeerId);
    await messageDB.saveMessage(packet, state.currentChatId, true);
    await upsertContact(state.currentChatId, {
      ...contact,
      lastMsg: text
    });
    addMessageToUI(packet, true);
    input.value = '';
  } catch (error) {
    console.warn('Send failed:', error);
    setStatus('error', 'Peer не подключен');
  }
};

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
    const profileCard = $('profileCardChats');
    if (profileCard) profileCard.hidden = true;
    return;
  }

  $('displayNameInput').value = state.profile.displayName;
  renderProfileCards();
  updateSettingsPanel();
}

function renderContacts() {
  const container1 = $('contacts');
  const container2 = $('contactsList');
  
  const render = (container, isMainList) => {
    if (!container) return;
    container.innerHTML = '';

    const items = Array.from(state.contacts.entries())
      .filter(([id]) => !isSelfContactId(id))
      .sort(([, left], [, right]) => {
        if (Boolean(right.online) !== Boolean(left.online)) {
          return Number(Boolean(right.online)) - Number(Boolean(left.online));
        }
        return (right.updatedAt || 0) - (left.updatedAt || 0);
      });

    if (items.length === 0) {
      container.innerHTML = '<div class="empty" style="padding: 16px; text-align: center; color: var(--muted); font-size: 13px;">Нет контактов</div>';
      return;
    }

    for (const [id, contact] of items) {
      const unread = state.unreadCounts.get(id) || 0;
      const initials = getContactInitials(contact.displayName || id);
      
      const btn = document.createElement('button');
      btn.className = `contact-item ${id === state.currentChatId ? 'active' : ''}`;
      btn.innerHTML = `
        <div class="contact-avatar">${initials}</div>
        <div class="contact-info">
          <span class="contact-name">${escapeHtml(getContactLabel(contact))}</span>
          <span class="contact-status ${contact.online ? 'online' : ''}">${contact.online ? '🟢 В сети' : '⚫ Не в сети'}</span>
        </div>
        ${unread > 0 ? `<div class="contact-badge">${unread > 99 ? '99+' : unread}</div>` : ''}
      `;
      btn.onclick = () => openChat(id);
      container.appendChild(btn);
    }
  };
  
  render(container1, true);
  render(container2, false);
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
  state.unreadCounts.delete(id);
  refreshDocTitle();
  renderContacts();
  renderChatHeader();
  await renderChatHistory(id);
  updateMobileLayout();
}

window.goBackFromChat = () => {
  state.currentChatId = null;
  renderContacts();
  renderChatHeader();
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

async function handleCallControl(packet, fromPeerId) {
  const { action, callId } = packet;
  const peerUserId = packet.senderId || findUserIdByPeerId(fromPeerId);

  if (action === 'invite' && peerUserId && callId) {
    await upsertContact(peerUserId, {
      displayName: packet.senderName || state.contacts.get(peerUserId)?.displayName || peerUserId,
      activePeerId: fromPeerId,
      online: true,
      roomId: state.transport?.options?.roomId,
      lastMsg: state.contacts.get(peerUserId)?.lastMsg || 'Звонок'
    });

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
    updateCallBar();
    updateMobileLayout();
    return;
  }

  if (action === 'accept' && callId && state.activeCall?.role === 'caller' && state.activeCall.callId === callId) {
    state.transport?.expectVoiceAnswer(fromPeerId);
    state.activeCall.status = 'active';
    updateCallBar();
    queueMicrotask(() => playRemoteAudioIfReady());
    return;
  }

  if (action === 'reject' && callId && state.activeCall?.callId === callId) {
    state.activeCall = null;
    updateCallBar();
    return;
  }

  if (action === 'end' && callId && state.activeCall?.callId === callId) {
    await hangupCallAudio(fromPeerId);
    state.activeCall = null;
    state.micMuted = false;
    updateCallBar();
  }
}

function updateCallBar() {
  const bar = $('callBar');
  if (!bar) return;

  const ac = state.activeCall;
  const chat = $('chat');
  if (!ac) {
    bar.hidden = true;
    if (chat) chat.classList.remove('call-bar-visible');
    renderChatHeader();
    return;
  }

  bar.hidden = false;
  if (chat) chat.classList.add('call-bar-visible');
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
    // On mobile: show sidebar at init, show chat when chat is selected
    if (state.currentChatId) {
      sidebar.classList.remove('show');
    } else {
      sidebar.classList.add('show');
    }
  } else {
    // On desktop: always show sidebar
    sidebar.classList.remove('show');
  }
}

window.startVoiceCall = async () => {
  if (!state.currentChatId || !state.transport || !state.multiplexer || !state.profile) return;
  const contact = state.contacts.get(state.currentChatId);
  if (!contact?.activePeerId) {
    setStatus('error', 'Собеседник не в сети');
    return;
  }
  if (state.activeCall) return;

  const callId = crypto.randomUUID();
  state.activeCall = {
    callId,
    peerUserId: state.currentChatId,
    remotePeerId: contact.activePeerId,
    status: 'ringing',
    role: 'caller'
  };
  updateCallBar();

  try {
    await state.multiplexer.send(
      {
        type: 'call',
        action: 'invite',
        callId,
        senderId: state.profile.userId,
        senderName: state.profile.displayName
      },
      contact.activePeerId
    );
  } catch (e) {
    console.warn('Invite failed:', e);
    state.activeCall = null;
    updateCallBar();
    setStatus('error', 'Не удалось позвонить');
  }
};

window.answerVoiceCall = async () => {
  const ac = state.activeCall;
  if (!ac || ac.status !== 'incoming' || !state.transport || !state.multiplexer || !state.profile) return;

  const contact = state.contacts.get(ac.peerUserId);
  const peerId = contact?.activePeerId || ac.remotePeerId;
  if (!peerId) return;

  try {
    await state.multiplexer.send(
      {
        type: 'call',
        action: 'accept',
        callId: ac.callId,
        senderId: state.profile.userId
      },
      peerId
    );
    await state.transport.startAudioCallWithLocalMedia(peerId, { asOfferer: true });
    ac.status = 'active';
    updateCallBar();
    await playRemoteAudioIfReady();
  } catch (e) {
    console.warn('Answer failed:', e);
    state.activeCall = null;
    updateCallBar();
    setStatus('error', 'Не удалось ответить');
  }
};

window.declineVoiceCall = async () => {
  const ac = state.activeCall;
  if (!ac || ac.status !== 'incoming' || !state.multiplexer || !state.profile) return;

  const contact = state.contacts.get(ac.peerUserId);
  const peerId = contact?.activePeerId || ac.remotePeerId;
  if (peerId) {
    await state.multiplexer
      .send(
        {
          type: 'call',
          action: 'reject',
          callId: ac.callId,
          senderId: state.profile.userId
        },
        peerId
      )
      .catch(() => {});
  }
  state.activeCall = null;
  updateCallBar();
};

window.endVoiceCall = async () => {
  const ac = state.activeCall;
  if (!ac || !state.multiplexer || !state.profile) {
    state.activeCall = null;
    state.micMuted = false;
    updateCallBar();
    return;
  }

  const contact = state.contacts.get(ac.peerUserId);
  const peerId = contact?.activePeerId || ac.remotePeerId;
  if (peerId) {
    await state.multiplexer
      .send(
        {
          type: 'call',
          action: 'end',
          callId: ac.callId,
          senderId: state.profile.userId
        },
        peerId
      )
      .catch(() => {});
  }
  await hangupCallAudio(peerId);
  state.activeCall = null;
  state.micMuted = false;
  updateCallBar();
};

function renderChatHeader() {
  const title = $('chatTitle');
  const subtitle = $('chatSubtitle');
  const btnCall = $('btnCall');
  
  if (btnCall) {
    const contact = state.currentChatId ? state.contacts.get(state.currentChatId) : null;
    btnCall.hidden = !state.currentChatId || !contact?.online || Boolean(state.activeCall);
  }

  if (!state.currentChatId) {
    if (title) title.textContent = 'Чаты';
    if (subtitle) subtitle.textContent = 'Выберите диалог';
    return;
  }

  const contact = state.contacts.get(state.currentChatId);
  if (title) title.textContent = getContactLabel(contact);
  if (subtitle) subtitle.textContent = `${contact?.online ? 'в сети' : 'не в сети'}`;
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
      online: false,
      activePeerId: null
    });
  }
}

async function renderChatHistory(chatId) {
  const messages = await messageDB.getMessages(chatId);
  const container = $('messages');
  container.innerHTML = '';

  if (messages.length === 0) {
    container.innerHTML = '<div class="empty-chat">Сообщений пока нет</div>';
    return;
  }

  for (const message of messages) {
    addMessageToUI(message, message.isSent);
  }
}

function addMessageToUI(packet, isSent) {
  const div = $('messages');
  const message = document.createElement('div');
  message.className = `msg ${isSent ? 'sent' : 'received'}`;
  message.innerHTML = `
    <span>${packet.content}</span>
    <time>${formatTime(packet.timestamp)}</time>
  `;
  div.appendChild(message);
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
  return contact.alias || contact.displayName || contact.id;
}

function setStatus(kind, text) {
  const node = $('networkStatus');
  if (!node) return;
  
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

init();
