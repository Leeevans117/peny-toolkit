/* Ingest + proxies: Import footage -> Proxies render -> Proxies attach, in order.
 * It calls the other two skills' own actions (api.skillAction), so it behaves exactly
 * like pressing their buttons one after another, with the folders chosen once.
 * The proxy steps are scoped to the bin the footage folder was imported into (found by
 * nodeId, the same bin Import footage used). A step that fails stops the run. */
var path = require("path");

module.exports = function (api) {
  function step(n, name) { api.status("Step " + n + "/3: " + name + "…"); api.log("Ingest + proxies, step " + n + "/3: " + name); }

  function run(params) {
    var folder = params.folder ? String(params.folder).trim().replace(/\/+$/, "") : "";
    var dest = params.dest ? String(params.dest).trim() : "";
    if (!folder || !dest) return Promise.resolve({ ok: false, error: "Needs both a footage folder and a proxy folder." });
    var out = { folder: folder, dest: dest };

    step(1, "importing " + folder);
    return api.skillAction("import-footage", "import", {
      folder: folder, redWav: params.redWav === true, linkedSequences: false
    }).then(function (imp) {
      out.import = { ok: imp.ok, summary: imp.ok ? imp.summary : imp.error, project: imp.project || null };
      if (!imp.ok) throw { stop: "Import failed: " + (imp.error || "") };
      // Root bin of this import, by nodeId.
      return api.skillAction("import-footage", "rootbin", { name: path.basename(folder) });
    }).then(function (rb) {
      if (!rb || !rb.ok) throw { stop: "Could not find the bin the footage went into: " + (rb && rb.error) };
      out.bin = rb.details;
      step(2, "rendering proxies for bin " + rb.details.name);
      return api.skillAction("proxy-automation", "render", { binNodeId: rb.details.nodeId, dest: dest });
    }).then(function (ren) {
      out.render = { ok: ren.ok, summary: ren.ok ? ren.summary : ren.error, jobs: (ren.details && ren.details.jobs) || [],
        skipped: (ren.details && ren.details.skipped) || [] };
      if (!ren.ok) throw { stop: "Proxy render did not finish cleanly: " + (ren.error || ren.summary) };
      step(3, "attaching proxies");
      return api.skillAction("proxy-automation", "attach", { binNodeId: out.bin.nodeId, dest: dest });
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
