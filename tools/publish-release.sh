#!/bin/bash
# Builds the installer and puts it on the office server for other Macs (run on the
# Mac that has the toolkit source, e.g. Data's Mac mini):
#
#   tools/publish-release.sh             build + publish
#   tools/publish-release.sh --models    also copy the Whisper and Ollama models
#                                        (about 20 GB, only needed once) so new Macs
#                                        copy them over the network instead of the internet
#
# PENY_SHARE (default /Volumes/ampdata/Peny/Claude/PenyToolkit) gets:
#   Peny Toolkit Installer/     unzipped installer: people double-click
#                               "Install Peny Toolkit.command" in it
#   Peny Toolkit Installer.zip  the same as one file (to copy elsewhere)
#   releases/version.json + releases/Peny-Toolkit-<version>.zip   read by update.sh on
#                               every installed Mac (the 3 newest zips are kept)
#   models/                     with --models
# Nothing is uploaded anywhere else.
set -eu
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SHARE="${PENY_SHARE:-/Volumes/ampdata/Peny/Claude/PenyToolkit}"
BUILD_DIR="${PENY_BUILD_DIR:-$HOME/PenyToolkit-scratch/installer-build}"
MODELS=0
for a in "$@"; do case "$a" in --models) MODELS=1 ;; *) echo "Unknown option $a"; exit 1 ;; esac; done

[ -d "$(dirname "$SHARE")" ] || { echo "$(dirname "$SHARE") is not there - connect the office server (Finder > Go > Connect to Server) and try again."; exit 1; }
PENY_RELEASES="${PENY_RELEASES:-$SHARE/releases}" "$REPO/tools/build-installer.sh" "$BUILD_DIR"

ZIP="$(plutil -extract zip raw -o - "$BUILD_DIR/version.json")"
VERSION="$(plutil -extract version raw -o - "$BUILD_DIR/version.json")"
mkdir -p "$SHARE/releases"
echo "Copying to $SHARE"
cp "$BUILD_DIR/$ZIP" "$SHARE/releases/$ZIP.part" && mv "$SHARE/releases/$ZIP.part" "$SHARE/releases/$ZIP"
# version.json last, so a Mac never sees a version whose zip is not complete yet.
cp "$BUILD_DIR/version.json" "$SHARE/releases/version.json.part" && mv "$SHARE/releases/version.json.part" "$SHARE/releases/version.json"
ls -t "$SHARE/releases/"Peny-Toolkit-*.zip | tail -n +4 | while read -r old; do rm -f "$old"; done

cp "$BUILD_DIR/$ZIP" "$SHARE/Peny Toolkit Installer.zip.part" && mv "$SHARE/Peny Toolkit Installer.zip.part" "$SHARE/Peny Toolkit Installer.zip"
rm -rf "$SHARE/Peny Toolkit Installer.new"
mkdir "$SHARE/Peny Toolkit Installer.new"
ditto -x -k "$BUILD_DIR/$ZIP" "$SHARE/Peny Toolkit Installer.new"
rm -rf "$SHARE/Peny Toolkit Installer.old"
[ -d "$SHARE/Peny Toolkit Installer" ] && mv "$SHARE/Peny Toolkit Installer" "$SHARE/Peny Toolkit Installer.old"
mv "$SHARE/Peny Toolkit Installer.new/Peny Toolkit Installer" "$SHARE/Peny Toolkit Installer"
rm -rf "$SHARE/Peny Toolkit Installer.new" "$SHARE/Peny Toolkit Installer.old"

if [ $MODELS = 1 ]; then
  echo "Copying models (only what is missing or different)"
  mkdir -p "$SHARE/models/whisper"
  for f in ggml-large-v3-turbo.bin ggml-silero-v5.1.2.bin; do
    rsync -a --progress "$HOME/PenyToolkit-scratch/whisper-models/$f" "$SHARE/models/whisper/"
  done
  M="$(sed -n 's/^var MODEL = "\(.*\)";.*/\1/p' "$REPO/skills/interview-selects/pipeline.js")"
  REL="manifests/registry.ollama.ai/library/${M%%:*}/${M#*:}"
  OM="$HOME/.ollama/models"
  mkdir -p "$SHARE/models/ollama/blobs" "$(dirname "$SHARE/models/ollama/$REL")"
  for blob in $(grep -o 'sha256:[0-9a-f]*' "$OM/$REL" | sort -u | tr : -); do
    rsync -a --progress "$OM/blobs/$blob" "$SHARE/models/ollama/blobs/"
  done
  cp "$OM/$REL" "$SHARE/models/ollama/$REL"
fi
echo "Published $VERSION:"
echo "  $SHARE/Peny Toolkit Installer/Install Peny Toolkit.command"
echo "  $SHARE/releases/version.json -> $ZIP"
