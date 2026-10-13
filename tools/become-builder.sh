#!/bin/bash
# Makes this Mac THE build machine: the one Mac that publishes the toolkit to the office
# server (/Volumes/ampdata/Peny/Claude/PenyToolkit) for every installer Mac. Run it from
# a git checkout at $HOME/PenyToolkit/com.peny.toolkit:
#
#   tools/become-builder.sh          turn on (safe to run again)
#   tools/become-builder.sh --off    stop publishing from this Mac
#
# Turning on:
#   - marks this Mac as the publisher ($HOME/.peny-toolkit/publisher); tools/auto-publish.sh
#     does nothing on any Mac without it, so only one Mac ever publishes
#   - post-commit hook: push main to GitHub, then publish (tools/auto-publish.sh)
#   - launchd agent com.peny.toolkit.update (auto-update.sh, every hour + at log-in): pulls
#     GitHub, installs, and publishes what is not on the server yet
# Only one Mac should be the build machine: run --off on the old one.
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
MARK="$HOME/.peny-toolkit/publisher"
HOOK="$(git -C "$REPO" rev-parse --git-common-dir)/hooks/post-commit"
case "$HOOK" in /*) ;; *) HOOK="$REPO/$HOOK" ;; esac
LABEL=com.peny.toolkit.update
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ "${1:-}" = --off ]; then
  rm -f "$MARK" && echo "This Mac no longer publishes (removed $MARK)."
  exit 0
fi

git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || { echo "$REPO is not a git checkout."; exit 1; }
mkdir -p "$(dirname "$MARK")"
printf 'build machine since %s (%s)\n' "$(date '+%Y-%m-%d %H:%M')" "$(scutil --get ComputerName 2>/dev/null)" > "$MARK"
echo "ok  publisher mark: $MARK"

mkdir -p "$(dirname "$HOOK")"
if ! grep -q "Peny Toolkit: push" "$HOOK" 2>/dev/null; then
  [ -e "$HOOK" ] && { echo "STOP $HOOK exists and is not the toolkit's; add the lines from setup.sh by hand."; exit 1; }
  cat > "$HOOK" <<'H'
#!/bin/bash
# Peny Toolkit: push every commit on main to GitHub (installed by setup.sh).
[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || exit 0
mkdir -p "$HOME/Library/Logs"
( git push -q origin main >> "$HOME/Library/Logs/PenyToolkit-update.log" 2>&1 & )
H
fi
if ! grep -q "auto-publish.sh" "$HOOK"; then
  printf '%s\n' '# Peny Toolkit: publish to the office server for installer Macs (tools/auto-publish.sh).' \
    '[ -x tools/auto-publish.sh ] && ( tools/auto-publish.sh >/dev/null 2>&1 & )' >> "$HOOK"
fi
chmod +x "$HOOK" && echo "ok  post-commit hook (push + publish): $HOOK"

WANT="$(cat <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$REPO/auto-update.sh</string></array>
  <key>StartInterval</key><integer>3600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/PenyToolkit-update.log</string>
</dict>
</plist>
PL
)"
if [ -f "$PLIST" ] && [ "$(cat "$PLIST")" = "$WANT" ]; then echo "ok  hourly agent $PLIST"
else
  mkdir -p "$(dirname "$PLIST")" && printf '%s\n' "$WANT" > "$PLIST"
  if [ "${PENY_NO_LAUNCHD:-0}" = 1 ]; then echo "ok  hourly agent written (not loaded: test mode)"
  else launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
       launchctl bootstrap "gui/$(id -u)" "$PLIST" && echo "ok  hourly agent loaded" || echo "MISSING hourly agent (launchctl failed)"; fi
fi

if [ -d /Volumes/ampdata ]; then echo "ok  office server connected"
else echo "NOTE office server not connected: publishing starts when /Volumes/ampdata is there"; fi
echo
echo "First publish (with the ~20 GB of models, once):"
echo "  \"$REPO/tools/publish-release.sh\" --models"
