import Foundation
import Combine
import AVFoundation
import WebRTC

enum CallPhase: Equatable {
    case idle
    case outgoing(name: String)
    case incoming(from: String, name: String)
    case connected(name: String)
    case ended(reason: String)

    var isActive: Bool {
        if case .idle = self { return false }
        if case .ended = self { return false }
        return true
    }
}

enum CallMode { case mesh, internet }

/// One entry in the call journal. Persisted per-account so history survives
/// restarts. `userId` may be empty for an inbound internet call we couldn't map
/// to a known contact (we only have the remote signaling peer + its name).
struct CallRecord: Identifiable, Equatable, Codable {
    var id = UUID()
    let userId: String
    let name: String
    let outgoing: Bool        // true = we placed it
    let connected: Bool       // true once the call was actually answered
    let viaMesh: Bool         // true = local mesh, false = internet (WebRTC)
    let time: Date            // when it started
    var duration: TimeInterval = 0

    /// Incoming + never answered = missed (shown in red, like Telegram).
    var missed: Bool { !outgoing && !connected }
}

/// Calls with automatic transport: nearby → mesh (serverless, lowest latency);
/// otherwise → internet P2P via WebRTC (Opus, echo-cancelled), signaled through
/// the self-hosted node. The node only relays SDP/ICE — audio stays P2P/E2E.
final class CallService: ObservableObject {
    @Published var phase: CallPhase = .idle
    @Published var muted: Bool = false
    @Published var micDenied: Bool = false
    /// True once the BB84 key-agreement ceremony for the live call has completed
    /// without a QBER breach. A compromised exchange instead collapses the call.
    @Published var qkdVerified: Bool = false
    /// Call journal, newest first.
    @Published var history: [CallRecord] = []

    weak var mesh: MeshService?
    var node: NodeConfig?
    private var signaling: SignalingClient?
    /// Node-less internet rendezvous over the BitTorrent DHT — used when there is no
    /// node to relay signaling (e.g. an iPhone on LTE with no Tract node nearby).
    private var dht: DHTRendezvous { DHTRendezvous.shared }

    private var mode: CallMode = .mesh
    /// For an internet call, whether signaling goes over the DHT (no node) vs a node.
    private var internetViaDHT = false
    private var callId = ""
    private var remotePub = ""            // remote contact public key (for DHT E2E)
    private var dhtOfferSDP: String?      // a received DHT offer, awaiting accept
    private var peerUserId: String?      // remote app userId
    private var remotePeerId: String?    // remote signaling peerId (internet)
    private var remoteName: String = ""
    private var cancellable: AnyCancellable?

    // In-flight call metadata, folded into a CallRecord when the call concludes.
    private var recStartedAt: Date?
    private var recConnectedAt: Date?
    private var recOutgoing = false
    private var recPeerUserId = ""
    private var recPeerName = ""

    // Mesh audio (AVAudioEngine)
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var captureConverter: AVAudioConverter?
    private var audioActive = false
    private let wireFormat = AVAudioFormat(commonFormat: .pcmFormatInt16,
                                           sampleRate: 16_000, channels: 1, interleaved: true)!
    private let playFormat = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!

    // Internet audio (WebRTC)
    private var webrtc: WebRTCCallEngine?

    // BB84 quantum key-agreement ceremony for the live call. Runs over whatever
    // signaling transport the call uses; a QBER breach collapses the call.
    private var bb84: BB84Session?
    private var sessionKey: Data?

    private var myId: String { mesh?.identity?.userId ?? "" }
    private var myName: String { mesh?.identity?.displayName ?? "" }

    private static var stablePeerId: String {
        let k = "tract.peerId"
        if let s = UserDefaults.standard.string(forKey: k) { return s }
        let s = "ios-" + UUID().uuidString.prefix(8)
        UserDefaults.standard.set(String(s), forKey: k)
        return String(s)
    }

    // MARK: Wiring

    func configure(mesh: MeshService, node: NodeConfig) {
        self.mesh = mesh
        self.node = node
        mesh.onControl = { [weak self] payload, peer in self?.handleMeshControl(payload, from: peer) }
        mesh.onAudio = { [weak self] payload, _ in self?.handleMeshAudio(payload) }
        cancellable = mesh.$peerCount.sink { [weak self] count in
            guard let self else { return }
            if count == 0, self.mode == .mesh, self.phase.isActive {
                self.teardown(reason: "Соединение потеряно")
            }
        }
    }

