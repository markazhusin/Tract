import Foundation
import UIKit
import MultipeerConnectivity

/// Receives events from the offline mesh and forwards them to the web layer.
protocol MeshTransportDelegate: AnyObject {
    /// Raw bytes arrived from a nearby device (tagged: message / call-control / audio).
    func mesh(_ mesh: MeshTransport, didReceive data: Data, from peer: String)
    /// The number of directly-connected mesh peers changed.
    func mesh(_ mesh: MeshTransport, didChangePeerCount count: Int)
    /// A nearby device was discovered, advertising its app identity + public key.
    func mesh(_ mesh: MeshTransport, didDiscover userId: String, publicKeyHex: String, name: String)
    /// A peer just connected — a chance to flush the courier (store-and-forward) queue.
    func meshDidConnectPeer(_ mesh: MeshTransport)
    /// Advertising/browsing could not start — almost always the iOS "Local Network"
    /// permission being denied. Surfaced so the UI can tell the user to grant it
    /// instead of silently spinning "Поиск…" forever.
    func mesh(_ mesh: MeshTransport, didFailWith reason: String)
}

/// Infrastructure-less device-to-device transport built on MultipeerConnectivity,
/// which uses peer-to-peer Wi-Fi (AWDL) and Bluetooth — so it works with the
/// internet OFF and with no server. The app's packets are already encrypted to
/// the recipient's key, so we just flood them to every nearby device and let the
/// crypto decide who can read them. That is the mesh: каждое устройство — узел.
final class MeshTransport: NSObject {
    /// Bonjour-style service id: 1–15 chars, lowercase letters/digits/hyphen.
    static let serviceType = "tract-mesh"

    weak var delegate: MeshTransportDelegate?

    private let myPeerID: MCPeerID
    private let session: MCSession
    private var advertiser: MCNearbyServiceAdvertiser?
    private var browser: MCNearbyServiceBrowser?

    private(set) var userId: String = ""
    private(set) var displayName: String = ""
    private(set) var publicKeyHex: String = ""

    /// Number of peers with a live, connected mesh session right now. Routing keys
    /// off this (not stale discovery flags) so we never "send into the void" when a
    /// nearby device was discovered but its Bluetooth/Wi-Fi session has since dropped.
    var connectedPeerCount: Int { session.connectedPeers.count }

    /// Stealth: don't advertise our identity (we won't appear as a nearby contact),
    /// but keep connecting + relaying — an invisible courier node.
    var stealth: Bool = false

    override init() {
        // Multipeer peer name is just a device label; the real identity is the
        // app-level userId advertised in discoveryInfo.
        let label = String(UIDevice.current.name.prefix(63))
        myPeerID = MCPeerID(displayName: label.isEmpty ? "tract" : label)
        session = MCSession(peer: myPeerID, securityIdentity: nil, encryptionPreference: .required)
        super.init()
        session.delegate = self
    }

    /// Called when the web app reports who is logged in. (Re)starts discovery so
    /// nearby devices see our userId.
    func setIdentity(userId: String, displayName: String, publicKeyHex: String) {
        self.userId = userId
        self.displayName = displayName
        self.publicKeyHex = publicKeyHex
        restart()
    }

    /// Toggle stealth at runtime (re-advertises without/with our identity).
    func setStealth(_ on: Bool) {
        guard stealth != on else { return }
        stealth = on
        if advertiser != nil { restart() }
    }

    func start() {
        // In stealth we still advertise the service (so peers connect and we can
        // relay) but WITHOUT our identity, so we don't show up as a contact.
        let info: [String: String] = stealth
            ? ["r": "1"]
            : ["uid": userId, "name": displayName, "pk": publicKeyHex]
        let adv = MCNearbyServiceAdvertiser(peer: myPeerID, discoveryInfo: info, serviceType: Self.serviceType)
        adv.delegate = self
        adv.startAdvertisingPeer()
        advertiser = adv

        let br = MCNearbyServiceBrowser(peer: myPeerID, serviceType: Self.serviceType)
        br.delegate = self
        br.startBrowsingForPeers()
        browser = br
        NSLog("[Mesh] start: advertising+browsing '\(Self.serviceType)' as '\(myPeerID.displayName)' uid=\(userId) stealth=\(stealth)")
    }

    func stop() {
        advertiser?.stopAdvertisingPeer()
        browser?.stopBrowsingForPeers()
        advertiser = nil
        browser = nil
    }

    private func restart() {
        stop()
        start()
    }

    /// Flood raw bytes to every connected peer. `.reliable` for messages/control,
    /// `.unreliable` for real-time audio (drop late packets instead of stalling).
    func broadcast(_ data: Data, reliable: Bool = true) {
        let peers = session.connectedPeers
        guard !peers.isEmpty else { return }
        do {
            try session.send(data, toPeers: peers, with: reliable ? .reliable : .unreliable)
        } catch {
            NSLog("[Mesh] send error: \(error)")
        }
    }

