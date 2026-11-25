// Multicam Sync Test, Premiere side. panel.js calls this with params.action:
//   "export" - the active sequence as FCP XML to params.path (seq.exportAsFinalCutProXML);
//              returns its id and name and a free name "<sequence> MULTICAM SYNC TEST" (" 2",
//              " 3"... when taken). Read only: the project is not changed.
//   "import" - params.path (the synced XML built by mcbuild.py) imported into the project
//              root (importFiles, as File > Import does); finds the new sequence by
//              params.name, opens it and counts its clips. Nothing is renamed, deleted or saved.
// ES3 only (no Array.filter / JSON in older ExtendScript: T.json is used by the core).
(function () {
  var T = PenyToolkit;
  var SUFFIX = " MULTICAM SYNC TEST";

  T.skills["multicam-sync"] = function (params) {
    var action = params.action;
    if (action === "export") return exportXml(params);
    if (action === "import") return importXml(params);
    return T.fail("Unknown action: " + action);
  };

  function freeName(base) {
    var name = base + SUFFIX, n = 2;
    while (T.sequenceNameExists(name)) { name = base + SUFFIX + " " + n; n++; }
    return name;
  }

  function exportXml(p) {
    var seq = T.activeSequence();
    if (!seq) return T.fail("No active sequence. Open the sequence that holds all the cameras and sound first.");
    var f = new File(p.path);
    if (f.exists) f.remove();
    var ret;
    try { ret = seq.exportAsFinalCutProXML(p.path, 1); } catch (e) { return T.fail("Premiere could not export the sequence as XML: " + e); }
    f = new File(p.path);
    if (!f.exists || f.length < 100) return T.fail("Premiere did not write the sequence XML (" + p.path + ", returned " + ret + ").");
    var v = 0, a = 0, i;
    for (i = 0; i < seq.videoTracks.numTracks; i++) v += seq.videoTracks[i].clips.numItems;
    for (i = 0; i < seq.audioTracks.numTracks; i++) a += seq.audioTracks[i].clips.numItems;
    return T.ok("Exported " + seq.name, { sequenceId: String(seq.sequenceID), sequenceName: String(seq.name), newName: freeName(String(seq.name)),
      path: p.path, bytes: f.length, videoClips: v, audioClips: a });
  }

  function importXml(p) {
    if (T.sequenceNameExists(p.name)) return T.fail("A sequence named \"" + p.name + "\" is already in the project, so nothing was imported.");
    var proj = T.proj();
    var before = {}, list = T.sequenceList(), i;
    for (i = 0; i < list.length; i++) before[String(list[i].sequenceID)] = 1;
    var root = proj.rootItem, rootBefore = {};
    for (i = 0; i < root.children.numItems; i++) rootBefore[String(root.children[i].nodeId)] = 1;
    var ret;
    try { ret = proj.importFiles([p.path], true, root, false); } catch (e) { return T.fail("Premiere could not import the synced XML: " + e); }
    var found = null, others = [];
    list = T.sequenceList();
    for (i = 0; i < list.length; i++) {
      if (before[String(list[i].sequenceID)]) continue;
      if (String(list[i].name) === p.name && !found) found = list[i]; else others.push(String(list[i].name));
    }
    var newRoot = [];
    for (i = 0; i < root.children.numItems; i++) if (!rootBefore[String(root.children[i].nodeId)]) newRoot.push(String(root.children[i].name));
    if (!found) return T.fail("The synced XML was imported but no new sequence named \"" + p.name + "\" appeared (importFiles returned " + ret + ").",
      { otherNewSequences: others, newProjectItems: newRoot });
    try { proj.openSequence(String(found.sequenceID)); } catch (e2) {}
    var v = 0, a = 0;
    for (i = 0; i < found.videoTracks.numTracks; i++) v += found.videoTracks[i].clips.numItems;
    for (i = 0; i < found.audioTracks.numTracks; i++) a += found.audioTracks[i].clips.numItems;
    var act = T.activeSequence();
    return T.ok("Imported " + p.name, { sequenceId: String(found.sequenceID), name: String(found.name), videoClips: v, audioClips: a,
      videoTracks: found.videoTracks.numTracks, audioTracks: found.audioTracks.numTracks, opened: !!(act && String(act.sequenceID) === String(found.sequenceID)),
      newProjectItems: newRoot, otherNewSequences: others });
  }
})();
