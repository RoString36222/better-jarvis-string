#!/bin/bash
# Installs ZEN Notch: builds it, bundles ~/Applications/ZEN Notch.app, signs it
# ad-hoc, and starts it at login with a LaunchAgent.
#
#   notch/scripts/install.sh              build, install, start now and at login
#   notch/scripts/install.sh --no-login   same, without the login item
#   notch/scripts/install.sh --uninstall  stop it and remove the app and agent
#
# Ad-hoc signing is enough on your own Mac; sharing the .app needs a Developer ID.
set -euo pipefail
cd "$(dirname "$0")/.."

APP="$HOME/Applications/ZEN Notch.app"
LABEL="dev.zen.notch"
AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"
VERSION="0.1.0"

stop() {
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  pkill -x ZENNotch 2>/dev/null || true
}

if [ "${1:-}" = "--uninstall" ]; then
  stop
  rm -f "$AGENT"
  rm -rf "$APP"
  echo "ZEN Notch removed."
  exit 0
fi

echo "building ZEN Notch (swift build -c release)…"
swift build -c release
BIN="$(swift build -c release --show-bin-path)/ZENNotch"

stop
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN" "$APP/Contents/MacOS/ZENNotch"
# LSUIElement: no Dock icon and no menu of its own — the arc is the whole app.
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>ZEN Notch</string>
  <key>CFBundleDisplayName</key><string>ZEN Notch</string>
  <key>CFBundleIdentifier</key><string>$LABEL</string>
  <key>CFBundleExecutable</key><string>ZENNotch</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
codesign --force --sign - "$APP"
echo "installed $APP"

if [ "${1:-}" = "--no-login" ]; then
  rm -f "$AGENT"
  open "$APP"
  echo "ZEN Notch is running (not at login)."
  exit 0
fi

mkdir -p "$(dirname "$AGENT")"
# KeepAlive on a crash only: Quit from the arc's menu means quit.
cat > "$AGENT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$APP/Contents/MacOS/ZENNotch</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Interactive</string>
</dict></plist>
PLIST
if ! launchctl bootstrap "gui/$(id -u)" "$AGENT" 2>/dev/null; then
  echo "  launchctl bootstrap failed; opening the app directly"
  open "$APP"
fi
echo "ZEN Notch is running and starts at login."
