import SwiftUI

/// One-time language picker shown on first launch (before anything else), and
/// reusable as a standalone sheet. Writing a choice sets `AppLanguage.chosen`, which
/// dismisses the first-launch gate in `RootView`.
struct LanguagePickerView: View {
    @EnvironmentObject var loc: AppLanguage
    /// When presented as a sheet (from Settings) we dismiss; on first launch the
    /// RootView gate hides us once `chosen` flips.
    var asSheet: Bool = false
    @Environment(\.dismiss) private var dismiss

    @State private var selection: Lang = AppLanguage.shared.lang

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            VStack(spacing: 22) {
                Spacer()

                Image(systemName: "globe")
                    .font(.system(size: 52, weight: .light))
                    .foregroundStyle(Theme.accent)

                VStack(spacing: 6) {
                    Text(loc.t("lang.title"))
                        .font(.system(size: 22, weight: .bold))
                        .foregroundStyle(Theme.text)
                    Text(loc.t("lang.subtitle"))
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.muted)
                        .multilineTextAlignment(.center)
                }
                .padding(.horizontal, 32)

                VStack(spacing: 10) {
                    ForEach(Lang.allCases) { l in
                        Button {
                            selection = l
                            loc.lang = l   // live preview as you tap
                        } label: {
                            HStack(spacing: 12) {
                                Text(l.flag).font(.system(size: 22))
                                Text(l.nativeName)
                                    .font(.system(size: 17, weight: .medium))
                                    .foregroundStyle(Theme.text)
                                Spacer()
                                if selection == l {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundStyle(Theme.accent)
                                }
                            }
                            .padding(.horizontal, 16).padding(.vertical, 14)
                            .background(
                                RoundedRectangle(cornerRadius: 14, style: .continuous)
                                    .fill(selection == l ? Theme.accent.opacity(0.12) : Theme.panelInput)
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: 14, style: .continuous)
                                    .strokeBorder(selection == l ? Theme.accent : .clear, lineWidth: 1.5)
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 24)

                Spacer()

                Button {
                    loc.choose(selection)
                    if asSheet { dismiss() }
                } label: {
                    Text(loc.t("lang.continue"))
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(Theme.onAccent)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(Theme.accent, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 24)
                .padding(.bottom, 24)
            }
        }
    }
}
