import SwiftUI

struct ChatsView: View {
    @EnvironmentObject var mesh: MeshService

    private var meshStatus: (text: String, color: Color) {
        if !mesh.running { return ("Меш выключен", Theme.muted) }
        if mesh.peerCount > 0 { return ("В сети рядом: \(mesh.peerCount)", Theme.online) }
        return ("Ищу устройства рядом…", Theme.warn)
    }

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()

            if mesh.contacts.isEmpty {
                EmptyHint(icon: "bubble.left.and.bubble.right",
                          title: "Нет чатов",
                          subtitle: "Чаты появятся, когда рядом окажется другое устройство Tract. Всё работает офлайн, через меш.")
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
                    CircleGlassButton(systemName: "square.and.pencil") {}
                }
            }
        }
    }
}
