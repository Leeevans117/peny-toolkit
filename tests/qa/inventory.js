// Builds QA_CHECKLIST.md: every function in the Toolkit, grouped by file, with the comment
// that says what it does and whether the offline tests ran it.
//   NODE_V8_COVERAGE=/tmp/v8 node --test tests/node/*.test.js     (Node + ExtendScript-in-Node coverage)
//   python3 tests/qa/pyfuncs.py /tmp/pyfuncs.json                   (Python functions the tests called)
//   node tests/qa/inventory.js /tmp/v8 /tmp/pyfuncs.json > QA_CHECKLIST.md
var fs = require("fs"), path = require("path"), cp = require("child_process"), url = require("url");
var ROOT = path.join(__dirname, "..", ".."), V8 = process.argv[2], PYF = process.argv[3];

// Lines (1-based) where a function that ran starts, per file.
var ran = {};
function lineOf(src, off) { var n = 1; for (var i = 0; i < off && i < src.length; i++) if (src.charCodeAt(i) === 10) n++; return n; }
if (V8) fs.readdirSync(V8).forEach(function (f) {
  JSON.parse(fs.readFileSync(path.join(V8, f), "utf-8")).result.forEach(function (s) {
    var file = s.url.indexOf("file://") === 0 ? url.fileURLToPath(s.url) : s.url;
    if (file.indexOf(ROOT + "/") !== 0 || file.indexOf("/tests/") >= 0) return;
    var rel = path.relative(ROOT, file), src; try { src = fs.readFileSync(file, "utf-8"); } catch (e) { return; }
    var set = ran[rel] = ran[rel] || {};
    s.functions.forEach(function (fn) { if (fn.ranges[0].count > 0) set[lineOf(src, fn.ranges[0].startOffset)] = true; });
  });
});
var pyRan = {};
if (PYF) JSON.parse(fs.readFileSync(PYF, "utf-8")).forEach(function (x) { (pyRan[x[0]] = pyRan[x[0]] || {})[x[1]] = true; });

// End-to-end runs that reach code no in-process coverage sees (separate processes, the browser).
var E2E = {
  "skills/sync-external-audio/measure.py": "run end to end on generated media (tests/python: SyncExternalAudioEndToEnd; stress_sync.py 1 h wav)",
  "skills/loudness-master/measure.py": "run end to end on generated media (tests/python: LoudnessMeasure, EBU reference sine)",
  "skills/colour-baseline/lutpreset.py": "parse_cube/embedded_blob in-process; CLI usage run",
  "skills/proxy-automation/red-proxy-finish.sh": "run end to end on ffmpeg renders (tests/node/scripts.test.js)",
  "install.sh": "copy + NO PANEL path run on macOS (needs rsync); soft reload needs an open panel",
  "main.js": "headless Chromium UI smoke (tests/ui/smoke.js): every app opened, every button pressed, no page errors",
  "loader.js": "headless Chromium UI smoke loads the page through it",
  "index.html": "headless Chromium UI smoke"
};
var WHY = {
  jsx: "needs Premiere's own objects (QE, Lumetri, encoder, bins) the fake does not model: Premiere run",
  panel: "runs real tools (ffmpeg/whisper/Ollama/REDline) after Premiere answers: Premiere run",
  sh: "installer/build/publish machine script: run on a Mac (verify_fresh_install.sh / build machine)",
  py: "called from a Premiere-side flow with real renders: Premiere run",
  js: "not reached by the offline tests"
};

var files = cp.execSync("git -c safe.directory='*' ls-files", { cwd: ROOT }).toString().trim().split("\n")
  .filter(function (f) { return /\.(js|jsx|py|sh|command)$/.test(f) && f.indexOf("tests/") !== 0; }).sort();
