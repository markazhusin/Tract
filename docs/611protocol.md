# 611protocol — specification

**Version 1.0 · 2026 · Mark Azhusin (611marco)**

611protocol is the layered encryption stack used by [Tract](../README.md). It places
a **quantum-key-distribution (BB84) tamper-evidence ceremony on top of a conventional
end-to-end pipeline**, so a live session has two independent guarantees instead of
one: classical confidentiality, plus active detection that the channel is being
interfered with.

This document specifies the protocol precisely enough to reimplement it. The
reference implementations are bit-for-bit equivalent across three languages:

| Language | File | Role |
|---|---|---|
| Go | [`internal/quantum/bb84.go`](../internal/quantum/bb84.go), `quantum.go`, `qrng.go` | reference + node |
| Swift | [`ios/Tract/QuantumBB84.swift`](../ios/Tract/QuantumBB84.swift), `BB84Session.swift` | iOS client |
| JS | `app/core/bb84.js` | web client |

> **Honest scope.** Software cannot put a real photon on a wire, so this is **not**
> the information-theoretic secrecy of physical QKD. It is a *faithful BB84 ceremony*
> on an emulated quantum channel, layered on an already-authenticated/E2E transport.
> An active man-in-the-middle who perturbs the exchange (intercept-resend) is
> **detected** by the QBER check and the session is torn down. The qubit collapse on
> measurement is genuine emulator behaviour, not a mock; the *choice* of bit and
> basis is a classical CSPRNG draw, exactly as a real QKD device decides locally.

---

## 1. Layers

```
611protocol  =  L1 classical E2E   +   L2 quantum tamper-evidence (per session)

  L1  Curve25519 (X25519 ECDH)  →  HKDF-SHA256  →  AES-256-GCM
      Content is sealed on the device before it leaves. Nodes / the DHT / any
      relay only ever see ciphertext.

  L2  BB84 ceremony per call, over the (already-E2E) signaling channel:
      prepare → transmit → measure → sift → QBER sample → abort-or-derive
      QBER over threshold  ⇒  key discarded  ⇒  call collapses on both ends.
```

**L1** guarantees confidentiality end-to-end. **L2** adds *tamper-evidence*: it does
not replace L1, it detects an active attacker on the live channel and refuses to
continue. The BB84-derived 32-byte key is held by both parties as a shared secret and
a `qkdVerified` signal; media transport itself remains E2E independently (WebRTC
DTLS-SRTP over the internet, or the encrypted mesh nearby).

---

## 2. Quantum primitives (L2)

### 2.1 Qubit state

A single qubit `a|0⟩ + b|1⟩` with complex amplitudes, stored as four `float64`:
`(a0r, a0i, a1r, a1i)`. BB84 needs only one qubit at a time, so no full 2ⁿ state
vector is used.

- **X (bit flip):** swap the `|0⟩` and `|1⟩` amplitudes.
- **H (Hadamard):** `|0⟩→|+⟩`, `|1⟩→|−⟩`, with `s = 1/√2`:
  `a0' = (a0+a1)·s`, `a1' = (a0−a1)·s` (applied to real and imaginary parts).
- **Measure (Z basis):** `p₁ = a1r² + a1i²`; draw `u ∈ [0,1)` from the CSPRNG; if
  `u < p₁` collapse to `|1⟩` and return 1, else collapse to `|0⟩` and return 0.

### 2.2 Bases

| Basis | Value | States |
|---|---|---|
| Rectilinear (Z) | `0` | `|0⟩`, `|1⟩` |
| Diagonal (X) | `1` | `|+⟩`, `|−⟩` |

- **prepare(bit, basis):** start `|0⟩`; if `bit==1` apply X; if `basis==diagonal`
  apply H.
- **measure(qubit, basis):** if `basis==diagonal` apply H, then measure in Z.

### 2.3 Randomness

`bit` values and basis *choices* are classical decisions drawn from the platform
CSPRNG (`crypto/rand` / `SecRandomCopyBytes` / WebCrypto) as a uniform 53-bit float
in `[0,1)`, `< 0.5 → 0`. Only the qubit that "travels" carries quantum behaviour.

---

## 3. Ceremony

Roles: the **caller is Alice** (prepares qubits), the **callee is Bob** (measures).
**N = 96** qubits per ceremony (sifting keeps ~half, sampling spends ~half of those,
leaving ~N/4 key bits — small wire payload, ample after amplification).

### 3.1 Steps

1. **Alice prepares.** For each `i∈[0,N)`: draw `aBits[i]`, `aBases[i]`; build qubit
   `prepare(aBits[i], aBases[i])`.
2. **Transmit.** Qubits are sent as amplitude quadruples (see §4, phase `q`). On a
   real channel an interceptor measuring here disturbs the state.
