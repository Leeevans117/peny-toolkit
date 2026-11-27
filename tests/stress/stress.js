// Stress and load runs for the Node side. Prints one line per run with time, memory and
// leftovers; exits 1 if any check fails. Real-sized inputs: a 3,200-clip proxy run (the
// size of the 4-5 Sep 2026 overnight run), a 40,000-clip RED card tree, 5,000 files of
// camera/date reads, an hour of interview audio, 1,000+ repeats of the small helpers.
//   node --expose-gc tests/stress/stress.js
var fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process");
var ROOT = path.join(__dirname, "..", "..");
var jobs = require(path.join(ROOT, "core", "jobs.js"));
var steps = require(path.join(ROOT, "core", "steps.js"));
var camera = require(path.join(ROOT, "core", "camera.js"));
var shoot = require(path.join(ROOT, "core", "shootdate.js"));
var W = require(path.join(ROOT, "skills", "import-footage", "walkLogic.js"));
var F = require(path.join(ROOT, "skills", "interview-selects", "fillers.js"));
var J = require(path.join(ROOT, "tests", "node", "jsx-harness.js"));
var H = require(path.join(ROOT, "tests", "node", "helpers.js"));

var failures = 0, rows = [];
function mem() { if (global.gc) global.gc(); return process.memoryUsage().heapUsed / 1048576; }
// Children of this process, not counting the shell that runs pgrep itself.
function childCount() { try { return Math.max(0, (cp.execSync("pgrep -P " + process.pid + " | wc -l").toString().trim() | 0) - 1); } catch (e) { return 0; } }
function fdCount() { try { return fs.readdirSync("/dev/fd").length; } catch (e) { return -1; } }
async function run(name, fn, check) {
  var m0 = mem(), fd0 = fdCount(), t0 = Date.now(), note = "";
  try { note = (await fn()) || ""; } catch (e) { note = "THREW " + e.message; failures++; }
  var ms = Date.now() - t0, m1 = mem(), fd1 = fdCount(), kids = childCount();
  var bad = check ? check(ms, m1 - m0) : null;
  if (fd1 > fd0 + 2) bad = (bad ? bad + "; " : "") + "file handles left open: " + fd0 + " -> " + fd1;
  if (kids) bad = (bad ? bad + "; " : "") + kids + " child processes left running";
  if (bad) failures++;
  var line = (bad ? "FAIL " : "PASS ") + name + " | " + ms + " ms | heap " + (m1 - m0 >= 0 ? "+" : "") + (m1 - m0).toFixed(1) + " MB | " + note + (bad ? " | " + bad : "");
  rows.push(line); console.log(line);
}

