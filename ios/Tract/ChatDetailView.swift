import SwiftUI

struct ChatDetailView: View {
    @EnvironmentObject var mesh: MeshService
    @EnvironmentObject var call: CallService
    @EnvironmentObject var node: NodeConfig
    let contact: Contact

    private var canCall: Bool { mesh.route(for: contact.userId) != .offline || node.isConfigured }

    @State private var draft = ""
    @State private var sendError = ""
    @FocusState private var inputFocused: Bool

    private var thread: [ChatMessage] { mesh.messages[contact.userId] ?? [] }

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 3) {
                        if thread.isEmpty {
                            Text("Сообщения E2E-зашифрованы и идут напрямую — узлы их не читают.")
                                .font(.system(size: 13))
                                .foregroundStyle(Theme.muted)
                                .multilineTextAlignment(.center)
                                .padding(.horizontal, 36)
                                .padding(.top, 40)
                        }
                        ForEach(thread) { m in
                            MessageBubble(message: m).id(m.id)
                                .contextMenu {
                                    Button {
                                        UIPasteboard.general.string = m.text
                                    } label: { Label("Копировать", systemImage: "doc.on.doc") }
                                    Button(role: .destructive) {
                                        mesh.deleteMessage(m.id, in: contact.userId)
                                    } label: { Label("Удалить", systemImage: "trash") }
                                }
                        }
                        Color.clear.frame(height: 6).id("bottom")
                    }
                    .padding(.horizontal, 10)
                    .padding(.top, 10)
                }
                .onChange(of: thread.count) { _ in
                    mesh.openedChat(contact.userId)   // ack messages that arrive while open
                    withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
                }
                .onAppear {
                    mesh.openedChat(contact.userId)
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
            }
        }
        .safeAreaInset(edge: .bottom) { inputBar }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 1) {
                    Text(contact.displayName)
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(Theme.text)
                    Text(mesh.route(for: contact.userId).label)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.muted)
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                HStack(spacing: 14) {
                    Button { call.startCall(to: contact) } label: {
                        Image(systemName: "phone.fill")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(canCall ? Theme.accent : Theme.muted)
                    }
                    .disabled(!canCall)
                    Avatar(name: contact.displayName, seed: contact.userId, size: 32)
                }
            }
        }
        .toolbarBackground(Theme.bgDeep, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
    }

    private var inputBar: some View {
        VStack(spacing: 0) {
            if !sendError.isEmpty {
                Text(sendError)
                    .font(.system(size: 12.5))
                    .foregroundStyle(Theme.danger)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16).padding(.top, 6)
            }
            HStack(alignment: .bottom, spacing: 8) {
                Image(systemName: "paperclip")
                    .font(.system(size: 20))
                    .foregroundStyle(Theme.muted)
                    .frame(width: 30, height: 40)

                TextField("Сообщение", text: $draft, axis: .vertical)
                    .font(.system(size: 16.5))
                    .foregroundStyle(Theme.text)
                    .focused($inputFocused)
                    .lineLimit(1...6)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(Theme.panelInput, in: RoundedRectangle(cornerRadius: 20, style: .continuous))

                if canSend {
                    Button(action: send) {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 18, weight: .bold))
                            .foregroundStyle(Theme.onAccent)
                            .frame(width: 40, height: 40)
                            .background(Theme.accent, in: Circle())
                    }
                    .buttonStyle(.plain)
                } else {
                    Image(systemName: "mic.fill")
                        .font(.system(size: 19))
                        .foregroundStyle(Theme.muted)
                        .frame(width: 40, height: 40)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
        }
        .background(Theme.bgDeep)
    }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func send() {
        guard canSend else { return }
        if mesh.send(text: draft, to: contact) {
            draft = ""
            sendError = ""
        } else {
            sendError = "Не удалось отправить: контакт несовместим (другой тип ключа)."
        }
    }
}

struct MessageBubble: View {
    let message: ChatMessage

    private var textColor: Color { message.fromMe ? Theme.onAccent : Theme.text }
    private var metaColor: Color { message.fromMe ? Theme.onAccent.opacity(0.55) : Theme.muted }

    var body: some View {
        HStack(spacing: 0) {
            if message.fromMe { Spacer(minLength: 56) }
            // Bubble hugs the text; time + checks sit at the bottom-right.
            HStack(alignment: .bottom, spacing: 6) {
                Text(message.text)
                    .font(.system(size: 16.5))
                    .foregroundStyle(textColor)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 3) {
                    Text(timeString).font(.system(size: 11)).foregroundStyle(metaColor)
                    if message.fromMe { checks }
                }
                .padding(.bottom, 1)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(
                message.fromMe ? Theme.accent : Theme.bubbleIn,
                in: RoundedRectangle(cornerRadius: 18, style: .continuous)
            )
            if !message.fromMe { Spacer(minLength: 56) }
        }
    }

    /// ✓ sent · ✓✓ read (two overlapped check glyphs).
    private var checks: some View {
        HStack(spacing: -4) {
            Image(systemName: "checkmark")
            if message.read == true { Image(systemName: "checkmark") }
        }
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(metaColor)
    }

    private var timeString: String {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f.string(from: message.time)
    }
}
