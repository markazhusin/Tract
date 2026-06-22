import Foundation
import Combine
import CryptoKit
import Compression

/// Node-less internet rendezvous over the global BitTorrent Mainline DHT.
///
/// When two peers aren't physically nearby (no mesh) AND there is no Tract node to
/// relay signaling, this carries calls and offline text directly through the public
/// DHT: each user has a deterministic "inbox" keypair derived from their (public)
/// userId, and a sender PUTs an E2E-encrypted item into the recipient's inbox that
/// the recipient polls for. No server, no node — just millions of unrelated
/// BitTorrent nodes holding small signed blobs for a couple of hours.
///
/// "Все шифруй": every payload is sealed with Crypto.sharedKey (X25519 → AES-GCM)
/// between the two users BEFORE it touches the DHT, so storage nodes only ever see
/// ciphertext. The BEP-44 ed25519 signature (deterministic, derivable by anyone who
/// knows the userId) provides DHT-level integrity; CONFIDENTIALITY comes from the
/// AES-GCM layer, which only the two real endpoints can open.
///
/// Honest limits (surfaced to the user, not hidden):
///   • Higher latency than a node: ring/connect takes ~15-30s (DHT round-trips are
///     seconds), vs ~1-2s through a node. It works without any infrastructure; that
///     is the cost.
///   • Foreground-only: rides a UDP socket, suspended by iOS in the background, like
///     the mesh.
///   • You can only be DHT-reached by a CONTACT (decrypting needs the sender's key),
///     and the BB84 ceremony is skipped on this path (too many round-trips); the call
///     is still E2E via DTLS-SRTP and the signaling itself is E2E-encrypted.
///   • The web PWA cannot do this at all (browsers have no UDP) — web still needs a node.
final class DHTRendezvous: ObservableObject {
    static let shared = DHTRendezvous()

    @Published private(set) var ready = false

    private var dht: MainlineDHT?
    private var identity: Identity?
    private var running = false

    /// Supplies the contacts whose inboxes we poll (userId + their public key hex).
    var contactsProvider: (() -> [(userId: String, pub: String)])?

    /// Decrypted inbound call signaling: (fromUserId, fromPubHex, type, payload).
    /// type ∈ {"offer","answer","call"} where "call" payloads carry an "action".
    var onCallSignal: ((String, String, String, [String: Any]) -> Void)?

    /// Decrypted inbound offline text: (fromUserId, fromPubHex, text, pid).
    var onTextMessage: ((String, String, String, String) -> Void)?

    // Dedup so re-reading a still-stored DHT item doesn't replay it.
    private var seenCall = Set<String>()          // callId+":"+type
    private var seenControl = Set<String>()        // callId+":"+action
    private var lastTextIndex: [String: Int] = [:] // per-sender highest pulled index

    private init() {}

    // MARK: - Lifecycle

    func start(identity: Identity) {
        self.identity = identity
        guard !running else { return }
        running = true
        loadTextCursors(identity.userId)
        Task.detached(priority: .utility) { [weak self] in
            guard let self else { return }
            guard let d = MainlineDHT() else { return }
            await MainActor.run { self.dht = d }
            let answered = await d.bootstrapAsync()
            await MainActor.run { self.ready = answered > 0 }
            await self.beaconLoop()
        }
        Task.detached(priority: .utility) { [weak self] in await self?.pollLoop() }
    }

    func stop() {
        running = false
        ready = false
        dht?.stop()
        dht = nil
        identity = nil
        seenCall.removeAll()
        seenControl.removeAll()
    }

