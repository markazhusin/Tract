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

/// Calls with automatic transport: nearby → mesh (serverless, lowest latency);
/// otherwise → internet P2P via WebRTC (Opus, echo-cancelled), signaled through
/// the self-hosted node. The node only relays SDP/ICE — audio stays P2P/E2E.
final class CallService: ObservableObject {
    @Published var phase: CallPhase = .idle
    @Published var muted: Bool = false
    @Published var micDenied: Bool = false

    weak var mesh: MeshService?
    var node: NodeConfig?
    private var signaling: SignalingClient?

    private var mode: CallMode = .mesh
    private var peerUserId: String?      // remote app userId
    private var remotePeerId: String?    // remote signaling peerId (internet)
    private var remoteName: String = ""
    private var cancellable: AnyCancellable?

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
    }

    // MARK: Outgoing

    func startCall(to contact: Contact) {
        guard !phase.isActive else { return }
        peerUserId = contact.userId
        remoteName = contact.displayName
        remotePeerId = nil

        if mesh?.reachability(of: contact.userId) == .localMesh {
            mode = .mesh
            phase = .outgoing(name: contact.displayName)
            sendMesh(action: "invite")
        } else if let sig = signaling {
            mode = .internet
            phase = .outgoing(name: contact.displayName)
            Task { await internetInvite(contact, sig) }
        } else {
            phase = .ended(reason: "Нет связи")
            autoClearEnded()
        }
    }

    private func internetInvite(_ contact: Contact, _ sig: SignalingClient) async {
        guard let peer = await sig.findPeer(userId: contact.userId),
              let rpid = peer["peerId"] as? String else {
            await MainActor.run { self.phase = .ended(reason: "Абонент не в сети"); self.autoClearEnded() }
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
        switch mode {
        case .mesh:
            sendMesh(action: "accept")
            phase = .connected(name: name)
            startMeshAudio()
        case .internet:
            if let sig = signaling, let rpid = remotePeerId {
                Task { await sig.sendSignal(toPeerId: rpid, toUserId: peerUserId ?? "", type: "call",
                                            payload: ["action": "accept"]) }
            }
            startInternetMedia(asCaller: false)
            phase = .connected(name: name)
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
            if let sig = signaling, let rpid = remotePeerId {
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

    // MARK: Mesh signaling in

    private func handleMeshControl(_ payload: Data, from peer: String) {
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
            phase = .incoming(from: from, name: name)
        case "accept":
            if case .outgoing = phase, mode == .mesh {
                phase = .connected(name: name)
                startMeshAudio()
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
            phase = .incoming(from: fromPeerId, name: name)
        case "accept":
            if case .outgoing = phase, mode == .internet {
                phase = .connected(name: remoteName)
                startInternetMedia(asCaller: true)
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
        peerUserId = nil
        remotePeerId = nil
        muted = false
        if reason.isEmpty {
            phase = .idle
        } else {
            phase = .ended(reason: reason)
            autoClearEnded()
        }
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
