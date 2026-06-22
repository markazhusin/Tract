// BB84 quantum key distribution for the Tract web client — the same ceremony as
// the Go reference (internal/quantum/bb84.go) and the iOS port (QuantumBB84.swift),
// wire-compatible so a web↔native call agrees bit-for-bit. BB84 lets the two call
// participants agree on a shared key AND detect tampering: measuring an unknown
// qubit in the wrong basis disturbs it (no-cloning), surfacing as an elevated error
// rate (QBER) on a publicly compared sample. If QBER crosses the abort threshold we
// assume interception and THROW THE KEY AWAY — the call collapses rather than
// continuing compromised.
//
// Honest scope: software can't put a real photon on the wire, so this isn't the
// information-theoretic secrecy of physical QKD. It's a faithful BB84 *ceremony*
// over the already-authenticated/E2E signaling channel — an active man-in-the-
// middle who perturbs the exchange (intercept-resend) is caught by the QBER check.

// Sampled error rate above which we assume compromise. Honest channels sit near 0;
// intercept-resend drives QBER toward 25%, so 15% cleanly separates the two. Must
// match QBERAbortThreshold in bb84.go / kQBERAbortThreshold in QuantumBB84.swift.
export const QBER_ABORT_THRESHOLD = 0.15;

const RECTILINEAR = 0; // Z basis
const DIAGONAL = 1;    // X basis

// Classical decisions (which bit, which basis) come from the CSPRNG, exactly as a
// real QKD device chooses them locally; only the qubit carries quantum behaviour.
function randFloat() {
  const buf = new Uint32Array(2);
  crypto.getRandomValues(buf);
  // 53-bit uniform in [0,1).
  return (buf[0] * 0x100000000 + buf[1]) / 0x20000000000000;
}
function randBit() { return randFloat() < 0.5 ? 0 : 1; }
function randBasis() { return randBit() === 1 ? DIAGONAL : RECTILINEAR; }

// --- Single-qubit state-vector emulator (all BB84 needs) ----------------------
// State a|0> + b|1> as complex amplitudes [a0r,a0i,a1r,a1i].
function zero() { return [1, 0, 0, 0]; }
function applyX(s) { return [s[2], s[3], s[0], s[1]]; }
function applyH(s) {
  const r = Math.SQRT1_2;
  return [(s[0] + s[2]) * r, (s[1] + s[3]) * r, (s[0] - s[2]) * r, (s[1] - s[3]) * r];
}
// Measure in computational (Z) basis, collapsing. Entropy from the CSPRNG — an
// honest emulation, like the Go qrng.
function measureZ(s) {
  const p1 = s[2] * s[2] + s[3] * s[3];
  return randFloat() < p1 ? 1 : 0;
}

function prepareQubit(bit, basis) {
  let s = zero();
  if (bit === 1) s = applyX(s);
  if (basis === DIAGONAL) s = applyH(s);
  return s;
}
function measureQubit(s, basis) {
  if (basis === DIAGONAL) s = applyH(s);
  return measureZ(s);
}

// Derive a 32-byte key from sifted bits (SHA-256 over the packed bits). Bit-packing
// matches DeriveKey in Go and deriveKey in Swift.
async function deriveKey(bits) {
  const packed = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => { if (b === 1) packed[i >> 3] |= 1 << (i & 7); });
  const digest = await crypto.subtle.digest('SHA-256', packed);
  return new Uint8Array(digest);
}

/**
 * Drives a BB84 ceremony between two peers over the existing signaling channel.
 * The connection initiator plays Alice (prepares qubits); the other peer plays Bob
 * (measures them). Messages travel as signaling type "qkd" with a JSON payload
 * keyed by `p` (phase):
 *   p="q"  Alice→Bob : prepared qubits           {n, q:[[a0r,a0i,a1r,a1i],…]}
 *   p="b"  Bob→Alice : Bob's measurement bases    {bb:[0/1,…]}
 *   p="s"  Alice→Bob : Alice's bases + QBER sample {ab:[0/1,…], sb:[bit,…]}
 *   p="ok" Bob→Alice : QBER acceptable, key agreed {}
 *   p="x"  Bob→Alice : QBER over threshold         {}
 * Mirrors reconcile() in bb84.go and BB84Session in the iOS app.
 */
export class BB84Session {
  static QUBIT_COUNT = 96;