    private func normalize(_ s: String) -> String {
        s.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    // MARK: - Keypairs (deterministic, derivable from public userIds)

    /// Same derivation the Go node uses for user records (SHA256 seed → ed25519),
    /// so a Tract node and this client agree on DHT keys. Used for the presence beacon.
    private func userKeyPair(_ userId: String) -> (pub: Data, priv: Curve25519.Signing.PrivateKey)? {
        let seed = Data(SHA256.hash(data: Data(("tract-user:" + normalize(userId)).utf8)))
        return MainlineDHT.keyPair(seed: seed)
    }

    /// The "inbox" keypair: where items addressed TO this user are stored.
    private func inboxKeyPair(_ userId: String) -> (pub: Data, priv: Curve25519.Signing.PrivateKey)? {
        let seed = Data(SHA256.hash(data: Data(("tract-inbox:" + normalize(userId)).utf8)))
        return MainlineDHT.keyPair(seed: seed)
    }

    private func sharedKey(theirPubHex: String) -> SymmetricKey? {
        guard let id = identity else { return nil }
        return Crypto.sharedKey(my: id.privateKey, theirHex: theirPubHex)
    }

    // MARK: - Presence beacon

    /// Publish a tiny "I'm online" marker under our user keypair (salt "p") so a
    /// caller can confirm reachability before placing a DHT call. Refreshed periodically.
    private func beaconLoop() async {
        while running {
            if let id = identity, let kp = userKeyPair(id.userId), let dht {
                let ts = Int64(Date().timeIntervalSince1970)
                var v = Data("on".utf8)
                var be = ts.bigEndian
                withUnsafeBytes(of: &be) { v.append(contentsOf: $0) }
                _ = await dht.putAsync(pub: kp.pub, priv: kp.priv, salt: Data("p".utf8), value: v, seq: ts)
            }
            try? await Task.sleep(nanoseconds: 90_000_000_000) // 90s
        }
    }

    /// Check whether a peer published a recent beacon. Best-effort; returns true if
    /// a beacon younger than ~3 min exists. Callers may proceed even on false (the
    /// peer might just not be running this build); it only speeds up "не в сети".
    func isOnline(userId: String) async -> Bool {
        guard let dht, let kp = userKeyPair(userId) else { return false }
        guard let (v, _) = await dht.getAsync(pub: kp.pub, salt: Data("p".utf8)), v.count >= 10 else { return false }
        let tsBytes = v.suffix(8)
        let ts = tsBytes.withUnsafeBytes { $0.load(as: Int64.self) }.bigEndian
        return Date().timeIntervalSince1970 - Double(ts) < 180
    }

    // MARK: - Send (call signaling + text), E2E-encrypted

    /// Place/continue a DHT call. type "offer"/"answer"/"call" (control). Returns
    /// whether at least the first chunk stored on the swarm.
    @discardableResult
    func sendCall(toUserId: String, toPub: String, type: String, payload: [String: Any]) async -> Bool {
        guard let dht, let inbox = inboxKeyPair(toUserId), let key = sharedKey(theirPubHex: toPub),
              let id = identity,
              let json = try? JSONSerialization.data(withJSONObject: payload),
              let blob = seal(json, key: key) else { return false }
        let me = normalize(id.userId)
        let salt: String
        switch type {
        case "offer":  salt = "o:" + me
        case "answer": salt = "a:" + me
        default:       salt = "c:" + me   // control: invite-decline/end
        }
        return await putBlob(dht: dht, kp: inbox, baseSalt: salt, blob: blob)
    }

    /// Deliver one offline text message into the recipient's DHT inbox (indexed
    /// mailbox so consecutive messages aren't overwritten).
    @discardableResult
    func sendText(toUserId: String, toPub: String, text: String, pid: String) async -> Bool {
        guard let dht, let inbox = inboxKeyPair(toUserId), let key = sharedKey(theirPubHex: toPub),
              let id = identity else { return false }
        let me = normalize(id.userId)
        let idx = nextSendIndex(to: toUserId)
        let payload: [String: Any] = ["pid": pid, "text": text, "from": id.userId,
                                      "fromPk": id.publicKeyHex, "ts": Int64(Date().timeIntervalSince1970)]
        guard let json = try? JSONSerialization.data(withJSONObject: payload), let blob = seal(json, key: key) else { return false }
        let stored = await putBlob(dht: dht, kp: inbox, baseSalt: "tm:" + me + ":" + String(idx), blob: blob)
        // Publish the new head so the recipient knows how far to read.
        var head = Data()
        var be = Int32(idx).bigEndian
        withUnsafeBytes(of: &be) { head.append(contentsOf: $0) }
        if let hb = seal(head, key: key) {
            _ = await putBlob(dht: dht, kp: inbox, baseSalt: "th:" + me, blob: hb)
        }
        return stored
    }

    // MARK: - Poll loop (read our own inbox for every contact)

    private func pollLoop() async {
        while running {
            if ready, let contacts = contactsProvider?(), let id = identity, let myInbox = inboxKeyPair(id.userId) {
                await withTaskGroup(of: Void.self) { group in
                    for c in contacts where !c.pub.isEmpty {
                        group.addTask { [weak self] in await self?.pollContact(myInbox: myInbox, contact: c) }
                    }
                }
            }
            try? await Task.sleep(nanoseconds: 6_000_000_000) // 6s between sweeps
        }
    }

    private func pollContact(myInbox: (pub: Data, priv: Curve25519.Signing.PrivateKey),
                             contact: (userId: String, pub: String)) async {
        guard let dht, let key = sharedKey(theirPubHex: contact.pub) else { return }
        let from = normalize(contact.userId)

        // Incoming offer (their offer lands in our inbox at "o:"+them).
        if let dict = await fetch(dht: dht, pub: myInbox.pub, baseSalt: "o:" + from, key: key) {
            deliverCall(from: contact, type: "offer", dict: dict)
        }
        // Incoming answer to a call we placed ("a:"+them).
        if let dict = await fetch(dht: dht, pub: myInbox.pub, baseSalt: "a:" + from, key: key) {
            deliverCall(from: contact, type: "answer", dict: dict)
        }
        // Incoming control (decline/end) at "c:"+them.
        if let dict = await fetch(dht: dht, pub: myInbox.pub, baseSalt: "c:" + from, key: key) {
            if let callId = dict["callId"] as? String, let action = dict["action"] as? String {
                let stamp = callId + ":" + action
                if !seenControl.contains(stamp), recent(dict) {
                    seenControl.insert(stamp)
                    await MainActor.run { self.onCallSignal?(contact.userId, contact.pub, "call", dict) }
                }
            }
        }
        // Offline text: read head, pull any new indices.
        await pollText(dht: dht, myInbox: myInbox, contact: contact, key: key)
    }

    private func deliverCall(from contact: (userId: String, pub: String), type: String, dict: [String: Any]) {
        guard let callId = dict["callId"] as? String, recent(dict) else { return }
        let stamp = callId + ":" + type
        guard !seenCall.contains(stamp) else { return }
        seenCall.insert(stamp)
        let uid = contact.userId, pub = contact.pub
        Task { @MainActor in self.onCallSignal?(uid, pub, type, dict) }
    }

    private func pollText(dht: MainlineDHT, myInbox: (pub: Data, priv: Curve25519.Signing.PrivateKey),
                          contact: (userId: String, pub: String), key: SymmetricKey) async {
        let from = normalize(contact.userId)
        guard let headBlob = await getBlob(dht: dht, pub: myInbox.pub, baseSalt: "th:" + from),
              let headData = openRaw(headBlob, key: key), headData.count >= 4 else { return }
        let head = Int(headData.prefix(4).withUnsafeBytes { $0.load(as: Int32.self) }.bigEndian)
        var cursor = lastTextIndex[from] ?? 0
        guard head > cursor else { return }
        let start = max(cursor + 1, head - 20) // bounded backfill
        for idx in start...head {
            if let dict = await fetch(dht: dht, pub: myInbox.pub, baseSalt: "tm:" + from + ":" + String(idx), key: key),
               let pid = dict["pid"] as? String, let text = dict["text"] as? String {
                let uid = contact.userId, pub = contact.pub
                await MainActor.run { self.onTextMessage?(uid, pub, text, pid) }
            }
            cursor = idx
        }
        lastTextIndex[from] = cursor
        saveTextCursors()
    }

    private func recent(_ dict: [String: Any]) -> Bool {
        guard let ts = (dict["ts"] as? Int64) ?? (dict["ts"] as? NSNumber)?.int64Value else { return true }
        return Date().timeIntervalSince1970 - Double(ts) < 120 // ignore stale (>2 min) DHT leftovers
    }

    // MARK: - Blob seal/open (compress → AES-GCM)

    private func seal(_ json: Data, key: SymmetricKey) -> Data? {
        Crypto.sealData(Self.zip(json), key: key)
    }
    private func open(_ blob: Data, key: SymmetricKey) -> [String: Any]? {
        guard let comp = Crypto.openData(blob, key: key), let json = Self.unzip(comp),
              let obj = try? JSONSerialization.jsonObject(with: json) as? [String: Any] else { return nil }
        return obj
    }
    private func openRaw(_ blob: Data, key: SymmetricKey) -> Data? {
        Crypto.openData(blob, key: key).flatMap { Self.unzip($0) }
    }

    private func fetch(dht: MainlineDHT, pub: Data, baseSalt: String, key: SymmetricKey) async -> [String: Any]? {
        guard let blob = await getBlob(dht: dht, pub: pub, baseSalt: baseSalt) else { return nil }
        return open(blob, key: key)
    }

    // MARK: - Chunked PUT/GET (BEP-44 1000-byte cap)

    private func putBlob(dht: MainlineDHT, kp: (pub: Data, priv: Curve25519.Signing.PrivateKey),
                         baseSalt: String, blob: Data) async -> Bool {
        let chunkCap = MainlineDHT.maxValue
        var chunks: [Data] = []
        if blob.count <= chunkCap - 1 {
            chunks = [blob]
        } else {
            var i = blob.startIndex
            // chunk 0 leaves 1 byte for the count header
            let first = blob.prefix(chunkCap - 1); chunks.append(Data(first)); i = blob.index(i, offsetBy: first.count)
            while i < blob.endIndex {
                let end = blob.index(i, offsetBy: min(chunkCap, blob.distance(from: i, to: blob.endIndex)))
                chunks.append(Data(blob[i..<end])); i = end
            }
        }
        let total = UInt8(min(chunks.count, 255))
        let seq = Int64(Date().timeIntervalSince1970 * 1000)
        // chunk 0: [total] + data0
        var v0 = Data([total]); v0.append(chunks[0])
        let ok = await dht.putAsync(pub: kp.pub, priv: kp.priv, salt: Data(baseSalt.utf8), value: v0, seq: seq) > 0
        for n in 1..<chunks.count {
            _ = await dht.putAsync(pub: kp.pub, priv: kp.priv,
                                   salt: Data((baseSalt + ":c" + String(n)).utf8), value: chunks[n], seq: seq)
        }
        return ok
    }

    private func getBlob(dht: MainlineDHT, pub: Data, baseSalt: String) async -> Data? {
        guard let (v0, _) = await dht.getAsync(pub: pub, salt: Data(baseSalt.utf8)), v0.count >= 1 else { return nil }
        let total = Int(v0[v0.startIndex])
        var out = Data(v0.dropFirst())
        if total <= 1 { return out }
        for n in 1..<total {
            guard let (vn, _) = await dht.getAsync(pub: pub, salt: Data((baseSalt + ":c" + String(n)).utf8)) else { return nil }
            out.append(vn)
        }
        return out
    }

    // MARK: - Send-index persistence (for the text mailbox)

    private func nextSendIndex(to userId: String) -> Int {
        let k = "tract.dht.sendIdx." + normalize(userId)
        let n = UserDefaults.standard.integer(forKey: k) + 1
        UserDefaults.standard.set(n, forKey: k)
        return n
    }

    private func textCursorKey(_ myId: String) -> String { "tract.dht.textCursors." + normalize(myId) }
    private func loadTextCursors(_ myId: String) {
        if let d = UserDefaults.standard.dictionary(forKey: textCursorKey(myId)) as? [String: Int] {
            lastTextIndex = d
        }
    }
    private func saveTextCursors() {
        guard let id = identity else { return }
        UserDefaults.standard.set(lastTextIndex, forKey: textCursorKey(id.userId))
    }

    // MARK: - zlib (Compression framework) with a 1-byte flag + 4-byte length header

    private static func zip(_ input: Data) -> Data {
        var out = Data()
        if input.isEmpty { out.append(0); out.append(contentsOf: [0, 0, 0, 0]); return out }
        let cap = input.count
        var dst = Data(count: cap)
        let n = dst.withUnsafeMutableBytes { d -> Int in
            input.withUnsafeBytes { s in
                compression_encode_buffer(d.bindMemory(to: UInt8.self).baseAddress!, cap,
                                          s.bindMemory(to: UInt8.self).baseAddress!, input.count, nil, COMPRESSION_ZLIB)
            }
        }
        var len = UInt32(input.count).bigEndian
        if n > 0 && n < input.count {
            out.append(1) // zlib
            withUnsafeBytes(of: &len) { out.append(contentsOf: $0) }
            out.append(dst.prefix(n))
        } else {
            out.append(0) // raw (incompressible)
            withUnsafeBytes(of: &len) { out.append(contentsOf: $0) }
            out.append(input)
        }
        return out
    }

    private static func unzip(_ input: Data) -> Data? {
        let a = [UInt8](input)
        guard a.count >= 5 else { return a.isEmpty ? Data() : nil }
        let flag = a[0]
        let origLen = Int(UInt32(a[1]) << 24 | UInt32(a[2]) << 16 | UInt32(a[3]) << 8 | UInt32(a[4]))
        let payload = Data(a[5...])
        if flag == 0 { return payload }
        if origLen == 0 { return Data() }
        var dst = Data(count: origLen)
        let n = dst.withUnsafeMutableBytes { d -> Int in
            payload.withUnsafeBytes { s in
                compression_decode_buffer(d.bindMemory(to: UInt8.self).baseAddress!, origLen,
                                          s.bindMemory(to: UInt8.self).baseAddress!, payload.count, nil, COMPRESSION_ZLIB)
            }
        }
        return n == origLen ? dst : nil
    }
}
