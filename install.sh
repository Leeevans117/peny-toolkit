#!/bin/bash
# Installs the panel into CEP and soft-reloads the open panel (see loader.js).
# Prints one line: OK / DEFERRED (busy) / ERROR / NO PANEL. Exit 0 only on OK.
set -u
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/com.peny.toolkit/"
HOOK="${PENY_HOOK:-/tmp/peny-toolkit}"
WAIT=60

rsync -a --delete --exclude .git --exclude .gitignore --exclude __pycache__ --exclude /setup.sh --exclude /auto-update.sh --exclude /CLAUDE.md --exclude /docs --exclude /presets --exclude /installer --exclude /tools "$SRC/" "$DEST" || { echo "ERROR rsync failed"; exit 1; }

mkdir -p "$HOOK"
# loader.js touches loader-alive every second; nothing in the last 5 s means no panel
# is open (the new copy loads when it is opened).
alive=$(stat -f %m "$HOOK/loader-alive" 2>/dev/null || echo 0)
if [ $(( $(date +%s) - alive )) -gt 5 ]; then
  echo "NO PANEL (installed; open Window > Extensions > Peny Toolkit)"; exit 3
fi

STAMP="$(date +%Y%m%d-%H%M%S)-$$"
printf '%s\n' "$STAMP" > "$HOOK/reload-stamp.tmp" && mv "$HOOK/reload-stamp.tmp" "$HOOK/reload-stamp"

state=""
for _ in $(seq 1 $WAIT); do
  sleep 1
  [ -f "$HOOK/reloaded.json" ] || continue
  # plutil reads JSON and ships with macOS (/usr/bin/python3 can be a stub that asks to
  # install the developer tools on a new Mac).
  get() { plutil -extract "$1" raw -o - "$HOOK/reloaded.json" 2>/dev/null || plutil -extract "$1" json -o - "$HOOK/reloaded.json" 2>/dev/null; }
  out=""
  if [ "$(get stamp)" = "$STAMP" ]; then
    if [ "$(get ok)" = true ]; then out="OK soft reload $STAMP, $(get skills) skills"
    elif [ "$(get deferred)" = true ]; then out="DEFERRED (busy: $(get busy))"
    else out="ERROR $(get error)"; fi
  fi
  case "$out" in
    OK*) echo "$out"; exit 0 ;;
    ERROR*) echo "$out"; exit 1 ;;
    DEFERRED*) state="$out" ;;
  esac
done
if [ -n "$state" ]; then echo "$state - reloads by itself when the action finishes"; exit 2; fi
echo "NO PANEL (no reply in ${WAIT} s)"; exit 3
