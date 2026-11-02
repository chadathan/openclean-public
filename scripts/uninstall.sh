#!/bin/bash
# Removes OpenClean.
#
#   curl -fsSL https://github.com/chadathan/openclean-releases/releases/latest/download/uninstall.sh | bash
#
# Removes the app from /Applications and ~/Applications. Your settings and OpenClean's record of
# items it moved to the Trash are kept, so reinstalling can still put those items back. To remove
# them as well, run with OPENCLEAN_PURGE=1. Items already in the Trash are never touched.

main() {
  set -euo pipefail
  say() { printf '\033[1m==>\033[0m %s\n' "$*"; }

  if pgrep -x OpenClean >/dev/null 2>&1; then
    say "Quitting OpenClean"
    pkill -TERM -x OpenClean 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -x OpenClean >/dev/null 2>&1 || break; sleep 0.5; done
  fi

  local removed=0 app
  for app in "/Applications/OpenClean.app" "${HOME:?}/Applications/OpenClean.app"; do
    if [ -d "$app" ] && [ -f "$app/Contents/Info.plist" ] \
      && [ "$(defaults read "$app/Contents/Info" CFBundleIdentifier 2>/dev/null)" = "com.openclean.app" ]; then
      rm -rf "${app:?}"
      say "Removed $app"
      removed=1
    fi
  done
  [ "$removed" = 1 ] || say "OpenClean.app was not found in /Applications or ~/Applications."

  if [ "${OPENCLEAN_PURGE:-0}" = "1" ]; then
    local data="${HOME:?}/Library/Application Support/OpenClean"
    if [ -d "$data" ]; then rm -rf "${data:?}"; say "Removed settings and Put back records in $data"; fi
  else
    echo "    Settings and Put back records were kept. Run with OPENCLEAN_PURGE=1 to remove them."
  fi
}

main "$@"
