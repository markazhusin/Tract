// App lock & disguise.
//
// Two independent settings:
//   tract.lock.disguise  — 'on' swaps icon/title to Calculator (handled by <head> boot script)
//   tract.lock.gate      — 'off'|'passcode'|'calculator'  what blocks the screen on launch
//
// Both can be active simultaneously ("calculator disguise + passcode gate").
//
// Two secrets stored as SHA-256 hashes:
//   tract.lock.codeHash  — unlock code
//   tract.lock.wipeHash  — duress code (action is configurable)
//
// Duress action (tract.lock.wipeAction):
//   'wipe-all'    — destroy everything, reload (default)
//   'clear-msgs'  — delete message history only, then unlock
//   'logout'      — log out without deleting data

const DISGUISE_KEY   = 'tract.lock.disguise';
const GATE_KEY       = 'tract.lock.gate';
const CODE_KEY       = 'tract.lock.codeHash';
const WIPE_KEY       = 'tract.lock.wipeHash';
const WIPE_ACTION    = 'tract.lock.wipeAction';

// Legacy compat: old installs stored mode in tract.lock.mode
const LEGACY_KEY     = 'tract.lock.mode';

let onUnlocked = null;

async function sha256Hex(input) {
  const data = new TextEncoder().encode(String(input));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- Public getters ----------

export function getLockConfig() {
  // Migrate legacy
  const legacy = localStorage.getItem(LEGACY_KEY);
  if (legacy && legacy !== 'off' && !localStorage.getItem(GATE_KEY)) {
    if (legacy === 'calculator') {
      localStorage.setItem(DISGUISE_KEY, 'on');
      localStorage.setItem(GATE_KEY, 'calculator');
    } else if (legacy === 'passcode') {
      localStorage.setItem(GATE_KEY, 'passcode');
    }
    localStorage.removeItem(LEGACY_KEY);
  }

  return {
    disguise:    localStorage.getItem(DISGUISE_KEY) === 'on',
    gate:        localStorage.getItem(GATE_KEY) || 'off',      // 'off'|'passcode'|'calculator'
    hasCode:     Boolean(localStorage.getItem(CODE_KEY)),
    hasWipe:     Boolean(localStorage.getItem(WIPE_KEY)),
    wipeAction:  localStorage.getItem(WIPE_ACTION) || 'wipe-all',
  };
}

// getLockMode kept for compat with index.html boot script
export function getLockMode() {
  const { disguise, gate } = getLockConfig();
  if (gate === 'calculator' || disguise) return 'calculator';
  if (gate === 'passcode') return 'passcode';
  return 'off';
}

export function isLockEnabled() {
  const { gate } = getLockConfig();
  return gate !== 'off';
}

// ---------- Configure ----------

export async function configureLock({ disguise, gate, code, wipeCode, wipeAction, oldCode } = {}) {
  const cfg = getLockConfig();

  // Verify old code if changing an existing one
  if (cfg.hasCode && oldCode !== undefined) {
    const oldHash = await sha256Hex(oldCode);
    if (oldHash !== localStorage.getItem(CODE_KEY)) {
      throw new Error('wrong-old-code');
    }
  }

  if (gate === 'off' && !disguise) {
    // Full disable
    localStorage.removeItem(DISGUISE_KEY);
    localStorage.removeItem(GATE_KEY);
    localStorage.removeItem(CODE_KEY);
    localStorage.removeItem(WIPE_KEY);
    localStorage.removeItem(WIPE_ACTION);
    localStorage.removeItem(LEGACY_KEY);
    return;
  }

  if (disguise !== undefined) {
    if (disguise) localStorage.setItem(DISGUISE_KEY, 'on');
    else localStorage.removeItem(DISGUISE_KEY);
  }

  if (gate !== undefined) {
    if (gate && gate !== 'off') localStorage.setItem(GATE_KEY, gate);
    else localStorage.removeItem(GATE_KEY);
  }

  if (code !== undefined && code !== null && String(code).length >= 1) {
    if (wipeCode && String(wipeCode) === String(code)) throw new Error('codes-equal');
    localStorage.setItem(CODE_KEY, await sha256Hex(code));
  }

  if (wipeCode !== undefined) {
    if (wipeCode && String(wipeCode).length >= 1) {
      localStorage.setItem(WIPE_KEY, await sha256Hex(wipeCode));
    } else {
      localStorage.removeItem(WIPE_KEY);
    }
  }

  if (wipeAction) localStorage.setItem(WIPE_ACTION, wipeAction);
}

export async function disableLock() {
  await configureLock({ disguise: false, gate: 'off' });
}

// ---------- Code checking ----------

async function classifyCode(code) {
  const hash = await sha256Hex(code);
  const wipeHash = localStorage.getItem(WIPE_KEY);
  const codeHash = localStorage.getItem(CODE_KEY);
  if (wipeHash && hash === wipeHash) return 'wipe';
  if (codeHash && hash === codeHash) return 'unlock';
  return 'invalid';
}

// ---------- Actions ----------

export async function wipeEverything() {
  try { localStorage.clear(); } catch {}
  try { sessionStorage.clear(); } catch {}
  try {
    if (typeof indexedDB.databases === 'function') {
      const dbs = await indexedDB.databases();
      await Promise.all(dbs.filter((d) => d?.name).map((d) => new Promise((res) => {
        const req = indexedDB.deleteDatabase(d.name);
        req.onsuccess = req.onerror = req.onblocked = () => res();
      })));
    } else {
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
  const action = localStorage.getItem(WIPE_ACTION) || 'wipe-all';

  if (action === 'clear-msgs') {
    // Only clear message history, keep identity
    try {
      if (typeof indexedDB.databases === 'function') {
        const dbs = await indexedDB.databases();
        await Promise.all(dbs.filter((d) => d?.name).map((d) => new Promise((res) => {
          const req = indexedDB.deleteDatabase(d.name);
          req.onsuccess = req.onerror = req.onblocked = () => res();
        })));
      } else {
        indexedDB.deleteDatabase('TractDB');
      }
    } catch {}
    doUnlock();
    return;
  }

  if (action === 'logout') {
    // Clear session keys but keep identity blob
    try { sessionStorage.clear(); } catch {}
    ['tract.session.unlockPassword', 'tract.session.rememberedPassword'].forEach((k) => {
      try { localStorage.removeItem(k); } catch {}
    });
    doUnlock();
    return;
  }

  // Default: wipe-all
  await wipeEverything();
  location.reload();
}

async function handleCodeEntry(code, onInvalid) {
  const kind = await classifyCode(code);
  if (kind === 'unlock') return doUnlock();
  if (kind === 'wipe')   return doWipe();
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
  let acc = null;
  let op = null;
  let fresh = true;
  let comboCandidate = '';
  let equalsArmed = false;

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
    if (nextOp === '+' && equalsArmed) {
      handleCodeEntry(comboCandidate, null);
      return;
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
    { label: 'AC',  cls: 'fn', act: clearAll },
    { label: '+/−', cls: 'fn', act: toggleSign },
    { label: '%',   cls: 'fn', act: percent },
    { label: '÷',   cls: 'op', act: () => chooseOp('÷') },
    { label: '7',   act: () => inputDigit('7') },
    { label: '8',   act: () => inputDigit('8') },
    { label: '9',   act: () => inputDigit('9') },
    { label: '×',   cls: 'op', act: () => chooseOp('×') },
    { label: '4',   act: () => inputDigit('4') },
    { label: '5',   act: () => inputDigit('5') },
    { label: '6',   act: () => inputDigit('6') },
    { label: '−',   cls: 'op', act: () => chooseOp('−') },
    { label: '1',   act: () => inputDigit('1') },
    { label: '2',   act: () => inputDigit('2') },
    { label: '3',   act: () => inputDigit('3') },
    { label: '+',   cls: 'op', act: () => chooseOp('+') },
    { label: '0',   cls: 'zero', act: () => inputDigit('0') },
    { label: '.',   act: () => inputDigit('.') },
    { label: '=',   cls: 'op', act: equals },
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

  const refreshDots = () => dotEls.forEach((d, i) => d.classList.toggle('filled', i < entry.length));

  const reject = () => {
    root.classList.add('shake');
    setTimeout(() => { root.classList.remove('shake'); entry = ''; refreshDots(); }, 400);
  };

  const press = async (digit) => {
    if (entry.length >= 4) return;
    entry += digit;
    refreshDots();
    if (entry.length === 4) {
      await handleCodeEntry(entry, reject);
      if (document.documentElement.hasAttribute('data-locked') && !root.classList.contains('shake')) {
        entry = ''; refreshDots();
      }
    }
  };

  const backspace = () => { entry = entry.slice(0, -1); refreshDots(); };

  for (const k of ['1','2','3','4','5','6','7','8','9','','0','⌫']) {
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

// ---------- Public entry point ----------

function renderLockScreen() {
  const host = document.getElementById('lockScreen');
  if (!host) return;
  host.innerHTML = '';
  host.hidden = false;
  document.documentElement.setAttribute('data-locked', '1');
  const { gate } = getLockConfig();
  host.appendChild(gate === 'calculator' ? createCalculator() : createPasscodePad());
}

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
