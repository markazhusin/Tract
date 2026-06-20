import SwiftUI

struct RootView: View {
    @EnvironmentObject var identity: IdentityStore
    @EnvironmentObject var mesh: MeshService
    @EnvironmentObject var call: CallService
    @EnvironmentObject var node: NodeConfig

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()

            if identity.identity == nil {
                AuthView()
                    .transition(.opacity)
            } else {
                MainTabView()
                    .transition(.opacity)
            }

            if call.phase.isActive {
                CallOverlayView()
                    .zIndex(10)
            }
        }
        .animation(.easeInOut(duration: 0.25), value: identity.identity)
        .animation(.easeInOut(duration: 0.25), value: call.phase)
        .onAppear { call.configure(mesh: mesh, node: node) }
        .onChange(of: identity.identity) { newValue in
            if let id = newValue {
                mesh.start(identity: id)
                call.goOnline(id)
            } else {
                call.goOffline()
                mesh.stop()
            }
        }
    }
}
