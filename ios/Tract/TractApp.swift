import SwiftUI

@main
struct TractApp: App {
    @StateObject private var identity = IdentityStore()
    @StateObject private var mesh = MeshService()
    @StateObject private var call = CallService()
    @StateObject private var node = NodeConfig()
    @StateObject private var lock = AppLock()
    @StateObject private var notifications = NotificationService.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(identity)
                .environmentObject(mesh)
                .environmentObject(call)
                .environmentObject(node)
                .environmentObject(lock)
                .environmentObject(notifications)
                .preferredColorScheme(.dark)
                .tint(Theme.accent)
                .onAppear { notifications.requestAuthorization() }
                .onChange(of: scenePhase) { phase in
                    if phase == .background { lock.lockIfEnabled() }
                    if phase == .active { notifications.refreshAuthorization() }
                }
        }
    }
}
