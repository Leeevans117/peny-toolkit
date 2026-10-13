#!/bin/bash
# Peny Toolkit installer. "Install Peny Toolkit.command" runs this; so does update.sh
# (with --update). Everything goes into the user's own folders: no admin password,
# no Homebrew, no GitHub. Safe to run again: it only replaces the toolkit's own files.
#
#   install-toolkit.sh                  full install
#   install-toolkit.sh --update         panel + tools only, no model downloads (update.sh)
#   install-toolkit.sh --no-models      skip the Whisper / Ollama models (about 20 GB)
#   install-toolkit.sh --home DIR       test run: install under DIR as if it were the home
#                                       folder; macOS settings and launchd are not touched
#   install-toolkit.sh --nas-updates    turn on NAS updates even on a developer Mac
#   install-toolkit.sh --panel-from-release   on a developer Mac, install this release's
#                                       panel instead of leaving the developer copy
#                                       (or PENY_PANEL_FROM_RELEASE=1, e.g. through update.sh)
#
# Where things go (HOME = the user's home folder):
#   panel     HOME/Library/Application Support/Adobe/CEP/extensions/com.peny.toolkit
#   tools     HOME/Library/Application Support/PenyToolkit/{bin,lib,python,ollama}
#   updater   HOME/Library/Application Support/PenyToolkit/update.sh (+ update.conf),
#             launchd agent com.peny.toolkit.nas-update (every hour and at log-in)
#   models    HOME/PenyToolkit-scratch/whisper-models, HOME/.ollama/models
#   presets   HOME/PenyToolkit-scratch/colour/Peny LUT Presets.prfpset
#   settings  HOME/.peny-toolkit/colour-baseline.json (only if missing)
set -u
P="$(cd "$(dirname "$0")" && pwd)"
UPDATE=0; MODELS=1; SANDBOX=""; NAS_UPDATES=0; PANEL_FROM_RELEASE="${PENY_PANEL_FROM_RELEASE:-0}"
while [ $# -gt 0 ]; do
  case "$1" in
    --update) UPDATE=1; MODELS=0 ;;
    --no-models) MODELS=0 ;;
    --home) SANDBOX="$2"; shift ;;
    --nas-updates) NAS_UPDATES=1 ;;
    --panel-from-release) PANEL_FROM_RELEASE=1 ;;
    -h|--help) sed -n '2,30p' "$0" | grep '^#'; exit 0 ;;
    *) echo "Unknown option $1"; exit 1 ;;
  esac
  shift
done
if [ -n "$SANDBOX" ]; then
  mkdir -p "$SANDBOX" && export HOME="$(cd "$SANDBOX" && pwd)"
  export PENY_HOOK="${PENY_HOOK:-$HOME/peny-hook}"
fi

SUPPORT="$HOME/Library/Application Support/PenyToolkit"
CEP_DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/com.peny.toolkit"
SCRATCH="$HOME/PenyToolkit-scratch"
MODEL_DIR="$SCRATCH/whisper-models"
DEVREPO="$HOME/PenyToolkit/com.peny.toolkit"
LOG="$HOME/Library/Logs/PenyToolkit-install.log"
VERSION="$(plutil -extract version raw -o - "$P/VERSION.json" 2>/dev/null || echo unknown)"
LABEL=com.peny.toolkit.nas-update
mkdir -p "$(dirname "$LOG")" "$SUPPORT"
exec > >(tee -a "$LOG") 2>&1
echo "=== $(date '+%Y-%m-%d %H:%M:%S') Peny Toolkit $VERSION installer${SANDBOX:+ (test run in $HOME)}"

DONE=(); TODO=()
done_() { DONE+=("$1"); echo "   ok: $1"; }
todo() { TODO+=("$1"); echo "   STILL TO DO: $1"; }
step() { echo; echo "$1"; }

DEV=0; [ -d "$DEVREPO/.git" ] && DEV=1

# Files from a download or a zip carry Apple's quarantine flag, which stops the tools
# from running. Clearing it on our own files needs no password.
unquarantine() { xattr -dr com.apple.quarantine "$@" 2>/dev/null || true; }
unquarantine "$P"

