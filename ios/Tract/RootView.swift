import SwiftUI

struct RootView: View {
    @EnvironmentObject var identity: IdentityStore
    @EnvironmentObject var mesh: MeshService
    @EnvironmentObject var call: CallService

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
        .onAppear { call.bind(to: mesh) }
        .onChange(of: identity.identity) { newValue in
            if let id = newValue {
                mesh.start(identity: id)
            } else {
                mesh.stop()
            }
        }
    }
}