(async function () {
  // 1. Proxy-sized pool: 3,200 jobs, 4 at once, with weights/kinds and progress ticks.
  await run("JobPool 3,200 jobs x4", async function () {
    var ticks = 0, slowest = 0;
    var p = new jobs.JobPool({ maxConcurrent: 4, watchMs: 200, onProgress: function () { var t = Date.now(); ticks++; p.progress(); slowest = Math.max(slowest, Date.now() - t); } });
    for (var i = 0; i < 3200; i++) p.add({ key: "k" + i, cmd: "true", kind: i % 3 ? "ffmpeg" : "r3d", weight: 1 + (i % 7), label: "clip " + i });
    p.start(); var s = await p.wait();
    if (s.ok !== 3200) throw new Error("only " + s.ok + " ok");
    return s.ok + " ok, " + ticks + " progress events, slowest progress() " + slowest + " ms";
  }, function (ms) { return ms > 120000 ? "too slow" : null; });

  // 2. progress()/ETA cost with a full queue (it plays the whole run forward every call).
  await run("ETA with 3,200 queued, 1,000 progress() calls", async function () {
    var p = new jobs.JobPool({ maxConcurrent: 4, watchMs: 1000, etaHistoryFile: null });
    p.etaHistory = { ffmpeg: 2, r3d: 6 };
    for (var i = 0; i < 3200; i++) p.add({ key: "k" + i, cmd: "sleep 30", kind: i % 3 ? "ffmpeg" : "r3d", weight: 1 + (i % 7), label: "c" + i });
    p._runStarted(); p.etaHistory = { ffmpeg: 2, r3d: 6 }; p.started = true;
    var t0 = Date.now(), e;
    for (var k = 0; k < 1000; k++) e = p.progress().eta;
    var per = (Date.now() - t0) / 1000;
    if (e.state !== "ok") throw new Error("eta state " + e.state);
    return per.toFixed(2) + " ms per call, eta " + Math.round(e.seconds / 3600) + " h";
  }, function (ms) { return ms / 1000 > 50 ? "progress() over 50 ms per call would stall the panel" : null; });

  // 3. Pause/resume/cancel hammered while jobs run (race check).
  await run("JobPool pause/resume/cancel race", async function () {
    var p = new jobs.JobPool({ maxConcurrent: 4, watchMs: 20 });
    for (var i = 0; i < 300; i++) p.add({ key: "k" + i, cmd: "sleep 0.0" + (i % 5), label: "j" + i });
    p.start();
    var flips = setInterval(function () { if (p.paused) p.resume(); else p.pause(); }, 7);
    await H.sleep(800); clearInterval(flips); p.resume(); p.cancel();
    var s = await p.wait();
    if (s.ok + s.killed + s.notStarted + s.failed !== 300) throw new Error("lost jobs: " + JSON.stringify(s).slice(0, 200));
    return s.ok + " ok, " + s.killed + " killed, " + s.notStarted + " not started, 0 lost";
  });

  // 4. Two pools saving the same ETA file at once (two runs back to back / two panels).
  await run("2 pools x 50 runs writing one ETA file", async function () {
    var d = H.tmpdir("eta"), f = path.join(d, "eta.json"), all = [];
    for (var r = 0; r < 50; r++) for (var q = 0; q < 2; q++) (function () {
      var p = new jobs.JobPool({ maxConcurrent: 2, watchMs: 50, etaHistoryFile: f });
      for (var i = 0; i < 3; i++) p.add({ key: "k" + i, cmd: "true", kind: "ffmpeg", label: "x" });
      p.start(); all.push(p.wait());
    }());
    await Promise.all(all);
    var j = JSON.parse(fs.readFileSync(f, "utf-8"));
    return "file still valid JSON, ffmpeg rate " + j.rates.ffmpeg.toFixed(4);
  });

  // 5. Ingest walk on a 200-card x 200-clip RED tree (40,000 clips).
  await run("walkTree 40,000 RED clips (in-memory tree)", async function () {
    var tree = {};
    for (var c = 0; c < 200; c++) { var card = "A" + c + ".RDM"; tree[card] = {}; for (var k = 0; k < 200; k++) tree[card]["A" + c + "_C" + k + ".RDC"] = ["A" + c + "_C" + k + "_001.R3D", "A" + c + "_C" + k + "_002.R3D", "A" + c + "_C" + k + ".wav"]; }
    function list(ref) { // ref: [] (root), [card], [card, rdc]
      if (ref.length === 0) return Promise.resolve(Object.keys(tree).map(function (n) { return { name: n, isDir: true, ref: [n] }; }));
      if (ref.length === 1) return Promise.resolve(Object.keys(tree[ref[0]]).map(function (n) { return { name: n, isDir: true, ref: [ref[0], n] }; }));
      return Promise.resolve(tree[ref[0]][ref[1]].map(function (n) { return { name: n, isDir: false, ref: null }; }));
    }
    var clips = 0, wavs = 0;
    await W.walkTree([], "Root", list, function (it) { if (it.type === "clip") { clips++; if (it.wav) wavs++; } });
    if (clips !== 40000 || wavs !== 40000) throw new Error(clips + " clips, " + wavs + " wavs");
    return clips + " clips, " + wavs + " wavs matched";
  }, function (ms) { return ms > 30000 ? "too slow" : null; });

  // 6. Camera + shoot date reads over 5,000 real files, then the cached second pass.
  await run("camera+shootdate 5,000 files, cold then cached", async function () {
    var d = H.tmpdir("cams"), clips = [];
    for (var f = 0; f < 50; f++) { var dir = path.join(d, "card " + f); fs.mkdirSync(dir); for (var i = 0; i < 100; i++) { var p = path.join(dir, "A_0062C" + (100 + i) + "H260927_000653EJ.MXF"); fs.writeFileSync(p, "xxCanon EOS C70\0"); clips.push({ path: p }); } }
    var cc = path.join(d, "cam.json"), dc = path.join(d, "date.json"), t0 = Date.now();
    await camera.detect(clips, { cacheFile: cc }); await shoot.detect(clips, { cacheFile: dc });
    var cold = Date.now() - t0; t0 = Date.now();
    await camera.detect(clips, { cacheFile: cc }); await shoot.detect(clips, { cacheFile: dc });
    var warm = Date.now() - t0;
    if (clips[4999].camera !== "Canon EOS C70" || clips[4999].shootDay !== "20260926") throw new Error(clips[4999].camera + " " + clips[4999].shootDay);
    return "cold " + cold + " ms, cached " + warm + " ms";
  });

  // 7. An hour of 16 kHz interview audio through the filler envelope and tiles.
  await run("fillers envelope + tiles, 60 min wav", async function () {
    var d = H.tmpdir("hour"), f = path.join(d, "hour.wav"), sr = 16000, n = 3600 * sr, buf = Buffer.alloc(44 + n * 2);
    for (var i = 0; i < n; i++) buf.writeInt16LE(((i / sr) % 4 < 2.5 ? Math.round(9000 * Math.sin(i / 7)) : 0), 44 + i * 2);
    H.writeWav(f, [], sr); var h = fs.readFileSync(f).slice(0, 44); h.writeUInt32LE(36 + n * 2, 4); h.writeUInt32LE(n * 2, 40); h.copy(buf); fs.writeFileSync(f, buf);
    var db = F.envelope(f), t = F.tiles(3600, db, d);
    return db.length + " frames, " + t.length + " first-pass clips";
  }, function (ms, dm) { return ms > 60000 ? "too slow" : null; });

  // 8. ExtendScript helpers 1,000+ times (fake Premiere): fingerprint of a 5,000-clip
  //    timeline, T.json of 10,000 records, parseTime x100,000, 200 safe copies.
  await run("ExtendScript helpers: big timeline, big JSON, 200 safe copies", async function () {
    var layout = []; for (var i = 0; i < 5000; i++) layout.push({ kind: i % 2 ? "audio" : "video", track: i % 2, name: "C" + i, start: i * 3, end: i * 3 + 2.5 });
    var h = J.load(["make-safe-copy"], { sequences: [{ name: "Big", id: "1", layout: layout }] });
    var t0 = Date.now(), fp; for (var k = 0; k < 20; k++) fp = h.T.fingerprint(h.P.project.sequences[0]);
    var fpMs = (Date.now() - t0) / 20;
    var recs = h.inCtx("(function(){var a=[];for(var i=0;i<10000;i++)a.push({name:'clip \"'+i+'\" é',start:i*1.5,ok:true});return {clips:a};})()");
    t0 = Date.now(); var js = h.T.json(recs); var jsonMs = Date.now() - t0;
    if (JSON.parse(js).clips.length !== 10000) throw new Error("json lost records");
    var seq = h.P.project.sequences[0]; t0 = Date.now();
    for (k = 0; k < 100000; k++) if (h.T.parseTime("1:02:" + (k % 60) + ".5", seq) !== 3720 + (k % 60) + 0.5) throw new Error("parseTime wrong at " + k);
    var ptMs = Date.now() - t0;
    var small = J.load(["make-safe-copy"], { sequences: [{ name: "S", id: "1", layout: layout.slice(0, 50) }] }), names = {};
    for (k = 0; k < 200; k++) { small.P.project.activeSequence = small.P.project.sequences[0]; var r = JSON.parse(small.T.run("make-safe-copy", {})); if (!r.ok) throw new Error("copy " + k + ": " + r.error); if (r.ok) names[r.details.copyName] = 1; }
    return "fingerprint 5,000 clips " + fpMs.toFixed(1) + " ms, json 10,000 records " + jsonMs + " ms, parseTime x100k " + ptMs + " ms, " + Object.keys(names).length + " unique copy names of 200 copies";
  });

  // 9. StepTask 1,000 runs sharing one history file.
  await run("StepTask 1,000 runs, one history file", async function () {
    var d = H.tmpdir("steps"), f = path.join(d, "h.json");
    for (var i = 0; i < 1000; i++) { var t = new steps.StepTask({ steps: [{ id: "a" }, { id: "b" }], historyFile: f, size: 1 + (i % 10) }); t.step("a"); t.step("b"); t.done(true); }
    JSON.parse(fs.readFileSync(f, "utf-8"));
    return "history still valid";
  });

  console.log("\n" + (failures ? "STRESS FAIL (" + failures + ")" : "STRESS PASS") + " on " + os.platform() + " " + os.arch() + ", node " + process.version + ", " + os.cpus().length + " CPUs");
  process.exit(failures ? 1 : 0);
}());
