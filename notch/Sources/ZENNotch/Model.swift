import AppKit
import SwiftUI

/// ZEN's colours. The arc sits in the menu bar beside the notch, which is black on a
/// notched Mac, so everything here is drawn for a dark ground whatever the system theme.
enum Theme {
    /// ZEN sapphire: the reactor's own blue.
    static let sapphire = Color(red: 0x2f / 255, green: 0x6b / 255, blue: 0xff / 255)
    /// The pale core / highlight.
    static let accent = Color(red: 0xdf / 255, green: 0xe9 / 255, blue: 0xff / 255)
    static let bg = Color(red: 0.02, green: 0.03, blue: 0.07)
    static let card = Color.white.opacity(0.06)
    static let text = Color.white
    static let subtle = Color.white.opacity(0.6)
    static let faint = Color.white.opacity(0.35)
    static let deny = Color(red: 1.0, green: 0.42, blue: 0.42)
}

/// What the arc shows. Mirrors the bridge's notch phases (bridge/notch.mjs).
enum Phase: String {
    case idle, listening, thinking, speaking, offline
}

struct Approval: Identifiable, Equatable {
    let id: String
    let text: String
}

struct NowPlaying: Equatable {
    var title: String
    var artist: String
    var album: String = ""
    var art: URL?
    var playing: Bool
    /// Seconds. The bridge sends the position every ~2s; between updates the
    /// card runs its own clock from `at`, so the bar moves smoothly.
    var duration: Double? = nil
    var position: Double? = nil
    var at = Date()

    /// Where the song is now, by the card's own clock.
    func elapsed(_ now: Date) -> Double? {
        guard let p = position else { return nil }
        let t = playing ? p + now.timeIntervalSince(at) : p
        return min(max(0, t), duration ?? t)
    }
}

/// Everything the views draw, fed by `Bridge`. Main-actor only: the socket hops here
/// before touching it.
@MainActor
final class Model: ObservableObject {
    /// Socket to the bridge is up. Down = the arc dims and the panel says ZEN isn't running.
    @Published var connected = false
    @Published var phase: Phase = .offline
    @Published var caption = ""
    @Published var windowOpen = false
    @Published var music: NowPlaying?
    @Published var approvals: [Approval] = []
    @Published var lastNotify: String?
    @Published var expanded = false
    /// Measured size of the open panel (the hover hit area follows it). Not @Published:
    /// layout writes it, and it must not cause another layout pass.
    var panelSize = CGSize(width: 300, height: 200)

    /// What the arc should do right now. Offline wins: a ZEN that can't hear you
    /// must never look like it is listening.
    var shownPhase: Phase { connected ? phase : .offline }
    /// A card is waiting: the arc breathes for attention until it is answered.
    var needsYou: Bool { !approvals.isEmpty }

    var send: (([String: Any]) -> Void)?

    func reply(_ a: Approval, ok: Bool) {
        // Removed here at once; the bridge's approve-done that follows is a no-op.
        approvals.removeAll { $0.id == a.id }
        send?(["type": "reply", "id": a.id, "ok": ok])
    }
    func music(_ op: String) {
        // Optimistic, so the button answers the click; the next push corrects it.
        if var m = music, op == "play" || op == "pause" {
            m.position = m.elapsed(Date()); m.at = Date(); m.playing = op == "play"; music = m
        }
        send?(["type": "music", "op": op])
    }

    /// Jump to `seconds` in the song (the timeline). The card moves at once; the
    /// bridge's next update confirms where Spotify really is.
    func seek(to seconds: Double) {
        guard var m = music else { return }
        m.position = max(0, min(seconds, m.duration ?? seconds)); m.at = Date(); music = m
        send?(["type": "music", "op": "seek", "position": m.position ?? 0])
    }
    func openZEN() { send?(["type": "open"]) }

