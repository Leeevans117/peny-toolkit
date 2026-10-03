/* Colour baseline, panel side (Node). Three buttons:
 * - Detect cameras: reads the active sequence's video clips (premiere.jsx "scan"), works out each
 *   clip's camera from the file itself and lists the cameras with clip counts, each with a
 *   dropdown of Lee's Lumetri presets (read from Premiere's user preset file). The choice per
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
var os = require("os");
var childProcess = require("child_process");

var SETTINGS = path.join(os.homedir(), ".peny-toolkit", "colour-baseline.json");
var REDLINE = ["/usr/local/bin/REDline", "/Applications/REDCINE-X Professional/REDCINE-X PRO.app/Contents/MacOS/REDline"];
var ADJUSTMENTS = "Adjustments";
var NO_LUT = "";

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
  function python() { return firstExisting(["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"]); }
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
            if (c.choice && pr.names.indexOf(c.choice) === -1) c.choice = NO_LUT; // preset gone
          });
          writeSettings(settings);
          state = { cameras: cams, presets: pr.names, sequence: scan.details.sequence, nested: scan.details.nested };
          render();
          var lines = cams.map(function (c) { return c.camera + ": " + c.clips.length + " clip(s)" + (c.choice ? " -> " + c.choice : " -> no LUT"); });
          return { ok: true, summary: cams.length + " camera(s) in \"" + scan.details.sequence + "\": " + lines.join("; ") + "." +
            (pr.names.length ? "" : " No Lumetri presets of yours found (Make LUT presets, then Effects panel > Import Presets)."),
            details: { sequence: scan.details.sequence, cameras: cams.map(function (c) {
              return { camera: c.camera, model: c.model, clips: c.clips.length, choice: c.choice, existing: c.existing, folders: c.folders.filter(function (f, i, a) { return a.indexOf(f) === i; }).slice(0, 5) };
            }), skipped: scan.details.skipped, nested: scan.details.nested, presetFile: pr.file, presets: pr.names.length } };
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
    var scan0, cams, plan, presetsInfo, t0 = Date.now();
    return jsx({ action: "scan" }).then(function (scan) {
      if (!scan.ok) throw new Error(scan.error);
      scan0 = scan.details;
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
        if (pick && presetsInfo.names.indexOf(pick) === -1) missing.push(cam.camera + " -> " + pick);
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
      return jsx({ action: "exportproj", path: src });
    }).then(function (ex) {
      if (!ex.ok) throw new Error(ex.error);
      api.status("Colour: adding Adjustments and LUTs to " + plan.clips.length + " clip(s)…");
      return runPy(["grade", src, out, path.join(work, "plan.json")]);
    }).then(function (g) {
      if (g.problems.length) throw new Error(g.problems.length + " clip(s) could not be matched in the exported project; nothing was imported. First: " + JSON.stringify(g.problems[0]).slice(0, 200));
      api.status("Colour: importing the graded copy…");
      return jsx({ action: "importseq", path: out, ids: [plan.newSequence] });
    }).then(function (im) {
      if (!im.ok) throw new Error(im.error);
      var extra = im.details.added.filter(function (s) { return s.id !== plan.newSequence; });
      return jsx({ action: "finish", id: plan.newSequence, base: scan0.sequence }).then(function (fin) {
        if (!fin.ok) throw new Error(fin.error);
        return verify(fin, extra);
      });
    }).then(function (r) {
      r.details.work = work;
      r.summary += " Took " + Math.round((Date.now() - t0) / 1000) + " s.";
      return r;
    });

    // Every clip of the new sequence against the original: same clip, time and master clip, and
    // its Lumetri stack = Adjustments (if added), LUT (if added), then what it had.
    function verify(fin, extra) {
      var after = fin.details.clips, bad = [], ok = 0, lutAdded = 0, adjAdded = 0;
      scan0.clips.forEach(function (cl, i) {
        // trackItem.components lists effects bottom-up (file order); Effect Controls shows the
        // reverse. Expected in that list: what the clip had, then the LUT, then Adjustments last
        // = Adjustments on top in Effect Controls.
        var b = after[i], want = cl.lumetri.concat(cl.plan.lut ? [cl.plan.lut] : []).concat(cl.plan.adjustments ? [adj] : []);
        var same = b && b.track === cl.track && b.startTicks === cl.startTicks && b.item === cl.item && JSON.stringify(b.lumetri) === JSON.stringify(want);
        if (same) { ok++; if (cl.plan.lut) lutAdded++; if (cl.plan.adjustments) adjAdded++; }
        else bad.push({ name: cl.name, track: "V" + (cl.track + 1), expected: want, found: b ? b.lumetri : null });
      });
      var perCam = cams.map(function (c) {
        return { camera: c.camera, lut: c.pick || null, clips: c.full.length, lutAdded: c.full.filter(function (x) { return x.plan.lut; }).length,
          keptOwnLut: c.full.filter(function (x) { return !x.plan.lut && c.pick; }).length };
      });
      var summary = "\"" + fin.details.sequence + "\" made: Adjustments on " + adjAdded + " clip(s), LUT on " + lutAdded + " (" +
        perCam.map(function (c) { return c.camera + ": " + (c.lut || "no LUT") + (c.keptOwnLut ? ", " + c.keptOwnLut + " kept their own LUT" : ""); }).join("; ") +
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
  function render() {
    if (!root) return;
    while (root.firstChild) root.removeChild(root.firstChild);
    if (!state.cameras) return;
    if (!state.cameras.length) { root.appendChild(el("p", "desc", "No video clips with media files in \"" + state.sequence + "\".")); return; }
    root.appendChild(el("span", "flabel", "Cameras in \"" + state.sequence + "\" and the LUT for each"));
    state.cameras.forEach(function (c) {
      var field = el("div", "field");
      var existing = Object.keys(c.existing).map(function (k) { return k + " x" + c.existing[k]; }).join(", ");
      field.appendChild(el("span", "flabel", c.camera + " · " + c.clips.length + " clip" + (c.clips.length === 1 ? "" : "s") + (existing ? " · has " + existing : "")));
      var sel = el("select", "colour-select");
      var none = el("option", "", "No LUT (Adjustments only)"); none.value = NO_LUT; sel.appendChild(none);
      state.presets.filter(function (n) { return n !== ADJUSTMENTS; }).forEach(function (n) { var o = el("option", "", n); o.value = n; sel.appendChild(o); });
      sel.value = c.choice || NO_LUT;
      sel.addEventListener("change", function () {
        var s = readSettings();
        s.choices[c.camera] = sel.value;
        writeSettings(s);
        c.choice = sel.value;
        api.log("Colour: " + c.camera + " -> " + (sel.value || "no LUT"));
      });
      field.appendChild(sel);
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
