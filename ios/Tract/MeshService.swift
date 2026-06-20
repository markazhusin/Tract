import Foundation
import Combine
import SwiftUI

// MARK: - Models

struct Contact: Identifiable, Equatable, Hashable {
    var id: String { userId }
    let userId: String
    var displayName: String
    var publicKeyHex: String
    var online: Bool
    var lastMessage: String
    var lastTime: Date?
    var unread: Int
}

struct ChatMessage: Identifiable, Equatable {
    let id = UUID()
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

/// Bridges the native MultipeerConnectivity mesh (MeshTransport) to SwiftUI.
/// Every device is both advertiser (server) and browser (client): a true p2p node.
/// Messages are E2E-encrypted here (X25519 → AES-GCM) before being flooded, so the
/// mesh just relays opaque boxes — only the addressee can decrypt. Works internet-OFF.
final class MeshService: ObservableObject, MeshTransportDelegate, AppTransport {
    @Published var contacts: [Contact] = []
    @Published var messages: [String: [ChatMessage]] = [:]
    @Published var peerCount: Int = 0
    @Published var running: Bool = false

    private let transport = MeshTransport()
    private(set) var identity: Identity?

    // Transport routing: mesh is transport #1; internet plugs in next.
    // (Router retains mesh for the app's lifetime — a benign, app-scoped cycle.)
    let internet = InternetTransport()
    private(set) lazy var router = TransportRouter([self, internet])

    /// Best route to a peer right now (for UI badges + send selection).
    func route(for userId: String) -> RouteQuality { router.bestRoute(to: userId).quality }

    // MARK: AppTransport (local mesh)

    var kind: TransportKind { .localMesh }
    var isAvailable: Bool { running }

    func reachability(of userId: String) -> RouteQuality {
        guard running else { return .offline }
        if let c = contacts.first(where: { $0.userId == userId }), c.online { return .localMesh }
        return .offline
    }

    func send(_ framed: Data, to userId: String, reliable: Bool) {
        // Mesh is a broadcast medium; crypto decides who can read it.
        transport.broadcast(framed, reliable: reliable)
    }

    /// Non-message frames are handed to the call layer (control + audio).
    var onControl: ((Data, String) -> Void)?
    var onAudio: ((Data, String) -> Void)?

    init() {
        transport.delegate = self
    }

    var totalUnread: Int { contacts.reduce(0) { $0 + $1.unread } }

    func start(identity: Identity) {
        self.identity = identity
        running = true
        transport.setIdentity(userId: identity.userId,
                              displayName: identity.displayName,
                              publicKeyHex: identity.publicKeyHex)
    }

    func stop() {
        transport.stop()
        identity = nil
        running = false
        contacts = []
        messages = [:]
        peerCount = 0
    }

    func messages(for contact: Contact) -> [ChatMessage] { messages[contact.userId] ?? [] }

    func markRead(_ userId: String) {
        guard let i = contacts.firstIndex(where: { $0.userId == userId }), contacts[i].unread != 0 else { return }
        contacts[i].unread = 0
    }

    func send(text: String, to contact: Contact) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let id = identity,
              let key = Crypto.sharedKey(my: id.privateKey, theirHex: contact.publicKeyHex),
              let box = Crypto.seal(trimmed, key: key) else { return }

        let packet: [String: String] = [
            "to": contact.userId,
            "from": id.userId,
            "fromName": id.displayName,
            "fromPk": id.publicKeyHex,
            "box": box
        ]
        if let data = try? JSONSerialization.data(withJSONObject: packet) {
            var framed = Data([UInt8(ascii: "M")])
            framed.append(data)
            // Let the router pick the best transport for this peer (mesh today).
            router.send(framed, to: contact.userId, reliable: true)
        }
        append(ChatMessage(text: trimmed, fromMe: true, time: Date()), to: contact.userId, preview: trimmed, bumpUnread: false)
    }

    /// Call signaling (invite / accept / decline / end) — reliable.
    func sendControl(_ dict: [String: Any]) {
        guard let json = try? JSONSerialization.data(withJSONObject: dict) else { return }
        var framed = Data([UInt8(ascii: "C")])
        framed.append(json)
        transport.broadcast(framed, reliable: true)
    }

    /// Real-time audio frame — unreliable (low latency).
    func sendAudio(_ pcm: Data) {
        var framed = Data([UInt8(ascii: "A")])
        framed.append(pcm)
        transport.broadcast(framed, reliable: false)
    }

    // MARK: MeshTransportDelegate (called on main)

    func mesh(_ mesh: MeshTransport, didReceive data: Data, from peer: String) {
        guard let tag = data.first else { return }
        let payload = Data(data.dropFirst())
        switch tag {
        case UInt8(ascii: "M"): handleMessage(payload)
        case UInt8(ascii: "C"): onControl?(payload, peer)
        case UInt8(ascii: "A"): onAudio?(payload, peer)
        default: break
        }
    }

    private func handleMessage(_ payload: Data) {
        guard let id = identity,
              let obj = try? JSONSerialization.jsonObject(with: payload) as? [String: String],
              obj["to"] == id.userId,
              let box = obj["box"],
              let fromPk = obj["fromPk"],
              let from = obj["from"],
              let key = Crypto.sharedKey(my: id.privateKey, theirHex: fromPk),
              let text = Crypto.open(box, key: key) else { return }

        upsert(userId: from, name: obj["fromName"] ?? from, pk: fromPk, online: true)
        append(ChatMessage(text: text, fromMe: false, time: Date()), to: from, preview: text, bumpUnread: true)
    }

    func mesh(_ mesh: MeshTransport, didChangePeerCount count: Int) {
        peerCount = count
    }

    func mesh(_ mesh: MeshTransport, didDiscover userId: String, publicKeyHex: String, name: String) {
        guard userId != identity?.userId, !userId.isEmpty else { return }
        upsert(userId: userId, name: name, pk: publicKeyHex, online: true)
    }

    // MARK: Helpers

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
}
