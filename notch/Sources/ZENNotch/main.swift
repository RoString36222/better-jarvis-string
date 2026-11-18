import AppKit
import Combine
import SwiftUI

/// The arc lives in the menu bar as a real status item, with the user's other
/// icons on the right — macOS places it, keeps it in line with them, and lets
/// the user ⌘-drag it like any other. (It used to float in its own window
/// beside the notch, which read as a stray, not part of the bar.)
///
/// The panel opens as a popover under it: on click, and on its own when an
/// Allow card arrives while ZEN's window is hidden, so a card is never missed.
/// Right-click is the menu (Open ZEN, Quit).
@MainActor
final class Controller: NSObject, NSPopoverDelegate {
    let model: Model
    private let item = NSStatusBar.system.statusItem(withLength: 26)
    private let popover = NSPopover()
    private var bag = Set<AnyCancellable>()
    static let arcSize: CGFloat = 18

    init(model: Model) {
        self.model = model
        super.init()
        if let button = item.button {
            // The arc itself, drawn by SwiftUI inside the status button; clicks go to the button.
            let arc = NSHostingView(rootView: LiveArc(model: model).frame(width: Self.arcSize, height: Self.arcSize).allowsHitTesting(false))
            arc.frame = NSRect(x: (26 - Self.arcSize) / 2, y: (button.bounds.height - Self.arcSize) / 2,
                               width: Self.arcSize, height: Self.arcSize)
            arc.autoresizingMask = [.minYMargin, .maxYMargin]
            button.addSubview(arc)
            button.target = self
            button.action = #selector(clicked(_:))
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
            button.toolTip = "ZEN"
        }
        item.autosaveName = "dev.zen.notch.arc"
        popover.behavior = .transient
        popover.animates = true
        popover.delegate = self
        popover.contentViewController = NSHostingController(rootView: PanelView(model: model).frame(width: PanelView.width))

        // A new Allow card while ZEN's window is hidden: open on its own. With the
        // window open the card is already on screen there; the arc's glow is enough.
        model.$approvals
            .map(\.count).removeDuplicates().scan((0, 0)) { ($0.1, $1) }
            .sink { [weak self] prev, now in
                guard let self, now > prev, !self.model.windowOpen else { return }
                self.show()
            }
            .store(in: &bag)
        // The panel's own controls (Open ZEN, the last card answered) close it through the model.
        model.$expanded.removeDuplicates().sink { [weak self] open in
            guard let self else { return }
            if open { self.show() } else if self.popover.isShown { self.popover.performClose(nil) }
        }
        .store(in: &bag)

        if let dir = ProcessInfo.processInfo.environment["ZEN_NOTCH_SNAPSHOT_DIR"] {
            debugSnapshots(dir)
        }
    }

    @objc private func clicked(_ sender: NSStatusBarButton) {
        if NSApp.currentEvent?.type == .rightMouseUp { return showMenu() }
        popover.isShown ? popover.performClose(nil) : show()
    }

    private func show() {
        guard let button = item.button, !popover.isShown else { return }
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        popover.contentViewController?.view.window?.makeKey()
        if !model.expanded { model.expanded = true }
    }

    func popoverDidClose(_ n: Notification) { if model.expanded { model.expanded = false } }

    private func showMenu() {
        let menu = NSMenu()
        menu.addItem(withTitle: "Open ZEN", action: #selector(openZen), keyEquivalent: "").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit ZEN Notch", action: #selector(quit), keyEquivalent: "q").target = self
        item.menu = menu
        item.button?.performClick(nil)
        item.menu = nil
    }
    @objc private func openZen() { model.openZEN() }
    @objc private func quit() { NSApp.terminate(nil) }

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
            renderPanel(to: dir + "/notch-expanded.png")
        }
    }

    /// The panel as drawn off-screen (no popover is shown, so a test card can never
    /// be answered by whoever is using the Mac).
    private func renderPanel(to path: String) {
        let r = ImageRenderer(content: PanelView(model: model).frame(width: PanelView.width).background(Color.black))
        r.scale = 2
        guard let img = r.nsImage, let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else { return }
        try? png.write(to: URL(fileURLWithPath: path))
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
