# Peny Toolkit: notes for Claude

Lee's Premiere Pro automation panel. Before any Premiere work:

1. Read `docs/working-rules.md` (how to work on Lee's projects).
2. Read `README.md` for how the panel and its skills are built, installed and tested.
3. Only when changing or debugging a skill: read that skill's section in `docs/skills.md`
   (not the whole file). In big files (`main.js`, `premiere.jsx`, `panel.js`) read the
   functions you need, not the whole file.

## Setting up or updating a Mac (Claude does this, not Lee)

A Mac that only uses the toolkit (no GitHub login needed): run the one-click installer
from the office server, see "One-click install" in `docs/new-machine.md`. Publishing a
new installer: the build machine does it on every commit, see `docs/build-machine.md`.

On a developer Mac (git checkout):

When Lee starts work on a Mac, run the steps in `docs/new-machine.md` under
"For Claude". In short: if `~/PenyToolkit/com.peny.toolkit` is missing, clone it and run
`setup.sh`; if it is there, `git pull` and run `setup.sh` again (it only fills gaps,
never upgrades or overwrites). Then report what `setup.sh` says is still MISSING and
which of those only Lee can do.

After changing code: `./install.sh`, then commit on `main` (the git hook pushes it; the
other Mac installs it within the hour). Never leave work uncommitted: the hourly update
skips a checkout with uncommitted changes.
