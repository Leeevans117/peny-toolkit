# Peny Toolkit: notes for Claude

Lee's Premiere Pro automation panel. Before any Premiere work:

1. Read `docs/working-rules.md` (how to work on Lee's projects).
2. Read `README.md` for how the panel and its skills are built, installed and tested.

## Setting up or updating a Mac (Claude does this, not Lee)

When Lee starts work on a Mac, run the steps in `docs/new-machine.md` under
"For Claude". In short: if `~/PenyToolkit/com.peny.toolkit` is missing, clone it and run
`setup.sh`; if it is there, `git pull` and run `setup.sh` again (it only fills gaps,
never upgrades or overwrites). Then report what `setup.sh` says is still MISSING and
which of those only Lee can do.

After changing code: `./install.sh`, commit, push.
