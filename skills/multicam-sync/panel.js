/* Multicam Sync Test, panel side (Node). TEST VERSION (25 Nov 2026, Lee).
 * 1. premiere.jsx "export": the active sequence as FCP XML (read only).
 * 2. mcrun.py (bundled python with numpy): mcjob.py reads the XML's clips, mcsync.py puts
 *    every camera and sound file on one clock (Tentacle LTC, checked camera timecode,
 *    waveform, file dates), mcbuild.py writes the same XML with every clip at its synced
 *    time, as a NEW sequence "<sequence> MULTICAM SYNC TEST" (unplaced clips at the end).
 * 3. premiere.jsx "import": that XML imported into the project and opened.
 * The active sequence is never changed and nothing is saved.
 * Work folder: /tmp/peny-toolkit/multicam-sync/<sequence>-<time>/ (source.xml, job.json,
 * out.json, the synced XML, report.json). Sound readings are cached in
 * ~/Library/Caches/PenyToolkit/multicam-sync, so a second run of the same shoot is quick. */
var fs = require("fs");
var os = require("os");
var path = require("path");
var childProcess = require("child_process");
function BUNDLED(name) { return path.join(os.homedir(), "Library", "Application Support", "PenyToolkit", "bin", name); }
var FFMPEG = [BUNDLED("ffmpeg"), "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"];
var FFPROBE = [BUNDLED("ffprobe"), "/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe"];
var PYTHON = [BUNDLED("python3"), "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"];
var WORK_ROOT = "/tmp/peny-toolkit/multicam-sync";
var CACHE = path.join(os.homedir(), "Library", "Caches", "PenyToolkit", "multicam-sync");

function firstExisting(list) { for (var i = 0; i < list.length; i++) if (fs.existsSync(list[i])) return list[i]; return null; }
function stamp() { var d = new Date(); function p(n) { return (n < 10 ? "0" : "") + n; } return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); }
function safe(s) { return String(s).replace(/[^A-Za-z0-9 _-]+/g, "_").slice(0, 80); }

module.exports = function (api) {
  var child = null, cancelled = false;

  function pythonWithNumpy() {
    for (var i = 0; i < PYTHON.length; i++) {
      if (!fs.existsSync(PYTHON[i])) continue;
      try { childProcess.execFileSync(PYTHON[i], ["-c", "import numpy"], { stdio: "ignore" }); return PYTHON[i]; } catch (e) {}
    }
    return null;
  }

  function runEngine(python, args) {
    return new Promise(function (ok, no) {
      child = childProcess.spawn(python, ["-u", path.join(api.skillDir, "mcrun.py")].concat(args));
      var out = "", err = "";
      child.stdout.on("data", function (d) { out += d; });
      child.stderr.on("data", function (d) {
        err += d; if (err.length > 20000) err = err.slice(-20000);
        String(d).split("\n").forEach(function (line) { if (line.trim()) { api.status(line.trim().slice(0, 160)); api.log("  " + line.trim()); } });
      });
      child.on("error", no);
      child.on("close", function (code) {
        child = null;
        if (cancelled) return no({ stop: "Cancelled. Nothing was imported." });
        if (code !== 0) return no(new Error("the sync engine stopped (exit " + code + "): " + err.slice(-400)));
        try { ok(JSON.parse(out.trim().split("\n").pop())); } catch (e) { no(new Error("the sync engine's answer was unreadable: " + out.slice(0, 200))); }
      });
    });
  }

  function sync() {
    cancelled = false;
    var ffmpeg = firstExisting(FFMPEG), ffprobe = firstExisting(FFPROBE), python = pythonWithNumpy();
    if (!ffmpeg || !ffprobe) return Promise.resolve({ ok: false, error: "ffmpeg/ffprobe not found (looked in " + FFMPEG.concat(FFPROBE).join(", ") + ")." });
    if (!python) return Promise.resolve({ ok: false, error: "No python3 with numpy found (looked in " + PYTHON.join(", ") + ")." });
    var dir = path.join(WORK_ROOT, "run-" + stamp()), ex, res, t0 = Date.now();
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(CACHE, { recursive: true });
    api.status("Exporting the sequence as XML…");
    return api.evalSkill({ action: "export", path: path.join(dir, "source.xml") }).then(function (r) {
      if (!r.ok) throw { stop: r.error };
      ex = r.details;
      api.log("Multicam Sync Test: \"" + ex.sequenceName + "\" " + ex.videoClips + " video / " + ex.audioClips + " audio clips -> \"" + ex.newName + "\"; work folder " + dir);
      return runEngine(python, [path.join(dir, "source.xml"), dir, ex.newName, ffmpeg, ffprobe, CACHE]);
    }).then(function (o) {
      res = o;
      if (cancelled) throw { stop: "Cancelled. Nothing was imported." };
      if (!o.placed) throw { stop: "No clip could be placed, so nothing was imported. " + (o.notes || []).slice(0, 3).join("; ") };
      var xml = path.join(dir, safe(ex.newName) + ".xml");
      fs.copyFileSync(o.xml, xml);
      api.status("Importing \"" + ex.newName + "\"…");
      return api.evalSkill({ action: "import", path: xml, name: ex.newName });
    }).then(function (im) {
      var total = res.placed + res.unplaced;
      var report = { source: ex, engine: res, imported: im, seconds: Math.round((Date.now() - t0) / 1000) };
      fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(report, null, 1));
      if (!im.ok) return { ok: false, error: im.error + " Work folder: " + dir, details: { workFolder: dir } };
      var un = (res.unplacedList || []).map(function (u) { return { name: u.name, reason: u.reason || u.why || "not placed" }; });
      var summary = res.placed + " of " + total + " clips synced on \"" + ex.newName + "\" (" + res.exact + " frame-exact, Iris; the rest by clock or file date, Mango)" +
        (res.unplaced ? "; " + res.unplaced + " not placed, at the end in Violet" : "") +
        ". The original sequence is unchanged and nothing is saved. " + report.seconds + " s.";
      api.status(summary);
      return { ok: true, summary: summary, details: { sequence: ex.newName, placed: res.placed, exact: res.exact, unplaced: un, notes: res.notes,
        cameras: res.cameras, build: res.build, workFolder: dir, skipped: un } };
    }).catch(function (e) {
      var msg = e && e.stop ? e.stop : "Multicam sync stopped: " + (e && e.message ? e.message : String(e));
      api.status(msg);
      return { ok: false, error: msg, details: { workFolder: dir } };
    });
  }

  function cancel() {
    cancelled = true;
    if (child) { try { child.kill("SIGTERM"); } catch (e) {} }
    return Promise.resolve({ ok: true, summary: "Cancel requested." });
  }

  return { actions: { sync: sync, cancel: cancel }, busy: function () { return child ? "multicam sync engine" : null; } };
};
