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
    /// When we last observed this contact online (mesh discovery). Drives the
    /// "был(а) …" last-seen subtitle. Optional → old saved data decodes fine.
    var lastSeen: Date? = nil
    /// When we last observed this contact reachable over the INTERNET (node peer
    /// registry or DHT presence beacon). Distinct from `online` (which is mesh-only)
    /// so "в сети" reflects the contact's real reachability, not just our own
    /// connectivity. Optional → old saved data decodes fine.
    var netSeen: Date? = nil
}

struct ChatMessage: Identifiable, Equatable, Codable {
    var id = UUID()
    var pid: String?      // wire packet id (for read receipts); optional for old data
    let text: String
    let fromMe: Bool
    let time: Date
    var read: Bool?       // outgoing: true once the recipient acked (✓✓)
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
    /// Devices seen nearby over the mesh. Being visible nearby is NOT being a
    /// contact — a contact exists only once explicitly added (or once you've
    /// actually exchanged a message). Not persisted; rebuilt from discovery.
    @Published var nearby: [Contact] = []
    @Published var messages: [String: [ChatMessage]] = [:]
    @Published var peerCount: Int = 0
    @Published var running: Bool = false
    /// Non-nil when the mesh failed to start (almost always the iOS Local Network
    /// permission being denied). Drives a fix-it hint in Settings.
    @Published var meshError: String? = nil

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
    private var presenceRunning = false
    private var processedPacketIds = Set<String>()

    /// Stealth: invisible to nearby/network discovery, but still relays others'
    /// (encrypted) messages — an invisible courier node.
    @Published var stealth: Bool = UserDefaults.standard.bool(forKey: "tract.stealth") {
        didSet {
            UserDefaults.standard.set(stealth, forKey: "tract.stealth")
            transport.setStealth(stealth)
        }
    }

    /// Opt-out for the third-party GetStream reserve signaling. On by default (it's a
    /// last-resort path for the narrow case of no node + a VPN filtering the DHT's
    /// UDP). Off → fully serverless: only mesh, self-hostable nodes, and the DHT.
    @Published var streamReserveEnabled: Bool = (UserDefaults.standard.object(forKey: "tract.streamReserve") as? Bool) ?? true {
        didSet { UserDefaults.standard.set(streamReserveEnabled, forKey: "tract.streamReserve") }
    }

    /// Nearby discovery on/off (the mesh). When off we don't advertise/browse.
    @Published var meshEnabled: Bool = (UserDefaults.standard.object(forKey: "tract.meshEnabled") as? Bool) ?? true {
        didSet {
            UserDefaults.standard.set(meshEnabled, forKey: "tract.meshEnabled")
            guard let id = identity else { return }
            if meshEnabled {
                transport.setIdentity(userId: id.userId, displayName: id.displayName, publicKeyHex: id.publicKeyHex)
            } else {
                transport.stop()
                peerCount = 0
            }
        }
    }

