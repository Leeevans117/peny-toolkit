/* Sound Pass, panel side (Node). Evens out the interview voice on a safe copy so every
 * phrase of every speaker sounds equally loud, with the top held at -6 dB on the meters:
 * 1. premiere.jsx "copy" (Make safe copy unless already on a TOOLKIT COPY), "scan" (voice clips).
 * 2. Every voice clip gets one Hard Limiter, bypassed (Volume keyframes left by an earlier
 *    Sound Pass run are cleared first); Premiere renders the voice tracks (exportAsMediaDirect,
 *    32-bit float) and measure.py reads the render's loudness every 100 ms ("dry").
 * 3. Limiter on with a -20 dB ceiling and enough boost to reach it: the render shows where
 *    each track's ceiling lands on the master, i.e. the gain after the clip (pan law, track
 *    and master faders, e.g. +4.9 / +15 dB in Tahnee Home IV).
 * 4. measure.py "level": a gain curve per clip that brings every phrase to TARGET loudness
 *    (LUFS, how loud it sounds rather than how high it peaks), so quiet and loud phrases and
 *    different speakers match. It goes on the clip as the limiter's Input Boost (the bulk,
 *    the same as clip gain, which scripts cannot set) plus Volume > Level keyframes (the
 *    phrase-to-phrase changes, all at or under 0 dB). Ceiling = -6 dB on the master; a final
 *    render checks every clip. Off-mic and short clips get one flat value (usual gain).
 * Renders go to /tmp/peny-toolkit/sound-pass/<sequence>-<time>/ and are removed once measured (their window levels are kept as .npz)
 * (report.json and report.csv stay). Only the TOOLKIT COPY changes; nothing is saved. */
var fs = require("fs");
var path = require("path");
// Tools put in place by the one-click installer (no Homebrew needed). Used first when
// present: they are the versions the toolkit was tested with, and their python3 has numpy
// (a Homebrew python3 without numpy would break Sync, Sound Pass and Colour).
function BUNDLED(name) { return path.join(process.env.HOME || "", "Library", "Application Support", "PenyToolkit", "bin", name); }
var childProcess = require("child_process");
var os = require("os");
var StepTask = require(path.join(__dirname, "..", "..", "core", "steps.js")).StepTask;

var FFMPEG = [BUNDLED("ffmpeg"), "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"];
var PYTHON = [BUNDLED("python3"), "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"];
var WORK_ROOT = "/tmp/peny-toolkit/sound-pass";

// Targets, on Premiere's master meter, set 23 Oct 2026 from Tony and Chris (Seoul interviews):
// speech at -20 LUFS momentary peaks about 15 dB higher, so the limiter at -6 dB trims the
// top 1-2 dB and the body of every phrase lands at -6 to -9 dB.
var TARGET = -20;      // LUFS momentary loudness every phrase is brought to
var CEILING = -6;      // limiter ceiling as seen on the master
var PROBE_CEILING = -20; // clip-side ceiling used to find the gain after each clip
var WINDOW = 3;      // s either side: a phrase's level is the speech within it
var RATE = 3;         // dB/s at most the level moves, and only while someone speaks (held in pauses)
var DEADBAND = 1.5;    // dB: smaller differences are left alone
var LIFT_MAX = 6;      // dB a phrase may be lifted above its clip's own level ...
var CUT_MAX = 6;       // ... or lowered below it
var KEY_TOL = 1;       // dB: keyframes are thinned to stay this close to the curve
var KEY_TOP = 0;       // dB: the loudest point of a clip's curve sits at Volume 0 dB, the rest under it
var MIN_SPEECH = 2;    // s of clear speech a clip needs for its own level, else the usual one
var LONG_SPEECH = 20;  // s of speech that sets a speaker's usual level
var SPREAD = 6;        // dB under the usual level that marks the interviewer or crew off-mic
var TRIM_MIN = 1;      // dB: a clip this far from the others' middle loudness gets one flat correction
var BOOST_MAX = 50;    // dB, the Hard Limiter's Input Boost range

