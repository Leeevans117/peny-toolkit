/* Peny Toolkit: background OS jobs (Node side of the panel).
 *
 * A pool that runs shell commands with child_process.exec, a few at a time, with
 * Pause (stop starting new jobs), Resume, Cancel (kill everything), and the stall and
 * timeout handling carried over from the Proxy Automation panel, where each rule was
 * found the hard way:
 *  - maxBuffer 200 MB: exec's 1 MB default killed long REDline renders (it logs a line
 *    per frame).
 *  - completion = the process exiting, never the output file existing (ffmpeg creates
 *    the file at the start, which over-filled the pool).
 *  - kill = SIGKILL every process under the shell (children first), then the shell;
 *    killing the shell alone orphans ffmpeg/REDline.
 *  - stall: after a 5 min grace, an output file that has not grown in 10 min is a hung
 *    job and is killed; 4 h is a hard backstop.
 *
 * Progress: pool.progress() counts finished jobs (real exits, the same events as the
 * log's Done/FAILED lines) and adds each running job's fraction when its tool reports
 * one: REDline logs "Export Job frame complete. <n> <fraction>" per frame, ffmpeg logs
 * "Duration:" once and "time=" as it goes. opts.onProgress gets it on every start/finish
 * (event "job-start"/"job-done") and at most every 500 ms in between (event "tick").
 *
 * ETA (progress().eta): each job may carry a weight (proxy-automation passes source bytes)
 * and a kind ("r3d"/"ffmpeg": REDline is far slower per byte). Seconds-per-weight is
 * measured per kind from the jobs' own run times (see _rates: recency-weighted, first
 * wave discounted, plus the rate saved from earlier runs in opts.etaHistoryFile), so it
 * already includes the slow-down of 4 renders at once and is not thrown by pauses. A
 * running job's time left blends that rate with its own pace (time so far / share done).
 * The rest of the run is then played forward with up to maxConcurrent jobs at once and
 * each job slower the more run together (ETA_SHARE), so the tail is counted right. "Estimating" only while a kind still to render has no
 * measurement and no saved rate. The finish time is smoothed (up to 10 s time constant)
 * so the number does not jump about. eta.jobs lists each running job with its own
 * fraction and seconds left (Jobs in progress panel).
 * Replay check (12 Oct 2026 Komodo runs: 44 clips warm and cold, 2 huge clips): mean
 * error 4-7% (old: 5%, 28%, and 7 min of "Estimating" then 65% high on the 2 clips).
 */

var childProcess = require("child_process");
var fs = require("fs");
var path = require("path");

var DEFAULTS = {
  maxConcurrent: 4,
  maxBuffer: 200 * 1024 * 1024,
  timeoutMs: 4 * 60 * 60 * 1000,
  stallGraceMs: 5 * 60 * 1000,
  stallCheckMs: 10 * 60 * 1000,
  watchMs: 5000,
  etaHistoryFile: null, // JSON file keeping each kind's render rate between runs (ETA)
  limits: null // function () -> { total, perKind }: how many may run now (see _fill)
};

// A missing file counts as 0 bytes, as in the original panel, so a job that never
// writes anything is still caught as stalled.
function fileSize(p) {
  try { return fs.statSync(p).size; } catch (e) { return 0; }
}

// A finished .mov has a whole 'moov' atom; ffmpeg/REDline write it last (no +faststart),
// so a render cut short lacks it. Walks the top-level atoms (a few 16-byte reads). The old
// check only searched the last 2 MB, but an 80-minute 8K interview proxy has a 9.6 MB moov
// (one sample entry per PCM sample), so finished files were called incomplete (20 Oct 2026).
function isCompleteMov(p) {
  var fd;
  try {
    var size = fs.statSync(p).size;
    if (size < 4096) return false;
    fd = fs.openSync(p, "r");
    var head = Buffer.alloc(16), off = 0;
    while (off + 8 <= size) {
      if (fs.readSync(fd, head, 0, 16, off) < 8) return false;
      var len = head.readUInt32BE(0), type = head.toString("latin1", 4, 8);
      if (len === 1) len = Number(head.readBigUInt64BE(8));
      else if (len === 0) len = size - off;           // runs to the end of the file
      if (len < 8 || off + len > size) return false;   // atom cut short
      if (type === "moov") return true;
      off += len;
    }
    return false;
  } catch (e) {
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (e) {}
  }
}

