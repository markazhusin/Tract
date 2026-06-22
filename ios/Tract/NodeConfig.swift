import Foundation
import Combine

/// Automatic signaling-node discovery — the user never types a server URL.
/// The app pings a set of candidate nodes (built-in seeds + nodes it has learned)
/// and uses whichever is online. Any node that is up serves the whole network.
/// Literal zero-knowledge discovery is impossible, so we bootstrap from seeds and
/// grow the list by gossip; an optional manual override exists for power users.
final class NodeConfig: ObservableObject {
    @Published private(set) var activeURL: URL?
    @Published private(set) var statusText = "Поиск сети…"

    /// Optional advanced override. Empty by default — normal users ignore it.
    @Published var manualURL: String {
        didSet {
            UserDefaults.standard.set(manualURL, forKey: Self.manualKey)
            Task { await resolve() }
        }
    }

    let roomId = "tract-public"

    /// Built-in bootstrap entries — no hosting, no central seed. A node is found
    /// locally (same machine), or you add a live node's address (manual/QR): anyone
    /// can run `tract-node` anywhere and expose it anonymously (e.g. an
    /// `*.trycloudflare.com` tunnel or a Tor .onion). Learned nodes join via gossip.
    private static let seeds: [String] = [
        "http://127.0.0.1:8877"
    ]

    private static let manualKey = "tract.node.manual"
    private static let learnedKey = "tract.nodes.learned"

    private var learned: [String] {
        get { UserDefaults.standard.stringArray(forKey: Self.learnedKey) ?? [] }
        set { UserDefaults.standard.set(Array(Set(newValue)), forKey: Self.learnedKey) }
    }

    var baseURL: URL? { activeURL }
    var isConfigured: Bool { activeURL != nil }

    private let bonjour = BonjourDiscovery()

    init() {
        manualURL = UserDefaults.standard.string(forKey: Self.manualKey) ?? ""
        // Zero-config LAN discovery: any node advertising _tract._tcp nearby
        // (e.g. the desktop app) is learned and probed automatically.
        bonjour.onFound = { [weak self] url in
            guard let self else { return }
            if !self.learned.contains(url) { self.learned = self.learned + [url] }
            Task { await self.resolve() }
        }
        bonjour.start()
        Task { await resolveLoop() }
    }

    private func resolveLoop() async {
        while true {
            await resolve()
            try? await Task.sleep(nanoseconds: activeURL == nil ? 8_000_000_000 : 45_000_000_000)
        }
    }

    /// Probe all candidates; keep the current node if still healthy, else pick the
    /// fastest responding one.
    func resolve() async {
        var candidates: [String] = []
        let manual = manualURL.trimmingCharacters(in: .whitespaces)
        if !manual.isEmpty { candidates.append(manual) }
        if let active = activeURL?.absoluteString { candidates.append(active) }
        candidates.append(contentsOf: learned)
        candidates.append(contentsOf: Self.seeds)

        var seen = Set<String>()
        let unique = candidates.compactMap { Self.normalize($0) }.filter { seen.insert($0.absoluteString).inserted }

        let healthy = await withTaskGroup(of: (URL, TimeInterval)?.self) { group -> [(URL, TimeInterval)] in
            for url in unique {
                group.addTask { await Self.ping(url) }
            }
            var out: [(URL, TimeInterval)] = []
            for await r in group { if let r { out.append(r) } }
            return out
        }

        await MainActor.run {
            guard !healthy.isEmpty else {
                self.activeURL = nil
                self.statusText = "Сеть недоступна"
                return
            }
            // Prefer manual, then the current active (sticky), else lowest latency.
            let pick: URL
            if !manual.isEmpty, let m = healthy.first(where: { $0.0.absoluteString == Self.normalize(manual)?.absoluteString }) {
                pick = m.0
            } else if let cur = self.activeURL, healthy.contains(where: { $0.0 == cur }) {
                pick = cur
            } else {
                pick = healthy.min(by: { $0.1 < $1.1 })!.0
            }
            self.activeURL = pick
            self.statusText = "Подключено"
            self.learned = self.learned + [pick.absoluteString]
        }
    }

    private static func normalize(_ s: String) -> URL? {
        let t = s.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty else { return nil }
        let withScheme = t.hasPrefix("http://") || t.hasPrefix("https://") ? t : "https://\(t)"
        return URL(string: withScheme)
    }

    /// GET /health with a short timeout; returns latency if reachable.
    private static func ping(_ base: URL) async -> (URL, TimeInterval)? {
        var req = URLRequest(url: base.appendingPathComponent("health"))
        req.timeoutInterval = 4
        let start = Date()
        guard let (_, resp) = try? await URLSession.shared.data(for: req),
              let http = resp as? HTTPURLResponse, http.statusCode == 200 else { return nil }
        return (base, Date().timeIntervalSince(start))
    }
}
