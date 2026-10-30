/* Interview selects pipeline (Node, no npm packages): whisper.cpp transcript -> Ollama
 * picks answers in overlapping windows -> merged list with times in sequence seconds. */
var fs = require("fs");
var path = require("path");
var http = require("http");
var childProcess = require("child_process");

// qwen2.5:14b labels who speaks better than 32b and ~3x faster on the M4 Pro (Arly Kemp,
// 29 Oct 2026); 32b is used when 14b isn't installed on this Mac (pickModel).
var MODEL = "qwen2.5:14b", FALLBACK = "qwen2.5:32b";
function pickModel() {
  return new Promise(function (ok) {
    var req = http.get({ host: "127.0.0.1", port: 11434, path: "/api/tags", timeout: 5000 }, function (res) {
      var out = ""; res.on("data", function (d) { out += d; });
      res.on("end", function () {
        var names = [];
        try { names = (JSON.parse(out).models || []).map(function (m) { return m.name; }); } catch (e) {}
        if (names.indexOf("qwen2.5:14b") < 0 && names.indexOf(FALLBACK) >= 0) MODEL = FALLBACK;
        ok(MODEL);
      });
    });
    req.on("error", function () { ok(MODEL); });
    req.on("timeout", function () { req.destroy(); ok(MODEL); });
  });
}
// Windows sent to Ollama at once (it is started with OLLAMA_NUM_PARALLEL to match): one
// request at a time left the M4 Pro writing ~9 tokens/s, the slow part of Find answers.
var PARALLEL = 2;
function pool(items, n, fn) {
  var next = 0;
  function worker() {
    if (next >= items.length) return Promise.resolve();
    var k = next++;
    return Promise.resolve(fn(items[k], k)).then(worker);
  }
  var ws = [];
  for (var i = 0; i < Math.min(n, items.length); i++) ws.push(worker());
  return Promise.all(ws);
}

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

var SCHEMA = { type: "object", required: ["answers", "interviewer_lines"], properties: { answers: { type: "array", items: { type: "object",
  required: ["from", "to", "topic"], properties: { from: { type: "string" }, to: { type: "string" }, topic: { type: "string" } } } },
  interviewer_lines: { type: "array", items: { type: "object", required: ["tag", "words"], properties: { tag: { type: "string" }, words: { type: "string" } } } } } };

/* Each transcript line is shown with a tag (L001, L002, ...) and the model answers with tags,
 * not line numbers or quotes: it wrote line numbers one out (Arly Kemp, 29 Oct 2026), and
 * quoting words to check them made it write so much that a 16 min interview took 13 min
 * (output, ~10 tokens/s on the M4 Pro, is the slow part). A tag that isn't in the part
 * sent is ignored. */
function tag(n) { return "L" + (n < 10 ? "00" : n < 100 ? "0" : "") + n; }
// An interviewer line comes as its tag plus its first 2 words; the words decide when the tag is
// a line or two out (the model reads each line it names when it has to quote it: without the
// words it named half as many). 0 when no line within 2 starts with the words.
function words(t) { return String(t || "").toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean); }
function checkTag(slice, t, quote, stats) {
  var n = untag(t, slice.length), q = words(quote).slice(0, 2);
  if (!n) { stats.badTags = (stats.badTags || 0) + 1; return 0; }
  if (!q.length) return n;
  function fits(m) { var w = words(slice[m - 1].text); return w[0] === q[0] && (q.length < 2 || w[1] === q[1]); }
  var order = [0, -1, 1, -2, 2];
  for (var k = 0; k < order.length; k++) {
    var m = n + order[k];
    if (m >= 1 && m <= slice.length && fits(m)) { if (order[k]) stats.snapped = (stats.snapped || 0) + 1; return m; }
  }
  stats.badTags = (stats.badTags || 0) + 1;
  return 0;
}
function untag(t, max) {
  var m = /(\d+)/.exec(String(t || ""));
  var n = m ? parseInt(m[1], 10) : 0;
  return n >= 1 && n <= max ? n : 0;
}

function prompt(lines, first, who) {
  var body = lines.map(function (l, i) { return tag(first + i) + " [" + tc(l.a) + "] " + l.text; }).join("\n");
  return "You are helping a video editor pick interview selects.\n" +
    "Below is part of a machine transcript of a sit-down interview" + (who ? " with " + who : "") + ". Each line has a tag (L001, L002, ...), a start time and the text. " +
    "Speakers are NOT labelled: work out from the content which lines are the interviewer or crew (questions, prompts, setup, chat between takes, phone calls) and which are the interviewee answering.\n" +
    "List EVERY stretch of the interviewee's own speech in this part that is worth keeping, in time order: their answers to questions, and anything else " +
    "worth keeping whether or not it answers a question, such as introducing themself (name, role, where they are from), standalone statements, stories, " +
    "opinions and useful descriptions. Be thorough and when in doubt keep it: a typical hour of interview has 30-40 of these.\n" +
    "Leave out: everything the interviewer or crew says (questions, prompts, set-up, reactions such as \"that's cool\", chat between takes, phone calls); " +
    "mic checks and \"are we rolling\"; a false start that is repeated straight after (keep the repeat); off-topic chatter about the shoot itself.\n" +
    "An answer that runs longer than about 2 minutes usually covers several points: split it where the subject changes, so each answer is about one thing.\n" +
    "For each one give the tag of its first and last line (the interviewee's speech itself, not the question) and a one-line topic.\n" +
    "Rules:\n- The topic is a short plain phrase with a capital first letter; names and places keep their capitals (e.g. London, Sam). It must never start with the word \"Topic\".\n" +
    "- Answers must not overlap.\n" +
    "Also list in interviewer_lines EVERY line spoken by the interviewer or crew in this part: go through the lines in order and include each question " +
    "(there is one before almost every answer), each prompt and set-up, and each short reaction (\"Really?\", \"Nice.\", \"That's cool.\"). " +
    "For each give its tag and its first 2 words exactly as written (so the line can be checked); a typical part has dozens of interviewer lines.\n" +
    "Return ONLY JSON: {\"answers\":[{\"from\":\"L004\",\"to\":\"L009\",\"topic\":\"...\"}],\"interviewer_lines\":[{\"tag\":\"L003\",\"words\":\"Did you\"}]}\n\nTranscript:\n" + body;
}

