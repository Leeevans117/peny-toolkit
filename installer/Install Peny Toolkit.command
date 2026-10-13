#!/bin/bash
# Double-click this file to install (or repair) the Peny Toolkit for Premiere Pro.
# Everything it needs is in the "payload" folder next to it; nothing comes from GitHub.
DIR="$(cd "$(dirname "$0")" && pwd)"
clear 2>/dev/null
cat <<'TXT'
  Peny Toolkit installer
  ----------------------
  This puts the Peny Toolkit panel into Premiere Pro, with the programs it uses.
  No password is needed. It can take a while the first time (the AI models for the
  Interviews app are about 20 GB). You can keep working while it runs.

TXT
if [ ! -f "$DIR/payload/install-toolkit.sh" ]; then
  echo "The payload folder is missing. Unzip the whole \"Peny Toolkit Installer\" zip and"
  echo "double-click \"Install Peny Toolkit.command\" inside the unzipped folder."
else
  xattr -dr com.apple.quarantine "$DIR" 2>/dev/null
  /bin/bash "$DIR/payload/install-toolkit.sh" "$@"
fi
echo
read -r -p "  Finished. Press Return to close this window. " _
