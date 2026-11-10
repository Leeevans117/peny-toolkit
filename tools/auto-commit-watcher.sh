#!/bin/bash
# Peny Toolkit: commits local changes so nothing is left hanging and the hourly
# update (auto-update.sh) is never blocked by "uncommitted changes".
#
# Runs as the launchd agent com.peny.toolkit.autocommit (installed by setup.sh on
# developer Macs), or by hand:
#
#   tools/auto-commit-watcher.sh --once    commit + push now (whatever is there), then exit
#   tools/auto-commit-watcher.sh           loop: after the files have been quiet for
#                                          3 minutes, commit + push
#
# Rules: only the main branch; never touches a checkout with merge conflicts; only
# commits after the changed files have been quiet for PENY_AUTOCOMMIT_IDLE seconds
# (default 180) so it does not save half-finished edits; untracked files are
# included (the .gitignore still applies). A push that is refused (the other Mac
# committed first) waits for the next cycle or the hourly auto-update, which does
# the same pull --ff-only + push. Log: ~/Library/Logs/PenyToolkit-autocommit.log
set -u

MODE=loop
[ "${1:-}" = "--once" ] && MODE=once

REPO="${PENY_REPO:-$HOME/PenyToolkit/com.peny.toolkit}"
IDLE="${PENY_AUTOCOMMIT_IDLE:-180}"
POLL="${PENY_AUTOCOMMIT_POLL:-30}"
[ "$MODE" = once ] && IDLE=0
LOG="$HOME/Library/Logs/PenyToolkit-autocommit.log"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
mkdir -p "$(dirname "$LOG")"
log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG"; }

if [ "$MODE" = loop ]; then
  # One watcher at a time.
  LOCKDIR="$HOME/.peny-toolkit/autocommit.lock"
  mkdir "$LOCKDIR" 2>/dev/null || exit 0
  trap 'rmdir "$LOCKDIR" 2>/dev/null' EXIT
  trap 'rmdir "$LOCKDIR" 2>/dev/null; exit 0' INT TERM
fi

# commit_once: commit + push if there are changes quiet for $IDLE seconds.
# Exit 0: committed (or nothing to do in --once mode). Exit 1: not yet (still editing).
commit_once() {
  [ -d "$REPO/.git" ] || return 1
  cd "$REPO" || return 1
  [ "$(git rev-parse --abbrev-ref HEAD)" = main ] || return 1
  if [ -n "$(git ls-files -u 2>/dev/null | head -1)" ]; then
    log "merge conflicts present - not committing (needs a merge by hand)"
    return 1
  fi
  status="$(git status --porcelain)"
  [ -n "$status" ] || return 1

  # Newer of all changed/added files (deleted files have no mtime; git add -A
  # covers them, so the quiet test only needs the files that exist).
  newest=0
  while IFS= read -r line; do
    f="${line:3}"
    [ -f "$REPO/$f" ] || continue
    m="$(stat -f %m "$REPO/$f" 2>/dev/null || echo 0)"
    [ "$m" -gt "$newest" ] && newest=$m
  done <<EOF
$status
EOF
  if [ $(( $(date +%s) - newest )) -lt "$IDLE" ]; then return 1; fi

  count="$(printf '%s\n' "$status" | wc -l | tr -d ' ')"
  git add -A
  git commit -q -m "Auto-commit: $count local change(s) on $(hostname -s) ($(date '+%d %b %Y %H:%M'))" \
    || { log "git commit failed"; return 1; }
  log "auto-committed $count file(s) -> $(git rev-parse --short HEAD)"
  if git push -q origin main 2>>"$LOG"; then
    log "pushed to GitHub"
  elif git pull -q --ff-only origin main 2>>"$LOG" && git push -q origin main 2>>"$LOG"; then
    log "other Mac committed first - pulled, then pushed"
  else
    log "push refused and not fast-forwardable - next cycle or the hourly update will retry (may need a merge by hand)"
  fi
  return 0
}

if [ "$MODE" = once ]; then
  commit_once
  [ $? -eq 0 ] || exit 2
  exit 0
fi

log "watcher started (repo=$REPO, idle=${IDLE}s, poll=${POLL}s)"
while :; do
  commit_once
  sleep "$POLL"
done
