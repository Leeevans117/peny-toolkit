// skills/interview-selects: fillers.js and pipeline.js (pure parts + a fake Ollama).
var test = require("node:test"), assert = require("node:assert/strict");
var fs = require("fs"), path = require("path"), http = require("http");
var H = require("./helpers");
var F = require(path.join(H.ROOT, "skills", "interview-selects", "fillers.js"));
var P = require(path.join(H.ROOT, "skills", "interview-selects", "pipeline.js"));

// A 16 kHz mono "interview": tone bursts (words) at the given [start, end] seconds, silence between.
function speechWav(file, spans, dur) {
  var sr = 16000, s = new Array(Math.round(dur * sr)).fill(0);
  for (var i = 0; i < s.length; i++) s[i] = (Math.random() - 0.5) * 0.0005;
  spans.forEach(function (sp) { for (var i = Math.round(sp[0] * sr); i < Math.round(sp[1] * sr) && i < s.length; i++) s[i] = 0.3 * Math.sin(i / 5); });
  return H.writeWav(file, s, sr, 1);
}
function whisperJson(file, words) { // words: [[text, t_sec]]
  var tokens = words.map(function (w) { return { text: " " + w[0], t_dtw: Math.round(w[1] * 100), offsets: { from: w[1] * 1000, to: w[1] * 1000 + 200 }, p: 0.9 }; });
  fs.writeFileSync(file, JSON.stringify({ transcription: [{ tokens: tokens }] }));
}

