// core/steps.js, core/camera.js, core/shootdate.js, core/ame.js, core/updater.js
var test = require("node:test"), assert = require("node:assert/strict");
var fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process");
var H = require("./helpers");
var steps = require(path.join(H.ROOT, "core", "steps.js"));
var camera = require(path.join(H.ROOT, "core", "camera.js"));
var shoot = require(path.join(H.ROOT, "core", "shootdate.js"));
var ame = require(path.join(H.ROOT, "core", "ame.js"));
var updater = require(path.join(H.ROOT, "core", "updater.js"));
var HAVE_FFMPEG = (function () { try { cp.execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch (e) { return false; } }());

// ---- StepTask ----
test("StepTask: steps move the bar forward and finish at 100%", async function () {
  var seen = [], t = new steps.StepTask({ title: "T", steps: [{ id: "a", label: "A" }, { id: "b", label: "B" }], onProgress: function (p) { seen.push(p); } });
  t.step("a"); await H.sleep(50); t.step("b"); t.done(true);
  var last = seen[seen.length - 1];
  assert.equal(last.event, "finished"); assert.equal(last.fraction, 1); assert.equal(last.eta.state, "done");
  assert.equal(last.finished, 2); assert.equal(last.unit, "steps");
  for (var i = 1; i < seen.length; i++) assert.ok(seen[i].fraction >= seen[i - 1].fraction, "bar went backwards");
  assert.equal(t.timer, null, "tick timer must stop");
});
test("StepTask: unknown step ids are ignored, done twice is harmless, failure is reported", function () {
  var seen = [], t = new steps.StepTask({ steps: [{ id: "a" }], onProgress: function (p) { seen.push(p); } });
  t.step("nope"); assert.equal(seen.length, 0);
  t.step("a"); t.done(false); t.done(true);
  assert.equal(seen.filter(function (p) { return p.event === "finished"; }).length, 1);
  assert.equal(seen[seen.length - 1].failed, 1);
});
test("StepTask: learns step times into the history file, ignores a corrupt one", async function () {
  var d = H.tmpdir("steps"), hist = path.join(d, "deep dir", "h.json");
  var t = new steps.StepTask({ steps: [{ id: "a" }], size: 10, historyFile: hist, defaults: { a: { a: 0, b: 0 } } });
  t.step("a"); await H.sleep(120); t.done(true);
  var h = JSON.parse(fs.readFileSync(hist, "utf-8"));
  assert.ok(h.steps.a.b > 0.005 && h.steps.a.b < 0.1, JSON.stringify(h));
  fs.writeFileSync(hist, "garbage{");
  var t2 = new steps.StepTask({ steps: [{ id: "a" }], historyFile: hist });
  assert.equal(t2.steps[0].expected, 2, "falls back to the 2 s default");
  t2.step("a"); await H.sleep(20); t2.done(true);
  assert.ok(JSON.parse(fs.readFileSync(hist, "utf-8")).steps.a);
});
test("StepTask: a failed run does not write history; size 0/negative counts as 1", function () {
  var d = H.tmpdir("steps2"), hist = path.join(d, "h.json");
  var t = new steps.StepTask({ steps: [{ id: "a" }], size: -5, historyFile: hist });
  assert.equal(t.size, 1);
  t.step("a"); t.done(false);
  assert.equal(fs.existsSync(hist), false);
});
test("StepTask: onProgress throwing does not throw out of step()", function () {
  var t = new steps.StepTask({ steps: [{ id: "a" }], onProgress: function () { throw new Error("x"); } });
  t.step("a"); t.done(true);
});

// ---- camera ----
test("camera.prettyModel: names from the strings cameras write", function () {
  var cases = {
    "Canon EOS R5m2": "Canon EOS R5 Mark II", "Canon EOS C70": "Canon EOS C70", "Canon XF605": "Canon XF605",
    "ILCE-7SM3": "Sony A7S III", "ILME-FX6V": "Sony FX6", "PXW-Z280": "Sony PXW-Z280",
    "V-RAPTOR 8K VV": "RED V-Raptor 8K VV", "KOMODO 6K": "RED Komodo 6K", "KOMODO-X 6K S35": "RED Komodo-X 6K",
    "NIKON Z 9": "Nikon Z 9", "  Canon   EOS  R5m2 ": "Canon EOS R5 Mark II", "GoPro": "GoPro"
  };
  Object.keys(cases).forEach(function (k) { assert.equal(camera.prettyModel(k), cases[k], k); });
  assert.equal(camera.prettyModel(""), null); assert.equal(camera.prettyModel(null), null); assert.equal(camera.prettyModel(undefined), null);
  assert.equal(camera.prettyModel(42), "42");
});
test("camera.fileModel: finds the model in the head or tail of a file", async function () {
  var d = H.tmpdir("cam"), a = path.join(d, "C0001 é.MP4"), b = path.join(d, "tail.mov"), c = path.join(d, "none.mov");
  fs.writeFileSync(a, Buffer.concat([Buffer.from("....ftypXAVC"), Buffer.alloc(100), Buffer.from("ILME-FX6V\0"), Buffer.alloc(1000)]));
  fs.writeFileSync(b, Buffer.concat([Buffer.alloc(7 * 1024 * 1024), Buffer.from("Canon EOS R5m2\0"), Buffer.alloc(100)]));
  fs.writeFileSync(c, Buffer.alloc(5000));
  assert.equal(await camera.fileModel(a), "ILME-FX6V");
  assert.equal(await camera.fileModel(b), "Canon EOS R5m2");
  assert.equal(await camera.fileModel(c), null);
  assert.equal(await camera.fileModel(path.join(d, "missing.mov")), null);
  fs.writeFileSync(path.join(d, "empty.mov"), "");
  assert.equal(await camera.fileModel(path.join(d, "empty.mov")), null);
});
test("camera.detect: one probe per folder+type, audio skipped, results cached", async function () {
  var d = H.tmpdir("camdet"), cache = path.join(d, "cache dir", "cam.json"), sub = path.join(d, "A cam");
  fs.mkdirSync(sub);
  ["C0001.MP4", "C0002.MP4"].forEach(function (n) { fs.writeFileSync(path.join(sub, n), Buffer.from("xxILCE-7SM3\0")); });
  fs.writeFileSync(path.join(sub, "sound.wav"), "RIFF");
  var clips = [{ path: path.join(sub, "C0001.MP4") }, { path: path.join(sub, "C0002.MP4") }, { path: path.join(sub, "sound.wav") },
    { path: "" }, { path: path.join(d, "gone.MP4") }, {}];
  var status = [];
  var out = await camera.detect(clips, { cacheFile: cache, status: function (s) { status.push(s); } });
  assert.deepEqual(out.map(function (c) { return c.camera; }), ["Sony A7S III", "Sony A7S III", null, null, null, null]);
  assert.equal(status.length, 1, "one file read for the folder");
  // The cache is kept per sample file (the first clip of the folder).
  var again = await camera.detect([{ path: path.join(sub, "C0001.MP4") }], { cacheFile: cache, status: function (s) { status.push(s); } });
  assert.equal(again[0].camera, "Sony A7S III"); assert.equal(status.length, 1, "second run comes from the cache");
  fs.writeFileSync(cache, "{{not json");
  var third = await camera.detect([{ path: path.join(sub, "C0002.MP4") }], { cacheFile: cache });
  assert.equal(third[0].camera, "Sony A7S III");
});
test("camera.redModel: no REDline installed gives null, not an error", async function () {
  if (fs.existsSync("/usr/local/bin/REDline")) return;
  assert.equal(await camera.redModel("/nope.R3D"), null);
});

// ---- shootdate ----
test("shootdate.shootDay: before 05:00 belongs to the day before, across months and leap years", function () {
  assert.equal(shoot.shootDay("20260826", "135620"), "20260826");
  assert.equal(shoot.shootDay("20260826", "045959"), "20260825");
  assert.equal(shoot.shootDay("20260826", "050000"), "20260826");
  assert.equal(shoot.shootDay("20260301", "010000"), "20260228");
  assert.equal(shoot.shootDay("20240301", "010000"), "20240229");
  assert.equal(shoot.shootDay("20260101", "000000"), "20251231");
  assert.equal(shoot.shootDay("20260826", null), "20260826");
  assert.equal(shoot.shootDay(null, "010000"), null);
  assert.equal(shoot.shootDay("", ""), null);
});
test("shootdate.fromName: Canon names, others ignored", function () {
  assert.deepEqual(shoot.fromName("/x/A_0062C344H260927_000653EJ_CANON.MXF"), { date: "20260927", time: "000653", from: "Canon file name" });
  assert.equal(shoot.fromName("/x/C0001.MP4"), null);
  assert.equal(shoot.fromName("/x/🎬 weird name.mov"), null);
});
test("shootdate.fromR3d: reads the RED header tags; junk or missing gives null", function () {
  var d = H.tmpdir("r3d"), f = path.join(d, "A001_C001_0826XX_001.R3D");
  fs.writeFileSync(f, Buffer.concat([Buffer.alloc(200), Buffer.from("\x00\x0c\x10#20260826\x00\x00\x0a\x10$135620\x00", "latin1"), Buffer.alloc(200)]));
  assert.deepEqual(shoot.fromR3d(f), { date: "20260826", time: "135620", from: "RED header" });
  fs.writeFileSync(f, Buffer.alloc(1000));
  assert.equal(shoot.fromR3d(f), null);
  assert.equal(shoot.fromR3d(path.join(d, "missing.R3D")), null);
});
test("shootdate.fromSonyXml: reads CreationDate from the sidecar, upper or lower case .xml", function () {
  var d = H.tmpdir("sony");
  fs.writeFileSync(path.join(d, "C0001.MP4"), "x");
  fs.writeFileSync(path.join(d, "C0001M01.xml"), '<a><CreationDate value="2026-08-26T13:56:20+02:00"/></a>');
  var r = shoot.fromSonyXml(path.join(d, "C0001.MP4"));
  assert.deepEqual(r, { date: "20260826", time: "135620", from: "Sony XML" });
  assert.equal(shoot.fromSonyXml(path.join(d, "C0002.MP4")), null);
  fs.writeFileSync(path.join(d, "C0003M01.XML"), "<broken");
  assert.equal(shoot.fromSonyXml(path.join(d, "C0003.MP4")), null);
});
test("shootdate.detect: wav bext date via ffprobe, missing files, cache", { skip: !HAVE_FFMPEG && "no ffmpeg" }, async function () {
  var d = H.tmpdir("sdet"), wav = path.join(d, "ZOOM0001 ü.wav"), cache = path.join(d, "c.json");
  cp.execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "0.2",
    "-metadata", "origination_date=2026-08-26", "-metadata", "origination_time=03:10:00", "-write_bext", "1", wav]);
  var clips = [{ path: wav }, { path: path.join(d, "missing.mov") }, { path: "" }];
  await shoot.detect(clips, { cacheFile: cache, ffprobe: "ffprobe" });
  assert.equal(clips[0].dateFrom, "wav (bext)"); assert.equal(clips[0].shootDay, "20260825", "03:10 counts as the day before");
  assert.equal(clips[1].shootDay, null); assert.equal(clips[1].size, null);
  assert.ok(JSON.parse(fs.readFileSync(cache, "utf-8"))[wav]);
  var again = [{ path: wav }]; await shoot.detect(again, { cacheFile: cache }); // no ffprobe: must come from cache
  assert.equal(again[0].shootDay, "20260825");
});
test("shootdate.detect: no ffprobe and no clues gives null, not an error", async function () {
  var d = H.tmpdir("sdet2"), f = path.join(d, "clip.mov"); fs.writeFileSync(f, "x");
  var clips = [{ path: f }]; await shoot.detect(clips, {});
  assert.equal(clips[0].shootDay, null); assert.equal(clips[0].size, 1);
});

