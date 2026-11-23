# QA report: Peny Toolkit full pass (20 Nov 2026, branch `qa/full-pass`)

Every number below comes from a run I watched pass. Where something was not run, it says so.

## 1. Results at a glance

| Part | Where it ran | Result |
|---|---|---|
| Node tests (`node --test`, 166 tests) | cloud, Linux x64, Node 22 | 165 pass, 0 fail, 1 skipped (install.sh copy test: no rsync in the cloud; macOS has it) |
| Python tests (`unittest`, 19 tests) | cloud | 19 pass |
| Pool limits self-check | cloud | pass |
| Panel UI smoke (headless Chromium, 9 apps, 47 buttons) | cloud | 9 of 9 apps pass, no page errors |
| Stress runs (`tests/stress/stress.js`, `stress_sync.py`) | cloud, 4 CPUs | all pass (section 4) |
| Fresh install (`verify_fresh_install.sh`) | cloud | PASS (3 passed, 0 failed, 2 skipped: install.sh needs rsync, installer is macOS only) |
| Stress runs | Mac Studio, macOS 26.6.2, arm64, 20 CPUs, Node 26 | all pass (section 4) |
| Full suite from the office-server share | Mac Studio | first run: Python 19/19, pool check pass, Node 157 pass / 2 fail / 3 skipped, both failures from the share, not the Toolkit (see below); re-run after the fixes (5645b4f): Node 159 pass / 0 fail / 3 skipped (a real Ollama holds port 11434), Python 19/19, pool check pass, UI smoke skipped (no Playwright on the Mac), ALL TESTS PASS |
| Fresh install with the one-click installer | Mac Studio | first run FAIL at the clone (share ownership); with that bypassed: panel, 12 skills, bundled ffmpeg/ffprobe/whisper-cli all PASS, full suite from the fresh copy ALL TESTS PASS; re-run after the fixes (5645b4f): PASS fresh install, 13 passed, 0 failed, 0 skipped (panel, 12 skills, no dev files in the install, installer, bundled ffmpeg/ffprobe/whisper-cli/python3+numpy, full suite from the fresh copy) |
| Premiere end to end in my own QA project (`/Volumes/ampdata/Peny/Claude/QA-2026-11-20/premiere-e2e/QA-E2E.prproj`) | Mac Studio, Premiere 27.0.0, installed panel 2026.11.18.1600 (0894e9b) | 10 skills run; 3 failures, all fixed on this branch (bugs 17-19); details in section 2b |

What the Mac Studio run found (all in the test tools, none in the Toolkit; fixed in 5645b4f and re-checked in the cloud on a copy owned by another user with a `._` file added):

