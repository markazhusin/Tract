import SwiftUI
import UIKit

private let pinLength = 4

// MARK: - PIN dots + keypad (shared)

struct PinDots: View {
    let count: Int
    var error: Bool = false
    var body: some View {
        HStack(spacing: 18) {
            ForEach(0..<pinLength, id: \.self) { i in
                Circle()
                    .strokeBorder(error ? Theme.danger : Theme.muted, lineWidth: 1.5)
                    .background(Circle().fill(i < count ? (error ? Theme.danger : Theme.accent) : .clear))
                    .frame(width: 16, height: 16)
            }
        }
        .frame(height: 20)
    }
}

struct PinPad: View {
    let onDigit: (String) -> Void
    let onDelete: () -> Void

    private let rows = [["1","2","3"],["4","5","6"],["7","8","9"],["","0","⌫"]]

    var body: some View {
        VStack(spacing: 16) {
            ForEach(rows, id: \.self) { row in
                HStack(spacing: 26) {
                    ForEach(row, id: \.self) { key in
                        keyButton(key)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func keyButton(_ key: String) -> some View {
        if key.isEmpty {
            Color.clear.frame(width: 72, height: 72)
        } else if key == "⌫" {
            Button(action: onDelete) {
                Image(systemName: "delete.left").font(.system(size: 22)).foregroundStyle(Theme.text)
                    .frame(width: 72, height: 72)
            }.buttonStyle(.plain)
        } else {
            Button { onDigit(key) } label: {
                Text(key).font(.system(size: 30, weight: .regular)).foregroundStyle(Theme.text)
                    .frame(width: 72, height: 72)
                    .background(Theme.panel, in: Circle())
            }.buttonStyle(.plain)
        }
    }
}

// MARK: - Lock screen (entry)

struct LockView: View {
    @EnvironmentObject var lock: AppLock
    @EnvironmentObject var loc: AppLanguage
    @State private var pin = ""
    @State private var error = false

    var body: some View {
        ZStack {
            LinearGradient(colors: [Theme.bgDeep, Theme.bg], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()
            VStack(spacing: 28) {
                Spacer()
                Image(systemName: "lock.fill").font(.system(size: 34)).foregroundStyle(Theme.accent)
                Text(loc.t("lock.enter")).font(.system(size: 18, weight: .semibold)).foregroundStyle(Theme.text)
                PinDots(count: pin.count, error: error)
                Spacer()
                PinPad(onDigit: add, onDelete: del)
                Spacer()
            }
            .padding(.bottom, 30)
        }
    }

    private func add(_ d: String) {
        guard pin.count < pinLength else { return }
        error = false
        pin += d
        if pin.count == pinLength {
            if !lock.unlock(pin) {
                error = true
                let g = UINotificationFeedbackGenerator(); g.notificationOccurred(.error)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { pin = "" }
            }
        }
    }

    private func del() { if !pin.isEmpty { pin.removeLast(); error = false } }
}

// MARK: - Set / change passcode (sheet)

struct PasscodeSetupView: View {
    @EnvironmentObject var lock: AppLock
    @EnvironmentObject var loc: AppLanguage
    @Environment(\.dismiss) private var dismiss

    @State private var first = ""
    @State private var confirm = ""
    @State private var confirming = false
    @State private var error = false

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            VStack(spacing: 26) {
                Spacer()
                Image(systemName: "lock.shield.fill").font(.system(size: 32)).foregroundStyle(Theme.accent)
                Text(confirming ? loc.t("lock.repeat") : loc.t("lock.create"))
                    .font(.system(size: 18, weight: .semibold)).foregroundStyle(Theme.text)
                PinDots(count: confirming ? confirm.count : first.count, error: error)
                Spacer()
                PinPad(onDigit: add, onDelete: del)
                Button(loc.t("common.cancel")) { dismiss() }.foregroundStyle(Theme.muted).padding(.top, 4)
                Spacer()
            }
            .padding(.bottom, 24)
        }
    }

    private func add(_ d: String) {
        error = false
        if !confirming {
            guard first.count < pinLength else { return }
            first += d
            if first.count == pinLength { confirming = true }
        } else {
            guard confirm.count < pinLength else { return }
            confirm += d
            if confirm.count == pinLength {
                if confirm == first {
                    lock.setPasscode(first)
                    dismiss()
                } else {
                    error = true
                    let g = UINotificationFeedbackGenerator(); g.notificationOccurred(.error)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                        confirm = ""; first = ""; confirming = false
                    }
                }
            }
        }
    }

    private func del() {
        if confirming { if !confirm.isEmpty { confirm.removeLast() } }
        else if !first.isEmpty { first.removeLast() }
        error = false
    }
}
