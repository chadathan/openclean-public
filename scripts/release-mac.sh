#!/bin/bash
# Builds, signs and publishes a release to GitHub Releases.
#
#   scripts/release-mac.sh            # version from package.json
#   OPENCLEAN_RELEASE_REPO=owner/name scripts/release-mac.sh
#
# The release repository must be public, because the install script downloads without signing in.
set -euo pipefail

REPO="${OPENCLEAN_RELEASE_REPO:-chadathan/openclean-releases}"
VERSION="$(node -p "require('./package.json').version")"
TAG="v$VERSION"
OUT="release/publish"
ASSET="OpenClean-mac-arm64.zip"

command -v gh >/dev/null || { echo "Install the GitHub CLI (gh) first." >&2; exit 1; }
[ "$(gh repo view "$REPO" --json visibility -q .visibility 2>/dev/null)" = "PUBLIC" ] \
  || { echo "$REPO must exist and be public so the install script can download from it." >&2; exit 1; }
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "$TAG already exists in $REPO. Bump the version in package.json first." >&2; exit 1
fi

npm run package:mac
APP="release/mac-arm64/OpenClean.app"
scripts/sign-mac.sh "$APP"

rm -rf "$OUT"; mkdir -p "$OUT"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT/$ASSET"
( cd "$OUT" && shasum -a 256 "$ASSET" > SHA256SUMS )
cp scripts/install.sh scripts/uninstall.sh "$OUT/"

gh release create "$TAG" --repo "$REPO" --title "OpenClean $VERSION" \
  --notes "Install or update: \`curl -fsSL https://github.com/$REPO/releases/latest/download/install.sh | bash\`" \
  "$OUT/$ASSET" "$OUT/SHA256SUMS" "$OUT/install.sh" "$OUT/uninstall.sh"
echo "Published $TAG to $REPO"
