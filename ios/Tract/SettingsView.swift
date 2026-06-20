import SwiftUI

struct TransportItem {
    let icon: String
    let color: Color
    let title: String
    let status: String
    let state: LinkState
}

struct SettingsView: View {
    @EnvironmentObject var identity: IdentityStore
    @EnvironmentObject var mesh: MeshService
    @EnvironmentObject var node: NodeConfig
    @State private var confirmDelete = false

    private var id: Identity? { identity.identity }

    private var meshState: (LinkState, String) {
        if !mesh.running { return (.off, "Выключен") }
        if mesh.peerCount > 0 { return (.on, "\(mesh.peerCount) рядом") }
        return (.error, "Поиск…")
    }

    private var transports: [TransportItem] {
        let m = meshState
        let meshCall: (LinkState, String) = mesh.peerCount > 0
            ? (.on, "Готов") : (mesh.running ? (.error, "Ждёт пира") : (.off, "Выключен"))
        let net: (LinkState, String) = node.isConfigured ? (.on, "Подключён") : (.dev, "Поиск узла…")
        return [
            TransportItem(icon: "dot.radiowaves.left.and.right", color: Theme.online,
                          title: "Локальный меш (Wi-Fi + Bluetooth)", status: m.1, state: m.0),
            TransportItem(icon: "phone.fill", color: Color(hex: "#36c5c0"),
                          title: "Звонки по мешу", status: meshCall.1, state: meshCall.0),
            TransportItem(icon: "phone.arrow.up.right.fill", color: Color(hex: "#5b9cf2"),
                          title: "Интернет-звонки (WebRTC)", status: net.1, state: net.0),
            TransportItem(icon: "antenna.radiowaves.left.and.right", color: Color(hex: "#5b9cf2"),
                          title: "Интернет (соединение)", status: net.1, state: net.0),
            TransportItem(icon: "globe", color: Color(hex: "#f2a35b"),
                          title: "Интернет-чаты + доставка офлайн", status: "В разработке", state: .dev),
            TransportItem(icon: "video.fill", color: Color(hex: "#c77dff"),
                          title: "Видеозвонки", status: "В разработке", state: .dev),
            TransportItem(icon: "dot.radiowaves.right", color: Color(hex: "#c77dff"),
                          title: "Bluetooth LE (дальний, прямой)", status: "В разработке", state: .dev),
            TransportItem(icon: "bell.badge.fill", color: Color(hex: "#f2a35b"),
                          title: "Пуш / звонок на закрытое прил.", status: "В разработке", state: .dev),
        ]
    }

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            ScrollView {
                    VStack(spacing: 18) {
                        profileHeader

                        // Transports — the heart of the app: which links can carry packets.
                        VStack(alignment: .leading, spacing: 7) {
                            sectionTitle("Транспорты")
                            GroupCard {
                                ForEach(Array(transports.enumerated()), id: \.offset) { idx, t in
                                    TransportRow(icon: t.icon, iconColor: t.color,
                                                 title: t.title, status: t.status, state: t.state)
                                    if idx != transports.count - 1 { RowDivider() }
                                }
                            }
                            Text("Маршрут выбирается автоматически: рядом → меш (Wi-Fi/Bluetooth, без сервера, мин. задержка); иначе → интернет P2P; не пробилось → ретранслятор. Каждое устройство — узел: и клиент, и сервер одновременно.")
                                .font(.system(size: 12.5))
                                .foregroundStyle(Theme.muted)
                                .padding(.horizontal, 6)
                        }

                        // Network status — fully automatic; no server details shown.
                        VStack(alignment: .leading, spacing: 7) {
                            sectionTitle("Сеть")
                            GroupCard {
                                HStack(spacing: 12) {
                                    Image(systemName: node.isConfigured ? "wifi" : "wifi.slash")
                                        .font(.system(size: 16))
                                        .foregroundStyle(node.isConfigured ? Theme.online : Theme.muted)
                                        .frame(width: 24)
                                    Text(node.isConfigured ? "Подключено" : node.statusText)
                                        .font(.system(size: 16))
                                        .foregroundStyle(Theme.text)
                                    Spacer()
                                    if !node.isConfigured { ProgressView().controlSize(.small) }
                                }
                                .padding(.horizontal, 14)
                                .padding(.vertical, 13)
                            }
                            Text("Связь по интернету подключается автоматически — настраивать ничего не нужно. Содержимое сообщений и звонков идёт напрямую и зашифровано (E2E).")
                                .font(.system(size: 12.5))
                                .foregroundStyle(Theme.muted)
                                .padding(.horizontal, 6)
                        }

                        VStack(spacing: 0) {
                            GroupCard {
                                SettingsRow(icon: "person.crop.circle", iconColor: Color(hex: "#e56565"), title: "Мой профиль")
                                RowDivider()
                                SettingsRow(icon: "key.fill", iconColor: Color(hex: "#c77dff"), title: "Мой ID", value: id?.userId, showChevron: false)
                            }
                        }

                        GroupCard {
                            Button { identity.lock() } label: {
                                SettingsRow(icon: "lock.fill", iconColor: Theme.muted, title: "Заблокировать", showChevron: false)
                            }.buttonStyle(.plain)
                            RowDivider()
                            Button { confirmDelete = true } label: {
                                HStack {
                                    Text("Удалить аккаунт")
                                        .font(.system(size: 17))
                                        .foregroundStyle(Theme.danger)
                                    Spacer()
                                }
                                .padding(.horizontal, 14).padding(.vertical, 12)
                                .contentShape(Rectangle())
                            }.buttonStyle(.plain)
                        }

                        Color.clear.frame(height: 96)
                    }
                    .padding(.horizontal, 14)
                    .padding(.top, 8)
                }
        }
        .safeAreaInset(edge: .top) {
            ScreenHeader(title: "Настройки")
        }
            .alert("Удалить аккаунт?", isPresented: $confirmDelete) {
                Button("Отмена", role: .cancel) {}
                Button("Удалить", role: .destructive) { identity.deleteAccount() }
            } message: {
                Text("Ключ будет стёрт с устройства без возможности восстановления.")
            }
    }

    private var profileHeader: some View {
        VStack(spacing: 12) {
            Avatar(name: id?.displayName ?? "?", seed: id?.userId ?? "", size: 96)
            Text(id?.displayName ?? "—")
                .font(.system(size: 24, weight: .bold))
                .foregroundStyle(Theme.text)
            HStack(spacing: 7) {
                Image(systemName: "checkmark.shield.fill")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.accent)
                Text(id?.userId ?? "")
                    .font(.system(size: 15))
                    .foregroundStyle(Theme.muted)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 16)
    }

    private func sectionTitle(_ t: String) -> some View {
        Text(t.uppercased())
            .font(.system(size: 12.5, weight: .semibold))
            .foregroundStyle(Theme.muted)
            .padding(.horizontal, 6)
    }
}
