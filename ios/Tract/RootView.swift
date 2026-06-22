import SwiftUI

struct RootView: View {
    @EnvironmentObject var identity: IdentityStore
    @EnvironmentObject var mesh: MeshService
    @EnvironmentObject var call: CallService
    @EnvironmentObject var node: NodeConfig
    @EnvironmentObject var lock: AppLock

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

            if lock.isLocked {
                LockView()
                    .transition(.opacity)
                    .zIndex(20)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: lock.isLocked)
        .animation(.easeInOut(duration: 0.25), value: identity.identity)
        .animation(.easeInOut(duration: 0.25), value: call.phase)
        .onAppear {
            mesh.node = node
            call.configure(mesh: mesh, node: node)
            // Cold launch with an already-restored account: Identity.init() loads it
            // synchronously, so onChange(of:identity) never fires and the transport
            // would otherwise never come up (mesh dead, calls offline). Bring it
            // online here. (start/goOnline are safe to re-run on later changes.)
            if let id = identity.identity, !mesh.running {
                mesh.start(identity: id)
                call.goOnline(id)
                DHTRendezvous.shared.start(identity: id)
            }
        }
        .onChange(of: identity.identity) { newValue in
            if let id = newValue {
                mesh.start(identity: id)
                call.goOnline(id)
                DHTRendezvous.shared.start(identity: id)
            } else {
                call.goOffline()
                mesh.stop()
                DHTRendezvous.shared.stop()
            }
        }
    }
}
