/* Colour baseline, panel side (Node). Three buttons:
 * - Detect cameras: reads the active sequence's video clips (premiere.jsx "scan"), works out each
 *   clip's camera from the file itself and lists the cameras with clip counts, each with a
 *   LUT picker: a row of folders (this Mac's Premiere LUT folders, then "Presets" = Lee's Lumetri
 *   presets from Premiere's user preset file) and a list of that folder's LUTs. The choice per
 *   camera is remembered in ~/.peny-toolkit/colour-baseline.json.
 * - Apply baseline grade: exports the active sequence to a project file, adds a Lumetri named
 *   "Adjustments" and the camera's LUT preset above each clip's existing Lumetri effects
 *   (lutpreset.py grade), imports it back as "<name> GRADED TOOLKIT COPY" and reads every clip
 *   back. Clips that already have Adjustments / a named LUT Lumetri are not given another. The
 *   open sequence is not edited; nothing is saved.
 * - Make LUT presets: .cube files in a folder -> one preset file for Effects panel > Import Presets.
 * Why not applyLumetriPreset / setValue: see premiere.jsx (they cannot load Lee's LUTs).
 *
 * Camera from the file: R3D -> REDline --printMeta 1 "Camera Model" (one clip per reel, ~5 s);
 * other files -> model strings in the first 4 MB / last 2 MB (Canon "Canon EOS R5m2", Sony
 * "ILCE-7SM3" / "ILME-FX6V", Nikon "niko" brand), one file per folder. Results are cached by
 * path, size and date. */
var fs = require("fs");
var path = require("path");
// Tools put in place by the one-click installer (no Homebrew needed). Used first when
// present: they are the versions the toolkit was tested with, and their python3 has numpy
// (a Homebrew python3 without numpy would break Sync, Sound Pass and Colour).
function BUNDLED(name) { return path.join(process.env.HOME || "", "Library", "Application Support", "PenyToolkit", "bin", name); }
var os = require("os");
var childProcess = require("child_process");

var SETTINGS = path.join(os.homedir(), ".peny-toolkit", "colour-baseline.json");
var REDLINE = ["/usr/local/bin/REDline", "/Applications/REDCINE-X Professional/REDCINE-X PRO.app/Contents/MacOS/REDline"];
var ADJUSTMENTS = "Adjustments";
var NO_LUT = "";
// LUT folders on this Mac (Lee, 23 Oct 2026; Creative only since 13 Oct): every folder in this
// Mac's Premiere Lumetri/LUTs (Mac mini 26.5.2: Technical, Creative, Legacy) and in the Adobe
// Common LUTs folders, read when Detect runs, so each Mac lists its own LUTs. A file is offered
// as a "file:<path>" choice; Apply builds the Lumetri from it (lutpreset.py lut_component), which
// takes 3D .cube and Premiere's binary .itx ("ITX3") only, so 1D .cube, .look, .ilut are left out.
var APPS = "/Applications";
var FOLDER_ORDER = ["Technical", "Creative", "Basic"]; // Lee's order; other folders follow A-Z
var PRESETS = "Presets"; // Lee's own Lumetri presets, last in the folder row
function lutRoots() {
  var roots = [];
  try {
    var apps = fs.readdirSync(APPS).filter(function (n) { return /^Adobe Premiere Pro \d{4}$/.test(n); }).sort().reverse();
    for (var i = 0; i < apps.length; i++) {
      var d = path.join(APPS, apps[i], apps[i] + ".app", "Contents", "Lumetri", "LUTs");
      if (fs.existsSync(d)) { roots.push(d); break; }
    }
  } catch (e) {}
  roots.push("/Library/Application Support/Adobe/Common/LUTs", path.join(os.homedir(), "Library", "Application Support", "Adobe", "Common", "LUTs"));
  return roots;
}
function usableLut(file) {
  var ext = extOf(file);
  if (ext !== "cube" && ext !== "itx") return false;
  try {
    var fd = fs.openSync(file, "r"), buf = Buffer.alloc(ext === "itx" ? 4 : 65536), n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    var s = buf.toString("latin1", 0, n);
    return ext === "itx" ? s === "ITX3" : /^\s*LUT_3D_SIZE/m.test(s) && !/^\s*LUT_1D_SIZE/m.test(s);
  } catch (e) { return false; }
}
// [{ name: "Technical", items: ["file:/…/x.cube", …] }, …] in Lee's order, empty folders left out.
function listLutFolders() {
  var byName = {};
  function walk(dir, name, depth) {
    var entries = [];
    try { entries = fs.readdirSync(dir); } catch (e) { return; }
    entries.forEach(function (n) {
      if (n.charAt(0) === ".") return;
      var p = path.join(dir, n), st = null;
      try { st = fs.statSync(p); } catch (e) { return; }
      if (st.isDirectory()) { if (depth < 3) walk(p, name, depth + 1); }
      else if (usableLut(p)) (byName[name] = byName[name] || []).push("file:" + p);
    });
  }
  lutRoots().forEach(function (root) {
    var subs = [];
    try { subs = fs.readdirSync(root); } catch (e) { return; }
    subs.forEach(function (n) {
      var p = path.join(root, n);
      try { if (n.charAt(0) !== "." && fs.statSync(p).isDirectory()) walk(p, n, 1); } catch (e) {}
    });
  });
  function rank(n) { var i = FOLDER_ORDER.indexOf(n); return i === -1 ? FOLDER_ORDER.length : i; }
  return Object.keys(byName).sort(function (a, b) { return rank(a) - rank(b) || a.localeCompare(b); }).map(function (n) {
    return { name: n, items: byName[n].sort(function (a, b) { return lutLabel(a).localeCompare(lutLabel(b)); }) };
  });
}
function lutLabel(v) { return v && v.indexOf("file:") === 0 ? path.basename(v.slice(5)).replace(/\.[^.]+$/, "") : v; }
// A saved choice still available: one of Lee's presets, or a LUT file that is still there.
function choiceExists(v, names) { return v.indexOf("file:") === 0 ? fs.existsSync(v.slice(5)) : names.indexOf(v) !== -1; }

