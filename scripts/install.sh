#!/bin/bash
# Installs or updates OpenClean.
#
#   curl -fsSL https://github.com/chadathan/openclean-releases/releases/latest/download/install.sh | bash
#
# What it does: downloads the app from GitHub Releases over HTTPS, checks its SHA-256 checksum,
# asks before installing this self-signed, non-notarized build, then installs it in /Applications
# (or ~/Applications when /Applications is not writable). It never uses sudo.
#
# Options, as environment variables:
#   OPENCLEAN_VERSION=0.3.1   install that version instead of the latest
#   OPENCLEAN_NO_OPEN=1       do not open OpenClean afterwards
#
# Everything runs inside main(), so a download cut off halfway executes nothing.

main() {
  set -euo pipefail

  local repo="${OPENCLEAN_REPO:-chadathan/openclean-releases}"
  local version="${OPENCLEAN_VERSION:-latest}"
  say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
  fail() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

  [ "$(uname -s)" = "Darwin" ] || fail "OpenClean runs on macOS only."
  local arch; arch="$(uname -m)"
  [ "$arch" = "arm64" ] || fail "This release supports Apple silicon Macs only (found $arch)."

  printf '\nOpenClean is self-signed and has not been notarized by Apple.\n'
  printf 'The installer verifies the downloaded archive checksum, but macOS may still warn or block the app.\n'
  local answer
  if ! read -r -p "Continue installing OpenClean? [y/N] " answer </dev/tty; then
    fail "Could not read confirmation from a terminal."
  fi
  case "$answer" in y|Y|yes|YES) ;; *) say "Installation cancelled."; return 0 ;; esac

  local asset="OpenClean-mac-arm64.zip"
  local base
  if [ "$version" = "latest" ]; then base="https://github.com/$repo/releases/latest/download"
  else base="https://github.com/$repo/releases/download/v${version#v}"; fi

  # Global, not local: the EXIT trap runs after main() returns.
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/openclean-install.XXXXXX")"
  trap 'rm -rf "${tmp:?}"' EXIT

  say "Downloading OpenClean ($version)"
  curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp/$asset" "$base/$asset" || fail "Download failed: $base/$asset"
  curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" || fail "Could not download the checksum file."

  say "Checking the download"
  local expected actual
  expected="$(awk -v name="$asset" '$2 == name { print $1 }' "$tmp/SHA256SUMS")"
  actual="$(shasum -a 256 "$tmp/$asset" | awk '{ print $1 }')"
  [ -n "$expected" ] || fail "The checksum file does not list $asset."
  [ "$expected" = "$actual" ] || fail "Checksum mismatch. The download may be damaged or altered; nothing was installed."

  ditto -x -k "$tmp/$asset" "$tmp/unpacked"
  local app="$tmp/unpacked/OpenClean.app"
  [ -d "$app" ] || fail "The download does not contain OpenClean.app."

  local dest="/Applications"
  if [ ! -w "$dest" ]; then dest="$HOME/Applications"; mkdir -p "$dest"; fi

  if pgrep -x OpenClean >/dev/null 2>&1; then
    say "Quitting the running OpenClean"
    # OpenClean keeps running in the menu bar when its window closes, so ask it to quit and then
    # make sure it has.
    pkill -TERM -x OpenClean 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -x OpenClean >/dev/null 2>&1 || break; sleep 0.5; done
    pgrep -x OpenClean >/dev/null 2>&1 && fail "OpenClean is still running. Quit it from its menu bar icon and run this again."
  fi

  say "Installing to $dest"
  local target="$dest/OpenClean.app"
  if [ -e "$target" ]; then mv "$target" "$tmp/previous.app"; fi
  if ! mv "$app" "$target"; then
    [ -e "$tmp/previous.app" ] && mv "$tmp/previous.app" "$target"
    fail "Could not move OpenClean into $dest. The previous version was kept."
  fi
  # curl does not mark downloads as quarantined, but clear the flag in case something else did.
  xattr -dr com.apple.quarantine "$target" 2>/dev/null || true

  local installed; installed="$(defaults read "$target/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo "")"
  say "OpenClean ${installed} is installed in $dest"
  echo "    Update later by running the same command again."
  echo "    Uninstall: curl -fsSL https://github.com/$repo/releases/latest/download/uninstall.sh | bash"

  if [ "${OPENCLEAN_NO_OPEN:-0}" != "1" ]; then open "$target"; fi
}

main "$@"