// ---- One probe per file -------------------------------------------------------------
// probeMedia(ffprobe, file): ONE ffprobe call (header read, no decoding) that gives
//   { ok: true, frames, duration, audio }   frames/duration null when the container has none
//   { ok: false, error }                    file missing, ffprobe missing/failed/timed out
// audio = the file's audio signature: [[channels, sampleRate], ...], one entry per audio
// stream in file order. Kept by path + size + mtime, in memory and in
// ~/.peny-toolkit/probe-cache.json, so a file is only probed again when it changes (a
// whole-project attach used to run two ffprobe calls per file on every click: 633 clips
// took 21 minutes, 14 Nov 2026). Failures are never cached.
// PENY_TOOLKIT_PROBE_CACHE: another file, for tests.
var PROBE_CACHE_FILE = process.env.PENY_TOOLKIT_PROBE_CACHE || path.join(require("os").homedir(), ".peny-toolkit", "probe-cache.json");
var probeCache = null, probeDirty = false, probeTimer = null;
// Files the read-ahead (warmProbes) just tried and could not read: asked again in the same
// run they fail at once instead of being read a second time with the panel frozen. In
// memory only, cleared by every read-ahead.
var warmFailed = {};
var PROBE_CACHE_VERSION = 2;   // 2: frames from stream duration (MXF), R3D frame count
// An entry from the file is only used if it has the shape this code writes (a damaged or
// hand-edited cache file must not break a plan or an attach).
function validEntry(key, e) {
  if (!e || typeof e !== "object") return false;
  if (key.charAt(0) === "r") return typeof e.channels === "number" && (e.frames === null || typeof e.frames === "number");
  return e.ok === true && Array.isArray(e.audio) && e.audio.every(function (a) { return Array.isArray(a) && typeof a[0] === "number" && typeof a[1] === "number"; }) &&
    (e.frames === null || typeof e.frames === "number") && (e.duration === null || typeof e.duration === "number");
}
// Entries of files that are gone or have changed are dropped when the cache is loaded, so
// the file does not grow for ever. Only done for up to PRUNE_MAX entries (one stat each).
var PRUNE_MAX = 20000;
function loadProbeCache() {
  if (probeCache) return probeCache;
  probeCache = {};
  try {
    var j = JSON.parse(fs.readFileSync(PROBE_CACHE_FILE, "utf-8"));
    if (j && j.v === PROBE_CACHE_VERSION && j.entries && typeof j.entries === "object") {
      var keys = Object.keys(j.entries);
      if (keys.length > PRUNE_MAX) probeDirty = true;   // too many to check: start again
      else keys.forEach(function (k) { if (validEntry(k, j.entries[k])) probeCache[k] = j.entries[k]; else probeDirty = true; });
    }
  } catch (e) {}
  return probeCache;
}
function saveProbeCache() {
  if (!probeDirty) return;
  probeDirty = false;
  try {
    fs.mkdirSync(path.dirname(PROBE_CACHE_FILE), { recursive: true });
    var tmp = PROBE_CACHE_FILE + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ v: PROBE_CACHE_VERSION, entries: probeCache }));
    fs.renameSync(tmp, PROBE_CACHE_FILE);
  } catch (e) {}
}
function probeTouched() {
  probeDirty = true;
  if (probeTimer) return;
  probeTimer = setTimeout(function () { probeTimer = null; saveProbeCache(); }, 2000);
  if (probeTimer.unref) probeTimer.unref();
}
function cacheKey(kind, file) {
  try { var st = fs.statSync(file); return kind + "|" + file + "|" + st.size + "|" + Math.round(st.mtimeMs); } catch (e) { return null; }
}
function probeMedia(ffprobe, file) {
  if (!file) return { ok: false, error: "no file" };
  var key = cacheKey("p", file);
  if (!key) return { ok: false, error: "file not found" };
  var cache = loadProbeCache();
  if (cache[key]) return cache[key];
  if (!ffprobe || !fs.existsSync(ffprobe)) return { ok: false, error: "ffprobe not found" };
  if (warmFailed[key]) return { ok: false, error: "ffprobe could not read the file" };
  var out;
  try {
    out = childProcess.execFileSync(ffprobe, probeArgs(file),
      { encoding: "utf-8", timeout: 30000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) { return { ok: false, error: "ffprobe could not read the file" }; }
  var r = parseProbe(out);
  if (r.ok) { cache[key] = r; probeTouched(); }
  return r;
}
function probeArgs(file) {
  return ["-v", "error", "-show_entries", "stream=codec_type,nb_frames,duration,r_frame_rate,channels,sample_rate:format=duration", "-of", "json", file];
}
function parseProbe(out) {
  var j;
  try { j = JSON.parse(out); } catch (e) { return { ok: false, error: "ffprobe could not read the file" }; }
  var streams = (j && j.streams) || [], frames = null, audio = [], seenVideo = false, bad = false;
  streams.forEach(function (s) {
    if (s.codec_type === "video" && !seenVideo) {
      seenVideo = true;
      var n = parseInt(s.nb_frames, 10);
      if (isFinite(n) && n > 0) frames = n;
      else {
        // MXF records no nb_frames; its video stream's duration is a whole number of
        // frames at a constant rate (Canon, Sony FX6, Z200: measured 15 Nov 2026).
        var fr = /^(\d+)\/(\d+)$/.exec(String(s.r_frame_rate || "")), sd = parseFloat(s.duration);
        if (fr && +fr[1] > 0 && +fr[2] > 0 && isFinite(sd) && sd > 0) {
          var f = sd * (+fr[1]) / (+fr[2]);
          if (Math.abs(f - Math.round(f)) < 0.01) frames = Math.round(f);
        }
      }
    } else if (s.codec_type === "audio") {
      var ch = parseInt(s.channels, 10), rate = parseInt(s.sample_rate, 10);
      if (!isFinite(ch) || ch < 1 || !isFinite(rate) || rate < 1) bad = true;
      audio.push([ch, rate]);
    }
  });
  if (!streams.length) return { ok: false, error: "ffprobe found no streams" };
  if (bad) return { ok: false, error: "ffprobe could not read an audio stream's channels or sample rate" };
  var d = j.format ? parseFloat(j.format.duration) : NaN;
  return { ok: true, frames: frames, duration: isFinite(d) ? d : null, audio: audio };
}

// An R3D's camera audio channels and frame count (ffprobe cannot read R3D): REDline
// --printMeta 1 prints "Camera Audio Channels:<tab>N" and "Total Frames:<tab>N". REDline
// exits with code 1 even when it worked, so only the fields count.
// { channels, frames (null if not printed) }, or null when REDline is missing or did not
// print the audio field.
function redMeta(redline, file) {
  var key = cacheKey("r", file);
  if (!key) return null;
  var cache = loadProbeCache();
  if (cache[key]) return cache[key];
  if (!redline || !fs.existsSync(redline) || warmFailed[key]) return null;
  var res = childProcess.spawnSync(redline, ["--i", file, "--printMeta", "1"],
    { encoding: "utf-8", timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  var m = parseRedMeta(res.stdout);
  if (!m) return null;
  cache[key] = m;
  probeTouched();
  return m;
}
function redAudioChannels(redline, file) { var m = redMeta(redline, file); return m ? m.channels : null; }
function parseRedMeta(out) {
  var c = /^Camera Audio Channels:\s*(\d+)\s*$/m.exec(String(out || ""));
  if (!c) return null;
  var f = /^Total Frames:\s*(\d+)\s*$/m.exec(String(out || ""));
  return { channels: parseInt(c[1], 10), frames: f && parseInt(f[1], 10) > 0 ? parseInt(f[1], 10) : null };
}

// Reads many files ahead of time, a few at once, so the checks that follow find them in
// the cache: probing one file after the other took 0.25 s per file and about 0.8 s per
// R3D, with the panel frozen meanwhile (Loudenvielle, 1,266 files: over 5 minutes).
// o = { ffprobe, redline, files, concurrency (6), onProgress(done, total) }. R3D files go
// to REDline, the rest to ffprobe. Files already known are skipped; a file that cannot be
// read is left out (the check that follows reports it). o.cancelled(): when it returns
// true no further file is started. Resolves with the number read; never rejects.
function warmProbes(o) {
  var cache = loadProbeCache(), seen = {}, todo = [];
  warmFailed = {};
  (o.files || []).forEach(function (f) {
    if (!f || seen[f]) return;
    seen[f] = 1;
    var red = /\.r3d$/i.test(f), key = cacheKey(red ? "r" : "p", f);
    if (!key || cache[key]) return;
    if (red ? !(o.redline && fs.existsSync(o.redline)) : !(o.ffprobe && fs.existsSync(o.ffprobe))) return;
    todo.push({ file: f, red: red, key: key });
  });
  var total = todo.length, done = 0, read = 0, next = 0;
  return new Promise(function (resolve) {
    if (!total) return resolve(0);
    var running = 0, finished = false;
    function finish() { if (!finished) { finished = true; probeTouched(); resolve(read); } }
    function settle(t, err, stdout) {
      try {
        // REDline exits with code 1 even when it worked: only what it printed counts.
        var r = t.red ? parseRedMeta(stdout) : (err ? null : parseProbe(stdout));
        if (r && (t.red || r.ok)) { cache[t.key] = r; read++; } else warmFailed[t.key] = 1;
      } catch (e) { warmFailed[t.key] = 1; }
      done++; running--;
      if (o.onProgress) { try { o.onProgress(done, total); } catch (e) {} }
      one();
    }
    function one() {
      var stop = false;
      try { stop = !!(o.cancelled && o.cancelled()); } catch (e) {}
      if (stop || next >= total) { if (!running) finish(); return; }
      var t = todo[next++];
      running++;
      try {
        childProcess.execFile(t.red ? o.redline : o.ffprobe, t.red ? ["--i", t.file, "--printMeta", "1"] : probeArgs(t.file),
          { encoding: "utf-8", timeout: t.red ? 60000 : 30000, maxBuffer: 8 * 1024 * 1024 },
          function (err, stdout) { settle(t, err, stdout); });
      } catch (e) { settle(t, e, ""); }
    }
    for (var i = 0; i < Math.min(o.concurrency || 6, total); i++) one();
  });
}

// "4 audio tracks (1ch x4 48000)", "2 audio tracks (2ch+1ch 48000)", "no audio".
function describeAudio(sig) {
  if (!sig.length) return "no audio";
  var rates = [], parts = [], i = 0;
  sig.forEach(function (s) { if (rates.indexOf(s[1]) === -1) rates.push(s[1]); });
  var same = sig.every(function (s) { return s[0] === sig[0][0]; });
  if (same && sig.length > 1) parts.push(sig[0][0] + "ch x" + sig.length);
  else for (; i < sig.length; i++) parts.push(sig[i][0] + "ch");
  var body = same && sig.length > 1 ? parts[0] : parts.join("+");
  return sig.length + " audio track" + (sig.length === 1 ? "" : "s") + " (" + body + " " +
    (rates.length === 1 ? rates[0] : sig.map(function (s) { return s[1]; }).join("/")) + ")";
}

// Is the proxy's audio the source's audio? (Lee, 14 Nov 2026: a proxy whose audio differs
// from the high-res file must never be attached - Premiere then refuses or mis-maps it on
// re-link.) o = { ffprobe, redline, mediaPath, proxyPath, fresh }
//   non-RED: the proxy's signature must equal the source's exactly (number of audio
//            streams, channels of each, sample rate of each, in order).
//   R3D:     the proxy must have one mono stream per "Camera Audio Channel" of the R3D,
//            as red-proxy-finish.sh writes. Older RED proxies (before 19 Oct 2026) have
//            one multichannel stream with the channels rotated by one (see
//            red-proxy-finish.sh): refused, see ACCEPT_OLD_RED_PROXIES.
// Returns { state: "ok" } | { state: "differs", reason } | { state: "unchecked", reason }.
// "unchecked" = the source or the proxy could not be read: never treated as ok.
//
// ACCEPT_OLD_RED_PROXIES: the one switch for the older RED proxies (one multichannel
// stream, right channel count, channels in the wrong order). false = refused and reported
// as "old RED proxy, channels in the wrong order, re-render needed", never attached.
// true = accepted when found on disk (a render that just finished must still be mono
// streams). PENY_TOOLKIT_ACCEPT_OLD_RED_PROXIES=1 or =0 overrides it, for tests.
var ACCEPT_OLD_RED_PROXIES = false;
function acceptOldRed() {
  var e = process.env.PENY_TOOLKIT_ACCEPT_OLD_RED_PROXIES;
  return e === "1" ? true : e === "0" ? false : ACCEPT_OLD_RED_PROXIES;
}
function audioCheck(o) {
  var px = probeMedia(o.ffprobe, o.proxyPath);
  if (!px.ok) return { state: "unchecked", reason: "audio could not be checked: proxy unreadable (" + px.error + ")" };
  if (!o.mediaPath) return { state: "unchecked", reason: "audio could not be checked: no source file" };
  if (/\.r3d$/i.test(o.mediaPath)) {
    var n = redAudioChannels(o.redline, o.mediaPath);
    if (n === null) return { state: "unchecked", reason: "audio could not be checked: REDline could not read the R3D's audio channels" };
    var total = 0;
    px.audio.forEach(function (s) { total += s[0]; });
    if (total !== n) return { state: "differs", reason: "audio check failed: proxy has " + total + " audio channel" + (total === 1 ? "" : "s") +
      " [" + describeAudio(px.audio) + "], the R3D " + n };
    if (px.audio.length !== n || px.audio.some(function (s) { return s[0] !== 1; })) {
      var old = px.audio.length === 1;   // the layout REDline writes and the Toolkit used to keep
      if (old && !o.fresh && acceptOldRed()) return { state: "ok", oldRed: true };
      return { state: "differs", oldRed: old, reason: old && !o.fresh
        ? "old RED proxy, channels in the wrong order, re-render needed (one " + n + "-channel track instead of " + n + " mono tracks)"
        : "audio check failed: proxy has " + describeAudio(px.audio) + ", expected " + n + " mono tracks for the R3D's " + n + " channels" };
    }
    return { state: "ok" };
  }
  var src = probeMedia(o.ffprobe, o.mediaPath);
  if (!src.ok) return { state: "unchecked", reason: "audio could not be checked: source unreadable (" + src.error + ")" };
  var same = src.audio.length === px.audio.length && src.audio.every(function (s, i) { return s[0] === px.audio[i][0] && s[1] === px.audio[i][1]; });
  if (!same) return { state: "differs", reason: "audio check failed: proxy has " + describeAudio(px.audio) + ", the source " + describeAudio(src.audio) };
  return { state: "ok" };
}

// A finished .mov can still be wrong: the Orbea Canonball proxies (issue 1) had a whole
// moov atom and every channel, but 9 fewer frames than their sources, and played with a
// dropped frame in Premiere. A proxy whose video frame count differs from the source must
// not be attached (these files go to remote editors).
// o = { ffprobe, redline, mediaPath, proxyPath }. The source's count is nb_frames, or for
// MXF the video stream's length in frames (probeMedia), or for R3D REDline's "Total
// Frames". Header reads only, no decoding.
// { state: "ok" } | { state: "differs", proxy, source, reason } | { state: "unchecked", reason }.
// "unchecked" = a count could not be read: never treated as ok (before 15 Nov 2026 R3D
// and MXF sources were not checked at all, so a short proxy of one passed).
function lengthCheck(o) {
  var px = probeMedia(o.ffprobe, o.proxyPath);
  if (!px.ok) return { state: "unchecked", reason: "length could not be checked: proxy unreadable (" + px.error + ")" };
  if (px.frames == null) return { state: "unchecked", reason: "length could not be checked: the proxy has no video frame count" };
  if (!o.mediaPath) return { state: "unchecked", reason: "length could not be checked: no source file" };
  var b;
  if (/\.r3d$/i.test(o.mediaPath)) {
    var m = redMeta(o.redline, o.mediaPath);
    if (!m || m.frames == null) return { state: "unchecked", reason: "length could not be checked: REDline could not read the R3D's frame count" };
    b = m.frames;
  } else {
    var src = probeMedia(o.ffprobe, o.mediaPath);
    if (!src.ok) return { state: "unchecked", reason: "length could not be checked: source unreadable (" + src.error + ")" };
    if (src.frames == null) return { state: "unchecked", reason: "length could not be checked: the source has no readable video frame count" };
    b = src.frames;
  }
  if (px.frames === b) return { state: "ok" };
  return { state: "differs", proxy: px.frames, source: b, reason: "frame check failed: the proxy has " + px.frames + " video frames, the source " + b +
    " - the render lost or duplicated frames and this proxy is broken; delete the file and re-render" };
}
// After a render, as a failure reason (or null). Only for jobs that name their source
// (mediaPath); a proxy whose length cannot be checked is a failed job too.
function frameCountMismatch(job) {
  if (!job.mediaPath) return null;
  var r = lengthCheck({ ffprobe: job.ffprobe, redline: job.redline, mediaPath: job.mediaPath, proxyPath: job.outputPath });
  return r.state === "ok" ? null : r.reason;
}
// After a render: the audio check above, as a failure reason (or null). Only for jobs that
// name their source (mediaPath); a proxy that cannot be checked is a failed job too.
function audioMismatch(job) {
  if (!job.mediaPath) return null;
  var r = audioCheck({ ffprobe: job.ffprobe, redline: job.redline, mediaPath: job.mediaPath, proxyPath: job.outputPath, fresh: true });
  return r.state === "ok" ? null : r.reason + (r.state === "differs" ? " - this proxy must not be used; the file is left in place, delete it by hand and re-render" : "");
}

/* new JobPool({ maxConcurrent, log, onChange })
 * pool.add({ key, cmd, outputPath, label })   key must be unique (outputPath is fine)
 * pool.start() / pause() / resume() / cancel()
 * pool.wait() -> Promise resolving with pool.summary() when nothing is left to run */
function JobPool(opts) {
  opts = opts || {};
  this.opts = {};
  for (var k in DEFAULTS) this.opts[k] = opts[k] !== undefined ? opts[k] : DEFAULTS[k];
  this.log = opts.log || function () {};
  this.onChange = opts.onChange || function () {};
  this.onProgress = opts.onProgress || function () {};
  this.lastTickAt = 0;
  this.queue = [];
  this.running = {};
  this.done = [];
  this.paused = false;
  this.cancelled = false;
  this.started = false;
  this.waiters = [];
  this.watchTimer = null;
  this.eta = null; // { finishAt, firstAt, firstSec } once estimated
}

JobPool.prototype.add = function (job) {
  job.state = "queued";
  this.queue.push(job);
};

JobPool.prototype.runningCount = function () { return Object.keys(this.running).length; };

JobPool.prototype.summary = function () {
  var s = { total: this.queue.length + this.runningCount() + this.done.length, queued: this.queue.length,
    running: this.runningCount(), ok: 0, failed: 0, killed: 0, notStarted: 0, cancelled: this.cancelled, paused: this.paused, jobs: [] };
  this.done.forEach(function (j) {
    if (j.state === "ok") s.ok++; else if (j.state === "killed") s.killed++; else if (j.state === "cancelled") s.notStarted++; else s.failed++;
    s.jobs.push({ label: j.label, outputPath: j.outputPath, state: j.state, reason: j.reason || null, seconds: j.seconds });
  });
  return s;
};

// Fraction (0..1) of the current job from a chunk of its output, or null. Lines can be
// split across chunks, so the tail of the last chunk is kept on the job.
function parseProgress(job, chunk) {
  var text = (job.outTail || "") + chunk, m, last = null, re;
  job.outTail = text.slice(-300);
  re = /Export Job frame complete\.\s+\d+\s+([\d.]+)/g; // REDline
  while ((m = re.exec(text))) last = parseFloat(m[1]);
  if (last !== null) return last;
  if (!job.durationSec && (m = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(text))) {
    job.durationSec = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
  }
  if (job.durationSec > 0) { // ffmpeg
    re = /time=\s*(\d+):(\d+):([\d.]+)/g;
    while ((m = re.exec(text))) last = ((+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3])) / job.durationSec;
  }
  return last;
}

JobPool.prototype.progress = function () {
  var s = this.summary(), self = this, partial = 0;
  Object.keys(this.running).forEach(function (k) { partial += Math.min(Math.max(self.running[k].progress || 0, 0), 0.99); });
  var finished = s.ok + s.failed + s.killed;
  var fraction = s.total ? Math.min((finished + partial) / s.total, 1) : 1;
  return { total: s.total, finished: finished, ok: s.ok, failed: s.failed + s.killed, running: s.running,
    queued: s.queued, notStarted: s.notStarted, cancelled: s.cancelled, paused: s.paused,
    fraction: fraction, percent: Math.floor(fraction * 1000) / 10, eta: this._estimate(s) };
};

// Render speed depends on how many jobs run at once: on the 12 Oct 2026 2-clip run the
// big clip sped up 1.65x when the other finished (2 at once -> alone). Each job's time per
// byte is taken to grow as (jobs at once)^ETA_SHARE; 0.55 replayed best across the 44-clip
// and 2-clip runs. Rates below are "solo" seconds per weight unit (as if the job ran
// alone); each job's average concurrency (j.cInt / run time) turns its measured rate into
// a solo one.
var ETA_SHARE = 0.55;
function share(c) { return Math.pow(Math.max(c, 1), ETA_SHARE); }

// Adds running-count x time to each running job since the last call (for its average
// concurrency). Called before every launch/exit and before each estimate.
JobPool.prototype._accrue = function (now) {
  var self = this, keys = Object.keys(this.running), c = keys.length;
  var dt = this._accruedAt ? (now - this._accruedAt) / 1000 : 0;
  if (dt > 0) keys.forEach(function (k) { var j = self.running[k]; j.cInt = (j.cInt || 0) + c * dt; });
  this._accruedAt = now;
};
function avgConc(j, sec) { return sec > 0 && j.cInt > 0 ? j.cInt / sec : 1; }

// Solo seconds per weight unit, per group (job.group: the camera, e.g. Komodo vs Nikon ZR
// R3D, 10 vs 5 s/GB on 12 Oct 2026) and per kind ("r3d"/"ffmpeg") as the fallback.
// Sources, newest counting most:
//  - finished ok jobs (real run time) and running jobs past 3% / 10 s (time so far over
//    the share done), each weighted by recency (half-life ETA_HALF_LIFE jobs), so the
//    slow first wave of a run (cold start: 11-14 s/GB against 8-9 later) fades out;
//    the first wave counts at ETA_FIRST_WAVE once later jobs or a saved rate exist;
//  - a prior counted as ETA_PRIOR_JOBS average-sized jobs: for a group, its saved rate
//    (opts.etaHistoryFile) or else its kind's rate; for a kind, its saved rate. So there
//    is an estimate from the start and the first few jobs do not throw it.
// A fixed ETA_OVERHEAD seconds per job (tool start-up) is taken off before dividing.
// Tuned by replaying the 12 Oct 2026 Komodo runs (44 clips cold and warm, 2 huge clips)
// and real renders of 28-30 Komodo/ZR/Canon clips.
var ETA_HALF_LIFE = 8, ETA_PRIOR_JOBS = 4, ETA_OVERHEAD = 1, ETA_FIRST_WAVE = 0.1;
function groupOf(j) { return j.group ? (j.kind || "job") + "|" + j.group : (j.kind || "job"); }
JobPool.prototype._rates = function (now) {
  var self = this, newest = 0, obs = [];
  this.done.forEach(function (j) {
    if (j.state === "ok" && j.exactSeconds > 0)
      obs.push({ k: j.kind || "job", g: groupOf(j), sec: Math.max(j.exactSeconds - ETA_OVERHEAD, 0.1) / share(avgConc(j, j.exactSeconds)), w: jobWeight(j), n: j.order || 0 });
  });
  Object.keys(this.running).forEach(function (k) {
    var j = self.running[k], el = (now - j.launchedAt) / 1000;
    if (j.progress >= 0.03 && el >= 10)
      obs.push({ k: j.kind || "job", g: groupOf(j), sec: Math.max(el - ETA_OVERHEAD, 0.1) / share(avgConc(j, el)), w: jobWeight(j) * j.progress, n: j.order || 0 });
  });
  var wave = this.opts.maxConcurrent, later = false, hist = this.etaHistory || {};
  var hasPrior = Object.keys(hist).length > 0;
  obs.forEach(function (o) { if (o.n > newest) newest = o.n; if (o.n >= wave) later = true; });
  var byKind = {}, byGroup = {};
  function add(map, key, sec, w) { var a = map[key] = map[key] || { sec: 0, w: 0 }; a.sec += sec; a.w += w; }
  obs.forEach(function (o) {
    var m = Math.pow(0.5, (newest - o.n) / ETA_HALF_LIFE) * ((later || hasPrior) && o.n < wave ? ETA_FIRST_WAVE : 1);
    add(byKind, o.k, m * o.sec, m * o.w);
    if (o.g !== o.k) add(byGroup, o.g, m * o.sec, m * o.w);
  });
  var avgW = this._avgWeight || {}, rates = {};
  function prior(map, key, r) { if (r > 0 && avgW[key] > 0) add(map, key, r * ETA_PRIOR_JOBS * avgW[key], ETA_PRIOR_JOBS * avgW[key]); }
  Object.keys(avgW).forEach(function (key) { if (key.indexOf("|") === -1) prior(byKind, key, hist[key]); });
  Object.keys(byKind).forEach(function (k) { if (byKind[k].w > 0) rates[k] = byKind[k].sec / byKind[k].w; });
  Object.keys(avgW).forEach(function (key) {
    if (key.indexOf("|") === -1) return;
    prior(byGroup, key, hist[key] > 0 ? hist[key] : rates[key.split("|")[0]]);
  });
  Object.keys(byGroup).forEach(function (g) { if (byGroup[g].w > 0) rates[g] = byGroup[g].sec / byGroup[g].w; });
  return rates;
};

function jobWeight(j) { return j.weight > 0 ? j.weight : 1; }

// Called once the queue is filled: numbers the jobs, the average weight per kind (for
// the saved-rate prior) and loads the saved rates.
JobPool.prototype._runStarted = function () {
  var sum = {}, cnt = {}, self = this;
  this.queue.forEach(function (j, i) {
    j.order = i;
    [j.kind || "job", groupOf(j)].forEach(function (k, x) {
      if (x && k === (j.kind || "job")) return;
      sum[k] = (sum[k] || 0) + jobWeight(j); cnt[k] = (cnt[k] || 0) + 1;
    });
  });
  this._avgWeight = {};
  Object.keys(sum).forEach(function (k) { self._avgWeight[k] = sum[k] / cnt[k]; });
  this.etaHistory = {};
  if (this.opts.etaHistoryFile) {
    try { var h = JSON.parse(fs.readFileSync(this.opts.etaHistoryFile, "utf-8")); if (h && h.rates) this.etaHistory = h.rates; } catch (e) {}
  }
};

// After a run: saves this run's steady rate per kind (recency-weighted, so mostly the
// later jobs) for the next run's first estimate.
JobPool.prototype._saveRates = function () {
  if (!this.opts.etaHistoryFile || this.cancelled) return;
  var save = this.etaHistory, had = false, self = this;
  this.etaHistory = {}; // this run's own jobs only
  var rates = this._rates(Date.now());
  this.etaHistory = save;
  var out = { rates: {}, updated: new Date().toISOString() };
  Object.keys(save || {}).forEach(function (k) { out.rates[k] = save[k]; });
  Object.keys(rates).forEach(function (k) {
    var n = self.done.filter(function (j) { return j.state === "ok" && (groupOf(j) === k || (j.kind || "job") === k); }).length;
    if (n >= 2) { out.rates[k] = rates[k]; had = true; }
  });
  if (!had) return;
  try {
    fs.mkdirSync(require("path").dirname(this.opts.etaHistoryFile), { recursive: true });
    fs.writeFileSync(this.opts.etaHistoryFile + ".tmp", JSON.stringify(out, null, 1));
    fs.renameSync(this.opts.etaHistoryFile + ".tmp", this.opts.etaHistoryFile);
  } catch (e) {}
};

// { state: "estimating"|"ok"|"paused"|"cancelled"|"done", seconds?, finishAt? }
JobPool.prototype._estimate = function (s) {
  if (s.cancelled) return { state: "cancelled" };
  if (!s.queued && !s.running) return { state: "done" };
  if (s.paused) return { state: "paused" };
  var now = Date.now(), self = this;
  this._accrue(now);
  var rates = this._rates(now);
  var missing = false, perJob = [], c0 = Math.max(Object.keys(this.running).length, 1);
  function solo(j, frac) { // solo seconds for frac of job j
    var r = rates[groupOf(j)];
    if (r === undefined) { missing = true; return 0; }
    return (ETA_OVERHEAD + jobWeight(j) * r) * frac;
  }
  // Each running job's remaining work in solo seconds: from the rate, blended with its
  // own pace (time so far / share done, at today's concurrency) as it gets further in.
  var active = [];
  Object.keys(this.running).forEach(function (k) {
    var j = self.running[k], f = Math.min(Math.max(j.progress || 0, 0), 0.99), el = (now - j.launchedAt) / 1000;
    var w = solo(j, 1 - f);
    if (f >= 0.03 && el >= 5) {
      var own = el * (1 - f) / f / share(avgConc(j, el)), b = Math.min(1, f / 0.3);
      w = rates[groupOf(j)] === undefined ? own : b * own + (1 - b) * w;
    } else if (!(j.progress > 0)) w = Math.max(w - el / share(c0), w * 0.1); // no progress output
    active.push({ j: j, work: w, f: f, el: el });
  });
  var queued = this.queue.map(function (j) { return { j: j, work: solo(j, 1) }; });
  // Plays the rest of the run forward: up to maxConcurrent at once, each moving at
  // 1/share(running) solo seconds per second; a finished job's lane takes the next one.
  var n = Math.max(this.opts.maxConcurrent, 1), t = 0, run = active.slice(), qi = 0, finish = {};
  while (run.length < n && qi < queued.length) run.push(queued[qi++]);
  var guard = 0;
  while (run.length && guard++ < 100000) {
    var sp = 1 / share(run.length), first = 0;
    for (var x = 1; x < run.length; x++) if (run[x].work < run[first].work) first = x;
    var dt = Math.max(run[first].work, 0) / sp;
    t += dt;
    run.forEach(function (r) { r.work -= dt * sp; });
    var left = [];
    run.forEach(function (r) { if (r.work <= 1e-9) finish[r.j.key] = t; else left.push(r); });
    run = left;
    while (run.length < n && qi < queued.length) run.push(queued[qi++]);
  }
  active.forEach(function (a) { perJob.push({ key: a.j.key, label: a.j.label, fraction: a.f, elapsed: Math.round(a.el), left: finish[a.j.key] || 0 }); });
  var raw = now + t * 1000;
  // Each running job's own time left, smoothed the same way as the total.
  var js = this.jobEta = this.jobEta || {};
  var jobsOut = perJob.map(function (r) {
    if (missing && !(r.fraction >= 0.03 && r.elapsed >= 5)) return { label: r.label, fraction: r.fraction, elapsed: r.elapsed, seconds: null };
    var at = now + r.left * 1000, e = js[r.key];
    if (!e) e = js[r.key] = { finishAt: at, at: now };
    else { var a = 1 - Math.exp(-(now - e.at) / 3000); e.finishAt += a * (at - e.finishAt); e.at = now; }
    return { label: r.label, fraction: r.fraction, elapsed: r.elapsed, seconds: Math.max(0, Math.round((e.finishAt - now) / 1000)) };
  });
  if (missing) return { state: "estimating", jobs: jobsOut };
  var e = this.eta;
  if (!e) {
    e = this.eta = { finishAt: raw, at: now, firstAt: now, firstSec: (raw - now) / 1000 };
  } else {
    var tau = Math.min(10000, Math.max(2000, (raw - now) / 10)); // short runs settle faster
    var a = 1 - Math.exp(-(now - e.at) / tau);
    e.finishAt += a * (raw - e.finishAt);
    e.at = now;
  }
  return { state: "ok", seconds: Math.max(0, Math.round((e.finishAt - now) / 1000)), finishAt: Math.round(e.finishAt),
    raw: Math.round((raw - now) / 1000), jobs: jobsOut };
};

JobPool.prototype._emitProgress = function (event) {
  var now = Date.now();
  if (event === "tick" && now - this.lastTickAt < 500) return;
  this.lastTickAt = now;
  var p = this.progress();
  p.event = event;
  try { this.onProgress(p); } catch (e) {}
};

JobPool.prototype.start = function () {
  if (this.started) return;
  this.started = true;
  this._runStarted();
  var self = this;
  this.watchTimer = setInterval(function () { self._watch(); }, this.opts.watchMs);
  this._fill();
};

JobPool.prototype.pause = function () { this.paused = true; this.log("Pool paused: no new jobs will start; running jobs carry on."); this.onChange(); this._emitProgress("paused"); };
JobPool.prototype.resume = function () { this.paused = false; this.log("Pool resumed."); this._fill(); this.onChange(); this._emitProgress("resumed"); };

JobPool.prototype.cancel = function () {
  this.cancelled = true;
  var self = this;
  this.queue.forEach(function (j) { j.state = "cancelled"; j.reason = "cancelled before start"; self.done.push(j); });
  this.queue = [];
  Object.keys(this.running).forEach(function (key) { self._kill(self.running[key], "cancelled"); });
  this.log("Pool cancelled.");
  this._emitProgress("cancelled");
  this._maybeFinish();
};

JobPool.prototype.wait = function () {
  var self = this;
  return new Promise(function (resolve) {
    self.waiters.push(resolve);
    self._maybeFinish();
  });
};

// opts.limits(): { total, perKind: { r3d: n } }, read each time a job could start (the
// Full / Half speed switch can change mid-run); without it, maxConcurrent of any kind.
JobPool.prototype._fill = function () {
  var lim = this.opts.limits ? this.opts.limits() : { total: this.opts.maxConcurrent }, self = this;
  this.opts.maxConcurrent = lim.total; // ETA plays the rest forward with this many at once
  var per = lim.perKind || {};
  function runningOf(kind) { return Object.keys(self.running).filter(function (k) { return (self.running[k].kind || "job") === kind; }).length; }
  for (var i = 0; !this.paused && !this.cancelled && i < this.queue.length && this.runningCount() < lim.total; ) {
    var kind = this.queue[i].kind || "job";
    if (per[kind] !== undefined && runningOf(kind) >= per[kind]) { i++; continue; }
    this._launch(this.queue.splice(i, 1)[0]);
  }
  this._maybeFinish();
};

JobPool.prototype._launch = function (job) {
  var self = this;
  var now = Date.now();
  this._accrue(now);
  job.state = "running";
  job.launchedAt = now;
  job.lastSizeCheckAt = now;
  job.lastSize = -1;
  this.running[job.key] = job;
  this.log("Start: " + job.label);
  job.child = childProcess.exec(job.cmd, { maxBuffer: this.opts.maxBuffer }, function (error, stdout, stderr) {
    self._accrue(Date.now());
    delete self.running[job.key];
    job.exactSeconds = (Date.now() - job.launchedAt) / 1000;
    job.seconds = Math.round(job.exactSeconds);
    if (job.killReason) {
      job.state = "killed";
      job.reason = job.killReason;
    } else if (error) {
      job.state = "failed";
      job.reason = (error.message || String(error)).split("\n")[0] +
        (stderr ? " | " + String(stderr).replace(/\s+/g, " ").slice(-600) : "");
    } else if (job.outputPath && !isCompleteMov(job.outputPath)) {
      job.state = "failed";
      job.reason = "process exited cleanly but the output has no moov atom (incomplete)";
    } else if (job.outputPath) {
      var mismatch = frameCountMismatch(job) || audioMismatch(job);
      if (mismatch) { job.state = "failed"; job.reason = mismatch; }
      else job.state = "ok";
    } else {
      job.state = "ok";
    }
    self.log((job.state === "ok" ? "Done: " : "FAILED: ") + job.label + " (" + job.seconds + " s)" +
      (job.reason ? " - " + job.reason : ""), job.state === "ok" ? "ok" : "err");
    self.done.push(job);
    self.onChange();
    self._emitProgress("job-done");
    self._fill();
  });
  job.progress = 0;
  [job.child.stdout, job.child.stderr].forEach(function (stream) {
    if (!stream) return;
    stream.on("data", function (chunk) {
      var f = parseProgress(job, String(chunk));
      if (f !== null && isFinite(f)) { job.progress = f; self._emitProgress("tick"); }
    });
  });
  this.onChange();
  this._emitProgress("job-start");
};

// Every process under pid, children before parents. A RED render is a shell chain
// (REDline, then red-proxy-finish.sh -> ffmpeg); an async "pkill -P" that ran after the
// shell was killed found nothing, and a hung REDline ran on as an orphan (20 Oct 2026).
function descendants(pid) {
  var out = [];
  try {
    childProcess.execSync("pgrep -P " + pid, { encoding: "utf-8" }).split("\n").forEach(function (s) {
      var c = parseInt(s, 10);
      if (c) out = out.concat(descendants(c), [c]);
    });
  } catch (e) {} // pgrep exits 1 when there are none
  return out;
}

JobPool.prototype._kill = function (job, reason) {
  job.killReason = reason;
  try {
    if (job.child && job.child.pid) descendants(job.child.pid).forEach(function (pid) { try { process.kill(pid, "SIGKILL"); } catch (e) {} });
    if (job.child) job.child.kill("SIGKILL");
  } catch (e) {
    this.log("Could not kill " + job.label + ": " + e.message, "err");
  }
};

JobPool.prototype._watch = function () {
  var now = Date.now(), self = this;
  Object.keys(this.running).forEach(function (key) {
    var job = self.running[key];
    if (now - job.launchedAt >= self.opts.timeoutMs) {
      self.log("Timeout, killing: " + job.label, "err");
      self._kill(job, "timed out after " + Math.round(self.opts.timeoutMs / 60000) + " min");
    } else if (job.outputPath && now - job.launchedAt >= self.opts.stallGraceMs && now - job.lastSizeCheckAt >= self.opts.stallCheckMs) {
      // A RED render writes job.partPath first (the final file only appears at the end).
      var size = fileSize(job.outputPath);
      if (job.partPath && !fs.existsSync(job.outputPath)) size = fileSize(job.partPath);
      if (job.lastSize !== -1 && size === job.lastSize) {
        self.log("Stalled (no output growth), killing: " + job.label + " at " + size + " bytes", "err");
        self._kill(job, "stalled: output stuck at " + size + " bytes");
      } else {
        job.lastSize = size;
        job.lastSizeCheckAt = now;
      }
    }
  });
};

JobPool.prototype._maybeFinish = function () {
  if (!this.started && !this.cancelled) return;
  if (this.runningCount() > 0) return;
  if (this.queue.length > 0 && !this.cancelled && !this.paused) return;
  if (this.queue.length > 0 && this.paused) return; // paused with work left: not finished
  if (this.watchTimer) { clearInterval(this.watchTimer); this.watchTimer = null; }
  if (!this.ratesSaved) { this.ratesSaved = true; this._saveRates(); }
  var waiters = this.waiters, s = this.summary();
  this.waiters = [];
  waiters.forEach(function (w) { w(s); });
};

module.exports = { JobPool: JobPool, isCompleteMov: isCompleteMov, fileSize: fileSize, parseProgress: parseProgress,
  probeMedia: probeMedia, warmProbes: warmProbes, redAudioChannels: redAudioChannels, redMeta: redMeta, audioCheck: audioCheck, lengthCheck: lengthCheck, describeAudio: describeAudio,
  saveProbeCache: saveProbeCache, PROBE_CACHE_FILE: PROBE_CACHE_FILE };
