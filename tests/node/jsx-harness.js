// Runs Peny Toolkit ExtendScript (core/core.jsx + skills/*/premiere.jsx) inside Node with a
// small fake Premiere. Not Premiere: it checks the scripts' own logic (guards, naming, JSON,
// time maths) and records every call that would change a timeline, so tests can prove a
// guard stopped before any change. Real Premiere behaviour still needs Lee's hand tests.
var fs = require("fs"), path = require("path"), vm = require("vm");
var ROOT = path.join(__dirname, "..", "..");
var TPS = 254016000000;

function list(arr, countKey) { var o = arr.slice(); o[countKey] = arr.length; return o; }

function makePremiere(opts) {
  opts = opts || {};
  var mutations = [], nextId = 100;
  function mut(what) { mutations.push(what); }
  function clip(name, startSec, endSec, trackKind) {
    var c = { name: name, nodeId: "n" + (nextId++), start: { ticks: String(Math.round(startSec * TPS)), seconds: startSec },
      end: { ticks: String(Math.round(endSec * TPS)), seconds: endSec }, _sel: false, mediaType: trackKind === "audio" ? "Audio" : "Video",
      inPoint: { ticks: "0", seconds: 0 }, outPoint: { ticks: String(Math.round((endSec - startSec) * TPS)), seconds: endSec - startSec },
      components: list([], "numItems"), projectItem: { name: name, nodeId: "p" + nextId, getMediaPath: function () { return "/media/" + name; }, treePath: "\\root\\" + name },
      isSelected: function () { return this._sel; },
      setSelected: function (v) { this._sel = !!v; },
      getLinkedItems: function () { return list([], "numItems"); },
      remove: function () { mut("remove " + name); }, move: function () { mut("move " + name); }, setInPoint: function () { mut("in " + name); },
      setOutPoint: function () { mut("out " + name); }, setStartTime: function () { mut("start " + name); }, setEndTime: function () { mut("end " + name); } };
    return c;
  }
  function seq(name, id, layout) {
    var mkTracks = function (kind, n) {
      var ts = []; for (var t = 0; t < n; t++) ts.push({ name: (kind === "video" ? "V" : "A") + (t + 1), clips: list([], "numItems"), id: t,
        isMuted: function () { return false; }, setMute: function () { mut("mute"); }, isLocked: function () { return false; },
        insertClip: function () { mut("insertClip"); }, overwriteClip: function () { mut("overwriteClip"); } });
      return list(ts, "numTracks");
    };
    var s = { name: name, sequenceID: id, timebase: String(TPS / 25), videoTracks: mkTracks("video", 2), audioTracks: mkTracks("audio", 3),
      end: String(600 * TPS), zeroPoint: "0", projectItem: { name: name, nodeId: "sp" + id },
      markers: { numMarkers: 0, createMarker: function () { mut("marker"); return { setColorByIndex: function () {} }; }, getFirstMarker: function () { return undefined; } },
      linkSelection: function () { mut("linkSelection"); return true; }, unlinkSelection: function () { mut("unlinkSelection"); return true; },
      getSelection: function () { return []; }, setInPoint: function () { mut("seq in"); }, setOutPoint: function () { mut("seq out"); },
      getPlayerPosition: function () { return { ticks: "0", seconds: 0 }; }, setPlayerPosition: function () {},
      clone: function () { if (opts.cloneFails) return false; var c = seq(name + " Copy", String(nextId++), []); copyClips(s, c); P.project.sequences.push(c); P.project.sequences.numSequences = P.project.sequences.length; return true; },
      getSettings: function () { return { videoFrameRate: { seconds: 0.04 } }; } };
    (layout || []).forEach(function (l) {
      var tr = (l.kind === "audio" ? s.audioTracks : s.videoTracks)[l.track];
      tr.clips.push(clip(l.name, l.start, l.end, l.kind)); tr.clips.numItems = tr.clips.length;
    });
    return s;
  }
  function copyClips(from, to) {
    ["videoTracks", "audioTracks"].forEach(function (k) {
      for (var t = 0; t < from[k].numTracks; t++) from[k][t].clips.forEach(function (c) {
        var n = clip(c.name, c.start.seconds, c.end.seconds, k === "audioTracks" ? "audio" : "video");
        to[k][t].clips.push(n); to[k][t].clips.numItems = to[k][t].clips.length;
      });
    });
  }
  var P = { mutations: mutations, seq: seq, clip: clip };
  var seqs = list((opts.sequences || []).map(function (s, i) { return seq(s.name, s.id || String(i + 1), s.layout); }), "numSequences");
  P.project = {
    name: "TEST.prproj", path: "/Users/test/TEST.prproj", sequences: seqs,
    activeSequence: seqs[opts.active || 0] || null,
    rootItem: { name: "root", children: list([], "numItems"), createBin: function () { mut("createBin"); return { children: list([], "numItems") }; } },
    openSequence: function (id) { for (var i = 0; i < seqs.length; i++) if (seqs[i].sequenceID === id) { P.project.activeSequence = seqs[i]; return true; } return false; },
    importFiles: function () { mut("importFiles"); return true; }, save: function () { mut("SAVE"); }, saveAs: function () { mut("SAVE"); },
    createNewSequence: function () { mut("createNewSequence"); }, getInsertionBin: function () { return P.project.rootItem; }
  };
  P.app = { project: P.project, projects: list([P.project], "numProjects"), version: "26.0", encoder: null,
    enableQE: function () {}, setSDKEventMessage: function () {} };
  return P;
}

function FakeFile(p) { this.fsName = String(p).replace(/^~/, "/home/qa"); this.path = this.fsName; this.name = path.basename(this.fsName); this.exists = fs.existsSync(this.fsName); }
FakeFile.prototype.open = function () { return false; }; // no writes from tests (T.log is a no-op here)
FakeFile.prototype.close = function () {}; FakeFile.prototype.writeln = function () {}; FakeFile.prototype.write = function () {}; FakeFile.prototype.read = function () { return ""; };
FakeFile.prototype.remove = function () { return false; };
function FakeFolder(p) { this.fsName = String(p); this.exists = fs.existsSync(this.fsName); }
FakeFolder.prototype.create = function () { return true; }; FakeFolder.prototype.getFiles = function () { return []; };

// Loads core.jsx plus the given skill files into a fresh context. Returns { T, P, ctx }.
function load(skillIds, premiereOpts) {
  var P = makePremiere(premiereOpts);
  var ctx = { app: P.app, File: function (p) { return new FakeFile(p); }, Folder: function (p) { return new FakeFolder(p); },
    qe: undefined, $: { global: null, sleep: function () {}, evalFile: function () {}, writeln: function () {}, os: "Macintosh OS 15.0", fileName: "" } };
  ctx.Folder.current = new FakeFolder("/tmp"); ctx.File.fs = "Macintosh"; ctx.Folder.temp = new FakeFolder("/tmp");
  ctx.$.global = ctx;
  vm.createContext(ctx);
  function run(file) { vm.runInContext(fs.readFileSync(file, "utf-8"), ctx, { filename: file }); }
  run(path.join(ROOT, "core", "core.jsx"));
  (skillIds || []).forEach(function (id) { run(path.join(ROOT, "skills", id, "premiere.jsx")); });
  // Values made inside the script's own world (arrays from Node fail `instanceof Array` there).
  function inCtx(js) { return vm.runInContext("(" + js + ")", ctx); }
  return { T: ctx.PenyToolkit, P: P, ctx: ctx, inCtx: inCtx };
}

module.exports = { load: load, makePremiere: makePremiere, TPS: TPS, ROOT: ROOT };
