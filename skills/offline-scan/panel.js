/* Offline Check, panel side (Node). Lee, 27 Nov 2026.
 * 1. premiere.jsx "plan": offline clips on visible tracks that a solid clip above does not
 *    surely hide, each with times to look at and the box where its slate would sit.
 * 2. Premiere renders a still at each time (a few per call, the playhead is put back).
 * 3. ffmpeg turns each still into a small grey picture (over black, as transparent parts
 *    show black); detect.js looks for the "Media offline" slate in the clip's box (also the
 *    whole frame, in case the box is off: keyframed Motion, scale to frame size...).
 * 4. Each stretch where the slate shows gets a red marker (earlier Offline Check markers are
 *    replaced; no other marker is touched) and a row in the list; a row moves the playhead.
 * Media Pending is not covered: scripts cannot see it, and still renders wait for the media
 * (unverified). */
var fs = require("fs");
var path = require("path");
var os = require("os");
var childProcess = require("child_process");
var detect = require(path.join(__dirname, "detect.js"));

function BUNDLED(name) { return path.join(process.env.HOME || "", "Library", "Application Support", "PenyToolkit", "bin", name); }
var FFMPEG = [BUNDLED("ffmpeg"), "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"];
var FW = 960, FH = 540;
var PER_CALL = 6; // stills per Premiere call (keeps each call short)
var FULL = { x: 0, y: 0, w: 1, h: 1 };

function firstExisting(list) { for (var i = 0; i < list.length; i++) if (fs.existsSync(list[i])) return list[i]; return null; }
function gray(ffmpeg, file) {
  return new Promise(function (resolve, reject) {
    childProcess.execFile(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", file, "-f", "lavfi", "-i", "color=black:s=16x16",
      "-filter_complex", "[1][0]scale2ref[b][a];[b][a]overlay,scale=" + FW + ":" + FH + ":flags=area,format=gray",
      "-frames:v", "1", "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024, timeout: 60000 }, function (err, out) {
      if (err) return reject(err);
      if (!out || out.length !== FW * FH) return reject(new Error("still could not be read"));
      resolve(out);
    });
  });
}
function tc(sec, fps) {
  var f = Math.round(sec * fps), r = Math.round(fps), fr = f % r, s = Math.floor(f / r);
  function p(n) { return (n < 10 ? "0" : "") + n; }
  return p(Math.floor(s / 3600)) + ":" + p(Math.floor(s / 60) % 60) + ":" + p(s % 60) + ":" + p(fr);
}

