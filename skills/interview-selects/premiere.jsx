// Interview Selects, Premiere side. The panel (panel.js) calls this with params.action:
//   "scan"  - the active sequence's audio as plain segments (file, in, start, end), following
//             nested sequences, so ffmpeg can rebuild the sound in sequence time. Read only.
//   "copy"  - runs Make safe copy (the make-safe-copy skill) unless the active sequence is
//             already a TOOLKIT COPY.
//   "mark"  - adds one sequence marker per answer (name = topic, comment = outline, spanning
//             the answer) to the active TOOLKIT COPY and reads them back.
(function () {
  var T = PenyToolkit;

  T.skills["interview-selects"] = function (params) {
    var seq = T.activeSequence();
    if (!seq) return T.fail("No active sequence. Open the interview sequence first.");
    var action = params.action || "scan";
    if (action === "scan") return scan(seq, params);
    if (action === "copy") return copy(seq);
    if (action === "mark") return mark(seq, params);
    return T.fail("Unknown action: " + action);
  };

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
      sequence: String(seq.name), sequenceId: String(seq.sequenceID), isCopy: T.isToolkitCopy(seq),
      tracks: labels, duration: Math.max(end, last), segments: segs, notes: notes, fps: T.sequenceFps(seq)
    });
  }

  function copy(seq) {
    if (T.isToolkitCopy(seq)) return T.ok("\"" + seq.name + "\" is already a TOOLKIT COPY; markers go on it.", { copyName: String(seq.name), copyId: String(seq.sequenceID), made: false });
    var file = new File(File($.fileName).parent.parent.fsName + "/make-safe-copy/premiere.jsx");
    if (!file.exists) return T.fail("Make safe copy skill not found at " + file.fsName);
    $.evalFile(file);
    var r = T.skills["make-safe-copy"]({});
    if (!r.ok) return r;
    if (!r.details.copyIsActive) return T.fail("The copy \"" + r.details.copyName + "\" was made but is not the active sequence, so no markers were added. Open it and run again.", r.details);
    r.details.made = true;
    return r;
  }

  function markerList(seq) {
    var out = [], m = seq.markers.getFirstMarker();
    while (m) {
      out.push({ start: m.start.seconds, end: m.end.seconds, name: String(m.name), comments: String(m.comments) });
      m = seq.markers.getNextMarker(m);
    }
    return out;
  }

  function findMarker(seq, start, name) {
    var m = seq.markers.getFirstMarker();
    while (m) {
      if (Math.abs(m.start.seconds - start) < 0.02 && String(m.name) === name) return m;
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

  function mark(seq, params) {
    if (!T.isToolkitCopy(seq)) return T.fail("Markers only go on a TOOLKIT COPY. \"" + seq.name + "\" is not one.");
    var want = params.answers || [], before = markerList(seq).length, added = [], failed = [];
    var fps = T.sequenceFps(seq) || 25;
    for (var i = 0; i < want.length; i++) {
      var w = want[i];
      // Whole frames, so the marker sits exactly where Premiere shows it.
      var a = Math.round(w.start * fps) / fps, b = Math.round(w.end * fps) / fps;
      try {
        // A marker this skill already put here (same start and topic) is updated, not doubled.
        var m = findMarker(seq, a, w.topic) || seq.markers.createMarker(a);
        m.name = w.topic;
        m.comments = w.outline;
        setEnd(m, b);
        added.push({ start: a, end: b, name: w.topic });
      } catch (e) {
        failed.push({ start: T.fmt(a), name: w.topic, error: String(e) });
      }
    }
    // Read back: every marker must be there with its name, comment and end.
    var now = markerList(seq), found = 0, wrong = [];
    for (var j = 0; j < added.length; j++) {
      var hit = null;
      for (var k = 0; k < now.length; k++) {
        if (Math.abs(now[k].start - added[j].start) < 0.02 && now[k].name === added[j].name) { hit = now[k]; break; }
      }
      if (!hit) { wrong.push({ name: added[j].name, problem: "not found after adding" }); continue; }
      if (Math.abs(hit.end - added[j].end) > 0.05) wrong.push({ name: added[j].name, problem: "ends at " + T.fmt(hit.end) + " not " + T.fmt(added[j].end) });
      else if (!hit.comments) wrong.push({ name: added[j].name, problem: "comment missing" });
      else found++;
    }
    var text = found + " of " + want.length + " answer markers added to \"" + seq.name + "\" and checked" + (wrong.length || failed.length ? "; see the list below." : ".");
    var details = { sequence: String(seq.name), markersBefore: before, markersAfter: now.length, checked: found, failed: failed, wrong: wrong };
    return found === want.length ? T.ok(text, details) : T.fail(text, details);
  }
}());
