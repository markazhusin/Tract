import Foundation
import CryptoKit
import Darwin

/// A participant in the GLOBAL BitTorrent Mainline DHT (BEP-5) with mutable-item
/// storage (BEP-44) — a Swift port of internal/mainline/mainline.go, wire-identical
/// so the iOS client interoperates with the public swarm AND with Tract Go nodes
/// (same KRPC/bencode, same SHA1 targets, same ed25519 keypair derivation).
///
/// This is what lets calls/chats find each other over the internet with NO running
/// node: a client PUTs a tiny signed card under a key derived from a userId, and the
/// peer GETs it back from millions of unrelated BitTorrent nodes. The card contents
/// are E2E-encrypted by the layer above (DHTRendezvous), so DHT storage nodes can't
/// read the SDP/ICE they carry.
///
/// Honest scope: this rides a raw UDP socket, so — exactly like the mesh — it lives
/// only while the app is foregrounded/alive; iOS suspends the socket in background.
/// Browsers have no UDP, so the web PWA cannot do this and still needs a node.
final class MainlineDHT {
    private static let idLen = 20
    private static let k = 8              // closest-nodes kept per lookup
    private static let alpha = 6          // lookup parallelism
    private static let rpcTimeout = 3.0   // seconds
    static let maxValue = 1000            // BEP-44 value cap (bytes)

    /// Well-known Mainline DHT bootstrap nodes; any one reachable joins the swarm.
    static let publicRouters = [
        "router.bittorrent.com:6881",
        "dht.transmissionbt.com:6881",
        "router.utorrent.com:6881",
        "dht.libtorrent.org:25401",
        "router.bitcomet.com:6881",
    ]

    struct Contact: Equatable {
        let id: Data        // 20 bytes
        let ip: Data        // 4 bytes, network order
        let port: UInt16
        static func == (a: Contact, b: Contact) -> Bool { a.id == b.id }
    }

    private var sock: Int32 = -1
    private let id: Data
    private let stateLock = NSLock()
    private var routes: [Contact] = []

    private let txLock = NSLock()
    private final class Pending { let sem = DispatchSemaphore(value: 0); var resp: Bencode? }
    private var txns: [Data: Pending] = [:]

    private let queue = DispatchQueue(label: "tract.mldht", attributes: .concurrent)
    private var closedFlag = false
    private var closedLock = NSLock()
    private var closed: Bool { closedLock.lock(); defer { closedLock.unlock() }; return closedFlag }

    private(set) var ready = false

