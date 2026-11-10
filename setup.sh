#!/bin/bash
# Sets up the Peny Toolkit on a Mac: tools, models, Premiere settings, the CEP panel.
# Safe to run again: anything already there is left alone (nothing is upgraded or
# overwritten). Run it from the checkout:
#
#   ~/PenyToolkit/com.peny.toolkit/setup.sh            everything
#   ~/PenyToolkit/com.peny.toolkit/setup.sh --check    only report what is missing
#   ~/PenyToolkit/com.peny.toolkit/setup.sh --no-models   skip the big downloads
#
# Not installed by this script: Adobe Premiere Pro, and REDline (RED's
# REDCINE-X PRO, from https://www.red.com/download). Proxies and Colour use REDline
# for R3D files.
set -u
SRC="$(cd "$(dirname "$0")" && pwd)"
CHECK=0; MODELS=1
for a in "$@"; do
  case "$a" in
    --check) CHECK=1 ;;
    --no-models) MODELS=0 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "Unknown option $a"; exit 1 ;;
  esac
done

# Paths the skills look in (see skills/*/panel.js).
MODEL_DIR="$HOME/PenyToolkit-scratch/whisper-models"
WHISPER_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin"
WHISPER_SIZE=1624555275
VAD_URL="https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin"
VAD_SIZE=885098
OLLAMA_MODEL="$(sed -n 's/^var MODEL = "\(.*\)";.*/\1/p' "$SRC/skills/interview-selects/pipeline.js")"
SETTINGS_DIR="$HOME/.peny-toolkit"

export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_UPGRADE=1
missing=0
ok()   { printf '  ok       %s\n' "$1"; }
todo() { printf '  MISSING  %s\n' "$1"; missing=$((missing + 1)); }
step() { printf '\n%s\n' "$1"; }

# --- Homebrew --------------------------------------------------------------
step "Homebrew"
BREW="$(command -v brew || ls /opt/homebrew/bin/brew /usr/local/bin/brew 2>/dev/null | head -1)"
if [ -z "$BREW" ]; then
  todo "Homebrew - install it first (needs your password), then run this again:"
  echo '           /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
  exit 1
fi
ok "$BREW"
BREW_BIN="$(dirname "$BREW")"

# --- Command-line tools ----------------------------------------------------
# formula : file it provides
step "Tools (Homebrew)"
# python@3.14 is checked by its own path: Homebrew links plain python3 only for its
# default Python, which may be a newer one.
PY="$(dirname "$BREW_BIN")/opt/python@3.14/bin/python3.14"
for pair in ffmpeg:ffmpeg whisper-cpp:whisper-cli ollama:ollama python@3.14:python3; do
  f="${pair%%:*}"; bin="${pair#*:}"; path="$BREW_BIN/$bin"; [ "$bin" = python3 ] && path="$PY"
  if [ -x "$path" ]; then ok "$bin"
  elif [ $CHECK = 1 ]; then todo "$bin (brew install $f)"
  else echo "  installing $f"; "$BREW" install "$f" >/dev/null && ok "$bin" || todo "$bin (brew install $f failed)"; fi
done

if "$PY" -c "import numpy" 2>/dev/null; then ok "numpy (for $PY)"
elif [ $CHECK = 1 ]; then todo "numpy (brew install numpy)"
else echo "  installing numpy"; "$BREW" install numpy >/dev/null && ok "numpy" || todo "numpy (brew install numpy failed)"; fi

# --- REDline (by hand) -------------------------------------------------------
step "REDline (install by hand)"
if [ -x "/Applications/REDCINE-X Professional/REDCINE-X PRO.app/Contents/MacOS/REDline" ] || [ -x /usr/local/bin/REDline ]; then ok "REDline"
else todo "REDline - install REDCINE-X PRO from https://www.red.com/download (only needed for R3D files)"; fi

# --- Models ------------------------------------------------------------------
download() { # url size dest
  local have; have=$(stat -L -f %z "$3" 2>/dev/null || echo 0)
  if [ "$have" = "$2" ]; then ok "$(basename "$3")"; return; fi
  if [ $CHECK = 1 ] || [ $MODELS = 0 ]; then todo "$(basename "$3") in $(dirname "$3")"; return; fi
  echo "  downloading $(basename "$3") ($(( $2 / 1048576 )) MB)"
  mkdir -p "$(dirname "$3")"
  curl -fL# --retry 3 -C - -o "$3.part" "$1" && [ "$(stat -f %z "$3.part")" = "$2" ] && mv "$3.part" "$3" \
    && ok "$(basename "$3")" || todo "$(basename "$3") (download failed; run again to resume)"
}
step "Whisper models (Interviews)"
download "$WHISPER_URL" $WHISPER_SIZE "$MODEL_DIR/ggml-large-v3-turbo.bin"
download "$VAD_URL" $VAD_SIZE "$MODEL_DIR/ggml-silero-v5.1.2.bin"

