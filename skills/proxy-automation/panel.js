/* Proxy automation, panel side (Node). Ported from the Proxy Automation panel
 * (com.peny.proxyautomation main.js + hostscript.jsx). Renders run here through
 * core/jobs.js instead of ExtendScript's system.callSystem, which is undefined in
 * Premiere 26 (the original panel's main blocker).
 *
 * Kept from the original: proxy naming (<item name>_Proxy.mov in a folder tree that
 * mirrors the bins), the ffmpeg and REDline commands, the moov-atom completeness check,
 * the proxy lookup (same folder, up to 4 levels up, then a whole-tree index matched by
 * folder similarity), max 4 renders at once, stall/timeout kills, Pause/Resume/Cancel.
 *
 * Changed on purpose:
 *  - never deletes or overwrites a proxy: ffmpeg runs with -n, an existing incomplete
 *    file is reported, not removed (the original deleted it and re-rendered).
 *  - works on a chosen bin (or the bins selected in the Project panel); "ALL" = whole project.
 *  - MP4/R3D (or any) clips that would write the same proxy file: the R3D wins, the
 *    others are reported (Lee's rule for the known collision bug).
 *  - the same media in two bins renders once; attach finds the shared proxy.
 *  - every attach/detach is read back in Premiere.
 */
var fs = require("fs");
var path = require("path");
// Tools put in place by the one-click installer (no Homebrew needed). Used first when
// present: they are the versions the toolkit was tested with, and their python3 has numpy
// (a Homebrew python3 without numpy would break Sync, Sound Pass and Colour).
function BUNDLED(name) { return path.join(process.env.HOME || "", "Library", "Application Support", "PenyToolkit", "bin", name); }

var PROXY_INFIX = "_Proxy";
var LOOKUP_LEVELS_UP = 4;
var SCALE_W = 1280, SCALE_H = 720;
var FFMPEG = [BUNDLED("ffmpeg"), "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"];
var REDLINE = ["/Applications/REDCINE-X Professional/REDCINE-X PRO.app/Contents/MacOS/REDline"];

