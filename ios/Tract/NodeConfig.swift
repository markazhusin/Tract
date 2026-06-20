import Foundation
import Combine

/// Address of the signaling node (the "switchboard"). Self-hostable: run the Go
/// server anywhere (home laptop, VPS, later an OpenWRT router) and point the app
/// here. The node only relays opaque signaling — media/content stay P2P/E2E.
final class NodeConfig: ObservableObject {
    @Published var serverURL: String {
        didSet { UserDefaults.standard.set(serverURL, forKey: Self.key) }
    }

    /// Shared room so devices (incl. the web build) discover each other.
    let roomId = "tract-public"

    private static let key = "tract.node.url"

    init() {
        serverURL = UserDefaults.standard.string(forKey: Self.key) ?? ""
    }

    var isConfigured: Bool { baseURL != nil }

    var baseURL: URL? {
        let s = serverURL.trimmingCharacters(in: .whitespaces)
        guard !s.isEmpty else { return nil }
        let withScheme = s.hasPrefix("http://") || s.hasPrefix("https://") ? s : "https://\(s)"
        guard let u = URL(string: withScheme) else { return nil }
        return u
    }
}
