// Master for YouTube (loudness-master), Premiere side. The panel (panel.js) calls this with params.action:
//   "prepare" - the active sequence S (or, when a "<S> MASTER <label>" sequence is active, the
//               sequence nested in it): makes "<S> MASTER <label> TOOLKIT COPY" in S's bin with S nested as one
//               clip (app.project.createNewSequenceFromClips), or reuses it when it already nests S,
//               opens it and lists its audio clips. S itself is never changed.
//   "limit"   - on a MASTER sequence: gives each listed audio clip one Hard Limiter (added with QE
//               if it has none) and sets Bypass / Input Boost / Maximum Amplitude, then reads them
//               back (Look-Ahead and Release keep their defaults).
//   "render"  - on a MASTER sequence: renders its whole audio, tracks as they are, to a 32-bit float
//               wav with exportAsMediaDirect, then restores in/out.
//   "marker"  - on a MASTER sequence: replaces the "Mastered " marker at 0 with params.name/comment.
//   "probe"   - read only: function names on the QE sequence and a QE audio track, and any
//               master/Mix track QE or the DOM exposes (nothing is added).
// Hard Limiter values (measured by render for Sound Pass on Premiere 26.5.2, 3 Oct 2026):
//   Input Boost dB = (v - 2/3) * 150, Maximum Amplitude dB = (v - 1) * 100.
(function () {
  var T = PenyToolkit;
  var HL = "Hard Limiter";
  // The master is named "<S> MASTER <label> TOOLKIT COPY": the working rules let timeline
  // edits run only on a sequence whose name ends TOOLKIT COPY.
  var MASTER_RE = / MASTER [^\/]+ TOOLKIT COPY$/;
  var MARK = "Mastered ";

  T.skills["loudness-master"] = function (params) {
    var action = params.action || "prepare";
    var seq = T.activeSequence();
    if (!seq) return T.fail("No active sequence. Open the sequence to master first.");
    if (action === "prepare") return prepare(seq, params);
    if (action === "probe") return probe(seq, params);
    if (!MASTER_RE.test(String(seq.name)) || !T.isToolkitCopy(seq)) return T.fail("\"" + seq.name + "\" is not a MASTER sequence; only the master is changed.");
    if (action === "limit") return limit(seq, params);
    if (action === "render") return render(seq, params);
    if (action === "marker") return marker(seq, params);
    return T.fail("Unknown action: " + action);
  };

  // ExtendScript is ES3: arrays have no filter/map/forEach.
  function pick(list, fn) { var out = []; for (var i = 0; i < list.length; i++) if (fn(list[i])) out.push(list[i]); return out; }
  function sequenceForItem(projectItem) {
    if (!projectItem) return null;
    try { if (!projectItem.isSequence()) return null; } catch (e) { return null; }
    var list = T.sequenceList(), id = String(projectItem.nodeId);
    for (var i = 0; i < list.length; i++) {
      try { if (list[i].projectItem && String(list[i].projectItem.nodeId) === id) return list[i]; } catch (e2) {}
    }
    return null;
  }
  function sequenceByName(name) {
    var list = T.sequenceList();
    for (var i = 0; i < list.length; i++) if (String(list[i].name) === name) return list[i];
    return null;
  }
  // The bin holding the project item with this nodeId (root if not found deeper).
  function binOf(bin, nodeId, depth) {
    if (depth > 20) return null;
    for (var i = 0; i < bin.children.numItems; i++) {
      var c = bin.children[i];
      if (String(c.nodeId) === nodeId) return bin;
      if (c.type === ProjectItemType.BIN) { var f = binOf(c, nodeId, depth + 1); if (f) return f; }
    }
    return null;
  }
  function audioClips(seq) {
    var out = [];
    for (var t = 0; t < seq.audioTracks.numTracks; t++) {
      var clips = seq.audioTracks[t].clips;
      for (var c = 0; c < clips.numItems; c++) {
        var it = clips[c], n = sequenceForItem(it.projectItem);
        out.push({ track: t, nodeId: String(it.nodeId), name: String(it.name), start: it.start.seconds, end: it.end.seconds,
          nests: n ? String(n.sequenceID) : null, hl: hlState(it) });
      }
    }
    return out;
  }
  function channels(seq) {
    try { var s = seq.getSettings(); return { type: s.audioChannelType, count: s.audioChannelCount, rate: String(s.audioSampleRate && s.audioSampleRate.seconds ? Math.round(1 / s.audioSampleRate.seconds) : s.audioSampleRate) }; }
    catch (e) { return { error: String(e) }; }
  }
  function findComponent(it, name) {
    for (var c = 0; c < it.components.numItems; c++) if (String(it.components[c].displayName) === name) return it.components[c];
    return null;
  }
  function prop(comp, name, index) {
    for (var p = 0; p < comp.properties.numItems; p++) {
      if (index !== undefined ? p === index : String(comp.properties[p].displayName) === name) return comp.properties[p];
    }
    return null;
  }
  function hlState(it) {
    var n = 0, first = null;
    for (var c = 0; c < it.components.numItems; c++) if (String(it.components[c].displayName) === HL) { n++; if (!first) first = it.components[c]; }
    if (!first) return { count: 0 };
    return { count: n, bypass: prop(first, "", 0).getValue(), boost: prop(first, "Input Boost").getValue(), max: prop(first, "Maximum Amplitude").getValue() };
  }
  function itemByNode(seq, track, nodeId) {
    var clips = seq.audioTracks[track].clips;
    for (var c = 0; c < clips.numItems; c++) if (String(clips[c].nodeId) === String(nodeId)) return clips[c];
    return null;
  }
  // Adds a Hard Limiter to the clip through QE (matched by track and start ticks).
  function addLimiter(seq, track, item) {
    app.enableQE();
    var qs = qe.project.getActiveSequence();
    if (!qs || String(qs.name) !== String(seq.name)) return "QE active sequence is not " + seq.name;
    var fx = qe.project.getAudioEffectByName(HL);
    if (!fx) return "QE has no audio effect named " + HL;
    var qt = qs.getAudioTrackAt(track), want = String(item.start.ticks);
    for (var i = 0; i < qt.numItems; i++) {
      var qi = qt.getItemAt(i);
      if (qi && String(qi.type) === "Clip" && String(qi.start.ticks) === want) { qi.addAudioEffect(fx); return null; }
    }
    return "QE item not found at " + T.fmt(item.start.seconds);
  }
  function near(a, b) { return Math.abs(Number(a) - Number(b)) < 0.0005; }

  function prepare(active, params) {
    var label = String(params.label || "YouTube");
    var src = active, srcFromMaster = false;
    if (MASTER_RE.test(String(active.name))) {
      var nested = pick(audioClips(active), function (c) { return c.nests; });
      if (!nested.length) return T.fail("\"" + active.name + "\" looks like a master but nests no sequence. Open the sequence to master.");
      src = T.findSequenceById(nested[0].nests);
      if (!src) return T.fail("The sequence nested in \"" + active.name + "\" was not found.");
      srcFromMaster = true;
    }
    var srcName = String(src.name), srcId = String(src.sequenceID), srcItem = src.projectItem;
    if (!srcItem) return T.fail("\"" + srcName + "\" has no project item to nest.");
    // "<S> MASTER <label> TOOLKIT COPY", with S's own " TOOLKIT COPY" left off so it is not
    // there twice; a master made under the longer name (first run, 24 Oct 2026) is reused.
    var base = T.isToolkitCopy(src) ? srcName.substr(0, srcName.length - T.COPY_SUFFIX.length).replace(/\s+$/, "") : srcName;
    var name = base + " MASTER " + label + " " + T.COPY_SUFFIX, made = false;
    var master = sequenceByName(name) || sequenceByName(srcName + " MASTER " + label + " " + T.COPY_SUFFIX);
    if (master) {
      name = String(master.name);
      var nests = pick(audioClips(master), function (c) { return c.nests === srcId; });
      if (!nests.length) return T.fail("A sequence named \"" + name + "\" exists but does not nest \"" + srcName + "\". Rename or remove it and run again.");
    } else {
      var before = T.fingerprint(src);
      var bin = binOf(app.project.rootItem, String(srcItem.nodeId), 0) || app.project.rootItem;
      var res = null, err = null;
      try { res = app.project.createNewSequenceFromClips(name, [srcItem], bin); } catch (e) { err = String(e); }
      master = sequenceByName(name);
      if (!master) return T.fail("Could not make \"" + name + "\" with createNewSequenceFromClips: " + (err || String(res)));
      made = true;
      var after = T.fingerprint(T.findSequenceById(srcId));
      if (after.hash !== before.hash || after.clips !== before.clips) return T.fail("\"" + srcName + "\" changed while its master was made; check it (undo).", { before: before, after: after });
    }
    if (String(app.project.activeSequence ? app.project.activeSequence.sequenceID : "") !== String(master.sequenceID)) {
      try { app.project.openSequence(master.sequenceID); } catch (e2) {}
      try { if (String(app.project.activeSequence.sequenceID) !== String(master.sequenceID)) app.project.activeSequence = master; } catch (e3) {}
    }
    var act = T.activeSequence();
    if (!act || String(act.sequenceID) !== String(master.sequenceID)) return T.fail("\"" + name + "\" was " + (made ? "made" : "found") + " but could not be made the active sequence. Open it and run again.");
    var clips = audioClips(master);
    var nestClips = pick(clips, function (c) { return c.nests === srcId; });
    var others = clips.length - nestClips.length;
    var d = { master: name, masterId: String(master.sequenceID), made: made, source: srcName, sourceId: srcId, sourceFromMaster: srcFromMaster,
      clips: nestClips, otherAudioClips: others, audioTracks: master.audioTracks.numTracks, channels: channels(master), sourceChannels: channels(src),
      duration: T.sec(master.end), sourceDuration: T.sec(src.end), fps: T.sequenceFps ? T.sequenceFps(master) : null };
    if (!nestClips.length) return T.fail("\"" + name + "\" has no audio clip of \"" + srcName + "\".", d);
    if (others) return T.fail("\"" + name + "\" has " + others + " audio clip(s) besides the nest; the master must hold only the nest.", d);
    return T.ok((made ? "Made" : "Reusing") + " \"" + name + "\" (" + nestClips.length + " nest audio clip(s)).", d);
  }

  // params.clips: [{track, nodeId}], params.bypass, params.boost, params.max (Hard Limiter values 0..1).
  function limit(seq, params) {
    var list = params.clips || [], out = [], added = 0, bad = 0;
    for (var i = 0; i < list.length; i++) {
      var c = list[i], it = itemByNode(seq, c.track, c.nodeId);
      if (!it) { out.push({ nodeId: c.nodeId, error: "clip not found" }); bad++; continue; }
      var comp = findComponent(it, HL);
      if (!comp) {
        var err = addLimiter(seq, c.track, it);
        it = itemByNode(seq, c.track, c.nodeId);
        comp = it ? findComponent(it, HL) : null;
        if (!comp) { out.push({ nodeId: c.nodeId, error: err || "Hard Limiter did not appear" }); bad++; continue; }
        added++;
      }
      if (params.boost !== undefined) prop(comp, "Input Boost").setValue(params.boost, true);
      if (params.max !== undefined) prop(comp, "Maximum Amplitude").setValue(params.max, true);
      prop(comp, "", 0).setValue(!!params.bypass, true);
      it = itemByNode(seq, c.track, c.nodeId);
      var s = hlState(it);
      s.nodeId = c.nodeId;
      s.matches = s.count >= 1 && !!s.bypass === !!params.bypass && (params.boost === undefined || near(s.boost, params.boost)) && (params.max === undefined || near(s.max, params.max));
      out.push(s);
    }
    var r = bad ? T.fail(bad + " of " + list.length + " clip(s) have no Hard Limiter.") : T.ok(list.length + " limiter(s) set and read back.");
    r.details.clips = out; r.details.added = added;
    return r;
  }

  function render(seq, params) {
    var oldIn = seq.getInPoint(), oldOut = seq.getOutPoint();
    seq.setInPoint("0");
    seq.setOutPoint(String(seq.end));
    var t0 = new Date().getTime(), res = null, err = null;
    try { res = seq.exportAsMediaDirect(params.path, params.preset, 1); } catch (e1) { err = String(e1); }
    var ms = new Date().getTime() - t0;
    try { seq.setInPoint(String(oldIn)); seq.setOutPoint(String(oldOut)); } catch (e3) {}
    var f = new File(params.path);
    if (err || !f.exists) return T.fail("Render failed: " + (err || String(res)), { ms: ms });
    return T.ok("Rendered " + T.fmt(T.sec(seq.end)) + " of audio in " + (ms / 1000).toFixed(1) + " s.", { path: params.path, bytes: f.length, ms: ms, result: String(res), duration: T.sec(seq.end) });
  }

  function marker(seq, params) {
    var mc = seq.markers, old = [], m = mc.getFirstMarker(), others = 0, i;
    while (m) { if (String(m.name).indexOf(MARK) === 0) old.push(m); else others++; m = mc.getNextMarker(m); }
    for (i = 0; i < old.length; i++) mc.deleteMarker(old[i]);
    var k = mc.createMarker(0);
    k.name = String(params.name);
    k.comments = String(params.comment || "");
    var now = 0, kept = 0;
    m = mc.getFirstMarker();
    while (m) { if (String(m.name).indexOf(MARK) === 0) now++; else kept++; m = mc.getNextMarker(m); }
    var d = { removed: old.length, now: now, othersKept: kept, othersBefore: others };
    if (now !== 1 || kept !== others || String(k.name) !== String(params.name)) return T.fail("Master marker did not read back.", d);
    return T.ok("Marker \"" + params.name + "\" at 0.", d);
  }

  // Read only. Function and property names of QE / DOM objects, and every way tried to reach
  // the master (Mix) track.
  function names(o) {
    var out = [];
    if (!o) return out;
    try { var ms = o.reflect.methods; for (var i = 0; i < ms.length; i++) out.push(String(ms[i].name) + "()"); } catch (e) {}
    try { var ps = o.reflect.properties; for (var j = 0; j < ps.length; j++) out.push(String(ps[j].name)); } catch (e2) {}
    if (!out.length) { try { for (var k in o) out.push(k); } catch (e3) {} }
    return out;
  }
  function probe(seq) {
    var d = { sequence: String(seq.name) };
    app.enableQE();
    var qs = qe.project.getActiveSequence();
    d.qeSequence = names(qs);
    d.qeProject = names(qe.project);
    var qt = null;
    try { qt = qs.getAudioTrackAt(0); } catch (e) { d.qeTrackError = String(e); }
    d.qeAudioTrack = names(qt);
    try { d.qeNumAudioTracks = qs.numAudioTracks; } catch (e1) {}
    var tries = {};
    var cands = ["getMasterTrack", "getMasterAudioTrack", "getAudioMasterTrack", "getMixTrack", "getSubmixTrack"];
    for (var i = 0; i < cands.length; i++) {
      try { var f = qs[cands[i]]; if (typeof f === "function") { var r = f.call(qs); tries["qe." + cands[i]] = r ? names(r).slice(0, 60) : String(r); } else tries["qe." + cands[i]] = "not a function"; }
      catch (e2) { tries["qe." + cands[i]] = "threw " + String(e2); }
    }
    try { var n = qs.numAudioTracks, past = qs.getAudioTrackAt(n); tries["qe.getAudioTrackAt(numAudioTracks)"] = past ? names(past).slice(0, 60) : String(past); }
    catch (e3) { tries["qe.getAudioTrackAt(numAudioTracks)"] = "threw " + String(e3); }
    d.domSequence = names(seq);
    d.domAudioTrack = names(seq.audioTracks[0]);
    try { tries["dom.audioTracks[numTracks]"] = String(seq.audioTracks[seq.audioTracks.numTracks]); } catch (e4) { tries["dom.audioTracks[numTracks]"] = "threw " + String(e4); }
    var domCands = ["masterTrack", "getMasterTrack", "masterAudioTrack"];
    for (var j = 0; j < domCands.length; j++) {
      try { var v = seq[domCands[j]]; tries["dom." + domCands[j]] = typeof v === "function" ? String(v.call(seq)) : String(v); } catch (e5) { tries["dom." + domCands[j]] = "threw " + String(e5); }
    }
    d.masterTries = tries;
    try { d.qeAudioEffects = { hardLimiter: !!qe.project.getAudioEffectByName(HL), loudnessMeter: !!qe.project.getAudioEffectByName("Loudness Meter") }; } catch (e6) { d.qeAudioEffects = String(e6); }
    return T.ok("Probe (read only).", d);
  }
}());
