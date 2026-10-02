/* Peny Toolkit panel. Reads skills/<id>/skill.json at open, draws one button per
 * skill, and runs a skill by evaluating core/core.jsx + the skill's premiere.jsx in
 * Premiere's ExtendScript engine, then calling PenyToolkit.run(id, params).
 * Only one ExtendScript call is in flight at a time.
 *
 * Test hook: a JSON file at /tmp/peny-toolkit/run.json ({"skill": "...",
 * "params": {...}, "id": "..."}) runs that skill through the same runSkill() the
 * buttons use; the result goes to /tmp/peny-toolkit/result.json. */

function nodeRequire(name) {
  if (typeof require !== "undefined") return require(name);
  var cepNode = typeof cep_node !== "undefined" ? cep_node : window.cep_node;
  if (cepNode && typeof cepNode.require === "function") return cepNode.require(name);
  throw new Error("Node.js is not available in this panel (check --enable-nodejs in the manifest).");
}

var fs = nodeRequire("fs");
var path = nodeRequire("path");
var os = nodeRequire("os");

var HOOK_DIR = "/tmp/peny-toolkit";
var HOOK_RUN = path.join(HOOK_DIR, "run.json");
var HOOK_RESULT = path.join(HOOK_DIR, "result.json");
var LOG_FILE = path.join(os.homedir(), "Library", "Logs", "PenyToolkit.log");
var HOOK_POLL_MS = 500;

var extRoot = (function () {
  var p = decodeURI(window.__adobe_cep__.getSystemPath("extension"));
  return p.replace(/^file:\/\//, "");
})();

var skills = [];
var busy = false;

// ---- Logging (panel + file) ----
function stamp() {
  var d = new Date();
  function p(n, w) { n = String(n); while (n.length < (w || 2)) n = "0" + n; return n; }
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" +
    p(d.getMinutes()) + ":" + p(d.getSeconds()) + "." + p(d.getMilliseconds(), 3);
}
function log(msg, cls) {
  var el = document.getElementById("log");
  var line = document.createElement("div");
  line.className = cls || "";
  line.textContent = stamp().slice(11, 19) + " " + msg;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
  while (el.children.length > 300) el.removeChild(el.firstChild);
  try { fs.appendFileSync(LOG_FILE, stamp() + " [panel] " + msg + "\n"); } catch (e) {}
}

// ---- ExtendScript ----
function jsxString(s) { return JSON.stringify(String(s)); }

function evalScript(script, cb) {
  window.__adobe_cep__.evalScript(script, function (res) { cb(res); });
}

function runSkill(skillId, params, source, done) {
  var skill = null;
  for (var i = 0; i < skills.length; i++) if (skills[i].id === skillId) skill = skills[i];
  if (!skill) return done({ ok: false, skill: skillId, error: "Unknown skill: " + skillId });
  if (busy) return done({ ok: false, skill: skillId, error: "Another skill is still running." });

  busy = true;
  setButtons(false);
  log("Run " + skill.name + " (" + source + ") " + JSON.stringify(params || {}), "warn");

  var core = path.join(extRoot, "core", "core.jsx");
  var entry = path.join(skill.dir, skill.entry || "premiere.jsx");
  var script =
    "(function(){try{$.evalFile(" + jsxString(core) + ");$.evalFile(" + jsxString(entry) + ");" +
    "return PenyToolkit.run(" + jsxString(skillId) + "," + JSON.stringify(params || {}) + ");}" +
    "catch(e){return '{\"ok\":false,\"error\":\"script load failed: '+String(e).replace(/[\"\\\\]/g,'')+'\"}';}}())";

  evalScript(script, function (raw) {
    var result;
    try { result = JSON.parse(raw); }
    catch (e) { result = { ok: false, skill: skillId, error: "Premiere returned: " + String(raw).slice(0, 300) }; }
    busy = false;
    setButtons(true);
    log((result.ok ? "OK  " : "FAIL ") + skill.name + ": " + (result.ok ? result.summary : result.error),
      result.ok ? "ok" : "err");
    var d = result.details || {};
    ["failed", "skipped"].forEach(function (k) {
      (d[k] || []).forEach(function (r) { log("  " + k + ": " + r.time + " " + r.name + " - " + r.reason, "warn"); });
    });
    done(result);
  });
}

// ---- UI ----
function setButtons(enabled) {
  var bs = document.querySelectorAll("button[data-skill]");
  for (var i = 0; i < bs.length; i++) bs[i].disabled = !enabled;
}

function loadSkills() {
  var dir = path.join(extRoot, "skills");
  var names = fs.readdirSync(dir).sort();
  names.forEach(function (n) {
    var file = path.join(dir, n, "skill.json");
    if (!fs.existsSync(file)) return;
    try {
      var s = JSON.parse(fs.readFileSync(file, "utf-8"));
      s.dir = path.join(dir, n);
      skills.push(s);
    } catch (e) {
      log("Could not read " + file + ": " + e.message, "err");
    }
  });
}

function drawSkills() {
  var host = document.getElementById("skills");
  skills.forEach(function (s) {
    var card = document.createElement("div");
    card.className = "skill";
    var inputsHtml = (s.inputs || []).map(function (inp) {
      return '<label>' + inp.label + '<input data-input="' + inp.id + '" placeholder="' + (inp.placeholder || "") + '"></label>';
    }).join("");
    card.innerHTML = "<p></p>" + (inputsHtml ? '<div class="inputs">' + inputsHtml + "</div>" : "") +
      '<button data-skill="' + s.id + '"></button>';
    card.querySelector("p").textContent = s.description || "";
    card.querySelector("button").textContent = s.name;
    card.querySelector("button").addEventListener("click", function () {
      var params = {};
      var fields = card.querySelectorAll("input[data-input]");
      for (var i = 0; i < fields.length; i++) params[fields[i].getAttribute("data-input")] = fields[i].value;
      runSkill(s.id, params, "button", function () {});
    });
    host.appendChild(card);
  });
}

// ---- Test hook ----
function pollHook() {
  if (busy || !fs.existsSync(HOOK_RUN)) return;
  var claimed = HOOK_RUN + ".claimed";
  try { fs.renameSync(HOOK_RUN, claimed); } catch (e) { return; }
  var req;
  try { req = JSON.parse(fs.readFileSync(claimed, "utf-8")); }
  catch (e) { req = null; }
  try { fs.unlinkSync(claimed); } catch (e) {}
  if (!req || !req.skill) {
    writeHookResult({ ok: false, error: "run.json could not be read or has no \"skill\"." });
    return;
  }
  runSkill(req.skill, req.params || {}, "test hook", function (result) {
    result.requestId = req.id || null;
    writeHookResult(result);
  });
}

function writeHookResult(result) {
  var staged = HOOK_RESULT + ".staged";
  try {
    fs.writeFileSync(staged, JSON.stringify(result, null, 2), "utf-8");
    fs.renameSync(staged, HOOK_RESULT);
  } catch (e) {
    log("Could not write " + HOOK_RESULT + ": " + e.message, "err");
  }
}

// ---- Start ----
(function start() {
  try {
    loadSkills();
    drawSkills();
    try { fs.mkdirSync(HOOK_DIR, { recursive: true }); } catch (e) {}
    setInterval(pollHook, HOOK_POLL_MS);
    document.getElementById("status").textContent = skills.length + " skills loaded. Test hook: " + HOOK_RUN;
    log("Panel open, " + skills.length + " skills: " + skills.map(function (s) { return s.id; }).join(", "));
  } catch (e) {
    document.getElementById("status").textContent = "Error: " + e.message;
    log("Start failed: " + e.message, "err");
  }
}());
