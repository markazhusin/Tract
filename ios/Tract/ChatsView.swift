import SwiftUI

struct ChatsView: View {
    @EnvironmentObject var mesh: MeshService
    @State private var showAdd = false

    private var meshStatus: (text: String, color: Color) {
        if !mesh.running { return ("Меш выключен", Theme.muted) }
        if mesh.peerCount > 0 { return ("В сети рядом: \(mesh.peerCount)", Theme.online) }
        return ("Ищу устройства рядом…", Theme.warn)
    }

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()

            if mesh.contacts.isEmpty {
                VStack(spacing: 16) {
                    EmptyHint(icon: "bubble.left.and.bubble.right",
                              title: "Нет чатов",
                              subtitle: "Добавьте контакт по ID (кнопка ✎ вверху) или дождитесь устройство рядом по мешу.")
                    Button { showAdd = true } label: {
                        Label("Добавить по ID", systemImage: "plus")
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
                            NavigationLink(value: c) {
                                ContactRow(contact: c)
                            }
                            .buttonStyle(.plain)
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
            ScreenHeader(
                title: "Чаты",
                subtitle: AnyView(
                    HStack(spacing: 6) {
                        Circle().fill(meshStatus.color).frame(width: 7, height: 7)
                        Text(meshStatus.text).font(.system(size: 12.5)).foregroundStyle(Theme.muted)
                    }
                )
            ) {
                HStack(spacing: 8) {
                    CircleGlassButton(systemName: "shield.lefthalf.filled") {}
                    CircleGlassButton(systemName: "square.and.pencil") { showAdd = true }
                }
            }
        }
        .sheet(isPresented: $showAdd) { AddContactView() }
    }
}