// ---- ame.wait ----
test("ame.wait: resolves from the note file, checks the output exists, deletes the note", async function () {
  var dir = "/tmp/peny-toolkit/ame", id = "qa" + process.pid + Date.now(), d = H.tmpdir("ame"), out = path.join(d, "master é.wav");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(out, "x");
  setTimeout(function () { fs.writeFileSync(path.join(dir, id + ".json"), JSON.stringify({ ok: true, path: out })); }, 50);
  var r = await ame.wait(id, out, {});
  assert.equal(r.ok, true); assert.ok(r.ms >= 0);
  assert.equal(fs.existsSync(path.join(dir, id + ".json")), false);
  // Says done but the file is not there.
  fs.writeFileSync(path.join(dir, id + "b.json"), JSON.stringify({ ok: true, path: "/nope" }));
  var r2 = await ame.wait(id + "b", path.join(d, "never.wav"));
  assert.equal(r2.ok, false); assert.match(r2.error, /is not there/);
  // Error from Media Encoder passes through.
  fs.writeFileSync(path.join(dir, id + "c.json"), JSON.stringify({ ok: false, error: "cancelled in Media Encoder" }));
  var r3 = await ame.wait(id + "c", out);
  assert.equal(r3.ok, false); assert.equal(r3.error, "cancelled in Media Encoder");
});
test("ame.wait: times out with a readable message; half-written note is retried", async function () {
  var dir = "/tmp/peny-toolkit/ame", id = "qat" + process.pid + Date.now();
  fs.mkdirSync(dir, { recursive: true });
  var r = await ame.wait(id, "/nope", { timeoutMs: 300 });
  assert.equal(r.ok, false); assert.match(r.error, /did not finish in 0 min/);
  fs.writeFileSync(path.join(dir, id + "h.json"), '{"ok": tr');
  setTimeout(function () { fs.writeFileSync(path.join(dir, id + "h.json"), '{"ok":false,"error":"x"}'); }, 300);
  var ticks = 0, r2 = await ame.wait(id + "h", "/nope", { onTick: function () { ticks++; throw new Error("ui"); } });
  assert.equal(r2.error, "x"); assert.ok(ticks >= 1);
});

