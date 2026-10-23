// Ingest + Proxies, Premiere side, for its job queue: which project is in
// front (a job is tied to it when the button is pressed), and saving one open project by
// path once its job has passed. Import and proxies reach that project through
// params.projectPath (core.jsx T.proj), not through the project in front.
(function (T) {
  function modified(path) { try { var f = new File(path); return f.exists ? f.modified.getTime() : 0; } catch (e) { return 0; } }

  function active() {
    if (!app.project) return T.fail("No project open.");
    var open = [], ps = app.projects;
    for (var i = 0; i < ps.numProjects; i++) { try { open.push({ name: String(ps[i].name), path: String(ps[i].path) }); } catch (e) {} }
    return T.ok("In front: " + app.project.name, { name: String(app.project.name), path: String(app.project.path), open: open });
  }

  function save(params) {
    var path = String(params.path || ""), p = T.findOpenProject(path);
    if (!p) return T.fail("Not open any more, so not saved: " + path);
    var m0 = modified(path), ret = null;
    try { ret = p.save(); } catch (e) { ret = "error: " + e; }
    var m1 = modified(path);
    var d = { returned: String(ret), modifiedBefore: m0, modifiedAfter: m1 };
    // Never trust the return: the file on disk must have been written.
    if (!(m1 > m0)) return T.fail("Save of " + p.name + " not confirmed: the file on disk did not change.", d);
    return T.ok("Saved " + p.name + ".", d);
  }

  T.skills["ingest-pipeline"] = function (params) {
    if (params.action === "active") return active();
    if (params.action === "save") return save(params);
    return T.fail("Unknown ingest-pipeline action: " + params.action);
  };
}(PenyToolkit));