step "Ollama model (Interviews)"
manifest="$HOME/.ollama/models/manifests/registry.ollama.ai/library/${OLLAMA_MODEL%%:*}/${OLLAMA_MODEL#*:}"
if [ -f "$manifest" ]; then ok "$OLLAMA_MODEL"
elif [ $CHECK = 1 ] || [ $MODELS = 0 ] || [ ! -x "$BREW_BIN/ollama" ]; then todo "$OLLAMA_MODEL (ollama pull $OLLAMA_MODEL, about 20 GB)"
else
  started=""
  if ! curl -s -m 2 http://127.0.0.1:11434/api/version >/dev/null; then
    "$BREW_BIN/ollama" serve >/dev/null 2>&1 & started=$!
    for _ in $(seq 1 20); do sleep 1; curl -s -m 1 http://127.0.0.1:11434/api/version >/dev/null && break; done
  fi
  echo "  pulling $OLLAMA_MODEL (about 20 GB)"
  "$BREW_BIN/ollama" pull "$OLLAMA_MODEL" && ok "$OLLAMA_MODEL" || todo "$OLLAMA_MODEL (ollama pull failed)"
  [ -n "$started" ] && kill "$started" 2>/dev/null
fi

# --- Saved settings ---------------------------------------------------------
step "Saved settings"
if [ -f "$SETTINGS_DIR/colour-baseline.json" ]; then ok "colour-baseline.json (kept as is)"
elif [ $CHECK = 1 ]; then todo "$SETTINGS_DIR/colour-baseline.json"
else mkdir -p "$SETTINGS_DIR" && cp "$SRC/presets/settings/colour-baseline.json" "$SETTINGS_DIR/" && ok "colour-baseline.json (Lee's camera -> LUT choices)"; fi

# --- Premiere: allow unsigned panels ----------------------------------------
# The panel is not signed, so CEP must run in debug mode (CSXS 11 and 12 cover
# Premiere 2022 onwards).
step "Premiere: allow unsigned panels"
for v in 11 12; do
  if [ "$(defaults read com.adobe.CSXS.$v PlayerDebugMode 2>/dev/null)" = "1" ]; then ok "CSXS.$v PlayerDebugMode"
  elif [ $CHECK = 1 ]; then todo "CSXS.$v PlayerDebugMode (defaults write com.adobe.CSXS.$v PlayerDebugMode 1)"
  else defaults write com.adobe.CSXS.$v PlayerDebugMode 1 && ok "CSXS.$v PlayerDebugMode (set)"; fi
done

# --- LUT presets -------------------------------------------------------------
step "LUT presets (Colour)"
LUTS="$HOME/PenyToolkit-scratch/colour/Peny LUT Presets.prfpset"
GH="$(command -v gh || ls "$BREW_BIN/gh" 2>/dev/null)"
if [ -f "$LUTS" ]; then ok "Peny LUT Presets.prfpset"
elif [ $CHECK = 0 ] && [ -n "$GH" ] && mkdir -p "$(dirname "$LUTS")" \
  && "$GH" release download presets -R Leeevans117/peny-toolkit -p "Peny.LUT.Presets.prfpset" -O "$LUTS" 2>/dev/null; then
  ok "Peny LUT Presets.prfpset (downloaded to $(dirname "$LUTS"))"
  echo "           In Premiere: Effects panel menu > Import Presets > choose that file (once per Mac)."
else
  todo "Peny LUT Presets.prfpset - from https://github.com/Leeevans117/peny-toolkit/releases/tag/presets"
  echo "           save as $LUTS, then in Premiere: Effects panel menu > Import Presets."
fi

# --- Automatic updates ------------------------------------------------------
# Every commit on main is pushed to GitHub (git hook), and every hour this Mac pulls
# new commits and installs them (launchd agent running auto-update.sh).
step "Automatic updates"
HOOK_FILE="$SRC/.git/hooks/post-commit"
if [ ! -d "$SRC/.git" ]; then todo "not a git checkout - clone the repo to get updates"
elif grep -q "Peny Toolkit: push" "$HOOK_FILE" 2>/dev/null; then ok "push on commit (git hook)"
elif [ -e "$HOOK_FILE" ]; then todo "push on commit: $HOOK_FILE already exists, left alone"
elif [ $CHECK = 1 ]; then todo "push on commit (git hook)"
else
  cat > "$HOOK_FILE" <<'HOOK'
