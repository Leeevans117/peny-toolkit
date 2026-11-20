# QA checklist: every function in the Peny Toolkit

Made by `tests/qa/inventory.js` from the code itself (2026-11-20, branch qa/full-pass). One row per function, grouped by file.
"What it does" is the code's own comment just above the function ("-" where there is none); the file heading says what the file takes in, gives back and touches.

Status: **[x] unit** = an offline test ran it (Node `--test` with V8 coverage, Python `unittest` with `trace`). **[x] e2e** = run end to end by a separate-process, browser or script test (named under the file). **[ ] -** = not run offline; the reason is under the file.

**944 functions; 388 (41%) run by the offline suite: 229 by unit tests, 159 end to end; 556 not run offline.**

## auto-update.sh

Developer Macs, hourly: push, pull --ff-only, install.sh; build Mac also publishes.

Not run offline (1): installer/build/publish machine script: run on a Mac (verify_fresh_install.sh / build machine).

| Status | Function | Line | What it does |
|---|---|---|---|
| [ ] - | `log` | 13 | - |

## core/ame.js

Waits for a Media Encoder render. Takes: job id, output path. Gives: {ok, path, ms} or {ok:false, error}. Touches: polls and deletes /tmp/peny-toolkit/ame/<job>.json.

| Status | Function | Line | What it does |
|---|---|---|---|
| [x] unit | `wait` | 9 | - |

## core/camera.js

Camera model from the footage files. Takes: clips [{path}]. Gives: clip.camera. Touches: reads 6 MB of one file per folder, REDline --printMeta for R3D, a JSON cache.

| Status | Function | Line | What it does |
|---|---|---|---|
| [x] unit | `firstExisting` | 12 | - |
| [x] unit | `extOf` | 13 | - |
| [x] unit | `prettyModel` | 16 | Readable camera names from the model strings the files carry. |
| [x] unit | `redModel` | 33 | - |
| [x] unit | `scanBytes` | 43 | - |
| [x] unit | `fileModel` | 54 | - |
| [x] unit | `readCache` | 70 | - |
| [x] unit | `writeCache` | 71 | - |
| [x] unit | `detect` | 74 | - |

## core/core.jsx

ExtendScript helpers shared by every skill (PenyToolkit.*). Takes: Premiere's app/project/sequence objects. Gives: JSON strings back to the panel ({ok, summary|error, details}). Touches: the active project's sequences (copies only), ~/Library/Logs/PenyToolkit.log, /tmp/peny-toolkit/ame/<job>.json (Media Encoder callbacks).

Not run offline (12): needs Premiere's own objects (QE, Lumetri, encoder, bins) the fake does not model: Premiere run.

