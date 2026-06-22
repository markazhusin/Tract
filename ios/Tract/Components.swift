import SwiftUI

// MARK: - Avatar

struct Avatar: View {
    let name: String
    let seed: String
    var size: CGFloat = 48

    private static let palette: [Color] = [
        Color(hex: "#e56565"), Color(hex: "#4dcd5e"), Color(hex: "#5b9cf2"),
        Color(hex: "#c77dff"), Color(hex: "#f2a35b"), Color(hex: "#36c5c0")
    ]

    private var color: Color {
        var hash = 5381
        for b in seed.utf8 { hash = (hash &* 33) ^ Int(b) }
        return Self.palette[abs(hash) % Self.palette.count]
    }

    private var initials: String {
        let parts = name.split(separator: " ")
        let s = parts.prefix(2).compactMap { $0.first }.map(String.init).joined()
        return s.isEmpty ? "?" : s.uppercased()
    }

    var body: some View {
        ZStack {
            Circle().fill(
                LinearGradient(colors: [color, color.opacity(0.72)],
                               startPoint: .top, endPoint: .bottom)
            )
            Text(initials)
                .font(.system(size: size * 0.4, weight: .semibold))
                .foregroundStyle(.white)
        }
        .frame(width: size, height: size)
    }
}

// MARK: - Status pill (replaces the old top-right indicator that overlapped buttons)

struct StatusPill: View {
    let text: String
    let color: Color

    var body: some View {
        HStack(spacing: 7) {
            Circle().fill(color).frame(width: 8, height: 8)
            Text(text)
                .font(.system(size: 12.5, weight: .medium))
                .foregroundStyle(Theme.text)
        }
        .padding(.horizontal, 13)
        .padding(.vertical, 7)
        .glassCard(corner: 20)
    }
}

// MARK: - Circular glass button (header / search)

struct CircleGlassButton: View {
    let systemName: String
    var size: CGFloat = 38
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: size * 0.42, weight: .semibold))
                .foregroundStyle(Theme.text)
                .frame(width: size, height: size)
        }
        .glassCard(corner: size / 2)
        .buttonStyle(.plain)
    }
}

// MARK: - Grouped solid card (Telegram-style settings groups)

struct GroupCard<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        VStack(spacing: 0) { content }
            .background(Theme.panel, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

struct RowDivider: View {
    var leading: CGFloat = 58
    var body: some View {
        Rectangle()
            .fill(Theme.line)
            .frame(height: 0.5)
            .padding(.leading, leading)
    }
}

struct SettingsRow: View {
    let icon: String
    let iconColor: Color
    let title: String
    var value: String? = nil
    var showChevron: Bool = true

    var body: some View {
        HStack(spacing: 13) {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(iconColor)
                .frame(width: 30, height: 30)
                .overlay(Image(systemName: icon).font(.system(size: 15, weight: .semibold)).foregroundStyle(.white))
            Text(title).font(.system(size: 17)).foregroundStyle(Theme.text)
            Spacer(minLength: 8)
            if let value { Text(value).font(.system(size: 16)).foregroundStyle(Theme.muted) }
            if showChevron {
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.muted.opacity(0.55))
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .contentShape(Rectangle())
    }
}

struct TransportRow: View {
    let icon: String
    let iconColor: Color
    let title: String
    let status: String
    let state: LinkState

    var body: some View {
        HStack(spacing: 13) {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(iconColor)
                .frame(width: 30, height: 30)
                .overlay(Image(systemName: icon).font(.system(size: 15, weight: .semibold)).foregroundStyle(.white))
            Text(title).font(.system(size: 17)).foregroundStyle(Theme.text)
            Spacer(minLength: 8)
            HStack(spacing: 6) {
                Circle().fill(state.dot).frame(width: 8, height: 8)
                Text(status).font(.system(size: 15)).foregroundStyle(Theme.muted)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .contentShape(Rectangle())
    }
}
