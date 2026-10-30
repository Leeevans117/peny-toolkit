// Interview Selects, Premiere side. The panel (panel.js) calls this with params.action:
//   "scan"  - the active sequence's audio as plain segments (file, in, start, end), following
//             nested sequences, so ffmpeg can rebuild the sound in sequence time. Read only.
//   "copy"  - duplicates the active sequence as "<name> Cut version" and opens it, unless the
//             active sequence already has "Cut version" in its name (Lee, 20 Oct 2026).
//   "mark"  - on a Cut version: one Chapter marker per question, one Segmentation marker per
//             broad theme, and the small topics as clip markers (see TOPICS below), read back.
//   "cutraise" - on a Cut version only: cuts at each question's answer, raises it one track,
//             removes everything between the answers, then a row of adjustment layers named
//             after the questions and a row above it named after the themes.
//   "unum"  - "Remove ums & uhs": duplicates the active sequence (or Cut version) as
//             "<name> No ums", opens it and extracts each filler span (panel.js finds them)
//             from every track, back to front, like the trim; markers move, links are
//             restored and checked, and a marker marks each cut.
//   "probe", "dump" - read-only checks used through the test hook (jsxAction).
(function () {
  var T = PenyToolkit;

  T.skills["interview-selects"] = function (params) {
    // A job stays on the sequence it started on (Lee, 30 Oct 2026: he works on other sequences
    // while it runs): panel.js passes its id on every call after the first.
    var was = T.activeSequence(), seq = params.sequenceId ? T.findSequenceById(params.sequenceId) : was;
    if (params.sequenceId && !seq) return T.fail("The sequence this job started on (" + (params.sequenceName || params.sequenceId) + ") is no longer in the open project, so nothing was changed. If you closed it or moved to another project, bring it back and run again.");
    if (!seq) return T.fail("No active sequence. Open the interview sequence first.");
    var action = params.action || "scan";
    if (action === "scan") return scan(seq, params);
    if (action === "copy") return backToLee(was, seq, copy(seq));
    if (action === "unum") return backToLee(was, seq, unum(seq, params));
    if (action === "mark") return mark(seq, params);
    if (action === "renderaudio") return renderAudio(seq, params);
    if (action === "probe") return probe(seq, params);
    if (action === "dump") return T.ok("Pieces " + params.a + "-" + params.b, { pieces: around(seq, params.a, params.b) });
    if (action === "cutraise") return backToLee(was, seq, cutraise(seq, params));
    if (action === "untest") return untest(params);
    if (action === "renote") return renote(seq, params);
    if (action === "unbase") return unbase(params);
    if (action === "layerprobe") return layerprobe(seq, params);
    if (action === "rmprobe") {
      if (!isCut(seq)) return T.fail("Only on a Cut version.");
      var gone = 0, vt0 = seq.videoTracks;
      for (var ti0 = 0; ti0 < vt0.numTracks; ti0++) for (var ci0 = vt0[ti0].clips.numItems - 1; ci0 >= 0; ci0--) {
        var c0 = vt0[ti0].clips[ci0];
        if (String(c0.name) === "Layer probe" && isAdjClip(c0)) { c0.remove(false, false); gone++; }
      }
      return T.ok(gone + " probe layer(s) removed from the Cut version.");
    }
    if (action === "topics") return T.ok("Topics", { mode: TOPICS, topics: readTopics(seq, 1 / (T.sequenceFps(seq) || 25)).list });
    return T.fail("Unknown action: " + action);
  };

  // QE only works on the active sequence and a script holds Premiere still while it runs, so
  // a QE step opens its sequence for that moment. If Lee had moved to another sequence, he is
  // put straight back at the end of the call; if he was on the one the job started on, the
  // job's copy stays open as before.
  function activate(seq) {
    var a = T.activeSequence();
    if (a && String(a.sequenceID) === String(seq.sequenceID)) return true;
    try { app.project.openSequence(String(seq.sequenceID)); } catch (e) {}
    a = T.activeSequence();
    return !!(a && String(a.sequenceID) === String(seq.sequenceID));
  }
  function backToLee(was, seq, result) {
    if (!was || String(was.sequenceID) === String(seq.sequenceID)) return result;
    if (!activate(was)) {
      result.details = result.details || {};
      result.details.activeNotRestored = String(was.name);
      if (result.summary) result.summary += " Could not switch back to \"" + was.name + "\".";
    }
    return result;
  }

  // The sequence's own sound as a wav: exactly what the timeline plays (the mic Lee chose for
  // the clip, mutes, levels). Scripting can't see which source channel a clip plays.
  function renderAudio(seq, params) {
    var ok = false, err = "";
    try { ok = seq.exportAsMediaDirect(params.path, params.preset, 0); } catch (e) { err = String(e); }
    if (err) return T.fail("Could not render the sequence's sound: " + err);
    return T.ok("Rendered the sound of \"" + seq.name + "\".", { path: params.path, result: String(ok) });
  }

  // ---- Cut version (Lee, 20 Oct 2026: the copy is "<sequence> Cut version") ----
  var CUT = "Cut version";
  function isCut(seq) { return String(seq.name).indexOf(CUT) >= 0; }

  // Where the small topic markers live:
  //   "clip"  - clip markers on the clip on the top video track (they belong to the source
  //             clip, so they show wherever that footage is used);
  //   "layer" - clip markers on the question adjustment layers, each layer given its own
  //             source range (base + sequence time) so its markers show on that layer only.
  // Lee, 20 Oct 2026: "clip" (on the top video clip). "layer" stays as an option.
  var TOPICS = "clip";

  function sequenceForItem(projectItem) {
    if (!projectItem) return null;
    try { if (!projectItem.isSequence()) return null; } catch (e) { return null; }
    var list = T.sequenceList(), id = String(projectItem.nodeId);
    for (var i = 0; i < list.length; i++) {
      try { if (list[i].projectItem && String(list[i].projectItem.nodeId) === id) return list[i]; } catch (e2) {}
    }
    return null;
  }

  // Audio tracks to use: "A2" / "2" picks one track, empty = every track that is not muted.
  function wantedTracks(seq, which) {
    var out = [], w = String(which || "").replace(/^\s+|\s+$/g, "").toUpperCase().replace(/^A/, "");
    for (var t = 0; t < seq.audioTracks.numTracks; t++) {
      if (w) { if (String(t + 1) === w) out.push(t); continue; }
      var muted = false;
      try { muted = seq.audioTracks[t].isMuted(); } catch (e) {}
      if (!muted) out.push(t);
    }
    return out;
  }

  // Segments of seq's audio between a and b (seconds, seq time), shifted by offset, on
  // the chosen tracks; nested sequences are followed (all their unmuted tracks).
  function collect(seq, tracks, a, b, offset, depth, out, notes) {
    if (depth > 6) { notes.push("Nesting deeper than 6 levels in " + seq.name + " was skipped."); return; }
    for (var k = 0; k < tracks.length; k++) {
      var clips = seq.audioTracks[tracks[k]].clips;
      for (var c = 0; c < clips.numItems; c++) {
        var it = clips[c], s = it.start.seconds, e = it.end.seconds;
        if (e <= a || s >= b) continue;
        var disabled = false;
        try { disabled = !!it.disabled; } catch (eD) {}
        if (disabled) continue;
        var cs = Math.max(s, a), ce = Math.min(e, b), inPt = it.inPoint.seconds + (cs - s);
        var speed = 1;
        try { speed = it.getSpeed(); } catch (eS) {}
        if (speed !== 1 && speed !== 0) notes.push("\"" + it.name + "\" at " + T.fmt(s + offset) + " has speed " + speed + "; its audio is used at normal speed.");
        var nested = sequenceForItem(it.projectItem);
        if (nested) {
          collect(nested, wantedTracks(nested, ""), inPt, inPt + (ce - cs), offset + cs - inPt, depth + 1, out, notes);
          continue;
        }
        var p = "";
        try { p = it.projectItem ? String(it.projectItem.getMediaPath()) : ""; } catch (eP) {}
        if (!p) { notes.push("\"" + it.name + "\" at " + T.fmt(s + offset) + " has no media file; left out."); continue; }
        // ffmpeg can't read .R3D sound: RED clips are read from their attached proxy (as
        // interview-sync does); without one the clip is left out (Arly Kemp, 29 Oct 2026).
        if (/\.r3d$/i.test(p)) {
          var px = "";
          try { if (it.projectItem.hasProxy && it.projectItem.hasProxy()) px = String(it.projectItem.getProxyPath() || ""); } catch (eX) {}
          if (px) p = px;
        }
        out.push({ path: p, inPoint: inPt, start: cs + offset, end: ce + offset, name: String(it.name), track: tracks[k] + 1, depth: depth });
      }
    }
  }

  function scan(seq, params) {
    var tracks = wantedTracks(seq, params.track);
    if (!tracks.length) return T.fail(params.track ? "This sequence has no audio track " + params.track + "." : "Every audio track in this sequence is muted.");
    var segs = [], notes = [], end = seq.end ? T.sec(seq.end) : 0, labels = [];
    for (var i = 0; i < tracks.length; i++) labels.push("A" + (tracks[i] + 1));
    collect(seq, tracks, 0, 1e9, 0, 0, segs, notes);
    if (!segs.length) return T.fail("No audio clips found on " + labels.join(", ") + ".");
    var last = 0;
    for (var j = 0; j < segs.length; j++) if (segs[j].end > last) last = segs[j].end;
    return T.ok("Found " + segs.length + " audio piece(s) on " + labels.join(", ") + ".", {
      sequence: String(seq.name), sequenceId: String(seq.sequenceID), isCopy: isCut(seq),
      tracks: labels, duration: Math.max(end, last), segments: segs, notes: notes, fps: T.sequenceFps(seq)
    });
  }

  // Duplicates seq (Sequence.clone, the way Make safe copy does), names the new sequence
  // "<name> Cut version" ("... Cut version 2" if taken), checks the original did not change
  // and opens the copy, unless Lee has moved to another sequence (then it stays closed and its
  // name is reported). Only the new sequence is named; no clip is renamed.
  function copy(seq, suffix) {
    suffix = suffix || CUT;
    if (suffix === CUT && isCut(seq)) return T.ok("\"" + seq.name + "\" is already a Cut version; markers go on it.", { copyName: String(seq.name), copyId: String(seq.sequenceID), made: false });
    var originalName = String(seq.name), originalId = String(seq.sequenceID), before = {}, list = T.sequenceList(), i;
    for (i = 0; i < list.length; i++) before[String(list[i].sequenceID)] = true;
    var printBefore = T.fingerprint(seq);
    seq.clone();
    var created = null;
    for (var tries = 0; tries < 20 && !created; tries++) {
      list = T.sequenceList();
      for (i = 0; i < list.length; i++) if (!before[String(list[i].sequenceID)]) { created = list[i]; break; }
      if (!created) $.sleep(250);
    }
    if (!created) return T.fail("Sequence.clone() did not create a new sequence (checked for 5 s).");
    var wanted = originalName + " " + suffix;
    for (var n = 2; T.sequenceNameExists(wanted) && n < 100; n++) wanted = originalName + " " + suffix + " " + n;
    created.name = wanted;
    if (String(created.name) !== wanted && created.projectItem) created.projectItem.name = wanted;
    if (String(created.name) !== wanted) return T.fail("The copy was made as \"" + created.name + "\" but could not be named \"" + wanted + "\".");
    var original = T.findSequenceById(originalId), printAfter = original ? T.fingerprint(original) : null;
    var unchanged = !!(printAfter && printAfter.hash === printBefore.hash && printAfter.clips === printBefore.clips && String(original.name) === originalName);
    var printCopy = T.fingerprint(created);
    if (printCopy.hash !== printBefore.hash) return T.fail("The copy \"" + wanted + "\" does not match \"" + originalName + "\" (" + printCopy.clips + " vs " + printBefore.clips + " clips), so nothing was changed on it.", { copyName: wanted, copyId: String(created.sequenceID) });
    var active = T.activeSequence(), onOriginal = !!(active && String(active.sequenceID) === originalId), isActive = false;
    if (onOriginal) isActive = activate(created);
    var d = { copyName: wanted, copyId: String(created.sequenceID), originalName: originalName, originalUnchanged: unchanged, copyIsActive: isActive, made: true };
    if (!unchanged) return T.fail("Copy made, but the original sequence no longer matches its fingerprint. Check it before going on.", d);
    if (onOriginal && !isActive) return T.fail("The copy \"" + wanted + "\" was made but could not be opened, so nothing was changed on it. Open it and run again.", d);
    return T.ok("Created \"" + wanted + "\"" + (isActive ? " and opened it" : "") + "; the original is unchanged.", d);
  }

  // ---- Remove ums & uhs ----
  var NOUMS = "No ums";
  function isNoUms(seq) { return String(seq.name).indexOf(NOUMS) >= 0; }

  // params.fillers: [{ word, start, end }] in sequence seconds (found by panel.js on this
  // sequence's sound). Each is snapped to frames; fillers that would cut through an edit,
  // or leave less than 3 frames of a clip, are skipped. The copy is made only after the
  // checks that need no change, so a refused run leaves nothing behind.
  function unum(seq, params) {
    if (isNoUms(seq)) return T.fail("\"" + seq.name + "\" is already a \"" + NOUMS + "\" copy. Open the sequence it came from and run again.");
    var fps = T.sequenceFps(seq) || 25, frame = 1 / fps, half = frame / 2, i, j, list = params.fillers || [];
    if (!list.length) return T.fail("No fillers to remove.");
    function locked(tracks) {
      for (var t = 0; t < tracks.numTracks; t++) if (tracks[t].clips.numItems && trackLocked(tracks[t])) return true;
      return false;
    }
    if (locked(seq.videoTracks) || locked(seq.audioTracks)) return T.fail("A track with clips on it is locked; the cuts would put it out of sync. Unlock it and run again.");
    // Spans in whole frames, joined when less than 3 frames apart.
    var spans = [], skipped = [];
    for (i = 0; i < list.length; i++) {
      var a = Math.round(list[i].start * fps), b = Math.round(list[i].end * fps);
      if (b - a < 1) { skipped.push({ at: T.fmt(list[i].start), word: list[i].word, why: "shorter than a frame" }); continue; }
      spans.push({ a: a, b: b, words: [list[i].word], at: [list[i].start] });
    }
    spans.sort(function (x, y) { return x.a - y.a; });
    var joined = [];
    for (i = 0; i < spans.length; i++) {
      var p = joined[joined.length - 1];
      if (p && spans[i].a - p.b < 3) { p.b = Math.max(p.b, spans[i].b); p.words = p.words.concat(spans[i].words); p.at = p.at.concat(spans[i].at); }
      else joined.push(spans[i]);
    }
    // Edits: no clip may start or end inside a span, or within 3 frames of it (a sliver).
    var pieces = allPieces(seq), cuts = [];
    for (i = 0; i < joined.length; i++) {
      var sp = joined[i], why = null;
      for (j = 0; j < pieces.length && !why; j++) {
        var ca = Math.round(pieces[j].a * fps), cb = Math.round(pieces[j].b * fps);
        if (cb <= sp.a - 3 || ca >= sp.b + 3) continue;
        if ((ca > sp.a && ca < sp.b) || (cb > sp.a && cb < sp.b)) why = "an edit on " + pieces[j].track + " is inside it";
        else if ((ca > sp.a - 3 && ca < sp.a) || (cb > sp.b && cb < sp.b + 3)) why = "less than 3 frames from an edit on " + pieces[j].track;
      }
      if (why) { skipped.push({ at: T.fmt(sp.at[0]), word: sp.words.join("+"), why: why }); continue; }
      cuts.push({ a: sp.a / fps, b: sp.b / fps, words: sp.words, at: sp.at });
    }
    if (!cuts.length) return T.fail("None of the " + list.length + " fillers could be cut safely; nothing was changed.", { skipped: skipped });

    // Copy, then work on the copy only.
    var origId = String(seq.sequenceID), origPrint = T.fingerprint(seq), origMarkers = markerList(seq).length, origEnd = T.sec(seq.end);
    var c = copy(seq, NOUMS);
    if (!c.ok) return c;
    var work = T.findSequenceById(c.details.copyId);
    if (!work || !activate(work)) return T.fail("The copy was made but could not be opened for cutting; nothing was cut.", c.details);
    app.enableQE();
    var q = qe.project.getActiveSequence(), before = T.sec(work.end), want = 0;
    for (i = 0; i < cuts.length; i++) want += cuts[i].b - cuts[i].a;
    var res = extractGaps(work, q, cuts, frame, { oldHoles: true });
    // A marker where each cut was, on the copy (put on after the extract, so not moved).
    var marked = 0, rows = [];
    for (i = 0; i < cuts.length; i++) {
      var did = false;
      for (j = 0; j < res.done.length; j++) if (Math.abs(res.done[j].a - cuts[i].a) < half) did = true;
      if (!did) { skipped.push({ at: T.fmt(cuts[i].at[0]), word: cuts[i].words.join("+"), why: "not cut: the extract stopped before it" }); continue; }
      var at = res.map(cuts[i].a), len = cuts[i].b - cuts[i].a, label = cuts[i].words.join(" + ");
      rows.push({ word: label, originalTime: T.fmt(cuts[i].a), originalStart: cuts[i].a, originalEnd: cuts[i].b, newTime: T.fmt(at), seconds: Math.round(len * 1000) / 1000 });
      try {
        var m = work.markers.createMarker(at);
        m.name = label + " removed";
        m.comments = "\"" + label + "\" removed by Remove ums & uhs: " + len.toFixed(2) + " s at " + tcOf(seq, cuts[i].a) + " in \"" + seq.name + "\".";
        marked++;
      } catch (eM) { res.problems.push("marker at " + T.fmt(at) + ": " + eM); }
    }
    var after = T.sec(work.end), orig = T.findSequenceById(origId), origNow = orig ? T.fingerprint(orig) : null;
    var origSame = !!(origNow && origNow.hash === origPrint.hash && origNow.clips === origPrint.clips && markerList(orig).length === origMarkers && Math.abs(T.sec(orig.end) - origEnd) < half);
    var lengthOk = Math.abs((before - after) - res.removed) < frame * 1.5 && Math.abs(res.removed - want) < frame * 1.5;
    var ok = lengthOk && origSame && !res.problems.length && res.gaps === cuts.length;
    var text = (ok ? "" : "CHECK: ") + res.gaps + " of " + list.length + " fillers removed from \"" + c.details.copyName + "\" (" + res.removed.toFixed(1) + " s, " + T.fmt(before) + " -> " + T.fmt(after) + "), " +
      skipped.length + " skipped; " + (res.problems.length ? res.problems.length + " problems, e.g. " + res.problems[0] : "links, sync and markers checked") +
      "; the original is " + (origSame ? "unchanged" : "NOT unchanged") + ". Nothing is saved.";
    var d = { sequence: c.details.copyName, original: String(seq.name), fillers: list.length, cuts: cuts.length, removedCount: res.gaps, removedSeconds: res.removed, wantSeconds: want,
      durationBefore: before, durationAfter: after, lengthOk: lengthOk, originalUnchanged: origSame, relinked: res.relinked, markersMoved: res.markersMoved, markersRestored: res.restored || 0,
      cutMarkers: marked, holes: res.holes, oldHoles: res.oldHoles, problems: res.problems.slice(0, 20), skipped: skipped, removed: rows };
    return ok ? T.ok(text, d) : T.fail(text, d);
  }

  // Read-only look at what Premiere 26.5.2 offers for moving a timeline piece to another
  // track: method names (and argument lists where ExtendScript reflection has them) of a
  // DOM TrackItem, a QE track item and a QE track. Changes nothing.
  function probe(seq, params) {
    function methods(o) {
      var out = [];
      try {
        var ms = o.reflect.methods;
        for (var i = 0; i < ms.length; i++) {
          var args = [];
          try { for (var j = 0; j < ms[i].arguments.length; j++) args.push(String(ms[i].arguments[j].name) + ":" + String(ms[i].arguments[j].dataType)); } catch (eA) {}
          out.push(String(ms[i].name) + "(" + args.join(",") + ")");
        }
      } catch (e) { out.push("reflect failed: " + e); }
      return out;
    }
    var d = { sequence: String(seq.name) };
    var it = seq.videoTracks[0].clips.numItems ? seq.videoTracks[0].clips[0] : null;
    if (it) d.domTrackItem = methods(it);
    d.domTrack = methods(seq.videoTracks[0]);
    app.enableQE();
    var q = qe.project.getActiveSequence();
    d.qeSequence = methods(q);
    var qt = q.getVideoTrackAt(0);
    d.qeTrack = methods(qt);
    for (var k = 0; k < qt.numItems; k++) {
      var qi = qt.getItemAt(k);
      if (qi && String(qi.type) === "Clip") { d.qeItem = methods(qi); break; }
    }
    return T.ok("Probe done.", d);
  }

  // Timecode of the frame nearest sec. Built from whole-frame ticks: setting Time.seconds
  // to e.g. 324.88 formatted one frame early (5:24.84) on 26.5.2.
  function tcOf(seq, sec) {
    var st = seq.getSettings(), tm = new Time(), tpf = parseFloat(seq.timebase);
    tm.ticks = String(Math.round(sec * T.TICKS_PER_SECOND / tpf) * tpf);
    return tm.getFormatted(st.videoFrameRate, st.videoDisplayFormat);
  }

  // Every clip on an unlocked track that spans t (strictly inside) is cut at t with the QE
  // razor, one track at a time. Returns the tracks cut.
  function razorAt(seq, q, t, frame) {
    var tc = tcOf(seq, t), done = [];
    function each(tracks, kind) {
      for (var i = 0; i < tracks.numTracks; i++) {
        var locked = false;
        try { locked = tracks[i].isLocked(); } catch (e) {}
        if (locked || (kind === "V" && trackHasLayers(tracks[i]))) continue;
        var cl = tracks[i].clips, hit = false;
        for (var c = 0; c < cl.numItems; c++) {
          if (cl[c].start.seconds < t - frame / 2 && cl[c].end.seconds > t + frame / 2) { hit = true; break; }
        }
        if (!hit) continue;
        qeTrack(seq, q, kind, i).razor(tc);
        done.push(kind + (i + 1));
      }
    }
    each(seq.videoTracks, "V");
    each(seq.audioTracks, "A");
    return { at: t, timecode: tc, tracks: done };
  }

  function piecesBetween(seq, a, b, frame) {
    var out = [];
    function each(tracks, kind) {
      for (var i = 0; i < tracks.numTracks; i++) {
        var cl = tracks[i].clips;
        for (var c = 0; c < cl.numItems; c++) {
          var x = cl[c];
          if (Math.abs(x.start.seconds - a) < frame / 2 && Math.abs(x.end.seconds - b) < frame / 2)
            out.push({ item: x, track: kind + (i + 1), kind: kind, index: i, name: String(x.name), nodeId: String(x.nodeId), links: T.linkedNodeIds(x).length });
        }
      }
    }
    each(seq.videoTracks, "V");
    each(seq.audioTracks, "A");
    return out;
  }

  function plain(list) {
    var o = [];
    for (var i = 0; i < list.length; i++) o.push({ track: list[i].track, name: list[i].name, nodeId: list[i].nodeId, links: list[i].links });
    return o;
  }

  // The QE track that holds the same clips as DOM track kind/i. Normally the same index,
  // but after QE addTracks put a track at the bottom (20 Oct 2026) the QE and DOM lists
  // disagreed, so the clips' starts are compared; the same index wins when both match.
  function qeTrack(seq, q, kind, i) {
    var dom = kind === "V" ? seq.videoTracks : seq.audioTracks, sig = [], c, j;
    for (c = 0; c < dom[i].clips.numItems; c++) sig.push(Math.round(dom[i].clips[c].start.seconds * 100));
    function sigOf(qt) {
      var out = [];
      for (var k = 0; k < qt.numItems; k++) { var it = qt.getItemAt(k); if (it && String(it.type) === "Clip") out.push(Math.round(T.sec(it.start.ticks) * 100)); }
      return out.join(",");
    }
    var want = sig.join(","), n = kind === "V" ? q.numVideoTracks : q.numAudioTracks;
    var same = kind === "V" ? q.getVideoTrackAt(i) : q.getAudioTrackAt(i);
    if (same && sigOf(same) === want) return same;
    for (j = 0; j < (n || 0); j++) {
      var cand = kind === "V" ? q.getVideoTrackAt(j) : q.getAudioTrackAt(j);
      if (cand && sigOf(cand) === want) return cand;
    }
    return same;
  }

  // QE item of the piece starting at a on track kind ("V"/"A") index i, or null.
  function qeItemAt(seq, q, kind, i, a, frame) {
    var qt = qeTrack(seq, q, kind, i);
    for (var k = 0; k < qt.numItems; k++) {
      var c = qt.getItemAt(k);
      if (c && String(c.type) === "Clip" && Math.abs(T.sec(c.start.ticks) - a) < frame / 2) return c;
    }
    return null;
  }

  function around(seq, a, b) {
    var now = [];
    function each(tracks, kind) {
      for (var t2 = 0; t2 < tracks.numTracks; t2++) {
        var cl = tracks[t2].clips;
        for (var c2 = 0; c2 < cl.numItems; c2++) {
          var x = cl[c2];
          if (x.end.seconds > a - 1 && x.start.seconds < b + 1)
            now.push(kind + (t2 + 1) + " " + T.fmt(x.start.seconds) + "-" + T.fmt(x.end.seconds) + " " + x.name + " links " + T.linkedNodeIds(x).length);
        }
      }
    }
    each(seq.videoTracks, "V");
    each(seq.audioTracks, "A");
    return now;
  }

  // ---- Cut & raise ----
  // Answer spans = sequence markers with a comment and a length (what "mark" adds);
  // overlapping spans are joined. Every clip on an unlocked track is cut at each span's
  // start and end (QE razor), the pieces are relinked to their original link groups (the
  // razor leaves right-hand halves unlinked), then each answer's pieces move up one track
  // (QE moveToTrack(video offset, audio offset, "00:00:00:00", false), tested 3 Oct 2026 on
  // 26.5.2: moves only that piece, keeps its time and links). Everything is read back.
  function answerSpans(seq, frame) {
    // Question (Chapter) markers when there are any; otherwise every answer (Comment) marker.
    var list = markerList(seq), spans = [], chapters = true, i;
    for (i = 0; i < list.length; i++) {
      var m = list[i];
      if (chapters && m.type !== "Chapter") continue;
      if (m.comments && m.end - m.start > frame) spans.push({ a: m.start, b: m.end, name: m.name });
    }
    spans.sort(function (x, y) { return x.a - y.a; });
    var out = [];
    out.byChapter = chapters;
    for (i = 0; i < spans.length; i++) {
      var p = out[out.length - 1];
      if (p && spans[i].a < p.b - frame / 2) { if (spans[i].b > p.b) p.b = spans[i].b; p.names.push(spans[i].name); }
      else out.push({ a: spans[i].a, b: spans[i].b, names: [spans[i].name] });
    }
    return out;
  }

  function allPieces(seq) {
    var out = [];
    function each(tracks, kind) {
      for (var i = 0; i < tracks.numTracks; i++) {
        var cl = tracks[i].clips;
        for (var c = 0; c < cl.numItems; c++) {
          var x = cl[c];
          out.push({ item: x, kind: kind, index: i, track: kind + (i + 1), name: String(x.name), nodeId: String(x.nodeId),
            a: x.start.seconds, b: x.end.seconds, offset: x.inPoint.seconds - x.start.seconds });
        }
      }
    }
    each(seq.videoTracks, "V");
    each(seq.audioTracks, "A");
    return out;
  }

  function isLocked(seq, kind, i) {
    var tr = kind === "V" ? seq.videoTracks[i] : seq.audioTracks[i];
    try { return tr.isLocked(); } catch (e) { return false; }
  }

  function cutraise(seq, params) {
    if (!isCut(seq)) return T.fail("Cut, raise & trim only runs on a sequence with \"Cut version\" in its name (made by Find answers). \"" + seq.name + "\" is not one.");
    var fps = T.sequenceFps(seq) || 25, frame = 1 / fps, half = frame / 2;
    var spans = answerSpans(seq, frame);
    if (!spans.length) return T.fail("No question markers (Chapter markers with a length) on this sequence. Run Find answers first.");
    var durBefore = T.sec(seq.end);
    if (!activate(seq)) return T.fail("\"" + seq.name + "\" could not be opened for cutting; nothing was changed.");
    app.enableQE();
    var q = qe.project.getActiveSequence();

    // Original clips: link group and source offset, to relink and to check nothing shifted.
    var orig = allPieces(seq), groups = [], gi, i, j, k;
    for (i = 0; i < orig.length; i++) {
      // getLinkedItems includes the clip itself; the group key is the sorted, de-duplicated ids.
      var raw = T.linkedNodeIds(orig[i].item), seen = {}, ids = [];
      raw.push(orig[i].nodeId);
      for (j = 0; j < raw.length; j++) if (!seen[raw[j]]) { seen[raw[j]] = true; ids.push(raw[j]); }
      ids.sort();
      orig[i].group = ids.length > 1 ? ids.join(",") : null;
    }
    function origAt(track, t) {
      for (var n = 0; n < orig.length; n++) if (orig[n].track === track && orig[n].a <= t + half && orig[n].b >= t - half) return orig[n];
      return null;
    }

    // 1. Cuts
    var points = [], cuts = 0, cutLog = [];
    for (i = 0; i < spans.length; i++) { points.push(spans[i].a); points.push(spans[i].b); }
    points.sort(function (x, y) { return x - y; });
    for (i = 0; i < points.length; i++) {
      if (i && points[i] - points[i - 1] < half) continue;
      var r = razorAt(seq, q, points[i], frame);
      cuts += r.tracks.length;
      if (r.tracks.length) cutLog.push(r.timecode + " " + r.tracks.join(" "));
    }

    // 2. Relink: pieces with the same start and end whose original clips were one link group.
    var pieces = allPieces(seq), relinked = 0, segs = {};
    for (i = 0; i < pieces.length; i++) {
      var o = origAt(pieces[i].track, (pieces[i].a + pieces[i].b) / 2);
      if (!o || !o.group) continue;
      var key = o.group + "|" + Math.round(pieces[i].a * fps) + "|" + Math.round(pieces[i].b * fps);
      pieces[i].linkedBefore = true;
      (segs[key] = segs[key] || []).push(pieces[i]);
    }
    var linkProblems = [];
    for (var key2 in segs) {
      if (!segs.hasOwnProperty(key2)) continue;
      var grp = segs[key2], need = false;
      for (j = 0; j < grp.length; j++) if (T.linkedNodeIds(grp[j].item).length < grp.length) need = true;
      if (!need || grp.length < 2) continue;
      T.deselectAll(seq);
      for (j = 0; j < grp.length; j++) grp[j].item.setSelected(true, true);
      seq.linkSelection();
      T.deselectAll(seq);
      relinked++;
      for (j = 0; j < grp.length; j++) if (T.linkedNodeIds(grp[j].item).length < grp.length) {
        linkProblems.push(grp[j].track + " " + T.fmt(grp[j].a) + " " + grp[j].name + " linked to " + T.linkedNodeIds(grp[j].item).length + " of " + grp.length);
      }
    }

    // 3. Raise each answer's pieces one track up, top track first.
    var raised = 0, skipped = [];
    for (i = 0; i < spans.length; i++) {
      var sp = spans[i], mine = [];
      pieces = allPieces(seq);
      for (j = 0; j < pieces.length; j++) {
        var pc = pieces[j];
        if (Math.abs(pc.a - sp.a) < half && Math.abs(pc.b - sp.b) < half && !isAdjClip(pc.item)) {
          var og = origAt(pc.track, (pc.a + pc.b) / 2);
          if (og && og.name === pc.name) mine.push(pc); // still on its original track = not raised yet
        }
      }
      if (!mine.length) { skipped.push(T.fmt(sp.a) + " " + sp.names[0] + ": already raised or nothing under it"); continue; }
      mine.sort(function (x, y) { return y.index - x.index; });
      // Target must exist, be unlocked and be free over the span (or hold a piece of this answer that moves first).
      var problem = null;
      for (j = 0; j < mine.length && !problem; j++) {
        var tk = mine[j].kind, ti = mine[j].index + 1, tracks = tk === "V" ? seq.videoTracks : seq.audioTracks;
        if (ti >= tracks.numTracks && tk === "V") { var vErr = ensureVideoTrack(seq, ti); if (vErr) { problem = vErr; break; } tracks = seq.videoTracks; }
        if (ti >= tracks.numTracks) { problem = "there is no track above " + mine[j].track + " (add one and run again)"; break; }
        if (isLocked(seq, tk, ti)) { problem = tk + (ti + 1) + " is locked"; break; }
        var cl = tracks[ti].clips;
        for (k = 0; k < cl.numItems; k++) {
          var x = cl[k];
          if (x.end.seconds > sp.a + half && x.start.seconds < sp.b - half) {
            var movesToo = false;
            for (var m2 = 0; m2 < mine.length; m2++) if (String(mine[m2].nodeId) === String(x.nodeId)) movesToo = true;
            if (!movesToo) { problem = tk + (ti + 1) + " already has \"" + x.name + "\" there"; break; }
          }
        }
      }
      if (problem) { skipped.push(T.fmt(sp.a) + " " + sp.names[0] + ": " + problem); continue; }
      for (j = 0; j < mine.length; j++) {
        var qi = qeItemAt(seq, q, mine[j].kind, mine[j].index, sp.a, frame);
        if (!qi) { skipped.push(T.fmt(sp.a) + " " + mine[j].track + ": QE item not found"); continue; }
        try {
          qi.moveToTrack(mine[j].kind === "V" ? 1 : 0, mine[j].kind === "A" ? 1 : 0, tcOf(seq, 0), false);
          raised++;
        } catch (e) { skipped.push(T.fmt(sp.a) + " " + mine[j].track + ": moveToTrack failed: " + e); }
      }
    }

    // 4. Read back: every piece keeps its original source offset and stays inside the original
    // clip's time; answer pieces sit one track up; links intact per answer; duration unchanged.
    pieces = allPieces(seq);
    var shifted = [], up = 0, notUp = [], linkBad = [];
    for (i = 0; i < pieces.length; i++) {
      var o2 = origAt(pieces[i].track, (pieces[i].a + pieces[i].b) / 2);
      if ((!o2 || o2.name !== pieces[i].name) && pieces[i].index > 0) o2 = origAt(pieces[i].kind + pieces[i].index, (pieces[i].a + pieces[i].b) / 2);
      pieces[i].linkedBefore = !!(o2 && o2.group && o2.name === pieces[i].name);
    }
    for (i = 0; i < pieces.length; i++) {
      var pc2 = pieces[i], inSpan = null;
      for (j = 0; j < spans.length; j++) if (Math.abs(pc2.a - spans[j].a) < half && Math.abs(pc2.b - spans[j].b) < half) inSpan = spans[j];
      var src = origAt(pc2.track, (pc2.a + pc2.b) / 2);
      if (src && src.name !== pc2.name) src = null;
      if (!src && inSpan && pc2.index > 0) {
        var srcBelow = origAt(pc2.kind + pc2.index, (pc2.a + pc2.b) / 2); // label of the track below
        if (srcBelow && srcBelow.name === pc2.name) { src = srcBelow; up++; }
      }
      if (!src) { notUp.push(pc2.track + " " + T.fmt(pc2.a) + " " + pc2.name + ": no original clip found"); continue; }
      if (Math.abs(src.offset - pc2.offset) > half) shifted.push(pc2.track + " " + T.fmt(pc2.a) + " " + pc2.name + " moved by " + (pc2.offset - src.offset).toFixed(3) + " s");
    }
    for (i = 0; i < spans.length; i++) {
      var inside = [];
      for (j = 0; j < pieces.length; j++) if (Math.abs(pieces[j].a - spans[i].a) < half && Math.abs(pieces[j].b - spans[i].b) < half && !isAdjClip(pieces[j].item) && pieces[j].linkedBefore) inside.push(pieces[j]);
      for (j = 0; j < inside.length; j++) {
        var n2 = T.linkedNodeIds(inside[j].item).length;
        if (inside.length > 1 && n2 < inside.length) linkBad.push(T.fmt(spans[i].a) + " " + inside[j].track + " linked to " + n2 + " of " + inside.length);
      }
    }
    // 5. Trim (Lee, 3 Oct 2026, like "Tahnee Home IV Trimmed"): everything outside the answers
    // (questions, crew chat, pauses) is extracted, so the answers run back to back; markers move
    // with them and each question's adjustment layer runs to the start of the next one.
    var trim = null, layerSpans = spans, expectDur = durBefore, mapT = function (t) { return t; };
    if (params.trim !== false) {
      trim = trimDead(seq, q, spans, frame, orig);
      expectDur = trim.keptTotal;
      mapT = trim.map;
    }
    layerSpans = [];
    for (i = 0; i < spans.length; i++) {
      var la = mapT(spans[i].a), lb = i + 1 < spans.length ? mapT(spans[i + 1].a) : mapT(spans[i].b);
      layerSpans.push({ a: la, b: lb, names: spans[i].names });
    }
    // 6. Question layers: in "layer" mode they were placed by Find answers (they carry the
    // topic markers) and the trim has closed them up; otherwise they are placed now.
    var layers, qTrack = questionLayerTrack(seq);
    if (params.layers === false) layers = { skipped: "turned off" };
    else if (TOPICS === "layer" && qTrack >= 0) layers = checkRow(seq, qTrack, layerSpans, frame);
    else {
      var lIdx = emptyTrackFrom(seq, topFootageTrack(seq) + 1);
      if (lIdx < 0) {
        var lErr = ensureVideoTrack(seq, Math.max(topFootageTrack(seq) + 1, seq.videoTracks.numTracks));
        lIdx = lErr ? -1 : emptyTrackFrom(seq, topFootageTrack(seq) + 1);
        if (lErr) layers = { error: lErr };
      }
      if (!layers) layers = addLayers(seq, layerSpans, frame, lIdx, null);
    }
    // 7. Theme row above the question layers: one layer per broad theme (Segmentation markers,
    // moved by the trim), back to back, named after the theme.
    var themes = { skipped: "no theme markers" }, ths = [], ml = markerList(seq);
    for (i = 0; i < ml.length; i++) if (ml[i].type === "Segmentation" && ml[i].end - ml[i].start > frame) ths.push({ a: ml[i].start, b: ml[i].end, names: [ml[i].name] });
    ths.sort(function (x, y) { return x.a - y.a; });
    for (i = 0; i + 1 < ths.length; i++) ths[i].b = ths[i + 1].a;
    if (ths.length && params.layers !== false) {
      var qIdx = layers.index !== undefined ? layers.index : questionLayerTrack(seq);
      if (qIdx < 0) qIdx = topFootageTrack(seq); // no question row: themes still go above the footage
      var tIdx = -1, vt = seq.videoTracks;
      for (i = qIdx + 1; i < vt.numTracks; i++) {
        if (trackLocked(vt[i])) continue;
        if (!vt[i].clips.numItems || (trackHasLayers(vt[i]) && i !== qIdx)) { tIdx = i; break; }
      }
      if (tIdx < 0) {
        var tErr = ensureVideoTrack(seq, vt.numTracks);
        if (tErr) themes = { error: tErr };
        else tIdx = seq.videoTracks.numTracks - 1;
      }
      if (!themes.error) themes = addLayers(seq, ths, frame, tIdx, null);
    }
    var durAfter = T.sec(seq.end);
    var ok = !shifted.length && !linkBad.length && !linkProblems.length && Math.abs(durAfter - expectDur) < frame * 1.5 && !layers.error && !themes.error && !(trim && trim.problems.length);
    var text = spans.length + " answers: " + cuts + " cuts, " + raised + " pieces raised one track, " + skipped.length + " skipped; links " +
      (linkBad.length || linkProblems.length ? "NOT all intact" : "intact") + "; " + (shifted.length ? shifted.length + " pieces shifted in time" : "nothing shifted in time") +
      (trim ? "; " + trim.gaps + " dead bits removed (" + T.fmt(trim.removed) + "), " + trim.markersMoved + " markers moved with them" + (trim.problems.length ? ", " + trim.problems.length + " problems" : "") : "") +
      "; length " + T.fmt(durAfter) + (trim || Math.abs(durAfter - durBefore) >= half ? " (was " + T.fmt(durBefore) + ")" : " (unchanged)") +
      "; " + (layers.error ? "adjustment layers: " + layers.error : layers.skipped ? "no adjustment layers (" + layers.skipped + ")" :
        layers.placed + " question layers on " + layers.track) +
      "; " + (themes.error ? "theme layers: " + themes.error : themes.skipped ? "no theme layers (" + themes.skipped + ")" : themes.placed + " theme layers on " + themes.track) + ".";
    var details = { sequence: String(seq.name), topicsOn: TOPICS, layers: layers, themeLayers: themes, answers: spans.length, joined: 0, cuts: cuts, relinkedGroups: relinked, raised: raised, raisedPiecesFound: up,
      skipped: skipped, unmatched: notUp, linkProblems: linkProblems.concat(linkBad), shifted: shifted,
      durationBefore: durBefore, durationAfter: durAfter, cutLogSample: cutLog.slice(0, 5),
      trim: trim ? { gaps: trim.gaps, removed: trim.removed, keptTotal: trim.keptTotal, markersMoved: trim.markersMoved, markersRestored: trim.restored || 0, relinked: trim.relinked,
        holes: trim.holes, problems: trim.problems.slice(0, 20), extractNote: trim.note } : null };
    for (i = 0; i < spans.length; i++) if (spans[i].names.length > 1) details.joined++;
    return ok ? T.ok(text, details) : T.fail(text, details);
  }

  // Extracts every stretch outside the answer (Comment) markers, last first, then checks:
  // length = answers' total, no holes, every piece shows the same source frames as before
  // (just earlier), linked pieces relinked, markers moved to their answers' new times.
  function trimDead(seq, q, spans, frame, orig) {
    var half = frame / 2, i, kept = [], dur = T.sec(seq.end), tl = readTopics(seq, frame).list;
    for (i = 0; i < tl.length; i++) if (tl[i].b - tl[i].a > frame) kept.push({ a: tl[i].a, b: tl[i].b });
    if (!kept.length) for (i = 0; i < spans.length; i++) kept.push({ a: spans[i].a, b: spans[i].b });
    kept.sort(function (x, y) { return x.a - y.a; });
    var merged = [];
    for (i = 0; i < kept.length; i++) {
      var p = merged[merged.length - 1];
      if (p && kept[i].a <= p.b + half) { if (kept[i].b > p.b) p.b = kept[i].b; } else merged.push({ a: kept[i].a, b: kept[i].b });
    }
    var gaps = [], prev = 0;
    for (i = 0; i < merged.length; i++) { if (merged[i].a - prev > half) gaps.push({ a: prev, b: merged[i].a }); prev = merged[i].b; }
    if (dur - prev > half) gaps.push({ a: prev, b: dur });
    return extractGaps(seq, q, gaps, frame, {});
  }

  // Extracts gaps (sorted [{ a, b }], sequence seconds) from every track, last first, then
  // checks length, source frames, links, markers and holes (see trimDead). opts.oldHoles:
  // holes that were already there before (moved by the extract) are not problems.
  function extractGaps(seq, q, gaps, frame, opts) {
    var half = frame / 2, i, j, dur = T.sec(seq.end), res = { problems: [] };
    var removed = 0;
    for (i = 0; i < gaps.length; i++) removed += gaps[i].b - gaps[i].a;
    res.gaps = gaps.length; res.removed = removed; res.keptTotal = dur - removed;
    res.map = function (t) {
      var r = t;
      for (var g = 0; g < gaps.length; g++) {
        if (gaps[g].b <= t + half) r -= gaps[g].b - gaps[g].a;
        else if (gaps[g].a < t) r -= t - gaps[g].a;
      }
      return r;
    };
    // Pieces and markers before.
    var before = allPieces(seq), oldMarkers = [], m = seq.markers.getFirstMarker();
    for (i = 0; i < before.length; i++) before[i].linked = T.linkedNodeIds(before[i].item).length >= 2;
    while (m) { oldMarkers.push({ start: m.start.seconds, end: m.end.seconds, name: String(m.name), type: String(m.type), comments: String(m.comments) }); m = seq.markers.getNextMarker(m); }
    // Extract, last gap first. QE extract(in, out) removes in..out with out exclusive
    // (an out of the gap's last frame left one frame behind, 3 Oct 2026). Any wrong amount
    // stops the trim, and only what was really removed is counted.
    var done = 0, doneGaps = [];
    for (i = gaps.length - 1; i >= 0; i--) {
      var d0 = T.sec(seq.end);
      q.extract(tcOf(seq, gaps[i].a), tcOf(seq, gaps[i].b));
      var cut = d0 - T.sec(seq.end);
      if (Math.abs(cut - (gaps[i].b - gaps[i].a)) > half) {
        res.problems.push("extract " + T.fmt(gaps[i].a) + "-" + T.fmt(gaps[i].b) + " removed " + cut.toFixed(3) + " s, not " + (gaps[i].b - gaps[i].a).toFixed(3) + "; trim stopped there");
        if (cut > half) { done++; doneGaps.push({ a: gaps[i].a, b: gaps[i].a + cut }); }
        break;
      }
      done++;
      doneGaps.push(gaps[i]);
    }
    if (done < gaps.length) {
      gaps = doneGaps.sort(function (x, y) { return x.a - y.a; });
      removed = 0;
      for (i = 0; i < gaps.length; i++) removed += gaps[i].b - gaps[i].a;
      res.gaps = gaps.length; res.removed = removed; res.keptTotal = dur - removed;
    }
    res.done = gaps;
    // Markers: put each back on its answer's new time (whether or not Premiere moved it).
    var cur = [], moved = 0;
    m = seq.markers.getFirstMarker();
    while (m) { cur.push(m); m = seq.markers.getNextMarker(m); }
    for (i = 0; i < oldMarkers.length; i++) {
      var om = oldMarkers[i], hit = null;
      for (j = 0; j < cur.length && !hit; j++) if (String(cur[j].name) === om.name && String(cur[j].type) === om.type &&
        (Math.abs(cur[j].start.seconds - om.start) < half || Math.abs(cur[j].start.seconds - res.map(om.start)) < half)) hit = cur[j];
      if (!hit) {
        // Extract drops a marker that starts exactly where a removed stretch ends (seen on
        // Chapter markers, 3 Oct 2026): put it back from what it was.
        try {
          hit = seq.markers.createMarker(res.map(om.start));
          hit.name = om.name;
          hit.comments = om.comments;
          if (om.type === "Chapter") hit.setTypeAsChapter();
          else if (om.type === "Segmentation") hit.setTypeAsSegmentation();
          res.restored = (res.restored || 0) + 1;
        } catch (eR) { res.problems.push("marker " + om.name + " lost in the trim and could not be put back: " + eR); continue; }
      }
      var na = res.map(om.start), nb = res.map(om.end);
      if (Math.abs(hit.start.seconds - na) >= half || Math.abs(hit.end.seconds - nb) >= half) {
        try { hit.start = na; } catch (e1) {}
        try { setEnd(hit, nb); } catch (e2) {}
        moved++;
      }
      if (Math.abs(hit.start.seconds - na) >= half || Math.abs(hit.end.seconds - nb) >= half) res.problems.push("marker " + om.name + " at " + T.fmt(hit.start.seconds) + " should be at " + T.fmt(na));
    }
    res.markersMoved = moved;
    // Pieces: each must be part of a piece from before, on the same track, at the mapped time.
    var after = allPieces(seq), groups = {};
    for (i = 0; i < after.length; i++) {
      var x = after[i], src = null;
      for (j = 0; j < before.length && !src; j++) {
        var b0 = before[j];
        if (b0.track === x.track && b0.name === x.name && x.item.inPoint.seconds >= b0.item.inPoint.seconds - half &&
            x.item.inPoint.seconds <= b0.item.inPoint.seconds + (b0.b - b0.a) + half &&
            Math.abs(res.map(b0.a + (x.item.inPoint.seconds - b0.item.inPoint.seconds)) - x.a) < half) src = b0;
      }
      if (!src) { res.problems.push(x.track + " " + T.fmt(x.a) + " " + x.name + ": not where its source frames should be"); continue; }
      // Link group as before the trim (by the pieces' common start and end); layers and
      // pieces that were not linked before stay as they are.
      if (isAdjClip(x.item) || !src.linked) continue;
      var key = String(src.a.toFixed(2)) + "|" + String(src.b.toFixed(2)) + "|" + Math.round(x.a / frame) + "|" + Math.round(x.b / frame);
      (groups[key] = groups[key] || []).push(x);
    }
    res.relinked = 0;
    for (var k in groups) {
      if (!groups.hasOwnProperty(k) || groups[k].length < 2) continue;
      var grp = groups[k], need = false;
      for (j = 0; j < grp.length; j++) if (T.linkedNodeIds(grp[j].item).length < grp.length) need = true;
      if (!need) continue;
      T.deselectAll(seq);
      for (j = 0; j < grp.length; j++) grp[j].item.setSelected(true, true);
      seq.linkSelection();
      T.deselectAll(seq);
      res.relinked++;
      for (j = 0; j < grp.length; j++) if (T.linkedNodeIds(grp[j].item).length < grp.length) res.problems.push(grp[j].track + " " + T.fmt(grp[j].a) + " linked to " + T.linkedNodeIds(grp[j].item).length + " of " + grp.length);
    }
    // Holes: every moment of the new length must have something on some track.
    function holesIn(list, end) {
      var sorted = list.slice().sort(function (x, y) { return x.a - y.a; }), reach = 0, out = [];
      for (var h = 0; h < sorted.length; h++) { if (sorted[h].a - reach > half) out.push({ a: reach, b: sorted[h].a }); if (sorted[h].b > reach) reach = sorted[h].b; }
      if (end - reach > half) out.push({ a: reach, b: end });
      return out;
    }
    var holeList = holesIn(after, T.sec(seq.end)), holes = [];
    if (opts.oldHoles) {
      var was = holesIn(before, dur);
      var newHoles = []; // (ExtendScript is ES3: no Array.filter)
      for (var hn = 0; hn < holeList.length; hn++) {
        var old = false;
        for (var w = 0; w < was.length; w++) if (res.map(was[w].a) <= holeList[hn].a + half && res.map(was[w].b) >= holeList[hn].b - half) old = true;
        if (!old) newHoles.push(holeList[hn]);
      }
      holeList = newHoles;
      res.oldHoles = was.length;
    }
    for (i = 0; i < holeList.length; i++) holes.push(T.fmt(holeList[i].a) + "-" + T.fmt(holeList[i].b));
    res.holes = holes;
    if (holes.length) res.problems.push(holes.length + " holes left, e.g. " + holes[0]);
    return res;
  }

  // The project's adjustment layer item (Lee's projects have one called "Adjustment Layer";
  // ExtendScript cannot make one). First item that says it is an adjustment layer, else by name.
  // Prefers an adjustment layer item named exactly "Adjustment Layer" (Lee's own renamed
  // per-question layers are left alone), else the first adjustment layer item.
  function findAdjustmentItem() {
    var plain = null, any = null, byName = null;
    function walk(bin) {
      for (var i = 0; i < bin.children.numItems; i++) {
        var it = bin.children[i];
        if (it.type === ProjectItemType.BIN) { walk(it); continue; }
        var adj = false;
        try { adj = it.isAdjustmentLayer && it.isAdjustmentLayer(); } catch (e) {}
        if (adj && !plain && String(it.name) === "Adjustment Layer") plain = it;
        if (adj && !any) any = it;
        if (!byName && String(it.name) === "Adjustment Layer") byName = it;
      }
    }
    walk(app.project.rootItem);
    return plain || byName || any;
  }

  function isAdjClip(c) { try { return !!c.isAdjustmentLayer(); } catch (e) { return false; } }
  function trackHasLayers(tr) {
    for (var i = 0; i < tr.clips.numItems; i++) if (isAdjClip(tr.clips[i])) return true;
    return false;
  }
  function trackLocked(tr) { try { return !!tr.isLocked(); } catch (e) { return false; } }
  // Highest video track with footage (not adjustment layers), -1 if none.
  function topFootageTrack(seq) {
    var top = -1, vt = seq.videoTracks;
    for (var i = 0; i < vt.numTracks; i++) {
      var cl = vt[i].clips;
      for (var c = 0; c < cl.numItems; c++) if (!isAdjClip(cl[c])) { top = i; break; }
    }
    return top;
  }
  // Adds video tracks to seq (QE addTracks, the bridge's add_tracks way) until index idx
  // exists; checks the existing tracks kept their places (QE can insert at the bottom).
  function ensureVideoTrack(seq, idx) {
    var vt = seq.videoTracks, need = idx + 1 - vt.numTracks;
    if (need <= 0) return null;
    var before = [], i;
    for (i = 0; i < vt.numTracks; i++) before.push(vt[i].clips.numItems + "|" + (vt[i].clips.numItems ? String(vt[i].clips[0].nodeId) : ""));
    app.enableQE();
    // QE addTracks(video count, video insert index, audio count, audio type, audio index,
    // submix count, submix type, submix index): the bridge's (n, 0, 0, 0) put the new track
    // at index 0 under the footage (20 Oct 2026), so insert at the top index instead.
    qe.project.getActiveSequence().addTracks(need, vt.numTracks, 0, 0, seq.audioTracks.numTracks, 0, 0, 0);
    vt = seq.videoTracks;
    if (vt.numTracks < idx + 1) return "could not add " + need + " video track(s) (now " + vt.numTracks + ")";
    for (i = 0; i < before.length; i++) {
      var now = vt[i].clips.numItems + "|" + (vt[i].clips.numItems ? String(vt[i].clips[0].nodeId) : "");
      if (now !== before[i]) return "adding tracks moved the existing video tracks (V" + (i + 1) + " changed); stopped";
    }
    return null;
  }

  // First unlocked video track at index >= from that is empty, -1 if none.
  function emptyTrackFrom(seq, from) {
    var vt = seq.videoTracks;
    for (var i = Math.max(0, from); i < vt.numTracks; i++) if (!trackLocked(vt[i]) && !vt[i].clips.numItems) return i;
    return -1;
  }
  function itemMarkers(item) {
    var out = [], mc = item.getMarkers(), m = mc.getFirstMarker();
    while (m) { out.push({ m: m, start: m.start.seconds, end: m.end.seconds, name: String(m.name), comments: String(m.comments) }); m = mc.getNextMarker(m); }
    return out;
  }

  // Puts the adjustment layer item on track from a to b (sequence seconds). With base set,
  // the layer's source range is base + a .. base + b (the item's in/out are set for the
  // overwrite and put back after), so clip markers at base + t show on this layer only.
  function placeLayer(track, item, a, b, name, base, frame) {
    var half = frame / 2, got = null, j;
    for (j = 0; j < track.clips.numItems; j++) if (Math.abs(track.clips[j].start.seconds - a) < half) got = track.clips[j];
    if (!got) {
      track.overwriteClip(item, a);
      for (j = 0; j < track.clips.numItems; j++) if (Math.abs(track.clips[j].start.seconds - a) < half) got = track.clips[j];
    }
    if (!got) return { error: T.fmt(a) + " " + name + ": layer did not appear" };
    if (!isAdjClip(got)) return { error: T.fmt(a) + ": a clip that is not an adjustment layer is there; left alone" };
    if (Math.abs(got.end.seconds - b) >= half) {
      var t = new Time();
      t.ticks = String(T.ticks(b));
      try { got.end = t; } catch (e4) {}
      if (Math.abs(got.end.seconds - b) >= half) { try { got.end = b; } catch (e5) {} }
    }
    got.name = name;
    // Own source range: TrackItem.inPoint can be set and keeps the layer's start and end
    // (20 Oct 2026, 26.5.2; the project item's in/out are ignored by overwriteClip for it).
    if (base !== null && base !== undefined && Math.abs(got.inPoint.seconds - (base + a)) >= half) {
      var ti = new Time();
      ti.ticks = String(T.ticks(base + a));
      try { got.inPoint = ti; } catch (e6) {}
    }
    if (Math.abs(got.end.seconds - b) >= half) return { error: T.fmt(a) + " " + name + ": ends at " + T.fmt(got.end.seconds) + " not " + T.fmt(b) };
    if (String(got.name) !== name) return { error: T.fmt(a) + ": name did not stick" };
    if (base !== null && base !== undefined && Math.abs(got.inPoint.seconds - (base + a)) >= half)
      return { error: T.fmt(a) + " " + name + ": its source starts at " + got.inPoint.seconds.toFixed(2) + " s, not " + (base + a).toFixed(2) + " (the in point did not stick)" };
    return { item: got };
  }

  // A source range on the adjustment item with no markers yet, for this Cut version's layers.
  function freeBase(item, dur) {
    var list = itemMarkers(item);
    for (var k = 0; k < 400; k++) {
      var base = 100000 + k * 20000, clash = false;
      for (var i = 0; i < list.length; i++) if (list[i].start >= base - 1 && list[i].start <= base + dur + 60) clash = true;
      if (!clash) return base;
    }
    return null;
  }

  function cleanName(t) { return String(t).replace(/^\s*topic\s*[:\-]?\s*/i, "") || "Answer"; }

  // ---- Topic markers ----
  // Topics read back in sequence time from wherever TOPICS keeps them.
  function readTopics(seq, frame) {
    var half = frame / 2, seen = {}, list = [], vt = seq.videoTracks, i, c, k;
    var qTrack = TOPICS === "layer" ? questionLayerTrack(seq) : -1;
    for (i = 0; i < vt.numTracks; i++) {
      if (TOPICS === "layer" && i !== qTrack) continue;
      var cl = vt[i].clips;
      for (c = 0; c < cl.numItems; c++) {
        var x = cl[c];
        if ((TOPICS === "layer") !== isAdjClip(x)) continue;
        if (TOPICS === "clip" && i !== topFootageTrackAt(seq, (x.start.seconds + x.end.seconds) / 2)) continue;
        var inS = x.inPoint.seconds, outS = inS + (x.end.seconds - x.start.seconds), ms = itemMarkers(x.projectItem);
        for (k = 0; k < ms.length; k++) {
          if (!ms[k].comments || ms[k].start < inS - half || ms[k].start >= outS - half) continue;
          var a = x.start.seconds + (ms[k].start - inS), b = Math.min(x.end.seconds, x.start.seconds + (ms[k].end - inS));
          var key = Math.round(a / frame) + "|" + ms[k].name;
          if (seen[key]) { if (b > seen[key].b) seen[key].b = b; continue; }
          seen[key] = { a: a, b: b, name: ms[k].name, comments: ms[k].comments };
          list.push(seen[key]);
        }
      }
    }
    // A topic cut into pieces (trim, raise) joins up again where its pieces touch.
    list.sort(function (p, q) { return p.a - q.a; });
    return { list: list, track: qTrack };
  }

  // Highest footage track with a clip covering t.
  function topFootageTrackAt(seq, t) {
    var vt = seq.videoTracks;
    for (var i = vt.numTracks - 1; i >= 0; i--) {
      var cl = vt[i].clips;
      for (var c = 0; c < cl.numItems; c++) if (!isAdjClip(cl[c]) && cl[c].start.seconds <= t && cl[c].end.seconds > t) return i;
    }
    return -1;
  }
  function footageClipAt(seq, t) {
    var i = topFootageTrackAt(seq, t);
    if (i < 0) return null;
    var cl = seq.videoTracks[i].clips;
    for (var c = 0; c < cl.numItems; c++) if (!isAdjClip(cl[c]) && cl[c].start.seconds <= t && cl[c].end.seconds > t) return cl[c];
    return null;
  }

  // The question layers are on the lowest video track that holds adjustment layers.
  function questionLayerTrack(seq) {
    var vt = seq.videoTracks;
    for (var i = 0; i < vt.numTracks; i++) if (trackHasLayers(vt[i])) return i;
    return -1;
  }

  function putMarker(mc, start, end, name, comments) {
    var list = [], m = mc.getFirstMarker(), hit = null;
    while (m) { if (Math.abs(m.start.seconds - start) < 0.02 && String(m.name) === name) hit = m; m = mc.getNextMarker(m); }
    if (!hit) hit = mc.createMarker(start);
    hit.name = name;
    hit.comments = comments;
    setEnd(hit, end);
    return hit;
  }


  // Checks the layers already on track idx against the spans (after the trim they should
  // sit back to back, one per question).
  function checkRow(seq, idx, spans, frame) {
    var half = frame / 2, cl = seq.videoTracks[idx].clips, problems = [], ok = 0, names = [];
    for (var i = 0; i < spans.length; i++) {
      var hit = null;
      for (var j = 0; j < cl.numItems; j++) if (isAdjClip(cl[j]) && Math.abs(cl[j].start.seconds - spans[i].a) < half) hit = cl[j];
      if (!hit) { problems.push(T.fmt(spans[i].a) + " " + spans[i].names[0] + ": no question layer starts here"); continue; }
      ok++;
      if (names.length < 5) names.push(T.fmt(hit.start.seconds) + "-" + T.fmt(hit.end.seconds) + " " + hit.name);
    }
    var holes = [];
    for (j = 1; j < cl.numItems; j++) if (cl[j].start.seconds - cl[j - 1].end.seconds > half) holes.push(T.fmt(cl[j - 1].end.seconds) + "-" + T.fmt(cl[j].start.seconds));
    var r = { track: "V" + (idx + 1), index: idx, placed: ok, of: spans.length, pieces: cl.numItems, holes: holes, problems: problems, sample: names };
    if (problems.length) r.error = problems.length + " question layers missing on V" + (idx + 1) + "; " + problems.slice(0, 3).join("; ");
    return r;
  }

  // A row of adjustment layers, one per span, named after it, on video track index target
  // (layers already there with the same start are reused). base: see placeLayer.
  function addLayers(seq, spans, frame, target, base) {
    var item = findAdjustmentItem(), placed = 0, problems = [], names = [];
    if (!item) return { error: "no Adjustment Layer in the project (make one: File > New > Adjustment Layer, then run again)" };
    if (target < 0 || target >= seq.videoTracks.numTracks) return { error: "no empty unlocked video track for the layers (add one and run again)" };
    for (var i = 0; i < spans.length; i++) {
      var title = cleanName(spans[i].names ? spans[i].names[0] : spans[i].name);
      var r = placeLayer(seq.videoTracks[target], item, spans[i].a, spans[i].b, title, base, frame);
      if (r.error) problems.push(r.error);
      else { placed++; if (names.length < 5) names.push(T.fmt(spans[i].a) + "-" + T.fmt(spans[i].b) + " " + title); }
    }
    var res = { track: "V" + (target + 1), index: target, placed: placed, of: spans.length, problems: problems, sample: names };
    if (problems.length) res.error = placed + " of " + spans.length + " placed on V" + (target + 1) + "; " + problems.slice(0, 3).join("; ");
    return res;
  }

  function markerList(seq) {
    var out = [], m = seq.markers.getFirstMarker();
    while (m) {
      out.push({ start: m.start.seconds, end: m.end.seconds, name: String(m.name), comments: String(m.comments), type: String(m.type) });
      m = seq.markers.getNextMarker(m);
    }
    return out;
  }

  // chapter: true finds only Chapter markers, false only the others, so a question and an
  // answer with the same start and title stay two markers.
  function findMarker(seq, start, name, chapter) {
    var m = seq.markers.getFirstMarker();
    while (m) {
      if (Math.abs(m.start.seconds - start) < 0.02 && String(m.name) === name && (String(m.type) === "Chapter") === !!chapter) return m;
      m = seq.markers.getNextMarker(m);
    }
    return null;
  }

  // Marker.end takes seconds as a number (a Time object gives "Illegal Parameter type",
  // seen 2 Oct 2026); ticks string as a fallback.
  function setEnd(m, sec) {
    try { m.end = sec; } catch (e) {}
    if (Math.abs(m.end.seconds - sec) < 0.02) return;
    try { m.end = String(T.ticks(sec)); } catch (e2) {}
    if (Math.abs(m.end.seconds - sec) >= 0.02) throw new Error("end could not be set (reads " + T.fmt(m.end.seconds) + ")");
  }

  // Questions -> Chapter markers, themes -> Segmentation markers (both on the sequence);
  // small topics -> clip markers (TOPICS). In "layer" mode the question layers are placed
  // here, carrying their topics, on the first empty unlocked track two above the footage
  // (one track is kept free for Cut & raise to move the answers up into).
  function mark(seq, params) {
    if (!isCut(seq)) return T.fail("Markers only go on a Cut version. \"" + seq.name + "\" is not one.");
    var fps = T.sequenceFps(seq) || 25, frame = 1 / fps, half = frame / 2, i, j;
    function fr(x) { return Math.round(x * fps) / fps; }
    var q = params.questions || [], th = params.themes || [], ans = params.answers || [];
    var want = [], failed = [], wrong = [], before = markerList(seq).length;
    for (i = 0; i < q.length; i++) want.push({ a: fr(q[i].start), b: fr(q[i].end), name: cleanName(q[i].title), comments: q[i].comment || q[i].title, type: "Chapter" });
    for (i = 0; i < th.length; i++) want.push({ a: fr(th[i].start), b: fr(th[i].end), name: cleanName(th[i].title), comments: th[i].comment || th[i].title, type: "Segmentation" });
    for (i = 0; i < want.length; i++) {
      var w = want[i];
      try {
        var m = findMarkerTyped(seq, w.a, w.name, w.type) || seq.markers.createMarker(w.a);
        m.name = w.name; m.comments = w.comments; setEnd(m, w.b);
        if (w.type === "Chapter") m.setTypeAsChapter(); else m.setTypeAsSegmentation();
      } catch (e) { failed.push({ start: T.fmt(w.a), name: w.name, error: String(e) }); }
    }
    var now = markerList(seq), seqOk = 0;
    for (i = 0; i < want.length; i++) {
      var hit = null;
      for (j = 0; j < now.length; j++) if (Math.abs(now[j].start - want[i].a) < 0.02 && now[j].name === want[i].name && now[j].type === want[i].type) hit = now[j];
      if (!hit) wrong.push({ name: want[i].name, problem: want[i].type + " marker not found after adding" });
      else if (Math.abs(hit.end - want[i].b) > 0.05) wrong.push({ name: want[i].name, problem: "ends at " + T.fmt(hit.end) + " not " + T.fmt(want[i].b) });
      else seqOk++;
    }

    // Topics
    var topicRes = { mode: TOPICS, put: 0 };
    if (TOPICS === "layer") {
      var item = findAdjustmentItem();
      if (!item) return T.fail("No Adjustment Layer in the project (make one: File > New > Adjustment Layer, then run again).");
      var qt = questionLayerTrack(seq), base = null;
      if (qt < 0) {
        var from = topFootageTrack(seq) + 2;
        qt = emptyTrackFrom(seq, from);
        if (qt < 0) {
          var addErr = ensureVideoTrack(seq, Math.max(from, seq.videoTracks.numTracks));
          if (addErr) return T.fail("Question layers: " + addErr + ".");
          qt = emptyTrackFrom(seq, from);
        }
      }
      if (qt < 0) return T.fail("No empty unlocked video track two above the footage for the question layers (add one and run again).");
      // Reuse the base of layers already here (re-run), else a free one.
      var cl = seq.videoTracks[qt].clips;
      // (only a base this skill chose: at or above 100000 s, far from the item's normal 3600 s)
      for (j = 0; j < cl.numItems && base === null; j++) if (isAdjClip(cl[j]) && cl[j].inPoint.seconds - cl[j].start.seconds >= 99999) base = cl[j].inPoint.seconds - cl[j].start.seconds;
      if (base === null) base = freeBase(item, T.sec(seq.end));
      if (base === null) return T.fail("No free source range on the Adjustment Layer item for this sequence's topic markers.");
      var spans = [];
      for (i = 0; i < q.length; i++) spans.push({ a: fr(q[i].start), b: fr(q[i].end), name: q[i].title });
      var lay = addLayers(seq, spans, frame, qt, base);
      topicRes.layers = lay; topicRes.track = "V" + (qt + 1); topicRes.base = base;
      if (lay.error) failed.push({ name: "question layers", error: lay.error });
      var mc = item.getMarkers();
      for (i = 0; i < ans.length; i++) {
        try { putMarker(mc, base + fr(ans[i].start), base + fr(ans[i].end), cleanName(ans[i].topic), ans[i].outline || ans[i].topic); topicRes.put++; }
        catch (e2) { failed.push({ start: T.fmt(ans[i].start), name: ans[i].topic, error: String(e2) }); }
      }
    } else {
      for (i = 0; i < ans.length; i++) {
        var a0 = fr(ans[i].start), clip = footageClipAt(seq, a0 + half);
        if (!clip) { failed.push({ start: T.fmt(a0), name: ans[i].topic, error: "no footage on the video tracks there" }); continue; }
        var src = clip.inPoint.seconds + (a0 - clip.start.seconds), len = Math.min(fr(ans[i].end), clip.end.seconds) - a0;
        try { putMarker(clip.projectItem.getMarkers(), src, src + len, cleanName(ans[i].topic), ans[i].outline || ans[i].topic); topicRes.put++; }
        catch (e3) { failed.push({ start: T.fmt(a0), name: ans[i].topic, error: String(e3) }); }
      }
    }
    // Read the topics back the way Cut & raise will.
    var back = readTopics(seq, frame).list, topicOk = 0;
    for (i = 0; i < ans.length; i++) {
      var aa = fr(ans[i].start), nm = cleanName(ans[i].topic), got = false;
      for (j = 0; j < back.length; j++) if (Math.abs(back[j].a - aa) < half && back[j].name === nm) got = true;
      if (got) topicOk++; else wrong.push({ name: nm, problem: "topic marker at " + T.fmt(aa) + " not read back" });
    }
    var ok = !failed.length && !wrong.length;
    var text = q.length + " question and " + th.length + " theme markers on \"" + seq.name + "\" (" + seqOk + " checked); " + topicOk + " of " + ans.length + " topic markers " +
      (TOPICS === "layer" ? "on the question layers (" + topicRes.track + ")" : "on the clips on the top video track") + " read back" + (ok ? "." : "; see the list below.");
    var details = { sequence: String(seq.name), markersBefore: before, markersAfter: markerList(seq).length, checked: seqOk + topicOk, questions: q.length, themes: th.length,
      topics: topicRes, failed: failed, wrong: wrong };
    return ok ? T.ok(text, details) : T.fail(text, details);
  }

  // Removes the one test marker named "Claude clip-marker test" from a project item (the
  // bridge cannot delete clip markers). Nothing else is touched.
  function untest(params) {
    var found = null;
    function walk(bin) {
      for (var i = 0; i < bin.children.numItems && !found; i++) {
        var it = bin.children[i];
        if (it.type === ProjectItemType.BIN) walk(it);
        else if (String(it.nodeId) === String(params.item)) found = it;
      }
    }
    walk(app.project.rootItem);
    if (!found) return T.fail("Item " + params.item + " not found.");
    var mc = found.getMarkers(), m = mc.getFirstMarker(), gone = 0, left = [];
    while (m) {
      var next = mc.getNextMarker(m);
      if (String(m.name) === "Claude clip-marker test") { mc.deleteMarker(m); gone++; }
      m = next;
    }
    m = mc.getFirstMarker();
    while (m) { left.push(T.fmt(m.start.seconds) + " " + m.name); m = mc.getNextMarker(m); }
    return T.ok(gone + " test marker(s) removed from " + found.name + ".", { left: left });
  }

  // Removes the topic markers a failed test put on the Adjustment Layer item at
  // base .. base + span (only markers in that range whose name is in params.names).
  function unbase(params) {
    var item = findAdjustmentItem(), names = {}, gone = 0, kept = 0;
    if (!item) return T.fail("No adjustment layer item.");
    for (var i = 0; i < (params.names || []).length; i++) names[params.names[i]] = true;
    var mc = item.getMarkers(), m = mc.getFirstMarker();
    while (m) {
      var next = mc.getNextMarker(m);
      if (m.start.seconds >= params.base - 1 && m.start.seconds <= params.base + params.span && names[String(m.name)]) { mc.deleteMarker(m); gone++; } else kept++;
      m = next;
    }
    return T.ok(gone + " test topic marker(s) removed from \"" + item.name + "\"; " + kept + " other marker(s) on it left alone.", { item: String(item.name), nodeId: String(item.nodeId) });
  }

  // On a Cut version: places one adjustment layer on track params.track (index) at a..b,
  // then tries to move its source start to params.src: TrackItem.inPoint, then QE slip.
  function layerprobe(seq, params) {
    if (!isCut(seq)) return T.fail("Only on a Cut version.");
    var fps = T.sequenceFps(seq) || 25, frame = 1 / fps, item = findAdjustmentItem(), tr = seq.videoTracks[params.track], d = {};
    var r = placeLayer(tr, item, params.a, params.b, "Layer probe", null, frame);
    if (r.error) return T.fail(r.error);
    var got = r.item;
    d.inBefore = got.inPoint.seconds; d.outBefore = got.outPoint.seconds;
    try { var t = new Time(); t.seconds = params.src; got.inPoint = t; d.setInPoint = "no error"; } catch (e) { d.setInPoint = String(e); }
    d.inAfterSet = got.inPoint.seconds; d.startAfterSet = got.start.seconds; d.endAfterSet = got.end.seconds;
    if (Math.abs(got.inPoint.seconds - params.src) > frame) {
      app.enableQE();
      var qi = qeItemAt(seq, qe.project.getActiveSequence(), "V", params.track, params.a, frame);
      if (qi) {
        var tm = new Time(), tpf = parseFloat(seq.timebase);
        tm.ticks = String(Math.round((params.src - got.inPoint.seconds) * T.TICKS_PER_SECOND / tpf) * tpf);
        var off = tm.getFormatted(seq.getSettings().videoFrameRate, seq.getSettings().videoDisplayFormat);
        d.slipOffset = off;
        try { d.slipReturned = String(qi.slip(off, false)); } catch (e2) { d.slipError = String(e2); }
        for (var j = 0; j < tr.clips.numItems; j++) if (Math.abs(tr.clips[j].start.seconds - params.a) < frame) got = tr.clips[j];
        d.inAfterSlip = got.inPoint.seconds; d.startAfterSlip = got.start.seconds; d.endAfterSlip = got.end.seconds;
      } else d.slipError = "QE item not found";
    }
    return T.ok("Layer probe done.", d);
  }

  // Sets new comments on this Cut version's topic markers, matched by name (params.notes =
  // { topic name: note }), wherever TOPICS keeps them. Times are not touched.
  function renote(seq, params) {
    if (!isCut(seq)) return T.fail("Only on a Cut version.");
    var notes = params.notes || {}, done = {}, n = 0, vt = seq.videoTracks;
    for (var i = 0; i < vt.numTracks; i++) {
      var cl = vt[i].clips;
      for (var c = 0; c < cl.numItems; c++) {
        var x = cl[c];
        if ((TOPICS === "layer") !== isAdjClip(x)) continue;
        var inS = x.inPoint.seconds, outS = inS + (x.end.seconds - x.start.seconds), mc = x.projectItem.getMarkers(), m = mc.getFirstMarker();
        while (m) {
          var key = String(m.name) + "@" + Math.round(m.start.seconds * 100);
          if (!done[key] && notes.hasOwnProperty(String(m.name)) && m.comments && m.start.seconds >= inS - 0.02 && m.start.seconds < outS) {
            m.comments = notes[String(m.name)]; done[key] = true; n++;
          }
          m = mc.getNextMarker(m);
        }
      }
    }
    return T.ok(n + " topic note(s) made brief on \"" + seq.name + "\".", { changed: n });
  }

  function findMarkerTyped(seq, start, name, type) {
    var m = seq.markers.getFirstMarker();
    while (m) {
      if (Math.abs(m.start.seconds - start) < 0.02 && String(m.name) === name && String(m.type) === type) return m;
      m = seq.markers.getNextMarker(m);
    }
    return null;
  }
}());
