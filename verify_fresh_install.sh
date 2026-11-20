#!/bin/bash
# Fresh-install check. Installs the Toolkit from scratch into a throw-away home folder,
# following only README.md / docs/new-machine.md, then runs the whole offline test suite
# against that install and prints PASS or FAIL for each part and overall.
#
#   ./verify_fresh_install.sh                     panel (install.sh) + test suite
#   ./verify_fresh_install.sh --installer DIR     also run the one-click installer from DIR
#                                                 (the "Peny Toolkit Installer" folder, e.g.
#                                                 /Volumes/ampdata/Peny/Claude/PenyToolkit/Peny Toolkit Installer)
#   ./verify_fresh_install.sh --keep              keep the throw-away home folder afterwards
#
# Never touches the real home folder, Premiere, projects, footage, launchd or macOS
# settings: everything goes under a new folder in /tmp whose name has a space and an
# accent in it (real Mac paths often do). No admin password, no downloads (--no-models).
# Exit 0 only when every part that can run here passed.
set -u
SRC="$(cd "$(dirname "$0")" && pwd)"
INSTALLER=""; KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --installer) INSTALLER="${2:-}"; shift ;;
    --keep) KEEP=1 ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option $1 (try --help)"; exit 2 ;;
  esac
  shift
done

SB="$(mktemp -d "/tmp/peny fresh é.XXXXXX")" || { echo "FAIL could not make a temp folder"; exit 1; }
[ $KEEP = 1 ] || trap 'rm -rf "$SB"' EXIT
REAL_HOME="$HOME"
export HOME="$SB" PENY_HOOK="$SB/hook"
pass=0; fail=0; skip=0
ok()   { echo "PASS $1"; pass=$((pass + 1)); }
bad()  { echo "FAIL $1"; fail=$((fail + 1)); }
skp()  { echo "SKIP $1"; skip=$((skip + 1)); }
part() { printf '\n== %s\n' "$1"; }
MAC=0; [ "$(uname -s)" = Darwin ] && MAC=1

part "Machine"
echo "   $(uname -sm), throw-away home: $SB"
for t in git node python3 ffmpeg rsync; do
  p="$(command -v $t || true)"; echo "   $t: ${p:-missing}"
done
command -v git >/dev/null || { bad "git is needed to make the fresh copy"; exit 1; }
v="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$v" -ge 22 ] && ok "node $v (tests need 22+)" || bad "node 22 or newer not found (got: ${v}); Homebrew: brew install node"

part "Fresh copy of the code (git clone of the committed tree, nothing uncommitted)"
if git clone -q "$SRC" "$SB/src/com.peny.toolkit" 2>&1; then
  R="$SB/src/com.peny.toolkit"; ok "cloned $(git -C "$R" rev-parse --short HEAD) ($(git -C "$R" ls-files | wc -l | tr -d ' ') files)"
else bad "git clone of $SRC failed"; exit 1; fi
[ -n "$(git -C "$SRC" status --porcelain)" ] && echo "   note: $SRC has uncommitted changes; they are NOT in this check"

part "Panel install (README: ./install.sh)"
D="$SB/Library/Application Support/Adobe/CEP/extensions/com.peny.toolkit"
if ! command -v rsync >/dev/null; then
  if [ $MAC = 1 ]; then bad "rsync missing (macOS ships it at /usr/bin/rsync)"; else skp "install.sh (needs rsync; macOS has it)"; fi
else
  out="$("$R/install.sh" 2>&1)"; rc=$?
  echo "   install.sh said: $out (exit $rc)"
  # No panel is open in the throw-away home, so NO PANEL (exit 3) is the right answer.
  if [ $rc = 3 ] && [ -f "$D/CSXS/manifest.xml" ] && [ -f "$D/main.js" ] && [ -f "$D/core/core.jsx" ]; then ok "panel copied into CEP extensions"
  else bad "install.sh did not install the panel (exit $rc)"; fi
  n=$(ls -d "$D"/skills/*/ 2>/dev/null | wc -l | tr -d ' '); m=$(ls -d "$R"/skills/*/ | wc -l | tr -d ' ')
  [ "$n" = "$m" ] && ok "all $m skills installed" || bad "$n of $m skills installed"
  leaked=""; for x in tests docs installer tools setup.sh QA_REPORT.md QA_CHECKLIST.md verify_fresh_install.sh .git; do [ -e "$D/$x" ] && leaked="$leaked $x"; done
  [ -z "$leaked" ] && ok "no developer or test files in the install" || bad "developer files copied into the install:$leaked"
  badj="$(node -e 'const fs=require("fs"),p=require("path");let b=[];for(const d of fs.readdirSync(process.argv[1])){try{JSON.parse(fs.readFileSync(p.join(process.argv[1],d,"skill.json"),"utf-8"))}catch(e){b.push(d)}}console.log(b.join(" "))' "$D/skills" 2>&1)"
  [ -z "$badj" ] && ok "every installed skill.json reads" || bad "skill.json missing or unreadable: $badj"
fi

part "One-click installer (docs/new-machine.md: Install Peny Toolkit.command, here as --home test run)"
if [ -z "$INSTALLER" ]; then skp "one-click installer (pass --installer DIR to include it)"
elif [ $MAC = 0 ]; then skp "one-click installer (macOS only)"
elif [ ! -f "$INSTALLER/payload/install-toolkit.sh" ]; then bad "no payload/install-toolkit.sh in $INSTALLER"
else
  "$INSTALLER/payload/install-toolkit.sh" --home "$SB" --no-models > "$SB/installer.txt" 2>&1; rc=$?
  tail -25 "$SB/installer.txt" | sed 's/^/   /'
  [ $rc = 0 ] && ok "installer finished (exit 0)" || bad "installer exit $rc (full output: $SB/installer.txt, use --keep)"
  B="$SB/Library/Application Support/PenyToolkit"
  for t in ffmpeg ffprobe whisper-cli; do
    "$B/bin/$t" -version >/dev/null 2>&1 || "$B/bin/$t" --help >/dev/null 2>&1 && ok "bundled $t runs" || bad "bundled $t does not run ($B/bin/$t)"
  done
  "$B/python/bin/python3" -c "import numpy" 2>/dev/null && ok "bundled python3 + numpy" || bad "bundled python3 cannot import numpy"
  [ -f "$D/CSXS/manifest.xml" ] && ok "installer put the panel in CEP" || bad "installer did not install the panel"
fi

part "Full offline test suite (tests/run-all.sh) from the fresh copy"
TAIL=8 "$R/tests/run-all.sh" > "$SB/run-all.txt" 2>&1; rc=$?
grep -E '^(== |PASS|FAIL|SKIP|ALL TESTS|SOME TESTS|# (tests|pass|fail|skipped)|Ran |OK|FAILED)' "$SB/run-all.txt" | sed 's/^/   /'
[ $rc = 0 ] && ok "tests/run-all.sh" || { bad "tests/run-all.sh (exit $rc; full output kept in $SB/run-all.txt with --keep)"; tail -40 "$SB/run-all.txt"; }

export HOME="$REAL_HOME"
echo
echo "$pass passed, $fail failed, $skip skipped"
if [ $fail = 0 ]; then echo "PASS fresh install"; exit 0; else echo "FAIL fresh install"; exit 1; fi
