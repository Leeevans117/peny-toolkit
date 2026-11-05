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
// Tools put in place by the one-click installer (no Homebrew needed). Used first when
// present: they are the versions the toolkit was tested with, and their python3 has numpy
// (a Homebrew python3 without numpy would break Sync, Sound Pass and Colour).
function BUNDLED(name) { return path.join(process.env.HOME || "", "Library", "Application Support", "PenyToolkit", "bin", name); }
var childProcess = require("child_process");

var FFMPEG = [BUNDLED("ffmpeg"), "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"];
var PYTHON = [BUNDLED("python3"), "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"];

function firstExisting(list) { for (var i = 0; i < list.length; i++) if (fs.existsSync(list[i])) return list[i]; return null; }
function q64(x) { return Math.round(x * 64) / 64; }
function floor64(x) { return Math.floor(x * 64) / 64; }
function clock(name) { var m = /(\d{6})_(\d{2})(\d{2})(\d{2})/.exec(name); return m ? (+m[2]) * 3600 + (+m[3]) * 60 + (+m[4]) : null; }
// Same as measure.py clip_clocks: RED Abs TC ("tc") and Timestamp ("ts"), the file name's HHMMSS.
function clipClocks(c) {
  var d = {}, k;
  for (k in (c.clocks || {})) if (c.clocks[k] !== undefined && c.clocks[k] !== null) d[k] = c.clocks[k];
  var n = clock(c.name); if (n !== null && d.name === undefined) d.name = n;
  return d;
}
function clipClock(c) { var d = clipClocks(c); return d.tc !== undefined ? d.tc : d.ts !== undefined ? d.ts : d.name !== undefined ? d.name : null; }
function hms(s, sec) {
  s = ((Math.round(s) % 86400) + 86400) % 86400;
  var h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
  return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m + (sec ? ":" + (x < 10 ? "0" : "") + x : "");
}
// Order for measuring: every 8th clip by camera clock, then every 4th between, 2nd, the rest.
function spread(list) {
  var out = [], seen = {};
  [8, 4, 2, 1].forEach(function (step) {
    for (var i = 0; i < list.length; i += step) if (!seen[i]) { seen[i] = true; out.push(list[i]); }
  });
  return out;
}
// Skipping goes by a time-of-day clock only: RED Timestamp ("ts") or the file name's. RED
// timecode resets (Lake Placid A134-A136: 70 min jump) so it could skip a clip that is in
// the recording. The Timestamp was up to 306 s out on 4 of 26 clips there, so a clip is
// skipped only when it is more than 15 min outside every recording (Lake Placid: 99 of 154
// skipped, none of the 26 that sync).
var SKIP_KINDS = ["ts", "name"], SKIP_MARGIN = 900;
function skipKind(rec) { for (var i = 0; i < SKIP_KINDS.length; i++) if (rec.offsets && rec.offsets[SKIP_KINDS[i]] !== undefined) return SKIP_KINDS[i]; return null; }
// Recordings usable for skipping: each must have agreeing time-of-day clocks.
function usable(recs) {
  if (!recs || !recs.length) return null;
  for (var i = 0; i < recs.length; i++) if (!skipKind(recs[i])) return null;
  return recs;
}
// Why a clip is outside every recording by its time-of-day clock, or null.
function outside(c, recs) {
  var cl = clipClocks(c), t = null, k = null;
  for (var i = 0; i < recs.length; i++) {
    k = skipKind(recs[i]);
    if (cl[k] === undefined) return null;
    t = cl[k];
    var rt = recs[i].offsets[k] + t + c.inPoint;
    if (rt + c.duration >= -SKIP_MARGIN && rt <= recs[i].length + SKIP_MARGIN) return null;
  }
  return "shot outside the external recording by the camera clock (" + hms(t + c.inPoint, true) + " vs recording " +
    recs.map(function (r) { var o = r.offsets[skipKind(r)]; return hms(-o) + "-" + hms(-o + r.length); }).join(", ") + ")";
}

