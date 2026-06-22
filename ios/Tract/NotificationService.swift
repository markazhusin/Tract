import Foundation
import UserNotifications
import UIKit

/// Local notifications for incoming chats and calls, with independent on/off
/// switches the user controls in Settings.
///
/// Honest scope — read before assuming "push works when the app is closed":
///   • While Tract is in the FOREGROUND we suppress banners (the chat/call UI is
///     already on screen; the unread badge and call overlay cover it).
///   • While Tract is BACKGROUNDED but still alive (the system keeps a recently
///     used app resident for a while; an active call keeps us awake via the
///     `audio` background mode), an incoming packet still reaches us and we post a
///     local banner immediately.
///   • Once iOS FORCE-QUITS or fully suspends the process, no code runs to receive
///     the packet — so a true "app is closed" notification needs remote push
///     (APNs / PushKit) driven by a server. A serverless, local-first node has no
///     standing connection to wake the OS, so that case is a known limitation, not
///     something this layer can fake. The toggles below govern everything we *can*
///     deliver locally.
final class NotificationService: NSObject, ObservableObject {
    static let shared = NotificationService()

    @Published var chatsEnabled: Bool {
        didSet { UserDefaults.standard.set(chatsEnabled, forKey: Keys.chats) }
    }
    @Published var callsEnabled: Bool {
        didSet { UserDefaults.standard.set(callsEnabled, forKey: Keys.calls) }
    }
    /// Whether the user has granted notification permission (drives the hint in UI).
    @Published var authorized: Bool = false

    private enum Keys {
        static let chats = "tract.notif.chats"
        static let calls = "tract.notif.calls"
    }

    private override init() {
        chatsEnabled = (UserDefaults.standard.object(forKey: Keys.chats) as? Bool) ?? true
        callsEnabled = (UserDefaults.standard.object(forKey: Keys.calls) as? Bool) ?? true
        super.init()
        UNUserNotificationCenter.current().delegate = self
        refreshAuthorization()
    }

    /// Ask for permission once (no-op if already decided). Call after login.
    func requestAuthorization() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            DispatchQueue.main.async { self.authorized = granted }
        }
    }

    func refreshAuthorization() {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            DispatchQueue.main.async {
                self.authorized = settings.authorizationStatus == .authorized
                    || settings.authorizationStatus == .provisional
            }
        }
    }

    /// An incoming chat message arrived. Suppressed in the foreground (UI shows it)
    /// and when the user disabled chat notifications.
    func notifyMessage(from name: String, text: String) {
        guard chatsEnabled, !isForeground else { return }
        post(title: name.isEmpty ? "Новое сообщение" : name,
             body: text, sound: .default, identifier: "msg-\(name)")
    }

    /// An incoming call arrived. Suppressed in the foreground (the call overlay
    /// shows it) and when the user disabled call notifications.
    func notifyCall(from name: String) {
        guard callsEnabled, !isForeground else { return }
        post(title: name.isEmpty ? "Входящий звонок" : name,
             body: "Входящий звонок", sound: .defaultCritical, identifier: "call")
    }

    // MARK: - Internals

    private var isForeground: Bool {
        UIApplication.shared.applicationState == .active
    }

    private func post(title: String, body: String, sound: UNNotificationSound, identifier: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = sound
        let req = UNNotificationRequest(identifier: "\(identifier)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req)
    }
}

extension NotificationService: UNUserNotificationCenterDelegate {
    // We already gate on app state ourselves, so anything reaching here while the
    // app happens to be foregrounded should stay silent; background delivery is the
    // system's job.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([])
    }
}
