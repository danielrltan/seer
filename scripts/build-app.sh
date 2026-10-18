#!/bin/bash
# Builds Seer.app: the menu-bar app (src/app/*.swift) with everything Seer needs inside it:
#   Contents/MacOS/Seer              the app, the screen stream, and `Seer wifi ...`
#   Contents/Resources/bin/node      the Node runtime (Apple-silicon slice only)
#   Contents/Resources/bin/cloudflared
#   Contents/Resources/seer/         Seer's own code (bin, src, assets, node_modules)
# Usage: scripts/build-app.sh [--install]   (--install replaces /Applications/Seer.app and deploys the code)
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="build/Seer.app"
rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources/bin" "$OUT/Contents/Resources/seer"

swiftc -O -target arm64-apple-macos14.0 -o "$OUT/Contents/MacOS/Seer" src/app/*.swift

lipo "$(readlink -f "$(command -v node)")" -thin arm64 -output "$OUT/Contents/Resources/bin/node" 2>/dev/null \
  || cp "$(readlink -f "$(command -v node)")" "$OUT/Contents/Resources/bin/node"
cp "$(readlink -f "$(command -v cloudflared)")" "$OUT/Contents/Resources/bin/cloudflared"
chmod -R u+w "$OUT/Contents/Resources/bin"                      # Homebrew installs them read-only
rsync -a --exclude '.DS_Store' bin src assets node_modules package.json "$OUT/Contents/Resources/seer/"
rm -rf "$OUT/Contents/Resources/seer/src/app" "$OUT/Contents/Resources/seer/src/helpers"   # compiled into the app

# icon: AppIcon.icns from the 512 px master
ICONSET="$(mktemp -d)/AppIcon.iconset"; mkdir -p "$ICONSET"
for s in 16 32 64 128 256 512; do
  sips -z $s $s assets/icon-512.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  [ $s -le 256 ] && sips -z $((s*2)) $((s*2)) assets/icon-512.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$OUT/Contents/Resources/AppIcon.icns"

cat > "$OUT/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.seer.app</string>
<key>CFBundleName</key><string>Seer</string>
<key>CFBundleDisplayName</key><string>Seer</string>
<key>CFBundleExecutable</key><string>Seer</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.2</string>
<key>CFBundleVersion</key><string>2</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
<key>NSScreenCaptureUsageDescription</key><string>Seer streams your screen to your phone while you watch it there.</string>
</dict></plist>
PLIST

# Signed ad hoc. (An Apple Development signature gets the app flagged as malware and trashed by Gatekeeper.) macOS
# ties Screen Recording and Accessibility to this exact build, so a rebuild asks for both again: rebuild only when
# the Swift app, node or cloudflared change. Seer's own code changes go out with scripts/deploy-code.sh instead.
codesign --force --deep --sign - "$OUT"
xattr -cr "$OUT"
echo "built $OUT ($(du -sh "$OUT" | cut -f1))"

if [ "${1:-}" = "--install" ]; then
  osascript -e 'tell application "Seer" to quit' >/dev/null 2>&1 || true
  sleep 1
  rm -rf /Applications/Seer.app
  cp -R "$OUT" /Applications/Seer.app
  xattr -cr /Applications/Seer.app
  echo "installed /Applications/Seer.app"
  "$(dirname "$0")/deploy-code.sh" --no-restart
fi
