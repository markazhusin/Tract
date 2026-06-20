import Foundation
import Combine
import SwiftUI

// MARK: - Models

struct Contact: Identifiable, Equatable, Hashable, Codable {
    var id: String { userId }
    let userId: String
    var displayName: String
    var publicKeyHex: String
    var online: Bool
    var lastMessage: String
    var lastTime: Date?
    var unread: Int
}

struct ChatMessage: Identifiable, Equatable, Codable {
    var id = UUID()
    let text: String
    let fromMe: Bool
    let time: Date
}

enum LinkState {
    case on, off, error, dev

    var dot: Color {
        switch self {
        case .on: return Theme.online
        case .error: return Theme.danger
        case .dev: return Color(hex: "#5b9cf2")
        case .off: return Theme.muted
        }
    }
}

/// Transport hub. Carries E2E text over the local mesh (MultipeerConnectivity,
/// internet-OFF) AND over the internet via the signaling node (app_packet +
/// inbox, so messages deliver "when the peer comes online"). Contacts & messages
/// are persisted per-account so they survive restarts.
final class MeshService: ObservableObject, MeshTransportDelegate, AppTransport {
    @Published var contacts: [Contact] = []
    @Published var messages: [String: [ChatMessage]] = [:]
    @Published var peerCount: Int = 0
    @Published var running: Bool = false

    private let transport = MeshTransport()
    private(set) var identity: Identity?

    /// Set by RootView so the internet path knows the node.
    var node: NodeConfig?

    let internet = InternetTransport()
    private(set) lazy var router = TransportRouter([self, internet])

    /// Non-message frames are handed to the call layer (control + audio).
    var onControl: ((Data, String) -> Void)?
    var onAudio: ((Data, String) -> Void)?

    private var inboxRunning = false
    private var processedPacketIds = Set<String>()

    /// Stealth: invisible to nearby/network discovery, but still relays others'
    /// (encrypted) messages — an invisible courier node.
    @Published var stealth: Bool = UserDefaults.standard.bool(forKey: "tract.stealth") {
        didSet {
            UserDefaults.standard.set(stealth, forKey: "tract.stealth")
            transport.setStealth(stealth)
        }
    }

    // Multi-hop relay: dedup seen packets + a small "courier" store-and-forward
    // queue we flush to peers as they connect.
    private var seenMeshIds = Set<String>()
    private var seenOrder: [String] = []
    private struct CourierItem { let id: String; let frame: Data; let at: Date }
    private var courier: [CourierItem] = []
    private let meshTTL = 6

    private let myPeerId: String = {
        let k = "tract.peerId"
        if let s = UserDefaults.standard.string(forKey: k) { return s }
        let s = "ios-" + UUID().uuidString.prefix(8)
        UserDefaults.standard.set(String(s), forKey: k)
        return String(s)
    }()

    init() {
        transport.delegate = self
    }

    var totalUnread: Int { contacts.reduce(0) { $0 + $1.unread } }

    // MARK: Lifecycle

    func start(identity: Identity) {
        self.identity = identity
        running = true
        load(identity.userId)
        transport.stealth = stealth
        transport.setIdentity(userId: identity.userId,
                              displayName: identity.displayName,
                              publicKeyHex: identity.publicKeyHex)
        startInboxLoop()
    }

    func stop() {
        save()
        transport.stop()
        identity = nil
        running = false
        contacts = []
        messages = [:]
        peerCount = 0
        processedPacketIds = []
    }

    // MARK: Route (UI + send selection)

    /// Nearby mesh peer → local mesh (best); otherwise internet if a node is up.
    func route(for userId: String) -> RouteQuality {
        if running, let c = contacts.first(where: { $0.userId == userId }), c.online { return .localMesh }
        if node?.isConfigured == true { return .internetDirect }
        return .offline
    }

    // MARK: AppTransport (kept for the router; mesh-only)

    var kind: TransportKind { .localMesh }
    var isAvailable: Bool { running }
    func reachability(of userId: String) -> RouteQuality {
        if running, let c = contacts.first(where: { $0.userId == userId }), c.online { return .localMesh }
        return .offline
    }
    func send(_ framed: Data, to userId: String, reliable: Bool) {
        transport.broadcast(framed, reliable: reliable)
    }

