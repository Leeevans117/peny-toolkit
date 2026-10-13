/* Sync external audio, panel side (Node). Step 2 of Link External Audio.
 * 1. premiere.jsx "scan": camera clips and the external wavs already on the timeline
 *    (anywhere, e.g. dropped after the clips as Lee did on 2 Oct 2026).
 * 2. measure.py: where each camera clip sits in the wavs, by waveform (GCC-PHAT); a clip
 *    is only synced on a confident match, otherwise it is reported and left alone.
 * 3. premiere.jsx "place": one wav piece under each synced clip on the wavs' audio track,
 *    in = measured time, length = the clip's; a clip that runs past the end of a ~1 h wav
 *    gets a second piece from the start of the next file (the recorder splits without a gap),
 *    on the same track, and the camera clip is cut there so each half links to one piece.
 *    In/out are multiples of 1/64 s (Premiere sometimes refuses other values).
 * Only on a TOOLKIT COPY sequence. Nothing is deleted, moved or renamed. */
var fs = require("fs");
var path = require("path");
// Tools put in place by the one-click installer (no Homebrew needed).
function BUNDLED(name) { return path.join(process.env.HOME || "", "Library", "Application Support", "PenyToolkit", "bin", name); }
var childProcess = require("child_process");

var FFMPEG = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", BUNDLED("ffmpeg")];
var PYTHON = ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", BUNDLED("python3"), "/usr/bin/python3"];

function firstExisting(list) { for (var i = 0; i < list.length; i++) if (fs.existsSync(list[i])) return list[i]; return null; }
function q64(x) { return Math.round(x * 64) / 64; }
function floor64(x) { return Math.floor(x * 64) / 64; }
function clock(name) { var m = /(\d{6})_(\d{2})(\d{2})(\d{2})/.exec(name); return m ? (+m[2]) * 3600 + (+m[3]) * 60 + (+m[4]) : null; }