# Clone on the same disk (instant), plain copy otherwise.
copy() { cp -c "$1" "$2" 2>/dev/null || cp "$1" "$2"; }

# --- 1. Programs ---------------------------------------------------------------
step "Step 1: Programs the toolkit uses (ffmpeg, Whisper, Ollama, Python)"
if [ "$(uname -m)" != arm64 ]; then
  todo "This Mac is not Apple Silicon; the bundled programs only run on M1 or newer."
else
  ok=1
  for d in bin lib python ollama; do
    mkdir -p "$SUPPORT/$d"
    rsync -a --delete "$P/tools/$d/" "$SUPPORT/$d/" || ok=0
  done
  rsync -a --delete "$P/tools/LICENSES/" "$SUPPORT/LICENSES/" 2>/dev/null
  unquarantine "$SUPPORT"
  T="$SUPPORT/bin"
  if [ $ok = 1 ] && "$T/ffmpeg" -hide_banner -version >/dev/null 2>&1 && "$T/ffprobe" -version >/dev/null 2>&1 \
     && "$T/whisper-cli" --help >/dev/null 2>&1 && "$T/python3" -c "import numpy" 2>/dev/null \
     && "$T/ollama" --version >/dev/null 2>&1; then
    done_ "programs in $T (each one started and checked)"
  else
    todo "programs in $T did not all start - see $LOG"
  fi
fi

# --- 2. The panel ----------------------------------------------------------------
step "Step 2: The Peny Toolkit panel for Premiere Pro"
if [ $DEV = 1 ] && [ $PANEL_FROM_RELEASE = 0 ]; then
  done_ "developer Mac: the panel comes from $DEVREPO (its install.sh), left as it is"
else
  mkdir -p "$(dirname "$CEP_DEST")"
  out="$("$P/panel/install.sh" 2>&1)"; code=$?
  case $code in
    0) done_ "panel installed and the open panel reloaded ($out)" ;;
    2) done_ "panel installed; the open panel reloads when its current job finishes ($out)" ;;
    3) done_ "panel installed in $CEP_DEST" ;;
    *) todo "panel install failed: $out" ;;
  esac
fi

