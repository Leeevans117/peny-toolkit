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

  function place(seq, params) {
    var trk = seq.audioTracks[params.track];
    if (!trk) return T.fail("Audio track A" + (params.track + 1) + " does not exist.");
    var fps = T.sequenceFps(seq) || 25, frame = 1 / fps;
    var placed = [], failed = [];
    for (var i = 0; i < params.pieces.length; i++) {
      var p = params.pieces[i], item = S.items[p.path];
      var rec = { clip: p.clip, wav: p.path.replace(/.*\//, ""), start: T.fmt(p.start), "in": p["in"], out: p.out };
      if (!item) { rec.reason = "wav not found in the project (run Sync again)"; failed.push(rec); continue; }
      var len = p.out - p["in"];
      var clash = busy(trk, p.start, p.start + len);
      if (clash) { rec.reason = "A" + (params.track + 1) + " is not empty there (" + clash + ")"; failed.push(rec); continue; }
      var oldIn = null, oldOut = null;
      try { oldIn = item.getInPoint(4).seconds; oldOut = item.getOutPoint(4).seconds; } catch (e0) {}
      item.setInPoint(String(p["in"]), 4);
      item.setOutPoint(String(p.out), 4);
      trk.overwriteClip(item, p.start);
      if (oldIn !== null) { try { item.setInPoint(String(oldIn), 4); item.setOutPoint(String(oldOut), 4); } catch (e1) {} }
      // Read back: the piece must start on this clip's frame with the asked in-point.
      var got = null;
      for (var c = 0; c < trk.clips.numItems; c++) {
        var it = trk.clips[c];
        if (Math.abs(T.sec(it.start.ticks) - p.start) < frame / 2 + 0.001 && mediaPath(it.projectItem) === p.path) got = it;
      }
      if (!got) { rec.reason = "piece not found on A" + (params.track + 1) + " after placing"; failed.push(rec); continue; }
      rec.gotIn = T.sec(got.inPoint.ticks);
      rec.gotLength = T.sec(got.end.ticks) - T.sec(got.start.ticks);
      if (Math.abs(rec.gotIn - p["in"]) > frame || Math.abs(rec.gotLength - len) > frame + 0.001) {
        rec.reason = "placed but in-point/length differ (in " + rec.gotIn.toFixed(3) + " s, length " + rec.gotLength.toFixed(3) + " s)";
        failed.push(rec);
        continue;
      }
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
