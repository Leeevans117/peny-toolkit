# Peny Toolkit

One Premiere Pro panel (Window > Extensions > Peny Toolkit) that holds all of Peny's
automations. Each automation is a **skill**: a folder under `com.peny.toolkit/skills/`.
The panel reads every `skills/*/skill.json` when it opens and draws a home screen with
one app tile per skill; tapping a tile opens that skill's view (< returns home).

- Source (git, local only): `~/PenyToolkit/com.peny.toolkit/`
- Installed copy: `~/Library/Application Support/Adobe/CEP/extensions/com.peny.toolkit/`
- Log: `~/Library/Logs/PenyToolkit.log`
- Installing on another Mac (one double-click, no GitHub): `docs/new-machine.md`, "One-click install";
  the installer is built and published to the office server by the build machine
  (`docs/build-machine.md`).

## Adding a skill

1. Make a folder `com.peny.toolkit/skills/<skill-id>/`.
2. Add `skill.json`:

   ```json
   {
     "id": "skill-id",
     "name": "Button label",
     "description": "One line shown on the card.",
     "entry": "premiere.jsx",
     "inputs": [ { "id": "start", "label": "From (optional)", "placeholder": "h:mm:ss" } ]
   }
   ```

   Input types: plain text (default), `"type": "folder"` (adds a Choose button),
   `"type": "checkbox"` (iOS-style toggle) or `"type": "segment"` (segmented control,
   `"options": [{"label", "value"} or {"label", "text": true, "placeholder"}]`; a text option
   shows a text box whose value is used). Values are passed to the skill as `params.<id>`.

   Tile and look: `"order"` (position on the home screen and its number key 1-9),
   `"icon": "icon.svg"` (white glyph inside the Peny folded-line frame: start every icon
   with `<path d="M22 28.5H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h18a3 3 0 0 1 3 3v24"
   stroke-width="2.2"/>` and keep the glyph inside x 8-24, y 8-24; drawn on the black Peny
   square, `"tint"` is ignored), `"subtitle"` (home row text; else the description's first
   sentence), `"progress": true` (the app reports its own progress; every other app gets
   a bar timed from its past runs in the History).
   Each action can have `"style": "primary" | "secondary" | "danger"` (white, grey,
   red outline) and `"prompts"` (folders asked for on click, each with an `"explain"` sheet).
   UI rules (Lee, 30 Oct 2026): home is the dashboard of tiles on the black-to-white fade;
   four styles (Studio default, Glass, Bold, Compact) set only CSS variables in index.html,
   picked with S or the half-circle button; motion (tile rise, press, view slide, bar sweep
   while running, all under 0.35 s) can be turned off with M and is off in Compact and
   when macOS asks for reduced motion. Blue = active/selected, green running, amber paused,
   red failed/destructive; numbers, times and paths in monospace.
   Opening an app (4 Nov 2026, smoother): the app's real screen grows out of the tapped
   icon inside a rounded window (clip-path), content settles from 86% around the icon, the
   icon's face fades off, home eases back and dims; curve cubic-bezier(0.2, 0, 0, 1),
   0.48 s open / 0.42 s close at Normal speed (Style sheet: Slow 1.5x, Normal, Fast 0.6x).
   Closing shrinks a still copy of the app back onto its icon. flipOpen/flipClose in main.js;
   Back, Esc, the logo or the home bar under every app reverse it. Icons are squircles
   (radius 22.5%). Panel text is not selectable except inputs, log, history and statuses.

3. Add `premiere.jsx` (ExtendScript, ES3: `var` only, no arrow functions, no JSON object):

   ```js
   PenyToolkit.skills["skill-id"] = function (params) {
     var T = PenyToolkit;
     var seq = T.activeSequence();
     if (!seq) return T.fail("No active sequence.");
     // ... do the work, then check it really happened ...
     return T.ok("What happened, in one line.", { any: "details" });
   };
   ```

   Helpers in `core/core.jsx`: `T.activeSequence()`, `T.isToolkitCopy(seq)`,
   `T.duplicateSequence(seq)`, `T.fingerprint(seq)`, `T.clipsOverlapping(seq, a, b)`,
   `T.linkedNodeIds(item)`, `T.deselectAll(seq)`, `T.parseTime(text, seq)`, `T.fmt(sec)`,
   `T.log(msg)`, `T.ok(summary, details)`, `T.fail(error, details)`.
   Keep everything under `PenyToolkit`: Premiere's ExtendScript engine is shared with
   every other panel (including the MCP bridge).

