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
  T.isToolkitCopy = function (seq) {
    var n = String(seq.name);
    return n.length >= T.COPY_SUFFIX.length && n.substr(n.length - T.COPY_SUFFIX.length) === T.COPY_SUFFIX;
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
  // names it "<name> TOOLKIT COPY". Only the new sequence is renamed.
  T.duplicateSequence = function (seq) {
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

    var wanted = originalName + " " + T.COPY_SUFFIX;
    for (var n = 2; T.sequenceNameExists(wanted) && n < 100; n++) wanted = originalName + " (" + n + ") " + T.COPY_SUFFIX;
    var cloneName = String(created.name);
    created.name = wanted;
    if (String(created.name) !== wanted && created.projectItem) created.projectItem.name = wanted;
    if (String(created.name) !== wanted) {
      return T.fail("The copy was created as \"" + cloneName + "\" but could not be renamed to \"" + wanted + "\".",
        { copyId: String(created.sequenceID), copyName: String(created.name) });
    }

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
