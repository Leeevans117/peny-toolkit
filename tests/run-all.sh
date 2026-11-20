#!/bin/bash
# Runs the whole offline test suite and prints PASS/FAIL per part.
#   tests/run-all.sh            Node + Python + scripts + UI smoke (UI only where Playwright is installed)
#   tests/run-all.sh --coverage also prints Node line coverage (Node 22+)
# Uses only Node's and Python's built-in test runners (no npm or pip packages). Needs
# node, python3 with numpy (the Toolkit's own), and ffmpeg for the media tests (they are
# skipped, and say so, when ffmpeg is missing). Never touches Premiere, footage or projects.
set -u
cd "$(dirname "$0")/.." || exit 1
COV=""; [ "${1:-}" = "--coverage" ] && COV="--experimental-test-coverage"
fail=0
part() { printf '\n== %s\n' "$1"; }

NODE="$(command -v node || ls "$HOME/Library/Application Support/PenyToolkit/bin/node" /opt/homebrew/bin/node 2>/dev/null | head -1)"
PY="$(ls "$HOME/Library/Application Support/PenyToolkit/bin/python3" /opt/homebrew/opt/python@3.14/bin/python3.14 2>/dev/null | head -1)"
[ -z "$PY" ] && PY="$(command -v python3)"

part "Node tests"
if [ -z "$NODE" ]; then echo "FAIL node not found"; fail=1
else
  # shellcheck disable=SC2086
  "$NODE" --test $COV --test-reporter=spec tests/node/*.test.js 2>&1 | tail -${TAIL:-40}
  [ "${PIPESTATUS[0]}" = 0 ] && echo "PASS node" || { echo "FAIL node"; fail=1; }
fi

part "Python tests"
if [ -z "$PY" ] || ! "$PY" -c "import numpy" 2>/dev/null; then echo "FAIL python3 with numpy not found"; fail=1
else
  (cd tests/python && "$PY" -m unittest -v 2>&1 | tail -${TAIL:-25}; exit "${PIPESTATUS[0]}") && echo "PASS python" || { echo "FAIL python"; fail=1; }
fi

part "Pool limits self-check"
"$NODE" tools/pool-limits-test.js && echo "PASS pool limits" || { echo "FAIL pool limits"; fail=1; }

part "Panel UI smoke (headless Chromium)"
"$NODE" tests/ui/smoke.js 2>&1 | tail -12
[ "${PIPESTATUS[0]}" = 0 ] || fail=1

echo
if [ $fail = 0 ]; then echo "ALL TESTS PASS"; else echo "SOME TESTS FAILED"; fi
exit $fail
