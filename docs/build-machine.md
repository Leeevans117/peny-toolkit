# The build machine

One Mac builds the installer and publishes it to the office server
(`/Volumes/ampdata/Peny/Claude/PenyToolkit`). Every installer Mac checks there every 5
minutes and installs anything newer. Only the Mac marked as the build machine publishes
(`~/.peny-toolkit/publisher`), so there is never more than one publisher.

From 13 Oct 2026 the build machine is **Lee's Mac Studio** (user `penypeople`, always on
the office server). Data's Mac mini is not on the server and does not publish.
On the Mac Studio the checkout is on the server, at
`/Volumes/ampdata/Peny/Claude/peny-toolkit` (Lee's choice), not `$HOME/PenyToolkit`; so the
one-click installer treats it as an ordinary installer Mac (panel from the release, 5-minute
updater on).

macOS refuses launchd jobs that read `/Volumes/ampdata` ("Operation not permitted", seen
13 Oct 2026 on macOS 26.6) unless `/bin/bash` gets Full Disk Access, which Lee does not
want. So the updates run from the open Peny Toolkit panel instead (`core/updater.js`;
programs it starts run as part of Premiere, which reads the server): the 5-minute release
check on every Mac and, on the build machine, the hourly `auto-update.sh` (the checkout
is named by `repo=` in `~/.peny-toolkit/publisher`). Commits made in a terminal publish
straight away (the post-commit hook runs as the user).

## Make this Mac the build machine

Steps marked **Lee** need Lee at the Mac; Claude does the rest. Use full paths.

1. Install the toolkit with the one-click installer first (`docs/new-machine.md`). It
   puts the programs the build packs into `$HOME/Library/Application Support/PenyToolkit`,
   the LUT presets into `$HOME/PenyToolkit-scratch/colour/` and the models into
   `$HOME/PenyToolkit-scratch/whisper-models` and `$HOME/.ollama/models`, so no Homebrew
   is needed to build.
2. git: `git --version`. If macOS offers to install the Command Line Developer Tools,
   **Lee** clicks Install (unverified whether it asks for a password).
3. GitHub sign-in (the repo is private), once. If `gh` is missing, Homebrew can install it
   (`/opt/homebrew/bin/brew install gh`); then **Lee** runs in Terminal:
   `/opt/homebrew/bin/gh auth login --hostname github.com --git-protocol https --web`
   (sign in as Leeevans117), then `/opt/homebrew/bin/gh auth setup-git`.
4. Get the source:
   `mkdir -p "$HOME/PenyToolkit" && git clone https://github.com/Leeevans117/peny-toolkit.git "$HOME/PenyToolkit/com.peny.toolkit"`
   (or `git -C "$HOME/PenyToolkit/com.peny.toolkit" pull` if it is already there).
5. Turn it on: `"$HOME/PenyToolkit/com.peny.toolkit/tools/become-builder.sh"`. It writes
   the publisher mark, the post-commit hook (push to GitHub, then publish) and the
   hourly `auto-update.sh` (pull GitHub, install, publish anything not on the server yet):
   a launchd agent `com.peny.toolkit.update` for a checkout in the home folder, the open
   panel for a checkout on a server.
6. First publish, with the models (about 20 GB, once), with the server connected:
   `"$HOME/PenyToolkit/com.peny.toolkit/tools/publish-release.sh" --models`
7. Check `/Volumes/ampdata/Peny/Claude/PenyToolkit/` now has `Peny Toolkit Installer/`,
   `Peny Toolkit Installer.zip`, `releases/version.json` and `models/`.
8. On the previous build machine: `"$HOME/PenyToolkit/com.peny.toolkit/tools/become-builder.sh" --off`.

With a checkout present the one-click installer treats the Mac as a developer Mac: the
panel then comes from the checkout (`install.sh`); NAS updates stay off unless the
installer is run with `--nas-updates`.

## After that

- Every commit on `main` made on the build machine is pushed and published within about a
  minute (`~/Library/Logs/PenyToolkit-publish.log`). Commits made on another Mac reach
  the build machine through GitHub within the hour and are published then.
- Uncommitted work is never published (the build packs the last commit).
- Server not connected: publishing waits and catches up (one log line).
- The build reuses the installed programs when Homebrew does not have all of ffmpeg,
  whisper-cli, ollama and python3 with numpy (`PENY_REUSE_TOOLS=1` forces it); both give
  identical files (checked 13 Oct 2026).