var out = [], total = 0, covered = 0, perStatus = { unit: 0, e2e: 0, none: 0 };
out.push("# QA checklist: every function in the Peny Toolkit", "",
  "Made by `tests/qa/inventory.js` from the code itself (" + new Date().toISOString().slice(0, 10) + ", branch qa/full-pass). One row per function, grouped by file.",
  "\"What it does\" is the code's own comment just above the function (\"-\" where there is none); the file heading says what the file takes in, gives back and touches.", "",
  "Status: **[x] unit** = an offline test ran it (Node `--test` with V8 coverage, Python `unittest` with `trace`). **[x] e2e** = run end to end by a separate-process, browser or script test (named under the file). **[ ] -** = not run offline; the reason is under the file.", "");
var TOUCH = JSON.parse(fs.readFileSync(path.join(__dirname, "touches.json"), "utf-8"));
var body = [];
files.forEach(function (rel) {
  var src = fs.readFileSync(path.join(ROOT, rel), "utf-8"), lines = src.split("\n"), rows = [];
  var ext = path.extname(rel).slice(1), py = ext === "py", sh = ext === "sh" || ext === "command";
  lines.forEach(function (l, i) {
    var m, name = null;
    if (py) { if ((m = /^(\s*)def\s+(\w+)\s*\(/.exec(l))) name = m[2]; }
    else if (sh) { if ((m = /^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{/.exec(l))) name = m[1]; }
    else if ((m = /^\s*(?:async\s+)?function\s+([\w$]+)\s*\(/.exec(l)) || (m = /([\w$.]+(?:\["[\w-]+"\])?)\s*=\s*(?:async\s+)?function\s*\w*\s*\(/.exec(l)) || (m = /^\s*([\w$]+)\s*:\s*(?:async\s+)?function\s*\(/.exec(l))) name = m[1];
    if (!name) return;
    var doc = "";
    for (var k = i - 1; k >= 0 && k >= i - 12; k--) {
      var c = lines[k].trim();
      if (/^(\/\/|#(?!!)|\*|\/\*)/.test(c)) doc = c.replace(/^(\/\/+|#+|\/\*+|\*+\/?)\s?/, "").replace(/\*\/$/, "") + (doc ? " " + doc : "");
      else break;
    }
    if (!doc && py) { var d = /^\s*"""(.*?)("""|$)/.exec(lines[i + 1] || ""); if (d) doc = d[1]; }
    doc = doc.replace(/\s+/g, " ").replace(/\|/g, "/").trim();
    if (doc.length > 140) doc = doc.slice(0, 137).replace(/\s+\S*$/, "") + "...";
    var unit = py ? !!(pyRan[rel] && pyRan[rel][name]) : !!(ran[rel] && (ran[rel][i + 1]));
    var st = unit ? "unit" : E2E[rel] ? "e2e" : "none";
    perStatus[st]++; total++; if (st !== "none") covered++;
    rows.push("| " + (st === "none" ? "[ ] -" : "[x] " + st) + " | `" + name + "` | " + (i + 1) + " | " + (doc || "-") + " |");
  });
  if (!rows.length && !E2E[rel]) return;
  body.push("## " + rel, "");
  if (TOUCH[rel]) body.push(TOUCH[rel], "");
  if (E2E[rel]) body.push("End to end: " + E2E[rel] + ".", "");
  var notRun = rows.filter(function (r) { return r.indexOf("[ ] -") === 2; }).length;
  if (notRun) body.push("Not run offline (" + notRun + "): " + (/\.jsx$/.test(rel) ? WHY.jsx : /panel\.js$/.test(rel) ? WHY.panel : sh ? WHY.sh : py ? WHY.py : WHY.js) + ".", "");
  if (rows.length) body.push("| Status | Function | Line | What it does |", "|---|---|---|---|");
  body = body.concat(rows); body.push("");
});
out.push("**" + total + " functions; " + covered + " (" + Math.round(100 * covered / total) + "%) run by the offline suite: " + perStatus.unit + " by unit tests, " + perStatus.e2e + " end to end; " + perStatus.none + " not run offline.**", "");
process.stdout.write(out.concat(body).join("\n") + "\n");
