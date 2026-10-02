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

  function listEntries(dirPath) {
    return fs.promises.readdir(dirPath).then(function (names) {
      return Promise.all(names.map(function (name) {
        var full = path.join(dirPath, name);
        return fs.promises.stat(full).then(function (st) { return { name: name, isDir: st.isDirectory(), ref: full }; },
          function () { return null; }); // broken link or no permission: skip, as the original did
      }));
    }).then(function (list) { return list.filter(Boolean); });
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
    var existing = {}, seen = {};
    var pending = {};

    function known(p) {
      if (existing[p] || seen[p]) return true;
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
      return api.evalSkill({ action: "import", chain: segs, paths: files, numbered: numbered }).then(function (r) {
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
    function flush(segs) {
      var key = JSON.stringify(segs), e = pending[key];
      if (!e) return Promise.resolve();
      delete pending[key];
      return importGroup(segs, e.plain, false).then(function () { return importGroup(segs, e.numbered, true); });
    }

    return api.evalSkill({ action: "index" }).then(function (idx) {
      if (!idx.ok) throw new Error(idx.error);
      (idx.details.paths || []).forEach(function (p) { existing[p] = true; });
      api.log("Project already has " + idx.details.paths.length + " media items; those files are skipped.");
      return walkLogic.walkTree(root, path.basename(root), listEntries, function (item, segs) {
        if (item.type === "warning") { stats.warnings++; warnings.push(item.message); api.log("  WARN: " + item.message, "warn"); return; }
        if (item.type === "clip") {
          stats.wrapperClips++;
          var clip = item.representativeFile.ref;
          if (known(clip)) stats.skippedExisting++; else queue(segs, clip, item.asNumberedStills);
          if (item.wav) { if (known(item.wav.ref)) stats.skippedExisting++; else queue(segs, item.wav.ref, false); }
          else stats.clipsWithNoWav++;
        } else if (item.type === "flat") {
          stats.flatItems++;
          if (known(item.file.ref)) stats.skippedExisting++; else queue(segs, item.file.ref, false);
        }
      }, {
        onEnterDir: function (segs) { api.status("Scanning: " + segs.join(" / ")); },
        onDirDone: function (segs) { return flush(segs); }
      });
    }).then(function () {
      var secs = ((Date.now() - started) / 1000).toFixed(1);
      var verb = doImport ? "imported" : "would import";
      var summary = (stats.videoImported + stats.audioImported) + " " + verb + " (" + stats.videoImported + " video, " +
        stats.audioImported + " audio) into " + bins.length + " bin(s); " + stats.skippedExisting + " already in the project; " +
        stats.importFailures + " failed; " + stats.warnings + " warnings. " + secs + " s.";
      return { ok: stats.importFailures === 0, summary: summary, error: summary, details: {
        root: root, stats: stats, bins: bins, createdBins: createdBins, failed: failures, warnings: warnings } };
    });
  }

  return {
    actions: {
      preview: function (params) { return run(params, false); },
      "import": function (params) { return run(params, true); }
    }
  };
};
