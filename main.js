/* Peny Toolkit panel. Reads skills/<id>/skill.json at open and draws a card per skill.
 *
 * Two kinds of skill:
 *  - Premiere-only: skill.json has "entry" (premiere.jsx). Its button evaluates
 *    core/core.jsx + the entry in Premiere and calls PenyToolkit.run(id, params).
 *  - With a panel module: skill.json also has "panel" (panel.js, a Node module) and
 *    "actions". Each action button calls the module, which can run OS jobs
 *    (core/jobs.js) and call its premiere.jsx through api.evalSkill().
 * Actions marked "control" (e.g. Pause/Cancel) work while another action runs; any
 * other action is refused while one is running.
 *
 * Every ExtendScript call goes through one queue, so only one is ever in flight.
 *
 * Test hook: /tmp/peny-toolkit/run.json {"skill", "action" (optional), "params", "id"}
 * runs through the same runAction() as the buttons. The result is written to
 * /tmp/peny-toolkit/result.json and, when an id is given, result-<id>.json. */

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

var jobs = nodeRequire(path.join(extRoot, "core", "jobs.js"));
var skills = [];
var running = null; // "<skill>/<action>" while a non-control action runs

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
  while (el.children.length > 400) el.removeChild(el.firstChild);
  try { fs.appendFileSync(LOG_FILE, stamp() + " [panel] " + msg + "\n"); } catch (e) {}
}

// ---- ExtendScript: one call at a time ----
var evalChain = Promise.resolve();
function evalJsx(script) {
  var p = evalChain.then(function () {
    return new Promise(function (resolve) { window.__adobe_cep__.evalScript(script, resolve); });
  });
  evalChain = p.catch(function () {});
  return p;
}

function jsxString(s) { return JSON.stringify(String(s)); }

function evalSkill(skill, params) {
  var core = path.join(extRoot, "core", "core.jsx");
  var entry = path.join(skill.dir, skill.entry || "premiere.jsx");
  var script =
    "(function(){try{$.evalFile(" + jsxString(core) + ");$.evalFile(" + jsxString(entry) + ");" +
    "return PenyToolkit.run(" + jsxString(skill.id) + "," + JSON.stringify(params || {}) + ");}" +
    "catch(e){return '{\"ok\":false,\"error\":\"script load failed: '+String(e).replace(/[\"\\\\]/g,'')+'\"}';}}())";
  return evalJsx(script).then(function (raw) {
    try { return JSON.parse(raw); }
    catch (e) { return { ok: false, skill: skill.id, error: "Premiere returned: " + String(raw).slice(0, 300) }; }
  });
}