module.exports = function (api) {
  var root = null, last = null;

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function draw() {
    if (!root) return;
    root.innerHTML = "";
    if (!last) return;
    var box = el("div", "oc-list");
    box.style.cssText = "margin-top:10px;display:flex;flex-direction:column;gap:4px";
    if (!last.hits.length) {
      box.appendChild(el("div", "oc-none", last.note));
    } else {
      last.hits.forEach(function (h) {
        var row = el("button", "oc-row");
        row.style.cssText = "text-align:left;display:flex;gap:8px;align-items:baseline;padding:6px 8px;border-radius:8px;border:1px solid rgba(255,59,48,.45);background:rgba(255,59,48,.10);color:inherit;cursor:pointer";
        var t = el("span", "mono", tc(h.start, last.fps)); t.style.fontFamily = "ui-monospace, Menlo, monospace";
        row.appendChild(t);
        row.appendChild(el("span", "", h.track + "  " + h.name + (h.nested ? " (nest)" : "")));
        row.title = (h.path || h.name) + "\nClick to move the playhead here.";
        row.addEventListener("click", function () { api.evalSkill({ mode: "seek", t: h.start }); });
        box.appendChild(row);
      });
    }
    root.appendChild(box);
  }

  function progress(done, total, startedAt, event) {
    var spent = (Date.now() - startedAt) / 1000;
    var left = done ? spent / done * (total - done) : null;
    api.progress({ title: "Offline Check", event: event, finished: done, total: total, unit: "stills", running: event === "finished" ? 0 : 1, failed: 0,
      percent: total ? done / total * 100 : 100, eta: left === null ? { state: "estimating" } : { state: "ok", seconds: Math.round(left), raw: Math.round(left) } });
  }

  function scan(params) {
    var ffmpeg = firstExisting(FFMPEG);
    if (!ffmpeg) return Promise.resolve({ ok: false, error: "ffmpeg not found (looked in " + FFMPEG.join(", ") + ")." });
    var dir = path.join(os.tmpdir(), "peny-offline-check-" + Date.now());
    fs.mkdirSync(dir, { recursive: true });
    var plan, startedAt = Date.now();
    return api.evalSkill({ mode: "plan" }).then(function (r) {
      if (!r.ok) throw r;
      plan = r.details;
      api.log("Offline Check plan: " + r.summary + " " + plan.totalSamples + " still(s) to render.");
      plan.candidates.forEach(function (c) { if (c.notCover) api.log("Offline Check: " + c.track + " " + c.name + " @" + c.start + " s, clips above that are not sure covers: " + c.notCover.join("; ")); });
      // time -> candidates to look for there
      var byTime = {}, times = [];
      plan.candidates.forEach(function (c, ci) {
        c.hitTimes = []; c.checked = 0;
        c.samples.forEach(function (t) { var k = String(t); if (!byTime[k]) { byTime[k] = []; times.push(t); } byTime[k].push(ci); });
      });
      times.sort(function (a, b) { return a - b; });
      var done = 0, unread = [];
      progress(0, times.length, startedAt, "started");
      function next(i) {
        if (i >= times.length) return Promise.resolve();
        var chunk = times.slice(i, i + PER_CALL);
        api.status("Checking stills " + (i + 1) + "-" + (i + chunk.length) + " of " + times.length + "…");
        return api.evalSkill({ mode: "frames", times: chunk, dir: dir }).then(function (fr) {
          if (!fr.ok) throw fr;
          (fr.details.missing || []).forEach(function (t) { unread.push(t); });
          return fr.details.frames.reduce(function (p, f) {
            return p.then(function () { return gray(ffmpeg, f.path); }).then(function (g) {
              (byTime[String(f.t)] || []).forEach(function (ci) {
                var c = plan.candidates[ci], boxes = [c.box, c.boxNested, FULL].filter(Boolean), hit = null;
                for (var b = 0; b < boxes.length && !hit; b++) { var s = detect.score(detect.cut(g, FW, FH, boxes[b])); if (s.hit) hit = s; }
                c.checked++;
                if (hit) c.hitTimes.push(f.t);
              });
              try { fs.unlinkSync(f.path); } catch (e) {}
            }, function (e) { unread.push(f.t); api.log("Offline Check: still at " + f.t + " s not read: " + (e.message || e), "err"); });
          }, Promise.resolve());
        }).then(function () { done += chunk.length; progress(done, times.length, startedAt, "tick"); return next(i + PER_CALL); });
      }
      return next(0).then(function () {
        progress(times.length, times.length, startedAt, "finished");
        // Each candidate's hits -> stretches: from the first hit sample to the frame before the
        // next sample that showed no slate (or the end of what is seen).
        var frame = 1 / plan.fps, hits = [];
        plan.candidates.forEach(function (c) {
          if (!c.hitTimes.length) return;
          var s = c.samples, inHit = false, a = 0;
          for (var k = 0; k < s.length; k++) {
            var on = c.hitTimes.indexOf(s[k]) !== -1;
            if (on && !inHit) { inHit = true; a = s[k]; }
            if (!on && inHit) { inHit = false; hits.push(stretch(c, a, s[k])); }
          }
          if (inHit) hits.push(stretch(c, a, s[s.length - 1] + frame));
        });
        function stretch(c, a, b) {
          return { start: a, end: Math.max(b, a + frame), track: c.track, name: c.name, nested: c.nested, path: c.path,
            comment: c.track + " " + c.name + (c.nested ? " (nested sequence)" : "") + (c.path ? " - " + c.path : "") };
        }
        hits.sort(function (x, y) { return x.start - y.start; });
        var counts = plan.counts;
        var note = counts.offline ? "No Media offline showing in \"" + plan.sequence + "\". " + counts.offline + " offline clip(s) are all hidden (" +
          counts.fullyCovered + " covered, " + counts.disabled + " disabled, " + counts.hiddenTrack + " on hidden tracks" +
          (counts.toCheck ? ", " + counts.toCheck + " checked by still" : "") + ")." : "No offline clips in \"" + plan.sequence + "\".";
        last = { hits: hits, fps: plan.fps, note: note };
        draw();
        var marks = params.markers === false ? Promise.resolve(null) : api.evalSkill({ mode: hits.length ? "mark" : "clear", hits: hits });
        return marks.then(function (m) {
          if (m && !m.ok) throw m;
          try { fs.rmdirSync(dir); } catch (e) {}
          var secs = Math.round((Date.now() - startedAt) / 100) / 10;
          var summary = hits.length ? hits.length + " place(s) show Media offline in \"" + plan.sequence + "\"" + (m ? ", red markers added" : "") + "." : note;
          if (unread.length) summary += " " + unread.length + " still(s) could not be checked (see log).";
          return { ok: true, summary: summary + " (" + times.length + " stills, " + secs + " s)", details: { hits: hits, counts: counts, stills: times.length, unread: unread, seconds: secs, markers: m ? m.details : null } };
        });
      });
    }).catch(function (e) {
      progress(0, 0, startedAt, "finished");
      return { ok: false, error: (e && (e.error || e.message)) || String(e), details: e && e.details };
    });
  }

  return {
    actions: {
      scan: scan,
      clear: function () {
        return api.evalSkill({ mode: "clear" }).then(function (r) { last = null; draw(); return r; });
      }
    },
    mount: function (element) { root = element; draw(); }
  };
};
