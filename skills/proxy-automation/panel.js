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

var PROXY_INFIX = "_Proxy";
var LOOKUP_LEVELS_UP = 4;
var SCALE_W = 1280, SCALE_H = 720;
var FFMPEG = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"];
var REDLINE = ["/Applications/REDCINE-X Professional/REDCINE-X PRO.app/Contents/MacOS/REDline"];

function firstExisting(list) { for (var i = 0; i < list.length; i++) if (fs.existsSync(list[i])) return list[i]; return null; }
function q(s) { return '"' + String(s).replace(/(["\\$`])/g, "\\$1") + '"'; }
function extOf(p) { var d = p.lastIndexOf("."); return d === -1 ? "" : p.substring(d + 1).toLowerCase(); }
function stripExt(n) { var d = n.lastIndexOf("."); return d > -1 ? n.substring(0, d) : n; }
function commonPrefix(a, b) { var i = 0, n = Math.min(a.length, b.length); while (i < n && a.charAt(i) === b.charAt(i)) i++; return i; }

module.exports = function (api) {
  var jobs = api.jobs;
  var pool = null;

  // RED proxies use --primaryDev ("Export Ungraded RWG/Log3G10"): the same flat, ungraded
  // look Premiere shows for the raw R3D. Without it REDline applies the clip's IPP2
  // output transform (a graded Rec.709 look), so toggling proxies changed the picture
  // as if a LUT had been added (Lee, 2 Oct 2026).
  function encodeCommand(entry) {
    if (extOf(entry.mediaPath) === "r3d") {
      var redline = firstExisting(REDLINE);
      if (!redline) return null;
      return q(redline) + " --i " + q(entry.mediaPath) + " --o " + q(entry.nameNoExt + PROXY_INFIX) +
        " --outDir " + q(path.dirname(entry.outputPath)) + " --format 201 --res 4 --resizeX " + SCALE_W +
        " --resizeY " + SCALE_H + " --fit 3 --primaryDev";
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
      if (!p.render.length) return { ok: true, summary: "Nothing to render.", details: { done: brief(p.done), shared: brief(p.shared), skipped: brief(p.skipped, 500) } };

      pool = new jobs.JobPool({
        maxConcurrent: params.maxConcurrent || 4,
        log: api.log,
        onChange: function () {
          var s = pool.summary();
          api.status((s.paused ? "Paused. " : "") + s.ok + "/" + s.total + " done, " + s.running + " running, " +
            s.queued + " queued" + (s.failed + s.killed ? ", " + (s.failed + s.killed) + " failed" : ""));
        }
      });
      var noCmd = [];
      p.render.forEach(function (r) {
        try { fs.mkdirSync(path.dirname(r.outputPath), { recursive: true }); } catch (e) {}
        var cmd = encodeCommand(r);
        if (!cmd) { r.reason = "no " + (extOf(r.mediaPath) === "r3d" ? "REDline" : "ffmpeg") + " found"; noCmd.push(r); return; }
        pool.add({ key: r.outputPath, cmd: cmd, outputPath: r.outputPath, label: r.binPath + "/" + r.name });
      });
      pool.start();
      return pool.wait().then(function (s) {
        pool = null;
        var summary = s.ok + " of " + s.total + " rendered and checked complete" +
          (s.failed + s.killed ? ", " + (s.failed + s.killed) + " failed or killed" : "") +
          (s.cancelled ? " (cancelled)" : "") + ". " + p.done.length + " already had proxies, " + p.skipped.length + " skipped.";
        return { ok: s.failed + s.killed === 0 && !s.cancelled && !noCmd.length, summary: summary, error: summary, details: {
          scope: res.details.scope, jobs: s.jobs, done: brief(p.done), shared: brief(p.shared),
          skipped: brief(p.skipped, 500), noCommand: brief(noCmd) } };
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

  return { actions: actions, controls: ["pause", "resume", "cancel"] };
};
