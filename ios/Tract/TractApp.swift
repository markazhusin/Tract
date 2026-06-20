import SwiftUI

@main
struct TractApp: App {
    @StateObject private var identity = IdentityStore()
    @StateObject private var mesh = MeshService()
    @StateObject private var call = CallService()
    @StateObject private var node = NodeConfig()
    @StateObject private var lock = AppLock()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(identity)
                .environmentObject(mesh)
                .environmentObject(call)
                .environmentObject(node)
                .environmentObject(lock)
                .preferredColorScheme(.dark)
                .tint(Theme.accent)
                .onChange(of: scenePhase) { phase in
                    if phase == .background { lock.lockIfEnabled() }
                }
        }
    }
}