    /// One frame from the bridge. Loose on purpose: an unknown frame from a newer
    /// bridge is ignored, never fatal.
    func apply(_ m: [String: Any]) {
        switch m["type"] as? String {
        case "state":
            phase = Phase(rawValue: m["phase"] as? String ?? "") ?? .idle
            caption = m["caption"] as? String ?? ""
            windowOpen = m["windowOpen"] as? Bool ?? false
        case "music":
            if let t = m["title"] as? String, !t.isEmpty {
                let art = (m["art"] as? String).flatMap(URL.init(string:))
                music = NowPlaying(title: t, artist: m["artist"] as? String ?? "",
                                   album: m["album"] as? String ?? "", art: art,
                                   playing: m["playing"] as? Bool ?? false,
                                   duration: (m["duration"] as? NSNumber)?.doubleValue,
                                   position: (m["position"] as? NSNumber)?.doubleValue)
            } else {
                music = nil
            }
        case "notify":
            if let t = m["text"] as? String, !t.isEmpty { lastNotify = t }
        case "approve":
            guard let id = m["id"] as? String else { return }
            let a = Approval(id: id, text: m["text"] as? String ?? "")
            if !approvals.contains(where: { $0.id == id }) { approvals.append(a) }
        case "approve-done":
            if let id = m["id"] as? String { approvals.removeAll { $0.id == id } }
        default:
            break
        }
    }

    /// The bridge went away: whatever it had asked is no longer askable.
    func disconnected() {
        connected = false
        approvals.removeAll()
    }
}

/// The socket to ZEN's bridge: ws://127.0.0.1:<port>/notch, redialled with backoff.
///
/// Loopback only, and everything the notch shows comes over it — the notch never reads
/// ZEN's files (HQ Notch learned that reading under ~/Documents raises a macOS privacy
/// prompt that froze the app).
@MainActor
final class Bridge {
    private let model: Model
    private let url: URL
    private var task: URLSessionWebSocketTask?
    private var pingTimer: Timer?
    private var attempt = 0
    /// 1s, 2s, 4s, 8s, then every 15s: ZEN is often simply not started yet.
    private static let backoff: [Double] = [1, 2, 4, 8, 15]

    init(model: Model) {
        self.model = model
        let env = ProcessInfo.processInfo.environment
        // ZEN_NOTCH_PORT (tests) > `defaults write dev.zen.notch port N` > 8787, ZEN's own.
        let saved = UserDefaults.standard.integer(forKey: "port")
        let port = Int(env["ZEN_NOTCH_PORT"] ?? "") ?? (saved > 0 ? saved : 8787)
        url = URL(string: "ws://127.0.0.1:\(port)/notch")!
        model.send = { [weak self] msg in self?.send(msg) }
    }

    func start() { dial() }

    private func dial() {
        task?.cancel(with: .goingAway, reason: nil)
        let t = URLSession.shared.webSocketTask(with: url)
        task = t
        t.resume()
        receive(t)
        // A ping both proves the line and lets the first success flip us online,
        // since URLSessionWebSocketTask has no "opened" callback.
        ping(t)
        pingTimer?.invalidate()
        pingTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            Task { @MainActor in if let self, let t = self.task { self.ping(t) } }
        }
    }

    private func ping(_ t: URLSessionWebSocketTask) {
        t.sendPing { [weak self] err in
            Task { @MainActor in
                guard let self, t === self.task else { return }
                if err != nil { self.lost(t) } else if !self.model.connected { self.model.connected = true; self.attempt = 0 }
            }
        }
    }

    private func receive(_ t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            Task { @MainActor in
                guard let self, t === self.task else { return }
                switch result {
                case .failure:
                    self.lost(t)
                case .success(let msg):
                    self.model.connected = true
                    self.attempt = 0
                    var data: Data?
                    switch msg {
                    case .string(let s): data = s.data(using: .utf8)
                    case .data(let d): data = d
                    @unknown default: data = nil
                    }
                    if let d = data, let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
                        self.model.apply(obj)
                    }
                    self.receive(t)
                }
            }
        }
    }

    private func lost(_ t: URLSessionWebSocketTask) {
        guard t === task else { return }
        task = nil
        pingTimer?.invalidate()
        model.disconnected()
        let delay = Self.backoff[min(attempt, Self.backoff.count - 1)]
        attempt += 1
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            Task { @MainActor in if let self, self.task == nil { self.dial() } }
        }
    }

    private func send(_ msg: [String: Any]) {
        guard let t = task, let d = try? JSONSerialization.data(withJSONObject: msg),
              let s = String(data: d, encoding: .utf8) else { return }
        t.send(.string(s)) { _ in }
    }

    func stop() { task?.cancel(with: .goingAway, reason: nil); pingTimer?.invalidate() }
}