// Sound of RED clips with no proxy attached. ffmpeg can't decode the audio inside an .R3D
// and REDline has no audio-only export, so REDline renders the measured stretch (the clip's
// first <=120 s from its in-point, +1 s) as a 192x108 ProRes Proxy .mov, which carries the
// camera channels; ffmpeg copies each channel to its own mono stream (measure.py tries
// streams one by one, as in a proxy) and the render is deleted. Tested 4 Nov 2026
// on Data's Mac mini (REDline 65.1.3, Komodo-X): the sound is sample-identical to the
// Toolkit proxy's, starts exactly on --start (0-based), ~24 s per 120 s of sound with the GPU
// on (47 s on CPU). REDline's channel order differs from the proxy's (ch1 = proxy a:3, ch2 =
// a:0 ...); it does not matter here, every channel is tried on its own. Slow-motion R3Ds have
// no camera audio ("Camera Audio Channels: 0") and are reported, not rendered.
var REDLINE = ["/usr/local/bin/REDline", "/Applications/REDCINE-X Professional/REDCINE-X PRO.app/Contents/MacOS/REDline"];
var RED_SECONDS = 120, RED_AT_ONCE = 2;
function redlineAudio(ffmpeg, api) {
  var redline = firstExisting(REDLINE);
  var dir = path.join(process.env.HOME || "/tmp", "Library", "Caches", "PenyToolkit", "sync-audio");
  var meta = {}, made = [];
  function run(cmd, args) {
    return new Promise(function (ok) {
      childProcess.execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024 }, function (e, out, err) {
        ok({ error: e, out: String(out || ""), err: String(err || "") });
      });
    });
  }
  // Exact rates for the rounded ones REDline prints (23.976 -> 24000/1001).
  function exactFps(x) {
    var nd = [24, 30, 48, 60, 120];
    for (var i = 0; i < nd.length; i++) if (Math.abs(x - nd[i] * 1000 / 1001) < 0.002) return nd[i] * 1000 / 1001;
    return x;
  }
  function info(r3d) {
    if (meta[r3d]) return meta[r3d];
    meta[r3d] = run(redline, ["--i", r3d, "--printMeta", "1"]).then(function (r) {
      var t = r.out + "\n" + r.err;
      var fps = /^FPS:\s*([\d.]+)/m.exec(t), frames = /^Total Frames:\s*(\d+)/m.exec(t), ch = /^Camera Audio Channels:\s*(\d+)/m.exec(t);
      var ts = /^Timestamp:\s*(\d{1,6})\s*$/m.exec(t), hms = ts ? ("000000" + ts[1]).slice(-6) : null;
      var tc = /^Abs TC:\s*(\d+):(\d+):(\d+)[:;](\d+)/m.exec(t);
      if (!fps || !frames) return { error: "REDline could not read the clip's metadata" + (r.error ? " (" + r.error.message.split("\n")[0] + ")" : "") };
      return { fps: exactFps(parseFloat(fps[1])), frames: +frames[1], channels: ch ? +ch[1] : null,
        clock: hms ? (+hms.slice(0, 2)) * 3600 + (+hms.slice(2, 4)) * 60 + (+hms.slice(4)) : undefined,
        tc: tc ? (+tc[1]) * 3600 + (+tc[2]) * 60 + (+tc[3]) + (+tc[4]) / Math.round(exactFps(parseFloat(fps[1]))) : undefined };
    });
    return meta[r3d];
  }
  function one(c) {
    return info(c.path).then(function (m) {
      if (m.error) return m.error;
      if (m.channels === 0) return "RED clip has no camera audio (REDline: 0 audio channels, e.g. slow motion)";
      var start = Math.max(0, Math.floor(c.inPoint * m.fps + 1e-6));
      if (start >= m.frames) return "in-point is past the end of the R3D (" + m.frames + " frames)";
      var count = Math.min(Math.ceil((Math.min(c.duration, RED_SECONDS) + 1) * m.fps), m.frames - start);
      var base = "sync-" + process.pid + "-" + String(c.id).replace(/[^\w.-]/g, "_");
      var mov = path.join(dir, base + ".mov"), wav = path.join(dir, base + "-sound.mov"); // one mono stream per channel
      [mov, wav].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} });
      return run(redline, ["--i", c.path, "--outDir", dir, "--o", base, "--format", "201", "--PRcodec", "3", "--res", "8",
        "--resizeX", "192", "--resizeY", "108", "--fit", "3", "--filter", "0", "--start", String(start), "--frameCount", String(count)]).then(function (r) {
        if (!fs.existsSync(mov)) {
          var line = (r.out + "\n" + r.err).split("\n").filter(function (l) { return /error|fail|unable/i.test(l); }).pop();
          return "REDline did not write the sound" + (line ? ": " + line.replace(/^\[[^\]]*\]<[^>]*>\s*/, "").trim() : "");
        }
        // REDline writes one multichannel stream; measure.py tries each *stream* on its own
        // (as in a proxy: 4 mono streams), so every channel becomes its own mono stream.
        return run(path.join(path.dirname(ffmpeg), "ffprobe"), ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels", "-of", "csv=p=0", mov]).then(function (p) {
          var n = parseInt(p.out, 10) || 0;
          if (!n) return { error: true };
          var fc = [], maps = [];
          for (var k = 0; k < n; k++) { fc.push("[0:a:0]pan=mono|c0=c" + k + "[c" + k + "]"); maps.push("-map", "[c" + k + "]"); }
          return run(ffmpeg, ["-v", "error", "-nostdin", "-y", "-i", mov, "-filter_complex", fc.join(";")].concat(maps, ["-c:a", "pcm_s24le", "-f", "mov", wav]));
        }).then(function (f) {
          try { fs.unlinkSync(mov); } catch (e) {}
          if (f.error || !fs.existsSync(wav)) { try { fs.unlinkSync(wav); } catch (e) {} return "RED clip has no camera audio (REDline wrote no sound" + (m.channels === null ? "" : ", " + m.channels + " channels in metadata") + ")"; }
          made.push(wav);
          c.path = wav;
          c.audioIn = c.inPoint - start / m.fps; // the wav starts on frame `start`
          return null;
        });
      });
    }).catch(function (e) { return "REDline failed: " + (e && e.message ? e.message : String(e)); });
  }
  return {
    available: function () { return !!redline; },
    // Renders the sound of every clip with source "redline"; clips that fail are taken out
    // of `clips` (in place) and added to `unread` with the reason.
    // Camera clock of every RED clip (proxy or not) for measure.py's clock check and the
    // clock skip: REDline "Abs TC" and "Timestamp" (HHMMSS), each checked on its own.
    clocks: function (clips) {
      var reds = redline ? clips.filter(function (c) { return c.red && fs.existsSync(c.media || ""); }) : [];
      var next = 0, done = 0, workers = [];
      function worker() { // 4 REDline reads at once: ~0.66 s each, 154 clips took 100 s one by one
        if (next >= reds.length) return Promise.resolve();
        var c = reds[next++];
        return info(c.media).then(function (m) {
          c.clocks = { ts: m.clock, tc: m.tc };
          api.status("Reading RED clip clocks " + (++done) + "/" + reds.length);
          return worker();
        });
      }
      for (var i = 0; i < 4; i++) workers.push(worker());
      return Promise.all(workers);
    },
    prepare: function (clips, unread) {
      var todo = clips.filter(function (c) { return c.source === "redline"; });
      if (!todo.length) return Promise.resolve();
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
      var next = 0, done = 0, failed = {};
      return Promise.resolve().then(function () {
        function worker() {
          if (next >= todo.length) return Promise.resolve();
          var c = todo[next++];
          return one(c).then(function (why) {
            done++;
            api.status("Reading RED sound " + done + "/" + todo.length + " " + c.name);
            api.log("  Reading RED sound " + done + "/" + todo.length + " " + c.name + (why ? " - " + why : ""));
            if (why) failed[c.id] = why;
            return worker();
          });
        }
        var workers = [];
        for (var i = 0; i < Math.min(RED_AT_ONCE, todo.length); i++) workers.push(worker());
        return Promise.all(workers).then(function () {
          for (var k = clips.length - 1; k >= 0; k--) {
            var c = clips[k];
            if (c.source === "redline" && failed[c.id]) { unread.push({ name: c.name, time: c.start, reason: failed[c.id] }); clips.splice(k, 1); }
          }
        });
      });
    },
    // Deletes the sound files this run wrote (~70 MB per 120 s clip).
    cleanup: function () { made.forEach(function (f) { try { fs.unlinkSync(f); } catch (e) {} }); made = []; }
  };
}

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

  // Camera-clock skip. Clips are measured in batches spread across the camera clock (every
  // 8th clip first, then the ones between...), so clips that sync come early wherever the
  // recording sits. Once a recording's camera clocks agree (measure.py clock_models, same
  // 2 s tolerance as its clock check), a clip the clock puts entirely outside every
  // recording (15 min margin, by the time-of-day clock) is not read at all: no REDline, no measuring. Any recording
  // whose clocks don't agree (or a wav with no synced clip yet) means nothing is skipped.
  // Lake Placid A005 + DJI Mic: 48 of 154 clips are inside the ~93 min recording.
  // A last measure.py run (every clip known or skipped) does the clock check and step 3.
  function batched(python, ffmpeg, wavInfo, clips, unread, redAudio) {
    var timed = clips.filter(function (c) { return clipClock(c) !== null; })
      .sort(function (a, b) { return (clipClock(a) + a.inPoint) - (clipClock(b) + b.inPoint); });
    var queue = spread(timed).concat(clips.filter(function (c) { return clipClock(c) === null; }));
    var size = Math.max(8, Math.ceil(clips.length / 8)), known = {}, models = null, skipped = 0, measured = 0;
    function job(list, first) {
      return { ffmpeg: ffmpeg, wavs: wavInfo, firstPassOnly: first, clips: list.map(function (c) {
        if (!known[c.id]) return c;
        var k = {}; for (var f in c) k[f] = c[f];
        k.known = known[c.id]; return k;
      }) };
    }
    function next() {
      var batch = [];
      while (queue.length && batch.length < size) {
        var c = queue.shift(), why = models && outside(c, models);
        if (why) { c.skip = why; skipped++; } else batch.push(c);
      }
      if (!batch.length) return Promise.resolve();
      return redAudio.prepare(batch, unread).then(function () {
        var have = clips.filter(function (c) { return known[c.id]; });
        measured += batch.length;
        api.log("  Measuring batch: " + batch.length + " clip(s) (" + measured + " measured, " + skipped + " skipped so far)");
        return measure(python, job(have.concat(batch), true));
      }).then(function (m) {
        m.results.forEach(function (r) { known[r.id] = r; });
        models = usable(m.recordings);
        return next();
      });
    }
    return next().then(function () {
      var all = clips.filter(function (c) { return known[c.id] || c.skip; });
      if (skipped) api.log("  Camera clock: " + skipped + " clip(s) shot outside the external recording, not read");
      return measure(python, job(all, false));
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
    var scan, wavInfo = [], unread = [];
    var redAudio = redlineAudio(ffmpeg, api);
    api.status("Reading the timeline…");
    return api.evalSkill({ action: "scan" }).then(function (r) {
      if (!r.ok) throw { stop: r.error };
      scan = r.details;
      if (!scan.wavs.length) throw { stop: "No external audio on this sequence. Put the wav files on an empty audio track (anywhere, e.g. after the clips) and run Sync again." };
      return Promise.all(scan.wavs.map(function (p) { return duration(ffprobe, p).then(function (d) { wavInfo.push({ path: p, duration: d }); }); }));
    }).then(function () {
      var bad = wavInfo.filter(function (w) { return !w.duration; });
      if (bad.length) throw { stop: "Could not read " + bad.map(function (w) { return w.path; }).join(", ") };
      // Where ffmpeg reads each camera clip's sound. ffmpeg can't decode the sound inside a
      // RED .R3D (it fails at once, so every R3D came back "no camera audio to measure":
      // Lee's 172-clip run on 4 Nov 2026). RED clips are read from the proxy Premiere has
      // attached (Toolkit RED proxies carry the camera channels, same timing as the R3D),
      // or, with no proxy, from the first minutes of the R3D's sound written out by REDline.
      var clips = [];
      unread = [];
      scan.cams.forEach(function (c) {
        var isRed = /\.r3d$/i.test(c.path || "");
        var src = null, how = "media";
        if (c.path && !isRed && fs.existsSync(c.path)) src = c.path;
        else if (c.proxy && fs.existsSync(c.proxy)) { src = c.proxy; how = "proxy"; }
        else if (isRed && fs.existsSync(c.path) && redAudio.available()) { src = c.path; how = "redline"; }
        if (!src) {
          unread.push({ name: c.name, time: c.start, reason: !c.path || !fs.existsSync(c.path) ? "media file not found (offline)" :
            "RED clip: ffmpeg can't read the sound inside an .R3D and there is no proxy attached or REDline installed" });
          return;
        }
        clips.push({ id: c.nodeId, name: c.name, path: src, source: how, red: isRed, media: c.path, start: c.start, inPoint: c.inPoint, duration: c.end - c.start });
      });
      var bySource = {};
      clips.forEach(function (c) { bySource[c.source] = (bySource[c.source] || 0) + 1; });
      api.log("Sync: " + clips.length + " camera clip(s) against " + wavInfo.length + " wav(s) on A" + (scan.track + 1) +
        " (sound read from: " + Object.keys(bySource).map(function (k) { return bySource[k] + " " + (k === "media" ? "camera file" : k === "proxy" ? "attached proxy" : "R3D via REDline"); }).join(", ") +
        (unread.length ? "; " + unread.length + " can't be read" : "") + ")");
      return redAudio.clocks(clips).then(function () {
        return batched(python, ffmpeg, wavInfo, clips, unread, redAudio);
      }).then(function (m) { redAudio.cleanup(); return m; }, function (e) { redAudio.cleanup(); throw e; });
    }).then(function (m) {
      var byId = {}, pieces = [], synced = [], unsynced = unread.slice();
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
        var cl = r.clock !== undefined && r.clock !== null ? r.clock : clock(r.name);
        if (cl !== null) rec.wavStartClock = cl + cam.inPoint - r.recTime;
        synced.push(rec);
      });
      if (!pieces.length) return { placed: { ok: true, details: { placed: [], failed: [] } }, synced: synced, unsynced: unsynced };
      api.status("Placing " + pieces.length + " wav piece(s) on A" + (scan.track + 1) + "…");
      return api.evalSkill({ action: "place", pieces: pieces, track: scan.track, sequenceId: scan.sequenceId, sequenceName: scan.sequence }).then(function (pl) {
        return { placed: pl, synced: synced, unsynced: unsynced };
      });
    }).then(function (o) {
      var d = o.placed.details || {};
      var clocks = o.synced.filter(function (s) { return s.wavStartClock !== undefined; }).map(function (s) { return s.wavStartClock; });
      // Spread of the clips within 2 s of the median: a camera clock that jumped (Lake Placid
      // A134-A136's TC) would otherwise make it read thousands of seconds.
      var med = clocks.slice().sort(function (a, b) { return a - b; })[Math.floor(clocks.length / 2)];
      var close = clocks.filter(function (x) { return Math.abs(x - med) <= 2; });
      var spread = close.length > 1 ? (Math.max.apply(null, close) - Math.min.apply(null, close)) : null;
      var summary = o.synced.length + " of " + (o.synced.length + o.unsynced.length) + " camera clips synced by waveform; " +
        (d.placed || []).length + " wav piece(s) placed and checked, " + (d.failed || []).length + " failed; " +
        o.unsynced.length + " left for you to sync by hand." +
        (spread !== null ? " Camera clocks agree to " + spread.toFixed(1) + " s" + (close.length < clocks.length ? " (" + (clocks.length - close.length) + " clip(s) on a different clock)" : "") + "." : "") +
        ((d.cuts || []).length ? " " + d.cuts.length + " camera clip(s) cut where the wav file changes, so each half links to its own piece." : "") +
        (o.unsynced.length || (d.failed || []).length ? "" : " Now run step 3, Link.");
      // A refused or failed "place" call has no details: say why nothing was placed.
      if (o.placed.ok === false && !(d.placed || []).length && !(d.failed || []).length) summary = "Nothing placed: " + (o.placed.error || "placing failed") + " " + summary;
      if (d.activeNotRestored) summary += " Could not switch back to \"" + d.activeNotRestored + "\".";
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
