import SwiftUI

struct CallOverlayView: View {
    @EnvironmentObject var call: CallService

    private var title: String {
        switch call.phase {
        case .idle: return ""
        case .outgoing(let n): return n
        case .incoming(_, let n): return n
        case .connected(let n): return n
        case .ended: return ""
        }
    }

    private var subtitle: String {
        switch call.phase {
        case .outgoing: return "Вызов…"
        case .incoming: return "Входящий звонок по мешу"
        case .connected: return "Соединено • без сервера"
        case .ended(let r): return r.isEmpty ? "Звонок завершён" : r
        case .idle: return ""
        }
    }

    private var seed: String {
        switch call.phase {
        case .incoming(let from, _): return from
        default: return title
        }
    }

    var body: some View {
        ZStack {
            LinearGradient(colors: [Theme.bgDeep, Theme.bg], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()

            VStack(spacing: 18) {
                Spacer()
                Avatar(name: title.isEmpty ? "?" : title, seed: seed, size: 128)
                    .shadow(color: Theme.accent.opacity(0.25), radius: 30)
                Text(title).font(.system(size: 28, weight: .bold)).foregroundStyle(Theme.text)
                HStack(spacing: 7) {
                    Image(systemName: "lock.fill").font(.system(size: 12)).foregroundStyle(Theme.accent)
                    Text(subtitle).font(.system(size: 15)).foregroundStyle(Theme.muted)
                }
                if call.micDenied {
                    Text("Нет доступа к микрофону — включите в Настройках iOS")
                        .font(.system(size: 13)).foregroundStyle(Theme.danger)
                        .multilineTextAlignment(.center).padding(.horizontal, 40)
                }
                Spacer()
                controls
                    .padding(.bottom, 50)
            }
        }
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    @ViewBuilder
    private var controls: some View {
        switch call.phase {
        case .incoming:
            HStack(spacing: 70) {
                CallButton(icon: "phone.down.fill", color: Theme.danger, label: "Отклонить") { call.decline() }
                CallButton(icon: "phone.fill", color: Theme.online, label: "Принять") { call.accept() }
            }
        case .outgoing, .connected:
            HStack(spacing: 50) {
                if case .connected = call.phase {
                    CallButton(icon: call.muted ? "mic.slash.fill" : "mic.fill",
                               color: call.muted ? Theme.warn : Theme.panel,
                               label: call.muted ? "Вкл. микр." : "Выкл. микр.") { call.toggleMute() }
                }
                CallButton(icon: "phone.down.fill", color: Theme.danger, label: "Завершить") { call.hangUp() }
            }
        case .ended, .idle:
            EmptyView()
        }
    }
}

struct CallButton: View {
    let icon: String
    let color: Color
    let label: String
    let action: () -> Void

    var body: some View {
        VStack(spacing: 8) {
            Button(action: action) {
                Image(systemName: icon)
                    .font(.system(size: 26, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 68, height: 68)
                    .background(color, in: Circle())
            }
            .buttonStyle(.plain)
            Text(label).font(.system(size: 13)).foregroundStyle(Theme.muted)
        }
    }
}
