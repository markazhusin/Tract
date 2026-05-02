import * as secp from '@noble/secp256k1';

const IDENTITY_KEY = 'tract.identity.v1';
const LEGACY_IDENTITY_KEY = 'tract.identity.privateKey';
const SESSION_PEER_KEY = 'tract.session.peerId';
const PBKDF2_ITERATIONS = 250000;

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const pairs = hex.match(/.{1,2}/g) || [];
  return Uint8Array.from(pairs.map((pair) => Number.parseInt(pair, 16)));
}

function encodeText(value) {
  return new TextEncoder().encode(value);
}

function decodeText(value) {
  return new TextDecoder().decode(value);
}

function bytesToBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

function base64ToBytes(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function deriveAesKey(password, salt) {
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    encodeText(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function generateKeyPair() {
  const privateKey = secp.utils.randomSecretKey();
  const publicKey = secp.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

export function getPublicKeyHex(kp) {
  return bytesToHex(secp.getPublicKey(kp.privateKey));
}

export function getUserIdFromKeyPair(kp) {
  return getPublicKeyHex(kp).slice(0, 12);
}

export function getStoredIdentityMetadata() {
  const stored = localStorage.getItem(IDENTITY_KEY);
  return stored ? JSON.parse(stored) : null;
}

export function getLegacyIdentityMetadata() {
  const legacyPrivateKeyHex = localStorage.getItem(LEGACY_IDENTITY_KEY);
  if (!legacyPrivateKeyHex) {
    return null;
  }

  try {
    const privateKey = hexToBytes(legacyPrivateKeyHex);
    const publicKey = secp.getPublicKey(privateKey);
    const keyPair = { privateKey, publicKey };
    return {
      keyPair,
      profile: {
        userId: getUserIdFromKeyPair(keyPair),
        displayName: 'Legacy user'
      }
    };
  } catch (error) {
    console.warn('Failed to parse legacy identity:', error);
    return null;
  }
}

export async function registerIdentity(password, displayName, options = {}) {
  const legacyIdentity = options.reuseLegacy !== false ? getLegacyIdentityMetadata() : null;
  const keyPair = legacyIdentity?.keyPair || await generateKeyPair();
  const userId = getUserIdFromKeyPair(keyPair);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await deriveAesKey(password, salt);
  const privateKeyHex = bytesToHex(keyPair.privateKey);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    encodeText(privateKeyHex)
  );

  const payload = {
    version: 1,
    userId,
    publicKeyHex: getPublicKeyHex(keyPair),
    displayName,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(encrypted))
  };

  localStorage.setItem(IDENTITY_KEY, JSON.stringify(payload));
  localStorage.removeItem(LEGACY_IDENTITY_KEY);
  return { keyPair, profile: { userId, displayName } };
}

export async function unlockIdentity(password) {
  const stored = getStoredIdentityMetadata();
  if (!stored) {
    throw new Error('Identity not found');
  }

  const salt = base64ToBytes(stored.salt);
  const iv = base64ToBytes(stored.iv);
  const ciphertext = base64ToBytes(stored.ciphertext);
  const aesKey = await deriveAesKey(password, salt);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    ciphertext
  );

  const privateKey = hexToBytes(decodeText(new Uint8Array(decrypted)));
  const publicKey = secp.getPublicKey(privateKey);
  return {
    keyPair: { privateKey, publicKey },
    profile: {
      userId: stored.userId,
      displayName: stored.displayName
    }
  };
}

export function updateStoredDisplayName(displayName) {
  const stored = getStoredIdentityMetadata();
  if (!stored) return;
  stored.displayName = displayName;
  localStorage.setItem(IDENTITY_KEY, JSON.stringify(stored));
}

export function clearSessionPeerId() {
  sessionStorage.removeItem(SESSION_PEER_KEY);
}

export function getOrCreateSessionPeerId(baseId) {
  const saved = sessionStorage.getItem(SESSION_PEER_KEY);
  if (saved) {
    return saved;
  }

  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 4);
  const peerId = `${baseId}-${suffix}`;
  sessionStorage.setItem(SESSION_PEER_KEY, peerId);
  return peerId;
}
