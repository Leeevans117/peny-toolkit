#!/bin/bash
# Builds "Peny Toolkit Installer": one zip that installs the toolkit on any Apple Silicon
# Mac with one double-click, without GitHub, git or Homebrew.
#
#   tools/build-installer.sh [out dir]      (default ~/PenyToolkit-scratch/installer-build)
#
# Run it on a Mac that has the toolkit set up (setup.sh: Homebrew ffmpeg, whisper-cpp,
# ollama, python 3.14 + numpy). The zip holds:
#   Peny Toolkit Installer/
#     Install Peny Toolkit.command   <- the one file people double-click
#     Read Me.txt
#     payload/panel/                 the committed panel (git archive HEAD: uncommitted
#                                    changes are NOT included)
#     payload/tools/                 ffmpeg, ffprobe, whisper-cli, ollama, python3 + numpy,
#                                    copied from Homebrew with their libraries
#                                    (tools/bundle_macho.py), so no Homebrew is needed
#     payload/presets/Peny LUT Presets.prfpset
#     payload/install-toolkit.sh, update.sh, VERSION.json, update.conf.default
# and next to the zip a version.json for the NAS updater (installer/update.sh).
#
# Release location baked in as the updater's default: PENY_RELEASES (default
# /Volumes/ampdata/Peny/Claude/PenyToolkit/releases; a https:// address works too).
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$HOME/PenyToolkit-scratch/installer-build}"
RELEASES="${PENY_RELEASES:-/Volumes/ampdata/Peny/Claude/PenyToolkit/releases}"
LUTS="${PENY_LUTS:-$HOME/PenyToolkit-scratch/colour/Peny LUT Presets.prfpset}"
BREW=/opt/homebrew
PY=$BREW/bin/python3

say() { printf '%s\n' "$*"; }
[ "$(uname -m)" = arm64 ] || { say "Build on an Apple Silicon Mac."; exit 1; }
# Tools come from Homebrew when it has all of them; otherwise (or with
# PENY_REUSE_TOOLS=1) they are reused from this Mac's installed toolkit
# (~/Library/Application Support/PenyToolkit, put there by the one-click installer), so a
# Mac without Homebrew can build too.
INSTALLED="$HOME/Library/Application Support/PenyToolkit"
REUSE="${PENY_REUSE_TOOLS:-0}"
for t in ffmpeg ffprobe whisper-cli ollama python3; do [ -x "$BREW/bin/$t" ] || REUSE=1; done
[ $REUSE = 1 ] || "$PY" -c "import numpy" 2>/dev/null || REUSE=1
if [ $REUSE = 1 ]; then
  for t in ffmpeg ffprobe whisper-cli ollama python3; do
    [ -x "$INSTALLED/bin/$t" ] || { say "No $t in Homebrew or in $INSTALLED/bin - run the one-click installer (or setup.sh) first."; exit 1; }
  done
  PY="$INSTALLED/bin/python3"
fi

cd "$REPO"
COMMIT="$(git rev-parse --short HEAD)"
BUILD="$(date -u +%Y%m%d%H%M)"
VERSION="$(date -u +%Y.%m.%d.%H%M)"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  say "Note: uncommitted changes are left out (the installer gets commit $COMMIT)."
fi

NAME="Peny Toolkit Installer"
STAGE="$OUT/stage"
ROOT="$STAGE/$NAME"
P="$ROOT/payload"
rm -rf "$STAGE"; mkdir -p "$P/panel" "$P/tools" "$P/presets"

say "1/5 Panel (commit $COMMIT)"
git archive HEAD | tar -x -C "$P/panel"

if [ $REUSE = 1 ]; then
say "2/5 Tools (reused from $INSTALLED)"
for d in bin lib python ollama LICENSES; do
  rsync -a --exclude __pycache__ "$INSTALLED/$d/" "$P/tools/$d/"
done
else
say "2/5 Tools (copying Homebrew programs and their libraries)"
PYFW="$(cd "$BREW/opt/python@3.14/Frameworks/Python.framework/Versions/3.14" && pwd -P)"
PYSITE="$("$PY" -c "import numpy, os; print(os.path.dirname(os.path.dirname(numpy.__file__)))")"
GGML_LIB="$(readlink -f "$BREW/opt/ggml/lib/libggml.0.dylib")"
# ggml searches its compiled-in Homebrew folder before the program's own folder.
GGML_DIR="$(strings -a "$GGML_LIB" | grep -E '^/opt/homebrew/.*/ggml/.*/libexec$' | head -1)"
[ -n "$GGML_DIR" ] || { say "Could not find ggml's backend folder in $GGML_LIB"; exit 1; }
cat > "$OUT/tools-spec.json" <<JSON
{"lib": "lib",
 "items": [
  {"src": "$BREW/bin/ffmpeg", "dest": "bin/ffmpeg"},
  {"src": "$BREW/bin/ffprobe", "dest": "bin/ffprobe"},
  {"src": "$BREW/bin/whisper-cli", "dest": "bin/whisper-cli"},
  {"src": "$BREW/opt/ggml/libexec", "dest": "bin"},
  {"src": "$BREW/opt/ollama", "dest": "ollama",
   "exclude": ["bin", "mlx_metal_v3", "*.plist", "*.service", "INSTALL_RECEIPT.json", "sbom.spdx.json"]},
  {"src": "$PYFW", "dest": "python/Python.framework/Versions/3.14",
   "exclude": ["test", "idlelib", "tkinter", "turtledemo", "ensurepip", "__pycache__", "_tkinter*.so",
               "sitecustomize.py", "site-packages", "Headers", "include"]},
  {"src": "$PYSITE/numpy", "dest": "python/Python.framework/Versions/3.14/lib/python3.14/site-packages/numpy",
   "exclude": ["__pycache__", "tests"]}
 ],
 "patch": [{"file": "lib/$(basename "$BREW/opt/ggml/lib/libggml.0.dylib")", "from": "$GGML_DIR", "to": "/peny-no-such-folder"}]}
