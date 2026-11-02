#!/bin/bash
# Signs a built OpenClean.app with OpenClean's own certificate (see create-signing-cert.sh).
# Usage: scripts/sign-mac.sh path/to/OpenClean.app
set -euo pipefail

APP="${1:?Usage: sign-mac.sh path/to/OpenClean.app}"
DIR="${OPENCLEAN_SIGNING_DIR:-$HOME/.openclean-signing}"
KEYCHAIN="$DIR/openclean-signing.keychain-db"
NAME="OpenClean Self-Signed Code Signing"

[ -d "$APP" ] || { echo "Not an app bundle: $APP" >&2; exit 1; }
[ -e "$KEYCHAIN" ] || { echo "No signing keychain at $KEYCHAIN. Run scripts/create-signing-cert.sh first." >&2; exit 1; }
if ! security find-identity -v -p codesigning "$KEYCHAIN" | grep -q "$NAME"; then
  echo "The signing certificate is not trusted for code signing yet. Run:" >&2
  echo "  security add-trusted-cert -r trustRoot -p codeSign -k \"$KEYCHAIN\" \"$DIR/cert.pem\"" >&2
  exit 1
fi
security unlock-keychain -p "$(cat "$DIR/keychain-password.txt")" "$KEYCHAIN"

sign() { codesign --force --sign "$NAME" --keychain "$KEYCHAIN" --timestamp=none "$@"; }

# Loose executables (the native helpers in app.asar.unpacked) are not reached by --deep.
while IFS= read -r -d '' file; do
  if file -b "$file" | grep -q 'Mach-O'; then sign "$file"; fi
done < <(find "$APP/Contents/Resources" -type f -perm -u+x -print0)

# Frameworks and helper apps, then the app itself.
sign --deep "$APP"

codesign --verify --deep --strict "$APP"
echo "Signed: $APP"
codesign -d -r- "$APP" 2>&1 | sed -n 's/^designated => /Designated requirement: /p'