- git refuses to read a checkout on the share ("dubious ownership": the share's files belong to uid 1002). The bash -n test, `inventory.js` and `verify_fresh_install.sh` now use a one-command `-c safe.directory`, and the fresh copy is made through a git bundle. No git settings are changed.
- The icon test read the share's macOS `._icon.svg` metadata files as icons. They are now skipped; every real icon is still checked.
- The installer exits 1 while anything is left for a person, and in a `--no-models` test run the models and the LUT import always are. The check now accepts exactly those items and fails on anything else.
- `run-all.sh` and the check looked for the bundled Python at `python/bin/python3`. The installer's launcher, and the one the skills use, is `bin/python3`.
- 3 Interviews tests skip when a real Ollama already holds port 11434 (by design, so they never talk to the real model).

Run it all again with `tests/run-all.sh` (prints `ALL TESTS PASS`) and `./verify_fresh_install.sh`.

## 2. Bugs found and fixed

Each one has a test that failed before the fix and passes after it. No test was weakened,
skipped or deleted.

| # | Severity | Where | Bug | Fix | Commit |
|---|---|---|---|---|---|
| 1 | High | `skills/proxy-automation/red-proxy-finish.sh` | If `<name>_Proxy.mov` already existed, ffmpeg's `-n` refused to overwrite but ffmpeg 6.1 still exits 0, so the script deleted the fresh REDline render and reported success while the old proxy stayed. | Checks for the output first; leaves both files and exits 1 with "already exists; left it alone". | b437e25 |
| 2 | Medium | `core/jobs.js` | A speed limit of 0 or not-a-number started nothing and never finished: the batch hung for ever. | Limits are clamped to at least 1. | 26ec86c |
| 3 | Medium | `skills/import-footage/walkLogic.js` | "Auto-Save" folders were not skipped (the skip list's "auto-save" only matched whole words). | Terms with a space or "-" match anywhere in the folder name. | d9b77d4 |
| 4 | Medium | `core/core.jsx` `T.run` | A skill that returned nothing crashed with a TypeError instead of an error the user can read. | Returns "The <skill> script returned no result (Toolkit bug: please send Lee the log)." | 680ced7 |
| 5 | Low | `core/jobs.js` | Two jobs with the same key: the second silently replaced the first (Proxies dedups, so not reachable today). | `add()` throws "Two jobs have the same key ...". | 26ec86c |
| 6 | Low | `core/core.jsx` `T.fmt` | 59.996 s showed as 0:00:60.00. | Rounds before splitting minutes and seconds. | 680ced7 |
| 7 | Low | `skills/interview-selects/pipeline.js` `tc` | 59.96 s showed as 0:60.0 in the notes. | Rounds first. | d9b77d4 |
| 8 | Low | `skills/interview-selects/fillers.js` | A 0-channel or 0 Hz wav crashed with RangeError. | Readable "Not a 16-bit PCM wav: <file>". | d9b77d4 |
| 9 | Low | `skills/colour-baseline/lutpreset.py` | A bad `LUT_3D_SIZE` line crashed with ValueError. | `LutError("bad LUT_3D_SIZE line: ...")`. | cf682d8 |
| 10 | Low | `skills/colour-baseline/lutpreset.py` | Run with no arguments: IndexError. | Prints its usage. | cf682d8 |
| 11 | Low | `skills/loudness-master/measure.py` | Duration came out 0.1 s short (it used the meter's last block, not the file length). | Prefers the file's own Duration. | cf682d8 |
| 12 | Low | `install.sh`, `.gitattributes` | The new tests and QA files would have been copied into every panel install and installer zip. | Excluded from rsync and `git archive`. | b437e25 |
| 13-16 | Low | `core/core.jsx`, colour-baseline, interview-selects, interview-sync `premiere.jsx` | After 99 copies of one sequence, new copies reused a name. | Name search goes to 10,000. | 43284da |

## 2b. Premiere end to end (Mac Studio, Premiere 27.0.0)

Run through the test hook in a new project made only for this, on test media with known sync
offsets; one line per check with its evidence: `/Volumes/ampdata/Peny/Claude/QA-2026-11-20/premiere-e2e/results.md`
(raw results in `premiere-e2e/hook-results/`). This tested the panel already installed
(0894e9b, main), not this branch. No other project was opened or changed.

| Check | Result |
|---|---|
| Ingest: 4 items into the right bins; same folder again adds no duplicates | PASS |
| Proxies: 3 of 3 rendered (frame counts match), attach verified; missing destination refused; cancel leaves no stray ffmpeg | PASS |
| Selects Setup: scan + build, UNCUT layout and markers read back | PASS |
| Make safe copy: original unchanged (same fingerprint before/after), name clash gets "(2)" | PASS |
| Sync and Link refuse a sequence that is not a TOOLKIT COPY; Link before Sync does nothing and says to sync first | PASS |
| Sync: offsets exact (12.00 s, 57.25 s); pieces placed within 10 ms (Premiere's frame snap) | PASS |
| Sound Pass: keyframes and red check marker read back | PASS |
| Master for YouTube: -14.3 LUFS / -1.1 dBTP (the skill's own measurement; an export was not measured separately) | PASS |
| Two requests back to back: the second waited for the first | PASS |
| Colour: detect found ILME-FX6V and ILCE-7SM3; apply made a GRADED copy with Lumetri on all 3 clips | PASS |
| Link External Audio on Premiere 27.0.0 | FAIL: bug 17 |
| Interviews Find answers | FAIL: bug 18 (crash hid the real error) |
| Interviews question/answer split | not conclusive: the test interviewer was only 12 dB quieter on the same mic (Lee's interviews use his own lav); transcript was word-perfect |
| Close the panel mid-render | not run (closing a CEP panel needs the screen) |

Bugs from this run, fixed on this branch with failing tests first (offline-tested; **not yet
re-run in Premiere**, because that needs this branch installed in the Mac Studio's panel):

| # | Severity | Where | Bug | Fix | Commit |
|---|---|---|---|---|---|
| 17 | High | `skills/link-external-audio/premiere.jsx` | On Premiere 27.0.0 `linkSelection()` does nothing. Link had already unlinked each camera clip from its own sound, so every camera on the copy lost its picture/sound link (the original was untouched). | Tries to put the first clip's link back, stops there, and says which clip, whether it is still unlinked, and that linking must be done by hand on this Premiere version. | 26068a2 |
| 18 | Medium | `skills/interview-selects/panel.js` | A failed marker step crashed with "Cannot read properties of undefined (reading 'replace')", hiding Premiere's own error. | Shows the step's error (or "no reason given"). | 26068a2 |
| 19 | Medium | `skills/proxy-automation/panel.js` | After a cancelled render the half-written proxy stays under its final name (by design, nothing is deleted), and the next render said only "Nothing to render." | Lists those files and says to delete them by hand, then render again. | 26068a2 |

| 20 | Medium | `core/ame.js`, `skills/interview-selects/panel.js` | Interviews' audio render went to a Media Encoder that never picked it up (it predated the Premiere restart); the panel sat at "95% · Estimating time left…" and Cancel answered "the run stops after the current step" while that step was a 4-hour wait. | The Media Encoder wait checks Cancel every second and stops with "Cancelled while waiting for Media Encoder". | c8dc1b1 |
| 21 | Low | `install.sh` | Run from a checkout on the office server, it copied 110 macOS `._` files into the panel. | `._*` and `.DS_Store` are never copied (test passes on the Mac Studio). | 67995cd |

Re-test of 17-19 in Premiere 27.0.0 with this branch (f756c86) installed, 20 Nov, Mac Studio (`premiere-e2e/results.md`, raw results `hook-results/result-rt-*.json`):

- **17 PASS:** Link stopped at FX6_A001C001.MOV with "Premiere's link did nothing on ..."; read back, all 3 camera clips are still linked to their sound.
- **18 PASS:** Find answers made "UNCUT (4) TOOLKIT COPY Cut" and said "Not all markers went on, so nothing was cut. ..." with the real reason ("no footage on the video tracks there" at 2:14 and 2:57, correct: that stretch is audio only); markers read back.
- **19 PASS:** 2 five-minute clips, cancelled after 5 s: both encodes killed, no ffmpeg left, partial files kept. Render again said verbatim: "Nothing rendered: 2 clips have a half-written or broken proxy on disk, so they were not rendered. Delete them by hand, then render again: .../FX6_C003C001_Proxy.mov, .../FX6_C003C002_Proxy.mov." (It still returns ok:true.)
- **21 PASS:** `scripts.test.js` 6/6 on the Mac Studio, including the `._` test.
- **20 PASS** (round 2, with c8dc1b1 installed): Media Encoder quit first to force a real wait; Find queued its audio at 14:32:04.0, Cancel was pressed at 14:32:04.4, and the run stopped at 14:32:05.0 with "Cancelled." (Media Encoder only finished at 14:32:10; no Cut copy made). Left as is: the queued Media Encoder job still runs and writes its wav into the work folder, and Cancel's own reply still says "the run stops after the current step".
- `install.sh` from the office server share: 0 `._` files copied.
- Panel restored afterwards: content hash matches the backup, installed.json 2026.11.18.1600 / 0894e9b, no `._` files.

Also seen in the re-test: while the 4-hour wait was stuck, the active sequence switched by itself to the empty "_Selects"; the panel log printed "failed: Camera 1 Scene - undefined"; with a fresh Media Encoder the same audio render took about 7 s.

Seen, not changed (each would change how the app behaves, so it is Lee's call):

- ~~A cancelled proxy render writes straight to the final `_Proxy.mov` name.~~ Built at Lee's request (23 Nov, cfe9f29): proxies render as `<name>_Proxy-rendering.mov` and are renamed only once complete and frame-checked. Mac Studio, real VideoToolbox renders: `proxy-render-real.test.js` 2/2 PASS, full suite 172 pass / 0 fail / 3 skipped (Ollama port in use).
- Sound Pass and Master for YouTube make their own TOOLKIT COPY when run on an original,
  where Sync and Link refuse. Both are safe; they are just different.
- A queued hook request runs on whichever sequence is active when it starts, not when it was
  sent.
- The GRADED copy's name drops the "(2)" of the sequence it was made from.
- The Media Encoder wait still times out only after 4 hours when nobody cancels; a job that
  Media Encoder never starts is not detected sooner.
- Quitting Premiere from a script: AppleScript could not reach Premiere 27, and a terminate
  signal made it abort while shutting down (no project was open; crash report 09:57).

## 3. Coverage

`QA_CHECKLIST.md` lists all 944 functions with their status (rebuild it with the commands at
the top of `tests/qa/inventory.js`).

- **388 of 944 functions (41%) run offline:** 229 by unit tests, 159 by end-to-end tests
  (measure scripts on generated media, red-proxy-finish on real ffmpeg renders, the panel UI
  in Chromium).
- **Node line coverage of the shared core:** jobs.js 99%, ame.js 100%, steps.js 100%,
  camera.js 94%, shootdate.js 95%, core.jsx 87%, updater.js 78%, walkLogic.js 99%,
  make-safe-copy 91%.
- **Skill `panel.js` / `premiere.jsx`: 17-43% of lines.** What is covered: every action
  loads, every button has code, every action given a failing Premiere returns a readable
  error within 8 s, and every timeline-editing action refuses a sequence that is not a
  TOOLKIT COPY (12 skill/action pairs). What is not: the paths after Premiere answers,
  which need Premiere's own objects (QE DOM, Lumetri, Media Encoder, bins) and real
  ffmpeg/whisper/Ollama/REDline runs. These are covered by the Premiere run (section 5).
- **Shell scripts that install, build or publish** (setup.sh, installer, update.sh,
  auto-update.sh, build/publish tools): syntax-checked (`bash -n`) only offline; they act on a
  Mac's own folders and the office server. `verify_fresh_install.sh --installer` runs the
  installer in a throw-away home on a Mac.
- **Python** line coverage is not measured (the stdlib has no line-coverage tool and I did not
  add the `coverage` package without asking); function coverage comes from `trace`.

## 4. Stress and load (cloud, Linux x64, 4 CPUs, Node 22)

```
PASS JobPool 3,200 jobs x4 | 17263 ms | heap +37.9 MB | 3200 ok, 6400 progress events, slowest progress() 4 ms
PASS ETA with 3,200 queued, 1,000 progress() calls | 842 ms | heap +13.6 MB | 0.81 ms per call, eta 7 h
PASS JobPool pause/resume/cancel race | 858 ms | heap -5.8 MB | 121 ok, 4 killed, 175 not started, 0 lost
PASS 2 pools x 50 runs writing one ETA file | 688 ms | heap -2.0 MB | file still valid JSON, ffmpeg rate 0.0919
PASS walkTree 40,000 RED clips (in-memory tree) | 222 ms | heap -15.8 MB | 40000 clips, 40000 wavs matched
PASS camera+shootdate 5,000 files, cold then cached | 122 ms | heap +3.5 MB | cold 45 ms, cached 30 ms
PASS fillers envelope + tiles, 60 min wav | 4704 ms | heap -5.9 MB | 360000 frames, 720 first-pass clips
PASS ExtendScript helpers: big timeline, big JSON, 200 safe copies | 320 ms | heap +2.7 MB | fingerprint 5,000 clips 4.5 ms, json 10,000 records 33 ms, parseTime x100k 96 ms, 200 unique copy names of 200 copies
PASS StepTask 1,000 runs, one history file | 129 ms | heap +7.0 MB | history still valid
STRESS PASS on linux x64, node v22.23.5, 4 CPUs
PASS sync measure: 1 h wav, 20 clips | 36.5 s | peak memory 310 MB | 20/20 synced, worst error 0.1 ms
```

Mac Studio (macOS 26.6.2, arm64, 20 CPUs, Node 26.5.0):

```
PASS JobPool 3,200 jobs x4 | 6144 ms | heap +18.0 MB | 3200 ok, 6400 progress events, slowest progress() 3 ms
PASS ETA with 3,200 queued, 1,000 progress() calls | 455 ms | heap +0.1 MB | 0.40 ms per call, eta 7 h
PASS JobPool pause/resume/cancel race | 913 ms | heap -16.5 MB | 91 ok, 4 killed, 205 not started, 0 lost
PASS 2 pools x 50 runs writing one ETA file | 190 ms | heap -0.4 MB | file still valid JSON, ffmpeg rate 0.0953
PASS walkTree 40,000 RED clips (in-memory tree) | 116 ms | heap +0.1 MB | 40000 clips, 40000 wavs matched
PASS camera+shootdate 5,000 files, cold then cached | 505 ms | heap +0.1 MB | cold 46 ms, cached 37 ms
PASS fillers envelope + tiles, 60 min wav | 3877 ms | heap -0.8 MB | 360000 frames, 720 first-pass clips
PASS ExtendScript helpers: big timeline, big JSON, 200 safe copies | 5883 ms | heap +0.2 MB | fingerprint 5,000 clips 7.0 ms, json 10,000 records 17 ms, parseTime x100k 70 ms, 200 unique copy names of 200 copies
PASS StepTask 1,000 runs, one history file | 233 ms | heap +0.1 MB | history still valid
STRESS PASS on darwin arm64, node v26.5.0, 20 CPUs
PASS sync measure: 1 h wav, 20 clips | 16.3 s | peak memory 398 MB | 20/20 synced, worst error 0.1 ms
```

All Mac Studio output files: `/Volumes/ampdata/Peny/Claude/QA-2026-11-20/`.

After every run the harness checks that no file handles were left open and no child
processes are still running; the long runs also have a time limit (30 s to 2 min) and every result is checked (counts, valid files). None tripped:
no leaks, slowdowns, stray processes or lost jobs. Cancel also kills the commands' own child
processes (tested in `tests/node/jobs.test.js` with a shell that starts a child).

## 5. What could not be tested offline, and how it is tested

| Not offline | Why | How it is tested |
|---|---|---|
| Skill actions after Premiere answers (import, bins, proxies attach, Lumetri, markers, razor, renders) | need Premiere's own DOM, QE and Media Encoder | Premiere run in my own QA project on the Mac Studio (section 1); Lee's own hand checks for anything that run marks unverified |
| Whisper and Ollama on real interviews | models are 1.6 GB and 20 GB; quality needs a person | Interviews run on the Tod/Arly test set by Lee |
| REDline renders | REDline is RED's licensed Mac app | Proxies on a RED card in a TEST project |
| One-click installer, update.sh, publish | act on the Mac's folders and the office server | `verify_fresh_install.sh --installer ...` on a Mac; a second Mac for Gatekeeper |
| Real panel inside Premiere (CEP, soft reload, docking) | CEP only runs in Adobe apps | Window > Extensions > Peny Toolkit after `./install.sh` |

## 6. Remaining risks, most likely first

1. **Premiere API changes between versions.** It has already happened: Premiere 27.0.0 (now on
   the Mac Studio) no longer links clips from scripts (bug 17). The QE and Lumetri calls are
   undocumented too. The TOOLKIT COPY guard keeps any damage on copies.
2. **Tools found only in three places.** ffmpeg, ffprobe and python are looked for only in the
   bundle, `/opt/homebrew` and `/usr/local`; a Mac with them anywhere else gets "not found".
   ffprobe is taken from ffmpeg's folder.
3. **The auto-commit watcher commits anything left on `main`** after 3 quiet minutes on
   developer Macs, including half-finished work, and the build Mac publishes it.
4. **REDline audio:** RED Raptor sound that is only hiss can still fail Sync (known since
   11 Nov; the timecode fallback is not built).
5. **`install.sh` uses BSD `stat -f`**, so it runs only on macOS (by design).
6. **Long proxy batches:** the "time left" estimate is unverified on very long real batches
   (the 3,200-job stress run checks speed, not accuracy).
