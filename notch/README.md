# ZEN Notch

A very small arc reactor (18pt) just right of the Mac's notch that stands in for ZEN while
its window is hidden. Close ZEN (✕, ⌥Space or Esc) and the window drops its 3D scene
entirely, so the GPU goes quiet; the arc keeps showing what ZEN is doing and lets you answer
it without opening the window.

- **Still** when ZEN is idle, **slow pulse** while listening, **spinning** while thinking,
  **ripples** while speaking, **dim** when ZEN (the bridge) isn't running.
- **A soft halo** while an Allow card is waiting. If ZEN's window is hidden, the panel also
  opens on its own for a few seconds, so an approval is never missed.
- **Hover or click** the arc for the panel: Allow / Deny cards (full text, scrollable), what
  Spotify is playing with ⏮ ⏯ ⏭, ZEN's last spoken alert, and **Open ZEN**. It hides again
  when the mouse leaves. Right-click the arc to quit.

macOS 14+. Builds with the Xcode Command Line Tools alone.

## Install

```sh
notch/scripts/install.sh              # build, install, start now and at login
notch/scripts/install.sh --no-login   # same, without the login item
notch/scripts/install.sh --uninstall
```

It builds with `swift build -c release`, bundles `~/Applications/ZEN Notch.app`
(`LSUIElement`: no Dock icon), signs it ad-hoc (fine on your own Mac; sharing needs a
Developer ID), and adds `~/Library/LaunchAgents/dev.zen.notch.plist` (restarts after a crash,
not after Quit). `start-kimi.sh` also opens the app if it is installed and not running.

## How it works

```
ZEN page (src/) ──{type:'phase'}──▶ bridge ◀──ws://127.0.0.1:8787/notch──▶ ZEN Notch.app
            ◀── approve / approve-done / window:show ──┘   (bridge/notch.mjs)
```

- **Everything comes over the bridge, on loopback.** The app never reads ZEN's files (HQ
  Notch learned that touching `~/Documents` raises a macOS privacy prompt that froze it).
- **Narrow by design.** `/notch` gets the phase, a short caption, now-playing, alerts and
  pending cards; it can answer a card, press a player button, or ask for the window. It cannot
  talk to the agent. That is why the bridge accepts this native, origin-less client on
  `/notch` (from `127.0.0.1` only) while it still refuses origin-less clients on the main socket.
- **First answer wins.** Every Allow card goes to the ZEN window *and* every notch. Whichever
  answers first settles it; the other is sent `approve-done` and dismisses its copy. Cards ZEN
  answers itself within a quarter second (an "Allow next 2 min" window) are never shown here.
- **Open ZEN** goes notch → bridge → page → Electron (`[zen:show]` on the console, the
  desktop app's existing line to the page), which shows and focuses the window.
- **Reconnects** with backoff (1, 2, 4, 8, then every 15 s), so start order doesn't matter.

## Coexisting with HQ Notch

HQ Notch sits *in* the notch with a 64pt wing either side; ZEN's arc goes just past HQ's
right wing, in the menu-bar band, so the two never overlap. Nudge it with
`defaults write dev.zen.notch offset 12` (points, + = further right; restart the app).

## Develop

```sh
notch/scripts/build.sh                       # swift build -c release
ZEN_NOTCH_PORT=8799 notch/.build/release/ZENNotch   # against a test bridge
```

- `ZEN_NOTCH_PORT` (or `defaults write dev.zen.notch port N`) points it at another bridge.
- `ZEN_NOTCH_SNAPSHOT_DIR=<dir>` writes PNGs of its own views — no Screen Recording permission
  needed: `arc-states.png` (every arc state, large), then the live window closed and open
  (`ZEN_NOTCH_SNAPSHOT_WAIT` seconds after launch, default 4). In this mode the window is fully
  transparent and click-through, so a test card can't be answered by whoever is at the Mac.
- A test bridge for it: `JARVIS_BRIDGE_PORT=8799 ZEN_MUSIC_DRY=1 ZEN_TEST_HOOKS=1 node
  bridge/server.mjs`. `ZEN_MUSIC_DRY=1` fakes Spotify (a fixed track, buttons only logged) so a
  test never touches real playback; `ZEN_TEST_HOOKS=1` lets a page raise an Allow card
  (`{type:'test-approve', text}`) or an alert (`{type:'test-notify', text}`) without a model turn.
