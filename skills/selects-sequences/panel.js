/* Selects sequences, panel side (Node). Two buttons:
 * - Scan footage: reads the footage root bin (premiere.jsx "scan"): its Day bins, the source bins
 *   in each day and their clips. Draws the choices under the buttons: the blocks (one per camera
 *   or source, by the bin name before "_": KX, R5, Others, LIVE, Audio...) in the order they go on
 *   the timeline, each with a label (the marker name), a colour and on/off; clips that sit in two
 *   days, with which day they belong to; and what will be made. Choices are remembered in
 *   ~/.peny-toolkit/selects-sequences.json.
 * - Build Selects sequences: scans again (stops if the bins changed), then for each day makes
 *   "<Project> Day NN_Selects UNCUT" (every clip of the day, one block per source back to back,
 *   a gap between blocks, a span marker named with the label over each block) and an empty
 *   "<Project> Day NN_Selects", files them in 01 SEQUENCES/Selects(/UNCUT) and checks each
 *   sequence clip by clip from Premiere. Recorder wavs (audio-only clips) go on a new audio track
 *   under the camera tracks. Sequences that already exist are left alone. Nothing is saved.
 * Lee's spec (23 Oct 2026, from the FMD Maribor, Team Camp, Whistler and Lake Placid runs):
 * 10 s gaps, UHD 2160p 25 fps, green markers, never rename clips, never guess. */
var fs = require("fs");
var path = require("path");
var os = require("os");

var camera = require(path.join(__dirname, "..", "..", "core", "camera.js"));
var shootdate = require(path.join(__dirname, "..", "..", "core", "shootdate.js"));
var DATE_CACHE = path.join(os.homedir(), ".peny-toolkit", "selects-dates.json");
var FFPROBE = [path.join(os.homedir(), "Library", "Application Support", "PenyToolkit", "bin", "ffprobe"), "/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe"];
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
var CLOCK_DAYS = 365; // a camera date this far before the newest clip's is a camera clock that was never set
var SETTINGS = path.join(os.homedir(), ".peny-toolkit", "selects-sequences.json");
var CAMERA_CACHE = path.join(os.homedir(), ".peny-toolkit", "selects-cameras.json");
var BATCH = 25; // clips per Premiere call, so the panel stays responsive and Cancel works between calls
var DEFAULT_LABELS = { KX: "Komodo", KOMODO: "Komodo", RAPTOR: "Raptor", R5: "R5", OTHERS: "Others", LIVE: "LIVE", AUDIO: "Audio" };
// Premiere's marker colours by index (Marker.setColorByIndex).
var COLOURS = [
  { name: "Green", css: "#30d158" }, { name: "Red", css: "#ff453a" }, { name: "Purple", css: "#bf5af2" }, { name: "Orange", css: "#ff9f0a" },
  { name: "Yellow", css: "#ffd60a" }, { name: "White", css: "#ffffff" }, { name: "Blue", css: "#0a84ff" }, { name: "Cyan", css: "#64d2ff" }];
var PRESET_NAME = "UHD (4K) 2160p 25 fps.sqpreset"; // what the bridge's create_sequence uses (Mac mini, 26.5.2)

function readSettings() {
  try { var s = JSON.parse(fs.readFileSync(SETTINGS, "utf-8")); ["labels", "include", "colours", "dups"].forEach(function (k) { s[k] = s[k] || {}; }); s.order = s.order || []; return s; }
  catch (e) { return { labels: {}, include: {}, colours: {}, dups: {}, order: [] }; }
}
function writeSettings(s) {
  try { fs.mkdirSync(path.dirname(SETTINGS), { recursive: true }); fs.writeFileSync(SETTINGS + ".tmp", JSON.stringify(s, null, 1)); fs.renameSync(SETTINGS + ".tmp", SETTINGS); } catch (e) {}
}

// The sequence preset: Premiere's own UHD 2160p 25 fps preset, found in this Mac's Premiere app
// (newest version first), else in the user's custom presets.
function findPreset(dirs) {
  var hits = [], near = [];
  function walk(dir, depth) {
    var list = [];
    try { list = fs.readdirSync(dir); } catch (e) { return; }
    list.forEach(function (n) {
      if (n.charAt(0) === ".") return;
      var p = path.join(dir, n), st = null;
      try { st = fs.statSync(p); } catch (e) { return; }
      if (st.isDirectory()) { if (depth < 6) walk(p, depth + 1); }
      else if (n === PRESET_NAME) hits.push(p);
      else if (/\.sqpreset$/i.test(n) && /2160p/i.test(n) && /\b25\b/.test(n) && !/(DCI|4096|HDR|vertical)/i.test(n)) near.push(p);
    });
  }
  (dirs || presetDirs()).forEach(function (d) { if (!hits.length) walk(d, 0); });
  // A Premiere version that names it differently: another UHD 2160p 25 fps preset (the frame size
  // and rate are checked on every sequence made).
  return hits[0] || near.sort()[0] || null;
}
function presetDirs() {
  var out = [];
  try {
    fs.readdirSync("/Applications").filter(function (n) { return /^Adobe Premiere Pro \d{4}$/.test(n); }).sort().reverse().forEach(function (n) {
      out.push(path.join("/Applications", n, n + ".app", "Contents", "Settings", "SequencePresets"));
      out.push(path.join("/Applications", n, n + ".app", "Contents", "Settings"));
    });
  } catch (e) {}
  out.push(path.join(os.homedir(), "Documents", "Adobe", "Premiere Pro"));
  return out;
}

function pad2(n) { return (n < 10 ? "0" : "") + n; }
function plural(n, w) { return n + " " + w + (n === 1 ? "" : "s"); }
function fmtFrames(f, fps) {
  var s = f / fps, h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s - h * 3600 - m * 60;
  return h + ":" + pad2(m) + ":" + (r < 10 ? "0" : "") + r.toFixed(2);
}

