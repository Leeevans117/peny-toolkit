/* Camera model from the footage files themselves (not bin or file names). Same reading as the
 * Colour tile (skills/colour-baseline/panel.js, tested 3 Oct 2026): R3D -> REDline --printMeta 1
 * "Camera Model"; MP4/MXF/MOV -> model strings in the first 4 MB / last 2 MB of the file (Canon
 * "Canon EOS R5m2", Sony "ILCE-7SM3" / "ILME-FX6V", Nikon "niko" brand). One file is read per
 * folder and type (per reel for R3D); results are cached by path, size and date.
 *   detect(clips [{path}], { cacheFile, status }) -> Promise of clips, each with .camera (or null)
 */
var fs = require("fs");
var path = require("path");
var childProcess = require("child_process");
var REDLINE = ["/usr/local/bin/REDline", "/Applications/REDCINE-X Professional/REDCINE-X PRO.app/Contents/MacOS/REDline"];
function firstExisting(list) { for (var i = 0; i < list.length; i++) if (fs.existsSync(list[i])) return list[i]; return null; }
function extOf(p) { var d = p.lastIndexOf("."); return d === -1 ? "" : p.substring(d + 1).toLowerCase(); }

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

var AUDIO_EXT = /^(wav|mp3|aac|aif|aiff|m4a|wma|ogg|flac|caf|bwf)$/;
function readCache(f) { try { return JSON.parse(fs.readFileSync(f, "utf-8")); } catch (e) { return {}; } }
function writeCache(f, c) {
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + ".tmp", JSON.stringify(c)); fs.renameSync(f + ".tmp", f); } catch (e) {}
}
function detect(clips, opts) {
  opts = opts || {};
  var cache = opts.cacheFile ? readCache(opts.cacheFile) : {}, groups = {}, order = [];
  clips.forEach(function (c) {
    c.camera = null;
    var p = String(c.path || ""), ext = extOf(p);
    if (!p || AUDIO_EXT.test(ext)) return;
    var dir = path.dirname(p);
    var key = ext === "r3d" ? path.dirname(dir) + "|" + path.basename(p).slice(0, 4).toUpperCase() : dir + "|" + ext;
    if (!groups[key]) { groups[key] = { sample: p, clips: [] }; order.push(key); }
    groups[key].clips.push(c);
  });
  var probed = 0;
  return order.reduce(function (pr, key) {
    return pr.then(function () {
      var g = groups[key], file = g.sample, st = null;
      try { st = fs.statSync(file); } catch (e) { return; }
      var hit = cache[file];
      if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) { g.model = hit.model; return; }
      probed++;
      if (opts.status) opts.status("Reading camera " + probed + " (" + path.basename(file) + ")…");
      return (extOf(file) === "r3d" ? redModel(file) : fileModel(file)).then(function (m) {
        g.model = m;
        cache[file] = { size: st.size, mtime: st.mtimeMs, model: m };
      });
    });
  }, Promise.resolve()).then(function () {
    order.forEach(function (k) { var name = prettyModel(groups[k].model); groups[k].clips.forEach(function (c) { c.camera = name; }); });
    if (opts.cacheFile) writeCache(opts.cacheFile, cache);
    return clips;
  });
}

module.exports = { detect: detect, prettyModel: prettyModel, fileModel: fileModel, redModel: redModel };
