import SwiftUI
import CoreImage.CIFilterBuiltins

/// "Мой профиль" — pushed from Settings. Holds identity (ID + QR) and, tucked at
/// the bottom in a danger zone, the deliberate account-deletion flow (an action
/// sheet, not a one-tap alert), so it can't be hit by accident.
struct ProfileView: View {
    @EnvironmentObject var identity: IdentityStore
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
                        Text("Ваш ID").font(.system(size: 13)).foregroundStyle(Theme.muted)
                        Text(myId)
                            .font(.system(size: 19, weight: .bold, design: .monospaced))
                            .foregroundStyle(Theme.accent)
                            .textSelection(.enabled)
                        Button(action: copyId) {
                            Label(copied ? "Скопировано" : "Скопировать ID",
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
                            Text("Управление аккаунтом")
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
        .navigationTitle("Мой профиль")
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
    @State private var confirmText = ""
    @State private var finalConfirm = false

    private let phrase = "УДАЛИТЬ"
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
                            Text("Аккаунт — это криптоключ")
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundStyle(Theme.text)
                        }
                        Text("Ваш ID и переписка существуют только на этом устройстве. Удаление стирает приватный ключ безвозвратно — вернуть ни ID, ни историю будет нельзя. Серверов с резервной копией не существует.")
                            .font(.system(size: 13.5))
                            .foregroundStyle(Theme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(14)
                    .background(Theme.panel, in: RoundedRectangle(cornerRadius: 16, style: .continuous))

                    VStack(alignment: .leading, spacing: 8) {
                        Text("Чтобы подтвердить, введите слово «\(phrase)»")
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
                        Text("Удалить аккаунт навсегда")
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
        .navigationTitle("Управление аккаунтом")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Удалить аккаунт навсегда?", isPresented: $finalConfirm, titleVisibility: .visible) {
            Button("Удалить", role: .destructive) { identity.deleteAccount() }
            Button("Отмена", role: .cancel) {}
        } message: {
            Text("Ключ будет стёрт с этого устройства без возможности восстановления.")
        }
    }
}
