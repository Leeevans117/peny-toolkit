/* Zoom (photo-zoom), panel side. Draws the controls under the buttons (module.mount):
 * - Looks: one-tap starting points (Push, Slow push, Pull, Pan, Tilt, Drift).
 * - Start / End size (%), Drift across / up-down (% of frame), Edge cover toggle.
 *   Double-click a slider (or its name) to put it back to its default.
 * - Speed curve: a cubic-bezier editor that fills the card. Drag either blue handle, type the
 *   four numbers, pick an ease preset, or double-click the curve to reset it. The curve's slope
 *   is the speed: flat = slow, steep = fast. A live preview plays the move on a frame.
 * Motion (Lee, 26 Nov 2026): picking a look or ease glides the sliders and curve there
 * (0.32 s on the toolkit's curve, cubic-bezier(0.2, 0, 0, 1)); instant when the toolkit's
 * motion is off (M, Compact) or macOS asks for reduced motion.
 * Apply sends the settings to premiere.jsx, which bakes the curve into keyframes on each
 * selected clip. Settings are remembered on this Mac (localStorage).
 * Per clip (27 Nov 2026): every clip Zoom applies to keeps its own settings (premiere.jsx stores
 * them next to the clip's Motion base); selecting it again glides the panel back to them,
 * without re-applying. A clip Zoom has not touched keeps the panel as it is.
 * Live (Lee, 26 Nov 2026): with Live on, every change re-applies to the selected clips straight
 * away: quick ~24-key passes while a control moves (one at a time, the newest settings win),
 * then a full pass 0.45 s after it stops. Live passes are not added to the History.
 * Preview: shows the clip's first frame (frame holds report normal speed to scripts, and in a
 * hold only the first frame is right); stills load directly, video through
 * ffmpeg (RED/BRAW from the attached proxy), cached in the temp folder. Framed at the sequence's
 * size, it plays the move at the clip's real length with a time bar; the dimmed area is the part
 * of the picture the zoom pushes out of frame. Read every 0.6 s while Zoom is open (not logged);
 * with nothing selected it shows the top clip under the playhead. A clip whose frame rate differs
 * from the sequence gets a warning: that judder is in the footage, not the zoom. */
var fs = require("fs");
var os = require("os");
var path = require("path");
var crypto = require("crypto");
var childProcess = require("child_process");
var FFMPEG = [path.join(os.homedir(), "Library", "Application Support", "PenyToolkit", "bin", "ffmpeg"), "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"];
var STILLS = { png: 1, jpg: 1, jpeg: 1, gif: 1, webp: 1, bmp: 1 }; // what the panel can show directly
var FRAMES = path.join(os.tmpdir(), "peny-zoom-frames");
var STORE = "peny.photo-zoom";
var DEFAULTS = { s0: 100, s1: 115, dx: 0, dy: 0, keep: true, live: true, curve: [0.42, 0, 0.58, 1] };
var LOOKS = [
  { label: "Slow push", s0: 100, s1: 108, dx: 0, dy: 0 },
  { label: "Push", s0: 100, s1: 115, dx: 0, dy: 0 },
  { label: "Pull", s0: 115, s1: 100, dx: 0, dy: 0 },
  { label: "Pan →", s0: 115, s1: 115, dx: 8, dy: 0 },
  { label: "Pan ←", s0: 115, s1: 115, dx: -8, dy: 0 },
  { label: "Tilt ↑", s0: 115, s1: 115, dx: 0, dy: -8 },
  { label: "Push + drift", s0: 105, s1: 118, dx: 5, dy: -2 }
];
var EASES = [
  { label: "Linear", c: [0, 0, 1, 1] },
  { label: "Ease in-out", c: [0.42, 0, 0.58, 1] },
  { label: "Ease out", c: [0, 0, 0.3, 1] },
  { label: "Ease in", c: [0.6, 0, 1, 1] },
  { label: "Glide", c: [0.25, 0.1, 0.25, 1] },
  { label: "Doc slow", c: [0.33, 0, 0.67, 1] }
];
var SLIDERS = [
  { key: "s0", label: "Start size", unit: "%", min: 80, max: 200, step: 1 },
  { key: "s1", label: "End size", unit: "%", min: 80, max: 200, step: 1 },
  { key: "dx", label: "Drift across", unit: "%", min: -20, max: 20, step: 0.5 },
  { key: "dy", label: "Drift up/down", unit: "%", min: -20, max: 20, step: 0.5 }
];
var GLIDE_MS = 320;

