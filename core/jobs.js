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

// A finished .mov can still be wrong: the Orbea Canonball proxies (issue 1) had a whole
// moov atom and every channel, but 9 fewer frames than their sources, and played with a
// dropped frame in Premiere. A proxy whose video frame count differs from the source must
// not be attached (these files go to remote editors). Compares the nb_frames each
// container recorded (header read only, no decoding, ~instant).
// null = cannot be checked (no ffprobe, or nb_frames missing, e.g. R3D/MXF);
// string = a reason the output must not be used.
function frameCountMismatch(job) {
  if (!job.ffprobe || !job.mediaPath) return null;
  function frames(p) {
    try {
      var out = childProcess.execFileSync(job.ffprobe,
        ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=nb_frames", "-of", "csv=p=0", p],
        { encoding: "utf-8", timeout: 30000 });
      var n = parseInt(String(out).split("\n")[0], 10);
      return isFinite(n) && n > 0 ? n : null;
    } catch (e) { return null; }
  }
  var a = frames(job.outputPath), b = frames(job.mediaPath);
  if (a === null || b === null) return null;
  if (a === b) return null;
  return "frame check failed: the proxy has " + a + " video frames, the source " + b +
    " - the render lost or duplicated frames and this proxy is broken; delete the file and re-render";
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
      var mismatch = frameCountMismatch(job);
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

module.exports = { JobPool: JobPool, isCompleteMov: isCompleteMov, fileSize: fileSize, parseProgress: parseProgress };