function firstExisting(list) { for (var i = 0; i < list.length; i++) if (fs.existsSync(list[i])) return list[i]; return null; }
function extOf(p) { var d = p.lastIndexOf("."); return d === -1 ? "" : p.substring(d + 1).toLowerCase(); }

function readSettings() {
  try { var s = JSON.parse(fs.readFileSync(SETTINGS, "utf-8")); s.choices = s.choices || {}; s.cache = s.cache || {}; return s; }
  catch (e) { return { choices: {}, cache: {} }; }
}
function writeSettings(s) {
  try { fs.mkdirSync(path.dirname(SETTINGS), { recursive: true }); fs.writeFileSync(SETTINGS + ".tmp", JSON.stringify(s, null, 1)); fs.renameSync(SETTINGS + ".tmp", SETTINGS); }
  catch (e) {}
}

// Readable camera names from the model strings the files carry.
function prettyModel(raw) {
  var s = String(raw || "").replace(/\s+/g, " ").trim(), m;
  if (!s) return null;
  if ((m = /^Canon (EOS )?(.+)$/i.exec(s))) {
    var body = m[2].replace(/m2$/i, " Mark II").replace(/m3$/i, " Mark III").replace(/MkII$/i, " Mark II");
    return "Canon " + (m[1] ? "EOS " : "") + body.replace(/\s+/g, " ").trim();
  }
  var sony = { "ILCE-7SM3": "Sony A7S III", "ILCE-7M4": "Sony A7 IV", "ILCE-7M3": "Sony A7 III", "ILCE-7SM2": "Sony A7S II", "ILCE-1": "Sony A1",
    "ILME-FX6V": "Sony FX6", "ILME-FX6": "Sony FX6", "ILME-FX3": "Sony FX3", "ILME-FX30": "Sony FX30", "ILME-FR7": "Sony FR7" };
  if (sony[s]) return sony[s];
  if (/^(ILCE|ILME|PXW|PMW|DSC)-/.test(s)) return "Sony " + s;
  if ((m = /^V-RAPTOR\s*(.*)$/i.exec(s))) return "RED V-Raptor " + m[1].replace(/\s+S35$/, " S35");
  if ((m = /^KOMODO(-X)?\s*(\S+)?/i.exec(s))) return "RED Komodo" + (m[1] ? "-X" : "") + (m[2] ? " " + m[2] : "");
  if (/^NIKON/i.test(s)) return "Nikon " + s.replace(/^NIKON\s*/i, "");
  return s;
}

function redModel(file) {
  var redline = firstExisting(REDLINE);
  if (!redline) return Promise.resolve(null);
  return new Promise(function (resolve) {
    childProcess.execFile(redline, ["--i", file, "--printMeta", "1"], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, function (err, out) {
      var m = /Camera Model:\s*([^\r\n]+)/.exec(String(out || ""));
      resolve(m ? m[1].trim() : null);
    });
  });
}
function scanBytes(buf) {
  var s = buf.toString("latin1"), m;
  if ((m = /Canon (?:EOS )?[A-Za-z0-9][A-Za-z0-9 .-]{1,14}?(?=\x00|$)/.exec(s))) return m[0];
  if ((m = /(?:ILCE|ILME|PXW|PMW)-[A-Z0-9]+/.exec(s))) return m[0];
  if ((m = /NIKON Z ?[A-Za-z0-9]+/.exec(s))) return m[0];
  if (/^.{4}ftyp[\s\S]{0,40}niko/.test(s)) return "NIKON";
  if ((m = /GoPro|HERO\d+ Black/.exec(s))) return m[0];
  if ((m = /DJI [A-Za-z0-9 ]{2,20}/.exec(s))) return m[0];
  if ((m = /iPhone [0-9A-Za-z ]{1,16}/.exec(s))) return "Apple " + m[0];
  return null;
}
function fileModel(file) {
  return new Promise(function (resolve) {
    fs.open(file, "r", function (err, fd) {
      if (err) return resolve(null);
      try {
        var size = fs.fstatSync(fd).size, head = Buffer.alloc(Math.min(size, 4 * 1024 * 1024)), tail = Buffer.alloc(Math.min(size, 2 * 1024 * 1024));
        fs.readSync(fd, head, 0, head.length, 0);
        fs.readSync(fd, tail, 0, tail.length, Math.max(0, size - tail.length));
        resolve(scanBytes(head) || scanBytes(tail));
      } catch (e) { resolve(null); }
      finally { try { fs.closeSync(fd); } catch (e2) {} }
    });
  });
}

