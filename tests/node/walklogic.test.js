// skills/import-footage/walkLogic.js: what Ingest imports from a footage folder.
var test = require("node:test"), assert = require("node:assert/strict");
var fs = require("fs"), path = require("path");
var H = require("./helpers");
var W = require(path.join(H.ROOT, "skills", "import-footage", "walkLogic.js"));

function fsList(dir) {
  return Promise.resolve(fs.readdirSync(dir, { withFileTypes: true }).map(function (e) {
    return { name: e.name, isDir: e.isDirectory(), ref: path.join(dir, e.name) };
  }));
}
function mk(root, files) {
  files.forEach(function (f) { var p = path.join(root, f); fs.mkdirSync(path.dirname(p), { recursive: true }); if (!/\/$/.test(f)) fs.writeFileSync(p, "x"); });
}
async function walk(root) {
  var out = [];
  await W.walkTree(root, path.basename(root), fsList, function (item, segs) {
    out.push({ bin: segs.join("/"), type: item.type, file: item.file ? item.file.name : item.representativeFile ? item.representativeFile.name : null,
      wav: item.wav ? item.wav.name : null, kind: item.kind, msg: item.message, stills: item.asNumberedStills });
  });
  return out;
}

test("file type checks: case-insensitive, extensions only at the end", function () {
  assert.ok(W.isVideoFile("A001.MOV") && W.isVideoFile("x.r3d") && W.isVideoFile("clip.Mp4"));
  assert.ok(!W.isVideoFile("A001.MOV.xml") && !W.isVideoFile("movie") && !W.isVideoFile(""));
  assert.ok(W.isAudioFile("ZOOM0001.WAV") && W.isMediaFile("a.m4a") && !W.isMediaFile("photo.jpg"));
  assert.ok(!W.isMediaFile(".wav") === false, "a file called just .wav still has the extension");
});
test("isSkippedFolderName: whole words only", function () {
  ["Proxies", "NIKON_300426_Proxies", "GH5 - Proxy", "Exports", "Media Cache Files", "LUTS", "Auto-Save"].forEach(function (n) { assert.ok(W.isSkippedFolderName(n), n); });
  ["Approximate", "Day 1", "Reports", "Lutz", "Exported Day"].forEach(function (n) { assert.ok(!W.isSkippedFolderName(n), n); });
  assert.ok(!W.isSkippedFolderName(""));
});
test("baseName", function () {
  assert.equal(W.baseName("A001_C001.R3D"), "A001_C001"); assert.equal(W.baseName("noext"), "noext"); assert.equal(W.baseName("a.b.c"), "a.b");
});
test("mapConcurrent: keeps order, respects the limit, empty list", async function () {
  var now = 0, max = 0;
  var r = await W.mapConcurrent([5, 1, 3, 2], 2, async function (x) { now++; max = Math.max(max, now); await H.sleep(x * 5); now--; return x * 10; });
  assert.deepEqual(r, [50, 10, 30, 20]); assert.equal(max, 2);
  assert.deepEqual(await W.mapConcurrent([], 4, async function () { return 1; }), []);
});
test("walkTree: RED card collapses each .RDC to one clip with its unchunked wav", async function () {
  var d = H.tmpdir("red"), root = path.join(d, "Shoot Day 1 🎬");
  mk(root, ["A001_0826XX.RDM/A001_C001_0826XX.RDC/A001_C001_0826XX_002.R3D", "A001_0826XX.RDM/A001_C001_0826XX.RDC/A001_C001_0826XX_001.R3D",
    "A001_0826XX.RDM/A001_C001_0826XX.RDC/A001_C001_0826XX.wav", "A001_0826XX.RDM/A001_C002_0826XX.RDC/A001_C002_0826XX_001.R3D",
    "A001_0826XX.RDM/A001_C003_0826XX.RDC/readme.txt"]);
  var out = await walk(root);
  var clips = out.filter(function (o) { return o.type === "clip"; });
  assert.equal(clips.length, 2);
  assert.equal(clips[0].file, "A001_C001_0826XX_001.R3D", "first chunk is the one imported");
  assert.equal(clips[0].wav, "A001_C001_0826XX.wav");
  assert.equal(clips[1].wav, null);
  assert.equal(clips[0].bin, "Shoot Day 1 🎬/A001_0826XX.RDM", "clip lands in the bin of the folder above the .RDC");
  assert.equal(out.filter(function (o) { return o.type === "warning"; }).length, 1, "RDC with no R3D gives a warning");
});
test("walkTree: flat cameras, Audio sibling, skipped folders, stills and sidecars", async function () {
  var d = H.tmpdir("flat"), root = path.join(d, "Card");
  mk(root, ["FX6/C0001.MP4", "FX6/C0001M01.XML", "FX6/thumb.jpg", "Proxies/C0001_Proxy.mov", "Audio/ZOOM0001.WAV", "Exports/final.mov",
    "empty folder/", "Stills/img.CR3", "trailing space /clip.mov"]);
  var out = await walk(root);
  var files = out.map(function (o) { return o.bin + "|" + o.file; }).sort();
  assert.deepEqual(files, ["Card/Audio|ZOOM0001.WAV", "Card/FX6|C0001.MP4", "Card/trailing space |clip.mov"]);
});
test("walkTree: ARRIRAW frame folders become one numbered-stills clip", async function () {
  var d = H.tmpdir("arri"), root = path.join(d, "ARRI");
  mk(root, ["A001C001/A001C001.0000001.ari", "A001C001/A001C001.0000002.ari", "lone/one.ari"]);
  var out = await walk(root);
  var c = out.filter(function (o) { return o.type === "clip"; });
  assert.equal(c.length, 1); assert.equal(c[0].stills, true); assert.equal(c[0].kind, "arri_raw_sequence");
});
test("walkTree: orphan wavs in Audio beside a RED card are still imported", async function () {
  var d = H.tmpdir("orph"), root = path.join(d, "R");
  mk(root, ["X.RDC/X_001.R3D", "Audio/X.wav", "Audio/other take.wav"]);
  var out = await walk(root);
  assert.deepEqual(out.map(function (o) { return o.type + ":" + o.file + ":" + o.wav; }).sort(), ["clip:X_001.R3D:X.wav", "flat:other take.wav:null"]);
});
test("walkTree: a folder that cannot be listed rejects with that error", async function () {
  await assert.rejects(W.walkTree("/does/not/exist", "x", fsList, function () {}), /ENOENT/);
});
test("walkTree: hooks are called and an empty root gives nothing", async function () {
  var d = H.tmpdir("empty"), entered = [], doneN = [];
  await W.walkTree(d, "E", fsList, function () { throw new Error("no items expected"); }, { onEnterDir: function (s) { entered.push(s.join("/")); }, onDirDone: function (s, n) { doneN.push(n); } });
  assert.deepEqual(entered, ["E"]); assert.deepEqual(doneN, [0]);
});