JSON
"$PY" "$REPO/tools/bundle_macho.py" "$OUT/tools-spec.json" "$P/tools"
ln -s ../python/Python.framework/Versions/3.14/bin/python3.14 "$P/tools/bin/python3"
ln -s ../ollama/libexec/ollama "$P/tools/bin/ollama"
mkdir -p "$P/tools/LICENSES"
cp "$BREW/opt/ffmpeg/LICENSE.md" "$P/tools/LICENSES/ffmpeg-LICENSE.md"
cp "$BREW/opt/ffmpeg/COPYING.GPLv3" "$P/tools/LICENSES/ffmpeg-COPYING.GPLv3"
cp "$BREW/opt/whisper-cpp/LICENSE" "$P/tools/LICENSES/whisper.cpp-LICENSE" 2>/dev/null || cp "$BREW/opt/whisper.cpp/LICENSE" "$P/tools/LICENSES/whisper.cpp-LICENSE"
cp "$BREW/opt/ggml/LICENSE" "$P/tools/LICENSES/ggml-LICENSE"
cp "$BREW/opt/ollama/LICENSE" "$P/tools/LICENSES/ollama-LICENSE"
cp "$PYFW/lib/python3.14/LICENSE.txt" "$P/tools/LICENSES/python-LICENSE.txt"
cp "$PYSITE/numpy-"*.dist-info/LICENSE.txt "$P/tools/LICENSES/numpy-LICENSE.txt" 2>/dev/null || true
cat > "$P/tools/LICENSES/README.txt" <<TXT
Programs in this folder are unchanged copies of Homebrew builds (ffmpeg, whisper.cpp/ggml,
ollama, Python 3.14, numpy), with library paths rewritten so they run without Homebrew.
Licences: ffmpeg GPL v3 (this build enables x264/x265), whisper.cpp/ggml MIT, ollama MIT,
Python PSF, numpy BSD. Source: https://formulae.brew.sh (ffmpeg, whisper-cpp, ollama, python@3.14).
TXT

fi

say "   checking the copied tools run"
T="$P/tools/bin"
"$T/ffmpeg" -hide_banner -version | head -1
"$T/ffprobe" -hide_banner -version | head -1
"$T/whisper-cli" --help >/dev/null 2>&1 || { say "whisper-cli does not run"; exit 1; }
"$T/python3" -c "import numpy, sys; print('python', sys.version.split()[0], 'numpy', numpy.__version__)"
"$T/ollama" --version 2>/dev/null | tail -1

say "3/5 LUT presets"
if [ -f "$LUTS" ]; then cp "$LUTS" "$P/presets/Peny LUT Presets.prfpset"
else say "   WARNING: $LUTS not found - the installer will not include the LUT presets"; fi

say "4/5 Installer scripts"
cp "$REPO/installer/Install Peny Toolkit.command" "$ROOT/"
cp "$REPO/installer/Read Me.txt" "$ROOT/"
cp "$REPO/installer/install-toolkit.sh" "$REPO/installer/update.sh" "$P/"
chmod +x "$ROOT/Install Peny Toolkit.command" "$P/install-toolkit.sh" "$P/update.sh"
printf 'PENY_RELEASES="%s"\n' "$RELEASES" > "$P/update.conf.default"
cat > "$P/VERSION.json" <<JSON
{"version": "$VERSION", "build": $BUILD, "commit": "$COMMIT", "built": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
JSON

say "5/5 Zip"
ZIP="Peny-Toolkit-$VERSION.zip"
rm -f "$OUT/$ZIP"
ditto -c -k --keepParent "$ROOT" "$OUT/$ZIP"
SHA="$(shasum -a 256 "$OUT/$ZIP" | cut -d' ' -f1)"
SIZE="$(stat -f %z "$OUT/$ZIP")"
cat > "$OUT/version.json" <<JSON
{"version": "$VERSION", "build": $BUILD, "commit": "$COMMIT", "zip": "$ZIP", "sha256": "$SHA", "size": $SIZE}
JSON
say "Built $OUT/$ZIP ($(( SIZE / 1048576 )) MB), version $VERSION, commit $COMMIT"
