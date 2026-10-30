/* Interview Selects, panel side (Node). One button, all on this Mac, no internet:
 * 1. premiere.jsx "scan": the active sequence's audio pieces (nested sequences followed).
 * 2. Premiere renders the sequence's own sound (the mic on the timeline), ffmpeg makes it one
 *    16 kHz mono wav; with the Audio track box filled, ffmpeg reads that track's files instead.
 * 3. whisper.cpp (large-v3-turbo) transcribes it in ~25 s pieces cut at quiet moments
 *    (whole-file voice detection dropped quiet interviewee speech, 29 Oct 2026).
 * 4. Who speaks: each line's level on that sound (the interviewer is quiet on the speaker's
 *    lav); only with no clear gap does Ollama (qwen2.5:14b, else 32b) label the lines. The answers
 *    are the runs of the interviewee's lines, cut edges moved to measured silence with handles,
 *    and one short Ollama call names each (pipeline.js selectsByLabels, safeEdges).
 * 5. The answers are grouped under the interviewer's questions (the interviewer's lines with a
 *    "?", no model pass), and Ollama groups the questions into broad themes (pipeline.js group,
 *    themes).
 * 6. premiere.jsx "copy": "<sequence> Cut version" (unless already on one), then "mark":
 *    question (Chapter) and theme (Segmentation) markers, topics as clip markers, read back.
 * Remove ums & uhs (unum): steps 1-2 on the active sequence, then fillers.js finds the
 * fillers (whisper on short clips, each checked twice, snapped to the sound) and
 * premiere.jsx "unum" cuts them on a copy "<sequence> No ums"; fillers.csv lists them all.
 * Sync Interviews (the tile's first section) is skills/interview-sync, run by its button.
 * Work files: /tmp/peny-toolkit/interview-selects/<sequence>-<time>/. Nothing is deleted. */
var fs = require("fs");
var path = require("path");
// Tools put in place by the one-click installer (no Homebrew needed). Used first when
// present: they are the versions the toolkit was tested with, and their python3 has numpy
// (a Homebrew python3 without numpy would break Sync, Sound Pass and Colour).
function BUNDLED(name) { return path.join(process.env.HOME || "", "Library", "Application Support", "PenyToolkit", "bin", name); }
var http = require("http");
var childProcess = require("child_process");
var pipeline = require("./pipeline.js");
var fillers = require("./fillers.js");

var FFMPEG = [BUNDLED("ffmpeg"), "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"];
var WHISPER = [BUNDLED("whisper-cli"), "/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"];
var OLLAMA = [BUNDLED("ollama"), "/opt/homebrew/bin/ollama", "/usr/local/bin/ollama"];
var MODEL_DIRS = [path.join(process.env.HOME || "", "PenyToolkit-scratch", "whisper-models")];
var WHISPER_MODEL = "ggml-large-v3-turbo.bin", VAD_MODEL = "ggml-silero-v5.1.2.bin";
var WORK_ROOT = "/tmp/peny-toolkit/interview-selects";
var BATCH = 60; // ffmpeg inputs per mix pass

function firstExisting(list) { for (var i = 0; i < list.length; i++) if (fs.existsSync(list[i])) return list[i]; return null; }
function inModelDir(name) { return firstExisting(MODEL_DIRS.map(function (d) { return path.join(d, name); })); }
function fmt(s) {
  var h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = (s % 60).toFixed(1);
  return h + ":" + (m < 10 ? "0" : "") + m + ":" + (x < 10 ? "0" : "") + x;
}

