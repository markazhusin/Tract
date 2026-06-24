import Foundation

/// Drives a BB84 key-agreement ceremony between the two call participants over the
/// existing signaling channel (node poll, GetStream reserve, or mesh — whichever
/// the call is using). The caller plays Alice (prepares qubits); the callee plays
/// Bob (measures them). Messages travel as signaling type `"qkd"` carrying a small
/// JSON payload keyed by `p` (phase):
///
///   p="q"  Alice→Bob : the prepared qubits           {n, q:[[a0r,a0i,a1r,a1i],…]}
///   p="b"  Bob→Alice : Bob's measurement bases        {bb:[0/1,…]}
///   p="s"  Alice→Bob : Alice's bases + QBER sample     {ab:[0/1,…], sb:[bit,…]}
///   p="ok" Bob→Alice : QBER acceptable, key agreed     {}
///   p="x"  Bob→Alice : QBER over threshold — collapse  {}
///
/// Both sides sift identically (keep positions where the bases matched), sacrifice
/// the even-indexed sifted bits to estimate QBER, and derive the key from the
/// odd-indexed survivors. If Bob's QBER exceeds the threshold he aborts and tells
/// Alice, so the call collapses on both ends. Mirrors `reconcile` in bb84.go.
final class BB84Session {
    /// Number of qubits exchanged. Sifting keeps ~half, sampling spends ~half of
    /// those, leaving ~n/4 key bits — plenty after SHA-256 amplification, while
    /// keeping the signaling payload small.
    static let qubitCount = 96

    enum Role { case alice, bob }
    let role: Role

    /// Sends one ceremony message. The call layer routes it over the active
    /// transport (internet signaling or mesh control) as type `"qkd"`.
    var send: (([String: Any]) -> Void)?
    /// Called once with the agreed 32-byte key when the ceremony succeeds.
    var onSuccess: ((Data) -> Void)?
    /// Called if QBER breaches the threshold (or the ceremony fails) — the caller
    /// tears the call down. The String is a short human reason.
    var onAbort: ((String) -> Void)?

    private var finished = false

    // Alice's state.
    private var aBits: [Int] = []
    private var aBases: [Basis] = []
    // Bob's state.
    private var bBits: [Int] = []
    private var bBases: [Basis] = []

    init(role: Role) { self.role = role }

    /// Alice kicks off the ceremony by preparing and "sending" the qubits.
    func start() {
        guard role == .alice else { return }
        let n = Self.qubitCount
        aBits = (0..<n).map { _ in QuantumRNG.bit() }
        aBases = (0..<n).map { _ in randBasis() }
        let q: [[Double]] = (0..<n).map { i in
            let s = prepareQubit(bit: aBits[i], basis: aBases[i])
            return [s.a0r, s.a0i, s.a1r, s.a1i]
        }
        send?(["p": "q", "n": n, "q": q])
    }

    /// Feed an incoming ceremony payload (the dict under signaling type `"qkd"`).
    func handle(_ payload: [String: Any]) {
        guard !finished, let phase = payload["p"] as? String else { return }
        switch (role, phase) {
        case (.bob, "q"):   bobReceiveQubits(payload)
        case (.alice, "b"): aliceReceiveBases(payload)
        case (.bob, "s"):   bobReconcile(payload)
        case (.alice, "ok"): aliceFinish(success: true)
        case (.alice, "x"):  aliceFinish(success: false)
        default: break
        }
    }

    // MARK: Bob

    private func bobReceiveQubits(_ payload: [String: Any]) {
        guard let raw = payload["q"] as? [[Double]] else { return }
        bBits = []; bBases = []
        for amp in raw where amp.count == 4 {
            var q = Qubit(a0r: amp[0], a0i: amp[1], a1r: amp[2], a1i: amp[3])
            let basis = randBasis()
            bBases.append(basis)
            bBits.append(measureQubit(&q, basis: basis))
        }
        send?(["p": "b", "bb": bBases.map { $0.rawValue }])
    }

    private func bobReconcile(_ payload: [String: Any]) {
        guard let ab = (payload["ab"] as? [Int])?.map({ Basis(rawValue: $0) ?? .rectilinear }),
              let sampleA = payload["sb"] as? [Int],
              ab.count == bBases.count else { onAbort?("BB84 protocol error"); finished = true; return }

        // Sift: positions where Alice's and Bob's bases matched.
        var sifted: [Int] = []   // Bob's bits at sifted positions
        for i in 0..<ab.count where ab[i] == bBases[i] { sifted.append(bBits[i]) }
        if sifted.isEmpty { abortBob("BB84: no sifted bits"); return }

        // Even-indexed sifted bits are the public QBER sample; odd-indexed survive
        // into the key. Alice sent her sample bits in the same order.
        var sampleB: [Int] = [], keyBits: [Int] = []
        for (i, bit) in sifted.enumerated() {
            if i % 2 == 0 { sampleB.append(bit) } else { keyBits.append(bit) }
        }
        let m = min(sampleA.count, sampleB.count)
        var mism = 0
        for i in 0..<m where sampleA[i] != sampleB[i] { mism += 1 }
        let qber = m > 0 ? Double(mism) / Double(m) : 0

        if qber > kQBERAbortThreshold || keyBits.isEmpty {
            abortBob(String(format: "%@ (QBER %.0f%%)", L("call.reason.compromised"), qber * 100))
            return
        }
        finished = true
        send?(["p": "ok"])
        onSuccess?(deriveKey(keyBits))
    }

    private func abortBob(_ reason: String) {
        finished = true
        send?(["p": "x"])
        onAbort?(reason)
    }

    // MARK: Alice

    private func aliceReceiveBases(_ payload: [String: Any]) {
        guard let bb = (payload["bb"] as? [Int])?.map({ Basis(rawValue: $0) ?? .rectilinear }),
              bb.count == aBases.count else { return }
        bBases = bb

        var siftedBits: [Int] = []
        for i in 0..<aBases.count where aBases[i] == bBases[i] { siftedBits.append(aBits[i]) }
        // Even-indexed sifted bits are the sample Alice publishes for QBER.
        var sample: [Int] = []
        for (i, bit) in siftedBits.enumerated() where i % 2 == 0 { sample.append(bit) }

        send?(["p": "s", "ab": aBases.map { $0.rawValue }, "sb": sample])
    }

    /// Alice derives the same key (odd-indexed sifted bits) once Bob confirms, or
    /// collapses the call if Bob signalled an abort.
    private func aliceFinish(success: Bool) {
        finished = true
        guard success else { onAbort?(L("call.reason.compromised") + " (BB84)"); return }
        var siftedBits: [Int] = []
        for i in 0..<aBases.count where aBases[i] == bBases[i] { siftedBits.append(aBits[i]) }
        var keyBits: [Int] = []
        for (i, bit) in siftedBits.enumerated() where i % 2 == 1 { keyBits.append(bit) }
        onSuccess?(deriveKey(keyBits))
    }
}
