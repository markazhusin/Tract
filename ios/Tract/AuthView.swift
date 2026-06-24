import SwiftUI

struct AuthView: View {
    @EnvironmentObject var identity: IdentityStore
    @EnvironmentObject var loc: AppLanguage

    enum Mode { case register, login }
    @State private var mode: Mode = .register
    @State private var name = ""
    @State private var password = ""
    @State private var confirm = ""
    @State private var error = ""
    @State private var busy = false
    @FocusState private var focused: Field?

    enum Field { case name, password, confirm }

    var body: some View {
        ZStack {
            LinearGradient(colors: [Theme.bgDeep, Theme.bg],
                           startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()

            ScrollView {
                VStack(spacing: 22) {
                    Spacer(minLength: 40)

                    VStack(spacing: 12) {
                        ZStack {
                            Circle().fill(Theme.accent.opacity(0.16)).frame(width: 92, height: 92)
                            Image(systemName: "dot.radiowaves.left.and.right")
                                .font(.system(size: 40, weight: .semibold))
                                .foregroundStyle(Theme.accent)
                        }
                        Text("Tract")
                            .font(.system(size: 30, weight: .bold))
                            .foregroundStyle(Theme.text)
                        Text(mode == .register
                             ? loc.t("auth.register.sub")
                             : loc.t("auth.login.sub"))
                            .font(.system(size: 14))
                            .foregroundStyle(Theme.muted)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 12)
                    }

                    VStack(spacing: 12) {
                        if mode == .register {
                            field(icon: "person", placeholder: loc.t("auth.name"), text: $name)
                                .focused($focused, equals: .name)
                                .textInputAutocapitalization(.words)
                        }
                        field(icon: "lock", placeholder: loc.t("auth.password"), text: $password, secure: true)
                            .focused($focused, equals: .password)
                        if mode == .register {
                            field(icon: "lock.rotation", placeholder: loc.t("auth.confirm"), text: $confirm, secure: true)
                                .focused($focused, equals: .confirm)
                        }

                        if !error.isEmpty {
                            Text(error)
                                .font(.system(size: 13))
                                .foregroundStyle(Theme.danger)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }

                        Button(action: submit) {
                            HStack {
                                if busy { ProgressView().tint(Theme.onAccent) }
                                Text(mode == .register ? loc.t("auth.create") : loc.t("auth.login"))
                                    .font(.system(size: 17, weight: .semibold))
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 15)
                            .background(Theme.accent, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                            .foregroundStyle(Theme.onAccent)
                        }
                        .buttonStyle(.plain)
                        .disabled(busy)
                        .padding(.top, 4)
                    }
                    .padding(18)
                    .background(Theme.panel.opacity(0.7), in: RoundedRectangle(cornerRadius: 22, style: .continuous))

                    Button {
                        withAnimation { switchMode() }
                    } label: {
                        Text(mode == .register ? loc.t("auth.haveAccount") : loc.t("auth.newAccount"))
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(Theme.accent)
                    }
                    .buttonStyle(.plain)

                    Spacer(minLength: 40)
                }
                .padding(.horizontal, 22)
            }
        }
        .onAppear { if identity.hasAccount { mode = .login } }
    }

    @ViewBuilder
    private func field(icon: String, placeholder: String, text: Binding<String>, secure: Bool = false) -> some View {
        HStack(spacing: 11) {
            Image(systemName: icon).font(.system(size: 16)).foregroundStyle(Theme.muted).frame(width: 22)
            Group {
                if secure {
                    SecureField(placeholder, text: text)
                } else {
                    TextField(placeholder, text: text)
                }
            }
            .font(.system(size: 16))
            .foregroundStyle(Theme.text)
            .autocorrectionDisabled()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 13)
        .background(Theme.panelInput, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func switchMode() {
        mode = mode == .register ? .login : .register
        error = ""
    }

    private func submit() {
        error = ""
        focused = nil
        if mode == .register {
            let trimmed = name.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty else { error = loc.t("auth.err.name"); return }
            guard password.count >= 6 else { error = loc.t("auth.err.short"); return }
            guard password == confirm else { error = loc.t("auth.err.mismatch"); return }
            busy = true
            do {
                try identity.createAccount(displayName: trimmed, password: password)
            } catch {
                self.error = loc.t("auth.err.create")
            }
            busy = false
        } else {
            guard !password.isEmpty else { error = loc.t("auth.err.pwd"); return }
            busy = true
            do {
                try identity.login(password: password)
            } catch let e as IdentityError {
                self.error = e.errorDescription ?? loc.t("auth.err.login")
            } catch {
                self.error = loc.t("auth.err.login")
            }
            busy = false
        }
    }
}