// Plan from a scan + choices: per day the blocks in order, with their clips. Pure, so the test
// harness can check it without Premiere.
function makePlan(scan, choice) {
  scan = view(scan, choice);
  var prefixes = blockKeys(scan, choice), problems = [], notes = (scan.dateNotes || []).slice();
  var included = prefixes.filter(function (k) { return choice.include[k] !== false; });
  // Clips with the same name in two days (Whistler R5 C344-C351): the day each belongs to.
  var dupDays = duplicates(scan, included), unresolved = [];
  if (choice.dupsAll) Object.keys(dupDays).forEach(function (n) { choice.dups[n] = pickDup(dupDays[n], choice.dupsAll); });
  Object.keys(dupDays).forEach(function (name) {
    var c = choice.dups[name];
    if (!c || (c !== "both" && dupDays[name].indexOf(c) === -1)) unresolved.push(name + " (" + dupDays[name].map(function (k) { return groupTitle(scan, k, choice); }).join(", ") + ")");
  });
  if (unresolved.length) problems.push(plural(unresolved.length, "clip") + (unresolved.length === 1 ? " sits" : " sit") + " in two groups; choose the group for each: " + unresolved.slice(0, 12).join("; ") + (unresolved.length > 12 ? "…" : ""));
  var name = String(choice.project || "").replace(/^\s+|\s+$/g, "");
  if (!name) problems.push("No project name for the sequence names.");
  var days = scan.days.map(function (d) {
    var blocks = [];
    included.forEach(function (k) {
      var srcs = d.sources.filter(function (s) { return s.prefix.toUpperCase() === k; });
      if (!srcs.length) return;
      var clips = [];
      srcs.forEach(function (s) {
        s.clips.forEach(function (c) {
          var dc = choice.dups[c.name];
          if (dupDays[c.name] && dc && dc !== "both" && dc !== d.label) return;
          clips.push({ nodeId: c.nodeId, name: c.name, path: c.path, audioOnly: !!c.audioOnly, offline: !!c.offline, fps: c.fps, channels: c.channels || null, bin: s.bin + (c.sub ? "/" + c.sub : "") });
        });
      });
      if (!clips.length) return;
      if (srcs.length > 1 && !srcs[0].byCamera) notes.push(groupTitle(scan, d.label, choice) + ": " + srcs.map(function (s) { return s.bin; }).join(" + ") + " make one " + label(k, choice) + " block.");
      blocks.push({ key: k, label: label(k, choice), colour: colourOf(k, choice), bins: srcs.map(function (s) { return s.bin; }), clips: clips });
    });
    var offline = [];
    blocks.forEach(function (b) { b.clips.forEach(function (c) { if (c.offline) offline.push(c.name); }); });
    var title = groupTitle(scan, d.label, choice);
    if (offline.length) problems.push(title + ": " + plural(offline.length, "clip") + " offline (" + offline.slice(0, 8).join(", ") + (offline.length > 8 ? "…" : "") + "). Relink or switch that block off first.");
    if (d.loose.length) notes.push(title + ": " + plural(d.loose.length, "clip") + (d.loose.length === 1 ? " sits" : " sit") + " directly in " + d.bin + ", not in a camera bin; they are left out.");
    var uncut = name + " " + title + "_Selects UNCUT", selects = name + " " + title + "_Selects";
    return { day: d.day, label: d.label, title: title, defaultTitle: d.title, binTitle: d.binTitle || d.bin, bin: d.bin, blocks: blocks, uncut: uncut, selects: selects,
      uncutExists: scan.sequences.indexOf(uncut) !== -1, selectsExists: scan.sequences.indexOf(selects) !== -1,
      clips: blocks.reduce(function (a, b) { return a + b.clips.length; }, 0),
      audioOnly: blocks.reduce(function (a, b) { return a + b.clips.filter(function (c) { return c.audioOnly; }).length; }, 0),
      offGrid: blocks.reduce(function (a, b) { return a + b.clips.filter(function (c) { return !c.audioOnly && c.fps && Math.abs(c.fps - 25) > 0.001; }).length; }, 0) };
  });
  if (!included.length) problems.push("Every block is switched off.");
  return { days: days, problems: problems, notes: notes, prefixes: prefixes, duplicates: dupDays };
}
// Blocks by camera (Lee, 23 Oct 2026): each group's clips split by the camera read from the files,
// so bins named B ROLE / PITS or a card number still give one block per camera. Clips whose file
// names no camera (audio, phones, screen grabs) stay in a block named after their bin.
function view(scan, choice) {
  if (choice.groupBy === "date") scan = byDate(scan);
  if (choice.blockBy !== "camera") return scan;
  var out = {}; for (var k in scan) if (scan.hasOwnProperty(k)) out[k] = scan[k];
  out.days = scan.days.map(function (d) {
    var g = {}; for (var x in d) if (d.hasOwnProperty(x)) g[x] = d[x];
    var by = {}, order = [];
    d.sources.forEach(function (s) {
      s.clips.forEach(function (c) {
        var key = c.camera || s.prefix;
        if (!by[key]) { by[key] = { bin: s.bin, bins: [], prefix: key, nodeId: s.nodeId, clips: [], audio: 0, byCamera: !!c.camera }; order.push(key); }
        if (by[key].bins.indexOf(s.bin) === -1) by[key].bins.push(s.bin);
        by[key].clips.push(c);
        if (c.audioOnly) by[key].audio++;
      });
    });
    g.sources = order.map(function (k2) {
      var b = by[k2];
      return { bin: b.bins.join(" + "), nodeId: b.nodeId, prefix: b.prefix, clips: b.clips, byCamera: b.byCamera,
        kind: b.audio === b.clips.length ? "audio" : b.audio ? "mixed" : "video" };
    });
    return g;
  });
  return out;
}
// Groups by shoot date (Lee, 6 Nov 2026): every clip whose camera date is the same day goes in one
// group, whatever bin it sits in; different days are different groups ("Day 01 (26 Aug)", in date
// order). Each clip keeps its source bin, so blocks are made as before. Clips with no date, or a
// camera clock that was never set (World Champs KX: 9 Mar 2018), go in one "No date" group.
// The same file in two bins (same name, size and time) is placed once.
function dayKey(c, newest) {
  if (!c.shootDay) return null;
  var t = function (d) { return Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)); };
  return newest && (t(newest) - t(c.shootDay)) / 86400000 > CLOCK_DAYS ? null : c.shootDay;
}
function byDate(scan) {
  if (scan.byDate) return scan;
  var newest = null, all = [];
  scan.days.forEach(function (d) {
    d.sources.forEach(function (s) { s.clips.forEach(function (c) { all.push({ c: c, s: s, d: d }); }); });
    (d.loose || []).forEach(function (c) { all.push({ c: c, s: null, d: d }); });
  });
  all.forEach(function (x) { if (x.c.shootDay && (!newest || x.c.shootDay > newest)) newest = x.c.shootDay; });
  var groups = {}, keys = [], seen = {}, twice = [], clock = {}, none = 0;
  all.forEach(function (x) {
    var c = x.c, key = dayKey(c, newest) || "none";
    if (c.size !== null && c.size !== undefined && c.shootTime) {
      var id = c.name + "|" + c.size + "|" + c.shootDay + c.shootTime;
      if (seen[id]) { twice.push(c.name + " (" + seen[id] + " and " + (x.s ? x.s.bin : x.d.bin) + ")"); return; }
      seen[id] = x.s ? x.s.bin : x.d.bin;
    }
    if (key === "none") { if (c.shootDay) { var ck = (c.camera || (x.s ? x.s.bin : x.d.bin)) + " (camera date " + fmtDay(c.shootDay, true) + ")"; clock[ck] = (clock[ck] || 0) + 1; } else none++; }
    if (!groups[key]) { groups[key] = { key: key, sources: [], bySrc: {}, loose: [], bins: [] }; keys.push(key); }
    var g = groups[key], bin = x.d.bin;
    if (g.bins.indexOf(bin) === -1) g.bins.push(bin);
    if (!x.s) { g.loose.push(c); return; }
    var sk = x.d.nodeId + "/" + x.s.nodeId;
    if (!g.bySrc[sk]) { g.bySrc[sk] = { bin: x.s.bin, nodeId: x.s.nodeId, prefix: x.s.prefix, kind: x.s.kind, clips: [] }; g.sources.push(g.bySrc[sk]); }
    g.bySrc[sk].clips.push(c);
  });
  keys.sort(function (a, b) { return a === "none" ? 1 : b === "none" ? -1 : a < b ? -1 : 1; });
  var out = {}; for (var k in scan) if (scan.hasOwnProperty(k)) out[k] = scan[k];
  var n = 0;
  out.days = keys.map(function (key) {
    var g = groups[key], dated = key !== "none";
    if (dated) n++;
    g.sources.forEach(function (s) { var a = s.clips.filter(function (c) { return c.audioOnly; }).length; s.kind = a === s.clips.length ? "audio" : a ? "mixed" : "video"; });
    return { bin: g.bins.join(" + "), nodeId: null, day: dated ? n : null, label: dated ? "d" + key : "nodate", date: dated ? key : null,
      title: dated ? "Day " + (n < 10 ? "0" : "") + n + " (" + fmtDay(key) + ")" : "No date", sources: g.sources, loose: g.loose, skipped: [] };
  });
  out.byDate = true;
  out.dateNotes = [];
  Object.keys(clock).forEach(function (k) { out.dateNotes.push(k + ": " + plural(clock[k], "clip") + (clock[k] === 1 ? " carries" : " carry") + " a camera date long before the rest (the camera clock was not set), so they go in No date."); });
  if (none) out.dateNotes.push(plural(none, "clip") + (none === 1 ? " has" : " have") + " no recording date in the file, so they go in No date.");
  if (twice.length) out.dateNotes.push(plural(twice.length, "clip") + (twice.length === 1 ? " is" : " are") + " the same file in two bins and are placed once: " + twice.slice(0, 6).join("; ") + (twice.length > 6 ? "…" : "") + ".");
  return out;
}
function fmtDay(d, year) { return +d.slice(6, 8) + " " + MONTHS[+d.slice(4, 6) - 1] + (year ? " " + d.slice(0, 4) : ""); }
// Cameras in a list of clips, most clips first: "Sony FX30 x42, not found x2".
function cameraText(clips) {
  var n = {}, keys = [];
  clips.forEach(function (c) { if (c.audioOnly) return; var k = c.camera || "camera not found in file"; if (!n[k]) { n[k] = 0; keys.push(k); } n[k]++; });
  keys.sort(function (a, b) { return n[b] - n[a]; });
  return keys.map(function (k) { return k + " x" + n[k]; }).join(", ");
}
// Block keys (bin prefix, upper case) in timeline order: the saved order, then new ones in the
// order the bins first appear, audio-only sources last.
function blockKeys(scan, choice) {
  var seen = {}, video = [], audio = [];
  scan.days.forEach(function (d) {
    d.sources.forEach(function (s) {
      var k = s.prefix.toUpperCase();
      if (seen[k]) { if (s.kind !== "audio") seen[k].audio = false; return; }
      seen[k] = { audio: s.kind === "audio" };
      (s.kind === "audio" ? audio : video).push(k);
    });
  });
  var keys = video.concat(audio).filter(function (k, i, a) { return a.indexOf(k) === i; });
  var saved = (choice.order || []).filter(function (k) { return seen[k]; });
  return saved.concat(keys.filter(function (k) { return saved.indexOf(k) === -1; }));
}
// A group's name in the sequence names: what Lee typed for it, else "Day 00" for a day bin or the
// bin's own name.
function groupTitle(scan, key, choice) {
  var g = null;
  scan.days.forEach(function (d) { if (d.label === key) g = d; });
  var typed = choice.names && choice.names[key];
  return typed || (g ? g.title : key);
}
function label(k, choice) {
  if (choice.labels[k]) return choice.labels[k];
  return DEFAULT_LABELS[k] || prefixShown(k, choice);
}
function prefixShown(k, choice) { return (choice.shown && choice.shown[k]) || k; }
function colourOf(k, choice) { var c = choice.colours[k]; return c === undefined || c === null ? 0 : Number(c); }
// One answer for every clip in two groups: "first" / "last" group (scan order), "both", or a group label.
function pickDup(groups, how) {
  if (how === "both") return "both";
  if (how === "first") return groups[0];
  if (how === "last") return groups[groups.length - 1];
  return groups.indexOf(how) !== -1 ? how : undefined;
}
function duplicates(scan, included) {
  var where = {};
  scan.days.forEach(function (d) {
    d.sources.forEach(function (s) {
      if (included.indexOf(s.prefix.toUpperCase()) === -1) return;
      s.clips.forEach(function (c) { (where[c.name] = where[c.name] || []).push(d.label); });
    });
  });
  var out = {};
  Object.keys(where).forEach(function (n) {
    var days = where[n].filter(function (v, i, a) { return a.indexOf(v) === i; });
    if (days.length > 1) out[n] = days;
  });
  return out;
}