    func goOnline(_ identity: Identity) {
        loadHistory()
        // Node-less DHT call signaling is always available (when no node, it's the
        // ONLY internet path; when a node exists, the node path is preferred).
        dht.onCallSignal = { [weak self] from, pub, type, payload in
            self?.handleDHTSignal(from: from, pub: pub, type: type, payload: payload)
        }
        guard let node else { return }
        let sig = SignalingClient(node: node, peerId: Self.stablePeerId)
        sig.onSignal = { [weak self] from, type, payload in self?.handleSignal(from: from, type: type, payload: payload) }
        sig.start(userId: identity.userId, displayName: identity.displayName, publicKeyHex: identity.publicKeyHex)
        signaling = sig
    }

    func goOffline() {
        signaling?.stop()
        signaling = nil
        if phase.isActive { teardown(reason: "") }
        saveHistory()
        history = []
    }

    // MARK: Outgoing

    func startCall(to contact: Contact) {
        guard !phase.isActive else { return }
        peerUserId = contact.userId
        remoteName = contact.displayName
        remotePeerId = nil
        beginCallRecord(outgoing: true, userId: contact.userId, name: contact.displayName)

        if mesh?.reachability(of: contact.userId) == .localMesh {
            mode = .mesh
            internetViaDHT = false
            phase = .outgoing(name: contact.displayName)
            sendMesh(action: "invite")
        } else if let sig = signaling, node?.isConfigured == true {
            mode = .internet
            internetViaDHT = false
            phase = .outgoing(name: contact.displayName)
            Task { await internetInvite(contact, sig) }
        } else if dht.ready {
            // No node — find each other and signal directly over the BitTorrent DHT.
            mode = .internet
            internetViaDHT = true
            phase = .outgoing(name: contact.displayName)
            startDHTOutgoing(contact)
        } else {
            phase = .ended(reason: "Нет связи")
            finishCallRecord()        // a placed call that never connected
            autoClearEnded()
        }
    }

    // MARK: - DHT internet call (no node)

    private func startDHTOutgoing(_ contact: Contact) {
        callId = UUID().uuidString.prefix(12).lowercased()
        remotePub = contact.publicKeyHex
        peerUserId = contact.userId
        startDHTMedia(asCaller: true)
    }

