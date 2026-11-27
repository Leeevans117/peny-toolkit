/* Zoom (photo-zoom): Netflix-style push / pull / drift on the selected clips.
 * Bakes the speed curve into linear keyframes on each selected clip's Motion Scale and Position,
 * relative to the clip's own Motion values (its "base", remembered per clip). Older versions used
 * a Transform effect; those zooms are set back to neutral when a clip is zoomed or reset.
 * Why baked keys: the scripting API can set Bezier interpolation but not the handles, so a
 * custom curve is sampled into linear keys on whole frames (one per frame, up to 240).
 * params: s0, s1 (scale %), dx, dy (drift in % of frame, + = right / down), curve [x1,y1,x2,y2]
 * (CSS cubic-bezier), keep (true = limit drift so the frame edge never shows),
 * draft (true = about 24 keys, for Live updates while a control is moving; the panel sends a
 * full pass when it stops). info (true) = only describe the first selected clip for the preview.
 * reset (true) = put the selected clips' Transform back to no zoom. */
PenyToolkit.skills["photo-zoom"] = function (params) {
  var T = PenyToolkit;
  var seq = T.activeSequence();
  if (!seq) return T.fail("No active sequence.");

  var s0 = num(params.s0, 100), s1 = num(params.s1, 115);
  var dx = num(params.dx, 0) / 100, dy = num(params.dy, 0) / 100;
  var c = params.curve && params.curve.length === 4 ? params.curve : [0.42, 0, 0.58, 1];
  var keep = params.keep !== false;
  if (s0 <= 0 || s1 <= 0) return T.fail("Sizes must be above 0%.");

  var sel = seq.getSelection(), clips = [];
  // QE's "Transform" is AE.ADBE Geometry; the Effects panel's newer one is AE.ADBE Geometry2.
  function isTransform(cm) { var m = String(cm.matchName); return m === "AE.ADBE Geometry" || m === "AE.ADBE Geometry2"; }
  function prop(cm, names) {
    for (var q = 0; q < cm.properties.numItems; q++) {
      var dn = String(cm.properties[q].displayName);
      for (var w = 0; w < names.length; w++) if (dn === names[w]) return cm.properties[q];
    }
    return null;
  }
  for (var i = 0; i < sel.length; i++) {
    var it = sel[i];
    if (it && String(it.mediaType) === "Video") clips.push(it);
  }
  if (params.info) return info();
  if (!clips.length) return T.fail("Select one or more video clips on the timeline first.");
  // Safety (26 Nov 2026): a Live pass once hit 698 selected clips. More than MAX_CLIPS needs
  // params.many (the panel asks first); Live never sends it.
  var MAX_CLIPS = 12;
  if (clips.length > MAX_CLIPS && !params.many) return T.fail(clips.length + " clips are selected. Zoom works on up to " + MAX_CLIPS + " at a time; select fewer clips.", { tooMany: clips.length });
  if (params.reset) return resetAll();

  var fps = T.sequenceFps(seq) || 25, done = [], failed = [], limited = 0;
  var bases = loadBases();
  for (var k = 0; k < clips.length; k++) {
    var clip = clips[k], name = String(clip.name);
    try {
      // The zoom goes on Motion (27 Nov 2026): Premiere applies Transform before Motion, at the
      // clip's own size, so on a small source blown up by Motion (854x480 at 450%) every step
      // was magnified into visible stutter. Motion renders at sequence size, so it stays smooth.
      // Motion's Scale/Position are absolute, so the clip's own values are kept as its "base"
      // (remembered per clip in ~/.peny-toolkit) and the zoom is relative to them.
      var mo = motionOf(clip);
      if (!mo) { failed.push(name + " (no Motion)"); continue; }
      var mScale = prop(mo, ["Scale"]), mPos = prop(mo, ["Position"]), mUni = prop(mo, ["Uniform Scale"]);
      if (!mScale || !mPos) { failed.push(name + " (Motion has no Scale/Position)"); continue; }
      if (mUni && !mUni.getValue()) { failed.push(name + " (Motion Uniform Scale is off)"); continue; }
      var bk = baseKey(clip), base = bases[bk];
      if (!mScale.isTimeVarying() && !mPos.isTimeVarying()) {
        var pv = mPos.getValue();
        base = { scale: Number(mScale.getValue()), x: Number(pv[0]), y: Number(pv[1]) };
        bases[bk] = base;
      } else if (!base) {
        failed.push(name + " (its Motion already has keyframes of its own; left alone)"); continue;
      }
      neutralTransforms(clip); // an earlier Transform zoom would double up
      reset(mScale, base.scale * s0 / 100); reset(mPos, [base.x, base.y]);

      var inS = clip.inPoint.seconds, dur = clip.end.seconds - clip.start.seconds;
      // Keys on whole frames, one per frame up to 240 (else evenly spaced); Live drafts use ~24.
      var frames = Math.max(1, Math.round(dur * fps)), maxKeys = params.draft ? 24 : 240;
      var stride = Math.max(1, Math.ceil(frames / maxKeys)), steps = Math.ceil(frames / stride);
      // Edge cover shrinks the whole drift so it fits at every moment, instead of pinning the
      // picture at the edge (that made it move at full speed and then stop dead).
      var fit = 1;
      if (keep && (dx || dy)) {
        for (var g = 1; g <= 100; g++) {
          var eg = ease(c, g / 100), sg = s0 + (s1 - s0) * eg, rg = Math.max(0, (sg / 100 - 1) / 2), mg = Math.max(Math.abs(dx), Math.abs(dy)) * Math.abs(eg);
          if (mg > 1e-9) fit = Math.min(fit, rg / mg);
        }
        fit = Math.max(0, fit);
      }
      var hitEdge = fit < 0.999;
      for (var n = 0; n <= steps; n++) {
        var fr = Math.min(frames, n * stride), u = fr / frames, e = ease(c, u), t = inS + fr / fps;
        var sc = s0 + (s1 - s0) * e;
        var x = dx * fit * e, y = dy * fit * e;
        // Premiere redraws only on the last key (redrawing on each made Apply take ~1.5 s).
        key(mScale, t, base.scale * sc / 100, n === steps);
        // Moving the picture left looks like the camera moving right, so drift is negated.
        key(mPos, t, [base.x - x, base.y - y], n === steps);
      }
      if (hitEdge) limited++;
      // Read back: Premiere's "success" is not trusted.
      var ks = mScale.getKeys(), got = ks ? ks.length : 0;
      if (got < 2) { failed.push(name + " (keys did not stick)"); continue; }
      // Remember this clip's settings so the panel can show them again when it is re-selected.
      base.set = { s0: s0, s1: s1, dx: num(params.dx, 0), dy: num(params.dy, 0), keep: keep, curve: [c[0], c[1], c[2], c[3]] };
      done.push({ clip: name, keys: got, from: round(mScale.getValueAtKey(ks[0]) / base.scale * 100), to: round(mScale.getValueAtKey(ks[got - 1]) / base.scale * 100) });
    } catch (e) {
      failed.push(name + " (" + e + ")");
    }
  }
  saveBases(bases);
  if (!done.length) return T.fail("No clip was changed: " + failed.join("; "), { failed: failed });
  var msg = "Zoom " + s0 + "% to " + s1 + "% on " + done.length + " clip" + (done.length === 1 ? "" : "s");
  if (limited) msg += "; drift scaled down on " + limited + " so the frame edge never shows";
  if (failed.length) msg += "; not changed: " + failed.join(", ");
  return T.ok(msg + ".", { done: done, failed: failed });

  // Reset zoom: Motion goes back to the clip's own Scale/Position (its remembered base), and any
  // Transform zoom from the earlier version is put back to neutral (scripting cannot delete an
  // effect: QE only has removeEffects, which would also take off Lumetri etc.).
  function resetAll() {
    var bs = loadBases(), m = 0, tz = 0;
    for (var r = 0; r < clips.length; r++) {
      var b = bs[baseKey(clips[r])], mo2 = motionOf(clips[r]);
      if (b && mo2) {
        var sc2 = prop(mo2, ["Scale"]), po2 = prop(mo2, ["Position"]);
        if (sc2) { if (sc2.isTimeVarying()) sc2.setTimeVarying(false); sc2.setValue(b.scale, true); }
        if (po2) { if (po2.isTimeVarying()) po2.setTimeVarying(false); po2.setValue([b.x, b.y], true); }
        delete bs[baseKey(clips[r])]; m++;
      }
      tz += neutralTransforms(clips[r]);
    }
    saveBases(bs);
    if (!m && !tz) return T.fail("The selected clips have no zoom to reset.");
    return T.ok("Reset " + (m + tz) + " zoom" + (m + tz === 1 ? "" : "s") + ": Motion back to the clip's own size and position." + (tz ? " Old Transform zooms set to neutral (delete them in Effect Controls if you like)." : ""), { motion: m, transform: tz });
  }
  function neutralTransforms(item) {
    var cs = item.components, n2 = 0;
    for (var j = 0; j < cs.numItems; j++) {
      if (!isTransform(cs[j])) continue;
      var sc3 = prop(cs[j], ["Scale", "Scale Height"]), po3 = prop(cs[j], ["Position"]);
      var keyed = (sc3 && sc3.isTimeVarying()) || (po3 && po3.isTimeVarying());
      if (!keyed) continue;
      if (sc3) { if (sc3.isTimeVarying()) sc3.setTimeVarying(false); sc3.setValue(100, true); }
      if (po3) { if (po3.isTimeVarying()) po3.setTimeVarying(false); po3.setValue([0.5, 0.5], true); }
      n2++;
    }
    return n2;
  }
  // A clip zoomed before settings were saved: read its move back from the keys (Motion against
  // its remembered base, else an older Transform zoom). Returns sizes, drift and 25 samples of
  // how far through the move it is (0..1) at even times; the panel fits the curve to those.
  function measure(item, bb) {
    var sc = null, po = null, baseS = 100, bx = 0.5, by = 0.5, mo3 = motionOf(item);
    if (bb && mo3) {
      var a1 = prop(mo3, ["Scale"]), a2 = prop(mo3, ["Position"]);
      if (a1 && a1.isTimeVarying()) { sc = a1; po = a2; baseS = bb.scale; bx = bb.x; by = bb.y; }
    }
    if (!sc) {
      var cs = item.components;
      for (var j = 0; j < cs.numItems && !sc; j++) if (isTransform(cs[j])) { var t1 = prop(cs[j], ["Scale", "Scale Height"]); if (t1 && t1.isTimeVarying()) { sc = t1; po = prop(cs[j], ["Position"]); } }
    }
    if (!sc) return null;
    var inS = item.inPoint.seconds, dur = item.end.seconds - item.start.seconds, N = 24;
    var sv = [], pv = [];
    for (var i = 0; i <= N; i++) {
      var t = inS + dur * i / N;
      sv.push(Number(sc.getValueAtTime(t)) / baseS * 100);
      var pp = po && po.isTimeVarying() ? po.getValueAtTime(t) : [bx, by];
      pv.push([(bx - pp[0]) * 100, (by - pp[1]) * 100]);
    }
    var sA = sv[0], sB = sv[N], dX = pv[N][0], dY = pv[N][1], samples = [];
    var useScale = Math.abs(sB - sA) > 0.05;
    var span = useScale ? sB - sA : (Math.abs(dX) >= Math.abs(dY) ? dX : dY);
    if (Math.abs(span) < 1e-6) return null;
    for (var k2 = 0; k2 <= N; k2++) samples.push(useScale ? (sv[k2] - sA) / span : ((Math.abs(dX) >= Math.abs(dY) ? pv[k2][0] : pv[k2][1])) / span);
    return { s0: round(sA), s1: round(sB), dx: round(dX), dy: round(dY), samples: samples };
  }
  function motionOf(item) {
    var cs = item.components;
    for (var j = 0; j < cs.numItems; j++) if (String(cs[j].matchName) === "AE.ADBE Motion") return cs[j];
    return null;
  }
  // Each zoomed clip's own Motion Scale/Position and its Zoom settings ("set"), kept in
  // ~/.peny-toolkit/photo-zoom-bases.json
  // (written only by this script, so it is read back with eval; ExtendScript has no JSON).
  function baseKey(item) { var pp = ""; try { pp = String(app.project.path); } catch (eK) {} return pp + "|" + String(seq.sequenceID) + "|" + String(item.nodeId); }
  function basesFile() { var d = new Folder("~/.peny-toolkit"); if (!d.exists) d.create(); return new File(d.fsName + "/photo-zoom-bases.json"); }
  function loadBases() {
    var f = basesFile(), o = {};
    if (f.exists && f.open("r")) { var txt = f.read(); f.close(); try { o = eval("(" + txt + ")") || {}; } catch (eL) { o = {}; } }
    return o;
  }
  function saveBases(o) {
    var f = basesFile();
    if (f.open("w")) { f.write(T.json(o)); f.close(); }
  }

  // For the panel's preview: the clip being edited (first selected video clip, else the top clip
  // under the playhead), its file, timing, speed and frame rate, the playhead, the sequence size.
  function info() {
    var cti = 0;
    try { cti = seq.getPlayerPosition().seconds; } catch (eC0) {}
    var out = { count: clips.length, w: Number(seq.frameSizeHorizontal) || 1920, h: Number(seq.frameSizeVertical) || 1080, fps: T.sequenceFps(seq) };
    var c0 = clips[0] || null, under = false;
    if (!c0) {
      for (var tr = seq.videoTracks.numTracks - 1; tr >= 0 && !c0; tr--) {
        var vt = seq.videoTracks[tr];
        try { if (vt.isMuted()) continue; } catch (eM) {}
        for (var j = 0; j < vt.clips.numItems; j++) { var x = vt.clips[j]; if (x.start.seconds <= cti && cti < x.end.seconds) { c0 = x; under = true; break; } }
      }
    }
    if (c0) {
      var pi = c0.projectItem, path = "", speed = 1, cfps = 0;
      try { speed = c0.getSpeed(); } catch (eS) {}
      try { cfps = Number(pi.getFootageInterpretation().frameRate) || 0; } catch (eF) {}
      try { path = pi ? String(pi.getMediaPath()) : ""; } catch (eP) {}
      var proxy = "";
      try { if (pi && pi.hasProxy()) proxy = String(pi.getProxyPath()); } catch (eX) {}
      var saved = null, measured = null;
      if (!under) {
        var bb = loadBases()[baseKey(c0)];
        if (bb && bb.set) saved = bb.set;
        else measured = measure(c0, bb);
      }
      out.clip = { saved: saved, measured: measured, id: String(c0.nodeId), name: String(c0.name), path: path, proxy: proxy, inS: c0.inPoint.seconds, start: c0.start.seconds, dur: c0.end.seconds - c0.start.seconds, cti: cti, speed: speed, fps: cfps, under: under };
    }
    return T.ok(clips.length ? String(clips.length) + " selected" : "nothing selected", out);
  }

  function num(v, d) { var f = parseFloat(v); return isNaN(f) ? d : f; }
  function round(v) { return Math.round(parseFloat(v) * 10) / 10; }

  // CSS cubic-bezier: solve x(t) = u for t (bisection is plenty at 60 samples), return y(t).
  function ease(cv, u) {
    if (u <= 0) return 0;
    if (u >= 1) return 1;
    var lo = 0, hi = 1, t = u;
    for (var j = 0; j < 30; j++) {
      t = (lo + hi) / 2;
      if (bez(cv[0], cv[2], t) < u) lo = t; else hi = t;
    }
    return bez(cv[1], cv[3], t);
  }
  function bez(a, b, t) { var m = 1 - t; return 3 * m * m * t * a + 3 * m * t * t * b + t * t * t; }

  function reset(prop, v) {
    if (prop.isTimeVarying()) prop.setTimeVarying(false); // drops every old key
    prop.setValue(v, true);
    prop.setTimeVarying(true);
  }
  function key(prop, t, v, redraw) {
    prop.addKey(t);
    try { prop.setInterpolationTypeAtKey(t, 0, false); } catch (eI) {} // 0 = linear
    prop.setValueAtKey(t, v, !!redraw);
  }
};
