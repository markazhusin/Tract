import SwiftUI
import UIKit

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

// MARK: - Contact row with last-seen status (Telegram contacts list)

struct ContactStatusRow: View {
    @EnvironmentObject var mesh: MeshService
    let contact: Contact

    private var route: RouteQuality { mesh.route(for: contact.userId) }
    private var isNearby: Bool { route == .localMesh }

    private var status: (text: String, color: Color) {
        if isNearby { return ("рядом", Theme.online) }
        if let ls = contact.lastSeen { return (ContactsView.lastSeenText(ls), Theme.muted) }
        return ("был(а) недавно", Theme.muted)
    }

    var body: some View {
        HStack(spacing: 13) {
            ZStack(alignment: .bottomTrailing) {
                Avatar(name: contact.displayName, seed: contact.userId, size: 52)
                if isNearby {
                    Circle().fill(Theme.online)
                        .frame(width: 13, height: 13)
                        .overlay(Circle().strokeBorder(Theme.bg, lineWidth: 2.5))
                }
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(contact.displayName)
                    .font(.system(size: 16.5, weight: .semibold))
                    .foregroundStyle(Theme.text)
                    .lineLimit(1)
                Text(status.text)
                    .font(.system(size: 13.5))
                    .foregroundStyle(status.color)
                    .lineLimit(1)
            }
            Spacer()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .contentShape(Rectangle())
    }
}

struct ContactsView: View {
    @EnvironmentObject var mesh: MeshService
    @State private var showAdd = false

    /// Nearby devices that are not (yet) contacts.
    private var nearbyOnly: [Contact] {
        mesh.nearby.filter { n in !mesh.contacts.contains { $0.userId == n.userId } }
    }

    /// Contacts grouped into alphabetical sections.
    private var sections: [(letter: String, items: [Contact])] {
        Dictionary(grouping: mesh.contacts) { Self.sectionLetter($0.displayName) }
            .map { (letter: $0.key, items: $0.value.sorted {
                $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
            }) }
            .sorted(by: Self.sectionLess)
    }

    private var indexLetters: [String] { sections.map { $0.letter } }

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            if mesh.contacts.isEmpty && nearbyOnly.isEmpty {
                emptyState
            } else {
                ScrollViewReader { proxy in
                    ZStack(alignment: .trailing) {
                        ScrollView {
                            LazyVStack(spacing: 0) {
                                if !nearbyOnly.isEmpty {
                                    sectionHeader("Рядом")
                                    ForEach(nearbyOnly) { c in
                                        NavigationLink(destination: ChatDetailView(contact: c)) {
                                            ContactRow(contact: c, showPreview: false)
                                        }
                                        .buttonStyle(.plain)
                                        // Opening a chat with a nearby device adds it as a contact.
                                        .simultaneousGesture(TapGesture().onEnded { mesh.promoteToContact(c.userId) })
                                    }
                                }
                                ForEach(sections, id: \.letter) { section in
                                    sectionHeader(section.letter).id("sec-\(section.letter)")
                                    ForEach(section.items) { c in
                                        NavigationLink(destination: ChatDetailView(contact: c)) {
                                            ContactStatusRow(contact: c)
                                        }
                                        .buttonStyle(.plain)
                                        .contextMenu {
                                            Button(role: .destructive) { mesh.deleteContact(c.userId) } label: {
                                                Label("Удалить контакт", systemImage: "trash")
                                            }
                                        }
                                    }
                                }
                            }
                            .padding(.horizontal, 8)
                            .padding(.top, 8)
                            Color.clear.frame(height: 96)
                        }
                        if indexLetters.count > 1 {
                            AlphabetIndex(letters: indexLetters) { letter in
                                withAnimation { proxy.scrollTo("sec-\(letter)", anchor: .top) }
                            }
                        }
                    }
                }
            }
        }
        .safeAreaInset(edge: .top) {
            ScreenHeader(title: "Контакты") {
                CircleGlassButton(systemName: "person.badge.plus") { showAdd = true }
            }
        }
        .sheet(isPresented: $showAdd) { AddContactView() }
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            EmptyHint(icon: "person.2",
                      title: "Пока никого",
                      subtitle: "Добавьте контакт по ID или дождитесь устройство рядом по мешу.")
            Button { showAdd = true } label: {
                Label("Добавить по ID", systemImage: "plus")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Theme.onAccent)
                    .padding(.horizontal, 18).padding(.vertical, 11)
                    .background(Theme.accent, in: Capsule())
            }
            .buttonStyle(.plain)
        }
    }

    private func sectionHeader(_ t: String) -> some View {
        HStack {
            Text(t.uppercased())
                .font(.system(size: 12.5, weight: .semibold))
                .foregroundStyle(Theme.muted)
            Spacer()
        }
        .padding(.horizontal, 14)
        .padding(.top, 14)
        .padding(.bottom, 4)
    }

    // MARK: Section helpers

    static func sectionLetter(_ name: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard let first = trimmed.first else { return "#" }
        let s = String(first).uppercased()
        return s.rangeOfCharacter(from: .letters) != nil ? s : "#"
    }

    static func sectionLess(_ a: (letter: String, items: [Contact]),
                            _ b: (letter: String, items: [Contact])) -> Bool {
        if a.letter == "#" { return false }   // "#" sinks to the bottom
        if b.letter == "#" { return true }
        return a.letter.localizedCaseInsensitiveCompare(b.letter) == .orderedAscending
    }

    static func lastSeenText(_ date: Date) -> String {
        let cal = Calendar.current
        let secs = Date().timeIntervalSince(date)
        if secs < 60 { return "был(а) только что" }
        if secs < 3600 { return "был(а) \(Int(secs / 60)) мин назад" }
        let f = DateFormatter()
        if cal.isDateInToday(date) { f.dateFormat = "HH:mm"; return "был(а) в \(f.string(from: date))" }
        if cal.isDateInYesterday(date) { f.dateFormat = "HH:mm"; return "был(а) вчера в \(f.string(from: date))" }
        f.dateFormat = "dd.MM.yy"
        return "был(а) \(f.string(from: date))"
    }
}

// MARK: - Alphabet side index (Telegram-style)

struct AlphabetIndex: View {
    let letters: [String]
    let onSelect: (String) -> Void

    var body: some View {
        VStack(spacing: 1) {
            ForEach(letters, id: \.self) { l in
                Text(l)
                    .font(.system(size: 10.5, weight: .bold))
                    .foregroundStyle(Theme.accent)
                    .frame(width: 18, height: 13)
                    .contentShape(Rectangle())
                    .onTapGesture {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        onSelect(l)
                    }
            }
        }
        .padding(.vertical, 8)
        .padding(.trailing, 2)
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
