// Peny Toolkit core (ExtendScript, ES3: var only, no JSON object assumed).
// Premiere's ExtendScript engine is shared with every other panel (including the
// MCP bridge), so everything lives under the single global PenyToolkit and no
// global such as JSON is touched.

// The panel loads this file with $.evalFile inside a function, which scopes a plain
// var to that call; pin the object to $.global so state (e.g. the proxy item cache)
// survives from one call to the next.
$.global.PenyToolkit = $.global.PenyToolkit || {};
var PenyToolkit = $.global.PenyToolkit;

(function (T) {
  T.TICKS_PER_SECOND = 254016000000;
  T.COPY_SUFFIX = "TOOLKIT COPY";
  T.LOG_PATH = "~/Library/Logs/PenyToolkit.log";
  T.skills = T.skills || {};

  // ---- JSON out (ES3 has no JSON) ----
  T.json = function (v) {
    if (v === null || v === undefined) return "null";
    var t = typeof v;
    if (t === "number") return isFinite(v) ? String(v) : "null";
    if (t === "boolean") return v ? "true" : "false";
    if (t === "string") {
      return '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r").replace(/\t/g, "\\t").replace(/[\x00-\x1f]/g, "") + '"';
    }
    if (v instanceof Array) {
      var a = [];
      for (var i = 0; i < v.length; i++) a.push(T.json(v[i]));
      return "[" + a.join(",") + "]";
    }
    var parts = [];
    for (var k in v) {
      if (v.hasOwnProperty(k) && typeof v[k] !== "function") parts.push(T.json(k) + ":" + T.json(v[k]));
    }
    return "{" + parts.join(",") + "}";
  };

  // ---- File log ----
  function pad(n, w) { var s = String(n); while (s.length < (w || 2)) s = "0" + s; return s; }
  T.stamp = function () {
    var d = new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " +
      pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) + "." + pad(d.getMilliseconds(), 3);
  };
  T.log = function (msg) {
    try {
      var f = new File(T.LOG_PATH);
      f.encoding = "UTF-8";
      f.lineFeed = "Unix";
      if (f.open("a")) { f.writeln(T.stamp() + " [jsx] " + msg); f.close(); }
    } catch (e) {}
  };

  // ---- Results ----
  T.ok = function (summary, details) { return { ok: true, summary: summary, details: details || {} }; };
  T.fail = function (error, details) { return { ok: false, error: error, details: details || {} }; };

  // ---- Time ----
  T.sec = function (ticks) { return parseFloat(ticks) / T.TICKS_PER_SECOND; };
  T.ticks = function (seconds) { return Math.round(parseFloat(seconds) * T.TICKS_PER_SECOND); };
  T.fmt = function (seconds) {
    var s = Math.max(0, seconds), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    var r = s - h * 3600 - m * 60;
    return h + ":" + pad(m) + ":" + (r < 10 ? "0" : "") + r.toFixed(2);
  };
  // Accepts plain seconds ("3832.8"), h:mm:ss / m:ss with optional decimal seconds
  // ("1:03:52.8"), or h:mm:ss:ff timecode using the sequence frame rate.
  // Returns NaN when the text cannot be read.
  T.parseTime = function (text, seq) {
    var s = String(text).replace(/^\s+|\s+$/g, "");
    if (s === "") return NaN;
    if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
    var m = /^(\d+):(\d{1,2}):(\d{1,2}):(\d{1,2})$/.exec(s);
    if (m) {
      var fps = T.sequenceFps(seq);
      if (!fps) return NaN;
      return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseInt(m[4], 10) / fps;
    }
    m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(s);
    if (m) return (m[1] ? parseInt(m[1], 10) * 3600 : 0) + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
    return NaN;
  };
  T.sequenceFps = function (seq) {
    try { var tb = parseFloat(seq.timebase); if (tb > 0) return T.TICKS_PER_SECOND / tb; } catch (e) {}
    return 0;
  };

  // ---- Project / sequence ----
  // The project a skill works on. Normally the active project; the Ingest + Proxies job queue sets
  // params.projectPath so Ingest and Proxies keep working on the project the job was started in
  // (Adobe: scripts can act on any project in app.projects). With a path set and that
  // project not open this is null, so nothing falls back to the project in front.
  T.targetPath = null;
  T.samePath = function (a, b) {
    try { return new File(String(a)).fsName === new File(String(b)).fsName; } catch (e) { return String(a) === String(b); }
  };
  T.findOpenProject = function (p) {
    var ps = app.projects;
    for (var i = 0; i < ps.numProjects; i++) { try { if (T.samePath(ps[i].path, p)) return ps[i]; } catch (e) {} }
    return null;
  };
  T.proj = function () {
    if (T.targetPath) return T.findOpenProject(T.targetPath);
    return app.project || null;
  };
  T.activeSequence = function () {
    if (!app || !app.project) return null;
    return app.project.activeSequence || null;
  };
  T.sequenceList = function () {
    var out = [], seqs = app.project.sequences;
    for (var i = 0; i < seqs.numSequences; i++) out.push(seqs[i]);
    return out;
  };
  T.findSequenceById = function (id) {
    var list = T.sequenceList();
    for (var i = 0; i < list.length; i++) if (String(list[i].sequenceID) === String(id)) return list[i];
    return null;
  };
  T.sequenceNameExists = function (name) {
    var list = T.sequenceList();
    for (var i = 0; i < list.length; i++) if (list[i].name === name) return true;
    return false;
  };
  // ---- Versions in the "Claude bin" (Lee, 11 Nov 2026) ----
  // Every button that makes a new sequence files it in "Claude bin/<Button>" under the next
  // version name (T.versionName). Older "... <Button> V<n>" and "... TOOLKIT COPY" sequences
  // still count as Toolkit copies.
  T.VERSION_BIN = "Claude bin";
  T.BUTTONS = ["Safe Copy", "Link External Audio", "Sound Pass", "Colour", "Sync Interviews", "Find Answers", "Trim", "Remove Ums"];
  function reEsc(x) { return String(x).replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&"); }
  function buttonsRe() {
    var a = [];
    for (var i = 0; i < T.BUTTONS.length; i++) a.push(reEsc(T.BUTTONS[i]));
    a.push("Master for \\S+");
    return "(?:" + a.join("|") + ")";
  }
  // Name of a Toolkit version made by `button` (any button when left out), or false.
  T.versionButton = function (name, button) {
    var m = new RegExp("^(.*) (" + (button ? reEsc(button) : buttonsRe()) + ") V(\\d+)$").exec(String(name));
    return m ? { base: m[1], button: m[2], n: parseInt(m[3], 10) } : false;
  };
  // The sequence a version came from: "C001 Sync Interviews V2 Colour V1" -> "C001"; older
  // suffixes (TOOLKIT COPY, Synced, Cut, No ums) are taken off too.
  T.versionBase = function (name) {
    var n = String(name), prev = null, m;
    var old = /\s+(?:\(\d+\)\s+)?(?:(?:MASTER \S+|GRADED)\s+)?TOOLKIT COPY$|\s+(?:Synced|No ums|Cut version|Cut(?: \d+)?(?: Trimmed(?: \d+)?)?)(?: \d+)?$/;
    while (n !== prev) {
      prev = n;
      m = T.versionButton(n);
      if (m) n = m.base;
      n = n.replace(old, "").replace(/(\S) V\d+$/, "$1");
    }
    return n.replace(/\s+$/, "") || String(name);
  };
  // Lee, 12 Nov 2026: the name keeps Lee's own version mark and only its number goes up
  // ("Tony EOY IV_V1" -> "Tony EOY IV_V2", "KAOS EOY IV V1" -> "KAOS EOY IV V2"); a name with
  // none gets " V1". The button is shown by its bin (Claude bin/<Button>), not in the name.
  // The last "V<digits>" that starts the name or follows a space, _, - or ( counts.
  T.versionMark = function (name) {
    var n = String(name), re = /(^|[\s_\-(])([Vv])(\d+)(?![0-9A-Za-z])/g, m, last = null;
    while ((m = re.exec(n)) !== null) { last = m; if (m[0] === "") re.lastIndex++; }
    if (!last) return null;
    var at = last.index + last[1].length;
    return { head: n.substr(0, at) + last[2], n: parseInt(last[3], 10), tail: n.substr(at + 1 + last[3].length) };
  };
  T.versionNumber = function (name) { var v = T.versionMark(name); return v ? v.n : 0; };
  // Next free name: the existing number + 1 (or V1), past any sequence already named that.
  T.versionName = function (srcName) {
    var v = T.versionMark(srcName), k = v ? v.n + 1 : 1, wanted;
    for (; k < 10000; k++) {
      wanted = v ? v.head + k + v.tail : String(srcName) + " V" + k;
      if (!T.sequenceNameExists(wanted)) break;
    }
    return wanted;
  };
  // Where seq sits in the Claude bin: { button: "<its sub-bin>" or "" (top) }, or null.
  T.versionBinOf = function (seq) {
    var item = seq && seq.projectItem;
    if (!item) return null;
    var tp = "";
    try { tp = String(item.treePath || ""); } catch (e) {}
    var parts = tp.split("\\");
    // "", "<project>.prproj", "Claude bin", ["<Button>",] "<name>"
    if (parts.length >= 4 && parts[2] === T.VERSION_BIN) return { button: parts.length >= 5 ? parts[3] : "" };
    return null;
  };
  T.isToolkitCopy = function (seq) {
    var n = String(seq.name);
    if (n.length >= T.COPY_SUFFIX.length && n.substr(n.length - T.COPY_SUFFIX.length) === T.COPY_SUFFIX) return true;
    return !!(T.versionButton(n) || T.versionBinOf(seq));
  };
  // The root bin "Claude bin", made when missing (create true).
  T.claudeBin = function (create) {
    var root = app.project.rootItem;
    for (var i = 0; i < root.children.numItems; i++) {
      var c = root.children[i];
      if (c && c.type === ProjectItemType.BIN && String(c.name) === T.VERSION_BIN) return c;
    }
    if (!create) return null;
    var b = null;
    try { b = root.createBin(T.VERSION_BIN); } catch (e) {}
    return b || T.claudeBin(false);
  };
  // The button's own bin inside the Claude bin ("Claude bin/Find Answers"), made when missing.
  T.buttonBin = function (button) {
    var top = T.claudeBin(true);
    if (!top || !button) return top;
    for (var i = 0; i < top.children.numItems; i++) {
      var c = top.children[i];
      if (c && c.type === ProjectItemType.BIN && String(c.name) === String(button)) return c;
    }
    var b = null;
    try { b = top.createBin(String(button)); } catch (e) {}
    if (b) return b;
    for (var j = 0; j < top.children.numItems; j++) {
      var d = top.children[j];
      if (d && d.type === ProjectItemType.BIN && String(d.name) === String(button)) return d;
    }
    return null;
  };
  // Moves seq's project item into its button's bin in the Claude bin (Lee, 11 Nov 2026: one
  // sub-bin per button). Returns null, or what went wrong.
  T.fileVersion = function (seq, button) {
    var item = seq && seq.projectItem;
    if (!item) return "the sequence has no project item";
    var where = T.VERSION_BIN + (button ? "/" + button : "");
    var bin = button ? T.buttonBin(button) : T.claudeBin(true);
    if (!bin) return "could not make the \"" + where + "\" bin";
    function inside() {
      for (var i = 0; i < bin.children.numItems; i++) if (String(bin.children[i].nodeId) === String(item.nodeId)) return true;
      return false;
    }
    if (inside()) return null;
    try { item.moveBin(bin); } catch (e) { return "moveBin failed: " + e; }
    for (var t = 0; t < 8 && !inside(); t++) $.sleep(250);
    return inside() ? null : "it did not move into \"" + where + "\"";
  };
  // Names a freshly made sequence as the next version of `button` and files it. Returns
  // null, or what went wrong.
  T.nameVersion = function (seq, srcName, button) {
    var wanted = T.versionName(srcName);
    seq.name = wanted;
    if (String(seq.name) !== wanted && seq.projectItem) seq.projectItem.name = wanted;
    if (String(seq.name) !== wanted) return "it was made as \"" + seq.name + "\" but could not be named \"" + wanted + "\"";
    return T.fileVersion(seq, button);
  };

  // Fingerprint of a sequence's timeline (track and clip counts, names, edges) so
  // a caller can show a sequence was not changed by an operation.
  T.fingerprint = function (seq) {
    var parts = [], clips = 0;
    function walk(tracks, tag) {
      for (var t = 0; t < tracks.numTracks; t++) {
        var tc = tracks[t].clips;
        for (var c = 0; c < tc.numItems; c++) {
          var it = tc[c];
          parts.push(tag + t + "|" + it.name + "|" + it.start.ticks + "|" + it.end.ticks);
          clips++;
        }
      }
    }
    walk(seq.videoTracks, "V");
    walk(seq.audioTracks, "A");
    var s = parts.join("\n"), h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 2147483647;
    return { videoTracks: seq.videoTracks.numTracks, audioTracks: seq.audioTracks.numTracks, clips: clips, hash: String(h) };
  };

  // Duplicates seq with Sequence.clone() (the call the MCP bridge's
  // duplicate_sequence uses), finds the new sequence by diffing sequence IDs, and
  // names it "<name> <button> V<n>" in the Claude bin. Only the new sequence is renamed.
  T.duplicateSequence = function (seq, button) {
    button = button || "Safe Copy";
    var originalName = String(seq.name);
    var originalId = String(seq.sequenceID);
    var before = {}, list = T.sequenceList(), i;
    for (i = 0; i < list.length; i++) before[String(list[i].sequenceID)] = true;
    var printBefore = T.fingerprint(seq);

    seq.clone();

    var created = null;
    for (var tries = 0; tries < 20 && !created; tries++) {
      list = T.sequenceList();
      for (i = 0; i < list.length; i++) {
        if (!before[String(list[i].sequenceID)]) { created = list[i]; break; }
      }
      if (!created) $.sleep(250);
    }
    if (!created) return T.fail("Sequence.clone() did not create a new sequence (checked for 5 s).");

    var cloneName = String(created.name);
    var bad = T.nameVersion(created, originalName, button), wanted = String(created.name);
    if (bad) return T.fail("The copy was created as \"" + cloneName + "\" but " + bad + ".",
        { copyId: String(created.sequenceID), copyName: String(created.name) });

    var original = T.findSequenceById(originalId);
    var printAfter = original ? T.fingerprint(original) : null;
    var printCopy = T.fingerprint(created);
    return T.ok("Created \"" + wanted + "\".", {
      originalName: original ? String(original.name) : null,
      originalId: originalId,
      originalUnchanged: !!(printAfter && printAfter.hash === printBefore.hash && printAfter.clips === printBefore.clips &&
        String(original.name) === originalName),
      originalBefore: printBefore,
      originalAfter: printAfter,
      copyName: String(created.name),
      copyId: String(created.sequenceID),
      copyMatchesOriginal: printCopy.hash === printBefore.hash
    });
  };

  // ---- Timeline helpers ----
  T.deselectAll = function (seq) {
    function off(tracks) {
      for (var t = 0; t < tracks.numTracks; t++) {
        var tc = tracks[t].clips;
        for (var c = 0; c < tc.numItems; c++) if (tc[c].isSelected()) tc[c].setSelected(false, true);
      }
    }
    off(seq.videoTracks);
    off(seq.audioTracks);
  };
  // Every clip overlapping (startSec, endSec) on every track, as plain records
  // that keep a reference to the TrackItem.
  T.clipsOverlapping = function (seq, startSec, endSec) {
    var a = T.ticks(startSec), b = T.ticks(endSec), out = [];
    function scan(tracks, kind) {
      for (var t = 0; t < tracks.numTracks; t++) {
        var tc = tracks[t].clips;
        for (var c = 0; c < tc.numItems; c++) {
          var it = tc[c], s = parseFloat(it.start.ticks), e = parseFloat(it.end.ticks);
          if (s < b && e > a) out.push({ item: it, kind: kind, track: t, name: String(it.name), nodeId: String(it.nodeId), startTicks: s, endTicks: e });
        }
      }
    }
    scan(seq.videoTracks, "video");
    scan(seq.audioTracks, "audio");
    return out;
  };
  // Real link state, read the way the MCP bridge's get_linked_items does it:
  // TrackItem.getLinkedItems() (not in Adobe's docs; verified on the Mac mini).
  T.linkedNodeIds = function (item) {
    var ids = [], linked = item.getLinkedItems();
    if (linked) for (var i = 0; i < linked.numItems; i++) ids.push(String(linked[i].nodeId));
    return ids;
  };
  T.trackLabel = function (kind, t) { return (kind === "video" ? "V" : "A") + (t + 1); };

  // ---- Media Encoder renders (6 Nov 2026: Premiere stays usable while they render) ----
  // Queues seq to Media Encoder and returns at once. When the job ends, Media Encoder calls
  // back into this engine and T.AME_DIR/<jobId>.json is written ({ok, path} or {ok:false,
  // error}); core/ame.js waits for it. workArea: 0 whole sequence, 1 in to out.
  T.AME_DIR = "/tmp/peny-toolkit/ame";
  function ameNote(jobID, ok, text) {
    try {
      Folder(T.AME_DIR).create();
      var f = new File(T.AME_DIR + "/" + jobID + ".json");
      f.encoding = "UTF-8";
      if (f.open("w")) { f.write(T.json({ ok: ok, path: ok ? String(text) : "", error: ok ? "" : String(text) })); f.close(); }
    } catch (e) {}
  }
  $.global.PenyAmeDone = function (jobID, outputFilePath) { ameNote(jobID, true, outputFilePath); };
  $.global.PenyAmeError = function (jobID, errorMessage) { ameNote(jobID, false, errorMessage || "Media Encoder reported an error"); };
  $.global.PenyAmeCancel = function (jobID) { ameNote(jobID, false, "cancelled in Media Encoder"); };
  T.queueRender = function (seq, outPath, preset, workArea) {
    var enc = app.encoder;
    if (!enc) return T.fail("Media Encoder is not available to scripting.");
    enc.bind("onEncoderJobComplete", $.global.PenyAmeDone);
    enc.bind("onEncoderJobError", $.global.PenyAmeError);
    enc.bind("onEncoderJobCanceled", $.global.PenyAmeCancel);
    try { enc.launchEncoder(); } catch (e0) {}
    var id = null, err = null;
    try { id = enc.encodeSequence(seq, outPath, preset, workArea, 1); } catch (e1) { err = String(e1); }
    if (err || !id || String(id) === "0") return T.fail("Media Encoder would not take the render: " + (err || String(id)));
    try { enc.startBatch(); } catch (e2) {}
    return T.ok("Queued in Media Encoder.", { jobId: String(id), path: outPath, ame: true });
  };

  // ---- Entry point used by the panel for every skill run ----
  T.run = function (skillId, params) {
    var started = new Date().getTime();
    try {
      var fn = T.skills[skillId];
      if (!fn) return T.json(T.fail("Unknown skill: " + skillId));
      T.targetPath = params && params.projectPath ? String(params.projectPath) : null;
      T.log("run " + skillId + " params=" + T.json(params || {}));
      var r = fn(params || {});
      r.skill = skillId;
      try { var rp = T.proj(); r.project = rp ? String(rp.name) : null; } catch (eP) {}
      r.ms = new Date().getTime() - started;
      T.log("done " + skillId + " ok=" + r.ok + " " + (r.ok ? r.summary : r.error) + " (" + r.ms + " ms)");
      return T.json(r);
    } catch (e) {
      var msg = String(e) + (e && e.line ? " (line " + e.line + ")" : "");
      T.log("error " + skillId + ": " + msg);
      return T.json({ ok: false, skill: skillId, error: msg, ms: new Date().getTime() - started });
    }
  };
}(PenyToolkit));