    private func notifyPeerCount() {
        let count = session.connectedPeers.count
        DispatchQueue.main.async { self.delegate?.mesh(self, didChangePeerCount: count) }
    }
}

extension MeshTransport: MCSessionDelegate {
    func session(_ session: MCSession, peer peerID: MCPeerID, didChange state: MCSessionState) {
        NSLog("[Mesh] peer \(peerID.displayName) state=\(state.rawValue) (0=notConn 1=conn… 2=connected)")
        notifyPeerCount()
        if state == .connected {
            DispatchQueue.main.async { self.delegate?.meshDidConnectPeer(self) }
        }
    }

    func session(_ session: MCSession, didReceive data: Data, fromPeer peerID: MCPeerID) {
        DispatchQueue.main.async { self.delegate?.mesh(self, didReceive: data, from: peerID.displayName) }
    }

    func session(_ session: MCSession, didReceive stream: InputStream, withName streamName: String, fromPeer peerID: MCPeerID) {}
    func session(_ session: MCSession, didStartReceivingResourceWithName resourceName: String, fromPeer peerID: MCPeerID, with progress: Progress) {}
    func session(_ session: MCSession, didFinishReceivingResourceWithName resourceName: String, fromPeer peerID: MCPeerID, at localURL: URL?, withError error: Error?) {}
}

extension MeshTransport: MCNearbyServiceAdvertiserDelegate {
    func advertiser(_ advertiser: MCNearbyServiceAdvertiser,
                    didReceiveInvitationFromPeer peerID: MCPeerID,
                    withContext context: Data?,
                    invitationHandler: @escaping (Bool, MCSession?) -> Void) {
        // Open mesh: auto-accept. Readability is enforced by E2E encryption, not
        // by who we connect to.
        NSLog("[Mesh] invitation from \(peerID.displayName) → accept")
        invitationHandler(true, session)
    }

    func advertiser(_ advertiser: MCNearbyServiceAdvertiser, didNotStartAdvertisingPeer error: Error) {
        NSLog("[Mesh] ADVERTISE FAILED: \(error.localizedDescription)")
        DispatchQueue.main.async {
            self.delegate?.mesh(self, didFailWith: Self.explain(error))
        }
    }
}

extension MeshTransport: MCNearbyServiceBrowserDelegate {
    func browser(_ browser: MCNearbyServiceBrowser, foundPeer peerID: MCPeerID, withDiscoveryInfo info: [String : String]?) {
        NSLog("[Mesh] found peer \(peerID.displayName) info=\(info ?? [:])")
        if let uid = info?["uid"], !uid.isEmpty {
            let pk = info?["pk"] ?? ""
            let name = info?["name"] ?? peerID.displayName
            DispatchQueue.main.async { self.delegate?.mesh(self, didDiscover: uid, publicKeyHex: pk, name: name) }
        }
        // Deterministic tie-break so the two peers don't invite each other at once.
        // MUST NOT use MCPeerID.displayName: on iOS 16+ UIDevice.current.name is the
        // generic "iPhone" for every device, so two phones tie and NEITHER invites →
        // they never connect. Compare the app-level userId instead (globally unique).
        // If the peer is in stealth (no advertised uid) we can't compare, so we just
        // invite — better a possible double-invite than no connection.
        let peerUid = info?["uid"] ?? ""
        let shouldInvite = peerUid.isEmpty ? true : (userId < peerUid)
        if shouldInvite {
            NSLog("[Mesh] inviting \(peerID.displayName) (myUid=\(userId) peerUid=\(peerUid))")
            browser.invitePeer(peerID, to: session, withContext: nil, timeout: 15)
        }
    }

    func browser(_ browser: MCNearbyServiceBrowser, lostPeer peerID: MCPeerID) {
        NSLog("[Mesh] lost peer \(peerID.displayName)")
        notifyPeerCount()
    }

    func browser(_ browser: MCNearbyServiceBrowser, didNotStartBrowsingForPeers error: Error) {
        NSLog("[Mesh] BROWSE FAILED: \(error.localizedDescription)")
        DispatchQueue.main.async {
            self.delegate?.mesh(self, didFailWith: Self.explain(error))
        }
    }

    /// Turn an MC error into a short Russian hint. The common one by far is the
    /// Local Network permission being off.
    static func explain(_ error: Error) -> String {
        let d = error.localizedDescription.lowercased()
        if d.contains("local network") || d.contains("not permitted") || d.contains("permission") {
            return "Нет доступа к локальной сети. Настройки iOS → Tract → «Локальная сеть» → включить."
        }
        return "Меш не запустился: \(error.localizedDescription)"
    }
}