function firstExisting(list) { for (var i = 0; i < list.length; i++) if (fs.existsSync(list[i])) return list[i]; return null; }
function boostValue(db) { return 2 / 3 + db / 150; }     // Input Boost, measured by render
function maxValue(db) { return 1 + db / 100; }          // Maximum Amplitude, measured by render
function median(a) { var s = a.slice().sort(function (x, y) { return x - y; }); var n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; }
// Sequence timecode hh:mm:ss:ff (seconds with one decimal when the frame rate is unknown).
function tc(s, fps) {
  if (!(fps > 0)) return fmt(s);
  var f = Math.round(s * fps), r = Math.round(fps), p = function (x) { return (x < 10 ? "0" : "") + x; };
  return p(Math.floor(f / (r * 3600))) + ":" + p(Math.floor(f / (r * 60)) % 60) + ":" + p(Math.floor(f / r) % 60) + ":" + p(f % r);
}
function r2(x) { return Math.round(x * 100) / 100; }
function fmt(s) { var h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = (s % 60).toFixed(1); return h + ":" + (m < 10 ? "0" : "") + m + ":" + (x < 10 ? "0" : "") + x; }

// Progress bar steps (core/steps.js). Each takes about a + b x voice clips seconds, from
// Lee's runs on 23 Oct 2026 (43 clips: 40 s), then learned from every finished run.
var STEPS = [
  { id: "copy", label: "Making the safe copy" },
  { id: "before", label: "Rendering as found" },
  { id: "dry", label: "Rendering without the limiter" },
  { id: "ceiling", label: "Finding the gain after each clip" },
  { id: "level", label: "Working out every phrase's level" },
  { id: "keys", label: "Writing Volume keyframes" },
  { id: "final", label: "Setting the limiters and checking" },
  { id: "trim", label: "Trimming clips to the same loudness" },
  { id: "mix", label: "Rendering the full mix as you hear it" },
  { id: "check", label: "Checking the result and marking spots" },
  { id: "report", label: "Writing the report" }];
var STEP_DEFAULTS = { copy: { a: 2, b: 0.01 }, before: { a: 1.5, b: 0.01 }, dry: { a: 2, b: 0.1 }, ceiling: { a: 2, b: 0.11 },
  level: { a: 1, b: 0.01 }, keys: { a: 1, b: 0.1 }, final: { a: 4, b: 0.15 }, trim: { a: 3, b: 0.07 }, mix: { a: 2, b: 0.05 }, check: { a: 1.5, b: 0.01 }, report: { a: 1, b: 0.01 } };