// Checks one built UNCUT sequence against what was placed (read back from Premiere).
function verify(rb, built, gap) {
  var problems = [], fps = rb.fps;
  if (rb.width !== 3840 || rb.height !== 2160) problems.push("frame size is " + rb.width + "x" + rb.height + ", not 3840x2160");
  if (Math.abs(fps - 25) > 0.001) problems.push("frame rate is " + fps + " fps, not 25");
  // Every placed clip where it was read back at placing, and nothing else on the tracks.
  var want = {}, seen = {};
  built.items.forEach(function (it) { want[it.nodeId + "@" + it.frame] = it; });
  function scanTracks(list, kind) {
    list.forEach(function (rows, t) {
      rows.forEach(function (r) {
        var key = r[2] + "@" + Math.round(r[0]), it = want[key];
        if (!it) { problems.push("unexpected clip on " + kind + (t + 1) + " at " + fmtFrames(r[0], fps)); return; }
        if (Math.floor(r[1] + 1e-6) !== it.endFrame && kind === "V") problems.push(it.name + " ends at " + fmtFrames(r[1], fps) + " not " + fmtFrames(it.endFrame, fps));
        seen[key] = (seen[key] || []).concat(kind + (t + 1));
      });
    });
  }
  scanTracks(rb.video, "V");
  scanTracks(rb.audio, "A");
  built.items.forEach(function (it) {
    var on = seen[it.nodeId + "@" + it.frame] || [];
    if (!on.length) problems.push(it.name + " is missing from the timeline");
    if (it.audioOnly && on.some(function (x) { return x.charAt(0) === "V" || (built.extraTrack !== null && x !== "A" + (built.extraTrack + 1)); })) problems.push(it.name + " (audio only) is on " + on.join(", "));
    if (!it.audioOnly && built.extraTrack !== null && on.indexOf("A" + (built.extraTrack + 1)) !== -1) problems.push(it.name + " camera audio landed on the recorder track A" + (built.extraTrack + 1));
  });
  // Blocks back to back inside, the gap between them, a marker over each.
  var prevEnd = null;
  built.blocks.forEach(function (b, i) {
    if (i > 0 && b.start - prevEnd !== gap) problems.push("gap before " + b.label + " is " + (b.start - prevEnd) + " frames, not " + gap);
    var f = b.start;
    b.items.forEach(function (it) { if (it.frame !== f) problems.push(it.name + " starts at frame " + it.frame + ", expected " + f); f = it.endFrame; });
    if (f !== b.end) problems.push(b.label + " block ends at frame " + f + " not " + b.end);
    prevEnd = b.end;
    var mk = rb.markers.filter(function (m) { return m.name === b.label && Math.abs(m.start - b.start) < 0.5 && Math.abs(m.end - b.end) < 0.5; });
    if (mk.length !== 1) problems.push("marker \"" + b.label + "\" over " + fmtFrames(b.start, fps) + "-" + fmtFrames(b.end, fps) + " found " + mk.length + " times");
  });
  if (rb.markers.length !== built.blocks.length) problems.push(rb.markers.length + " markers, expected " + built.blocks.length);
  var v1 = (rb.video[0] || []).length;
  return { ok: !problems.length, problems: problems, v1Clips: v1, end: prevEnd, endText: prevEnd === null ? "" : fmtFrames(prevEnd, fps),
    perTrack: rb.audio.map(function (r, i) { return "A" + (i + 1) + ":" + r.length; }).concat(rb.video.map(function (r, i) { return "V" + (i + 1) + ":" + r.length; })) };
}

