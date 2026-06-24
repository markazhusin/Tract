import SwiftUI

/// Supported interface languages. English and Russian for now; the table below is
/// structured so more can be added by appending a column.
enum Lang: String, CaseIterable, Identifiable {
    case en, ru
    var id: String { rawValue }
    var nativeName: String { self == .en ? "English" : "Русский" }
    var flag: String { self == .en ? "🇬🇧" : "🇷🇺" }
}

/// App-wide language state, reactive: views that read it via `@EnvironmentObject`
/// re-render when the language changes, so switching is instant with no restart.
/// The choice is persisted; on first launch it defaults to the device language and
/// the app shows a one-time picker (see `LanguagePickerView`).
final class AppLanguage: ObservableObject {
    static let shared = AppLanguage()

    @Published var lang: Lang {
        didSet { UserDefaults.standard.set(lang.rawValue, forKey: Self.langKey) }
    }
    /// True once the user has explicitly picked a language (drives the first-launch picker).
    @Published var chosen: Bool {
        didSet { UserDefaults.standard.set(chosen, forKey: Self.chosenKey) }
    }

    private static let langKey = "tract.lang"
    private static let chosenKey = "tract.langChosen"

    private init() {
        if let s = UserDefaults.standard.string(forKey: Self.langKey), let l = Lang(rawValue: s) {
            lang = l
        } else {
            let pref = Locale.preferredLanguages.first ?? "en"
            lang = pref.lowercased().hasPrefix("ru") ? .ru : .en
        }
        chosen = UserDefaults.standard.bool(forKey: Self.chosenKey)
    }

    /// Localized string for a key (falls back to English, then the key itself).
    func t(_ key: String) -> String {
        L10n.table[key]?[lang] ?? L10n.table[key]?[.en] ?? key
    }

    func choose(_ l: Lang) { lang = l; chosen = true }
}

/// Convenience: a global lookup for non-View contexts (uses the current language).
func L(_ key: String) -> String { AppLanguage.shared.t(key) }

