// Sync external audio, Premiere side. The measuring happens in Node/Python (panel.js,
// measure.py); this file reads the timeline and places the wav pieces, one call per action:
//   action "scan"  -> camera clips on video tracks and the external audio (any audio clip
//                     whose name is not a camera clip's), with media paths
//   action "place" -> params.pieces [{path, in, out, start}] onto params.track; each piece
//                     is read back (position and in-point) and the wav item's own in/out
//                     is put back as it was
// Runs only on a sequence whose name ends "TOOLKIT COPY". Never deletes, renames or
// moves existing clips: a piece is only placed where its track is empty.
(function (T) {
  var S = T.sync = T.sync || {};
  S.items = S.items || {}; // media path -> ProjectItem of the wav, filled by "scan"

  function mediaPath(item) { try { return String(item.getMediaPath()); } catch (e) { return ""; } }

  function scan(seq) {
    var cams = [], names = {}, t, c;
    for (t = 0; t < seq.videoTracks.numTracks; t++) {
      var vc = seq.videoTracks[t].clips;
      for (c = 0; c < vc.numItems; c++) {
        var v = vc[c], pi = v.projectItem;
        if (!pi) continue;
        names[String(v.name)] = true;
        cams.push({ nodeId: String(v.nodeId), name: String(v.name), path: mediaPath(pi), track: t,
          start: T.sec(v.start.ticks), end: T.sec(v.end.ticks), inPoint: T.sec(v.inPoint.ticks) });
      }
    }
    var wavs = {}, perTrack = {};
    for (t = 0; t < seq.audioTracks.numTracks; t++) {
      var ac = seq.audioTracks[t].clips;
      for (c = 0; c < ac.numItems; c++) {
        var a = ac[c];
        if (names[String(a.name)] || !a.projectItem) continue;
        var p = mediaPath(a.projectItem);
        if (!p) continue;
        S.items[p] = a.projectItem;
        wavs[p] = true;
        perTrack[t] = (perTrack[t] || 0) + 1;
      }
    }
    var track = -1, most = 0;
    for (var k in perTrack) if (perTrack.hasOwnProperty(k) && perTrack[k] > most) { most = perTrack[k]; track = parseInt(k, 10); }
    var list = [];
    for (var w in wavs) if (wavs.hasOwnProperty(w)) list.push(w);
    return { cams: cams, wavs: list, track: track };
  }

  function busy(trk, a, b) {
    for (var c = 0; c < trk.clips.numItems; c++) {
      var it = trk.clips[c], s = T.sec(it.start.ticks), e = T.sec(it.end.ticks);
      if (s < b - 0.001 && e > a + 0.001) return String(it.name) + " at " + T.fmt(s);
    }
    return null;
  }

  // A clip whose sound runs across two wav files gets two pieces. Premiere will not link
  // two clips on one track to a camera clip (tested 2 Oct 2026: getLinkedItems 0), so the
  // second piece goes on another audio track that is empty there; with none free it stays
  // on the wavs' track and the clip has to be linked by hand.
  function chooseTrack(seq, main, used, a, b) {
    if (!used[main] && !busy(seq.audioTracks[main], a, b)) return main;
    for (var t = 0; t < seq.audioTracks.numTracks; t++) {
      if (t === main || used[t]) continue;
      if (!busy(seq.audioTracks[t], a, b)) return t;
    }
    return used[main] && !busy(seq.audioTracks[main], a, b) ? -2 : -1; // -2: only the shared track
  }

  function place(seq, params) {
    if (!seq.audioTracks[params.track]) return T.fail("Audio track A" + (params.track + 1) + " does not exist.");
    var fps = T.sequenceFps(seq) || 25, frame = 1 / fps;
    var placed = [], failed = [], usedBy = {};
    for (var i = 0; i < params.pieces.length; i++) {
      var p = params.pieces[i], item = S.items[p.path];
      var rec = { clip: p.clip, wav: p.path.replace(/.*\//, ""), start: T.fmt(p.start), "in": p["in"], out: p.out };
      if (!item) { rec.reason = "wav not found in the project (run Sync again)"; failed.push(rec); continue; }
      var len = p.out - p["in"];
      var used = usedBy[p.clip] || (usedBy[p.clip] = {});
      var ti = chooseTrack(seq, params.track, used, p.start, p.start + len);
      if (ti === -1) { rec.reason = "A" + (params.track + 1) + " is not empty there (" + busy(seq.audioTracks[params.track], p.start, p.start + len) + ")"; failed.push(rec); continue; }
      if (ti === -2) { ti = params.track; rec.note = "second piece on the same track (no empty audio track free): link this clip by hand, or add an empty audio track and sync a new copy"; }
      var trk = seq.audioTracks[ti];
      rec.track = "A" + (ti + 1);
      // ProjectItem.setInPoint/setOutPoint take ticks (a seconds value was ignored on 26.5.2:
      // pieces landed 1 frame long from 0). Read back before placing.
      var oldIn = null, oldOut = null;
      try { oldIn = item.getInPoint(4).ticks; oldOut = item.getOutPoint(4).ticks; } catch (e0) {}
      item.setInPoint(String(T.ticks(p["in"])), 4);
      item.setOutPoint(String(T.ticks(p.out)), 4);
      var setIn = NaN, setOut = NaN;
      try { setIn = T.sec(item.getInPoint(4).ticks); setOut = T.sec(item.getOutPoint(4).ticks); } catch (e2) {}
      // Premiere rounds in/out to whole frames (3534.094 -> 3534.08 at 25 fps), so allow a frame.
      if (!(Math.abs(setIn - p["in"]) <= frame + 0.001 && Math.abs(setOut - p.out) <= frame + 0.001)) {
        rec.reason = "Premiere did not take the wav in/out (in " + setIn + ", out " + setOut + ")";
        if (oldIn !== null) { try { item.setInPoint(oldIn, 4); item.setOutPoint(oldOut, 4); } catch (e3) {} }
        failed.push(rec);
        continue;
      }
      trk.overwriteClip(item, p.start);
      if (oldIn !== null) { try { item.setInPoint(oldIn, 4); item.setOutPoint(oldOut, 4); } catch (e1) {} }
      // Read back: the piece must start on this clip's frame with the asked in-point.
      var got = null;
      for (var c = 0; c < trk.clips.numItems; c++) {
        var it = trk.clips[c];
        if (Math.abs(T.sec(it.start.ticks) - p.start) < frame / 2 + 0.001 && mediaPath(it.projectItem) === p.path) got = it;
      }
      if (!got) { rec.reason = "piece not found on " + rec.track + " after placing"; failed.push(rec); continue; }
      rec.gotIn = T.sec(got.inPoint.ticks);
      rec.gotLength = T.sec(got.end.ticks) - T.sec(got.start.ticks);
      if (Math.abs(rec.gotIn - p["in"]) > frame || Math.abs(rec.gotLength - len) > frame + 0.001) {
        rec.reason = "placed but in-point/length differ (in " + rec.gotIn.toFixed(3) + " s, length " + rec.gotLength.toFixed(3) + " s)";
        failed.push(rec);
        continue;
      }
      used[ti] = true;
      placed.push(rec);
    }
    var summary = placed.length + " wav piece(s) placed and checked, " + failed.length + " failed.";
    var r = T.ok(summary, { placed: placed, failed: failed, track: "A" + (params.track + 1) });
    if (failed.length) { r.ok = false; r.error = summary; }
    return r;
  }

  PenyToolkit.skills["sync-external-audio"] = function (params) {
    var seq = T.activeSequence();
    if (!seq) return T.fail("No active sequence.");
    if (!T.isToolkitCopy(seq)) {
      return T.fail("Refused: the active sequence \"" + seq.name + "\" does not end in \"" + T.COPY_SUFFIX +
        "\". Run Make safe copy first and run this on the copy.");
    }
    if (params.action === "scan") {
      var s = scan(seq);
      return T.ok(s.cams.length + " camera clips, " + s.wavs.length + " external audio file(s)" +
        (s.track >= 0 ? " on A" + (s.track + 1) : "") + ".", { sequence: String(seq.name), cams: s.cams, wavs: s.wavs, track: s.track,
        fps: T.sequenceFps(seq) || 25 });
    }
    if (params.action === "place") return place(seq, params);
    return T.fail("Unknown action: " + params.action);
  };
}(PenyToolkit));
