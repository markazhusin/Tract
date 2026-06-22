import Foundation
import Security

/// BB84 quantum key distribution for Tract, ported from the Go reference in
/// `internal/quantum/bb84.go` so the iOS client and the node agree bit-for-bit on
/// the ceremony. BB84 lets the two call participants agree on a shared key AND
/// detect tampering: measuring an unknown qubit in the wrong basis disturbs it
/// (no-cloning), which shows up as an elevated error rate (QBER) on a publicly
/// compared sample. If QBER crosses the abort threshold we assume interception and
/// THROW THE KEY AWAY — in Tract that means the call collapses rather than
/// continuing compromised.
///
/// Honest scope (same as the Go side): software cannot put a real photon on the
/// wire, so the information-theoretic secrecy of physical QKD isn't claimed here.
/// This is a faithful BB84 *ceremony* layered on the already-authenticated/E2E
/// signaling channel — an active man-in-the-middle who perturbs the exchange
/// (intercept-resend) is detected by the QBER check and the session is torn down.

// MARK: - Single-qubit emulator

/// A single qubit state a|0> + b|1> with complex amplitudes. BB84 only ever needs
/// one qubit at a time (prepare, optionally intercept-resend, measure), so a full
/// 2^n state vector would be wasted; this mirrors the Go emulator's behaviour for
/// the 1-qubit subset (X, H, computational measurement).
struct Qubit: Codable {
    // Real/imaginary parts of the two amplitudes.
    var a0r: Double, a0i: Double
    var a1r: Double, a1i: Double

    /// |0>
    static var zero: Qubit { Qubit(a0r: 1, a0i: 0, a1r: 0, a1i: 0) }

    /// Pauli-X (bit flip): swap amplitudes.
    mutating func x() {
        swap(&a0r, &a1r)
        swap(&a0i, &a1i)
    }

    /// Hadamard: |0>->|+>, |1>->|->. Maps between Z and X bases.
    mutating func h() {
        let s = 1.0 / 2.0.squareRoot()
        let n0r = (a0r + a1r) * s, n0i = (a0i + a1i) * s
        let n1r = (a0r - a1r) * s, n1i = (a0i - a1i) * s
        a0r = n0r; a0i = n0i; a1r = n1r; a1i = n1i
    }

    /// Measure in the computational (Z) basis, collapsing the state. Entropy for
    /// the collapse is drawn from the system CSPRNG — an honest emulation, like the
    /// Go `qrng`.
    mutating func measureZ() -> Int {
        let p1 = a1r * a1r + a1i * a1i
        if QuantumRNG.float() < p1 {
            a0r = 0; a0i = 0; a1r = 1; a1i = 0
            return 1
        }
        a0r = 1; a0i = 0; a1r = 0; a1i = 0
        return 0
    }
}

/// CSPRNG helpers — classical decisions (which bit, which basis) use these, exactly
/// as a real QKD device uses a local RNG for its choices. Only the qubit itself
/// carries quantum behaviour.
enum QuantumRNG {
    static func float() -> Double {
        var u: UInt64 = 0
        withUnsafeMutableBytes(of: &u) { _ = SecRandomCopyBytes(kSecRandomDefault, 8, $0.baseAddress!) }
        return Double(u >> 11) * (1.0 / 9007199254740992.0) // 53-bit mantissa in [0,1)
    }
    static func bit() -> Int { float() < 0.5 ? 0 : 1 }
}

// MARK: - BB84 primitives

enum Basis: Int, Codable { case rectilinear = 0, diagonal = 1 } // Z / X

/// Sampled error rate above which we assume the channel is compromised and abort.
/// Honest channels sit near 0; intercept-resend drives QBER toward 25%, so 15%
/// cleanly separates the two. Must match `QBERAbortThreshold` in bb84.go.
let kQBERAbortThreshold = 0.15

/// Encode `bit` in `basis` as a single qubit.
func prepareQubit(bit: Int, basis: Basis) -> Qubit {
    var q = Qubit.zero
    if bit == 1 { q.x() }
    if basis == .diagonal { q.h() }
    return q
}

/// Measure `q` in `basis`, returning the bit (measuring in X = H then Z).
func measureQubit(_ q: inout Qubit, basis: Basis) -> Int {
    if basis == .diagonal { q.h() }
    return q.measureZ()
}

func randBasis() -> Basis { QuantumRNG.bit() == 1 ? .diagonal : .rectilinear }

/// Derive a 32-byte key from sifted bits (SHA-256 over the packed bits — the
/// stand-in for privacy amplification). Bit-compatible with `DeriveKey` in Go.
func deriveKey(_ bits: [Int]) -> Data {
    var packed = [UInt8](repeating: 0, count: (bits.count + 7) / 8)
    for (i, b) in bits.enumerated() where b == 1 { packed[i / 8] |= 1 << UInt8(i % 8) }
    return Data(BB84SHA256.hash(Data(packed)))
}

// MARK: - Minimal SHA-256 (no CryptoKit dependency assumed)

/// Small SHA-256 so the BB84 key derivation matches the Go side without pulling in
/// CryptoKit (keeps this file usable on any deployment target). Named distinctly so
/// it doesn't shadow CryptoKit's `SHA256`, which Identity.swift uses for HKDF.
enum BB84SHA256 {
    static func hash(_ message: Data) -> [UInt8] {
        var h: [UInt32] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                           0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
        let k: [UInt32] = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]

        var msg = [UInt8](message)
        let bitLen = UInt64(msg.count) * 8
        msg.append(0x80)
        while msg.count % 64 != 56 { msg.append(0) }
        for i in (0..<8).reversed() { msg.append(UInt8((bitLen >> (UInt64(i) * 8)) & 0xff)) }

        func rotr(_ x: UInt32, _ n: UInt32) -> UInt32 { (x >> n) | (x << (32 - n)) }

        var chunk = 0
        while chunk < msg.count {
            var w = [UInt32](repeating: 0, count: 64)
            for i in 0..<16 {
                let o = chunk + i * 4
                w[i] = (UInt32(msg[o]) << 24) | (UInt32(msg[o+1]) << 16) | (UInt32(msg[o+2]) << 8) | UInt32(msg[o+3])
            }
            for i in 16..<64 {
                let s0 = rotr(w[i-15], 7) ^ rotr(w[i-15], 18) ^ (w[i-15] >> 3)
                let s1 = rotr(w[i-2], 17) ^ rotr(w[i-2], 19) ^ (w[i-2] >> 10)
                w[i] = w[i-16] &+ s0 &+ w[i-7] &+ s1
            }
            var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7]
            for i in 0..<64 {
                let S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
                let ch = (e & f) ^ (~e & g)
                let t1 = hh &+ S1 &+ ch &+ k[i] &+ w[i]
                let S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
                let maj = (a & b) ^ (a & c) ^ (b & c)
                let t2 = S0 &+ maj
                hh = g; g = f; f = e; e = d &+ t1; d = c; c = b; b = a; a = t1 &+ t2
            }
            h[0] = h[0] &+ a; h[1] = h[1] &+ b; h[2] = h[2] &+ c; h[3] = h[3] &+ d
            h[4] = h[4] &+ e; h[5] = h[5] &+ f; h[6] = h[6] &+ g; h[7] = h[7] &+ hh
            chunk += 64
        }

        var out = [UInt8]()
        for v in h { for i in (0..<4).reversed() { out.append(UInt8((v >> (UInt32(i) * 8)) & 0xff)) } }
        return out
    }
}