module.exports = function (api) {
  var st = load();
  var root = null, ui = null, raf = 0, tween = 0;

  function load() {
    try { var v = JSON.parse(localStorage.getItem(STORE)); if (v && v.curve) { if (v.live === undefined) v.live = true; return v; } } catch (e) {}
    return clone(DEFAULTS);
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  // Every user change ends in save(), so Live hangs off it.
  function save() { try { localStorage.setItem(STORE, JSON.stringify(st)); } catch (e) {} scheduleLive(); }
  function settings(extra) {
    var p = { s0: st.s0, s1: st.s1, dx: st.dx, dy: st.dy, keep: st.keep !== false, curve: st.curve };
    if (extra) Object.keys(extra).forEach(function (k) { if (extra[k] !== undefined) p[k] = extra[k]; });
    return p;
  }

  // ---- Live ----
  var live = { busy: false, pending: false, final: false, settle: 0 };
  function scheduleLive() {
    if (!st.live) return;
    live.pending = true; pump();
    clearTimeout(live.settle);
    live.settle = setTimeout(function () { send(false); }, 450);
  }
  function pump() { if (!live.busy && live.pending) { live.pending = false; send(true); } }
  function send(draft) {
    if (live.busy) { if (!draft) live.final = true; return; }
    live.busy = true;
    var t0 = Date.now();
    api.evalSkill(settings({ draft: draft })).then(function (r) {
      live.busy = false;
      liveNote(r && r.ok ? "Live · " + (r.details && r.details.done ? r.details.done.length : 0) + " clip" + (r.details && r.details.done && r.details.done.length === 1 ? "" : "s") + " updated (" + (Date.now() - t0) + " ms)"
        : "Live · " + (r && r.error && /Select one/.test(r.error) ? "select a clip on the timeline" : r && r.details && r.details.tooMany ? r.details.tooMany + " clips selected: Live works on up to 12" : (r && r.error) || "no answer"), !(r && r.ok));
      if (live.final) { live.final = false; send(false); return; }
      pump();
    });
  }
  function liveNote(text, warn) { if (ui && ui.liveNote) { ui.liveNote.textContent = text; ui.liveNote.style.color = warn ? "var(--warn, #f5a623)" : ""; } }

  // The test inbox passes its own settings; a button press passes none.
  // More than 12 selected clips: Premiere refuses until you confirm here (Live never confirms).
  function apply(given) {
    api.status("Zoom: applying to selected clips…");
    return api.evalSkill(settings(given)).then(function (r) {
      var n = r && r.details && r.details.tooMany;
      if (n && window.confirm("Apply the zoom to all " + n + " selected clips?\n\nThis can take a while and Premiere cannot be stopped once it starts.")) {
        api.status("Zoom: applying to " + n + " clips…");
        return api.evalSkill(settings({ many: true }));
      }
      return r;
    }).then(function (r) { pollInfo(true); return r; });
  }

  // ---- Motion ----
  function motionOn() {
    if (document.body.getAttribute("data-motion") !== "on") return false;
    try { if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false; } catch (e) {}
    return true;
  }
  // cubic-bezier(0.2, 0, 0, 1), the toolkit's own curve, for every glide.
  function out(u) { return ease([0.2, 0, 0, 1], u); }
  // Glide st (sizes, drifts, curve) to target, repainting as it goes.
  // quiet: the values came from the clip itself (re-selected), so Live does not re-apply them.
  function glideTo(target, quiet) {
    cancelAnimationFrame(tween);
    var from = clone(st), keys = Object.keys(target);
    function setAt(u) {
      keys.forEach(function (k) {
        if (k === "curve") st.curve = from.curve.map(function (v, i) { return v + (target.curve[i] - v) * u; });
        else st[k] = from[k] + (target[k] - from[k]) * u;
      });
      refresh();
    }
    function finish() {
      keys.forEach(function (k) { if (k === "curve") st.curve = target.curve.slice(); else st[k] = target[k]; });
      if (quiet) { try { localStorage.setItem(STORE, JSON.stringify(st)); } catch (e) {} } else save();
      refresh();
    }
    clearTimeout(glideTimer);
    if (!motionOn()) { finish(); return; }
    var t0 = performance.now(), done = false;
    function land() { if (done) return; done = true; cancelAnimationFrame(tween); clearTimeout(glideTimer); finish(); }
    // Frames slow down while the panel is in the background, so a timer makes sure it lands.
    glideTimer = setTimeout(land, GLIDE_MS + 60);
    (function step(now) {
      if (done) return;
      var u = Math.min(1, (now - t0) / GLIDE_MS);
      setAt(out(u));
      if (u < 1) tween = requestAnimationFrame(step); else land();
    })(t0);
  }
  var glideTimer = 0;

  // ---- UI ----
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function css() {
    var old = document.getElementById("pz-style"); if (old) old.parentNode.removeChild(old);
    var s = el("style"); s.id = "pz-style";
    s.textContent =
      ".pz { display: flex; flex-direction: column; gap: 12px; margin-top: 12px; }" +
      ".pz .cap { font-size: var(--fs-xs, 11px); color: var(--dim); display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; }" +
      ".pz .cap em { font-style: normal; color: var(--faint); }" +
      ".pz .chips { display: flex; flex-wrap: wrap; gap: 6px; }" +
      ".pz .chips button { font: inherit; font-size: var(--fs-xs, 11px); padding: 5px 10px; border-radius: 999px; border: 1px solid var(--line); background: transparent; color: var(--text); cursor: pointer;" +
      "  transition: border-color .18s, color .18s, background-color .18s, transform .12s cubic-bezier(.2,0,0,1); }" +
      ".pz .chips button:hover { background: var(--surface-3, rgba(255,255,255,.06)); }" +
      ".pz .chips button:active { transform: scale(.95); }" +
      ".pz .chips button.on { border-color: var(--accent); color: var(--accent); }" +
      ".pz .sl { display: grid; grid-template-columns: 116px minmax(0, 1fr) 64px; align-items: center; gap: 10px; font-size: var(--fs-xs, 11px); color: var(--dim); }" +
      ".pz .sl > span { cursor: default; user-select: none; }" +
      ".pz .sl input[type=range] { width: 100%; accent-color: var(--accent); cursor: pointer; }" +
      ".pz input[type=number] { width: 100%; min-width: 0; box-sizing: border-box; font: var(--fs-xs, 11px) var(--mono); background: transparent; color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 3px 5px; text-align: right;" +
      "  transition: border-color .18s; }" +
      ".pz input[type=number]:focus { border-color: var(--accent); outline: none; }" +
      ".pz .flash { animation: pz-flash .5s cubic-bezier(.2,0,0,1); }" +
      "@keyframes pz-flash { 0% { color: var(--accent); border-color: var(--accent); } 100% { } }" +
      ".pz .curve { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 0.8fr); gap: 12px; align-items: start; }" +
      "@media (max-width: 440px) { .pz .curve { grid-template-columns: 1fr; } }" +
      ".pz canvas.cv { width: 100%; height: auto; aspect-ratio: 1; border: 1px solid var(--line); border-radius: 10px; cursor: grab; touch-action: none; display: block; }" +
      ".pz canvas.cv.grab { cursor: grabbing; }" +
      ".pz canvas.pv { width: 100%; height: auto; aspect-ratio: 16 / 10; border-radius: 8px; display: block; }" +
      ".pz .bez { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; margin-top: 8px; }" +
      ".pz .bez label { display: flex; flex-direction: column; gap: 2px; font-size: 10px; color: var(--faint); }" +
      ".pz .keep { display: flex; align-items: center; gap: 8px; font-size: var(--fs-xs, 11px); color: var(--dim); cursor: pointer; }";
    document.head.appendChild(s);
  }

  function render() {
    if (!root) return;
    css();
    root.innerHTML = "";
    ui = { sliders: {}, bez: [], lookBtns: [], easeBtns: [] };
    var w = el("div", "pz");

    w.appendChild(capRow("Looks", "tap to start from one"));
    var looks = el("div", "chips");
    LOOKS.forEach(function (lk) {
      var b = el("button", null, lk.label);
      b.addEventListener("click", function () { glideTo({ s0: lk.s0, s1: lk.s1, dx: lk.dx, dy: lk.dy }); });
      looks.appendChild(b); ui.lookBtns.push({ b: b, lk: lk });
    });
    w.appendChild(looks);

    w.appendChild(capRow("Move", "double-click a slider to reset it"));
    SLIDERS.forEach(function (d) { w.appendChild(slider(d)); });
    var kp = el("label", "keep"); var kc = el("input"); kc.type = "checkbox"; kc.checked = st.keep !== false; ui.keepBox = kc;
    kc.addEventListener("change", function () { st.keep = kc.checked; save(); });
    kp.appendChild(kc); kp.appendChild(el("span", null, "Edge cover (limit drift so the frame edge never shows)"));
    w.appendChild(kp);
    var lv = el("label", "keep"); var lc = el("input"); lc.type = "checkbox"; lc.checked = !!st.live;
    lc.addEventListener("change", function () { st.live = lc.checked; liveNote(st.live ? "Live · on" : "Live off: press Apply to update the clips"); save(); });
    lv.appendChild(lc); lv.appendChild(el("span", null, "Live: update the selected clips as you adjust"));
    w.appendChild(lv);
    ui.liveNote = el("div", "cap"); ui.liveNote.style.minHeight = "1.2em";
    ui.liveNote.textContent = st.live ? "Live · on" : "Live off: press Apply to update the clips";
    w.appendChild(ui.liveNote);

    w.appendChild(capRow("Speed curve", "drag the blue dots · double-click to reset"));
    var eases = el("div", "chips");
    EASES.forEach(function (ez) {
      var b = el("button", null, ez.label);
      b.addEventListener("click", function () { glideTo({ curve: ez.c }); });
      eases.appendChild(b); ui.easeBtns.push({ b: b, c: ez.c });
    });
    w.appendChild(eases);

    var box = el("div", "curve");
    ui.cv = el("canvas", "cv"); ui.cv.title = "Drag the blue dots to shape the speed. Double-click to reset.";
    box.appendChild(ui.cv);
    var side = el("div");
    ui.pv = el("canvas", "pv"); side.appendChild(ui.pv);
    ui.fpsNote = el("div", "cap"); ui.fpsNote.style.color = "var(--warn, #f5a623)"; ui.fpsNote.style.marginTop = "6px";
    ui.fpsNote.textContent = media.fpsNote || ""; ui.fpsNote.style.display = media.fpsNote ? "" : "none";
    side.appendChild(ui.fpsNote);
    var bez = el("div", "bez");
    [["Start handle · time", 0], ["Start handle · move", 1], ["End handle · time", 2], ["End handle · move", 3]].forEach(function (f) {
      var lab = el("label"); lab.appendChild(el("span", null, f[0]));
      var n = el("input"); n.type = "number"; n.step = 0.01; n.min = f[1] % 2 ? -0.5 : 0; n.max = f[1] % 2 ? 1.5 : 1;
      n.addEventListener("change", function () {
        var v = parseFloat(n.value); if (isNaN(v)) return;
        st.curve[f[1]] = clampCurve(f[1], v); save(); refresh();
      });
      lab.appendChild(n); bez.appendChild(lab); ui.bez.push(n);
    });
    side.appendChild(bez);
    box.appendChild(side);
    w.appendChild(box);
    root.appendChild(w);

    wireCurve();
    // Canvases follow the card's width at any panel size, including when the view first opens
    // (it is hidden, so 0 wide, when mounted).
    if (window.PenyZoomRO) window.PenyZoomRO.disconnect();
    if (typeof ResizeObserver === "function") {
      window.PenyZoomRO = new ResizeObserver(function () { sizeCanvases(); refresh(); });
      window.PenyZoomRO.observe(ui.cv); window.PenyZoomRO.observe(ui.pv);
    } else {
      if (window.PenyZoomResize) window.removeEventListener("resize", window.PenyZoomResize);
      window.PenyZoomResize = function () { sizeCanvases(); refresh(); };
      window.addEventListener("resize", window.PenyZoomResize);
    }
    sizeCanvases(); refresh(); animate();
  }

  function capRow(a, b) { var c = el("div", "cap"); c.appendChild(el("span", null, a)); c.appendChild(el("em", null, b)); return c; }

  function slider(d) {
    var row = el("label", "sl"); row.title = "Double-click to reset to " + DEFAULTS[d.key] + d.unit;
    row.appendChild(el("span", null, d.label + " " + d.unit));
    var r = el("input"); r.type = "range"; r.min = d.min; r.max = d.max; r.step = d.step;
    var n = el("input"); n.type = "number"; n.min = d.min; n.max = d.max; n.step = d.step;
    r.addEventListener("input", function () { cancelAnimationFrame(tween); clearTimeout(glideTimer); st[d.key] = parseFloat(r.value); save(); refresh(); });
    n.addEventListener("change", function () { var v = parseFloat(n.value); if (isNaN(v)) return; st[d.key] = Math.max(d.min, Math.min(d.max, v)); save(); refresh(); });
    row.addEventListener("dblclick", function (ev) {
      if (ev.target === n) return; // double-click in the number box selects its text as usual
      ev.preventDefault();
      var t = {}; t[d.key] = DEFAULTS[d.key]; glideTo(t);
      n.classList.remove("flash"); void n.offsetWidth; n.classList.add("flash");
    });
    row.appendChild(r); row.appendChild(n);
    ui.sliders[d.key] = { r: r, n: n, d: d };
    return row;
  }

  // Paint every control from st (no rebuild, so glides and drags stay smooth).
  function refresh() {
    if (!ui) return;
    Object.keys(ui.sliders).forEach(function (k) {
      var s = ui.sliders[k], v = st[k];
      s.r.value = v;
      if (document.activeElement !== s.n) s.n.value = +(Math.round(v / s.d.step) * s.d.step).toFixed(2);
    });
    ui.bez.forEach(function (n, i) { if (document.activeElement !== n) n.value = (+st.curve[i]).toFixed(2); });
    ui.lookBtns.forEach(function (o) { o.b.classList.toggle("on", near(o.lk.s0, st.s0) && near(o.lk.s1, st.s1) && near(o.lk.dx, st.dx) && near(o.lk.dy, st.dy)); });
    ui.easeBtns.forEach(function (o) { o.b.classList.toggle("on", o.c.every(function (v, i) { return near(v, st.curve[i], 0.005); })); });
    drawCurve();
  }
  function near(a, b, tol) { return Math.abs(a - b) < (tol || 0.01); }

  // ---- Curve editor ----
  var hover = -1, drag = -1;
  function sizeCanvases() {
    var dpr = window.devicePixelRatio || 1;
    [ui.cv, ui.pv].forEach(function (c) {
      var r = c.getBoundingClientRect(); if (!r.width) return;
      c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
    });
  }
  function pad() { return ui.cv.width * 0.12; }
  function toPx(x, y) { var p = pad(), s = ui.cv.width - p * 2; return [p + x * s, ui.cv.height - p - y * s]; }
  function fromPx(px, py) { var p = pad(), s = ui.cv.width - p * 2; return [(px - p) / s, (ui.cv.height - p - py) / s]; }
  function color(name, fb) { var v = getComputedStyle(document.body).getPropertyValue(name).trim(); return v || fb; }
  function clampCurve(i, v) { return i % 2 ? Math.min(1.5, Math.max(-0.5, v)) : Math.min(1, Math.max(0, v)); }
  function drawCurve() {
    var cv = ui.cv; if (!cv || !cv.width) return;
    var g = cv.getContext("2d"), c = st.curve, W = cv.width, H = cv.height, k = W / 320;
    var line = color("--line", "#444"), text = color("--text", "#fff"), acc = color("--accent", "#0a84ff"), faint = color("--faint", "#888");
    g.clearRect(0, 0, W, H);
    var a = toPx(0, 0), b = toPx(1, 1);
    g.strokeStyle = line; g.lineWidth = 1 * k; g.globalAlpha = 0.4;
    for (var i = 1; i < 4; i++) {
      var gx = a[0] + (b[0] - a[0]) * i / 4, gy = a[1] + (b[1] - a[1]) * i / 4;
      g.beginPath(); g.moveTo(gx, a[1]); g.lineTo(gx, b[1]); g.moveTo(a[0], gy); g.lineTo(b[0], gy); g.stroke();
    }
    g.globalAlpha = 1; g.lineWidth = 1.5 * k; g.strokeRect(a[0], b[1], b[0] - a[0], a[1] - b[1]);
    g.setLineDash([5 * k, 5 * k]); g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke(); g.setLineDash([]);
    var h1 = toPx(c[0], c[1]), h2 = toPx(c[2], c[3]);
    g.strokeStyle = acc; g.lineWidth = 2 * k; g.globalAlpha = 0.8;
    g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(h1[0], h1[1]); g.moveTo(b[0], b[1]); g.lineTo(h2[0], h2[1]); g.stroke();
    g.globalAlpha = 1; g.strokeStyle = text; g.lineWidth = 3.5 * k; g.lineCap = "round";
    g.beginPath(); g.moveTo(a[0], a[1]); g.bezierCurveTo(h1[0], h1[1], h2[0], h2[1], b[0], b[1]); g.stroke();
    [h1, h2].forEach(function (h, idx) {
      var big = hover === idx * 2 || drag === idx * 2;
      g.fillStyle = acc; g.beginPath(); g.arc(h[0], h[1], (big ? 13 : 10) * k, 0, Math.PI * 2); g.fill();
      g.strokeStyle = "#fff"; g.lineWidth = 2 * k; g.stroke();
    });
    g.fillStyle = faint; g.font = Math.round(13 * k) + "px -apple-system, sans-serif";
    g.textAlign = "right"; g.fillText("time →", b[0], a[1] + 22 * k);
    g.save(); g.translate(a[0] - 12 * k, b[1]); g.rotate(-Math.PI / 2); g.textAlign = "right"; g.fillText("move →", 0, 0); g.restore();
  }
  function wireCurve() {
    var cv = ui.cv;
    function pt(ev) { var r = cv.getBoundingClientRect(); return [(ev.clientX - r.left) * cv.width / r.width, (ev.clientY - r.top) * cv.height / r.height]; }
    function nearest(p) {
      var c = st.curve, h1 = toPx(c[0], c[1]), h2 = toPx(c[2], c[3]);
      var d1 = Math.hypot(p[0] - h1[0], p[1] - h1[1]), d2 = Math.hypot(p[0] - h2[0], p[1] - h2[1]);
      return { i: d1 <= d2 ? 0 : 2, d: Math.min(d1, d2) };
    }
    // Mouse events (with document listeners while dragging) work in every CEP version.
    cv.addEventListener("mousedown", function (ev) {
      if (ev.button !== 0) return;
      ev.preventDefault();
      cancelAnimationFrame(tween); clearTimeout(glideTimer);
      drag = nearest(pt(ev)).i; cv.classList.add("grab");
      move(ev);
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", end);
    });
    cv.addEventListener("mousemove", function (ev) {
      if (drag >= 0) return;
      var n = nearest(pt(ev)), h = n.d < cv.width * 0.08 ? n.i : -1;
      if (h !== hover) { hover = h; drawCurve(); }
    });
    cv.addEventListener("mouseleave", function () { if (drag < 0 && hover >= 0) { hover = -1; drawCurve(); } });
    cv.addEventListener("dblclick", function () { glideTo({ curve: DEFAULTS.curve }); });
    function end() {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", end);
      drag = -1; cv.classList.remove("grab"); save(); refresh();
    }
    function move(ev) {
      if (drag < 0) return;
      var v = fromPx.apply(null, pt(ev));
      st.curve[drag] = clampCurve(drag, +v[0].toFixed(3));       // time stays 0..1 (one value per moment)
      st.curve[drag + 1] = clampCurve(drag + 1, +v[1].toFixed(3)); // move may overshoot a little
      refresh(); scheduleLive();
    }
  }

  // ---- Preview: the frame (blue outline) and the picture zooming / drifting inside it ----
  function ease(c, u) {
    if (u <= 0) return 0;
    if (u >= 1) return 1;
    var lo = 0, hi = 1, t = u;
    for (var j = 0; j < 24; j++) { t = (lo + hi) / 2; if (bz(c[0], c[2], t) < u) lo = t; else hi = t; }
    return bz(c[1], c[3], t);
  }
  function bz(a, b, t) { var m = 1 - t; return 3 * m * m * t * a + 3 * m * t * t * b + t * t * t; }
  // ---- The selected clip, for the preview ----
  var media = { clipId: null, key: "", img: null, name: "", dur: 2.6, w: 1920, h: 1080, note: "", fpsNote: "" };
  function viewOpen() { return root && root.offsetParent !== null && !document.hidden; }
  function pollInfo(force) {
    if (!force && (!viewOpen() || live.busy)) return;
    if (pollInfo.busy) return;
    pollInfo.busy = true;
    api.evalSkill({ info: true, quiet: true }).then(function (r) {
      pollInfo.busy = false;
      if (!r || !r.ok) return;
      var d = r.details || {};
      media.w = d.w || 1920; media.h = d.h || 1080;
      if (!d.clip) { media.key = ""; media.img = null; media.name = ""; media.note = "No clip selected: showing a sample"; return; }
      var c = d.clip;
      // The clip's first frame (27 Nov 2026): Premiere's scripting cannot see a frame hold (it
      // reports normal speed), and in a hold only the first frame is the right one.
      c.at = Math.round(c.inS * 100) / 100;
      var key = c.id + "|" + c.path + "|" + c.at;
      media.fpsNote = c.fps && d.fps && Math.abs(c.fps - d.fps) > 0.05
        ? c.fps.toFixed(2).replace(/\.00$/, "") + " fps clip in a " + d.fps.toFixed(2).replace(/\.00$/, "") + " fps sequence: Premiere drops or repeats frames, so moves look juddery. Right-click the clip > Time Interpolation > Optical Flow (or Frame Blending) to smooth it."
        : "";
      if (ui && ui.fpsNote) { ui.fpsNote.textContent = media.fpsNote; ui.fpsNote.style.display = media.fpsNote ? "" : "none"; }
      // Re-selecting a clip Zoom has worked on brings its own settings back into the panel.
      if (d.clip.id !== media.clipId) {
        media.clipId = d.clip.id;
        var sv = d.clip.saved;
        // Zoomed before settings were saved: fit the curve to the move measured from its keys.
        if (!sv && d.clip.measured) { var ms = d.clip.measured; sv = { s0: ms.s0, s1: ms.s1, dx: ms.dx, dy: ms.dy, keep: st.keep, curve: fitCurve(ms.samples) }; }
        if (sv && sv.curve) {
          clearTimeout(live.settle); live.pending = false;
          glideTo({ s0: sv.s0, s1: sv.s1, dx: sv.dx, dy: sv.dy, curve: sv.curve }, true);
          if (st.keep !== (sv.keep !== false)) { st.keep = sv.keep !== false; if (ui && ui.keepBox) ui.keepBox.checked = st.keep; }
          liveNote("Loaded this clip's zoom settings");
        }
      }
      media.dur = d.clip.dur; media.name = d.clip.name + (d.count > 1 ? " +" + (d.count - 1) : "") + (d.clip.under ? " (under playhead)" : "");
      if (key === media.key) return;
      media.key = key; if (!media.img) media.note = "Loading frame…";
      frameFor(d.clip, function (file) {
        if (media.key !== key) return;
        if (!file) { media.img = null; media.note = "No frame (offline or unreadable): showing a sample"; return; }
        var img = new Image();
        img.onload = function () { if (media.key === key) { media.img = img; media.note = ""; } };
        img.onerror = function () { if (media.key === key) { media.img = null; media.note = "Could not show this frame"; } };
        img.src = "file://" + encodeURI(file).replace(/#/g, "%23") + "?v=" + Date.now();
      });
    });
  }
  // A still is shown as it is; anything else gets one frame from the middle of the clip via ffmpeg.
  function frameFor(c, done) {
    var src = c.path, ext = path.extname(src || "").slice(1).toLowerCase();
    if (STILLS[ext] && fs.existsSync(src)) return done(src);
    // ffmpeg cannot read RED or BRAW: use the proxy (same timing) when there is one.
    if ((ext === "r3d" || ext === "braw" || !fs.existsSync(src || "")) && c.proxy && fs.existsSync(c.proxy)) src = c.proxy;
    if (!src || !fs.existsSync(src)) return done(null);
    var ff = FFMPEG.filter(function (f) { return fs.existsSync(f); })[0];
    if (!ff) return done(null);
    var at = Math.max(0, c.at);
    var out = path.join(FRAMES, crypto.createHash("md5").update(src + "|" + at.toFixed(1)).digest("hex") + ".jpg");
    if (fs.existsSync(out)) return done(out);
    try { fs.mkdirSync(FRAMES, { recursive: true }); } catch (e) {}
    // One ffmpeg at a time while you scrub; only the newest frame asked for is made next.
    if (frameFor.running) { frameFor.next = [c, done]; return; }
    frameFor.running = true;
    var finish = function () { frameFor.running = false; var nx = frameFor.next; frameFor.next = null; if (nx) frameFor(nx[0], nx[1]); };
    childProcess.execFile(ff, ["-y", "-v", "error", "-ss", at.toFixed(3), "-i", src, "-frames:v", "1", "-vf", "scale=720:-2", "-q:v", "4", out], { timeout: 20000 }, function (err) {
      done(!err && fs.existsSync(out) ? out : null);
      finish();
    });
  }
  // Every 0.6 s while Zoom is open (quiet: these reads are not logged).
  if (window.PenyZoomPoll) clearInterval(window.PenyZoomPoll);
  window.PenyZoomPoll = setInterval(function () { pollInfo(false); }, 600);

  // ---- Preview: the sequence frame (blue outline) with the picture moving inside it; outside
  // the frame the picture is dimmed. Plays at the clip's real length; the bar is the clip's time.
  // The cubic-bezier that best matches samples of a move (0..1 at even times): a coarse search
  // over both handles, then two finer passes around the best. ~10k tries, a few ms.
  function fitCurve(samp) {
    var N = samp.length - 1;
    function err(c) { var e = 0; for (var i = 1; i < N; i++) { var d = ease(c, i / N) - samp[i]; e += d * d; } return e; }
    var best = [0.42, 0, 0.58, 1], be = err(best), step = 0.1;
    var lo = [0, -0.5, 0, -0.5], hi = [1, 1.5, 1, 1.5];
    for (var pass = 0; pass < 3; pass++) {
      var c0 = best.slice(), r = pass === 0 ? null : step * 2;
      var rng = function (i) { return r === null ? [lo[i], hi[i]] : [Math.max(lo[i], c0[i] - r), Math.min(hi[i], c0[i] + r)]; };
      var R0 = rng(0), R1 = rng(1), R2 = rng(2), R3 = rng(3);
      for (var a = R0[0]; a <= R0[1] + 1e-9; a += step)
        for (var b = R1[0]; b <= R1[1] + 1e-9; b += step)
          for (var cc = R2[0]; cc <= R2[1] + 1e-9; cc += step)
            for (var dd = R3[0]; dd <= R3[1] + 1e-9; dd += step) {
              var cand = [a, b, cc, dd], ce = err(cand);
              if (ce < be) { be = ce; best = cand; }
            }
      step /= 4;
    }
    return best.map(function (v) { return Math.round(v * 1000) / 1000; });
  }
  // Same as premiere.jsx: how much of the drift fits inside the zoom at every moment (0..1).
  function driftFit() {
    var m0 = Math.max(Math.abs(st.dx), Math.abs(st.dy)) / 100, f = 1;
    if (!m0) return 1;
    for (var g2 = 1; g2 <= 100; g2++) {
      var e2 = ease(st.curve, g2 / 100), s2 = (st.s0 + (st.s1 - st.s0) * e2) / 100, r2 = Math.max(0, (s2 - 1) / 2), need = m0 * Math.abs(e2);
      if (need > 1e-9) f = Math.min(f, r2 / need);
    }
    return Math.max(0, f);
  }
  function animate() {
    cancelAnimationFrame(raf);
    var t0 = performance.now(), HOLD = 700;
    pollInfo(true);
    function frame(now) {
      var pv = ui && ui.pv;
      if (!pv || !document.body.contains(pv)) return;
      if (pv.width) {
        var LEN = Math.max(1200, Math.min(10000, media.dur * 1000));
        var tt = (now - t0) % (LEN + HOLD), u = Math.min(1, tt / LEN), e = ease(st.curve, u);
        var g = pv.getContext("2d"), W = pv.width, H = pv.height, acc = color("--accent", "#0a84ff");
        var ar = media.w / media.h, fw = W * 0.62, fh = fw / ar;
        if (fh > H * 0.62) { fh = H * 0.62; fw = fh * ar; }
        var fx = (W - fw) / 2, fy = (H - fh) / 2 - H * 0.04;
        var s = (st.s0 + (st.s1 - st.s0) * e) / 100, x = (st.dx / 100) * e, y = (st.dy / 100) * e;
        var f2 = st.keep !== false ? driftFit() : 1; x *= f2; y *= f2;
        g.clearRect(0, 0, W, H);
        var pw = fw * s, ph = fh * s, px = fx + fw / 2 - pw / 2 - x * fw, py = fy + fh / 2 - ph / 2 - y * fh;
        if (media.img) {
          // Cover-fit the picture to the frame's shape (as Premiere's Set to Frame Size + fill).
          var iw = media.img.naturalWidth, ih = media.img.naturalHeight, sw = iw, sh = ih, sx = 0, sy = 0;
          if (iw / ih > ar) { sw = ih * ar; sx = (iw - sw) / 2; } else { sh = iw / ar; sy = (ih - sh) / 2; }
          g.drawImage(media.img, sx, sy, sw, sh, px, py, pw, ph);
        } else {
          var grad = g.createLinearGradient(px, py, px + pw, py + ph);
          grad.addColorStop(0, "#3a4a5e"); grad.addColorStop(1, "#7a6248");
          g.fillStyle = grad; g.fillRect(px, py, pw, ph);
          g.strokeStyle = "rgba(255,255,255,0.3)"; g.lineWidth = Math.max(1, W / 220);
          for (var i = 1; i < 3; i++) { g.beginPath(); g.moveTo(px + pw * i / 3, py); g.lineTo(px + pw * i / 3, py + ph); g.moveTo(px, py + ph * i / 3); g.lineTo(px + pw, py + ph * i / 3); g.stroke(); }
        }
        g.fillStyle = "rgba(0,0,0,0.6)";
        g.fillRect(0, 0, W, fy); g.fillRect(0, fy + fh, W, H - fy - fh); g.fillRect(0, fy, fx, fh); g.fillRect(fx + fw, fy, W - fx - fw, fh);
        g.strokeStyle = acc; g.lineWidth = Math.max(1.5, W / 160); g.strokeRect(fx, fy, fw, fh);
        // Time bar: where the move is in the clip, with the speed curve's shape faintly behind it.
        var bh = Math.max(3, H / 70), by = fy + fh + H * 0.06;
        g.fillStyle = "rgba(255,255,255,0.14)"; g.fillRect(fx, by, fw, bh);
        g.fillStyle = acc; g.fillRect(fx, by, fw * u, bh);
        g.beginPath(); g.arc(fx + fw * u, by + bh / 2, bh * 1.3, 0, Math.PI * 2); g.fill();
        // Time on the right, the clip name in whatever room is left (cut with an ellipsis).
        var fs1 = Math.round(H / 15), ty = by + bh * 2.2;
        g.textBaseline = "top"; g.textAlign = "right"; g.font = fs1 + "px ui-monospace, Menlo, monospace";
        var tlabel = (u * media.dur).toFixed(1) + " / " + media.dur.toFixed(1) + " s";
        g.fillStyle = color("--dim", "#aaa"); g.fillText(tlabel, fx + fw, ty);
        var room2 = fw - g.measureText(tlabel).width - fs1;
        g.textAlign = "left"; g.font = fs1 + "px -apple-system, sans-serif";
        var full = media.note || media.name || "Sample", label = full;
        while (label.length > 1 && g.measureText(label + "\u2026").width > room2) label = label.slice(0, -1);
        g.fillText(label === full ? full : label + "\u2026", fx, ty);
      }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
  }

  return {
    actions: {
      apply: apply,
      reset: function () { api.status("Zoom: resetting…"); return api.evalSkill({ reset: true }); }
    },
    mount: function (element) { root = element; render(); }
  };
};
