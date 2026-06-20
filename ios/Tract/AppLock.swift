import Foundation
import Combine
import CryptoKit

/// Optional passcode lock at app entry (and when returning from background).
final class AppLock: ObservableObject {
    @Published var isLocked: Bool = false
    @Published private(set) var isEnabled: Bool = false

    private let key = "tract.passcode"   // stores a salted SHA-256 hash, never the PIN

    init() {
        isEnabled = UserDefaults.standard.string(forKey: key) != nil
        isLocked = isEnabled
    }

    func setPasscode(_ pin: String) {
        UserDefaults.standard.set(Self.hash(pin), forKey: key)
        isEnabled = true
        isLocked = false
    }

    func disable() {
        UserDefaults.standard.removeObject(forKey: key)
        isEnabled = false
        isLocked = false
    }

    @discardableResult
    func unlock(_ pin: String) -> Bool {
        guard isEnabled, Self.hash(pin) == UserDefaults.standard.string(forKey: key) else { return false }
        isLocked = false
        return true
    }

    func lockIfEnabled() { if isEnabled { isLocked = true } }

    private static func hash(_ pin: String) -> String {
        let d = SHA256.hash(data: Data(("tract-lock-v1:" + pin).utf8))
        return d.map { String(format: "%02x", $0) }.joined()
    }
}
