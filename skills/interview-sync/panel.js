/* Sync Interviews, panel side (Node). Runs from the Interviews tile (section Sync Interviews).
 * 1. premiere.jsx "scan": every clip of the active sequence as a unit (a camera clip with its
 *    own linked sound, or an audio clip linked to no picture).
 * 2. Where ffmpeg reads the sound: the media file and/or the proxy Premiere has attached
 *    (syncmeasure.py takes the proxy when it matches the media; RED .R3D, which ffmpeg
 *    can't read, only from its proxy); neither found and the clip can't be measured.
 * 3. syncmeasure.py: camera A (lowest video track with clips) stays; every other clip is
 *    matched to it by waveform and given its new start (see syncmeasure.py).
 * 4. premiere.jsx "apply": a copy "<sequence> Synced" with the clips moved and, if asked,
 *    linked; everything read back. The original sequence is not changed. Nothing is saved.
 * Report: /tmp/peny-toolkit/interview-sync/<sequence>-<time>/sync.csv. */
var fs = require("fs");
var path = require("path");
var childProcess = require("child_process");
function BUNDLED(name) { return path.join(process.env.HOME || "", "Library", "Application Support", "PenyToolkit", "bin", name); }
var FFMPEG = [BUNDLED("ffmpeg"), "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"];
var PYTHON = [BUNDLED("python3"), "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"];
var WORK_ROOT = "/tmp/peny-toolkit/interview-sync";

function firstExisting(list) { for (var i = 0; i < list.length; i++) if (fs.existsSync(list[i])) return list[i]; return null; }
function fmt(s) {
  var neg = s < 0; s = Math.abs(s);
  var h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = (s % 60).toFixed(2);
  return (neg ? "-" : "") + h + ":" + (m < 10 ? "0" : "") + m + ":" + (x < 10 ? "0" : "") + x;
}
function csvCell(v) { var s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function stamp() { var d = new Date(); function p(n) { return (n < 10 ? "0" : "") + n; } return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); }

