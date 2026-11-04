// Selects sequences, Premiere side. The panel (panel.js) calls this with params.action:
//   "scan"     - reads the footage root bin: its groups (Day bins, card or camera bins: any bin
//                that holds bins), the source bins in each (KX_021026, R5_250926, B ROLE, PITS...)
//                and every clip in them (nested RED .RDM/.RDC bins included), plus the sequences
//                that already exist. Read only.
//   "create"   - makes one new sequence from a sequence preset (QE newSequence; the project must
//                be the one in front) and reads its frame size and rate back.
//   "place"    - puts clips back to back on a sequence from a frame (overwriteClip at empty
//                positions only) and reads every placement back: where it landed, how long it
//                is, which tracks got picture and sound.
//   "track"    - adds one audio track at the bottom (QE addTracks) for recorder wavs and checks
//                the existing tracks did not move.
//   "marker"   - adds one span marker (name, start, end, colour) and reads it back.
//   "bins"     - files sequences into 01 SEQUENCES/Selects(/UNCUT), creating the bins if missing,
//                and checks each sequence is in its bin.
//   "readback" - every clip on every track and every marker of a sequence, for the final check.
// Nothing here renames clips, deletes anything or saves the project.
(function (T) {
  var AUDIO_EXT = /\.(wav|mp3|aac|aif|aiff|m4a|wma|ogg|flac|caf|bwf)$/i;
  var SKIP_EXT = /\.(png|jpe?g|tiff?|bmp|gif|psd|ai|eps|csv|txt|xml|pdf|srt|aegraphic|mogrt|prproj|cube)$/i;
  var DAY_RE = /^\s*day\s*[_ -]?0*(\d+)/i;

  T.skills["selects-sequences"] = function (params) {
    var p = T.proj();
    if (!p) return T.fail(T.targetPath ? "The project this run started in is no longer open: " + T.targetPath : "No project open.");
    var a = params.action || "scan";
    if (a === "scan") return scan(p, params);
    if (a === "create") return create(p, params);
    if (a === "place") return place(p, params);
    if (a === "track") return addTrack(p, params);
    if (a === "marker") return marker(p, params);
    if (a === "bins") return bins(p, params);
    if (a === "readback") return readback(p, params);
    return T.fail("Unknown action: " + a);
  };

  function isBin(it) { return it.type == ProjectItemType.BIN; }
  function mediaPath(it) { try { return String(it.getMediaPath() || ""); } catch (e) { return ""; } }
  function isSeqItem(it) { try { return !!it.isSequence(); } catch (e) { return false; } }
  function childBins(bin) {
    var out = [];
    for (var i = 0; i < bin.children.numItems; i++) if (isBin(bin.children[i])) out.push(bin.children[i]);
    out.sort(function (x, y) { return byName(String(x.name), String(y.name)); });
    return out;
  }
  // Bin order = name order, as the Project panel sorts by Name (C0001 < C0002, A004 < A010).
  function byName(a, b) { a = a.toLowerCase(); b = b.toLowerCase(); return a < b ? -1 : a > b ? 1 : 0; }

  function findBinPath(root, path) {
    var parts = String(path).split("/"), bin = root;
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === "") continue;
      var next = null;
      for (var c = 0; c < bin.children.numItems; c++) if (isBin(bin.children[c]) && String(bin.children[c].name) === parts[i]) { next = bin.children[c]; break; }
      if (!next) return null;
      bin = next;
    }
    return bin;
  }
  function allBins(root) {
    var out = [], st = [{ bin: root, path: "" }];
    while (st.length) {
      var f = st.pop();
      for (var c = 0; c < f.bin.children.numItems; c++) {
        var ch = f.bin.children[c];
        if (!isBin(ch)) continue;
        var p = f.path === "" ? String(ch.name) : f.path + "/" + ch.name;
        out.push({ bin: ch, path: p });
        st.push({ bin: ch, path: p });
      }
    }
    return out;
  }
  // The footage root: a path from the project root, a bin name that only one bin has, or (empty)
  // the bin selected in the Project panel.
  function footageRoot(p, text) {
    text = String(text || "").replace(/^\s+|\s+$/g, "");
    var list = allBins(p.rootItem), i;
    if (text === "") {
      var sel = null, bins = [];
      try { sel = app.getCurrentProjectViewSelection(); } catch (e) {}
      if (sel) for (i = 0; i < sel.length; i++) if (isBin(sel[i])) bins.push(sel[i]);
      if (bins.length !== 1) return { error: bins.length ? "Select only one footage bin (" + bins.length + " are selected)." : "Select the footage bin in the Project panel (e.g. 02 FOOTAGE/LakePlacid), or type its path." };
      for (i = 0; i < list.length; i++) if (String(list[i].bin.nodeId) === String(bins[0].nodeId)) return list[i];
      return { bin: bins[0], path: String(bins[0].name) };
    }
    var b = findBinPath(p.rootItem, text);
    if (b) return { bin: b, path: text };
    var hits = [];
    for (i = 0; i < list.length; i++) if (String(list[i].bin.name) === text || list[i].path === text) hits.push(list[i]);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return { error: hits.length + " bins are called \"" + text + "\"; type the path from the project root (e.g. 02 FOOTAGE/" + text + ")." };
    return { error: "Bin not found: \"" + text + "\". Type the path from the project root, e.g. 02 FOOTAGE/LakePlacid." };
  }

  function fps(it) {
    try { var fi = it.getFootageInterpretation(); if (fi && fi.frameRate) return Math.round(fi.frameRate * 1000) / 1000; } catch (e) {}
    return null;
  }
  function channels(it) {
    try { var m = it.getAudioChannelMapping; if (m) { m = it.getAudioChannelMapping(); return { type: m.audioChannelsType, clips: m.audioClipsNumber }; } } catch (e) {}
    return null;
  }
  function offline(it) { try { return !!it.isOffline(); } catch (e) { return false; } }
  function clipRecord(it, sub) {
    var mp = mediaPath(it);
    var r = { nodeId: String(it.nodeId), name: String(it.name), path: mp, sub: sub, offline: offline(it), fps: fps(it),
      audioOnly: AUDIO_EXT.test(mp) || AUDIO_EXT.test(String(it.name)) };
    if (r.audioOnly) r.channels = channels(it);
    return r;
  }
  // Clips in a source bin: its own clips by name, then each nested bin's (by name), so a RED
  // .RDM mag bin's clips come in mag order.
  function clipsIn(bin, sub, out, skipped) {
    var own = [], i;
    for (i = 0; i < bin.children.numItems; i++) {
      var ch = bin.children[i];
      if (isBin(ch)) continue;
      if (ch.type != ProjectItemType.CLIP || isSeqItem(ch)) { skipped.push({ name: String(ch.name), reason: "not a footage clip" }); continue; }
      var mp = mediaPath(ch);
      if (SKIP_EXT.test(mp) || /^\._/.test(String(ch.name))) { skipped.push({ name: String(ch.name), reason: "not video or audio" }); continue; }
      own.push(ch);
    }
    own.sort(function (x, y) { return byName(String(x.name), String(y.name)); });
    for (i = 0; i < own.length; i++) out.push(clipRecord(own[i], sub));
    var kids = childBins(bin);
    for (i = 0; i < kids.length; i++) clipsIn(kids[i], sub ? sub + "/" + kids[i].name : String(kids[i].name), out, skipped);
    return out;
  }
  function prefixOf(name) { var m = /^([^_]+)_/.exec(String(name)); return (m ? m[1] : String(name)).replace(/^\s+|\s+$/g, ""); }

  // A RED mag/clip folder imported as a bin (A004_0309MA.RDM, A003_A164_0309WV.RDC): part of a
  // camera source, never a group of its own.
  var MAG_RE = /\.(RDM|RDC)$/i;
  function hasGroupBins(bin) {
    var kids = childBins(bin);
    for (var i = 0; i < kids.length; i++) if (!MAG_RE.test(String(kids[i].name))) return true;
    return false;
  }
  function source(bin, skipped) {
    var clips = clipsIn(bin, "", [], skipped);
    if (!clips.length) { skipped.push({ name: String(bin.name), reason: "bin has no clips" }); return null; }
    var audio = 0;
    for (var k = 0; k < clips.length; k++) if (clips[k].audioOnly) audio++;
    return { bin: String(bin.name), nodeId: String(bin.nodeId), prefix: prefixOf(bin.name), kind: audio === clips.length ? "audio" : audio ? "mixed" : "video", clips: clips };
  }
  function looseClips(bin) {
    var out = [];
    for (var j = 0; j < bin.children.numItems; j++) {
      var ch = bin.children[j];
      if (!isBin(ch) && ch.type == ProjectItemType.CLIP && !isSeqItem(ch) && !SKIP_EXT.test(mediaPath(ch))) out.push(clipRecord(ch, ""));
    }
    return out;
  }
  // One group = one Selects UNCUT + one Selects sequence. Any bin in the footage bin that holds
  // bins of its own (a day, a card, a camera, a place: Lee, 23 Oct 2026, Orbea Canonball has
  // "FMD ORBEA ... SONY FX30 ..." > B ROLE / PITS / RIDING / TALKING) is a group and its bins are
  // the blocks. Bins in the footage bin that only hold clips (or RED mags) are blocks of one group
  // named after the footage bin itself. Day bins (Day0_..., Day 2) are titled "Day 00" and come
  // first, in day order; other groups follow by name.
  function group(bin, own) {
    var skipped = [], sources = [], kids = own || childBins(bin);
    for (var j = 0; j < kids.length; j++) { var src = source(kids[j], skipped); if (src) sources.push(src); }
    var m = DAY_RE.exec(String(bin.name)), n = m ? parseInt(m[1], 10) : null;
    return { bin: String(bin.name), nodeId: String(bin.nodeId), day: n, label: n === null ? "g" + String(bin.nodeId) : (n < 10 ? "0" : "") + n,
      title: n === null ? String(bin.name) : "Day " + (n < 10 ? "0" : "") + n, sources: sources, loose: own ? [] : looseClips(bin), skipped: skipped };
  }
  function scan(p, params) {
    var root = footageRoot(p, params.bin);
    if (root.error) return T.fail(root.error);
    var days = [], kids = childBins(root.bin), blocks = [], i;
    for (i = 0; i < kids.length; i++) {
      if (hasGroupBins(kids[i])) days.push(group(kids[i]));
      else blocks.push(kids[i]);
    }
    if (blocks.length) { var g = group(root.bin, blocks); g.loose = looseClips(root.bin); days.push(g); }
    for (i = days.length - 1; i >= 0; i--) if (!days[i].sources.length) days.splice(i, 1);
    if (!days.length) return T.fail("No bins with clips in \"" + root.path + "\". Select the bin that holds the day, card or camera bins (e.g. 02 FOOTAGE/LakePlacid).");
    days.sort(function (a, b) {
      if (a.day !== null && b.day !== null) return a.day - b.day;
      if (a.day !== null || b.day !== null) return a.day !== null ? -1 : 1;
      return byName(a.bin, b.bin);
    });
    for (i = 1; i < days.length; i++) if (days[i].day !== null && days[i].day === days[i - 1].day) return T.fail("Two bins are Day " + days[i].day + ": \"" + days[i - 1].bin + "\" and \"" + days[i].bin + "\". Rename or merge one first.");
    var seqNames = [], seqs = p.sequences;
    for (i = 0; i < seqs.numSequences; i++) seqNames.push(String(seqs[i].name));
    var front = app.project ? String(app.project.path) : "";
    return T.ok(days.length + " group(s) in \"" + root.path + "\".", { project: { name: String(p.name), path: String(p.path) }, front: front,
      root: { path: root.path, nodeId: String(root.bin.nodeId) }, days: days, sequences: seqNames });
  }

  function seqById(p, id) {
    var seqs = p.sequences;
    for (var i = 0; i < seqs.numSequences; i++) if (String(seqs[i].sequenceID) === String(id)) return seqs[i];
    return null;
  }
  function seqSettings(s) {
    var tb = parseFloat(s.timebase);
    return { id: String(s.sequenceID), name: String(s.name), width: Number(s.frameSizeHorizontal), height: Number(s.frameSizeVertical),
      timebase: tb, fps: tb > 0 ? Math.round(T.TICKS_PER_SECOND / tb * 1000) / 1000 : 0,
      videoTracks: s.videoTracks.numTracks, audioTracks: s.audioTracks.numTracks };
  }
  function front(p) { try { return T.samePath(app.project.path, p.path); } catch (e) { return false; } }

  function create(p, params) {
    var name = String(params.name || "");
    if (!name) return T.fail("No sequence name.");
    if (!front(p)) return T.fail("Premiere switched to another project (" + String(app.project.name) + "). Click into " + String(p.name) + " and press Build again.");
    var seqs = p.sequences, before = {}, i;
    for (i = 0; i < seqs.numSequences; i++) {
      if (String(seqs[i].name) === name) return T.fail("A sequence called \"" + name + "\" already exists; it was left alone.");
      before[String(seqs[i].sequenceID)] = true;
    }
    var preset = new File(String(params.preset || ""));
    if (!preset.exists) return T.fail("Sequence preset not found: " + params.preset);
    app.enableQE();
    qe.project.newSequence(name, preset.fsName);
    var made = null;
    for (var tries = 0; tries < 20 && !made; tries++) {
      seqs = p.sequences;
      for (i = 0; i < seqs.numSequences; i++) if (!before[String(seqs[i].sequenceID)]) { made = seqs[i]; break; }
      if (!made) $.sleep(250);
    }
    if (!made) return T.fail("Premiere did not make the sequence \"" + name + "\" (checked for 5 s).");
    if (String(made.name) !== name) return T.fail("The new sequence is called \"" + made.name + "\", not \"" + name + "\".", seqSettings(made));
    return T.ok("Made \"" + name + "\".", seqSettings(made));
  }

  // Clip on a track that starts at startTicks (within half a frame), or null.
  function clipAt(track, startTicks, half) {
    var cl = track.clips;
    for (var i = cl.numItems - 1; i >= 0; i--) {
      var s = parseFloat(cl[i].start.ticks);
      if (Math.abs(s - startTicks) < half) return cl[i];
      if (s < startTicks - half) break;
    }
    return null;
  }
  function lastEnd(tracks) {
    var e = 0;
    for (var t = 0; t < tracks.numTracks; t++) {
      var cl = tracks[t].clips;
      if (cl.numItems) e = Math.max(e, parseFloat(cl[cl.numItems - 1].end.ticks));
    }
    return e;
  }
  // Project items by nodeId, read fresh for each call: node ids are not stable once Premiere has
  // switched between projects (23 Oct 2026: a cached id placed a different clip), so every hit is
  // also checked against the clip's name and media path from the scan.
  function itemById(p, id, cache) {
    if (cache[id]) return cache[id];
    var st = [p.rootItem];
    while (st.length) {
      var b = st.pop();
      for (var c = 0; c < b.children.numItems; c++) {
        var ch = b.children[c];
        if (isBin(ch)) st.push(ch);
        else cache[String(ch.nodeId)] = ch;
      }
    }
    return cache[id] || null;
  }

  // params.startFrame + params.items [{ nodeId, audioTrack (index, for audio-only clips) }]: the
  // clips go back to back from startFrame, each at the frame the one before really ended on
  // (Premiere floors a 24 fps clip in a 25 fps sequence to whole frames). Only empty places are
  // used: nothing on any track may end after the start. Every placement is read back.
  function place(p, params) {
    var s = seqById(p, params.sequenceId);
    if (!s) return T.fail("Sequence not found (it may have been deleted): " + params.sequenceId);
    var tb = parseFloat(s.timebase), half = tb / 2, out = [], cache = {};
    var items = params.items || [], frame = Number(params.startFrame) || 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i], startTicks = frame * tb, r = { nodeId: it.nodeId, frame: frame };
      out.push(r);
      var pi = itemById(p, String(it.nodeId), cache);
      if (!pi) { r.error = "clip not found in the project"; break; }
      if ((it.name && String(pi.name) !== String(it.name)) || (it.path && mediaPath(pi) !== String(it.path))) {
        r.error = "the project item for " + it.name + " is now \"" + pi.name + "\" (the project changed since the scan); nothing placed"; break;
      }
      var busyEnd = Math.max(lastEnd(s.videoTracks), lastEnd(s.audioTracks));
      if (busyEnd > startTicks + half) { r.error = "the timeline is not empty at " + T.fmt(startTicks / T.TICKS_PER_SECOND) + " (something ends at " + T.fmt(busyEnd / T.TICKS_PER_SECOND) + "); nothing placed over it"; break; }
      var sec = startTicks / T.TICKS_PER_SECOND;
      if (it.audioTrack !== undefined && it.audioTrack !== null) {
        if (it.audioTrack >= s.audioTracks.numTracks) { r.error = "audio track A" + (it.audioTrack + 1) + " does not exist"; break; }
        s.audioTracks[it.audioTrack].overwriteClip(pi, sec);
      } else {
        s.videoTracks[0].overwriteClip(pi, sec);
      }
      // Read back: what landed at this start on each track.
      var v = clipAt(s.videoTracks[0], startTicks, half), end = 0, aud = [], t;
      if (v && String(v.projectItem.nodeId) !== String(it.nodeId)) v = null;
      if (v) { r.video = true; r.startTicks = parseFloat(v.start.ticks); end = parseFloat(v.end.ticks); }
      for (t = 0; t < s.audioTracks.numTracks; t++) {
        var a = clipAt(s.audioTracks[t], startTicks, half);
        if (a && String(a.projectItem.nodeId) === String(it.nodeId)) {
          aud.push(t);
          if (!v && r.startTicks === undefined) r.startTicks = parseFloat(a.start.ticks);
          end = Math.max(end, parseFloat(a.end.ticks));
        }
      }
      r.audioTracks = aud;
      if (!v && !aud.length) { r.error = "Premiere placed nothing for this clip"; break; }
      if (Math.abs(r.startTicks - startTicks) >= half) { r.error = "landed at " + T.fmt(r.startTicks / T.TICKS_PER_SECOND) + " instead of " + T.fmt(sec); break; }
      r.endTicks = end;
      r.offGrid = Math.abs(end / tb - Math.round(end / tb)) > 1e-6;
      r.endFrame = Math.floor(end / tb + 1e-6);
      if (r.endFrame <= frame) { r.error = "it is shorter than one frame on the timeline"; break; }
      frame = r.endFrame;
    }
    var bad = null;
    for (i = 0; i < out.length; i++) if (out[i].error) bad = out[i];
    if (bad) return T.fail("Placing stopped: " + bad.error + ".", { placed: out, endFrame: frame });
    return T.ok(out.length + " clip(s) placed and read back.", { placed: out, endFrame: frame });
  }

  // One audio track at the bottom (QE addTracks; the sequence is opened first because QE works
  // on the active sequence). params.kind: QE audio track type. Checks the tracks above kept their
  // clips.
  function addTrack(p, params) {
    var s = seqById(p, params.sequenceId);
    if (!s) return T.fail("Sequence not found: " + params.sequenceId);
    if (!front(p)) return T.fail("Premiere switched to another project; click into " + String(p.name) + " first.");
    var n = s.audioTracks.numTracks, before = [], i;
    for (i = 0; i < n; i++) before.push(s.audioTracks[i].clips.numItems);
    p.openSequence(String(s.sequenceID));
    var active = p.activeSequence;
    if (!active || String(active.sequenceID) !== String(s.sequenceID)) return T.fail("Could not open \"" + s.name + "\" to add a track.");
    app.enableQE();
    var qs = qe.project.getActiveSequence();
    // addTracks(video count, video index, audio count, audio type, audio index, submix count, submix type, submix index)
    qs.addTracks(0, s.videoTracks.numTracks, 1, Number(params.kind || 0), n, 0, 0, 0);
    s = seqById(p, params.sequenceId);
    if (s.audioTracks.numTracks !== n + 1) return T.fail("Premiere did not add the audio track (audio " + n + " -> " + s.audioTracks.numTracks + ").");
    for (i = 0; i < n; i++) if (s.audioTracks[i].clips.numItems !== before[i]) return T.fail("Adding the audio track moved the existing tracks (A" + (i + 1) + " changed).");
    return T.ok("Added audio track A" + (n + 1) + ".", { index: n, audioTracks: n + 1 });
  }

  function marker(p, params) {
    var s = seqById(p, params.sequenceId);
    if (!s) return T.fail("Sequence not found: " + params.sequenceId);
    var tb = parseFloat(s.timebase), a = params.startFrame * tb / T.TICKS_PER_SECOND, b = params.endFrame * tb / T.TICKS_PER_SECOND;
    var m = s.markers.createMarker(a);
    m.name = String(params.name);
    try { m.end = b; } catch (e) {}
    if (Math.abs(m.end.seconds - b) >= 0.02) { try { m.end = String(Math.round(params.endFrame * tb)); } catch (e2) {} }
    var colour = null;
    if (params.colour !== undefined && params.colour !== null) {
      try { m.setColorByIndex(Number(params.colour)); } catch (e3) {}
      try { colour = m.getColorByIndex(); } catch (e4) { colour = null; }
    }
    var r = { name: String(m.name), start: m.start.seconds, end: m.end.seconds, type: String(m.type), colour: colour };
    if (r.name !== String(params.name)) return T.fail("Marker name did not stick.", r);
    if (Math.abs(r.start - a) >= 0.02 || Math.abs(r.end - b) >= 0.02) return T.fail("Marker \"" + r.name + "\" spans " + T.fmt(r.start) + "-" + T.fmt(r.end) + ", not " + T.fmt(a) + "-" + T.fmt(b) + ".", r);
    return T.ok("Marker \"" + r.name + "\" " + T.fmt(r.start) + "-" + T.fmt(r.end) + ".", r);
  }

  function childBin(parent, name, created) {
    for (var i = 0; i < parent.children.numItems; i++) if (isBin(parent.children[i]) && String(parent.children[i].name) === name) return parent.children[i];
    var b = parent.createBin(name);
    if (b) created.push(name);
    return b;
  }
  function holds(bin, nodeId) {
    for (var i = 0; i < bin.children.numItems; i++) if (String(bin.children[i].nodeId) === String(nodeId)) return true;
    return false;
  }
  // params.moves: [{ sequenceId, to: "uncut" | "selects" }]
  function bins(p, params) {
    var created = [];
    var top = childBin(p.rootItem, String(params.sequencesBin || "01 SEQUENCES"), created);
    if (!top) return T.fail("Could not make the bin " + (params.sequencesBin || "01 SEQUENCES") + ".");
    var sel = childBin(top, "Selects", created), unc = sel ? childBin(sel, "UNCUT", created) : null;
    if (!sel || !unc) return T.fail("Could not make the Selects/UNCUT bins.");
    var moves = params.moves || [], done = [], bad = [];
    for (var i = 0; i < moves.length; i++) {
      var s = seqById(p, moves[i].sequenceId), dest = moves[i].to === "uncut" ? unc : sel;
      if (!s) { bad.push({ name: moves[i].sequenceId, reason: "sequence not found" }); continue; }
      var item = s.projectItem;
      if (!holds(dest, item.nodeId)) item.moveBin(dest);
      if (holds(dest, item.nodeId)) done.push(String(s.name));
      else bad.push({ name: String(s.name), reason: "did not move into " + (moves[i].to === "uncut" ? "Selects/UNCUT" : "Selects") });
    }
    var d = { moved: done, failed: bad, createdBins: created };
    if (bad.length) return T.fail(bad.length + " sequence(s) could not be filed.", d);
    return T.ok(done.length + " sequence(s) filed" + (created.length ? " (made bins: " + created.join(", ") + ")" : "") + ".", d);
  }

  function readback(p, params) {
    var s = seqById(p, params.sequenceId);
    if (!s) return T.fail("Sequence not found: " + params.sequenceId);
    var tb = parseFloat(s.timebase);
    function tracks(list) {
      var out = [];
      for (var t = 0; t < list.numTracks; t++) {
        var cl = list[t].clips, rows = [];
        for (var c = 0; c < cl.numItems; c++) rows.push([parseFloat(cl[c].start.ticks) / tb, parseFloat(cl[c].end.ticks) / tb, String(cl[c].projectItem ? cl[c].projectItem.nodeId : "")]);
        out.push(rows);
      }
      return out;
    }
    var marks = [], m = s.markers.getFirstMarker();
    while (m) {
      var col = null;
      try { col = m.getColorByIndex(); } catch (e) {}
      marks.push({ name: String(m.name), start: m.start.ticks / tb, end: m.end.ticks / tb, type: String(m.type), colour: col });
      m = s.markers.getNextMarker(m);
    }
    var d = seqSettings(s);
    d.video = tracks(s.videoTracks);
    d.audio = tracks(s.audioTracks);
    d.markers = marks;
    return T.ok("Read back \"" + s.name + "\".", d);
  }
}(PenyToolkit));
