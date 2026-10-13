#!/bin/bash
# Peny Toolkit updater for Macs set up with the one-click installer (no git, no GitHub).
# The launchd agent com.peny.toolkit.nas-update runs it every hour and at log-in; safe to
# run by hand:
#   "$HOME/Library/Application Support/PenyToolkit/update.sh"
#
# Looks in the release location set in update.conf next to this file:
#   PENY_RELEASES="/Volumes/ampdata/Peny/Claude/PenyToolkit/releases"   (a folder), or
#   PENY_RELEASES="https://example.com/peny-toolkit"                     (a web address)
# which holds version.json + the zip it names (tools/publish-release.sh puts them there).
# If its build number is newer than the installed one (installed.json), the zip is
# checked (sha256), unpacked and its installer runs with --update: tools and panel are
# replaced and the open panel soft-reloads (or waits until its current job ends).
# When the folder is missing (NAS not mounted) or the site cannot be reached it logs one
# line and stops; nothing is shown on screen.
set -u
SUPPORT="$(cd "$(dirname "$0")" && pwd)"
LOG="$HOME/Library/Logs/PenyToolkit-update.log"
export PATH="/usr/bin:/bin:/usr/sbin:/sbin"
mkdir -p "$(dirname "$LOG")"
log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG"; }

PENY_RELEASES=""
[ -f "$SUPPORT/update.conf" ] && . "$SUPPORT/update.conf"
R="${PENY_RELEASES_OVERRIDE:-$PENY_RELEASES}"
[ -n "$R" ] || { log "no release location in $SUPPORT/update.conf"; exit 0; }

# One run at a time (a lock older than 3 hours is from a run that died).
LOCK="$SUPPORT/.update-lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  [ -n "$(find "$LOCK" -maxdepth 0 -mmin +180 2>/dev/null)" ] && rm -rf "$LOCK" && mkdir "$LOCK" 2>/dev/null \
    || { log "another update is running - skipped"; exit 0; }
fi
TMP="$(mktemp -d "${TMPDIR:-/tmp}/peny-update.XXXXXX")"
trap 'rm -rf "$TMP" "$LOCK"' EXIT

get() { # name -> $TMP/name
  case "$R" in
    http://*|https://*) curl -fsS -m 600 -o "$TMP/$1" "$R/$1" ;;
    *) cp "$R/$1" "$TMP/$1" ;;
  esac
}
case "$R" in
  http://*|https://*) get version.json 2>/dev/null || { log "release site $R not reachable - skipped"; exit 0; } ;;
  *) [ -f "$R/version.json" ] || { log "release folder $R not reachable (office server not connected?) - skipped"; exit 0; }
     get version.json || { log "could not read $R/version.json"; exit 1; } ;;
esac

field() { plutil -extract "$1" raw -o - "$2" 2>/dev/null; }
NEW_BUILD="$(field build "$TMP/version.json")"; NEW_VERSION="$(field version "$TMP/version.json")"
ZIP="$(field zip "$TMP/version.json")"; SHA="$(field sha256 "$TMP/version.json")"
HAVE_BUILD="$(field build "$SUPPORT/installed.json")"; HAVE_BUILD="${HAVE_BUILD:-0}"
case "$NEW_BUILD$HAVE_BUILD" in *[!0-9]*|"") log "unreadable version.json in $R"; exit 1 ;; esac
if [ "$NEW_BUILD" -le "$HAVE_BUILD" ]; then
  log "up to date ($(field version "$SUPPORT/installed.json"))"; exit 0
fi

log "installing $NEW_VERSION from $R"
get "$ZIP" || { log "could not copy $R/$ZIP"; exit 1; }
[ "$(shasum -a 256 "$TMP/$ZIP" | cut -d' ' -f1)" = "$SHA" ] || { log "$ZIP is damaged (checksum differs) - not installed"; exit 1; }
ditto -x -k "$TMP/$ZIP" "$TMP/x" || { log "could not unzip $ZIP"; exit 1; }
INSTALLER="$(find "$TMP/x" -maxdepth 3 -path '*/payload/install-toolkit.sh' | head -1)"
[ -n "$INSTALLER" ] || { log "$ZIP has no payload/install-toolkit.sh"; exit 1; }
out="$(/bin/bash "$INSTALLER" --update 2>&1)"; code=$?
printf '%s\n' "$out" | sed 's/^/    /' >> "$LOG"
if [ $code = 0 ]; then log "installed $NEW_VERSION"
else log "update to $NEW_VERSION had problems (see above)"; exit 1; fi
