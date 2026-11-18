import AppKit
import Combine
import SwiftUI

/// Borderless panel over the menu bar, on every Space, that never steals focus.
/// Same recipe as HQ Notch: mouse events pass through except over what is drawn.
final class ArcPanel: NSPanel {
    init(frame: NSRect) {
        super.init(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        level = .statusBar
        collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        isMovable = false
        hidesOnDeactivate = false
        ignoresMouseEvents = true
    }
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

/// The window's content: the arc at `arcX` in the menu bar, the panel hanging under it.
struct Root: View {
    @ObservedObject var model: Model
    let arcX: CGFloat
    let barHeight: CGFloat
    let panelX: CGFloat
    static let arcSize: CGFloat = 18

    var body: some View {
        ZStack(alignment: .topLeading) {
            LiveArc(model: model)
                .frame(width: Self.arcSize + 8, height: barHeight)
                .onTapGesture { model.expanded.toggle() }
                .contextMenu { Button("Quit ZEN Notch") { NSApp.terminate(nil) } }
                .offset(x: arcX - (Self.arcSize + 8) / 2)
            if model.expanded {
                PanelView(model: model)
                    .onGeometryChange(for: CGSize.self, of: { $0.size }) { s in if s != .zero { model.panelSize = s } }
                    .offset(x: panelX, y: barHeight + 4)
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .animation(.easeOut(duration: 0.15), value: model.expanded)
    }
}

@MainActor
final class Controller {
    let model: Model
    private var panel: ArcPanel!
    private var bag = Set<AnyCancellable>()
    private var mouseTimer: Timer?
    private var enteredAt: Date?
    private var leftAt: Date?
    private var autoOpenUntil: Date?
    /// Arc centre and panel's left edge, in the window's own coordinates.
    private var arcX: CGFloat = 0
    private var panelX: CGFloat = 0
    private var barHeight: CGFloat = 24
    static let windowSize = CGSize(width: PanelView.width + 40, height: 560)
    /// Rest on the arc this long before the panel opens (a pass-by never opens it).
    static let hoverDelay: TimeInterval = 0.25

    init(model: Model) {
        self.model = model
        panel = ArcPanel(frame: NSRect(origin: .zero, size: Self.windowSize))
        layout()
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
                                               object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.layout() }
        }
        // A new Allow card while ZEN's window is hidden: open on its own, so it is
        // seen even if nobody is looking at the menu bar. With the window open the
        // card is already on screen there; the arc's halo is enough.
        model.$approvals
            .map(\.count).removeDuplicates().scan((0, 0)) { ($0.1, $1) }
            .sink { [weak self] prev, now in
                guard let self, now > prev, !self.model.windowOpen else { return }
                self.autoOpenUntil = Date().addingTimeInterval(8)
                self.model.expanded = true
            }
            .store(in: &bag)
        mouseTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 20, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.trackMouse() }
        }
        panel.orderFrontRegardless()
        if let dir = ProcessInfo.processInfo.environment["ZEN_NOTCH_SNAPSHOT_DIR"] {
            // A snapshot run draws off-glass: fully transparent and click-through, so a
            // test card can never be answered by whoever is using the Mac meanwhile.
            snapshotOnly = true
            panel.alphaValue = 0
            debugSnapshots(dir)
        }
    }

    /// The built-in notched display if there is one, else the main screen.
    private var screen: NSScreen? { NSScreen.screens.first { $0.safeAreaInsets.top > 0 } ?? NSScreen.main }

    /// Just right of the hardware notch, clear of HQ Notch.
    ///
    /// HQ Notch sits *in* the notch with a 64pt wing (+10 padding) either side of it, so
    /// its closed pill ends 74pt right of the notch's edge. The arc goes a little past
    /// that: never overlapping HQ, still reading as part of the notch. Without a notch
    /// (external display), the arc sits right of the menu bar's middle the same way.
    /// `defaults write dev.zen.notch offset N` nudges it (points, + = further right).
    private func layout() {
        guard let sc = screen else { return }
        let f = sc.frame
        var notchRight = f.midX + 60
        if sc.safeAreaInsets.top > 0, let r = sc.auxiliaryTopRightArea {
            notchRight = r.minX
            barHeight = sc.safeAreaInsets.top
        } else {
            barHeight = max(24, f.maxY - sc.visibleFrame.maxY)
        }
        let nudge = CGFloat(UserDefaults.standard.double(forKey: "offset"))
        let arcCentre = notchRight + 74 + 8 + Root.arcSize / 2 + 4 + nudge
        let w = Self.windowSize
        let x = min(max(f.minX, arcCentre - w.width / 2), f.maxX - w.width)
        panel.setFrame(NSRect(x: x, y: f.maxY - w.height, width: w.width, height: w.height), display: true)
        arcX = arcCentre - x
        // The panel hangs centred under the arc, kept inside the window.
        panelX = min(max(4, arcX - PanelView.width / 2), w.width - PanelView.width - 4)
        panel.contentView = NSHostingView(rootView: Root(model: model, arcX: arcX, barHeight: barHeight, panelX: panelX))
    }

