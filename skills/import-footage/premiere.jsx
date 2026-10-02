// Import footage, Premiere side. Ported from Master Footage Importer (CEP build,
// jsx/main.jsx, com.peny.importredmirrorbins.cep 2.0.0). Same bin logic:
//  - the root bin (first path segment) reuses an existing bin of that name anywhere in
//    the project if there is exactly one, otherwise it is found/created at the root;
//  - every further segment is a direct child bin, found or created.
// Changed: an import is judged by reading the bin back, never by importFiles' return
// value, and only files that are really missing get a one-at-a-time retry (the
// original retried every file whenever importFiles returned false, which can import
// duplicates if that return is wrong). Nothing is deleted, renamed or moved.
//   action "index"  -> builds the project's media-path index (kept in Premiere; returns a count)
//   action "exists" -> params.paths: returns the ones already in the project (small replies only;
//                      a 600 KB reply with every path was lost on the way back to the panel)
//   action "import" -> params.chain [bin names], params.paths [files], params.numbered
(function (T) {
  var I = T.importer = T.importer || {};

  function norm(p) { return p ? String(p).replace(/\\/g, "/") : p; }

  function index() {
    I.binsByName = {};
    I.binCache = {};
    I.pathIndex = {};
    var count = 0, stack = [app.project.rootItem];
    while (stack.length) {
      var bin = stack.pop();
      for (var i = 0; i < bin.children.numItems; i++) {
        var ch = bin.children[i];
        if (ch.type == ProjectItemType.BIN) {
          (I.binsByName[ch.name] = I.binsByName[ch.name] || []).push(ch);
          stack.push(ch);
        } else {
          try { var mp = ch.getMediaPath ? ch.getMediaPath() : null; if (mp) { I.pathIndex[norm(mp)] = true; count++; } } catch (e) {}
        }
      }
    }
    return T.ok(count + " media items already in the project.", { count: count });
  }

  function exists(params) {
    if (!I.pathIndex) index();
    var paths = params.paths || [], found = [];
    for (var i = 0; i < paths.length; i++) if (I.pathIndex[norm(paths[i])]) found.push(paths[i]);
    return T.ok(found.length + " of " + paths.length + " already in the project.", { found: found });
  }

  function childBin(parent, name) {
    for (var i = 0; i < parent.children.numItems; i++) {
      var ch = parent.children[i];
      if (ch.type == ProjectItemType.BIN && ch.name === name) return { bin: ch, created: false };
    }
    var made = parent.createBin(name);
    if (I.binsByName) (I.binsByName[name] = I.binsByName[name] || []).push(made);
    return { bin: made, created: true };
  }

  function resolveChain(chain, createdBins) {
    var key = chain.join("\u0001");
    if (I.binCache && I.binCache[key]) return I.binCache[key];
    var matches = (I.binsByName && I.binsByName[chain[0]]) || [], current, r;
    if (matches.length === 1) current = matches[0];
    else { r = childBin(app.project.rootItem, chain[0]); current = r.bin; if (r.created) createdBins.push(chain[0]); }
    for (var i = 1; i < chain.length; i++) {
      r = childBin(current, chain[i]);
      current = r.bin;
      if (r.created) createdBins.push(chain.slice(0, i + 1).join(" / "));
    }
    if (I.binCache) I.binCache[key] = current;
    return current;
  }

  function mediaPathsIn(bin) {
    var have = {};
    for (var i = 0; i < bin.children.numItems; i++) {
      try { var mp = bin.children[i].getMediaPath(); if (mp) have[norm(mp)] = true; } catch (e) {}
    }
    return have;
  }

  function doImport(params) {
    var chain = params.chain || [], paths = params.paths || [], numbered = !!params.numbered;
    if (!chain.length) return T.fail("No bin path given.");
    if (!paths.length) return T.ok("Nothing to import.", { imported: [], failed: [] });
    var createdBins = [], bin;
    try { bin = resolveChain(chain, createdBins); } catch (e) { return T.fail("Could not find or create the bin: " + e); }

    var before = mediaPathsIn(bin), ret = null;
    try { ret = app.project.importFiles(paths, true, bin, numbered); } catch (e2) { ret = "error: " + e2; }
    var have = mediaPathsIn(bin), missing = [], i;
    for (i = 0; i < paths.length; i++) if (!have[norm(paths[i])]) missing.push(paths[i]);

    var retried = [];
    for (i = 0; i < missing.length; i++) {
      try { app.project.importFiles([missing[i]], true, bin, numbered); } catch (e3) {}
      retried.push(missing[i]);
    }
    if (retried.length) have = mediaPathsIn(bin);

    var imported = [], failed = [], already = [];
    for (i = 0; i < paths.length; i++) {
      var p = norm(paths[i]);
      if (have[p] && I.pathIndex) I.pathIndex[p] = true;
      if (before[p]) already.push(paths[i]);
      else if (have[p]) imported.push(paths[i]);
      else failed.push(paths[i]);
    }
    var s = imported.length + " imported into \"" + chain.join(" / ") + "\"" + (failed.length ? ", " + failed.length + " failed" : "") + ".";
    var d = { bin: chain.join(" / "), imported: imported, failed: failed, alreadyInBin: already,
      createdBins: createdBins, importFilesReturned: String(ret), retriedOneByOne: retried.length };
    return failed.length ? { ok: false, error: s, summary: s, details: d } : T.ok(s, d);
  }

  T.skills["import-footage"] = function (params) {
    if (!app.project) return T.fail("No project open.");
    if (params.action === "index") return index();
    if (params.action === "exists") return exists(params);
    if (params.action === "import") return doImport(params);
    return T.fail("Unknown import action: " + params.action);
  };
}(PenyToolkit));