// ---- fillers ----
test("fillers.words: custom list cleaned, empty falls back to the defaults", function () {
  assert.deepEqual(F.words("Um, UH;  like"), ["um", "uh", "like"]);
  assert.deepEqual(F.words(""), F.DEFAULT_WORDS); assert.deepEqual(F.words(null), F.DEFAULT_WORDS); assert.deepEqual(F.words("🎬 ,,"), F.DEFAULT_WORDS);
});
test("fillers.readWords: tokens without a leading space join the word before; shift added", function () {
  var d = H.tmpdir("fw"), f = path.join(d, "w.json");
  fs.writeFileSync(f, JSON.stringify({ transcription: [{ tokens: [{ text: "[_BEG_]", offsets: { from: 0 } }, { text: " I", t_dtw: 100, offsets: { from: 0 } }, { text: "'m", t_dtw: 120, offsets: { from: 0 } },
    { text: " um", t_dtw: -1, offsets: { from: 2500 } }] }] }));
  var w = F.readWords(f, 10);
  assert.deepEqual(w.map(function (x) { return x.text; }), ["I'm", "um"]);
  assert.equal(w[0].t, 11); assert.equal(w[0].dtw, true);
  assert.equal(w[1].t, 12.5); assert.equal(w[1].dtw, false, "no DTW time: falls back to the offset and says so");
  fs.writeFileSync(f, "{}"); assert.deepEqual(F.readWords(f, 0), []);
  fs.writeFileSync(f, "not json"); assert.throws(function () { F.readWords(f, 0); });
});
test("fillers.envelope: dB per 10 ms; rejects 24-bit and non-wav files", function () {
  var d = H.tmpdir("env"), f = speechWav(path.join(d, "a é.wav"), [[0.5, 1]], 2);
  var db = F.envelope(f);
  assert.equal(db.length, 200);
  assert.ok(db[10] < -60 && db[70] > -20, "silence low, tone high: " + db[10] + " " + db[70]);
  var b = fs.readFileSync(f); b.writeUInt16LE(24, 34); fs.writeFileSync(path.join(d, "b.wav"), b);
  assert.throws(function () { F.envelope(path.join(d, "b.wav")); }, /Not a 16-bit PCM wav/);
  fs.writeFileSync(path.join(d, "c.wav"), "hello");
  assert.throws(function () { F.envelope(path.join(d, "c.wav")); }, /Not a 16-bit PCM wav/);
});
test("fillers.envelope: a wav that says 0 channels gives a clear error, not a crash", function () {
  var d = H.tmpdir("env0"), f = speechWav(path.join(d, "z.wav"), [], 1), b = fs.readFileSync(f);
  b.writeUInt16LE(0, 22); fs.writeFileSync(f, b);
  assert.throws(function () { F.envelope(f); }, /Not a 16-bit PCM wav|channels/);
});
test("fillers.sound: an isolated filler is found; one joined to a word is skipped with a reason", function () {
  var d = H.tmpdir("snd"), f = speechWav(path.join(d, "s.wav"), [[1, 1.6], [2.5, 2.8], [3.6, 4.2], [6, 6.6], [6.62, 7.3]], 9);
  var db = F.envelope(f);
  var ws = [{ text: "so", t: 1.3, dtw: true }, { text: "um", t: 2.65, dtw: true }, { text: "yes", t: 3.9, dtw: true }];
  var r = F.sound(ws, 1, db);
  assert.ok(!r.why, JSON.stringify(r)); assert.ok(Math.abs(r.a - 250) <= 2 && Math.abs(r.b - 280) <= 2, JSON.stringify(r));
  var ws2 = [{ text: "um", t: 6.3, dtw: true }, { text: "word", t: 6.9, dtw: true }];
  assert.ok(F.sound(ws2, 0, db).why);
  assert.equal(F.sound([{ text: "um", t: 2.6, dtw: false }], 0, db).why, "no word timing from whisper");
  assert.equal(F.sound([{ text: "um", t: 5.0, dtw: true }], 0, db).why, "no sound at that time");
});
test("fillers.windows and tiles: inside the file, quiet stretches left out", function () {
  var w = F.windows([{ t: 1 }, { t: 99 }], 100, "/x");
  assert.deepEqual(w.map(function (x) { return x.start; }), [0, 0, 94, 94]);
  var d = H.tmpdir("tiles"), f = speechWav(path.join(d, "t.wav"), [[0, 3], [20, 23]], 30);
  var t = F.tiles(30, F.envelope(f), d);
  assert.deepEqual(t.map(function (x) { return x.start; }), [0, 15, 20]);
  assert.deepEqual(F.tiles(0, new Float32Array(0), d), []);
});
test("fillers.decide: cut only when both checks agree", function () {
  var d = H.tmpdir("dec"), f = speechWav(path.join(d, "s.wav"), [[1, 1.6], [2.5, 2.8], [3.6, 4.2]], 9), db = F.envelope(f);
  var cands = [{ t: 2.65, word: "um", context: "" }], wins = F.windows(cands, 9, d);
  wins.forEach(function (w) { whisperJson(w.file + ".json", [["so", 1.3 - w.start], ["um", 2.65 - w.start], ["yes", 3.9 - w.start]]); });
  var r = F.decide(cands, wins, db, {});
  assert.equal(r.fillers.length, 1); assert.equal(r.skipped.length, 0);
  assert.ok(r.fillers[0].start < 2.5 && r.fillers[0].end > 2.8 && r.fillers[0].end < 3.6, JSON.stringify(r.fillers[0]));
  // One check missing -> skipped, with the reason.
  fs.unlinkSync(wins[1].file + ".json");
  var r2 = F.decide(cands, wins, db, {});
  assert.equal(r2.fillers.length, 0); assert.match(r2.skipped[0].why, /whisper could not check it/);
});

