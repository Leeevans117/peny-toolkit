/* Sound Pass, panel side (Node). Levels the interview voice on a safe copy the way Lee did it
 * in Assembly V1 (a Hard Limiter on every voice clip, top held at -6 dB on the meters), but
 * per clip, so every clip sits at the same level:
 * 1. premiere.jsx "copy" (Make safe copy unless already on a TOOLKIT COPY), "scan" (voice clips).
 * 2. Every voice clip gets one Hard Limiter, bypassed; Premiere renders the voice tracks
 *    (exportAsMediaDirect, 32-bit float) and measure.py reads each clip's speech level (L0).
 * 3. Limiter on with 0 dB boost and a -20 dB ceiling; the render shows where each track's
 *    ceiling lands on the master, i.e. the gain after the clip (pan law, track and master
 *    faders, e.g. +4.9 / +15 dB in Tahnee Home IV).
 * 4. Input Boost = target - L0 (within 6 dB of the source's usual boost, so off-mic questions
 *    are not pumped up), ceiling = -6 dB on the master, then a final render checks every clip.
 *    All renders are compared on the same speech windows (chosen on the dry render). Lee's clip gain, Volume and faders are left as they are.
 * Renders go to /tmp/peny-toolkit/sound-pass/<sequence>-<time>/ and are removed once measured (their 400 ms window levels are kept as .npz)
 * (report.json and report.csv stay). Only the TOOLKIT COPY changes; nothing is saved. */
var fs = require("fs");
var path = require("path");
var childProcess = require("child_process");

var FFMPEG = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"];
var PYTHON = ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"];
var WORK_ROOT = "/tmp/peny-toolkit/sound-pass";

// Targets, on Premiere's master meter (dBFS), calibrated on Lee's V1 interviews.
var TARGET_PRE = -6;   // median 400 ms speech peak before the limiter trims the top
var CEILING = -6;      // limiter ceiling as seen on the master
var PROBE_CEILING = -20; // clip-side ceiling used to find the gain after each clip
var MIN_WINDOWS = 5;   // clips with less speech (2 s) take the usual boost of their source
var LONG_WINDOWS = 50; // clips with 20 s of speech set the usual boost
var SPREAD = 6;        // dB a clip may move from its source's usual boost

