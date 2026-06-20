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

    func start() {
        // discoveryInfo is small; uid + compressed pubkey hex (66 chars) + name fit.
        let info = ["uid": userId, "name": displayName, "pk": publicKeyHex]
        let adv = MCNearbyServiceAdvertiser(peer: myPeerID, discoveryInfo: info, serviceType: Self.serviceType)
        adv.delegate = self
        adv.startAdvertisingPeer()
        advertiser = adv

        let br = MCNearbyServiceBrowser(peer: myPeerID, serviceType: Self.serviceType)
        br.delegate = self
        br.startBrowsingForPeers()
        browser = br
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
        notifyPeerCount()
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
        invitationHandler(true, session)
    }
}

extension MeshTransport: MCNearbyServiceBrowserDelegate {
    func browser(_ browser: MCNearbyServiceBrowser, foundPeer peerID: MCPeerID, withDiscoveryInfo info: [String : String]?) {
        if let uid = info?["uid"], !uid.isEmpty {
            let pk = info?["pk"] ?? ""
            let name = info?["name"] ?? peerID.displayName
            DispatchQueue.main.async { self.delegate?.mesh(self, didDiscover: uid, publicKeyHex: pk, name: name) }
        }
        // Deterministic tie-break so two peers don't invite each other at once.
        if myPeerID.displayName < peerID.displayName {
            browser.invitePeer(peerID, to: session, withContext: nil, timeout: 15)
        }
    }

    func browser(_ browser: MCNearbyServiceBrowser, lostPeer peerID: MCPeerID) {
        notifyPeerCount()
    }
}
