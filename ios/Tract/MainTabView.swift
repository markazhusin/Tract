import SwiftUI

enum Tab: Int, CaseIterable {
    case contacts, calls, chats, settings

    var title: String {
        switch self {
        case .contacts: return "Контакты"
        case .calls: return "Звонки"
        case .chats: return "Чаты"
        case .settings: return "Настройки"
        }
    }

    var icon: String {
        switch self {
        case .contacts: return "person"
        case .calls: return "phone"
        case .chats: return "bubble.left.and.bubble.right"
        case .settings: return "gearshape"
        }
    }
}

struct MainTabView: View {
    @EnvironmentObject var mesh: MeshService
    @State private var tab: Tab = .chats
    @State private var showSearch = false

    var body: some View {
        NavigationView {
            TabView(selection: $tab) {
                ContactsView().tag(Tab.contacts)
                CallsView().tag(Tab.calls)
                ChatsView().tag(Tab.chats)
                SettingsView().tag(Tab.settings)
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .background(Theme.bg.ignoresSafeArea())
            .overlay(alignment: .bottom) {
                // Floating glass bar: content scrolls UNDER it so Liquid Glass
                // refracts the content behind — no opaque backing.
                BottomBar(tab: $tab, showSearch: $showSearch, unread: mesh.totalUnread)
            }
            .navigationBarHidden(true)
        }
        .navigationViewStyle(.stack)
        .sheet(isPresented: $showSearch) { SearchSheet() }
    }
}

// MARK: - Bottom navbar (Liquid Glass pill + separate search button, Telegram-like)
// Lives in a safeAreaInset (not a ZStack overlay) so taps land reliably and never
// fall through to the content behind it. Tab switches drive the paged TabView,
// which also enables horizontal swipe navigation between tabs.

struct BottomBar: View {
    @Binding var tab: Tab
    @Binding var showSearch: Bool
    var unread: Int

    var body: some View {
        HStack(spacing: 10) {
            HStack(spacing: 2) {
                ForEach(Tab.allCases, id: \.self) { t in
                    Button {
                        withAnimation(.spring(response: 0.32, dampingFraction: 0.85)) { tab = t }
                    } label: {
                        VStack(spacing: 3) {
                            ZStack {
                                Image(systemName: t.icon)
                                    .font(.system(size: 21, weight: .regular))
                                if t == .chats && unread > 0 {
                                    Text("\(min(unread, 99))")
                                        .font(.system(size: 11, weight: .bold))
                                        .foregroundStyle(Theme.onAccent)
                                        .padding(.horizontal, 5).padding(.vertical, 1)
                                        .background(Theme.accent, in: Capsule())
                                        .offset(x: 13, y: -10)
                                }
                            }
                            Text(t.title).font(.system(size: 10, weight: .medium))
                        }
                        .foregroundStyle(tab == t ? Theme.accent : Theme.muted)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 9)
                        .background {
                            if tab == t {
                                RoundedRectangle(cornerRadius: 16, style: .continuous)
                                    .fill(Theme.accent.opacity(0.12))
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(6)
            .glassCard(corner: 28)

            CircleGlassButton(systemName: "magnifyingglass", size: 56) { showSearch = true }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 4)
    }
}

// MARK: - Search sheet

struct SearchSheet: View {
    @EnvironmentObject var mesh: MeshService
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var showAdd = false

    private var results: [Contact] {
        guard !query.isEmpty else { return mesh.contacts }
        return mesh.contacts.filter {
            $0.displayName.localizedCaseInsensitiveContains(query) ||
            $0.userId.localizedCaseInsensitiveContains(query)
        }
    }

    var body: some View {
        NavigationView {
            ZStack {
                Theme.bg.ignoresSafeArea()
                if results.isEmpty {
                    VStack(spacing: 16) {
                        EmptyHint(icon: "magnifyingglass", title: "Ничего не найдено",
                                  subtitle: "Добавьте контакт по его ID.")
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
                            ForEach(results) { c in
                                NavigationLink(destination: ChatDetailView(contact: c)) { ContactRow(contact: c) }
                                    .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal, 12)
                        .padding(.top, 8)
                    }
                }
            }
            .searchable(text: $query, prompt: "Поиск")
            .navigationTitle("Поиск")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button { showAdd = true } label: { Image(systemName: "plus") }
                        .foregroundStyle(Theme.accent)
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Готово") { dismiss() }.foregroundStyle(Theme.accent)
                }
            }
            .sheet(isPresented: $showAdd) { AddContactView() }
        }
        .navigationViewStyle(.stack)
        .preferredColorScheme(.dark)
    }
}

// MARK: - Shared empty-state hint

struct EmptyHint: View {
    let icon: String
    let title: String
    let subtitle: String

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 44, weight: .light))
                .foregroundStyle(Theme.muted.opacity(0.7))
            Text(title).font(.system(size: 18, weight: .semibold)).foregroundStyle(Theme.text)
            Text(subtitle)
                .font(.system(size: 14))
                .foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
        }
    }
}
