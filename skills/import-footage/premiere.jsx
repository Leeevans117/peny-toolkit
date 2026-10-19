// Import footage, Premiere side. Ported from Master Footage Importer (CEP build,
// jsx/main.jsx, com.peny.importredmirrorbins.cep 2.0.0). Same bin logic:
//  - the root bin (first path segment) reuses an existing bin of that name anywhere in
//    the project if there is exactly one, otherwise it is found/created at the root;
//  - every further segment is a direct child bin, found or created.
// Changed: an import is judged by reading the bin back, never by importFiles' return
// value, and only files that are really missing get a one-at-a-time retry (the
// original retried every file whenever importFiles returned false, which can import
// duplicates if that return is wrong). Nothing is deleted, renamed or moved.
//   action "index"  -> builds the project's media-path index (kept in Premiere; returns a count)
//   action "exists" -> params.paths: returns the ones already in the project (small replies only;
//                      a 600 KB reply with every path was lost on the way back to the panel)
//   action "import" -> params.chain [bin names], params.paths [files], params.numbered
(function (T) {
  var I = T.importer = T.importer || {};

  // Media Browser stores files on the start-up disk as /Volumes/<disk name>/Users/...,
  // importFiles stores /Users/...; I.bootPrefixes (sent by the panel) maps the first
  // form to the second so the same file is never imported twice.
  I.bootPrefixes = I.bootPrefixes || [];
  // Used only as a comparison key. Lower-cased because Mac disks ignore letter case:
  // a clip stored as ".mp4" in the project is the same file as ".MP4" on disk.
  function norm(p) {
    if (!p) return p;
    var s = String(p).replace(/\\/g, "/").toLowerCase()
      // A drive copy of the office server keeps its path as a folder named "/Volumes/" (shown
      // as ":Volumes/:ampdata" in the shell): the same file as /Volumes/ampdata/... .
      .replace(/^.*\/:volumes\/:/, "/volumes/");
    for (var i = 0; i < I.bootPrefixes.length; i++) {
      var pre = String(I.bootPrefixes[i]).toLowerCase();
      if (s.indexOf(pre + "/") === 0) { s = s.substring(pre.length); break; }
    }
    return s;
  }

  function index() {
    I.binsByName = {};
    I.binCache = {};
    I.pathIndex = {};
    var count = 0, stack = [app.project.rootItem];
    while (stack.length) {
      var bin = stack.pop();
      for (var i = 0; i < bin.children.numItems; i++) {
        var ch = bin.children[i];
        if (ch.type == ProjectItemType.BIN) {
          (I.binsByName[ch.name] = I.binsByName[ch.name] || []).push(ch);
          stack.push(ch);
        } else {
          try { var mp = ch.getMediaPath ? ch.getMediaPath() : null; if (mp) { I.pathIndex[norm(mp)] = true; count++; } } catch (e) {}
        }
      }
    }
    return T.ok(count + " media items already in the project.", { count: count });
  }

  function exists(params) {
    if (!I.pathIndex) index();
    var paths = params.paths || [], found = [];
    for (var i = 0; i < paths.length; i++) if (I.pathIndex[norm(paths[i])]) found.push(paths[i]);
    return T.ok(found.length + " of " + paths.length + " already in the project.", { found: found });
  }

  function childBin(parent, name) {
    for (var i = 0; i < parent.children.numItems; i++) {
      var ch = parent.children[i];
      if (ch.type == ProjectItemType.BIN && ch.name === name) return { bin: ch, created: false };
    }
    var made = parent.createBin(name);
    if (I.binsByName) (I.binsByName[name] = I.binsByName[name] || []).push(made);
    return { bin: made, created: true };
  }

  function resolveChain(chain, createdBins) {
    var key = chain.join("\u0001");
    if (I.binCache && I.binCache[key]) return I.binCache[key];
    var matches = (I.binsByName && I.binsByName[chain[0]]) || [], current, r;
    if (matches.length === 1) current = matches[0];
    else { r = childBin(app.project.rootItem, chain[0]); current = r.bin; if (r.created) createdBins.push(chain[0]); }
    for (var i = 1; i < chain.length; i++) {
      r = childBin(current, chain[i]);
      current = r.bin;
      if (r.created) createdBins.push(chain.slice(0, i + 1).join(" / "));
    }
    if (I.binCache) I.binCache[key] = current;
    return current;
  }

  function mediaPathsIn(bin) {
    var have = {};
    for (var i = 0; i < bin.children.numItems; i++) {
      try { var mp = bin.children[i].getMediaPath(); if (mp) have[norm(mp)] = true; } catch (e) {}
    }
    return have;
  }

  function doImport(params) {
    var chain = params.chain || [], paths = params.paths || [], numbered = !!params.numbered;
    if (!chain.length) return T.fail("No bin path given.");
    if (!paths.length) return T.ok("Nothing to import.", { imported: [], failed: [] });
    var createdBins = [], bin;
    try { bin = resolveChain(chain, createdBins); } catch (e) { return T.fail("Could not find or create the bin: " + e); }

    var before = mediaPathsIn(bin), ret = null;
    try { ret = app.project.importFiles(paths, true, bin, numbered); } catch (e2) { ret = "error: " + e2; }
    var have = mediaPathsIn(bin), missing = [], i;
    for (i = 0; i < paths.length; i++) if (!have[norm(paths[i])]) missing.push(paths[i]);

    var retried = [];
    for (i = 0; i < missing.length; i++) {
      try { app.project.importFiles([missing[i]], true, bin, numbered); } catch (e3) {}
      retried.push(missing[i]);
    }
    if (retried.length) have = mediaPathsIn(bin);

    var imported = [], failed = [], already = [];
    for (i = 0; i < paths.length; i++) {
      var p = norm(paths[i]);
      if (have[p] && I.pathIndex) I.pathIndex[p] = true;
      if (before[p]) already.push(paths[i]);
      else if (have[p]) imported.push(paths[i]);
      else failed.push(paths[i]);
    }
    var s = imported.length + " imported into \"" + chain.join(" / ") + "\"" + (failed.length ? ", " + failed.length + " failed" : "") + ".";
    var d = { bin: chain.join(" / "), imported: imported, failed: failed, alreadyInBin: already,
      createdBins: createdBins, importFilesReturned: String(ret), retriedOneByOne: retried.length };
    return failed.length ? { ok: false, error: s, summary: s, details: d } : T.ok(s, d);
  }

  // ---- Linked R3D + wav sequences ----
  // Premiere cannot script Merge Clips (checked on 26.5.2: only isMergedClip exists), so
  // for each RED clip with a matched wav this builds one sequence, named exactly after
  // the clip, in a "Synced" bin inside the card bin: the R3D (with its own audio) from
  // createNewSequenceFromClips, the wav on the first empty audio track placed by
  // timecode (start timecode of each item; falls back to lining up the starts when a
  // timecode is missing), then everything linked and the link read back.
  function findByMedia(bin, mediaPath) {
    var want = norm(mediaPath);
    for (var i = 0; i < bin.children.numItems; i++) {
      var ch = bin.children[i];
      try { if (norm(ch.getMediaPath()) === want) return ch; } catch (e) {}
    }
    return null;
  }
  function childByName(bin, name) {
    for (var i = 0; i < bin.children.numItems; i++) if (bin.children[i].name === name) return bin.children[i];
    return null;
  }
  function sequenceForItem(item) {
    var seqs = app.project.sequences;
    for (var i = 0; i < seqs.numSequences; i++) {
      try { if (seqs[i].projectItem && String(seqs[i].projectItem.nodeId) === String(item.nodeId)) return seqs[i]; } catch (e) {}
    }
    return null;
  }
  function tcSeconds(item) { try { var t = item.startTime(); return t ? parseFloat(t.seconds) : NaN; } catch (e) { return NaN; } }

  function syncPair(pair) {
    var rec = { name: null, chain: pair.chain.join(" / ") };
    var createdBins = [];
    if (!I.binsByName) index();
    var card = resolveChain(pair.chain, createdBins);
    var r3d = findByMedia(card, pair.video), wav = findByMedia(card, pair.wav);
    if (!r3d || !wav) { rec.reason = "R3D or wav not found in bin " + rec.chain; return { ok: false, rec: rec }; }
    rec.name = String(r3d.name);
    var synced = childBin(card, "Synced").bin;
    // Premiere drops the extension when it names the sequence (A157_D032_0326LV_001.R3D
    // becomes A157_D032_0326LV_001), so look for both names before making another.
    var bare = rec.name.replace(/\.[^.]+$/, "");
    if (childByName(synced, rec.name) || childByName(synced, bare)) { rec.reason = "a sequence of this name is already in Synced"; return { ok: true, skipped: true, rec: rec }; }

    var seq = app.project.createNewSequenceFromClips(rec.name, [r3d], synced);
    if (!seq) {
      var made = childByName(synced, rec.name);
      seq = made ? sequenceForItem(made) : null;
    }
    if (!seq) { rec.reason = "createNewSequenceFromClips made no sequence"; return { ok: false, rec: rec }; }
    rec.sequenceId = String(seq.sequenceID);
    rec.sequenceName = String(seq.name);
    app.project.openSequence(seq.sequenceID);
    var active = app.project.activeSequence;
    if (!active || String(active.sequenceID) !== rec.sequenceId) { rec.reason = "could not make the new sequence active"; return { ok: false, rec: rec }; }

    var v = seq.videoTracks[0].clips.numItems ? seq.videoTracks[0].clips[0] : null;
    if (!v) { rec.reason = "new sequence has no video clip"; return { ok: false, rec: rec }; }
    var r3dTc = tcSeconds(r3d), wavTc = tcSeconds(wav);
    var offset = 0;
    if (!isNaN(r3dTc) && !isNaN(wavTc) && (r3dTc > 0 || wavTc > 0)) { offset = wavTc - r3dTc; rec.aligned = "timecode"; }
    else rec.aligned = "start (no timecode)";
    var pos = T.sec(v.start.ticks) + offset;
    if (pos < 0) { rec.aligned = "start (wav starts " + (-offset).toFixed(3) + " s before the video)"; pos = T.sec(v.start.ticks); }
    rec.r3dTc = r3dTc; rec.wavTc = wavTc; rec.offsetSeconds = offset;

    var target = -1;
    for (var t = 0; t < seq.audioTracks.numTracks; t++) if (seq.audioTracks[t].clips.numItems === 0) { target = t; break; }
    rec.audioTracks = seq.audioTracks.numTracks;
    if (target === -1) { rec.reason = "no empty audio track for the wav (" + seq.audioTracks.numTracks + " tracks, all used)"; return { ok: false, rec: rec }; }
    seq.audioTracks[target].overwriteClip(wav, pos);
    var w = null;
    for (var c = 0; c < seq.audioTracks[target].clips.numItems; c++) {
      var ci = seq.audioTracks[target].clips[c];
      try { if (String(ci.projectItem.nodeId) === String(wav.nodeId)) w = ci; } catch (e) {}
    }
    if (!w) { rec.reason = "wav did not land on A" + (target + 1); return { ok: false, rec: rec }; }
    rec.wavTrack = "A" + (target + 1);
    var fps = T.sequenceFps(seq) || 25;
    rec.offsetFrames = Math.round((T.sec(w.start.ticks) - T.sec(v.start.ticks) - offset) * fps);

    // Link: select every clip in the new sequence, unlink (the R3D video and its own
    // audio arrive already linked, and linkSelection will not add to an existing
    // group), then link them all as one group.
    var all = [], k;
    T.deselectAll(seq);
    for (t = 0; t < seq.videoTracks.numTracks; t++) for (k = 0; k < seq.videoTracks[t].clips.numItems; k++) all.push(seq.videoTracks[t].clips[k]);
    for (t = 0; t < seq.audioTracks.numTracks; t++) for (k = 0; k < seq.audioTracks[t].clips.numItems; k++) all.push(seq.audioTracks[t].clips[k]);
    for (k = 0; k < all.length; k++) all[k].setSelected(true, true);
    seq.unlinkSelection();
    seq.linkSelection();
    T.deselectAll(seq);
    var ids = T.linkedNodeIds(v), have = {}, missing = 0;
    have[String(v.nodeId)] = true;
    for (k = 0; k < ids.length; k++) have[ids[k]] = true;
    for (k = 0; k < all.length; k++) if (!have[String(all[k].nodeId)]) missing++;
    rec.clipsInSequence = all.length;
    rec.linked = all.length - missing;
    if (missing) { rec.reason = missing + " of " + all.length + " clips not in the link group after linkSelection"; return { ok: false, rec: rec }; }
    return { ok: true, rec: rec };
  }

  function sync(params) {
    var pairs = params.pairs || [], done = [], skipped = [], failed = [];
    for (var i = 0; i < pairs.length; i++) {
      var r;
      try { r = syncPair(pairs[i]); } catch (e) { r = { ok: false, rec: { name: pairs[i].video, reason: String(e) + (e.line ? " (line " + e.line + ")" : "") } }; }
      // Plain if/else: a nested ?: here put skipped pairs in the "made" list.
      if (r.skipped) skipped.push(r.rec);
      else if (r.ok) done.push(r.rec);
      else failed.push(r.rec);
    }
    var s = done.length + " linked R3D+wav sequence(s) made and verified, " + skipped.length + " already there, " + failed.length + " failed.";
    var d = { made: done, skipped: skipped, failed: failed };
    return failed.length ? { ok: false, error: s, summary: s, details: d } : T.ok(s, d);
  }

  // The bin an import of folder <name> lands in, found the same way resolveChain finds
  // it (one bin of that name anywhere in the project, else a root bin of that name),
  // without creating anything.
  function rootBin(params) {
    index();
    var name = String(params.name), matches = I.binsByName[name] || [], bin = null;
    if (matches.length === 1) bin = matches[0];
    else {
      var r = app.project.rootItem;
      for (var i = 0; i < r.children.numItems; i++) if (r.children[i].type == ProjectItemType.BIN && r.children[i].name === name) { bin = r.children[i]; break; }
    }
    if (!bin) return T.fail("No bin named \"" + name + "\".");
    return T.ok("Root bin: " + bin.name, { nodeId: String(bin.nodeId), name: String(bin.name), treePath: String(bin.treePath) });
  }

  T.skills["import-footage"] = function (params) {
    if (!app.project) return T.fail("No project open.");
    if (params.bootPrefixes) I.bootPrefixes = params.bootPrefixes;
    if (params.action === "index") return index();
    if (params.action === "exists") return exists(params);
    if (params.action === "import") return doImport(params);
    if (params.action === "sync") return sync(params);
    if (params.action === "rootbin") return rootBin(params);
    return T.fail("Unknown import action: " + params.action);
  };
}(PenyToolkit));
