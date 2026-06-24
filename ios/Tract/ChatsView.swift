import SwiftUI

struct ChatsView: View {
    @EnvironmentObject var mesh: MeshService
    @EnvironmentObject var loc: AppLanguage
    @State private var showAdd = false

    private var nearbySubtitle: AnyView? {
        guard mesh.peerCount > 0 else { return nil }   // no eternal "searching" — only real status
        return AnyView(
            HStack(spacing: 6) {
                Circle().fill(Theme.online).frame(width: 7, height: 7)
                Text("\(loc.t("nearby.count")) \(mesh.peerCount)").font(.system(size: 12.5)).foregroundStyle(Theme.muted)
            }
        )
    }

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()

            if mesh.contacts.isEmpty {
                VStack(spacing: 16) {
                    EmptyHint(icon: "bubble.left.and.bubble.right",
                              title: loc.t("chats.empty.title"),
                              subtitle: loc.t("chats.empty.sub"))
                    Button { showAdd = true } label: {
                        Label(loc.t("common.addById"), systemImage: "plus")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Theme.onAccent)
                            .padding(.horizontal, 18).padding(.vertical, 11)
                            .background(Theme.accent, in: Capsule())
                    }
                    .buttonStyle(.plain)
                }
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(mesh.contacts) { c in
                            NavigationLink(destination: ChatDetailView(contact: c)) {
                                ContactRow(contact: c)
                            }
                            .buttonStyle(.plain)
                            .contextMenu {
                                Button(role: .destructive) { mesh.deleteContact(c.userId) } label: {
                                    Label("Удалить чат", systemImage: "trash")
                                }
                            }
                            if c.id != mesh.contacts.last?.id {
                                RowDivider(leading: 79)
                            }
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.top, 8)
                    Color.clear.frame(height: 96)
                }
            }
        }
        .safeAreaInset(edge: .top) {
            ScreenHeader(title: loc.t("chats.title"), subtitle: nearbySubtitle) {
                CircleGlassButton(systemName: "square.and.pencil") { showAdd = true }
            }
        }
        .sheet(isPresented: $showAdd) { AddContactView() }
    }
}
