// Colour baseline, Premiere side. The panel (panel.js) calls this with params.action:
//   "scan"       - the active sequence's video clips that play a media file (read only), with each
//                  clip's Lumetri effects by instance name: "lumetri" in trackItem.components order
//                  (bottom-up), "shown" as Effect Controls lists them (top = rendered first).
//                  trackItem.components (and QE) list a clip's effects in the reverse of
//                  Effect Controls / render order (proven 3 Oct 2026 by a B&W LUT render test).
//   "exportproj" - writes the active sequence to a .prproj file (Sequence.exportAsProject; the
//                  sequence itself is not changed).
//   "importseq"  - imports sequences from a .prproj (Project.importSequences) and lists the
//                  sequences that appeared.
//   "finish"     - names the imported graded sequence "<name> GRADED TOOLKIT COPY" (unique),
//                  opens it and scans it.
//   "frame", "setparam", "addplain" - test hook only.
//
// Why a round trip through a project file (tested 3 Oct 2026, Premiere 26.5.2, TEST project):
//   - a script cannot load a LUT into Lumetri (setValue on the Look / Input LUT / path / blob
//     params reads back but the picture does not change) and cannot rename an effect
//     (displayName / instanceName writes are ignored);
//   - app.project.applyLumetriPreset(name) only knows Premiere's 325 bundled Lumetri presets,
//     not presets Lee saved or imported, even after a restart.
//   A Lumetri written into a project file (lutpreset.py) with its LUT embedded and an instance
//   name does load, render (within 0.5/255 of ffmpeg lut3d) and show its name.
//   importSequences reuses the project's master clips; nested sequences the graded sequence uses
//   come in as extra copies.
(function () {
  var T = PenyToolkit;
  var LUMETRI = "AE.ADBE Lumetri";
  var STILL_EXT = /\.(png|jpe?g|tiff?|psd|ai|gif|bmp|exr|dpx|tga|svg|heic)$/i;
  var GRADED = "GRADED " + T.COPY_SUFFIX;

  T.skills["colour-baseline"] = function (params) {
    var action = params.action || "scan";
    if (action === "importseq") return importSeq(params);
    if (action === "finish") return finish(params);
    var seq = T.activeSequence();
    if (!seq) return T.fail("No active sequence. Open the sequence you want to grade first.");
    if (action === "scan") return scan(seq);
    if (action === "exportproj") return exportProj(seq, params);
    if (action === "frame") return frame(seq, params);
    if (action === "setparam") return setParam(seq, params);
    if (action === "addplain") return addPlain(seq, params);
    if (action === "qeorder") return qeOrder(seq, params);
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

  // Video clips that play a media file (not nested sequences, graphics, stills or adjustment layers).
  function scan(seq) {
    var clips = [], skipped = {}, nested = {};
    for (var t = 0; t < seq.videoTracks.numTracks; t++) {
      var tc = seq.videoTracks[t].clips;
      for (var c = 0; c < tc.numItems; c++) {
        var it = tc[c], pi = it.projectItem, p = mediaPath(pi), why = null;
        try { if (it.isAdjustmentLayer()) why = "adjustment layer"; } catch (e0) {}
        if (!why && !pi) why = "graphic / generated";
        if (!why) { try { if (pi.isSequence()) { why = "nested sequence"; nested[String(pi.name)] = true; } } catch (e1) {} }
        if (!why && !p) why = "no media file";
        if (!why && STILL_EXT.test(p)) why = "still image";
        if (why) { skipped[why] = (skipped[why] || 0) + 1; continue; }
        var pm = "";
        try { pm = String(pi.getProjectMetadata()); } catch (e2) {}
        clips.push({ track: t, nodeId: String(it.nodeId), item: String(pi.nodeId), name: String(it.name), start: it.start.seconds,
          startTicks: String(it.start.ticks), path: p, codec: metaField(pm, "PropertyText\\.Codec"),
          videoInfo: metaField(pm, "Intrinsic\\.VideoInfo"), lumetri: lumetris(it.components), shown: lumetris(it.components).reverse() });
      }
    }
    // Nested sequences on audio tracks too (they come in as copies with the graded sequence).
    for (var a = 0; a < seq.audioTracks.numTracks; a++) {
      var ac = seq.audioTracks[a].clips;
      for (var k = 0; k < ac.numItems; k++) { try { if (ac[k].projectItem && ac[k].projectItem.isSequence()) nested[String(ac[k].projectItem.name)] = true; } catch (e3) {} }
    }
    var sk = [], nl = [];
    for (var s in skipped) if (skipped.hasOwnProperty(s)) sk.push(skipped[s] + " " + s);
    for (var n in nested) if (nested.hasOwnProperty(n)) nl.push(n);
    return T.ok("Found " + clips.length + " video clip(s).", { sequence: String(seq.name), sequenceId: String(seq.sequenceID),
      isCopy: T.isToolkitCopy(seq), clips: clips, skipped: sk, nested: nl });
  }

  function trackItem(seq, track, nodeId) {
    var tr = seq.videoTracks[track];
    if (!tr) return null;
    for (var c = 0; c < tr.clips.numItems; c++) if (String(tr.clips[c].nodeId) === String(nodeId)) return tr.clips[c];
    return null;
  }

  function exportProj(seq, params) {
    var ok = seq.exportAsProject(params.path);
    return new File(params.path).exists ? T.ok("Exported \"" + seq.name + "\" to " + params.path, { returned: ok, sequenceId: String(seq.sequenceID) })
      : T.fail("exportAsProject wrote nothing (returned " + ok + ").");
  }

  function importSeq(params) {
    var before = {}, list = T.sequenceList(), i, r = null, err = null;
    for (i = 0; i < list.length; i++) before[String(list[i].sequenceID)] = true;
    try { r = app.project.importSequences(params.path, params.ids); } catch (e) { err = String(e); }
    list = T.sequenceList();
    var added = [];
    for (i = 0; i < list.length; i++) if (!before[String(list[i].sequenceID)]) added.push({ name: String(list[i].name), id: String(list[i].sequenceID) });
    if (err || !added.length) return T.fail("importSequences " + (err ? "threw " + err : "returned " + r) + "; no new sequence appeared.", { added: added });
    return T.ok(added.length + " sequence(s) imported.", { added: added, returned: r });
  }

  function finish(params) {
    var seq = T.findSequenceById(params.id);
    if (!seq) return T.fail("The imported sequence " + params.id + " is not in the project.");
    var base = String(params.base).replace(/\s*(\(\d+\)\s*)?(GRADED\s+)?TOOLKIT COPY$/, "").replace(/\s+$/, "");
    var wanted = base + " " + GRADED;
    for (var n = 2; T.sequenceNameExists(wanted) && String(seq.name) !== wanted && n < 100; n++) wanted = base + " (" + n + ") " + GRADED;
    seq.name = wanted;
    if (String(seq.name) !== wanted && seq.projectItem) seq.projectItem.name = wanted;
    try { app.project.openSequence(String(seq.sequenceID)); } catch (e) {}
    var active = T.activeSequence();
    if (!active || String(active.sequenceID) !== String(seq.sequenceID)) return T.fail("Imported as \"" + seq.name + "\" but it could not be opened.", { name: String(seq.name) });
    var r = scan(active);
    r.summary = "\"" + seq.name + "\" is open.";
    return r;
  }

  // ---- test hook only ----
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
  // Sets one param of the clip's n-th Lumetri (params.lumetri, from the top). TOOLKIT COPY only.
  function setParam(seq, params) {
    if (!T.isToolkitCopy(seq)) return T.fail("Only on a TOOLKIT COPY.");
    var it = trackItem(seq, params.track, params.nodeId), n = -1;
    if (!it) return T.fail("Clip not found.");
    for (var c = 0; c < it.components.numItems; c++) {
      if (!isLumetri(it.components[c])) continue;
      if (++n !== params.lumetri) continue;
      var pr = it.components[c].properties[params.prop], before = pr.getValue();
      pr.setValue(params.value, true);
      return T.ok(String(pr.displayName) + ": " + before + " -> " + it.components[c].properties[params.prop].getValue(), {});
    }
    return T.fail("No Lumetri #" + params.lumetri);
  }
  // QE's component list for a clip, with each component's Saturation (used to tell two Lumetri
  // effects apart after a marker value is set on one of them through the DOM).
  function qeOrder(seq, params) {
    var it = trackItem(seq, params.track, params.nodeId);
    if (!it) return T.fail("Clip not found.");
    app.enableQE();
    var qs = qe.project.getActiveSequence(), qt = qs.getVideoTrackAt(params.track), want = String(it.start.ticks), qi = null;
    for (var i = 0; i < qt.numItems; i++) { var x = qt.getItemAt(i); if (x && String(x.type) === "Clip" && String(x.start.ticks) === want) { qi = x; break; } }
    if (!qi) return T.fail("QE item not found.");
    var qe_ = [], dom = [];
    for (var k = 0; k < qi.numComponents; k++) {
      var qc = qi.getComponentAt(k), sat = null;
      try { sat = String(qc.getParamValue("Saturation", "00:00:00:00")); } catch (e) { sat = "-"; }
      qe_.push(String(qc.name) + " sat=" + sat);
    }
    for (var c = 0; c < it.components.numItems; c++) {
      var cm = it.components[c], s2 = "-";
      if (isLumetri(cm)) { try { s2 = String(cm.properties[16].getValue()); } catch (e2) {} }
      dom.push(String(cm.displayName) + (instName(cm) ? " (" + instName(cm) + ")" : "") + " sat=" + s2);
    }
    return T.ok("QE: " + qe_.join(" | ") + " || DOM: " + dom.join(" | "), { qe: qe_, dom: dom });
  }
  // A plain Lumetri Color added with QE (goes at the bottom). TOOLKIT COPY only.
  function addPlain(seq, params) {
    if (!T.isToolkitCopy(seq)) return T.fail("Only on a TOOLKIT COPY.");
    var it = trackItem(seq, params.track, params.nodeId);
    if (!it) return T.fail("Clip not found.");
    app.enableQE();
    var qs = qe.project.getActiveSequence(), qt = qs.getVideoTrackAt(params.track), want = String(it.start.ticks);
    for (var i = 0; i < qt.numItems; i++) {
      var qi = qt.getItemAt(i);
      if (qi && String(qi.type) === "Clip" && String(qi.start.ticks) === want) { qi.addVideoEffect(qe.project.getVideoEffectByName("Lumetri Color")); break; }
    }
    it = trackItem(seq, params.track, params.nodeId);
    return T.ok("Lumetri stack: " + lumetris(it.components).join(" | "), { lumetri: lumetris(it.components) });
  }
}());
