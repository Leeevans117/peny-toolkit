/* Import footage, panel side (Node). Ported from Master Footage Importer (CEP build,
 * index.js). walkLogic.js is the original module, unchanged: it decides what each
 * folder holds (RED .RDC folders become one clip from the first .R3D plus its wav,
 * ARRIRAW frame folders become one numbered-stills clip, other video/audio files are
 * imported as they are, Exports/Renders/Proxies/cache/LUT folders are skipped).
 * The folder tree is mirrored as bins and files already in the project are skipped.
 *
 * Same flow as the original: walk, queue files per bin, import each folder's files as
 * soon as that folder is resolved. Changed: the project's media paths are fetched
 * once and checked here (the original made one ExtendScript call per file), and
 * "preview" walks and plans without importing anything.
 */
var fs = require("fs");
var path = require("path");

module.exports = function (api) {
  var walkLogic = require(path.join(api.skillDir, "walkLogic.js"));

  // Callback-style fs wrapped in this page's Promise: after a CEP page reload,
  // fs.promises calls never resolve (seen 2 Oct 2026), callbacks still do.
  function readdir(p) { return new Promise(function (ok, no) { fs.readdir(p, function (e, n) { if (e) no(e); else ok(n); }); }); }
  function stat(p) { return new Promise(function (ok) { fs.stat(p, function (e, st) { ok(e ? null : st); }); }); }

  function listEntries(dirPath) {
    return readdir(dirPath).then(function (names) {
      return Promise.all(names.map(function (name) {
        var full = path.join(dirPath, name);
        return stat(full).then(function (st) { return st ? { name: name, isDir: st.isDirectory(), ref: full } : null; });
      })); // broken links / no permission come back null and are skipped, as in the original
    }).then(function (list) { return list.filter(Boolean); });
  }

  // Every /Volumes/<name> that is the start-up disk itself (realpath "/").
  function bootVolumePrefixes() {
    var out = [];
    try {
      fs.readdirSync("/Volumes").forEach(function (n) {
        try { if (fs.realpathSync(path.join("/Volumes", n)) === "/") out.push("/Volumes/" + n); } catch (e) {}
      });
    } catch (e) {}
    return out;
  }

  function run(params, doImport) {
    var root = params.folder ? String(params.folder).trim().replace(/\/+$/, "") : "";
    if (!root) return Promise.resolve({ ok: false, error: "Choose the footage folder first." });
    try { if (!fs.statSync(root).isDirectory()) return Promise.resolve({ ok: false, error: "Not a folder: " + root }); }
    catch (e) { return Promise.resolve({ ok: false, error: "Folder does not exist: " + root }); }

    var started = Date.now();
    var stats = { wrapperClips: 0, flatItems: 0, videoImported: 0, audioImported: 0, skippedExisting: 0,
      clipsWithNoWav: 0, importFailures: 0, warnings: 0 };
    var bins = [], warnings = [], failures = [], createdBins = [];
    var seen = {};
    var project = null;
    var pending = {};
    var redPairs = []; // RED clips with a matched wav: {chain, video, wav}
    // Media Browser imports a RED clip as its R3D only. Slow-motion RED clips keep their
    // real-time sound in a separate .wav (the R3D has no audio); Media Browser leaves
    // that out, so the toolkit does too unless "Also import slow-motion RED .wav" is on.
    var redWav = params.redWav === true || params.redWav === "true";
    var makeLinked = redWav && (params.linkedSequences === true || params.linkedSequences === "true");
    var bootPrefixes = bootVolumePrefixes();

    // Duplicates within this run are dropped here; files already in the project are
    // filtered per folder in flush(), by asking Premiere (the index stays there).
    function known(p) {
      if (seen[p]) return true;
      seen[p] = true;
      return false;
    }
    function queue(segs, file, numbered) {
      var key = JSON.stringify(segs);
      var e = pending[key] || (pending[key] = { segs: segs, plain: [], numbered: [] });
      (numbered ? e.numbered : e.plain).push(file);
    }
    function importGroup(segs, files, numbered) {
      if (!files.length) return Promise.resolve();
      var plan = { bin: segs.join(" / "), files: files.map(function (f) { return path.relative(root, f); }), numberedStills: numbered };
      if (!doImport) {
        bins.push(plan);
        files.forEach(function (f) { if (walkLogic.isAudioFile(f)) stats.audioImported++; else stats.videoImported++; });
        return Promise.resolve();
      }
      return api.evalSkill({ action: "import", chain: segs, paths: files, numbered: numbered, bootPrefixes: bootPrefixes }).then(function (r) {
        var d = r.details || {};
        (d.imported || []).forEach(function (f) { if (walkLogic.isAudioFile(f)) stats.audioImported++; else stats.videoImported++; });
        (d.createdBins || []).forEach(function (b) { createdBins.push(b); });
        var failed = d.failed || (r.ok ? [] : files);
        stats.importFailures += failed.length;
        failed.forEach(function (f) { failures.push({ bin: plan.bin, file: f, reason: r.error || "not in the bin after import" }); });
        plan.imported = (d.imported || []).length;
        plan.importFilesReturned = d.importFilesReturned;
        bins.push(plan);
        api.log("  " + (r.ok ? r.summary : r.error), r.ok ? "ok" : "err");
        api.status("Importing… " + (stats.videoImported + stats.audioImported) + " imported so far");
      });
    }
    function dropExisting(files) {
      if (!files.length) return Promise.resolve(files);
      return api.evalSkill({ action: "exists", paths: files, bootPrefixes: bootPrefixes }).then(function (r) {
        if (!r.ok) throw new Error(r.error);
        var found = {};
        (r.details.found || []).forEach(function (f) { found[f] = true; });
        stats.skippedExisting += (r.details.found || []).length;
        return files.filter(function (f) { return !found[f]; });
      });
    }
    function flush(segs) {
      var key = JSON.stringify(segs), e = pending[key];
      if (!e) return Promise.resolve();
      delete pending[key];
      return dropExisting(e.plain).then(function (plain) {
        return importGroup(segs, plain, false);
      }).then(function () { return dropExisting(e.numbered); }).then(function (numbered) {
        return importGroup(segs, numbered, true);
      });
    }

    return api.evalSkill({ action: "index", bootPrefixes: bootPrefixes }).then(function (idx) {
      if (!idx.ok) throw new Error(idx.error);
      project = idx.project || null;
      api.log("Project already has " + idx.details.count + " media items; those files are skipped.");
      return walkLogic.walkTree(root, path.basename(root), listEntries, function (item, segs) {
        if (item.type === "warning") { stats.warnings++; warnings.push(item.message); api.log("  WARN: " + item.message, "warn"); return; }
        if (item.type === "clip") {
          stats.wrapperClips++;
          var clip = item.representativeFile.ref;
          if (!known(clip)) queue(segs, clip, item.asNumberedStills);
          if (item.wav && item.kind === "red" && !redWav) {
            stats.redWavLeftOut = (stats.redWavLeftOut || 0) + 1;
          } else if (item.wav) {
            if (!known(item.wav.ref)) queue(segs, item.wav.ref, false);
            if (item.kind === "red") redPairs.push({ chain: segs, video: clip, wav: item.wav.ref });
          }
          else stats.clipsWithNoWav++;
        } else if (item.type === "flat") {
          stats.flatItems++;
          if (!known(item.file.ref)) queue(segs, item.file.ref, false);
        }
      }, {
        onEnterDir: function (segs) { api.status("Scanning: " + segs.join(" / ")); },
        onDirDone: function (segs) { return flush(segs); }
      });
    }).then(function () {
      if (!makeLinked || !redPairs.length) return null;
      if (!doImport) return { ok: true, summary: redPairs.length + " linked R3D+wav sequence(s) would be made (or skipped if already there).", details: {} };
      api.status("Making linked R3D+wav sequences…");
      return api.evalSkill({ action: "sync", pairs: redPairs, bootPrefixes: bootPrefixes });
    }).then(function (linked) {
      if (linked) api.log("  " + (linked.ok ? linked.summary : linked.error), linked.ok ? "ok" : "err");
      var secs = ((Date.now() - started) / 1000).toFixed(1);
      var verb = doImport ? "imported" : "would import";
      var summary = (stats.videoImported + stats.audioImported) + " " + verb + " (" + stats.videoImported + " video, " +
        stats.audioImported + " audio) into " + bins.length + " bin(s); " + stats.skippedExisting + " already in the project; " +
        stats.importFailures + " failed; " + stats.warnings + " warnings. " + secs + " s." +
        (stats.redWavLeftOut ? " " + stats.redWavLeftOut + " slow-motion RED .wav file(s) left out, as Media Browser does." : "");
      if (linked) summary += " Linked sequences: " + (linked.ok ? linked.summary : linked.error);
      var ld = (linked && linked.details) || {};
      return { ok: stats.importFailures === 0 && (!linked || linked.ok), project: project, summary: summary, error: summary, details: {
        root: root, stats: stats, bins: bins, createdBins: createdBins, failed: failures.concat(ld.failed || []), warnings: warnings,
        linkedSequences: linked ? { made: ld.made || [], skipped: ld.skipped || [], failed: ld.failed || [] } : null } };
    });
  }

  return {
    actions: {
      preview: function (params) { return run(params, false); },
      "import": function (params) { return run(params, true); }
    }
  };
};
