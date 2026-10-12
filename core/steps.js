/* Peny Toolkit: progress bar and time left for a skill that runs in a few known steps
 * whose own progress cannot be read (Premiere import, a Python pass...).
 *
 *   var task = new StepTask({ id: "colour-apply", title: "Colour", steps: [
 *     { id: "scan", label: "Reading the sequence" }, ...], size: 784, onProgress: api.progress });
 *   task.step("scan"); ... task.step("export"); ... task.done(true);
 *
 * Each step is expected to take a + b x size seconds (size = clips, files...). a and b
 * start from opts.defaults and are learned from earlier runs (opts.historyFile), so the
 * time left is right from the start. While a step runs, the bar moves on by its expected
 * time (never past 95% of the step); once steps finish, the rest are scaled by how far
 * the finished ones ran over or under. Ticks every second; the result has the same
 * shape as JobPool.progress() so the panel draws it the same way (unit "steps", one
 * entry in eta.jobs for the step running).
 */
var fs = require("fs");
var path = require("path");

function StepTask(opts) {
  this.opts = opts;
  this.steps = opts.steps.map(function (s) { return { id: s.id, label: s.label }; });
  this.size = Math.max(opts.size || 1, 1);
  this.onProgress = opts.onProgress || function () {};
  var hist = {};
  try { if (opts.historyFile) hist = JSON.parse(fs.readFileSync(opts.historyFile, "utf-8")).steps || {}; } catch (e) {}
  var defaults = opts.defaults || {}, size = this.size;
  this.steps.forEach(function (s) {
    var h = hist[s.id] || defaults[s.id] || { a: 2, b: 0 };
    s.a = h.a || 0; s.b = h.b || 0;
    s.expected = Math.max(s.a + s.b * size, 0.5);
  });
  this.current = -1;
  this.startedAt = Date.now();
  this.finished = false;
  this.timer = null;
  this.finishAt = null;
}

StepTask.prototype.step = function (id) {
  var now = Date.now(), i = -1;
  for (var x = 0; x < this.steps.length; x++) if (this.steps[x].id === id) i = x;
  if (i === -1) return;
  if (this.current >= 0) { var c = this.steps[this.current]; c.actual = (now - c.at) / 1000; }
  // Steps skipped over count as taking no time.
  for (var y = this.current + 1; y < i; y++) this.steps[y].actual = 0;
  this.current = i;
  this.steps[i].at = now;
  var self = this;
  if (!this.timer) this.timer = setInterval(function () { self._emit("tick"); }, 1000);
  this._emit("job-start");
};

StepTask.prototype.done = function (ok) {
  if (this.finished) return;
  var now = Date.now();
  if (this.current >= 0) { var c = this.steps[this.current]; c.actual = (now - c.at) / 1000; }
  this.finished = true;
  this.failed = !ok;
  if (this.timer) { clearInterval(this.timer); this.timer = null; }
  if (ok) this._save();
  this._emit("finished");
};

StepTask.prototype._state = function () {
  var now = Date.now(), done = 0, exp = 0, act = 0, self = this;
  this.steps.forEach(function (s, i) { if (i < self.current || (self.finished && i <= self.current)) { done += s.expected; act += s.actual || 0; exp += s.expected; } });
  // How far the finished steps ran over/under, counted in as more of the run is done.
  var total = this.steps.reduce(function (a, s) { return a + s.expected; }, 0);
  var k = exp > 0 ? Math.min(Math.max(act / exp, 0.4), 3) : 1, w = Math.min(exp / total, 1);
  var scale = 1 + (k - 1) * Math.max(w, 0.5);
  var cur = this.steps[this.current], curLeft = 0, curFrac = 0;
  if (cur && !this.finished) {
    var el = (now - cur.at) / 1000, want = cur.expected * scale;
    curFrac = Math.min(el / want, 0.95);
    curLeft = Math.max(want - el, Math.min(5, want * 0.1)); // overrunning: "a few seconds" until it ends
  }
  var rest = 0;
  for (var i = this.current + 1; i < this.steps.length; i++) rest += this.steps[i].expected * scale;
  var fracDone = this.finished ? 1 : (done + (cur ? cur.expected * curFrac : 0)) / total;
  return { left: this.finished ? 0 : curLeft + rest, frac: Math.min(fracDone, this.finished ? 1 : 0.99), curFrac: curFrac, curLeft: curLeft };
};

StepTask.prototype._emit = function (event) {
  var now = Date.now(), st = this._state(), n = this.steps.length;
  var raw = now + st.left * 1000;
  if (this.finishAt === null) this.finishAt = raw;
  else this.finishAt += (1 - Math.exp(-1 / 3)) * (raw - this.finishAt); // ~3 s smoothing
  var finishedSteps = this.finished ? n : Math.max(this.current, 0);
  var cur = this.steps[this.current];
  var p = { unit: "steps", title: this.opts.title, total: n, finished: finishedSteps, ok: finishedSteps,
    failed: this.failed ? 1 : 0, running: this.finished ? 0 : 1, queued: this.finished ? 0 : n - finishedSteps - 1,
    cancelled: false, paused: false, fraction: st.frac, percent: Math.floor(st.frac * 1000) / 10, event: event,
    eta: this.finished ? { state: "done" } : { state: "ok", seconds: Math.max(0, Math.round((this.finishAt - now) / 1000)),
      finishAt: Math.round(this.finishAt), raw: Math.round(st.left),
      jobs: cur ? [{ label: cur.label, fraction: st.curFrac, elapsed: Math.round((now - cur.at) / 1000), seconds: Math.round(st.curLeft) }] : [] } };
  try { this.onProgress(p); } catch (e) {}
};

// Learns a + b x size per step: keeps a, moves b halfway towards this run's value.
StepTask.prototype._save = function () {
  if (!this.opts.historyFile) return;
  var out = { steps: {}, updated: new Date().toISOString() }, size = this.size;
  try { out.steps = JSON.parse(fs.readFileSync(this.opts.historyFile, "utf-8")).steps || {}; } catch (e) {}
  this.steps.forEach(function (s) {
    if (!(s.actual > 0)) return;
    var b = Math.max(s.actual - s.a, 0) / size;
    out.steps[s.id] = { a: s.a, b: s.b > 0 ? s.b + 0.5 * (b - s.b) : b };
  });
  try {
    fs.mkdirSync(path.dirname(this.opts.historyFile), { recursive: true });
    fs.writeFileSync(this.opts.historyFile + ".tmp", JSON.stringify(out, null, 1));
    fs.renameSync(this.opts.historyFile + ".tmp", this.opts.historyFile);
  } catch (e) {}
};

module.exports = { StepTask: StepTask };