    // Multi-hop relay: dedup seen packets + a small "courier" store-and-forward
    // queue we flush to peers as they connect.
    private var seenMeshIds = Set<String>()
    private var seenOrder: [String] = []
    private var ackedPids = Set<String>()   // incoming msgs we've already sent a read receipt for
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
        meshError = nil
        load(identity.userId)
        transport.stealth = stealth
        if meshEnabled {
            transport.setIdentity(userId: identity.userId,
                                  displayName: identity.displayName,
                                  publicKeyHex: identity.publicKeyHex)
        }
        startInboxLoop()
        startPresenceLoop()
        wireDHT()
    }

    /// Feed the node-less DHT rendezvous our contacts (whose inboxes to poll) and
    /// receive offline text it pulls from our own inbox.
    private func wireDHT() {
        let dht = DHTRendezvous.shared
        dht.contactsProvider = { [weak self] in
            (self?.contacts ?? []).map { (userId: $0.userId, pub: $0.publicKeyHex) }
        }
        dht.onTextMessage = { [weak self] from, fromPk, text, pid in
            self?.receiveDHTText(from: from, fromPk: fromPk, text: text, pid: pid)
        }
    }

    /// Inbound offline text pulled from our DHT inbox (already decrypted by the
    /// rendezvous layer). Deduped on pid against what we've already shown.
    private func receiveDHTText(from: String, fromPk: String, text: String, pid: String) {
        if !pid.isEmpty {
            if processedPacketIds.contains(pid) { return }
            processedPacketIds.insert(pid)
        }
        upsert(userId: from, name: from, pk: fromPk, online: false)
        append(ChatMessage(pid: pid.isEmpty ? nil : pid, text: text, fromMe: false, time: Date()),
               to: from, preview: text, bumpUnread: true)
        save()
    }

    func stop() {
        save()
        transport.stop()
        identity = nil
        running = false
        contacts = []
        nearby = []
        messages = [:]
        peerCount = 0
        processedPacketIds = []
    }

    // MARK: Route (UI + send selection)

    /// How we can actually reach THIS contact right now. Nearby mesh peer with a
    /// live session → local mesh (best). Otherwise "в сети" only if we've observed
    /// the contact reachable over the internet recently (node registry / DHT beacon)
    /// — not merely because WE have connectivity. Else offline ("был(а) …").
    func route(for userId: String) -> RouteQuality {
        if running, let c = contacts.first(where: { $0.userId == userId }),
           c.online, transport.connectedPeerCount > 0 { return .localMesh }
        if let c = contacts.first(where: { $0.userId == userId }), let ns = c.netSeen,
           Date().timeIntervalSince(ns) < Self.presenceTTL { return .internetDirect }
        return .offline
    }

    /// A contact is considered "в сети" over the internet if observed within this
    /// window (presence is polled every ~12s; this gives a couple of misses' grace).
    private static let presenceTTL: TimeInterval = 75

    // MARK: AppTransport (kept for the router; mesh-only)

    var kind: TransportKind { .localMesh }
    var isAvailable: Bool { running }
    func reachability(of userId: String) -> RouteQuality {
        if running, let c = contacts.first(where: { $0.userId == userId }),
           c.online, transport.connectedPeerCount > 0 { return .localMesh }
        return .offline
    }
    func send(_ framed: Data, to userId: String, reliable: Bool) {
        transport.broadcast(framed, reliable: reliable)
    }

    func messages(for contact: Contact) -> [ChatMessage] { messages[contact.userId] ?? [] }

    /// User opened the chat: clear unread AND send read receipts (✓✓) for every
    /// incoming message we haven't acked yet — so "seen" lights up on the sender.
    func openedChat(_ userId: String) {
        if let i = contacts.firstIndex(where: { $0.userId == userId }) { contacts[i].unread = 0 }
        if let msgs = messages[userId] {
            for m in msgs where !m.fromMe {
                if let pid = m.pid, !pid.isEmpty, !ackedPids.contains(pid) {
                    ackedPids.insert(pid)
                    sendReceipt(to: userId, pid: pid)
                }
            }
        }
        save()
    }

    // MARK: Contacts

    func addContact(userId: String, name: String, pubkeyHex: String, online: Bool) {
        upsert(userId: userId, name: name, pk: pubkeyHex, online: online)
        save()
    }

    // MARK: Deletion

    func deleteMessage(_ id: UUID, in userId: String) {
        guard var arr = messages[userId] else { return }
        arr.removeAll { $0.id == id }
        messages[userId] = arr
        if let i = contacts.firstIndex(where: { $0.userId == userId }) {
            contacts[i].lastMessage = arr.last?.text ?? ""
            contacts[i].lastTime = arr.last?.time
        }
        save()
    }

    /// Remove a contact and its whole conversation.
    func deleteContact(_ userId: String) {
        messages[userId] = nil
        contacts.removeAll { $0.userId == userId }
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

        let pid = UUID().uuidString

        // Deliver over EVERY transport that's actually up, not just the "best" one —
        // the mesh flood is best-effort (a discovered peer may have dropped, or sits
        // several hops away), so we also push the same packet over the internet when
        // available. The recipient dedups on `pid`, so it shows exactly once. This is
        // why a message "проходит" even when Bluetooth is flaky.
        let meshUp = meshEnabled && transport.connectedPeerCount > 0

        if meshUp {
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
        }

        if node?.isConfigured == true {
            let userId = contact.userId
            Task { await self.sendAppPacket(toUserId: userId, box: box, pid: pid) }
        } else if DHTRendezvous.shared.ready {
            // No node — deliver into the recipient's DHT inbox (E2E, store-and-forward).
            // sendText re-encrypts with the X25519 shared key itself, so pass plaintext.
            let userId = contact.userId, pub = contact.publicKeyHex
            Task { await DHTRendezvous.shared.sendText(toUserId: userId, toPub: pub, text: trimmed, pid: pid) }
        }

        // If nothing is up the message is still stored (shown as sent ✓); it simply
        // can't leave the device until a path appears.
        append(ChatMessage(pid: pid, text: trimmed, fromMe: true, time: Date()), to: contact.userId, preview: trimmed, bumpUnread: false)
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

    private func sendAppPacket(toUserId: String, box: String, pid: String) async {
        guard let id = identity else { return }
        await postAppPacket(toUserId: toUserId, payload: [
            "type": "text", "senderId": id.userId, "fromPk": id.publicKeyHex, "box": box, "pid": pid
        ])
    }

    /// Read receipt back to the sender (✓✓). Sent as a message_control app_packet.
    private func sendReceipt(to userId: String, pid: String) {
        guard let id = identity, node?.isConfigured == true else { return }
        Task {
            await self.postAppPacket(toUserId: userId, payload: [
                "type": "message_control", "action": "read", "pid": pid, "senderId": id.userId
            ])
        }
    }

    private func postAppPacket(toUserId: String, payload: [String: Any]) async {
        guard let base = node?.baseURL, let room = node?.roomId else { return }
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

    // MARK: Presence (per-contact internet reachability)

    private func startPresenceLoop() {
        guard !presenceRunning else { return }
        presenceRunning = true
        Task { await presenceLoop() }
    }

    /// Poll each contact's real internet reachability so "в сети" reflects the
    /// CONTACT's presence, not our own connectivity. Two independent signals:
    ///   • the node's peer registry (`/peers/by-user`) — online if registered & not
    ///     hiding; carries the node's `lastSeen`.
    ///   • the DHT presence beacon (`isOnline`) — works node-lessly.
    /// Either one marks the contact reachable; both feed `lastSeen` for "был(а) …".
    private func presenceLoop() async {
        while running {
            let snapshot = contacts.map { (userId: $0.userId, pub: $0.publicKeyHex) }
            for c in snapshot {
                var online = false
                var seenAt: Date? = nil
                if let (isOn, ls) = await nodePresence(userId: c.userId) {
                    if isOn { online = true; seenAt = ls ?? Date() }
                }
                if !online, DHTRendezvous.shared.ready,
                   await DHTRendezvous.shared.isOnline(userId: c.userId) {
                    online = true; seenAt = Date()
                }
                if online {
                    await MainActor.run { self.markNetSeen(c.userId, at: seenAt ?? Date()) }
                }
            }
            try? await Task.sleep(nanoseconds: 12_000_000_000)
        }
        presenceRunning = false
    }

    /// Ask the node whether a user is currently registered. Returns nil if the node
    /// is unreachable (so we don't clobber presence), else (online, lastSeen).
    private func nodePresence(userId: String) async -> (online: Bool, lastSeen: Date?)? {
        guard let base = node?.baseURL, let room = node?.roomId,
              var comps = URLComponents(url: base.appendingPathComponent("peers/by-user/\(userId)"),
                                        resolvingAgainstBaseURL: false) else { return nil }
        comps.queryItems = [URLQueryItem(name: "roomId", value: room)]
        guard let url = comps.url else { return nil }
        var req = URLRequest(url: url); req.timeoutInterval = 8
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              let http = resp as? HTTPURLResponse, http.statusCode == 200,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        guard let peer = obj["peer"] as? [String: Any] else { return (false, nil) }
        let hidden = (peer["hideOnline"] as? Bool) ?? false
        if hidden { return (false, nil) }
        let ls = (peer["lastSeen"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue / 1000) }
        return (true, ls)
    }

    /// Record an internet-presence observation: drives "в сети" and "был(а) …".
    private func markNetSeen(_ userId: String, at date: Date) {
        guard let i = contacts.firstIndex(where: { $0.userId == userId }) else { return }
        contacts[i].netSeen = date
        if (contacts[i].lastSeen ?? .distantPast) < date { contacts[i].lastSeen = date }
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
        guard let id = identity, let from = payload["senderId"] as? String, from != id.userId else { return }
        let type = payload["type"] as? String

        // Read receipt from the recipient → mark our outgoing message ✓✓.
        if type == "message_control", payload["action"] as? String == "read",
           let pid = payload["pid"] as? String {
            markRead(pid: pid, in: from)
            return
        }

        guard type == "text",
              let fromPk = payload["fromPk"] as? String,
              let box = payload["box"] as? String,
              let key = Crypto.sharedKey(my: id.privateKey, theirHex: fromPk),
              let text = Crypto.open(box, key: key) else { return }
        upsert(userId: from, name: from, pk: fromPk, online: false)
        append(ChatMessage(pid: payload["pid"] as? String, text: text, fromMe: false, time: Date()),
               to: from, preview: text, bumpUnread: true)
        save()
    }

    private func markRead(pid: String, in contactUserId: String) {
        guard var arr = messages[contactUserId] else { return }
        var changed = false
        for i in arr.indices where arr[i].fromMe && arr[i].pid == pid && arr[i].read != true {
            arr[i].read = true
            changed = true
        }
        if changed { messages[contactUserId] = arr; save() }
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
            // Addressed to us: decrypt and show. Dedup on `pid` ACROSS transports
            // (mesh + node + DHT all share this set) so a message we receive over
            // two paths at once is shown exactly once.
            if !pid.isEmpty {
                if processedPacketIds.contains(pid) { return }
                processedPacketIds.insert(pid)
            }
            guard let box = obj["box"] as? String, let fromPk = obj["fromPk"] as? String,
                  let from = obj["from"] as? String,
                  let key = Crypto.sharedKey(my: id.privateKey, theirHex: fromPk),
                  let text = Crypto.open(box, key: key) else { return }
            upsert(userId: from, name: obj["fromName"] as? String ?? from, pk: fromPk, online: true)
            append(ChatMessage(pid: pid.isEmpty ? nil : pid, text: text, fromMe: false, time: Date()),
                   to: from, preview: text, bumpUnread: true)
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
        meshError = nil   // we clearly have local-network access — clear any stale hint
        courier.removeAll { Date().timeIntervalSince($0.at) > 600 }
        for item in courier { transport.broadcast(item.frame, reliable: true) }
    }

    func mesh(_ mesh: MeshTransport, didFailWith reason: String) {
        meshError = reason
    }

    func mesh(_ mesh: MeshTransport, didChangePeerCount count: Int) {
        peerCount = count
        // No mesh peers left → no contact is reachable nearby. Flip them offline
        // (their lastSeen keeps the last time we saw them) so the UI shows "был(а)".
        if count == 0 {
            var changed = false
            for i in contacts.indices where contacts[i].online {
                contacts[i].online = false
                changed = true
            }
            if changed { save() }
        }
    }

    func mesh(_ mesh: MeshTransport, didDiscover userId: String, publicKeyHex: String, name: String) {
        guard userId != identity?.userId, !userId.isEmpty else { return }
        // Already a contact → just refresh online/key. Otherwise it's a NEARBY
        // device (visible, but not a contact until added).
        if let i = contacts.firstIndex(where: { $0.userId == userId }) {
            contacts[i].online = true
            contacts[i].lastSeen = Date()
            if !publicKeyHex.isEmpty { contacts[i].publicKeyHex = publicKeyHex }
            if !name.isEmpty { contacts[i].displayName = name }
            save()
        } else {
            upsertNearby(userId: userId, name: name, pk: publicKeyHex)
        }
    }

    private func upsertNearby(userId: String, name: String, pk: String) {
        if let i = nearby.firstIndex(where: { $0.userId == userId }) {
            nearby[i].online = true
            if !name.isEmpty { nearby[i].displayName = name }
            if !pk.isEmpty { nearby[i].publicKeyHex = pk }
        } else {
            nearby.append(Contact(userId: userId, displayName: name.isEmpty ? userId : name,
                                  publicKeyHex: pk, online: true,
                                  lastMessage: "", lastTime: nil, unread: 0))
        }
    }

    /// Explicitly turn a nearby device into a contact (контакт = добавлен).
    func promoteToContact(_ userId: String) {
        guard let n = nearby.first(where: { $0.userId == userId }) else { return }
        upsert(userId: n.userId, name: n.displayName, pk: n.publicKeyHex, online: true)
        save()
    }

    // MARK: Mutators

    private func upsert(userId: String, name: String, pk: String, online: Bool) {
        nearby.removeAll { $0.userId == userId }   // a contact is no longer merely "nearby"
        if let i = contacts.firstIndex(where: { $0.userId == userId }) {
            contacts[i].online = online
            if online { contacts[i].lastSeen = Date() }
            if !name.isEmpty { contacts[i].displayName = name }
            if !pk.isEmpty { contacts[i].publicKeyHex = pk }
        } else {
            contacts.append(Contact(userId: userId, displayName: name.isEmpty ? userId : name,
                                    publicKeyHex: pk, online: online,
                                    lastMessage: "", lastTime: nil, unread: 0,
                                    lastSeen: online ? Date() : nil))
        }
    }

    private func append(_ message: ChatMessage, to userId: String, preview: String, bumpUnread: Bool) {
        messages[userId, default: []].append(message)
        var senderName = userId
        if let i = contacts.firstIndex(where: { $0.userId == userId }) {
            contacts[i].lastMessage = preview
            contacts[i].lastTime = message.time
            if bumpUnread { contacts[i].unread += 1 }
            senderName = contacts[i].displayName
        }
        contacts.sort { ($0.lastTime ?? .distantPast) > ($1.lastTime ?? .distantPast) }
        // Incoming message (not our own echo) → local notification, if enabled and
        // we're not already on screen. Centralised here so mesh + internet paths
        // both notify.
        if bumpUnread && !message.fromMe {
            NotificationService.shared.notifyMessage(from: senderName, text: preview)
        }
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
