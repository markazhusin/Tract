import SwiftUI

struct RootView: View {
    @EnvironmentObject var identity: IdentityStore
    @EnvironmentObject var mesh: MeshService
    @EnvironmentObject var call: CallService
    @EnvironmentObject var node: NodeConfig
    @EnvironmentObject var lock: AppLock
    @EnvironmentObject var loc: AppLanguage
    @State private var pendingInvite: String?

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()

            if !loc.chosen {
                // First launch: pick a language before anything else.
                LanguagePickerView()
                    .transition(.opacity)
                    .zIndex(30)
            } else if identity.identity == nil {
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
        .animation(.easeInOut(duration: 0.25), value: loc.chosen)
        .onOpenURL { url in
            // A `tract:<id>:<pk>` link (e.g. from scanning a QR with the system
            // camera) — add the contact. If not logged in yet, hold it until we are.
            let s = url.absoluteString
            if identity.identity != nil {
                Task { _ = await mesh.lookupContact(by: s, node: node) }
            } else {
                pendingInvite = s
            }
        }
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
                // Process a contact invite that arrived before login.
                if let inv = pendingInvite {
                    pendingInvite = nil
                    Task { _ = await mesh.lookupContact(by: inv, node: node) }
                }
            } else {
                call.goOffline()
                mesh.stop()
                DHTRendezvous.shared.stop()
            }
        }
    }
}
