# Setting up a new Mac

1. Install Adobe Premiere Pro and Homebrew (https://brew.sh).
2. Sign in to GitHub on the Mac (the repo is private), e.g. `brew install gh && gh auth login`.
3. Clone and run setup:

   ```bash
   mkdir -p ~/PenyToolkit && gh repo clone Leeevans117/peny-toolkit ~/PenyToolkit/com.peny.toolkit && ~/PenyToolkit/com.peny.toolkit/setup.sh
   ```

4. Install REDline by hand: REDCINE-X PRO from https://www.red.com/download (only
   needed for R3D proxies and camera detection).
5. LUT presets: download `Peny LUT Presets.prfpset` from the repo's Releases page
   (`gh release download presets -R Leeevans117/peny-toolkit -D ~/PenyToolkit-scratch/colour`),
   then in Premiere: Effects panel menu > Import Presets.
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
