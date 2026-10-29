/* Master for YouTube (loudness-master), panel side (Node). Masters the active sequence's whole
 * mix to a delivery target from targets.json (one action per target; YouTube now), the way
 * Mike Russell's mix-track method does it, but measured instead of played by ear:
 * 1. premiere.jsx "prepare": a "<S> MASTER <label> TOOLKIT COPY" sequence holding the active
 *    sequence S nested as one clip (made in S's bin, or reused), so no clip of S changes.
 * 2. The nest gets one Hard Limiter, bypassed, with Maximum Amplitude at the target's true
 *    peak - 0.5 dB (the limiter holds sample peaks; true peak can go over them). Premiere
 *    renders the master (exportAsMediaDirect, 32-bit float wav) and measure.py reads its
 *    EBU R128 loudness ("before").
 * 3. Limiter on, Input Boost = target - integrated; render, measure, correct the boost by
 *    what is still missing and lower Maximum Amplitude when the true peak is over, until
 *    integrated is within the target's tolerance and the true peak at or under it (4 passes
 *    at most). Input Boost below 0 (a cut) is used only when Premiere reads it back; if not,
 *    a mix that is too loud is reported as needing turning down.
 * 4. A "Mastered <label> ..." marker at 0 on the master, report.json in
 *    /tmp/peny-toolkit/loudness-master/<sequence>-<time>/ (the renders are removed once
 *    measured). Nothing is saved. */
var fs = require("fs");
var path = require("path");
var childProcess = require("child_process");
var os = require("os");
var StepTask = require(path.join(__dirname, "..", "..", "core", "steps.js")).StepTask;

// Tools put in place by the one-click installer first (see Sound Pass); measure.py needs
// only the standard library, so any python3 does.
function BUNDLED(name) { return path.join(process.env.HOME || "", "Library", "Application Support", "PenyToolkit", "bin", name); }
var FFMPEG = [BUNDLED("ffmpeg"), "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"];
var PYTHON = [BUNDLED("python3"), "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"];
var WORK_ROOT = "/tmp/peny-toolkit/loudness-master";

var PEAK_MARGIN = 0.5;  // dB: Maximum Amplitude starts this far under the target true peak
var PEAK_STEP = 0.2;    // dB more taken off Maximum Amplitude when the true peak lands over
var BOOST_MAX = 24;     // dB of Input Boost at most
var CUT_MAX = -12;      // dB: Input Boost below 0, used only if Premiere reads it back
var MAX_MIN = -10;      // dB: Maximum Amplitude is never set lower than this
var PASSES = 4;         // limiter passes after the "before" render

function firstExisting(list) { for (var i = 0; i < list.length; i++) if (fs.existsSync(list[i])) return list[i]; return null; }
function boostValue(db) { return 2 / 3 + db / 150; }     // Input Boost, measured by render
function boostDb(v) { return (v - 2 / 3) * 150; }
function maxValue(db) { return 1 + db / 100; }          // Maximum Amplitude, measured by render
function maxDb(v) { return (v - 1) * 100; }
function r1(x) { return Math.round(x * 10) / 10; }
function r2(x) { return Math.round(x * 100) / 100; }
// "2026-10-24 11:11" in this Mac's time zone (toISOString would give UTC).
function localStamp(d) { function z(n) { return (n < 10 ? "0" : "") + n; } return d.getFullYear() + "-" + z(d.getMonth() + 1) + "-" + z(d.getDate()) + " " + z(d.getHours()) + ":" + z(d.getMinutes()); }
function sign(x) { return (x > 0 ? "+" : "") + r1(x).toFixed(1); }

var TARGETS = JSON.parse(fs.readFileSync(path.join(__dirname, "targets.json"), "utf-8"));

