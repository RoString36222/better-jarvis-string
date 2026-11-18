#!/bin/bash
# Builds ZEN Notch (release) with the Command Line Tools alone — no Xcode.
# The binary lands in notch/.build/release/ZENNotch; install.sh bundles it.
set -euo pipefail
cd "$(dirname "$0")/.."
swift build -c release
echo "built: $(swift build -c release --show-bin-path)/ZENNotch"