    init?() {
        var rnd = Data(count: Self.idLen)
        _ = rnd.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, Self.idLen, $0.baseAddress!) }
        self.id = rnd

        let s = socket(AF_INET, SOCK_DGRAM, 0)
        guard s >= 0 else { return nil }
        // Bind to an ephemeral port on all interfaces.
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0
        addr.sin_addr.s_addr = INADDR_ANY
        let bound = withUnsafePointer(to: &addr) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(s, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0 else { close(s); return nil }
        // 1s read timeout so the read loop can notice close().
        var tv = timeval(tv_sec: 1, tv_usec: 0)
        setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        self.sock = s
        startReadLoop()
    }

    func stop() {
        closedLock.lock(); closedFlag = true; closedLock.unlock()
        if sock >= 0 { close(sock); sock = -1 }
    }

    // MARK: - Wire I/O

    private func startReadLoop() {
        queue.async { [weak self] in
            guard let self else { return }
            var buf = [UInt8](repeating: 0, count: 64 * 1024)
            while !self.closed {
                var sa = sockaddr_storage()
                var slen = socklen_t(MemoryLayout<sockaddr_storage>.size)
                let n = withUnsafeMutablePointer(to: &sa) { sp in
                    sp.withMemoryRebound(to: sockaddr.self, capacity: 1) { sap in
                        recvfrom(self.sock, &buf, buf.count, 0, sap, &slen)
                    }
                }
                if n <= 0 { continue } // timeout or error → loop and re-check closed
                guard let from = Self.fromAddr(sa) else { continue }
                let data = Data(buf[0..<n])
                guard let msg = try? Bencode.decode(data), msg.dictValue != nil else { continue }
                self.handle(msg, from: from)
            }
        }
    }

    private func handle(_ msg: Bencode, from: Contact) {
        let y = msg["y"]?.stringValue ?? ""
        switch y {
        case "r", "e":
            if let t = msg["t"]?.dataValue {
                txLock.lock(); let p = txns[t]; txLock.unlock()
                if let p { p.resp = msg; p.sem.signal() }
            }
            if let r = msg["r"]?.dictValue, let rid = r["id"]?.dataValue, rid.count == Self.idLen {
                remember(Contact(id: rid, ip: from.ip, port: from.port))
            }
        case "q":
            answer(msg, from: from)
        default: break
        }
    }

    /// Answer inbound queries so we stay a good DHT citizen (and stay in others'
    /// routing tables, which keeps our PUTs reachable).
    private func answer(_ msg: Bencode, from: Contact) {
        let t = msg["t"]?.dataValue ?? Data()
        let q = msg["q"]?.stringValue ?? ""
        let a = msg["a"]?.dictValue
        if let a, let aid = a["id"]?.dataValue, aid.count == Self.idLen {
            remember(Contact(id: aid, ip: from.ip, port: from.port))
        }
        var resp: [String: Bencode] = ["id": .bytes(id)]
        switch q {
        case "ping":
            break
        case "find_node", "get_peers", "get":
            var target = Data(count: Self.idLen)
            if let a {
                if let tg = a["target"]?.dataValue, tg.count == Self.idLen { target = tg }
                else if let ih = a["info_hash"]?.dataValue, ih.count == Self.idLen { target = ih }
            }
            resp["nodes"] = .bytes(compactClosest(target))
            resp["token"] = .string("tract")
            if q == "get_peers" { resp["values"] = .list([]) }
        default:
            break
        }
        let reply: Bencode = .dict(["t": .bytes(t), "y": .string("r"), "r": .dict(resp)])
        send(reply.encoded(), to: from)
    }

    private func send(_ data: Data, to c: Contact) {
        guard sock >= 0 else { return }
        var sa = Self.sockAddrIn(c)
        _ = data.withUnsafeBytes { raw in
            withUnsafePointer(to: &sa) { p in
                p.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    sendto(sock, raw.baseAddress, data.count, 0, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }
        }
    }

    /// Send a KRPC query and BLOCK for the matching response (up to rpcTimeout).
    /// Call off the main thread (the rendezvous layer does, via the async wrappers).
    private func query(_ c: Contact, _ method: String, _ args: [String: Bencode]) -> [String: Bencode]? {
        guard sock >= 0 else { return nil }
        var a = args
        a["id"] = .bytes(id)
        let tid = Self.newTxID()
        let pending = Pending()
        txLock.lock(); txns[tid] = pending; txLock.unlock()
        defer { txLock.lock(); txns[tid] = nil; txLock.unlock() }

        let msg: Bencode = .dict(["t": .bytes(tid), "y": .string("q"), "q": .string(method), "a": .dict(a)])
        send(msg.encoded(), to: c)

        if pending.sem.wait(timeout: .now() + Self.rpcTimeout) == .timedOut { return nil }
        guard let resp = pending.resp else { return nil }
        if resp["y"]?.stringValue == "e" { return nil }
        return resp["r"]?.dictValue
    }

    // MARK: - Routing table

    private func remember(_ c: Contact) {
        if c.id == id || c.ip.count != 4 || c.port == 0 { return }
        stateLock.lock(); defer { stateLock.unlock() }
        if routes.contains(where: { $0.id == c.id }) { return }
        routes.append(c)
        let cap = 512
        if routes.count > cap { routes.removeFirst(routes.count - cap) }
    }

    private func closest(_ target: Data, _ n: Int) -> [Contact] {
        stateLock.lock(); let all = routes; stateLock.unlock()
        let sorted = all.sorted { Self.xorLess($0.id, $1.id, target) }
        return Array(sorted.prefix(n))
    }

    private func compactClosest(_ target: Data) -> Data {
        var b = Data()
        for c in closest(target, Self.k) {
            b.append(c.id)
            b.append(c.ip)
            b.append(UInt8(c.port >> 8)); b.append(UInt8(c.port & 0xff))
        }
        return b
    }

    // MARK: - Bootstrap & lookup

    /// Join the global DHT via the public routers (plus any extra addrs), then warm
    /// the table by looking ourselves up. Returns how many routers answered. BLOCKS.
    @discardableResult
    func bootstrap(_ extra: [String] = []) -> Int {
        var answered = 0
        for s in Self.publicRouters + extra {
            guard let c = Self.resolve(s) else { continue }
            if let r = query(c, "find_node", ["target": .bytes(id)]) {
                answered += 1
                absorbNodes(r)
            }
        }
        if answered > 0 {
            // Warm the routing table across the keyspace, not just near our own id:
            // a few random-target lookups populate enough buckets that the FIRST
            // call's PUT/GET (to an arbitrary inbox target) lands on live nodes
            // instead of an empty neighborhood — the cold-start "stuck" trap.
            _ = iterativeFind(id)
            for _ in 0..<3 {
                var r = Data(count: Self.idLen)
                _ = r.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, Self.idLen, $0.baseAddress!) }
                _ = iterativeFind(r)
            }
        }
        ready = answered > 0
        return answered
    }

    @discardableResult
    private func absorbNodes(_ r: [String: Bencode]) -> [Contact] {
        let cs = Self.parseCompactNodes(r["nodes"]?.dataValue ?? Data())
        for c in cs { remember(c) }
        return cs
    }

    private func iterativeFind(_ target: Data) -> [Contact] {
        var shortlist = closest(target, Self.k)
        var queried = Set<Data>()
        for _ in 0..<8 {
            let batch = Self.pickUnqueried(shortlist, queried, Self.alpha)
            if batch.isEmpty { break }
            let group = DispatchGroup()
            let lock = NSLock()
            var got: [Contact] = []
            for c in batch {
                queried.insert(c.id)
                group.enter()
                queue.async {
                    defer { group.leave() }
                    guard let r = self.query(c, "find_node", ["target": .bytes(target)]) else { return }
                    let cs = self.absorbNodes(r)
                    lock.lock(); got.append(contentsOf: cs); lock.unlock()
                }
            }
            group.wait()
            shortlist = Self.mergeClosest(shortlist, got, target, Self.k)
        }
        return shortlist
    }

    // MARK: - BEP-44 mutable items

    /// Deterministic ed25519 keypair from a 32-byte seed — two peers agreeing on the
    /// same seed derive the same keypair, hence the same DHT target. Byte-identical
    /// to Go's mainline.KeyPairFromSeed (RFC 8032 Ed25519 in both).
    static func keyPair(seed: Data) -> (pub: Data, priv: Curve25519.Signing.PrivateKey)? {
        guard seed.count == 32, let priv = try? Curve25519.Signing.PrivateKey(rawRepresentation: seed) else { return nil }
        return (priv.publicKey.rawRepresentation, priv)
    }

    /// DHT key for a mutable item: SHA1(pubkey [++ salt]).
    static func mutableTarget(pub: Data, salt: Data) -> Data {
        var h = Insecure.SHA1()
        h.update(data: pub)
        if !salt.isEmpty { h.update(data: salt) }
        return Data(h.finalize())
    }

    /// The exact byte string BEP-44 signs/verifies: bencoded salt (if any), seq and
    /// v entries concatenated WITHOUT an enclosing dict. Mirrors Go's signBuffer.
    private static func signBuffer(salt: Data, seq: Int64, v: Data) -> Data {
        var b = Data()
        if !salt.isEmpty {
            b.append(contentsOf: Array("4:salt".utf8))
            b.append(contentsOf: Array(String(salt.count).utf8))
            b.append(UInt8(ascii: ":"))
            b.append(salt)
        }
        b.append(contentsOf: Array("3:seqi".utf8))
        b.append(contentsOf: Array(String(seq).utf8))
        b.append(UInt8(ascii: "e"))
        b.append(contentsOf: Array("1:v".utf8))
        b.append(contentsOf: Array(String(v.count).utf8))
        b.append(UInt8(ascii: ":"))
        b.append(v)
        return b
    }

    /// Publish a signed mutable value under the keypair (optionally salted). seq must
    /// strictly increase across updates. Returns how many nodes accepted. BLOCKS.
    @discardableResult
    func put(pub: Data, priv: Curve25519.Signing.PrivateKey, salt: Data, value: Data, seq: Int64) -> Int {
        guard value.count <= Self.maxValue else { return 0 }
        let target = Self.mutableTarget(pub: pub, salt: salt)
        guard let sig = try? priv.signature(for: Self.signBuffer(salt: salt, seq: seq, v: value)) else { return 0 }

        // Collect write tokens DURING the lookup: query the converging shortlist
        // with "get" (every well-behaved node answers with a token), accumulating
        // token-holders across ALL rounds — not just the final neighborhood. This
        // is what makes a cold-table publish reliable: re-querying only the last 8
        // nodes (some slow/unresponsive) was the "stuck connecting" trap.
        //
        // A single convergence pass can occasionally come back with no tokens
        // (every queried node slow/unresponsive that cycle — e.g. a router briefly
        // rate-limiting a freshly-joined node). Retry the whole pass a couple of
        // times rather than reporting a failed publish; each retry re-densifies the
        // neighborhood, so the next one usually lands.
        var holders = collectTokens(target)
        for _ in 0..<3 where holders.isEmpty {
            holders = collectTokens(target)
        }
        var stored = 0
        for h in holders.prefix(Self.k) {
            var args: [String: Bencode] = [
                "token": .bytes(h.token),
                "k": .bytes(pub),
                "sig": .bytes(Data(sig)),
                "seq": .int(seq),
                "v": .bytes(value),
            ]
            if !salt.isEmpty { args["salt"] = .bytes(salt) }
            if query(h.c, "put", args) != nil { stored += 1 }
        }
        return stored
    }

    /// Iterative lookup using "get" so every responding node yields a write token.
    /// Returns the token-holders we touched, closest-to-target first.
    private func collectTokens(_ target: Data) -> [(c: Contact, token: Data)] {
        // Same target-seeded densification as get(): converge to the true-closest
        // neighborhood so the value lands where a reader will look for it.
        var shortlist = Self.mergeClosest(closest(target, Self.k), iterativeFind(target), target, Self.k)
        var queried = Set<Data>()
        var tokens: [Data: (c: Contact, token: Data)] = [:]   // keyed by node id
        for _ in 0..<8 {
            let batch = Self.pickUnqueried(shortlist, queried, Self.alpha)
            if batch.isEmpty { break }
            let group = DispatchGroup()
            let lock = NSLock()
            var more: [Contact] = []
            for c in batch {
                queried.insert(c.id)
                group.enter()
                queue.async {
                    defer { group.leave() }
                    guard let r = self.query(c, "get", ["target": .bytes(target)]) else { return }
                    let cs = self.absorbNodes(r)
                    lock.lock()
                    more.append(contentsOf: cs)
                    if let t = r["token"]?.dataValue, !t.isEmpty { tokens[c.id] = (c, t) }
                    lock.unlock()
                }
            }
            group.wait()
            shortlist = Self.mergeClosest(shortlist, more, target, Self.k)
        }
        return tokens.values.sorted { Self.xorLess($0.c.id, $1.c.id, target) }
    }

    /// Fetch the highest-seq signed value under the keypair (and salt). The signature
    /// is verified before returning. BLOCKS.
    func get(pub: Data, salt: Data) -> (value: Data, seq: Int64)? {
        let target = Self.mutableTarget(pub: pub, salt: salt)
        // Densify the routing neighborhood around THIS target first (find_node),
        // then merge with whatever the table already had. On a cold/sparse table
        // the plain `closest()` set is only "closest we happen to know" — not the
        // true-closest — so a reader converges to a different node set than the
        // writer did and misses the value. A target-seeded lookup makes both
        // sides land on the same neighborhood.
        var shortlist = Self.mergeClosest(closest(target, Self.k), iterativeFind(target), target, Self.k)
        guard let verifyKey = try? Curve25519.Signing.PublicKey(rawRepresentation: pub) else { return nil }

        var queried = Set<Data>()
        var best: Data?
        var bestSeq: Int64 = -1
        for _ in 0..<8 {
            let batch = Self.pickUnqueried(shortlist, queried, Self.alpha)
            if batch.isEmpty { break }
            let group = DispatchGroup()
            let lock = NSLock()
            var more: [Contact] = []
            for c in batch {
                queried.insert(c.id)
                group.enter()
                queue.async {
                    defer { group.leave() }
                    guard let r = self.query(c, "get", ["target": .bytes(target)]) else { return }
                    let cs = self.absorbNodes(r)
                    lock.lock(); more.append(contentsOf: cs); lock.unlock()
                    guard let v = r["v"]?.dataValue, let sig = r["sig"]?.dataValue else { return }
                    let seq = r["seq"]?.intValue ?? 0
                    if verifyKey.isValidSignature(sig, for: Self.signBuffer(salt: salt, seq: seq, v: v)) {
                        lock.lock()
                        if seq > bestSeq { bestSeq = seq; best = v }
                        lock.unlock()
                    }
                }
            }
            group.wait()
            shortlist = Self.mergeClosest(shortlist, more, target, Self.k)
        }
        if let best { return (best, bestSeq) }
        return nil
    }

    // MARK: - Async wrappers (so callers don't block their own queues)

    func bootstrapAsync(_ extra: [String] = []) async -> Int {
        await withCheckedContinuation { cont in
            queue.async { cont.resume(returning: self.bootstrap(extra)) }
        }
    }

    func putAsync(pub: Data, priv: Curve25519.Signing.PrivateKey, salt: Data, value: Data, seq: Int64) async -> Int {
        await withCheckedContinuation { cont in
            queue.async { cont.resume(returning: self.put(pub: pub, priv: priv, salt: salt, value: value, seq: seq)) }
        }
    }

    func getAsync(pub: Data, salt: Data) async -> (value: Data, seq: Int64)? {
        await withCheckedContinuation { cont in
            queue.async { cont.resume(returning: self.get(pub: pub, salt: salt)) }
        }
    }

    // MARK: - Helpers

    private static func newTxID() -> Data {
        var d = Data(count: 2)
        _ = d.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 2, $0.baseAddress!) }
        return d
    }

    private static func xorLess(_ a: Data, _ b: Data, _ target: Data) -> Bool {
        let ab = [UInt8](a), bb = [UInt8](b), tb = [UInt8](target)
        for i in 0..<min(ab.count, bb.count, tb.count) {
            let xa = ab[i] ^ tb[i], xb = bb[i] ^ tb[i]
            if xa != xb { return xa < xb }
        }
        return false
    }

    private static func parseCompactNodes(_ s: Data) -> [Contact] {
        let recLen = idLen + 6
        var out: [Contact] = []
        var b = [UInt8](s)
        var i = 0
        while b.count - i >= recLen {
            let cid = Data(b[i..<i + idLen])
            let ip = Data(b[i + idLen..<i + idLen + 4])
            let port = UInt16(b[i + idLen + 4]) << 8 | UInt16(b[i + idLen + 5])
            if port != 0 && !(ip[0] == 0 && ip[1] == 0 && ip[2] == 0 && ip[3] == 0) {
                out.append(Contact(id: cid, ip: ip, port: port))
            }
            i += recLen
        }
        return out
    }

    private static func pickUnqueried(_ cs: [Contact], _ queried: Set<Data>, _ n: Int) -> [Contact] {
        var batch: [Contact] = []
        for c in cs where !queried.contains(c.id) {
            batch.append(c)
            if batch.count >= n { break }
        }
        return batch
    }

    private static func mergeClosest(_ a: [Contact], _ b: [Contact], _ target: Data, _ n: Int) -> [Contact] {
        var seen = Set<Data>()
        var merged: [Contact] = []
        for c in a + b where !seen.contains(c.id) {
            seen.insert(c.id)
            merged.append(c)
        }
        merged.sort { xorLess($0.id, $1.id, target) }
        return Array(merged.prefix(n))
    }

    // MARK: - Address conversion

    private static func sockAddrIn(_ c: Contact) -> sockaddr_in {
        var sa = sockaddr_in()
        sa.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        sa.sin_family = sa_family_t(AF_INET)
        sa.sin_port = c.port.bigEndian
        sa.sin_addr.s_addr = c.ip.withUnsafeBytes { $0.load(as: in_addr_t.self) }
        return sa
    }

    private static func fromAddr(_ sa: sockaddr_storage) -> Contact? {
        guard Int32(sa.ss_family) == AF_INET else { return nil }
        var s = sa
        let sin = withUnsafePointer(to: &s) { p in
            p.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee }
        }
        var addrBE = sin.sin_addr.s_addr
        let ip = withUnsafeBytes(of: &addrBE) { Data($0) }
        let port = UInt16(bigEndian: sin.sin_port)
        return Contact(id: Data(count: idLen), ip: ip, port: port)
    }

    /// Resolve "host:port" to a contact (IPv4 only, matching the Go udp4 client).
    private static func resolve(_ hostport: String) -> Contact? {
        guard let idx = hostport.lastIndex(of: ":") else { return nil }
        let host = String(hostport[..<idx])
        let portStr = String(hostport[hostport.index(after: idx)...])
        guard let _ = UInt16(portStr) else { return nil }
        var hints = addrinfo(ai_flags: 0, ai_family: AF_INET, ai_socktype: SOCK_DGRAM,
                             ai_protocol: 0, ai_addrlen: 0, ai_canonname: nil, ai_addr: nil, ai_next: nil)
        var res: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(host, portStr, &hints, &res) == 0, let first = res else { return nil }
        defer { freeaddrinfo(res) }
        var p: UnsafeMutablePointer<addrinfo>? = first
        while let cur = p {
            if cur.pointee.ai_family == AF_INET, let sa = cur.pointee.ai_addr {
                let sin = sa.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee }
                var addrBE = sin.sin_addr.s_addr
                let ip = withUnsafeBytes(of: &addrBE) { Data($0) }
                let port = UInt16(bigEndian: sin.sin_port)
                return Contact(id: Data(count: idLen), ip: ip, port: port)
            }
            p = cur.pointee.ai_next
        }
        return nil
    }
}