module.exports = function (api) {
  var busy = null;

  function pythonWithNumpy() {
    for (var i = 0; i < PYTHON.length; i++) {
      if (!fs.existsSync(PYTHON[i])) continue;
      try { childProcess.execFileSync(PYTHON[i], ["-c", "import numpy"], { stdio: "ignore" }); return PYTHON[i]; } catch (e) {}
    }
    return null;
  }

  function measure(python, job) {
    return new Promise(function (ok, no) {
      var child = childProcess.spawn(python, [path.join(api.skillDir, "measure.py")]);
      var out = "", err = "";
      child.stdout.on("data", function (d) { out += d; });
      child.stderr.on("data", function (d) { err += d; });
      child.on("error", no);
      child.on("close", function (code) {
        if (code !== 0) return no(new Error("measure.py exited " + code + ": " + err.slice(-400)));
        try { ok(JSON.parse(out)); } catch (e) { no(new Error("measure.py output unreadable: " + out.slice(0, 200))); }
      });
      child.stdin.end(JSON.stringify(job));
    });
  }

  function jsx(p) {
    return api.evalSkill(p).then(function (r) { if (!r.ok) throw { stop: r.error, details: r.details }; return r; });
  }

  function run(params) {
    // Test hook: params.jsxAction calls one premiere.jsx action directly (e.g. "keys", "render").
    if (params.jsxAction) {
      var p = {}; for (var k in params) if (params.hasOwnProperty(k)) p[k] = params[k];
      p.action = params.jsxAction;
      return api.evalSkill(p);
    }
    var ffmpeg = firstExisting(FFMPEG), python = pythonWithNumpy();
    if (!ffmpeg) return Promise.resolve({ ok: false, error: "ffmpeg not found (" + FFMPEG.join(", ") + ")." });
    if (!python) return Promise.resolve({ ok: false, error: "No python3 with numpy found (" + PYTHON.join(", ") + ")." });
    var preset = path.join(api.skillDir, "wav-float.epr");
    var even = params.even !== false;
    var t0 = Date.now(), dir, scan, clips, voiceTracks, copyInfo, report = { passes: {}, settings: { target: TARGET, ceiling: CEILING, even: even } }, npz = {};
    busy = "Sound Pass";
    // The bar starts once the clips are counted; the copy step is dated back to the press.
    var task = null;
    function step(id) { if (task) task.step(id); }

    // Sets the clips (unless settings is null), renders the voice tracks and keeps the
    // window levels of the render (the wav itself is removed).
    function pass(name, settings, tracks) {
      step(name);
      api.status("Sound Pass: " + name + (settings ? " — setting " + settings.length + " clips…" : " — as found…"));
      return (settings ? jsx({ action: "set", clips: settings }) : Promise.resolve({ details: { set: 0, added: 0 } })).then(function (s) {
        report.passes[name] = { set: s.details.set, added: s.details.added, volumeReset: s.details.volumeReset || 0 };
        api.status("Sound Pass: " + name + " — rendering the voice tracks…");
        var wav = path.join(dir, name + ".wav");
        return jsx({ action: "render", voiceTracks: tracks || voiceTracks, path: wav, preset: preset }).then(function (r) {
          report.passes[name].renderMs = r.details.ms;
          if (!r.details.mutesRestored) throw { stop: "Track mutes on the copy were not restored after the " + name + " render; check the copy's track mute buttons." };
          api.status("Sound Pass: " + name + " — measuring…");
          npz[name] = path.join(dir, name + ".npz");
          return measure(python, { mode: "blocks", ffmpeg: ffmpeg, wav: wav, out: npz[name] });
        }).then(function () { try { fs.unlinkSync(wav); } catch (e) {} });
      });
    }
    function clipList() { return clips.map(function (c) { return { id: c.nodeId, start: c.start, end: c.end, group: c.group, keyable: c.keyable }; }); }
    // Speech stats per clip for the given renders, all on the same speech windows.
    function stats(names, maskFrom) {
      var files = {}; names.forEach(function (n) { files[n] = npz[n]; });
      return measure(python, { mode: "stats", files: files, maskFrom: maskFrom, gate: 20, clips: clipList() }).then(function (m) { return m.files; });
    }

    return jsx({ action: "copy" }).then(function (c) {
      copyInfo = c.details;
      return jsx({ action: "scan", tracks: params.tracks || "" });
    }).then(function (s) {
      scan = s.details;
      if (!scan.isCopy) throw { stop: "The active sequence is not a TOOLKIT COPY after the copy step." };
      clips = scan.clips;
      task = new StepTask({ title: "Sound Pass", steps: STEPS, size: clips.length, defaults: STEP_DEFAULTS,
        historyFile: path.join(os.homedir(), ".peny-toolkit", "sound-pass-eta.json"), onProgress: api.progress || function () {} });
      task.step("copy"); task.steps[0].at = t0;
      voiceTracks = [];
      clips.forEach(function (c) {
        if (voiceTracks.indexOf(c.track) < 0) voiceTracks.push(c.track);
        c.group = c.label + " " + c.source;  // one speaker's recording on one track
        // Volume keyframes on a clip that already has a Hard Limiter are taken as an earlier
        // Sound Pass run's and cleared (Volume back to 0 dB); anyone else's are kept.
        c.resetVolume = c.volumeDb === "keyframed" && c.hl.count > 0;
        c.v0 = c.resetVolume ? 0 : c.volumeDb;
        c.keyable = typeof c.v0 === "number";
      });
      var safe = scan.sequence.replace(/[^A-Za-z0-9 _-]+/g, "").replace(/\s+/g, "_").slice(0, 60);
      dir = path.join(WORK_ROOT, safe + "-" + new Date().toISOString().replace(/[:.]/g, "-"));
      fs.mkdirSync(dir, { recursive: true });
      api.log("Sound Pass: \"" + scan.sequence + "\": " + clips.length + " voice clip(s) on " + voiceTracks.map(function (t) { return "A" + (t + 1); }).join(", ") +
        (scan.skipped.length ? "; left alone: " + scan.skipped.join(", ") : ""));
      report.before = clips.map(function (c) { return { nodeId: c.nodeId, clipGainDb: c.clipGainDb, volumeDb: c.volumeDb, hl: c.hl }; });
      return pass("before", null);
    }).then(function () {
      return pass("dry", clips.map(function (c) { return { track: c.track, nodeId: c.nodeId, bypass: true, resetVolume: c.resetVolume }; }));
    }).then(function () { return stats(["dry"], "dry"); }).then(function (m) {
      clips.forEach(function (c) { c.dry = m.dry.clips[c.nodeId] || {}; });
      // Enough boost that the clip's peaks pass the probe ceiling by 6 dB.
      return pass("ceiling", clips.map(function (c) {
        var b = typeof c.dry.max === "number" ? Math.max(0, Math.min(BOOST_MAX, PROBE_CEILING + 6 - c.dry.max)) : 0;
        c.probeBoost = r2(b);
        return { track: c.track, nodeId: c.nodeId, bypass: false, boost: boostValue(b), max: maxValue(PROBE_CEILING) };
      }));
    }).then(function () { return stats(["dry", "ceiling"], "dry"); }).then(function (m) {
      // Gain after the clip, per track: where the -20 dB clip ceiling lands on the master
      // (only clips that really reach it count: boosted peaks well over the ceiling).
      var post = {}, byTrack = {};
      clips.forEach(function (c) {
        var d = m.dry.clips[c.nodeId] || {}, e = m.ceiling.clips[c.nodeId] || {};
        if (e.n >= 5 && d.max + c.probeBoost > e.max + 3) (byTrack[c.track] = byTrack[c.track] || []).push(e.max - PROBE_CEILING);
      });
      voiceTracks.forEach(function (t) { post[t] = byTrack[t] && byTrack[t].length ? r2(median(byTrack[t])) : null; });
      report.postGainDb = post;
      step("level");
      api.status("Sound Pass: working out the level of every phrase…");
      return measure(python, { mode: "level", file: npz.dry, clips: clipList().map(function (c) { if (!even) c.keyable = false; return c; }), target: TARGET,
        lo: -CUT_MAX, hi: LIFT_MAX, window: WINDOW, rate: RATE, dead: DEADBAND, tol: KEY_TOL, spread: SPREAD, minSpeech: MIN_SPEECH, longSpeech: LONG_SPEECH });
    }).then(function (lv) {
      var plan = [], keyJobs = [], noPost = [], clamped = [];
      clips.forEach(function (c) {
        var l = lv[c.nodeId] || { mode: "flat", gain: 0, note: "not measured" }, b;
        c.level = l;
        if (l.note) c.note = l.note;
        if (l.mode === "ride") {
          // Curve g(t) relative to the dry render = (Volume - v0) + Input Boost. The loudest
          // point of the curve sits at Volume KEY_TOP, the bulk goes into the Input Boost.
          b = l.gainMax - (KEY_TOP - c.v0);
          var keys = l.keys.map(function (k) { return { t: k[0], db: r2(c.v0 + k[1] - b) }; });
          keyJobs.push({ track: c.track, nodeId: c.nodeId, keys: keys, clear: true });
          c.keys = keys.length;
          c.volMin = r2(Math.min.apply(null, keys.map(function (k) { return k.db; })));
        } else b = l.gain;
        if (b > BOOST_MAX) { clamped.push(c.label + " " + fmt(c.start)); b = BOOST_MAX; }
        var p = report.postGainDb[c.track];
        if (p === null) { if (noPost.indexOf(c.label) < 0) noPost.push(c.label); p = -3; }
        c.boostDb = r2(Math.max(-60, b));
        c.ceilingDb = r2(Math.max(-60, Math.min(0, CEILING - p)));
        plan.push({ track: c.track, nodeId: c.nodeId, bypass: false, boost: boostValue(c.boostDb), max: maxValue(c.ceilingDb) });
      });
      report.notes = [];
      if (noPost.length) report.notes.push("No clip on " + noPost.join(", ") + " reached the probe ceiling; assumed the usual -3 dB pan law after the clip.");
      if (clamped.length) report.notes.push("Needed more than +" + BOOST_MAX + " dB (the limiter's most), so these stay quieter: " + clamped.join(", "));
      report.keys = { clips: keyJobs.length, keys: keyJobs.reduce(function (n, j) { return n + j.keys.length; }, 0) };
      return (keyJobs.length ? (step("keys"), api.status("Sound Pass: writing " + report.keys.keys + " Volume keyframes on " + keyJobs.length + " clip(s)…"), jsx({ action: "keys", clips: keyJobs })) : Promise.resolve())
        .then(function () { return pass("final", plan); });
    }).then(function () { return stats(["dry", "final"], "dry"); }).then(function (m) {
      // Trim: the slow curve can leave a whole clip a few dB off, so every clip with its own
      // level gets one flat correction to the middle loudness of all of them. Only the Input
      // Boost moves (no new keyframes), then one more render.
      var own = clips.filter(function (c) { return !c.note && c.level.speechSec >= MIN_SPEECH && typeof (m.final.clips[c.nodeId] || {}).lu50 === "number"; });
      var mid = own.length ? median(own.map(function (c) { return m.final.clips[c.nodeId].lu50; })) : null, plan = [];
      own.forEach(function (c) {
        var d = r2(mid - m.final.clips[c.nodeId].lu50);
        if (Math.abs(d) >= TRIM_MIN) c.trimDb = d;
      });
      // A short clip that follows its neighbour's level gets its neighbour's trim too.
      clips.forEach(function (c) {
        var f = (c.level.follows || []).map(function (id) { var o = clips.filter(function (x) { return x.nodeId === id; })[0]; return o && o.trimDb || 0; });
        if (f.length) { var d = r2(f.reduce(function (a, x) { return a + x; }, 0) / f.length); if (d) c.trimDb = d; }
      });
      clips.forEach(function (c) {
        if (!c.trimDb) return;
        c.boostDb = r2(Math.max(-60, Math.min(BOOST_MAX, c.boostDb + c.trimDb)));
        plan.push({ track: c.track, nodeId: c.nodeId, bypass: false, boost: boostValue(c.boostDb), max: maxValue(c.ceilingDb) });
      });
      report.trim = { clips: plan.length, to: mid };
      if (!plan.length) return;
      return pass("trim", plan).then(function () { npz.final = npz.trim; });
    }).then(function () {
      // Every track that was playing when Sound Pass started (music, camera sound...), so the
      // check hears the background under the voice too. Nothing is set; mutes are put back.
      var heard = (scan.tracks || []).filter(function (t) { return !t.muted; }).map(function (t) { return t.index; });
      return heard.length ? pass("mix", null, heard) : null;
    }).then(function () { return stats(["before", "dry", "final"], "dry"); }).then(function (m) {
      // Check: spots worth a listen in the finished render, marked red on the copy.
      step("check");
      api.status("Sound Pass: checking the result…");
      return measure(python, { mode: "check", file: npz.final, mask: npz.dry, mix: npz.mix || null, ceiling: CEILING,
        clips: clips.map(function (c) { return { id: c.nodeId, start: c.start, end: c.end, group: c.group, name: c.name, note: c.note || "" }; }) }).then(function (ck) {
        report.check = { total: ck.total, capped: ck.capped, kinds: ck.kinds, middle: ck.middle };
        report.spots = ck.spots;
        return jsx({ action: "markers", spots: ck.spots.map(function (s) { return { t: s.t, end: s.end, text: s.text }; }) });
      }).then(function (mk) { report.markers = mk.details; return m; });
    }).then(function (m) {
      step("report");
      var rows = [], meds = [], medsBefore = [], bad = [];
      clips.forEach(function (c) {
        var f = m.final.clips[c.nodeId] || {}, b = m.before.clips[c.nodeId] || {};
        var row = { track: c.label, start: fmt(c.start), end: fmt(c.end), name: c.name, speechSec: c.level.speechSec,
          clipGainDb: c.clipGainDb, volumeDb: c.volumeDb, hadLimiter: c.hl.count > 0, earlierKeysCleared: !!c.resetVolume,
          beforeLoud50: b.lu50, beforeLoud10: b.lu10, beforeLoud90: b.lu90, beforePk50: b.pk50, beforeMax: b.max,
          mode: c.level.mode, boostDb: c.boostDb, trimDb: c.trimDb || 0, ceilingDb: c.ceilingDb, keyframes: c.keys || 0, volumeMinDb: c.volMin === undefined ? "" : c.volMin, note: c.note || "",
          afterLoud10: f.lu10, afterLoud50: f.lu50, afterLoud90: f.lu90, afterPk25: f.pk25, afterPk50: f.pk50, afterMax: f.max };
        rows.push(row);
        if (c.level.mode === "ride" && typeof f.lu50 === "number") {
          meds.push(f.lu50);
          if (typeof b.lu50 === "number") medsBefore.push(b.lu50);
        }
        if (typeof f.max === "number" && f.max > CEILING + 0.5) bad.push(row);
      });
      // Clips with 20 s of speech whose loudness is 3 dB away from the others' middle.
      var mid = median(meds);
      clips.forEach(function (c, i) {
        var f = m.final.clips[c.nodeId] || {};
        if (c.level.mode === "ride" && c.level.speechSec >= LONG_SPEECH && typeof f.lu50 === "number" && Math.abs(f.lu50 - mid) > 3 && bad.indexOf(rows[i]) < 0) bad.push(rows[i]);
      });
      function range(a) { return a.length ? { min: Math.min.apply(null, a), max: Math.max.apply(null, a), median: median(a) } : null; }
      report.clips = rows;
      report.all = m.final.all; report.allBefore = m.before.all;
      report.spread = range(meds); report.spreadBefore = range(medsBefore);
      fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(report, null, 1));
      fs.writeFileSync(path.join(dir, "spots.csv"), "timecode,end,kind,text\n" + report.spots.map(function (s) {
        return [tc(s.t, scan.fps), s.end === null ? "" : tc(s.end, scan.fps), s.kinds.join(" + "), '"' + s.text.replace(/"/g, '""') + '"'].join(",");
      }).join("\n") + "\n");
      var keys = Object.keys(rows[0]);
      fs.writeFileSync(path.join(dir, "report.csv"), keys.join(",") + "\n" + rows.map(function (r) {
        return keys.map(function (k) { var v = r[k]; return typeof v === "string" ? '"' + v.replace(/"/g, '""') + '"' : (v === undefined || v === null ? "" : v); }).join(",");
      }).join("\n") + "\n");
      var a = m.final.all || {}, ab = m.before.all || {};
      var flagged = clips.filter(function (c) { return c.note; }).length;
      var summary = "Evened out " + clips.length + " voice clip(s) on \"" + scan.sequence + "\"" + (copyInfo.made ? " (new safe copy; the original is untouched)" : "") +
        ". Speech loudness now " + a.lu10 + " to " + a.lu90 + " LUFS (middle " + a.lu50 + ")" +
        (report.spread ? ", clip to clip " + report.spread.min + " to " + report.spread.max : "") +
        "; peaks: middle " + a.pk50 + " dB, top " + a.max + " dB" +
        " (as found: " + ab.lu10 + " to " + ab.lu90 + " LUFS" + (report.spreadBefore ? ", clip to clip " + report.spreadBefore.min + " to " + report.spreadBefore.max : "") + ", top " + ab.max + " dB)" +
        (report.keys.keys ? "; " + report.keys.keys + " Volume keyframes on " + report.keys.clips + " clip(s)" : "") +
        (flagged ? ". " + flagged + " off-mic/short clip(s) given the usual level only (see notes)" : "") +
        (report.notes.length ? ". " + report.notes.join(" ") : "") +
        (bad.length ? ". " + bad.length + " clip(s) over the ceiling or 3 dB away from the others" : "") +
        (report.spots.length ? ". " + report.spots.length + " spot(s) to check (red markers named Sound Pass" + (report.check.capped ? "; first 100 of " + report.check.total : "") + "): " + path.join(dir, "spots.csv")
          : ". No spots to check") +
        ". Took " + Math.round((Date.now() - t0) / 1000) + " s. Report: " + path.join(dir, "report.csv");
      api.status(summary);
      return { ok: bad.length === 0, summary: summary, error: summary, details: { sequence: scan.sequence, workFolder: dir, all: a, allBefore: ab, spread: report.spread,
        spreadBefore: report.spreadBefore, postGainDb: report.postGainDb, keys: report.keys, outside: bad, clips: rows, skipped: scan.skipped, notes: report.notes, spots: report.spots, check: report.check, markers: report.markers } };
    }).catch(function (e) {
      var msg = e && e.stop ? e.stop : "Sound Pass stopped: " + (e && e.message ? e.message : String(e));
      api.status(msg);
      return { ok: false, error: msg, details: { workFolder: dir || null, more: e && e.details ? e.details : null } };
    }).then(function (r) { if (task) task.done(!!r.ok); busy = null; return r; });
  }

  return { actions: { run: run }, busy: function () { return busy; } };
};
