/* Zoom (photo-zoom) maths, shared by premiere.jsx (ExtendScript, loaded with $.evalFile) and
 * panel.js (Node require), so the preview and the keyframes always agree. ES3 only.
 *
 * Settings p (all optional, defaults in DEFAULTS):
 *   s0, s1   start / end size, % of the clip's own size
 *   sx, sy   start position, % of frame (+ = view moves right / down)
 *   dx, dy   end position, % of frame (the old "drift")
 *   ax, ay   anchor: the point of the frame the zoom pushes into and turns around,
 *            % of frame from the centre (-50 = left / top edge, +50 = right / bottom edge)
 *   r0, r1   start / end rotation, degrees (+ = clockwise, as Premiere)
 *   hold0, hold1  seconds held still at the start / end of the clip before / after the move
 *   keep     edge cover: scale the start/end positions down so the frame edge never shows
 *   curve    CSS cubic-bezier [x1, y1, x2, y2]
 *
 * Model: the picture point under the anchor stays put while the size and rotation change
 * (relative to the moment the picture is smallest); the start -> end position then moves the
 * view on top of that. Edge cover shrinks the start/end positions by one factor for the whole
 * move (pinning at the edge made the move stop dead, 27 Nov 2026), checked with all four frame
 * corners so rotation is covered too. */
