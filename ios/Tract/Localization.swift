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
        "common.done":     [.en: "Done",      .ru: "Готово"],
        "nearby.count":    [.en: "nearby:",   .ru: "рядом:"],

        // Add contact / QR
        "add.title":       [.en: "New contact", .ru: "Новый контакт"],
        "add.yourId":      [.en: "Your ID",     .ru: "Ваш ID"],
        "add.copyId":      [.en: "Copy ID",     .ru: "Скопировать ID"],
        "add.copied":      [.en: "Copied",      .ru: "Скопировано"],
        "add.scanQR":      [.en: "Scan QR code", .ru: "Сканировать QR-код"],
        "add.byId":        [.en: "Add by ID",   .ru: "Добавить по ID"],
        "add.placeholder": [.en: "@id or tract link", .ru: "@id или tract-ссылка"],
        "add.searching":   [.en: "Searching…",  .ru: "Ищу контакт…"],
        "add.connecting":  [.en: "The network is still connecting — try again in a couple of seconds.",
                            .ru: "Сеть ещё подключается — повторите через пару секунд."],
        "add.notFound":    [.en: "Not found. The contact must have been online at least once — or add them by their QR / tract link.",
                            .ru: "Не найдено. Контакт должен быть онлайн хотя бы раз — или добавьте по его QR / tract-ссылке."],
        "add.scanError":   [.en: "Camera unavailable. Allow camera access in iOS Settings → Tract.",
                            .ru: "Камера недоступна. Разрешите доступ в Настройках iOS → Tract."],

        "common.cancel":   [.en: "Cancel",  .ru: "Отмена"],
        "common.delete":   [.en: "Delete",  .ru: "Удалить"],
        "common.copy":     [.en: "Copy",    .ru: "Копировать"],
        "common.call":     [.en: "Call",    .ru: "Позвонить"],
        "common.search":   [.en: "Search",  .ru: "Поиск"],

        // Auth
        "auth.register.sub": [.en: "Create an account — the key is generated on the device. No server, works offline.",
                              .ru: "Создайте аккаунт — ключ генерируется на устройстве. Без сервера, работает офлайн."],
        "auth.login.sub":    [.en: "Enter your password to unlock the account on this device.",
                              .ru: "Введите пароль, чтобы разблокировать аккаунт на этом устройстве."],
        "auth.name":         [.en: "Name",     .ru: "Имя"],
        "auth.password":     [.en: "Password", .ru: "Пароль"],
        "auth.confirm":      [.en: "Repeat password", .ru: "Повторите пароль"],
        "auth.create":       [.en: "Create account", .ru: "Создать аккаунт"],
        "auth.login":        [.en: "Log in",   .ru: "Войти"],
        "auth.haveAccount":  [.en: "I already have an account", .ru: "У меня уже есть аккаунт"],
        "auth.newAccount":   [.en: "Create a new account", .ru: "Создать новый аккаунт"],
        "auth.err.name":     [.en: "Enter a name", .ru: "Введите имя"],
        "auth.err.short":    [.en: "Password must be at least 6 characters", .ru: "Пароль должен быть не короче 6 символов"],
        "auth.err.mismatch": [.en: "Passwords don't match", .ru: "Пароли не совпадают"],
        "auth.err.create":   [.en: "Couldn't create the account", .ru: "Не удалось создать аккаунт"],
        "auth.err.pwd":      [.en: "Enter your password", .ru: "Введите пароль"],
        "auth.err.login":    [.en: "Couldn't log in", .ru: "Не удалось войти"],

        // Profile
        "profile.title":     [.en: "My profile", .ru: "Мой профиль"],
        "profile.manage":    [.en: "Account management", .ru: "Управление аккаунтом"],
        "profile.deleteWord":[.en: "DELETE", .ru: "УДАЛИТЬ"],
        "profile.keyTitle":  [.en: "An account is a crypto key", .ru: "Аккаунт — это криптоключ"],
        "profile.keyBody":   [.en: "Your ID and conversations exist only on this device. Deleting erases the private key irreversibly — neither the ID nor the history can be recovered. There are no backup servers.",
                              .ru: "Ваш ID и переписка существуют только на этом устройстве. Удаление стирает приватный ключ безвозвратно — вернуть ни ID, ни историю будет нельзя. Серверов с резервной копией не существует."],
        "profile.confirmWord":[.en: "To confirm, type the word \"DELETE\"", .ru: "Чтобы подтвердить, введите слово «УДАЛИТЬ»"],
        "profile.deleteForever":[.en: "Delete account forever", .ru: "Удалить аккаунт навсегда"],
        "profile.deleteQ":   [.en: "Delete the account forever?", .ru: "Удалить аккаунт навсегда?"],
        "profile.deleteNote":[.en: "The key will be erased from this device with no way to recover it.",
                              .ru: "Ключ будет стёрт с этого устройства без возможности восстановления."],

        // Call overlay
        "call.outgoing":     [.en: "Calling…", .ru: "Вызов…"],
        "call.incomingMesh": [.en: "Incoming call over the mesh", .ru: "Входящий звонок по мешу"],
        "call.connected":    [.en: "Connected • no server", .ru: "Соединено • без сервера"],
        "call.ended":        [.en: "Call ended", .ru: "Звонок завершён"],
        "call.micDenied":    [.en: "No microphone access — enable it in iOS Settings", .ru: "Нет доступа к микрофону — включите в Настройках iOS"],
        "call.decline":      [.en: "Decline", .ru: "Отклонить"],
        "call.accept":       [.en: "Accept",  .ru: "Принять"],
        "call.micOn":        [.en: "Unmute",  .ru: "Вкл. микр."],
        "call.micOff":       [.en: "Mute",    .ru: "Выкл. микр."],
        "call.hangup":       [.en: "End",     .ru: "Завершить"],

        // Call reasons (shown in the overlay)
        "call.reason.lost":     [.en: "Connection lost",   .ru: "Соединение потеряно"],
        "call.reason.declined": [.en: "Call declined",     .ru: "Звонок отклонён"],
        "call.reason.noconn":   [.en: "No connection",     .ru: "Нет связи"],
        "call.reason.offline":  [.en: "Contact is offline", .ru: "Абонент не в сети"],
        "call.reason.dropped":  [.en: "Connection dropped", .ru: "Связь прервана"],
        "call.reason.compromised":[.en: "Channel compromised", .ru: "Канал скомпрометирован"],

        // Calls list
        "calls.empty.title": [.en: "Call log is empty", .ru: "Журнал звонков пуст"],
        "calls.empty.sub":   [.en: "Call from a chat or with the \"New call\" button. Nearby — over the mesh; over the internet — directly via WebRTC.",
                              .ru: "Звоните из чата или кнопкой «Новый звонок». Рядом — по мешу, по интернету — напрямую через WebRTC."],
        "calls.all":         [.en: "All", .ru: "Все"],
        "calls.missed":      [.en: "Missed", .ru: "Пропущенные"],
        "calls.noMissed":    [.en: "No missed calls", .ru: "Пропущенных звонков нет"],
        "calls.new":         [.en: "New call", .ru: "Новый звонок"],
        "calls.clearQ":      [.en: "Clear the whole call log?", .ru: "Очистить весь журнал звонков?"],
        "calls.clear":       [.en: "Clear", .ru: "Очистить"],
        "calls.noContacts.title":[.en: "No contacts", .ru: "Нет контактов"],
        "calls.noContacts.sub":[.en: "Add a contact by ID to call them.", .ru: "Добавьте контакт по ID, чтобы позвонить."],
        "calls.kind.missed":  [.en: "Missed",   .ru: "Пропущенный"],
        "calls.kind.outgoing":[.en: "Outgoing", .ru: "Исходящий"],
        "calls.kind.incoming":[.en: "Incoming", .ru: "Входящий"],
        "calls.via.mesh":     [.en: "over the mesh", .ru: "по мешу"],
        "calls.via.internet": [.en: "over the internet", .ru: "по интернету"],
        "calls.yesterday":    [.en: "yesterday", .ru: "вчера"],

        // Chat detail
        "chat.e2eNote":      [.en: "Messages are E2E-encrypted and go directly — nodes don't read them.",
                              .ru: "Сообщения E2E-зашифрованы и идут напрямую — узлы их не читают."],
        "chat.message":      [.en: "Message", .ru: "Сообщение"],
        "chat.sendError":    [.en: "Couldn't send: incompatible contact (different key type).",
                              .ru: "Не удалось отправить: контакт несовместим (другой тип ключа)."],

        // Lock
        "lock.enter":        [.en: "Enter passcode", .ru: "Введите код-пароль"],
        "lock.repeat":       [.en: "Repeat the code", .ru: "Повторите код"],
        "lock.create":       [.en: "Set a passcode", .ru: "Придумайте код"],

        // Contacts statuses / empty
        "contacts.empty.title":[.en: "No one yet", .ru: "Пока никого"],
        "contacts.empty.sub":  [.en: "Add a contact by ID or wait for a device nearby over the mesh.",
                                .ru: "Добавьте контакт по ID или дождитесь устройство рядом по мешу."],
        "contacts.nearby":     [.en: "Nearby", .ru: "Рядом"],
        "status.nearby":       [.en: "nearby", .ru: "рядом"],
        "status.online":       [.en: "online", .ru: "в сети"],
        "status.seen.justnow": [.en: "last seen just now", .ru: "был(а) только что"],
        "status.seen.minsAgo": [.en: "last seen %d min ago", .ru: "был(а) %d мин назад"],
        "status.seen.recently":[.en: "last seen recently", .ru: "был(а) недавно"],
        "status.seen.todayAt": [.en: "last seen today at %@", .ru: "был(а) в %@"],
        "status.seen.yesterdayAt":[.en: "last seen yesterday at %@", .ru: "был(а) вчера в %@"],
        "status.seen.onDate":  [.en: "last seen %@", .ru: "был(а) %@"],

        // Search sheet
        "search.empty.title":  [.en: "Nothing found", .ru: "Ничего не найдено"],
        "search.empty.sub":    [.en: "Add a contact by their ID.", .ru: "Добавьте контакт по его ID."],

        // Route labels
        "route.localMesh":     [.en: "Local mesh", .ru: "Локальный меш"],
        "route.internetP2P":   [.en: "Internet (P2P)", .ru: "Интернет (P2P)"],
        "route.offline":       [.en: "offline", .ru: "не в сети"],
        "route.relay":         [.en: "relay", .ru: "ретранслятор"],
        "route.online":        [.en: "online", .ru: "в сети"],
        "route.nearby":        [.en: "nearby", .ru: "рядом"],

        // Mesh permission hint
        "mesh.localNetworkDenied":[.en: "No local-network access. iOS Settings → Tract → \"Local Network\" → enable.",
                                   .ru: "Нет доступа к локальной сети. Настройки iOS → Tract → «Локальная сеть» → включить."],
        "mesh.startFailed":    [.en: "Mesh didn't start:", .ru: "Меш не запустился:"],
    ]
}