function ollamaGenerate(text, numCtx) { return ollamaGenerateWith(text, SCHEMA, numCtx); }

function ollamaGenerateWith(text, schema, numCtx) {
  return new Promise(function (ok, no) {
    var data = JSON.stringify({ model: MODEL, prompt: text, stream: false, format: schema, keep_alive: "10m",
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
  var per = [], stats = { windows: wins.length, promptTokens: 0, outputTokens: 0 }, crew = {};
  var chain = pool(wins, PARALLEL, function (w, wi) {
    {
      if (progress) progress(wi, wins.length, w);
      var slice = lines.slice(w.first, w.last + 1);
      return ollamaGenerate(prompt(slice, 1, opts.who), opts.numCtx || 16384).then(function (r) {
        stats.promptTokens += r.prompt_eval_count || 0; stats.outputTokens += r.eval_count || 0;
        var ans = [], j = null;
        try { j = JSON.parse(r.response); ans = j.answers || []; } catch (e) { ans = []; stats.badWindows = (stats.badWindows || 0) + 1; }
        ((j && j.interviewer_lines) || []).forEach(function (c) {
          var n = checkTag(slice, c && c.tag, c && c.words, stats);
          if (n) crew[w.first + n - 1] = true;
        });
        per[wi] = ans.map(function (x) {
          var s = untag(x.from, slice.length), e = untag(x.to, slice.length);
          if (!s || !e) { stats.badTags = (stats.badTags || 0) + 1; return null; }
          if (e < s) { var t = s; s = e; e = t; }
          return { a: slice[s - 1].a, b: slice[e - 1].b, i0: w.first + s - 1, i1: w.first + e - 1, atEnd: e >= slice.length - 1,
            topic: cleanTopic(x.topic), outline: "", win: wi };
        }).filter(Boolean);
      });
    }
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
    return splitLong(lines, merged, opts, stats, progress, crew);
  }).then(function (final) {
    stats.raw = final.map(function (x) { return [x.a, x.b]; });
    stats.crew = Object.keys(crew).map(Number).sort(function (p, q) { return p - q; });
    final = dropCrew(lines, final, crew, stats);
    stats.answers = final.length;
    return { answers: final.map(function (x) { return { start: x.a, end: x.b, topic: x.topic, outline: x.outline }; }), stats: stats };
  });
}

/* Answers longer than opts.maxSec (150 s) are sent back on their own lines to be split
 * where the subject changes; the split is used only if it gives 2+ answers. */
/* The model's answer edges are unreliable (Arly Kemp, 29 Oct 2026: an answer ending on the
 * next question, her reply left out), and the interviewee's words must never be cut (Lee,
 * 29 Oct 2026). So each answer is reshaped on the transcript lines:
 *  - an interviewer line that runs on (no sentence end, next line starts lower case) makes
 *    the next line the interviewer's too;
 *  - a question at either end of an answer goes (a line of 1.5 s or more ending in "?", or
 *    a line the model named as the interviewer's with a "?" in it);
 *  - the answer then grows over neighbouring lines that are not the interviewer's and not a
 *    question, through silences of up to 3 s, up to the next answer; a short interviewer
 *    reaction (under 1.5 s, no "?") between two of her lines is taken in;
 *  - inside, only a line the model named as the interviewer's that is a question goes.
 * Stretches less than 1.5 s apart are joined; a stretch under 2 s is joined to the nearer
 * stretch of the same answer, and one under 1 s left on its own is dropped. */
function dropCrew(lines, list, crew0, stats) {
  var crew = {}, i;
  Object.keys(crew0).forEach(function (k) { crew[k] = true; });
  function runsOn(i) {
    var tx = lines[i].text.replace(/\s+$/, ""), nx = lines[i + 1];
    return !!nx && (!/[.?!]$/.test(tx) || /\.\.\.$/.test(tx)) && /^[a-z]/.test(nx.text.replace(/^\s+/, "")) && nx.a - lines[i].b < 1;
  }
  for (i = 0; i < lines.length; i++) if (crew[i] && runsOn(i)) crew[i + 1] = true;
  function isQ(i) { return lines[i].b - lines[i].a >= 1.5 && /\?\s*$/.test(lines[i].text); }
  function edge(i) { return isQ(i) || (crew[i] && lines[i].text.indexOf("?") >= 0); }
  var owner = lines.map(function () { return false; }), spans = [];
  stats.crewLines = Object.keys(crew0).length; stats.questionsCut = 0; stats.grown = 0;
  stats.joined = 0; stats.shortJoined = 0; stats.shortKept = 0; stats.shortDropped = 0;
  list.forEach(function (x) {
    var idx = [];
    lines.forEach(function (l, k) { if (l.a >= x.a - 0.05 && l.b <= x.b + 0.05) idx.push(k); });
    while (idx.length && edge(idx[0])) { idx.shift(); stats.questionsCut++; }
    while (idx.length && edge(idx[idx.length - 1])) { idx.pop(); stats.questionsCut++; }
    if (idx.length) spans.push({ f: idx[0], l: idx[idx.length - 1], topic: x.topic, outline: x.outline });
  });
  spans.forEach(function (s) { for (var k = s.f; k <= s.l; k++) owner[k] = true; });
  function free(k) { return k >= 0 && k < lines.length && !owner[k] && !crew[k] && !isQ(k); }
  function reaction(k) { return k >= 0 && k < lines.length && !owner[k] && crew[k] && !/\?/.test(lines[k].text) && lines[k].b - lines[k].a < 1.5; }
  spans.forEach(function (s) {
    for (;;) {
      var j = s.l + 1;
      if (j >= lines.length || lines[j].a - lines[s.l].b > 3) break;
      if (free(j)) { s.l = j; owner[j] = true; stats.grown++; continue; }
      if (reaction(j) && free(j + 1) && lines[j + 1].a - lines[j].b <= 3) { s.l = j + 1; owner[j] = owner[j + 1] = true; stats.grown += 2; continue; }
      break;
    }
    for (;;) {
      var b = s.f - 1;
      if (b < 0 || lines[s.f].a - lines[b].b > 3) break;
      if (free(b)) { s.f = b; owner[b] = true; stats.grown++; continue; }
      if (reaction(b) && free(b - 1) && lines[b].a - lines[b - 1].b <= 3) { s.f = b - 1; owner[b] = owner[b - 1] = true; stats.grown += 2; continue; }
      break;
    }
  });
  var out = [];
  spans.sort(function (p, q) { return p.f - q.f; }).forEach(function (s) {
    var runs = [], run = null;
    for (var k = s.f; k <= s.l; k++) {
      if (crew[k] && isQ(k)) { if (run) { runs.push(run); run = null; } stats.questionsCut++; continue; }
      if (run) run.b = lines[k].b; else run = { a: lines[k].a, b: lines[k].b };
    }
    if (run) runs.push(run);
    var j = [];
    runs.forEach(function (r) { var p = j[j.length - 1]; if (p && r.a - p.b < 1.5) { p.b = r.b; stats.joined++; } else j.push({ a: r.a, b: r.b }); });
    for (var m = 0; m < j.length; m++) {
      if (j.length < 2 || j[m].b - j[m].a >= 2) continue;
      var gp = m > 0 ? j[m].a - j[m - 1].b : 1e9, gn = m + 1 < j.length ? j[m + 1].a - j[m].b : 1e9;
      if (gp <= gn) j[m - 1].b = j[m].b; else j[m + 1].a = j[m].a;
      j.splice(m, 1); stats.shortJoined++; m = -1;
    }
    j.forEach(function (r) {
      var d = r.b - r.a;
      if (d < 1) { stats.shortDropped++; return; }
      if (d < 2) stats.shortKept++;
      out.push({ a: r.a, b: r.b, topic: s.topic, outline: s.outline });
    });
  });
  return out;
}

function splitLong(lines, list, opts, stats, progress, crew) {
  var maxSec = opts.maxSec || 150, out = [], chain = Promise.resolve(), long = list.filter(function (x) { return x.b - x.a > maxSec; });
  stats.longSplit = 0;
  list.forEach(function (x) {
    chain = chain.then(function () {
      if (x.b - x.a <= maxSec) { out.push(x); return; }
      if (progress) progress(-1, long.length, { ws: x.a, we: x.b });
      var slice = lines.slice(x.i0, x.i1 + 1);
      return ollamaGenerate(prompt(slice, 1, opts.who), opts.numCtx || 16384).then(function (r) {
        stats.promptTokens += r.prompt_eval_count || 0; stats.outputTokens += r.eval_count || 0;
        var ans = [], j = null;
        try { j = JSON.parse(r.response); ans = j.answers || []; } catch (e) {}
        ((j && j.interviewer_lines) || []).forEach(function (c) { var n = checkTag(slice, c && c.tag, c && c.words, stats); if (crew && n) crew[x.i0 + n - 1] = true; });
        var parts = ans.map(function (y) {
          var s = untag(y.from, slice.length), e = untag(y.to, slice.length);
          if (!s || !e) return null;
          if (e < s) { var t = s; s = e; e = t; }
          return { a: slice[s - 1].a, b: slice[e - 1].b, i0: x.i0 + s - 1, i1: x.i0 + e - 1, topic: cleanTopic(y.topic), outline: "" };
        }).filter(Boolean).sort(function (p, q) { return p.a - q.a; }).filter(function (y, k, arr) { return k === 0 || y.a >= arr[k - 1].b - 0.5; });
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

/* Groups the answers by interviewer question. A second pass over the transcript (same
 * overlapping windows) lists the interviewer's questions: the line each starts on, the question
 * in a few words and a broad title for the answer it gets. Each answer belongs to the last
 * question before it; a question spans its first answer's start to its last answer's end
 * (the question itself stays out). Questions without an answer are dropped. */
var Q_SCHEMA = { type: "object", required: ["questions"], properties: { questions: { type: "array", items: { type: "object",
  required: ["line", "question", "title"], properties: { line: { type: "integer" }, question: { type: "string" }, title: { type: "string" } } } } } };

function qPrompt(lines, who) {
  var body = lines.map(function (l, i) { return (i + 1) + " [" + tc(l.a) + "] " + l.text; }).join("\n");
  return "Below is part of a machine transcript of a sit-down interview" + (who ? " with " + who : "") + ". Speakers are NOT labelled.\n" +
    "List EVERY question the interviewer asks, including follow-up questions that move the answer on to a new point (a typical hour has 30-40). " +
    "Leave out only one- or two-word prompts (\"and then?\", \"why?\"), crew chat and set-up. " +
    "For each give the line number where the question starts, the question in a few words, and a broad title for the answer it gets " +
    "(a short phrase, capital first letter, names keep their capitals, never starting with the word \"Topic\").\n" +
    "Return ONLY JSON: {\"questions\":[{\"line\":12,\"question\":\"...\",\"title\":\"...\"}]}\n\nTranscript:\n" + body;
}

function group(lines, answers, opts, progress) {
  opts = opts || {};
  if (opts.crew) return Promise.resolve(groupFrom(questionsFromCrew(lines, opts.crew), answers, opts, { prompt: 0, output: 0 }));
  var wins = windows(lines, opts.winSec || 540, opts.ovSec || 60), found = [], tokens = { prompt: 0, output: 0 };
  var chain = pool(wins, PARALLEL, function (w, wi) {
    {
      if (progress) progress(wi, wins.length, w);
      var slice = lines.slice(w.first, w.last + 1);
      return ollamaGenerateWith(qPrompt(slice, opts.who), Q_SCHEMA, opts.numCtx || 16384).then(function (r) {
        tokens.prompt += r.prompt_eval_count || 0; tokens.output += r.eval_count || 0;
        var qs = [];
        try { qs = JSON.parse(r.response).questions || []; } catch (e) {}
        qs.forEach(function (q) {
          var n = Math.max(1, Math.min(slice.length, q.line | 0)), t = slice[n - 1].a;
          if (t >= w.coreA && t < w.coreB) found.push({ at: t, question: String(q.question || "").trim(), title: cleanTopic(q.title) });
        });
      });
    }
  });
  return chain.then(function () { return groupFrom(found, answers, opts, tokens); });
}

/* Questions from the interviewer lines the answers pass already named (no second model pass:
 * it took ~3 min of a 13 min run, 29 Oct 2026): every run of interviewer lines with a "?" in it
 * is a question, starting at its first line; titles come from the first answer's topic. */
function questionsFromCrew(lines, crew) {
  var set = {}, out = [], i = 0;
  crew.forEach(function (k) { set[k] = true; });
  while (i < lines.length) {
    if (!set[i]) { i++; continue; }
    var e = i;
    while (e + 1 < lines.length && set[e + 1]) e++;
    var text = lines.slice(i, e + 1).map(function (l) { return l.text; }).join(" ");
    if (text.indexOf("?") >= 0) out.push({ at: lines[i].a, question: text.length > 100 ? text.slice(0, 97) + "..." : text, title: "" });
    i = e + 1;
  }
  return out;
}

function groupFrom(found, answers, opts, tokens) {
    found.sort(function (p, q) { return p.at - q.at; });
    var groups = [];
    answers.forEach(function (x, i) {
      var q = null;
      found.forEach(function (f) { if (f.at <= x.start + 0.5) q = f; });
      var g = groups[groups.length - 1];
      if (g && g.q === q) g.l = i; else groups.push({ q: q, f: i, l: i });
    });
    // Long sections are split at answer boundaries (Lee wanted finer sections: his own edit of
    // Tahnee Home IV has 36, most 1-3 min, none over 5): over opts.maxSection (240 s) with
    // 2+ answers -> pieces of about 200 s; each new piece is named after its first answer.
    var maxSec = opts.maxSection || 240, fine = [];
    groups.forEach(function (g) {
      var dur = answers[g.l].end - answers[g.f].start, n = g.l - g.f + 1;
      if (dur <= maxSec || n < 2) { fine.push(g); return; }
      var k = Math.min(n, Math.ceil(dur / 200)), size = dur / k, cur = { q: g.q, f: g.f, l: g.f }, part = 1;
      for (var i = g.f + 1; i <= g.l; i++) {
        if (answers[i].start - answers[g.f].start >= part * size - 30 && part < k) {
          fine.push(cur); cur = { q: null, f: i, l: i, split: true }; part++;
        } else cur.l = i;
      }
      fine.push(cur);
    });
    groups = fine;
    return {
      questions: groups.map(function (g) {
        var list = answers.slice(g.f, g.l + 1), title = (g.q && g.q.title) || list[0].topic;
        return { start: list[0].start, end: list[list.length - 1].end, title: title, question: g.q ? g.q.question : "",
          comment: (g.q && g.q.question ? "Q: " + g.q.question + "\n" : "") + "Answers: " + list.map(function (x) { return x.topic; }).join("; "),
          answers: [g.f + 1, g.l + 1] };
      }),
      asked: found.length,
      tokens: tokens
    };
}

/* Broad themes (Lee, 20 Oct 2026): consecutive questions grouped under a theme that spans
 * several of them, e.g. "Family and the team" over the first four questions. One short
 * Ollama call over the question titles. Groups are made consecutive and complete whatever
 * the model returns; a theme spans its first question's start to its last question's end. */
var THEME_SCHEMA = { type: "object", required: ["themes"], properties: { themes: { type: "array", items: { type: "object",
  required: ["first", "last", "title"], properties: { first: { type: "integer" }, last: { type: "integer" }, title: { type: "string" } } } } } };

function themes(questions, opts) {
  opts = opts || {};
  if (!questions.length) return Promise.resolve({ themes: [], tokens: { prompt: 0, output: 0 } });
  var list = questions.map(function (q, i) { return (i + 1) + ". [" + tc(q.start) + "] " + q.title + (q.question ? " (asked: " + q.question + ")" : ""); }).join("\n");
  var want = Math.max(2, Math.min(10, Math.round(questions.length / 4)));
  var text = "You are helping a video editor organise an interview" + (opts.who ? " with " + opts.who : "") + ". Below are the interview's questions in time order.\n" +
    "Group consecutive questions into broad themes, each spanning several questions (about " + want + " themes in all; a theme is usually 2 to 6 questions). " +
    "Every question belongs to exactly one theme, in order.\n" +
    "For each theme give its first and last question number and a broad title (a short phrase, capital first letter, names keep their capitals, never starting with the word \"Topic\").\n" +
    "Return ONLY JSON: {\"themes\":[{\"first\":1,\"last\":4,\"title\":\"...\"}]}\n\nQuestions:\n" + list;
  return ollamaGenerateWith(text, THEME_SCHEMA, opts.numCtx || 8192).then(function (r) {
    var ts = [];
    try { ts = JSON.parse(r.response).themes || []; } catch (e) {}
    var out = [], next = 1, n = questions.length;
    ts.sort(function (p, q) { return (p.first | 0) - (q.first | 0); }).forEach(function (t) {
      var f = Math.max(next, t.first | 0), l = Math.min(n, Math.max(f, t.last | 0));
      if (f > n || l < f) return;
      if (f > next) out.push({ f: next, l: f - 1, title: questions[next - 1].title });
      out.push({ f: f, l: l, title: cleanTopic(t.title) });
      next = l + 1;
    });
    if (next <= n) out.push({ f: next, l: n, title: out.length ? out[out.length - 1].title : questions[next - 1].title, extend: true });
    // A trailing remainder joins the theme before it rather than standing alone.
    var merged = [];
    out.forEach(function (g) {
      var p = merged[merged.length - 1];
      if (g.extend && p) p.l = g.l; else merged.push(g);
    });
    return {
      themes: merged.map(function (g) {
        return { start: questions[g.f - 1].start, end: questions[g.l - 1].end, title: g.title, questions: [g.f, g.l],
          comment: "Questions: " + questions.slice(g.f - 1, g.l).map(function (q) { return q.title; }).join("; ") };
      }),
      tokens: { prompt: r.prompt_eval_count || 0, output: r.eval_count || 0 }
    };
  });
}

/* Brief notes (Lee, 20 Oct 2026: "more brief, we don't need to see that Tony is saying
 * it"). One short Ollama call rewrites every outline as a log note of at most ~12 words
 * with no speaker; cleanOutline then strips any "Tony says that" style opening left over. */
var BRIEF_SCHEMA = { type: "object", required: ["notes"], properties: { notes: { type: "array", items: { type: "object",
  required: ["n", "note"], properties: { n: { type: "integer" }, note: { type: "string" } } } } } };

function cleanOutline(t, who) {
  var names = ["the interviewee", "interviewee", "the speaker", "he", "she", "they"];
  if (who) names.unshift(who);
  var verbs = "says|said|explains|explained|mentions|mentioned|talks about|talked about|discusses|discussed|describes|described|expresses|expressed|notes|noted|recalls|recalled|reflects on|reflected on|highlights|emphasizes|emphasises|shares|admits|believes|feels|thinks|hopes|say|explain|mention|talk about|discuss|describe|express|note|recall|reflect on|highlight|share|admit|believe|feel|think|hope";
  t = String(t || "").trim();
  for (var i = 0; i < names.length; i++) {
    var re = new RegExp("^" + names[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?:'s)?\\s+(?:" + verbs + ")(?:\\s+that|\\s+how)?\\s*[:,]?\\s*", "i");
    if (re.test(t)) { t = t.replace(re, ""); break; }
  }
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

function brief(answers, opts) {
  opts = opts || {};
  if (!answers.length) return Promise.resolve({ answers: answers, tokens: { prompt: 0, output: 0 } });
  // Notes come from what was said (opts.lines) when the answer has no outline yet: Find
  // answers no longer asks the model for one (its output is the slow part).
  var list = answers.map(function (a, i) {
    var said = a.outline;
    if (!said && opts.lines) said = opts.lines.filter(function (l) { return l.a >= a.start - 0.05 && l.b <= a.end + 0.05; })
      .map(function (l) { return l.text; }).join(" ").split(/\s+/).slice(0, 60).join(" ");
    return (i + 1) + ". " + a.topic + ": " + (said || "");
  }).join("\n");
  var text = "Write a brief log note for a video editor for each numbered answer below (its topic, then what was said): the point made, at most about 12 words, no full sentence needed. " +
    "Do not name or refer to the speaker at all (no \"" + (opts.who || "Tony") + " says\", \"they mention\", \"the interviewee\"). Keep names of other people and places.\n" +
    "Return ONLY JSON: {\"notes\":[{\"n\":1,\"note\":\"...\"}]}\n\nNotes:\n" + list;
  return ollamaGenerateWith(text, BRIEF_SCHEMA, opts.numCtx || 8192).then(function (r) {
    var notes = [];
    try { notes = JSON.parse(r.response).notes || []; } catch (e) {}
    var byN = {};
    notes.forEach(function (x) { if (x && x.n) byN[x.n | 0] = String(x.note || "").trim(); });
    return {
      answers: answers.map(function (a, i) {
        var o = {};
        for (var k in a) if (a.hasOwnProperty(k)) o[k] = a[k];
        o.outline = cleanOutline(byN[i + 1] || a.outline, opts.who);
        return o;
      }),
      tokens: { prompt: r.prompt_eval_count || 0, output: r.eval_count || 0 }
    };
  });
}

function cleanTopic(t) {
  t = String(t || "").replace(/^\s*topic\s*[:\-–—]?\s*/i, "").trim();
  if (!/\s/.test(t) && /[a-z][A-Z]/.test(t)) t = t.replace(/([a-z])([A-Z])/g, "$1 $2"); // "FamilyDynamicInTeam"
  if (!t) t = "Answer";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/* Labels first (29 Oct 2026). Every transcript line is labelled E (the interviewee) or I (the
 * interviewer or crew) by the model, 120 lines per call, two calls at once; the answers are
 * then the runs of her lines, and one short call names each run (topic of a few words) and
 * writes its log note. Measured on Arly Kemp against her mic channel: qwen2.5:14b labelled
 * 107/112 of her lines and 80/95 of the interviewer's right in 74 s (32b: 83/115, 59/97, 226 s),
 * and the whole model stage went from ~7 min (32b, model-picked answers) to ~2 min.
 * Why runs and not model-picked answers: Lee wants nothing of hers cut (29 Oct 2026), and the
 * model's own answer edges were often a line out. */
var LABEL_SCHEMA = { type: "object", required: ["labels"], properties: { labels: { type: "array", items: { type: "string" } } } };
var LABEL_LINES = 120;
function labelPrompt(lines, first, who) {
  var body = lines.map(function (l, i) { return tag(first + i) + " " + l.text; }).join("\n");
  return "Below is part of a machine transcript of a sit-down interview" + (who ? " with " + who : "") + ". Speakers are NOT labelled. For EVERY line say who speaks it: " +
    "E = the interviewee, I = the interviewer or crew (questions, prompts, set-up, reactions like \"Really?\", \"Nice.\", \"That's cool.\"). " +
    "A line where both speak: the one who says most. Return ONLY JSON: {\"labels\":[\"" + tag(first) + " I\",\"" + tag(first + 1) + " E\", ...]} with one entry per line, in order.\n\nTranscript:\n" + body;
}
var NOTE_SCHEMA = { type: "object", required: ["items"], properties: { items: { type: "array", items: { type: "object",
  required: ["n", "topic", "note"], properties: { n: { type: "integer" }, topic: { type: "string" }, note: { type: "string" } } } } } };
function notePrompt(list, who) {
  return "Below are stretches of what the interviewee says in an interview" + (who ? " with " + who : "") + ", numbered. For each give a topic of 2 to 4 words " +
    "that says what it is about specifically (e.g. \"BMX as a kid\", \"First World Cup in Andorra\"; capital first letter, names keep their capitals, never starting with the word \"Topic\") " +
    "and a log note for a video editor: the content itself, at most about 12 words, no full sentence needed (e.g. \"Arlie Kemp, from Pemberton, BC\", \"Started riding at 2, lessons in Whistler\"). " +
    "Never describe the speaker or what they do (no \"" + (who || "Tony") + " says\", \"introduces self\", \"they mention\", \"the interviewee\", \"expresses\"). Keep names of other people and places.\n" +
    "Return ONLY JSON: {\"items\":[{\"n\":1,\"topic\":\"...\",\"note\":\"...\"}]}\n\n" + list;
}
// Both passes said interviewer: dropped only if it reads like it too (a question, a reaction, a
// prompt). A line of the interviewee's that both passes got wrong stays (Tod, 30 Oct 2026).
var INTERVIEWER = /\?|^\s*(perfect|awesome|cool|nice|great|wow|okay|ok|amazing|brilliant)\b|\bthat'?s (really |pretty |so |very )?(cool|great|awesome|nice|amazing|good)\b|\b(do|did|would|could|can|have|are|were|was|is|will) you\b|\byour\b|\bquestions?\b|\blet'?s (talk|start|go)\b|\btell (me|us)\b/i;
function clearlyInterviewer(l) { return INTERVIEWER.test(l.text); }

/* Cut edges from the sound itself, not whisper's line times (the end of a line is often early or
 * late). Speech/silence comes from an energy floor learned per interview (20 ms frames, 2-means
 * on dB). A start moves back to the silence before the word it lands in, then 0.25 s of handle;
 * an end moves on to the silence after the word, then 0.5 s of handle; a handle stops short of
 * the next speech so it never runs into a question. Answers that then touch are joined. */
function readWavDb(file) {
  var buf = fs.readFileSync(file), at = 12, data = -1, size = 0;
  while (at + 8 <= buf.length) {
    var id = buf.toString("ascii", at, at + 4), len = buf.readUInt32LE(at + 4);
    if (id === "data") { data = at + 8; size = Math.min(len, buf.length - data); break; }
    at += 8 + len + (len & 1);
  }
  if (data < 0) return null;
  var frame = 320, n = Math.floor(size / 2 / frame), db = new Float32Array(n);
  for (var f = 0; f < n; f++) {
    var sum = 0;
    for (var k = 0; k < frame; k++) { var v = buf.readInt16LE(data + 2 * (f * frame + k)) / 32768; sum += v * v; }
    db[f] = 10 * Math.log10(sum / frame + 1e-10);
  }
  return db;
}
function speechThreshold(db) {
  var sorted = Array.prototype.slice.call(db).sort(function (a, b) { return a - b; });
  var lo = sorted[Math.floor(sorted.length * 0.1)], hi = sorted[Math.floor(sorted.length * 0.9)];
  for (var it = 0; it < 20; it++) {
    var c = (lo + hi) / 2, sl = 0, nl = 0, sh = 0, nh = 0;
    for (var i = 0; i < db.length; i++) { if (db[i] < c) { sl += db[i]; nl++; } else { sh += db[i]; nh++; } }
    if (!nl || !nh) break;
    lo = sl / nl; hi = sh / nh;
  }
  return lo + (hi - lo) * 0.35;
}
// Each line's level (90th percentile of its frames: a line the two share counts by its loud part,
// so the interviewee's words in it are kept), split in two groups.
// "I" lines are the quiet group; null when the groups aren't at least 6 dB apart.
function levelLabels(lines, wav, stats) {
  var db = null;
  try { db = readWavDb(wav); } catch (e) {}
  if (!db || lines.length < 10) return null;
  var lv = lines.map(function (l) {
    var f = Math.floor(l.a / 0.02), t = Math.max(f + 1, Math.ceil(l.b / 0.02)), v = Array.prototype.slice.call(db, f, t).sort(function (x, y) { return x - y; });
    return v.length ? v[Math.floor(v.length * 0.9)] : -100;
  });
  var sorted = lv.slice().sort(function (x, y) { return x - y; }), lo = sorted[Math.floor(sorted.length * 0.1)], hi = sorted[Math.floor(sorted.length * 0.9)];
  for (var it = 0; it < 20; it++) {
    var c = (lo + hi) / 2, sl = 0, nl = 0, sh = 0, nh = 0;
    lv.forEach(function (x) { if (x < c) { sl += x; nl++; } else { sh += x; nh++; } });
    if (!nl || !nh) return null;
    lo = sl / nl; hi = sh / nh;
  }
  stats.levelGapDb = Math.round((hi - lo) * 10) / 10;
  if (hi - lo < 6) return null;
  var cut = (lo + hi) / 2;
  stats.speakers = "lav level";
  return lv.map(function (x) { return x < cut ? "I" : "E"; });
}
function safeEdges(answers, wav, stats) {
  var db = null;
  try { db = readWavDb(wav); } catch (e) {}
  if (!db || !db.length) { stats.edges = "no audio to measure"; return answers; }
  var F = 0.02, th = speechThreshold(db), n = db.length, MIN_GAP = 4; // 4 frames = 80 ms of silence
  function speech(f) { return f >= 0 && f < n && db[f] > th; }
  function gapAt(f) { for (var k = 0; k < MIN_GAP; k++) if (speech(f + k)) return false; return true; }
  function onsetBack(f, limit) { // start of the speech f is in, or just after f: walks back to a gap
    while (f > limit && !gapAt(f - MIN_GAP)) f--;
    return Math.max(f, limit);
  }
  function offsetOn(f, limit) { // end of the speech f is in: walks on to a gap
    while (f < limit && !gapAt(f)) f++;
    return Math.min(f, limit);
  }
  var out = [], moved = 0;
  answers.forEach(function (x, i) {
    var a = Math.round(x.start / F), b = Math.round(x.end / F);
    // Line times can be up to a second out either way, so look for the speech first.
    var A = a, B = b, look = Math.round(1 / F), first = -1, last = -1, f;
    for (f = a; f <= Math.min(n - 1, a + look); f++) if (speech(f)) { first = f; break; }
    if (first >= 0) A = onsetBack(first, Math.max(0, a - look));
    for (f = b; f >= Math.max(0, b - look); f--) if (speech(f)) { last = f; break; }
    if (last >= 0) B = offsetOn(last, Math.min(n, b + Math.round(1.5 / F)));
    // Handles, stopping short of other speech.
    var head = A, tail = B, h = Math.round(0.25 / F), t = Math.round(0.5 / F);
    while (head > 0 && A - head < h && !speech(head - 1)) head--;
    while (tail < n && tail - B < t && !speech(tail)) tail++;
    if (head !== a || tail !== b) moved++;
    out.push({ start: head * F, end: Math.max(tail, head + 1) * F, topic: x.topic, outline: x.outline });
  });
  // Never into the answer before; touching answers join.
  var res = [];
  out.forEach(function (x) {
    var p = res[res.length - 1];
    if (p && x.start <= p.end + 0.02) { p.end = Math.max(p.end, x.end); stats.edgesJoined = (stats.edgesJoined || 0) + 1; return; }
    res.push(x);
  });
  stats.edges = { threshold: Math.round(th * 10) / 10, moved: moved, of: answers.length };
  return res;
}

function selectsByLabels(lines, opts, progress) {
  opts = opts || {};
  var stats = { model: MODEL, labelCalls: 0, promptTokens: 0, outputTokens: 0, unlabelled: 0, votesSplit: 0 }, lab = {}, wins = [], runs = [], i;
  // Two labelling passes, the second with its windows shifted by half a window; a line is the
  // interviewer's only when both passes say so (her words are never cut on one say-so: one
  // pass alone put ~5 of Tahnee's lines on the interviewer).
  var votes = [{}, {}], passes = 2;
  // On the speaker's lav the interviewer is much quieter, and that tells them apart better than
  // the model and at once (30 Oct 2026, against the other mics as a key: Tod 42/43 interviewer
  // lines right and all 180 of his; Arly 110/121 and all 128 of hers). The model is only asked if there is no
  // clear gap in the line levels (one shared mic, or the Audio track box filled).
  var byLevel = opts.wav ? levelLabels(lines, opts.wav, stats) : null;
  for (var pass = 0; !byLevel && pass < passes; pass++) {
    var off = pass ? Math.floor(LABEL_LINES / 2) : 0;
    if (off && off < lines.length) wins.push({ pass: pass, first: 0, last: off - 1, ws: lines[0].a });
    for (i = off; i < lines.length; i += LABEL_LINES) wins.push({ pass: pass, first: i, last: Math.min(lines.length, i + LABEL_LINES) - 1, ws: lines[i].a });
  }
  return pool(wins, PARALLEL, function (w, wi) {
    if (progress) progress(wi, wins.length, w);
    var slice = lines.slice(w.first, w.last + 1);
    return ollamaGenerateWith(labelPrompt(slice, w.first + 1, opts.who), LABEL_SCHEMA, opts.numCtx || 12288).then(function (r) {
      stats.labelCalls++; stats.promptTokens += r.prompt_eval_count || 0; stats.outputTokens += r.eval_count || 0;
      var j = null;
      try { j = JSON.parse(r.response); } catch (e) {}
      ((j && j.labels) || []).forEach(function (x) {
        var m = /L(\d+)\s*[:\-=]?\s*([EI])/i.exec(String(x));
        if (!m) return;
        var n = parseInt(m[1], 10) - 1;
        if (n >= w.first && n <= w.last) votes[w.pass][n] = m[2].toUpperCase();
      });
    });
  }).then(function () {
    for (i = 0; byLevel && i < lines.length; i++) lab[i] = byLevel[i];
    for (i = 0; !byLevel && i < lines.length; i++) {
      var a = votes[0][i], b = passes > 1 ? votes[1][i] : a;
      if (a === "I" && b === "I" && clearlyInterviewer(lines[i])) lab[i] = "I"; else if (a || b) lab[i] = "E";
      if (a && b && a !== b) stats.votesSplit++;
    }
    // Unlabelled lines count as the interviewee's (never cut their words).
    var who = lines.map(function (l, k) { if (!lab[k]) stats.unlabelled++; return lab[k] || "E"; });
    // A short interviewer reaction between two of her lines (under 1.5 s, no "?") stays in.
    var keep = who.map(function (w) { return w === "E"; });
    for (i = 1; i + 1 < lines.length; i++)
      if (who[i] === "I" && keep[i - 1] && who[i + 1] === "E" && lines[i].text.indexOf("?") < 0 && lines[i].b - lines[i].a < 1.5) keep[i] = true;
    var run = null;
    for (i = 0; i < lines.length; i++) {
      if (!keep[i]) { if (run) { runs.push(run); run = null; } continue; }
      if (run && lines[i].a - lines[run.l].b > 4) { runs.push(run); run = null; }
      if (run) run.l = i; else run = { f: i, l: i };
    }
    if (run) runs.push(run);
    // A lone reply under 2 s that is only an acknowledgement ("Yeah.", "Yeah, they were.") is
    // dropped; other short ones ("Freeride skiing.") stay.
    var ACK = /^(oh |um |uh |so )?(yeah|yes|yep|no|nope|okay|ok|mm+|mhm|right|sure|exactly|totally|definitely)([ ,]+(yeah|they were|it was|i do|i did|i think so|for sure))?[.!?]*$/i;
    runs = runs.filter(function (r) {
      var d = lines[r.l].b - lines[r.f].a, tx = lines.slice(r.f, r.l + 1).map(function (l) { return l.text.trim(); }).join(" ");
      if (d < 1) return false;
      if (d < 2 && ACK.test(tx)) { stats.acksDropped = (stats.acksDropped || 0) + 1; return false; }
      return true;
    });
    stats.labels = lines.map(function (l, k) { return lab[k] || "-"; }).join("");
    stats.votes = [0, 1].map(function (pn) { return lines.map(function (l, k) { return votes[pn][k] || "-"; }).join(""); });
    stats.crew = []; who.forEach(function (w, k) { if (w === "I") stats.crew.push(k); });
    stats.runs = runs.length;
    // Topics and notes: one call per ~25 runs, two at once.
    var chunks = [];
    for (i = 0; i < runs.length; i += 25) chunks.push(runs.slice(i, i + 25));
    if (progress) progress(-2, chunks.length, { ws: 0 });
    return pool(chunks, PARALLEL, function (ch) {
      var list = ch.map(function (r, k) {
        var said = lines.slice(r.f, r.l + 1).map(function (l) { return l.text; }).join(" ").split(/\s+/).slice(0, 70).join(" ");
        return (k + 1) + ". " + said;
      }).join("\n");
      return ollamaGenerateWith(notePrompt(list, opts.who), NOTE_SCHEMA, 8192).then(function (r) {
        stats.noteCalls = (stats.noteCalls || 0) + 1; stats.promptTokens += r.prompt_eval_count || 0; stats.outputTokens += r.eval_count || 0;
        var j = null;
        try { j = JSON.parse(r.response); } catch (e) {}
        ((j && j.items) || []).forEach(function (x) {
          var r2 = ch[(x.n | 0) - 1];
          if (r2) { r2.topic = cleanTopic(x.topic); r2.note = cleanOutline(String(x.note || ""), opts.who); }
        });
      });
    });
  }).then(function () {
    var answers = runs.map(function (r) { return { start: lines[r.f].a, end: lines[r.l].b, topic: r.topic || "Answer", outline: r.note || "" }; });
    return { answers: opts.wav ? safeEdges(answers, opts.wav, stats) : answers, stats: stats };
  });
}

module.exports = { selectsByLabels: selectsByLabels, pickModel: pickModel, model: function () { return MODEL; }, PARALLEL: PARALLEL, readTranscript: readTranscript, selects: selects, group: group, themes: themes, brief: brief, cleanOutline: cleanOutline, windows: windows, tc: tc, MODEL: MODEL };
