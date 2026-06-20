import SwiftUI

struct ChatDetailView: View {
    @EnvironmentObject var mesh: MeshService
    @EnvironmentObject var call: CallService
    let contact: Contact

    @State private var draft = ""
    @FocusState private var inputFocused: Bool

    private var thread: [ChatMessage] { mesh.messages[contact.userId] ?? [] }

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 6) {
                        if thread.isEmpty {
                            Text("Сообщения E2E-зашифрованы и идут напрямую через меш, без сервера.")
                                .font(.system(size: 13))
                                .foregroundStyle(Theme.muted)
                                .multilineTextAlignment(.center)
                                .padding(.horizontal, 30)
                                .padding(.top, 30)
                        }
                        ForEach(thread) { m in
                            MessageBubble(message: m).id(m.id)
                        }
                        Color.clear.frame(height: 8).id("bottom")
                    }
                    .padding(.horizontal, 12)
                    .padding(.top, 10)
                }
                .onChange(of: thread.count) { _ in
                    withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
                }
                .onAppear {
                    mesh.markRead(contact.userId)
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
            }
        }
        .safeAreaInset(edge: .bottom) { inputBar }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                HStack(spacing: 9) {
                    Avatar(name: contact.displayName, seed: contact.userId, size: 32)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(contact.displayName).font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.text)
                        RouteBadge(quality: mesh.route(for: contact.userId))
                    }
                }
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { call.startCall(to: contact) } label: {
                    Image(systemName: "phone.fill")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(mesh.route(for: contact.userId) != .offline ? Theme.accent : Theme.muted)
                }
                .disabled(mesh.route(for: contact.userId) == .offline)
            }
        }
        .toolbarBackground(Theme.bgDeep, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
    }

    private var inputBar: some View {
        HStack(spacing: 10) {
            HStack {
                TextField("Сообщение", text: $draft, axis: .vertical)
                    .font(.system(size: 16))
                    .foregroundStyle(Theme.text)
                    .focused($inputFocused)
                    .lineLimit(1...5)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Theme.panelInput, in: RoundedRectangle(cornerRadius: 20, style: .continuous))

            Button(action: send) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 18, weight: .bold))
                    .foregroundStyle(Theme.onAccent)
                    .frame(width: 42, height: 42)
                    .background(canSend ? Theme.accent : Theme.muted.opacity(0.4), in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Theme.bgDeep)
    }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func send() {
        guard canSend else { return }
        mesh.send(text: draft, to: contact)
        draft = ""
    }
}

struct MessageBubble: View {
    let message: ChatMessage

    var body: some View {
        HStack {
            if message.fromMe { Spacer(minLength: 50) }
            VStack(alignment: .trailing, spacing: 2) {
                Text(message.text)
                    .font(.system(size: 16))
                    .foregroundStyle(message.fromMe ? Theme.onAccent : Theme.text)
                Text(timeString)
                    .font(.system(size: 10))
                    .foregroundStyle(message.fromMe ? Theme.onAccent.opacity(0.6) : Theme.muted)
            }
            .padding(.horizontal, 13)
            .padding(.vertical, 8)
            .background(
                message.fromMe ? Theme.accent : Theme.panel,
                in: RoundedRectangle(cornerRadius: 18, style: .continuous)
            )
            if !message.fromMe { Spacer(minLength: 50) }
        }
    }

    private var timeString: String {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f.string(from: message.time)
    }
}
