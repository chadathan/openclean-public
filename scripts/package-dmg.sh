#!/bin/bash
# Builds OpenClean.app and a DMG for it.
#
# Signs with OpenClean's own certificate when it is set up and trusted (see
# create-signing-cert.sh); otherwise signs ad hoc, which Apple silicon needs to run the app at all.
# A DMG downloaded in a browser is quarantined: an app without an Apple Developer ID still needs
# "Open Anyway" in System Settings › Privacy & Security on first launch.
set -euo pipefail

VERSION="$(node -p "require('./package.json').version")"
APP="release/mac-arm64/OpenClean.app"
KEYCHAIN="${OPENCLEAN_SIGNING_DIR:-$HOME/.openclean-signing}/openclean-signing.keychain-db"

npm run package:mac

if [ -e "$KEYCHAIN" ] && security find-identity -v -p codesigning "$KEYCHAIN" | grep -q "OpenClean Self-Signed Code Signing"; then
  scripts/sign-mac.sh "$APP"
  SIGNED="OpenClean certificate"
else
  echo "OpenClean's certificate is not set up or not trusted; signing ad hoc."
  codesign --force --deep --sign - "$APP"
  codesign --verify --deep --strict "$APP"
  SIGNED="ad hoc"
fi

rm -f "release/OpenClean-$VERSION-arm64.dmg" "release/OpenClean-$VERSION-arm64.dmg.blockmap"
npx electron-builder --mac dmg --arm64 --prepackaged "$APP"
DMG="release/OpenClean-$VERSION-arm64.dmg"
hdiutil verify "$DMG" >/dev/null
echo "Built $DMG (signed: $SIGNED)"
shasum -a 256 "$DMG"
