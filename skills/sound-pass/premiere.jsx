// Sound Pass, Premiere side. The panel (panel.js) calls this with params.action:
//   "scan"   - the active sequence's interview voice clips (read only). A voice clip is an
//              audio clip on an unmuted track whose sound comes from a .wav (the wireless
//              recorder), directly or through a nested sequence; camera audio (R3D/MP4/MXF/MOV)
//              is left alone. params.tracks ("A1,A8") overrides the rule.
//   "copy"   - Make safe copy unless the active sequence already is a TOOLKIT COPY.
//   "set"    - on a TOOLKIT COPY: gives each listed clip one Hard Limiter (added with QE if it
//              has none) and sets Bypass / Input Boost / Maximum Amplitude, then reads them back.
//   "render" - on a TOOLKIT COPY: renders the sequence's audio (only the voice tracks unmuted)
//              to a 32-bit float wav with exportAsMediaDirect, then restores mutes and in/out.
//              Used to measure what Premiere's meters see.
//   "probe"  - read-only list of one clip's audio components (test hook).
// Hard Limiter values (measured by render on Premiere 26.5.2, 3 Oct 2026):
//   Input Boost dB = (v - 2/3) * 150, Maximum Amplitude dB = (v - 1) * 100.
//   Lee's V1 preset: Max 0.97 (-3 dB), Boost 0.70667 (+6 dB), Look-Ahead 0.13333, Release 0.375.
// Clip gain cannot be set from a script (QE staticClipGain reads but ignores writes), so the
// level is set with the limiter's Input Boost; Lee's clip gain is left as it is.
(function () {
  var T = PenyToolkit;
  var HL = "Hard Limiter";
  var VOICE_EXT = /\.wav$/i;

  T.skills["sound-pass"] = function (params) {
    var action = params.action || "scan";
    if (action === "copy") return copy();
    var seq = T.activeSequence();
    if (!seq) return T.fail("No active sequence. Open the interview sequence first.");
    if (action === "scan") return scan(seq, params);
    if (action === "set") return set(seq, params);
    if (action === "render") return render(seq, params);
    if (action === "probe") return probe(seq, params);
    if (action === "keys") return keys(seq, params);
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
  function mediaPath(it) {
    try { return it.projectItem ? String(it.projectItem.getMediaPath()) : ""; } catch (e) { return ""; }
  }
  // .wav files a nested sequence plays (unmuted tracks), depth-limited.
  function nestedWavs(seq, depth, out) {
    if (depth > 4) return out;
    for (var t = 0; t < seq.audioTracks.numTracks; t++) {
      var muted = false;
      try { muted = seq.audioTracks[t].isMuted(); } catch (e) {}
      if (muted) continue;
      var clips = seq.audioTracks[t].clips;
      for (var c = 0; c < clips.numItems; c++) {
        var it = clips[c], n = sequenceForItem(it.projectItem);
        if (n) { nestedWavs(n, depth + 1, out); continue; }
        var p = mediaPath(it);
        if (VOICE_EXT.test(p)) out[p] = true;
      }
    }
    return out;
  }
  function findComponent(it, name) {
    for (var c = 0; c < it.components.numItems; c++) if (String(it.components[c].displayName) === name) return it.components[c];
    return null;
  }
  function prop(comp, name, index) {
    for (var p = 0; p < comp.properties.numItems; p++) {
      if (index !== undefined ? p === index : String(comp.properties[p].displayName) === name) return comp.properties[p];
    }
    return null;
  }
  function hlState(it) {
    var n = 0, first = null;
    for (var c = 0; c < it.components.numItems; c++) if (String(it.components[c].displayName) === HL) { n++; if (!first) first = it.components[c]; }
    if (!first) return { count: 0 };
    return { count: n, bypass: prop(first, "", 0).getValue(), boost: prop(first, "Input Boost").getValue(), max: prop(first, "Maximum Amplitude").getValue(),
      lookAhead: prop(first, "Look-Ahead Time").getValue(), release: prop(first, "Release Time").getValue() };
  }
  // Volume > Level in dB (value 0.17783 = 0 dB: dB = 20 log10(v) + 15, checked by render).
  function volumeDb(it) {
    var v = findComponent(it, "Volume");
    if (!v) return null;
    var l = prop(v, "Level");
    if (!l) return null;
    if (l.isTimeVarying()) return "keyframed";
    var x = l.getValue();
    if (!(x > 0)) return -999;
    return Math.round((20 * Math.log(x) / Math.LN10 + 15) * 100) / 100;
  }
  // Clip gain is readable (not writable) through QE: staticClipGain, in dB.
  function qeGains(seq) {
    var out = {};
    try {
      app.enableQE();
      var qs = qe.project.getActiveSequence();
      if (!qs || String(qs.name) !== String(seq.name)) return out;
      for (var t = 0; t < seq.audioTracks.numTracks; t++) {
        var qt = qs.getAudioTrackAt(t);
        for (var i = 0; i < qt.numItems; i++) {
          var qi = qt.getItemAt(i);
          if (qi && String(qi.type) === "Clip") out[t + ":" + qi.start.ticks] = qi.staticClipGain;
        }
      }
    } catch (e) {}
    return out;
  }
  function trackFilter(text) {
    var s = String(text || "").replace(/\s+/g, "").toUpperCase();
    if (!s) return null;
    var out = {}, parts = s.split(","), any = false;
    for (var i = 0; i < parts.length; i++) { var n = parseInt(parts[i].replace(/^A/, ""), 10); if (n > 0) { out[n - 1] = true; any = true; } }
    return any ? out : null;
  }

  function scan(seq, params) {
    var only = trackFilter(params.tracks), clips = [], tracks = [], skipped = {}, gains = qeGains(seq);
    for (var t = 0; t < seq.audioTracks.numTracks; t++) {
      var tr = seq.audioTracks[t], muted = false;
      try { muted = tr.isMuted(); } catch (e) {}
      tracks.push({ index: t, label: "A" + (t + 1), muted: !!muted });
      if (only ? !only[t] : muted) continue;
      for (var c = 0; c < tr.clips.numItems; c++) {
        var it = tr.clips[c], nest = sequenceForItem(it.projectItem), p = mediaPath(it), source = p, wavs = null;
        var disabled = false;
        try { disabled = !!it.disabled; } catch (eD) {}
        if (disabled) continue;
        if (nest) {
          var w = nestedWavs(nest, 0, {}), list = [];
          for (var k in w) if (w.hasOwnProperty(k)) list.push(k);
          if (!list.length && !only) { skipped["nested " + nest.name + " (no .wav inside)"] = true; continue; }
          source = "nest:" + String(nest.name);
          wavs = list;
        } else if (!VOICE_EXT.test(p) && !only) {
          var ext = (/\.[^.\/]+$/.exec(p) || ["no file"])[0].toLowerCase();
          skipped[ext + " on A" + (t + 1)] = (skipped[ext + " on A" + (t + 1)] || 0) + 1;
          continue;
        }
        var g = gains[t + ":" + it.start.ticks];
        clips.push({ track: t, label: "A" + (t + 1), index: c, nodeId: String(it.nodeId), name: String(it.name), start: it.start.seconds, end: it.end.seconds,
          source: source, wavs: wavs, clipGainDb: g === undefined ? null : g, volumeDb: volumeDb(it), hl: hlState(it) });
      }
    }
    var sk = [];
    for (var s in skipped) if (skipped.hasOwnProperty(s)) sk.push(s + (skipped[s] === true ? "" : " x" + skipped[s]));
    if (!clips.length) return T.fail("No interview voice clips found (looked for .wav audio, directly or in nested sequences, on unmuted tracks). Skipped: " + (sk.join(", ") || "nothing"), { tracks: tracks });
    return T.ok("Found " + clips.length + " voice clip(s).", { sequence: String(seq.name), sequenceId: String(seq.sequenceID), isCopy: T.isToolkitCopy(seq),
      end: T.sec(seq.end), tracks: tracks, clips: clips, skipped: sk });
  }

  function copy() {
    var seq = T.activeSequence();
    if (!seq) return T.fail("No active sequence.");
    if (T.isToolkitCopy(seq)) return T.ok("\"" + seq.name + "\" is already a TOOLKIT COPY; levels go on it.", { copyName: String(seq.name), copyId: String(seq.sequenceID), made: false });
    var file = new File(File($.fileName).parent.parent.fsName + "/make-safe-copy/premiere.jsx");
    if (!file.exists) return T.fail("Make safe copy skill not found at " + file.fsName);
    $.evalFile(file);
    var r = T.skills["make-safe-copy"]({});
    if (!r.ok) return r;
    if (!r.details.copyIsActive) return T.fail("The copy \"" + r.details.copyName + "\" was made but is not the active sequence. Open it and run again.", r.details);
    r.details.made = true;
    return r;
  }

  function itemByNode(seq, track, nodeId) {
    var clips = seq.audioTracks[track].clips;
    for (var c = 0; c < clips.numItems; c++) if (String(clips[c].nodeId) === String(nodeId)) return clips[c];
    return null;
  }
  // Adds a Hard Limiter to the clip through QE (matched by track and start ticks).
  function addLimiter(seq, track, item) {
    app.enableQE();
    var qs = qe.project.getActiveSequence();
    if (!qs || String(qs.name) !== String(seq.name)) return "QE active sequence is not " + seq.name;
    var fx = qe.project.getAudioEffectByName(HL);
    if (!fx) return "QE has no audio effect named " + HL;
    var qt = qs.getAudioTrackAt(track), want = String(item.start.ticks);
    for (var i = 0; i < qt.numItems; i++) {
      var qi = qt.getItemAt(i);
      if (qi && String(qi.type) === "Clip" && String(qi.start.ticks) === want) { qi.addAudioEffect(fx); return null; }
    }
    return "QE item not found at " + T.fmt(item.start.seconds);
  }
  function near(a, b) { return Math.abs(Number(a) - Number(b)) < 0.0005; }

  // params.clips: [{track, nodeId, bypass, boost, max}] (boost/max are Hard Limiter values 0..1).
  function set(seq, params) {
    if (!T.isToolkitCopy(seq)) return T.fail("Sound Pass only changes a TOOLKIT COPY; \"" + seq.name + "\" is not one.");
    var list = params.clips || [], done = 0, failed = [], added = 0;
    for (var i = 0; i < list.length; i++) {
      var c = list[i], it = itemByNode(seq, c.track, c.nodeId);
      if (!it) { failed.push({ nodeId: c.nodeId, error: "clip not found" }); continue; }
      var comp = findComponent(it, HL);
      if (!comp) {
        var err = addLimiter(seq, c.track, it);
        it = itemByNode(seq, c.track, c.nodeId);
        comp = it ? findComponent(it, HL) : null;
        if (!comp) { failed.push({ nodeId: c.nodeId, error: err || "Hard Limiter did not appear" }); continue; }
        added++;
      }
      prop(comp, "Look-Ahead Time").setValue(0.1333329826593399, true);
      prop(comp, "Release Time").setValue(0.375, true);
      if (c.boost !== undefined) prop(comp, "Input Boost").setValue(c.boost, true);
      if (c.max !== undefined) prop(comp, "Maximum Amplitude").setValue(c.max, true);
      prop(comp, "", 0).setValue(!!c.bypass, true);
      it = itemByNode(seq, c.track, c.nodeId);
      var s = hlState(it);
      var good = s.count >= 1 && !!s.bypass === !!c.bypass && (c.boost === undefined || near(s.boost, c.boost)) && (c.max === undefined || near(s.max, c.max));
      if (good) done++;
      else failed.push({ nodeId: c.nodeId, start: T.fmt(it.start.seconds), wanted: c, got: s });
    }
    var r = failed.length ? T.fail(failed.length + " of " + list.length + " clip(s) did not take the limiter settings.") : T.ok(done + " clip(s) set and read back.");
    r.details.set = done; r.details.added = added; r.details.failed = failed;
    return r;
  }

  function render(seq, params) {
    if (!T.isToolkitCopy(seq)) return T.fail("Render only runs on a TOOLKIT COPY.");
    var keep = {}, saved = [], t;
    for (t = 0; t < (params.voiceTracks || []).length; t++) keep[params.voiceTracks[t]] = true;
    for (t = 0; t < seq.audioTracks.numTracks; t++) {
      var tr = seq.audioTracks[t], m = 0;
      try { m = tr.isMuted() ? 1 : 0; } catch (e) {}
      saved.push(m);
      var want = keep[t] ? 0 : 1;
      if (want !== m) tr.setMute(want);
    }
    var oldIn = seq.getInPoint(), oldOut = seq.getOutPoint();
    seq.setInPoint("0");
    seq.setOutPoint(String(seq.end));
    var t0 = new Date().getTime(), res = null, err = null;
    try { res = seq.exportAsMediaDirect(params.path, params.preset, 1); } catch (e1) { err = String(e1); }
    var ms = new Date().getTime() - t0;
    for (t = 0; t < seq.audioTracks.numTracks; t++) {
      var now = 0;
      try { now = seq.audioTracks[t].isMuted() ? 1 : 0; } catch (e2) {}
      if (now !== saved[t]) seq.audioTracks[t].setMute(saved[t]);
    }
    try { seq.setInPoint(String(oldIn)); seq.setOutPoint(String(oldOut)); } catch (e3) {}
    var restored = true;
    for (t = 0; t < seq.audioTracks.numTracks; t++) { var m2 = 0; try { m2 = seq.audioTracks[t].isMuted() ? 1 : 0; } catch (e4) {} if (m2 !== saved[t]) restored = false; }
    var f = new File(params.path);
    if (err || !f.exists) return T.fail("Render failed: " + (err || String(res)), { ms: ms });
    return T.ok("Rendered " + T.fmt(T.sec(seq.end)) + " of audio in " + (ms / 1000).toFixed(1) + " s.", { path: params.path, bytes: f.length, ms: ms, result: String(res), mutesRestored: restored, duration: T.sec(seq.end) });
  }

  // params.clips: [{track, nodeId, keys: [{t: sequence seconds, db}], clear}] - Volume > Level
  // keyframes on a TOOLKIT COPY, read back (key times are clip/media time: in + (t - start)).
  function keys(seq, params) {
    if (!T.isToolkitCopy(seq)) return T.fail("Sound Pass only changes a TOOLKIT COPY; \"" + seq.name + "\" is not one.");
    var list = params.clips || [], out = [], failed = 0;
    for (var i = 0; i < list.length; i++) {
      var c = list[i], it = itemByNode(seq, c.track, c.nodeId);
      if (!it) { out.push({ nodeId: c.nodeId, error: "clip not found" }); failed++; continue; }
      var lv = prop(findComponent(it, "Volume"), "Level");
      if (c.clear && lv.isTimeVarying()) lv.setTimeVarying(false);
      if (!lv.isTimeVarying()) lv.setTimeVarying(true);
      var off = it.inPoint.seconds - it.start.seconds, rec = { nodeId: c.nodeId, set: 0, bad: [] };
      for (var k = 0; k < c.keys.length; k++) {
        var tm = new Time(); tm.seconds = c.keys[k].t + off;
        var v = Math.pow(10, (c.keys[k].db - 15) / 20);
        lv.addKey(tm);
        lv.setValueAtKey(tm, v, true);
        var got = lv.getValueAtKey(tm);
        if (Math.abs(got - v) > 1e-4) rec.bad.push({ t: c.keys[k].t, want: v, got: got }); else rec.set++;
      }
      var all = lv.getKeys();
      rec.keysNow = all ? all.length : 0;
      if (rec.bad.length) failed++;
      out.push(rec);
    }
    return failed ? T.fail(failed + " clip(s) did not take their keyframes.", { clips: out }) : T.ok(list.length + " clip(s) keyframed and read back.", { clips: out });
  }
  function probe(seq, params) {
    var it = seq.audioTracks[params.track || 0].clips[params.clip || 0], out = [];
    for (var c = 0; c < it.components.numItems; c++) {
      var cp = it.components[c], pr = [];
      for (var p = 0; p < cp.properties.numItems; p++) { var v = null; try { v = cp.properties[p].getValue(); } catch (e) {} pr.push(String(cp.properties[p].displayName) + "=" + v); }
      out.push(String(cp.displayName) + ": " + pr.join(", "));
    }
    return T.ok("Probe", { clip: String(it.name), start: it.start.seconds, components: out });
  }
}());
