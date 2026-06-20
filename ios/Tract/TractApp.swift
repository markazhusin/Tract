import SwiftUI

@main
struct TractApp: App {
    @StateObject private var identity = IdentityStore()
    @StateObject private var mesh = MeshService()
    @StateObject private var call = CallService()
    @StateObject private var node = NodeConfig()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(identity)
                .environmentObject(mesh)
                .environmentObject(call)
                .environmentObject(node)
                .preferredColorScheme(.dark)
                .tint(Theme.accent)
        }
    }
}