    /// Screen rects of what is drawn: the arc, and the panel when open.
    private var arcRect: NSRect {
        let pf = panel.frame
        let half = Root.arcSize / 2 + 6
        return NSRect(x: pf.minX + arcX - half, y: pf.maxY - barHeight, width: half * 2, height: barHeight)
    }
    private var panelRect: NSRect {
        let pf = panel.frame, s = model.panelSize
        return NSRect(x: pf.minX + panelX, y: pf.maxY - barHeight - 4 - s.height, width: s.width, height: s.height + 4)
    }

    private var snapshotOnly = false

    private func trackMouse() {
        if snapshotOnly { panel.ignoresMouseEvents = true; return }
        let p = NSEvent.mouseLocation
        let onArc = arcRect.insetBy(dx: -2, dy: -2).contains(p)
        let inside = onArc || (model.expanded && panelRect.insetBy(dx: -2, dy: -2).contains(p))
        panel.ignoresMouseEvents = !inside
        if inside {
            leftAt = nil
            if onArc, !model.expanded {
                if enteredAt == nil { enteredAt = Date() }
                if let e = enteredAt, Date().timeIntervalSince(e) >= Self.hoverDelay { model.expanded = true }
            }
            return
        }
        enteredAt = nil
        guard model.expanded else { return }
        if let until = autoOpenUntil, Date() < until { return }
        autoOpenUntil = nil
        if leftAt == nil { leftAt = Date() }
        if let l = leftAt, Date().timeIntervalSince(l) > 0.45 {
            model.expanded = false
            leftAt = nil
            panel.resignKey()
        }
    }

    // MARK: Debug snapshots

    /// ZEN_NOTCH_SNAPSHOT_DIR=<dir>: PNGs of the app's own views, no Screen Recording
    /// permission needed. arc-states.png renders every phase of the glyph (large, side by
    /// side); then the live window is captured closed and open, after a few seconds so a
    /// test bridge has time to send state, music and a card.
    private func debugSnapshots(_ dir: String) {
        Task { @MainActor in
            renderArcStates(to: dir + "/arc-states.png")
            let wait = Double(ProcessInfo.processInfo.environment["ZEN_NOTCH_SNAPSHOT_WAIT"] ?? "") ?? 4
            try? await Task.sleep(for: .seconds(wait))
            snapshotWindow(to: dir + "/notch-closed.png")
            autoOpenUntil = Date().addingTimeInterval(3)
            model.expanded = true
            try? await Task.sleep(for: .seconds(1.2))
            snapshotWindow(to: dir + "/notch-expanded.png")
            autoOpenUntil = nil
        }
    }

    private func renderArcStates(to path: String) {
        let states: [(String, Phase, Bool, Double)] = [
            ("idle", .idle, false, 0), ("listening", .listening, false, 0.45),
            ("thinking", .thinking, false, 0.2), ("speaking", .speaking, false, 0.3),
            ("offline", .offline, false, 0), ("waiting on you", .idle, true, 0.6),
        ]
        let strip = HStack(spacing: 18) {
            ForEach(states, id: \.0) { s in
                VStack(spacing: 6) {
                    ArcGlyph(phase: s.1, attention: s.2, time: s.3).frame(width: 30, height: 30)
                    Text(s.0).font(.system(size: 8)).foregroundStyle(.white.opacity(0.7))
                }
            }
        }
        .padding(14)
        .background(Color.black)
        let r = ImageRenderer(content: strip)
        r.scale = 5
        guard let img = r.nsImage, let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else { return }
        try? png.write(to: URL(fileURLWithPath: path))
    }

    private func snapshotWindow(to path: String) {
        guard let v = panel.contentView else { return }
        // What is drawn: from the top of the bar down to the panel's bottom when open.
        let h = model.expanded ? barHeight + 4 + model.panelSize.height + 8 : barHeight
        var r = NSRect(x: 0, y: v.bounds.height - h, width: v.bounds.width, height: h)
        if v.isFlipped { r.origin.y = 0 }
        guard let rep = v.bitmapImageRepForCachingDisplay(in: r) else { return }
        v.cacheDisplay(in: r, to: rep)
        // On black, as it will look against the menu bar beside the notch.
        let pw = rep.pixelsWide, ph = rep.pixelsHigh
        guard let out = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pw, pixelsHigh: ph, bitsPerSample: 8,
                                         samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                         colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: out)
        let all = NSRect(x: 0, y: 0, width: pw, height: ph)
        NSColor.black.setFill()
        all.fill()
        rep.draw(in: all, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: false, hints: nil)
        NSGraphicsContext.restoreGraphicsState()
        try? out.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = Model()
    var controller: Controller?
    var bridge: Bridge?

    func applicationDidFinishLaunching(_ n: Notification) {
        controller = Controller(model: model)
        bridge = Bridge(model: model)
        bridge?.start()
    }
    func applicationWillTerminate(_ n: Notification) { bridge?.stop() }
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    // No Dock icon, no menu bar of its own: the arc is the whole app.
    app.setActivationPolicy(.accessory)
    let delegate = AppDelegate()
    app.delegate = delegate
    app.run()
}
