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

    /// Backup signaling over GetStream — a reserve for reliability/load. Receives
    /// in parallel always; used for sending when the node path fails. Bootstrapped
    /// lazily from the node (the only holder of the Stream secret).
    private var stream: StreamSignalingFallback?

    /// Delivered on the main queue: (fromPeerId, type, payload). `payload` is a
    /// String for offer/answer SDP, or [String:Any] for ICE / app packets.
    var onSignal: ((String, String, Any) -> Void)?

    /// Supplies the userIds of our contacts so their GetStream backup channels are
    /// polled for INCOMING signaling even before we've sent them anything — a node
    /// being down (or a peer registered on a different node) then can't drop a call.
    var contactsProvider: (() -> [String])?

    /// Whether the GetStream reserve transport is bootstrapped AND the user hasn't
    /// opted out. Off → the cascade is fully serverless (mesh + node + DHT only),
    /// with no dependency on any third-party account.
    var streamReady: Bool { streamReserveEnabled && streamReadyFlag }
    private var streamReadyFlag = false

    /// Opt-out for the third-party GetStream reserve (default on). Read live so the
    /// Settings toggle takes effect without a restart.
    private var streamReserveEnabled: Bool {
        (UserDefaults.standard.object(forKey: "tract.streamReserve") as? Bool) ?? true
    }

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
        stream = StreamSignalingFallback(node: node, myUserId: userId)
        stream?.onSignal = { [weak self] from, type, payload in
            self?.onSignal?(from, type, payload)
        }
        Task { await self.heartbeatLoop() }
        Task { await self.pollLoop() }
        Task { await self.streamLoop() }
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
        // A spread of public STUN servers maximizes server-reflexive (public-IP)
        // candidate discovery for direct connections; more servers = more chances
        // one is reachable. IPv6 direct paths use host candidates (no STUN needed).
        var servers: [[String: Any]] = [
            ["urls": [
                "stun:stun.l.google.com:19302",
                "stun:stun1.l.google.com:19302",
                "stun:stun2.l.google.com:19302",
                "stun:stun.cloudflare.com:3478",
                "stun:free.expressturn.com:3478",
            ]]
        ]
        if let base = node.baseURL, let data = try? await get(base.appendingPathComponent("ice")),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let list = obj["iceServers"] as? [[String: Any]] {
            servers.append(contentsOf: list)
        }
        // ExpressTURN managed relay (last resort): also baked in client-side so a
        // call can still traverse symmetric/CGNAT NAT even before /ice is reachable.
        // A TURN credential is necessarily client-visible; this is a shared account,
        // not a secret. The node's /ice returns the same entry — duplicates are
        // harmless (WebRTC de-dupes ICE servers).
        servers.append([
            "urls": ["turn:free.expressturn.com:3478"],
            "username": "000000002097466615",
            "credential": "XbNNDiAEa142/ZiNAhE8/Ab3qTQ=",
        ])
        return servers
    }

    // MARK: Signaling

    /// Send signaling DIRECTLY over the GetStream reserve (addressed by userId, not
    /// peerId). Used as the last-resort call transport when a peer can't be located
    /// on any node but both sides watch the deterministic per-pair channel — works
    /// over HTTPS, so it survives VPNs / UDP filtering that can sink the DHT.
    func sendViaStream(toUserId: String, type: String, payload: Any) async {
        guard streamReserveEnabled, !toUserId.isEmpty else { return }
        stream?.register(peerUserId: toUserId)
        await stream?.send(toUserId: toUserId, fromPeerId: peerId, type: type, payload: payload)
    }

    func sendSignal(toPeerId: String, toUserId: String, type: String, payload: Any) async {
        // Remember the peer so its backup channel is polled for replies.
        if !toUserId.isEmpty { stream?.register(peerUserId: toUserId) }
        do {
            try await post("signal", [
                "from": peerId, "to": toPeerId, "toUserId": toUserId,
                "roomId": node.roomId, "type": type, "payload": payload
            ])
        } catch {
            // Node path failed — fall back to the GetStream reserve transport, unless
            // the user opted out of it (then we stay fully serverless).
            if streamReserveEnabled {
                await stream?.send(toUserId: toUserId, fromPeerId: peerId, type: type, payload: payload)
            }
        }
    }

    private func pollLoop() async {
        while running {
            if node.baseURL != nil { await poll() }
            try? await Task.sleep(nanoseconds: 1_000_000_000)
        }
    }

    /// Keep the GetStream reserve bootstrapped (token from the node) and poll the
    /// backup channels for incoming signaling, so a peer whose own node is down can
    /// still reach us. Best-effort; never blocks the primary path.
    private func streamLoop() async {
        while running {
            guard streamReserveEnabled else {           // opted out → stay serverless
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                continue
            }
            if !streamReadyFlag, node.baseURL != nil {
                await stream?.bootstrap()
                streamReadyFlag = stream?.isEnabled ?? false
            }
            if streamReadyFlag {
                // Always watch every contact's backup channel for inbound signaling,
                // so a call/offer reaches us even if our node path is down or the
                // caller is registered on a different node.
                for uid in contactsProvider?() ?? [] where !uid.isEmpty {
                    stream?.register(peerUserId: uid)
                }
                await stream?.pollAll()
            }
            try? await Task.sleep(nanoseconds: 2_000_000_000)
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