module.exports = function (api) {
  var children = [], cancelled = false;

  function run(cmd, args, onLine) {
    return new Promise(function (ok, no) {
      if (cancelled) return no({ stop: "Cancelled." });
      var child = childProcess.spawn(cmd, args), err = "";
      children.push(child);
      function lines(d) { err += d; if (err.length > 20000) err = err.slice(-20000); if (onLine) String(d).split(/[\r\n]+/).forEach(function (l) { if (l.trim()) onLine(l.trim()); }); }
      child.stdout.on("data", lines);
      child.stderr.on("data", lines);
      child.on("error", no);
      child.on("close", function (code) {
        children = children.filter(function (c) { return c !== child; });
        if (cancelled) return no({ stop: "Cancelled." });
        if (code !== 0) return no(new Error(path.basename(cmd) + " exited " + code + ": " + err.slice(-400)));
        ok();
      });
    });
  }

  // Joins pieces that continue the same file without a gap, so a cut-up interview
  // becomes a few long inputs.
  function joinPieces(segs) {
    var list = segs.slice().sort(function (a, b) { return a.start - b.start; }), out = [];
    list.forEach(function (s) {
      var p = out[out.length - 1];
      if (p && p.path === s.path && Math.abs(p.end - s.start) < 0.01 && Math.abs(p.inPoint + (p.end - p.start) - s.inPoint) < 0.01) p.end = s.end;
      else out.push({ path: s.path, inPoint: s.inPoint, start: s.start, end: s.end });
    });
    return out;
  }

  // The interview's sound. Normally the sequence's own sound, rendered by Premiere: exactly
  // the mic Lee put on the timeline (30 Oct 2026; scripting can't see which channel of a file
  // a clip plays). 5 s per 16 min, in one script. With the "Audio track" box filled (rendering
  // one track would mean muting the others on his sequence), that track's files are read
  // with ffmpeg, all their channels mixed; RED clips from their proxy.
  function sequenceAudio(ffmpeg, scan, params, dir) {
    if ((params.track || "").trim()) return fromFiles(ffmpeg, scan, dir);
    var raw = path.join(dir, "sequence-render.wav"), final = path.join(dir, "interview.wav");
    api.status("Reading the sound of \"" + scan.sequence + "\"…");
    return api.evalSkill({ action: "renderaudio", sequenceId: scan.sequenceId, sequenceName: scan.sequence, path: raw, preset: path.join(api.skillDir, "wav-float.epr") }).then(function (r) {
      if (!r.ok) throw { stop: r.error };
      if (!fs.existsSync(raw) || !fs.statSync(raw).size) throw { stop: "Premiere didn't write the sequence's sound (" + raw + ")." };
      return run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", raw, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", final]);
    }).then(function () {
      try { fs.unlinkSync(raw); } catch (e) {}
      return final;
    });
  }
  function fromFiles(ffmpeg, scan, dir) {
    var usable = scan.segments.filter(function (s) { return !/\.r3d$/i.test(s.path); });
    if (usable.length < scan.segments.length) api.log("Interview Selects: " + (scan.segments.length - usable.length) + " RED clip(s) without a proxy left out (their sound can only be read by Premiere: empty the Audio track box, or make their proxies).");
    if (!usable.length) throw { stop: "No readable audio on that track: RED clips need a proxy when the Audio track box is filled." };
    var gone = usable.filter(function (s) { return !fs.existsSync(s.path); });
    if (gone.length) throw { stop: gone.length + " audio file(s) are offline, e.g. " + gone[0].path };
    return buildAudio(ffmpeg, joinPieces(usable), scan.duration, dir);
  }

  var streamCounts = {};
  function audioStreams(ffmpeg, file) {
    if (streamCounts[file]) return streamCounts[file];
    var n = 1;
    try {
      var out = childProcess.execFileSync(path.join(path.dirname(ffmpeg), "ffprobe"), ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file], { timeout: 60000 });
      n = Math.max(1, Math.min(8, String(out).split("\n").filter(function (l) { return l.trim(); }).length));
    } catch (e) {}
    streamCounts[file] = n;
    return n;
  }

  // One wav in sequence time: each piece trimmed, delayed to its start and mixed.
  function buildAudio(ffmpeg, pieces, duration, dir) {
    var batches = [], files = [];
    for (var i = 0; i < pieces.length; i += BATCH) batches.push(pieces.slice(i, i + BATCH));
    var chain = Promise.resolve();
    batches.forEach(function (b, bi) {
      chain = chain.then(function () {
        api.status("Building the interview audio (" + (bi + 1) + "/" + batches.length + ")…");
        var args = ["-hide_banner", "-loglevel", "error", "-y"], parts = [];
        b.forEach(function (p, k) {
          args.push("-ss", p.inPoint.toFixed(4), "-t", (p.end - p.start).toFixed(4), "-i", p.path);
          // Every audio stream of the file, mixed: the first alone is often the camera's own
          // mic, 15-20 dB under the others (Tod, Arly: whole sentences went untranscribed).
          var ns = audioStreams(ffmpeg, p.path), ins = "";
          for (var st = 0; st < ns; st++) { parts.push("[" + k + ":a:" + st + "]aformat=channel_layouts=mono[s" + k + "_" + st + "]"); ins += "[s" + k + "_" + st + "]"; }
          parts.push(ins + (ns > 1 ? "amix=inputs=" + ns + ":normalize=0," : "") + "aresample=16000,adelay=" + Math.round(p.start * 1000) + ":all=1[a" + k + "]");
        });
        var labels = b.map(function (p, k) { return "[a" + k + "]"; }).join("");
        var graph = parts.join(";") + ";" + labels + "amix=inputs=" + b.length + ":normalize=0:duration=longest,apad=whole_dur=" + duration.toFixed(3) + "[out]";
        var script = path.join(dir, "mix" + bi + ".txt"), out = path.join(dir, "mix" + bi + ".wav");
        fs.writeFileSync(script, graph);
        args.push("-filter_complex_script", script, "-map", "[out]", "-t", duration.toFixed(3), "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", out);
        files.push(out);
        return run(ffmpeg, args);
      });
    });
    return chain.then(function () {
      var final = path.join(dir, "interview.wav");
      if (files.length === 1) { fs.renameSync(files[0], final); return final; }
      var args = ["-hide_banner", "-loglevel", "error", "-y"];
      files.forEach(function (f) { args.push("-i", f); });
      args.push("-filter_complex", "amix=inputs=" + files.length + ":normalize=0:duration=longest", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", final);
      return run(ffmpeg, args).then(function () { return final; });
    });
  }

  // Whisper over the whole file with VAD lost quiet interviewee speech (Arly Kemp, 29 Oct
  // 2026: her name and home town and every line VAD took for silence), and without VAD its
  // times drift by seconds. So the wav is cut into chunks of about 25 s at its quietest
  // moments and each chunk is transcribed on its own, all in one whisper run (model loaded
  // once); a line's time is its chunk's start (counted in samples) + whisper's time in it.
  function quietCuts(wav, duration) {
    var buf = fs.readFileSync(wav), at = 12, data = -1, size = 0;
    while (at + 8 <= buf.length) {
      var id = buf.toString("ascii", at, at + 4), len = buf.readUInt32LE(at + 4);
      if (id === "data") { data = at + 8; size = Math.min(len, buf.length - data); break; }
      at += 8 + len + (len & 1);
    }
    if (data < 0) return [];
    var rate = 16000, frame = 800, n = Math.floor(size / 2 / frame), e = new Float64Array(n);
    for (var f = 0; f < n; f++) {
      var sum = 0;
      for (var k = 0; k < frame; k++) { var v = buf.readInt16LE(data + 2 * (f * frame + k)); sum += v * v; }
      e[f] = sum;
    }
    var cuts = [], prev = 0, step = frame / rate;
    while (prev + 28 < duration) {
      var lo = Math.ceil((prev + 18) / step), hi = Math.min(n - 1, Math.floor((prev + 28) / step)), best = lo;
      for (f = lo; f <= hi; f++) if (e[f] < e[best]) best = f;
      prev = (best + 0.5) * step;
      cuts.push(prev);
    }
    return cuts;
  }
  function wavSamples(file) {
    var buf = fs.readFileSync(file), at = 12;
    while (at + 8 <= buf.length) {
      var id = buf.toString("ascii", at, at + 4), len = buf.readUInt32LE(at + 4);
      if (id === "data") return Math.floor(Math.min(len, buf.length - at - 8) / 2);
      at += 8 + len + (len & 1);
    }
    return 0;
  }
  function transcribe(whisper, ffmpeg, wav, dir, duration) {
    var started = Date.now(), cdir = path.join(dir, "chunks");
    fs.mkdirSync(cdir, { recursive: true });
    var cuts = quietCuts(wav, duration);
    api.status("Cutting " + fmt(duration) + " of audio into " + (cuts.length + 1) + " pieces…");
    var args = ["-hide_banner", "-loglevel", "error", "-y", "-i", wav, "-f", "segment", "-c:a", "pcm_s16le"];
    if (cuts.length) args.push("-segment_times", cuts.map(function (c) { return c.toFixed(3); }).join(","));
    args.push(path.join(cdir, "c%04d.wav"));
    var files;
    return run(ffmpeg, args).then(function () {
      files = fs.readdirSync(cdir).filter(function (f) { return /^c\d+\.wav$/.test(f); }).sort().map(function (f) { return path.join(cdir, f); });
      var wargs = ["-m", inModelDir(WHISPER_MODEL), "-mc", "0", "-sns", "-l", "en", "-oj", "-t", "8"], done = 0;
      files.forEach(function (f) { wargs.push("-f", f); });
      return run(whisper, wargs, function (line) {
        if (/saving output to/.test(line)) {
          done++;
          api.status("Transcribing " + fmt(duration) + " of audio: " + done + " of " + files.length + " pieces (" + Math.round((Date.now() - started) / 1000) + " s)");
        }
      });
    }).then(function () {
      // Chunk starts from the samples actually in each chunk (the segment muxer cuts on
      // packet boundaries, not at the exact times asked for).
      var t0 = 0, lines = [];
      files.forEach(function (f) {
        var j = null;
        try { j = JSON.parse(fs.readFileSync(f + ".json", "utf-8")); } catch (e) {}
        (j && j.transcription || []).forEach(function (s) {
          var text = String(s.text || "").trim();
          if (!text || /^[\[(].*[\])]$/.test(text)) return;
          lines.push({ offsets: { from: Math.round(t0 * 1000 + s.offsets.from), to: Math.round(t0 * 1000 + s.offsets.to) }, text: " " + text });
        });
        t0 += wavSamples(f) / 16000;
      });
      fs.writeFileSync(path.join(dir, "transcript.json"), JSON.stringify({ transcription: lines }, null, 1));
      function srt(ms) {
        function p(n, w) { n = String(n); while (n.length < w) n = "0" + n; return n; }
        return p(Math.floor(ms / 3600000), 2) + ":" + p(Math.floor(ms / 60000) % 60, 2) + ":" + p(Math.floor(ms / 1000) % 60, 2) + "," + p(ms % 1000, 3);
      }
      fs.writeFileSync(path.join(dir, "transcript.srt"), lines.map(function (l, i) {
        return (i + 1) + "\n" + srt(l.offsets.from) + " --> " + srt(l.offsets.to) + "\n" + l.text.trim() + "\n";
      }).join("\n"));
      return path.join(dir, "transcript.json");
    });
  }

  function ollamaUp() {
    return new Promise(function (ok) {
      var req = http.get({ host: "127.0.0.1", port: 11434, path: "/api/version", timeout: 1500 }, function (res) { res.resume(); ok(res.statusCode === 200); });
      req.on("error", function () { ok(false); });
      req.on("timeout", function () { req.destroy(); ok(false); });
    });
  }

  // Starts `ollama serve` unless one is already running; returns the child we started (or null).
  function startOllama(ollama) {
    return ollamaUp().then(function (up) {
      if (up) { api.log("Ollama was already running; it is left running afterwards."); return null; }
      var env = Object.assign({}, process.env, { OLLAMA_FLASH_ATTENTION: "1", OLLAMA_KV_CACHE_TYPE: "q8_0", OLLAMA_NUM_PARALLEL: String(pipeline.PARALLEL) });
      var child = childProcess.spawn(ollama, ["serve"], { env: env, stdio: "ignore" });
      var t0 = Date.now();
      return new Promise(function (ok, no) {
        (function wait() {
          ollamaUp().then(function (u) {
            if (u) return ok(child);
            if (Date.now() - t0 > 30000) { try { child.kill(); } catch (e) {} return no(new Error("Ollama did not start within 30 s.")); }
            setTimeout(wait, 500);
          });
        }());
      });
    });
  }

  function writeCsv(file, answers) {
    function q(s) { return '"' + String(s).replace(/"/g, '""') + '"'; }
    fs.writeFileSync(file, "start,end,topic,outline\n" + answers.map(function (a) { return [fmt(a.start), fmt(a.end), q(a.topic), q(a.outline)].join(","); }).join("\n") + "\n");
  }

  function find(params) {
    cancelled = false;
    var ffmpeg = firstExisting(FFMPEG), whisper = firstExisting(WHISPER), ollama = firstExisting(OLLAMA);
    var missing = [];
    if (!ffmpeg) missing.push("ffmpeg");
    if (!whisper) missing.push("whisper-cli (brew install whisper-cpp)");
    if (!ollama) missing.push("ollama (brew install ollama)");
    if (!inModelDir(WHISPER_MODEL)) missing.push(WHISPER_MODEL + " in " + MODEL_DIRS.join(" or "));
    if (!inModelDir(VAD_MODEL)) missing.push(VAD_MODEL + " in " + MODEL_DIRS.join(" or "));
    if (missing.length) return Promise.resolve({ ok: false, error: "Missing on this Mac: " + missing.join("; ") + "." });

    var t0 = Date.now(), scan, dir, answers, questions = [], themes = [], stats, server = null, times = {};
    function lap(k) { times[k] = Math.round((Date.now() - t0) / 1000); }
    if (params.reuse) return markOnly(params.reuse, params);
    api.status("Reading the sequence's audio…");
    return api.evalSkill({ action: "scan", track: params.track || "", sequenceId: params.sequenceId }).then(function (r) {
      if (!r.ok) throw { stop: r.error };
      scan = r.details;
      var safe = scan.sequence.replace(/[^A-Za-z0-9 _-]+/g, "").replace(/\s+/g, "_").slice(0, 60);
      dir = path.join(WORK_ROOT, safe + "-" + new Date().toISOString().replace(/[:.]/g, "-"));
      fs.mkdirSync(dir, { recursive: true });
      var pieces = joinPieces(scan.segments);
      fs.writeFileSync(path.join(dir, "scan.json"), JSON.stringify(scan, null, 1));
      api.log("Interview Selects: \"" + scan.sequence + "\" " + fmt(scan.duration) + ", " + scan.segments.length + " audio piece(s) on " + scan.tracks.join(", ") +
        " (" + pieces.length + " after joining)." + (scan.notes.length ? " Notes: " + scan.notes.join(" ") : ""));
      return sequenceAudio(ffmpeg, scan, params, dir);
    }).then(function (wav) {
      lap("audio");
      return transcribe(whisper, ffmpeg, wav, dir, scan.duration);
    }).then(function (json) {
      lap("transcribe");
      var lines = pipeline.readTranscript(json);
      if (lines.length < 5) throw { stop: "Whisper heard almost no speech (" + lines.length + " lines). Check the audio track." };
      api.status("Starting the local AI model…");
      return startOllama(ollama).then(function (child) {
        server = child;
        return pipeline.pickModel();
      }).then(function (model) {
        api.log("Interview Selects: model " + model);
        var w0 = Date.now();
        return pipeline.selectsByLabels(lines, { who: (params.name || "").trim(), wav: path.join(dir, "interview.wav") }, function (i, n, w) {
          if (cancelled) throw { stop: "Cancelled." };
          var el = Math.round((Date.now() - w0) / 1000);
          api.status(i >= 0 ? "Finding who speaks: part " + (i + 1) + " of " + n + " (" + fmt(w.ws) + " onwards, " + el + " s so far)…"
                            : "Naming the answers (" + el + " s so far)…");
        });
      });
    }).then(function (r) {
      if (!r.answers.length) throw { stop: "The model found no answers. Transcript: " + path.join(dir, "transcript.srt") };
      return r;
    }).then(function (r) {
      answers = r.answers; stats = r.stats;
      api.status("Grouping the " + answers.length + " answers by question…");
      var g0 = Date.now();
      return pipeline.group(pipeline.readTranscript(path.join(dir, "transcript.json")), answers, { who: (params.name || "").trim(), crew: stats.crew }, function (i, n) {
        if (cancelled) throw { stop: "Cancelled." };
        api.status("Finding the interviewer's questions: part " + (i + 1) + " of " + n + " (" + Math.round((Date.now() - g0) / 1000) + " s so far)…");
      }).then(function (g) {
        questions = g.questions; stats.groupTokens = g.tokens;
        api.status("Grouping the " + questions.length + " questions into broad themes…");
        return pipeline.themes(questions, { who: (params.name || "").trim() }).then(function (t) { themes = t.themes; stats.themeTokens = t.tokens; return g; });
      }).then(function (g) {
        r.questions = questions; r.themes = themes;
        fs.writeFileSync(path.join(dir, "answers.json"), JSON.stringify(r, null, 1));
        writeCsv(path.join(dir, "answers.csv"), answers);
        writeCsv(path.join(dir, "questions.csv"), questions.map(function (q) { return { start: q.start, end: q.end, topic: q.title, outline: q.comment }; }));
        writeCsv(path.join(dir, "themes.csv"), themes.map(function (t) { return { start: t.start, end: t.end, topic: t.title, outline: t.comment }; }));
        lap("answers");
      });
    }).then(function () {
      // By now Lee may be on another sequence: everything goes to the one the run started on.
      api.status("Making the Cut version of \"" + scan.sequence + "\"…");
      return api.evalSkill({ action: "copy", sequenceId: scan.sequenceId, sequenceName: scan.sequence });
    }).then(function (c) {
      if (!c.ok) throw { stop: c.error };
      api.status("Adding " + questions.length + " question, " + themes.length + " theme and " + answers.length + " topic markers to \"" + c.details.copyName + "\"…");
      return api.evalSkill({ action: "mark", sequenceId: c.details.copyId, sequenceName: c.details.copyName, answers: answers, questions: questions, themes: themes }).then(function (m) { return { copy: c, mark: m }; });
    }).then(function (o) {
      lap("total");
      var d = o.mark.details || {};
      var summary = (o.mark.ok ? "" : "Not all markers went on. ") + o.mark.summary.replace(/\.$/, "") + "" +
        (o.copy.details.made ? " (a new Cut version; the original is untouched)" : "") + ". Took " + fmt(times.total) +
        " (audio " + times.audio + " s, transcript " + (times.transcribe - times.audio) + " s, answers " + (times.answers - times.transcribe) + " s). List: " + path.join(dir, "answers.csv");
      api.status(summary);
      return { ok: !!o.mark.ok, summary: summary, error: summary, details: {
        sequence: d.sequence, markers: d.checked, questions: questions.length, themes: themes.length, topics: d.topics, wrong: d.wrong, failed: d.failed, workFolder: dir, stats: stats, times: times } };
    }).catch(function (e) {
      var msg = e && e.stop ? e.stop : "Interview Selects stopped: " + (e && e.message ? e.message : String(e));
      api.status(msg);
      return { ok: false, error: msg, details: { workFolder: dir || null } };
    }).then(function (result) {
      if (server) { try { server.kill(); } catch (eK) {} api.log("Stopped the Ollama server started for this run."); }
      return result;
    });
  }

  // Puts the answers of an earlier run (its answers.json) on the active sequence's safe
  // copy without transcribing again (test hook: params.reuse = path to answers.json).
  function markOnly(file, params) {
    var saved, answers, questions, themes, server = null;
    try { saved = JSON.parse(fs.readFileSync(file, "utf-8")); answers = saved.answers; questions = saved.questions; themes = saved.themes; } catch (e) { return Promise.resolve({ ok: false, error: "Could not read " + file }); }
    var grouped = Promise.resolve(), who = (params.name || "").trim();
    if (params.brief) {
      // Test hook: rewrite the saved outlines as brief notes first.
      grouped = startOllama(firstExisting(OLLAMA)).then(function (child) {
        server = child;
        api.status("Making the topic notes brief…");
        return pipeline.brief(answers, { who: who });
      }).then(function (b) {
        answers = b.answers; saved.answers = answers;
        fs.writeFileSync(file, JSON.stringify(saved, null, 1));
        if (server) { try { server.kill(); } catch (eK) {} server = null; }
      });
    }
    if (!questions || !themes || params.regroup) {
      var ollama = firstExisting(OLLAMA);
      grouped = grouped.then(function () { api.status("Grouping the answers by question…"); return startOllama(ollama); }).then(function (child) {
        server = child;
        if (questions && !params.regroup) return { questions: questions };
        return pipeline.group(pipeline.readTranscript(path.join(path.dirname(file), "transcript.json")), answers, { who: who }, function (i, n) {
          api.status("Finding the interviewer's questions: part " + (i + 1) + " of " + n + "…");
        });
      }).then(function (g) {
        questions = g.questions; saved.questions = questions;
        api.status("Grouping the questions into broad themes…");
        return pipeline.themes(questions, { who: who });
      }).then(function (t) {
        themes = t.themes; saved.themes = themes;
        fs.writeFileSync(file, JSON.stringify(saved, null, 1));
      });
    }
    return grouped.then(function () {
      if (server) { try { server.kill(); } catch (eK) {} server = null; }
      api.status("Making the Cut version of the sequence…");
      return api.evalSkill({ action: "copy" });
    }).then(function (c) {
      if (!c.ok) return c;
      api.status("Adding question, theme and topic markers…");
      return api.evalSkill({ action: "mark", sequenceId: c.details.copyId, sequenceName: c.details.copyName, answers: answers, questions: questions, themes: themes }).then(function (m) {
        var d = m.details || {};
        var summary = (m.summary || m.error) + " (from " + file + ")";
        d.themeList = themes.map(function (t) { return fmt(t.start) + "-" + fmt(t.end) + " " + t.title + " (questions " + t.questions.join("-") + ")"; });
        api.status(summary);
        d.questionList = questions.map(function (q) { return fmt(q.start) + "-" + fmt(q.end) + " " + q.title + (q.question ? " (Q: " + q.question + ")" : ""); });
        return { ok: !!m.ok, summary: summary, error: m.error || summary, details: d };
      });
    }).catch(function (e) {
      if (server) { try { server.kill(); } catch (eK) {} }
      return { ok: false, error: "Stopped: " + (e && e.message ? e.message : String(e)) };
    });
  }

  // Remove ums & uhs: the active sequence's sound -> fillers.js -> premiere.jsx "unum" on a
  // "<sequence> No ums" copy. params.fillers = the words to remove (empty = the default list).
  function unum(params) {
    cancelled = false;
    var ffmpeg = firstExisting(FFMPEG), whisper = firstExisting(WHISPER), missing = [];
    if (!ffmpeg) missing.push("ffmpeg");
    if (!whisper) missing.push("whisper-cli (brew install whisper-cpp)");
    if (!inModelDir(WHISPER_MODEL)) missing.push(WHISPER_MODEL + " in " + MODEL_DIRS.join(" or "));
    if (missing.length) return Promise.resolve({ ok: false, error: "Missing on this Mac: " + missing.join("; ") + "." });
    var words = fillers.words(params.fillers), t0 = Date.now(), scan, dir, found;
    function q(v) { return '"' + String(v).replace(/"/g, '""') + '"'; }
    api.status("Reading the sequence's audio…");
    return api.evalSkill({ action: "scan", track: params.track || "" }).then(function (r) {
      if (!r.ok) throw { stop: r.error };
      scan = r.details;
      if (scan.sequence.indexOf("No ums") >= 0) throw { stop: "\"" + scan.sequence + "\" is already a \"No ums\" copy. Open the sequence it came from and run again." };
      var safe = scan.sequence.replace(/[^A-Za-z0-9 _-]+/g, "").replace(/\s+/g, "_").slice(0, 60);
      dir = path.join(WORK_ROOT, safe + "-ums-" + new Date().toISOString().replace(/[:.]/g, "-"));
      fs.mkdirSync(dir, { recursive: true });
      api.log("Remove ums & uhs: \"" + scan.sequence + "\" " + fmt(scan.duration) + ", " + scan.segments.length + " audio piece(s) on " + scan.tracks.join(", ") + "; removing " + words.join(", ") + ".");
      return sequenceAudio(ffmpeg, scan, params, dir);
    }).then(function (wav) {
      return fillers.find(wav, scan.duration, dir, { ffmpeg: ffmpeg, whisper: whisper, model: inModelDir(WHISPER_MODEL) }, run, api.status, { words: words });
    }).then(function (r) {
      found = r;
      fs.writeFileSync(path.join(dir, "fillers.json"), JSON.stringify(r, null, 1));
      if (r.crashed.length) api.log("whisper stopped on " + r.crashed.length + " clip(s) (left out): " + r.crashed.slice(0, 5).join(", "));
      if (!r.fillers.length) throw { stop: "No fillers found that can be cut safely (" + r.candidates + " possible, " + r.skipped.length + " skipped as unclear). Nothing was changed. List: " + path.join(dir, "fillers.json") };
      api.status("Cutting " + r.fillers.length + " fillers on a copy of the sequence…");
      return api.evalSkill({ action: "unum", sequenceId: scan.sequenceId, fillers: r.fillers.map(function (f) { return { word: f.word, start: f.start, end: f.end }; }) });
    }).then(function (u) {
      var d = u.details || {}, rows = ["status,word,original_time,new_time,seconds,note"];
      (d.removed || []).forEach(function (x) { rows.push(["removed", x.word, x.originalTime, x.newTime, x.seconds, ""].map(q).join(",")); });
      (d.skipped || []).forEach(function (x) { rows.push(["skipped", x.word, x.at, "", "", x.why].map(q).join(",")); });
      found.skipped.forEach(function (x) { rows.push(["left in", x.word, fmt(x.t), "", "", x.why + ": " + x.context].map(q).join(",")); });
      var csv = path.join(dir, "fillers.csv");
      fs.writeFileSync(csv, rows.join("\n") + "\n");
      var took = Math.round((Date.now() - t0) / 1000);
      var summary = (u.ok ? "" : "Not all went well. ") + (u.summary || u.error).replace(/\.$/, "") + ". " + found.skipped.length + " more possible fillers left in (too close to a word or not clear). Took " + fmt(took) + ". List: " + csv;
      api.status(summary);
      return { ok: !!u.ok, summary: summary, error: summary, details: { sequence: d.sequence, removed: d.removedCount, removedSeconds: d.removedSeconds, skippedInPremiere: (d.skipped || []).length,
        leftIn: found.skipped.length, candidates: found.candidates, clips: found.clips, crashed: found.crashed.length, durationBefore: d.durationBefore, durationAfter: d.durationAfter,
        originalUnchanged: d.originalUnchanged, problems: d.problems, holes: d.holes, relinked: d.relinked, markersMoved: d.markersMoved, cutMarkers: d.cutMarkers, workFolder: dir, csv: csv, took: took } };
    }).catch(function (e) {
      var msg = e && e.stop ? e.stop : "Remove ums & uhs stopped: " + (e && e.message ? e.message : String(e));
      api.status(msg);
      return { ok: false, error: msg, details: { workFolder: dir || null } };
    });
  }

  function cancel() {
    cancelled = true;
    children.forEach(function (c) { try { c.kill(); } catch (e) {} });
    // Sync Interviews runs in its own module (skills/interview-sync); stop it too.
    if (api.skillAction) api.skillAction("interview-sync", "cancel", {});
    return Promise.resolve({ ok: true, summary: "Cancel requested; the run stops after the current step." });
  }

  // Cut & raise: all in Premiere (premiere.jsx "cutraise"). params.jsxAction lets the test
  // hook call another premiere.jsx action (e.g. "probe") without reopening the panel.
  function cutraise(params) {
    var p = {};
    for (var k in params) if (params.hasOwnProperty(k)) p[k] = params[k];
    p.action = params.jsxAction || "cutraise";
    api.status(p.action === "cutraise" ? "Cutting, raising and trimming the answers…" : "Running " + p.action + "…");
    return api.evalSkill(p).then(function (r) { api.status(r.ok ? r.summary : r.error); return r; });
  }

  return { actions: { find: find, cutraise: cutraise, unum: unum, cancel: cancel }, busy: function () { return children.length ? children.length + " child process(es)" : null; } };
};
