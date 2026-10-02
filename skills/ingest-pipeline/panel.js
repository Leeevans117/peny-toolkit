/* Ingest + proxies: Import footage -> Proxies render -> Proxies attach, in order.
 * It calls the other two skills' own actions (api.skillAction), so it behaves exactly
 * like pressing their buttons one after another, with the folders chosen once.
 * The proxy steps cover exactly the clips that come from the chosen folder, wherever
 * they sit in the project (found by media path), so footage imported earlier gets its
 * proxies too. A step that fails stops the run. */
var path = require("path");

module.exports = function (api) {
  function step(n, name) { api.status("Step " + n + "/3: " + name + "…"); api.log("Ingest + proxies, step " + n + "/3: " + name); }

  function run(params) {
    // No trim(): real folder names can end in a space ("Joe La Thuile FMD ").
    var folder = params.folder ? String(params.folder).replace(/(.)\/+$/, "$1") : "";
    var dest = params.dest ? String(params.dest).replace(/(.)\/+$/, "$1") : "";
    if (!folder || !dest) return Promise.resolve({ ok: false, error: "Needs both a footage folder and a proxy folder." });
    var out = { folder: folder, dest: dest };

    step(1, "importing " + folder);
    return api.skillAction("import-footage", "import", {
      folder: folder, redWav: params.redWav === true, linkedSequences: false
    }).then(function (imp) {
      out.import = { ok: imp.ok, summary: imp.ok ? imp.summary : imp.error, project: imp.project || null };
      if (!imp.ok) throw { stop: "Import failed: " + (imp.error || "") };
      // Stages 2 and 3 work on exactly the clips from this folder, wherever they are in
      // the project (just imported, or already there from an earlier import).
      out.scope = { mediaPaths: (imp.details && imp.details.mediaPaths) || [], bootPrefixes: (imp.details && imp.details.bootPrefixes) || [] };
      if (!out.scope.mediaPaths.length) throw { stop: "No video or audio files found in " + folder };
      step(2, "rendering proxies for " + out.scope.mediaPaths.length + " file(s) from the footage folder");
      return api.skillAction("proxy-automation", "render", { mediaPaths: out.scope.mediaPaths, bootPrefixes: out.scope.bootPrefixes, dest: dest });
    }).then(function (ren) {
      out.render = { ok: ren.ok, summary: ren.ok ? ren.summary : ren.error, jobs: (ren.details && ren.details.jobs) || [],
        skipped: (ren.details && ren.details.skipped) || [] };
      if (!ren.ok) throw { stop: "Proxy render did not finish cleanly: " + (ren.error || ren.summary) };
      step(3, "attaching proxies");
      return api.skillAction("proxy-automation", "attach", { mediaPaths: out.scope.mediaPaths, bootPrefixes: out.scope.bootPrefixes, dest: dest });
    }).then(function (att) {
      var d = att.details || {};
      out.attach = { ok: att.ok, summary: att.ok ? att.summary : att.error, attached: (d.attached || []).map(function (a) { return a.name; }),
        failed: d.failed || [], noProxyFile: d.noProxyFile || [] };
      var summary = "1) " + out.import.summary + "\n2) " + out.render.summary + "\n3) " + out.attach.summary;
      api.status("Done.");
      return { ok: att.ok, summary: summary, error: summary, project: out.import.project, details: out };
    }).catch(function (e) {
      var msg = e && e.stop ? e.stop : "Stopped: " + (e && e.message ? e.message : String(e));
      api.status(msg);
      return { ok: false, error: msg, details: out };
    });
  }

  function control(name) {
    return function () { return api.skillAction("proxy-automation", name, {}); };
  }

  return { actions: { run: run, pause: control("pause"), resume: control("resume"), cancel: control("cancel") } };
};