if [ $UPDATE = 0 ]; then
  # --- 3. Premiere setting -------------------------------------------------------
  step "Step 3: Let Premiere load the panel"
  # The panel is not signed by Adobe, so CEP must run in debug mode. Premiere 2022-2026
  # use CSXS 11 and 12; 13 is set too so the next version works straight away.
  if [ -n "$SANDBOX" ]; then
    done_ "test run: would set PlayerDebugMode 1 for com.adobe.CSXS.11, 12 and 13"
  else
    for v in 11 12 13; do defaults write com.adobe.CSXS.$v PlayerDebugMode 1; done
    if [ "$(defaults read com.adobe.CSXS.12 PlayerDebugMode 2>/dev/null)" = 1 ]; then
      done_ "Premiere allowed to load the panel (PlayerDebugMode, CSXS 11-13)"
    else todo "could not set PlayerDebugMode"; fi
  fi

  # --- 4. Saved settings and LUT presets -----------------------------------------
  step "Step 4: Colour settings and LUT presets"
  if [ -f "$HOME/.peny-toolkit/colour-baseline.json" ]; then done_ "camera LUT choices kept ($HOME/.peny-toolkit/colour-baseline.json)"
  else
    mkdir -p "$HOME/.peny-toolkit" && cp "$P/panel/presets/settings/colour-baseline.json" "$HOME/.peny-toolkit/" \
      && done_ "Peny camera LUT choices copied to $HOME/.peny-toolkit/colour-baseline.json"
  fi
  LUTS="$SCRATCH/colour/Peny LUT Presets.prfpset"
  if [ -f "$P/presets/Peny LUT Presets.prfpset" ]; then
    mkdir -p "$SCRATCH/colour"
    if cmp -s "$P/presets/Peny LUT Presets.prfpset" "$LUTS"; then done_ "LUT presets file already in $LUTS"
    else copy "$P/presets/Peny LUT Presets.prfpset" "$LUTS" && done_ "LUT presets file copied to $LUTS"; fi
    if grep -l -s -F "<Name>Peny LUTs</Name>" "$HOME/Documents/Adobe/Premiere Pro/"*/Profile-*/"Effect Presets and Custom Items.prfpset" >/dev/null; then
      done_ "LUT presets already imported into Premiere (Effects panel > Presets > Peny LUTs)"
    else
      todo "Import the LUT presets once: in Premiere open the Effects panel, click its menu (the three lines next to the word Effects), choose Import Presets..., press Cmd+Shift+G, paste  $LUTS  and click Open."
    fi
  else
    todo "LUT presets were not in this installer; ask Lee for Peny LUT Presets.prfpset"
  fi

  # --- 5. Models -------------------------------------------------------------------
  step "Step 5: AI models for the Interviews app (Whisper and Ollama)"
  NAS_MODELS=""
  for d in "${PENY_MODELS:-/Volumes/ampdata/Peny/Claude/PenyToolkit/models}" "$P/../../models"; do
    [ -d "$d" ] && { NAS_MODELS="$(cd "$d" && pwd)"; break; }
  done
  [ -n "$NAS_MODELS" ] && echo "   using the copies in $NAS_MODELS where they are there"
  fetch_whisper() { # file url size
    local f="$MODEL_DIR/$1"
    if [ "$(stat -f %z "$f" 2>/dev/null)" = "$3" ]; then done_ "Whisper model $1"; return; fi
    if [ $MODELS = 0 ]; then todo "Whisper model $1 (run the installer again without --no-models)"; return; fi
    mkdir -p "$MODEL_DIR"
    if [ -n "$NAS_MODELS" ] && [ "$(stat -f %z "$NAS_MODELS/whisper/$1" 2>/dev/null)" = "$3" ]; then
      echo "   copying $1 ($(( $3 / 1048576 )) MB) from the office server"
      copy "$NAS_MODELS/whisper/$1" "$f.part" && mv "$f.part" "$f" && { done_ "Whisper model $1 (copied)"; return; }
    fi
    echo "   downloading $1 ($(( $3 / 1048576 )) MB) from huggingface.co"
    curl -fL# --retry 3 -C - -o "$f.part" "$2" && [ "$(stat -f %z "$f.part")" = "$3" ] && mv "$f.part" "$f" \
      && done_ "Whisper model $1 (downloaded)" || todo "Whisper model $1: download failed, run the installer again to resume"
  }
  fetch_whisper ggml-large-v3-turbo.bin "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin" 1624555275
  fetch_whisper ggml-silero-v5.1.2.bin "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin" 885098

  OLLAMA_MODEL="$(sed -n 's/^var MODEL = "\(.*\)";.*/\1/p' "$P/panel/skills/interview-selects/pipeline.js")"
  OM="${OLLAMA_MODELS:-$HOME/.ollama/models}"
  REL="manifests/registry.ollama.ai/library/${OLLAMA_MODEL%%:*}/${OLLAMA_MODEL#*:}"
  if [ -f "$OM/$REL" ]; then done_ "Ollama model $OLLAMA_MODEL"
  elif [ $MODELS = 0 ]; then todo "Ollama model $OLLAMA_MODEL (about 20 GB; run the installer again without --no-models)"
  elif [ -n "$NAS_MODELS" ] && [ -f "$NAS_MODELS/ollama/$REL" ]; then
    echo "   copying $OLLAMA_MODEL (about 20 GB) from the office server - this takes a while"
    ok=1
    for blob in $("$SUPPORT/bin/python3" -c "import json,sys; m=json.load(open(sys.argv[1])); print(' '.join(l['digest'].replace(':','-') for l in [m['config']]+m['layers']))" "$NAS_MODELS/ollama/$REL"); do
      mkdir -p "$OM/blobs"
      [ "$(stat -f %z "$OM/blobs/$blob" 2>/dev/null)" = "$(stat -f %z "$NAS_MODELS/ollama/blobs/$blob" 2>/dev/null)" ] && continue
      copy "$NAS_MODELS/ollama/blobs/$blob" "$OM/blobs/$blob.part" && mv "$OM/blobs/$blob.part" "$OM/blobs/$blob" || ok=0
    done
    if [ $ok = 1 ]; then mkdir -p "$(dirname "$OM/$REL")" && cp "$NAS_MODELS/ollama/$REL" "$OM/$REL" && done_ "Ollama model $OLLAMA_MODEL (copied)"
    else todo "Ollama model $OLLAMA_MODEL: copy from $NAS_MODELS failed, run the installer again"; fi
  else
    OL="$SUPPORT/bin/ollama"; started=""
    if ! curl -s -m 2 http://127.0.0.1:11434/api/version >/dev/null; then
      "$OL" serve >/dev/null 2>&1 & started=$!
      for _ in $(seq 1 20); do sleep 1; curl -s -m 1 http://127.0.0.1:11434/api/version >/dev/null && break; done
    fi
    echo "   downloading $OLLAMA_MODEL (about 20 GB) from ollama.com - this takes a while"
    "$OL" pull "$OLLAMA_MODEL" && done_ "Ollama model $OLLAMA_MODEL (downloaded)" \
      || todo "Ollama model $OLLAMA_MODEL: download failed, run the installer again"
    [ -n "$started" ] && kill "$started" 2>/dev/null
  fi