4. **Skills that need Node** (run ffmpeg, read lots of files, long jobs): also add
   `"panel": "panel.js"` and `"actions"` to `skill.json`. `panel.js` exports
   `function (api) { return { actions: { <id>: function (params) { return Promise } } } }`.
   `api.evalSkill(params)` calls your `premiere.jsx`, `api.jobs` is `core/jobs.js`
   (job pool with Pause/Resume/Cancel and stall/timeout kills), `api.log(msg)`,
   `api.status(text)`. Actions with `"control": true` (e.g. Pause) work while another
   action is running; `"confirm": "..."` asks first. See `skills/proxy-automation/`.

5. Install and reload:

   ```bash
   "$HOME/PenyToolkit/com.peny.toolkit/install.sh"
   ```

   It copies the panel into CEP (rsync, without .git and __pycache__), then asks the
   open panel to soft-reload (loader.js swaps main.js, skills and core.jsx in place;
   the page itself never reloads) and prints one line:
   `OK` / `DEFERRED (busy: ...)` (reloads by itself when the running action ends) /
   `ERROR ...` / `NO PANEL` (installed; it loads when the panel is opened). Exit 0 only on OK.

   `premiere.jsx` changes take effect on the next run anyway (it is reloaded every time).
   Changes to `loader.js` or `CSXS/manifest.xml` still need the panel closed and reopened
   (Window > Extensions > Peny Toolkit); a manifest change may need a Premiere restart
   (unverified). Do not reload the page in place through the debug port: afterwards
   Node's fs.promises never resolves and replies from Premiere go missing.

6. Commit: `git add -A && git commit -m "..."`.

## Rules every skill follows

- Never trust a "success" return from Premiere: read the result back and report what
  actually happened.
- Anything that edits a timeline runs only on a sequence whose name ends
  `TOOLKIT COPY` (made by **Make safe copy**).
- Never rename clips, or delete footage, proxies or project items. Never save the project, except Ingest + Proxies with "Save each project" on (Lee, 22 Oct 2026): only after its import, render and attach all passed, confirmed by the file on disk changing.
- Only one ExtendScript call at a time (the panel queues them).

## Testing without clicking

Write `/tmp/peny-toolkit/inbox/run.json`:

```json
{ "skill": "link-external-audio", "params": { "start": "0:41:25", "end": "0:43:14" }, "id": "t1" }
```

(add `"action": "render"` for skills with actions; the Ingest app's action is `"ingest"`, with
`"folder"` in params since the folder window only opens for button presses). The panel runs it through the same
code as the button and writes `/tmp/peny-toolkit/result.json` and `result-<id>.json`.

## Skills

How each skill works, and its full test notes: `docs/skills.md`. Read the skill's
section there before changing it.

| Skill | What it does | Last tested |
|---|---|---|
| Link External Audio (app) | Runs Make safe copy, Sync external audio, Link external audio in order | 2 Oct 2026, TEST project |
| Sync external audio | Lines up recorder wavs to camera clips by waveform (measure.py) | 5 Nov 2026, 172 Canon clips (Day 4); measure.py speed-up 10 Nov offline only |
| Make safe copy | Duplicates the active sequence as "<name> TOOLKIT COPY" | 2 Oct 2026, TEST project |
| Link external audio | Links each camera clip to its own audio and the wav under it | 2 Oct 2026, TEST project |
| Proxies | Renders ProRes Proxy files and attaches/detaches them | 2 Oct 2026, small bin only; not at scale |
| Ingest (import-footage) | Imports a footage folder as bins mirroring its tree | 2 Oct 2026, TEST project, real RED clips |
| Ingest + proxies | Import, then render and attach proxies, in one button | 2 Oct 2026, TEST project, Canon/Sony/RED |
| Interviews (interview-selects) | Transcribes, finds answers, makes "<sequence> Cut" with markers, cuts & raises the answers; Trim makes "<Cut> Trimmed" | 30 Oct 2026, Whistler; partly unverified |
| Interviews > Remove ums & uhs (unum) | Finds and cuts fillers on a "<sequence> No ums" copy | 23 Oct 2026, Episode_1_Korea; not checked by ear |
| Interviews > Sync Interviews (interview-sync) | Syncs a whole interview timeline by sound, then links | 29 Oct 2026, Whistler copies; some modes untested |
| Sound Pass | Evens out every phrase of the interview voice to -20 LUFS on a safe copy; keeps the music/camera balance | 6 Nov 2026, Main Assembly V8 audio test (6) TOOLKIT COPY, 230 voice clips |
| Master for YouTube (loudness-master) | Masters the whole mix to -14 LUFS / -1 dBTP on a master copy | 24 Oct 2026, Episode_1_Korea |
| Colour (colour-baseline) | Detects cameras, applies a LUT baseline grade on a GRADED copy; makes LUT presets | 3 Oct 2026, TEST project; picker not in real panel yet |
| Selects Setup (selects-sequences) | Builds UNCUT and empty Selects sequences per shoot date (or bin group) from a footage bin | 6 Nov 2026: by shoot date, Lee ran it on World Champs |
