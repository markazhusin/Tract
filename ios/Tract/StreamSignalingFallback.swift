import Foundation

/// Backup signaling over GetStream — a reserve transport for reliability/load when
/// the Tract node path (HTTP polling) is unavailable or saturated. It carries the
/// SAME messages (offer/answer/ICE/app_packet) as the node, JSON-wrapped inside a
/// Stream Chat message, exchanged in a deterministic per-pair channel.
///
/// The Stream API SECRET never reaches the client: the node mints a short per-user
/// JWT at `GET /getstream/token`, and we use that token + the public API key here.
/// Everything is best-effort — any failure simply means this reserve didn't fire;
/// the primary node path is unaffected. End-to-end content stays encrypted by the
/// app's own crypto, so Stream only ever relays ciphertext.
final class StreamSignalingFallback {
    private let base = URL(string: "https://chat.stream-io-api.com")!

    private let node: NodeConfig
    private let myUserId: String

    private var apiKey = ""
    private var token = ""
    private var streamUid = ""           // sanitised id the node minted the token for
    private var ready = false

    // Per-peer channel state: last seen message id, so polling only yields new ones.
    private var lastSeen: [String: String] = [:]
    // Peers we've interacted with — the set of channels to poll for incoming.
    private var peers: Set<String> = []

    /// Delivered on the main queue: (fromPeerId, type, payload) — same shape as the
    /// node's poll, so the call/chat layer handles both transports identically.
    var onSignal: ((String, String, Any) -> Void)?

    init(node: NodeConfig, myUserId: String) {
        self.node = node
        self.myUserId = myUserId
    }

    var isEnabled: Bool { ready }

    /// Remember a peer so its backup channel is polled for incoming messages.
    func register(peerUserId: String) {
        let p = peerUserId.trimmingCharacters(in: .whitespaces)
        if !p.isEmpty { peers.insert(p) }
    }

    /// Poll every known peer's backup channel once.
    func pollAll() async {
        for p in peers { await poll(peerUserId: p) }
    }

    /// Fetch the token/config from the node (the only place the secret lives).
    func bootstrap() async {
        guard let baseURL = node.baseURL,
              var comps = URLComponents(url: baseURL.appendingPathComponent("getstream/token"),
                                        resolvingAgainstBaseURL: false) else { return }
        comps.queryItems = [URLQueryItem(name: "userId", value: myUserId)]
        guard let url = comps.url,
              let (data, _) = try? await URLSession.shared.data(from: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              (obj["enabled"] as? Bool) == true,
              let key = obj["apiKey"] as? String,
              let tok = obj["token"] as? String,
              let uid = obj["userId"] as? String else { return }
        apiKey = key; token = tok; streamUid = uid; ready = true
    }

    // MARK: Channel naming

    /// Deterministic, order-independent channel id for a pair of users. Hashed so
    /// it always fits Stream's id charset/length regardless of the raw userIds.
    private func channelId(with peerUserId: String) -> String {
        let a = streamUid
        let b = sanitize(peerUserId)
        let pair = (a < b ? a + "|" + b : b + "|" + a)
        return "tract-" + djb2Hex(pair)
    }

    private func sanitize(_ s: String) -> String {
        String(s.lowercased().unicodeScalars.filter {
            ("a"..."z").contains(Character($0)) || ("0"..."9").contains(Character($0))
            || $0 == "@" || $0 == "_" || $0 == "-"
        }.map(Character.init))
    }

    private func djb2Hex(_ s: String) -> String {
        var h: UInt64 = 5381
        for b in s.utf8 { h = (h &* 33) ^ UInt64(b) }
        return String(h, radix: 16)
    }

    // MARK: Send

    /// Relay one signaling message through Stream. `toUserId` is required (Stream
    /// addressing is user-based, not peer-based).
    func send(toUserId: String, fromPeerId: String, type: String, payload: Any) async {
        guard ready, !toUserId.isEmpty else { return }
        let cid = channelId(with: toUserId)
        await ensureChannel(cid, peerUserId: toUserId)

        let envelope: [String: Any] = ["from": fromPeerId, "type": type, "payload": payload]
        guard let env = try? JSONSerialization.data(withJSONObject: envelope),
              let text = String(data: env, encoding: .utf8) else { return }
        _ = try? await post("channels/messaging/\(cid)/message",
                            ["message": ["text": text]])
    }

    /// Create/ensure the messaging channel exists with both members.
    private func ensureChannel(_ cid: String, peerUserId: String) async {
        _ = try? await post("channels/messaging/\(cid)/query", [
            "state": true, "watch": false, "presence": false,
            "data": ["members": [streamUid, sanitize(peerUserId)]],
        ])
    }

    // MARK: Receive (polling)

    /// Poll a peer's channel for messages newer than the last we saw and surface
    /// any that weren't sent by us.
    func poll(peerUserId: String) async {
        guard ready, !peerUserId.isEmpty else { return }
        let cid = channelId(with: peerUserId)
        var messages: [String: Any] = ["limit": 30]
        if let last = lastSeen[cid] { messages["id_gt"] = last }

        guard let obj = try? await post("channels/messaging/\(cid)/query", [
            "state": true, "watch": false, "presence": false,
            "messages": messages,
        ]), let msgs = obj["messages"] as? [[String: Any]] else { return }

        for m in msgs {
            if let id = m["id"] as? String { lastSeen[cid] = id }
            // Skip our own echoes.
            if let user = m["user"] as? [String: Any], (user["id"] as? String) == streamUid { continue }
            guard let text = m["text"] as? String,
                  let data = text.data(using: .utf8),
                  let env = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let from = env["from"] as? String,
                  let type = env["type"] as? String else { continue }
            let payload = env["payload"] ?? [:]
            await MainActor.run { self.onSignal?(from, type, payload) }
        }
    }

    // MARK: HTTP

    @discardableResult
    private func post(_ path: String, _ body: [String: Any]) async throws -> [String: Any]? {
        guard var comps = URLComponents(url: base.appendingPathComponent(path),
                                        resolvingAgainstBaseURL: false) else { return nil }
        comps.queryItems = [URLQueryItem(name: "api_key", value: apiKey)]
        guard let url = comps.url else { return nil }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(token, forHTTPHeaderField: "Authorization")
        req.setValue("jwt", forHTTPHeaderField: "Stream-Auth-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        req.timeoutInterval = 10
        let (data, _) = try await URLSession.shared.data(for: req)
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }
}
