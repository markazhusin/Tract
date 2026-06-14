// App lock & disguise.
//
// Three modes (persisted in localStorage as `tract.lock.mode`):
//   off        — no lock.
//   passcode   — Telegram-style 4-digit code on launch.
//   calculator — the app masquerades as a Calculator (icon + name swapped in the
//                <head> boot script). It behaves as a real calculator until the
//                user types the secret combo, presses "=", then "+".
//
// Two secrets are stored as SHA-256 hashes (never plaintext):
//   codeHash — unlock.
//   wipeHash — duress code: wipes ALL local data and unregisters the PWA.
//
// The duress path is intentionally indistinguishable to an observer: entering it
// looks exactly like a wrong/normal entry, but it destroys everything.

const LOCK_MODE_KEY = 'tract.lock.mode';
const LOCK_CODE_KEY = 'tract.lock.codeHash';
const LOCK_WIPE_KEY = 'tract.lock.wipeHash';

let onUnlocked = null;

async function sha256Hex(input) {
  const data = new TextEncoder().encode(String(input));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function getLockMode() {
  const m = localStorage.getItem(LOCK_MODE_KEY);
  return m === 'passcode' || m === 'calculator' ? m : 'off';
}

export function isLockEnabled() {
  return getLockMode() !== 'off';
}

export function hasWipeCode() {
  return Boolean(localStorage.getItem(LOCK_WIPE_KEY));
}

// Persist a lock configuration. Empty/short codes throw so callers can validate.
export async function configureLock({ mode, code, wipeCode }) {
  if (mode === 'off') {
    localStorage.removeItem(LOCK_MODE_KEY);
    localStorage.removeItem(LOCK_CODE_KEY);
    localStorage.removeItem(LOCK_WIPE_KEY);
    return;
  }
  if (!code || String(code).length < 1) {
    throw new Error('empty-code');
  }
  if (wipeCode && String(wipeCode) === String(code)) {
    throw new Error('codes-equal');
  }
  localStorage.setItem(LOCK_MODE_KEY, mode);
  localStorage.setItem(LOCK_CODE_KEY, await sha256Hex(code));
  if (wipeCode) {
    localStorage.setItem(LOCK_WIPE_KEY, await sha256Hex(wipeCode));
  } else {
    localStorage.removeItem(LOCK_WIPE_KEY);
  }
}

export async function disableLock() {
  await configureLock({ mode: 'off' });
}

// 'unlock' | 'wipe' | 'invalid'
async function classifyCode(code) {
  const hash = await sha256Hex(code);
  const wipeHash = localStorage.getItem(LOCK_WIPE_KEY);
  const codeHash = localStorage.getItem(LOCK_CODE_KEY);
  if (wipeHash && hash === wipeHash) return 'wipe';
  if (codeHash && hash === codeHash) return 'unlock';
  return 'invalid';
}

// Destroy every trace of the app on this device.
export async function wipeEverything() {
  try { localStorage.clear(); } catch {}
  try { sessionStorage.clear(); } catch {}

  try {
    if (typeof indexedDB.databases === 'function') {
      const dbs = await indexedDB.databases();
      await Promise.all(
        dbs
          .filter((d) => d && d.name)
          .map((d) => new Promise((res) => {
            const req = indexedDB.deleteDatabase(d.name);
            req.onsuccess = req.onerror = req.onblocked = () => res();
          }))
      );
    } else {
      // Older browsers can't enumerate; delete the known database names.
      indexedDB.deleteDatabase('TractDB');
    }
  } catch {}

  try {
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {}

  try {
    if (navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } catch {}
}

function doUnlock() {
  const host = document.getElementById('lockScreen');
  if (host) { host.hidden = true; host.innerHTML = ''; }
  document.documentElement.removeAttribute('data-locked');
  const cb = onUnlocked;
  onUnlocked = null;
  cb?.();
}

async function doWipe() {
  await wipeEverything();
  // Reload to a pristine state. localStorage is gone, so the lock config and
  // disguise are gone too — an observer just sees an empty app, the victim's
  // data is unrecoverable.
  location.reload();
}

async function handleCodeEntry(code, onInvalid) {
  const kind = await classifyCode(code);
  if (kind === 'unlock') return doUnlock();
  if (kind === 'wipe') return doWipe();
  onInvalid?.();
}

// ---------- Calculator UI ----------

function createCalculator() {
  const root = document.createElement('div');
  root.className = 'calc';

  const screen = document.createElement('div');
  screen.className = 'calc-screen';
  screen.textContent = '0';

  const keys = document.createElement('div');
  keys.className = 'calc-keys';

  root.appendChild(screen);
  root.appendChild(keys);

  let display = '0';
  let acc = null;        // accumulated value
  let op = null;         // pending operator: + - × ÷
  let fresh = true;      // next digit begins a new number
  let comboCandidate = ''; // raw number string the user last typed
  let equalsArmed = false; // "=" was the previous action

  const render = () => { screen.textContent = display; };

  const compute = (a, b, operator) => {
    switch (operator) {
      case '+': return a + b;
      case '−': return a - b;
      case '×': return a * b;
      case '÷': return b === 0 ? 0 : a / b;
      default: return b;
    }
  };

  const fmt = (n) => {
    if (!isFinite(n)) return '0';
    let s = String(Math.round(n * 1e10) / 1e10);
    if (s.length > 12) s = n.toPrecision(10).replace(/\.?0+$/, '');
    return s;
  };

  const inputDigit = (d) => {
    if (fresh) {
      display = d === '.' ? '0.' : d;
      fresh = false;
    } else if (d === '.') {
      if (!display.includes('.')) display += '.';
    } else {
      display = display === '0' ? d : display + d;
    }
    comboCandidate = display;
    equalsArmed = false;
    render();
  };

  const chooseOp = (nextOp) => {
    // Unlock/duress gesture: "+" pressed immediately after "=".
    if (nextOp === '+' && equalsArmed) {
      handleCodeEntry(comboCandidate, null);
    }
    equalsArmed = false;
    const val = parseFloat(display);
    if (op !== null && !fresh) {
      acc = compute(acc, val, op);
      display = fmt(acc);
    } else {
      acc = val;
    }
    op = nextOp;
    fresh = true;
    render();
  };

  const equals = () => {
    const val = parseFloat(display);
    if (op !== null) {
      acc = compute(acc, val, op);
      display = fmt(acc);
      op = null;
    } else {
      acc = val;
    }
    // comboCandidate already holds the number string the user typed.
    equalsArmed = true;
    fresh = true;
    render();
  };

  const clearAll = () => {
    display = '0'; acc = null; op = null; fresh = true; comboCandidate = ''; equalsArmed = false;
    render();
  };

  const toggleSign = () => {
    if (display === '0') return;
    display = display.startsWith('-') ? display.slice(1) : '-' + display;
    comboCandidate = display;
    render();
  };

  const percent = () => {
    display = fmt(parseFloat(display) / 100);
    comboCandidate = display;
    render();
  };

  const layout = [
    { label: 'AC', cls: 'fn', act: clearAll },
    { label: '+/−', cls: 'fn', act: toggleSign },
    { label: '%', cls: 'fn', act: percent },
    { label: '÷', cls: 'op', act: () => chooseOp('÷') },
    { label: '7', act: () => inputDigit('7') },
    { label: '8', act: () => inputDigit('8') },
    { label: '9', act: () => inputDigit('9') },
    { label: '×', cls: 'op', act: () => chooseOp('×') },
    { label: '4', act: () => inputDigit('4') },
    { label: '5', act: () => inputDigit('5') },
    { label: '6', act: () => inputDigit('6') },
    { label: '−', cls: 'op', act: () => chooseOp('−') },
    { label: '1', act: () => inputDigit('1') },
    { label: '2', act: () => inputDigit('2') },
    { label: '3', act: () => inputDigit('3') },
    { label: '+', cls: 'op', act: () => chooseOp('+') },
    { label: '0', cls: 'zero', act: () => inputDigit('0') },
    { label: '.', act: () => inputDigit('.') },
    { label: '=', cls: 'op', act: equals }
  ];

  for (const key of layout) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `calc-key${key.cls ? ' ' + key.cls : ''}`;
    btn.textContent = key.label;
    btn.addEventListener('click', key.act);
    keys.appendChild(btn);
  }

  render();
  return root;
}

// ---------- Passcode UI ----------

function createPasscodePad() {
  const root = document.createElement('div');
  root.className = 'passlock';

  const title = document.createElement('div');
  title.className = 'passlock-title';
  title.textContent = 'Введите код-пароль';

  const dots = document.createElement('div');
  dots.className = 'passlock-dots';
  const dotEls = [];
  for (let i = 0; i < 4; i++) {
    const d = document.createElement('div');
    d.className = 'passlock-dot';
    dots.appendChild(d);
    dotEls.push(d);
  }

  const pad = document.createElement('div');
  pad.className = 'passlock-pad';

  root.appendChild(title);
  root.appendChild(dots);
  root.appendChild(pad);

  let entry = '';

  const refreshDots = () => {
    dotEls.forEach((d, i) => d.classList.toggle('filled', i < entry.length));
  };

  const reject = () => {
    root.classList.add('shake');
    setTimeout(() => {
      root.classList.remove('shake');
      entry = '';
      refreshDots();
    }, 400);
  };

  const press = async (digit) => {
    if (entry.length >= 4) return;
    entry += digit;
    refreshDots();
    if (entry.length === 4) {
      const code = entry;
      await handleCodeEntry(code, reject);
      if (document.documentElement.hasAttribute('data-locked')) {
        // still locked → was invalid; reject() already handled it, but if not:
        if (!root.classList.contains('shake')) { entry = ''; refreshDots(); }
      }
    }
  };

  const backspace = () => { entry = entry.slice(0, -1); refreshDots(); };

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];
  for (const k of keys) {
    const btn = document.createElement('button');
    btn.type = 'button';
    if (k === '') {
      btn.className = 'passlock-key blank';
      btn.disabled = true;
    } else if (k === '⌫') {
      btn.className = 'passlock-key';
      btn.textContent = '⌫';
      btn.addEventListener('click', backspace);
    } else {
      btn.className = 'passlock-key';
      btn.textContent = k;
      btn.addEventListener('click', () => press(k));
    }
    pad.appendChild(btn);
  }

  refreshDots();
  return root;
}

// ---------- Public entry points ----------

function renderLockScreen() {
  const host = document.getElementById('lockScreen');
  if (!host) return;
  host.innerHTML = '';
  host.hidden = false;
  document.documentElement.setAttribute('data-locked', '1');
  const mode = getLockMode();
  host.appendChild(mode === 'calculator' ? createCalculator() : createPasscodePad());
}

// Resolves once the user has unlocked (or immediately if no lock is set).
export function initAppLock() {
  return new Promise((resolve) => {
    if (!isLockEnabled()) {
      document.documentElement.removeAttribute('data-locked');
      const host = document.getElementById('lockScreen');
      if (host) host.hidden = true;
      resolve();
      return;
    }
    onUnlocked = resolve;
    renderLockScreen();
  });
}
