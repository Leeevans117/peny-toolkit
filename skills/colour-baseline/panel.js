/* Colour baseline, panel side (Node). Two buttons:
 * - Detect cameras: reads the active sequence's video clips (premiere.jsx "scan"), works out each
 *   clip's camera from the file itself and lists the cameras with clip counts, each with a
 *   dropdown of Premiere's Lumetri presets (Lee's own presets first). The choice per camera is
 *   remembered in ~/.peny-toolkit/colour-baseline.json.
 * - Apply baseline grade: Make safe copy (unless already on a TOOLKIT COPY), then per camera the
 *   chosen LUT preset, then the "Adjustments" preset on every clip, so Effect Controls reads
 *   Adjustments (top) then the LUT Lumetri. Clips that already have them are skipped; every clip
 *   is read back. Nothing is saved.
 * Why presets: Premiere 26.5.2 scripts cannot load a LUT into Lumetri or rename an effect, but
 * app.project.applyLumetriPreset(name) adds a Lumetri named after the preset with its look loaded
 * (see premiere.jsx).
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
var BUNDLED_PRESETS = "/Applications/Adobe Premiere Pro 2026/Adobe Premiere Pro 2026.app/Contents/Resources/LocalizedPresets/en_US/Effect Presets/Lumetri Presets.prfpset";
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
  var bundled = null;

  function jsx(params) { return api.evalSkill(params); }

  function bundledNames() {
    if (bundled) return bundled;
    bundled = {};
    try {
      var x = fs.readFileSync(BUNDLED_PRESETS, "utf-8"), re = /<TreeItem ObjectID[\s\S]*?<Name>([^<]*)<\/Name>/g, m;
      while ((m = re.exec(x))) bundled[m[1]] = true;
    } catch (e) {}
    return bundled;
  }

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
        if (!cams[name]) { cams[name] = { camera: name, model: g.model || null, clips: [], existing: {}, folders: [] }; list.push(cams[name]); }
        var cam = cams[name];
        cam.folders.push(path.dirname(s.path));
        g.clips.forEach(function (c) {
          cam.clips.push({ track: c.track, nodeId: c.nodeId });
          (c.lumetri || []).forEach(function (n) { var k = n || "(unnamed Lumetri Color)"; cam.existing[k] = (cam.existing[k] || 0) + 1; });
        });
      });
      list.sort(function (a, b) { return b.clips.length - a.clips.length; });
      return list;
    });
  }

  // Suggested preset for a camera with no saved choice: one of Lee's own presets whose name
  // names the brand ("CANON LUT" for Canon, "RED LUT" for RED...).
  function suggest(camera, userPresets) {
    var brand = (/^(Canon|Sony|Nikon|RED|DJI|GoPro|Apple)\b/.exec(camera) || [])[1];
    if (!brand) return NO_LUT;
    var re = new RegExp("\\b" + brand + "\\b", "i");
    for (var i = 0; i < userPresets.length; i++) if (userPresets[i] !== ADJUSTMENTS && re.test(userPresets[i])) return userPresets[i];
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
      return jsx({ action: "presets" }).then(function (pr) {
        if (!pr.ok) return pr;
        var b = bundledNames(), user = pr.details.presets.filter(function (n) { return !b[n]; });
        return cameraFor(scan.details.clips, settings).then(function (cams) {
          cams.forEach(function (c) {
            if (!settings.choices.hasOwnProperty(c.camera)) c.suggested = suggest(c.camera, user);
            c.choice = settings.choices.hasOwnProperty(c.camera) ? settings.choices[c.camera] : c.suggested;
          });
          writeSettings(settings);
          state = { cameras: cams, presets: pr.details.presets, userPresets: user, sequence: scan.details.sequence };
          render();
          var hasAdj = pr.details.presets.indexOf(ADJUSTMENTS) !== -1;
          var lines = cams.map(function (c) { return c.camera + ": " + c.clips.length + " clip(s)" + (c.choice ? " -> " + c.choice : " -> no LUT"); });
          return { ok: true, summary: cams.length + " camera(s) in \"" + scan.details.sequence + "\": " + lines.join("; ") + "." +
            (hasAdj ? "" : " Premiere has no Lumetri preset called \"" + ADJUSTMENTS + "\" yet, so Apply will stop until one is saved."),
            details: { sequence: scan.details.sequence, cameras: cams.map(function (c) {
              return { camera: c.camera, model: c.model, clips: c.clips.length, choice: c.choice, existing: c.existing, folders: c.folders.filter(function (f, i, a) { return a.indexOf(f) === i; }).slice(0, 5) };
            }), skipped: scan.details.skipped, userPresets: user, presetCount: pr.details.presets.length, adjustmentsPreset: hasAdj } };
        });
      });
    });
  }

  function apply(params) {
    var adj = params.adjustments || ADJUSTMENTS;
    return jsx({ action: "presets" }).then(function (pr) {
      if (!pr.ok) return pr;
      if (pr.details.presets.indexOf(adj) === -1) {
        return { ok: false, error: "Premiere has no Lumetri preset called \"" + adj + "\", so nothing was changed. Put a plain Lumetri Color on any clip, right-click it in Effect Controls > Save Preset…, and name it " + adj + "." };
      }
      return jsx({ action: "copy" });
    }).then(function (cp) {
      if (!cp.ok) return cp;
      api.log("Colour: " + cp.summary);
      var settings = readSettings();
      return jsx({ action: "scan" }).then(function (scan) {
        if (!scan.ok) return scan;
        if (!scan.details.isCopy) return { ok: false, error: "The active sequence is not a TOOLKIT COPY after Make safe copy; nothing changed." };
        return cameraFor(scan.details.clips, settings).then(function (cams) {
          writeSettings(settings);
          var choices = params.choices || settings.choices;
          var groups = cams.map(function (c) {
            var pick = choices.hasOwnProperty(c.camera) ? choices[c.camera] : null;
            return { camera: c.camera, preset: pick || null, clips: c.clips, chosen: choices.hasOwnProperty(c.camera) };
          });
          var unchosen = groups.filter(function (g) { return !g.chosen; }).map(function (g) { return g.camera; });
          api.status("Colour: adding Lumetri presets to " + scan.details.clips.length + " clip(s)…");
          return jsx({ action: "apply", adjustments: adj, groups: groups.map(function (g) { return { camera: g.camera, preset: g.preset, clips: g.clips }; }) }).then(function (r) {
            r.details = r.details || {};
            r.details.copy = { name: cp.details.copyName, made: !!cp.details.made };
            if (unchosen.length) {
              r.details.noChoice = unchosen;
              if (r.ok) r.summary += " No LUT chosen yet for: " + unchosen.join(", ") + " (Adjustments only).";
            }
            if (r.ok && cp.details.made) r.summary = "Made safe copy \"" + cp.details.copyName + "\". " + r.summary;
            return r;
          });
        });
      });
    });
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
    root.appendChild(el("span", "flabel", "Cameras in \"" + state.sequence + "\" and the LUT preset for each"));
    state.cameras.forEach(function (c) {
      var field = el("div", "field");
      var existing = Object.keys(c.existing).map(function (k) { return k + " x" + c.existing[k]; }).join(", ");
      field.appendChild(el("span", "flabel", c.camera + " · " + c.clips.length + " clip" + (c.clips.length === 1 ? "" : "s") + (existing ? " · has " + existing : "")));
      var sel = el("select", "colour-select");
      var none = el("option", "", "No LUT (Adjustments only)"); none.value = NO_LUT; sel.appendChild(none);
      function group(label, names) {
        if (!names.length) return;
        var og = el("optgroup"); og.label = label;
        names.forEach(function (n) { var o = el("option", "", n); o.value = n; og.appendChild(o); });
        sel.appendChild(og);
      }
      group("Your Lumetri presets", state.userPresets.filter(function (n) { return n !== ADJUSTMENTS; }));
      group("Premiere's Lumetri presets", state.presets.filter(function (n) { return state.userPresets.indexOf(n) === -1; }));
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
    if (state.presets.indexOf(ADJUSTMENTS) === -1) {
      root.appendChild(el("p", "desc", "Premiere has no Lumetri preset called \"Adjustments\" yet. Put a plain Lumetri Color on any clip, right-click it in Effect Controls > Save Preset…, name it Adjustments."));
    }
  }

  // Make LUT presets: every 3D .cube under the chosen folder becomes a Lumetri effect preset
  // named after its file (LUT embedded, Creative Look slot, like Lee's own "CANON LUT"), plus a
  // plain "Adjustments" preset, written to one .prfpset for Effects panel > Import Presets.
  // Premiere's preset list is read without touching Premiere if a call to it fails.
  function makePresets(params) {
    var folder = params.folder;
    if (!folder || !fs.existsSync(folder)) return Promise.resolve({ ok: false, error: "Choose the folder that holds your LUTs." });
    var python = firstExisting(["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"]);
    var outDir = path.join(os.homedir(), "PenyToolkit-scratch", "colour");
    var out = path.join(outDir, path.basename(folder).replace(/[\/:]/g, "-") + " LUT Presets.prfpset");
    return jsx({ action: "presets" }).catch(function () { return { ok: false }; }).then(function (pr) {
      var have = pr && pr.ok ? pr.details.presets : [];
      var spec = { bin: "Peny LUTs - " + path.basename(folder), paths: [folder] };
      if (have.indexOf(ADJUSTMENTS) === -1) spec.adjustments = ADJUSTMENTS;
      fs.mkdirSync(outDir, { recursive: true });
      var specFile = path.join(outDir, "spec-" + Date.now() + ".json");
      fs.writeFileSync(specFile, JSON.stringify(spec));
      api.status("Colour: building presets from " + folder + "…");
      return new Promise(function (resolve) {
        childProcess.execFile(python, [path.join(api.skillDir, "lutpreset.py"), "presets", out, specFile], { maxBuffer: 16 * 1024 * 1024, timeout: 600000 }, function (err, stdout, stderr) {
          try { fs.unlinkSync(specFile); } catch (e) {}
          if (err) return resolve({ ok: false, error: "Making presets failed: " + String(stderr || err.message).slice(0, 400) });
          var r = JSON.parse(stdout), made = r.results.filter(function (x) { return x.ok; }), bad = r.results.filter(function (x) { return !x.ok; });
          var already = made.filter(function (x) { return have.indexOf(x.name) !== -1; }).map(function (x) { return x.name; });
          resolve({ ok: made.length > 0, error: made.length ? undefined : "No usable .cube LUTs in " + folder,
            summary: made.length + " preset(s) written to " + out + (bad.length ? "; " + bad.length + " LUT(s) could not be used" : "") + (r.skipped.length ? "; " + r.skipped.length + " skipped (duplicates or unsupported)" : "") +
              ". To load them in Premiere: Effects panel menu (≡) > Import Presets…, choose that file. Then press Detect cameras.",
            details: { file: out, presets: made.map(function (x) { return x.name; }), failed: bad.map(function (x) { return { name: x.name, reason: x.error }; }),
              skipped: r.skipped.map(function (x) { return { name: path.basename(x.file), reason: x.reason }; }), alreadyInPremiere: already } });
        });
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
