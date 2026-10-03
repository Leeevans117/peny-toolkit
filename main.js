/* Peny Toolkit panel. Reads skills/<id>/skill.json at open and draws a home screen with
 * one app tile per skill (name, icon.svg, "tint", "order"); each tile opens the skill's view.
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
 * Test hook: /tmp/peny-toolkit/inbox/run.json {"skill", "action" (optional), "params", "id"}
 * runs through the same runAction() as the buttons. The result is written to
 * /tmp/peny-toolkit/result.json and, when an id is given, result-<id>.json.
 *
 * Loaded by loader.js, which can run this file again in the same page (soft reload),
 * so everything is inside one function and window.PenyApp.stop() undoes what it set up. */

(function () {

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
var HOOK_INBOX = path.join(HOOK_DIR, "inbox");
var HOOK_RUN = path.join(HOOK_INBOX, "run.json");
// Reloading a CEP page can leave the old page running invisibly (seen 2 Oct 2026:
// hidden copies kept polling the hook and took requests they could never finish).
// Each page writes its own id here when it starts (loader.js does it, once per page);
// a page whose id is no longer the current one stops polling.
var INSTANCE_FILE = path.join(HOOK_DIR, "instance");
var INSTANCE_ID = (window.PenyLoader && window.PenyLoader.instanceId) || (Date.now() + "-" + Math.random().toString(36).slice(2, 8));
var hookTimer = null;
var HOOK_RESULT = path.join(HOOK_DIR, "result.json");
var LOG_FILE = path.join(os.homedir(), "Library", "Logs", "PenyToolkit.log");
var HOOK_POLL_MS = 500;

var extRoot = (function () {
  var p = decodeURI(window.__adobe_cep__.getSystemPath("extension"));
  return p.replace(/^file:\/\//, "");
})();

var jobs = null; // loaded in start(), after clearToolkitModules()
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
  if (!id) id = list.some(function (a) { return a.id === "run"; }) ? "run" : list[0].id;
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
  if (params) for (var pk in params) if (params.hasOwnProperty(pk) && typeof params[pk] === "string") params[pk] = fileUrlToPath(params[pk]);
  var label = skill.name + (skill.actions ? " > " + action.label : "");
  if (!action.control) { running = label; runningSkill = skill.id; setButtons(); }
  log("Run " + label + " (" + source + ") " + JSON.stringify(params || {}), "warn");

  var p;
  try {
    if (action.skill) {
      // An action that runs another (Premiere-only) skill, e.g. Link External Audio's
      // "Make safe copy" step, which runs the make-safe-copy skill.
      var other = findSkill(action.skill);
      if (!other) p = Promise.resolve({ ok: false, error: "Unknown skill: " + action.skill });
      else if (other.module) p = other.module.actions[action.action || "run"](params || {});
      else p = evalSkill(other, params);
    } else if (skill.module) {
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
    if (!action.control) { running = null; runningSkill = null; setButtons(); }
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

// ---- Proxy progress ----
// Fed by the render pool (core/jobs.js via proxy-automation): real job starts/exits plus
// each running render's own fraction. Start/finish events go to the log; ticks are
// written to the log file at most every 3 s.
var lastProgressFileAt = 0;
function progressText(p) {
  if (p.event === "none") return "Nothing to render" + (p.already ? " (" + p.already + " already have proxies)" : "");
  return p.finished + " of " + p.total + " proxies done · " + p.percent.toFixed(p.percent % 1 ? 1 : 0) + "%";
}
function showProgress(p) {
  if (!p) return;
  var line = "Proxy progress: " + progressText(p) + " (" + p.event + ", " + p.running + " running" +
    (p.failed ? ", " + p.failed + " failed" : "") + (p.cancelled ? ", cancelled" : "") + ")";
  if (p.event === "tick") {
    if (Date.now() - lastProgressFileAt >= 3000) {
      lastProgressFileAt = Date.now();
      try { fs.appendFileSync(LOG_FILE, stamp() + " [panel] " + line + "\n"); } catch (e) {}
    }
  } else {
    log(line);
  }
  drawProgress(p);
}

// ---- UI ----
// Home screen: one app tile per skill (icon.svg on its "tint" colours, in "order").
// Tapping a tile opens that skill's view; < goes back. Views are built once at start so
// inputs, statuses and running state survive switching. One log and one proxy progress
// bar sit under every view; the bar shows in views whose skill.json has "progress": true.
var currentView = null; // skill id, or null on the home screen
var runningSkill = null;
var lastProgress = null;

function setButtons() {
  var bs = document.querySelectorAll("button[data-action]");
  for (var i = 0; i < bs.length; i++) {
    if (bs[i].getAttribute("data-control") !== "1") bs[i].disabled = !!running;
  }
  var tiles = document.querySelectorAll(".tile[data-skill]");
  for (var t = 0; t < tiles.length; t++) {
    var badge = tiles[t].querySelector(".badge");
    if (badge) badge.classList.toggle("hidden", tiles[t].getAttribute("data-skill") !== runningSkill);
  }
}
function setStatus(skill, text) {
  var el = document.querySelector('.status[data-skill="' + skill.id + '"]');
  if (el) el.textContent = text || "";
}

function drawProgress(p) {
  if (p) lastProgress = p;
  p = lastProgress;
  var box = document.getElementById("progress");
  var count = document.getElementById("pcount"), fill = document.getElementById("pfill"), sub = document.getElementById("psub");
  if (!p) {
    count.textContent = "No proxy run yet";
    fill.style.width = "0%";
    sub.textContent = "";
    box.className = "glass";
  } else {
    var pct = p.percent.toFixed(p.percent % 1 ? 1 : 0);
    count.innerHTML = p.event === "none" ? "Nothing to render" :
      "<b>" + p.finished + "</b> of <b>" + p.total + "</b> · <b>" + pct + "%</b>";
    fill.style.width = (p.fraction * 100) + "%";
    var bits = [];
    if (p.running) bits.push(p.running + " rendering");
    if (p.queued) bits.push(p.queued + " queued");
    if (p.failed) bits.push(p.failed + " failed");
    if (p.paused) bits.push("paused");
    if (p.cancelled) bits.push("cancelled");
    if (p.already) bits.push(p.already + " already had proxies");
    sub.textContent = bits.join(" · ");
    box.className = "glass" + (p.failed || p.cancelled ? " failed" : p.fraction >= 1 ? " complete" : "");
  }
  var skill = currentView ? findSkill(currentView) : null;
  if (!(skill && skill.progress)) box.classList.add("hidden");
}

function iconBox(skill, cls) {
  var box = document.createElement("div");
  box.className = cls;
  var t = skill.tint || ["#8e8e93", "#636366"];
  box.style.background = "linear-gradient(160deg, " + t[0] + ", " + (t[1] || t[0]) + ")";
  box.innerHTML = skill.iconSvg || "";
  return box;
}

function showView(id) {
  if (id && !findSkill(id)) id = null;
  currentView = id;
  document.getElementById("home").classList.toggle("hidden", !!id);
  document.getElementById("detail").classList.toggle("hidden", !id);
  var views = document.querySelectorAll(".app[data-skill]");
  for (var i = 0; i < views.length; i++) views[i].classList.toggle("hidden", views[i].getAttribute("data-skill") !== id);
  if (id) {
    var s = findSkill(id);
    document.getElementById("nav-title").textContent = s.name;
    var nav = document.getElementById("nav-icon"), look = iconBox(s, "nav-icon");
    nav.style.background = look.style.background;
    nav.innerHTML = look.innerHTML;
    var log = document.getElementById("log");
    log.scrollTop = log.scrollHeight;
  }
  drawProgress(null);
}

// Glass sheet instead of window.confirm. Resolves true for the OK button.
function sheet(opts) {
  return new Promise(function (resolve) {
    var el = document.getElementById("sheet");
    document.getElementById("sheet-title").textContent = opts.title || "";
    document.getElementById("sheet-text").textContent = opts.text || "";
    var ok = document.getElementById("sheet-ok"), no = document.getElementById("sheet-cancel");
    ok.textContent = opts.ok || "Continue";
    ok.className = "pill " + (opts.okStyle || "primary");
    no.textContent = opts.cancel || "Cancel";
    no.className = "pill " + (opts.cancelStyle || "danger");
    function done(v) { el.classList.add("hidden"); ok.onclick = no.onclick = null; resolve(v); }
    ok.onclick = function () { done(true); };
    no.onclick = function () { done(false); };
    el.classList.remove("hidden");
  });
}

function storeKey(skill, input) { return "penytoolkit." + skill.id + "." + input; }
function remember(skill, input, value) { try { localStorage.setItem(storeKey(skill, input), value); } catch (e) {} }
function recall(skill, input) { try { return localStorage.getItem(storeKey(skill, input)) || ""; } catch (e) { return ""; } }

// The CEP folder picker returns a file:// URL with %-escapes
// ("file:///Volumes/G-SPEED%20Shuttle/..."); turn it into a plain path.
function fileUrlToPath(v) {
  var s = String(v || "");
  if (s.indexOf("file://") !== 0) return s;
  s = s.replace(/^file:\/\/(localhost)?/, "");
  try { s = decodeURIComponent(s); } catch (e) {}
  return s.replace(/\/+$/, "") || "/";
}

function chooseFolder(title, start) {
  try {
    var r = window.cep.fs.showOpenDialog(false, true, title, start || "");
    if (r && r.data && r.data.length) return fileUrlToPath(r.data[0]);
  } catch (e) { log("Folder dialog failed: " + e.message, "err"); }
  return null;
}

// Node's require cache outlives a CEP page reload, so without this a reload keeps
// running the old panel.js/jobs.js. Drop the toolkit's own modules before loading.
function clearToolkitModules() {
  try {
    var req = typeof require !== "undefined" ? require : cep_node.require;
    Object.keys(req.cache).forEach(function (k) { if (k.indexOf(extRoot) === 0) delete req.cache[k]; });
  } catch (e) {}
}

function loadSkills() {
  var dir = path.join(extRoot, "skills");
  fs.readdirSync(dir).sort().forEach(function (n) {
    var file = path.join(dir, n, "skill.json");
    if (!fs.existsSync(file)) return;
    try {
      var s = JSON.parse(fs.readFileSync(file, "utf-8"));
      s.dir = path.join(dir, n);
      if (s.icon) { try { s.iconSvg = fs.readFileSync(path.join(s.dir, s.icon), "utf-8"); } catch (e) {} }
      if (s.panel) {
        var factory = nodeRequire(path.join(s.dir, s.panel));
        s.module = factory({
          evalSkill: function (params) { return evalSkill(s, params); },
          jobs: jobs,
          log: log,
          status: function (text) { setStatus(s, text); },
          progress: showProgress,
          // Run another skill's action directly (used by multi-step skills).
          skillAction: function (skillId, actionId, params) {
            var other = findSkill(skillId);
            if (!other || !other.module || !other.module.actions[actionId]) return Promise.resolve({ ok: false, error: "No action " + skillId + "/" + actionId });
            return Promise.resolve(other.module.actions[actionId](params || {}));
          },
          skillDir: s.dir
        });
      }
      skills.push(s);
    } catch (e) {
      log("Could not load skill " + n + ": " + e.message, "err");
    }
  });
  skills.sort(function (a, b) { return (a.order || 99) - (b.order || 99); });
}

function drawSkills() {
  var tiles = document.getElementById("tiles"), apps = document.getElementById("apps");
  skills.forEach(function (s) {
    if (s.hidden) return; // runs only from another app's button (e.g. make-safe-copy)
    // Home tile
    var tile = document.createElement("button");
    tile.className = "tile";
    tile.setAttribute("data-skill", s.id);
    tile.appendChild(iconBox(s, "icon"));
    var badge = document.createElement("span"); badge.className = "badge hidden"; badge.title = "Running"; tile.appendChild(badge);
    var nm = document.createElement("span"); nm.className = "name"; nm.textContent = s.name; tile.appendChild(nm);
    tile.addEventListener("click", function () { showView(s.id); });
    tiles.appendChild(tile);

    // App view
    var view = document.createElement("div");
    view.className = "app hidden";
    view.setAttribute("data-skill", s.id);
    var card = document.createElement("div");
    card.className = "glass card";
    var p = document.createElement("p"); p.className = "desc"; p.textContent = s.description || ""; card.appendChild(p);

    var toggles = document.createElement("div"); toggles.className = "toggles";
    var getters = {}; // input id -> function returning its value
    (s.inputs || []).forEach(function (inp) {
      if (inp.type === "checkbox") {
        var lab = document.createElement("label"); lab.className = "toggle";
        var tl = document.createElement("span"); tl.className = "tlabel"; tl.textContent = inp.label; lab.appendChild(tl);
        var sw = document.createElement("span"); sw.className = "switch";
        var cb = document.createElement("input"); cb.type = "checkbox"; cb.setAttribute("data-input", inp.id);
        var saved = recall(s, inp.id);
        cb.checked = saved === "" ? !!inp["default"] : saved === "true";
        cb.addEventListener("change", function () { remember(s, inp.id, cb.checked ? "true" : "false"); });
        sw.appendChild(cb);
        var tr = document.createElement("span"); tr.className = "track"; sw.appendChild(tr);
        var kn = document.createElement("span"); kn.className = "knob"; sw.appendChild(kn);
        lab.appendChild(sw);
        toggles.appendChild(lab);
        getters[inp.id] = function () { return cb.checked; };
        return;
      }
      var field = document.createElement("div"); field.className = "field";
      var fl = document.createElement("span"); fl.className = "flabel"; fl.textContent = inp.label; field.appendChild(fl);
      if (inp.type === "segment") {
        // Segmented control; an option with "text": true shows a text box whose value is used.
        var seg = document.createElement("div"); seg.className = "segmented";
        var txt = document.createElement("input"); txt.type = "text";
        var chosen = parseInt(recall(s, inp.id + ".option"), 10) || 0;
        txt.value = recall(s, inp.id + ".text");
        txt.addEventListener("change", function () { remember(s, inp.id + ".text", txt.value); });
        var segButtons = inp.options.map(function (o, i) {
          var b = document.createElement("button");
          b.textContent = o.label;
          b.addEventListener("click", function () { chosen = i; remember(s, inp.id + ".option", String(i)); paint(); });
          seg.appendChild(b);
          return b;
        });
        function paint() {
          segButtons.forEach(function (b, i) { b.className = i === chosen ? "on" : ""; });
          var o = inp.options[chosen] || inp.options[0];
          txt.placeholder = o.placeholder || "";
          txt.classList.toggle("hidden", !o.text);
        }
        if (chosen >= inp.options.length) chosen = 0;
        paint();
        field.appendChild(seg); field.appendChild(txt);
        getters[inp.id] = function () { var o = inp.options[chosen]; return o.text ? txt.value : o.value; };
      } else {
        var row = document.createElement("div"); row.className = "row";
        var input = document.createElement("input"); input.type = "text"; input.setAttribute("data-input", inp.id);
        input.placeholder = inp.placeholder || "";
        input.value = recall(s, inp.id);
        input.addEventListener("change", function () { remember(s, inp.id, input.value); });
        row.appendChild(input);
        if (inp.type === "folder") {
          var fb = document.createElement("button");
          fb.className = "pill secondary small"; fb.textContent = "Choose…";
          fb.addEventListener("click", function () {
            var f = chooseFolder(inp.label, input.value);
            if (f) { input.value = f; remember(s, inp.id, f); }
          });
          row.appendChild(fb);
        }
        field.appendChild(row);
        getters[inp.id] = function () { return input.value; };
      }
      card.appendChild(field);
    });
    if (toggles.children.length) card.appendChild(toggles);

    // Buttons: normal actions first, then the ones that work while a run is going.
    var list = s.actions || [{ id: "run", label: s.name, style: "primary" }];
    var main = document.createElement("div"); main.className = "buttons";
    var ctl = document.createElement("div"); ctl.className = "buttons";
    list.forEach(function (a) {
      var b = document.createElement("button");
      b.textContent = a.label;
      b.className = "pill " + (a.style || (a.control ? "secondary" : "primary"));
      b.setAttribute("data-action", a.id);
      if (a.control) b.setAttribute("data-control", "1");
      b.addEventListener("click", function () { pressAction(s, a, getters); });
      (a.control ? ctl : main).appendChild(b);
    });
    card.appendChild(main);
    if (ctl.children.length) {
      var cl = document.createElement("div"); cl.className = "controls-label"; cl.textContent = "While running";
      card.appendChild(cl); card.appendChild(ctl);
    }
    var st = document.createElement("div"); st.className = "status"; st.setAttribute("data-skill", s.id);
    card.appendChild(st);
    view.appendChild(card);
    apps.appendChild(view);
  });
  document.getElementById("back").addEventListener("click", function () { showView(null); });
}

// A button press: confirm if asked, explain + pick each prompted folder, then run.
function pressAction(s, a, getters) {
  var params = {};
  Object.keys(getters).forEach(function (k) { params[k] = getters[k](); });
  var prompts = a.prompts || [];
  var chain = a.confirm
    ? sheet({ title: a.label + "?", text: a.confirm, ok: a.label, okStyle: a.style === "danger" ? "danger" : "primary", cancel: "Back", cancelStyle: "secondary" })
    : Promise.resolve(true);
  prompts.forEach(function (pr) {
    chain = chain.then(function (go) {
      if (!go) return false;
      // Say what the next window is for before it opens; Cancel stops here.
      var explained = pr.explain ? (function () {
        var lines = pr.explain.split("\n\n");
        return sheet({ title: lines[0], text: lines.slice(1).join("\n\n") + "\n\nClick Continue to open the folder window, or Cancel to stop." });
      }()) : Promise.resolve(true);
      return explained.then(function (ok) {
        if (!ok) { log(s.name + ": cancelled before " + pr.title, "warn"); return false; }
        var picked = chooseFolder(pr.title, "");
        if (!picked) { log(s.name + ": cancelled (" + pr.title + ")", "warn"); return false; }
        params[pr.id] = picked;
        return true;
      });
    });
  });
  chain.then(function (go) { if (go) runAction(s.id, a.id, params, "button"); });
}

// ---- Test hook ----
function pollHook() {
  var current = "";
  try { current = fs.readFileSync(INSTANCE_FILE, "utf-8"); } catch (e) {}
  if (current !== INSTANCE_ID) {
    clearInterval(hookTimer);
    try { fs.appendFileSync(LOG_FILE, stamp() + " [panel] Stale panel instance " + INSTANCE_ID + " stopped polling.\n"); } catch (e2) {}
    return;
  }
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
var startError = null;
(function start() {
  try {
    clearToolkitModules();
    jobs = nodeRequire(path.join(extRoot, "core", "jobs.js"));
    loadSkills();
    drawSkills();
    showView(null);
    try { fs.mkdirSync(HOOK_INBOX, { recursive: true }); } catch (e) {}
    if (!window.PenyLoader) fs.writeFileSync(INSTANCE_FILE, INSTANCE_ID, "utf-8");
    hookTimer = setInterval(pollHook, HOOK_POLL_MS);
    document.getElementById("status").textContent = skills.filter(function (s) { return !s.hidden; }).length + " apps";
    log("T3 soft-reload test line");
    log("Panel open (instance " + INSTANCE_ID + "), " + skills.length + " skills: " + skills.map(function (s) { return s.id; }).join(", "));
  } catch (e) {
    startError = e.message;
    document.getElementById("status").textContent = "Error: " + e.message;
    log("Start failed: " + e.message, "err");
  }
}());

// ---- Soft reload (loader.js) ----
// Busy: an action running, or a skill module saying it still has work (a render pool,
// a child process). loader.js waits while this returns something.
function isBusy() {
  if (running) return running;
  for (var i = 0; i < skills.length; i++) {
    var m = skills[i].module;
    var b = m && typeof m.busy === "function" ? m.busy() : null;
    if (b) return skills[i].id + ": " + b;
  }
  return null;
}

// Undo what this file set up in the page: the hook timer is its only timer; its click
// handlers sit on elements loader.js throws away.
function stop() {
  if (hookTimer) { clearInterval(hookTimer); hookTimer = null; }
  skills = [];
}

window.PenyApp = {
  stop: stop,
  isBusy: isBusy,
  error: startError,
  skillsCount: function () { return skills.length; }
};

}());
