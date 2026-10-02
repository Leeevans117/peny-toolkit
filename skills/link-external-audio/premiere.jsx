// Link external audio: the saved skill "Link external audio to camera clips",
// run inside Premiere. For each camera clip on a video track: select every clip
// within its start/end pulled in by 0.02 s, check the selection, linkSelection(),
// then read the real link state back with TrackItem.getLinkedItems(). A success
// return from linkSelection() is never trusted.
PenyToolkit.skills["link-external-audio"] = function (params) {
  var T = PenyToolkit;
  var EDGE = 0.02;
  var seq = T.activeSequence();
  if (!seq) return T.fail("No active sequence.");
  if (!T.isToolkitCopy(seq)) {
    return T.fail("Refused: the active sequence \"" + seq.name + "\" does not end in \"" + T.COPY_SUFFIX +
      "\". Run Make safe copy first and run this on the copy.");
  }

  var from = 0, to = Infinity;
  if (params.start && String(params.start).replace(/\s/g, "") !== "") {
    from = T.parseTime(params.start, seq);
    if (isNaN(from)) return T.fail("Could not read the From time \"" + params.start + "\".");
  }
  if (params.end && String(params.end).replace(/\s/g, "") !== "") {
    to = T.parseTime(params.end, seq);
    if (isNaN(to)) return T.fail("Could not read the To time \"" + params.end + "\".");
  }
  if (!(to > from)) return T.fail("To must be after From.");

  var fps = T.sequenceFps(seq);
  var frameTicks = fps ? T.TICKS_PER_SECOND / fps : T.TICKS_PER_SECOND / 25;

  // Camera clips: every clip on a video track that starts inside the range.
  var cams = [], t, c;
  for (t = 0; t < seq.videoTracks.numTracks; t++) {
    var vc = seq.videoTracks[t].clips;
    for (c = 0; c < vc.numItems; c++) {
      var s0 = T.sec(vc[c].start.ticks);
      if (s0 >= from - 1e-6 && s0 < to) cams.push({ item: vc[c], track: t });
    }
  }
  cams.sort(function (a, b) { return parseFloat(a.item.start.ticks) - parseFloat(b.item.start.ticks); });

  var linked = [], already = [], failed = [], skipped = [];
  T.deselectAll(seq);

  for (var i = 0; i < cams.length; i++) {
    var cam = cams[i].item;
    var camId = String(cam.nodeId);
    var s = parseFloat(cam.start.ticks), e = parseFloat(cam.end.ticks);
    var rec = { name: String(cam.name), track: T.trackLabel("video", cams[i].track), time: T.fmt(T.sec(s)), nodeId: camId };

    if (T.sec(e) - T.sec(s) <= 2 * EDGE + 0.01) { rec.reason = "clip too short to select safely"; skipped.push(rec); continue; }

    var group = T.clipsOverlapping(seq, T.sec(s) + EDGE, T.sec(e) - EDGE);
    var videos = 0, perTrack = {}, camAudio = 0, external = 0, problem = null, k;
    for (k = 0; k < group.length && !problem; k++) {
      var g = group[k], key = T.trackLabel(g.kind, g.track);
      perTrack[key] = (perTrack[key] || 0) + 1;
      if (perTrack[key] > 1) {
        problem = "2 or more clips on " + key + " under this clip (e.g. the recording crosses wav files). Premiere will not link 2 clips on one track, so link this one by hand.";
      } else if (g.kind === "video") {
        videos++;
        if (g.nodeId !== camId) problem = "another video clip (" + g.name + " on " + key + ") overlaps this clip";
      } else if (g.name === rec.name && g.startTicks === s) {
        camAudio++;
      } else if (g.startTicks < s - frameTicks || g.endTicks > e + frameTicks) {
        problem = "\"" + g.name + "\" on " + key + " runs past this clip's start or end, so it may belong to something else";
      } else {
        external++;
      }
    }
    if (!problem && videos !== 1) problem = "expected 1 video clip in range, found " + videos;
    if (!problem && camAudio === 0) problem = "no camera audio (same name and start) found";
    if (!problem && external === 0) problem = "no external audio under this clip";
    rec.expected = group.length;
    rec.camAudio = camAudio;
    rec.external = external;
    if (problem) { rec.reason = problem; skipped.push(rec); continue; }

    var want = {};
    for (k = 0; k < group.length; k++) want[group[k].nodeId] = true;

    // Current link state of the camera clip.
    var before = T.linkedNodeIds(cam), outside = false, have = {}, haveCount = 0;
    have[camId] = true;
    for (k = 0; k < before.length; k++) have[before[k]] = true;
    for (var id in have) if (have.hasOwnProperty(id)) { haveCount++; if (!want[id]) outside = true; }
    if (!outside && haveCount === group.length) { rec.reason = "already linked"; already.push(rec); continue; }
    if (outside) { rec.reason = "already linked to clips outside this group; left alone"; skipped.push(rec); continue; }

    // Select exactly this group and check the selection before linking.
    for (k = 0; k < group.length; k++) group[k].item.setSelected(true, true);
    var selCount = -1;
    try { var sel = seq.getSelection(); selCount = sel ? sel.length : 0; } catch (e1) {}
    rec.selected = selCount;
    if (selCount !== -1 && selCount !== group.length) {
      rec.reason = "selection has " + selCount + " clips, expected " + group.length + "; not linked";
      T.deselectAll(seq);
      failed.push(rec);
      continue;
    }

    // link_selection will not add items to an existing link group, so a partly
    // linked clip (e.g. camera clip still linked to camera audio) is unlinked first.
    if (haveCount > 1) { seq.unlinkSelection(); rec.unlinkedFirst = true; }
    seq.linkSelection();

    var after = T.linkedNodeIds(cam), got = {}, gotCount = 0, missing = 0;
    got[camId] = true;
    for (k = 0; k < after.length; k++) got[after[k]] = true;
    for (id in got) if (got.hasOwnProperty(id)) gotCount++;
    for (id in want) if (want.hasOwnProperty(id) && !got[id]) missing++;
    rec.linkedCount = after.length;
    T.deselectAll(seq);

    if (missing === 0 && gotCount === group.length) {
      linked.push(rec);
    } else {
      rec.reason = "after linkSelection, getLinkedItems shows " + after.length + " items (" + missing + " of the group missing)";
      failed.push(rec);
    }
  }
  T.deselectAll(seq);

  var details = {
    sequence: String(seq.name),
    range: { from: T.fmt(from), to: to === Infinity ? "end" : T.fmt(to) },
    cameraClips: cams.length,
    linked: linked, alreadyLinked: already, failed: failed, skipped: skipped
  };
  var summary = cams.length + " camera clips: " + linked.length + " linked and verified, " + already.length +
    " already linked, " + failed.length + " failed, " + skipped.length + " skipped.";

  // Lee, 2 Oct 2026: once the synced wav pieces are linked, remove the whole wavs parked on
  // the timeline (e.g. dropped after the clips for Sync). Only when every clip in range
  // linked or was already linked, and only a clip instance on this TOOLKIT COPY timeline
  // that: is not a camera clip, overlaps no video clip, is linked to nothing, and whose file
  // is already linked under a camera clip. Project items and files are never touched.
  var removed = [];
  if (!failed.length && (linked.length || already.length)) {
    var camSet = {}, usedPaths = {}, parked = [];
    for (k = 0; k < cams.length; k++) camSet[String(cams[k].item.name)] = true;
    for (t = 0; t < seq.audioTracks.numTracks; t++) {
      var tcl = seq.audioTracks[t].clips;
      for (c = 0; c < tcl.numItems; c++) {
        var ai = tcl[c];
        if (camSet[String(ai.name)] || !ai.projectItem) continue;
        var mp = ""; try { mp = String(ai.projectItem.getMediaPath()); } catch (eM) {}
        if (!mp) continue;
        if (T.linkedNodeIds(ai).length) { usedPaths[mp] = true; continue; }
        var as = T.sec(ai.start.ticks), ae = T.sec(ai.end.ticks), overVideo = false;
        for (var vt = 0; vt < seq.videoTracks.numTracks && !overVideo; vt++) {
          var vcl = seq.videoTracks[vt].clips;
          for (var vi = 0; vi < vcl.numItems; vi++) {
            if (T.sec(vcl[vi].start.ticks) < ae - 0.001 && T.sec(vcl[vi].end.ticks) > as + 0.001) { overVideo = true; break; }
          }
        }
        if (!overVideo) parked.push({ item: ai, path: mp, track: t, name: String(ai.name), start: as, nodeId: String(ai.nodeId) });
      }
    }
    for (k = 0; k < parked.length; k++) {
      var pk = parked[k], pr = { name: pk.name, track: T.trackLabel("audio", pk.track), time: T.fmt(pk.start) };
      if (!usedPaths[pk.path]) { pr.reason = "kept: this file is not linked under any camera clip"; skipped.push(pr); continue; }
      pk.item.remove(false, false);
      var still = false, tc2 = seq.audioTracks[pk.track].clips;
      for (c = 0; c < tc2.numItems; c++) if (String(tc2[c].nodeId) === pk.nodeId) still = true;
      if (still) { pr.reason = "could not remove the parked copy"; failed.push(pr); } else removed.push(pr);
    }
  }
  details.removedParkedWavs = removed;
  if (removed.length) {
    var rl = [];
    for (k = 0; k < removed.length; k++) rl.push(removed[k].name + " on " + removed[k].track + " at " + removed[k].time);
    summary += " Removed " + removed.length + " parked wav copy(s) from the timeline (" + rl.join(", ") + ").";
  }

  // Seen 2 Oct 2026: the wavs sat on A5 after the camera clips (not synced), so every clip
  // was skipped with "no external audio". Say where the external audio is instead.
  var noExt = 0;
  for (k = 0; k < skipped.length; k++) if (skipped[k].reason === "no external audio under this clip") noExt++;
  if (noExt) {
    var camNames = {};
    for (k = 0; k < cams.length; k++) camNames[String(cams[k].item.name)] = true;
    var ext = null;
    for (t = 0; t < seq.audioTracks.numTracks; t++) {
      var ac = seq.audioTracks[t].clips;
      for (c = 0; c < ac.numItems; c++) {
        if (camNames[String(ac[c].name)]) continue;
        var st = T.sec(ac[c].start.ticks);
        if (!ext || st < ext.start) ext = { name: String(ac[c].name), track: T.trackLabel("audio", t), start: st };
      }
    }
    var hint = ext
      ? " External audio is on the timeline (first: \"" + ext.name + "\" on " + ext.track + " at " + T.fmt(ext.start) +
        ") but none of it sits under " + (noExt === cams.length ? "any camera clip" : noExt + " of the camera clips") + ". Sync it under the clips first, then run Link again."
      : " No external audio found on any audio track of this sequence.";
    summary += hint;
    details.hint = hint;
  }
  if (failed.length) return { ok: false, error: summary, summary: summary, details: details };
  return T.ok(summary, details);
};
