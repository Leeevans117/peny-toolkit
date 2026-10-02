/* Interview selects pipeline (Node, no npm packages): whisper.cpp transcript -> Ollama
 * picks answers in overlapping windows -> merged list with times in sequence seconds. */
var fs = require("fs");
var path = require("path");
var http = require("http");
var childProcess = require("child_process");

var MODEL = "qwen2.5:32b";

function tc(sec) {
  var h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = (sec % 60).toFixed(1);
  return (h ? h + ":" : "") + (m < 10 && h ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
}

// whisper.cpp JSON -> [{a, b, text}] in seconds
function readTranscript(file) {
  return JSON.parse(fs.readFileSync(file, "utf-8")).transcription.map(function (s) {
    return { a: s.offsets.from / 1000, b: s.offsets.to / 1000, text: s.text.trim() };
  }).filter(function (s) { return s.text; });
}

var SCHEMA = { type: "object", required: ["answers"], properties: { answers: { type: "array", items: { type: "object",
  required: ["start_line", "end_line", "topic", "outline"], properties: { start_line: { type: "integer" }, end_line: { type: "integer" },
  topic: { type: "string" }, outline: { type: "string" } } } } } };

function prompt(lines, first, who) {
  var body = lines.map(function (l, i) { return (first + i) + " [" + tc(l.a) + "] " + l.text; }).join("\n");
  return "You are helping a video editor pick interview selects.\n" +
    "Below is part of a machine transcript of a sit-down interview" + (who ? " with " + who : "") + ". Each line has a line number, a start time and the text. " +
    "Speakers are NOT labelled: work out from the content which lines are the interviewer or crew (questions, prompts, setup, chat between takes, phone calls) and which are the interviewee answering.\n" +
    "List EVERY substantive answer the interviewee gives in this part, in time order. Be thorough: a typical hour of interview has 30-40 answers. " +
    "Leave out interviewer and crew speech, small talk, false starts and technical chat.\n" +
    "An answer that runs longer than about 2 minutes usually covers several points: split it where the subject changes, so each answer is about one thing.\n" +
    "For each answer give the first and last line number of the answer itself (not the question), a one-line topic and a 1-2 sentence outline of what is said.\n" +
    "Rules:\n- The topic is a short plain phrase with a capital first letter; names and places keep their capitals (e.g. London, Sam). It must never start with the word \"Topic\".\n" +
    "- " + (who ? "Start the outline with the interviewee's name (" + who + "); after that use they/their." : "In the outline call the interviewee \"they\" (or use their name if the transcript makes it clear).") + " Never assume gender.\n" +
    "- Answers must not overlap.\n" +
    "Return ONLY JSON: {\"answers\":[{\"start_line\":1,\"end_line\":2,\"topic\":\"...\",\"outline\":\"...\"}]}\n\nTranscript:\n" + body;
}

function ollamaGenerate(text, numCtx) {
  return new Promise(function (ok, no) {
    var data = JSON.stringify({ model: MODEL, prompt: text, stream: false, format: SCHEMA, keep_alive: "10m",
      options: { temperature: 0, num_ctx: numCtx } });
    var req = http.request({ host: "127.0.0.1", port: 11434, path: "/api/generate", method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, function (res) {
      var out = ""; res.on("data", function (d) { out += d; });
      res.on("end", function () { try { ok(JSON.parse(out)); } catch (e) { no(new Error("Ollama reply unreadable: " + out.slice(0, 200))); } });
    });
    req.on("error", no);
    req.setTimeout(30 * 60 * 1000, function () { req.destroy(new Error("Ollama timed out")); });
    req.end(data);
  });
}

/* Windows of ~winSec with ovSec overlap. An answer is kept by the window whose core
 * (window minus half the overlap at each inner edge) holds its start; an answer that
 * reaches the end of its window is extended by the next window's overlapping answer. */
function windows(lines, winSec, ovSec) {
  var end = lines[lines.length - 1].b, out = [], ws = 0;
  while (true) {
    var we = ws + winSec;
    if (we >= end - ovSec) we = end + 1;
    out.push({ ws: ws, we: we });
    if (we > end) break;
    ws = we - ovSec;
  }
  out.forEach(function (w, i) {
    w.coreA = i === 0 ? -1 : w.ws + ovSec / 2;
    w.coreB = i === out.length - 1 ? 1e9 : w.we - ovSec / 2;
    w.first = -1; w.last = -1;
    lines.forEach(function (l, j) { if (l.a >= w.ws && l.a < w.we) { if (w.first < 0) w.first = j; w.last = j; } });
  });
  return out.filter(function (w) { return w.first >= 0; });
}

function selects(lines, opts, progress) {
  opts = opts || {};
  var wins = windows(lines, opts.winSec || 540, opts.ovSec || 60);
  var per = [], stats = { windows: wins.length, promptTokens: 0, outputTokens: 0 };
  var chain = Promise.resolve();
  wins.forEach(function (w, wi) {
    chain = chain.then(function () {
      if (progress) progress(wi, wins.length, w);
      var slice = lines.slice(w.first, w.last + 1);
      return ollamaGenerate(prompt(slice, 1, opts.who), opts.numCtx || 16384).then(function (r) {
        stats.promptTokens += r.prompt_eval_count || 0; stats.outputTokens += r.eval_count || 0;
        var ans = [];
        try { ans = JSON.parse(r.response).answers || []; } catch (e) { ans = []; stats.badWindows = (stats.badWindows || 0) + 1; }
        per[wi] = ans.map(function (x) {
          var s = Math.max(1, Math.min(slice.length, x.start_line | 0)), e = Math.max(s, Math.min(slice.length, x.end_line | 0));
          return { a: slice[s - 1].a, b: slice[e - 1].b, i0: w.first + s - 1, i1: w.first + e - 1, atEnd: e >= slice.length - 1,
            topic: cleanTopic(x.topic), outline: String(x.outline || "").trim(), win: wi };
        });
      });
    });
  });
  return chain.then(function () {
    var kept = [];
    per.forEach(function (list, wi) {
      list.forEach(function (x) { if (x.a >= wins[wi].coreA && x.a < wins[wi].coreB) kept.push(x); });
    });
    kept.sort(function (p, q) { return p.a - q.a; });
    // Extend answers cut off by their window's end with the next window's version.
    kept.forEach(function (x) {
      if (!x.atEnd || !per[x.win + 1]) return;
      per[x.win + 1].forEach(function (y) { if (y.a <= x.b && y.b > x.b) { x.b = y.b; x.i1 = y.i1; } });
    });
    // Merge overlaps (keep the earlier answer's words, widen its range).
    var merged = [];
    kept.forEach(function (x) {
      var p = merged[merged.length - 1];
      if (p && x.a < p.b - 0.5) {
        var ov = Math.min(p.b, x.b) - x.a, shorter = Math.min(p.b - p.a, x.b - x.a);
        if (ov > shorter * 0.5) { p.b = Math.max(p.b, x.b); p.i1 = Math.max(p.i1, x.i1); return; }
        x.a = p.b; // small overlap: start this one where the last ended
      }
      merged.push(x);
    });
    return splitLong(lines, merged, opts, stats, progress);
  }).then(function (final) {
    stats.answers = final.length;
    return { answers: final.map(function (x) { return { start: x.a, end: x.b, topic: x.topic, outline: x.outline }; }), stats: stats };
  });
}

/* Answers longer than opts.maxSec (150 s) are sent back on their own lines to be split
 * where the subject changes; the split is used only if it gives 2+ answers. */
function splitLong(lines, list, opts, stats, progress) {
  var maxSec = opts.maxSec || 150, out = [], chain = Promise.resolve(), long = list.filter(function (x) { return x.b - x.a > maxSec; });
  stats.longSplit = 0;
  list.forEach(function (x) {
    chain = chain.then(function () {
      if (x.b - x.a <= maxSec) { out.push(x); return; }
      if (progress) progress(-1, long.length, { ws: x.a, we: x.b });
      var slice = lines.slice(x.i0, x.i1 + 1);
      return ollamaGenerate(prompt(slice, 1, opts.who), opts.numCtx || 16384).then(function (r) {
        stats.promptTokens += r.prompt_eval_count || 0; stats.outputTokens += r.eval_count || 0;
        var ans = [];
        try { ans = JSON.parse(r.response).answers || []; } catch (e) {}
        var parts = ans.map(function (y) {
          var s = Math.max(1, Math.min(slice.length, y.start_line | 0)), e = Math.max(s, Math.min(slice.length, y.end_line | 0));
          return { a: slice[s - 1].a, b: slice[e - 1].b, i0: x.i0 + s - 1, i1: x.i0 + e - 1, topic: cleanTopic(y.topic), outline: String(y.outline || "").trim() };
        }).sort(function (p, q) { return p.a - q.a; }).filter(function (y, k, arr) { return k === 0 || y.a >= arr[k - 1].b - 0.5; });
        if (parts.length >= 2) { stats.longSplit++; parts.forEach(function (y) { out.push(y); }); } else out.push(x);
      });
    });
  });
  return chain.then(function () {
    // A split can overlap its neighbour; keep the first and drop near-duplicates.
    var res = [];
    out.sort(function (p, q) { return p.a - q.a; }).forEach(function (x) {
      var p = res[res.length - 1];
      if (p && x.a < p.b - 0.5) {
        var ov = Math.min(p.b, x.b) - x.a, shorter = Math.min(p.b - p.a, x.b - x.a);
        if (ov > shorter * 0.5) { p.b = Math.max(p.b, x.b); return; }
        x.a = p.b;
      }
      res.push(x);
    });
    return res;
  });
}

function cleanTopic(t) {
  t = String(t || "").replace(/^\s*topic\s*[:\-–—]?\s*/i, "").trim();
  if (!t) t = "Answer";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

module.exports = { readTranscript: readTranscript, selects: selects, windows: windows, tc: tc, MODEL: MODEL };
