# Setting up a new Mac

Lee can just tell Claude on the new Mac: "Set up the Peny Toolkit from
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

## Updates

```bash
cd ~/PenyToolkit/com.peny.toolkit && git pull && ./install.sh
```
