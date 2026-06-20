import Foundation

/// HTTP signaling client that speaks the existing Go server's protocol — the SAME
/// one the web build uses, so native ↔ web interop works. Presence (register +
/// heartbeat), peer lookup, ICE config, and offer/answer/ICE relay via polling.
final class SignalingClient {
    let node: NodeConfig
    let peerId: String

    private var userId = ""
    private var displayName = ""
    private var publicKeyHex = ""
    private var running = false
    private var registered = false
    private var lastBase: URL?

    /// Delivered on the main queue: (fromPeerId, type, payload). `payload` is a
    /// String for offer/answer SDP, or [String:Any] for ICE / app packets.
    var onSignal: ((String, String, Any) -> Void)?

    init(node: NodeConfig, peerId: String) {
        self.node = node
        self.peerId = peerId
    }

    func start(userId: String, displayName: String, publicKeyHex: String) {
        self.userId = userId
        self.displayName = displayName
        self.publicKeyHex = publicKeyHex
        guard !running else { return }
        running = true
        Task { await self.heartbeatLoop() }
        Task { await self.pollLoop() }
    }

    func stop() {
        running = false
        Task { try? await self.post("peer/unregister", ["peerId": peerId, "roomId": node.roomId]) }
    }

    // MARK: Presence

    private var stealth: Bool { UserDefaults.standard.bool(forKey: "tract.stealth") }

    private func register() async {
        try? await post("peer/register", [
            "peerId": peerId, "roomId": node.roomId, "userId": userId,
            "displayName": displayName, "publicKeyHex": publicKeyHex, "hideOnline": stealth
        ])
    }

    /// Publish our identity (public key + name) so other devices can add us by @id.
    private func uploadIdentity() async {
        let blob: [String: Any] = [
            "version": 2, "userId": userId, "publicKeyHex": publicKeyHex, "displayName": displayName
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: blob),
              let blobStr = String(data: data, encoding: .utf8) else { return }
        try? await post("identity/store", ["userId": userId, "identityBlob": blobStr])
    }

    private func heartbeatLoop() async {
        while running {
            // The node is discovered asynchronously; (re)register whenever it changes.
            if let base = node.baseURL {
                if base != lastBase { lastBase = base; registered = false }
                if !registered {
                    await register()
                    await uploadIdentity()   // publish our pubkey so others can add us by ID
                    registered = true
                }
                try? await post("peer/heartbeat", [
                    "peerId": peerId, "roomId": node.roomId, "displayName": displayName,
                    "publicKeyHex": publicKeyHex, "hideOnline": stealth,
                    "lastSeen": Int(Date().timeIntervalSince1970 * 1000)
                ])
            }
            try? await Task.sleep(nanoseconds: 5_000_000_000)
        }
    }

    // MARK: Lookup / ICE

    /// Returns the peer record for a userId (incl. its current peerId), or nil if offline.
    func findPeer(userId: String) async -> [String: Any]? {
        guard let base = node.baseURL,
              var comps = URLComponents(url: base.appendingPathComponent("peers/by-user/\(userId)"),
                                        resolvingAgainstBaseURL: false) else { return nil }
        comps.queryItems = [URLQueryItem(name: "roomId", value: node.roomId)]
        guard let url = comps.url, let data = try? await get(url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return obj["peer"] as? [String: Any]
    }

    /// ICE servers from the node (TURN) plus public STUN for NAT discovery.
    func iceServers() async -> [[String: Any]] {
        var servers: [[String: Any]] = [
            ["urls": ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]]
        ]
        if let base = node.baseURL, let data = try? await get(base.appendingPathComponent("ice")),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let list = obj["iceServers"] as? [[String: Any]] {
            servers.append(contentsOf: list)
        }
        return servers
    }

    // MARK: Signaling

    func sendSignal(toPeerId: String, toUserId: String, type: String, payload: Any) async {
        try? await post("signal", [
            "from": peerId, "to": toPeerId, "toUserId": toUserId,
            "roomId": node.roomId, "type": type, "payload": payload
        ])
    }

    private func pollLoop() async {
        while running {
            if node.baseURL != nil { await poll() }
            try? await Task.sleep(nanoseconds: 1_000_000_000)
        }
    }

    private func poll() async {
        guard let base = node.baseURL,
              var comps = URLComponents(url: base.appendingPathComponent("signal/poll/\(peerId)"),
                                        resolvingAgainstBaseURL: false) else { return }
        comps.queryItems = [URLQueryItem(name: "roomId", value: node.roomId)]
        guard let url = comps.url, let data = try? await get(url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let messages = obj["messages"] as? [[String: Any]] else { return }
        for m in messages {
            guard let from = m["from"] as? String, let type = m["type"] as? String else { continue }
            let payload = m["payload"] ?? [:]
            await MainActor.run { self.onSignal?(from, type, payload) }
        }
    }

    // MARK: HTTP

    @discardableResult
    private func post(_ path: String, _ body: [String: Any]) async throws -> Data {
        guard let base = node.baseURL else { throw URLError(.badURL) }
        var req = URLRequest(url: base.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        req.timeoutInterval = 10
        let (data, _) = try await URLSession.shared.data(for: req)
        return data
    }

    private func get(_ url: URL) async throws -> Data {
        var req = URLRequest(url: url)
        req.timeoutInterval = 10
        let (data, _) = try await URLSession.shared.data(for: req)
        return data
    }
}
