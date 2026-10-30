// Sync Interviews, Premiere side (Interviews tile > Sync Interviews). panel.js calls this with
// params.action:
//   "scan"  - every clip of the active sequence as a "unit": a video clip with the camera
//             audio linked to it, or an audio clip linked to no video (external recorder wav,
//             lav, any loose sound). Media path, proxy path (RED: ffmpeg can't read R3D sound,
//             the toolkit's proxies carry it), timecode of the media's first frame. Read only.
//   "apply" - duplicates the scanned sequence as "<name> Synced" and opens it, moves every
//             unit (its video and all its linked audio) to the start measured by
//             syncmeasure.py, reads every clip back, then links as asked:
//               "all"     - each camera A clip with the camera B clips and the audio clips
//                           synced to it (one clip per track: Premiere can't link two clips
//                           on one track);
//               "cameras" - each camera A clip with the camera B clips synced to it; audio
//                           clips stay unlinked;
//               "none"    - nothing linked.
//             The original sequence is never changed; nothing is renamed, deleted or saved.
//   "probe" - test hook only: which move calls this Premiere has, on a "Synced" sequence.
(function () {
  var T = PenyToolkit;
  var SUFFIX = "Synced";

  T.skills["interview-sync"] = function (params) {
    var action = params.action || "scan";
    var seq = T.activeSequence();
    if (action === "apply") {
      // Stays on the sequence it scanned, whatever is active now; if Lee has moved on he is put
      // straight back at the end (linking needs the copy open while the script holds Premiere).
      var r = apply(params);
      if (seq && String(seq.sequenceID) !== String(params.sequenceId)) {
        try { app.project.openSequence(String(seq.sequenceID)); } catch (e) {}
        var now = T.activeSequence();
        if (!now || String(now.sequenceID) !== String(seq.sequenceID)) { r.details = r.details || {}; r.details.activeNotRestored = String(seq.name); }
      }
      return r;
    }
    if (!seq) return T.fail("No active sequence. Open the interview sequence first.");
    if (action === "scan") return scan(seq);
    if (action === "probe") return probe(seq, params);
    return T.fail("Unknown action: " + action);
  };

  function mediaPath(pi) { try { return pi ? String(pi.getMediaPath() || "") : ""; } catch (e) { return ""; } }
  function proxyPath(pi) {
    try { if (pi && pi.hasProxy && pi.hasProxy()) return String(pi.getProxyPath() || ""); } catch (e) {}
    return "";
  }
  function startTc(pi) {
    // Timecode of the media's first frame, in seconds (null when Premiere has none).
    try { var t = pi.startTime(); if (t && t.seconds !== undefined) return t.seconds; } catch (e) {}
    return null;
  }
  function isSequenceItem(pi) { try { return pi && pi.isSequence && pi.isSequence(); } catch (e) { return false; } }
  function speedOf(it) { try { return it.getSpeed(); } catch (e) { return 1; } }
  // Where in its media the clip starts. After a head trim made by script the in point and
  // the length can disagree (C385 on a test copy, 29 Oct 2026: in 0, out 983.84, length
  // 979.6), and it's not certain which one Premiere plays; such a clip is not measured.
  function mediaIn(it) { return it.inPoint.seconds; }
  function inOutDisagree(it) {
    try { return Math.abs(it.outPoint.seconds - it.inPoint.seconds - (it.end.seconds - it.start.seconds)) > 0.05; } catch (e) { return false; }
  }

  // Units of seq. Each keeps the TrackItems (video + linked audio, or one audio clip).
  function units(seq) {
    var out = [], owner = {}, t, c, it, k;
    var vt = seq.videoTracks, at = seq.audioTracks;
    for (t = 0; t < vt.numTracks; t++) {
      for (c = 0; c < vt[t].clips.numItems; c++) {
        it = vt[t].clips[c];
        var ids = [];
        try { ids = T.linkedNodeIds(it); } catch (eL) {}
        var u = { kind: "video", track: t, index: c, item: it, audio: [] };
        for (k = 0; k < ids.length; k++) if (ids[k] !== String(it.nodeId)) owner[ids[k]] = u;
        out.push(u);
      }
    }
    // Audio items linked to a video clip belong to it; the rest are units of their own.
    for (t = 0; t < at.numTracks; t++) {
      for (c = 0; c < at[t].clips.numItems; c++) {
        it = at[t].clips[c];
        var o = owner[String(it.nodeId)];
        if (o) o.audio.push({ track: t, index: c, item: it });
        else out.push({ kind: "audio", track: t, index: c, item: it, audio: [] });
      }
    }
    return out;
  }

  function describe(u, n) {
    var it = u.item, pi = it.projectItem;
    var rec = {
      id: "u" + n, name: String(it.name), kind: u.kind, track: u.track, index: u.index, nodeId: String(it.nodeId),
      start: it.start.seconds, end: it.end.seconds, inPoint: mediaIn(it), duration: it.end.seconds - it.start.seconds,
      path: mediaPath(pi), proxy: proxyPath(pi), tc: startTc(pi),
      audio: []
    };
    for (var a = 0; a < u.audio.length; a++) {
      var ai = u.audio[a].item;
      rec.audio.push({ track: u.audio[a].track, index: u.audio[a].index, nodeId: String(ai.nodeId), start: ai.start.seconds, end: ai.end.seconds });
    }
    if (isSequenceItem(pi)) rec.skip = "nested sequence (not measured)";
    else if (!pi) rec.skip = "not a media clip";
    else if (Math.abs(speedOf(it) - 1) > 0.001) rec.skip = "speed changed (" + Math.round(speedOf(it) * 100) + "%)";
    else if (inOutDisagree(it)) rec.skip = "its in point (" + T.fmt(it.inPoint.seconds) + "), out point (" + T.fmt(it.outPoint.seconds) + ") and length (" + T.fmt(it.end.seconds - it.start.seconds) + ") don't agree, so where it starts in its file isn't certain; trim its head once by hand and run again";
    else if (u.kind === "video" && !u.audio.length && !/\.(wav|mp3|aif|aiff|m4a)$/i.test(rec.path)) rec.noAudio = true;
    return rec;
  }

  function scan(seq) {
    var us = units(seq), list = [];
    for (var i = 0; i < us.length; i++) list.push(describe(us[i], i));
    return T.ok(list.length + " clip(s) on " + seq.name, {
      sequenceId: String(seq.sequenceID), sequenceName: String(seq.name), fps: T.sequenceFps(seq) || 25,
      end: seq.end ? T.sec(seq.end) : null, units: list
    });
  }

  // ---- Copy ----
  function copyOf(seq) {
    var before = {}, list = T.sequenceList(), i;
    for (i = 0; i < list.length; i++) before[String(list[i].sequenceID)] = true;
    var printBefore = T.fingerprint(seq);
    seq.clone();
    var created = null;
    for (var tries = 0; tries < 20 && !created; tries++) {
      list = T.sequenceList();
      for (i = 0; i < list.length; i++) if (!before[String(list[i].sequenceID)]) { created = list[i]; break; }
      if (!created) $.sleep(250);
    }
    if (!created) return { error: "Sequence.clone() did not make a copy (checked for 5 s)." };
    var wanted = String(seq.name) + " " + SUFFIX;
    for (var n = 2; T.sequenceNameExists(wanted) && n < 100; n++) wanted = String(seq.name) + " " + SUFFIX + " " + n;
    created.name = wanted;
    if (String(created.name) !== wanted && created.projectItem) created.projectItem.name = wanted;
    var printCopy = T.fingerprint(created);
    if (printCopy.hash !== printBefore.hash) return { error: "The copy does not match the original (" + printCopy.clips + " vs " + printBefore.clips + " clips)." };
    app.project.openSequence(created.sequenceID);
    return { seq: created, name: String(created.name) };
  }

  // ---- Moving ----
  // Premiere 26: assigning .start trims the head instead of moving (seen 29 Oct 2026 with the
  // MCP bridge's move_clip on the Mac mini: end stayed, linked audio stayed). TrackItem.move()
  // takes an offset; whether linked items follow is checked, and each item is moved itself
  // when they don't.
  function moveBy(item, offsetSec) {
    var t = new Time();
    t.seconds = offsetSec;
    item.move(t);
  }
  function near(a, b, tol) { return Math.abs(a - b) <= tol; }

  function itemAt(seq, kind, track, index) {
    var tr = kind === "video" ? seq.videoTracks[track] : seq.audioTracks[track];
    if (!tr || index >= tr.clips.numItems) return null;
    return tr.clips[index];
  }
  // Every TrackItem of the unit in seq (looked up by track + index before anything moves).
  function bind(seq, rec) {
    var main = itemAt(seq, rec.kind, rec.track, rec.index);
    if (!main || String(main.name) !== rec.name || !near(main.start.seconds, rec.start, 0.002)) return null;
    var items = [{ item: main, start: rec.start }];
    for (var a = 0; a < rec.audio.length; a++) {
      var ai = itemAt(seq, "audio", rec.audio[a].track, rec.audio[a].index);
      if (!ai || !near(ai.start.seconds, rec.audio[a].start, 0.002)) return null;
      items.push({ item: ai, start: rec.audio[a].start });
    }
    return items;
  }

  // Move all items of one unit by offset; returns problems (empty when every item landed).
  function moveUnit(items, offset, tol) {
    var probs = [], i;
    var ends = [];
    for (i = 0; i < items.length; i++) ends.push({ s: items[i].item.start.seconds, e: items[i].item.end.seconds, inp: items[i].item.inPoint.seconds });
    try { moveBy(items[0].item, offset); } catch (e) { return ["move failed: " + e]; }
    for (i = 0; i < items.length; i++) {
      var it = items[i].item;
      if (!near(it.start.seconds, ends[i].s + offset, tol)) {
        // Linked item did not follow: move it on its own.
        try { moveBy(it, ends[i].s + offset - it.start.seconds); } catch (e2) {}
      }
      if (!near(it.start.seconds, ends[i].s + offset, tol) || !near(it.end.seconds, ends[i].e + offset, tol) || !near(it.inPoint.seconds, ends[i].inp, tol))
        probs.push(String(it.name) + " is at " + T.fmt(it.start.seconds) + "-" + T.fmt(it.end.seconds) + ", wanted " + T.fmt(ends[i].s + offset));
    }
    return probs;
  }

  function apply(params) {
    var src = T.findSequenceById(params.sequenceId);
    if (!src) return T.fail("The scanned sequence is gone.");
    var plan = params.units || [];
    var fps = T.sequenceFps(src) || 25, tol = 0.5 / fps;
    var made = copyOf(src);
    if (made.error) return T.fail(made.error);
    var seq = made.seq;
    // Bind every unit to its items in the copy before anything moves.
    var bound = [], i, probs = [];
    for (i = 0; i < plan.length; i++) {
      var items = bind(seq, plan[i]);
      if (!items) return T.fail("Could not find " + plan[i].name + " (" + T.trackLabel(plan[i].kind, plan[i].track) + " at " + T.fmt(plan[i].start) + ") in the copy; nothing moved.", { copy: made.name });
      bound.push({ rec: plan[i], items: items });
    }
    var moving = [];
    for (i = 0; i < bound.length; i++) if (Math.abs(bound[i].rec.newStart - bound[i].rec.start) >= tol) moving.push(bound[i]);
    // Park every moving unit after everything (latest first, so nothing lands on anything),
    // then bring each to its new start.
    var lastEnd = 0;
    for (i = 0; i < bound.length; i++) {
      lastEnd = Math.max(lastEnd, bound[i].rec.end, bound[i].rec.newStart + (bound[i].rec.end - bound[i].rec.start));
    }
    var park = Math.ceil(lastEnd + 60), parkAt = park;
    moving.sort(function (a, b) { return b.rec.start - a.rec.start; });
    var parked = [];
    for (i = 0; i < moving.length; i++) {
      var m = moving[i], len = m.rec.end - m.rec.start;
      var to = parkAt;
      parkAt = Math.ceil(parkAt + len + 10);
      var p1 = moveUnit(m.items, to - m.rec.start, tol);
      if (p1.length) { probs = probs.concat(p1); break; }
      parked.push(m);
    }
    if (!probs.length) {
      for (i = 0; i < parked.length; i++) {
        var pm = parked[i];
        var p2 = moveUnit(pm.items, pm.rec.newStart - pm.items[0].item.start.seconds, tol);
        if (p2.length) probs = probs.concat(p2);
      }
    }
    // Read back every unit.
    var check = [];
    for (i = 0; i < bound.length; i++) {
      var b = bound[i], it0 = b.items[0].item;
      var ok = near(it0.start.seconds, b.rec.newStart, tol);
      for (var k = 1; k < b.items.length && ok; k++) ok = near(b.items[k].item.start.seconds - it0.start.seconds, b.items[k].start - b.rec.start, tol);
      check.push({ name: b.rec.name, track: T.trackLabel(b.rec.kind, b.rec.track), wanted: b.rec.newStart, at: it0.start.seconds, ok: ok });
      if (!ok) probs.push(b.rec.name + " is at " + T.fmt(it0.start.seconds) + ", wanted " + T.fmt(b.rec.newStart));
    }
    var res = { copy: made.name, copyId: String(seq.sequenceID), moved: moving.length, checked: check, problems: probs, links: [] };
    if (probs.length) return T.fail("Moving clips failed on " + made.name + ": " + probs.slice(0, 3).join("; ") + ". Nothing was linked; the original sequence is unchanged.", res);
    // A scripted move unlinks a clip from its own audio (TrackItem.move, seen 29 Oct 2026), so
    // every camera clip is linked back to its own sound, plus any loose audio clip of the same
    // file that now sits exactly under it (camera audio that was unlinked before the sync).
    res.own = relinkOwn(seq, bound, tol);
    for (i = 0; i < res.own.length; i++) if (!res.own[i].ok) probs.push(res.own[i].name + ": " + res.own[i].reason);
    if (probs.length) return T.fail("Clips moved on " + made.name + " but " + probs.length + " camera clip(s) could not be linked back to their own audio: " + probs.slice(0, 3).join("; "), res);
    if (params.link && params.link !== "none") res.links = link(seq, bound, params.link, tol);
    var bad = 0;
    for (i = 0; i < res.links.length; i++) if (!res.links[i].ok) bad++;
    return T.ok(moving.length + " clip(s) moved on " + made.name + (params.link && params.link !== "none" ? "; " + (res.links.length - bad) + " of " + res.links.length + " link group(s) checked" : ""), res);
  }

  // ---- Own links (each camera clip with its own audio) ----
  // Links sel into one group and returns how many of sel are in sel[0]'s group afterwards.
  // unlinkSelection runs first (linkSelection won't add a clip to a group it is already in),
  // so if the new group doesn't hold, every group the clips were in before is linked again
  // (sync2, 29 Oct 2026: a failed group left camera A unlinked from its own audio).
  function inGroup(it, other) {
    var ids = T.linkedNodeIds(it);
    for (var q = 0; q < ids.length; q++) if (ids[q] === String(other.nodeId)) return true;
    return false;
  }
  function selectOnly(seq, list) { T.deselectAll(seq); for (var i = 0; i < list.length; i++) list[i].setSelected(true, true); }
  function linkItems(seq, sel) {
    var before = [], seen = {}, i, k;
    for (i = 0; i < sel.length; i++) {
      if (seen[String(sel[i].nodeId)]) continue;
      var g = [sel[i]], li = sel[i].getLinkedItems();
      seen[String(sel[i].nodeId)] = true;
      for (k = 0; li && k < li.numItems; k++) if (!seen[String(li[k].nodeId)]) { seen[String(li[k].nodeId)] = true; g.push(li[k]); }
      if (g.length > 1) before.push(g);
    }
    selectOnly(seq, sel);
    seq.unlinkSelection();
    selectOnly(seq, sel);
    seq.linkSelection();
    T.deselectAll(seq);
    var have = 1;
    for (i = 1; i < sel.length; i++) if (inGroup(sel[0], sel[i])) have++;
    if (have === sel.length) return { linked: have };
    // Didn't hold: put the old groups back and check them.
    selectOnly(seq, sel);
    seq.unlinkSelection();
    var restored = 0;
    for (i = 0; i < before.length; i++) {
      selectOnly(seq, before[i]);
      seq.linkSelection();
      var n = 1;
      for (k = 1; k < before[i].length; k++) if (inGroup(before[i][0], before[i][k])) n++;
      if (n === before[i].length) restored++;
    }
    T.deselectAll(seq);
    return { linked: have, restored: restored === before.length, groupsBefore: before.length };
  }
  function relinkOwn(seq, bound, tol) {
    var out = [], i, j;
    for (i = 0; i < bound.length; i++) {
      var v = bound[i];
      if (v.rec.kind !== "video") continue;
      var sel = [], k;
      for (k = 0; k < v.items.length; k++) sel.push(v.items[k].item);
      var v0 = v.items[0].item, joined = 0;
      for (j = 0; j < bound.length; j++) {
        var a = bound[j];
        if (a.rec.kind !== "audio" || !a.rec.path || a.rec.path !== v.rec.path || a.joined) continue;
        var ai = a.items[0].item;
        // In sync with the picture (same media time at the same place) and overlapping it;
        // the two may be trimmed differently.
        if (Math.abs((ai.start.seconds - mediaIn(ai)) - (v0.start.seconds - mediaIn(v0))) <= tol &&
            Math.min(ai.end.seconds, v0.end.seconds) - Math.max(ai.start.seconds, v0.start.seconds) > tol) { sel.push(ai); a.joined = v.rec.id; joined++; (v.extra = v.extra || []).push(ai); }
      }
      if (sel.length < 2) continue;
      // Already one group (nothing moved, nothing to join)?
      var ids = T.linkedNodeIds(v0), have = 0;
      for (k = 1; k < sel.length; k++) for (var q = 0; q < ids.length; q++) if (ids[q] === String(sel[k].nodeId)) { have++; break; }
      if (have === sel.length - 1) continue;
      var r = linkItems(seq, sel), n = r.linked;
      out.push({ name: v.rec.name, at: T.fmt(v0.start.seconds), items: sel.length, joined: joined, linked: n, ok: n === sel.length,
        reason: n === sel.length ? "" : "after linking, " + n + " of " + sel.length + " clips are in its group" + (r.restored ? "; its old links were put back" : "; its old links could NOT all be put back") });
    }
    return out;
  }

  // ---- Linking ----
  // One link group per anchor (the clip at the top of each placement chain: camera A for
  // most). Premiere can't link two clips on one track, so the clip overlapping the anchor
  // most wins a track; the others are listed. unlinkSelection first: linkSelection won't
  // add a clip to a group it is already in (camera B's own audio). Read back with
  // getLinkedItems; linkSelection's return is never trusted.
  function trackKey(u, k) { return k === 0 ? u.rec.kind + u.rec.track : "audio" + u.items[k].item.parentTrackIndex; }
  function addUnit(u, used, sel) {
    var k, list = [];
    for (k = 0; k < u.items.length; k++) list.push({ key: trackKey(u, k), item: u.items[k].item });
    for (k = 0; k < (u.extra || []).length; k++) list.push({ key: "audio" + u.extra[k].parentTrackIndex, item: u.extra[k] });
    for (k = 0; k < list.length; k++) if (used[list[k].key]) return false;
    for (k = 0; k < list.length; k++) { used[list[k].key] = true; sel.push(list[k].item); }
    return true;
  }
  function link(seq, bound, mode, tol) {
    var byId = {}, i, out = [], groups = {}, order = [];
    for (i = 0; i < bound.length; i++) byId[bound[i].rec.id] = bound[i];
    for (i = 0; i < bound.length; i++) {
      var r = bound[i].rec;
      if (!r.synced) continue;
      var top = r, hops = 0;
      while (top.withId && byId[top.withId] && byId[top.withId].rec.synced && hops++ < 50) top = byId[top.withId].rec;
      var anchorId = top.withId || top.id;
      if (!groups[anchorId]) { groups[anchorId] = []; order.push(anchorId); }
      groups[anchorId].push(bound[i]);
    }
    for (var g = 0; g < order.length; g++) {
      var aId = order[g];
      if (!byId[aId]) continue;
      var anchor = byId[aId], used = {}, sel = [], left = [];
      addUnit(anchor, used, sel);
      var members = groups[aId].slice();
      members.sort(function (a, b) { return overlap(b, anchor) - overlap(a, anchor); });
      for (i = 0; i < members.length; i++) {
        var mu = members[i];
        if (mode === "cameras" && mu.rec.kind !== "video") continue;
        if (mu.joined) continue; // camera audio linked back to its own picture (relinkOwn); goes with it
        if (overlap(mu, anchor) <= tol) { left.push(mu.rec.name + " (does not overlap " + anchor.rec.name + ")"); continue; }
        if (!addUnit(mu, used, sel)) left.push(mu.rec.name + " (its track already has a clip in this link group)");
      }
      var rec = { anchor: anchor.rec.name, at: T.fmt(anchor.items[0].item.start.seconds), wanted: sel.length, left: left };
      if (sel.length < 2 || sel.length === anchor.items.length + (anchor.extra || []).length) { rec.ok = true; rec.note = "nothing to link"; out.push(rec); continue; }
      var lr = linkItems(seq, sel);
      rec.linked = lr.linked;
      rec.ok = rec.linked === sel.length;
      if (!rec.ok) { rec.restored = lr.restored; rec.reason = "after linking, " + rec.linked + " of " + sel.length + " clips are in the group" + (lr.restored ? "; the old links were put back" : "; the old links could NOT all be put back"); }
      rec.names = [];
      for (i = 0; i < sel.length; i++) rec.names.push(String(sel[i].name) + " " + (sel[i].mediaType === "Video" ? "V" : "A") + (sel[i].parentTrackIndex + 1));
      out.push(rec);
    }
    return out;
  }
  function overlap(a, b) {
    var a0 = a.items[0].item.start.seconds, a1 = a.items[0].item.end.seconds, b0 = b.items[0].item.start.seconds, b1 = b.items[0].item.end.seconds;
    return Math.min(a1, b1) - Math.max(a0, b0);
  }

  // ---- Probe (test hook only, on a Synced copy) ----
  function probe(seq, params) {
    if (String(seq.name).indexOf(SUFFIX) < 0 && String(seq.name).indexOf("Copy") < 0) return T.fail("Probe only on a copy.");
    var it = itemAt(seq, params.kind || "video", params.track || 0, params.index || 0);
    if (!it) return T.fail("No clip there.");
    var r = { name: String(it.name), hasMove: typeof it.move, before: [it.start.seconds, it.end.seconds, it.inPoint.seconds], linkedBefore: [] };
    var ids = T.linkedNodeIds(it), linked = it.getLinkedItems(), k;
    for (k = 0; linked && k < linked.numItems; k++) r.linkedBefore.push([String(linked[k].nodeId), linked[k].start.seconds]);
    if (params.offset) {
      try { moveBy(it, params.offset); r.moved = true; } catch (e) { r.moveError = String(e); }
      r.after = [it.start.seconds, it.end.seconds, it.inPoint.seconds];
      r.linkedAfter = [];
      linked = it.getLinkedItems();
      for (k = 0; linked && k < linked.numItems; k++) r.linkedAfter.push([String(linked[k].nodeId), linked[k].start.seconds]);
    }
    return T.ok("probe", r);
  }
}());