(function (root) {
  var M = {};
  M.DEFAULTS = { s0: 100, s1: 115, sx: 0, sy: 0, dx: 0, dy: 0, ax: 0, ay: 0, r0: 0, r1: 0, hold0: 0, hold1: 0, keep: true, curve: [0.42, 0, 0.58, 1] };

  function num(v, d) { var f = parseFloat(v); return isNaN(f) ? d : f; }
  // Settings with every field filled and in range.
  M.norm = function (p) {
    var D = M.DEFAULTS, o = {}, k;
    p = p || {};
    for (k in D) if (D.hasOwnProperty(k) && k !== "curve" && k !== "keep") o[k] = num(p[k], D[k]);
    o.keep = p.keep !== false;
    var c = p.curve && p.curve.length === 4 ? p.curve : D.curve;
    o.curve = [num(c[0], 0.42), num(c[1], 0), num(c[2], 0.58), num(c[3], 1)];
    o.ax = Math.max(-50, Math.min(50, o.ax)); o.ay = Math.max(-50, Math.min(50, o.ay));
    o.hold0 = Math.max(0, o.hold0); o.hold1 = Math.max(0, o.hold1);
    return o;
  };

  // CSS cubic-bezier: solve x(t) = u for t by bisection, return y(t).
  function bez(a, b, t) { var m = 1 - t; return 3 * m * m * t * a + 3 * m * t * t * b + t * t * t; }
  M.ease = function (cv, u) {
    if (u <= 0) return 0;
    if (u >= 1) return 1;
    var lo = 0, hi = 1, t = u;
    for (var j = 0; j < 30; j++) { t = (lo + hi) / 2; if (bez(cv[0], cv[2], t) < u) lo = t; else hi = t; }
    return bez(cv[1], cv[3], t);
  };

  // When the move runs inside a clip of dur seconds: [a, b] in seconds from the clip's start.
  // Holds that leave less than one frame of move are scaled down to fit.
  M.window = function (p, dur, fps) {
    var f = 1 / (fps || 25), h0 = p.hold0, h1 = p.hold1, room = dur - f;
    if (room <= 0) return { a: 0, b: dur };
    if (h0 + h1 > room) { var r = room / (h0 + h1); h0 *= r; h1 *= r; }
    return { a: h0, b: dur - h1 };
  };
  // How far through the move (0..1, before easing) at t seconds from the clip's start.
  M.progress = function (p, t, dur, fps) {
    var w = M.window(p, dur, fps);
    if (w.b - w.a <= 1e-9) return t >= w.b ? 1 : 0;
    return Math.max(0, Math.min(1, (t - w.a) / (w.b - w.a)));
  };

  // The picture at eased progress e: size k (1 = clip's own size), picture offset cx, cy in
  // pixels of the W x H frame (+ = right / down), rotation rot in degrees added to the clip's own.
  M.state = function (p, e, fit, W, H) {
    var s = p.s0 + (p.s1 - p.s0) * e, k = s / 100, kmin = Math.min(p.s0, p.s1) / 100;
    if (kmin <= 0) kmin = 1e-6;
    var rot = p.r0 + (p.r1 - p.r0) * e, rref = p.s0 <= p.s1 ? p.r0 : p.r1;
    var th = (rot - rref) * Math.PI / 180, cs = Math.cos(th), sn = Math.sin(th);
    var Ax = p.ax / 100 * W, Ay = p.ay / 100 * H, q = k / kmin;
    var cx = Ax - q * (Ax * cs - Ay * sn), cy = Ay - q * (Ax * sn + Ay * cs);
    var vx = (p.sx + (p.dx - p.sx) * e) / 100 * W, vy = (p.sy + (p.dy - p.sy) * e) / 100 * H;
    return { k: k, cx: cx - fit * vx, cy: cy - fit * vy, rot: rot };
  };

  // True when the picture covers the whole frame (all four corners inside it).
  M.covers = function (st, W, H, baseRot) {
    var th = -((st.rot + (baseRot || 0)) * Math.PI / 180), cs = Math.cos(th), sn = Math.sin(th);
    var hw = W / 2, hh = H / 2, eps = 1e-6 * (W + H);
    for (var i = 0; i < 4; i++) {
      var qx = (i & 1 ? hw : -hw) - st.cx, qy = (i & 2 ? hh : -hh) - st.cy;
      var lx = (qx * cs - qy * sn) / st.k, ly = (qx * sn + qy * cs) / st.k;
      if (Math.abs(lx) > hw + eps || Math.abs(ly) > hh + eps) return false;
    }
    return true;
  };

  // Edge cover: the largest factor (0..1) for the start/end positions that keeps the frame
  // covered all through the move. edge = true when the edge shows even with no movement
  // (size too small for the anchor or rotation).
  M.fit = function (p, W, H, baseRot) {
    var f = 1, edge = false;
    if (!p.keep) return { fit: 1, edge: false };
    for (var g = 0; g <= 100; g++) {
      var e = M.ease(p.curve, g / 100);
      if (!M.covers(M.state(p, e, 0, W, H), W, H, baseRot)) { edge = true; continue; }
      if (M.covers(M.state(p, e, f, W, H), W, H, baseRot)) continue;
      var lo = 0, hi = f;
      for (var j = 0; j < 24; j++) { var mid = (lo + hi) / 2; if (M.covers(M.state(p, e, mid, W, H), W, H, baseRot)) lo = mid; else hi = mid; }
      f = lo;
    }
    return { fit: f, edge: edge };
  };

  // Keyframes for a clip dur seconds long: whole frames from the clip's start, one per frame
  // during the move up to maxKeys (else evenly spaced), plus one at the start, at each end of
  // the move and at the clip's end. Each: f (frame), t (seconds), scale (% of clip's own size),
  // px, py (offset in fractions of the frame, added to the clip's own Position), rot (degrees).
  M.keys = function (p, dur, fps, W, H, maxKeys, baseRot) {
    fps = fps || 25;
    var frames = Math.max(1, Math.round(dur * fps)), w = M.window(p, dur, fps);
    var fa = Math.max(0, Math.min(frames, Math.round(w.a * fps))), fb = Math.max(fa, Math.min(frames, Math.round(w.b * fps)));
    var span = fb - fa, stride = Math.max(1, Math.ceil(span / (maxKeys || 240)));
    var list = [0], fr;
    for (fr = fa; fr < fb; fr += stride) list.push(fr);
    list.push(fb); list.push(frames);
    var fit = M.fit(p, W, H, baseRot), out = [], last = -1;
    list.sort(function (x, y) { return x - y; });
    for (var i = 0; i < list.length; i++) {
      fr = list[i];
      if (fr === last) continue;
      last = fr;
      var u = span > 0 ? Math.max(0, Math.min(1, (fr - fa) / span)) : (fr >= fb ? 1 : 0);
      var st = M.state(p, M.ease(p.curve, u), fit.fit, W, H);
      out.push({ f: fr, t: fr / fps, scale: st.k * 100, px: st.cx / W, py: st.cy / H, rot: st.rot });
    }
    return { keys: out, fit: fit.fit, edge: fit.edge, limited: fit.fit < 0.999 };
  };

  if (typeof module !== "undefined" && module.exports) module.exports = M;
  else root.PenyZoomMath = M;
})(typeof $ !== "undefined" && $.global ? $.global : this);
