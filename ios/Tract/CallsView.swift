import SwiftUI

// MARK: - Call journal (Telegram-style: Все / Пропущенные + grouped log)

/// Consecutive calls with the same peer collapse into one row with a count,
/// the way Telegram groups repeated calls.
struct CallLogGroup: Identifiable {
    let records: [CallRecord]
    var id: UUID { records[0].id }
    var head: CallRecord { records[0] }
    var count: Int { records.count }
    var ids: Set<UUID> { Set(records.map { $0.id }) }
}

struct CallsView: View {
    @EnvironmentObject var mesh: MeshService
    @EnvironmentObject var call: CallService
    @EnvironmentObject var node: NodeConfig
    @EnvironmentObject var loc: AppLanguage

    @State private var showNewCall = false
    @State private var filterMissed = false
    @State private var showClearConfirm = false

    private var filtered: [CallRecord] {
        filterMissed ? call.history.filter { $0.missed } : call.history
    }
    private var groups: [CallLogGroup] { Self.group(filtered) }

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()

            if call.history.isEmpty {
                VStack(spacing: 16) {
                    EmptyHint(icon: "phone",
                              title: loc.t("calls.empty.title"),
                              subtitle: loc.t("calls.empty.sub"))
                    newCallButton
                }
            } else {
                ScrollView {
                    VStack(spacing: 12) {
                        Picker("", selection: $filterMissed) {
                            Text(loc.t("calls.all")).tag(false)
                            Text(loc.t("calls.missed")).tag(true)
                        }
                        .pickerStyle(.segmented)
                        .padding(.horizontal, 10)
                        .padding(.top, 4)

                        newCallRow

                        if groups.isEmpty {
                            Text(loc.t("calls.noMissed"))
                                .font(.system(size: 14))
                                .foregroundStyle(Theme.muted)
                                .padding(.top, 36)
                        } else {
                            GroupCard {
                                ForEach(groups) { g in
                                    CallLogRow(group: g) { callBack(g.head) }
                                        .contextMenu {
                                            if reachable(g.head) {
                                                Button { callBack(g.head) } label: {
                                                    Label(loc.t("common.call"), systemImage: "phone")
                                                }
                                            }
                                            Button(role: .destructive) {
                                                call.deleteHistory(ids: g.ids)
                                            } label: { Label(loc.t("common.delete"), systemImage: "trash") }
                                        }
                                    if g.id != groups.last?.id { RowDivider(leading: 71) }
                                }
                            }
                            .padding(.horizontal, 10)
                        }
                    }
                    Color.clear.frame(height: 96)
                }
            }
        }
        .safeAreaInset(edge: .top) {
            ScreenHeader(title: loc.t("calls.title")) {
                HStack(spacing: 8) {
                    if !call.history.isEmpty {
                        CircleGlassButton(systemName: "ellipsis") { showClearConfirm = true }
                    }
                    CircleGlassButton(systemName: "phone.badge.plus") { showNewCall = true }
                }
            }
        }
        .sheet(isPresented: $showNewCall) { NewCallSheet() }
        .confirmationDialog(loc.t("calls.clearQ"),
                            isPresented: $showClearConfirm, titleVisibility: .visible) {
            Button(loc.t("calls.clear"), role: .destructive) { call.clearHistory() }
            Button(loc.t("common.cancel"), role: .cancel) {}
        }
    }

    // MARK: Rows / buttons

    private var newCallRow: some View {
        Button { showNewCall = true } label: {
            HStack(spacing: 13) {
                ZStack {
                    Circle().fill(Theme.online.opacity(0.16)).frame(width: 46, height: 46)
                    Image(systemName: "phone.fill")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(Theme.online)
                }
                Text(loc.t("calls.new"))
                    .font(.system(size: 16.5, weight: .semibold))
                    .foregroundStyle(Theme.online)
                Spacer()
            }
            .padding(.horizontal, 14).padding(.vertical, 8)
            .background(Theme.panel, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 10)
    }

    private var newCallButton: some View {
        Button { showNewCall = true } label: {
            Label(loc.t("calls.new"), systemImage: "phone.fill")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.onAccent)
                .padding(.horizontal, 18).padding(.vertical, 11)
                .background(Theme.accent, in: Capsule())
        }
        .buttonStyle(.plain)
    }

    // MARK: Actions / helpers

    private func contact(for rec: CallRecord) -> Contact? {
        mesh.contacts.first { $0.userId == rec.userId }
    }

    private func reachable(_ rec: CallRecord) -> Bool {
        guard let c = contact(for: rec) else { return false }
        return mesh.route(for: c.userId) != .offline || node.isConfigured
    }

    private func callBack(_ rec: CallRecord) {
        guard let c = contact(for: rec),
              mesh.route(for: c.userId) != .offline || node.isConfigured else { return }
        call.startCall(to: c)
    }

    /// Collapse consecutive records with the same peer into one group.
    static func group(_ recs: [CallRecord]) -> [CallLogGroup] {
        func key(_ r: CallRecord) -> String { r.userId.isEmpty ? "name:\(r.name)" : r.userId }
        var out: [CallLogGroup] = []
        var bucket: [CallRecord] = []
        for r in recs {
            if let last = bucket.last, key(last) == key(r) {
                bucket.append(r)
            } else {
                if !bucket.isEmpty { out.append(CallLogGroup(records: bucket)) }
                bucket = [r]
            }
        }
        if !bucket.isEmpty { out.append(CallLogGroup(records: bucket)) }
        return out
    }

    static func shortTime(_ date: Date) -> String {
        let cal = Calendar.current
        let f = DateFormatter()
        if cal.isDateInToday(date) { f.dateFormat = "HH:mm" }
        else if cal.isDateInYesterday(date) { return L("calls.yesterday") }
        else { f.dateFormat = "dd.MM" }
        return f.string(from: date)
    }

    static func durationText(_ d: TimeInterval) -> String {
        let s = Int(d.rounded())
        return String(format: "%d:%02d", s / 60, s % 60)
    }
}