module.exports = function (api) {
  var busy = null;

  function measure(python, ffmpeg, wav) {
    return new Promise(function (ok, no) {
      var child = childProcess.spawn(python, ["-I", path.join(api.skillDir, "measure.py")]);
      var out = "", err = "";
      child.stdout.on("data", function (d) { out += d; });
      child.stderr.on("data", function (d) { err += d; });
      child.on("error", no);
      child.on("close", function (code) {
        var j = null;
        try { j = JSON.parse(out); } catch (e) {}
        if (code !== 0 || !j || j.error) return no(new Error("measure.py: " + (j && j.error ? j.error : "exited " + code + ": " + (err || out).slice(-400))));
        ok(j);
      });
      child.stdin.end(JSON.stringify({ wav: wav, ffmpeg: ffmpeg }));
    });
  }

  function jsx(p) {
    return api.evalSkill(p).then(function (r) { if (!r.ok) throw { stop: r.error, details: r.details }; return r; });
  }

  function master(target, params) {
    // Test hook: params.jsxAction calls one premiere.jsx action directly (e.g. "probe").
    if (params.jsxAction) {
      var p = {}; for (var k in params) if (params.hasOwnProperty(k)) p[k] = params[k];
      p.action = params.jsxAction;
      return api.evalSkill(p);
    }
    var ffmpeg = firstExisting(FFMPEG), python = firstExisting(PYTHON);
    if (!ffmpeg) return Promise.resolve({ ok: false, error: "ffmpeg not found (" + FFMPEG.join(", ") + ")." });
    if (!python) return Promise.resolve({ ok: false, error: "python3 not found (" + PYTHON.join(", ") + ")." });
    var preset = path.join(api.skillDir, "wav-float.epr");
    var name = "Master for " + target.label;
    var t0 = Date.now(), dir = null, prep = null, clips = null, task = null;
    var report = { target: target, passes: [] };
    busy = name;
    function step(id) { if (task) task.step(id); }

    // Sets the nest's limiter, renders the master and measures it (the wav is removed).
    function pass(label, set) {
      step(label);
      api.status(name + ": " + label + " — setting the limiter…");
      return jsx({ action: "limit", clips: clips, bypass: set.bypass, boost: boostValue(set.boost), max: maxValue(set.max) }).then(function (l) {
        var got = l.details.clips[0], row = { pass: label, bypass: set.bypass, boostWanted: r2(set.boost), maxWanted: r2(set.max),
          boostRead: r2(boostDb(got.boost)), maxRead: r2(maxDb(got.max)), limitersAdded: l.details.added, readBack: l.details.clips.every(function (c) { return c.matches; }) };
        report.passes.push(row);
        if (!row.readBack) return row;  // the caller decides (a cut Premiere would not take)
        return render(label, row);
      });
    }
    function render(label, row) {
      api.status(name + ": " + label + " — rendering the master…");
      var wav = path.join(dir, label + ".wav");
      return jsx({ action: "render", path: wav, preset: preset }).then(function (r) {
        row.renderMs = r.details.ms;
        api.status(name + ": " + label + " — measuring…");
        return measure(python, ffmpeg, wav);
      }).then(function (m) {
        try { fs.unlinkSync(wav); } catch (e) {}
        row.integrated = m.integrated; row.truePeak = m.truePeak; row.lra = m.lra; row.samplePeak = m.samplePeak; row.duration = m.duration;
        if (typeof m.integrated !== "number") throw { stop: "The master rendered silent (no integrated loudness). Check that the sequence has audio and its tracks are not muted." };
        return row;
      });
    }
    function onTarget(row) {
      return Math.abs(row.integrated - target.integrated) <= target.tolerance && typeof row.truePeak === "number" && row.truePeak <= target.truePeak;
    }

    return jsx({ action: "prepare", label: target.label }).then(function (r) {
      prep = r.details;
      clips = prep.clips.map(function (c) { return { track: c.track, nodeId: c.nodeId }; });
      report.prepare = prep;
      var size = Math.max(1, Math.round((prep.duration || 60) / 60));
      var steps = [{ id: "prepare", label: "Making the master sequence" }, { id: "before", label: "Rendering the mix as it is" }];
      for (var i = 1; i <= PASSES; i++) steps.push({ id: "pass " + i, label: "Limiter pass " + i });
      steps.push({ id: "marker", label: "Marking the master" });
      var defaults = { prepare: { a: 3, b: 0 }, before: { a: 3, b: 1 }, marker: { a: 1, b: 0 } };
      for (var j = 1; j <= PASSES; j++) defaults["pass " + j] = { a: 3, b: 1 };
      task = new StepTask({ title: name, steps: steps, size: size, defaults: defaults,
        historyFile: path.join(os.homedir(), ".peny-toolkit", "loudness-master-eta.json"), onProgress: api.progress || function () {} });
      task.step("prepare"); task.steps[0].at = t0;
      var safe = prep.source.replace(/[^A-Za-z0-9 _-]+/g, "").replace(/\s+/g, "_").slice(0, 60);
      dir = path.join(WORK_ROOT, safe + "-" + new Date().toISOString().replace(/[:.]/g, "-"));
      fs.mkdirSync(dir, { recursive: true });
      api.log(name + ": " + (prep.made ? "made" : "reusing") + " \"" + prep.master + "\" (" + prep.clips.length + " nest audio clip(s), " +
        (prep.channels && prep.channels.count ? prep.channels.count + " channel(s)" : "channels unknown") + ")");
      return pass("before", { bypass: true, boost: 0, max: target.truePeak - PEAK_MARGIN });
    }).then(function (b) {
      if (!b.readBack) throw { stop: "The Hard Limiter on the master did not take its settings.", details: b };
      report.before = b;
      var set = { bypass: false, boost: Math.max(CUT_MAX, Math.min(BOOST_MAX, target.integrated - b.integrated)), max: target.truePeak - PEAK_MARGIN };
      // prev: the last (boost, integrated) point, to learn how much of each dB of boost the
      // limiter lets through (under heavy limiting it is less than 1 LU per dB).
      var minBoost = CUT_MAX, n = 0, prev = { boost: 0, integrated: b.integrated };
      function next() {
        n++;
        return pass("pass " + n, set).then(function (row) {
          if (!row.readBack) {
            if (set.boost < 0 && minBoost < 0) {
              // Premiere would not take an Input Boost below 0: no cut through the limiter.
              report.cutRefused = { wanted: set.boost, read: row.boostRead };
              minBoost = 0; set.boost = 0; n--; report.passes.pop();
              return next();
            }
            throw { stop: "The Hard Limiter on the master did not take its settings (" + JSON.stringify(row) + ").", details: row };
          }
          if (onTarget(row) || n >= PASSES) return row;
          var slope = 1;
          if (Math.abs(set.boost - prev.boost) >= 0.5) slope = Math.max(0.3, Math.min(1.2, (row.integrated - prev.integrated) / (set.boost - prev.boost)));
          prev = { boost: set.boost, integrated: row.integrated };
          row.slope = r2(slope);
          var want = Math.max(minBoost, Math.min(BOOST_MAX, set.boost + (target.integrated - row.integrated) / slope));
          var newMax = set.max;
          if (row.truePeak > target.truePeak) newMax = Math.max(MAX_MIN, set.max - (row.truePeak - target.truePeak) - PEAK_STEP);
          // Nothing left to change (boost at its limit, peak fine): stop.
          if (Math.abs(want - set.boost) < 0.05 && newMax === set.max) return row;
          set = { bypass: false, boost: want, max: newMax };
          return next();
        });
      }
      return next();
    }).then(function (f) {
      step("marker");
      report.final = f;
      var ok = onTarget(f);
      var tooLoud = !ok && f.integrated > target.integrated + target.tolerance;
      var title = "Mastered " + target.label + " " + r1(f.integrated).toFixed(1) + " LUFS / " + r1(f.truePeak).toFixed(1) + " dBTP";
      var comment = "Target " + target.integrated + " LUFS ±" + target.tolerance + ", true peak ≤ " + target.truePeak + " dBTP. " +
        "Hard Limiter on the nest: Input Boost " + sign(f.boostRead) + " dB, Maximum Amplitude " + r1(f.maxRead).toFixed(1) + " dB. " +
        "As found: " + r1(report.before.integrated).toFixed(1) + " LUFS, " + r1(report.before.truePeak).toFixed(1) + " dBTP. " +
        (ok ? "On target." : "NOT on target.") + " " + localStamp(new Date());
      report.ok = ok; report.tooLoud = tooLoud; report.tooQuiet = !ok && f.integrated < target.integrated - target.tolerance;
      return jsx({ action: "marker", name: title, comment: comment }).then(function (mk) { report.marker = mk.details; report.markerName = title; return f; });
    }).then(function (f) {
      var b = report.before, ok = report.ok;
      fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(report, null, 1));
      var summary = (ok ? "Mastered" : "Could not master") + " \"" + prep.source + "\" for " + target.label + " on \"" + prep.master + "\"" + (prep.made ? " (new)" : "") +
        ": " + r1(b.integrated).toFixed(1) + " LUFS / " + r1(b.truePeak).toFixed(1) + " dBTP as found → " + r1(f.integrated).toFixed(1) + " LUFS / " + r1(f.truePeak).toFixed(1) + " dBTP" +
        " (target " + target.integrated + " ±" + target.tolerance + " LUFS, ≤ " + target.truePeak + " dBTP; LRA " + r1(f.lra) + " LU)" +
        ". Hard Limiter: Input Boost " + sign(f.boostRead) + " dB, Maximum Amplitude " + r1(f.maxRead).toFixed(1) + " dB, " + (report.passes.length - 1) + " pass(es)" +
        (report.tooQuiet ? ". The mix is still " + r1(target.integrated - f.integrated).toFixed(1) + " LU too quiet with the most Input Boost allowed (+" + BOOST_MAX + " dB); check its levels" : "") +
        (report.tooLoud ? ". The mix is " + r1(f.integrated - target.integrated).toFixed(1) + " LU too loud" + (report.cutRefused ? " and Input Boost cannot go below 0" : "") + ": turn it down (track or master faders) and run again" : "") +
        ". Nothing saved. Took " + Math.round((Date.now() - t0) / 1000) + " s. Report: " + path.join(dir, "report.json");
      api.status(summary);
      return { ok: ok, summary: summary, error: summary, details: { master: prep.master, source: prep.source, made: prep.made, workFolder: dir, before: b, final: f,
        passes: report.passes, cutRefused: report.cutRefused || null, tooLoud: report.tooLoud, marker: report.markerName } };
    }).catch(function (e) {
      var msg = e && e.stop ? e.stop : name + " stopped: " + (e && e.message ? e.message : String(e));
      api.status(msg);
      if (dir) { try { report.error = msg; fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(report, null, 1)); } catch (e2) {} }
      return { ok: false, error: msg, details: { workFolder: dir, passes: report.passes, more: e && e.details ? e.details : null } };
    }).then(function (r) { if (task) task.done(!!r.ok); busy = null; return r; });
  }

  var actions = {};
  TARGETS.forEach(function (t) { actions[t.id] = function (params) { return master(t, params || {}); }; });
  return { actions: actions, busy: function () { return busy; } };
};