    func messages(for contact: Contact) -> [ChatMessage] { messages[contact.userId] ?? [] }

    func markRead(_ userId: String) {
        guard let i = contacts.firstIndex(where: { $0.userId == userId }), contacts[i].unread != 0 else { return }
        contacts[i].unread = 0
        save()
    }

    // MARK: Contacts

    func addContact(userId: String, name: String, pubkeyHex: String, online: Bool) {
        upsert(userId: userId, name: name, pk: pubkeyHex, online: online)
        save()
    }

    func lookupContact(by raw: String, node: NodeConfig) async -> Bool {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.lowercased().hasPrefix("tract:") {
            let parts = trimmed.dropFirst(6).split(separator: ":")
            if parts.count >= 2 {
                let id = normalizeId(String(parts[0]))
                let pk = String(parts[1])
                await MainActor.run { self.addContact(userId: id, name: id, pubkeyHex: pk, online: false) }
                return true
            }
        }
        let id = normalizeId(trimmed)
        guard id.count > 1, let base = node.baseURL else { return false }
        if let (pk, name) = await fetchIdentity(base: base, id: id) {
            await MainActor.run { self.addContact(userId: id, name: name, pubkeyHex: pk, online: false) }
            return true
        }
        return false
    }

    private func normalizeId(_ s: String) -> String {
        var t = s.trimmingCharacters(in: .whitespaces).lowercased()
        if !t.isEmpty, !t.hasPrefix("@") { t = "@" + t }
        return t
    }

