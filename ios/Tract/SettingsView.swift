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
    @FocusState private var urlFocused: Bool

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
        let net: (LinkState, String) = node.isConfigured ? (.on, "Узел задан") : (.off, "Укажите узел")
        return [
            TransportItem(icon: "dot.radiowaves.left.and.right", color: Theme.online,
                          title: "Локальный меш (Wi-Fi + Bluetooth)", status: m.1, state: m.0),
            TransportItem(icon: "phone.fill", color: Color(hex: "#36c5c0"),
                          title: "Звонки по мешу", status: meshCall.1, state: meshCall.0),
            TransportItem(icon: "phone.arrow.up.right.fill", color: Color(hex: "#5b9cf2"),
                          title: "Интернет-звонки (WebRTC)", status: net.1, state: net.0),
            TransportItem(icon: "antenna.radiowaves.left.and.right", color: Color(hex: "#5b9cf2"),
                          title: "Сигналинг-узел", status: net.1, state: net.0),
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

                        // Self-hosted signaling node (run the Go server anywhere).
                        VStack(alignment: .leading, spacing: 7) {
                            sectionTitle("Сигналинг-узел")
                            GroupCard {
                                HStack(spacing: 12) {
                                    Image(systemName: "server.rack")
                                        .font(.system(size: 16))
                                        .foregroundStyle(node.isConfigured ? Theme.online : Theme.muted)
                                        .frame(width: 24)
                                    TextField("https://адрес-узла или IP:порт", text: $node.serverURL)
                                        .font(.system(size: 15))
                                        .foregroundStyle(Theme.text)
                                        .textInputAutocapitalization(.never)
                                        .autocorrectionDisabled()
                                        .keyboardType(.URL)
                                        .focused($urlFocused)
                                        .submitLabel(.done)
                                        .onSubmit { urlFocused = false }
                                }
                                .padding(.horizontal, 14)
                                .padding(.vertical, 12)
                            }
                            Text("Свой узел для звонков/чатов по интернету. Подними Go-сервер (ноут, VPS, позже OpenWRT) и впиши адрес. Узел видит только зашифрованный сигналинг — медиа идёт P2P. Применяется при следующем входе.")
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
