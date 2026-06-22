import Foundation
import Network

/// Finds Tract nodes on the local network via Bonjour/mDNS (`_tract._tcp`) and
/// reports each as an `http://host:port` URL — zero-config LAN entry-point
/// discovery, so the phone auto-connects to any node running nearby (e.g. the
/// desktop app) without typing an address. iOS 13+.
final class BonjourDiscovery {
    private var browser: NWBrowser?
    private let queue = DispatchQueue(label: "tract.bonjour")

    /// Delivered on the main queue as "http://host:port".
    var onFound: ((String) -> Void)?

    func start() {
        guard browser == nil else { return }
        let params = NWParameters()
        params.includePeerToPeer = true
        let b = NWBrowser(for: .bonjour(type: "_tract._tcp", domain: nil), using: params)
        b.browseResultsChangedHandler = { [weak self] results, _ in
            for r in results { self?.resolve(r.endpoint) }
        }
        b.stateUpdateHandler = { state in
            if case .failed = state { /* Wi-Fi off etc. — silently idle */ }
        }
        b.start(queue: queue)
        browser = b
    }

    func stop() {
        browser?.cancel()
        browser = nil
    }

    /// Resolve a Bonjour endpoint to host:port by briefly opening a connection.
    private func resolve(_ endpoint: NWEndpoint) {
        guard case .service = endpoint else { return }
        let conn = NWConnection(to: endpoint, using: .tcp)
        conn.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                if let path = conn.currentPath,
                   case let .hostPort(host, port) = path.remoteEndpoint {
                    let h = Self.hostString(host)
                    if !h.isEmpty {
                        let url = "http://\(h):\(port.rawValue)"
                        DispatchQueue.main.async { self?.onFound?(url) }
                    }
                }
                conn.cancel()
            case .failed, .cancelled:
                conn.cancel()
            default:
                break
            }
        }
        conn.start(queue: queue)
    }

    private static func hostString(_ host: NWEndpoint.Host) -> String {
        switch host {
        case .ipv4(let a):
            return "\(a)".components(separatedBy: "%").first ?? "\(a)"
        case .ipv6(let a):
            let s = "\(a)".components(separatedBy: "%").first ?? "\(a)"
            return "[\(s)]"
        case .name(let n, _):
            return n
        @unknown default:
            return ""
        }
    }
}
