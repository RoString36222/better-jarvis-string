import SwiftUI

// MARK: - The arc

/// ZEN's reactor, shrunk to a menu-bar glyph (~18pt): an outer ring, three arc segments
/// and a core. Drawn from a time value rather than with SwiftUI animations so the same
/// frame can be rendered for snapshots, and so a still arc costs nothing — the timeline
/// that drives it is paused whenever nothing moves (see `LiveArc`).
struct ArcGlyph: View {
    var phase: Phase
    var attention: Bool
    var time: Double
    var size: CGFloat = 18

    var body: some View {
        let off = phase == .offline
        let blue = off ? Color.white.opacity(0.45) : Theme.sapphire
        let core = off ? Color.white.opacity(0.5) : Theme.accent
        // Listening: a slow breath (1.8s). Everything else holds still unless it spins.
        let breath = phase == .listening ? 0.5 + 0.5 * sin(time * 2 * .pi / 1.8) : 1.0
        // Thinking: the segments spin, about a turn a second.
        let spin = phase == .thinking ? (time * 330).truncatingRemainder(dividingBy: 360) : 0
        // Waiting on you: a soft halo, slower than listening so the two never read alike.
        let halo = attention ? 0.5 + 0.5 * sin(time * 2 * .pi / 2.4) : 0

        ZStack {
            if attention {
                Circle()
                    .fill(Theme.accent.opacity(0.18 + 0.32 * halo))
                    .blur(radius: 3 + 2 * halo)
                    .scaleEffect(1.05 + 0.18 * halo)
            }
            // Speaking: two ripples leave the core and fade at the rim, 0.9s apart.
            if phase == .speaking {
                ForEach(0..<2, id: \.self) { i in
                    let p = ((time / 0.9) + Double(i) * 0.5).truncatingRemainder(dividingBy: 1)
                    Circle()
                        .stroke(Theme.accent.opacity(0.85 * (1 - p)), lineWidth: 1.2)
                        .scaleEffect(0.25 + 0.75 * p)
                }
            }
            Circle()
                .stroke(blue.opacity(0.55), lineWidth: max(1, size * 0.06))
            ForEach(0..<3, id: \.self) { i in
                Circle()
                    .trim(from: 0, to: 0.22)
                    .stroke(blue, style: StrokeStyle(lineWidth: size * 0.12, lineCap: .round))
                    .rotationEffect(.degrees(Double(i) * 120 + spin - 90))
                    .padding(size * 0.17)
            }
            Circle()
                .fill(core)
                .frame(width: size * 0.28, height: size * 0.28)
                .shadow(color: blue.opacity(off ? 0 : 0.9), radius: size * (0.12 + 0.12 * breath))
                .scaleEffect(phase == .listening ? 0.85 + 0.3 * breath : 1)
        }
        .frame(width: size, height: size)
        .opacity(off ? 0.55 : (phase == .listening ? 0.75 + 0.25 * breath : 1))
    }
}

/// The arc on screen: a timeline only while something moves, so an idle ZEN Notch
/// draws once and then costs nothing at all.
struct LiveArc: View {
    @ObservedObject var model: Model
    var body: some View {
        let phase = model.shownPhase
        let moving = model.needsYou || phase == .listening || phase == .thinking || phase == .speaking
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !moving)) { ctx in
            ArcGlyph(phase: phase, attention: model.needsYou, time: ctx.date.timeIntervalSinceReferenceDate)
        }
        .contentShape(Rectangle())
        .help("ZEN")
    }
}

// MARK: - The panel

/// The compact panel under the arc: Allow cards first (they are why it exists while ZEN
/// is hidden), then what's playing, ZEN's last word, and Open ZEN.
struct PanelView: View {
    @ObservedObject var model: Model
    static let width: CGFloat = 300

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            if !model.connected {
                Text("ZEN isn't running. The arc comes back to life when it starts.")
                    .font(.system(size: 11)).foregroundStyle(Theme.subtle)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(model.approvals) { a in ApprovalCard(approval: a, model: model) }
            if let m = model.music { MusicRow(music: m, model: model) }
            if let n = model.lastNotify {
                VStack(alignment: .leading, spacing: 3) {
                    Text("ZEN SAID").font(.system(size: 9, weight: .semibold)).tracking(1.2)
                        .foregroundStyle(Theme.faint)
                    Text(n).font(.system(size: 11.5)).foregroundStyle(Theme.text.opacity(0.85))
                        .lineLimit(3).fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8).background(Theme.card, in: RoundedRectangle(cornerRadius: 8))
            }
            Button(action: model.openZEN) {
                HStack(spacing: 6) {
                    Image(systemName: "macwindow")
                    Text(model.windowOpen ? "Show ZEN" : "Open ZEN")
                }
                .font(.system(size: 12, weight: .semibold))
                .frame(maxWidth: .infinity).padding(.vertical, 6)
                .background(Theme.sapphire.opacity(model.connected ? 0.9 : 0.3), in: RoundedRectangle(cornerRadius: 8))
                .foregroundStyle(Theme.text)
            }
            .buttonStyle(.plain)
            .disabled(!model.connected)
        }
        .padding(12)
        .frame(width: Self.width, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 14).fill(Theme.bg.opacity(0.97))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.sapphire.opacity(0.35), lineWidth: 1))
        )
        .environment(\.colorScheme, .dark)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                ArcGlyph(phase: model.shownPhase, attention: false, time: 0, size: 14)
                Text("ZEN").font(.system(size: 12, weight: .bold)).tracking(2).foregroundStyle(Theme.accent)
                Text(label).font(.system(size: 11)).foregroundStyle(Theme.subtle)
                Spacer(minLength: 0)
            }
            if model.connected, !model.caption.isEmpty {
                Text(model.caption).font(.system(size: 11)).foregroundStyle(Theme.subtle)
                    .lineLimit(1).truncationMode(.tail)
            }
        }
    }

    private var label: String {
        switch model.shownPhase {
        case .idle: model.windowOpen ? "ready" : "ready · window hidden"
        case .listening: "listening"
        case .thinking: "thinking"
        case .speaking: "speaking"
        case .offline: "offline"
        }
    }
}

