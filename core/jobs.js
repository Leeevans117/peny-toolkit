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
  this.queue = [];
  this.running = {};
  this.done = [];
  this.paused = false;
  this.cancelled = false;
  this.started = false;
  this.waiters = [];
  this.watchTimer = null;
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

JobPool.prototype.start = function () {
  if (this.started) return;
  this.started = true;
  var self = this;
  this.watchTimer = setInterval(function () { self._watch(); }, this.opts.watchMs);
  this._fill();
};

JobPool.prototype.pause = function () { this.paused = true; this.log("Pool paused: no new jobs will start; running jobs carry on."); this.onChange(); };
JobPool.prototype.resume = function () { this.paused = false; this.log("Pool resumed."); this._fill(); this.onChange(); };

JobPool.prototype.cancel = function () {
  this.cancelled = true;
  var self = this;
  this.queue.forEach(function (j) { j.state = "cancelled"; j.reason = "cancelled before start"; self.done.push(j); });
  this.queue = [];
  Object.keys(this.running).forEach(function (key) { self._kill(self.running[key], "cancelled"); });
  this.log("Pool cancelled.");
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
    job.seconds = Math.round((Date.now() - job.launchedAt) / 1000);
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
    self._fill();
  });
  this.onChange();
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

module.exports = { JobPool: JobPool, isCompleteMov: isCompleteMov, fileSize: fileSize };