| Status | Function | Line | What it does |
|---|---|---|---|
| [x] unit | `T.json` | 19 | ---- JSON out (ES3 has no JSON) ---- |
| [x] unit | `pad` | 41 | ---- File log ---- |
| [ ] - | `T.stamp` | 42 | - |
| [x] unit | `T.log` | 47 | - |
| [x] unit | `T.ok` | 57 | ---- Results ---- |
| [x] unit | `T.fail` | 58 | - |
| [x] unit | `T.sec` | 61 | ---- Time ---- |
| [x] unit | `T.ticks` | 62 | - |
| [x] unit | `T.fmt` | 63 | - |
| [x] unit | `T.parseTime` | 72 | Accepts plain seconds ("3832.8"), h:mm:ss / m:ss with optional decimal seconds ("1:03:52.8"), or h:mm:ss:ff timecode using the sequence... |
| [x] unit | `T.sequenceFps` | 86 | - |
| [ ] - | `T.samePath` | 97 | - |
| [ ] - | `T.findOpenProject` | 100 | - |
| [x] unit | `T.proj` | 105 | - |
| [x] unit | `T.activeSequence` | 109 | - |
| [x] unit | `T.sequenceList` | 113 | - |
| [x] unit | `T.findSequenceById` | 118 | - |
| [x] unit | `T.sequenceNameExists` | 123 | - |
| [x] unit | `T.isToolkitCopy` | 128 | - |
| [x] unit | `T.fingerprint` | 135 | Fingerprint of a sequence's timeline (track and clip counts, names, edges) so a caller can show a sequence was not changed by an operation. |
| [x] unit | `walk` | 137 | - |
| [x] unit | `T.duplicateSequence` | 157 | Duplicates seq with Sequence.clone() (the call the MCP bridge's duplicate_sequence uses), finds the new sequence by diffing sequence... |
| [ ] - | `T.deselectAll` | 203 | ---- Timeline helpers ---- |
| [ ] - | `off` | 204 | - |
| [x] unit | `T.clipsOverlapping` | 215 | Every clip overlapping (startSec, endSec) on every track, as plain records that keep a reference to the TrackItem. |
| [x] unit | `scan` | 217 | - |
| [ ] - | `T.linkedNodeIds` | 232 | Real link state, read the way the MCP bridge's get_linked_items does it: TrackItem.getLinkedItems() (not in Adobe's docs; verified on... |
| [ ] - | `T.trackLabel` | 237 | - |
| [ ] - | `ameNote` | 244 | - |
| [ ] - | `$.global.PenyAmeDone` | 252 | - |
| [ ] - | `$.global.PenyAmeError` | 253 | - |
| [ ] - | `$.global.PenyAmeCancel` | 254 | - |
| [ ] - | `T.queueRender` | 255 | - |
| [x] unit | `T.run` | 270 | ---- Entry point used by the panel for every skill run ---- |

## core/jobs.js

Job pool for shell jobs (ffmpeg/REDline renders). Takes: jobs {key, cmd, outputPath, kind, weight}. Gives: summary, progress, ETA. Touches: child processes (exec, kill), output files (size, moov atom, ffprobe frame count), the ETA history JSON.

| Status | Function | Line | What it does |
|---|---|---|---|
| [x] unit | `fileSize` | 53 | A missing file counts as 0 bytes, as in the original panel, so a job that never writes anything is still caught as stalled. |
| [x] unit | `isCompleteMov` | 61 | A finished .mov has a whole 'moov' atom; ffmpeg/REDline write it last (no +faststart), so a render cut short lacks it. Walks the... |
| [x] unit | `frameCountMismatch` | 92 | A finished .mov can still be wrong: the Orbea Canonball proxies (issue 1) had a whole moov atom and every channel, but 9 fewer frames... |
| [x] unit | `frames` | 94 | - |
| [x] unit | `JobPool` | 114 | new JobPool({ maxConcurrent, log, onChange }) pool.add({ key, cmd, outputPath, label }) key must be unique (outputPath is fine)... |
| [x] unit | `JobPool.prototype.add` | 135 | Keys must be unique: running jobs are kept by key, so a second job with the same key would overwrite the first and one of them would be... |
| [x] unit | `JobPool.prototype.runningCount` | 142 | - |
| [x] unit | `JobPool.prototype.summary` | 144 | - |
| [x] unit | `parseProgress` | 156 | Fraction (0..1) of the current job from a chunk of its output, or null. Lines can be split across chunks, so the tail of the last chunk... |
| [x] unit | `JobPool.prototype.progress` | 172 | - |
| [x] unit | `share` | 189 | - |
| [x] unit | `JobPool.prototype._accrue` | 193 | Adds running-count x time to each running job since the last call (for its average concurrency). Called before every launch/exit and... |
| [x] unit | `avgConc` | 199 | - |
| [x] unit | `groupOf` | 215 | - |
| [x] unit | `JobPool.prototype._rates` | 216 | - |
| [x] unit | `add` | 231 | - |
| [x] unit | `prior` | 238 | - |
| [x] unit | `jobWeight` | 249 | - |
| [x] unit | `JobPool.prototype._runStarted` | 253 | Called once the queue is filled: numbers the jobs, the average weight per kind (for the saved-rate prior) and loads the saved rates. |
| [x] unit | `JobPool.prototype._saveRates` | 272 | After a run: saves this run's steady rate per kind (recency-weighted, so mostly the later jobs) for the next run's first estimate. |
| [x] unit | `JobPool.prototype._estimate` | 293 | { state: "estimating"/"ok"/"paused"/"cancelled"/"done", seconds?, finishAt? } |
| [x] unit | `solo` | 301 | - |
| [x] unit | `JobPool.prototype._emitProgress` | 360 | - |
| [x] unit | `JobPool.prototype.start` | 369 | - |
| [x] unit | `JobPool.prototype.pause` | 378 | - |
| [x] unit | `JobPool.prototype.resume` | 379 | - |
| [x] unit | `JobPool.prototype.cancel` | 381 | - |
| [x] unit | `JobPool.prototype.wait` | 392 | - |
| [x] unit | `JobPool.prototype._fill` | 402 | opts.limits(): { total, perKind: { r3d: n } }, read each time a job could start (the Full / Half speed switch can change mid-run);... |
| [x] unit | `runningOf` | 410 | - |
| [x] unit | `JobPool.prototype._launch` | 419 | - |
| [x] unit | `descendants` | 473 | Every process under pid, children before parents. A RED render is a shell chain (REDline, then red-proxy-finish.sh -> ffmpeg); an async... |
| [x] unit | `JobPool.prototype._kill` | 484 | - |
| [x] unit | `JobPool.prototype._watch` | 494 | - |
| [x] unit | `JobPool.prototype._maybeFinish` | 516 | - |

## core/shootdate.js

Shoot day of each clip. Takes: clips [{path}], ffprobe path. Gives: clip.shootDay/shootTime/dateFrom/size. Touches: reads R3D headers, Sony XML sidecars, ffprobe, a JSON cache.

| Status | Function | Line | What it does |
|---|---|---|---|
| [x] unit | `extOf` | 20 | - |
| [x] unit | `pad2` | 21 | - |
| [x] unit | `fromR3d` | 23 | - |
| [x] unit | `fromName` | 33 | - |
| [x] unit | `isoLocal` | 37 | - |
| [x] unit | `fromSonyXml` | 41 | - |
| [x] unit | `fromFfprobe` | 52 | - |
| [x] unit | `readOne` | 71 | - |
| [x] unit | `shootDay` | 78 | "20260826" + "013000" -> "20260825" (before 05:00 = the day before). |
| [x] unit | `readCache` | 85 | - |
| [x] unit | `writeCache` | 86 | - |
| [x] unit | `detect` | 89 | - |

## core/steps.js

Progress bar for multi-step skills. Takes: step ids, size. Gives: progress events like JobPool's. Touches: its history JSON.

| Status | Function | Line | What it does |
|---|---|---|---|
| [x] unit | `StepTask` | 19 | - |
| [x] unit | `StepTask.prototype.step` | 39 | - |
| [x] unit | `StepTask.prototype.done` | 53 | - |
| [x] unit | `StepTask.prototype._state` | 64 | - |
| [x] unit | `StepTask.prototype._emit` | 83 | - |
| [x] unit | `StepTask.prototype._save` | 100 | Learns a + b x size per step: keeps a, moves b halfway towards this run's value. |

## core/updater.js

Runs update scripts from inside the panel. Takes: isBusy(). Touches: runs ~/Library/Application Support/PenyToolkit/update.sh every 5 min and the build Mac's auto-update.sh hourly.

Not run offline (2): not reached by the offline tests.

| Status | Function | Line | What it does |
|---|---|---|---|
| [x] unit | `exists` | 31 | - |
| [x] unit | `releaseScript` | 33 | - |
| [x] unit | `buildScript` | 39 | - |
| [x] unit | `start` | 48 | opts: log(msg, level), isBusy() -> reason or null |
| [ ] - | `run` | 54 | - |
| [ ] - | `tick` | 67 | - |
| [x] unit | `stop` | 82 | A running script carries on after a soft reload; update.sh and auto-publish.sh lock themselves, so the next panel's run cannot overlap it. |
| [x] unit | `running` | 83 | - |

## install.sh

Developer Macs: rsync the checkout into CEP, ask the open panel to soft-reload. Prints OK / DEFERRED / ERROR / NO PANEL.

End to end: copy + NO PANEL path run on macOS (needs rsync); soft reload needs an open panel.

| Status | Function | Line | What it does |
|---|---|---|---|
| [x] e2e | `get` | 29 | plutil reads JSON and ships with macOS (/usr/bin/python3 can be a stub that asks to install the developer tools on a new Mac). |

## installer/install-toolkit.sh

One-click installer: bundled tools + models into ~/Library/Application Support/PenyToolkit, panel into CEP. No admin, no Homebrew.

Not run offline (6): installer/build/publish machine script: run on a Mac (verify_fresh_install.sh / build machine).

| Status | Function | Line | What it does |
|---|---|---|---|
| [ ] - | `done_` | 59 | - |
| [ ] - | `todo` | 60 | - |
| [ ] - | `step` | 61 | - |
| [ ] - | `unquarantine` | 67 | Files from a download or a zip carry Apple's quarantine flag, which stops the tools from running. Clearing it on our own files needs no... |
| [ ] - | `copy` | 71 | Clone on the same disk (instant), plain copy otherwise. |
| [ ] - | `fetch_whisper` | 154 | - |

## installer/update.sh

Installer Macs: reads version.json on the office server, copies and checks the zip, reinstalls.

Not run offline (4): installer/build/publish machine script: run on a Mac (verify_fresh_install.sh / build machine).

| Status | Function | Line | What it does |
|---|---|---|---|
| [ ] - | `log` | 21 | - |
| [ ] - | `quiet` | 23 | "Nothing to do" lines are logged only when they change (the check runs every 5 minutes). |
| [ ] - | `get` | 39 | - |
| [ ] - | `field` | 51 | - |

## loader.js

Loads main.js and soft-reloads it in place. Touches: /tmp/peny-toolkit/instance, loader-alive (heartbeat every second), reload-stamp, reloaded.json; PenyToolkit.log.

End to end: headless Chromium UI smoke loads the page through it.

| Status | Function | Line | What it does |
|---|---|---|---|
| [x] e2e | `stamp` | 35 | Local time, same format as main.js's log lines. |
| [x] e2e | `p` | 37 | - |
| [x] e2e | `log` | 41 | - |
| [x] e2e | `readStamp` | 46 | - |
| [x] e2e | `stampValue` | 50 | - |
| [x] e2e | `writeJson` | 51 | - |
| [x] e2e | `report` | 56 | - |
| [x] e2e | `clearToolkitModules` | 62 | - |
| [x] e2e | `restoreHtml` | 67 | Puts back <body> (without its scripts) and the <style> blocks from index.html. |
| [x] e2e | `reloadCore` | 84 | core.jsx keeps its state on $.global.PenyToolkit (`// {}`), so evaluating it again only replaces the functions; skills' premiere.jsx are... |
| [x] e2e | `loadApp` | 92 | Runs main.js as an inline script (synchronous, never served from a cache). |
| [x] e2e | `softReload` | 101 | - |
| [x] e2e | `poll` | 123 | - |

## main.js

Panel UI (CEP page). Takes: skill.json files, button presses, the test hook /tmp/peny-toolkit/inbox/run.json. Gives: the home screen, app views, progress bars, History, the log. Touches: ~/Library/Logs/PenyToolkit.log, /tmp/peny-toolkit (hook, result files), ~/.peny-toolkit settings, Premiere through evalScript (one call at a time), every skill's panel.js.

End to end: headless Chromium UI smoke (tests/ui/smoke.js): every app opened, every button pressed, no page errors.

| Status | Function | Line | What it does |
|---|---|---|---|
| [x] e2e | `nodeRequire` | 24 | - |
| [x] e2e | `stamp` | 63 | ---- Logging (panel + file) ---- |
| [x] e2e | `p` | 65 | - |
| [x] e2e | `log` | 69 | - |
| [x] e2e | `evalJsx` | 82 | - |
| [x] e2e | `jsxString` | 90 | - |
| [x] e2e | `evalSkill` | 96 | - |
| [x] e2e | `evalPieces` | 118 | A skill with "pieceMs" in skill.json works in pieces of about that long, so Premiere answers between them: its jsx returns details.next... |
| [x] e2e | `piece` | 123 | - |
| [x] e2e | `findSkill` | 147 | ---- Running actions ---- |
| [x] e2e | `findAction` | 148 | - |
| [x] e2e | `runAction` | 155 | - |
| [x] e2e | `progressText` | 232 | - |
| [x] e2e | `leftText` | 238 | Time left as text, as close as the estimate allows: to 5 s under 90 s, to 10 s under 10 min, then minutes. "" for null. |
| [x] e2e | `doneByText` | 251 | Clock time the run should finish ("13:05"), from the smoothed finish time. |
| [x] e2e | `etaText` | 257 | "About 3 min 20 s left · done by 13:05 (8 of 30 done)"; empty when over or cancelled. |
| [x] e2e | `showProgress` | 267 | - |
| [x] e2e | `jobsMinimised` | 302 | - |
| [x] e2e | `clipName` | 303 | - |
| [x] e2e | `esc` | 304 | - |
| [x] e2e | `padViews` | 307 | The dock sits in the page's flow under the work area (index.html), so views need no padding; it also refreshes the header chip and the... |
| [x] e2e | `taskOver` | 308 | - |
| [x] e2e | `drawJobs` | 312 | - |
| [x] e2e | `initJobsDock` | 354 | - |
| [x] e2e | `setButtons` | 375 | - |
| [x] e2e | `setStatus` | 390 | - |
| [x] e2e | `statusText` | 396 | - |
| [x] e2e | `endText` | 402 | "Finished at 00:15" / "Stopped with an error at 00:15" / "Cancelled at 00:15" under a bar whose run is over, from the run's real end... |
| [x] e2e | `viewTask` | 409 | The bar in an app's view: that app's own task, else (Ingest + proxies) the proxy run. |
| [x] e2e | `proxyView` | 414 | Proxies and Ingest + proxies show the proxy run; every other app only its own task. |
| [x] e2e | `drawProgress` | 416 | - |
| [x] e2e | `iconBox` | 456 | - |
| [x] e2e | `drawAppTiles` | 467 | An app with "apps" in skill.json opens a mini dashboard of tiles, one per job; each tile opens its own view (Lee, 30 Oct 2026: nothing... |
| [x] e2e | `setNav` | 474 | - |
| [x] e2e | `showApp` | 478 | - |
| [x] e2e | `showView` | 488 | - |
| [x] e2e | `sheet` | 514 | Glass sheet instead of window.confirm. Resolves true for the OK button. |
| [x] e2e | `done` | 524 | - |
| [x] e2e | `ok.onclick` | 526 | - |
| [x] e2e | `no.onclick` | 527 | - |
| [x] e2e | `readShared` | 535 | - |
| [x] e2e | `writeShared` | 536 | - |
| [x] e2e | `storeKey` | 540 | - |
| [x] e2e | `remember` | 541 | - |
| [x] e2e | `recall` | 542 | - |
| [x] e2e | `fileUrlToPath` | 546 | The CEP folder picker returns a file:// URL with %-escapes ("file:///Volumes/G-SPEED%20Shuttle/..."); turn it into a plain path. |
| [x] e2e | `chooseFolder` | 554 | - |
| [x] e2e | `clearToolkitModules` | 564 | Node's require cache outlives a CEP page reload, so without this a reload keeps running the old panel.js/jobs.js. Drop the toolkit's own... |
| [x] e2e | `loadSkills` | 571 | - |
| [x] e2e | `evalSkill` | 584 | - |
| [x] e2e | `status` | 587 | - |
| [x] e2e | `progress` | 588 | - |
| [x] e2e | `skillAction` | 590 | Run another skill's action directly (used by multi-step skills). |
| [x] e2e | `setProjectTarget` | 596 | Ingest + Proxies job queue: the project every skill call works on (null = the one in front). |
| [x] e2e | `drawSkills` | 608 | - |
| [x] e2e | `drawInput` | 642 | - |
| [x] e2e | `paint` | 680 | - |
| [x] e2e | `drawGroup` | 721 | - |
| [x] e2e | `actionButton` | 732 | - |
| [x] e2e | `goBack` | 797 | - |
| [x] e2e | `goHome` | 801 | - |
| [x] e2e | `speedId` | 822 | - |
| [x] e2e | `flipMs` | 823 | - |
| [x] e2e | `motionOn` | 825 | - |
| [x] e2e | `flipEnd` | 830 | - |
| [x] e2e | `visibleView` | 831 | - |
| [x] e2e | `snapshotView` | 835 | A still copy of a view as it looks now (opening or closing inside one view, e.g. an Interviews job): it stands in for the old screen... |
| [x] e2e | `clipOf` | 845 | clip-path for the window: the icon's box (round 22.5%) or the whole pane (square). |
| [x] e2e | `iconLook` | 851 | The icon's glyph and colour, read while the icon is on screen (before the view changes: opening a job hides the job icons). |
| [x] e2e | `makeFace` | 856 | The icon's black face with its glyph, clipped like the window, glyph kept centred in it. |
| [x] e2e | `settle` | 876 | Scales a view's children around one screen point (the icon's centre), so they move as one. |
| [x] e2e | `flipOpen` | 886 | - |
| [x] e2e | `flipClose` | 916 | - |
| [x] e2e | `runFlip` | 950 | Plays the animations; when they end (or flipEnd() is called) cleans up. |
| [x] e2e | `finish` | 952 | - |
| [x] e2e | `firstSentence` | 962 | - |
| [x] e2e | `infoBlock` | 965 | A header row (title, or none for a slim row) with an "i" that opens the how-to text under it. |
| [x] e2e | `setInfo` | 980 | - |
| [x] e2e | `closeInfo` | 984 | - |
| [x] e2e | `pressAction` | 991 | A button press: confirm if asked, explain + pick each prompted folder, then run. |
| [x] e2e | `pastSeconds` | 1025 | - |
| [x] e2e | `clockText` | 1030 | - |
| [x] e2e | `runTimerReport` | 1031 | - |
| [x] e2e | `startRunTimer` | 1045 | - |
| [x] e2e | `stopRunTimer` | 1052 | - |
| [x] e2e | `finishRunTimer` | 1058 | - |
| [x] e2e | `loadHistory` | 1071 | - |
| [x] e2e | `historyFromLog` | 1078 | First start with no history file: rebuild it from the log's "Run <app> > <button> (source)" and "OK / FAIL <app> > <button>: ..." lines... |
| [x] e2e | `addHistory` | 1103 | - |
| [x] e2e | `hhmm` | 1111 | - |
| [x] e2e | `whenText` | 1113 | Time today ("08:14:03", or "08:14" short), else the date ("29 Oct"). |
| [x] e2e | `drawHistory` | 1117 | - |
| [x] e2e | `drawStates` | 1133 | ---- State: header chip and each home row ---- |
| [x] e2e | `pref` | 1159 | ---- Layout: log / history pane at the bottom, on the side or hidden; list or icon view ---- Remembered per Mac (localStorage). Premiere... |
| [x] e2e | `applyLayout` | 1161 | - |
| [x] e2e | `cycleLayout` | 1179 | - |
| [x] e2e | `toggleGrid` | 1180 | - |
| [x] e2e | `styleId` | 1188 | - |
| [x] e2e | `applyStyle` | 1189 | - |
| [x] e2e | `setStyle` | 1196 | - |
| [x] e2e | `cycleStyle` | 1197 | - |
| [x] e2e | `toggleMotion` | 1198 | - |
| [x] e2e | `showStyles` | 1199 | - |
| [x] e2e | `showTab` | 1227 | - |
| [x] e2e | `initLayout` | 1233 | - |
| [x] e2e | `move` | 1246 | - |
| [x] e2e | `up` | 1251 | - |
| [x] e2e | `showKeys` | 1265 | - |
| [x] e2e | `onKey` | 1271 | - |
| [x] e2e | `pollHook` | 1303 | ---- Test hook ---- |
| [x] e2e | `writeHookResult` | 1328 | - |
| [x] e2e | `isBusy` | 1370 | ---- Soft reload (loader.js) ---- Busy: an action running, or a skill module saying it still has work (a render pool, a child process).... |
| [x] e2e | `stop` | 1382 | Undo what this file set up in the page: the hook timer and the updater's timers; its click handlers sit on elements loader.js throws away. |
| [x] e2e | `skillsCount` | 1394 | - |

## setup.sh

Developer Macs: Homebrew tools, models, Premiere settings, launchd agents, then install.sh. Safe to repeat.

Not run offline (4): installer/build/publish machine script: run on a Mac (verify_fresh_install.sh / build machine).

| Status | Function | Line | What it does |
|---|---|---|---|
| [ ] - | `ok` | 36 | - |
| [ ] - | `todo` | 37 | - |
| [ ] - | `step` | 38 | - |
| [ ] - | `download` | 74 | --- Models ------------------------------------------------------------------ |

## skills/colour-baseline/lutpreset.py

Builds Lumetri-with-LUT effects and .prfpset preset files; grades a project XML copy.

End to end: parse_cube/embedded_blob in-process; CLI usage run.

| Status | Function | Line | What it does |
|---|---|---|---|
| [x] unit | `parse_cube` | 43 | - |
| [x] unit | `lut_hash` | 77 | - |
| [x] unit | `embedded_blob` | 82 | - |
| [x] e2e | `utf16z` | 97 | - |
| [x] e2e | `_b64` | 101 | - |
| [x] e2e | `_objects` | 105 | Top-level objects of a template file: list of (tag, ObjectID, text). |
| [x] e2e | `_binary_hash` | 113 | Premiere's BinaryHash attribute: 12 bytes of hash + uint32 (length + 12), shown as a GUID. |
| [x] e2e | `_set_param_value` | 120 | Replaces an Arb param's StartKeyframeValue with data (bytes), with a BinaryHash. |
| [x] e2e | `_component` | 129 | Copies a template effect with fresh ObjectIDs from next_id. edit(index, text) may change a |
| [x] e2e | `_xml_text` | 156 | - |
| [x] e2e | `lut_component` | 160 | - |
| [x] e2e | `edit` | 164 | - |
| [x] e2e | `plain_component` | 180 | - |
| [x] e2e | `effect_component` | 184 | A whole Lumetri effect saved from a project (e.g. Lee's own "CANON LUT"), copied as is. |
| [x] e2e | `write_presets` | 262 | entries: [{"name", and one of "lut" (.cube path), "effect" (effect xml file), "plain": true}]. |
| [x] e2e | `collect` | 292 | .cube files under the given files/folders, de-duplicated by content. Preset name = file name |
| [x] e2e | `_object_text` | 331 | ---- test: inject into an exported project ---- |
| [x] e2e | `inject` | 336 | - |
| [x] e2e | `load_presets` | 361 | ---- grade: add effects from a preset file to clips of an exported sequence ---- |
| [x] e2e | `_copy_objects` | 399 | Copies an effect with fresh ObjectIDs; comp_id sets the component's <ID> in its chain. |
| [x] e2e | `lut_label` | 422 | Effect name for a LUT choice: a preset's own name, or a LUT file's name without extension. |
| [x] e2e | `grade` | 429 | plan: {"sequence": uid, "newSequence": uid, "newName", "oldName", "presets": prfpset path, |
| [x] e2e | `shrink` | 519 | - |
| [x] e2e | `main` | 534 | - |

## skills/colour-baseline/panel.js

Colour: detect cameras, LUT picker, apply the baseline on a GRADED TOOLKIT COPY, make LUT presets. Touches: exports/imports a project XML copy, ~/.peny-toolkit LUT folders.

Not run offline (38): runs real tools (ffmpeg/whisper/Ollama/REDline) after Premiere answers: Premiere run.

| Status | Function | Line | What it does |
|---|---|---|---|
| [ ] - | `BUNDLED` | 24 | Tools put in place by the one-click installer (no Homebrew needed). Used first when present: they are the versions the toolkit was... |
| [ ] - | `lutRoots` | 40 | - |
| [ ] - | `usableLut` | 52 | - |
| [ ] - | `listLutFolders` | 63 | [{ name: "Technical", items: ["file:/…/x.cube", …] }, …] in Lee's order, empty folders left out. |
| [ ] - | `walk` | 65 | - |
| [ ] - | `rank` | 84 | - |
| [ ] - | `lutLabel` | 89 | - |
| [ ] - | `choiceExists` | 91 | A saved choice still available: one of Lee's presets, or a LUT file that is still there. |
| [ ] - | `firstExisting` | 93 | - |
| [ ] - | `extOf` | 94 | - |
| [x] unit | `readSettings` | 96 | - |
| [ ] - | `writeSettings` | 100 | - |
| [ ] - | `prettyModel` | 106 | Readable camera names from the model strings the files carry. |
| [ ] - | `redModel` | 123 | - |
| [ ] - | `scanBytes` | 133 | - |
| [ ] - | `fileModel` | 144 | - |
| [x] unit | `module.exports` | 171 | - |
| [x] unit | `jsx` | 176 | - |
| [ ] - | `cameraFor` | 179 | Camera per clip. Probes one file per reel (R3D) or per folder + type (others). |
| [ ] - | `userPresetFile` | 224 | Lee's Lumetri presets, read from Premiere's user preset file (the one Effects panel > Import Presets / Save Preset writes). Premiere's... |
| [ ] - | `python` | 237 | - |
| [ ] - | `runPy` | 238 | - |
| [ ] - | `listPresets` | 246 | - |
| [ ] - | `suggest` | 254 | Suggested LUT for a camera with no saved choice: one of Lee's presets naming the brand ("CANON LUT" for Canon, "RED LUT" for RED...). |
| [x] unit | `detect` | 262 | - |
| [x] unit | `apply` | 302 | Apply: export the active sequence to a project file, add "Adjustments" and the camera's LUT preset to every video clip there... |
| [ ] - | `verify` | 375 | Every clip of the new sequence against the original: same clip, time and master clip, and its Lumetri stack = Adjustments (if added),... |
| [ ] - | `uuidv4` | 404 | - |
| [ ] - | `el` | 412 | ---- Camera list in the skill card ---- |
| [ ] - | `addCss` | 436 | - |
| [ ] - | `lutFolders` | 442 | The folder row: this Mac's LUT folders, then Lee's presets. |
| [ ] - | `folderOf` | 447 | - |
| [ ] - | `picker` | 451 | - |
| [ ] - | `label` | 460 | - |
| [ ] - | `paintFolders` | 464 | - |
| [ ] - | `fill` | 465 | - |
| [ ] - | `show` | 477 | - |
| [ ] - | `choose` | 488 | - |
| [ ] - | `wrap._open` | 508 | - |
| [ ] - | `uiProbe` | 514 | Test hook (detect with uiProbe): opens each camera's list, scrolls it into view as a click does, and checks it lies inside the panel's... |
| [ ] - | `render` | 541 | - |
| [x] unit | `makePresets` | 563 | Make LUT presets: every 3D .cube under the chosen folder becomes a Lumetri effect preset named after its file (LUT embedded in the... |
| [x] unit | `wrap` | 589 | - |
| [ ] - | `busy` | 600 | - |
| [ ] - | `mount` | 601 | - |

## skills/colour-baseline/premiere.jsx

Colour, Premiere side: scan, export/import the graded copy, set Lumetri params (TOOLKIT COPY only).

Not run offline (12): needs Premiere's own objects (QE, Lumetri, encoder, bins) the fake does not model: Premiere run.

| Status | Function | Line | What it does |
|---|---|---|---|
| [x] unit | `T.skills["colour-baseline"]` | 31 | - |
| [ ] - | `mediaPath` | 46 | - |
| [ ] - | `metaField` | 47 | - |
| [ ] - | `isLumetri` | 51 | - |
| [ ] - | `instName` | 52 | - |
| [ ] - | `lumetris` | 54 | Lumetri effects top to bottom, by instance name ("" = an unnamed Lumetri Color). |
| [ ] - | `scan` | 61 | Video clips that play a media file (not nested sequences, graphics, stills or adjustment layers). |
| [ ] - | `trackItem` | 92 | - |
| [ ] - | `exportProj` | 99 | - |
| [ ] - | `importSeq` | 105 | - |
| [ ] - | `finish` | 116 | - |
| [ ] - | `frame` | 133 | ---- test hook only ---- |
| [x] unit | `setParam` | 146 | Sets one param of the clip's n-th Lumetri (params.lumetri, from the top). TOOLKIT COPY only. |
| [ ] - | `qeOrder` | 161 | QE's component list for a clip, with each component's Saturation (used to tell two Lumetri effects apart after a marker value is set on... |
| [x] unit | `addPlain` | 182 | A plain Lumetri Color added with QE (goes at the bottom). TOOLKIT COPY only. |

## skills/import-footage/panel.js

Ingest, Node side. Takes: a footage folder. Gives: import results. Touches: walks the folder (fs), calls premiere.jsx to make bins and import.

Not run offline (14): runs real tools (ffmpeg/whisper/Ollama/REDline) after Premiere answers: Premiere run.

| Status | Function | Line | What it does |
|---|---|---|---|
| [x] unit | `module.exports` | 17 | - |
| [ ] - | `readdir` | 22 | Callback-style fs wrapped in this page's Promise: after a CEP page reload, fs.promises calls never resolve (seen 2 Oct 2026), callbacks... |
| [ ] - | `stat` | 23 | - |
| [ ] - | `listEntries` | 28 | Hidden files are skipped: a Mac writing to the server leaves a "._C1836.MP4" next to every clip (its Finder info, not video); Premiere... |
| [ ] - | `bootVolumePrefixes` | 38 | Every /Volumes/<name> that is the start-up disk itself (realpath "/"). |
| [x] unit | `run` | 48 | - |
| [ ] - | `known` | 73 | - |
| [ ] - | `queue` | 79 | - |
| [ ] - | `importPieces` | 86 | A bin's files go in pieces of IMPORT_PIECE with a pause between, so Premiere answers while it imports (6 Nov 2026). A numbered still... |
| [ ] - | `next` | 88 | - |
| [ ] - | `importGroup` | 108 | - |
| [ ] - | `dropExisting` | 130 | - |
| [ ] - | `flush` | 140 | - |
| [ ] - | `onEnterDir` | 173 | - |
| [ ] - | `onDirDone` | 174 | - |
| [x] unit | `preview` | 200 | - |
| [x] unit | `ingest` | 203 | The Ingest app's button: the Ingest + proxies run stopped after its import step, which calls "import" below. One code path for both apps. |
| [ ] - | `rootbin` | 206 | Not a button: lets Ingest + proxies find the bin a folder was imported into. |

## skills/import-footage/premiere.jsx

Ingest, Premiere side: bins mirroring the folder tree, importFiles, checks of what is already imported. Touches: the project's bins and items (adds only).

Not run offline (15): needs Premiere's own objects (QE, Lumetri, encoder, bins) the fake does not model: Premiere run.

| Status | Function | Line | What it does |
|---|---|---|---|
| [ ] - | `norm` | 23 | Used only as a comparison key. Lower-cased because Mac disks ignore letter case: a clip stored as ".mp4" in the project is the same file... |
| [ ] - | `index` | 36 | - |
| [ ] - | `exists` | 56 | - |
| [ ] - | `childBin` | 63 | - |
| [ ] - | `resolveChain` | 73 | - |
| [ ] - | `mediaPathsIn` | 88 | - |
| [ ] - | `doImport` | 96 | - |
| [ ] - | `findByMedia` | 136 | ---- Linked R3D + wav sequences ---- Premiere cannot script Merge Clips (checked on 26.5.2: only isMergedClip exists), so for each RED... |
| [ ] - | `childByName` | 144 | - |
| [ ] - | `sequenceForItem` | 148 | - |
| [ ] - | `tcSeconds` | 155 | - |
| [ ] - | `syncPair` | 157 | - |
| [ ] - | `sync` | 229 | - |
| [ ] - | `rootBin` | 247 | The bin an import of folder <name> lands in, found the same way resolveChain finds it (one bin of that name anywhere in the project,... |
| [ ] - | `T.skills["import-footage"]` | 259 | - |

## skills/import-footage/walkLogic.js

What Ingest imports from a footage folder (RED .RDC, ARRIRAW, flat files, Audio folders, skipped Proxies/Exports). Takes: a listEntries function. Gives: items per bin path. Touches: nothing itself.

| Status | Function | Line | What it does |
|---|---|---|---|
| [x] unit | `hasExt` | 111 | - |
| [x] unit | `anyExt` | 115 | - |
| [x] unit | `isVideoFile` | 119 | - |
| [x] unit | `isAudioFile` | 123 | - |
| [x] unit | `isMediaFile` | 127 | - |
| [x] unit | `isSkippedFolderName` | 131 | - |
| [x] unit | `baseName` | 147 | - |
| [x] unit | `mapConcurrent` | 161 | Runs `fn` over `items` with at most `limit` in flight at once, preserving result order. Used for the per-subfolder classification... |
| [x] unit | `worker` | 164 | - |
| [x] unit | `findWrapperRule` | 283 | Returns the first WRAPPER_RULES entry that matches folder `name` given its own direct `children`, or null if this is just a plain folder. |
| [x] unit | `findCompanionWav` | 300 | ========================================================================== Companion-wav matching (generalized from the RED-only... |
| [x] unit | `resolveDirectory` | 338 | items: Array< / { type: "clip", kind, wrapperName, representativeFile, clipBase, asNumberedStills, wav: entry/null } / { type: "flat",... |
| [x] unit | `walkTree` | 476 | including) the folder the item's bin should mirror - this is exactly the bin path that should be created/reused in Premiere for that... |
| [x] unit | `walk` | 478 | - |

## skills/ingest-pipeline/panel.js

Ingest + Proxies: Import, then Proxies render and attach, with a job queue across projects. Touches: the other two skills' actions; saves a project only with Save each project on and after every step passed.

Not run offline (8): runs real tools (ffmpeg/whisper/Ollama/REDline) after Premiere answers: Premiere run.

| Status | Function | Line | What it does |
|---|---|---|---|
| [x] unit | `module.exports` | 19 | - |
| [ ] - | `run` | 20 | - |
| [ ] - | `step` | 22 | - |
| [ ] - | `isOn` | 71 | - |
| [ ] - | `jobText` | 72 | - |
| [x] unit | `insideDest` | 75 | A footage folder inside the proxy folder would import the proxies as footage (Lee, 23 Oct 2026). |
| [x] unit | `makeJob` | 80 | - |
| [ ] - | `runJob` | 89 | - |
| [x] unit | `runAll` | 105 | - |
| [ ] - | `next` | 109 | - |
| [ ] - | `enqueue` | 134 | - |
| [x] unit | `control` | 150 | - |
| [x] unit | `run` | 166 | - |
| [ ] - | `ingest` | 168 | - |

## skills/ingest-pipeline/premiere.jsx

Which project is in front; saves one open project by path (Ingest + Proxies only).

Not run offline (4): needs Premiere's own objects (QE, Lumetri, encoder, bins) the fake does not model: Premiere run.

| Status | Function | Line | What it does |
|---|---|---|---|
| [ ] - | `modified` | 6 | - |
| [ ] - | `active` | 8 | - |
| [ ] - | `save` | 15 | - |
| [ ] - | `T.skills["ingest-pipeline"]` | 27 | - |

## skills/interview-selects/fillers.js

Finds um/uh fillers with two whisper passes and the sound envelope. Touches: ffmpeg/whisper runs passed in, clip files in a work folder.

Not run offline (5): not reached by the offline tests.

| Status | Function | Line | What it does |
|---|---|---|---|
| [x] unit | `words` | 21 | - |
| [x] unit | `key` | 25 | - |
| [x] unit | `readWords` | 29 | Whisper -ojf JSON -> words with their DTW time (seconds, minus shift) and probability. A token with a leading space starts a word;... |
| [x] unit | `envelope` | 47 | 16-bit PCM wav -> dB per 10 ms frame. |
| [x] unit | `percentile` | 65 | - |
| [x] unit | `sound` | 72 | The sound of the filler ws[i] in db (frames of 10 ms): { a, b, quietBefore, quietAfter } in frames, or { why } when it cannot be told... |
| [x] unit | `soundAt` | 86 | - |
| [x] unit | `loud` | 90 | - |
| [x] unit | `fillerWords` | 110 | Filler words in a list of words: [{ i, word, t }]. |
| [x] unit | `context` | 117 | - |
| [x] unit | `windows` | 120 | Check windows for each candidate: [{ cand, lead, start, file }] (file = wav to write). |
| [x] unit | `decide` | 133 | Decides each candidate from its two check windows (whisper JSON at w.file + ".json"). Returns { fillers: [{ word, start, end, sound, p,... |
| [x] unit | `inWindow` | 136 | - |
| [x] unit | `tiles` | 173 | Clips for the first pass: TILE s long every TILE / 2 s, so every moment is in two clips; clips with under half a second of sound are... |
| [ ] - | `find` | 185 | The whole search on wav (16 kHz mono, sequence time). tools: { ffmpeg, whisper, model }; run(cmd, args, onLine) -> Promise (the panel's,... |
| [ ] - | `cut` | 188 | Cuts each clip out of wav, one ffmpeg per 40 clips. |
| [ ] - | `transcribe` | 203 | whisper on many clips in one go (model loaded once), each to <clip>.json. whisper 1.9.4 aborts with DTW on a clip that comes out as one... |
| [ ] - | `done` | 204 | - |
| [ ] - | `from` | 205 | - |

## skills/interview-selects/panel.js

Interviews: transcribe (whisper), find answers (Ollama, local), cut & raise, trim, remove ums. Touches: renders the sequence audio, ~/PenyToolkit-scratch, starts Ollama if needed, the '<sequence> Cut' copy.

Not run offline (21): runs real tools (ffmpeg/whisper/Ollama/REDline) after Premiere answers: Premiere run.

| Status | Function | Line | What it does |
|---|---|---|---|
| [x] unit | `BUNDLED` | 28 | Tools put in place by the one-click installer (no Homebrew needed). Used first when present: they are the versions the toolkit was... |
| [x] unit | `firstExisting` | 43 | - |
| [x] unit | `inModelDir` | 44 | - |
| [ ] - | `fmt` | 45 | - |
| [x] unit | `module.exports` | 50 | - |
| [ ] - | `run` | 53 | - |
| [ ] - | `lines` | 58 | - |
| [ ] - | `joinPieces` | 73 | Joins pieces that continue the same file without a gap, so a cut-up interview becomes a few long inputs. |
| [ ] - | `sequenceAudio` | 88 | The interview's sound. Normally the sequence's own sound, rendered by Premiere: exactly the mic Lee put on the timeline (30 Oct 2026;... |
| [ ] - | `fromFiles` | 105 | - |
| [ ] - | `audioStreams` | 115 | - |
| [ ] - | `buildAudio` | 127 | One wav in sequence time: each piece trimmed, delayed to its start and mixed. |
| [ ] - | `quietCuts` | 167 | Whisper over the whole file with VAD lost quiet interviewee speech (Arly Kemp, 29 Oct 2026: her name and home town and every line VAD... |
| [ ] - | `wavSamples` | 190 | - |
| [ ] - | `transcribe` | 199 | - |
| [ ] - | `srt` | 233 | - |
| [ ] - | `p` | 234 | - |
| [ ] - | `ollamaUp` | 244 | - |
| [ ] - | `startOllama` | 253 | Starts `ollama serve` unless one is already running; returns the child we started (or null). |
| [ ] - | `writeCsv` | 271 | - |
| [ ] - | `q` | 272 | - |
| [x] unit | `find` | 276 | - |
| [ ] - | `lap` | 288 | - |
| [ ] - | `markOnly` | 379 | Puts the answers of an earlier run (its answers.json) on the active sequence's safe copy without transcribing again (test hook:... |
| [x] unit | `unum` | 435 | Remove ums & uhs: the active sequence's sound -> fillers.js -> premiere.jsx "unum" on a "<sequence> No ums" copy. params.fillers = the... |
| [ ] - | `q` | 443 | - |
| [x] unit | `cancel` | 483 | - |
| [ ] - | `cutraise` | 493 | Cut & raise: all in Premiere (premiere.jsx "cutraise"). params.jsxAction lets the test hook call another premiere.jsx action (e.g.... |
| [x] unit | `trim` | 502 | Trim (Lee, 6 Nov 2026): a "<Cut> Trimmed" copy with the dead bits between answers removed. |

## skills/interview-selects/pipeline.js

Transcript -> speaker labels -> answers -> notes. Takes: whisper JSON, a 16 kHz wav. Gives: answer spans with topics. Touches: Ollama on 127.0.0.1:11434.

Not run offline (30): not reached by the offline tests.

| Status | Function | Line | What it does |
|---|---|---|---|
| [x] unit | `pickModel` | 11 | - |
| [x] unit | `pool` | 29 | - |
| [x] unit | `worker` | 31 | - |
| [x] unit | `tc` | 41 | - |
| [x] unit | `readTranscript` | 48 | whisper.cpp JSON -> [{a, b, text}] in seconds |
| [x] unit | `tag` | 63 | Each transcript line is shown with a tag (L001, L002, ...) and the model answers with tags, not line numbers or quotes: it wrote line... |
| [ ] - | `words` | 67 | An interviewer line comes as its tag plus its first 2 words; the words decide when the tag is a line or two out (the model reads each... |
| [ ] - | `checkTag` | 68 | - |
| [ ] - | `fits` | 72 | - |
| [ ] - | `untag` | 81 | - |
| [ ] - | `prompt` | 87 | - |
| [ ] - | `ollamaGenerate` | 107 | - |
| [x] unit | `ollamaGenerateWith` | 109 | - |
| [x] unit | `windows` | 127 | Windows of ~winSec with ovSec overlap. An answer is kept by the window whose core (window minus half the overlap at each inner edge)... |
| [ ] - | `selects` | 145 | - |
| [ ] - | `dropCrew` | 218 | next question, her reply left out), and the interviewee's words must never be cut (Lee, 29 Oct 2026). So each answer is reshaped on the... |
| [ ] - | `runsOn` | 221 | - |
| [ ] - | `isQ` | 226 | - |
| [ ] - | `edge` | 227 | - |
| [ ] - | `free` | 239 | - |
| [ ] - | `reaction` | 240 | - |
| [ ] - | `splitLong` | 283 | - |
| [ ] - | `qPrompt` | 330 | - |
| [ ] - | `group` | 340 | - |
| [ ] - | `questionsFromCrew` | 365 | Questions from the interviewer lines the answers pass already named (no second model pass: it took ~3 min of a 13 min run, 29 Oct 2026):... |
| [ ] - | `groupFrom` | 379 | - |
| [ ] - | `themes` | 423 | - |
| [x] unit | `cleanOutline` | 467 | - |
| [ ] - | `brief` | 479 | - |
| [ ] - | `cleanTopic` | 510 | - |
| [x] unit | `labelPrompt` | 527 | - |
| [x] unit | `notePrompt` | 535 | - |
| [ ] - | `clearlyInterviewer` | 545 | - |
| [ ] - | `readWavDb` | 552 | Cut edges from the sound itself, not whisper's line times (the end of a line is often early or late). Speech/silence comes from an... |
| [ ] - | `speechThreshold` | 568 | - |
| [ ] - | `levelLabels` | 582 | Each line's level (90th percentile of its frames: a line the two share counts by its loud part, so the interviewee's words in it are... |
| [ ] - | `safeEdges` | 603 | - |
| [ ] - | `speech` | 608 | - |
| [ ] - | `gapAt` | 609 | - |
| [ ] - | `onsetBack` | 610 | - |
| [ ] - | `offsetOn` | 614 | - |
| [x] unit | `selectsByLabels` | 645 | - |

## skills/interview-selects/premiere.jsx

Interviews, Premiere side: scan, '<sequence> Cut' copy, markers, razor + raise, trim, unum. Touches: only the Cut/No ums copies.

Not run offline (68): needs Premiere's own objects (QE, Lumetri, encoder, bins) the fake does not model: Premiere run.

| Status | Function | Line | What it does |
|---|---|---|---|
| [ ] - | `T.skills["interview-selects"]` | 21 | - |
| [ ] - | `activate` | 59 | QE only works on the active sequence and a script holds Premiere still while it runs, so a QE step opens its sequence for that moment.... |
| [ ] - | `backToLee` | 66 | - |
| [ ] - | `renderAudio` | 78 | The sequence's own sound as a wav: exactly what the timeline plays (the mic Lee chose for the clip, mutes, levels). Scripting can't see... |
| [ ] - | `isCut` | 89 | "<name> Cut", "<name> Cut 2", their "Trimmed" copies, and any older "Cut version". A name like "Rough Cut" counts only if "Rough" is a... |
| [ ] - | `sequenceForItem` | 102 | - |
| [ ] - | `wantedTracks` | 113 | Audio tracks to use: "A2" / "2" picks one track, empty = every track that is not muted. |
| [ ] - | `collect` | 126 | Segments of seq's audio between a and b (seconds, seq time), shifted by offset, on the chosen tracks; nested sequences are followed (all... |
| [ ] - | `scan` | 160 | - |
| [ ] - | `copy` | 179 | Duplicates seq (Sequence.clone, the way Make safe copy does), names the new sequence "<name> Cut" ("... Cut 2" if taken), checks the... |
| [ ] - | `isNoUms` | 212 | - |
| [ ] - | `unum` | 218 | params.fillers: [{ word, start, end }] in sequence seconds (found by panel.js on this sequence's sound). Each is snapped to frames;... |
| [ ] - | `locked` | 222 | - |
| [ ] - | `probe` | 297 | Read-only look at what Premiere 26.5.2 offers for moving a timeline piece to another track: method names (and argument lists where... |
| [ ] - | `methods` | 298 | - |
| [ ] - | `tcOf` | 328 | Timecode of the frame nearest sec. Built from whole-frame ticks: setting Time.seconds to e.g. 324.88 formatted one frame early (5:24.84)... |
| [ ] - | `razorAt` | 336 | Every clip on an unlocked track that spans t (strictly inside) is cut at t with the QE razor, one track at a time. Returns the tracks cut. |
| [ ] - | `each` | 338 | - |
| [ ] - | `piecesBetween` | 357 | - |
| [ ] - | `each` | 359 | - |
| [ ] - | `plain` | 374 | - |
| [ ] - | `qeTrack` | 383 | The QE track that holds the same clips as DOM track kind/i. Normally the same index, but after QE addTracks put a track at the bottom... |
| [ ] - | `sigOf` | 386 | - |
| [ ] - | `qeItemAt` | 402 | QE item of the piece starting at a on track kind ("V"/"A") index i, or null. |
| [ ] - | `around` | 411 | - |
| [ ] - | `each` | 413 | - |
| [ ] - | `answerSpans` | 435 | ---- Cut & raise ---- Answer spans = sequence markers with a comment and a length (what "mark" adds); overlapping spans are joined.... |
| [ ] - | `allPieces` | 456 | - |
| [ ] - | `each` | 458 | - |
| [ ] - | `isLocked` | 473 | - |
| [ ] - | `cutraise` | 478 | - |
| [ ] - | `origAt` | 498 | - |
| [ ] - | `mapT` | 613 | 5. Trim (Lee, 3 Oct 2026, like "Tahnee Home IV Trimmed"): everything outside the answers (questions, crew chat, pauses) is extracted, so... |
| [ ] - | `trimOnly` | 680 | "Trim" (Lee, 6 Nov 2026): duplicates a Cut as "<name> Trimmed" and runs only trimDead on the copy. trimDead needs just the markers and... |
| [ ] - | `trimDead` | 701 | Extracts every stretch outside the answer (Comment) markers, last first, then checks: length = answers' total, no holes, every piece... |
| [ ] - | `extractGaps` | 720 | Extracts gaps (sorted [{ a, b }], sequence seconds) from every track, last first, then checks length, source frames, links, markers and... |
| [ ] - | `res.map` | 725 | - |
| [ ] - | `holesIn` | 820 | Holes: every moment of the new length must have something on some track. |
| [ ] - | `findAdjustmentItem` | 848 | The project's adjustment layer item (Lee's projects have one called "Adjustment Layer"; ExtendScript cannot make one). First item that... |
| [ ] - | `walk` | 850 | - |
| [ ] - | `isAdjClip` | 865 | - |
| [ ] - | `trackHasLayers` | 866 | - |
| [ ] - | `trackLocked` | 870 | - |
| [ ] - | `topFootageTrack` | 872 | Highest video track with footage (not adjustment layers), -1 if none. |
| [ ] - | `ensureVideoTrack` | 882 | Adds video tracks to seq (QE addTracks, the bridge's add_tracks way) until index idx exists; checks the existing tracks kept their... |
| [ ] - | `emptyTrackFrom` | 902 | First unlocked video track at index >= from that is empty, -1 if none. |
| [ ] - | `itemMarkers` | 907 | - |
| [ ] - | `placeLayer` | 916 | Puts the adjustment layer item on track from a to b (sequence seconds). With base set, the layer's source range is base + a .. base + b... |
| [ ] - | `freeBase` | 947 | A source range on the adjustment item with no markers yet, for this Cut version's layers. |
| [ ] - | `cleanName` | 957 | - |
| [ ] - | `readTopics` | 961 | ---- Topic markers ---- Topics read back in sequence time from wherever TOPICS keeps them. |
| [ ] - | `topFootageTrackAt` | 988 | Highest footage track with a clip covering t. |
| [ ] - | `footageClipAt` | 996 | - |
| [ ] - | `questionLayerTrack` | 1005 | The question layers are on the lowest video track that holds adjustment layers. |
| [ ] - | `putMarker` | 1011 | - |
| [ ] - | `checkRow` | 1024 | Checks the layers already on track idx against the spans (after the trim they should sit back to back, one per question). |
| [ ] - | `addLayers` | 1042 | A row of adjustment layers, one per span, named after it, on video track index target (layers already there with the same start are... |
| [ ] - | `markerList` | 1057 | - |
| [ ] - | `findMarker` | 1068 | chapter: true finds only Chapter markers, false only the others, so a question and an answer with the same start and title stay two markers. |
| [ ] - | `setEnd` | 1079 | Marker.end takes seconds as a number (a Time object gives "Illegal Parameter type", seen 2 Oct 2026); ticks string as a fallback. |
| [ ] - | `mark` | 1090 | Questions -> Chapter markers, themes -> Segmentation markers (both on the sequence); small topics -> clip markers (TOPICS). In "layer"... |
| [ ] - | `fr` | 1093 | - |
| [ ] - | `untest` | 1173 | Removes the one test marker named "Claude clip-marker test" from a project item (the bridge cannot delete clip markers). Nothing else is... |
| [ ] - | `walk` | 1175 | - |
| [ ] - | `unbase` | 1197 | Removes the topic markers a failed test put on the Adjustment Layer item at base .. base + span (only markers in that range whose name... |
| [ ] - | `layerprobe` | 1212 | On a Cut version: places one adjustment layer on track params.track (index) at a..b, then tries to move its source start to params.src:... |
| [ ] - | `renote` | 1239 | Sets new comments on this Cut version's topic markers, matched by name (params.notes = { topic name: note }), wherever TOPICS keeps... |
| [ ] - | `findMarkerTyped` | 1260 | - |

## skills/interview-sync/panel.js

Sync Interviews, Node side: syncmeasure.py over every clip, then apply. Touches: ffmpeg reads, proxies.

Not run offline (5): runs real tools (ffmpeg/whisper/Ollama/REDline) after Premiere answers: Premiere run.

| Status | Function | Line | What it does |
|---|---|---|---|
| [x] unit | `BUNDLED` | 15 | - |
| [x] unit | `firstExisting` | 21 | - |
| [ ] - | `fmt` | 22 | - |
| [ ] - | `csvCell` | 27 | - |
| [ ] - | `stamp` | 28 | - |
| [x] unit | `module.exports` | 30 | - |
| [ ] - | `pythonWithNumpy` | 33 | - |
| [ ] - | `measure` | 41 | - |
| [x] unit | `sync` | 61 | - |
| [x] unit | `cancel` | 159 | - |
| [x] unit | `jsx` | 166 | Test hook only: run one premiere.jsx action (e.g. "probe") as it is. |

## skills/interview-sync/premiere.jsx

Sync Interviews, Premiere side: scan units; apply moves on its own copy; link.

Not run offline (23): needs Premiere's own objects (QE, Lumetri, encoder, bins) the fake does not model: Premiere run.

| Status | Function | Line | What it does |
|---|---|---|---|
| [x] unit | `T.skills["interview-sync"]` | 22 | - |
| [ ] - | `mediaPath` | 42 | - |
| [ ] - | `proxyPath` | 43 | - |
| [ ] - | `startTc` | 47 | - |
| [ ] - | `isSequenceItem` | 52 | - |
| [ ] - | `speedOf` | 53 | - |
| [ ] - | `mediaIn` | 57 | Where in its media the clip starts. After a head trim made by script the in point and the length can disagree (C385 on a test copy, 29... |
| [ ] - | `inOutDisagree` | 58 | - |
| [ ] - | `units` | 63 | Units of seq. Each keeps the TrackItems (video + linked audio, or one audio clip). |
| [ ] - | `describe` | 88 | - |
| [ ] - | `scan` | 108 | - |
| [x] unit | `copyOf` | 118 | ---- Copy ---- |
| [ ] - | `moveBy` | 145 | ---- Moving ---- Premiere 26: assigning .start trims the head instead of moving (seen 29 Oct 2026 with the MCP bridge's move_clip on the... |
| [ ] - | `near` | 150 | - |
| [ ] - | `itemAt` | 152 | - |
| [ ] - | `bind` | 158 | Every TrackItem of the unit in seq (looked up by track + index before anything moves). |
| [ ] - | `moveUnit` | 171 | Move all items of one unit by offset; returns problems (empty when every item landed). |
| [x] unit | `apply` | 188 | - |
| [ ] - | `inGroup` | 257 | ---- Own links (each camera clip with its own audio) ---- Links sel into one group and returns how many of sel are in sel[0]'s group... |
| [ ] - | `selectOnly` | 262 | - |
| [ ] - | `linkItems` | 263 | - |
| [x] unit | `relinkOwn` | 294 | - |
| [ ] - | `trackKey` | 329 | ---- Linking ---- One link group per anchor (the clip at the top of each placement chain: camera A for most). Premiere can't link two... |
| [ ] - | `addUnit` | 330 | - |
| [ ] - | `link` | 338 | - |
| [ ] - | `overlap` | 376 | - |
| [ ] - | `probe` | 382 | ---- Probe (test hook only, on a Synced copy) ---- |

## skills/interview-sync/syncmeasure.py

Sync Interviews measuring (sound, then picture motion for silent cameras). JSON in/out. Touches: ffmpeg/ffprobe reads.

Not run offline (33): called from a Premiere-side flow with real renders: Premiere run.

| Status | Function | Line | What it does |
|---|---|---|---|
| [ ] - | `say` | 89 | - |
| [ ] - | `_stop` | 93 | - |
| [ ] - | `run` | 102 | - |
| [ ] - | `probe` | 113 | {audio: number of audio streams, video: bool, duration, size} of path (cached). |
| [ ] - | `decode` | 138 | {stream: signal} for every audio stream of path over [start, start+dur], 2 kHz, in |
| [x] unit | `pick_channels` | 173 | Distinct, non-silent channels, loudest first. |
| [x] unit | `gcc` | 191 | Lag (samples) of piece inside sig (piece[0] at sig[lag]) and peak / next-best ratio. |
| [x] unit | `piece_spans` | 215 | (offset, length) of the pieces of a range L s long. |
| [ ] - | `match` | 222 | Best agreed lag of u against the candidate units. Returns (cand, L, how) or None, |
| [ ] - | `motion` | 282 | Movement per frame of path over [start, start+dur] at fps: log of the mean absolute |
| [ ] - | `vpiece_spans` | 298 | (offset, length) of the picture pieces of a range L s long: 3 of 120 s, or 2 halves-ish. |
| [ ] - | `vfeat` | 306 | Movement made comparable: minus its 1 s average (lighting drifts), in robust standard |
| [ ] - | `vxc` | 317 | Lag (frames) of piece inside sig, its score and the best score more than 1 s away |
| [ ] - | `picture_src` | 334 | File to read u's picture from: the proxy, else the media (not for audio clips). |
| [ ] - | `vmatch` | 342 | Picture match of u against the candidate clips: each piece of u (offset, movement) is |
| [ ] - | `choose_sources` | 379 | u["src"] and u["source"] (how) per unit; non-RED proxies checked against their original. |
| [ ] - | `check` | 394 | - |
| [ ] - | `sound_spread` | 424 | dB between loud and quiet moments (see SOUND_DB) of u's best channel, from 3 short |
| [ ] - | `sounds_agree` | 444 | L (as in match) when 2+ of 3 pieces of track b's longest clip land within AGREE of each |
| [ ] - | `choose_reference` | 466 | Keep camera A as the reference when its sound is usable; otherwise make the lowest |
| [ ] - | `usable` | 473 | - |
| [ ] - | `bps` | 504 | - |
| [ ] - | `main` | 509 | - |
| [ ] - | `whole` | 547 | - |
| [ ] - | `bits` | 548 | - |
| [ ] - | `read` | 562 | - |
| [ ] - | `read_whole` | 596 | - |
| [ ] - | `has_sound` | 603 | - |
| [ ] - | `curve_read` | 641 | - |
| [ ] - | `pieces_read` | 645 | - |
| [ ] - | `curve` | 653 | - |
| [ ] - | `tkey` | 676 | Timecode (clock model). Each track's clock offset to camera A's clock is learnt from its matched clips (chained through the clip each... |
| [ ] - | `aclock` | 692 | - |
| [ ] - | `root` | 714 | New starts: root of each group stays; children follow their parent. |
| [ ] - | `root_in` | 717 | - |
| [ ] - | `new_start` | 722 | - |

## skills/link-external-audio/premiere.jsx

Links each camera clip to its own audio and the wav under it on a TOOLKIT COPY, in pieces. Touches: selection and links on the copy only.

| Status | Function | Line | What it does |
|---|---|---|---|
| [x] unit | `PenyToolkit.skills["link-external-audio"]` | 11 | Link external audio: the saved skill "Link external audio to camera clips", run inside Premiere. For each camera clip on a video track:... |

## skills/loudness-master/measure.py

EBU R128 meter via ffmpeg ebur128. Takes: {wav, ffmpeg}. Gives: integrated, LRA, true/sample peak, duration.

End to end: run end to end on generated media (tests/python: LoudnessMeasure, EBU reference sine).

| Status | Function | Line | What it does |
|---|---|---|---|
| [x] unit | `find_ffmpeg` | 15 | - |
| [x] unit | `num` | 22 | - |
| [x] e2e | `measure` | 31 | - |

## skills/loudness-master/panel.js

Master for YouTube: master copy, render, measure, limiter loop to -14 LUFS / -1 dBTP.

Not run offline (15): runs real tools (ffmpeg/whisper/Ollama/REDline) after Premiere answers: Premiere run.

| Status | Function | Line | What it does |
|---|---|---|---|
| [x] unit | `BUNDLED` | 27 | Tools put in place by the one-click installer first (see Sound Pass); measure.py needs only the standard library, so any python3 does. |
| [x] unit | `firstExisting` | 39 | - |
| [ ] - | `boostValue` | 40 | - |
| [ ] - | `boostDb` | 41 | - |
| [ ] - | `maxValue` | 42 | - |
| [ ] - | `maxDb` | 43 | - |
| [ ] - | `r1` | 44 | - |
| [ ] - | `r2` | 45 | - |
| [ ] - | `localStamp` | 47 | "2026-10-24 11:11" in this Mac's time zone (toISOString would give UTC). |
| [ ] - | `sign` | 48 | - |
| [x] unit | `module.exports` | 52 | - |
| [ ] - | `measure` | 55 | - |
| [ ] - | `jsx` | 72 | - |
| [x] unit | `master` | 76 | - |
| [ ] - | `step` | 91 | - |
| [ ] - | `pass` | 94 | Sets the nest's limiter, renders the master and measures it (the wav is removed). |
| [ ] - | `render` | 105 | - |
| [ ] - | `onTarget` | 123 | - |
| [ ] - | `next` | 153 | - |

## skills/loudness-master/premiere.jsx

Master for YouTube, Premiere side: prepare the MASTER TOOLKIT COPY, limiter, render, marker.

Not run offline (18): needs Premiere's own objects (QE, Lumetri, encoder, bins) the fake does not model: Premiere run.

| Status | Function | Line | What it does |
|---|---|---|---|
| [x] unit | `T.skills["loudness-master"]` | 24 | - |
| [ ] - | `pick` | 41 | ExtendScript is ES3: arrays have no filter/map/forEach. |
| [ ] - | `sequenceForItem` | 42 | - |
| [ ] - | `sequenceByName` | 51 | - |
| [ ] - | `binOf` | 57 | The bin holding the project item with this nodeId (root if not found deeper). |
| [ ] - | `audioClips` | 66 | - |
| [ ] - | `channels` | 78 | - |
| [ ] - | `findComponent` | 82 | - |
| [ ] - | `prop` | 86 | - |
| [ ] - | `hlState` | 92 | - |
| [ ] - | `itemByNode` | 98 | - |
| [ ] - | `addLimiter` | 104 | Adds a Hard Limiter to the clip through QE (matched by track and start ticks). |
| [ ] - | `near` | 117 | - |
| [ ] - | `prepare` | 119 | - |
| [ ] - | `limit` | 169 | params.clips: [{track, nodeId}], params.bypass, params.boost, params.max (Hard Limiter values 0..1). |
| [ ] - | `render` | 196 | - |
| [ ] - | `marker` | 209 | - |
| [ ] - | `names` | 226 | Read only. Function and property names of QE / DOM objects, and every way tried to reach the master (Mix) track. |
| [ ] - | `probe` | 234 | - |

## skills/make-safe-copy/premiere.jsx

Make safe copy: '<name> TOOLKIT COPY' of the active sequence, opened; original checked unchanged.

| Status | Function | Line | What it does |
|---|---|---|---|
| [x] unit | `PenyToolkit.skills["make-safe-copy"]` | 3 | Make safe copy: duplicate the active sequence as "<name> TOOLKIT COPY" and open the copy, so later skills work on it and never on the... |

## skills/proxy-automation/panel.js

Proxies: plans and renders ProRes Proxy files (ffmpeg / REDline), then attaches or detaches them. Takes: bin, destination folder, speed. Touches: renders into the destination folder (never deletes), the job pool, ffprobe frame checks.

Not run offline (20): runs real tools (ffmpeg/whisper/Ollama/REDline) after Premiere answers: Premiere run.

| Status | Function | Line | What it does |
|---|---|---|---|
| [x] unit | `BUNDLED` | 25 | Tools put in place by the one-click installer (no Homebrew needed). Used first when present: they are the versions the toolkit was... |
| [ ] - | `firstExisting` | 34 | - |
| [ ] - | `q` | 35 | - |
| [ ] - | `extOf` | 36 | - |
| [ ] - | `stripExt` | 37 | - |
| [ ] - | `sourceBytes` | 39 | Source bytes, the ETA's work measure. A RED clip is _001.R3D, _002.R3D... in one folder. |
| [ ] - | `cameraOf` | 55 | - |
| [ ] - | `commonPrefix` | 63 | - |
| [x] unit | `module.exports` | 65 | - |
| [ ] - | `encodeCommand` | 82 | space, gamma, white balance/tint and ISO, as Premiere does for the R3D. Log clips (Komodo, V-Raptor: Log3G10/RWG) come out log; clips... |
| [ ] - | `indexProxies` | 110 | Whole-tree index of existing proxy files under root: lower-case base name -> [{file, dir}]. |
| [ ] - | `mediaSeconds` | 130 | - |
| [ ] - | `frameCount` | 144 | - |
| [ ] - | `brokenFrames` | 161 | A proxy with a different frame count than its source is broken, even though it looks finished (issue 1: the Orbea Canonball proxies lost... |
| [ ] - | `sameLength` | 173 | A proxy found away from the clip's own folder only counts if it is as long as the clip: two different files can share a name (Les Gets:... |
| [ ] - | `resolveProxy` | 183 | Same lookup order as the original findExistingProxyFile + resolveProxyFromGlobalIndex, but never climbing above the proxy root. Matches... |
| [x] unit | `checkRoot` | 205 | - |
| [x] unit | `listScope` | 214 | - |
| [ ] - | `plan` | 221 | Works out what to render without touching anything. |
| [ ] - | `brief` | 273 | - |
| [x] unit | `actions.render` | 281 | - |
| [ ] - | `limits` | 307 | Full / Half speed switch (Lee, 6 Nov 2026), read whenever a render could start. Half measured on the M4 Pro: 1 REDline uses ~7.5 of 14... |
| [ ] - | `onChange` | 315 | - |
| [ ] - | `onProgress` | 322 | Drives the overall progress bar: finished renders (real process exits) plus the running renders' own fractions; see core/jobs.js. |
| [x] unit | `actions.pause` | 371 | - |
| [x] unit | `actions.resume` | 376 | - |
| [x] unit | `actions.cancel` | 381 | - |
| [x] unit | `actions.attach` | 387 | - |
| [ ] - | `piece` | 404 | - |
| [x] unit | `actions.detach` | 426 | - |

## skills/proxy-automation/premiere.jsx

Proxies, Premiere side: lists clips with media and proxy state; attachProxy/detach. Touches: project items' proxy links.

Not run offline (14): needs Premiere's own objects (QE, Lumetri, encoder, bins) the fake does not model: Premiere run.

| Status | Function | Line | What it does |
|---|---|---|---|
| [ ] - | `extOf` | 20 | - |
| [ ] - | `inList` | 21 | - |
| [ ] - | `hasProxy` | 25 | hasProxy / getProxyPath are a property on some builds and a method on others (original panel, historical bug 1); handle both. |
| [ ] - | `proxyPath` | 28 | - |
| [ ] - | `itemById` | 40 | Finds a project item by nodeId: from the last listing if cached, else by walking the project. |
| [ ] - | `findBin` | 55 | - |
| [ ] - | `binFullPath` | 72 | Full bin path from the project root ("02 FOOTAGE/Korea / Seoul/Day2/Komodo"), so the proxy tree mirrors where the bin really sits, not... |
| [ ] - | `findBinByName` | 89 | Typed bin that is not a path from the root: accept it if exactly one bin has that name (or that full path, which matters when a bin name... |
| [ ] - | `scopeRoots` | 104 | - |
| [ ] - | `normPath` | 141 | Start-up-disk paths stored by Media Browser (/Volumes/Macintosh HD/Users/...) are compared as /Users/... (prefixes sent by the panel).... |
| [ ] - | `list` | 153 | - |
| [ ] - | `attach` | 196 | - |
| [ ] - | `detach` | 215 | - |
| [ ] - | `T.skills["proxy-automation"]` | 231 | - |

## skills/proxy-automation/red-proxy-finish.sh

Turns a REDline render into the final RED proxy (full-range levels, mono streams in R3D order). Touches: writes <name>_Proxy.mov, removes the REDline part file on success only.

End to end: run end to end on ffmpeg renders (tests/node/scripts.test.js).


## skills/selects-sequences/panel.js

Selects Setup: scan footage bins, plan UNCUT + Selects sequences by shoot date and camera, build them.

Not run offline (42): runs real tools (ffmpeg/whisper/Ollama/REDline) after Premiere answers: Premiere run.

| Status | Function | Line | What it does |
|---|---|---|---|
| [ ] - | `readSettings` | 36 | - |
| [ ] - | `writeSettings` | 40 | - |
| [x] unit | `findPreset` | 46 | The sequence preset: Premiere's own UHD 2160p 25 fps preset, found in this Mac's Premiere app (newest version first), else in the user's... |
| [x] unit | `walk` | 48 | - |
| [x] unit | `presetDirs` | 65 | - |
| [ ] - | `pad2` | 77 | - |
| [ ] - | `plural` | 78 | - |
| [ ] - | `fmtFrames` | 79 | - |
| [ ] - | `makePlan` | 86 | Plan from a scan + choices: per day the blocks in order, with their clips. Pure, so the test harness can check it without Premiere. |
| [ ] - | `view` | 135 | Blocks by camera (Lee, 23 Oct 2026): each group's clips split by the camera read from the files, so bins named B ROLE / PITS or a card... |
| [ ] - | `dayKey` | 165 | Groups by shoot date (Lee, 6 Nov 2026): every clip whose camera date is the same day goes in one group, whatever bin it sits in;... |
| [ ] - | `t` | 167 | - |
| [ ] - | `byDate` | 170 | - |
| [ ] - | `fmtDay` | 212 | - |
| [ ] - | `cameraText` | 214 | Cameras in a list of clips, most clips first: "Sony FX30 x42, not found x2". |
| [ ] - | `blockKeys` | 222 | Block keys (bin prefix, upper case) in timeline order: the saved order, then new ones in the order the bins first appear, audio-only... |
| [ ] - | `groupTitle` | 238 | A group's name in the sequence names: what Lee typed for it, else "Day 00" for a day bin or the bin's own name. |
| [ ] - | `label` | 244 | - |
| [ ] - | `prefixShown` | 248 | - |
| [ ] - | `colourOf` | 249 | - |
| [ ] - | `pickDup` | 251 | One answer for every clip in two groups: "first" / "last" group (scan order), "both", or a group label. |
| [ ] - | `duplicates` | 257 | - |
| [ ] - | `verify` | 274 | Checks one built UNCUT sequence against what was placed (read back from Premiere). |
| [ ] - | `scanTracks` | 281 | - |
| [x] unit | `module.exports` | 316 | - |
| [x] unit | `jsx` | 323 | - |
| [x] unit | `need` | 324 | - |
| [ ] - | `choiceFrom` | 326 | - |
| [ ] - | `save` | 341 | - |
| [x] unit | `doScan` | 351 | - |
| [ ] - | `nameGroupsByCamera` | 374 | A card or camera bin that is not a day, holding one camera's clips, is named after that camera to start with ("Sony FX30" instead of... |
| [ ] - | `summary` | 388 | - |
| [x] unit | `scanAction` | 398 | - |
| [x] unit | `progress` | 413 | - |
| [ ] - | `buildDay` | 422 | Builds one day's UNCUT: blocks back to back with the gap between, a marker over each block. |
| [x] unit | `build` | 489 | - |
| [ ] - | `el` | 559 | ---- Choices drawn under the buttons ---- |
| [ ] - | `addCss` | 560 | - |
| [ ] - | `persist` | 570 | - |
| [ ] - | `render` | 571 | - |
| [ ] - | `b.onclick` | 583 | - |
| [ ] - | `b.onclick` | 592 | - |
| [ ] - | `move` | 603 | - |
| [ ] - | `up.onclick` | 604 | - |
| [ ] - | `inp.onchange` | 607 | - |
| [ ] - | `sw.onclick` | 611 | - |
| [ ] - | `tg.onclick` | 615 | - |
| [ ] - | `b.onclick` | 643 | - |
| [ ] - | `b.onclick` | 652 | - |
| [ ] - | `gi.onchange` | 664 | - |
| [x] unit | `scan` | 684 | - |
| [x] unit | `build` | 685 | - |
| [x] unit | `cancel` | 686 | - |
| [ ] - | `busy` | 688 | - |
| [ ] - | `mount` | 689 | - |

## skills/selects-sequences/premiere.jsx

Selects Setup, Premiere side: scan bins, make sequences and place clips (new sequences only).

Not run offline (35): needs Premiere's own objects (QE, Lumetri, encoder, bins) the fake does not model: Premiere run.

| Status | Function | Line | What it does |
|---|---|---|---|
| [ ] - | `T.skills["selects-sequences"]` | 23 | - |
| [ ] - | `isBin` | 37 | - |
| [ ] - | `mediaPath` | 38 | - |
| [ ] - | `isSeqItem` | 39 | - |
| [ ] - | `childBins` | 40 | - |
| [ ] - | `byName` | 47 | Bin order = name order, as the Project panel sorts by Name (C0001 < C0002, A004 < A010). |
| [ ] - | `findBinPath` | 49 | - |
| [ ] - | `allBins` | 60 | - |
| [ ] - | `footageRoot` | 76 | The footage root: a path from the project root, a bin name that only one bin has, or (empty) the bin selected in the Project panel. |
| [ ] - | `fps` | 96 | - |
| [ ] - | `channels` | 100 | - |
| [ ] - | `offline` | 104 | - |
| [ ] - | `clipRecord` | 105 | - |
| [ ] - | `clipsIn` | 114 | Clips in a source bin: its own clips by name, then each nested bin's (by name), so a RED .RDM mag bin's clips come in mag order. |
| [ ] - | `prefixOf` | 130 | - |
| [ ] - | `hasGroupBins` | 135 | - |
| [ ] - | `source` | 140 | - |
| [ ] - | `looseClips` | 147 | - |
| [ ] - | `group` | 161 | One group = one Selects UNCUT + one Selects sequence. Any bin in the footage bin that holds bins of its own (a day, a card, a camera, a... |
| [ ] - | `scan` | 168 | - |
| [ ] - | `seqById` | 192 | - |
| [ ] - | `seqSettings` | 197 | - |
| [ ] - | `front` | 203 | - |
| [ ] - | `create` | 205 | - |
| [ ] - | `clipAt` | 230 | Clip on a track that starts at startTicks (within half a frame), or null. |
| [ ] - | `lastEnd` | 239 | - |
| [ ] - | `itemById` | 250 | Project items by nodeId, read fresh for each call: node ids are not stable once Premiere has switched between projects (23 Oct 2026: a... |
| [ ] - | `place` | 268 | params.startFrame + params.items [{ nodeId, audioTrack (index, for audio-only clips) }]: the clips go back to back from startFrame, each... |
| [ ] - | `addTrack` | 320 | One audio track at the bottom (QE addTracks; the sequence is opened first because QE works on the active sequence). params.kind: QE... |
| [ ] - | `marker` | 339 | - |
| [ ] - | `childBin` | 358 | - |
| [ ] - | `holds` | 364 | - |
| [ ] - | `bins` | 369 | params.moves: [{ sequenceId, to: "uncut" / "selects" }] |
| [ ] - | `readback` | 389 | - |
| [ ] - | `tracks` | 393 | - |

## skills/sound-pass/measure.py

Sound Pass meter: blocks/stats/phrases/level/bed/check modes. JSON in/out. Touches: ffmpeg reads, .npz files it is given.

Not run offline (22): called from a Premiere-side flow with real renders: Premiere run.

| Status | Function | Line | What it does |
|---|---|---|---|
| [ ] - | `blocks` | 30 | - |
| [ ] - | `band_power` | 59 | Mean power in BANDS for each 100 ms frame (rows of samples), Hann window. |
| [ ] - | `momentary` | 67 | Momentary loudness (LUFS, 400 ms window) every 100 ms, left channel, from ffmpeg's ebur128. |
| [ ] - | `summary` | 82 | - |
| [ ] - | `stats` | 97 | Speech windows are chosen per group (one speaker's source on one track; clips without a |
| [ ] - | `frames` | 148 | 100 ms loudness frames whose 400 ms window lies inside start..end (sequence seconds). |
| [ ] - | `word_frames` | 153 | Loudness frames that are clear speech: within `gate` dB of the render's 95th percentile. |
| [ ] - | `phrases` | 161 | Quiet stretches of speech to lift with Volume keyframes. Speech windows (dry render) use a |
| [ ] - | `level` | 207 | Even out the speech: a gain curve per clip (dB, relative to the `file` render) that |
| [ ] - | `emean` | 308 | Energy average of loudness values (dB). |
| [ ] - | `speech_mask` | 313 | Clear-speech frames of the voice clips: within WORD_GATE dB of their group's (speaker's) |
| [ ] - | `lin` | 333 | - |
| [ ] - | `bed` | 337 | Gain curve for the music / camera sound (the bed) so Lee's voice-to-bed balance stays |
| [ ] - | `balance` | 390 | Voice over bed (dB) on clear-speech moments that have a bed under them, before and after |
| [ ] - | `check` | 436 | Spots in the finished render that are worth a listen, so nobody has to sit through the |
| [ ] - | `side` | 489 | Cuts between consecutive voice clips. |
| [ ] - | `tone_bands` | 564 | Body / voice / presence of the given frames, each in dB relative to their sum. |
| [ ] - | `tone_spots` | 570 | - |
| [ ] - | `mix_spots` | 609 | Spots where the background under the voice changes at a voice cut. |
| [ ] - | `em` | 614 | - |
| [ ] - | `thin` | 639 | Fewest points whose straight lines stay within tol dB of the curve (Douglas-Peucker). |
| [ ] - | `main` | 657 | - |

## skills/sound-pass/panel.js

Sound Pass: renders, measures and keys voice levels on a TOOLKIT COPY.

Not run offline (14): runs real tools (ffmpeg/whisper/Ollama/REDline) after Premiere answers: Premiere run.

| Status | Function | Line | What it does |
|---|---|---|---|
| [x] unit | `BUNDLED` | 23 | Tools put in place by the one-click installer (no Homebrew needed). Used first when present: they are the versions the toolkit was... |
| [x] unit | `firstExisting` | 51 | - |
| [ ] - | `boostValue` | 52 | - |
| [ ] - | `maxValue` | 53 | - |
| [ ] - | `median` | 54 | - |
| [ ] - | `tc` | 56 | Sequence timecode hh:mm:ss:ff (seconds with one decimal when the frame rate is unknown). |
| [ ] - | `p` | 58 | - |
| [ ] - | `r2` | 61 | - |
| [ ] - | `fmt` | 62 | - |
| [x] unit | `module.exports` | 82 | - |
| [x] unit | `pythonWithNumpy` | 85 | - |
| [ ] - | `measure` | 93 | - |
| [ ] - | `jsx` | 108 | - |
| [x] unit | `run` | 112 | - |
| [ ] - | `step` | 128 | - |
| [ ] - | `pass` | 132 | Sets the clips (unless settings is null), renders the voice tracks and keeps the window levels of the render (the wav itself is removed). |
| [ ] - | `clipList` | 148 | - |
| [ ] - | `stats` | 150 | Speech stats per clip for the given renders, all on the same speech windows. |
| [ ] - | `range` | 312 | - |

## skills/sound-pass/premiere.jsx

Sound Pass, Premiere side: scan, copy, limiter, keys, markers, render (TOOLKIT COPY only).

Not run offline (24): needs Premiere's own objects (QE, Lumetri, encoder, bins) the fake does not model: Premiere run.

| Status | Function | Line | What it does |
|---|---|---|---|
| [x] unit | `T.skills["sound-pass"]` | 26 | - |
| [ ] - | `sequenceForItem` | 42 | - |
| [ ] - | `mediaPath` | 51 | - |
| [ ] - | `nestedWavs` | 55 | .wav files a nested sequence plays (unmuted tracks), depth-limited. |
| [ ] - | `findComponent` | 71 | - |
| [ ] - | `prop` | 75 | - |
| [ ] - | `hlState` | 81 | - |
| [ ] - | `volumeDb` | 89 | Volume > Level in dB (value 0.17783 = 0 dB: dB = 20 log10(v) + 15, checked by render). |
| [ ] - | `qeGains` | 100 | Clip gain is readable (not writable) through QE: staticClipGain, in dB. |
| [ ] - | `trackFilter` | 117 | "A5, A6", "A5 A6", "a5; a6", "5 and 6" -> {4: true, 5: true}; null for none. |
| [ ] - | `scan` | 125 | - |
| [ ] - | `copy` | 162 | - |
| [ ] - | `itemByNode` | 176 | - |
| [ ] - | `addLimiter` | 182 | Adds a Hard Limiter to the clip through QE (matched by track and start ticks). |
| [ ] - | `addEffect` | 183 | - |
| [ ] - | `near` | 196 | - |
| [x] unit | `set` | 199 | params.clips: [{track, nodeId, bypass, boost, max}] (boost/max are Hard Limiter values 0..1). |
| [x] unit | `render` | 238 | - |
| [x] unit | `keys` | 270 | params.clips: [{track, nodeId, keys: [{t: sequence seconds, db}], clear}] - Volume > Level keyframes on a TOOLKIT COPY, read back (key... |
| [ ] - | `ours` | 299 | - |
| [x] unit | `markers` | 300 | - |
| [ ] - | `bedProps` | 327 | Amplify's gain: Left / Right sliders on a stereo clip (Link Sliders on; both are set), Gain on mono. |
| [ ] - | `bedProp` | 332 | - |
| [ ] - | `lastComponent` | 333 | - |
| [ ] - | `bedValue` | 340 | Amplify Left/Right value <-> dB: 0.6667 = 0 dB, 144 dB per unit (renders 4 Nov 2026: 0.5 / 0.8 / 0.9 gave -24.0 / +19.2 / +33.6 dB on a... |
| [ ] - | `bedDb` | 341 | - |
| [ ] - | `bedInfo` | 342 | - |
| [ ] - | `hasOurMarkers` | 353 | - |
| [x] unit | `bed` | 360 | params.clips: [{track, nodeId, keys: [{t: sequence s, db}], add}] - on a TOOLKIT COPY: keys on our BED_FX gain (added when `add` or... |
| [x] unit | `addfx` | 397 | Test: params {track, nodeId, name} adds that audio effect to one clip of a TOOLKIT COPY. |
| [ ] - | `probe` | 405 | - |

## skills/sync-external-audio/measure.py

GCC-PHAT waveform match of camera audio in recorder wavs. Takes: JSON job on stdin. Gives: JSON results on stdout. Touches: ffmpeg decodes only.

End to end: run end to end on generated media (tests/python: SyncExternalAudioEndToEnd; stress_sync.py 1 h wav).

| Status | Function | Line | What it does |
|---|---|---|---|
| [x] e2e | `say` | 46 | - |
| [x] e2e | `decode` | 50 | - |
| [x] unit | `gcc_peak` | 61 | Lag (samples) of clip inside the signal whose rfft (size n) is sig_spec, searched |
| [x] unit | `peak_ratio` | 77 | - |
| [x] e2e | `channels` | 88 | Camera audio channels as {stream index: 2 kHz signal}, exact copies dropped. |
| [x] e2e | `fine` | 107 | Fine lag (seconds into the wav for the clip's in-point) for each channel. |
| [x] unit | `clock` | 126 | Seconds of day from a file name's HHMMSS (Canon H260703_153021, DJI DJI_38_20261005_020529). |
| [x] e2e | `clip_clocks` | 133 | The clip's camera clocks by kind: "tc" (RED Abs TC) and "ts" (RED Timestamp) from the |
| [x] e2e | `clip_clock` | 145 | One clock for ordering and reporting: TC, else Timestamp, else the name's. |
| [x] unit | `accept` | 154 | f: {channel: (seconds, ratio)}; coarse: {channel: seconds}. |
| [x] unit | `median` | 170 | - |
| [x] e2e | `offsets` | 175 | {(recording, clock kind): [(result, recorder time - camera clock)]} of synced clips. |
| [x] e2e | `clock_models` | 185 | Per recording: its length and, per clock kind whose clocks agree, the recorder-minus- |
| [x] e2e | `main` | 201 | - |

## skills/sync-external-audio/panel.js

Sync external audio, Node side: scan, measure.py, place. Touches: ffmpeg/REDline reads, a cache folder.

Not run offline (28): runs real tools (ffmpeg/whisper/Ollama/REDline) after Premiere answers: Premiere run.

| Status | Function | Line | What it does |
|---|---|---|---|
| [x] unit | `BUNDLED` | 17 | Tools put in place by the one-click installer (no Homebrew needed). Used first when present: they are the versions the toolkit was... |
| [x] unit | `firstExisting` | 23 | - |
| [ ] - | `q64` | 24 | - |
| [ ] - | `floor64` | 25 | - |
| [ ] - | `clock` | 26 | - |
| [ ] - | `clipClocks` | 28 | Same as measure.py clip_clocks: RED Abs TC ("tc") and Timestamp ("ts"), the file name's HHMMSS. |
| [ ] - | `clipClock` | 34 | - |
| [ ] - | `hms` | 35 | - |
| [ ] - | `spread` | 41 | Order for measuring: every 8th clip by camera clock, then every 4th between, 2nd, the rest. |
| [ ] - | `skipKind` | 54 | - |
| [ ] - | `usable` | 56 | Recordings usable for skipping: each must have agreeing time-of-day clocks. |
| [ ] - | `outside` | 62 | Why a clip is outside every recording by its time-of-day clock, or null. |
| [ ] - | `redlineAudio` | 87 | - |
| [ ] - | `run` | 91 | - |
| [ ] - | `exactFps` | 99 | Exact rates for the rounded ones REDline prints (23.976 -> 24000/1001). |
| [ ] - | `info` | 104 | - |
| [ ] - | `one` | 118 | - |
| [ ] - | `available` | 154 | - |
| [ ] - | `clocks` | 159 | Renders the sound of every clip with source "redline"; clips that fail are taken out of `clips` (in place) and added to `unread` with... |
| [ ] - | `worker` | 162 | - |
| [ ] - | `prepare` | 174 | - |
| [ ] - | `worker` | 180 | - |
| [ ] - | `cleanup` | 202 | Deletes the sound files this run wrote (~70 MB per 120 s clip). |
| [x] unit | `module.exports` | 206 | - |
| [ ] - | `pythonWithNumpy` | 207 | - |
| [ ] - | `duration` | 215 | - |
| [ ] - | `batched` | 231 | Camera-clock skip. Clips are measured in batches spread across the camera clock (every 8th clip first, then the ones between...), so... |
| [ ] - | `job` | 236 | - |
| [ ] - | `next` | 243 | - |
| [ ] - | `measure` | 268 | - |
| [x] unit | `sync` | 286 | - |
| [ ] - | `fmt` | 393 | - |

## skills/sync-external-audio/premiere.jsx

Sync external audio, Premiere side: reads camera clips and wavs; places wav pieces on a TOOLKIT COPY.

Not run offline (8): needs Premiere's own objects (QE, Lumetri, encoder, bins) the fake does not model: Premiere run.

| Status | Function | Line | What it does |
|---|---|---|---|
| [ ] - | `mediaPath` | 14 | - |
| [ ] - | `proxyPath` | 16 | Attached proxy (RED: ffmpeg can't read the sound inside an .R3D, the proxy has it). |
| [ ] - | `scan` | 21 | - |
| [ ] - | `busy` | 53 | - |
| [ ] - | `razorCam` | 65 | A clip whose sound runs across two wav files gets two pieces on the same wireless track (Lee: wireless audio always on one track).... |
| [ ] - | `halfAt` | 89 | Read back: a camera clip must now start at the cut on the video track and on each camera audio track, and both video halves must still... |
| [ ] - | `place` | 119 | - |
| [ ] - | `activate` | 191 | "place" works on the sequence "scan" read (sequenceId), not whichever is active then: Lee, 5 Nov 2026, the 12 min of measuring ended... |
| [x] unit | `PenyToolkit.skills["sync-external-audio"]` | 199 | - |

## tools/auto-commit-watcher.sh

Developer Macs: commits and pushes uncommitted changes on main after 3 quiet minutes.

Not run offline (2): installer/build/publish machine script: run on a Mac (verify_fresh_install.sh / build machine).

| Status | Function | Line | What it does |
|---|---|---|---|
| [ ] - | `log` | 30 | - |
| [ ] - | `commit_once` | 42 | commit_once: commit + push if there are changes quiet for $IDLE seconds. Exit 0: committed (or nothing to do in --once mode). Exit 1:... |

## tools/auto-publish.sh

Build Mac: publishes main to the office server.

Not run offline (1): installer/build/publish machine script: run on a Mac (verify_fresh_install.sh / build machine).

| Status | Function | Line | What it does |
|---|---|---|---|
| [ ] - | `log` | 16 | - |

## tools/build-installer.sh

Build Mac: builds the one-click installer zip.

Not run offline (1): installer/build/publish machine script: run on a Mac (verify_fresh_install.sh / build machine).

| Status | Function | Line | What it does |
|---|---|---|---|
| [ ] - | `say` | 32 | - |

## tools/bundle_macho.py

Copies Homebrew programs with their dylibs into a relocatable folder (installer build).

Not run offline (6): called from a Premiere-side flow with real renders: Premiere run.

| Status | Function | Line | What it does |
|---|---|---|---|
| [ ] - | `is_macho` | 29 | - |
| [ ] - | `run` | 39 | - |
| [ ] - | `load_commands` | 43 | -> (id or None, [dependency names], [rpaths]) |
| [ ] - | `resolve` | 68 | - |
| [ ] - | `main` | 84 | - |
| [ ] - | `excluded` | 93 | - |

## tools/publish-release.sh

Build Mac: copies a built installer to the office server and writes version.json.

Not run offline (1): installer/build/publish machine script: run on a Mac (verify_fresh_install.sh / build machine).

| Status | Function | Line | What it does |
|---|---|---|---|
| [ ] - | `put` | 55 | same size = already there; clone on the same disk (instant), plain copy otherwise |

