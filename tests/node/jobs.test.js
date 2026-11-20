// core/jobs.js: the job pool behind Proxies and Ingest + Proxies.
var test = require("node:test"), assert = require("node:assert/strict");
var fs = require("fs"), path = require("path"), cp = require("child_process");
var H = require("./helpers");
var jobs = require(path.join(H.ROOT, "core", "jobs.js"));

function pool(o) { o = o || {}; o.watchMs = o.watchMs || 30; return new jobs.JobPool(o); }
// Running and not a zombie (a killed child whose parent has gone can stay a zombie until
// init reaps it; that process is dead).
function alive(pid) {
  try { process.kill(pid, 0); } catch (e) { return false; }
  try { return !/^Z/.test(cp.execSync("ps -o stat= -p " + pid, { encoding: "utf-8" }).trim()); } catch (e) { return false; }
}
var HAVE_FFMPEG = (function () { try { cp.execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch (e) { return false; } }());

// ---- isCompleteMov ----
test("isCompleteMov: whole moov after a big mdat is complete", function () {
  var d = H.tmpdir("mov"), f = H.writeAtoms(path.join(d, "ok clip.mov"), [["ftyp", 12], ["mdat", 200000], ["moov", 5000]]);
  assert.equal(jobs.isCompleteMov(f), true);
});
test("isCompleteMov: render cut short (no moov) is incomplete", function () {
  var d = H.tmpdir("mov"), f = H.writeAtoms(path.join(d, "cut.mov"), [["ftyp", 12], ["mdat", 200000]]);
  assert.equal(jobs.isCompleteMov(f), false);
});
test("isCompleteMov: moov whose length runs past the end of the file is incomplete", function () {
  var d = H.tmpdir("mov"), f = path.join(d, "trunc.mov");
  H.writeAtoms(f, [["ftyp", 12], ["mdat", 8000], ["moov", 5000]]);
  fs.truncateSync(f, fs.statSync(f).size - 100);
  assert.equal(jobs.isCompleteMov(f), false);
});
test("isCompleteMov: 64-bit atom sizes and size-0 (to end of file) atoms are read", function () {
  var d = H.tmpdir("mov"), f = path.join(d, "big.mov");
  var ftyp = Buffer.alloc(20); ftyp.writeUInt32BE(20, 0); ftyp.write("ftyp", 4);
  var mdat = Buffer.alloc(16 + 9000); mdat.writeUInt32BE(1, 0); mdat.write("mdat", 4); mdat.writeBigUInt64BE(BigInt(16 + 9000), 8);
  var moov = Buffer.alloc(100); moov.writeUInt32BE(0, 0); moov.write("moov", 4);
  fs.writeFileSync(f, Buffer.concat([ftyp, mdat, moov]));
  assert.equal(jobs.isCompleteMov(f), true);
});
test("isCompleteMov: missing file, tiny file, garbage, folder", function () {
  var d = H.tmpdir("mov");
  assert.equal(jobs.isCompleteMov(path.join(d, "nope.mov")), false);
  fs.writeFileSync(path.join(d, "tiny.mov"), "moov");
  assert.equal(jobs.isCompleteMov(path.join(d, "tiny.mov")), false);
  fs.writeFileSync(path.join(d, "junk.mov"), Buffer.alloc(10000, 0xff));
  assert.equal(jobs.isCompleteMov(path.join(d, "junk.mov")), false);
  fs.writeFileSync(path.join(d, "zeros.mov"), Buffer.alloc(10000, 0)); // atom length 0 = rest of file, type "\0\0\0\0"
  assert.equal(jobs.isCompleteMov(path.join(d, "zeros.mov")), false);
  assert.equal(jobs.isCompleteMov(d), false);
  assert.equal(jobs.isCompleteMov(null), false);
});
test("isCompleteMov: a real ffmpeg .mov is complete, the same file cut in half is not", { skip: !HAVE_FFMPEG && "no ffmpeg" }, function () {
  var d = H.tmpdir("mov"), f = path.join(d, "real clip.mov");
  cp.execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=25:duration=2", "-c:v", "mjpeg", f]);
  assert.equal(jobs.isCompleteMov(f), true);
  fs.truncateSync(f, Math.floor(fs.statSync(f).size / 2));
  assert.equal(jobs.isCompleteMov(f), false);
});

// ---- fileSize ----
test("fileSize: real size, 0 for a missing file", function () {
  var d = H.tmpdir("fs"); fs.writeFileSync(path.join(d, "a b"), "12345");
  assert.equal(jobs.fileSize(path.join(d, "a b")), 5);
  assert.equal(jobs.fileSize(path.join(d, "missing")), 0);
});

// ---- parseProgress ----
test("parseProgress: REDline frame lines, split across chunks", function () {
  var j = {};
  assert.equal(jobs.parseProgress(j, "Export Job frame complete. 10 0.1"), 0.1);
  assert.equal(jobs.parseProgress(j, "\nExport Job frame comp"), 0.1); // tail kept, last full value is still 0.1
  assert.equal(jobs.parseProgress(j, "lete. 50 0.5\n"), 0.5);
});
test("parseProgress: ffmpeg Duration then time=", function () {
  var j = {};
  assert.equal(jobs.parseProgress(j, "  Duration: 00:01:40.00, start: 0"), null);
  assert.equal(j.durationSec, 100);
  assert.equal(jobs.parseProgress(j, "frame=  250 fps=50 time=00:00:25.00 bitrate"), 0.25);
  assert.equal(jobs.parseProgress(j, "time=00:01:15.00 time=00:01:30.00"), 0.9);
});
test("parseProgress: garbage, empty and unicode give null", function () {
  var j = {};
  assert.equal(jobs.parseProgress(j, ""), null);
  assert.equal(jobs.parseProgress(j, "🎬 nothing useful here ünïcode"), null);
  assert.equal(jobs.parseProgress(j, "time=00:00:10.00"), null, "no Duration yet: no fraction");
  assert.equal(jobs.parseProgress({}, "Duration: 00:00:00.00\ntime=00:00:01.00"), null, "zero duration must not divide by zero");
});
test("parseProgress: tail kept short on huge chunks", function () {
  var j = {};
  jobs.parseProgress(j, "x".repeat(5 * 1024 * 1024));
  assert.ok(j.outTail.length <= 300);
});

// ---- the pool ----
test("pool: runs every job, counts ok and failed, reports stderr of a failure", async function () {
  var p = pool({ maxConcurrent: 2 }), events = [];
  p.onProgress = function (e) { events.push(e.event); };
  p.add({ key: "a", cmd: "true", label: "A" });
  p.add({ key: "b", cmd: "echo broken >&2; exit 3", label: "B" });
  p.add({ key: "c", cmd: "printf done", label: "C" });
  p.start();
  var s = await p.wait();
  assert.equal(s.total, 3); assert.equal(s.ok, 2); assert.equal(s.failed, 1);
  var b = s.jobs.filter(function (j) { return j.label === "B"; })[0];
  assert.equal(b.state, "failed"); assert.match(b.reason, /broken/);
  assert.ok(events.indexOf("job-start") >= 0 && events.indexOf("job-done") >= 0);
  var pr = p.progress(); assert.equal(pr.fraction, 1); assert.equal(pr.eta.state, "done");
});
test("pool: never runs more than maxConcurrent at once", async function () {
  var p = pool({ maxConcurrent: 3 }), max = 0;
  for (var i = 0; i < 10; i++) p.add({ key: "k" + i, cmd: "sleep 0.15", label: "j" + i });
  var t = setInterval(function () { max = Math.max(max, p.runningCount()); }, 10);
  p.start(); var s = await p.wait(); clearInterval(t);
  assert.equal(s.ok, 10); assert.ok(max <= 3 && max >= 2, "max at once " + max);
});
test("pool: an empty pool finishes at once", async function () {
  var p = pool(); p.start(); var s = await p.wait(); assert.equal(s.total, 0);
});
test("pool: start twice does not run jobs twice", async function () {
  var d = H.tmpdir("twice"), f = path.join(d, "count");
  var p = pool(); p.add({ key: "a", cmd: "echo x >> '" + f + "'", label: "a" });
  p.start(); p.start(); await p.wait();
  assert.equal(fs.readFileSync(f, "utf-8"), "x\n");
});
test("pool: output that exited cleanly but has no moov is a failure", async function () {
  var d = H.tmpdir("nomoov"), out = path.join(d, "Proxy ü.mov");
  var p = pool(); p.add({ key: out, cmd: "head -c 10000 /dev/zero > '" + out + "'", outputPath: out, label: "x" });
  p.start(); var s = await p.wait();
  assert.equal(s.failed, 1); assert.match(s.jobs[0].reason, /no moov atom/);
});
test("pool: frame-count check fails a proxy with fewer frames than its source", { skip: !HAVE_FFMPEG && "no ffmpeg" }, async function () {
  var d = H.tmpdir("frames"), src = path.join(d, "src clip.mov"), out = path.join(d, "src clip_Proxy.mov");
  cp.execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=25:duration=2", "-c:v", "mjpeg", src]);
  var cmd = "ffmpeg -v error -y -i '" + src + "' -frames:v 40 -c:v mjpeg '" + out + "'";
  var p = pool(); p.add({ key: out, cmd: cmd, outputPath: out, mediaPath: src, ffprobe: "ffprobe", label: "x" });
  p.start(); var s = await p.wait();
  assert.equal(s.failed, 1); assert.match(s.jobs[0].reason, /40 video frames, the source 50/);
  // And a whole-length proxy passes.
  fs.unlinkSync(out);
  var p2 = pool(); p2.add({ key: out, cmd: cmd.replace("-frames:v 40 ", ""), outputPath: out, mediaPath: src, ffprobe: "ffprobe", label: "y" });
  p2.start(); var s2 = await p2.wait(); assert.equal(s2.ok, 1, JSON.stringify(s2.jobs));
});
test("pool: over 1 MB of tool output does not kill the job (maxBuffer)", async function () {
  var p = pool(); p.add({ key: "a", cmd: "head -c 3000000 /dev/zero | tr '\\0' 'x'", label: "loud" });
  p.start(); var s = await p.wait(); assert.equal(s.ok, 1, JSON.stringify(s.jobs));
});
test("pool: pause stops new jobs, wait stays open while paused, resume finishes", async function () {
  var p = pool({ maxConcurrent: 1 }), resolved = false;
  for (var i = 0; i < 3; i++) p.add({ key: "k" + i, cmd: "sleep 0.1", label: "j" + i });
  p.start(); p.pause();
  p.wait().then(function () { resolved = true; });
  await H.sleep(400);
  assert.equal(resolved, false); assert.equal(p.summary().ok, 1); assert.equal(p.queue.length, 2);
  assert.equal(p.progress().eta.state, "paused");
  p.resume(); await p.wait();
  assert.equal(p.summary().ok, 3);
});
test("pool: cancel kills running jobs and their children, marks queued as not started", async function () {
  var d = H.tmpdir("cancel"), pidf = path.join(d, "child.pid");
  var p = pool({ maxConcurrent: 1 });
  p.add({ key: "a", cmd: "sleep 30 & echo $! > '" + pidf + "'; wait", label: "long" });
  p.add({ key: "b", cmd: "true", label: "never" });
  p.start();
  for (var i = 0; i < 50 && !fs.existsSync(pidf); i++) await H.sleep(20);
  var child = parseInt(fs.readFileSync(pidf, "utf-8"), 10);
  assert.ok(alive(child));
  var t0 = Date.now(); p.cancel(); var s = await p.wait();
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(s.killed, 1); assert.equal(s.notStarted, 1); assert.equal(s.cancelled, true);
  await H.sleep(100);
  assert.equal(alive(child), false, "grandchild sleep must be killed, not orphaned");
  assert.equal(p.progress().eta.state, "cancelled");
});
test("pool: timeout kills a job that runs too long", async function () {
  var p = pool({ timeoutMs: 300 }); p.add({ key: "a", cmd: "sleep 20", label: "slow" });
  p.start(); var s = await p.wait();
  assert.equal(s.killed, 1); assert.match(s.jobs[0].reason, /timed out/);
});
test("pool: stall check kills a job whose output stopped growing, spares one that grows", async function () {
  var d = H.tmpdir("stall"), stuck = path.join(d, "stuck.mov"), grow = path.join(d, "grow.mov");
  var p = pool({ stallGraceMs: 0, stallCheckMs: 150, timeoutMs: 5000 });
  p.add({ key: stuck, cmd: "echo hi > '" + stuck + "'; sleep 20", outputPath: stuck, label: "stuck" });
  p.add({ key: grow, cmd: "for i in 1 2 3 4 5 6 7 8 9 10; do echo $i >> '" + grow + "'; sleep 0.1; done", outputPath: grow, label: "grow" });
  p.start(); var s = await p.wait();
  var st = {}; s.jobs.forEach(function (j) { st[j.label] = j; });
  assert.equal(st.stuck.state, "killed"); assert.match(st.stuck.reason, /stalled/);
  assert.notEqual(st.grow.state, "killed", "a growing output must not be called stalled");
});
test("pool: Full/Half limits are read every time a job could start", async function () {
  var mode = "half", maxR = 0;
  var p = pool({ limits: function () { return mode === "half" ? { total: 2, perKind: { r3d: 1 } } : { total: 4 }; } });
  for (var i = 0; i < 4; i++) p.add({ key: "r" + i, cmd: "sleep 0.15", kind: "r3d", label: "r" + i });
  var t = setInterval(function () {
    var r = 0; Object.keys(p.running).forEach(function (k) { if (p.running[k].kind === "r3d") r++; });
    maxR = Math.max(maxR, r);
  }, 10);
  p.start(); await p.wait(); clearInterval(t);
  assert.equal(maxR, 1);
});
test("pool: a limit of 0 must not leave the run hanging for ever", async function () {
  var p = pool({ limits: function () { return { total: 2, perKind: { r3d: 0 } }; } });
  p.add({ key: "a", cmd: "true", kind: "r3d", label: "a" });
  p.start();
  var r = await Promise.race([p.wait(), H.sleep(1500).then(function () { return "hung"; })]);
  assert.notEqual(r, "hung", "wait() never resolved");
});
test("pool: two jobs with the same key are refused, not silently lost", function () {
  var p = pool(); p.add({ key: "same", cmd: "true", label: "1" });
  assert.throws(function () { p.add({ key: "same", cmd: "true", label: "2" }); }, /same key/);
});
test("pool: ETA learns a rate, saves it, and a corrupt history file is ignored", async function () {
  var d = H.tmpdir("eta"), hist = path.join(d, "sub dir", "eta.json");
  var p = pool({ maxConcurrent: 2, etaHistoryFile: hist });
  for (var i = 0; i < 4; i++) p.add({ key: "k" + i, cmd: "sleep 0.1", kind: "ffmpeg", weight: 1 + i, label: "j" + i });
  p.start();
  assert.equal(p.progress().eta.state, "estimating", "no saved rate and nothing measured yet");
  await p.wait();
  var saved = JSON.parse(fs.readFileSync(hist, "utf-8"));
  assert.ok(saved.rates.ffmpeg > 0, JSON.stringify(saved));
  // Next run starts with an estimate straight away.
  var p2 = pool({ maxConcurrent: 2, etaHistoryFile: hist });
  p2.add({ key: "x", cmd: "sleep 0.2", kind: "ffmpeg", weight: 2, label: "x" });
  p2.start();
  var e = p2.progress().eta; assert.equal(e.state, "ok"); assert.ok(e.seconds >= 0);
  await p2.wait();
  fs.writeFileSync(hist, "{not json");
  var p3 = pool({ etaHistoryFile: hist }); p3.add({ key: "y", cmd: "true", kind: "ffmpeg", label: "y" });
  p3.start(); var s3 = await p3.wait(); assert.equal(s3.ok, 1);
});
test("pool: a cancelled run does not overwrite the saved rates", async function () {
  var d = H.tmpdir("eta2"), hist = path.join(d, "eta.json");
  fs.writeFileSync(hist, JSON.stringify({ rates: { ffmpeg: 123 } }));
  var p = pool({ etaHistoryFile: hist });
  p.add({ key: "a", cmd: "sleep 5", kind: "ffmpeg", label: "a" }); p.start(); p.cancel(); await p.wait();
  assert.equal(JSON.parse(fs.readFileSync(hist, "utf-8")).rates.ffmpeg, 123);
});
test("pool: onProgress or log throwing does not break the run", async function () {
  var p = new jobs.JobPool({ watchMs: 30, onProgress: function () { throw new Error("ui gone"); } });
  p.add({ key: "a", cmd: "true", label: "a" }); p.start();
  var s = await p.wait(); assert.equal(s.ok, 1);
});
