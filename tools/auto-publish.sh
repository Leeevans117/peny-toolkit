#!/bin/bash
# Publishes the toolkit to the office server whenever main has a commit that is not
# published yet, so every installer Mac picks it up within 5 minutes (update.sh).
# Run by the post-commit hook (in the background) and by auto-update.sh every hour
# (catches up after the server was not connected). Does nothing unless this Mac is THE
# build machine (~/.peny-toolkit/publisher, made by tools/become-builder.sh), when the
# server is not connected, when this checkout is not on main, or when the commit is
# already published.
#   PENY_SHARE   server folder (default /Volumes/ampdata/Peny/Claude/PenyToolkit)
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SHARE="${PENY_SHARE:-/Volumes/ampdata/Peny/Claude/PenyToolkit}"
LOG="$HOME/Library/Logs/PenyToolkit-publish.log"
[ -f "$HOME/.peny-toolkit/publisher" ] || exit 0   # only one Mac publishes
mkdir -p "$(dirname "$LOG")"
log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG"; }
if [ ! -d "$(dirname "$SHARE")" ]; then   # logged once per change of state
  [ "$(tail -1 "$LOG" 2>/dev/null | cut -c21-)" = "office server not connected - will publish when it is" ] \
    || log "office server not connected - will publish when it is"
  exit 0
fi
[ "$(git -C "$REPO" rev-parse --abbrev-ref HEAD)" = "${PENY_PUBLISH_BRANCH:-main}" ] || exit 0
LOCK="${TMPDIR:-/tmp}/peny-auto-publish.lock"
mkdir "$LOCK" 2>/dev/null || exit 0   # a publish is running; it re-checks HEAD when done
trap 'rmdir "$LOCK"' EXIT
for _ in 1 2 3; do   # commits made while publishing are published straight after
  head="$(git -C "$REPO" rev-parse --short HEAD)"
  [ "$(plutil -extract commit raw -o - "$SHARE/releases/version.json" 2>/dev/null)" = "$head" ] && exit 0
  log "publishing $head"
  if "$REPO/tools/publish-release.sh" >> "$LOG" 2>&1; then log "published $head"; else log "publish of $head failed"; exit 1; fi
done