function firstExisting(list) { for (var i = 0; i < list.length; i++) if (fs.existsSync(list[i])) return list[i]; return null; }
function q(s) { return '"' + String(s).replace(/(["\\$`])/g, "\\$1") + '"'; }
function extOf(p) { var d = p.lastIndexOf("."); return d === -1 ? "" : p.substring(d + 1).toLowerCase(); }
function stripExt(n) { var d = n.lastIndexOf("."); return d > -1 ? n.substring(0, d) : n; }
// Source bytes, the ETA's work measure. A RED clip is _001.R3D, _002.R3D... in one folder.
function sourceBytes(p) {
  try {
    var m = /^(.*)_\d{3}\.r3d$/i.exec(path.basename(p));
    if (!m) return fs.statSync(p).size;
    var dir = path.dirname(p), pre = m[1].toLowerCase() + "_", total = 0;
    fs.readdirSync(dir).forEach(function (n) {
      var l = n.toLowerCase();
      if (l.indexOf(pre) === 0 && /_\d{3}\.r3d$/.test(l)) { try { total += fs.statSync(path.join(dir, n)).size; } catch (e) {} }
    });
    return total || fs.statSync(p).size;
  } catch (e) { return 0; }
}
// Camera model from the first 256 KB of the file ("KOMODO-X 6K S35", "NIKON ZR",
// "Canon EOS R5m2"): the ETA times each camera separately, as their render speed per byte
// differs a lot (Komodo 10 s/GB, Nikon ZR R3D 5 s/GB, 12 Oct 2026). "" if none found.
var CAMERA_RE = /(KOMODO[-\w]*(?: \w+)*?(?= S35|\b)|V-RAPTOR[-\w ]*?(?=\x00|$)|RAPTOR|MONSTRO|HELIUM|GEMINI|DRAGON[-\w]*|NIKON Z\w+|Canon EOS [\w-]+|ILME-\w+|ILCE-\w+|DC-\w+|BMPCC\w*|URSA[\w ]*)/;
function cameraOf(p) {
  try {
    var fd = fs.openSync(p, "r"), buf = Buffer.alloc(262144), n;
    try { n = fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
    var m = CAMERA_RE.exec(buf.toString("latin1", 0, n));
    return m ? m[1].trim() : "";
  } catch (e) { return ""; }
}
function commonPrefix(a, b) { var i = 0, n = Math.min(a.length, b.length); while (i < n && a.charAt(i) === b.charAt(i)) i++; return i; }

module.exports = function (api) {
  var jobs = api.jobs;
  var pool = null;

  // RED proxies use --primaryDev ("Export Ungraded RWG/Log3G10"): the same flat, ungraded
  // look Premiere shows for the raw R3D. Without it REDline applies the clip's IPP2
  // output transform (a graded Rec.709 look), so toggling proxies changed the picture
  // as if a LUT had been added (Lee, 2 Oct 2026).
  // --useMeta: develop at the clip's shot white balance/tint/ISO as Premiere does. Without it
  // REDline uses its defaults (5600K, tint 0, ISO 320), so a 4800K clip's proxy came out warm
  // (Lee, 2 Oct 2026). --metaIgnoreFrameGuide keeps in-camera frame guides from cropping.
  function encodeCommand(entry) {
    if (extOf(entry.mediaPath) === "r3d") {
      var redline = firstExisting(REDLINE);
      if (!redline) return null;
      return q(redline) + " --i " + q(entry.mediaPath) + " --o " + q(entry.nameNoExt + PROXY_INFIX) +
        " --outDir " + q(path.dirname(entry.outputPath)) + " --format 201 --res 4 --resizeX " + SCALE_W +
        " --resizeY " + SCALE_H + " --fit 3 --primaryDev --useMeta --metaIgnoreFrameGuide";
    }
    var ffmpeg = firstExisting(FFMPEG);
    if (!ffmpeg) return null;
    // -n: never overwrite (the original used -y).
    return q(ffmpeg) + " -n -hwaccel videotoolbox -i " + q(entry.mediaPath) +
      ' -map 0:v:0 -map "0:a?" -vf scale=' + SCALE_W + ":" + SCALE_H +
      " -c:v prores_videotoolbox -profile:v 0 -pix_fmt yuv422p10le -c:a pcm_s24le " + q(entry.outputPath);
  }

  // Whole-tree index of existing proxy files under root: lower-case base name -> [{file, dir}].
  function indexProxies(root) {
    var index = {}, stack = [root], infix = PROXY_INFIX.toLowerCase() + ".";
    while (stack.length) {
      var dir = stack.pop(), entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
      entries.forEach(function (d) {
        if (d.name.charAt(0) === ".") return;
        var full = path.join(dir, d.name);
        if (d.isDirectory()) { stack.push(full); return; }
        var pos = d.name.toLowerCase().indexOf(infix);
        if (pos === -1) return;
        var base = d.name.substring(0, pos).toLowerCase();
        (index[base] = index[base] || []).push({ file: full, dir: dir });
      });
    }
    return index;
  }

  // Same lookup order as the original findExistingProxyFile + resolveProxyFromGlobalIndex,
  // but never climbing above the proxy root.
  function resolveProxy(root, binPath, nameNoExt, index) {
    var prefix = (nameNoExt + PROXY_INFIX + ".").toLowerCase();
    var dir = path.join(root, binPath);
    for (var level = 0; level <= LOOKUP_LEVELS_UP; level++) {
      var names = [];
      try { names = fs.readdirSync(dir); } catch (e) {}
      for (var i = 0; i < names.length; i++) if (names[i].toLowerCase().indexOf(prefix) === 0) return path.join(dir, names[i]);
      if (path.resolve(dir) === path.resolve(root)) break;
      dir = path.dirname(dir);
    }
    var c = index[nameNoExt.toLowerCase()];
    if (!c || !c.length) return null;
    var want = path.join(root, binPath), best = c[0], score = -1;
    c.forEach(function (x) { var s = commonPrefix(x.dir, want); if (s > score) { score = s; best = x; } });
    return best.file;
  }

  function checkRoot(params) {
    // No trim(): real folder names can end in a space ("Joe La Thuile FMD ").
    var root = params.dest ? String(params.dest).replace(/(.)\/+$/, "$1") : "";
    if (!root) return { error: "Choose the proxy folder first." };
    try { if (!fs.statSync(root).isDirectory()) return { error: "Not a folder: " + root }; }
    catch (e) { return { error: "Proxy folder does not exist: " + root }; }
    return { root: root };
  }

  function listScope(params) {
    var q = { action: "list", bin: params.bin || "", binNodeId: params.binNodeId || "" };
    if (params.mediaPaths) { q.mediaPaths = params.mediaPaths; q.bootPrefixes = params.bootPrefixes || []; }
    return api.evalSkill(q);
  }

  // Works out what to render without touching anything.
  function plan(items, root) {
    var index = indexProxies(root);
    var p = { render: [], done: [], skipped: [], shared: [] };
    var byOutput = {}, byMedia = {};
    items.forEach(function (it) {
      var rec = { nodeId: it.nodeId, name: it.name, mediaPath: it.mediaPath, binPath: it.binPath };
      if (it.offline) { rec.reason = "media offline"; p.skipped.push(rec); return; }
      if (it.hasProxy && it.proxyPath && fs.existsSync(it.proxyPath) && jobs.isCompleteMov(it.proxyPath)) {
        rec.reason = "proxy attached: " + it.proxyPath; p.done.push(rec); return;
      }
      var nameNoExt = stripExt(it.name);
      var found = resolveProxy(root, it.binPath, nameNoExt, index);
      if (found) {
        if (jobs.isCompleteMov(found)) { rec.reason = "proxy on disk: " + found; p.done.push(rec); }
        else { rec.reason = "incomplete proxy on disk, left alone (delete it by hand to re-render): " + found; p.skipped.push(rec); }
        return;
      }
      var mediaKey = it.mediaPath;
      if (byMedia[mediaKey]) { rec.reason = "same media as " + byMedia[mediaKey].binPath + "/" + byMedia[mediaKey].name + "; rendered once, attach shares it"; p.shared.push(rec); return; }
      rec.nameNoExt = nameNoExt;
      rec.outputPath = path.join(root, it.binPath, nameNoExt + PROXY_INFIX + ".mov");
      var outKey = rec.outputPath.toLowerCase();
      var clash = byOutput[outKey];
      if (clash) {
        var newIsR3d = extOf(rec.mediaPath) === "r3d", oldIsR3d = extOf(clash.mediaPath) === "r3d";
        if (newIsR3d && !oldIsR3d) {
          p.render.splice(p.render.indexOf(clash), 1);
          delete byMedia[clash.mediaPath];
          clash.reason = "same proxy name as " + rec.mediaPath + "; the R3D wins";
          p.skipped.push(clash);
        } else {
          rec.reason = "same proxy name as " + clash.mediaPath + (oldIsR3d ? "; the R3D wins" : "; first one wins");
          p.skipped.push(rec);
          return;
        }
      }
      byOutput[outKey] = rec;
      byMedia[mediaKey] = rec;
      p.render.push(rec);
    });
    return p;
  }

  function brief(list, n) {
    return list.slice(0, n || 50).map(function (r) {
      return { name: r.name, bin: r.binPath, outputPath: r.outputPath, reason: r.reason };
    });
  }

  var actions = {};

  actions.render = function (params) {
    if (pool) return Promise.resolve({ ok: false, error: "A render is already running. Pause, resume or cancel it first." });
    var c = checkRoot(params);
    if (c.error) return Promise.resolve({ ok: false, error: c.error });
    return listScope(params).then(function (res) {
      if (!res.ok) return res;
      var p = plan(res.details.items, c.root);
      api.log("Plan: " + p.render.length + " to render, " + p.done.length + " already have proxies, " +
        p.shared.length + " share media, " + p.skipped.length + " skipped.");
      p.skipped.forEach(function (r) { api.log("  skipped: " + r.binPath + "/" + r.name + " - " + r.reason, "warn"); });
      if (params.dryRun) {
        return { ok: true, summary: "Dry run: " + p.render.length + " would render.", details: {
          scope: res.details.scope, tally: res.details.tally, render: brief(p.render, 500), done: brief(p.done),
          shared: brief(p.shared), skipped: brief(p.skipped, 500) } };
      }
      if (!p.render.length) {
        api.progress({ event: "none", total: 0, finished: 0, ok: 0, failed: 0, running: 0, queued: 0, fraction: 1, percent: 100,
          already: p.done.length });
        return { ok: true, summary: "Nothing to render.", details: { done: brief(p.done), shared: brief(p.shared), skipped: brief(p.skipped, 500) } };
      }

      pool = new jobs.JobPool({
        maxConcurrent: params.maxConcurrent || 4,
        // Render speed per kind kept between runs, so the time left is right from the start.
        etaHistoryFile: params.etaHistoryFile || path.join(require("os").homedir(), ".peny-toolkit", "proxy-eta.json"),
        log: api.log,
        onChange: function () {
          var s = pool.summary();
          api.status((s.paused ? "Paused. " : "") + s.ok + "/" + s.total + " done, " + s.running + " running, " +
            s.queued + " queued" + (s.failed + s.killed ? ", " + (s.failed + s.killed) + " failed" : ""));
        },
        // Drives the overall progress bar: finished renders (real process exits) plus the
        // running renders' own fractions; see core/jobs.js.
        onProgress: function (pr) { pr.already = p.done.length; api.progress(pr); }
      });
      var noCmd = [];
      // ETA: each camera is timed separately, so the first wave starts one clip of each
      // camera (in order of first appearance) instead of leaving some until the end.
      var seenCam = {}, firsts = [];
      p.render.forEach(function (r, i) { r.camera = cameraOf(r.mediaPath) || extOf(r.mediaPath); if (!seenCam[r.camera]) { seenCam[r.camera] = 1; firsts.push(i); } });
      var waveN = params.maxConcurrent || 4;
      firsts.slice(0, waveN).forEach(function (idx, slot) {
        var at = p.render.indexOf(p.render.filter(function (r) { return r.camera === p.render[idx].camera; })[0]);
        if (at > slot) p.render.splice(slot, 0, p.render.splice(at, 1)[0]);
      });
      p.render.forEach(function (r) {
        try { fs.mkdirSync(path.dirname(r.outputPath), { recursive: true }); } catch (e) {}
        var cmd = encodeCommand(r);
        if (!cmd) { r.reason = "no " + (extOf(r.mediaPath) === "r3d" ? "REDline" : "ffmpeg") + " found"; noCmd.push(r); return; }
        pool.add({ key: r.outputPath, cmd: cmd, outputPath: r.outputPath, label: r.binPath + "/" + r.name,
          weight: sourceBytes(r.mediaPath), kind: extOf(r.mediaPath) === "r3d" ? "r3d" : "ffmpeg",
          group: r.camera });
      });
      var startedAt = Date.now();
      pool.start();
      return pool.wait().then(function (s) {
        var pr = pool.progress(); pr.event = "finished"; pr.already = p.done.length; api.progress(pr);
        // First ETA vs the real finish, for checking the estimate (log + result details).
        var e = pool.eta, etaCheck = null;
        if (e) {
          etaCheck = { firstEstimateAfterSec: Math.round((e.firstAt - startedAt) / 1000), firstEstimateLeftSec: Math.round(e.firstSec),
            actualLeftSec: Math.round((Date.now() - e.firstAt) / 1000), totalSec: Math.round((Date.now() - startedAt) / 1000) };
          api.log("ETA check: first estimate " + etaCheck.firstEstimateAfterSec + " s in said " + etaCheck.firstEstimateLeftSec +
            " s left; it took " + etaCheck.actualLeftSec + " s (whole run " + etaCheck.totalSec + " s).");
        }
        pool = null;
        var summary = s.ok + " of " + s.total + " rendered and checked complete" +
          (s.failed + s.killed ? ", " + (s.failed + s.killed) + " failed or killed" : "") +
          (s.cancelled ? " (cancelled)" : "") + ". " + p.done.length + " already had proxies, " + p.skipped.length + " skipped.";
        return { ok: s.failed + s.killed === 0 && !s.cancelled && !noCmd.length, summary: summary, error: summary, details: {
          scope: res.details.scope, jobs: s.jobs, done: brief(p.done), shared: brief(p.shared),
          skipped: brief(p.skipped, 500), noCommand: brief(noCmd), eta: etaCheck } };
      });
    });
  };

  actions.pause = function () {
    if (!pool) return Promise.resolve({ ok: false, error: "No render running." });
    pool.pause();
    return Promise.resolve({ ok: true, summary: "Paused. Renders already running carry on; nothing new starts until Resume." });
  };
  actions.resume = function () {
    if (!pool) return Promise.resolve({ ok: false, error: "No render running." });
    pool.resume();
    return Promise.resolve({ ok: true, summary: "Resumed." });
  };
  actions.cancel = function () {
    if (!pool) return Promise.resolve({ ok: false, error: "No render running." });
    pool.cancel();
    return Promise.resolve({ ok: true, summary: "Cancel sent: queued renders dropped, running ones killed. Partial files are left on disk (nothing is deleted)." });
  };

  actions.attach = function (params) {
    var c = checkRoot(params);
    if (c.error) return Promise.resolve({ ok: false, error: c.error });
    return listScope(params).then(function (res) {
      if (!res.ok) return res;
      var index = indexProxies(c.root), pairs = [], missing = [], incomplete = [], already = [];
      res.details.items.forEach(function (it) {
        var found = resolveProxy(c.root, it.binPath, stripExt(it.name), index);
        if (!found) { missing.push({ name: it.name, bin: it.binPath }); return; }
        if (!jobs.isCompleteMov(found)) { incomplete.push({ name: it.name, bin: it.binPath, file: found }); return; }
        if (it.hasProxy && it.proxyPath && path.resolve(it.proxyPath) === path.resolve(found)) { already.push({ name: it.name, file: found }); return; }
        pairs.push({ nodeId: it.nodeId, path: found });
      });
      return api.evalSkill({ action: "attach", pairs: pairs }).then(function (r) {
        var d = r.details || {};
        var summary = (d.attached || []).length + " attached and verified, " + already.length + " already attached, " +
          (d.failed || []).length + " failed, " + missing.length + " have no proxy file, " + incomplete.length + " proxy files incomplete.";
        return { ok: r.ok && !incomplete.length, summary: summary, error: summary, details: {
          attached: d.attached || [], failed: d.failed || [], alreadyAttached: already, noProxyFile: missing, incomplete: incomplete } };
      });
    });
  };

  actions.detach = function (params) {
    return listScope(params).then(function (res) {
      if (!res.ok) return res;
      var ids = res.details.items.filter(function (it) { return it.hasProxy; }).map(function (it) { return it.nodeId; });
      if (!ids.length) return { ok: true, summary: "No proxies attached in " + res.details.scope.join(", ") + ".", details: {} };
      return api.evalSkill({ action: "detach", nodeIds: ids });
    });
  };

  return { actions: actions, controls: ["pause", "resume", "cancel"], busy: function () { return pool ? "render pool running" : null; } };
};
