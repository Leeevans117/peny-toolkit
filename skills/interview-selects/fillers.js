/* Filler words (um, uh, ...) for "Remove ums & uhs". Pure Node, no Premiere.
 * Measured 23 Oct 2026 on the Tony Les Gets and Rallon interviews:
 * - whisper.cpp only writes most fillers with a verbatim prompt ("Umm, uh, ..."), and Find
 *   answers' -mc 0 makes it ignore any prompt, so this runs its own passes.
 * - Over a whole file whisper's word times drifted up to 2 s, and without voice detection it
 *   made things up in quiet stretches ("All right." x38) or looped; with voice detection its
 *   word times are in speech-only time (not file time), so neither works for cutting.
 * So: pass 1 transcribes short clips (10 s every 5 s, quiet ones left out) with DTW token
 * times (-dtw large.v3.turbo, needs -nfa), which sit near the middle of each word; pass 2
 * transcribes each filler found again in two 6 s clips (starting 3 s and 2 s before it), and
 * it is cut only when both put it on the same sound. The sound is the loud run (10 ms frames)
 * round the DTW time, with a pause on both sides and neither neighbouring word's DTW time
 * inside it. A filler that runs into a word is skipped, never guessed. */
var fs = require("fs");

var DEFAULT_WORDS = ["um", "umm", "uh", "uhh", "er", "erm", "ah", "hmm"];
var PROMPT = "Umm, uh, so, I mean, like, uh, you know, er, hmm, um, yeah.";
var TILE = 10;              // s, first-pass clips (every TILE / 2 s)
var WIN = 6, LEADS = [3, 2]; // check windows: 6 s, starting 3 s and 2 s before the candidate

function words(list) {
  var out = String(list || "").toLowerCase().split(/[\s,;]+/).map(function (w) { return w.replace(/[^a-z]/g, ""); }).filter(Boolean);
  return out.length ? out : DEFAULT_WORDS.slice();
}
function key(text) { return String(text).toLowerCase().replace(/[^a-z]/g, ""); }

