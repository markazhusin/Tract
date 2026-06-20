import Foundation
import Combine
import AVFoundation

enum CallPhase: Equatable {
    case idle
    case outgoing(name: String)
    case incoming(from: String, name: String)
    case connected(name: String)
    case ended(reason: String)

    var isActive: Bool {
        if case .idle = self { return false }
        return true
    }
}

/// Serverless calls over the mesh. The MultipeerConnectivity link already makes
/// two nearby devices discover and connect automatically (advertiser + browser,
/// auto-accept), so calls reuse that always-on p2p connection: no signaling server,
/// no STUN/TURN, works internet-OFF. Signaling and audio both ride the mesh.
final class CallService: ObservableObject {
    @Published var phase: CallPhase = .idle
    @Published var muted: Bool = false
    @Published var micDenied: Bool = false

    weak var mesh: MeshService?
    private var cancellable: AnyCancellable?

    /// userId of the remote party in the current/last call.
    private var peerUserId: String?

    // Audio
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var captureConverter: AVAudioConverter?
    private var audioActive = false
    private let wireFormat = AVAudioFormat(commonFormat: .pcmFormatInt16,
                                           sampleRate: 16_000, channels: 1, interleaved: true)!
    private let playFormat = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!

    private var myId: String { mesh?.identity?.userId ?? "" }
    private var myName: String { mesh?.identity?.displayName ?? "" }

    // MARK: Wiring

    func bind(to mesh: MeshService) {
        self.mesh = mesh
        mesh.onControl = { [weak self] payload, peer in self?.handleControl(payload, from: peer) }
        mesh.onAudio = { [weak self] payload, _ in self?.handleAudio(payload) }
        // If the mesh connection drops mid-call, tear the call down — "failproof" cleanup.
        cancellable = mesh.$peerCount.sink { [weak self] count in
            guard let self else { return }
            if count == 0, self.phase.isActive {
                self.teardown(reason: "Соединение потеряно")
            }
        }
    }

    // MARK: Outgoing

    func startCall(to contact: Contact) {
        guard !phase.isActive else { return }
        peerUserId = contact.userId
        phase = .outgoing(name: contact.displayName)
        send(action: "invite")
    }

    // MARK: Incoming actions

    func accept() {
        guard case .incoming(_, let name) = phase else { return }
        send(action: "accept")
        phase = .connected(name: name)
        startAudio()
    }

    func decline() {
        send(action: "decline")
        teardown(reason: "")
    }

    func hangUp() {
        send(action: "end")
        teardown(reason: "")
    }

    func toggleMute() { muted.toggle() }

    // MARK: Signaling in

    private func handleControl(_ payload: Data, from peer: String) {
        guard let obj = try? JSONSerialization.jsonObject(with: payload) as? [String: String],
              let action = obj["action"],
              let from = obj["from"] else { return }
        // Only react to control addressed to us (or broadcast invites).
        if let to = obj["to"], !to.isEmpty, to != myId { return }
        let name = obj["fromName"] ?? from

        switch action {
        case "invite":
            if phase.isActive {
                // Busy: politely decline the new caller.
                sendRaw(action: "decline", to: from)
            } else {
                peerUserId = from
                phase = .incoming(from: from, name: name)
            }
        case "accept":
            if case .outgoing = phase {
                phase = .connected(name: name)
                startAudio()
            }
        case "decline":
            if phase.isActive { teardown(reason: "Звонок отклонён") }
        case "end":
            if phase.isActive { teardown(reason: "") }
        default:
            break
        }
    }

    // MARK: Audio in

    private func handleAudio(_ payload: Data) {
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

    // MARK: Signaling out

    private func send(action: String) { sendRaw(action: action, to: peerUserId) }

    private func sendRaw(action: String, to: String?) {
        var dict: [String: Any] = ["t": "call", "action": action, "from": myId, "fromName": myName]
        if let to { dict["to"] = to }
        mesh?.sendControl(dict)
    }

    // MARK: Lifecycle

    private func teardown(reason: String) {
        stopAudio()
        peerUserId = nil
        muted = false
        if reason.isEmpty {
            phase = .idle
        } else {
            phase = .ended(reason: reason)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { [weak self] in
                if case .ended = self?.phase { self?.phase = .idle }
            }
        }
    }

    // MARK: Audio engine

    private func startAudio() {
        AVAudioSession.sharedInstance().requestRecordPermission { [weak self] granted in
            DispatchQueue.main.async {
                guard let self else { return }
                if granted {
                    self.configureAndStartEngine()
                } else {
                    self.micDenied = true
                }
            }
        }
    }

    private func configureAndStartEngine() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .voiceChat,
                                    options: [.defaultToSpeaker, .allowBluetooth])
            try session.setActive(true, options: [])
        } catch {
            NSLog("[Call] audio session error: \(error)")
            return
        }

        let input = engine.inputNode
        let inFormat = input.inputFormat(forBus: 0)
        guard inFormat.sampleRate > 0 else { NSLog("[Call] no input format"); return }
        captureConverter = AVAudioConverter(from: inFormat, to: wireFormat)

        if player.engine == nil { engine.attach(player) }
        engine.connect(player, to: engine.mainMixerNode, format: playFormat)

        input.installTap(onBus: 0, bufferSize: 1920, format: inFormat) { [weak self] buffer, _ in
            self?.captureAndSend(buffer, inFormat: inFormat)
        }

        engine.prepare()
        do {
            try engine.start()
            player.play()
            audioActive = true
        } catch {
            NSLog("[Call] engine start error: \(error)")
        }
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
            fed = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, out.frameLength > 0, let ch = out.int16ChannelData else { return }
        let data = Data(bytes: ch[0], count: Int(out.frameLength) * 2)
        mesh?.sendAudio(data)
    }

    private func stopAudio() {
        guard audioActive else { return }
        audioActive = false
        engine.inputNode.removeTap(onBus: 0)
        player.stop()
        engine.stop()
        captureConverter = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