#!/bin/bash
# Peny Toolkit: push every commit on main to GitHub (installed by setup.sh).
[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || exit 0
mkdir -p "$HOME/Library/Logs"
mkdir -p "$HOME/Library/Logs"
( git push -q origin main >> "$HOME/Library/Logs/PenyToolkit-update.log" 2>&1 & )
# Peny Toolkit: publish to the office server for installer Macs (tools/auto-publish.sh).
[ -x tools/auto-publish.sh ] && ( tools/auto-publish.sh >/dev/null 2>&1 & )
HOOK
  chmod +x "$HOOK_FILE" && ok "push on commit (git hook installed)"
fi

LABEL=com.peny.toolkit.update
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
WANT="$(cat <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$SRC/auto-update.sh</string></array>
  <key>StartInterval</key><integer>3600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/PenyToolkit-update.log</string>
</dict>
</plist>
PL
)"
case "$SRC" in /Volumes/*) ON_SERVER=1 ;; *) ON_SERVER=0 ;; esac
if [ $ON_SERVER = 1 ]; then
  # launchd may not read a network volume (macOS: "Operation not permitted"); on the build
  # machine the open panel runs auto-update.sh hourly instead (tools/become-builder.sh).
  [ $CHECK = 1 ] || { launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null; rm -f "$PLIST"; }
  ok "hourly update: not with launchd (checkout on a server; tools/become-builder.sh hands it to the panel)"
elif [ -f "$PLIST" ] && [ "$(cat "$PLIST")" = "$WANT" ]; then ok "hourly update ($PLIST)"
elif [ $CHECK = 1 ]; then todo "hourly update ($PLIST)"
elif [ "${PENY_NO_LAUNCHD:-0}" = 1 ]; then
  mkdir -p "$(dirname "$PLIST")" && printf '%s\n' "$WANT" > "$PLIST" && ok "hourly update (plist written, not loaded: test mode)"
else
  mkdir -p "$(dirname "$PLIST")" && printf '%s\n' "$WANT" > "$PLIST"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
  launchctl bootstrap "gui/$(id -u)" "$PLIST" && ok "hourly update (loaded)" || todo "hourly update (launchctl bootstrap failed)"
fi

# --- Auto-commit --------------------------------------------------------------
# Commits + pushes changes on main after they have been quiet for 3 minutes, so the
# hourly update is never blocked by uncommitted work. Only for checkouts in the home
# folder: launchd may not read a server volume (same restriction as the hourly update
# above); on a checkout on a server use tools/auto-commit-watcher.sh --once by hand.
if [ -d "$SRC/.git" ] && [ $ON_SERVER = 0 ]; then
  ALABEL=com.peny.toolkit.autocommit
  APLIST="$HOME/Library/LaunchAgents/$ALABEL.plist"
  AWANT="$(cat <<AL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$ALABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$SRC/tools/auto-commit-watcher.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/PenyToolkit-autocommit.log</string>
</dict>
</plist>
AL
)"
  if [ $CHECK = 1 ]; then
    [ -f "$APLIST" ] && launchctl print "gui/$(id -u)/$ALABEL" >/dev/null 2>&1 && ok "auto-commit agent" || todo "auto-commit agent (re-run setup.sh without --check)"
  elif [ -f "$APLIST" ] && [ "$(cat "$APLIST")" = "$AWANT" ] && launchctl print "gui/$(id -u)/$ALABEL" >/dev/null 2>&1; then
    ok "auto-commit (commits main after 3 quiet minutes; tools/auto-commit-watcher.sh --once by hand)"
  elif [ "${PENY_NO_LAUNCHD:-0}" = 1 ]; then
    mkdir -p "$(dirname "$APLIST")" && printf '%s\n' "$AWANT" > "$APLIST" && ok "auto-commit (plist written, not loaded: test mode)"
  else
    mkdir -p "$(dirname "$APLIST")" && printf '%s\n' "$AWANT" > "$APLIST"
    launchctl bootout "gui/$(id -u)/$ALABEL" 2>/dev/null
    launchctl bootstrap "gui/$(id -u)" "$APLIST" && ok "auto-commit agent (loaded)" || todo "auto-commit (launchctl bootstrap failed)"
  fi
fi

# --- The panel ---------------------------------------------------------------
step "Peny Toolkit panel"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/com.peny.toolkit"
if [ $CHECK = 1 ]; then
  [ -f "$DEST/CSXS/manifest.xml" ] && ok "installed in $DEST" || todo "panel ($SRC/install.sh)"
else
  mkdir -p "$(dirname "$DEST")"
  out="$("$SRC/install.sh")"; code=$?
  case $code in 0|2|3) ok "installed: $out" ;; *) todo "panel: $out" ;; esac
fi

echo
if [ $missing = 0 ]; then echo "All set. In Premiere: Window > Extensions > Peny Toolkit."
else echo "$missing thing(s) still to do (see MISSING above)."; fi
[ $missing = 0 ]
