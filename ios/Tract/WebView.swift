import SwiftUI
import WebKit

/// Hosts the existing Tract web UI (bundled under `web/`) in a WKWebView and
/// bridges it to the native offline mesh. The web app keeps all of its logic;
/// the only new thing is a transport that, inside this shell, carries packets
/// over MultipeerConnectivity instead of the internet.
struct WebView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let controller = WKUserContentController()
        controller.add(context.coordinator, name: "tractMesh")

        let config = WKWebViewConfiguration()
        config.userContentController = controller
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isOpaque = false
        webView.backgroundColor = .black
        if #available(iOS 16.4, *) { webView.isInspectable = true }

        context.coordinator.webView = webView
        context.coordinator.mesh.delegate = context.coordinator

        if let dir = Bundle.main.url(forResource: "web", withExtension: nil) {
            let indexURL = dir.appendingPathComponent("index.html")
            if FileManager.default.fileExists(atPath: indexURL.path) {
                webView.loadFileURL(indexURL, allowingReadAccessTo: dir)
                return webView
            }
        }
        webView.loadHTMLString(
            "<body style='font-family:-apple-system;color:#fff;background:#000;padding:24px'>" +
            "<h2>web/ not bundled</h2><p>Run <code>ios/sync-web.sh</code>, then rebuild.</p></body>",
            baseURL: nil
        )
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKScriptMessageHandler, MeshTransportDelegate {
        let mesh = MeshTransport()
        weak var webView: WKWebView?

        // JS → native
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any],
                  let kind = body["kind"] as? String else { return }
            switch kind {
            case "identify":
                mesh.setIdentity(userId: body["userId"] as? String ?? "",
                                 displayName: body["displayName"] as? String ?? "",
                                 publicKeyHex: body["publicKeyHex"] as? String ?? "")
            case "send":
                if let packet = body["packet"] as? String { mesh.broadcast(packet) }
            default:
                break
            }
        }

        // native → JS
        func mesh(_ mesh: MeshTransport, didReceive packetJSON: String, from peer: String) {
            let b64 = Data(packetJSON.utf8).base64EncodedString()
            let safePeer = peer.replacingOccurrences(of: "\"", with: "")
            let js = "window.__tractMeshDeliverB64 && window.__tractMeshDeliverB64(\"\(b64)\", \"\(safePeer)\")"
            DispatchQueue.main.async { self.webView?.evaluateJavaScript(js, completionHandler: nil) }
        }

        func mesh(_ mesh: MeshTransport, didChangePeerCount count: Int) {
            let js = "window.__tractMeshPeers && window.__tractMeshPeers(\(count))"
            DispatchQueue.main.async { self.webView?.evaluateJavaScript(js, completionHandler: nil) }
        }

        func mesh(_ mesh: MeshTransport, didDiscover userId: String, publicKeyHex: String, name: String) {
            let uid = jsString(userId)
            let pk = jsString(publicKeyHex)
            let nm = jsString(name)
            let js = "window.__tractMeshPeer && window.__tractMeshPeer(\(uid), \(pk), \(nm))"
            DispatchQueue.main.async { self.webView?.evaluateJavaScript(js, completionHandler: nil) }
        }

        /// Wrap a value as a safe JS string literal.
        private func jsString(_ s: String) -> String {
            let escaped = s
                .replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "\"", with: "\\\"")
                .replacingOccurrences(of: "\n", with: "\\n")
            return "\"\(escaped)\""
        }
    }
}
