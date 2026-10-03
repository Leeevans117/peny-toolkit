# Peny Toolkit

One Premiere Pro panel (Window > Extensions > Peny Toolkit) that holds all of Peny's
automations. Each automation is a **skill**: a folder under `com.peny.toolkit/skills/`.
The panel reads every `skills/*/skill.json` when it opens and draws a home screen with
one app tile per skill; tapping a tile opens that skill's view (< returns home).

- Source (git, local only): `~/PenyToolkit/com.peny.toolkit/`
- Installed copy: `~/Library/Application Support/Adobe/CEP/extensions/com.peny.toolkit/`
- Log: `~/Library/Logs/PenyToolkit.log`

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

   Tile and look: `"order"` (position on the home screen), `"icon": "icon.svg"` (white
   glyph, drawn on a rounded square), `"tint": ["#top", "#bottom"]` (icon gradient),
   `"progress": true` (shows the proxy progress bar above the log in this view).
   Each action can have `"style": "primary" | "secondary" | "danger"` (blue, grey glass,
   red pill) and `"prompts"` (folders asked for on click, each with an `"explain"` sheet).

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
   /Users/penymini1/PenyToolkit/com.peny.toolkit/install.sh
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
- Never save the project, rename clips, or delete footage, proxies or project items.
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

| Skill | What it does | Status |
|---|---|---|
| Link External Audio (app) | Three steps: 1 Make safe copy, 2 Sync external audio, 3 Link external audio. Make safe copy and Sync are hidden skills run from this app's buttons ("skill" on an action) | Tested 2 Oct 2026 in the TEST project on Lee's 2 Desktop Canon clips + 2 Rode wavs: both synced, D071 cut at 1:06.12, 3 pieces on A1, 3 halves/clips linked (6 items each, getLinkedItems), 2 parked wavs removed from the copy, original sequence untouched |
| Sync external audio | measure.py: GCC-PHAT, every camera channel separately (exact duplicates dropped), coarse in 10-min wav windows, fine +-3 s at 8 kHz; accepts only when two channels agree or coarse+fine agree with a strong peak; camera-clock second pass for short clips. Places pieces with in/out in ticks (rounded to frames by Premiere); all pieces on the wireless track; a clip crossing two wavs is cut there (QE razor, camera halves re-linked and checked) so each half links to its own piece. Link then removes the parked whole-wav copies (only timeline instances on the TOOLKIT COPY, unlinked, over no video, whose file is linked under a clip) | 14 La Thuile clips vs hand sync: 9 synced, all within 18 ms, 0 wrong, 5 left for hand sync |
| Make safe copy | Duplicates the active sequence as "<name> TOOLKIT COPY", checks the original is unchanged, opens the copy | Tested 2 Oct 2026 (TEST project) |
| Link external audio | Links each camera clip to its camera audio and the external wav under it; verifies each link; refuses non-copies | Tested 2 Oct 2026 on 3 groups (TEST project) |
| Proxies | Renders ProRes Proxy files (ffmpeg / REDline) into a folder tree mirroring the bins, attaches/detaches them; Pause/Resume/Cancel. Never deletes or overwrites a proxy; R3D wins a name clash; same media in two bins renders once | Port of Proxy Automation. Tested 2 Oct 2026 on a 2-clip scratch bin (Canon + R3D) in the TEST project: render, attach, detach, pause/resume, cancel. Not yet tested at scale |
| Ingest (import-footage) | Button runs the Ingest + proxies code path stopped after the import step (ingest-pipeline action "ingest"); Step 1 FOOTAGE sheet, then folder window. Imports a footage folder mirroring its tree as bins (port of Master Footage Importer CEP 2.0.0). RED clips import like Media Browser: R3D only; normal-speed clips carry their sound inside the R3D, slow-motion clips (75-240 fps) have none and their separate .wav is left out unless "Also import slow-motion RED .wav" is ticked. Skips Exports/Renders/Proxies/cache folders and files already in the project (including Media Browser imports stored as /Volumes/<start-up disk>/...). Optional linked R3D+wav sequences (off) | Tested 2 Oct 2026 in the TEST project on real Raptor clips: normal clip Movie 48 kHz 4 mono, slow-mo clip Video only, no wav imported, re-run and Media Browser re-import skipped |
| Ingest + proxies | Overall proxy progress bar (x of y, %) from real render exits plus REDline/ffmpeg per-clip fraction. One button: asks for the footage folder, then the proxy folder, then runs Import footage -> Proxies render -> Proxies attach on the imported bin; each stage must pass before the next; Pause/Resume/Cancel | Tested 2 Oct 2026 in the TEST project with Canon R5 MP4, Sony FX6 MXF and RED Raptor R3D (normal + slow-mo): 4 imported, 4 proxies rendered (ProRes 1280x720, audio channels matching), 4 attached and verified; re-run did nothing |
| Sound Pass | Levels interview voice on a safe copy like Lee's Assembly V1 (Hard Limiter on every voice clip, ceiling -6 dB on the master) but per clip: renders the voice tracks with exportAsMediaDirect (32-bit float preset wav-float.epr), measure.py takes each clip's median 400 ms speech peak; Input Boost = -6 dB minus that (within 6 dB of the source's usual boost; quieter clips = interviewer off-mic, usual boost only); the ceiling is moved by the gain measured after the clip (pan law -3 dB, track/master faders). Voice = clips playing a .wav (directly or nested) on unmuted tracks; "Voice tracks" input overrides. Clip gain is not scriptable (QE staticClipGain is read-only) so it is left as is. Mappings measured by render: Volume dB = 20log10(v)+15, Input Boost dB = (v-2/3)*150, Max Amplitude dB = (v-1)*100. "Ride quiet moments" (on by default): after levelling, stretches of clear speech (15 dB gate) whose 2 s level is more than 3 dB under -6 get Volume keyframes lifting them toward -7 dB (max +6, 150 ms ramps); off-mic/short clips and clips with existing Volume keyframes are not ridden | Tested 3 Oct 2026 in TEST (test hook, not by clicking): Tony Home IV, Chris_SeoulIV, Tahnee Home IV, Laura_IV_Seoul copies; all speech tops at -6.0 dB, medians -6.2 to -6.8 dB |