module.exports = function (api) {
  var child = null, cancelled = false;

  function pythonWithNumpy() {
    for (var i = 0; i < PYTHON.length; i++) {
      if (!fs.existsSync(PYTHON[i])) continue;
      try { childProcess.execFileSync(PYTHON[i], ["-c", "import numpy"], { stdio: "ignore" }); return PYTHON[i]; } catch (e) {}
    }
    return null;
  }

  function measure(python, job) {
    return new Promise(function (ok, no) {
      child = childProcess.spawn(python, [path.join(api.skillDir, "syncmeasure.py")]);
      var out = "", err = "";
      child.stdout.on("data", function (d) { out += d; });
      child.stderr.on("data", function (d) {
        err += d; if (err.length > 20000) err = err.slice(-20000);
        String(d).split("\n").forEach(function (line) { if (line.trim()) { api.status(line.trim()); api.log("  " + line.trim()); } });
      });
      child.on("error", no);
      child.on("close", function (code) {
        child = null;
        if (cancelled) return no({ stop: "Cancelled." });
        if (code !== 0) return no(new Error("syncmeasure.py exited " + code + ": " + err.slice(-400)));
        try { ok(JSON.parse(out)); } catch (e) { no(new Error("syncmeasure.py output unreadable: " + out.slice(0, 200))); }
      });
      child.stdin.end(JSON.stringify(job));
    });
  }

  function sync(params) {
    cancelled = false;
    var mode = params.link === "cameras" || params.link === "none" ? params.link : "all";
    var ffmpeg = firstExisting(FFMPEG);
    if (!ffmpeg) return Promise.resolve({ ok: false, error: "ffmpeg not found (looked in " + FFMPEG.join(", ") + ")." });
    var python = pythonWithNumpy();
    if (!python) return Promise.resolve({ ok: false, error: "No python3 with numpy found (looked in " + PYTHON.join(", ") + ")." });
    var scan, dir, plan, unread = [];
    api.status("Reading the timeline…");
    return api.evalSkill({ action: "scan" }).then(function (r) {
      if (!r.ok) throw { stop: r.error };
      scan = r.details;
      dir = path.join(WORK_ROOT, String(scan.sequenceName).replace(/[^A-Za-z0-9 _-]+/g, "_").slice(0, 60) + "-" + stamp());
      fs.mkdirSync(dir, { recursive: true });
      var units = scan.units;
      var videoTracks = units.filter(function (u) { return u.kind === "video" && !u.skip; }).map(function (u) { return u.track; });
      var audioTracks = units.filter(function (u) { return u.kind === "audio" && !u.skip; }).map(function (u) { return u.track; });
      if (!videoTracks.length && !audioTracks.length) throw { stop: "No clips to sync on this sequence." };
      var refKind = videoTracks.length ? "video" : "audio";
      var refTrack = Math.min.apply(null, refKind === "video" ? videoTracks : audioTracks);
      var job = { ffmpeg: ffmpeg, fps: scan.fps, gap: 5, units: [] };
      units.forEach(function (u) {
        if (u.skip) { unread.push({ name: u.name, track: (u.kind === "video" ? "V" : "A") + (u.track + 1), time: fmt(u.start), reason: u.skip }); return; }
        // Sound for ffmpeg: syncmeasure.py picks the cheaper of the media and the attached
        // proxy (a non-RED proxy only once it matches the media); RED only from its proxy.
        var media = u.path && !/\.r3d$/i.test(u.path) && fs.existsSync(u.path) ? u.path : null;
        var proxy = u.proxy && fs.existsSync(u.proxy) ? u.proxy : null;
        if (!media && !proxy) unread.push({ name: u.name, track: (u.kind === "video" ? "V" : "A") + (u.track + 1), time: fmt(u.start),
          reason: /\.r3d$/i.test(u.path) ? "RED clip without a proxy: its sound can't be read outside Premiere (make its proxy first)" : "media file not found" });
        job.units.push({ id: u.id, name: u.name, kind: u.kind, track: u.track, start: u.start, inPoint: u.inPoint, duration: u.duration,
          media: media, proxy: proxy, tc: u.tc, ref: u.kind === refKind && u.track === refTrack });
      });
      api.log("Sync Interviews: " + job.units.length + " clip(s); camera A = " + (refKind === "video" ? "V" : "A") + (refTrack + 1) + "; link: " + mode);
      fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify(job, null, 1));
      return measure(python, job);
    }).then(function (m) {
      fs.writeFileSync(path.join(dir, "measure.json"), JSON.stringify(m, null, 1));
      var byId = {};
      m.units.forEach(function (x) { byId[x.id] = x; });
      plan = scan.units.filter(function (u) { return byId[u.id]; }).map(function (u) {
        var x = byId[u.id];
        return { id: u.id, name: u.name, kind: u.kind, track: u.track, index: u.index, start: u.start, end: u.end, audio: u.audio, path: u.path, inPoint: u.inPoint,
          newStart: x.newStart, synced: x.synced, ref: x.ref, withId: x.withId };
      });
      var synced = m.units.filter(function (x) { return x.synced; }).length;
      if (!synced) throw { stop: "No clip could be matched by waveform, so nothing was changed. " + m.units.filter(function (x) { return !x.ref; }).map(function (x) { return x.name + ": " + x.reason; }).slice(0, 4).join("; ") };
      api.status("Moving clips on a copy…");
      return api.evalSkill({ action: "apply", sequenceId: scan.sequenceId, units: plan, link: mode }).then(function (a) { return { m: m, a: a }; });
    }).then(function (o) {
      var m = o.m, a = o.a, d = a.details || {};
      var rows = m.units.map(function (x) {
        return { clip: x.name, track: (x.kind === "video" ? "V" : "A") + (x.track + 1), role: x.ref ? (Math.abs(x.shift) > 0.001 ? "camera A (moved with its group)" : "camera A (stays)") : x.synced ? "synced" : "not synced",
          with: x.with || "", old_start: fmt(x.oldStart), new_start: fmt(x.newStart), moved_by_s: x.shift.toFixed(3), how: x.how || "", reason: x.reason || "" };
      });
      unread.forEach(function (u) { rows.push({ clip: u.name, track: u.track, role: "not measured", old_start: u.time, reason: u.reason }); });
      var cols = ["clip", "track", "role", "with", "old_start", "new_start", "moved_by_s", "how", "reason"];
      var synced = m.units.filter(function (x) { return x.synced; }).length;
      var others = m.units.filter(function (x) { return !x.ref; }).length + unread.length;
      var links = d.links || [], linkedOk = links.filter(function (l) { return l.ok && l.linked; }).length;
      var linkBad = links.filter(function (l) { return !l.ok; }).length;
      var own = d.own || [], ownBad = own.filter(function (o) { return !o.ok; }).length;
      // A run is only OK when every clip moved and every link group (own audio and the
      // chosen linking) reads back whole.
      var allOk = !!a.ok && !linkBad && !ownBad;
      var summary = a.ok
        ? synced + " of " + others + " clips synced to camera A on \"" + d.copy + "\"" +
          (mode === "none" ? ", not linked" : "; " + linkedOk + " link group(s) made and checked" + (linkBad ? ", " + linkBad + " FAILED (see the list)" : "")) +
          ". The original sequence is unchanged and nothing is saved. List: " + path.join(dir, "sync.csv")
        : a.error;
      var skipped = m.units.filter(function (x) { return !x.ref && !x.synced; }).map(function (x) { return { name: x.name, time: fmt(x.oldStart), reason: x.reason }; }).concat(unread);
      links.forEach(function (l) { (l.left || []).forEach(function (t) { skipped.push({ name: t, time: l.at, reason: "not linked to " + l.anchor }); }); });
      api.status(summary);
      links.forEach(function (l) { if (!l.ok) rows.push({ clip: l.anchor, role: "link group FAILED", new_start: l.at, reason: l.reason + (l.names ? " (" + l.names.join(", ") + ")" : "") }); });
      own.forEach(function (o) { if (!o.ok) rows.push({ clip: o.name, role: "own audio link FAILED", new_start: o.at, reason: o.reason }); });
      fs.writeFileSync(path.join(dir, "sync.csv"), cols.join(",") + "\n" + rows.map(function (r) { return cols.map(function (c) { return csvCell(r[c]); }).join(","); }).join("\n") + "\n");
      return { ok: allOk, summary: summary, error: allOk ? undefined : summary, details: { copy: d.copy, synced: synced, of: others, links: links, own: own, skipped: skipped,
        failed: links.filter(function (l) { return !l.ok; }).map(function (l) { return { name: l.anchor, time: l.at, reason: l.reason }; }), workFolder: dir } };
    }).catch(function (e) {
      var msg = e && e.stop ? e.stop : "Sync stopped: " + (e && e.message ? e.message : String(e));
      api.status(msg);
      return { ok: false, error: msg, details: { workFolder: dir || null } };
    });
  }

  function cancel() {
    cancelled = true;
    if (child) { try { child.kill("SIGTERM"); } catch (e) {} }
    return Promise.resolve({ ok: true, summary: "Cancel requested." });
  }

  // Test hook only: run one premiere.jsx action (e.g. "probe") as it is.
  function jsx(params) { return api.evalSkill(params || {}); }

  return { actions: { sync: sync, cancel: cancel, jsx: jsx }, busy: function () { return child ? "syncmeasure.py" : null; } };
};
