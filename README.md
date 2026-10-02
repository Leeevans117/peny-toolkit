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
   cd ~/PenyToolkit/com.peny.toolkit
   rsync -a --delete --exclude .git --exclude .gitignore ./ \
     "$HOME/Library/Application Support/Adobe/CEP/extensions/com.peny.toolkit/"
   ```

   `premiere.jsx` changes take effect on the next run (it is reloaded every time).
   New skills or `main.js`/`panel.js` changes need the panel closed and reopened
   (Window > Extensions > Peny Toolkit). Do not reload the page in place through the
   debug port: afterwards Node's fs.promises never resolves and replies from Premiere
   go missing.

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
| Make safe copy | Duplicates the active sequence as "<name> TOOLKIT COPY", checks the original is unchanged, opens the copy | Tested 2 Oct 2026 (TEST project) |
| Link external audio | Links each camera clip to its camera audio and the external wav under it; verifies each link; refuses non-copies | Tested 2 Oct 2026 on 3 groups (TEST project) |
| Proxies | Renders ProRes Proxy files (ffmpeg / REDline) into a folder tree mirroring the bins, attaches/detaches them; Pause/Resume/Cancel. Never deletes or overwrites a proxy; R3D wins a name clash; same media in two bins renders once | Port of Proxy Automation. Tested 2 Oct 2026 on a 2-clip scratch bin (Canon + R3D) in the TEST project: render, attach, detach, pause/resume, cancel. Not yet tested at scale |
| Ingest (import-footage) | Button runs the Ingest + proxies code path stopped after the import step (ingest-pipeline action "ingest"); Step 1 FOOTAGE sheet, then folder window. Imports a footage folder mirroring its tree as bins (port of Master Footage Importer CEP 2.0.0). RED clips import like Media Browser: R3D only; normal-speed clips carry their sound inside the R3D, slow-motion clips (75-240 fps) have none and their separate .wav is left out unless "Also import slow-motion RED .wav" is ticked. Skips Exports/Renders/Proxies/cache folders and files already in the project (including Media Browser imports stored as /Volumes/<start-up disk>/...). Optional linked R3D+wav sequences (off) | Tested 2 Oct 2026 in the TEST project on real Raptor clips: normal clip Movie 48 kHz 4 mono, slow-mo clip Video only, no wav imported, re-run and Media Browser re-import skipped |
| Ingest + proxies | Overall proxy progress bar (x of y, %) from real render exits plus REDline/ffmpeg per-clip fraction. One button: asks for the footage folder, then the proxy folder, then runs Import footage -> Proxies render -> Proxies attach on the imported bin; each stage must pass before the next; Pause/Resume/Cancel | Tested 2 Oct 2026 in the TEST project with Canon R5 MP4, Sony FX6 MXF and RED Raptor R3D (normal + slow-mo): 4 imported, 4 proxies rendered (ProRes 1280x720, audio channels matching), 4 attached and verified; re-run did nothing |