// ---- pipeline (pure parts) ----
test("pipeline.tc: times as m:ss.s / h:mm:ss.s", function () {
  assert.equal(P.tc(0), "0:00.0"); assert.equal(P.tc(65.25), "1:05.3"); assert.equal(P.tc(3725.5), "1:02:05.5");
});
test("pipeline.tc: 59.96 s rounds up to the next minute, not 0:60.0", function () {
  assert.equal(P.tc(59.96), "1:00.0"); assert.equal(P.tc(3599.97), "1:00:00.0");
});
test("pipeline.readTranscript: seconds, empty lines dropped, bad files throw", function () {
  var d = H.tmpdir("tr"), f = path.join(d, "transcript.json");
  fs.writeFileSync(f, JSON.stringify({ transcription: [{ offsets: { from: 1000, to: 2500 }, text: " Hello " }, { offsets: { from: 2500, to: 3000 }, text: "  " }] }));
  assert.deepEqual(P.readTranscript(f), [{ a: 1, b: 2.5, text: "Hello" }]);
  fs.writeFileSync(f, "{}"); assert.throws(function () { P.readTranscript(f); });
  assert.throws(function () { P.readTranscript(path.join(d, "missing.json")); }, /ENOENT/);
});
test("pipeline.windows: overlapping windows cover every line once in a core", function () {
  var lines = []; for (var i = 0; i < 200; i++) lines.push({ a: i * 10, b: i * 10 + 8, text: "x" });
  var w = P.windows(lines, 540, 60);
  assert.equal(w[0].ws, 0); assert.ok(w[w.length - 1].we > 1998);
  lines.forEach(function (l) { assert.equal(w.filter(function (x) { return l.a >= x.coreA && l.a < x.coreB; }).length >= 1, true); });
  assert.equal(P.windows([{ a: 0, b: 5, text: "x" }], 540, 60).length, 1);
});
test("pipeline.cleanOutline: drops 'Tony says that' openings", function () {
  assert.equal(P.cleanOutline("Tony says that the trail was wet", "Tony"), "The trail was wet");
  assert.equal(P.cleanOutline("She explains how she started", ""), "She started");
  assert.equal(P.cleanOutline("the interviewee mentions: London", null), "London");
  assert.equal(P.cleanOutline("", "x"), ""); assert.equal(P.cleanOutline(null), "");
  assert.equal(P.cleanOutline("Started riding at 2", "A (b) c"), "Started riding at 2", "regex characters in a name are safe");
});

// Fake Ollama on 127.0.0.1:11434 (skipped when a real one is running there).
function fakeOllama(handler) {
  return new Promise(function (ok) {
    var srv = http.createServer(function (req, res) {
      var b = ""; req.on("data", function (d) { b += d; }); req.on("end", function () { handler(req, b, res); });
    });
    srv.on("error", function () { ok(null); });
    srv.listen(11434, "127.0.0.1", function () { ok(srv); });
  });
}
test("pipeline.pickModel: falls back to 32b only when 14b is missing; no server keeps 14b", async function (t) {
  var srv = await fakeOllama(function (req, b, res) { res.end(JSON.stringify({ models: [{ name: "qwen2.5:32b" }] })); });
  if (!srv) return t.skip("port 11434 in use (a real Ollama is running)");
  try { assert.equal(await P.pickModel(), "qwen2.5:32b"); } finally { srv.close(); }
});
test("pipeline.selectsByLabels: garbage from Ollama keeps every line as the interviewee's (nothing cut)", async function (t) {
  var srv = await fakeOllama(function (req, b, res) { res.end(JSON.stringify({ response: "this is not json", prompt_eval_count: 1, eval_count: 1 })); });
  if (!srv) return t.skip("port 11434 in use");
  try {
    var lines = []; for (var i = 0; i < 12; i++) lines.push({ a: i * 5, b: i * 5 + 4, text: "line " + i });
    var r = await P.selectsByLabels(lines, { who: "Tod" });
    var spans = (r.answers || r).map ? (r.answers || r) : [];
    var covered = 0; spans.forEach(function (s) { covered += s.end - s.start; });
    assert.ok(covered >= 55, "all 12 lines kept: " + JSON.stringify(r).slice(0, 300));
  } finally { srv.close(); }
});
test("pipeline.selectsByLabels: Ollama not running gives a readable error", async function (t) {
  var probe = await fakeOllama(function () {});
  if (!probe) return t.skip("port 11434 in use");
  probe.close();
  var lines = []; for (var i = 0; i < 12; i++) lines.push({ a: i * 5, b: i * 5 + 4, text: "line " + i });
  await assert.rejects(P.selectsByLabels(lines, {}), function (e) { return /ECONNREFUSED|Ollama/.test(String(e && e.message)); });
});
