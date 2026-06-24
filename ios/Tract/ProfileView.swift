import SwiftUI
import CoreImage.CIFilterBuiltins

/// "Мой профиль" — pushed from Settings. Holds identity (ID + QR) and, tucked at
/// the bottom in a danger zone, the deliberate account-deletion flow (an action
/// sheet, not a one-tap alert), so it can't be hit by accident.
struct ProfileView: View {
    @EnvironmentObject var identity: IdentityStore
    @EnvironmentObject var loc: AppLanguage
    @State private var copied = false

    private var id: Identity? { identity.identity }
    private var myId: String { id?.userId ?? "" }
    private var myPk: String { id?.publicKeyHex ?? "" }
    private var shareString: String { "tract:\(myId):\(myPk)" }

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            ScrollView {
                VStack(spacing: 22) {
                    VStack(spacing: 12) {
                        Avatar(name: id?.displayName ?? "?", seed: myId, size: 96)
                        Text(id?.displayName ?? "—")
                            .font(.system(size: 24, weight: .bold))
                            .foregroundStyle(Theme.text)
                    }
                    .padding(.top, 8)

                    // ID + QR — others scan/paste this to add you (works offline).
                    VStack(spacing: 14) {
                        if let img = qr(shareString) {
                            Image(uiImage: img)
                                .interpolation(.none)
                                .resizable()
                                .frame(width: 168, height: 168)
                                .padding(10)
                                .background(.white)
                                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                        }
                        Text(loc.t("add.yourId")).font(.system(size: 13)).foregroundStyle(Theme.muted)
                        Text(myId)
                            .font(.system(size: 19, weight: .bold, design: .monospaced))
                            .foregroundStyle(Theme.accent)
                            .textSelection(.enabled)
                        Button(action: copyId) {
                            Label(copied ? loc.t("add.copied") : loc.t("add.copyId"),
                                  systemImage: copied ? "checkmark" : "doc.on.doc")
                                .font(.system(size: 14, weight: .medium))
                                .foregroundStyle(Theme.accent)
                        }
                        .buttonStyle(.plain)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 18)
                    .background(Theme.panel, in: RoundedRectangle(cornerRadius: 18, style: .continuous))

                    // Account management lives one screen deeper (not a red button
                    // here) — a discreet, low-emphasis link, so deletion is never an
                    // accidental tap.
                    NavigationLink {
                        AccountDeletionView()
                    } label: {
                        HStack {
                            Text(loc.t("profile.manage"))
                                .font(.system(size: 14))
                                .foregroundStyle(Theme.muted)
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(Theme.muted.opacity(0.5))
                        }
                        .padding(.horizontal, 14).padding(.vertical, 12)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 10)

                    Color.clear.frame(height: 40)
                }
                .padding(.horizontal, 14)
                .padding(.top, 8)
            }
        }
        .navigationTitle(loc.t("profile.title"))
        .navigationBarTitleDisplayMode(.inline)
    }

    private func copyId() {
        UIPasteboard.general.string = myId
        copied = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
    }

    private func qr(_ string: String) -> UIImage? {
        let context = CIContext()
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(string.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
              let cg = context.createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}

// MARK: - Account management / deletion (hidden one screen deeper)

/// Deletion is deliberate and unusual: you must type a confirmation word before
/// the destructive action even becomes tappable, then confirm once more. There is
/// no recovery — the account is just a private key on this device.
struct AccountDeletionView: View {
    @EnvironmentObject var identity: IdentityStore
    @EnvironmentObject var loc: AppLanguage
    @State private var confirmText = ""
    @State private var finalConfirm = false

    private var phrase: String { loc.t("profile.deleteWord") }
    private var canDelete: Bool {
        confirmText.trimmingCharacters(in: .whitespaces).uppercased() == phrase
    }

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 10) {
                            Image(systemName: "key.fill")
                                .font(.system(size: 15))
                                .foregroundStyle(Theme.warn)
                            Text(loc.t("profile.keyTitle"))
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundStyle(Theme.text)
                        }
                        Text(loc.t("profile.keyBody"))
                            .font(.system(size: 13.5))
                            .foregroundStyle(Theme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(14)
                    .background(Theme.panel, in: RoundedRectangle(cornerRadius: 16, style: .continuous))

                    VStack(alignment: .leading, spacing: 8) {
                        Text(loc.t("profile.confirmWord"))
                            .font(.system(size: 13.5))
                            .foregroundStyle(Theme.muted)
                        TextField(phrase, text: $confirmText)
                            .font(.system(size: 17, weight: .semibold, design: .monospaced))
                            .foregroundStyle(Theme.text)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.characters)
                            .padding(.horizontal, 14).padding(.vertical, 12)
                            .background(Theme.panelInput, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .strokeBorder(canDelete ? Theme.danger.opacity(0.6) : Color.clear, lineWidth: 1)
                            )
                    }

                    Button { finalConfirm = true } label: {
                        Text(loc.t("profile.deleteForever"))
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(canDelete ? .white : Theme.muted)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background(canDelete ? Theme.danger : Theme.panel,
                                        in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(!canDelete)
                }
                .padding(.horizontal, 14).padding(.top, 12)
            }
        }
        .navigationTitle(loc.t("profile.manage"))
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog(loc.t("profile.deleteQ"), isPresented: $finalConfirm, titleVisibility: .visible) {
            Button(loc.t("common.delete"), role: .destructive) { identity.deleteAccount() }
            Button(loc.t("common.cancel"), role: .cancel) {}
        } message: {
            Text(loc.t("profile.deleteNote"))
        }
    }
}
