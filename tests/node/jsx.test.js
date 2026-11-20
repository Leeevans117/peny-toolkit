// ExtendScript side, run in Node against a fake Premiere (tests/node/jsx-harness.js).
var test = require("node:test"), assert = require("node:assert/strict");
var fs = require("fs"), path = require("path");
var J = require("./jsx-harness");
var SKILLS = fs.readdirSync(path.join(J.ROOT, "skills")).filter(function (d) { return fs.existsSync(path.join(J.ROOT, "skills", d, "premiere.jsx")); });

test("every premiere.jsx loads and registers the skill under its skill.json id", function () {
  SKILLS.forEach(function (id) {
    var h = J.load([id]);
    var want = JSON.parse(fs.readFileSync(path.join(J.ROOT, "skills", id, "skill.json"), "utf-8")).id;
    assert.equal(typeof h.T.skills[want], "function", id + " did not register PenyToolkit.skills[\"" + want + "\"]");
  });
});
test("ExtendScript files use only ES3 (no let/const/arrows/template strings/JSON object)", function () {
  var files = ["core/core.jsx"].concat(SKILLS.map(function (id) { return "skills/" + id + "/premiere.jsx"; }));
  var bad = [];
  files.forEach(function (f) {
    var src = fs.readFileSync(path.join(J.ROOT, f), "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")            // comments
      .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, "\"\"");          // strings
    src.split("\n").forEach(function (line, i) {
      if (/\b(let|const)\s+[A-Za-z_$]/.test(line) || /=>/.test(line) || /`/.test(line) || /\bJSON\.(parse|stringify)\b/.test(line))
        bad.push(f + ":" + (i + 1) + ": " + line.trim());
    });
  });
  assert.deepEqual(bad, []);
});

test("T.json: output parses back exactly, control characters dropped, no functions", function () {
  var h = J.load(), T = h.T;
  var v = h.inCtx('{ a: "quote \\" back \\\\ slash", b: "line\\nbreak\\ttab\\r", e: "🎬 ü", n: [1, 2.5, -3, null, true, false], z: 0, nan: NaN, inf: Infinity, u: undefined, f: function () {}, nested: { k: ["x"] } }');
  var back = JSON.parse(T.json(v));
  assert.equal(back.a, 'quote " back \\ slash'); assert.equal(back.b, "line\nbreak\ttab\r"); assert.equal(back.e, "🎬 ü");
  assert.deepEqual(back.n, [1, 2.5, -3, null, true, false]); assert.equal(back.z, 0);
  assert.equal(back.nan, null); assert.equal(back.inf, null); assert.equal(back.u, null); assert.equal("f" in back, false);
  assert.deepEqual(back.nested, { k: ["x"] });
  assert.equal(JSON.parse(T.json("a\u0001b")), "ab");
  assert.equal(T.json(null), "null"); assert.equal(T.json(undefined), "null");
});
test("T.fmt: h:mm:ss.ss, never 60 seconds, negatives clamp to 0", function () {
  var T = J.load().T;
  assert.equal(T.fmt(0), "0:00:00.00"); assert.equal(T.fmt(3725.5), "1:02:05.50"); assert.equal(T.fmt(-4), "0:00:00.00");
  assert.equal(T.fmt(59.999), "0:01:00.00"); assert.equal(T.fmt(3599.999), "1:00:00.00");
});
test("T.parseTime: seconds, m:ss, h:mm:ss.s, timecode; junk is NaN", function () {
  var h = J.load([], { sequences: [{ name: "S" }] }), T = h.T, seq = h.P.project.sequences[0];
  assert.equal(T.parseTime("3832.8", seq), 3832.8); assert.equal(T.parseTime(" 1:03:52.8 ", seq), 3832.8);
  assert.equal(T.parseTime("2:05", seq), 125); assert.equal(T.parseTime("0:00:10:12", seq), 10.48);
  ["", "   ", "abc", "-5", "1:2:3:4:5", "1::2", "🎬", null, undefined].forEach(function (x) { assert.ok(isNaN(T.parseTime(x, seq)), String(x)); });
  assert.ok(isNaN(T.parseTime("0:00:10:12", null)), "timecode needs a frame rate");
});
test("T.sec/T.ticks round trip; isToolkitCopy only on the exact suffix", function () {
  var T = J.load().T;
  assert.equal(T.sec(T.ticks(12.34)), 12.34); assert.equal(T.ticks("1"), J.TPS);
  assert.equal(T.isToolkitCopy({ name: "Day 1 TOOLKIT COPY" }), true);
  assert.equal(T.isToolkitCopy({ name: "Day 1 toolkit copy" }), false);
  assert.equal(T.isToolkitCopy({ name: "TOOLKIT COPY of Day 1" }), false);
  assert.equal(T.isToolkitCopy({ name: "" }), false);
});
test("T.fingerprint changes when a clip moves and not otherwise", function () {
  var h = J.load([], { sequences: [{ name: "S", layout: [{ kind: "video", track: 0, name: "A001", start: 0, end: 5 }, { kind: "audio", track: 0, name: "A001", start: 0, end: 5 }] }] });
  var seq = h.P.project.sequences[0], a = h.T.fingerprint(seq), b = h.T.fingerprint(seq);
  assert.deepEqual(a, b); assert.equal(a.clips, 2);
  seq.videoTracks[0].clips[0].end.ticks = String(6 * J.TPS);
  assert.notEqual(h.T.fingerprint(seq).hash, a.hash);
});
test("T.clipsOverlapping: edges touching do not count as overlap", function () {
  var h = J.load([], { sequences: [{ name: "S", layout: [{ kind: "video", track: 0, name: "a", start: 0, end: 5 }, { kind: "video", track: 1, name: "b", start: 5, end: 9 }, { kind: "audio", track: 2, name: "c", start: 4, end: 6 }] }] });
  var r = h.T.clipsOverlapping(h.P.project.sequences[0], 5, 6).map(function (x) { return x.name; }).sort();
  assert.equal(r.join(","), "b,c");
});
test("Make safe copy: names the copy '<name> TOOLKIT COPY', opens it, leaves the original alone", function () {
  var h = J.load(["make-safe-copy"], { sequences: [{ name: "Episode 1 🎬", id: "1", layout: [{ kind: "video", track: 0, name: "A001", start: 0, end: 5 }] }] });
  var r = JSON.parse(h.T.run("make-safe-copy", {}));
  assert.equal(r.ok, true, r.error); assert.equal(r.details.copyName, "Episode 1 🎬 TOOLKIT COPY");
  assert.equal(r.details.originalUnchanged, true); assert.equal(r.details.copyIsActive, true); assert.equal(r.details.copyMatchesOriginal, true);
  assert.equal(h.P.project.sequences[0].name, "Episode 1 🎬", "original keeps its name");
  // A second copy of the original gets "(2)".
  h.P.project.activeSequence = h.P.project.sequences[0];
  var r2 = JSON.parse(h.T.run("make-safe-copy", {}));
  assert.equal(r2.details.copyName, "Episode 1 🎬 (2) TOOLKIT COPY");
  assert.deepEqual(h.P.mutations, []);
});
test("Make safe copy: no active sequence, clone that does nothing -> clear errors", function () {
  var h = J.load(["make-safe-copy"], { sequences: [] });
  assert.match(JSON.parse(h.T.run("make-safe-copy", {})).error, /No active sequence/);
  var h2 = J.load(["make-safe-copy"], { sequences: [{ name: "S" }], cloneFails: true });
  assert.match(JSON.parse(h2.T.run("make-safe-copy", {})).error, /did not create a new sequence/);
});
test("T.run: unknown skill, a skill that throws, a skill that returns nothing", function () {
  var T = J.load().T;
  assert.match(JSON.parse(T.run("nope", {})).error, /Unknown skill/);
  T.skills.boom = function () { throw new Error("kaboom"); };
  var r = JSON.parse(T.run("boom", {})); assert.equal(r.ok, false); assert.match(r.error, /kaboom/);
  T.skills.empty = function () {};
  var r2 = JSON.parse(T.run("empty", {})); assert.equal(r2.ok, false);
  assert.match(r2.error, /returned no result/, "a skill that returns nothing should say so plainly");
});

// The core safety rule: anything that edits a timeline runs only on a TOOLKIT COPY.
var EDITS = [
  ["link-external-audio", {}], ["sound-pass", { action: "set", clips: [] }], ["sound-pass", { action: "keys", clips: [] }],
  ["sound-pass", { action: "markers", spots: [] }], ["sound-pass", { action: "render", path: "/tmp/x.wav" }], ["sound-pass", { action: "bed", clips: [] }],
  ["sound-pass", { action: "addfx", clips: [] }],
  ["colour-baseline", { action: "setparam" }], ["colour-baseline", { action: "addplain" }],
  ["loudness-master", { action: "limit" }], ["loudness-master", { action: "marker" }],
  ["sync-external-audio", { action: "place", items: [] }]
];
EDITS.forEach(function (e) {
  test("refuses to edit a sequence that is not a TOOLKIT COPY: " + e[0] + " " + (e[1].action || ""), function () {
    var h = J.load([e[0]], { sequences: [{ name: "Episode 1 LIVE", layout: [{ kind: "video", track: 0, name: "A001", start: 0, end: 5 }, { kind: "audio", track: 0, name: "A001", start: 0, end: 5 }] }] });
    var r = JSON.parse(h.T.run(e[0], e[1]));
    assert.equal(r.ok, false, JSON.stringify(r).slice(0, 300));
    assert.match(r.error, /TOOLKIT COPY|not a MASTER|safe copy|copy/i, "refusal must say why: " + r.error);
    assert.deepEqual(h.P.mutations, [], "nothing changed before the refusal");
  });
});

test("Sync Interviews apply: works on a copy it makes itself, the scanned sequence is left alone", function () {
  var h = J.load(["interview-sync"], { sequences: [{ name: "IV Tod", id: "1", layout: [{ kind: "video", track: 0, name: "A001", start: 0, end: 5 }] }] });
  var before = h.T.fingerprint(h.P.project.sequences[0]);
  var r = JSON.parse(h.T.run("interview-sync", { action: "apply", sequenceId: "1", units: [] }));
  assert.equal(h.P.project.sequences[0].name, "IV Tod");
  assert.equal(h.T.fingerprint(h.P.project.sequences[0]).hash, before.hash);
  assert.ok(h.P.project.sequences.length === 2 && /TOOLKIT COPY|Synced|copy/i.test(h.P.project.sequences[1].name), h.P.project.sequences[1] && h.P.project.sequences[1].name);
  assert.deepEqual(h.P.mutations.filter(function (m) { return !/^(marker|linkSelection|unlinkSelection)$/.test(m); }), [], JSON.stringify(r).slice(0, 200));
  assert.match(JSON.parse(h.T.run("interview-sync", { action: "apply", sequenceId: "999" })).error, /scanned sequence is gone/);
});

test("Make safe copy: the 100th and later copies still get their own name (was a repeat of (99))", function () {
  var h = J.load(["make-safe-copy"], { sequences: [{ name: "S", id: "1" }] }), names = {};
  for (var k = 0; k < 120; k++) { h.P.project.activeSequence = h.P.project.sequences[0]; var r = JSON.parse(h.T.run("make-safe-copy", {})); assert.equal(r.ok, true, r.error); names[r.details.copyName] = 1; }
  assert.equal(Object.keys(names).length, 120);
});

// Found in the Premiere 27.0.0 run (20 Nov 2026): linkSelection() does nothing there, but the
// skill had already unlinked each camera clip from its own sound first, so every camera on
// the copy lost its picture/sound link. linkWorks=false behaves like 27.0.0.
function linkScene(linkWorks) {
  var lay = [];
  ["C001", "C002", "C003"].forEach(function (n, i) {
    var s = i * 20;
    lay.push({ kind: "video", track: 0, name: n + ".MP4", start: s, end: s + 10 }, { kind: "audio", track: 0, name: n + ".MP4", start: s, end: s + 10 },
      { kind: "audio", track: 1, name: "ZOOM0001.WAV", start: s + 1, end: s + 9 });
  });
  var h = J.load(["link-external-audio"], { sequences: [{ name: "Day 1 TOOLKIT COPY", layout: lay }] });
  var seq = h.P.project.sequences[0], groups = {}, x = { h: h, unlinks: 0 };
  function all() { var out = []; ["videoTracks", "audioTracks"].forEach(function (k) { for (var t = 0; t < seq[k].numTracks; t++) seq[k][t].clips.forEach(function (c) { out.push(c); }); }); return out; }
  function arr(items) { var a = h.inCtx("[]"); items.forEach(function (i) { a.push(i); }); a.numItems = a.length; return a; }
  var clips = x.clips = all();
  clips.forEach(function (c) { if (c.mediaType === "Video") { var g = [c, clips.filter(function (a) { return a.mediaType === "Audio" && a.name === c.name; })[0]]; g.forEach(function (m) { groups[m.nodeId] = g; }); } });
  clips.forEach(function (c) { c.getLinkedItems = function () { return arr((groups[c.nodeId] || []).filter(function (m) { return m !== c; })); }; });
  seq.getSelection = function () { return arr(all().filter(function (c) { return c._sel; })); };
  seq.unlinkSelection = function () { x.unlinks++; all().forEach(function (c) { if (c._sel) delete groups[c.nodeId]; }); return true; };
  seq.linkSelection = function () { if (linkWorks) { var g = all().filter(function (c) { return c._sel; }); g.forEach(function (m) { groups[m.nodeId] = g; }); } return true; };
  x.linkedToSound = function (name) { var v = clips.filter(function (c) { return c.name === name && c.mediaType === "Video"; })[0]; return (groups[v.nodeId] || []).length > 1; };
  return x;
}
test("link-external-audio: when Premiere's link does nothing, stop after the first clip and say so (do not unlink every camera)", function () {
  var x = linkScene(false);
  var r = JSON.parse(x.h.T.run("link-external-audio", {}));
  assert.equal(r.ok, false, JSON.stringify(r).slice(0, 400));
  assert.equal(x.unlinks, 1, "unlinked " + x.unlinks + " camera clips; only the first may be touched");
  assert.ok(x.linkedToSound("C002.MP4") && x.linkedToSound("C003.MP4"), "the other cameras must keep their sound link");
  assert.match(r.error, /link did nothing/i, r.error);
  assert.match(r.error, /C001\.MP4.*unlinked: select them and use Clip > Link/, r.error);
});
test("link-external-audio: with a working link every camera is linked to its sound and wav (unchanged behaviour)", function () {
  var x = linkScene(true);
  var r = JSON.parse(x.h.T.run("link-external-audio", {}));
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 400));
  assert.equal(r.details.linked.length, 3, JSON.stringify(r.details).slice(0, 400));
  assert.equal(x.unlinks, 3);
});
