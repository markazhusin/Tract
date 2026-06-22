import Foundation
import WebRTC

/// One WebRTC audio call. Media is P2P (Opus, echo-cancelled, jitter-buffered) —
/// superb quality, minimal latency; the node only relays SDP/ICE, never the audio.
final class WebRTCCallEngine: NSObject, RTCPeerConnectionDelegate {

    private static let factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        return RTCPeerConnectionFactory(encoderFactory: RTCDefaultVideoEncoderFactory(),
                                        decoderFactory: RTCDefaultVideoDecoderFactory())
    }()

    private var pc: RTCPeerConnection?
    private var localAudioTrack: RTCAudioTrack?

    var onLocalIce: ((RTCIceCandidate) -> Void)?
    var onConnected: (() -> Void)?
    var onClosed: (() -> Void)?

    /// Fired once when ICE gathering completes — used by the non-trickle DHT path,
    /// which bakes all candidates into a single SDP instead of trickling them.
    private var gatheringDone: (() -> Void)?

    func setMuted(_ muted: Bool) { localAudioTrack?.isEnabled = !muted }

    func localSDP() -> String? { pc?.localDescription?.sdp }

    func configure(iceServers: [[String: Any]]) {
        let servers: [RTCIceServer] = iceServers.compactMap { dict in
            guard let urls = dict["urls"] as? [String] ?? (dict["urls"] as? String).map({ [$0] }) else { return nil }
            if let user = dict["username"] as? String, let cred = dict["credential"] as? String {
                return RTCIceServer(urlStrings: urls, username: user, credential: cred)
            }
            return RTCIceServer(urlStrings: urls)
        }

        let config = RTCConfiguration()
        config.iceServers = servers
        config.sdpSemantics = .unifiedPlan
        // Maximize DIRECT connections (relay only as last resort):
        config.continualGatheringPolicy = .gatherContinually
        config.iceTransportPolicy = .all          // try host/srflx before relay
        config.candidateNetworkPolicy = .all       // gather on Wi-Fi AND cellular (multi-homed)
        config.bundlePolicy = .maxBundle
        config.rtcpMuxPolicy = .require
        config.iceCandidatePoolSize = 1            // pre-gather so candidates are ready
        // IPv6 host candidates are gathered by default and trickled below — that's
        // the path that connects two CGNAT phones directly when both have IPv6.

        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        pc = Self.factory.peerConnection(with: config, constraints: constraints, delegate: self)

        configureAudioSession()

        // Local microphone track.
        let audioConstraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        let source = Self.factory.audioSource(with: audioConstraints)
        let track = Self.factory.audioTrack(with: source, trackId: "audio0")
        localAudioTrack = track
        pc?.add(track, streamIds: ["stream0"])
    }

    private func configureAudioSession() {
        let session = RTCAudioSession.sharedInstance()
        session.lockForConfiguration()
        try? session.setCategory(.playAndRecord, with: [.defaultToSpeaker, .allowBluetooth])
        try? session.setMode(.voiceChat)
        try? session.setActive(true)
        session.unlockForConfiguration()
    }

    private var offerAnswerConstraints: RTCMediaConstraints {
        RTCMediaConstraints(mandatoryConstraints: ["OfferToReceiveAudio": "true"],
                            optionalConstraints: nil)
    }

    func createOffer(_ completion: @escaping (String?) -> Void) {
        pc?.offer(for: offerAnswerConstraints) { [weak self] sdp, _ in
            guard let self, let sdp else { completion(nil); return }
            self.pc?.setLocalDescription(sdp) { _ in completion(sdp.sdp) }
        }
    }

    func createAnswer(_ completion: @escaping (String?) -> Void) {
        pc?.answer(for: offerAnswerConstraints) { [weak self] sdp, _ in
            guard let self, let sdp else { completion(nil); return }
            self.pc?.setLocalDescription(sdp) { _ in completion(sdp.sdp) }
        }
    }

    /// Non-trickle variants for the DHT path: create the SDP, set it local, then wait
    /// for ICE gathering to COMPLETE (or `timeout`) so the returned SDP already carries
    /// all candidates — no separate ICE channel needed (DHT round-trips are too slow
    /// to trickle).
    func createOfferFull(timeout: TimeInterval = 6, _ completion: @escaping (String?) -> Void) {
        pc?.offer(for: offerAnswerConstraints) { [weak self] sdp, _ in
            guard let self, let sdp else { completion(nil); return }
            self.pc?.setLocalDescription(sdp) { _ in self.waitGathering(timeout: timeout, completion) }
        }
    }

    func createAnswerFull(timeout: TimeInterval = 6, _ completion: @escaping (String?) -> Void) {
        pc?.answer(for: offerAnswerConstraints) { [weak self] sdp, _ in
            guard let self, let sdp else { completion(nil); return }
            self.pc?.setLocalDescription(sdp) { _ in self.waitGathering(timeout: timeout, completion) }
        }
    }

    private func waitGathering(timeout: TimeInterval, _ completion: @escaping (String?) -> Void) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { completion(nil); return }
            if self.pc?.iceGatheringState == .complete { completion(self.pc?.localDescription?.sdp); return }
            var done = false
            let finish = { [weak self] in
                if done { return }; done = true
                completion(self?.pc?.localDescription?.sdp)
            }
            self.gatheringDone = finish
            DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { finish() }
        }
    }

    func setRemote(sdp: String, type: RTCSdpType, _ completion: @escaping () -> Void) {
        let desc = RTCSessionDescription(type: type, sdp: sdp)
        pc?.setRemoteDescription(desc) { _ in completion() }
    }

    func add(candidate: [String: Any]) {
        guard let sdp = candidate["candidate"] as? String else { return }
        let mid = candidate["sdpMid"] as? String
        let line = (candidate["sdpMLineIndex"] as? Int).map(Int32.init) ?? 0
        pc?.add(RTCIceCandidate(sdp: sdp, sdpMLineIndex: line, sdpMid: mid)) { _ in }
    }

    func close() {
        pc?.close()
        pc = nil
        let session = RTCAudioSession.sharedInstance()
        session.lockForConfiguration()
        try? session.setActive(false)
        session.unlockForConfiguration()
    }

    // MARK: RTCPeerConnectionDelegate

    func peerConnection(_ pc: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        onLocalIce?(candidate)
    }

    func peerConnection(_ pc: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        DispatchQueue.main.async {
            switch newState {
            case .connected, .completed: self.onConnected?()
            case .failed, .disconnected, .closed: self.onClosed?()
            default: break
            }
        }
    }

    func peerConnection(_ pc: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ pc: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ pc: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ pc: RTCPeerConnection) {}
    func peerConnection(_ pc: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
        if newState == .complete {
            let cb = gatheringDone; gatheringDone = nil
            DispatchQueue.main.async { cb?() }
        }
    }
    func peerConnection(_ pc: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ pc: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}

/// Helper to build an ICE candidate dict for the wire (matches the web's shape).
extension RTCIceCandidate {
    var wireDict: [String: Any] {
        var d: [String: Any] = ["candidate": sdp, "sdpMLineIndex": Int(sdpMLineIndex)]
        if let mid = sdpMid { d["sdpMid"] = mid }
        return d
    }
}
