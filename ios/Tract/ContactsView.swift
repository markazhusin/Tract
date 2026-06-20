import SwiftUI

struct ContactRow: View {
    @EnvironmentObject var mesh: MeshService
    let contact: Contact
    var showPreview: Bool = true

    private var route: RouteQuality { mesh.route(for: contact.userId) }

    var body: some View {
        HStack(spacing: 13) {
            ZStack(alignment: .bottomTrailing) {
                Avatar(name: contact.displayName, seed: contact.userId, size: 52)
                if route != .offline {
                    Circle().fill(route.color)
                        .frame(width: 13, height: 13)
                        .overlay(Circle().strokeBorder(Theme.bg, lineWidth: 2.5))
                }
            }
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(contact.displayName)
                        .font(.system(size: 16.5, weight: .semibold))
                        .foregroundStyle(Theme.text)
                        .lineLimit(1)
                    Spacer()
                    if showPreview, let t = contact.lastTime {
                        Text(Self.shortTime(t))
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.muted)
                    }
                }
                HStack(spacing: 8) {
                    if showPreview && !contact.lastMessage.isEmpty {
                        Text(contact.lastMessage)
                            .font(.system(size: 14.5))
                            .foregroundStyle(Theme.muted)
                            .lineLimit(1)
                    } else {
                        RouteBadge(quality: route)
                    }
                    Spacer()
                    if showPreview && contact.unread > 0 {
                        Text("\(contact.unread)")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(Theme.onAccent)
                            .padding(.horizontal, 7).padding(.vertical, 2)
                            .background(Theme.accent, in: Capsule())
                    }
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .contentShape(Rectangle())
    }

    static func shortTime(_ date: Date) -> String {
        let f = DateFormatter()
        if Calendar.current.isDateInToday(date) {
            f.dateFormat = "HH:mm"
        } else {
            f.dateFormat = "dd.MM"
        }
        return f.string(from: date)
    }
}

struct ContactsView: View {
    @EnvironmentObject var mesh: MeshService

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            if mesh.contacts.isEmpty {
                EmptyHint(icon: "person.2",
                          title: "Пока никого рядом",
                          subtitle: "Контакты появятся автоматически, когда рядом включат другое устройство Tract. Интернет не нужен.")
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(mesh.contacts) { c in
                            NavigationLink(value: c) {
                                ContactRow(contact: c, showPreview: false)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.top, 8)
                    Color.clear.frame(height: 96)
                }
            }
        }
        .safeAreaInset(edge: .top) {
            ScreenHeader(title: "Контакты")
        }
    }
}

// MARK: - Reusable top header (glass, does not overlap content)

struct ScreenHeader<Trailing: View>: View {
    let title: String
    var subtitle: AnyView? = nil
    @ViewBuilder var trailing: () -> Trailing

    init(title: String, subtitle: AnyView? = nil, @ViewBuilder trailing: @escaping () -> Trailing = { EmptyView() }) {
        self.title = title
        self.subtitle = subtitle
        self.trailing = trailing
    }

    var body: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 24, weight: .bold)).foregroundStyle(Theme.text)
                if let subtitle { subtitle }
            }
            Spacer()
            trailing()
        }
        .padding(.horizontal, 16)
        .padding(.top, 6)
        .padding(.bottom, 10)
        .background(Theme.bg.opacity(0.92))
    }
}
