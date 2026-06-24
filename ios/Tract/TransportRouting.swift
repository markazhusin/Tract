import SwiftUI

// MARK: - Transport kinds

enum TransportKind: String {
    case localMesh
    case internetP2P

    var title: String {
        switch self {
        case .localMesh: return L("route.localMesh")
        case .internetP2P: return L("route.internetP2P")
        }
    }
}

// MARK: - Route quality (higher = preferred: nearest/lowest-latency wins)

enum RouteQuality: Int, Comparable {
    case offline = 0
    case relay = 1          // via server relay (last resort)
    case internetDirect = 2 // P2P over the internet
    case localMesh = 3      // nearby Wi-Fi/Bluetooth — best latency, no server

    static func < (a: RouteQuality, b: RouteQuality) -> Bool { a.rawValue < b.rawValue }

    var label: String {
        switch self {
        case .offline: return L("route.offline")
        case .relay: return L("route.relay")
        case .internetDirect: return L("route.online")
        case .localMesh: return L("route.nearby")
        }
    }

    var color: Color {
        switch self {
        case .offline: return Theme.muted
        case .relay: return Theme.warn
        case .internetDirect: return Color(hex: "#5b9cf2")
        case .localMesh: return Theme.online
        }
    }

    var icon: String {
        switch self {
        case .offline: return "wifi.slash"
        case .relay: return "antenna.radiowaves.left.and.right"
        case .internetDirect: return "globe"
        case .localMesh: return "dot.radiowaves.left.and.right"
        }
    }
}

// MARK: - Transport abstraction

/// A way to reach peers. The router asks each transport how well it can reach a
/// given peer right now, then routes through the best available one.
protocol AppTransport: AnyObject {
    var kind: TransportKind { get }
    var isAvailable: Bool { get }
    func reachability(of userId: String) -> RouteQuality
    func send(_ framed: Data, to userId: String, reliable: Bool)
}

/// Internet P2P (signaling + WebRTC) is driven directly by the signaling and call
/// layers, not through this router, which routes the local mesh. This entry reports
/// unavailable so the router stays mesh-only.
final class InternetTransport: AppTransport {
    let kind: TransportKind = .internetP2P
    var isAvailable: Bool { false }
    func reachability(of userId: String) -> RouteQuality { .offline }
    func send(_ framed: Data, to userId: String, reliable: Bool) {}
}

/// Picks the best transport per peer by relevance/rationality: nearest and
/// lowest-latency first (local mesh), then internet P2P, then relay.
final class TransportRouter {
    private let transports: [AppTransport]

    init(_ transports: [AppTransport]) { self.transports = transports }

    func bestRoute(to userId: String) -> (kind: TransportKind?, quality: RouteQuality) {
        var best: (TransportKind?, RouteQuality) = (nil, .offline)
        for t in transports where t.isAvailable {
            let q = t.reachability(of: userId)
            if q > best.1 { best = (t.kind, q) }
        }
        return best
    }

    func send(_ framed: Data, to userId: String, reliable: Bool) {
        let candidate = transports
            .filter { $0.isAvailable && $0.reachability(of: userId) != .offline }
            .max { $0.reachability(of: userId) < $1.reachability(of: userId) }
        candidate?.send(framed, to: userId, reliable: reliable)
    }
}

// MARK: - Route badge (per-peer, shown in lists and chat header)

struct RouteBadge: View {
    let quality: RouteQuality
    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: quality.icon).font(.system(size: 10, weight: .bold))
            Text(quality.label).font(.system(size: 11.5, weight: .medium))
        }
        .foregroundStyle(quality.color)
    }
}