/// One Allow/Deny card, full text, scrollable when long.
struct ApprovalCard: View {
    let approval: Approval
    @ObservedObject var model: Model

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("ZEN asks before it acts", systemImage: "hand.raised.fill")
                .font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.accent)
            ScrollView {
                Text(approval.text).font(.system(size: 12)).foregroundStyle(Theme.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            .frame(maxHeight: 120)
            .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Button { model.reply(approval, ok: false) } label: {
                    Text("Deny").frame(maxWidth: .infinity).padding(.vertical, 5)
                        .background(Theme.deny.opacity(0.18), in: RoundedRectangle(cornerRadius: 7))
                        .foregroundStyle(Theme.deny)
                }
                Button { model.reply(approval, ok: true) } label: {
                    Text("Allow").frame(maxWidth: .infinity).padding(.vertical, 5)
                        .background(Theme.sapphire, in: RoundedRectangle(cornerRadius: 7))
                        .foregroundStyle(Theme.text)
                }
            }
            .buttonStyle(.plain)
            .font(.system(size: 12, weight: .semibold))
        }
        .padding(10)
        .background(Theme.sapphire.opacity(0.14), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.accent.opacity(0.35), lineWidth: 1))
    }
}

/// Now playing, laid out like macOS's own Now Playing card: big art on the
/// left; title, "artist – album", the three large buttons and a progress bar
/// with elapsed and remaining time on the right.
struct MusicRow: View {
    let music: NowPlaying
    @ObservedObject var model: Model
    static let artSize: CGFloat = 84
    /// While the timeline is being dragged: where the finger is, 0...1. The bar
    /// and the times follow it; the song only jumps on release, like Music.app.
    @State private var scrub: Double?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            AsyncImage(url: music.art) { img in
                img.resizable().scaledToFill()
            } placeholder: {
                ZStack {
                    Theme.sapphire.opacity(0.25)
                    Image(systemName: "music.note").font(.system(size: 26)).foregroundStyle(Theme.accent)
                }
            }
            .frame(width: Self.artSize, height: Self.artSize)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .shadow(color: .black.opacity(0.35), radius: 4, y: 2)

            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(music.title).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.text).lineLimit(1)
                    Spacer(minLength: 0)
                    if music.playing {
                        Image(systemName: "waveform").font(.system(size: 10)).foregroundStyle(Theme.subtle)
                    }
                }
                Text(music.album.isEmpty ? music.artist : "\(music.artist) – \(music.album)")
                    .font(.system(size: 11)).foregroundStyle(Theme.subtle).lineLimit(1)

                HStack(spacing: 22) {
                    control("backward.fill", "previous", size: 15)
                    control(music.playing ? "pause.fill" : "play.fill", music.playing ? "pause" : "play", size: 20)
                    control("forward.fill", "next", size: 15)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 2)

                // Only ticks while playing: paused, it draws once and costs nothing.
                TimelineView(.periodic(from: .now, by: 1)) { ctx in
                    progress(now: ctx.date)
                }
            }
        }
        .padding(10)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 12))
    }

    @ViewBuilder private func progress(now: Date) -> some View {
        if let d = music.duration, d > 0, let live = music.elapsed(music.playing ? now : music.at) {
            let e = scrub.map { $0 * d } ?? live
            VStack(spacing: 3) {
                GeometryReader { g in
                    let frac = min(1, max(0, e / d))
                    ZStack(alignment: .leading) {
                        Capsule().fill(Theme.text.opacity(0.18)).frame(height: scrub == nil ? 4 : 6)
                        Capsule().fill(Theme.sapphire).frame(width: max(4, g.size.width * frac), height: scrub == nil ? 4 : 6)
                        // The knob shows while scrubbing, like the system player.
                        if scrub != nil {
                            Circle().fill(Theme.text).frame(width: 11, height: 11)
                                .offset(x: g.size.width * frac - 5.5)
                        }
                    }
                    .frame(maxHeight: .infinity)
                    // A tall hit area over a thin bar: easy to grab, click or drag.
                    .contentShape(Rectangle())
                    .gesture(
                        DragGesture(minimumDistance: 0)
                            .onChanged { v in scrub = min(1, max(0, v.location.x / max(1, g.size.width))) }
                            .onEnded { v in
                                let f = min(1, max(0, v.location.x / max(1, g.size.width)))
                                scrub = nil
                                model.seek(to: f * d)
                            }
                    )
                }
                .frame(height: 14)
                .animation(.easeOut(duration: 0.12), value: scrub == nil)
                HStack {
                    Text(clock(e))
                    Spacer()
                    Text("−" + clock(max(0, d - e)))
                }
                .font(.system(size: 9, design: .rounded).monospacedDigit())
                .foregroundStyle(Theme.subtle)
            }
        }
    }

    private func clock(_ s: Double) -> String {
        let t = Int(s.rounded(.down))
        return String(format: "%02d:%02d", t / 60, t % 60)
    }

    private func control(_ symbol: String, _ op: String, size: CGFloat) -> some View {
        Button { model.music(op) } label: {
            Image(systemName: symbol).font(.system(size: size)).foregroundStyle(Theme.text)
                .frame(width: size + 14, height: size + 10).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
