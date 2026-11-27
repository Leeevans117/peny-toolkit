/* Zoom (photo-zoom): Netflix-style push / pull / pan on the selected clips.
 * Bakes the move into linear keyframes on each selected clip's Motion Scale, Position and (when
 * used) Rotation, relative to the clip's own Motion values (its "base", remembered per clip).
 * Older versions used a Transform effect; those zooms are set back to neutral when a clip is
 * zoomed or reset.
 * Why baked keys: the scripting API can set Bezier interpolation but not the handles, so a
 * custom curve is sampled into linear keys on whole frames (one per frame, up to 240).
 * The maths (sizes, start/end position, anchor, rotation, holds, edge cover) is zoommath.js,
 * shared with the panel's preview; see the settings list there.
 * params: the settings, plus
 *   draft (true) = about 24 keys, for Live updates while a control is moving;
 *   info (true)  = only describe the first selected clip for the preview;
 *   reset (true) = take every Zoom keyframe off the selected clips (see resetAll);
 *   refit (true) = re-key every clip Zoom has keyed on the active sequence whose length or
 *                  In point changed since (Premiere scripting has no trim event, so the panel
 *                  asks every 1.5 s while "Stretch with the clip" is on). */
// The maths is loaded fresh each time this file is evaluated (so an update takes effect without a
// Premiere restart); $.fileName is this file while $.evalFile runs it. params.mathPath (sent by
// the panel) is the fallback.
try { $.evalFile(new File($.fileName).path + "/zoommath.js"); } catch (eZ0) {}
PenyToolkit.skills["photo-zoom"] = function (params) {
  var T = PenyToolkit;
  var seq = T.activeSequence();
  if (!seq) return T.fail("No active sequence.");
  var Z = $.global.PenyZoomMath;
  if (!Z && params.mathPath) { try { $.evalFile(String(params.mathPath)); } catch (eZ) {} Z = $.global.PenyZoomMath; }
  if (!Z) return T.fail("Zoom maths (zoommath.js) did not load.");

  var W = Number(seq.frameSizeHorizontal) || 1920, H = Number(seq.frameSizeVertical) || 1080;
  var fps = T.sequenceFps(seq) || 25;

  // QE's "Transform" is AE.ADBE Geometry; the Effects panel's newer one is AE.ADBE Geometry2.
  function isTransform(cm) { var m = String(cm.matchName); return m === "AE.ADBE Geometry" || m === "AE.ADBE Geometry2"; }
  function prop(cm, names) {
    for (var q = 0; q < cm.properties.numItems; q++) {
      var dn = String(cm.properties[q].displayName);
      for (var w = 0; w < names.length; w++) if (dn === names[w]) return cm.properties[q];
    }
    return null;
  }

  if (params.refit) return refitAll();

  var sel = seq.getSelection(), clips = [];
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

  var p = Z.norm(params);
  if (p.s0 <= 0 || p.s1 <= 0) return T.fail("Sizes must be above 0%.");

  var done = [], failed = [], limited = 0, edges = 0;
  var bases = loadBases();
  for (var k = 0; k < clips.length; k++) {
    var r = zoomClip(clips[k], p, bases, !!params.draft);
    if (r.error) { failed.push(String(clips[k].name) + " (" + r.error + ")"); continue; }
    if (r.limited) limited++;
    if (r.edge) edges++;
    done.push(r.done);
  }
  saveBases(bases);
  if (!done.length) return T.fail("No clip was changed: " + failed.join("; "), { failed: failed });
  var msg = "Zoom " + p.s0 + "% to " + p.s1 + "% on " + done.length + " clip" + (done.length === 1 ? "" : "s");
  if (limited) msg += "; movement scaled down on " + limited + " so the frame edge never shows";
  if (edges) msg += "; the frame edge still shows on " + edges + " (raise the size, or move the anchor or rotation less)";
  if (failed.length) msg += "; not changed: " + failed.join(", ");
  return T.ok(msg + ".", { done: done, failed: failed, edge: edges });

  // Key one clip with settings p. bs = the remembered bases (changed in place).
  // Returns { done } or { error }.
  function zoomClip(clip, p, bs, draft) {
    var name = String(clip.name);
    try {
      // The zoom goes on Motion (27 Nov 2026): Premiere applies Transform before Motion, at the
      // clip's own size, so on a small source blown up by Motion (854x480 at 450%) every step
      // was magnified into visible stutter. Motion renders at sequence size, so it stays smooth.
      // Motion's values are absolute, so the clip's own values are kept as its "base"
      // (remembered per clip in ~/.peny-toolkit) and the zoom is relative to them.
      var mo = motionOf(clip);
      if (!mo) return { error: "no Motion" };
      var mScale = prop(mo, ["Scale"]), mPos = prop(mo, ["Position"]), mUni = prop(mo, ["Uniform Scale"]), mRot = prop(mo, ["Rotation"]);
      if (!mScale || !mPos) return { error: "Motion has no Scale/Position" };
      if (mUni && !mUni.getValue()) return { error: "Motion Uniform Scale is off" };
      var bk = baseKey(clip), base = bs[bk];
      if (!mScale.isTimeVarying() && !mPos.isTimeVarying() && !(base && base.rotKeyed && mRot && mRot.isTimeVarying())) {
        var pv = mPos.getValue();
        var rot0 = base && base.rotKeyed && typeof base.rot === "number" ? base.rot : (mRot && !mRot.isTimeVarying() ? Number(mRot.getValue()) : 0);
        base = { scale: Number(mScale.getValue()), x: Number(pv[0]), y: Number(pv[1]), rot: rot0 };
        bs[bk] = base;
      } else if (!base) {
        return { error: "its Motion already has keyframes of its own; left alone" };
      }
      if (typeof base.rot !== "number") base.rot = mRot && !mRot.isTimeVarying() ? Number(mRot.getValue()) : 0;
      var useRot = !!mRot && (p.r0 !== 0 || p.r1 !== 0);
      if (useRot && mRot.isTimeVarying() && !base.rotKeyed) return { error: "its Motion Rotation already has keyframes of its own; left alone" };

      neutralTransforms(clip); // an earlier Transform zoom would double up
      var inS = clip.inPoint.seconds, dur = clip.end.seconds - clip.start.seconds;
      var plan = Z.keys(p, dur, fps, W, H, draft ? 24 : 240, base.rot);
      var ks0 = plan.keys[0];
      reset(mScale, base.scale * ks0.scale / 100); reset(mPos, [base.x + ks0.px, base.y + ks0.py]);
      if (useRot) reset(mRot, base.rot + ks0.rot);
      else if (mRot && base.rotKeyed) { if (mRot.isTimeVarying()) mRot.setTimeVarying(false); mRot.setValue(base.rot, true); }
      base.rotKeyed = useRot;
      for (var n = 0; n < plan.keys.length; n++) {
        var kk = plan.keys[n], t = inS + kk.t, last = n === plan.keys.length - 1;
        // Premiere redraws only on the last key (redrawing on each made Apply take ~1.5 s).
        key(mScale, t, base.scale * kk.scale / 100, last && !useRot);
        key(mPos, t, [base.x + kk.px, base.y + kk.py], last && !useRot);
        if (useRot) key(mRot, t, base.rot + kk.rot, last);
      }
      // Read back: Premiere's "success" is not trusted.
      var ks = mScale.getKeys(), got = ks ? ks.length : 0;
      if (got < 2) return { error: "keys did not stick" };
      // Remember this clip's settings (the panel shows them again when it is re-selected) and
      // what length it was keyed for (refit re-keys it when that changes).
      base.set = { s0: p.s0, s1: p.s1, sx: p.sx, sy: p.sy, dx: p.dx, dy: p.dy, ax: p.ax, ay: p.ay, r0: p.r0, r1: p.r1, hold0: p.hold0, hold1: p.hold1, keep: p.keep, curve: [p.curve[0], p.curve[1], p.curve[2], p.curve[3]] };
      base.applied = { inS: inS, dur: dur, draft: !!draft };
      base.seq = String(seq.sequenceID); base.node = String(clip.nodeId);
      var where = locate(clip); if (where) { base.ti = where.ti; base.ci = where.ci; }
      return { done: { clip: name, keys: got, from: round(mScale.getValueAtKey(ks[0]) / base.scale * 100), to: round(mScale.getValueAtKey(ks[got - 1]) / base.scale * 100), dur: round(dur) }, limited: plan.limited, edge: plan.edge };
    } catch (e) {
      return { error: String(e) };
    }
  }

  // Stretch with the clip: every clip on this sequence that Zoom keyed (full pass, not a Live
  // draft) whose In point or length has changed by half a frame or more is keyed again with its
  // own settings. The remembered length is written after each refit, so Cmd+Z of a refit is not
  // redone (the remembered length then matches the clip again).
  function refitAll() {
    var bs = loadBases(), sid = String(seq.sequenceID), pp = projPath(), half = 0.5 / fps, out = [], bad = [], seen = 0;
    for (var bk in bs) {
      if (!bs.hasOwnProperty(bk)) continue;
      var b = bs[bk];
      if (!b || !b.set || !b.applied || b.applied.draft) continue;
      if (bk.indexOf(pp + "|" + sid + "|") !== 0) continue;
      seen++;
      var node = b.node || bk.split("|").pop(), clip = findClip(node, b);
      if (!clip) continue;
      var inS = clip.inPoint.seconds, dur = clip.end.seconds - clip.start.seconds;
      if (Math.abs(inS - b.applied.inS) < half && Math.abs(dur - b.applied.dur) < half) continue;
      var r = zoomClip(clip, Z.norm(b.set), bs, false);
      if (r.error) bad.push(String(clip.name) + " (" + r.error + ")"); else out.push({ clip: String(clip.name), from: round(b.applied.dur), to: round(dur) });
    }
    if (out.length || bad.length) saveBases(bs);
    return T.ok(out.length ? "Stretched the zoom on " + out.length + " clip" + (out.length === 1 ? "" : "s") + " to its new length." : "Nothing to stretch.", { refit: out, failed: bad, watched: seen });
  }
  // A clip by node id, trying the track / index it had last time first (cheap), then its
  // track, then every video track.
  function findClip(node, hint) {
    var vt = seq.videoTracks, t, j, c;
    if (hint && typeof hint.ti === "number" && hint.ti < vt.numTracks) {
      var tr = vt[hint.ti];
      if (typeof hint.ci === "number" && hint.ci < tr.clips.numItems) { c = tr.clips[hint.ci]; if (String(c.nodeId) === node) return c; }
      for (j = 0; j < tr.clips.numItems; j++) { c = tr.clips[j]; if (String(c.nodeId) === node) { hint.ci = j; return c; } }
    }
    for (t = 0; t < vt.numTracks; t++) for (j = 0; j < vt[t].clips.numItems; j++) { c = vt[t].clips[j]; if (String(c.nodeId) === node) { if (hint) { hint.ti = t; hint.ci = j; } return c; } }
    return null;
  }
  function locate(item) {
    var vt = seq.videoTracks, node = String(item.nodeId);
    for (var t = 0; t < vt.numTracks; t++) for (var j = 0; j < vt[t].clips.numItems; j++) if (String(vt[t].clips[j].nodeId) === node) return { ti: t, ci: j };
    return null;
  }

  // Reset zoom: every keyframe comes off the selected clips' Motion Scale, Position and Rotation
  // (and any old Transform zoom is set neutral). A clip Zoom remembers goes back to its own
  // size, position and rotation from before the zoom; a clip with keys but no memory of its own
  // values (zoomed on another Mac, or keyed by hand) keeps the values at its first frame.
  // Scripting cannot delete an effect (QE only has removeEffects, which would also take off
  // Lumetri etc.).
  function resetAll() {
    var bs = loadBases(), m = 0, u = 0, tz = 0, names = [];
    for (var r = 0; r < clips.length; r++) {
      var c = clips[r], bk = baseKey(c), b = bs[bk], mo2 = motionOf(c), hit = false;
      if (mo2) {
        var sc2 = prop(mo2, ["Scale"]), po2 = prop(mo2, ["Position"]), ro2 = prop(mo2, ["Rotation"]);
        var at = c.inPoint.seconds;
        if (b) {
          clear(sc2, b.scale); clear(po2, [b.x, b.y]);
          if (ro2 && (b.rotKeyed || ro2.isTimeVarying()) && typeof b.rot === "number") clear(ro2, b.rot);
          else if (ro2 && ro2.isTimeVarying()) clear(ro2, ro2.getValueAtTime(at));
          delete bs[bk]; m++; hit = true;
        } else {
          var any = false;
          if (sc2 && sc2.isTimeVarying()) { clear(sc2, sc2.getValueAtTime(at)); any = true; }
          if (po2 && po2.isTimeVarying()) { clear(po2, po2.getValueAtTime(at)); any = true; }
          if (ro2 && ro2.isTimeVarying()) { clear(ro2, ro2.getValueAtTime(at)); any = true; }
          if (any) { u++; hit = true; }
        }
      }
      var n2 = neutralTransforms(c); tz += n2;
      if (hit || n2) names.push(String(c.name));
      // Read back: no key may be left on Motion.
      if (mo2) {
        var left = [];
        var props = ["Scale", "Position", "Rotation"];
        for (var q = 0; q < props.length; q++) { var pr = prop(mo2, [props[q]]); if (pr && pr.isTimeVarying()) left.push(props[q]); }
        if (left.length) { saveBases(bs); return T.fail(String(c.name) + ": keys still on " + left.join(", ") + " after reset.", { left: left }); }
      }
    }
    saveBases(bs);
    if (!m && !u && !tz) return T.fail("The selected clips have no zoom keyframes to reset.");
    var msg = "Reset " + names.length + " clip" + (names.length === 1 ? "" : "s") + ": every Motion Scale, Position and Rotation keyframe removed";
    if (m) msg += "; " + m + " back to the clip's own size and position";
    if (u) msg += "; " + u + " had no saved size, so kept the values at their first frame";
    if (tz) msg += ". Old Transform zooms set to neutral (delete them in Effect Controls if you like)";
    return T.ok(msg + ".", { motion: m, unknown: u, transform: tz, clips: names });
  }
  function clear(pr, v) {
    if (!pr) return;
    if (pr.isTimeVarying()) pr.setTimeVarying(false); // drops every key
    pr.setValue(v, true);
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
  // Each zoomed clip's own Motion Scale/Position/Rotation, its Zoom settings ("set") and the
  // length it was keyed for ("applied"), kept in ~/.peny-toolkit/photo-zoom-bases.json
  // (written only by this script, so it is read back with eval; ExtendScript has no JSON).
  function projPath() { var pp = ""; try { pp = String(app.project.path); } catch (eK) {} return pp; }
  function baseKey(item) { return projPath() + "|" + String(seq.sequenceID) + "|" + String(item.nodeId); }
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
    var out = { count: clips.length, w: W, h: H, fps: T.sequenceFps(seq) };
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

  function round(v) { return Math.round(parseFloat(v) * 10) / 10; }

  function reset(pr, v) {
    if (pr.isTimeVarying()) pr.setTimeVarying(false); // drops every old key
    pr.setValue(v, true);
    pr.setTimeVarying(true);
  }
  function key(pr, t, v, redraw) {
    pr.addKey(t);
    try { pr.setInterpolationTypeAtKey(t, 0, false); } catch (eI) {} // 0 = linear
    pr.setValueAtKey(t, v, !!redraw);
  }
};
