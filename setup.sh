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
for pair in ffmpeg:ffmpeg whisper-cpp:whisper-cli ollama:ollama python@3.14:python3; do
  f="${pair%%:*}"; bin="${pair#*:}"
  if [ -x "$BREW_BIN/$bin" ]; then ok "$bin"
  elif [ $CHECK = 1 ]; then todo "$bin (brew install $f)"
  else echo "  installing $f"; "$BREW" install "$f" >/dev/null && ok "$bin" || todo "$bin (brew install $f failed)"; fi
done

if "$BREW_BIN/python3" -c "import numpy" 2>/dev/null; then ok "numpy (for $BREW_BIN/python3)"
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
if [ -f "$LUTS" ]; then ok "Peny LUT Presets.prfpset"
else
  todo "Peny LUT Presets.prfpset - too big for git (78 MB). Get it from the repo's Releases page"
  echo "           (or: gh release download presets -R Leeevans117/peny-toolkit -D \"$(dirname "$LUTS")\")"
  echo "           then in Premiere: Effects panel menu > Import Presets."
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