// MARK: - One call-log row

struct CallLogRow: View {
    @EnvironmentObject var mesh: MeshService
    @EnvironmentObject var loc: AppLanguage
    let group: CallLogGroup
    let onCall: () -> Void

    private var head: CallRecord { group.head }
    private var route: RouteQuality { mesh.route(for: head.userId) }
    private var reachable: Bool { !head.userId.isEmpty && route != .offline }

    private var arrowIcon: String { head.outgoing ? "arrow.up.right" : "arrow.down.left" }
    private var accent: Color { head.missed ? Theme.danger : Theme.muted }

    private var detailText: String {
        var parts: [String] = [head.missed ? loc.t("calls.kind.missed") : (head.outgoing ? loc.t("calls.kind.outgoing") : loc.t("calls.kind.incoming"))]
        parts.append(head.viaMesh ? loc.t("calls.via.mesh") : loc.t("calls.via.internet"))
        if head.connected, head.duration >= 1 { parts.append(CallsView.durationText(head.duration)) }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        HStack(spacing: 13) {
            Avatar(name: head.name, seed: head.userId.isEmpty ? head.name : head.userId, size: 46)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(head.name)
                        .font(.system(size: 16.5, weight: .semibold))
                        .foregroundStyle(head.missed ? Theme.danger : Theme.text)
                        .lineLimit(1)
                    if group.count > 1 {
                        Text("(\(group.count))")
                            .font(.system(size: 14))
                            .foregroundStyle(Theme.muted)
                    }
                }
                HStack(spacing: 5) {
                    Image(systemName: arrowIcon)
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(accent)
                    Text(detailText)
                        .font(.system(size: 13.5))
                        .foregroundStyle(Theme.muted)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 8)

            Text(CallsView.shortTime(head.time))
                .font(.system(size: 13))
                .foregroundStyle(Theme.muted)

            Image(systemName: "phone.fill")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(reachable ? Theme.accent : Theme.muted.opacity(0.4))
                .frame(width: 30, height: 30)
        }
        .padding(.horizontal, 14).padding(.vertical, 9)
        .contentShape(Rectangle())
        .onTapGesture { onCall() }
    }
}

// MARK: - New call: pick a contact to ring

struct NewCallSheet: View {
    @EnvironmentObject var mesh: MeshService
    @EnvironmentObject var call: CallService
    @EnvironmentObject var node: NodeConfig
    @EnvironmentObject var loc: AppLanguage
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var results: [Contact] {
        guard !query.isEmpty else { return mesh.contacts }
        return mesh.contacts.filter {
            $0.displayName.localizedCaseInsensitiveContains(query) ||
            $0.userId.localizedCaseInsensitiveContains(query)
        }
    }

    private func canCall(_ c: Contact) -> Bool {
        mesh.route(for: c.userId) != .offline || node.isConfigured
    }

    var body: some View {
        NavigationView {
            ZStack {
                Theme.bg.ignoresSafeArea()
                if mesh.contacts.isEmpty {
                    EmptyHint(icon: "person.2",
                              title: loc.t("calls.noContacts.title"),
                              subtitle: loc.t("calls.noContacts.sub"))
                } else {
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(results) { c in
                                Button {
                                    dismiss()
                                    if canCall(c) { call.startCall(to: c) }
                                } label: {
                                    HStack(spacing: 13) {
                                        Avatar(name: c.displayName, seed: c.userId, size: 46)
                                        VStack(alignment: .leading, spacing: 3) {
                                            Text(c.displayName)
                                                .font(.system(size: 16.5, weight: .semibold))
                                                .foregroundStyle(Theme.text)
                                                .lineLimit(1)
                                            RouteBadge(quality: mesh.route(for: c.userId))
                                        }
                                        Spacer()
                                        Image(systemName: "phone.fill")
                                            .font(.system(size: 16, weight: .semibold))
                                            .foregroundStyle(canCall(c) ? Theme.accent : Theme.muted.opacity(0.4))
                                    }
                                    .padding(.horizontal, 14).padding(.vertical, 9)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .disabled(!canCall(c))
                                if c.id != results.last?.id { RowDivider(leading: 71) }
                            }
                        }
                        .padding(.horizontal, 10).padding(.top, 8)
                    }
                }
            }
            .searchable(text: $query, prompt: loc.t("common.search"))
            .navigationTitle(loc.t("calls.new"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button(loc.t("common.done")) { dismiss() }.foregroundStyle(Theme.accent)
                }
            }
        }
        .navigationViewStyle(.stack)
        .preferredColorScheme(.dark)
    }
}
