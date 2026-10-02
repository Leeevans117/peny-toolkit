# Peny Toolkit

One Premiere Pro panel (Window > Extensions > Peny Toolkit) that holds all of Peny's
automations. Each automation is a **skill**: a folder under `com.peny.toolkit/skills/`.
The panel reads every `skills/*/skill.json` when it opens and draws a card for each.

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

   Input types: plain text (default) or `"type": "folder"` (adds a Browse button).
   Values are passed to the skill as `params.<id>`.

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

(add `"action": "render"` for skills with actions). The panel runs it through the same
code as the button and writes `/tmp/peny-toolkit/result.json` and `result-<id>.json`.

## Skills

| Skill | What it does | Status |
|---|---|---|
| Make safe copy | Duplicates the active sequence as "<name> TOOLKIT COPY", checks the original is unchanged, opens the copy | Tested 2 Oct 2026 (TEST project) |
| Link external audio | Links each camera clip to its camera audio and the external wav under it; verifies each link; refuses non-copies | Tested 2 Oct 2026 on 3 groups (TEST project) |
| Proxies | Renders ProRes Proxy files (ffmpeg / REDline) into a folder tree mirroring the bins, attaches/detaches them; Pause/Resume/Cancel. Never deletes or overwrites a proxy; R3D wins a name clash; same media in two bins renders once | Port of Proxy Automation. Tested 2 Oct 2026 on a 2-clip scratch bin (Canon + R3D) in the TEST project: render, attach, detach, pause/resume, cancel. Not yet tested at scale |
| Import footage | Imports a footage folder mirroring its tree as bins (port of Master Footage Importer CEP 2.0.0; walkLogic.js unchanged). RED .RDC = one clip + wav; skips Exports/Renders/Proxies/cache; skips files already in the project; Preview = plan only | Tested 2 Oct 2026 in the TEST project on a scratch folder (RDC + wav, orphan wav, mp4, Proxies folders, jpg, xml): preview, import, re-run skipped all 4. RED wav match without _NNN fixed and tested on a real Raptor pair. Linked R3D+wav sequences (Synced bin) tested end to end on the real pair: made, 0-frame offset, 5 clips linked, re-run skipped |