// Whisper -ojf JSON -> words with their DTW time (seconds, minus shift) and probability. A
// token with a leading space starts a word; tokens without one ("," "-" "'m") join the last.
function readWords(file, shift) {
  var d = JSON.parse(fs.readFileSync(file, "utf-8")), out = [];
  (d.transcription || []).forEach(function (s) {
    var first = true;
    (s.tokens || []).forEach(function (t) {
      var text = String(t.text || "");
      if (/^\[_/.test(text)) return;
      var dtw = typeof t.t_dtw === "number" && t.t_dtw >= 0 ? t.t_dtw / 100 : null;
      var last = out[out.length - 1];
      if (!first && last && !/^\s/.test(text)) { last.text += text; return; }
      first = false;
      out.push({ text: text.trim(), t: (dtw !== null ? dtw : t.offsets.from / 1000) + (shift || 0), dtw: dtw !== null, p: t.p });
    });
  });
  return out;
}

// 16-bit PCM wav -> dB per 10 ms frame.
function envelope(file) {
  var b = fs.readFileSync(file), pos = 12, fmt = null, data = null;
  while (pos + 8 <= b.length) {
    var id = b.toString("ascii", pos, pos + 4), size = b.readUInt32LE(pos + 4);
    if (id === "fmt ") fmt = { ch: b.readUInt16LE(pos + 10), sr: b.readUInt32LE(pos + 12), bits: b.readUInt16LE(pos + 22) };
    if (id === "data") { data = { at: pos + 8, size: Math.min(size, b.length - pos - 8) }; break; }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || !data || fmt.bits !== 16) throw new Error("Not a 16-bit PCM wav: " + file);
  var hop = Math.round(fmt.sr / 100), step = 2 * fmt.ch, n = Math.floor(data.size / step / hop), db = new Float32Array(n);
  for (var f = 0; f < n; f++) {
    var sum = 0;
    for (var k = 0; k < hop; k++) { var v = b.readInt16LE(data.at + (f * hop + k) * step) / 32768; sum += v * v; }
    db[f] = 10 * Math.log10(sum / hop + 1e-12);
  }
  return db;
}

function percentile(arr, a, b, p) {
  var s = Array.prototype.slice.call(arr, Math.max(0, a), Math.min(arr.length, b)).sort(function (x, y) { return x - y; });
  return s.length ? s[Math.floor((s.length - 1) * p)] : -120;
}

// The sound of the filler ws[i] in db (frames of 10 ms): { a, b, quietBefore, quietAfter }
// in frames, or { why } when it cannot be told apart from the words round it.
function sound(ws, i, db) {
  if (!ws[i].dtw) return { why: "no word timing from whisper" };
  // Quiet level = 10th percentile over +-3 s (the pauses). The sound is what is 6 dB above it;
  // when that runs into a word, 9 then 12 dB (a filler said straight after a word only shows
  // its pause at a higher level).
  var c = Math.round(ws[i].t * 100), floor = percentile(db, c - 300, c + 300, 0.1), first = null;
  for (var k = 0; k < 3; k++) {
    var r = soundAt(ws, i, db, c, floor + 10, floor + 6 + 3 * k);
    if (!r.why) return r;
    if (!first) first = r;
  }
  return first;
}

function soundAt(ws, i, db, c, hi, lo) {
  var GAP = 5, QUIET = 10, MAXLEN = 120, MINLEN = 15, NEAR = 15, q;
  var prev = i > 0 ? Math.round(ws[i - 1].t * 100) : -1e9, next = i + 1 < ws.length ? Math.round(ws[i + 1].t * 100) : 1e9;
  if (lo > hi) hi = lo;
  function loud(f, t) { return f >= 0 && f < db.length && db[f] > t; }
  var seed = -1;
  for (var d = 0; d <= NEAR && seed < 0; d++) { if (loud(c - d, hi)) seed = c - d; else if (loud(c + d, hi)) seed = c + d; }
  if (seed < 0) return { why: "no sound at that time" };
  var a = seed, b = seed;
  for (;;) { for (q = 1; q <= GAP + 1 && !loud(a - q, lo); q++); if (q > GAP + 1) break; a -= q; }
  for (;;) { for (q = 1; q <= GAP + 1 && !loud(b + q, lo); q++); if (q > GAP + 1) break; b += q; }
  if (b - a + 1 > MAXLEN) return { why: "runs on into speech (" + ((b - a + 1) / 100).toFixed(2) + " s of sound)" };
  if (b - a + 1 < MINLEN) return { why: "too short to be a filler (" + ((b - a + 1) * 10) + " ms)" };
  if (prev >= a - 2) return { why: "joined to the word before" };
  if (next <= b + 2) return { why: "joined to the word after" };
  var qa = 0, qb = 0;
  while (qa < 100 && a - 1 - qa >= 0 && !loud(a - 1 - qa, lo)) qa++;
  while (qb < 100 && b + 1 + qb < db.length && !loud(b + 1 + qb, lo)) qb++;
  if (qa < QUIET && a - qa > 0) return { why: "no pause before it" };
  if (qb < QUIET && b + qb < db.length - 1) return { why: "no pause after it" };
  return { a: a, b: b, quietBefore: qa, quietAfter: qb };
}

// Filler words in a list of words: [{ i, word, t }].
function fillerWords(ws, list) {
  var want = {}, out = [];
  words(list).forEach(function (w) { want[w] = true; });
  for (var i = 0; i < ws.length; i++) if (want[key(ws[i].text)]) out.push({ i: i, word: key(ws[i].text), t: ws[i].t });
  return out;
}

function context(ws, i) { return ws.slice(Math.max(0, i - 4), i + 5).map(function (w) { return w.text; }).join(" "); }

// Check windows for each candidate: [{ cand, lead, start, file }] (file = wav to write).
function windows(cands, duration, dir) {
  var out = [];
  cands.forEach(function (c, n) {
    LEADS.forEach(function (lead) {
      var start = Math.max(0, Math.min(c.t - lead, duration - WIN));
      out.push({ cand: n, lead: lead, start: start, file: require("path").join(dir, "c" + n + "_" + lead + ".wav") });
    });
  });
  return out;
}

// Decides each candidate from its two check windows (whisper JSON at w.file + ".json").
// Returns { fillers: [{ word, start, end, sound, p, context }], skipped: [{ word, t, why, context }] }.
function decide(cands, wins, db, opts) {
  opts = opts || {};
  var pad = opts.pad === undefined ? 0.04 : opts.pad, list = opts.words, fillers = [], skipped = [];
  function inWindow(w) {
    if (!fs.existsSync(w.file + ".json")) return { hits: [], whys: ["whisper could not check it"] };
    var ws = readWords(w.file + ".json", w.start), hits = [], whys = [];
    fillerWords(ws, list).forEach(function (f) {
      if (Math.abs(f.t - cands[w.cand].t) > 1.6) return;
      var s = sound(ws, f.i, db);
      if (s.why) whys.push(s.why); else hits.push({ word: f.word, a: s.a, b: s.b, qa: s.quietBefore, qb: s.quietAfter, p: ws[f.i].p, context: context(ws, f.i) });
    });
    return { hits: hits, whys: whys };
  }
  cands.forEach(function (c, n) {
    var mine = wins.filter(function (w) { return w.cand === n; }).map(inWindow);
    var agreed = mine[0].hits.filter(function (x) {
      return mine.slice(1).every(function (m) { return m.hits.some(function (y) { return Math.abs(x.a - y.a) <= 6 && Math.abs(x.b - y.b) <= 6; }); });
    });
    if (!agreed.length) {
      var whys = [];
      mine.forEach(function (m) { m.whys.forEach(function (w) { if (whys.indexOf(w) < 0) whys.push(w); }); });
      var heard = mine.filter(function (m) { return m.hits.length; }).length;
      skipped.push({ word: c.word, t: c.t, context: c.context,
        why: whys.length ? whys.join("; ") : heard ? "the two checks put it in different places" : "not heard again in the check" });
      return;
    }
    agreed.forEach(function (x) {
      if (fillers.some(function (f) { return Math.abs(f.sound[0] * 100 - x.a) <= 10; })) return; // same sound as an earlier candidate
      var padA = Math.min(pad, x.qa / 300), padB = Math.min(pad, x.qb / 300); // at most a third of each pause
      fillers.push({ word: x.word, start: Math.max(0, x.a / 100 - padA), end: (x.b + 1) / 100 + padB, sound: [x.a / 100, (x.b + 1) / 100], p: x.p, context: x.context });
    });
  });
  fillers.sort(function (a, b) { return a.start - b.start; });
  // A candidate skipped whose sound was cut through another candidate is not a skip.
  skipped = skipped.filter(function (s) { return !fillers.some(function (f) { return Math.abs(f.sound[0] - s.t) < 0.8 && f.word === s.word; }); });
  return { fillers: fillers, skipped: skipped };
}

// Clips for the first pass: TILE s long every TILE / 2 s, so every moment is in two clips;
// clips with under half a second of sound are left out (whisper makes words up in quiet).
function tiles(duration, db, dir) {
  var floor = percentile(db, 0, db.length, 0.1), out = [];
  for (var start = 0; start < duration - 0.5; start += TILE / 2) {
    var a = Math.round(start * 100), b = Math.min(db.length, Math.round((start + TILE) * 100)), loud = 0;
    for (var f = a; f < b; f++) if (db[f] > floor + 10) loud++;
    if (loud >= 50) out.push({ start: start, len: Math.min(TILE, duration - start), file: require("path").join(dir, "t" + out.length + ".wav") });
  }
  return out;
}

// The whole search on wav (16 kHz mono, sequence time). tools: { ffmpeg, whisper, model };
// run(cmd, args, onLine) -> Promise (the panel's, so Cancel kills it); status(text).
function find(wav, duration, dir, tools, run, status, opts) {
  var path = require("path"), list = (opts || {}).words, cands = [], wins = [], db = envelope(wav), crashed = [];
  // Cuts each clip out of wav, one ffmpeg per 40 clips.
  function cut(clips) {
    var chain = Promise.resolve();
    for (var i = 0; i < clips.length; i += 40) (function (part) {
      chain = chain.then(function () {
        var args = ["-hide_banner", "-loglevel", "error", "-y", "-i", wav];
        part.forEach(function (c) { args.push("-ss", c.start.toFixed(3), "-t", String(c.len || WIN), "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", c.file); });
        return run(tools.ffmpeg, args);
      });
    }(clips.slice(i, i + 40)));
    return chain;
  }
  // whisper on many clips in one go (model loaded once), each to <clip>.json. whisper 1.9.4
  // aborts with DTW on a clip that comes out as one or two tokens (WHISPER_ASSERT
  // filter_width < a->ne[2], 23 Oct 2026), ending the batch: the clip it stopped on is left
  // without a result and the rest run again.
  function transcribe(clips, label) {
    function done() { return clips.filter(function (c) { return fs.existsSync(c.file + ".json"); }).length; }
    function from(k) {
      var left = clips.slice(k).filter(function (c) { return !fs.existsSync(c.file + ".json"); });
      if (!left.length) return Promise.resolve();
      var args = ["-m", tools.model, "-l", "en", "-ojf", "-t", "8", "-np", "-nfa", "--prompt", PROMPT, "--dtw", "large.v3.turbo"];
      left.forEach(function (c) { args.push("-f", c.file); });
      return run(tools.whisper, args, function (line) {
        if (/saving output to/.test(line)) status(label + ": " + Math.round(100 * done() / clips.length) + "%");
      }).catch(function (e) {
        if (e && e.stop) throw e;
        var at = clips.indexOf(left.filter(function (c) { return !fs.existsSync(c.file + ".json"); })[0]);
        if (at < 0) return;
        crashed.push(path.basename(clips[at].file));
        if (crashed.length > 10 + clips.length / 4) throw new Error("whisper stopped on " + crashed.length + " clips: " + (e && e.message ? e.message : e));
        return from(at + 1);
      });
    }
    status(label + "…");
    return from(0);
  }
  var tdir = path.join(dir, "filler-pass1"), cdir = path.join(dir, "filler-pass2"), tl;
  fs.mkdirSync(tdir, { recursive: true });
  fs.mkdirSync(cdir, { recursive: true });
  tl = tiles(duration, db, tdir);
  status("Cutting " + tl.length + " short clips…");
  return cut(tl).then(function () {
    return transcribe(tl, "Listening for fillers in " + tl.length + " short clips (pass 1 of 2)");
  }).then(function () {
    var found = [];
    tl.forEach(function (c) {
      if (!fs.existsSync(c.file + ".json")) return;
      var ws = readWords(c.file + ".json", c.start);
      fillerWords(ws, list).forEach(function (f) {
        // Not in the first or last half second of a clip (cut-off words), unless the file starts or ends there.
        if ((f.t - c.start < 0.5 && c.start > 0) || (c.start + c.len - f.t < 0.5 && c.start + c.len < duration - 0.1)) return;
        found.push({ t: f.t, word: f.word, context: context(ws, f.i) });
      });
    });
    found.sort(function (a, b) { return a.t - b.t; });
    found.forEach(function (x) { if (!cands.length || x.t - cands[cands.length - 1].t > 0.35) cands.push(x); });
    if (!cands.length) return null;
    wins = windows(cands, duration, cdir);
    status("Cutting " + wins.length + " check clips…");
    return cut(wins).then(function () { return transcribe(wins, "Checking " + cands.length + " possible fillers (pass 2 of 2)"); });
  }).then(function () {
    var r = cands.length ? decide(cands, wins, db, opts) : { fillers: [], skipped: [] };
    r.candidates = cands.length; r.clips = tl.length; r.crashed = crashed;
    return r;
  });
}

module.exports = { find: find, readWords: readWords, envelope: envelope, words: words, windows: windows, decide: decide, sound: sound,
  tiles: tiles, DEFAULT_WORDS: DEFAULT_WORDS, PROMPT: PROMPT, TILE: TILE, WIN: WIN };
