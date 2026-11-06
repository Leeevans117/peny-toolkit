/* Shoot date of each clip, read from the footage files (Lee, 6 Nov 2026: clips whose cameras'
 * dates match go in one Selects sequence, different dates in different ones).
 * The camera's own local date and time, in this order:
 *  - R3D: the clip header's recording date and time tags (0x23 "20260826", 0x24 "135620"; the
 *    0x30/0x31 pair beside them is UTC). Checked 6 Nov 2026 on World Champs: Sandell Day 1 =
 *    26 Aug, Day 2 = 27 Aug, Louis PRACTICE_1 = 26 Aug, TRAINING2 = 27 Aug, as the folders say.
 *  - Canon file names: A_0062C344H260927_000653EJ_... = 27 Sep 2026 00:06:53 (the camera's clock).
 *  - Sony sidecar XML (C0001M01.XML): <CreationDate value="2026-08-26T13:56:20+02:00"/>.
 *  - Broadcast wav (recorders, RED's own wavs): bext date + time, local.
 *  - QuickTime "com.apple.quicktime.creationdate" (iPhone), local with its offset.
 *  - Else the file's creation_time (UTC) in this Mac's time zone, marked approx.
 * A recording before 05:00 counts as the day before (a night shoot stays with its day).
 *   detect(clips [{path}], { cacheFile, ffprobe, status }) -> Promise; sets c.shootDay
 *   ("20260826" or null), c.shootTime ("135620" or null), c.dateFrom, c.size. */
var fs = require("fs");
var path = require("path");
var childProcess = require("child_process");
var EARLY = "050000"; // before this, the shoot day is the day before

function extOf(p) { var d = p.lastIndexOf("."); return d === -1 ? "" : p.substring(d + 1).toLowerCase(); }
function pad2(n) { return (n < 10 ? "0" : "") + n; }

function fromR3d(file) {
  var fd = null;
  try {
    fd = fs.openSync(file, "r");
    var buf = Buffer.alloc(65536), n = fs.readSync(fd, buf, 0, buf.length, 0), s = buf.toString("latin1", 0, n);
    var d = /\x00\x0c\x10#(\d{8})\x00/.exec(s), t = /\x00\x0a\x10\$(\d{6})\x00/.exec(s);
    return d ? { date: d[1], time: t ? t[1] : null, from: "RED header" } : null;
  } catch (e) { return null; }
  finally { if (fd !== null) try { fs.closeSync(fd); } catch (e2) {} }
}
function fromName(file) {
  var m = /^[A-Z]_\d{4}C\d{3,4}[A-Z](\d{2})(\d{2})(\d{2})_(\d{6})/.exec(path.basename(file));
  return m ? { date: "20" + m[1] + m[2] + m[3], time: m[4], from: "Canon file name" } : null;
}
function isoLocal(v, from) {
  var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(String(v || ""));
  return m ? { date: m[1] + m[2] + m[3], time: m[4] + m[5] + m[6], from: from } : null;
}
function fromSonyXml(file) {
  var base = file.replace(/\.[^.\/]+$/, "");
  var tries = [base + "M01.XML", base + "M01.xml"];
  for (var i = 0; i < tries.length; i++) {
    try {
      var x = fs.readFileSync(tries[i], "utf-8").slice(0, 20000), m = /<CreationDate\s+value="([^"]+)"/.exec(x);
      if (m) return isoLocal(m[1], "Sony XML");
    } catch (e) {}
  }
  return null;
}
function fromFfprobe(file, ffprobe) {
  if (!ffprobe) return Promise.resolve(null);
  return new Promise(function (resolve) {
    childProcess.execFile(ffprobe, ["-v", "error", "-show_entries", "format_tags", "-of", "json", file], { timeout: 30000 }, function (err, out) {
      var tags = {};
      try { tags = (JSON.parse(String(out || "{}")).format || {}).tags || {}; } catch (e) {}
      // Broadcast wav (bext): date "2026-08-26" + creation_time "13:56:20", the recorder's local clock.
      if (/^\d{4}-\d{2}-\d{2}$/.test(tags.date || "") && /^\d{2}:\d{2}:\d{2}$/.test(tags.creation_time || ""))
        return resolve({ date: tags.date.replace(/-/g, ""), time: tags.creation_time.replace(/:/g, ""), from: "wav (bext)" });
      var qt = tags["com.apple.quicktime.creationdate"];
      if (qt) return resolve(isoLocal(qt, "QuickTime date"));
      var ct = tags.creation_time;
      if (!ct) return resolve(null);
      var d = new Date(ct);
      if (isNaN(d.getTime()) || d.getFullYear() < 1990) return resolve(null);
      resolve({ date: d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()), time: pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds()), from: "file date (UTC, this Mac's time zone)" });
    });
  });
}
function readOne(file, ffprobe) {
  var ext = extOf(file);
  if (ext === "r3d") return Promise.resolve(fromR3d(file));
  var r = fromName(file) || fromSonyXml(file);
  return r ? Promise.resolve(r) : fromFfprobe(file, ffprobe);
}
// "20260826" + "013000" -> "20260825" (before 05:00 = the day before).
function shootDay(date, time) {
  if (!date) return null;
  if (!time || time >= EARLY) return date;
  var d = new Date(Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8)) - 86400000);
  return d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate());
}

function readCache(f) { try { return JSON.parse(fs.readFileSync(f, "utf-8")); } catch (e) { return {}; } }
function writeCache(f, c) {
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + ".tmp", JSON.stringify(c)); fs.renameSync(f + ".tmp", f); } catch (e) {}
}
function detect(clips, opts) {
  opts = opts || {};
  var cache = opts.cacheFile ? readCache(opts.cacheFile) : {}, n = 0;
  return clips.reduce(function (pr, c) {
    return pr.then(function () {
      c.shootDay = null; c.shootTime = null; c.dateFrom = null; c.size = null;
      var p = String(c.path || "");
      if (!p) return;
      var st = null;
      try { st = fs.statSync(p); } catch (e) { return; }
      c.size = st.size;
      var hit = cache[p];
      var got = hit && hit.size === st.size && hit.mtime === st.mtimeMs ? Promise.resolve(hit.r) : readOne(p, opts.ffprobe).then(function (r) {
        cache[p] = { size: st.size, mtime: st.mtimeMs, r: r };
        return r;
      });
      if (opts.status && ++n % 50 === 0) opts.status("Reading shoot dates " + n + " of " + clips.length + "…");
      return got.then(function (r) {
        if (!r) return;
        c.shootDay = shootDay(r.date, r.time); c.shootTime = r.time; c.dateFrom = r.from;
      });
    });
  }, Promise.resolve()).then(function () {
    if (opts.cacheFile) writeCache(opts.cacheFile, cache);
    return clips;
  });
}

module.exports = { detect: detect, shootDay: shootDay, fromR3d: fromR3d, fromName: fromName, fromSonyXml: fromSonyXml, readOne: readOne };
