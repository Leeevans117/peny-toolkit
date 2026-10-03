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
 *  - kill = pkill -P <shell pid> then SIGKILL the shell; killing the shell alone can
 *    orphan ffmpeg/REDline.
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
 * measured per kind from the jobs' own run times (finished jobs, plus running ones past
 * 10% of their render), so it already includes the slow-down of 4 renders at once and is
 * not thrown by pauses. The remaining jobs are then laid out on maxConcurrent lanes, so
 * the tail (fewer than 4 left) is counted right. "Estimating" until a job has finished,
 * or while a kind still to render has no measurement. The finish time is smoothed
 * (15 s time constant, less near the end) so the number does not jump about.
 */

var childProcess = require("child_process");
var fs = require("fs");

var DEFAULTS = {
  maxConcurrent: 4,
  maxBuffer: 200 * 1024 * 1024,
  timeoutMs: 4 * 60 * 60 * 1000,
  stallGraceMs: 5 * 60 * 1000,
  stallCheckMs: 10 * 60 * 1000,
  watchMs: 5000
};

// A missing file counts as 0 bytes, as in the original panel, so a job that never
// writes anything is still caught as stalled.
function fileSize(p) {
  try { return fs.statSync(p).size; } catch (e) { return 0; }
}

// A finished .mov has a 'moov' atom; ffmpeg/REDline write it last (no +faststart), so
// a render cut short lacks it. Reads only the last 2 MB.
function isCompleteMov(p) {
  var TAIL = 2 * 1024 * 1024;
  try {
    var size = fs.statSync(p).size;
    if (size < 4096) return false;
    var start = size > TAIL ? size - TAIL : 0;
    var buf = Buffer.alloc(size - start);
    var fd = fs.openSync(p, "r");
    try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
    return buf.indexOf("moov") !== -1;
  } catch (e) {
    return false;
  }
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

// Seconds per weight unit for each kind, from finished ok jobs and running jobs past 10%.
JobPool.prototype._rates = function (now) {
  var acc = {}, self = this;
  function add(kind, sec, w) { var a = acc[kind] = acc[kind] || { sec: 0, w: 0 }; a.sec += sec; a.w += w; }
  this.done.forEach(function (j) { if (j.state === "ok" && j.exactSeconds > 0) add(j.kind || "job", j.exactSeconds, jobWeight(j)); });
  Object.keys(this.running).forEach(function (k) {
    var j = self.running[k];
    if (j.progress >= 0.1) add(j.kind || "job", (now - j.launchedAt) / 1000, jobWeight(j) * j.progress);
  });
  var rates = {};
  Object.keys(acc).forEach(function (k) { if (acc[k].w > 0) rates[k] = acc[k].sec / acc[k].w; });
  return rates;
};

function jobWeight(j) { return j.weight > 0 ? j.weight : 1; }

// { state: "estimating"|"ok"|"paused"|"cancelled"|"done", seconds?, finishAt? }
JobPool.prototype._estimate = function (s) {
  if (s.cancelled) return { state: "cancelled" };
  if (!s.queued && !s.running) return { state: "done" };
  if (s.paused) return { state: "paused" };
  var now = Date.now(), self = this, rates = this._rates(now);
  if (!this.done.some(function (j) { return j.state === "ok"; })) return { state: "estimating" };
  var lanes = [], missing = false;
  function cost(j, frac) {
    var r = rates[j.kind || "job"];
    if (r === undefined) { missing = true; return 0; }
    return jobWeight(j) * frac * r;
  }
  Object.keys(this.running).forEach(function (k) {
    var j = self.running[k], f = Math.min(Math.max(j.progress || 0, 0), 0.99);
    var left = cost(j, 1 - f);
    // No progress output: its run so far counts, never below 0.
    if (!(j.progress > 0)) left = Math.max(left - (now - j.launchedAt) / 1000, left * 0.1);
    lanes.push(left);
  });
  var n = Math.max(this.opts.maxConcurrent, 1);
  while (lanes.length < n) lanes.push(0);
  this.queue.forEach(function (j) {
    var i = 0;
    for (var x = 1; x < lanes.length; x++) if (lanes[x] < lanes[i]) i = x;
    lanes[i] += cost(j, 1);
  });
  if (missing) return { state: "estimating" };
  var raw = now + Math.max.apply(null, lanes) * 1000;
  var e = this.eta;
  if (!e) {
    e = this.eta = { finishAt: raw, at: now, firstAt: now, firstSec: (raw - now) / 1000 };
  } else {
    var tau = Math.min(15000, Math.max(3000, (raw - now) / 4)); // short runs settle faster
    var a = 1 - Math.exp(-(now - e.at) / tau);
    e.finishAt += a * (raw - e.finishAt);
    e.at = now;
  }
  return { state: "ok", seconds: Math.max(0, Math.round((e.finishAt - now) / 1000)), finishAt: Math.round(e.finishAt),
    raw: Math.round((raw - now) / 1000) };
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

JobPool.prototype._fill = function () {
  while (!this.paused && !this.cancelled && this.queue.length && this.runningCount() < this.opts.maxConcurrent) {
    this._launch(this.queue.shift());
  }
  this._maybeFinish();
};

JobPool.prototype._launch = function (job) {
  var self = this;
  var now = Date.now();
  job.state = "running";
  job.launchedAt = now;
  job.lastSizeCheckAt = now;
  job.lastSize = -1;
  this.running[job.key] = job;
  this.log("Start: " + job.label);
  job.child = childProcess.exec(job.cmd, { maxBuffer: this.opts.maxBuffer }, function (error, stdout, stderr) {
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

JobPool.prototype._kill = function (job, reason) {
  job.killReason = reason;
  try {
    if (job.child && job.child.pid) childProcess.exec("pkill -P " + job.child.pid);
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
      var size = fileSize(job.outputPath);
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
  var waiters = this.waiters, s = this.summary();
  this.waiters = [];
  waiters.forEach(function (w) { w(s); });
};

module.exports = { JobPool: JobPool, isCompleteMov: isCompleteMov, fileSize: fileSize, parseProgress: parseProgress };
