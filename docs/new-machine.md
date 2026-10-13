# Setting up a new Mac

## One-click install (any Apple Silicon Mac; no GitHub, git, Homebrew or password)

1. Connect the office server (Finder > Go > Connect to Server) so
   `/Volumes/ampdata` is there.
2. In Finder go to ampdata > Peny > Claude > PenyToolkit > Peny Toolkit Installer
   (`/Volumes/ampdata/Peny/Claude/PenyToolkit/Peny Toolkit Installer/`) and double-click
   **Install Peny Toolkit.command**. A Terminal window shows each step and ends with a
   summary: "Installed" and "Still needs you".
3. Do what "Still needs you" lists (see "What still needs a person" below), then open
   Premiere Pro: Window > Extensions > Peny Toolkit (if it is not listed, quit and reopen
   Premiere).

Without the server: carry a folder made with `publish-release.sh` (see "Publishing",
`PENY_SHARE=<folder>`) on a drive. It holds `Peny Toolkit Installer/` and `models/` side by
side; copy the whole folder to the Mac (or run it from the drive) and double-click
**Install Peny Toolkit.command** inside `Peny Toolkit Installer`. The models are taken from
the `models` folder next to it (then the office server, then the internet).
Running the installer again is safe (it repairs anything missing).

What it installs (all in the user's own folders, so no admin password):

| Thing | Where |
|---|---|
| The panel | `~/Library/Application Support/Adobe/CEP/extensions/com.peny.toolkit/` |
| ffmpeg, ffprobe, whisper-cli, ollama, python3 + numpy (copies of the Homebrew builds with their libraries; the skills use these first, Homebrew's only if they are missing; Homebrew itself is not touched) | `~/Library/Application Support/PenyToolkit/bin` (+ `lib`, `python`, `ollama`) |
| Whisper models, Ollama qwen2.5:32b | `~/PenyToolkit-scratch/whisper-models/`, `~/.ollama/models` - copied from a `models` folder next to the installer folder, else `/Volumes/ampdata/Peny/Claude/PenyToolkit/models`, else downloaded (about 22 GB) |
| Peny LUT Presets.prfpset | `~/PenyToolkit-scratch/colour/` |
| colour-baseline.json (camera -> LUT choices) | `~/.peny-toolkit/` (only if missing) |
| PlayerDebugMode 1 for CSXS 11, 12, 13 | macOS defaults (lets Premiere load the unsigned panel) |
| Hourly updater (launchd `com.peny.toolkit.nas-update`) | `~/Library/Application Support/PenyToolkit/update.sh` + `update.conf` |

Log: `~/Library/Logs/PenyToolkit-install.log`. Options (run
`".../payload/install-toolkit.sh" --help`): `--no-models`, `--home DIR` (test run into a
spare folder), `--nas-updates` / `--panel-from-release` (developer Macs, below).

### What still needs a person

- **Gatekeeper.** Opened from the office server the installer just runs (Finder does not
  mark files copied from a server; unverified until tried on a second Mac). If the zip
  came from a web download, email or AirDrop, macOS 15+ blocks it once: click Done, then
  System Settings > Privacy & Security > Open Anyway next to "Install Peny Toolkit.command",
  and double-click again. Only an Apple Developer ID signature + notarisation (paid Apple
  Developer account) removes this. The installer clears the quarantine flag from its own
  files so the bundled programs run.
- **LUT presets** (Colour app): Premiere keeps user presets in one file it rewrites on quit
  (`~/Documents/Adobe/Premiere Pro/<version>/Profile-<user>/Effect Presets and Custom
  Items.prfpset`, same format as our .prfpset), so the installer does not write into it.
  It checks whether "Peny LUTs" is already imported and, if not, prints the exact steps:
  Effects panel menu > Import Presets... > the full path of `Peny LUT Presets.prfpset`.
- **REDline** (RED .R3D footage only): RED's licence does not allow bundling it. Install
  REDCINE-X PRO from https://www.red.com/download. The installer says if it is missing.
- **Premiere Pro** itself (Creative Cloud), and an Apple Silicon Mac (the bundled
  programs are arm64).

### Updates on installer Macs (live)

Every 5 minutes (and at log-in) `update.sh` reads `PENY_RELEASES` from
`~/Library/Application Support/PenyToolkit/update.conf` (default
`/Volumes/ampdata/Peny/Claude/PenyToolkit/releases`; an `https://` address also works,
for a web link later). If the server is not connected it does nothing (one log line when
that changes). If `version.json` there has a newer build than `installed.json`, it copies
the zip, checks its sha256, and runs the installer with `--update` (tools + panel; the
open panel soft-reloads, or waits until its current job ends). Log:
`~/Library/Logs/PenyToolkit-update.log`. Update now:
`"$HOME/Library/Application Support/PenyToolkit/update.sh"`.

On the Mac mini, every commit on `main` is published automatically: the post-commit hook
(and the hourly `auto-update.sh`, to catch up after the server was disconnected) runs
`tools/auto-publish.sh`, which runs `publish-release.sh` when the commit is not on the
server yet. So a change reaches every connected installer Mac within about 6 minutes
(about 1 minute to build, up to 5 to be picked up). Log:
`~/Library/Logs/PenyToolkit-publish.log`.

### Publishing a release (Data's Mac mini)

Commit first (the installer packs the last commit, never uncommitted changes), connect
the office server, then:

```bash
/Users/penymini1/PenyToolkit/com.peny.toolkit/tools/publish-release.sh            # build + publish
/Users/penymini1/PenyToolkit/com.peny.toolkit/tools/publish-release.sh --models   # first time: also the ~20 GB of models
```

It runs `tools/build-installer.sh` (zip in `~/PenyToolkit-scratch/installer-build/`) and
copies to `/Volumes/ampdata/Peny/Claude/PenyToolkit/`: `Peny Toolkit Installer/`,
`Peny Toolkit Installer.zip`, `releases/version.json` + `releases/Peny-Toolkit-<version>.zip`
(3 newest kept), and with `--models` a `models/` folder. Nothing goes to GitHub.
Installer Macs pick the new version up within the hour.

## Developer Macs (git checkout)

The Macs that change the toolkit keep a git checkout and update through GitHub (below).
The installer can still be run on them: it adds the bundled programs and settings but
leaves the panel and updates to the checkout unless given `--panel-from-release` /
`--nas-updates`.

Lee can tell Claude on such a Mac: "Set up the Peny Toolkit from
github.com/Leeevans117/peny-toolkit". Claude follows "For Claude" below and only stops
for the steps that need Lee (marked **Lee**).

## For Claude

Run these in order. Use full paths (`/opt/homebrew/bin/...`); stop and ask Lee only at
the **Lee** steps.

1. `command -v brew || ls /opt/homebrew/bin/brew` - if missing, **Lee** installs Homebrew
   (needs the Mac password): give the command from https://brew.sh.
2. `/opt/homebrew/bin/brew install gh` if `gh` is missing.
3. `/opt/homebrew/bin/gh auth status` - if not signed in, **Lee** runs
   `/opt/homebrew/bin/gh auth login --hostname github.com --git-protocol https --web`
   in Terminal and signs in as Leeevans117. Then `/opt/homebrew/bin/gh auth setup-git`.
4. If `$HOME/PenyToolkit/com.peny.toolkit` is missing:
   `mkdir -p $HOME/PenyToolkit && /opt/homebrew/bin/gh repo clone Leeevans117/peny-toolkit $HOME/PenyToolkit/com.peny.toolkit`.
   Otherwise `git -C $HOME/PenyToolkit/com.peny.toolkit pull`.
5. `$HOME/PenyToolkit/com.peny.toolkit/setup.sh` (run in the background: the first run
   downloads about 22 GB of models). Safe to repeat.
6. Report the MISSING lines. Only **Lee** can do: REDline (REDCINE-X PRO from
   https://www.red.com/download), Effects panel menu > Import Presets with
   `<home>/PenyToolkit-scratch/colour/Peny LUT Presets.prfpset` (give the full path),
   and opening Window > Extensions > Peny Toolkit (a brand-new panel may need a
   Premiere restart).

## By hand

1. Install Adobe Premiere Pro and Homebrew (https://brew.sh).
2. Sign in to GitHub on the Mac (the repo is private), e.g. `brew install gh && gh auth login`.
3. Clone and run setup:

   ```bash
   mkdir -p ~/PenyToolkit && gh repo clone Leeevans117/peny-toolkit ~/PenyToolkit/com.peny.toolkit && ~/PenyToolkit/com.peny.toolkit/setup.sh
   ```

4. Install REDline by hand: REDCINE-X PRO from https://www.red.com/download (only
   needed for R3D proxies and camera detection).
5. LUT presets: setup.sh downloads `Peny LUT Presets.prfpset` (78 MB, kept on the repo's
   Releases page, too big for git) into `~/PenyToolkit-scratch/colour/`. Import it once in
   Premiere: Effects panel menu > Import Presets.
6. Open Premiere: Window > Extensions > Peny Toolkit.

`setup.sh --check` lists what is missing without installing anything.
`setup.sh --no-models` skips the large downloads (Whisper ~1.6 GB, Ollama
qwen2.5:32b ~20 GB).

## What setup.sh installs

| Thing | Where | Used by |
|---|---|---|
| ffmpeg, whisper-cpp, ollama, python 3.14, numpy | Homebrew | Proxies, Sync, Sound Pass, Interviews |
| ggml-large-v3-turbo.bin, ggml-silero-v5.1.2.bin | `~/PenyToolkit-scratch/whisper-models/` | Interviews |
| qwen2.5:32b | Ollama (`~/.ollama`) | Interviews |
| colour-baseline.json (camera -> LUT choices) | `~/.peny-toolkit/` (only if missing) | Colour |
| PlayerDebugMode 1 for CSXS 11 and 12 | macOS defaults | lets Premiere load the unsigned panel |
| The panel | `~/Library/Application Support/Adobe/CEP/extensions/com.peny.toolkit/` | Premiere |

## Updates on developer Macs (automatic)

setup.sh turns these on:

- **Push on commit**: a git hook pushes every commit on `main` to GitHub.
- **Hourly update**: the launchd agent `com.peny.toolkit.update` runs `auto-update.sh`
  every hour and at log-in. It pulls new commits (fast-forward only) and runs
  `install.sh`, so the open panel soft-reloads (or waits until a running action ends).
  It also pushes any commit the hook could not (offline). It skips a checkout with
  uncommitted changes or on another branch, and stops if both Macs changed the toolkit
  at once (log says "needs a merge by hand").

Log: `~/Library/Logs/PenyToolkit-update.log`. Update now by hand:
`~/PenyToolkit/com.peny.toolkit/auto-update.sh`. Turn the hourly update off:
`launchctl bootout gui/$(id -u)/com.peny.toolkit.update`.
