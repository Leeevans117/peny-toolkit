#!/bin/bash
# Keeps this Mac's toolkit in step with GitHub. Run every hour by the launchd agent
# com.peny.toolkit.update (installed by setup.sh), and safe to run by hand.
# - Pushes local commits that have not reached GitHub yet.
# - Pulls new commits (fast-forward only) and runs install.sh, which soft-reloads the
#   open panel (or waits until the running action finishes).
# Never touches a checkout with uncommitted changes or one on another branch.
set -u
REPO="$(cd "$(dirname "$0")" && pwd)"
LOG="$HOME/Library/Logs/PenyToolkit-update.log"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
mkdir -p "$(dirname "$LOG")"
log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG"; }
cd "$REPO" || exit 1
# Publish main to the office server for installer Macs if it is not there yet (does
# nothing when the server is not connected).
[ -x "$REPO/tools/auto-publish.sh" ] && "$REPO/tools/auto-publish.sh"

branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = main ] || { log "skip: on branch $branch"; exit 0; }
[ -z "$(git status --porcelain --untracked-files=no)" ] || { log "skip: uncommitted changes"; exit 0; }
git fetch -q origin main 2>>"$LOG" || { log "fetch failed (offline?)"; exit 1; }

ahead=$(git rev-list --count origin/main..HEAD)
behind=$(git rev-list --count HEAD..origin/main)
if [ "$behind" -gt 0 ]; then
  if git merge -q --ff-only origin/main 2>>"$LOG"; then
    log "pulled $behind commit(s) to $(git rev-parse --short HEAD); install: $("$REPO/install.sh" 2>&1 | tail -1)"
    [ -x "$REPO/tools/auto-publish.sh" ] && "$REPO/tools/auto-publish.sh"
  else
    log "cannot fast-forward (both Macs changed the toolkit): needs a merge by hand"; exit 1
  fi
fi
if [ "$ahead" -gt 0 ] && [ "$behind" = 0 ]; then
  git push -q origin main 2>>"$LOG" && log "pushed $ahead commit(s)" || log "push failed"
fi
exit 0
