import SwiftUI

// MARK: - Brand palette (Tract: mint accent on near-black, Telegram-like dark)

extension Color {
    init(hex: String) {
        let s = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        var v: UInt64 = 0
        Scanner(string: s).scanHexInt64(&v)
        let r, g, b, a: Double
        if s.count == 8 {
            r = Double((v >> 24) & 0xff) / 255
            g = Double((v >> 16) & 0xff) / 255
            b = Double((v >> 8) & 0xff) / 255
            a = Double(v & 0xff) / 255
        } else {
            r = Double((v >> 16) & 0xff) / 255
            g = Double((v >> 8) & 0xff) / 255
            b = Double(v & 0xff) / 255
            a = 1
        }
        self.init(.sRGB, red: r, green: g, blue: b, opacity: a)
    }
}

enum Theme {
    static let bg = Color(hex: "#141515")
    static let bgDeep = Color(hex: "#050508")
    static let panel = Color(hex: "#1b1c1c")
    static let panelInput = Color(hex: "#202121")
    static let line = Color(hex: "#2a2b2b")
    static let text = Color(hex: "#f5f5f5")
    static let muted = Color(hex: "#9a9a9a")
    static let accent = Color(hex: "#B7FFF9")
    static let online = Color(hex: "#4dcd5e")
    static let danger = Color(hex: "#e56565")
    static let warn = Color(hex: "#e7a23d")
    static let onAccent = Color(hex: "#0c1413")
}

// MARK: - Liquid Glass (iOS 26) with graceful fallback

struct GlassCard: ViewModifier {
    var corner: CGFloat = 22
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(.regular, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
        } else {
            content
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: corner, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.08), lineWidth: 1)
                )
        }
    }
}

extension View {
    func glassCard(corner: CGFloat = 22) -> some View { modifier(GlassCard(corner: corner)) }
}
