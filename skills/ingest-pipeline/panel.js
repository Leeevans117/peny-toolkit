/* Ingest + proxies: Import footage -> Proxies render -> Proxies attach, in order.
 * It calls the other two skills' own actions (api.skillAction), so it behaves exactly
 * like pressing their buttons one after another, with the folders chosen once.
 * The "ingest" action is the same run stopped after step 1 (no proxy folder, no render,
 * no attach); the Ingest app (import-footage) uses it so both import the same way.
 * The proxy steps cover exactly the clips that come from the chosen folder, wherever
 * they sit in the project (found by media path), so footage imported earlier gets its
 * proxies too. A step that fails stops the run.
 *
 * Job queue (Lee, 22 Oct 2026): each press is a job tied to the project in front at that
 * moment (its path), and every step works on that project through api.setProjectTarget,
 * so clicking into another project mid-run changes nothing. Pressing the button again
 * while a run is going adds a job ("queue" action) that starts when the current one ends.
 * With "Save each project" on, a project is saved only after import, render and attach
 * all passed, and the save is confirmed by the file on disk changing; a job that fails is
 * left unsaved. Jobs live in memory: a panel reload or Premiere restart drops waiting ones. */
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
      if (stopAll) throw { stop: "Stopped after the import, before proxies." };
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

  // ---- Job queue ----
  var waiting = [], current = null, stopAll = false, seq = 0, busy = false;
  function isOn(v) { return v === true || v === "true"; }
  function jobText(j) { return "job " + j.n + " (" + j.projectName + " <- " + path.basename(j.folder) + ")"; }

  // A footage folder inside the proxy folder would import the proxies as footage (Lee, 23 Oct 2026).
  function insideDest(folder, dest) {
    var f = path.resolve(String(folder || "")), d = path.resolve(String(dest || ""));
    return !!d && (f === d || f.indexOf(d + path.sep) === 0);
  }

  function makeJob(params) {
    if (insideDest(params.folder, params.dest)) return Promise.reject({ stop: "The footage folder is inside the proxy folder, so the proxies would be imported as footage. Choose the footage folder (e.g. Footage > Whistler) in Step 1." });
    return api.evalSkill({ action: "active" }).then(function (a) {
      if (!a.ok) throw { stop: a.error || "No project open." };
      return { n: ++seq, projectName: a.details.name, projectPath: a.details.path,
        folder: params.folder, dest: params.dest, save: isOn(params.saveProject) };
    });
  }

  function runJob(j) {
    current = j;
    api.log("Ingest + proxies " + jobText(j) + ": starting in " + j.projectPath);
    api.setProjectTarget(j.projectPath);
    return run({ folder: j.folder, dest: j.dest }, false).then(function (r) {
      api.setProjectTarget(null);
      r.job = { n: j.n, project: j.projectName, folder: j.folder };
      if (!r.ok || !j.save) return r;
      return api.evalSkill({ action: "save", path: j.projectPath }).then(function (sv) {
        r.summary += "\n4) " + (sv.ok ? sv.summary : "NOT saved: " + sv.error);
        if (!sv.ok) { r.ok = false; r.error = r.summary; }
        return r;
      });
    }, function (e) { api.setProjectTarget(null); throw e; });
  }

  function runAll(params) {
    stopAll = false; busy = true;
    return makeJob(params).then(function (first) {
      var results = [];
      function next(j) {
        return runJob(j).then(function (r) {
          results.push(r);
          api.log("Ingest + proxies " + jobText(j) + ": " + (r.ok ? "passed" : "FAILED") + "\n" + (r.ok ? r.summary : r.error), r.ok ? "ok" : "err");
          if (stopAll || !waiting.length) return;
          return next(waiting.shift());
        });
      }
      return next(first).then(function () {
        current = null; busy = false;
        var dropped = waiting.splice(0, waiting.length);
        if (results.length === 1 && !dropped.length) return results[0];
        var okN = results.filter(function (r) { return r.ok; }).length;
        var summary = okN + " of " + results.length + " job(s) passed." + results.map(function (r) {
          return "\n\nJob " + r.job.n + ", " + r.job.project + " <- " + r.job.folder + ":\n" + (r.ok ? r.summary : r.error);
        }).join("") + (dropped.length ? "\n\nNot run (stopped): " + dropped.map(jobText).join(", ") : "");
        api.status(okN + " of " + results.length + " job(s) passed.");
        return { ok: okN === results.length && !dropped.length, summary: summary, error: summary, details: { jobs: results, notRun: dropped } };
      });
    }).catch(function (e) {
      current = null; busy = false; api.setProjectTarget(null);
      return { ok: false, error: e && e.stop ? e.stop : "Stopped: " + (e && e.message ? e.message : String(e)) };
    });
  }

  function enqueue(params) {
    var folder = params.folder ? String(params.folder).replace(/(.)\/+$/, "$1") : "";
    var dest = params.dest ? String(params.dest).replace(/(.)\/+$/, "$1") : "";
    if (!folder || !dest) return Promise.resolve({ ok: false, error: "Needs both a footage folder and a proxy folder." });
    return makeJob({ folder: folder, dest: dest, saveProject: params.saveProject }).then(function (j) {
      // Premiere can be busy for a minute (a big attach) before this press is read; if the run
      // ended meanwhile, don't leave the job waiting for some later, unrelated Run press.
      if (!busy) return { ok: false, error: "Not queued: the run had already finished. Press Run to start " + jobText(j) + "." };
      waiting.push(j);
      var s = "Queued " + jobText(j) + ". It starts after " + (current ? jobText(current) : "the current job") +
        (waiting.length > 1 ? " and " + (waiting.length - 1) + " other waiting job(s)" : "") + ".";
      api.log(s);
      return { ok: true, summary: s, details: { queued: waiting.map(jobText) } };
    }).catch(function (e) { return { ok: false, error: e && e.stop ? e.stop : String(e) }; });
  }

  function control(name) {
    return function () {
      if (name === "cancel") {
        stopAll = true;
        var dropped = waiting.splice(0, waiting.length);
        return api.skillAction("proxy-automation", "cancel", {}).then(function (r) {
          var s = (r.ok ? r.summary : "No render was running; the current job stops after its current step.") +
            (dropped.length ? " Waiting jobs dropped: " + dropped.map(jobText).join(", ") + "." : "");
          return { ok: true, summary: s };
        });
      }
      return api.skillAction("proxy-automation", name, {});
    };
  }

  return { actions: {
    run: function (params) { return runAll(params); },
    queue: enqueue,
    ingest: function (params) { return run(params, true); },
    pause: control("pause"), resume: control("resume"), cancel: control("cancel") } };
};
