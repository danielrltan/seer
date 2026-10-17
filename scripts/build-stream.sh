#!/bin/bash
# Builds ~/.seer/SeerStream.app (ad-hoc signed: an Apple Development signature makes Gatekeeper trash it when
# launched outside Xcode). A rebuild changes its code hash, so macOS asks for Screen Recording and Accessibility again.
set -euo pipefail
cd "$(dirname "$0")/.."
B="$HOME/.seer/SeerStream.app"
mkdir -p "$B/Contents/MacOS"
cat > "$B/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.seer.stream</string>
<key>CFBundleName</key><string>Seer Stream</string>
<key>CFBundleDisplayName</key><string>Seer Stream</string>
<key>CFBundleExecutable</key><string>SeerStream</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
</dict></plist>
PLIST
swiftc -O -target arm64-apple-macos14.0 -o "$B/Contents/MacOS/SeerStream" src/helpers/stream/SeerStream.swift
codesign --force --sign - "$B"
xattr -cr "$B"
echo "built $B"
