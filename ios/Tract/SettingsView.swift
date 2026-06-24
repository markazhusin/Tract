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
    @EnvironmentObject var lock: AppLock
    @EnvironmentObject var notifications: NotificationService
    @EnvironmentObject var loc: AppLanguage
    @ObservedObject private var dht = DHTRendezvous.shared
    @State private var showPasscodeSetup = false
    @State private var showLanguage = false

    private var id: Identity? { identity.identity }

    private var meshState: (LinkState, String) {
        if !mesh.meshEnabled { return (.off, loc.t("settings.transport.off")) }
        if mesh.meshError != nil { return (.error, loc.t("settings.transport.noaccess")) }
        if !mesh.running { return (.off, loc.t("settings.transport.notrunning")) }
        if mesh.peerCount > 0 { return (.on, "\(mesh.peerCount) \(loc.t("settings.transport.nearbyCount"))") }
        return (.dev, loc.t("settings.transport.searching"))
    }

    // Transport is now exactly two real links — everything else (mesh calls,
    // internet calls, internet chats, relay) rides one of these two, so showing
    // them as separate rows was the same status repeated. One row per actual link.
    private var transports: [TransportItem] {
        let m = meshState
        // Internet works two ways: through a configured node, or node-lessly over the
        // BitTorrent DHT. Don't get stuck on "Поиск узла…" — the DHT path needs no node.
        let net: (LinkState, String)
        if node.isConfigured {
            net = (.on, loc.t("settings.transport.connectedNode"))
        } else if dht.ready {
            net = (.on, loc.t("settings.transport.viaDHT"))
        } else {
            net = (.dev, loc.t("settings.transport.connecting"))
        }
        return [
            TransportItem(icon: "dot.radiowaves.left.and.right", color: Theme.online,
                          title: loc.t("settings.transport.nearby"), status: m.1, state: m.0),
            TransportItem(icon: "globe", color: Color(hex: "#5b9cf2"),
                          title: loc.t("settings.transport.internet"), status: net.1, state: net.0),
        ]
    }

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            ScrollView {
                VStack(spacing: 18) {
                    profileHeader

                    // Транспорт — единственное место со статусом связи. Маршрут
                    // выбирается сам, поэтому здесь только два реальных канала.
                    VStack(alignment: .leading, spacing: 7) {
                        sectionTitle(loc.t("settings.section.transport"))
                        GroupCard {
                            ForEach(Array(transports.enumerated()), id: \.offset) { idx, t in
                                TransportRow(icon: t.icon, iconColor: t.color,
                                             title: t.title, status: t.status, state: t.state)
                                if idx != transports.count - 1 { RowDivider() }
                            }
                        }
                        if let err = mesh.meshError {
                            fixItBanner(icon: "wifi.exclamationmark", text: err) {
                                if let url = URL(string: UIApplication.openSettingsURLString) {
                                    UIApplication.shared.open(url)
                                }
                            }
                        }
                        if !node.isConfigured {
                            fixItBanner(icon: "antenna.radiowaves.left.and.right.slash",
                                        text: "Узел сети не найден. Без запущенной ноды (tract-node рядом в той же Wi-Fi или вручную) интернет-звонки и доставка офлайн недоступны — работает только связь рядом по мешу.",
                                        action: nil)
                        }
                        Text(loc.t("settings.transport.hint"))
                            .font(.system(size: 12.5))
                            .foregroundStyle(Theme.muted)
                            .padding(.horizontal, 6)
                    }

                    // Уведомления — раздельные переключатели для чатов и звонков.
                    VStack(alignment: .leading, spacing: 7) {
                        sectionTitle(loc.t("settings.section.notif"))
                        GroupCard {
                            toggleRow(icon: "bubble.left.fill", tint: Color(hex: "#36c5c0"),
                                      title: loc.t("settings.notif.messages"), isOn: $notifications.chatsEnabled)
                            RowDivider()
                            toggleRow(icon: "phone.fill", tint: Color(hex: "#5b9cf2"),
                                      title: loc.t("settings.notif.calls"), isOn: $notifications.callsEnabled)
                        }
                        Text(notifications.authorized
                             ? loc.t("settings.notif.on")
                             : loc.t("settings.notif.off"))
                            .font(.system(size: 12.5))
                            .foregroundStyle(Theme.muted)
                            .padding(.horizontal, 6)
                    }

                    // Приватность и сеть — раньше дублировалось в «шторке» на экране
                    // чатов; теперь единственное место.
                    VStack(alignment: .leading, spacing: 7) {
                        sectionTitle(loc.t("settings.section.privacy"))
                        GroupCard {
                            languageRow
                            RowDivider()
                            toggleRow(icon: "dot.radiowaves.left.and.right", tint: Theme.online,
                                      title: loc.t("settings.privacy.nearby"),
                                      subtitle: loc.t("settings.privacy.nearby.sub"),
                                      isOn: $mesh.meshEnabled)
                            RowDivider()
                            toggleRow(icon: "eye.slash.fill", tint: Color(hex: "#c77dff"),
                                      title: loc.t("settings.privacy.stealth"),
                                      subtitle: loc.t("settings.privacy.stealth.sub"),
                                      isOn: $mesh.stealth)
                            RowDivider()
                            toggleRow(icon: "arrow.triangle.2.circlepath", tint: Color(hex: "#f4a259"),
                                      title: loc.t("settings.privacy.reserve"),
                                      subtitle: loc.t("settings.privacy.reserve.sub"),
                                      isOn: $mesh.streamReserveEnabled)
                            RowDivider()
                            HStack(spacing: 13) {
                                RoundedRectangle(cornerRadius: 8, style: .continuous)
                                    .fill(Color(hex: "#5b9cf2")).frame(width: 30, height: 30)
                                    .overlay(Image(systemName: "lock.fill")
                                        .font(.system(size: 15, weight: .semibold)).foregroundStyle(.white))
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(loc.t("settings.privacy.passcode")).font(.system(size: 17)).foregroundStyle(Theme.text)
                                    Text(loc.t("settings.privacy.passcode.sub"))
                                        .font(.system(size: 12.5)).foregroundStyle(Theme.muted)
                                }
                                Spacer(minLength: 8)
                                Toggle("", isOn: Binding(
                                    get: { lock.isEnabled },
                                    set: { on in if on { showPasscodeSetup = true } else { lock.disable() } }
                                )).labelsHidden().tint(Theme.accent)
                            }
                            .padding(.horizontal, 14).padding(.vertical, 11)
                        }
                    }

                    // Аккаунт — ID живёт только здесь, внутри «Мой профиль».
                    GroupCard {
                        NavigationLink(destination: ProfileView()) {
                            SettingsRow(icon: "person.crop.circle", iconColor: Color(hex: "#e56565"), title: loc.t("settings.profile"))
                        }
                        .buttonStyle(.plain)
                        RowDivider()
                        Button { identity.lock() } label: {
                            SettingsRow(icon: "lock.fill", iconColor: Theme.muted, title: loc.t("settings.lock"), showChevron: false)
                        }.buttonStyle(.plain)
                    }

                    Color.clear.frame(height: 96)
                }
                .padding(.horizontal, 14)
                .padding(.top, 8)
            }
        }
        .safeAreaInset(edge: .top) {
            ScreenHeader(title: loc.t("settings.title"))
        }
        .sheet(isPresented: $showPasscodeSetup) { PasscodeSetupView() }
        .sheet(isPresented: $showLanguage) { LanguagePickerView(asSheet: true) }
    }

    // Tappable header → profile. No raw ID here: it lives only inside «Мой профиль».
    private var profileHeader: some View {
        NavigationLink(destination: ProfileView()) {
            VStack(spacing: 12) {
                Avatar(name: id?.displayName ?? "?", seed: id?.userId ?? "", size: 96)
                Text(id?.displayName ?? "—")
                    .font(.system(size: 24, weight: .bold))
                    .foregroundStyle(Theme.text)
                HStack(spacing: 7) {
                    Image(systemName: "checkmark.shield.fill")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.accent)
                    Text(loc.t("settings.localAccount"))
                        .font(.system(size: 15))
                        .foregroundStyle(Theme.muted)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Theme.muted.opacity(0.5))
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var languageRow: some View {
        Button { showLanguage = true } label: {
            HStack(spacing: 13) {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color(hex: "#36c5c0")).frame(width: 30, height: 30)
                    .overlay(Image(systemName: "globe")
                        .font(.system(size: 15, weight: .semibold)).foregroundStyle(.white))
                VStack(alignment: .leading, spacing: 3) {
                    Text(loc.t("settings.language")).font(.system(size: 17)).foregroundStyle(Theme.text)
                    Text(loc.t("settings.language.sub")).font(.system(size: 12.5)).foregroundStyle(Theme.muted)
                }
                Spacer(minLength: 8)
                Text("\(loc.lang.flag) \(loc.lang.nativeName)")
                    .font(.system(size: 14)).foregroundStyle(Theme.muted)
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.muted.opacity(0.5))
            }
            .padding(.horizontal, 14).padding(.vertical, 11)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func toggleRow(icon: String, tint: Color, title: String, subtitle: String? = nil, isOn: Binding<Bool>) -> some View {
        HStack(alignment: subtitle == nil ? .center : .top, spacing: 13) {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(tint).frame(width: 30, height: 30)
                .overlay(Image(systemName: icon).font(.system(size: 14, weight: .semibold)).foregroundStyle(.white))
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.system(size: 17)).foregroundStyle(Theme.text)
                if let subtitle {
                    Text(subtitle).font(.system(size: 12.5)).foregroundStyle(Theme.muted)
                }
            }
            Spacer(minLength: 8)
            Toggle("", isOn: isOn).labelsHidden().tint(Theme.accent)
        }
        .padding(.horizontal, 14).padding(.vertical, 11)
    }

    @ViewBuilder
    private func fixItBanner(icon: String, text: String, action: (() -> Void)?) -> some View {
        let content = HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.warn)
            Text(text)
                .font(.system(size: 12.5))
                .foregroundStyle(Theme.text)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            if action != nil {
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.muted.opacity(0.6))
            }
        }
        .padding(12)
        .background(Theme.warn.opacity(0.12), in: RoundedRectangle(cornerRadius: 14, style: .continuous))

        if let action {
            Button(action: action) { content.contentShape(Rectangle()) }.buttonStyle(.plain)
        } else {
            content
        }
    }

    private func sectionTitle(_ t: String) -> some View {
        Text(t.uppercased())
            .font(.system(size: 12.5, weight: .semibold))
            .foregroundStyle(Theme.muted)
            .padding(.horizontal, 6)
    }
}
