#!/bin/bash
# Builds Seer.app: the menu-bar app (src/app/*.swift) with everything Seer needs inside it:
#   Contents/MacOS/Seer              the app, the screen stream, and `Seer wifi ...`
#   Contents/Resources/bin/node      the Node runtime (Apple-silicon slice only)
#   Contents/Resources/bin/cloudflared
#   Contents/Resources/seer/         Seer's own code (bin, src, assets, node_modules)
# Usage: scripts/build-app.sh [--install]   (--install replaces /Applications/Seer.app, deploys the code and reopens it)
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="build/Seer.app"
rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources/bin" "$OUT/Contents/Resources/seer"

swiftc -O -target arm64-apple-macos14.0 -import-objc-header src/app/CGVirtualDisplayPrivate.h -o "$OUT/Contents/MacOS/Seer" src/app/*.swift

lipo "$(readlink -f "$(command -v node)")" -thin arm64 -output "$OUT/Contents/Resources/bin/node" 2>/dev/null \
  || cp "$(readlink -f "$(command -v node)")" "$OUT/Contents/Resources/bin/node"
cp "$(readlink -f "$(command -v cloudflared)")" "$OUT/Contents/Resources/bin/cloudflared"
chmod -R u+w "$OUT/Contents/Resources/bin"                      # Homebrew installs them read-only
rsync -a --exclude '.DS_Store' bin src assets node_modules package.json "$OUT/Contents/Resources/seer/"
rm -rf "$OUT/Contents/Resources/seer/src/app" "$OUT/Contents/Resources/seer/src/helpers"   # compiled into the app

# icon: on macOS 26 an app icon must come from an Icon Composer icon (assets/Seer.icon) compiled into Assets.car,
# or the system draws it shrunk inside a grey frame; actool (Xcode) compiles it, with Seer.icns for older macOS.
# Without Xcode: AppIcon.icns from the macOS master (assets/icon-macos-1024.png).
ICON_FILE=AppIcon
if xcrun --find actool >/dev/null 2>&1; then
  xcrun actool assets/Seer.icon --compile "$OUT/Contents/Resources" --platform macosx --minimum-deployment-target 14.0 \
    --app-icon Seer --output-partial-info-plist "$(mktemp -d)/partial.plist" >/dev/null
  ICON_FILE=Seer
else
  ICONSET="$(mktemp -d)/AppIcon.iconset"; mkdir -p "$ICONSET"
  for s in 16 32 64 128 256 512; do
    sips -z $s $s assets/icon-macos-1024.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
    [ $s -le 256 ] && sips -z $((s*2)) $((s*2)) assets/icon-macos-1024.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$OUT/Contents/Resources/AppIcon.icns"
fi

cat > "$OUT/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.seer.app</string>
<key>CFBundleName</key><string>Seer</string>
<key>CFBundleDisplayName</key><string>Seer</string>
<key>CFBundleExecutable</key><string>Seer</string>
<key>CFBundleIconFile</key><string>$ICON_FILE</string>
<key>CFBundleIconName</key><string>Seer</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.2</string>
<key>CFBundleVersion</key><string>2</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
<key>NSScreenCaptureUsageDescription</key><string>Seer streams your screen to your phone while you watch it there.</string>
</dict></plist>
PLIST

# Signed with "Seer Local Signing" (scripts/make-signing-cert.sh, a self-signed certificate in this Mac's
# keychain): macOS then ties Screen Recording and Accessibility to the certificate, and a rebuild keeps both.
# Without it, ad hoc: macOS ties them to this exact build and every rebuild asks for both again.
# (Never an Apple Development certificate: Gatekeeper flags that build as malware and offers to trash it.)
if security find-certificate -c "Seer Local Signing" >/dev/null 2>&1; then
  codesign --force --deep --sign "Seer Local Signing" "$OUT"
  echo "signed with Seer Local Signing: permissions carry over"
else
  codesign --force --deep --sign - "$OUT"
  echo "signed ad hoc: macOS will ask for Screen Recording and Accessibility again (scripts/make-signing-cert.sh fixes that)"
fi
xattr -cr "$OUT"
echo "built $OUT ($(du -sh "$OUT" | cut -f1))"

if [ "${1:-}" = "--install" ]; then
  osascript -e 'tell application "Seer" to quit' >/dev/null 2>&1 || true
  for _ in $(seq 20); do pgrep -qx Seer || break; sleep 0.5; done   # gone, or open below only wakes the one quitting
  rm -rf /Applications/Seer.app
  cp -R "$OUT" /Applications/Seer.app
  xattr -cr /Applications/Seer.app
  echo "installed /Applications/Seer.app"
  "$(dirname "$0")/deploy-code.sh" --no-restart
  open -a /Applications/Seer.app && echo "reopened Seer"
fi
