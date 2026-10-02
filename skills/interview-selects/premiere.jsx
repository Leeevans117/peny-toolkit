// Interview Selects, Premiere side. The panel (panel.js) calls this with params.action:
//   "scan"  - the active sequence's audio as plain segments (file, in, start, end), following
//             nested sequences, so ffmpeg can rebuild the sound in sequence time. Read only.
//   "copy"  - runs Make safe copy (the make-safe-copy skill) unless the active sequence is
//             already a TOOLKIT COPY.
//   "mark"  - adds one sequence marker per answer (name = topic, comment = outline, spanning
//             the answer) to the active TOOLKIT COPY and reads them back.
//   "cutraise" - on a TOOLKIT COPY: cuts every clip at each answer marker's start and end,
//             relinks the pieces and moves each answer up one track (see cutraise below).
//   "probe", "dump" - read-only checks used through the test hook (jsxAction).
(function () {
  var T = PenyToolkit;

  T.skills["interview-selects"] = function (params) {
    var seq = T.activeSequence();
    if (!seq) return T.fail("No active sequence. Open the interview sequence first.");
    var action = params.action || "scan";
    if (action === "scan") return scan(seq, params);
    if (action === "copy") return copy(seq);
    if (action === "mark") return mark(seq, params);
    if (action === "probe") return probe(seq, params);
    if (action === "dump") return T.ok("Pieces " + params.a + "-" + params.b, { pieces: around(seq, params.a, params.b) });
    if (action === "cutraise") return cutraise(seq, params);
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
        if (locked) continue;
        var cl = tracks[i].clips, hit = false;
        for (var c = 0; c < cl.numItems; c++) {
          if (cl[c].start.seconds < t - frame / 2 && cl[c].end.seconds > t + frame / 2) { hit = true; break; }
        }
        if (!hit) continue;
        (kind === "V" ? q.getVideoTrackAt(i) : q.getAudioTrackAt(i)).razor(tc);
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

  // QE item of the piece starting at a on track kind ("V"/"A") index i, or null.
  function qeItemAt(seq, q, kind, i, a, frame) {
    var qt = kind === "V" ? q.getVideoTrackAt(i) : q.getAudioTrackAt(i);
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
    var list = markerList(seq), spans = [], chapters = false, i;
    for (i = 0; i < list.length; i++) if (list[i].type === "Chapter" && list[i].end - list[i].start > frame) chapters = true;
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
    if (!T.isToolkitCopy(seq)) return T.fail("Cut & raise only works on a TOOLKIT COPY. \"" + seq.name + "\" is not one.");
    var fps = T.sequenceFps(seq) || 25, frame = 1 / fps, half = frame / 2;
    var spans = answerSpans(seq, frame);
    if (!spans.length) return T.fail("No answer markers (markers with a comment and a length) on this sequence. Run Find answers first.");
    var durBefore = T.sec(seq.end);
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
        if (Math.abs(pc.a - sp.a) < half && Math.abs(pc.b - sp.b) < half) {
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
      for (j = 0; j < pieces.length; j++) if (Math.abs(pieces[j].a - spans[i].a) < half && Math.abs(pieces[j].b - spans[i].b) < half) inside.push(pieces[j]);
      for (j = 0; j < inside.length; j++) {
        var n2 = T.linkedNodeIds(inside[j].item).length;
        if (inside.length > 1 && n2 < inside.length) linkBad.push(T.fmt(spans[i].a) + " " + inside[j].track + " linked to " + n2 + " of " + inside.length);
      }
    }
    var layers = params.layers === false ? { skipped: "turned off" } : addLayers(seq, spans, frame);
    var durAfter = T.sec(seq.end);
    var ok = !shifted.length && !linkBad.length && !linkProblems.length && Math.abs(durAfter - durBefore) < half && !layers.error;
    var text = spans.length + " answers: " + cuts + " cuts, " + raised + " pieces raised one track, " + skipped.length + " skipped; links " +
      (linkBad.length || linkProblems.length ? "NOT all intact" : "intact") + "; " + (shifted.length ? shifted.length + " pieces shifted in time" : "nothing shifted in time") +
      "; length " + T.fmt(durAfter) + (Math.abs(durAfter - durBefore) < half ? " (unchanged)" : " (was " + T.fmt(durBefore) + ")") +
      "; " + (layers.error ? "adjustment layers: " + layers.error : layers.skipped ? "no adjustment layers (" + layers.skipped + ")" :
        layers.placed + " adjustment layers named on " + layers.track) + ".";
    var details = { sequence: String(seq.name), spansFrom: spans.byChapter ? "question markers" : "answer markers", layers: layers, answers: spans.length, joined: 0, cuts: cuts, relinkedGroups: relinked, raised: raised, raisedPiecesFound: up,
      skipped: skipped, unmatched: notUp, linkProblems: linkProblems.concat(linkBad), shifted: shifted,
      durationBefore: durBefore, durationAfter: durAfter, cutLogSample: cutLog.slice(0, 5) };
    for (i = 0; i < spans.length; i++) if (spans[i].names.length > 1) details.joined++;
    return ok ? T.ok(text, details) : T.fail(text, details);
  }

  // The project's adjustment layer item (Lee's projects have one called "Adjustment Layer";
  // ExtendScript cannot make one). First item that says it is an adjustment layer, else by name.
  function findAdjustmentItem() {
    var byName = null;
    function walk(bin) {
      for (var i = 0; i < bin.children.numItems; i++) {
        var it = bin.children[i];
        if (it.type === ProjectItemType.BIN) { var r = walk(it); if (r) return r; continue; }
        var adj = false;
        try { adj = it.isAdjustmentLayer && it.isAdjustmentLayer(); } catch (e) {}
        if (adj) return it;
        if (!byName && String(it.name) === "Adjustment Layer") byName = it;
      }
      return null;
    }
    return walk(app.project.rootItem) || byName;
  }

  // One adjustment layer per span, named after the question, on the lowest unlocked video
  // track above every clip that is empty over the whole sequence. Only layers this makes are
  // named; a layer already there with that name and span is left as it is.
  function addLayers(seq, spans, frame) {
    var half = frame / 2, item = findAdjustmentItem(), i, j;
    if (!item) return { error: "no Adjustment Layer in the project (make one: File > New > Adjustment Layer, then run again)" };
    var top = -1, vt = seq.videoTracks;
    for (i = 0; i < vt.numTracks; i++) if (vt[i].clips.numItems) top = i;
    var target = -1;
    for (i = top + 1; i < vt.numTracks; i++) {
      var locked = false;
      try { locked = vt[i].isLocked(); } catch (e) {}
      if (!locked && !vt[i].clips.numItems) { target = i; break; }
    }
    // A re-run: our layers are already on a track above the clips.
    var existing = null;
    for (i = 0; i < vt.numTracks && !existing; i++) {
      var cl = vt[i].clips;
      for (j = 0; j < cl.numItems; j++) {
        var adj = false;
        try { adj = cl[j].isAdjustmentLayer(); } catch (e2) {}
        if (adj) { existing = i; break; }
      }
    }
    if (existing !== null) target = existing;
    if (target < 0) return { error: "no empty unlocked video track above the clips (add one and run again)" };
    var track = vt[target], placed = 0, problems = [], names = [];
    for (i = 0; i < spans.length; i++) {
      var sp = spans[i], title = sp.names[0], got = null;
      if (/^\s*topic\b/i.test(title)) title = title.replace(/^\s*topic\s*[:\-]?\s*/i, "");
      for (j = 0; j < track.clips.numItems; j++) if (Math.abs(track.clips[j].start.seconds - sp.a) < half) got = track.clips[j];
      if (!got) {
        track.overwriteClip(item, sp.a);
        for (j = 0; j < track.clips.numItems; j++) if (Math.abs(track.clips[j].start.seconds - sp.a) < half) got = track.clips[j];
      }
      if (!got) { problems.push(T.fmt(sp.a) + " " + title + ": layer did not appear"); continue; }
      var isAdj = false;
      try { isAdj = got.isAdjustmentLayer(); } catch (e3) {}
      if (!isAdj) { problems.push(T.fmt(sp.a) + ": a non-adjustment clip is there; left alone"); continue; }
      if (Math.abs(got.end.seconds - sp.b) >= half) {
        var t = new Time();
        t.ticks = String(T.ticks(sp.b));
        try { got.end = t; } catch (e4) {}
        if (Math.abs(got.end.seconds - sp.b) >= half) { try { got.end = sp.b; } catch (e5) {} }
      }
      got.name = title;
      if (Math.abs(got.end.seconds - sp.b) >= half) problems.push(T.fmt(sp.a) + " " + title + ": ends at " + T.fmt(got.end.seconds) + " not " + T.fmt(sp.b));
      else if (String(got.name) !== title) problems.push(T.fmt(sp.a) + ": name did not stick");
      else { placed++; if (names.length < 5) names.push(T.fmt(sp.a) + "-" + T.fmt(sp.b) + " " + title); }
    }
    var r = { track: "V" + (target + 1), placed: placed, of: spans.length, problems: problems, sample: names };
    if (problems.length) r.error = placed + " of " + spans.length + " placed on V" + (target + 1) + "; " + problems.slice(0, 3).join("; ");
    return r;
  }

  function markerList(seq) {
    var out = [], m = seq.markers.getFirstMarker();
    while (m) {
      out.push({ start: m.start.seconds, end: m.end.seconds, name: String(m.name), comments: String(m.comments), type: String(m.type) });
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
    var want = [], before = markerList(seq).length, added = [], failed = [], q = params.questions || [], i;
    // Question markers (one per interviewer question, a broad title, spanning all its answers)
    // are Chapter markers; the small answer markers are Comment markers.
    for (i = 0; i < q.length; i++) want.push({ start: q[i].start, end: q[i].end, topic: q[i].title, outline: q[i].comment, chapter: true });
    for (i = 0; i < (params.answers || []).length; i++) want.push(params.answers[i]);
    var fps = T.sequenceFps(seq) || 25;
    for (i = 0; i < want.length; i++) {
      var w = want[i];
      // Whole frames, so the marker sits exactly where Premiere shows it.
      var a = Math.round(w.start * fps) / fps, b = Math.round(w.end * fps) / fps;
      try {
        // A marker this skill already put here (same start and topic) is updated, not doubled.
        var m = findMarker(seq, a, w.topic) || seq.markers.createMarker(a);
        m.name = w.topic;
        m.comments = w.outline;
        setEnd(m, b);
        if (w.chapter) m.setTypeAsChapter();
        added.push({ start: a, end: b, name: w.topic, chapter: !!w.chapter });
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
      else if (added[j].chapter && hit.type !== "Chapter") wrong.push({ name: added[j].name, problem: "type is " + hit.type + ", not Chapter" });
      else found++;
    }
    var text = found + " of " + want.length + " markers (" + q.length + " question, " + (want.length - q.length) + " answer) added to \"" + seq.name + "\" and checked" + (wrong.length || failed.length ? "; see the list below." : ".");
    var details = { sequence: String(seq.name), markersBefore: before, markersAfter: now.length, checked: found, questions: q.length, failed: failed, wrong: wrong };
    return found === want.length ? T.ok(text, details) : T.fail(text, details);
  }
}());
