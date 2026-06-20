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
    // Cohesive cool-graphite scale: one elevated surface for every card / field /
    // incoming bubble, with the mint accent reserved for primary/own elements.
    static let bgDeep = Color(hex: "#0E1012")   // nav bar, input bar, tab bar backdrop
    static let bg = Color(hex: "#15171A")        // main background
    static let panel = Color(hex: "#1F2226")     // unified surface (cards, fields, incoming bubble)
    static let panelInput = Color(hex: "#1F2226")
    static let bubbleIn = Color(hex: "#1F2226")
    static let line = Color(hex: "#2A2E33")      // subtle dividers
    static let text = Color(hex: "#F1F3F4")
    static let muted = Color(hex: "#8A9098")
    static let accent = Color(hex: "#B7FFF9")    // mint — used sparingly (own bubble, primary, active)
    static let onAccent = Color(hex: "#0B1413")
    static let online = Color(hex: "#49C96A")
    static let danger = Color(hex: "#E5654F")
    static let warn = Color(hex: "#E0A23C")
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