  /**
   * @param {'alice'|'bob'} role
   * @param {(msg: object) => void} send  routes one ceremony message as type "qkd"
   * @param {(key: Uint8Array) => void} onSuccess
   * @param {(reason: string) => void} onAbort
   */
  constructor(role, send, onSuccess, onAbort) {
    this.role = role;
    this.send = send;
    this.onSuccess = onSuccess;
    this.onAbort = onAbort;
    this.finished = false;
    this.aBits = []; this.aBases = [];
    this.bBits = []; this.bBases = [];
  }

  start() {
    if (this.role !== 'alice') return;
    const n = BB84Session.QUBIT_COUNT;
    this.aBits = Array.from({ length: n }, () => randBit());
    this.aBases = Array.from({ length: n }, () => randBasis());
    const q = this.aBits.map((bit, i) => prepareQubit(bit, this.aBases[i]));
    this.send({ p: 'q', n, q });
  }

  async handle(payload) {
    if (this.finished || !payload || typeof payload.p !== 'string') return;
    const p = payload.p;
    if (this.role === 'bob' && p === 'q') return this._bobReceiveQubits(payload);
    if (this.role === 'alice' && p === 'b') return this._aliceReceiveBases(payload);
    if (this.role === 'bob' && p === 's') return this._bobReconcile(payload);
    if (this.role === 'alice' && p === 'ok') return this._aliceFinish(true);
    if (this.role === 'alice' && p === 'x') return this._aliceFinish(false);
  }

  // --- Bob ---
  _bobReceiveQubits(payload) {
    const raw = Array.isArray(payload.q) ? payload.q : [];
    this.bBits = []; this.bBases = [];
    for (const amp of raw) {
      if (!Array.isArray(amp) || amp.length !== 4) continue;
      const basis = randBasis();
      this.bBases.push(basis);
      this.bBits.push(measureQubit(amp.slice(), basis));
    }
    this.send({ p: 'b', bb: this.bBases });
  }

  async _bobReconcile(payload) {
    const ab = payload.ab, sampleA = payload.sb;
    if (!Array.isArray(ab) || !Array.isArray(sampleA) || ab.length !== this.bBases.length) {
      this.finished = true; this.onAbort('BB84 protocol error'); return;
    }
    const sifted = [];
    for (let i = 0; i < ab.length; i++) if (ab[i] === this.bBases[i]) sifted.push(this.bBits[i]);
    if (sifted.length === 0) return this._abortBob('BB84: no sifted bits');

    const sampleB = [], keyBits = [];
    sifted.forEach((bit, i) => (i % 2 === 0 ? sampleB : keyBits).push(bit));
    const m = Math.min(sampleA.length, sampleB.length);
    let mism = 0;
    for (let i = 0; i < m; i++) if (sampleA[i] !== sampleB[i]) mism++;
    const qber = m > 0 ? mism / m : 0;

    if (qber > QBER_ABORT_THRESHOLD || keyBits.length === 0) {
      return this._abortBob(`Канал скомпрометирован (QBER ${Math.round(qber * 100)}%)`);
    }
    this.finished = true;
    this.send({ p: 'ok' });
    this.onSuccess(await deriveKey(keyBits));
  }

  _abortBob(reason) {
    this.finished = true;
    this.send({ p: 'x' });
    this.onAbort(reason);
  }

  // --- Alice ---
  _aliceReceiveBases(payload) {
    const bb = payload.bb;
    if (!Array.isArray(bb) || bb.length !== this.aBases.length) return;
    this.bBases = bb;
    const sifted = [];
    for (let i = 0; i < this.aBases.length; i++) if (this.aBases[i] === bb[i]) sifted.push(this.aBits[i]);
    const sample = sifted.filter((_, i) => i % 2 === 0);
    this.send({ p: 's', ab: this.aBases, sb: sample });
  }

  async _aliceFinish(success) {
    this.finished = true;
    if (!success) { this.onAbort('Канал скомпрометирован (BB84)'); return; }
    const sifted = [];
    for (let i = 0; i < this.aBases.length; i++) if (this.aBases[i] === this.bBases[i]) sifted.push(this.aBits[i]);
    const keyBits = sifted.filter((_, i) => i % 2 === 1);
    this.onSuccess(await deriveKey(keyBits));
  }
}