    private func fetchIdentity(base: URL, id: String) async -> (pubkey: String, name: String)? {
        guard let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else { return nil }
        var req = URLRequest(url: base.appendingPathComponent("identity").appendingPathComponent(encoded))
        req.timeoutInterval = 8
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              let http = resp as? HTTPURLResponse, http.statusCode == 200,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let blobStr = obj["identityBlob"] as? String,
              let blobData = blobStr.data(using: .utf8),
              let blob = try? JSONSerialization.jsonObject(with: blobData) as? [String: Any],
              let pk = blob["publicKeyHex"] as? String, !pk.isEmpty else { return nil }
        let name = (blob["displayName"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? id
        return (pk, name)
    }

    // MARK: Send text (mesh nearby, else internet)

    /// Returns false if the message could not be prepared (e.g. an incompatible
    /// contact key) so the UI can show an error instead of silently dropping it.
    @discardableResult
    func send(text: String, to contact: Contact) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let id = identity else { return false }
        guard let key = Crypto.sharedKey(my: id.privateKey, theirHex: contact.publicKeyHex),
              let box = Crypto.seal(trimmed, key: key) else {
            return false   // incompatible/invalid key (e.g. a secp256k1 web contact)
        }

        if route(for: contact.userId) == .localMesh {
            let pid = UUID().uuidString
            let packet: [String: Any] = [
                "id": pid, "to": contact.userId, "from": id.userId, "fromName": id.displayName,
                "fromPk": id.publicKeyHex, "box": box, "ttl": meshTTL
            ]
            if let data = try? JSONSerialization.data(withJSONObject: packet) {
                var framed = Data([UInt8(ascii: "M")]); framed.append(data)
                markSeen(pid)
                transport.broadcast(framed, reliable: true)
                courierEnqueue(id: pid, frame: framed)   // carry it to peers that connect later
            }
        } else {
            let userId = contact.userId
            Task { await self.sendAppPacket(toUserId: userId, box: box) }
        }

        append(ChatMessage(text: trimmed, fromMe: true, time: Date()), to: contact.userId, preview: trimmed, bumpUnread: false)
        save()
        return true
    }

    /// Mesh call signaling (invite / accept / decline / end).
    func sendControl(_ dict: [String: Any]) {
        guard let json = try? JSONSerialization.data(withJSONObject: dict) else { return }
        var framed = Data([UInt8(ascii: "C")]); framed.append(json)
        transport.broadcast(framed, reliable: true)
    }

    /// Mesh real-time audio frame — unreliable (low latency).
    func sendAudio(_ pcm: Data) {
        var framed = Data([UInt8(ascii: "A")]); framed.append(pcm)
        transport.broadcast(framed, reliable: false)
    }

    // MARK: Internet send/receive (signaling node: app_packet + inbox)

    private func sendAppPacket(toUserId: String, box: String) async {
        guard let id = identity, let base = node?.baseURL, let room = node?.roomId else { return }
        let payload: [String: Any] = ["type": "text", "senderId": id.userId, "fromPk": id.publicKeyHex, "box": box]
        let body: [String: Any] = ["from": myPeerId, "to": "", "toUserId": toUserId,
                                   "roomId": room, "type": "app_packet", "payload": payload]
        var req = URLRequest(url: base.appendingPathComponent("signal"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        req.timeoutInterval = 10
        _ = try? await URLSession.shared.data(for: req)
    }

    private func startInboxLoop() {
        guard !inboxRunning else { return }
        inboxRunning = true
        Task { await inboxLoop() }
    }

    private func inboxLoop() async {
        while running {
            await pullInbox()
            try? await Task.sleep(nanoseconds: 2_000_000_000)
        }
        inboxRunning = false
    }

    private func pullInbox() async {
        guard let id = identity, let base = node?.baseURL else { return }
        var req = URLRequest(url: base.appendingPathComponent("inbox/pull"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["userId": id.userId])
        req.timeoutInterval = 10
        guard let (data, _) = try? await URLSession.shared.data(for: req),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let entries = obj["messages"] as? [[String: Any]] else { return }

        var ackIds: [String] = []
        for entry in entries {
            guard let pid = entry["id"] as? String else { continue }
            ackIds.append(pid)
            if processedPacketIds.contains(pid) { continue }
            processedPacketIds.insert(pid)
            if let payload = entry["payload"] as? [String: Any] {
                await MainActor.run { self.handleAppPacket(payload) }
            }
        }
        if !ackIds.isEmpty { await ackInbox(ackIds, userId: id.userId, base: base) }
    }

    private func ackInbox(_ ids: [String], userId: String, base: URL) async {
        var req = URLRequest(url: base.appendingPathComponent("inbox/ack"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["userId": userId, "ids": ids])
        req.timeoutInterval = 10
        _ = try? await URLSession.shared.data(for: req)
    }

    private func handleAppPacket(_ payload: [String: Any]) {
        guard let id = identity,
              (payload["type"] as? String) == "text",
              let from = payload["senderId"] as? String, from != id.userId,
              let fromPk = payload["fromPk"] as? String,
              let box = payload["box"] as? String,
              let key = Crypto.sharedKey(my: id.privateKey, theirHex: fromPk),
              let text = Crypto.open(box, key: key) else { return }
        upsert(userId: from, name: from, pk: fromPk, online: false)
        append(ChatMessage(text: text, fromMe: false, time: Date()), to: from, preview: text, bumpUnread: true)
        save()
    }

    // MARK: MeshTransportDelegate (called on main)

    func mesh(_ mesh: MeshTransport, didReceive data: Data, from peer: String) {
        guard let tag = data.first else { return }
        let payload = Data(data.dropFirst())
        switch tag {
        case UInt8(ascii: "M"): handleMeshMessage(payload)
        case UInt8(ascii: "C"): onControl?(payload, peer)
        case UInt8(ascii: "A"): onAudio?(payload, peer)
        default: break
        }
    }

    private func handleMeshMessage(_ payload: Data) {
        guard let obj = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] else { return }
        let pid = obj["id"] as? String ?? ""
        if !pid.isEmpty {
            if seenMeshIds.contains(pid) { return }   // dedup: already handled/forwarded
            markSeen(pid)
        }

        let to = obj["to"] as? String ?? ""
        if let id = identity, to == id.userId {
            // Addressed to us: decrypt and show.
            guard let box = obj["box"] as? String, let fromPk = obj["fromPk"] as? String,
                  let from = obj["from"] as? String,
                  let key = Crypto.sharedKey(my: id.privateKey, theirHex: fromPk),
                  let text = Crypto.open(box, key: key) else { return }
            upsert(userId: from, name: obj["fromName"] as? String ?? from, pk: fromPk, online: true)
            append(ChatMessage(text: text, fromMe: false, time: Date()), to: from, preview: text, bumpUnread: true)
            save()
            return
        }

        // Not for us → relay (multi-hop "jumps") + carry as courier. We can't read
        // it (E2E), we just pass it along. Works even in stealth.
        var ttl = (obj["ttl"] as? Int) ?? Int((obj["ttl"] as? Double) ?? 0)
        guard ttl > 0 else { return }
        ttl -= 1
        var fwd = obj
        fwd["ttl"] = ttl
        if let data = try? JSONSerialization.data(withJSONObject: fwd) {
            var framed = Data([UInt8(ascii: "M")]); framed.append(data)
            transport.broadcast(framed, reliable: true)
            if !pid.isEmpty { courierEnqueue(id: pid, frame: framed) }
        }
    }

    // MARK: Relay helpers (dedup + courier store-and-forward)

    private func markSeen(_ id: String) {
        guard seenMeshIds.insert(id).inserted else { return }
        seenOrder.append(id)
        if seenOrder.count > 600 { seenMeshIds.remove(seenOrder.removeFirst()) }
    }

    private func courierEnqueue(id: String, frame: Data) {
        courier.removeAll { Date().timeIntervalSince($0.at) > 600 }   // keep 10 min
        guard !courier.contains(where: { $0.id == id }) else { return }
        courier.append(CourierItem(id: id, frame: frame, at: Date()))
        if courier.count > 80 { courier.removeFirst(courier.count - 80) }
    }

    func meshDidConnectPeer(_ mesh: MeshTransport) {
        courier.removeAll { Date().timeIntervalSince($0.at) > 600 }
        for item in courier { transport.broadcast(item.frame, reliable: true) }
    }

    func mesh(_ mesh: MeshTransport, didChangePeerCount count: Int) { peerCount = count }

    func mesh(_ mesh: MeshTransport, didDiscover userId: String, publicKeyHex: String, name: String) {
        guard userId != identity?.userId, !userId.isEmpty else { return }
        upsert(userId: userId, name: name, pk: publicKeyHex, online: true)
        save()
    }

    // MARK: Mutators

    private func upsert(userId: String, name: String, pk: String, online: Bool) {
        if let i = contacts.firstIndex(where: { $0.userId == userId }) {
            contacts[i].online = online
            if !name.isEmpty { contacts[i].displayName = name }
            if !pk.isEmpty { contacts[i].publicKeyHex = pk }
        } else {
            contacts.append(Contact(userId: userId, displayName: name.isEmpty ? userId : name,
                                    publicKeyHex: pk, online: online,
                                    lastMessage: "", lastTime: nil, unread: 0))
        }
    }

    private func append(_ message: ChatMessage, to userId: String, preview: String, bumpUnread: Bool) {
        messages[userId, default: []].append(message)
        if let i = contacts.firstIndex(where: { $0.userId == userId }) {
            contacts[i].lastMessage = preview
            contacts[i].lastTime = message.time
            if bumpUnread { contacts[i].unread += 1 }
        }
        contacts.sort { ($0.lastTime ?? .distantPast) > ($1.lastTime ?? .distantPast) }
    }

    // MARK: Persistence (per account)

    private struct Persisted: Codable { var contacts: [Contact]; var messages: [String: [ChatMessage]] }

    private func storeURL(_ userId: String) -> URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let safe = userId.replacingOccurrences(of: "@", with: "at-")
        return docs.appendingPathComponent("chat-\(safe).json")
    }

    private func save() {
        guard let id = identity else { return }
        let p = Persisted(contacts: contacts, messages: messages)
        if let data = try? JSONEncoder().encode(p) { try? data.write(to: storeURL(id.userId)) }
    }

    private func load(_ userId: String) {
        guard let data = try? Data(contentsOf: storeURL(userId)),
              let p = try? JSONDecoder().decode(Persisted.self, from: data) else { return }
        contacts = p.contacts
        messages = p.messages
    }
}
