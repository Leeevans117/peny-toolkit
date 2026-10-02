/* Ingest + proxies: Import footage -> Proxies render -> Proxies attach, in order.
 * It calls the other two skills' own actions (api.skillAction), so it behaves exactly
 * like pressing their buttons one after another, with the folders chosen once.
 * The "ingest" action is the same run stopped after step 1 (no proxy folder, no render,
 * no attach); the Ingest app (import-footage) uses it so both import the same way.
 * The proxy steps cover exactly the clips that come from the chosen folder, wherever
 * they sit in the project (found by media path), so footage imported earlier gets its
 * proxies too. A step that fails stops the run. */
var path = require("path");

module.exports = function (api) {
  function run(params, ingestOnly) {
    var steps = ingestOnly ? 1 : 3, title = ingestOnly ? "Ingest" : "Ingest + proxies";
    function step(n, name) { api.status("Step " + n + "/" + steps + ": " + name + "…"); api.log(title + ", step " + n + "/" + steps + ": " + name); }
    // No trim(): real folder names can end in a space ("Joe La Thuile FMD ").
    var folder = params.folder ? String(params.folder).replace(/(.)\/+$/, "$1") : "";
    var dest = params.dest ? String(params.dest).replace(/(.)\/+$/, "$1") : "";
    if (!folder || (!dest && !ingestOnly)) return Promise.resolve({ ok: false, error: ingestOnly ? "Needs a footage folder." : "Needs both a footage folder and a proxy folder." });
    var out = { folder: folder, dest: dest };

    step(1, "importing " + folder);
    return api.skillAction("import-footage", "import", {
      folder: folder, redWav: params.redWav === true || params.redWav === "true",
      linkedSequences: params.linkedSequences === true || params.linkedSequences === "true"
    }).then(function (imp) {
      out.import = { ok: imp.ok, summary: imp.ok ? imp.summary : imp.error, project: imp.project || null };
      if (!imp.ok) throw { stop: "Import failed: " + (imp.error || "") };
      if (ingestOnly) throw { ingested: imp }; // Ingest app: stop after step 1
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
      if (e && e.ingested) {
        api.status("Done.");
        return { ok: true, summary: "1) " + out.import.summary, project: out.import.project,
          details: { folder: folder, import: out.import, importDetails: e.ingested.details || {} } };
      }
      var msg = e && e.stop ? e.stop : "Stopped: " + (e && e.message ? e.message : String(e));
      api.status(msg);
      return { ok: false, error: msg, details: out };
    });
  }

  function control(name) {
    return function () { return api.skillAction("proxy-automation", name, {}); };
  }

  return { actions: {
    run: function (params) { return run(params, false); },
    ingest: function (params) { return run(params, true); },
    pause: control("pause"), resume: control("resume"), cancel: control("cancel") } };
};
