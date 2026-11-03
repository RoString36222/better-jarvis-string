#!/bin/bash
# Installs ZEN.app into /Applications: the Electron shell from desktop/,
# renamed, with ZEN's icon, pointing at this checkout. Run again after moving
# the repo or updating Electron.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
APP=/Applications/ZEN.app

[ -d desktop/node_modules/electron ] || (cd desktop && npm install)
DIST=desktop/node_modules/electron/dist
if [ ! -d "$DIST/Electron.app" ]; then
  # Electron's own unzip fails on some Node versions; macOS's ditto does not.
  ZIP=$(ls ~/Library/Caches/electron/*/electron-v*-darwin-arm64.zip 2>/dev/null | head -1)
  [ -n "$ZIP" ] || { (cd desktop && node node_modules/electron/install.js); ZIP=$(ls ~/Library/Caches/electron/*/electron-v*-darwin-arm64.zip | head -1); }
  rm -rf "$DIST" && mkdir -p "$DIST" && ditto -x -k "$ZIP" "$DIST"
  printf 'Electron.app/Contents/MacOS/Electron' > desktop/node_modules/electron/path.txt
fi

rm -rf "$APP"
ditto "$DIST/Electron.app" "$APP"
P="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName ZEN" "$P"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName ZEN" "$P" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string ZEN" "$P"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.zen.assistant" "$P"
for k in "NSMicrophoneUsageDescription:ZEN listens for your voice." "NSCameraUsageDescription:ZEN uses the camera only when you ask it to look."; do
  key=${k%%:*}; val=${k#*:}
  /usr/libexec/PlistBuddy -c "Set :$key $val" "$P" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :$key string $val" "$P"
done
cp desktop/icon/zen.icns "$APP/Contents/Resources/electron.icns"
ln -s "$ROOT/desktop" "$APP/Contents/Resources/app"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1
touch "$APP"
echo "Installed $APP — open it from Launchpad or Spotlight; ⌥Space summons it."
