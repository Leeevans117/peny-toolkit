#!/bin/bash
# Installs the panel into CEP and soft-reloads the open panel (see loader.js).
# Prints one line: OK / DEFERRED (busy) / ERROR / NO PANEL. Exit 0 only on OK.
set -u
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/com.peny.toolkit/"
HOOK="${PENY_HOOK:-/tmp/peny-toolkit}"
WAIT=60

rsync -a --delete --exclude .git --exclude .gitignore --exclude __pycache__ --exclude /setup.sh --exclude /docs --exclude /presets "$SRC/" "$DEST" || { echo "ERROR rsync failed"; exit 1; }

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
  out=$(/usr/bin/python3 - "$HOOK/reloaded.json" "$STAMP" <<'PY'
import json, sys
try: r = json.load(open(sys.argv[1]))
except Exception: sys.exit(0)
if r.get("stamp") != sys.argv[2]: sys.exit(0)
if r.get("ok"): print("OK soft reload %s, %s skills" % (r["stamp"], r.get("skills")))
elif r.get("deferred"): print("DEFERRED (busy: %s)" % r.get("busy"))
else: print("ERROR %s" % r.get("error"))
PY
)
  case "$out" in
    OK*) echo "$out"; exit 0 ;;
    ERROR*) echo "$out"; exit 1 ;;
    DEFERRED*) state="$out" ;;
  esac
done
if [ -n "$state" ]; then echo "$state - reloads by itself when the action finishes"; exit 2; fi
echo "NO PANEL (no reply in ${WAIT} s)"; exit 3