3. **Bob measures.** For each qubit: draw `bBases[i]`; `bBits[i] =
   measure(qubit, bBases[i])`. Bob sends his bases (phase `b`).
4. **Alice reveals bases + sample.** Alice sends `aBases` and her QBER sample (phase
   `s`).
5. **Sift.** Both sides keep positions where `aBases[i] == bBases[i]`, preserving
   order. (On an honest channel, sifted `aBits == bBits` at every kept position.)
6. **QBER sample.** Of the sifted bits, **even indices** are sacrificed for a public
   comparison; Bob computes `QBER = mismatches / sampled`.
7. **Decision.**
   - If `QBER > 0.15` **or** no key bits remain → Bob aborts (phase `x`); the call
     collapses on both ends.
   - Else Bob confirms (phase `ok`).
8. **Key.** Both sides take the **odd-indexed** sifted survivors as `keyBits` and
   derive the key (§3.2). On an honest channel these are identical on both ends.

### 3.2 Key derivation

`DeriveKey(bits)` (a stand-in for full privacy amplification):

1. Pack bits **LSB-first** into bytes: bit `i` sets bit `(i mod 8)` of byte
   `⌊i/8⌋`.
2. `key = SHA-256(packed)` → **32 bytes**.

Identical in all three ports (`DeriveKey` / `deriveKey`).

---

## 4. Wire protocol

The ceremony rides the active signaling transport (node poll, GetStream reserve, or
mesh control) as messages of type `"qkd"`, each a small JSON object keyed by `p`
(phase):

| Phase | Direction | Payload | Meaning |
|---|---|---|---|
| `q` | Alice → Bob | `{n, q:[[a0r,a0i,a1r,a1i],…]}` | prepared qubits |
| `b` | Bob → Alice | `{bb:[0/1,…]}` | Bob's measurement bases |
| `s` | Alice → Bob | `{ab:[0/1,…], sb:[bit,…]}` | Alice's bases + QBER sample |
| `ok` | Bob → Alice | `{}` | QBER acceptable, key agreed |
| `x` | Bob → Alice | `{}` | QBER over threshold — collapse |

The `qkd` messages themselves travel inside the already-E2E signaling channel.

---

## 5. Security properties & verification

### 5.1 Intercept-resend detection

An eavesdropper who measures each qubit in a guessed basis and resends guesses the
wrong basis half the time; a wrong-basis measurement randomises the bit, so among
sifted positions it injects errors at ~25%. The **0.15 threshold cleanly separates**
an honest channel (~0%) from an attacked one (~25%).

### 5.2 Measured behaviour (reference, N=96, 2000 runs each)

| Channel | Key agreement | Abort rate | Mean QBER |
|---|---|---|---|
| **Honest** | 100% | 0% | **0.000** |
| **Intercept-resend (Eve)** | — | **100%** | **0.250** |

Reproduce: the Go reference exposes `Simulate(n, eve)` and `Eve()`
(`internal/quantum/bb84.go`); the package tests (`go test ./internal/quantum/`)
cover honest agreement, eavesdropper detection, deterministic key derivation, and the
underlying state-vector emulator (Bell entanglement, superposition probabilities,
gate correctness, norm preservation).

### 5.3 What L2 does and does not give

- **Gives:** active-tampering evidence on the live channel; a fresh shared 32-byte
  secret per session; deterministic, cross-implementation agreement.
- **Does not give:** information-theoretic secrecy (no physical photons). Passive
  confidentiality is provided by **L1** (X25519/AES-256-GCM) and by the media
  transport's own encryption (DTLS-SRTP / mesh), not by L2.

### 5.4 Threat model (summary)

| Adversary | Outcome |
|---|---|
| Passive network observer (node, relay, DHT, ISP) | sees only ciphertext (L1) |
| Active MITM on the live signaling channel | perturbs qubits → QBER > 0.15 → **call collapses** (L2) |
| Compromised/malicious node | cannot read content; can drop/delay, not forge (E2E + signatures) |
| Offline brute force | X25519 + AES-256-GCM |

---

## 6. Prior art

To the author's knowledge, **no shipping messenger combines a BB84 QKD ceremony with
a fully serverless (mesh + DHT) end-to-end P2P transport.** The components exist
separately — mesh messengers (Briar, Meshtastic), E2E messengers (Signal), QKD in
telecom lab hardware — but not the combination as a consumer, serverless app. This is
an honest "to our knowledge", not an absolute; corrections are welcome.

---

*611protocol and Tract were created by Mark Azhusin (611marco). Licensed AGPL-3.0;
intended to later be released freely. Telegram @marco_611 · channel @tractmesh.*
*With love, from Infinity, Milky Way, Earth.* ❤️