var StepTask = require(path.join(__dirname, "..", "..", "core", "steps.js")).StepTask;
// Apply's steps for the progress bar and time left; a + b x clips seconds each, from Lee's
// two runs on 12 Oct 2026 (784 clips: 3-5 s, 7-8 s, 47-91 s, 133-177 s, 4-6 s). Learned
// from each run after that (~/.peny-toolkit/colour-eta.json).
var APPLY_STEPS = [
  { id: "scan", label: "Reading the sequence and cameras" },
  { id: "export", label: "Exporting the sequence" },
  { id: "grade", label: "Adding Adjustments and LUTs" },
  { id: "import", label: "Importing the graded copy" },
  { id: "finish", label: "Checking every clip" }];
var APPLY_DEFAULTS = { scan: { a: 1, b: 0.004 }, export: { a: 2, b: 0.007 }, grade: { a: 3, b: 0.084 }, import: { a: 5, b: 0.19 }, finish: { a: 1, b: 0.005 } };

module.exports = function (api) {
  var busy = null;
  var state = { cameras: null, presets: null, userPresets: null, sequence: null };
  var root = null; // the mount element in the skill card

  function jsx(params) { return api.evalSkill(params); }

  // Camera per clip. Probes one file per reel (R3D) or per folder + type (others).
  function cameraFor(clips, settings) {
    var groups = {}, order = [];
    clips.forEach(function (c) {
      var ext = extOf(c.path), dir = path.dirname(c.path);
      var key = ext === "r3d" ? path.dirname(dir) + "|" + path.basename(c.path).slice(0, 4).toUpperCase() : dir + "|" + ext + "|" + c.videoInfo;
      if (!groups[key]) { groups[key] = { sample: c, clips: [] }; order.push(key); }
      groups[key].clips.push(c);
    });
    var probed = 0;
    return order.reduce(function (p, key) {
      return p.then(function () {
        var g = groups[key], file = g.sample.path, st = null;
        try { st = fs.statSync(file); } catch (e) {}
        var cached = settings.cache[file];
        if (cached && st && cached.size === st.size && cached.mtime === st.mtimeMs) { g.model = cached.model; return; }
        if (!st) { g.model = null; g.offline = true; return; }
        probed++;
        api.status("Colour: reading camera " + probed + " (" + path.basename(file) + ")…");
        return (extOf(file) === "r3d" ? redModel(file) : fileModel(file)).then(function (model) {
          g.model = model;
          settings.cache[file] = { size: st.size, mtime: st.mtimeMs, model: model };
        });
      });
    }, Promise.resolve()).then(function () {
      var cams = {}, list = [];
      order.forEach(function (key) {
        var g = groups[key], s = g.sample, name = prettyModel(g.model);
        if (!name) name = (g.offline ? "Offline media" : "Unknown camera") + " (" + extOf(s.path).toUpperCase() + (s.codec ? " " + s.codec : "") + (s.videoInfo ? " " + s.videoInfo.replace(/ \(.*$/, "") : "") + ")";
        if (!cams[name]) { cams[name] = { camera: name, model: g.model || null, clips: [], full: [], existing: {}, folders: [] }; list.push(cams[name]); }
        var cam = cams[name];
        cam.folders.push(path.dirname(s.path));
        g.clips.forEach(function (c) {
          cam.clips.push({ track: c.track, nodeId: c.nodeId });
          cam.full.push(c);
          (c.lumetri || []).forEach(function (n) { var k = n || "(unnamed Lumetri Color)"; cam.existing[k] = (cam.existing[k] || 0) + 1; });
        });
      });
      list.sort(function (a, b) { return b.clips.length - a.clips.length; });
      return list;
    });
  }

  // Lee's Lumetri presets, read from Premiere's user preset file (the one Effects panel >
  // Import Presets / Save Preset writes). Premiere's script API cannot apply these, so Apply
  // copies them into a project file instead (see premiere.jsx).
  function userPresetFile() {
    var base = path.join(os.homedir(), "Documents", "Adobe", "Premiere Pro"), best = null;
    try {
      fs.readdirSync(base).filter(function (v) { return /^\d+\.\d+$/.test(v); }).sort(function (a, b) { return parseFloat(b) - parseFloat(a); }).some(function (v) {
        return fs.readdirSync(path.join(base, v)).filter(function (d) { return /^Profile-/.test(d); }).some(function (d) {
          var f = path.join(base, v, d, "Effect Presets and Custom Items.prfpset");
          if (fs.existsSync(f)) { best = f; return true; }
          return false;
        });
      });
    } catch (e) {}
    return best;
  }
  function python() { return firstExisting([BUNDLED("python3"), "/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"]); }
  function runPy(args, timeout) {
    return new Promise(function (resolve, reject) {
      childProcess.execFile(python(), [path.join(api.skillDir, "lutpreset.py")].concat(args), { maxBuffer: 64 * 1024 * 1024, timeout: timeout || 600000 }, function (err, stdout, stderr) {
        if (err) return reject(new Error(String(stderr || err.message).trim().split("\n").pop().slice(0, 400)));
        try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error("lutpreset.py: " + String(stdout).slice(0, 200))); }
      });
    });
  }
  function listPresets() {
    var f = userPresetFile();
    if (!f) return Promise.resolve({ file: null, names: [] });
    return runPy(["list", f], 120000).then(function (names) { return { file: f, names: names }; });
  }

  // Suggested LUT for a camera with no saved choice: one of Lee's presets naming the brand
  // ("CANON LUT" for Canon, "RED LUT" for RED...).
  function suggest(camera, names) {
    var brand = (/^(Canon|Sony|Nikon|RED|DJI|GoPro|Apple)\b/.exec(camera) || [])[1];
    if (!brand) return NO_LUT;
    var re = new RegExp("\\b" + brand + "\\b", "i");
    for (var i = 0; i < names.length; i++) if (names[i] !== ADJUSTMENTS && re.test(names[i])) return names[i];
    return NO_LUT;
  }

  function detect(params) {
    // Test hook: params.jsxAction calls one premiere.jsx action directly (e.g. "scan", "frame").
    if (params.jsxAction) {
      var p = JSON.parse(JSON.stringify(params));
      p.action = params.jsxAction;
      delete p.jsxAction;
      return jsx(p);
    }
    var settings = readSettings();
    return jsx({ action: "scan" }).then(function (scan) {
      if (!scan.ok) return scan;
      return listPresets().then(function (pr) {
        return cameraFor(scan.details.clips, settings).then(function (cams) {
          cams.forEach(function (c) {
            if (!settings.choices.hasOwnProperty(c.camera)) c.suggested = suggest(c.camera, pr.names);
            c.choice = settings.choices.hasOwnProperty(c.camera) ? settings.choices[c.camera] : c.suggested;
            if (c.choice && !choiceExists(c.choice, pr.names)) c.choice = NO_LUT; // preset or file gone
          });
          writeSettings(settings);
          var folders = listLutFolders();
          state = { cameras: cams, presets: pr.names, folders: folders, sequence: scan.details.sequence, nested: scan.details.nested };
          render();
          var lines = cams.map(function (c) { return c.camera + ": " + c.clips.length + " clip(s)" + (c.choice ? " -> " + lutLabel(c.choice) : " -> no LUT"); });
          return { ok: true, summary: cams.length + " camera(s) in \"" + scan.details.sequence + "\": " + lines.join("; ") + "." +
            (pr.names.length ? "" : " No Lumetri presets of yours found (Make LUT presets, then Effects panel > Import Presets)."),
            details: { sequence: scan.details.sequence, cameras: cams.map(function (c) {
              return { camera: c.camera, model: c.model, clips: c.clips.length, choice: c.choice, existing: c.existing, folders: c.folders.filter(function (f, i, a) { return a.indexOf(f) === i; }).slice(0, 5) };
            }), skipped: scan.details.skipped, nested: scan.details.nested, presetFile: pr.file, presets: pr.names.length,
            lutFolders: folders.map(function (f) { return f.name + " (" + f.items.length + ")"; }),
            // Test hook: params.uiProbe opens each camera's LUT list in the real panel and reports
            // whether it can be seen (the old dropdown could not at small panel sizes).
            ui: params.uiProbe ? uiProbe() : undefined } };
        });
      });
    });
  }

  // Apply: export the active sequence to a project file, add "Adjustments" and the camera's LUT
  // preset to every video clip there (lutpreset.py grade), import it back as a new
  // "<name> GRADED TOOLKIT COPY" and read every clip back. The open sequence is never edited.
  function apply(params) {
    var adj = params.adjustments || ADJUSTMENTS, settings = readSettings(), choices = params.choices || settings.choices;
    var work = path.join("/tmp/peny-toolkit/colour", new Date().toISOString().replace(/[:.]/g, "-"));
    fs.mkdirSync(work, { recursive: true });
    var src = path.join(work, "source.prproj"), out = path.join(work, "graded.prproj");
    var scan0, cams, plan, presetsInfo, t0 = Date.now(), task = null;
    // The bar starts once the clip count is known (the scan is a couple of seconds).
    return jsx({ action: "scan" }).then(function (scan) {
      if (!scan.ok) throw new Error(scan.error);
      scan0 = scan.details;
      task = new StepTask({ title: "Colour", steps: APPLY_STEPS, size: scan0.clips.length, defaults: APPLY_DEFAULTS,
        historyFile: path.join(os.homedir(), ".peny-toolkit", "colour-eta.json"), onProgress: api.progress });
      task.step("scan");
      if (!scan0.clips.length) throw new Error("No video clips with media files in \"" + scan0.sequence + "\".");
      return listPresets();
    }).then(function (pr) {
      presetsInfo = pr;
      return cameraFor(scan0.clips, settings);
    }).then(function (c) {
      cams = c;
      writeSettings(settings);
      var clips = [], missing = [];
      cams.forEach(function (cam) {
        // The LUT Detect shows: the saved choice, else the suggestion (Lee's preset naming the
        // brand). Suggestions are only shown, not saved, so Apply must work them out the same
        // way (bug 3 Oct: Detect showed CANON LUT / RED LUT, Apply used no LUT).
        var pick = choices.hasOwnProperty(cam.camera) ? choices[cam.camera] : suggest(cam.camera, presetsInfo.names);
        if (pick && !choiceExists(pick, presetsInfo.names)) missing.push(cam.camera + " -> " + lutLabel(pick));
        cam.pick = pick;
        cam.full.forEach(function (cl) {
          var hasLut = cl.lumetri.some(function (n) { return n !== "" && n !== adj; });
          cl.plan = { track: cl.track, start: cl.startTicks, lut: pick && !hasLut ? pick : null, adjustments: cl.lumetri.indexOf(adj) === -1 };
          clips.push(cl.plan);
        });
      });
      if (missing.length) throw new Error("These LUT presets are not in your preset file any more: " + missing.join(", ") + ". Press Detect cameras and choose again.");
      plan = { sequence: scan0.sequenceId, newSequence: uuidv4(), oldName: scan0.sequence, newName: scan0.sequence + " GRADED (importing)",
        presets: presetsInfo.file, adjustments: adj, clips: clips };
      fs.writeFileSync(path.join(work, "plan.json"), JSON.stringify(plan));
      api.status("Colour: exporting \"" + scan0.sequence + "\"…");
      task.step("export");
      return jsx({ action: "exportproj", path: src });
    }).then(function (ex) {
      if (!ex.ok) throw new Error(ex.error);
      api.status("Colour: adding Adjustments and LUTs to " + plan.clips.length + " clip(s)…");
      task.step("grade");
      return runPy(["grade", src, out, path.join(work, "plan.json")]);
    }).then(function (g) {
      if (g.problems.length) throw new Error(g.problems.length + " clip(s) could not be matched in the exported project; nothing was imported. First: " + JSON.stringify(g.problems[0]).slice(0, 200));
      api.status("Colour: importing the graded copy…");
      task.step("import");
      return jsx({ action: "importseq", path: out, ids: [plan.newSequence] });
    }).then(function (im) {
      if (!im.ok) throw new Error(im.error);
      var extra = im.details.added.filter(function (s) { return s.id !== plan.newSequence; });
      task.step("finish");
      return jsx({ action: "finish", id: plan.newSequence, base: scan0.sequence }).then(function (fin) {
        if (!fin.ok) throw new Error(fin.error);
        return verify(fin, extra);
      });
    }).then(function (r) {
      r.details.work = work;
      r.summary += " Took " + Math.round((Date.now() - t0) / 1000) + " s.";
      // A read-back mismatch still went through every step, so its timings count.
      if (task) task.done(true);
      return r;
    }, function (e) {
      if (task) task.done(false);
      throw e;
    });

    // Every clip of the new sequence against the original: same clip, time and master clip, and
    // its Lumetri stack = Adjustments (if added), LUT (if added), then what it had.
    function verify(fin, extra) {
      var after = fin.details.clips, bad = [], ok = 0, lutAdded = 0, adjAdded = 0;
      scan0.clips.forEach(function (cl, i) {
        // trackItem.components lists effects bottom-up (file order); Effect Controls shows the
        // reverse. Expected in that list: what the clip had, then the LUT, then Adjustments last
        // = Adjustments on top in Effect Controls.
        var b = after[i], want = cl.lumetri.concat(cl.plan.lut ? [lutLabel(cl.plan.lut)] : []).concat(cl.plan.adjustments ? [adj] : []);
        // Same media counts as the same clip: importSequences can relink a clip to another project
        // item of the same file (A045/A046 sit in two bins), which read back as 68 "wrong" clips on 12 Oct.
        var same = b && b.track === cl.track && b.startTicks === cl.startTicks && (b.item === cl.item || (b.path && b.path === cl.path)) &&
          JSON.stringify(b.lumetri) === JSON.stringify(want);
        if (same) { ok++; if (cl.plan.lut) lutAdded++; if (cl.plan.adjustments) adjAdded++; }
        else bad.push({ name: cl.name, track: "V" + (cl.track + 1), expected: want, found: b ? b.lumetri : null });
      });
      var perCam = cams.map(function (c) {
        return { camera: c.camera, lut: c.pick || null, clips: c.full.length, lutAdded: c.full.filter(function (x) { return x.plan.lut; }).length,
          keptOwnLut: c.full.filter(function (x) { return !x.plan.lut && c.pick; }).length };
      });
      var summary = "\"" + fin.details.sequence + "\" made: Adjustments on " + adjAdded + " clip(s), LUT on " + lutAdded + " (" +
        perCam.map(function (c) { return c.camera + ": " + (lutLabel(c.lut) || "no LUT") + (c.keptOwnLut ? ", " + c.keptOwnLut + " kept their own LUT" : ""); }).join("; ") +
        "); " + ok + " of " + scan0.clips.length + " clips read back right. \"" + scan0.sequence + "\" is unchanged." +
        (extra.length ? " Premiere also brought in copies of nested sequence(s) it uses: " + extra.map(function (s) { return s.name; }).join(", ") + "." : "");
      var details = { sequence: fin.details.sequence, sequenceId: plan.newSequence, from: scan0.sequence, cameras: perCam, readBack: { ok: ok, total: scan0.clips.length, wrong: bad.slice(0, 20) },
        nestedCopies: extra, skipped: scan0.skipped };
      if (bad.length) return { ok: false, error: summary + " " + bad.length + " clip(s) do not match (see details).", details: details };
      return { ok: true, summary: summary, details: details };
    }
  }

  function uuidv4() {
    var b = require("crypto").randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = b.toString("hex");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  }

  // ---- Camera list in the skill card ----
  function el(tag, cls, text) {
    var d = root.ownerDocument.createElement(tag);
    if (cls) d.className = cls;
    if (text !== undefined) d.textContent = text;
    return d;
  }
  // The LUT picker is drawn in the page, not a <select>: CEP draws a <select>'s list inside the
  // panel and cut it off unless the panel was full screen (Lee, 23 Oct 2026). This list opens
  // in the card itself, scrolls with the panel and has its own scroll bar.
  var CSS = [
    ".lut-folders { flex-wrap: wrap; margin-bottom: 6px; }",
    ".lut-folders button { flex: 1 1 auto; }",
    ".lut-current { width: 100%; display: flex; align-items: center; gap: 6px; padding: 7px 10px; color: var(--text); font: inherit; font-size: 12px; text-align: left;",
    "  background: rgba(0, 0, 0, 0.22); border: 1px solid var(--glass-line); border-radius: 12px; cursor: pointer; }",
    ".lut-current .lname { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
    ".lut-current .chev { flex: 0 0 auto; color: var(--dim); }",
    ".lut-list { margin-top: 6px; padding: 6px; border-radius: 12px; background: rgba(0, 0, 0, 0.5); border: 1px solid var(--glass-line); }",
    ".lut-list input[type=text] { margin-bottom: 6px; }",
    ".lut-opts { max-height: 220px; overflow-y: auto; }",
    ".lut-opt { display: block; width: 100%; padding: 6px 10px; border: 0; border-radius: 8px; background: none; color: var(--text); font: inherit;",
    "  font-size: 12px; text-align: left; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
    ".lut-opt:hover { background: var(--glass-strong); }",
    ".lut-opt.on { background: #fff; color: #000; }",
    ".lut-empty { padding: 6px 10px; color: var(--faint); font-size: 12px; }"].join("\n");
  function addCss() {
    var doc = root.ownerDocument, st = doc.getElementById("colour-lut-css");
    if (!st) { st = doc.createElement("style"); st.id = "colour-lut-css"; doc.head.appendChild(st); }
    st.textContent = CSS;
  }
  // The folder row: this Mac's LUT folders, then Lee's presets.
  function lutFolders() {
    var list = (state.folders || []).slice(), mine = state.presets.filter(function (n) { return n !== ADJUSTMENTS; });
    if (mine.length) list.push({ name: PRESETS, items: mine });
    return list;
  }
  function folderOf(v, folders) {
    for (var i = 0; v && i < folders.length; i++) if (folders[i].items.indexOf(v) !== -1) return folders[i].name;
    return null;
  }
  function picker(c, folders) {
    var wrap = el("div", "lut-picker"), open = false;
    var folder = folderOf(c.choice, folders) || (folders.length ? folders[0].name : null);
    var seg = el("div", "segmented lut-folders");
    var cur = el("button", "lut-current"), lname = el("span", "lname"), chev = el("span", "chev", "▾");
    cur.appendChild(lname); cur.appendChild(chev);
    var list = el("div", "lut-list hidden"), search = el("input"), opts = el("div", "lut-opts");
    search.type = "text"; search.placeholder = "Filter";
    list.appendChild(search); list.appendChild(opts);
    function label() {
      var f = folderOf(c.choice, folders);
      lname.textContent = c.choice ? lutLabel(c.choice) + (f ? "  ·  " + f : "") : "No LUT (Adjustments only)";
    }
    function paintFolders() { Array.prototype.forEach.call(seg.children, function (b) { b.className = b.textContent === folder ? "on" : ""; }); }
    function fill() {
      while (opts.firstChild) opts.removeChild(opts.firstChild);
      var f = folders.filter(function (x) { return x.name === folder; })[0], q = search.value.trim().toLowerCase();
      var items = [NO_LUT].concat(f ? f.items : []).filter(function (v) { return !q || v === NO_LUT || lutLabel(v).toLowerCase().indexOf(q) !== -1; });
      items.forEach(function (v) {
        var o = el("button", "lut-opt" + (v === (c.choice || NO_LUT) ? " on" : ""), v === NO_LUT ? "No LUT (Adjustments only)" : lutLabel(v));
        o.title = v.indexOf("file:") === 0 ? v.slice(5) : o.textContent;
        o.addEventListener("click", function () { choose(v); });
        opts.appendChild(o);
      });
      if (items.length === 1 && q) opts.appendChild(el("div", "lut-empty", "No LUT in " + folder + " matches \"" + search.value + "\""));
    }
    function show(on) {
      open = on;
      list.classList.toggle("hidden", !open);
      chev.textContent = open ? "▴" : "▾";
      if (open) {
        fill();
        var sel = opts.querySelector(".lut-opt.on");
        if (sel) opts.scrollTop = Math.max(0, sel.offsetTop - opts.offsetTop - 60);
        if (list.scrollIntoView) list.scrollIntoView({ block: "nearest" });
      }
    }
    function choose(v) {
      var s = readSettings();
      s.choices[c.camera] = v;
      writeSettings(s);
      c.choice = v;
      api.log("Colour: " + c.camera + " -> " + (lutLabel(v) || "no LUT"));
      label();
      show(false);
    }
    folders.forEach(function (f) {
      var b = el("button", "", f.name);
      b.title = f.items.length + " LUT" + (f.items.length === 1 ? "" : "s");
      b.addEventListener("click", function () { folder = f.name; search.value = ""; paintFolders(); show(true); });
      seg.appendChild(b);
    });
    cur.addEventListener("click", function () { show(!open); });
    search.addEventListener("input", fill);
    if (folders.length) wrap.appendChild(seg);
    wrap.appendChild(cur); wrap.appendChild(list);
    paintFolders(); label();
    wrap._open = function (on) { show(on); return list; };
    return wrap;
  }
  // Test hook (detect with uiProbe): opens each camera's list, scrolls it into view as a click
  // does, and checks it lies inside the panel's visible area; puts the panel back after (if
  // Colour was not on screen it is shown for the check and the screen put back).
  function uiProbe() {
    if (!root) return { error: "no panel" };
    var doc = root.ownerDocument, win = doc.defaultView, view = root.closest(".view") || doc.scrollingElement;
    var wasOpen = root.offsetParent !== null, saved = [];
    if (!wasOpen) [doc.getElementById("home"), doc.getElementById("detail"), root.closest(".app")].forEach(function (e, i) {
      if (!e) return;
      saved.push([e, e.className]);
      e.classList.toggle("hidden", i === 0);
    });
    var shown = root.offsetParent !== null, top0 = view.scrollTop;
    var out = { panel: win.innerWidth + "x" + win.innerHeight, viewOpen: wasOpen, shownForCheck: !wasOpen && shown, pickers: [] };
    Array.prototype.forEach.call(root.querySelectorAll(".lut-picker"), function (p, i) {
      var list = p._open(true), r = list.getBoundingClientRect(), v = view.getBoundingClientRect();
      var o = list.querySelectorAll(".lut-opt"), last = o[o.length - 1], opts = list.querySelector(".lut-opts");
      opts.scrollTop = opts.scrollHeight;
      var lr = last ? last.getBoundingClientRect() : null, orr = opts.getBoundingClientRect();
      out.pickers.push({ camera: state.cameras[i] && state.cameras[i].camera,
        folders: Array.prototype.map.call(p.querySelectorAll(".lut-folders button"), function (b) { return b.textContent; }),
        options: o.length, list: Math.round(r.top) + "-" + Math.round(r.bottom), area: Math.round(v.top) + "-" + Math.round(v.bottom),
        listInView: shown && r.height > 0 && r.top >= v.top - 1 && r.bottom <= v.bottom + 1,
        lastOptionReachable: !!lr && lr.bottom <= orr.bottom + 1 && lr.top >= orr.top - 1 });
      p._open(false);
    });
    view.scrollTop = top0;
    saved.forEach(function (s) { s[0].className = s[1]; });
    return out;
  }
  function render() {
    if (!root) return;
    addCss();
    while (root.firstChild) root.removeChild(root.firstChild);
    if (!state.cameras) return;
    if (!state.cameras.length) { root.appendChild(el("p", "desc", "No video clips with media files in \"" + state.sequence + "\".")); return; }
    root.appendChild(el("span", "flabel", "Cameras in \"" + state.sequence + "\" and the LUT for each"));
    var folders = lutFolders();
    state.cameras.forEach(function (c) {
      var field = el("div", "field");
      var existing = Object.keys(c.existing).map(function (k) { return k + " x" + c.existing[k]; }).join(", ");
      field.appendChild(el("span", "flabel", c.camera + " · " + c.clips.length + " clip" + (c.clips.length === 1 ? "" : "s") + (existing ? " · has " + existing : "")));
      field.appendChild(picker(c, folders));
      root.appendChild(field);
    });
    if (!state.presets.length) root.appendChild(el("p", "desc", "No Lumetri presets of yours found. Press Make LUT presets, then in Premiere: Effects panel menu > Import Presets…"));
    if (state.nested && state.nested.length) root.appendChild(el("p", "desc", "This sequence uses nested sequence(s) (" + state.nested.join(", ") + "); Premiere brings in copies of them with the graded copy."));
  }

  // Make LUT presets: every 3D .cube under the chosen folder becomes a Lumetri effect preset
  // named after its file (LUT embedded in the Creative Look, like Lee's own "CANON LUT"), plus a
  // plain "Adjustments" preset, in one .prfpset for Effects panel > Import Presets.
  function makePresets(params) {
    var folder = params.folder;
    if (!folder || !fs.existsSync(folder)) return Promise.resolve({ ok: false, error: "Choose the folder that holds your LUTs." });
    var outDir = path.join(os.homedir(), "PenyToolkit-scratch", "colour");
    var out = path.join(outDir, path.basename(folder).replace(/[\/:]/g, "-") + " LUT Presets.prfpset");
    return listPresets().catch(function () { return { names: [] }; }).then(function (pr) {
      var spec = { bin: "Peny LUTs - " + path.basename(folder), paths: [folder] };
      if (pr.names.indexOf(ADJUSTMENTS) === -1) spec.adjustments = ADJUSTMENTS;
      fs.mkdirSync(outDir, { recursive: true });
      var specFile = path.join(outDir, "spec-" + Date.now() + ".json");
      fs.writeFileSync(specFile, JSON.stringify(spec));
      api.status("Colour: building presets from " + folder + "…");
      return runPy(["presets", out, specFile]).then(function (r) {
        try { fs.unlinkSync(specFile); } catch (e) {}
        var made = r.results.filter(function (x) { return x.ok; }), bad = r.results.filter(function (x) { return !x.ok; });
        var already = made.filter(function (x) { return pr.names.indexOf(x.name) !== -1; }).map(function (x) { return x.name; });
        return { ok: made.length > 0, error: made.length ? undefined : "No usable .cube LUTs in " + folder,
          summary: made.length + " preset(s) written to " + out + (bad.length ? "; " + bad.length + " LUT(s) could not be used" : "") + (r.skipped.length ? "; " + r.skipped.length + " skipped (duplicates or unsupported)" : "") +
            (already.length ? "; " + already.length + " have the same name as presets you already have" : "") +
            ". To load them: in Premiere, Effects panel menu (≡) > Import Presets…, choose that file. Then press Detect cameras.",
          details: { file: out, presets: made.map(function (x) { return x.name; }), failed: bad.map(function (x) { return { name: x.name, reason: x.error }; }),
            skipped: r.skipped.map(function (x) { return { name: path.basename(x.file), reason: x.reason }; }), alreadyYours: already } };
      });
    });
  }

  function wrap(name, fn) {
    return function (params) {
      busy = name;
      return Promise.resolve().then(function () { return fn(params || {}); })
        .catch(function (e) { return { ok: false, error: name + " failed: " + (e && e.message ? e.message : String(e)) }; })
        .then(function (r) { busy = null; return r; });
    };
  }

  return {
    actions: { detect: wrap("detect", detect), apply: wrap("apply", apply), makepresets: wrap("makepresets", makePresets) },
    busy: function () { return busy; },
    mount: function (element) { root = element; render(); }
  };
};