/// The string table. Keys are stable identifiers; values are per-language. Surfaces
/// not yet present here fall back to their in-code text and can be migrated over time.
enum L10n {
    static let table: [String: [Lang: String]] = [
        // Tabs
        "tab.contacts": [.en: "Contacts", .ru: "Контакты"],
        "tab.calls":    [.en: "Calls",    .ru: "Звонки"],
        "tab.chats":    [.en: "Chats",    .ru: "Чаты"],
        "tab.settings": [.en: "Settings", .ru: "Настройки"],

        // Language picker
        "lang.title":    [.en: "Choose your language", .ru: "Выберите язык"],
        "lang.subtitle": [.en: "You can change this later in Settings.",
                          .ru: "Позже можно изменить в Настройках."],
        "lang.continue": [.en: "Continue", .ru: "Продолжить"],
        "settings.language": [.en: "Language", .ru: "Язык"],
        "settings.language.sub": [.en: "Interface language.", .ru: "Язык интерфейса."],

        // Settings — sections
        "settings.title":            [.en: "Settings",   .ru: "Настройки"],
        "settings.section.transport":[.en: "Transport",  .ru: "Транспорт"],
        "settings.section.notif":    [.en: "Notifications", .ru: "Уведомления"],
        "settings.section.privacy":  [.en: "Privacy & network", .ru: "Приватность и сеть"],

        // Settings — transport
        "settings.transport.nearby": [.en: "Nearby (Wi-Fi + Bluetooth)", .ru: "Рядом (Wi-Fi + Bluetooth)"],
        "settings.transport.internet": [.en: "Internet (P2P)", .ru: "Интернет (P2P)"],
        "settings.transport.off":    [.en: "Off",          .ru: "Выключен"],
        "settings.transport.noaccess":[.en: "No access",   .ru: "Нет доступа"],
        "settings.transport.notrunning":[.en: "Not running", .ru: "Не запущен"],
        "settings.transport.searching":[.en: "Searching…", .ru: "Поиск…"],
        "settings.transport.nearbyCount":[.en: "nearby",   .ru: "рядом"],
        "settings.transport.connectedNode":[.en: "Connected (node)", .ru: "Подключён (узел)"],
        "settings.transport.viaDHT": [.en: "Via DHT",       .ru: "Через DHT"],
        "settings.transport.connecting":[.en: "Connecting…", .ru: "Подключение…"],
        "settings.transport.hint":   [.en: "The route is chosen automatically: nearby → mesh (Wi-Fi/Bluetooth, no server); else → internet P2P; if it can't connect → relay. Calls and chats use the same channel, directly and encrypted (E2E). The mesh works while the app is open.",
                                       .ru: "Маршрут выбирается автоматически: рядом → меш (Wi-Fi/Bluetooth, без сервера); иначе → интернет P2P; не пробилось → ретранслятор. Звонки и чаты идут по тому же каналу, напрямую и зашифрованно (E2E). Меш работает, пока приложение открыто."],

        // Settings — notifications
        "settings.notif.messages":   [.en: "Messages", .ru: "Сообщения"],
        "settings.notif.calls":      [.en: "Calls",    .ru: "Звонки"],
        "settings.notif.on":         [.en: "Arrive when the app is backgrounded. If iOS has fully evicted the app, a notification can't be delivered without a push server.",
                                       .ru: "Приходят, когда приложение свёрнуто. Если iOS полностью выгрузила приложение из памяти, доставить уведомление без сервера push нельзя."],
        "settings.notif.off":        [.en: "Notifications are disabled in iOS settings — enable them for Tract to get message and call alerts.",
                                       .ru: "Уведомления выключены в настройках iOS — включите их для Tract, чтобы получать сигналы о сообщениях и звонках."],

        // Settings — privacy
        "settings.privacy.nearby":   [.en: "Find nearby", .ru: "Поиск рядом"],
        "settings.privacy.nearby.sub":[.en: "Find devices over Wi-Fi/Bluetooth with no internet.",
                                       .ru: "Находить устройства по Wi-Fi/Bluetooth без интернета."],
        "settings.privacy.stealth":  [.en: "Invisible", .ru: "Невидимость"],
        "settings.privacy.stealth.sub":[.en: "You're hidden nearby and online, but your device keeps relaying others' messages, like a courier.",
                                       .ru: "Вас не видно рядом и в сети, но устройство продолжает передавать чужие сообщения, как курьер."],
        "settings.privacy.reserve":  [.en: "Reserve signaling", .ru: "Резервный сигналинг"],
        "settings.privacy.reserve.sub":[.en: "A third-party channel (GetStream) as a last resort — when there's neither a node nor the DHT (e.g. a VPN filtering UDP). Turn off for fully serverless operation: mesh + nodes + DHT.",
                                       .ru: "Сторонний канал (GetStream) на крайний случай — когда нет ни узла, ни DHT (например, VPN режет UDP). Выключите для полностью бессерверной работы: меш + узлы + DHT."],
        "settings.privacy.passcode": [.en: "Passcode", .ru: "Код-пароль"],
        "settings.privacy.passcode.sub":[.en: "Ask for a passcode on launch and after backgrounding.",
                                       .ru: "Запрашивать код при входе и после сворачивания."],

        // Settings — account
        "settings.profile":          [.en: "My profile", .ru: "Мой профиль"],
        "settings.lock":             [.en: "Lock",        .ru: "Заблокировать"],
        "settings.localAccount":     [.en: "Local account", .ru: "Локальный аккаунт"],

        // Common list headers / empty states
        "chats.title":     [.en: "Chats",    .ru: "Чаты"],
        "contacts.title":  [.en: "Contacts", .ru: "Контакты"],
        "calls.title":     [.en: "Calls",    .ru: "Звонки"],
        "chats.empty.title":   [.en: "No chats", .ru: "Нет чатов"],
        "chats.empty.sub":     [.en: "Add a contact by ID with the button above, or wait for a device nearby over the mesh.",
                                .ru: "Добавьте контакт по ID кнопкой вверху или дождитесь устройство рядом по мешу."],
        "common.addById":  [.en: "Add by ID", .ru: "Добавить по ID"],
        "nearby.count":    [.en: "nearby:",   .ru: "рядом:"],
    ]
}