fi

# --- 6. Automatic updates ----------------------------------------------------------
step "Step 6: Automatic updates from the office server"
cp "$P/update.sh" "$SUPPORT/update.sh.new" && chmod +x "$SUPPORT/update.sh.new" && mv "$SUPPORT/update.sh.new" "$SUPPORT/update.sh"
[ -f "$SUPPORT/update.conf" ] || cp "$P/update.conf.default" "$SUPPORT/update.conf"
cp "$P/VERSION.json" "$SUPPORT/installed.json"
if [ $UPDATE = 1 ]; then
  done_ "version $VERSION recorded"
elif [ $DEV = 1 ] && [ $NAS_UPDATES = 0 ]; then
  done_ "developer Mac: updates come from git (auto-update.sh); NAS updates not turned on"
else
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$SUPPORT/update.sh</string></array>
  <key>StartInterval</key><integer>3600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/PenyToolkit-update.log</string>
</dict>
</plist>
PL
  if [ -n "$SANDBOX" ]; then done_ "test run: updater written to $PLIST (not started)"
  else
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
    launchctl bootstrap "gui/$(id -u)" "$PLIST" && done_ "checks $(sed -n 's/^PENY_RELEASES="\(.*\)"$/\1/p' "$SUPPORT/update.conf") every hour for a newer version" \
      || todo "could not start the hourly updater (launchctl)"
  fi
fi

# --- Things only a person can do -------------------------------------------------------
if [ $UPDATE = 0 ]; then
  step "Checking what still needs you"
  if ls -d /Applications/Adobe\ Premiere\ Pro* >/dev/null 2>&1; then done_ "Adobe Premiere Pro is installed"
  else todo "Install Adobe Premiere Pro from the Creative Cloud app."; fi
  if [ -x "/Applications/REDCINE-X Professional/REDCINE-X PRO.app/Contents/MacOS/REDline" ] || [ -x /usr/local/bin/REDline ]; then
    done_ "REDline (RED camera files) is installed"
  else
    todo "Only for RED (.R3D) footage: install REDCINE-X PRO from https://www.red.com/download (RED's licence does not allow us to include it). Everything else works without it."
  fi
fi

echo
echo "================================================================"
echo " Peny Toolkit $VERSION"
echo "================================================================"
echo " Installed:"
for x in "${DONE[@]}"; do echo "   - $x"; done
if [ ${#TODO[@]} -gt 0 ]; then
  echo
  echo " Still needs you:"
  for x in "${TODO[@]}"; do echo "   - $x"; done
fi
if [ $UPDATE = 0 ]; then
  echo
  echo " Then open Premiere Pro and choose Window > Extensions > Peny Toolkit."
  echo " (If it is not in the list, quit Premiere and open it again.)"
fi
echo " Log: $LOG"
[ ${#TODO[@]} = 0 ]