// ---- updater ----
test("updater.releaseScript: needs both update.sh and the panel-updates switch", function () {
  var home = H.tmpdir("home"), sup = path.join(home, "Library", "Application Support", "PenyToolkit");
  assert.equal(updater.releaseScript(home), null);
  fs.mkdirSync(sup, { recursive: true }); fs.writeFileSync(path.join(sup, "update.sh"), "#!/bin/bash\n");
  assert.equal(updater.releaseScript(home), null);
  fs.writeFileSync(path.join(sup, "panel-updates"), "");
  assert.equal(updater.releaseScript(home), path.join(sup, "update.sh"));
});
test("updater.buildScript: reads repo= from the publisher mark, path with spaces", function () {
  var home = H.tmpdir("home2"), repo = path.join(home, "Peny Toolkit é"), mark = path.join(home, ".peny-toolkit");
  assert.equal(updater.buildScript(home), null);
  fs.mkdirSync(mark); fs.writeFileSync(path.join(mark, "publisher"), "built=1\nrepo=" + repo + "  \n");
  assert.equal(updater.buildScript(home), null, "no auto-update.sh there yet");
  fs.mkdirSync(repo); fs.writeFileSync(path.join(repo, "auto-update.sh"), "");
  assert.equal(updater.buildScript(home), path.join(repo, "auto-update.sh"));
  fs.writeFileSync(path.join(mark, "publisher"), "garbage");
  assert.equal(updater.buildScript(home), null);
});
test("updater.start: stop() clears its timers; nothing runs while busy", function () {
  var u = updater.start({ log: function () {}, isBusy: function () { return "busy"; } });
  assert.equal(u.running(), false);
  u.stop(); // must not leave timers that keep the process alive (the test would hang)
});
