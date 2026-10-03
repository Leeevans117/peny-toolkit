// Colour baseline, Premiere side. The panel (panel.js) calls this with params.action:
//   "scan"     - the active sequence's video clips that play a media file (read only), with each
//                clip's Lumetri effects (instance names, top to bottom) and the master clip's.
//   "presets"  - Premiere's Lumetri preset names (app.project.getAllLumetriPresetsList).
//   "copy"     - Make safe copy unless the active sequence already is a TOOLKIT COPY.
//   "apply"    - on a TOOLKIT COPY: params.groups [{camera, preset, clips:[{track,nodeId}]}] and
//                params.adjustments (preset name): selects the clips that still need each preset,
//                runs app.project.applyLumetriPreset, then reads every clip back.
//   "frame"    - exports one frame of a clip as PNG (test hook, to check a look shows).
//
// What Premiere 26.5.2 allows (tested 3 Oct 2026 in the TEST project):
//   - applyLumetriPreset(name) adds a new Lumetri Color to every selected timeline clip, at the
//     TOP of the clip's effects, with the preset's look loaded, and the effect is named after the
//     preset (Component.instanceName). It accepts only names in Premiere's Lumetri preset list;
//     a .cube path returns false.
//   - A script cannot load a LUT any other way: setValue on Look / Input LUT / their path and
//     blob params reads back but the picture does not change (blob strings stop at the first
//     null). displayName / instanceName writes are ignored, so an effect cannot be renamed.
// So the LUT preset goes on first and "Adjustments" second, which leaves Adjustments on top.
(function () {
  var T = PenyToolkit;
  var LUMETRI = "AE.ADBE Lumetri";
  var STILL_EXT = /\.(png|jpe?g|tiff?|psd|ai|gif|bmp|exr|dpx|tga|svg|heic)$/i;

  T.skills["colour-baseline"] = function (params) {
    var action = params.action || "scan";
    if (action === "presets") return presets();
    if (action === "copy") return copy();
    var seq = T.activeSequence();
    if (!seq) return T.fail("No active sequence. Open the sequence you want to grade first.");
    if (action === "scan") return scan(seq);
    if (action === "apply") return apply(seq, params);
    if (action === "frame") return frame(seq, params);
    return T.fail("Unknown action: " + action);
  };

  function mediaPath(pi) { try { return pi ? String(pi.getMediaPath()) : ""; } catch (e) { return ""; } }
  function metaField(pm, name) {
    var m = new RegExp("<premierePrivateProjectMetaData:Column\\." + name + ">([^<]*)<").exec(pm);
    return m ? m[1] : "";
  }
  function isLumetri(comp) { try { return String(comp.matchName) === LUMETRI; } catch (e) { return false; } }
  function instName(comp) { try { return String(comp.instanceName); } catch (e) { return ""; } }
  // Lumetri effects top to bottom, by instance name ("" = an unnamed Lumetri Color).
  function lumetris(components) {
    var out = [];
    for (var c = 0; c < components.numItems; c++) if (isLumetri(components[c])) out.push(instName(components[c]));
    return out;
  }
  function masterLumetris(pi) {
    try { var vc = pi.videoComponents(); return vc ? lumetris(vc) : []; } catch (e) { return null; }
  }

  function presetList() {
    var list = app.project.getAllLumetriPresetsList(), out = [];
    for (var i = 0; list && i < list.length; i++) out.push(String(list[i]));
    return out;
  }
  function presets() {
    var out = presetList();
    return T.ok(out.length + " Lumetri presets.", { presets: out });
  }

  function copy() {
    var seq = T.activeSequence();
    if (!seq) return T.fail("No active sequence.");
    if (T.isToolkitCopy(seq)) return T.ok("\"" + seq.name + "\" is already a TOOLKIT COPY; the grade goes on it.", { copyName: String(seq.name), copyId: String(seq.sequenceID), made: false });
    var file = new File(File($.fileName).parent.parent.fsName + "/make-safe-copy/premiere.jsx");
    if (!file.exists) return T.fail("Make safe copy skill not found at " + file.fsName);
    $.evalFile(file);
    var r = T.skills["make-safe-copy"]({});
    if (!r.ok) return r;
    if (!r.details.copyIsActive) return T.fail("The copy \"" + r.details.copyName + "\" was made but is not the active sequence. Open it and run again.", r.details);
    r.details.made = true;
    return r;
  }

  // Video clips that play a media file (not nested sequences, graphics, stills or adjustment layers).
  function scan(seq) {
    var clips = [], skipped = {};
    for (var t = 0; t < seq.videoTracks.numTracks; t++) {
      var tc = seq.videoTracks[t].clips;
      for (var c = 0; c < tc.numItems; c++) {
        var it = tc[c], pi = it.projectItem, p = mediaPath(pi), why = null;
        try { if (it.isAdjustmentLayer()) why = "adjustment layer"; } catch (e0) {}
        if (!why && !pi) why = "graphic / generated";
        if (!why) { try { if (pi.isSequence()) why = "nested sequence"; } catch (e1) {} }
        if (!why && !p) why = "no media file";
        if (!why && STILL_EXT.test(p)) why = "still image";
        if (why) { skipped[why] = (skipped[why] || 0) + 1; continue; }
        var pm = "";
        try { pm = String(pi.getProjectMetadata()); } catch (e2) {}
        clips.push({ track: t, nodeId: String(it.nodeId), name: String(it.name), start: it.start.seconds, path: p,
          codec: metaField(pm, "PropertyText\\.Codec"), videoInfo: metaField(pm, "Intrinsic\\.VideoInfo"),
          lumetri: lumetris(it.components), master: masterLumetris(pi) });
      }
    }
    var sk = [];
    for (var k in skipped) if (skipped.hasOwnProperty(k)) sk.push(skipped[k] + " " + k);
    return T.ok("Found " + clips.length + " video clip(s).", { sequence: String(seq.name), sequenceId: String(seq.sequenceID),
      isCopy: T.isToolkitCopy(seq), clips: clips, skipped: sk });
  }

  function trackItem(seq, track, nodeId) {
    var tr = seq.videoTracks[track];
    if (!tr) return null;
    for (var c = 0; c < tr.clips.numItems; c++) if (String(tr.clips[c].nodeId) === String(nodeId)) return tr.clips[c];
    return null;
  }
  function indexOf(list, name) { for (var i = 0; i < list.length; i++) if (list[i] === name) return i; return -1; }
  // A clip's LUT Lumetri: the first Lumetri named anything but the Adjustments name (a preset
  // applied earlier, or Lee's own "CANON LUT" / "RED LUT"). -1 when it has none.
  function lutIndex(list, adjustments) {
    for (var i = 0; i < list.length; i++) if (list[i] !== "" && list[i] !== adjustments) return i;
    return -1;
  }
  // Component count of every video clip, so the check can show nothing else changed.
  function counts(seq) {
    var out = {};
    for (var t = 0; t < seq.videoTracks.numTracks; t++) {
      var tc = seq.videoTracks[t].clips;
      for (var c = 0; c < tc.numItems; c++) out[t + ":" + tc[c].nodeId] = tc[c].components.numItems;
    }
    return out;
  }
  // Selects exactly the given clips, applies the preset, deselects. Returns null or an error.
  function applyTo(seq, items, preset) {
    if (!items.length) return null;
    T.deselectAll(seq);
    for (var i = 0; i < items.length; i++) items[i].setSelected(true, true);
    var ok = false;
    try { ok = app.project.applyLumetriPreset(preset); } catch (e) { T.deselectAll(seq); return "applyLumetriPreset threw: " + e; }
    T.deselectAll(seq);
    return ok ? null : "Premiere refused the preset \"" + preset + "\" (applyLumetriPreset returned false).";
  }

  function apply(seq, params) {
    if (!T.isToolkitCopy(seq)) return T.fail("The colour baseline only goes on a TOOLKIT COPY; \"" + seq.name + "\" is not one.");
    var adj = String(params.adjustments || "Adjustments"), groups = params.groups || [];
    var known = presetList(), knownSet = {};
    for (var k = 0; k < known.length; k++) knownSet[known[k]] = true;
    if (!knownSet[adj]) return T.fail("Premiere has no Lumetri preset called \"" + adj + "\", so the Adjustments effect cannot be added with that name. Save a plain Lumetri Color as an effect preset called \"" + adj + "\" first.", { adjustments: adj });
    for (var g0 = 0; g0 < groups.length; g0++) {
      if (groups[g0].preset && !knownSet[groups[g0].preset]) return T.fail("Premiere has no Lumetri preset called \"" + groups[g0].preset + "\" (chosen for " + groups[g0].camera + ").");
    }
    T.deselectAll(seq);
    var before = counts(seq), report = [], expect = {}, missing = [], errors = [], all = [];

    // 1. LUT preset, camera by camera (it goes on top of what the clip has).
    for (var g = 0; g < groups.length; g++) {
      var grp = groups[g], todo = [], has = 0, other = [];
      for (var i = 0; i < grp.clips.length; i++) {
        var ref = grp.clips[i], it = trackItem(seq, ref.track, ref.nodeId);
        if (!it) { missing.push(ref.nodeId); continue; }
        all.push({ ref: ref, camera: grp.camera, preset: grp.preset || null });
        if (!grp.preset) continue;
        var l0 = lumetris(it.components), cur = lutIndex(l0, adj);
        if (cur !== -1 && l0[cur] === grp.preset) has++;
        else if (cur !== -1) other.push({ name: String(it.name), lut: l0[cur] });
        else { todo.push(it); expect[ref.track + ":" + ref.nodeId] = 1; }
      }
      var err = grp.preset ? applyTo(seq, todo, grp.preset) : null;
      if (err) errors.push(grp.camera + ": " + err);
      report.push({ camera: grp.camera, preset: grp.preset || null, clips: grp.clips.length, added: err ? 0 : todo.length, already: has, otherLut: other });
    }
    // 2. Adjustments on every clip that has none yet (goes on top, above the LUT).
    var adjTodo = [], adjHas = 0;
    for (var a = 0; a < all.length; a++) {
      var it2 = trackItem(seq, all[a].ref.track, all[a].ref.nodeId);
      if (!it2) continue;
      if (indexOf(lumetris(it2.components), adj) !== -1) { adjHas++; continue; }
      adjTodo.push(it2);
      var key = all[a].ref.track + ":" + all[a].ref.nodeId;
      expect[key] = (expect[key] || 0) + 1;
    }
    var adjErr = applyTo(seq, adjTodo, adj);
    if (adjErr) errors.push("Adjustments: " + adjErr);

    // 3. Read back: every clip's Lumetri stack and order, and that no other clip changed.
    var after = counts(seq), wrong = [], stacks = [], okClips = 0;
    for (var b = 0; b < all.length; b++) {
      var r = all[b].ref, it3 = trackItem(seq, r.track, r.nodeId);
      if (!it3) continue;
      var l = lumetris(it3.components), ai = indexOf(l, adj), li = lutIndex(l, adj);
      var good = ai !== -1 && (li === -1 ? !all[b].preset : ai < li);
      if (good) okClips++;
      else wrong.push({ name: String(it3.name), track: "V" + (r.track + 1), lumetri: l });
      if (stacks.length < 12) stacks.push({ name: String(it3.name), camera: all[b].camera, lumetri: l });
    }
    var changedElsewhere = [], countMismatch = [];
    for (var kk in after) {
      if (!after.hasOwnProperty(kk)) continue;
      var diff = after[kk] - (before[kk] || 0);
      if (!expect[kk]) { if (diff !== 0) changedElsewhere.push(kk); }
      else if (!errors.length && diff !== expect[kk]) countMismatch.push(kk + " +" + diff + " (expected +" + expect[kk] + ")");
    }
    var lutAdded = 0;
    for (var rr = 0; rr < report.length; rr++) lutAdded += report[rr].added;
    var summary = "On \"" + seq.name + "\": LUT preset added to " + lutAdded + " clip(s), Adjustments to " + (adjErr ? 0 : adjTodo.length) +
      " (" + adjHas + " already had it); read back " + okClips + " of " + all.length + " clip(s) with Adjustments on top of their LUT.";
    var details = { sequence: String(seq.name), cameras: report, adjustments: { preset: adj, added: adjErr ? 0 : adjTodo.length, already: adjHas },
      readBack: { ok: okClips, total: all.length, wrong: wrong.slice(0, 30), examples: stacks }, missing: missing,
      changedElsewhere: changedElsewhere, countMismatch: countMismatch.slice(0, 30), errors: errors };
    var problems = errors.slice(0);
    if (wrong.length) problems.push(wrong.length + " clip(s) without Adjustments above a LUT");
    if (changedElsewhere.length) problems.push(changedElsewhere.length + " other clip(s) changed");
    if (countMismatch.length) problems.push(countMismatch.length + " clip(s) with an unexpected number of effects");
    return problems.length ? T.fail(summary + " Problems: " + problems.join("; "), details) : T.ok(summary, details);
  }

  function frame(seq, params) {
    app.enableQE();
    var it = trackItem(seq, params.track, params.nodeId);
    if (!it) return T.fail("Clip not found.");
    var at = parseFloat(it.start.ticks) + (params.at !== undefined ? T.ticks(params.at) : Math.round((parseFloat(it.end.ticks) - parseFloat(it.start.ticks)) / 2));
    seq.setPlayerPosition(String(at));
    var qs = qe.project.getActiveSequence(), tc = String(qs.CTI.timecode);
    qs.exportFramePNG(tc, params.path);
    var f = new File(params.path + ".png");
    for (var i = 0; i < 40 && !f.exists; i++) $.sleep(250);
    return f.exists ? T.ok("Frame " + tc + " written.", { path: f.fsName, timecode: tc }) : T.fail("Frame export did not appear: " + f.fsName);
  }
}());