// ---- Running actions ----
function findSkill(id) { for (var i = 0; i < skills.length; i++) if (skills[i].id === id) return skills[i]; return null; }
function findAction(skill, id) {
  var list = skill.actions || [{ id: "run", label: skill.name }];
  if (!id) return list[0];
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

function runAction(skillId, actionId, params, source) {
  var skill = findSkill(skillId);
  if (!skill) return Promise.resolve({ ok: false, skill: skillId, error: "Unknown skill: " + skillId });
  var action = findAction(skill, actionId);
  if (!action) return Promise.resolve({ ok: false, skill: skillId, error: "Unknown action: " + actionId });
  if (!action.control && running) {
    return Promise.resolve({ ok: false, skill: skillId, error: running + " is still running." });
  }
  var label = skill.name + (skill.actions ? " > " + action.label : "");
  if (!action.control) { running = label; setButtons(); }
  log("Run " + label + " (" + source + ") " + JSON.stringify(params || {}), "warn");

  var p;
  try {
    if (skill.module) {
      var fn = skill.module.actions[action.id];
      p = fn ? fn(params || {}) : Promise.resolve({ ok: false, error: "Action not implemented: " + action.id });
    } else {
      p = evalSkill(skill, params);
    }
  } catch (e) {
    p = Promise.resolve({ ok: false, error: "Action threw: " + e.message });
  }
  return Promise.resolve(p).catch(function (e) {
    return { ok: false, error: "Action failed: " + (e && e.message ? e.message : String(e)) };
  }).then(function (result) {
    result = result || { ok: false, error: "No result" };
    result.skill = skill.id;
    result.action = action.id;
    if (!action.control) { running = null; setButtons(); }
    log((result.ok ? "OK  " : "FAIL ") + label + ": " + (result.ok ? result.summary : result.error), result.ok ? "ok" : "err");
    var d = result.details || {};
    ["failed", "skipped"].forEach(function (k) {
      (d[k] || []).slice(0, 30).forEach(function (r) {
        log("  " + k + ": " + (r.time ? r.time + " " : "") + (r.bin ? r.bin + "/" : "") + (r.name || r.nodeId || "") + " - " + r.reason, "warn");
      });
    });
    setStatus(skill, result.ok ? result.summary : result.error);
    return result;
  });
}

// ---- UI ----
function setButtons() {
  var bs = document.querySelectorAll("button[data-action]");
  for (var i = 0; i < bs.length; i++) {
    if (bs[i].getAttribute("data-control") !== "1") bs[i].disabled = !!running;
  }
}
function setStatus(skill, text) {
  var el = document.querySelector('.status[data-skill="' + skill.id + '"]');
  if (el) el.textContent = text || "";
}

function storeKey(skill, input) { return "penytoolkit." + skill.id + "." + input; }
function remember(skill, input, value) { try { localStorage.setItem(storeKey(skill, input), value); } catch (e) {} }
function recall(skill, input) { try { return localStorage.getItem(storeKey(skill, input)) || ""; } catch (e) { return ""; } }

function chooseFolder(title, start) {
  try {
    var r = window.cep.fs.showOpenDialog(false, true, title, start || "");
    if (r && r.data && r.data.length) return r.data[0];
  } catch (e) { log("Folder dialog failed: " + e.message, "err"); }
  return null;
}

function loadSkills() {
  var dir = path.join(extRoot, "skills");
  fs.readdirSync(dir).sort().forEach(function (n) {
    var file = path.join(dir, n, "skill.json");
    if (!fs.existsSync(file)) return;
    try {
      var s = JSON.parse(fs.readFileSync(file, "utf-8"));
      s.dir = path.join(dir, n);
      if (s.panel) {
        var factory = nodeRequire(path.join(s.dir, s.panel));
        s.module = factory({
          evalSkill: function (params) { return evalSkill(s, params); },
          jobs: jobs,
          log: log,
          status: function (text) { setStatus(s, text); },
          skillDir: s.dir
        });
      }
      skills.push(s);
    } catch (e) {
      log("Could not load skill " + n + ": " + e.message, "err");
    }
  });
}

function drawSkills() {
  var host = document.getElementById("skills");
  skills.forEach(function (s) {
    var card = document.createElement("div");
    card.className = "skill";
    var h = document.createElement("h2"); h.textContent = s.name; card.appendChild(h);
    var p = document.createElement("p"); p.textContent = s.description || ""; card.appendChild(p);

    var fields = document.createElement("div");
    fields.className = "inputs";
    (s.inputs || []).forEach(function (inp) {
      var label = document.createElement("label");
      label.textContent = inp.label;
      var row = document.createElement("div"); row.className = "row";
      var input = document.createElement("input");
      input.setAttribute("data-input", inp.id);
      input.placeholder = inp.placeholder || "";
      input.value = recall(s, inp.id);
      input.addEventListener("change", function () { remember(s, inp.id, input.value); });
      row.appendChild(input);
      if (inp.type === "folder") {
        var b = document.createElement("button");
        b.className = "small"; b.textContent = "Browse…";
        b.addEventListener("click", function () {
          var f = chooseFolder(inp.label, input.value);
          if (f) { input.value = f; remember(s, inp.id, f); }
        });
        row.appendChild(b);
      }
      label.appendChild(row);
      fields.appendChild(label);
    });
    if (fields.children.length) card.appendChild(fields);

    var buttons = document.createElement("div"); buttons.className = "buttons";
    (s.actions || [{ id: "run", label: s.name }]).forEach(function (a) {
      var b = document.createElement("button");
      b.textContent = a.label;
      b.setAttribute("data-action", a.id);
      if (a.control) { b.setAttribute("data-control", "1"); b.className = "control"; }
      b.addEventListener("click", function () {
        if (a.confirm && !window.confirm(a.confirm)) return;
        var params = {};
        var ins = card.querySelectorAll("input[data-input]");
        for (var i = 0; i < ins.length; i++) params[ins[i].getAttribute("data-input")] = ins[i].value;
        runAction(s.id, a.id, params, "button");
      });
      buttons.appendChild(b);
    });
    card.appendChild(buttons);

    var st = document.createElement("div"); st.className = "status"; st.setAttribute("data-skill", s.id);
    card.appendChild(st);
    host.appendChild(card);
  });
}

// ---- Test hook ----
function pollHook() {
  if (!fs.existsSync(HOOK_RUN)) return;
  var req = null;
  try { req = JSON.parse(fs.readFileSync(HOOK_RUN, "utf-8")); } catch (e) { req = null; }
  var skill = req && req.skill ? findSkill(req.skill) : null;
  var action = skill ? findAction(skill, req.action) : null;
  if (running && !(action && action.control)) return; // wait for the running action to finish
  var claimed = HOOK_RUN + ".claimed";
  try { fs.renameSync(HOOK_RUN, claimed); } catch (e) { return; }
  try { fs.unlinkSync(claimed); } catch (e) {}
  if (!req || !req.skill) { writeHookResult({ ok: false, error: "run.json could not be read or has no \"skill\"." }, null); return; }
  runAction(req.skill, req.action, req.params || {}, "test hook").then(function (result) {
    result.requestId = req.id || null;
    writeHookResult(result, req.id);
  });
}

function writeHookResult(result, id) {
  var text = JSON.stringify(result, null, 2);
  [HOOK_RESULT].concat(id ? [path.join(HOOK_DIR, "result-" + String(id).replace(/[^\w.-]/g, "_") + ".json")] : [])
    .forEach(function (target) {
      var staged = target + ".staged";
      try { fs.writeFileSync(staged, text, "utf-8"); fs.renameSync(staged, target); }
      catch (e) { log("Could not write " + target + ": " + e.message, "err"); }
    });
}

// ---- Start ----
(function start() {
  try {
    loadSkills();
    drawSkills();
    try { fs.mkdirSync(HOOK_DIR, { recursive: true }); } catch (e) {}
    setInterval(pollHook, HOOK_POLL_MS);
    document.getElementById("status").textContent = skills.length + " skills loaded.";
    log("Panel open, " + skills.length + " skills: " + skills.map(function (s) { return s.id; }).join(", "));
  } catch (e) {
    document.getElementById("status").textContent = "Error: " + e.message;
    log("Start failed: " + e.message, "err");
  }
}());