function firstExisting(list) { for (var i = 0; i < list.length; i++) if (fs.existsSync(list[i])) return list[i]; return null; }
function boostValue(db) { return 2 / 3 + db / 150; }     // Input Boost, measured by render
function maxValue(db) { return 1 + db / 100; }          // Maximum Amplitude, measured by render
function median(a) { var s = a.slice().sort(function (x, y) { return x - y; }); var n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; }
function r2(x) { return Math.round(x * 100) / 100; }
function fmt(s) { var h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = (s % 60).toFixed(1); return h + ":" + (m < 10 ? "0" : "") + m + ":" + (x < 10 ? "0" : "") + x; }

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
    var ffmpeg = firstExisting(FFMPEG), python = pythonWithNumpy();
    if (!ffmpeg) return Promise.resolve({ ok: false, error: "ffmpeg not found (" + FFMPEG.join(", ") + ")." });
    if (!python) return Promise.resolve({ ok: false, error: "No python3 with numpy found (" + PYTHON.join(", ") + ")." });
    var preset = path.join(api.skillDir, "wav-float.epr");
    var t0 = Date.now(), dir, scan, clips, voiceTracks, copyInfo, report = { passes: {} }, npz = {};
    busy = "Sound Pass";

    // Sets the clips (unless settings is null), renders the voice tracks and keeps the
    // 400 ms window levels of the render (the wav itself is removed).
    function pass(name, settings) {
      api.status("Sound Pass: " + name + (settings ? " — setting " + settings.length + " clips…" : " — as found…"));
      return (settings ? jsx({ action: "set", clips: settings }) : Promise.resolve({ details: { set: 0, added: 0 } })).then(function (s) {
        report.passes[name] = { set: s.details.set, added: s.details.added };
        api.status("Sound Pass: " + name + " — rendering the voice tracks…");
        var wav = path.join(dir, name + ".wav");
        return jsx({ action: "render", voiceTracks: voiceTracks, path: wav, preset: preset }).then(function (r) {
          report.passes[name].renderMs = r.details.ms;
          if (!r.details.mutesRestored) throw { stop: "Track mutes on the copy were not restored after the " + name + " render; check the copy's track mute buttons." };
          api.status("Sound Pass: " + name + " — measuring…");
          npz[name] = path.join(dir, name + ".npz");
          return measure(python, { mode: "blocks", ffmpeg: ffmpeg, wav: wav, out: npz[name] });
        }).then(function () { try { fs.unlinkSync(wav); } catch (e) {} });
      });
    }
    // Speech stats per clip for every render so far, all on the dry render's speech windows.
    function stats() {
      return measure(python, { mode: "stats", files: npz, maskFrom: "dry", gate: 20, clips: clips.map(function (c) { return { id: c.nodeId, start: c.start, end: c.end }; }) })
        .then(function (m) { return m.files; });
    }

    return jsx({ action: "copy" }).then(function (c) {
      copyInfo = c.details;
      return jsx({ action: "scan", tracks: params.tracks || "" });
    }).then(function (s) {
      scan = s.details;
      if (!scan.isCopy) throw { stop: "The active sequence is not a TOOLKIT COPY after the copy step." };
      clips = scan.clips;
      voiceTracks = [];
      clips.forEach(function (c) { if (voiceTracks.indexOf(c.track) < 0) voiceTracks.push(c.track); });
      var safe = scan.sequence.replace(/[^A-Za-z0-9 _-]+/g, "").replace(/\s+/g, "_").slice(0, 60);
      dir = path.join(WORK_ROOT, safe + "-" + new Date().toISOString().replace(/[:.]/g, "-"));
      fs.mkdirSync(dir, { recursive: true });
      api.log("Sound Pass: \"" + scan.sequence + "\": " + clips.length + " voice clip(s) on " + voiceTracks.map(function (t) { return "A" + (t + 1); }).join(", ") +
        (scan.skipped.length ? "; left alone: " + scan.skipped.join(", ") : ""));
      report.before = clips.map(function (c) { return { nodeId: c.nodeId, clipGainDb: c.clipGainDb, volumeDb: c.volumeDb, hl: c.hl }; });
      return pass("before", null);
    }).then(function () {
      return pass("dry", clips.map(function (c) { return { track: c.track, nodeId: c.nodeId, bypass: true }; }));
    }).then(function () {
      return pass("ceiling", clips.map(function (c) { return { track: c.track, nodeId: c.nodeId, bypass: false, boost: boostValue(0), max: maxValue(PROBE_CEILING) }; }));
    }).then(stats).then(function (m) {
      // Gain after the clip, per track: where the -20 dB clip ceiling lands on the master
      // (only clips that really reach it count).
      var post = {}, byTrack = {};
      clips.forEach(function (c) {
        var d = m.dry.clips[c.nodeId] || {}, e = m.ceiling.clips[c.nodeId] || {};
        if (e.n >= MIN_WINDOWS && d.max > e.max + 3) (byTrack[c.track] = byTrack[c.track] || []).push(e.max - PROBE_CEILING);
      });
      voiceTracks.forEach(function (t) { post[t] = byTrack[t] && byTrack[t].length ? r2(median(byTrack[t])) : null; });
      report.postGainDb = post;
      clips.forEach(function (c) {
        c.dry = m.dry.clips[c.nodeId] || {};
        c.asFound = m.before.clips[c.nodeId] || {};
        c.want = c.dry.n >= MIN_WINDOWS ? TARGET_PRE - c.dry.pk50 : null;
      });
      // The usual boost for each source on each track, from clips with plenty of speech.
      // A clip may move at most SPREAD dB from it. Clips more than SPREAD dB quieter are the
      // interviewer or crew off-mic between the answers; like Lee (one gain for every clip) they
      // get the usual boost only, so their room noise is not pumped up.
      function groupBoost(c) {
        var pick = function (f) { return clips.filter(function (o) { return o.want !== null && o.dry.n >= LONG_WINDOWS && o.track === c.track && f(o); }).map(function (o) { return o.want; }); };
        var g = pick(function (o) { return o.source === c.source; });
        if (!g.length) g = pick(function () { return true; });
        if (!g.length) g = clips.filter(function (o) { return o.want !== null && o.track === c.track; }).map(function (o) { return o.want; });
        return g.length ? median(g) : 0;
      }
      var plan = [], noPost = [];
      clips.forEach(function (c) {
        var g = groupBoost(c), b;
        if (c.want === null) { b = g; c.note = "little speech: usual boost"; }
        else if (c.want > g + SPREAD) { b = g; c.note = "quiet (" + r2(c.want - g) + " dB under the answers): probably the interviewer or crew off-mic, given the usual boost only"; }
        else if (c.want < g - SPREAD) { b = g - SPREAD; c.note = "loud: lowered " + SPREAD + " dB more than usual only"; }
        else b = c.want;
        var p = post[c.track];
        if (p === null) { if (noPost.indexOf(c.label) < 0) noPost.push(c.label); p = -3; }
        c.boostDb = r2(Math.max(-60, Math.min(45, b)));
        c.ceilingDb = r2(Math.max(-60, Math.min(0, CEILING - p)));
        plan.push({ track: c.track, nodeId: c.nodeId, bypass: false, boost: boostValue(c.boostDb), max: maxValue(c.ceilingDb) });
      });
      if (noPost.length) report.notes = ["No clip on " + noPost.join(", ") + " reached the probe ceiling; assumed the usual -3 dB pan law after the clip."];
      return pass("final", plan);
    }).then(stats).then(function (m) {
      var rows = [], spread = [], spreadBefore = [], bad = [];
      clips.forEach(function (c) {
        var f = m.final.clips[c.nodeId] || {}, b = m.before.clips[c.nodeId] || {};
        var row = { track: c.label, start: fmt(c.start), end: fmt(c.end), name: c.name, speechSec: r2((f.n || 0) * 0.4),
          clipGainDb: c.clipGainDb, volumeDb: c.volumeDb, hadLimiter: c.hl.count > 0,
          beforePk25: b.pk25, beforePk50: b.pk50, beforePk75: b.pk75, beforeMax: b.max, beforeIn12to6: b.in12to6,
          boostDb: c.boostDb, ceilingDb: c.ceilingDb, note: c.note || "",
          afterPk10: f.pk10, afterPk25: f.pk25, afterPk50: f.pk50, afterPk75: f.pk75, afterMax: f.max, afterIn12to6: f.in12to6 };
        rows.push(row);
        if (f.n >= MIN_WINDOWS && !c.note) {
          spread.push(f.pk50);
          if (b.n >= MIN_WINDOWS) spreadBefore.push(b.pk50);
          if ((f.n >= LONG_WINDOWS && (f.pk50 < -9 || f.pk50 > -5)) || f.max > CEILING + 0.5) bad.push(row);
        }
        if (f.max > CEILING + 0.5 && bad.indexOf(row) < 0) bad.push(row);
      });
      function range(a) { return a.length ? { min: Math.min.apply(null, a), max: Math.max.apply(null, a), median: median(a) } : null; }
      report.clips = rows;
      report.all = m.final.all; report.allBefore = m.before.all;
      report.spread = range(spread); report.spreadBefore = range(spreadBefore);
      fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(report, null, 1));
      var keys = Object.keys(rows[0]);
      fs.writeFileSync(path.join(dir, "report.csv"), keys.join(",") + "\n" + rows.map(function (r) {
        return keys.map(function (k) { var v = r[k]; return typeof v === "string" ? '"' + v.replace(/"/g, '""') + '"' : (v === undefined || v === null ? "" : v); }).join(",");
      }).join("\n") + "\n");
      var a = m.final.all || {}, ab = m.before.all || {}, flagged = clips.filter(function (c) { return c.note; }).length;
      var summary = "Levelled " + clips.length + " voice clip(s) on \"" + scan.sequence + "\"" + (copyInfo.made ? " (new safe copy; the original is untouched)" : "") +
        ". Speech now: median " + a.pk50 + " dB, body " + a.pk25 + " to " + a.pk75 + " dB, top " + a.max + " dB, " + Math.round((a.in12to6 || 0) * 100) + "% between -12 and -6" +
        (report.spread ? "; answer clips' medians " + report.spread.min + " to " + report.spread.max + " dB" : "") +
        " (as found: median " + ab.pk50 + ", top " + ab.max + ", " + Math.round((ab.in12to6 || 0) * 100) + "%" +
        (report.spreadBefore ? ", medians " + report.spreadBefore.min + " to " + report.spreadBefore.max : "") + ")" +
        (flagged ? ". " + flagged + " quiet/short clip(s) kept near the usual boost (see notes)" : "") +
        (bad.length ? ". " + bad.length + " clip(s) with 20 s+ of speech outside -9..-5 dB, or over the ceiling" : "") +
        ". Took " + Math.round((Date.now() - t0) / 1000) + " s. Report: " + path.join(dir, "report.csv");
      api.status(summary);
      return { ok: bad.length === 0, summary: summary, error: summary, details: { sequence: scan.sequence, workFolder: dir, all: a, allBefore: ab, spread: report.spread,
        spreadBefore: report.spreadBefore, postGainDb: report.postGainDb, outside: bad, clips: rows, skipped: scan.skipped, notes: report.notes || [] } };
    }).catch(function (e) {
      var msg = e && e.stop ? e.stop : "Sound Pass stopped: " + (e && e.message ? e.message : String(e));
      api.status(msg);
      return { ok: false, error: msg, details: { workFolder: dir || null, more: e && e.details ? e.details : null } };
    }).then(function (r) { busy = null; return r; });
  }

  return { actions: { run: run }, busy: function () { return busy; } };
};
