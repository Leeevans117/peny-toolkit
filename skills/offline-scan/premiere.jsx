/* Offline Check: finds the places in the open sequence where "Media offline" really shows.
 * Lee, 27 Nov 2026: an offline clip you cannot see (fully covered, disabled, on a hidden track)
 * is fine; only frames that show the offline slate count.
 * This file does the Premiere side; panel.js renders stills and looks for the slate in them.
 *   mode "plan":  offline clips (and nests holding offline clips) on visible tracks, minus the
 *                 time a solid full-frame clip above surely hides them; each comes back with the
 *                 times to render and the box on screen where its slate would sit.
 *   mode "frames": render stills (params.times, seconds) to params.dir, then put the playhead back.
 *   mode "mark":  replace the sequence's earlier "Media offline" scan markers with params.hits.
 *   mode "clear": remove those markers only.
 *   mode "seek":  move the playhead to params.t (seconds).
 * Changes nothing else. Markers are the only edit, and only ones this tool made are removed. */
PenyToolkit.skills["offline-scan"] = function (params) {
  var T = PenyToolkit;
  params = params || {};
  var seq = T.activeSequence();
  if (!seq) return T.fail("No active sequence. Open the sequence to check.");
  var MARK_NAME = "Media offline";
  var MARK_TAG = "Offline Check:";
  var CAMERA_EXT = { mp4: 1, mov: 1, mxf: 1, r3d: 1, braw: 1, mts: 1, m2ts: 1, avi: 1, m4v: 1, crm: 1, nev: 1, mkv: 1 };

  var st = seq.getSettings();
  var SW = Number(st.videoFrameWidth), SH = Number(st.videoFrameHeight);
  var fps = T.sequenceFps(seq) || 25;
  var FRAME = 1 / fps;

  function r3(v) { return Math.round(v * 1000) / 1000; }
  function isSeqItem(pi) { try { return !!pi.isSequence(); } catch (e) { return false; } }
  function isOffline(pi) { try { return !!pi.isOffline(); } catch (e) { return false; } }
  function mediaPath(pi) { try { return String(pi.getMediaPath() || ""); } catch (e) { return ""; } }
  function frameSize(pi) {
    var md = "";
    try { md = String(pi.getProjectMetadata()); } catch (e) { return null; }
    var mm = /Intrinsic\.VideoInfo>([^<]*)</.exec(md);
    var m2 = mm ? /(\d+)\s*x\s*(\d+)/.exec(mm[1]) : null;
    return m2 ? { w: parseInt(m2[1], 10), h: parseInt(m2[2], 10) } : null;
  }
  function comp(ti, matchName) {
    try { var cs = ti.components; for (var j = 0; j < cs.numItems; j++) if (String(cs[j].matchName) === matchName) return cs[j]; } catch (e) {}
    return null;
  }
  function prop(cm, name) {
    if (!cm) return null;
    for (var p = 0; p < cm.properties.numItems; p++) if (String(cm.properties[p].displayName) === name) return cm.properties[p];
    return null;
  }
  function varies(pr) { try { return !!(pr && pr.isTimeVarying()); } catch (e) { return false; } }
  function val(pr) { try { return pr ? pr.getValue() : null; } catch (e) { return null; } }
  function num(pr, dflt) { var v = val(pr); var n = Number(v); return isFinite(n) ? n : dflt; }
  function pair(pr, dflt) { var v = val(pr); return v && v.length >= 2 ? [Number(v[0]), Number(v[1])] : dflt; }

  // Where the clip's picture sits on screen, in 0..1 of the sequence frame, from its Motion and
  // frame size. null when it moves (keyframes) or is rotated: the panel then checks the whole frame.
  function screenBox(ti, size) {
    var m = comp(ti, "AE.ADBE Motion");
    if (!m || !size) return null;
    var pos = prop(m, "Position"), sc = prop(m, "Scale"), scw = prop(m, "Scale Width"), uni = prop(m, "Uniform Scale"),
        rot = prop(m, "Rotation"), anc = prop(m, "Anchor Point");
    if (varies(pos) || varies(sc) || varies(scw) || varies(rot) || varies(anc)) return null;
    if (Math.abs(num(rot, 0)) > 0.01) return null;
    var sy = num(sc, 100) / 100, u = val(uni), sx = (u === false || u === 0) ? num(scw, 100) / 100 : sy;
    var p = pair(pos, [0.5, 0.5]), a = pair(anc, [0.5, 0.5]);
    var w = size.w * sx, h = size.h * sy;
    var x = p[0] * SW - a[0] * w, y = p[1] * SH - a[1] * h;
    return { x: r3(x / SW), y: r3(y / SH), w: r3(w / SW), h: r3(h / SH) };
  }
  // Is this clip a solid picture that surely covers the whole frame (so nothing below shows)?
  // Strict on purpose: anything unsure is not a cover, and the panel renders a still instead.
  function solidCover(ti) { return coverWhy(ti) === ""; }
  // "" when the clip is a sure cover, else why not (reported in the plan, for checking).
  function coverWhy(ti) {
    try { if (ti.disabled) return "disabled"; } catch (e) {}
    try { if (ti.isAdjustmentLayer()) return "adjustment layer"; } catch (e2) {}
    var pi = null; try { pi = ti.projectItem; } catch (e3) {}
    if (!pi) return "no project item";
    if (isSeqItem(pi)) return "nested sequence";
    if (isOffline(pi)) return "offline";
    var mp = mediaPath(pi), ext = mp.substring(mp.lastIndexOf(".") + 1).toLowerCase();
    if (!CAMERA_EXT[ext]) return "not camera video (" + ext + ")"; // stills and graphics may be transparent
    try { var fi = pi.getFootageInterpretation(); var au = Number(fi.alphaUsage); if (au !== 0 && au !== 3) return "alpha " + au; } catch (e4) { return "alpha unreadable"; }
    var cs = ti.components;
    for (var j = 0; j < cs.numItems; j++) {
      var mn = String(cs[j].matchName);
      if (mn !== "AE.ADBE Opacity" && mn !== "AE.ADBE Motion" && mn !== "AE.ADBE Lumetri") return "effect " + mn;
    }
    var op = comp(ti, "AE.ADBE Opacity"), o = prop(op, "Opacity"), bm = prop(op, "Blend Mode");
    if (varies(o)) return "opacity keyframed";
    if (num(o, 100) < 99.99) return "opacity " + num(o, 100);
    if (bm && num(bm, 0) !== 0) return "blend mode " + num(bm, 0);
    var sz = frameSize(pi);
    if (!sz) return "frame size unknown";
    var b = screenBox(ti, sz);
    if (!b) return "motion keyframed or rotated";
    if (b.x <= 0.0005 && b.y <= 0.0005 && b.x + b.w >= 0.9995 && b.y + b.h >= 0.9995) return "";
    return "does not fill frame " + b.x + "," + b.y + " " + b.w + "x" + b.h;
  }
  // Does this sequence (or one nested in it) hold an offline video clip on a visible track?
  var nestMemo = {};
  function nestHasOffline(s, depth) {
    var id = String(s.sequenceID);
    if (nestMemo[id] !== undefined) return nestMemo[id];
    nestMemo[id] = false;
    if (depth > 4) return false;
    var vt = s.videoTracks;
    for (var t = 0; t < vt.numTracks; t++) {
      try { if (vt[t].isMuted()) continue; } catch (e) {}
      for (var c = 0; c < vt[t].clips.numItems; c++) {
        var ti = vt[t].clips[c], pi = null;
        try { if (ti.disabled) continue; } catch (e1) {}
        try { pi = ti.projectItem; } catch (e2) {}
        if (!pi) continue;
        if (isOffline(pi)) { nestMemo[id] = true; return true; }
        if (isSeqItem(pi)) { var ns = seqOfItem(pi); if (ns && nestHasOffline(ns, depth + 1)) { nestMemo[id] = true; return true; } }
      }
    }
    return false;
  }
  function seqOfItem(pi) {
    var seqs = T.proj().sequences;
    for (var i = 0; i < seqs.numSequences; i++) { try { if (String(seqs[i].projectItem.nodeId) === String(pi.nodeId)) return seqs[i]; } catch (e) {} }
    return null;
  }
  // [a,b] minus a list of [a,b] spans.
  function subtract(a, b, spans) {
    var out = [[a, b]];
    for (var i = 0; i < spans.length; i++) {
      var next = [];
      for (var k = 0; k < out.length; k++) {
        var x = out[k];
        if (spans[i][1] <= x[0] || spans[i][0] >= x[1]) { next.push(x); continue; }
        if (spans[i][0] > x[0]) next.push([x[0], spans[i][0]]);
        if (spans[i][1] < x[1]) next.push([spans[i][1], x[1]]);
      }
      out = next;
    }
    return out;
  }
  function snap(sec) { return Math.round(sec * fps) / fps; }

  if (params.mode === "plan") {
    var vt = seq.videoTracks, nTracks = vt.numTracks;
    var muted = [], clips = [];
    for (var t = 0; t < nTracks; t++) {
      var mu = false; try { mu = !!vt[t].isMuted(); } catch (e) {}
      muted.push(mu);
      var list = [];
      for (var c = 0; c < vt[t].clips.numItems; c++) { var ti = vt[t].clips[c]; list.push({ ti: ti, a: ti.start.seconds, b: ti.end.seconds }); }
      var trs = [];
      try { for (var x = 0; x < vt[t].transitions.numItems; x++) trs.push([vt[t].transitions[x].start.seconds, vt[t].transitions[x].end.seconds]); } catch (eT) {}
      clips.push({ list: list, transitions: trs });
    }
    var counts = { offline: 0, hiddenTrack: 0, disabled: 0, fullyCovered: 0, toCheck: 0 };
    var cands = [], totalSamples = 0;
    for (t = 0; t < nTracks; t++) {
      for (c = 0; c < clips[t].list.length; c++) {
        var rec = clips[t].list[c], pi = null;
        try { pi = rec.ti.projectItem; } catch (e5) {}
        if (!pi) continue;
        var nested = false;
        if (!isOffline(pi)) {
          if (!isSeqItem(pi)) continue;
          var ns = seqOfItem(pi);
          if (!ns || !nestHasOffline(ns, 1)) continue;
          nested = true;
        }
        counts.offline++;
        var where = { track: "V" + (t + 1), name: String(rec.ti.name), nodeId: String(rec.ti.nodeId), start: r3(rec.a), end: r3(rec.b), nested: nested, path: nested ? "" : mediaPath(pi) };
        if (muted[t]) { counts.hiddenTrack++; continue; }
        var dis = false; try { dis = !!rec.ti.disabled; } catch (e6) {}
        if (dis) { counts.disabled++; continue; }
        // Spans hidden by a solid cover on a visible track above (minus its transitions).
        var covers = [], edges = [rec.a, rec.b], notCover = [];
        for (var u = t + 1; u < nTracks; u++) {
          if (muted[u]) continue;
          for (var k = 0; k < clips[u].list.length; k++) {
            var up = clips[u].list[k];
            if (up.b <= rec.a || up.a >= rec.b) continue;
            edges.push(up.a, up.b);
            var why = coverWhy(up.ti);
            if (!why) covers.push([up.a, up.b]); else notCover.push("V" + (u + 1) + " " + String(up.ti.name) + ": " + why);
          }
          for (k = 0; k < clips[u].transitions.length; k++) edges.push(clips[u].transitions[k][0], clips[u].transitions[k][1]);
        }
        for (k = 0; k < clips[t].transitions.length; k++) edges.push(clips[t].transitions[k][0], clips[t].transitions[k][1]);
        var openSpans = [];
        for (u = t + 1; u < nTracks; u++) if (!muted[u]) for (k = 0; k < clips[u].transitions.length; k++) openSpans.push(clips[u].transitions[k]);
        var coverOnly = [];
        for (k = 0; k < covers.length; k++) { var pieces = subtract(covers[k][0], covers[k][1], openSpans); for (var q = 0; q < pieces.length; q++) coverOnly.push(pieces[q]); }
        var seen = subtract(rec.a, rec.b, coverOnly);
        if (!seen.length) { counts.fullyCovered++; continue; }
        // Times to render: the middle of every stretch between edits above, the first and last
        // frame of each seen stretch, and one every 10 s in long stretches (keyframed fades).
        edges.sort(function (m, n) { return m - n; });
        var times = {}, sampleList = [];
        for (var s = 0; s < seen.length; s++) {
          var sa = seen[s][0], sb = seen[s][1];
          if (sb - sa < FRAME / 2) continue;
          var cuts = [sa];
          for (k = 0; k < edges.length; k++) if (edges[k] > sa + FRAME / 2 && edges[k] < sb - FRAME / 2) cuts.push(edges[k]);
          cuts.push(sb);
          var pts = [sa, sb - FRAME];
          for (k = 0; k + 1 < cuts.length; k++) {
            var len = cuts[k + 1] - cuts[k];
            pts.push(cuts[k] + len / 2);
            for (var e10 = cuts[k] + 10; e10 < cuts[k + 1] - 5; e10 += 10) pts.push(e10);
          }
          for (k = 0; k < pts.length; k++) {
            var tt = snap(pts[k]);
            if (tt < sa - 1e-6) tt = snap(sa + FRAME / 2);
            if (tt >= sb) tt = snap(sb - FRAME);
            if (!times[tt]) { times[tt] = 1; sampleList.push(r3(tt)); }
          }
        }
        if (!sampleList.length) { counts.fullyCovered++; continue; }
        sampleList.sort(function (m, n) { return m - n; });
        where.seen = []; for (s = 0; s < seen.length; s++) where.seen.push([r3(seen[s][0]), r3(seen[s][1])]);
        where.samples = sampleList;
        if (notCover.length) where.notCover = notCover;
        where.box = nested ? { x: 0, y: 0, w: 1, h: 1 } : screenBox(rec.ti, frameSize(pi));
        where.boxNested = nested ? screenBox(rec.ti, (function () { var nsq = seqOfItem(pi); if (!nsq) return null; var ss = nsq.getSettings(); return { w: Number(ss.videoFrameWidth), h: Number(ss.videoFrameHeight) }; })()) : null;
        totalSamples += sampleList.length;
        counts.toCheck++;
        cands.push(where);
      }
    }
    return T.ok(counts.offline + " offline clip(s) in \"" + seq.name + "\": " + counts.toCheck + " to check by still, " + counts.fullyCovered + " fully covered, " + counts.disabled + " disabled, " + counts.hiddenTrack + " on hidden tracks.",
      { sequence: String(seq.name), sequenceId: String(seq.sequenceID), width: SW, height: SH, fps: fps, counts: counts, candidates: cands, totalSamples: totalSamples });
  }

  if (params.mode === "frames") {
    app.enableQE();
    var qs = qe.project.getActiveSequence();
    if (!qs) return T.fail("Could not reach the sequence for stills.");
    var keep = seq.getPlayerPosition().ticks, done = [], miss = [];
    try {
      for (var i = 0; i < params.times.length; i++) {
        var sec = Number(params.times[i]);
        seq.setPlayerPosition(String(T.ticks(sec)));
        var tc = String(qs.CTI.timecode), base = params.dir + "/f_" + Math.round(sec * 1000);
        qs.exportFramePNG(tc, base);
        var f = new File(base + ".png");
        for (var w = 0; w < 40 && !f.exists; w++) $.sleep(100);
        if (f.exists) done.push({ t: sec, tc: tc, path: f.fsName }); else miss.push(sec);
      }
    } finally {
      seq.setPlayerPosition(String(keep));
    }
    return T.ok(done.length + " still(s) rendered.", { frames: done, missing: miss });
  }

  function removeOurs() {
    var removed = 0, ms = seq.markers, m = ms.getFirstMarker(), gone = [];
    while (m) {
      var nx = ms.getNextMarker(m);
      if (String(m.name) === MARK_NAME && String(m.comments).indexOf(MARK_TAG) === 0) gone.push(m);
      m = nx;
    }
    for (var g = 0; g < gone.length; g++) { ms.deleteMarker(gone[g]); removed++; }
    return removed;
  }
  function countOurs() {
    var n = 0, ms = seq.markers, m = ms.getFirstMarker();
    while (m) { if (String(m.name) === MARK_NAME && String(m.comments).indexOf(MARK_TAG) === 0) n++; m = ms.getNextMarker(m); }
    return n;
  }

  if (params.mode === "mark" || params.mode === "clear") {
    var removed = removeOurs(), added = 0, hits = params.mode === "mark" ? (params.hits || []) : [];
    for (var h = 0; h < hits.length; h++) {
      var mk = seq.markers.createMarker(Number(hits[h].start));
      mk.name = MARK_NAME;
      mk.comments = MARK_TAG + " " + hits[h].comment;
      if (hits[h].end > hits[h].start) mk.end = Number(hits[h].end);
      try { mk.setColorByIndex(1); } catch (eC) {} // red
      added++;
    }
    var now = countOurs();
    if (now !== added) return T.fail("Markers: wanted " + added + ", found " + now + " after writing.", { removed: removed });
    return T.ok(params.mode === "mark" ? added + " red marker(s) added (" + removed + " old removed)." : removed + " marker(s) removed.", { added: added, removed: removed });
  }

  if (params.mode === "seek") {
    seq.setPlayerPosition(String(T.ticks(Number(params.t))));
    return T.ok("Playhead at " + T.fmt(Number(params.t)) + ".");
  }

  return T.fail("Unknown mode " + params.mode);
};