module.exports = function (api) {
  function pythonWithNumpy() {
    for (var i = 0; i < PYTHON.length; i++) {
      if (!fs.existsSync(PYTHON[i])) continue;
      try { childProcess.execFileSync(PYTHON[i], ["-c", "import numpy"], { stdio: "ignore" }); return PYTHON[i]; } catch (e) {}
    }
    return null;
  }

  function duration(ffprobe, p) {
    return new Promise(function (ok) {
      childProcess.execFile(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p], function (e, out) {
        ok(e ? null : parseFloat(out));
      });
    });
  }

  function measure(python, job) {
    return new Promise(function (ok, no) {
      var child = childProcess.spawn(python, [path.join(api.skillDir, "measure.py")]);
      var out = "", err = "";
      child.stdout.on("data", function (d) { out += d; });
      child.stderr.on("data", function (d) {
        err += d;
        String(d).split("\n").forEach(function (line) { if (line.trim()) { api.status(line.trim()); api.log("  " + line.trim()); } });
      });
      child.on("error", no);
      child.on("close", function (code) {
        if (code !== 0) return no(new Error("measure.py exited " + code + ": " + err.slice(-400)));
        try { ok(JSON.parse(out)); } catch (e) { no(new Error("measure.py output unreadable: " + out.slice(0, 200))); }
      });
      child.stdin.end(JSON.stringify(job));
    });
  }

  function sync(params) {
    var ffmpeg = firstExisting(FFMPEG);
    if (!ffmpeg) return Promise.resolve({ ok: false, error: "ffmpeg not found (looked in " + FFMPEG.join(", ") + ")." });
    var ffprobe = path.join(path.dirname(ffmpeg), "ffprobe");
    var python = pythonWithNumpy();
    if (!python) return Promise.resolve({ ok: false, error: "No python3 with numpy found (looked in " + PYTHON.join(", ") + ")." });
    var scan, wavInfo = [];
    api.status("Reading the timeline…");
    return api.evalSkill({ action: "scan" }).then(function (r) {
      if (!r.ok) throw { stop: r.error };
      scan = r.details;
      if (!scan.wavs.length) throw { stop: "No external audio on this sequence. Put the wav files on an empty audio track (anywhere, e.g. after the clips) and run Sync again." };
      return Promise.all(scan.wavs.map(function (p) { return duration(ffprobe, p).then(function (d) { wavInfo.push({ path: p, duration: d }); }); }));
    }).then(function () {
      var bad = wavInfo.filter(function (w) { return !w.duration; });
      if (bad.length) throw { stop: "Could not read " + bad.map(function (w) { return w.path; }).join(", ") };
      var clips = scan.cams.filter(function (c) { return c.path && fs.existsSync(c.path); });
      api.log("Sync: " + clips.length + " camera clip(s) against " + wavInfo.length + " wav(s) on A" + (scan.track + 1));
      return measure(python, { ffmpeg: ffmpeg, wavs: wavInfo, clips: clips.map(function (c) {
        return { id: c.nodeId, name: c.name, path: c.path, inPoint: c.inPoint, duration: c.end - c.start };
      }) });
    }).then(function (m) {
      var byId = {}, pieces = [], synced = [], unsynced = [];
      scan.cams.forEach(function (c) { byId[c.nodeId] = c; });
      m.results.forEach(function (r) {
        var cam = byId[r.id];
        if (!r.synced) { unsynced.push({ name: r.name, time: cam ? cam.start : null, reason: r.reason }); return; }
        var wi = -1;
        m.wavs.forEach(function (w, i) { if (w.path === r.wav) wi = i; });
        var w = m.wavs[wi], start = cam.start, len = cam.end - cam.start, inT = r.wavTime;
        if (inT < 0) { start -= inT; len += inT; inT = 0; } // wav starts after the clip
        inT = q64(inT);
        var out = q64(inT + len), end = floor64(w.duration - 0.001);
        var rec = { name: r.name, time: cam.start, wav: path.basename(r.wav), wavTime: r.wavTime, why: r.why };
        if (out <= end) {
          pieces.push({ clip: r.name, path: r.wav, "in": inT, out: out, start: start });
        } else {
          pieces.push({ clip: r.name, path: r.wav, "in": inT, out: end, start: start });
          var next = m.wavs[wi + 1];
          if (next && next.recording === w.recording) {
            pieces.push({ clip: r.name, path: next.path, "in": 0, out: q64(len - (end - inT)), start: start + (end - inT) });
            rec.split = path.basename(r.wav) + " + " + path.basename(next.path);
          } else rec.split = "runs past the end of " + path.basename(r.wav) + "; the rest has no audio";
        }
        // Wall clock of the wav's start from this clip (camera filename time); these should
        // agree across clips of one recording to about a second.
        var cl = clock(r.name);
        if (cl !== null) rec.wavStartClock = cl + cam.inPoint - r.recTime;
        synced.push(rec);
      });
      if (!pieces.length) return { placed: { ok: true, details: { placed: [], failed: [] } }, synced: synced, unsynced: unsynced };
      api.status("Placing " + pieces.length + " wav piece(s) on A" + (scan.track + 1) + "…");
      return api.evalSkill({ action: "place", pieces: pieces, track: scan.track }).then(function (pl) {
        return { placed: pl, synced: synced, unsynced: unsynced };
      });
    }).then(function (o) {
      var d = o.placed.details || {};
      var clocks = o.synced.filter(function (s) { return s.wavStartClock !== undefined; }).map(function (s) { return s.wavStartClock; });
      var spread = clocks.length > 1 ? (Math.max.apply(null, clocks) - Math.min.apply(null, clocks)) : null;
      var summary = o.synced.length + " of " + (o.synced.length + o.unsynced.length) + " camera clips synced by waveform; " +
        (d.placed || []).length + " wav piece(s) placed and checked, " + (d.failed || []).length + " failed; " +
        o.unsynced.length + " left for you to sync by hand." +
        (spread !== null ? " Camera clocks agree to " + spread.toFixed(1) + " s." : "") +
        ((d.cuts || []).length ? " " + d.cuts.length + " camera clip(s) cut where the wav file changes, so each half links to its own piece." : "") +
        (o.unsynced.length || (d.failed || []).length ? "" : " Now run step 3, Link.");
      api.status(summary);
      return { ok: o.placed.ok !== false, summary: summary, error: summary, details: {
        synced: o.synced, skipped: o.unsynced.map(function (u) { return { name: u.name, time: u.time !== null ? fmt(u.time) : "", reason: u.reason }; }),
        placed: d.placed || [], cuts: d.cuts || [], failed: d.failed || [] } };
    }).catch(function (e) {
      var msg = e && e.stop ? e.stop : "Sync stopped: " + (e && e.message ? e.message : String(e));
      api.status(msg);
      return { ok: false, error: msg };
    });
  }

  function fmt(s) {
    var h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = (s % 60).toFixed(2);
    return h + ":" + (m < 10 ? "0" : "") + m + ":" + (x < 10 ? "0" : "") + x;
  }

  return { actions: { sync: sync } };
};