    /// Build/answer media for the DHT path (non-trickle: ICE baked into one SDP).
    private func startDHTMedia(asCaller: Bool) {
        AVAudioSession.sharedInstance().requestRecordPermission { [weak self] granted in
            DispatchQueue.main.async {
                guard let self else { return }
                guard granted else { self.micDenied = true; return }
                Task {
                    let ice = await self.iceServersForDHT()
                    await MainActor.run {
                        self.ensureWebRTC(asCaller: asCaller)
                        self.webrtc?.configure(iceServers: ice)
                        if asCaller {
                            self.webrtc?.createOfferFull { sdp in
                                guard let sdp else { return }
                                let toUser = self.peerUserId ?? ""
                                let pub = self.remotePub
                                let payload: [String: Any] = ["callId": self.callId, "fromName": self.myName,
                                                              "sdp": sdp, "ts": Int64(Date().timeIntervalSince1970)]
                                Task { await self.dht.sendCall(toUserId: toUser, toPub: pub, type: "offer", payload: payload) }
                            }
                        } else if let offer = self.dhtOfferSDP {
                            self.webrtc?.setRemote(sdp: offer, type: .offer) {
                                self.webrtc?.createAnswerFull { ans in
                                    guard let ans else { return }
                                    let toUser = self.peerUserId ?? ""
                                    let pub = self.remotePub
                                    let payload: [String: Any] = ["callId": self.callId, "sdp": ans,
                                                                  "ts": Int64(Date().timeIntervalSince1970)]
                                    Task { await self.dht.sendCall(toUserId: toUser, toPub: pub, type: "answer", payload: payload) }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    /// ICE servers without a node: public STUN + the baked-in ExpressTURN relay.
    private func iceServersForDHT() async -> [[String: Any]] {
        [
            ["urls": [
                "stun:stun.l.google.com:19302",
                "stun:stun1.l.google.com:19302",
                "stun:stun.cloudflare.com:3478",
                "stun:free.expressturn.com:3478",
            ]],
            ["urls": ["turn:free.expressturn.com:3478"],
             "username": "000000002097466615",
             "credential": "XbNNDiAEa142/ZiNAhE8/Ab3qTQ="],
        ]
    }

    private func handleDHTSignal(from: String, pub: String, type: String, payload: [String: Any]) {
        let cid = payload["callId"] as? String ?? ""
        switch type {
        case "offer":
            guard !phase.isActive else { return }   // busy → ignore (no ringback over DHT)
            guard let sdp = payload["sdp"] as? String else { return }
            mode = .internet
            internetViaDHT = true
            callId = cid
            peerUserId = from
            remotePub = pub
            remoteName = payload["fromName"] as? String ?? from
            dhtOfferSDP = sdp
            beginCallRecord(outgoing: false, userId: from, name: remoteName)
            phase = .incoming(from: from, name: remoteName)
            NotificationService.shared.notifyCall(from: remoteName)
        case "answer":
            guard internetViaDHT, cid == callId, case .outgoing = phase,
                  let sdp = payload["sdp"] as? String else { return }
            markCallConnected()
            phase = .connected(name: remoteName)
            webrtc?.setRemote(sdp: sdp, type: .answer) {}
        case "call":   // control: decline / end
            let action = payload["action"] as? String ?? ""
            guard internetViaDHT, cid == callId || callId.isEmpty else { return }
            if action == "decline", phase.isActive { teardown(reason: "Звонок отклонён") }
            if action == "end", phase.isActive { teardown(reason: "") }
        default: break
        }
    }

    private func internetInvite(_ contact: Contact, _ sig: SignalingClient) async {
        guard let peer = await sig.findPeer(userId: contact.userId),
              let rpid = peer["peerId"] as? String else {
            await MainActor.run {
                self.phase = .ended(reason: "Абонент не в сети")
                self.finishCallRecord()
                self.autoClearEnded()
            }
            return
        }
        await MainActor.run { self.remotePeerId = rpid }
        await sig.sendSignal(toPeerId: rpid, toUserId: contact.userId, type: "call",
                             payload: ["action": "invite", "fromName": myName])
    }

    // MARK: Incoming actions

    func accept() {
        guard case .incoming(_, let name) = phase else { return }
        remoteName = name
        markCallConnected()
        switch mode {
        case .mesh:
            sendMesh(action: "accept")
            phase = .connected(name: name)
            startMeshAudio()
            startQKD(asAlice: false)   // answerer = Bob
        case .internet:
            if internetViaDHT {
                // Answerer over DHT: build the answer from the stored offer and
                // publish it back to the caller's inbox. ICE is baked in (non-trickle).
                startDHTMedia(asCaller: false)
                phase = .connected(name: name)
                // BB84 skipped on the DHT path (too many round-trips); the call is
                // still E2E via DTLS-SRTP. See DHTRendezvous header.
            } else {
                if let sig = signaling, let rpid = remotePeerId {
                    Task { await sig.sendSignal(toPeerId: rpid, toUserId: peerUserId ?? "", type: "call",
                                                payload: ["action": "accept"]) }
                }
                startInternetMedia(asCaller: false)
                phase = .connected(name: name)
                startQKD(asAlice: false)   // answerer = Bob
            }
        }
    }

    func decline() {
        sendControl(action: "decline")
        teardown(reason: "")
    }

    func hangUp() {
        sendControl(action: "end")
        teardown(reason: "")
    }

    func toggleMute() {
        muted.toggle()
        if mode == .internet { webrtc?.setMuted(muted) }
    }

    // MARK: Outgoing control routing

    private func sendControl(action: String) {
        switch mode {
        case .mesh: sendMesh(action: action)
        case .internet:
            if internetViaDHT {
                let toUser = peerUserId ?? ""
                let pub = remotePub
                guard !toUser.isEmpty, !pub.isEmpty else { return }
                let payload: [String: Any] = ["callId": callId, "action": action,
                                              "ts": Int64(Date().timeIntervalSince1970)]
                Task { await dht.sendCall(toUserId: toUser, toPub: pub, type: "control", payload: payload) }
            } else if let sig = signaling, let rpid = remotePeerId {
                Task { await sig.sendSignal(toPeerId: rpid, toUserId: peerUserId ?? "", type: "call",
                                            payload: ["action": action]) }
            }
        }
    }

    private func sendMesh(action: String) {
        var dict: [String: Any] = ["t": "call", "action": action, "from": myId, "fromName": myName]
        if let to = peerUserId { dict["to"] = to }
        mesh?.sendControl(dict)
    }

    // MARK: BB84 quantum key agreement

    /// Begin the BB84 ceremony for the connected call. The party that placed the
    /// call is Alice (prepares qubits); the answerer is Bob (measures them). On
    /// success both hold an identical session key; on a QBER breach the call
    /// collapses on both ends — "звонок рассыпается" if intercepted.
    private func startQKD(asAlice: Bool) {
        sessionKey = nil
        qkdVerified = false
        let session = BB84Session(role: asAlice ? .alice : .bob)
        session.send = { [weak self] msg in self?.sendQKD(msg) }
        session.onSuccess = { [weak self] key in
            DispatchQueue.main.async {
                guard let self else { return }
                self.sessionKey = key
                self.qkdVerified = true
            }
        }
        session.onAbort = { [weak self] reason in
            DispatchQueue.main.async {
                guard let self, self.phase.isActive else { return }
                self.teardown(reason: reason.isEmpty ? "Канал скомпрометирован" : reason)
            }
        }
        bb84 = session
        if asAlice { session.start() }
    }

    /// Route one BB84 ceremony message over the active transport as type "qkd".
    private func sendQKD(_ msg: [String: Any]) {
        switch mode {
        case .internet:
            if let sig = signaling, let rpid = remotePeerId {
                Task { await sig.sendSignal(toPeerId: rpid, toUserId: self.peerUserId ?? "", type: "qkd", payload: msg) }
            }
        case .mesh:
            var dict: [String: Any] = ["t": "qkd", "from": myId, "d": msg]
            if let to = peerUserId { dict["to"] = to }
            mesh?.sendControl(dict)
        }
    }

    // MARK: Mesh signaling in

    private func handleMeshControl(_ payload: Data, from peer: String) {
        // BB84 ceremony frames carry arrays/ints, so they're parsed separately from
        // the all-string call-control frames below.
        if let any = try? JSONSerialization.jsonObject(with: payload) as? [String: Any],
           (any["t"] as? String) == "qkd" {
            if let to = any["to"] as? String, !to.isEmpty, to != myId { return }
            if let d = any["d"] as? [String: Any] { bb84?.handle(d) }
            return
        }
        guard let obj = try? JSONSerialization.jsonObject(with: payload) as? [String: String],
              let action = obj["action"], let from = obj["from"] else { return }
        if let to = obj["to"], !to.isEmpty, to != myId { return }
        let name = obj["fromName"] ?? from

        switch action {
        case "invite":
            if phase.isActive { return }
            mode = .mesh
            peerUserId = from
            remoteName = name
            beginCallRecord(outgoing: false, userId: from, name: name)
            phase = .incoming(from: from, name: name)
            NotificationService.shared.notifyCall(from: name)
        case "accept":
            if case .outgoing = phase, mode == .mesh {
                markCallConnected()
                phase = .connected(name: name)
                startMeshAudio()
                startQKD(asAlice: true)   // caller = Alice
            }
        case "decline":
            if phase.isActive { teardown(reason: "Звонок отклонён") }
        case "end":
            if phase.isActive { teardown(reason: "") }
        default: break
        }
    }

    // MARK: Internet signaling in

    private func handleSignal(from: String, type: String, payload: Any) {
        switch type {
        case "call":
            guard let dict = payload as? [String: Any], let action = dict["action"] as? String else { return }
            handleInternetControl(action: action, fromPeerId: from, name: dict["fromName"] as? String ?? "Контакт")
        case "offer":
            guard let sdp = payload as? String else { return }
            ensureWebRTC(asCaller: false)
            webrtc?.setRemote(sdp: sdp, type: .offer) { [weak self] in
                self?.webrtc?.createAnswer { answer in
                    guard let self, let answer, let sig = self.signaling, let rpid = self.remotePeerId else { return }
                    Task { await sig.sendSignal(toPeerId: rpid, toUserId: self.peerUserId ?? "", type: "answer", payload: answer) }
                }
            }
        case "answer":
            guard let sdp = payload as? String else { return }
            webrtc?.setRemote(sdp: sdp, type: .answer) {}
        case "ice":
            guard let dict = payload as? [String: Any] else { return }
            webrtc?.add(candidate: dict)
        case "qkd":
            guard let dict = payload as? [String: Any] else { return }
            bb84?.handle(dict)
        default:
            break
        }
    }

    private func handleInternetControl(action: String, fromPeerId: String, name: String) {
        switch action {
        case "invite":
            if phase.isActive {
                if let sig = signaling {
                    Task { await sig.sendSignal(toPeerId: fromPeerId, toUserId: "", type: "call", payload: ["action": "decline"]) }
                }
                return
            }
            mode = .internet
            remotePeerId = fromPeerId
            remoteName = name
            beginCallRecord(outgoing: false, userId: peerUserId ?? "", name: name)
            phase = .incoming(from: fromPeerId, name: name)
            NotificationService.shared.notifyCall(from: name)
        case "accept":
            if case .outgoing = phase, mode == .internet {
                markCallConnected()
                phase = .connected(name: remoteName)
                startInternetMedia(asCaller: true)
                startQKD(asAlice: true)   // caller = Alice
            }
        case "decline":
            if phase.isActive { teardown(reason: "Звонок отклонён") }
        case "end":
            if phase.isActive { teardown(reason: "") }
        default: break
        }
    }

    // MARK: Internet media (WebRTC)

    private func ensureWebRTC(asCaller: Bool) {
        guard webrtc == nil else { return }
        let rtc = WebRTCCallEngine()
        rtc.onLocalIce = { [weak self] cand in
            guard let self, let sig = self.signaling, let rpid = self.remotePeerId else { return }
            Task { await sig.sendSignal(toPeerId: rpid, toUserId: self.peerUserId ?? "", type: "ice", payload: cand.wireDict) }
        }
        rtc.onClosed = { [weak self] in
            guard let self else { return }
            if self.mode == .internet, self.phase.isActive { self.teardown(reason: "Связь прервана") }
        }
        webrtc = rtc
    }

    private func startInternetMedia(asCaller: Bool) {
        AVAudioSession.sharedInstance().requestRecordPermission { [weak self] granted in
            DispatchQueue.main.async {
                guard let self else { return }
                guard granted else { self.micDenied = true; return }
                guard let sig = self.signaling else { return }
                Task {
                    let ice = await sig.iceServers()
                    await MainActor.run {
                        self.ensureWebRTC(asCaller: asCaller)
                        self.webrtc?.configure(iceServers: ice)
                        if asCaller {
                            self.webrtc?.createOffer { sdp in
                                guard let sdp, let rpid = self.remotePeerId else { return }
                                Task { await sig.sendSignal(toPeerId: rpid, toUserId: self.peerUserId ?? "", type: "offer", payload: sdp) }
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: Mesh audio in

    private func handleMeshAudio(_ payload: Data) {
        guard audioActive, case .connected = phase, payload.count >= 2 else { return }
        let frames = AVAudioFrameCount(payload.count / 2)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: frames),
              let dst = buffer.floatChannelData else { return }
        buffer.frameLength = frames
        payload.withUnsafeBytes { raw in
            guard let src = raw.baseAddress?.assumingMemoryBound(to: Int16.self) else { return }
            let out = dst[0]
            for i in 0..<Int(frames) {
                out[i] = max(-1.0, min(1.0, Float(Int16(littleEndian: src[i])) / 32768.0))
            }
        }
        player.scheduleBuffer(buffer, completionHandler: nil)
    }

    // MARK: Lifecycle

    private func teardown(reason: String) {
        stopMeshAudio()
        webrtc?.close()
        webrtc = nil
        bb84 = nil
        sessionKey = nil
        qkdVerified = false
        finishCallRecord()
        peerUserId = nil
        remotePeerId = nil
        internetViaDHT = false
        callId = ""
        remotePub = ""
        dhtOfferSDP = nil
        muted = false
        if reason.isEmpty {
            phase = .idle
        } else {
            phase = .ended(reason: reason)
            autoClearEnded()
        }
    }

    // MARK: Call journal

    private func beginCallRecord(outgoing: Bool, userId: String, name: String) {
        recStartedAt = Date()
        recConnectedAt = nil
        recOutgoing = outgoing
        recPeerUserId = userId
        recPeerName = name
    }

    private func markCallConnected() {
        if recConnectedAt == nil { recConnectedAt = Date() }
    }

    /// Fold the in-flight call into a journal entry. Guarded so the many teardown
    /// paths (and explicit failures) record exactly once.
    private func finishCallRecord() {
        guard let started = recStartedAt else { return }
        let connected = recConnectedAt != nil
        let duration = recConnectedAt.map { Date().timeIntervalSince($0) } ?? 0
        let rec = CallRecord(userId: recPeerUserId,
                             name: recPeerName.isEmpty ? recPeerUserId : recPeerName,
                             outgoing: recOutgoing, connected: connected,
                             viaMesh: mode == .mesh, time: started,
                             duration: max(0, duration))
        recStartedAt = nil
        recConnectedAt = nil
        history.insert(rec, at: 0)
        if history.count > 300 { history.removeLast(history.count - 300) }
        saveHistory()
    }

    func deleteHistory(ids: Set<UUID>) {
        history.removeAll { ids.contains($0.id) }
        saveHistory()
    }

    func clearHistory() {
        history = []
        saveHistory()
    }

    private func historyURL() -> URL? {
        guard let uid = mesh?.identity?.userId, !uid.isEmpty else { return nil }
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let safe = uid.replacingOccurrences(of: "@", with: "at-")
        return docs.appendingPathComponent("calls-\(safe).json")
    }

    private func saveHistory() {
        guard let url = historyURL() else { return }
        if let data = try? JSONEncoder().encode(history) { try? data.write(to: url) }
    }

    private func loadHistory() {
        guard let url = historyURL(),
              let data = try? Data(contentsOf: url),
              let arr = try? JSONDecoder().decode([CallRecord].self, from: data) else { return }
        history = arr
    }

    private func autoClearEnded() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { [weak self] in
            if case .ended = self?.phase { self?.phase = .idle }
        }
    }

    // MARK: Mesh audio engine

    private func startMeshAudio() {
        AVAudioSession.sharedInstance().requestRecordPermission { [weak self] granted in
            DispatchQueue.main.async {
                guard let self else { return }
                if granted { self.configureAndStartEngine() } else { self.micDenied = true }
            }
        }
    }

    private func configureAndStartEngine() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetooth])
            try session.setActive(true, options: [])
        } catch {
            NSLog("[Call] audio session error: \(error)")
            return
        }

        let input = engine.inputNode
        let inFormat = input.inputFormat(forBus: 0)
        guard inFormat.sampleRate > 0 else { return }
        captureConverter = AVAudioConverter(from: inFormat, to: wireFormat)

        if player.engine == nil { engine.attach(player) }
        engine.connect(player, to: engine.mainMixerNode, format: playFormat)

        input.installTap(onBus: 0, bufferSize: 1920, format: inFormat) { [weak self] buffer, _ in
            self?.captureAndSend(buffer, inFormat: inFormat)
        }

        engine.prepare()
        do { try engine.start(); player.play(); audioActive = true }
        catch { NSLog("[Call] engine start error: \(error)") }
    }

    private func captureAndSend(_ buffer: AVAudioPCMBuffer, inFormat: AVAudioFormat) {
        guard !muted, let converter = captureConverter else { return }
        let ratio = wireFormat.sampleRate / inFormat.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: wireFormat, frameCapacity: capacity) else { return }
        var error: NSError?
        var fed = false
        converter.convert(to: out, error: &error) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true; status.pointee = .haveData; return buffer
        }
        guard error == nil, out.frameLength > 0, let ch = out.int16ChannelData else { return }
        mesh?.sendAudio(Data(bytes: ch[0], count: Int(out.frameLength) * 2))
    }

    private func stopMeshAudio() {
        guard audioActive else { return }
        audioActive = false
        engine.inputNode.removeTap(onBus: 0)
        player.stop()
        engine.stop()
        captureConverter = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