module.exports = function (api) {
  var busy = null, cancelled = false, root = null;
  var state = { scan: null, plan: null, choice: null };

  // After a scan every call names that project, so a click into another project during a build
  // cannot send clips there (making sequences and tracks still needs it in front; those calls check).
  var target = null;
  function jsx(p) { if (target && p.action !== "scan") p.projectPath = target; return api.evalSkill(p); }
  function need(r, what) { if (!r || !r.ok) throw new Error((what ? what + ": " : "") + (r && r.error ? r.error : "no answer from Premiere")); return r.details; }

  function choiceFrom(params, scan) {
    var s = readSettings();
    var pp = (s.projects || {})[scan.project.path] || {};
    var c = { project: params.project || "", groupBy: params.groupBy || pp.groupBy || "date", blockBy: params.blockBy || pp.blockBy || "bin", names: pp.names || {}, labels: s.labels, include: pp.include || {}, colours: s.colours, dups: s.dups, order: pp.order || s.order, shown: {}, path: scan.project.path };
    scan.days.forEach(function (d) { d.sources.forEach(function (x) {
      c.shown[x.prefix.toUpperCase()] = x.prefix;
      x.clips.forEach(function (cl) { if (cl.camera) c.shown[cl.camera.toUpperCase()] = cl.camera; });
    }); });
    // Test hook / overrides.
    ["labels", "include", "colours", "dups", "names"].forEach(function (k) { if (params[k]) for (var x in params[k]) if (params[k].hasOwnProperty(x)) c[k][x] = params[k][x]; });
    if (params.order) c.order = params.order;
    if (params.dupsAll) c.dupsAll = params.dupsAll;
    if (!c.project) c.project = String(scan.project.name).replace(/\.prproj$/i, "");
    return c;
  }
  function save(choice) {
    var s = readSettings();
    // Labels and colours follow the camera everywhere; order and which blocks are in are per project
    // (the order has been different on every project so far). The last order is the default for a new one.
    s.labels = choice.labels; s.colours = choice.colours; s.dups = choice.dups; s.order = choice.order;
    s.projects = s.projects || {};
    s.projects[choice.path] = { order: choice.order, include: choice.include, names: choice.names, blockBy: choice.blockBy, groupBy: choice.groupBy };
    writeSettings(s);
  }

  function doScan(params) {
    var scan;
    return jsx({ action: "scan", bin: params.bin || "" }).then(function (r) {
      scan = need(r);
      var all = [];
      scan.days.forEach(function (d) { d.sources.forEach(function (s) { all = all.concat(s.clips); }); });
      return camera.detect(all, { cacheFile: CAMERA_CACHE, status: function (t) { api.status("Selects: " + t); } }).then(function () {
        scan.days.forEach(function (d) { all = all.concat(d.loose || []); });
        var ffprobe = null; FFPROBE.forEach(function (f) { if (!ffprobe && fs.existsSync(f)) ffprobe = f; });
        return shootdate.detect(all, { cacheFile: DATE_CACHE, ffprobe: ffprobe, status: function (t) { api.status("Selects: " + t); } });
      });
    }).then(function () {
      nameGroupsByCamera(scan);
      target = scan.project.path;
      var choice = choiceFrom(params, scan);
      state = { scan: scan, choice: choice, plan: makePlan(scan, choice), preset: params.preset || findPreset(), params: { bin: params.bin || "", project: params.project || "", gap: params.gap } };
      return state;
    });
  }

  // A card or camera bin that is not a day, holding one camera's clips, is named after that camera
  // to start with ("Sony FX30" instead of "FMD ORBEA Cannonball 2026 SONY FX30 SLOG 3 5200k"), unless
  // two groups would get the same name. Lee can still type his own.
  function nameGroupsByCamera(scan) {
    var want = scan.days.map(function (d) {
      if (d.day !== null && d.day !== undefined) return null;
      var cams = {}, all = true;
      d.sources.forEach(function (s) { s.clips.forEach(function (c) { if (c.audioOnly) return; if (c.camera) cams[c.camera] = 1; else all = false; }); });
      var k = Object.keys(cams);
      return all && k.length === 1 ? k[0] : null;
    });
    scan.days.forEach(function (d, i) {
      if (!want[i] || want.filter(function (w) { return w === want[i]; }).length > 1) return;
      d.binTitle = d.title; d.title = want[i];
    });
  }

  function summary(st) {
    var pl = st.plan, total = 0;
    var lines = pl.days.map(function (d) {
      total += d.clips;
      return d.title + ": " + (d.blocks.map(function (b) { return b.label + " " + b.clips.length; }).join(", ") || "nothing") +
        (d.uncutExists ? " (UNCUT already exists, skipped)" : "");
    });
    return { text: plural(pl.days.length, "group") + ", " + plural(total, "clip") + " in \"" + st.scan.root.path + "\". " + lines.join("; ") + ".", total: total };
  }

  function scanAction(params) {
    return doScan(params).then(function (st) {
      render();
      var s = summary(st);
      return { ok: true, summary: s.text + (st.plan.problems.length ? " To sort first: " + st.plan.problems.join(" ") : ""),
        details: { project: st.scan.project, root: st.scan.root, preset: findPreset(), problems: st.plan.problems, notes: st.plan.notes,
          blockBy: st.choice.blockBy, groupBy: st.choice.groupBy,
          blocks: st.plan.prefixes.map(function (k) { return { key: k, label: label(k, st.choice), on: st.choice.include[k] !== false, colour: colourOf(k, st.choice) }; }),
          cameras: view(st.scan, st.choice).days.map(function (d) { return { group: d.title, bin: d.bin, sources: d.sources.map(function (s) { return { bin: s.bin, cameras: cameraText(s.clips) }; }) }; }),
          duplicates: st.plan.duplicates,
          days: st.plan.days.map(function (d) { return { day: d.label, title: d.title, bin: d.bin, uncut: d.uncut, selects: d.selects, uncutExists: d.uncutExists, selectsExists: d.selectsExists, clips: d.clips,
            audioOnly: d.audioOnly, not25fps: d.offGrid, blocks: d.blocks.map(function (b) { return { label: b.label, bins: b.bins, clips: b.clips.length }; }) }; }) } };
    });
  }

  function progress(done, total, label, t0, finished, failed) {
    var frac = total ? done / total : 1, el = (Date.now() - t0) / 1000, left = done > 3 && !finished ? el / done * (total - done) : null;
    api.progress({ unit: "clips", title: "Selects", total: total, finished: done, ok: done, failed: failed ? 1 : 0, running: finished ? 0 : 1, queued: 0,
      cancelled: !!(finished && cancelled), paused: false, fraction: frac, percent: Math.floor(frac * 1000) / 10, event: finished ? "finished" : "tick",
      eta: finished ? { state: cancelled ? "cancelled" : "done" } : left === null ? { state: "estimating", jobs: [{ label: label, fraction: frac }] } :
        { state: "ok", seconds: Math.round(left), finishAt: Date.now() + left * 1000, raw: Math.round(left), jobs: [{ label: label, fraction: frac, seconds: Math.round(left) }] } });
  }

  // Builds one day's UNCUT: blocks back to back with the gap between, a marker over each block.
  function buildDay(d, preset, gapSec, counter) {
    var built = { name: d.uncut, id: null, blocks: [], items: [], extraTrack: null, notes: [] }, gap = 0;
    return jsx({ action: "create", name: d.uncut, preset: preset }).then(function (r) {
      var info = need(r, d.uncut);
      built.id = info.id;
      built.settings = info;
      counter.current = d.uncut;
      // Gap in whole frames of the new sequence (10 s = 250 frames at 25 fps).
      gap = built.gapFrames = Math.round(gapSec * info.fps);
      if (!d.audioOnly) return null;
      var wavs = [];
      d.blocks.forEach(function (b) { b.clips.forEach(function (c) { if (c.audioOnly) wavs.push(c); }); });
      // QE audio track type 0 = mono; a stereo wav needs a stereo track (1).
      var stereo = wavs.some(function (c) { return c.channels && c.channels.type === 1; });
      return jsx({ action: "track", sequenceId: built.id, kind: stereo ? 1 : 0 }).then(function (t) {
        built.extraTrack = need(t, d.uncut + " recorder track").index;
        built.extraTrackKind = stereo ? "stereo" : "mono";
      });
    }).then(function () {
      var frame = 0;
      return d.blocks.reduce(function (p, b, bi) {
        return p.then(function () {
          if (cancelled) return;
          if (bi > 0) frame += gap;
          var blk = { label: b.label, colour: b.colour, start: frame, end: null, items: [] };
          built.blocks.push(blk);
          var batches = [];
          for (var i = 0; i < b.clips.length; i += BATCH) batches.push(b.clips.slice(i, i + BATCH));
          return batches.reduce(function (q, batch) {
            return q.then(function () {
              if (cancelled) return;
              return jsx({ action: "place", sequenceId: built.id, startFrame: frame,
                items: batch.map(function (c) { return { nodeId: c.nodeId, name: c.name, path: c.path, audioTrack: c.audioOnly ? built.extraTrack : null }; }) }).then(function (r) {
                var placed = (r.details && r.details.placed) || [];
                placed.forEach(function (x, i) {
                  if (x.error) return;
                  var c = batch[i], it = { nodeId: x.nodeId, name: c.name, frame: x.frame, endFrame: x.endFrame, audioOnly: c.audioOnly, video: !!x.video, audioTracks: x.audioTracks, offGrid: x.offGrid };
                  if (!c.audioOnly && !x.video) built.notes.push(c.name + " came in with sound only (Premiere could not read its picture, e.g. VP9 in MP4)");
                  if (!c.audioOnly && x.video && !x.audioTracks.length) built.notes.push(c.name + " came in picture only (no sound tracks; slow-motion RED clips have none)");
                  if (x.offGrid) built.notes.push(c.name + " ends between frames");
                  blk.items.push(it); built.items.push(it);
                  counter.done++;
                });
                progress(counter.done, counter.total, d.uncut, counter.t0);
                need(r, d.uncut + ", " + b.label);
                frame = r.details.endFrame;
              });
            });
          }, Promise.resolve()).then(function () {
            if (cancelled) return;
            blk.end = frame;
            return jsx({ action: "marker", sequenceId: built.id, startFrame: blk.start, endFrame: blk.end, name: b.label, colour: b.colour }).then(function (m) {
              var md = need(m, d.uncut + " marker " + b.label);
              if (md.colour !== null && md.colour !== undefined && Number(md.colour) !== Number(b.colour)) built.notes.push("marker " + b.label + " colour reads back " + md.colour + ", not " + b.colour);
            });
          });
        });
      }, Promise.resolve());
    }).then(function () {
      if (cancelled) return built;
      return jsx({ action: "readback", sequenceId: built.id }).then(function (r) {
        built.check = verify(need(r, d.uncut + " read back"), built, gap);
        return built;
      });
    });
  }

  function build(params) {
    if (busy) return Promise.resolve({ ok: false, error: "Already building." });
    busy = "building Selects sequences";
    cancelled = false;
    var preset = params.preset || findPreset();
    var gapSec = parseFloat(params.gap === undefined || params.gap === "" ? 10 : params.gap);
    var before = state.scan, done = [], made = [], skipped = [], counter = { done: 0, total: 0, t0: Date.now() };
    return Promise.resolve().then(function () {
      if (!preset) throw new Error("Premiere's sequence preset \"" + PRESET_NAME + "\" was not found on this Mac.");
      if (!(gapSec >= 0)) throw new Error("Gap must be a number of seconds (e.g. 10).");
      return doScan(params);
    }).then(function (st) {
      save(st.choice);
      render();
      if (st.scan.front && st.scan.project.path !== st.scan.front) throw new Error("Click into " + st.scan.project.name + " in Premiere first (another project is in front).");
      // The choices Lee saw must match the bins now.
      if (before && before.project.path === st.scan.project.path) {
        var a = JSON.stringify(before.days.map(function (d) { return d.sources.map(function (s) { return s.clips.length; }); }));
        var b = JSON.stringify(st.scan.days.map(function (d) { return d.sources.map(function (s) { return s.clips.length; }); }));
        if (a !== b || before.root.nodeId !== st.scan.root.nodeId) throw new Error("The footage bins changed since Scan footage; check the list again and press Build once more.");
      }
      if (st.plan.problems.length) throw new Error("Sort these first: " + st.plan.problems.join(" "));
      var todo = st.plan.days.filter(function (d) { if (d.uncutExists) skipped.push(d.uncut + " (already exists)"); return !d.uncutExists && d.blocks.length; });
      counter.total = todo.reduce(function (a, d) { return a + d.clips; }, 0);
      progress(0, counter.total, "Starting", counter.t0);
      return todo.reduce(function (p, d) {
        return p.then(function () {
          if (cancelled) return;
          api.status("Selects: building " + d.uncut + "…");
          return buildDay(d, preset, gapSec, counter).then(function (b) { counter.current = null; done.push(b); made.push({ sequenceId: b.id, to: "uncut" }); });
        });
      }, Promise.resolve()).then(function () {
        if (cancelled) return;
        // Empty Selects sequences.
        return st.plan.days.reduce(function (p, d) {
          return p.then(function () {
            if (d.selectsExists) { skipped.push(d.selects + " (already exists)"); return; }
            return jsx({ action: "create", name: d.selects, preset: preset }).then(function (r) { made.push({ sequenceId: need(r, d.selects).id, to: "selects" }); });
          });
        }, Promise.resolve());
      }).then(function () {
        if (!made.length) return null;
        return jsx({ action: "bins", moves: made }).then(function (r) { return need(r, "Filing in 01 SEQUENCES/Selects"); });
      }).then(function (filed) {
        var bad = done.filter(function (b) { return b.check && !b.check.ok; });
        var notes = [];
        done.forEach(function (b) { b.notes.forEach(function (n) { notes.push(b.name + ": " + n); }); });
        var lines = done.map(function (b) {
          return b.name + ": " + b.items.length + " clips, " + b.blocks.length + " blocks (" + b.blocks.map(function (x) { return x.label; }).join(", ") + "), ends " +
            (b.check ? b.check.endText : "?") + (b.extraTrack !== null ? ", recorder audio on A" + (b.extraTrack + 1) + " (" + b.extraTrackKind + ")" : "") + (b.check && b.check.ok ? ", checked OK" : "");
        });
        var sum = (cancelled ? "Cancelled. " : "") + plural(done.length, "UNCUT sequence") + " built and " + plural(made.length - done.length, "empty Selects sequence") + " made" +
          (filed ? ", filed in 01 SEQUENCES/Selects" : "") + ". " + lines.join("; ") + (skipped.length ? ". Left alone: " + skipped.join(", ") : "") +
          ". The project is NOT saved: press Cmd+S in Premiere when you are happy.";
        var details = { preset: preset, gapSeconds: gapSec, sequences: done.map(function (b) { return { name: b.name, id: b.id, clips: b.items.length, check: b.check, notes: b.notes,
          blocks: b.blocks.map(function (x) { return { label: x.label, start: x.start, end: x.end, clips: x.items.length }; }) }; }), skipped: skipped, filed: filed, notes: notes };
        progress(counter.done, counter.total, "Done", counter.t0, true, bad.length > 0);
        if (bad.length) return { ok: false, error: sum + " CHECK FAILED on " + bad.map(function (b) { return b.name + " (" + b.check.problems.slice(0, 5).join("; ") + ")"; }).join(", "), details: details };
        return { ok: !cancelled, error: cancelled ? sum : undefined, summary: sum, details: details };
      });
    }).catch(function (e) {
      progress(counter.done, counter.total, "Stopped", counter.t0, true, true);
      var msg = e && e.message ? e.message : String(e);
      var so = done.map(function (b) { return b.name; }).concat(counter.current ? [counter.current + " (unfinished)"] : []);
      var partial = so.length ? " Made so far (left in the project, not saved): " + so.join(", ") + "." : "";
      return { ok: false, error: msg + partial, details: { made: done.map(function (b) { return { name: b.name, id: b.id, clips: b.items.length }; }) } };
    }).then(function (r) { busy = null; return r; });
  }

  // ---- Choices drawn under the buttons ----
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function addCss() {
    if (document.getElementById("selects-css")) return;
    var s = document.createElement("style");
    s.id = "selects-css";
    s.textContent = ".sel-row{display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap}" +
      ".sel-row input[type=text]{flex:1;min-width:90px}.sel-mv{width:26px;padding:4px 0}.sel-sw{width:16px;height:16px;border-radius:50%;border:2px solid transparent;cursor:pointer;padding:0}" +
      ".sel-sw.on{border-color:#fff;box-shadow:0 0 0 2px rgba(0,0,0,.6) inset}.sel-off{opacity:.45}.sel-info{color:var(--faint);font-size:11.5px;width:100%;margin:-2px 0 4px 32px}" +
      ".sel-warn{color:#ffd60a;font-size:12.5px;margin:6px 0}.sel-list{color:var(--dim);font-size:12px;margin:4px 0 10px 4px;white-space:pre-wrap}";
    document.head.appendChild(s);
  }
  function persist() { save(state.choice); state.plan = makePlan(state.scan, state.choice); render(); }
  function render() {
    if (!root || typeof document === "undefined") return;
    addCss();
    while (root.firstChild) root.removeChild(root.firstChild);
    var st = state;
    if (!st.scan) return;
    var c = st.choice, pl = st.plan;
    var gf0 = el("div", "field");
    gf0.appendChild(el("span", "flabel", "One sequence per"));
    var gseg = el("div", "segmented");
    [["date", "Shoot date (from the files)"], ["bin", "Bin"]].forEach(function (o) {
      var b = el("button", c.groupBy === o[0] ? "on" : "", o[1]);
      b.onclick = function () { c.groupBy = o[0]; persist(); };
      gseg.appendChild(b);
    });
    gf0.appendChild(gseg); root.appendChild(gf0);
    var bf = el("div", "field");
    bf.appendChild(el("span", "flabel", "One block per"));
    var bseg = el("div", "segmented");
    [["bin", "Bin"], ["camera", "Camera (from the files)"]].forEach(function (o) {
      var b = el("button", c.blockBy === o[0] ? "on" : "", o[1]);
      b.onclick = function () { c.blockBy = o[0]; persist(); };
      bseg.appendChild(b);
    });
    bf.appendChild(bseg); root.appendChild(bf);
    var vs = view(st.scan, c);
    var f = el("div", "field");
    f.appendChild(el("span", "flabel", "Blocks, in timeline order (label = marker name)"));
    pl.prefixes.forEach(function (k, i) {
      var on = c.include[k] !== false, row = el("div", "sel-row" + (on ? "" : " sel-off"));
      var up = el("button", "pill secondary small sel-mv", "▲"), dn = el("button", "pill secondary small sel-mv", "▼");
      up.disabled = i === 0; dn.disabled = i === pl.prefixes.length - 1;
      function move(to) { var o = pl.prefixes.slice(); o.splice(i, 1); o.splice(to, 0, k); c.order = o; persist(); }
      up.onclick = function () { move(i - 1); }; dn.onclick = function () { move(i + 1); };
      row.appendChild(up); row.appendChild(dn);
      var inp = el("input"); inp.type = "text"; inp.value = label(k, c);
      inp.onchange = function () { var v = inp.value.replace(/^\s+|\s+$/g, ""); if (v) c.labels[k] = v; else delete c.labels[k]; persist(); };
      row.appendChild(inp);
      COLOURS.forEach(function (col, ci) {
        var sw = el("button", "sel-sw" + (colourOf(k, c) === ci ? " on" : "")); sw.style.background = col.css; sw.title = col.name;
        sw.onclick = function () { c.colours[k] = ci; persist(); };
        row.appendChild(sw);
      });
      var tg = el("button", "pill " + (on ? "secondary" : "primary") + " small", on ? "Leave out" : "Include");
      tg.onclick = function () { c.include[k] = !on; persist(); };
      row.appendChild(tg);
      f.appendChild(row);
      var days = [], n = 0, kind = "";
      pl.days.forEach(function (d) { d.blocks.forEach(function (b) { if (b.key === k) { days.push(d.title); n += b.clips.length; } }); });
      var bins = [], clipsK = [];
      vs.days.forEach(function (d) { d.sources.forEach(function (s) {
        if (s.prefix.toUpperCase() !== k) return;
        if (s.kind !== "video") kind = s.kind === "audio" ? " · audio only: own track under the camera audio" : " · has audio-only clips";
        bins.push(s.bin); clipsK = clipsK.concat(s.clips);
      }); });
      var cams = cameraText(clipsK);
      f.appendChild(el("div", "sel-info", "Bins " + bins.slice(0, 4).join(", ") + (bins.length > 4 ? "…" : "") + (on ? " · " + plural(n, "clip") + " · " + days.join(", ") : " · left out") + kind +
        (cams ? " · Camera: " + cams : "")));
    });
    root.appendChild(f);
    var dups = Object.keys(pl.duplicates);
    if (dups.length) {
      var df = el("div", "field");
      df.appendChild(el("span", "flabel", "Clips in two groups: which one does each belong to?"));
      // One click for all of them. When every clip sits in the same groups, the buttons name those groups.
      var same = dups.every(function (n) { return pl.duplicates[n].join("|") === pl.duplicates[dups[0]].join("|"); });
      var allOpts = (same ? pl.duplicates[dups[0]].map(function (g) { return [g, groupTitle(vs, g, c)]; }) : [["first", "First group"], ["last", "Last group"]]).concat([["both", "Both"]]);
      var allRow = el("div", "sel-row"); allRow.appendChild(el("span", "tlabel", "All " + dups.length + " clips"));
      var allSeg = el("div", "segmented");
      allOpts.forEach(function (o) {
        var on = dups.every(function (n) { return c.dups[n] === pickDup(pl.duplicates[n], o[0]); });
        var b = el("button", on ? "on" : "", o[1]);
        b.onclick = function () { dups.forEach(function (n) { c.dups[n] = pickDup(pl.duplicates[n], o[0]); }); persist(); };
        allSeg.appendChild(b);
      });
      allRow.appendChild(allSeg); df.appendChild(allRow);
      dups.forEach(function (name) {
        var row = el("div", "sel-row"); row.appendChild(el("span", "tlabel", name));
        var seg = el("div", "segmented");
        pl.duplicates[name].concat(["both"]).forEach(function (opt) {
          var b = el("button", c.dups[name] === opt ? "on" : "", opt === "both" ? "Both" : groupTitle(vs, opt, c));
          b.onclick = function () { c.dups[name] = opt; persist(); };
          seg.appendChild(b);
        });
        row.appendChild(seg); df.appendChild(row);
      });
      root.appendChild(df);
    }
    // Group names used in the sequence names; typed names are kept for this project.
    var gf = el("div", "field");
    gf.appendChild(el("span", "flabel", "Name in the sequence names, per group (" + (c.groupBy === "date" ? "day and date" : "bin name") + " to start with)"));
    pl.days.forEach(function (d) {
      var row = el("div", "sel-row"), gi = el("input"); gi.type = "text"; gi.value = d.title; gi.title = "Bin: " + d.bin;
      gi.onchange = function () { var v = gi.value.replace(/^\s+|\s+$/g, ""); if (v && v !== d.defaultTitle) c.names[d.label] = v; else delete c.names[d.label]; persist(); };
      row.appendChild(gi); gf.appendChild(row);
      var g0 = null; vs.days.forEach(function (x) { if (x.label === d.label) g0 = x; });
      var gc = g0 ? cameraText([].concat.apply([], g0.sources.map(function (s) { return s.clips; }))) : "";
      gf.appendChild(el("div", "sel-info", (c.groupBy === "date" ? "From " : "Bin ") + d.bin + " · " + plural(d.clips, "clip") + (gc ? " · " + gc : "")));
    });
    root.appendChild(gf);
    var out = el("div", "field");
    out.appendChild(el("span", "flabel", "Build will make (in 01 SEQUENCES/Selects), preset: " + (st.preset ? path.basename(st.preset) : "NOT FOUND")));
    out.appendChild(el("div", "sel-list", pl.days.map(function (d) {
      return (d.uncutExists ? "✓ exists, left alone: " : "") + "UNCUT/" + d.uncut + "  ·  " + plural(d.clips, "clip") + (d.offGrid ? " (" + d.offGrid + " not 25 fps)" : "") +
        "\n" + (d.selectsExists ? "✓ exists, left alone: " : "") + d.selects + "  ·  empty";
    }).join("\n")));
    root.appendChild(out);
    pl.problems.forEach(function (p) { root.appendChild(el("div", "sel-warn", "To sort first: " + p)); });
    pl.notes.forEach(function (p) { root.appendChild(el("div", "sel-list", p)); });
  }

  return {
    actions: {
      scan: function (p) { return scanAction(p); },
      build: function (p) { return build(p); },
      cancel: function () { if (!busy) return Promise.resolve({ ok: true, summary: "Nothing running." }); cancelled = true; return Promise.resolve({ ok: true, summary: "Stopping after the clips being placed now." }); }
    },
    busy: function () { return busy; },
    mount: function (element) { root = element; render(); }
  };
};
module.exports.makePlan = makePlan;
module.exports.verify = verify;
module.exports.pickDup = pickDup;
module.exports.findPreset = findPreset;
