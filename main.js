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
var updates = null; // core/updater.js: release + build-machine updates run from the panel
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

// Set by Ingest + Proxies while it runs a queued job: every skill call then carries
// projectPath, so Ingest and Proxies work on that open project, not the one in front.
var projectTarget = null;

function evalSkill(skill, params) {
  if (projectTarget) {
    var withTarget = {};
    for (var pk in (params || {})) if (params.hasOwnProperty(pk)) withTarget[pk] = params[pk];
    if (withTarget.projectPath === undefined) withTarget.projectPath = projectTarget;
    params = withTarget;
  }
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
  // Pressed again while its own run is going: "queue" names the action that adds a job
  // to that run instead (Ingest + Proxies), so the lock below is left alone.
  var queued = !action.control && running && action.queue && runningSkill === skill.id && skill.module && skill.module.actions[action.queue];
  if (!action.control && !queued && running) {
    return Promise.resolve({ ok: false, skill: skillId, error: running + " is still running." });
  }
  if (params) for (var pk in params) if (params.hasOwnProperty(pk) && typeof params[pk] === "string") params[pk] = fileUrlToPath(params[pk]);
  var label = skill.name + (skill.actions ? " > " + action.label : "");
  var locks = !action.control && !queued;
  var startedAt = Date.now();
  if (locks) { running = label; runningSkill = skill.id; runningAction = action.id; startRunTimer(skill, action); setButtons(); }
  log((queued ? "Queue " : "Run ") + label + " (" + source + ") " + JSON.stringify(params || {}), "warn");

  var p;
  try {
    if (queued) {
      p = skill.module.actions[action.queue](params || {});
    } else if (action.skill) {
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
    if (locks) { running = null; runningSkill = null; runningAction = null; finishRunTimer(skill, result); setButtons(); }
    log((result.ok ? "OK  " : "FAIL ") + label + ": " + (result.ok ? result.summary : result.error), result.ok ? "ok" : "err");
    var d = result.details || {};
    ["failed", "skipped"].forEach(function (k) {
      (d[k] || []).slice(0, 30).forEach(function (r) {
        log("  " + k + ": " + (r.time ? r.time + " " : "") + (r.bin ? r.bin + "/" : "") + (r.name || r.nodeId || "") + " - " + r.reason, "warn");
      });
    });
    setStatus(skill, result.ok ? result.summary : result.error);
    addHistory({ t: startedAt, ms: Date.now() - startedAt, skill: skill.id, app: skill.name, action: skill.actions ? action.label : "",
      ok: !!result.ok, text: String((result.ok ? result.summary : result.error) || ""), source: source });
    return result;
  });
}

// ---- Progress ----
// Each skill reports through api.progress: proxies from the render pool (core/jobs.js:
// real job starts/exits plus each render's own fraction), Colour from its steps
// (core/steps.js, unit "steps"). tasks[skill id] keeps the latest report of each.
// Start/finish events go to the log; ticks are written to the log file at most every 3 s.
var lastProgressFileAt = 0;
var tasks = {};
function progressText(p) {
  if (p.event === "none") return "Nothing to render" + (p.already ? " (" + p.already + " already have proxies)" : "");
  return p.finished + " of " + p.total + " " + (p.unit || "proxies") + " done · " + p.percent.toFixed(p.percent % 1 ? 1 : 0) + "%";
}
// Time left as text, as close as the estimate allows: to 5 s under 90 s, to 10 s under
// 10 min, then minutes. "" for null.
function leftText(sec) {
  if (sec === null || sec === undefined || !isFinite(sec)) return "";
  if (sec < 5) return "A few seconds left";
  if (sec < 90) return "About " + Math.round(sec / 5) * 5 + " s left";
  if (sec < 600) {
    var r = Math.round(sec / 10) * 10, m = Math.floor(r / 60), x = r % 60;
    return "About " + m + " min" + (x ? " " + x + " s" : "") + " left";
  }
  var mm = Math.round(sec / 60);
  if (mm < 60) return "About " + mm + " min left";
  return "About " + Math.floor(mm / 60) + " h" + (mm % 60 ? " " + mm % 60 + " min" : "") + " left";
}
// Clock time the run should finish ("13:05"), from the smoothed finish time.
function doneByText(e) {
  if (!e || !e.finishAt || e.seconds < 60) return "";
  var d = new Date(e.finishAt);
  return "done by " + ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
}
// "About 3 min 20 s left · done by 13:05 (8 of 30 done)"; empty when over or cancelled.
function etaText(p) {
  var e = p && p.eta;
  if (!e || p.event === "none" || p.event === "finished") return "";
  var done = p.timer ? "" : " (" + p.finished + " of " + p.total + " done)";
  if (e.state === "paused") return "Paused" + done;
  if (e.state === "estimating") return "Estimating time left…" + done;
  if (e.state !== "ok") return "";
  var by = doneByText(e);
  return leftText(e.seconds) + (by ? " · " + by : "") + done;
}
function showProgress(p, skill) {
  if (!p) return;
  if (!p.timer && runTimer && skill && runTimer.skill === skill.id) stopRunTimer(false);
  p.skillId = skill ? skill.id : "proxy-automation";
  p.updatedAt = Date.now();
  tasks[p.skillId] = p;
  var eta = etaText(p);
  var line = (p.title || "Proxy") + " progress: " + progressText(p) + (eta ? " · " + eta : "") +
    (p.eta && p.eta.state === "ok" ? " [eta " + p.eta.seconds + " s, raw " + p.eta.raw + " s]" : "") + " (" + p.event + ", " + p.running + " running" +
    (p.failed ? ", " + p.failed + " failed" : "") + (p.cancelled ? ", cancelled" : "") + ")";
  if (p.event === "tick") {
    if (Date.now() - lastProgressFileAt >= 3000) {
      lastProgressFileAt = Date.now();
      try { fs.appendFileSync(LOG_FILE, stamp() + " [panel] " + line + "\n"); } catch (e) {}
    }
  } else {
    log(line);
  }
  drawProgress();
  drawJobs();
}

// ---- Jobs in progress ----
// Dock at the bottom of every screen while anything runs: one card per task (which app,
// x of y, overall bar, time left), with a small bar per clip rendering (or the step
// running) and its own time left. The header minimises it to one line; the choice is
// remembered. A finished task stays 10 s, then goes; the dock hides when none are left.
var JOB_KEEP_MS = 10000;
function jobsMinimised() { try { return localStorage.getItem("penytoolkit.jobs.min") === "1"; } catch (e) { return false; } }
function clipName(label) { return String(label || "").split("/").pop().replace(/\.(r3d|mp4|mxf|mov|braw|crm)$/i, ""); }
function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
// The dock sits in the page's flow under the work area (index.html), so views need no padding;
// it also refreshes the header chip and the home rows' states.
function padViews() { drawStates(); }
function taskOver(p) {
  return p.event === "finished" || p.event === "cancelled" || (p.eta && (p.eta.state === "done" || p.eta.state === "cancelled"));
}
var jobsTimer = null;
function drawJobs() {
  var dock = document.getElementById("jobs"), now = Date.now();
  var list = Object.keys(tasks).map(function (k) { return tasks[k]; }).filter(function (p) {
    return p.event !== "none" && (!taskOver(p) || now - p.updatedAt < JOB_KEEP_MS);
  });
  clearTimeout(jobsTimer);
  if (list.some(taskOver)) jobsTimer = setTimeout(drawJobs, 1000);
  if (!list.length) { dock.classList.add("hidden"); padViews(); return; }
  var running = 0, longest = null, h = "";
  list.forEach(function (p) {
    var over = taskOver(p), e = p.eta || {};
    // A proxy run started by another app (Ingest + proxies) carries that app's name.
    var host = runningSkill && runningSkill !== p.skillId && !tasks[runningSkill] ? findSkill(runningSkill) : null;
    var skill = p.skillId === "proxy-automation" && host && host.progress ? host : findSkill(p.skillId);
    var title = p.title || (skill ? skill.name : "Proxies");
    var pct = p.timer && !over && e.state === "estimating" ? "–" : p.percent.toFixed(p.percent % 1 ? 1 : 0) + "%";
    var left = over ? (p.cancelled ? "Cancelled" : p.failed ? (p.unit === "steps" ? "Stopped with an error" : p.failed + " failed") : "Finished") :
      e.state === "paused" ? "Paused" : e.state === "estimating" ? "Estimating time left…" : e.state === "ok" ? leftText(e.seconds) : "";
    if (!over) { running += p.unit === "steps" ? 1 : p.running; if (e.state === "ok" && (longest === null || e.seconds > longest)) longest = e.seconds; }
    var by = !over && e.state === "ok" ? doneByText(e) : "";
    h += '<div class="jtask' + (over && (p.failed || p.cancelled) ? " failed" : "") + (over ? "" : " running") + '"><div class="jrow"><span class="jname">' + esc(title) +
      '</span><span class="jval">' + (p.timer ? "" : p.finished + " of " + p.total + (p.unit === "steps" ? " steps" : "") + " · ") + pct +
      '</span></div><div class="bar"><div class="fill" style="width:' + (p.fraction * 100).toFixed(1) + '%"></div></div><div class="jeta">' +
      esc(left + (by ? " · " + by : "")) + "</div>";
    if (!over) (e.jobs || []).forEach(function (j) {
      var jl = j.seconds === null || j.seconds === undefined ? "Estimating…" : leftText(j.seconds);
      h += '<div class="jclip"><div class="jrow"><span class="jname">' + esc(clipName(j.label)) + '</span><span class="jval">' +
        Math.floor(j.fraction * 100) + "% · " + esc(jl) + '</span></div><div class="bar"><div class="fill" style="width:' +
        (j.fraction * 100).toFixed(1) + '%"></div></div></div>';
    });
    var more = [];
    if (!over && p.queued && p.unit !== "steps") more.push(p.queued + " queued");
    if (p.already) more.push(p.already + " already had proxies");
    if (more.length) h += '<div class="jmore">' + esc(more.join(" · ")) + "</div>";
    h += "</div>";
  });
  document.getElementById("jobs-sum").textContent = running ? running + " running" + (longest !== null ? " · " + leftText(longest) : "") :
    list.length + " finished";
  document.getElementById("jobs-body").innerHTML = h;
  dock.className = "glass" + (jobsMinimised() ? " min" : "");
  padViews();
}
function initJobsDock() {
  window.addEventListener("resize", padViews);
  document.getElementById("jobs-head").addEventListener("click", function () {
    var dock = document.getElementById("jobs"), min = !dock.classList.contains("min");
    dock.classList.toggle("min", min);
    try { localStorage.setItem("penytoolkit.jobs.min", min ? "1" : "0"); } catch (e) {}
    padViews();
  });
}

// ---- UI ----
// Home screen: one app tile per skill (icon.svg on its "tint" colours, in "order").
// Tapping a tile opens that skill's view; < goes back. Views are built once at start so
// inputs, statuses and running state survive switching. One log and one proxy progress
// bar sit under every view; the bar shows in views whose skill.json has "progress": true.
var currentView = null; // skill id, or null on the home screen
var runningSkill = null;
var runningAction = null;
var currentApp = null; // an "apps" tile's id inside the current view, or null on its dashboard
var lastView = null; // the app last opened, focused again on the way home

function setButtons() {
  var bs = document.querySelectorAll("button[data-action]");
  for (var i = 0; i < bs.length; i++) {
    // A "queue" action stays usable while its own skill runs: pressing it adds a job.
    var queues = bs[i].getAttribute("data-queue-skill");
    if (bs[i].getAttribute("data-control") !== "1") bs[i].disabled = !!running && !(queues && queues === runningSkill);
  }
  var tiles = document.querySelectorAll(".tile[data-skill]");
  for (var t = 0; t < tiles.length; t++) {
    var badge = tiles[t].querySelector(".badge");
    if (badge) badge.classList.toggle("hidden", tiles[t].getAttribute("data-skill") !== runningSkill);
  }
  drawAppTiles();
  drawStates();
}
function setStatus(skill, text) {
  var el = document.querySelector('.status[data-skill="' + skill.id + '"]');
  if (el) el.textContent = text || "";
}

// The bar in an app's view: that app's own task, else (Ingest + proxies) the proxy run.
function viewTask(skill) {
  if (!skill) return null;
  return tasks[skill.id] || (proxyView(skill) ? tasks["proxy-automation"] : null) || null;
}
// Proxies and Ingest + proxies show the proxy run; every other app only its own task.
function proxyView(skill) { return !!skill && (skill.id === "proxy-automation" || skill.id === "ingest-pipeline");
}
function drawProgress() {
  var skill = currentView ? findSkill(currentView) : null;
  var p = viewTask(skill);
  var box = document.getElementById("progress");
  box.querySelector(".ptitle").textContent = p && p.title ? p.title : skill && !proxyView(skill) ? skill.name : "Proxies";
  var count = document.getElementById("pcount"), fill = document.getElementById("pfill"), sub = document.getElementById("psub");
  if (!p) {
    count.textContent = skill && !proxyView(skill) ? "Not run yet" : "No proxy run yet";
    fill.style.width = "0%";
    document.getElementById("peta").textContent = "";
    sub.textContent = "";
    box.className = "glass";
  } else {
    var pct = p.percent.toFixed(p.percent % 1 ? 1 : 0);
    count.innerHTML = p.event === "none" ? "Nothing to render" : p.timer ? "<b>" + (p.eta && p.eta.state === "estimating" && !taskOver(p) ? "–" : pct + "%") + "</b>" :
      "<b>" + p.finished + "</b> of <b>" + p.total + "</b> · <b>" + pct + "%</b>";
    fill.style.width = (p.fraction * 100) + "%";
    document.getElementById("peta").textContent = etaText(p);
    var bits = [];
    if (p.unit === "steps") { if (p.running && p.eta && p.eta.jobs && p.eta.jobs[0]) bits.push(p.eta.jobs[0].label + "…"); }
    else if (p.running) bits.push(p.running + " rendering");
    if (p.queued && p.unit !== "steps") bits.push(p.queued + " queued");
    if (p.failed) bits.push(p.failed + " failed");
    if (p.paused) bits.push("paused");
    if (p.cancelled) bits.push("cancelled");
    if (p.already) bits.push(p.already + " already had proxies");
    sub.textContent = bits.join(" · ");
    box.className = "glass" + (p.failed || p.cancelled ? " failed" : p.fraction >= 1 ? " complete" : "");
  }
  if (p && p.event !== "none" && !taskOver(p)) box.classList.add("running");
  // Apps with their own progress always show the bar; the rest once a run has one.
  if (!skill || !(skill.progress || p)) box.classList.add("hidden");
}

function iconBox(skill, cls) {
  // Every icon is the same black Peny square (index.html); "tint" in skill.json is ignored so no
  // app drifts into its own colour (Lee, 30 Oct 2026).
  var box = document.createElement("div");
  box.className = cls;
  box.innerHTML = skill.iconSvg || "";
  return box;
}

// An app with "apps" in skill.json opens a mini dashboard of tiles, one per job; each tile opens
// its own view (Lee, 30 Oct 2026: nothing suggests one job must come before another).
function drawAppTiles() {
  [].forEach.call(document.querySelectorAll(".subtile"), function (t) {
    var on = t.getAttribute("data-owner") === runningSkill && (t.getAttribute("data-actions") || "").split(",").indexOf(runningAction) >= 0;
    t.querySelector(".badge").classList.toggle("hidden", !on);
  });
  [].forEach.call(document.querySelectorAll(".runbox"), function (b) { b.classList.toggle("hidden", b.getAttribute("data-owner") !== runningSkill); });
}
function setNav(look) {
  document.getElementById("nav-title").textContent = look.name;
  document.getElementById("nav-icon").innerHTML = "";
}
function showApp(skill, appId) {
  currentApp = appId || null;
  var view = document.querySelector('.app[data-skill="' + skill.id + '"]');
  view.querySelector(".subtiles").classList.toggle("hidden", !!currentApp);
  [].forEach.call(view.querySelectorAll(".subview"), function (v) { v.classList.toggle("hidden", v.getAttribute("data-app") !== currentApp); });
  var app = (skill.apps || []).filter(function (a) { return a.id === currentApp; })[0];
  setNav(app || skill);
  document.getElementById("back").title = app ? skill.name : "Home";
  document.getElementById("detail").scrollTop = 0;
}
function showView(id) {
  if (id && !findSkill(id)) id = null;
  currentView = id;
  currentApp = null;
  document.getElementById("back").title = "Home";
  document.body.setAttribute("data-view", id ? "detail" : "home");
  document.body.classList.remove("pane-home");
  document.getElementById("home").classList.toggle("hidden", !!id);
  document.getElementById("detail").classList.toggle("hidden", !id);
  var views = document.querySelectorAll(".app[data-skill]");
  for (var i = 0; i < views.length; i++) views[i].classList.toggle("hidden", views[i].getAttribute("data-skill") !== id);
  if (id) {
    var s = findSkill(id);
    setNav(s);
    if (s.apps) showApp(s, null);
    var log = document.getElementById("log");
    log.scrollTop = log.scrollHeight;
  } else {
    var back = document.querySelector('.tile[data-skill="' + lastView + '"]');
    if (back) back.focus();
  }
  if (id) lastView = id;
  drawProgress();
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
    ok.title = "Enter"; no.title = "Esc";
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
      (s.apps || []).forEach(function (a) { if (a.icon) { try { a.iconSvg = fs.readFileSync(path.join(s.dir, a.icon), "utf-8"); } catch (e) {} } });
      if (s.panel) {
        var factory = nodeRequire(path.join(s.dir, s.panel));
        s.module = factory({
          evalSkill: function (params) { return evalSkill(s, params); },
          jobs: jobs,
          log: log,
          status: function (text) { setStatus(s, text); },
          progress: function (p) { showProgress(p, s); },
          // Run another skill's action directly (used by multi-step skills).
          skillAction: function (skillId, actionId, params) {
            var other = findSkill(skillId);
            if (!other || !other.module || !other.module.actions[actionId]) return Promise.resolve({ ok: false, error: "No action " + skillId + "/" + actionId });
            return Promise.resolve(other.module.actions[actionId](params || {}));
          },
          // Ingest + Proxies job queue: the project every skill call works on (null = the one in front).
          setProjectTarget: function (p) { projectTarget = p || null; },
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
  // Keys: one listener per page (a soft reload swaps it, not adds one). See onKey().
  if (window.PenyInfoEsc) document.removeEventListener("keydown", window.PenyInfoEsc);
  window.PenyInfoEsc = onKey;
  document.addEventListener("keydown", window.PenyInfoEsc);
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
    // List rows: first sentence of the how-to, the app's state, its number key.
    var sb = document.createElement("span"); sb.className = "sub"; sb.textContent = s.subtitle || firstSentence(s.description); tile.appendChild(sb);
    var sta = document.createElement("span"); sta.className = "state"; tile.appendChild(sta);
    var n = tiles.children.length + 1;
    if (n <= 9) { var kb = document.createElement("kbd"); kb.textContent = n; tile.appendChild(kb); }
    tile.title = s.name + (n <= 9 ? " (" + n + ")" : "");
    tile.addEventListener("click", function () { flipOpen(tile, function () { showView(s.id); }); });
    tiles.appendChild(tile);

    // App view
    var view = document.createElement("div");
    view.className = "app hidden";
    view.setAttribute("data-skill", s.id);
    var card = document.createElement("div");
    card.className = "glass card";
    // How-to text sits behind an "i" (Lee, 29 Oct 2026). With "apps" each app's view has its own.
    if (!s.apps && s.description) infoBlock(card, null, s.description);

    var getters = {}; // input id -> function returning its value
    function drawInput(inp, card, toggles) {
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
        // The same input in two "apps" views stays one value.
        input.addEventListener("input", function () {
          [].forEach.call(view.querySelectorAll('input[data-input="' + inp.id + '"]'), function (o) { if (o !== input) o.value = input.value; });
        });
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
    }

    // Buttons: normal actions first, then the ones that work while a run is going (control
    // buttons, e.g. Cancel). "apps" in skill.json split an app into tiles, each with its own view
    // holding only its inputs and buttons; "inputs"/"actions" name them. Getters hold every input.
    var all = s.actions || [{ id: "run", label: s.name, style: "primary" }];
    var ctl = document.createElement("div"); ctl.className = "buttons";
    function drawGroup(box, inputIds, actionIds) {
      var toggles = document.createElement("div"); toggles.className = "toggles";
      (s.inputs || []).forEach(function (inp) { if (!inputIds || inputIds.indexOf(inp.id) >= 0) drawInput(inp, box, toggles); });
      if (toggles.children.length) box.appendChild(toggles);
      var main = document.createElement("div"); main.className = "buttons";
      all.forEach(function (a) {
        if (a.control || (actionIds && actionIds.indexOf(a.id) < 0)) return;
        main.appendChild(actionButton(a));
      });
      if (main.children.length) box.appendChild(main);
    }
    function actionButton(a) {
      var b = document.createElement("button");
      b.textContent = a.label;
      b.className = "pill " + (a.style || (a.control ? "secondary" : "primary"));
      b.setAttribute("data-action", a.id);
      if (a.control) b.setAttribute("data-control", "1");
      if (a.queue) b.setAttribute("data-queue-skill", s.id);
      b.addEventListener("click", function () { pressAction(s, a, getters); });
      return b;
    }
    if (s.apps) {
      var dash = document.createElement("div"); dash.className = "glass subtiles";
      s.apps.forEach(function (ap, ai) {
        var t = document.createElement("button"); t.className = "tile subtile";
        t.setAttribute("data-app", ap.id); t.setAttribute("data-owner", s.id); t.setAttribute("data-actions", (ap.actions || []).join(","));
        t.appendChild(iconBox(ap, "icon"));
        var bd = document.createElement("span"); bd.className = "badge hidden"; bd.title = "Running"; t.appendChild(bd);
        var n = document.createElement("span"); n.className = "name"; n.textContent = ap.name; t.appendChild(n);
        var su = document.createElement("span"); su.className = "sub"; su.textContent = ap.subtitle || ""; t.appendChild(su);
        if (ai < 9) { var kb2 = document.createElement("kbd"); kb2.textContent = ai + 1; t.appendChild(kb2); t.title = ap.name + " (" + (ai + 1) + ")"; }
        t.addEventListener("click", function () { flipOpen(t, function () { showApp(s, ap.id); }); });
        dash.appendChild(t);
        var sv = document.createElement("div"); sv.className = "glass card subview hidden"; sv.setAttribute("data-app", ap.id);
        if (ap.description) infoBlock(sv, null, ap.description);
        if (ap.needs) { var nd = document.createElement("p"); nd.className = "needs"; nd.textContent = ap.needs; sv.appendChild(nd); }
        drawGroup(sv, ap.inputs || [], ap.actions || []);
        view.appendChild(sv);
      });
      view.insertBefore(dash, view.firstChild);
      // An input no tile uses still gets its getter (every action gets every input).
      var spare = document.createElement("div"); spare.className = "hidden";
      (s.inputs || []).forEach(function (inp) { if (!getters[inp.id]) drawInput(inp, spare, spare); });
      view.appendChild(spare);
      // Status and the control buttons sit under every view; controls show while this app runs.
      card.className = "runcard";
      var rb = document.createElement("div"); rb.className = "runbox hidden"; rb.setAttribute("data-owner", s.id);
      var rl = document.createElement("div"); rl.className = "controls-label"; rl.textContent = "While running"; rb.appendChild(rl);
      var rbb = document.createElement("div"); rbb.className = "buttons";
      all.forEach(function (a) { if (a.control) rbb.appendChild(actionButton(a)); });
      rb.appendChild(rbb);
      card.appendChild(rb);
    } else {
      drawGroup(card, null, null);
      all.forEach(function (a) { if (a.control) ctl.appendChild(actionButton(a)); });
    }
    if (ctl.children.length) {
      var cl = document.createElement("div"); cl.className = "controls-label"; cl.textContent = "While running";
      card.appendChild(cl); card.appendChild(ctl);
    }
    // A skill module can draw its own controls under the buttons (e.g. Colour's camera list).
    if (s.module && typeof s.module.mount === "function") {
      var slot = document.createElement("div"); slot.className = "skill-slot";
      card.appendChild(slot);
      try { s.module.mount(slot); } catch (eM) { log("Could not draw " + s.id + ": " + eM.message, "err"); }
    }
    var st = document.createElement("div"); st.className = "status"; st.setAttribute("data-skill", s.id);
    card.appendChild(st);
    view.appendChild(card);
    apps.appendChild(view);
  });
  document.getElementById("back").addEventListener("click", goBack);
  document.getElementById("home-title").addEventListener("click", goHome);
  document.getElementById("logo").addEventListener("click", goHome);
  document.getElementById("homebar").addEventListener("click", goHome);
}
function goBack() {
  if (currentApp) { var app = currentApp, sk = findSkill(currentView); flipClose(function () { showApp(sk, null); }, function () { return document.querySelector('.app[data-skill="' + sk.id + '"] .subtile[data-app="' + app + '"]'); }); }
  else if (currentView) { var id = currentView; flipClose(function () { showView(null); }, function () { return document.querySelector('#tiles .tile[data-skill="' + id + '"]'); }); }
}
function goHome() {
  if (!currentView) return;
  var id = currentView;
  flipClose(function () { showView(null); }, function () { return document.querySelector('#tiles .tile[data-skill="' + id + '"]'); });
}

// ---- Opening and closing an app like an iPhone (FLIP: First, Last, Invert, Play) ----
// First: the tapped icon's box. Last: the whole work pane. A "ghost" squircle the colour of the
// icon is laid out once at the Last box, then Inverted with a transform so it sits exactly on
// the icon, and Played back to no transform, so it grows out of the icon. Under it the old
// screen sinks (scale 0.92, fades) and the new one fades in. Closing runs the same in reverse
// onto the app's icon. Only transform and opacity animate (no width/height/top/left), with
// Apple's curve cubic-bezier(0.32, 0.72, 0, 1). Motion off (M, Compact style, macOS reduced
// motion): the switch is instant. A tap during an animation finishes it first.
var FLIP_MS = 420;
var flipRun = null;
function motionOn() {
  if (document.body.getAttribute("data-motion") !== "on") return false;
  try { if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false; } catch (e) {}
  return typeof document.body.animate === "function";
}
function flipEnd() { if (flipRun) flipRun(); }
function visibleView() { return currentView ? document.getElementById("detail") : document.getElementById("home"); }
function makeGhost(iconEl, to) {
  var g = document.createElement("div");
  g.className = "flip-ghost";
  g.style.left = to.left + "px"; g.style.top = to.top + "px"; g.style.width = to.width + "px"; g.style.height = to.height + "px";
  var ir = iconEl.getBoundingClientRect();
  // The radius is fixed in the Last box's pixels: 22.5% of the icon there, so at icon size it
  // reads as the icon's squircle and grows with it.
  g.style.borderRadius = (ir.width * 0.225 * Math.max(to.width / ir.width, 1)) + "px / " + (ir.height * 0.225 * Math.max(to.height / ir.height, 1)) + "px";
  var svg = iconEl.querySelector("svg");
  if (svg) {
    var c = svg.cloneNode(true), sw = svg.getBoundingClientRect();
    c.style.width = sw.width * to.width / ir.width + "px"; c.style.height = sw.height * to.height / ir.height + "px";
    g.appendChild(c);
  }
  document.body.appendChild(g);
  return g;
}
function invertOf(from, to) {
  return "translate(" + (from.left - to.left) + "px," + (from.top - to.top) + "px) scale(" + (from.width / to.width) + "," + (from.height / to.height) + ")";
}
function flipOpen(tileEl, change) {
  flipEnd();
  var iconEl = tileEl && tileEl.querySelector(".icon");
  if (!motionOn() || !iconEl) { change(); return; }
  var first = iconEl.getBoundingClientRect();
  var oldV = visibleView();
  document.body.classList.add("flipping");
  change();
  var newV = visibleView();
  if (oldV !== newV) oldV.classList.add("flip-keep");
  // Last: the pane as the app shows it (the Log pane may have joined and made it shorter).
  var last = document.getElementById("main").getBoundingClientRect();
  var ghost = makeGhost(iconEl, last);
  var opt = { duration: FLIP_MS, easing: "cubic-bezier(0.32, 0.72, 0, 1)", fill: "both" };
  var anims = [
    // Scaling also stretches the corners, so the ghost is gone (fades 45%-80%) before it is
    // full size; the app fading in underneath takes over.
    ghost.animate([{ transform: invertOf(first, last), opacity: 1, offset: 0 }, { opacity: 1, offset: 0.45 }, { opacity: 0, offset: 0.8 }, { transform: "none", opacity: 0, offset: 1 }], opt),
    ghost.firstChild ? ghost.firstChild.animate([{ opacity: 1 }, { opacity: 0, offset: 0.35 }, { opacity: 0 }], opt) : null,
    oldV !== newV ? oldV.animate([{ transform: "scale(1)", opacity: 1 }, { transform: "scale(0.92)", opacity: 0 }], opt) : null,
    newV.animate([{ transform: "scale(0.96)", opacity: 0 }, { transform: "scale(0.96)", opacity: 0, offset: 0.4 }, { transform: "none", opacity: 1 }], opt)
  ].filter(Boolean);
  runFlip(anims, [ghost], [oldV, newV], oldV);
}
function flipClose(change, findIcon) {
  flipEnd();
  if (!motionOn()) { change(); return; }
  var oldV = visibleView();
  var last = document.getElementById("main").getBoundingClientRect();
  document.body.classList.add("flipping");
  change();
  var newV = visibleView();
  var tileEl = findIcon(), iconEl = tileEl && tileEl.querySelector(".icon");
  if (!iconEl || !iconEl.getBoundingClientRect().width) { document.body.classList.remove("flipping"); return; }
  if (tileEl.scrollIntoView) tileEl.scrollIntoView({ block: "nearest" });
  var first = iconEl.getBoundingClientRect();
  var ghost = makeGhost(iconEl, last);
  if (oldV !== newV) oldV.classList.add("flip-keep");
  var opt = { duration: FLIP_MS, easing: "cubic-bezier(0.32, 0.72, 0, 1)", fill: "both" };
  var anims = [
    ghost.animate([{ transform: "none", opacity: 0, offset: 0 }, { opacity: 0, offset: 0.1 }, { opacity: 1, offset: 0.35 }, { transform: invertOf(first, last), opacity: 1, offset: 0.9 }, { transform: invertOf(first, last), opacity: 0, offset: 1 }], opt),
    ghost.firstChild ? ghost.firstChild.animate([{ opacity: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1 }], opt) : null,
    oldV !== newV ? oldV.animate([{ opacity: 1 }, { opacity: 0, offset: 0.25 }, { opacity: 0 }], opt) : null,
    newV.animate([{ transform: oldV !== newV ? "scale(0.92)" : "scale(0.98)", opacity: 0 }, { transform: "none", opacity: 1 }], opt)
  ].filter(Boolean);
  runFlip(anims, [ghost], [oldV, newV], oldV);
}
// Plays the animations; when they end (or flipEnd() is called) cleans up: ghost removed,
// kept-visible view released, transforms dropped.
function runFlip(anims, ghosts, layers, kept) {
  var done = false;
  function finish() {
    if (done) return; done = true; flipRun = null;
    anims.forEach(function (a) { try { a.cancel(); } catch (e) {} });
    ghosts.forEach(function (g) { if (g.parentNode) g.parentNode.removeChild(g); });
    kept.classList.remove("flip-keep");
    document.body.classList.remove("flipping");
  }
  flipRun = finish;
  Promise.all(anims.map(function (a) { return a.finished; })).then(finish, finish);
  setTimeout(finish, FLIP_MS + 300); // never leave a ghost behind
}
function firstSentence(t) { var m = /^[^.]*[.]/.exec(String(t || "")); return m ? m[0] : String(t || ""); }

// A header row (title, or none for a slim row) with an "i" that opens the how-to text under it.
function infoBlock(parent, title, text) {
  var head = document.createElement("div"); head.className = "info-head" + (title === null ? " slim" : "");
  if (title !== null) { var h = document.createElement("div"); h.className = "section-title"; h.textContent = title; head.appendChild(h); }
  parent.appendChild(head);
  if (!text) return;
  var btn = document.createElement("button"); btn.className = "info-btn"; btn.title = "How to";
  btn.setAttribute("aria-label", "How to" + (title ? ": " + title : "")); btn.setAttribute("aria-expanded", "false");
  btn.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="2.3" r="1.25" fill="currentColor"/>' +
    '<rect x="5" y="4.6" width="2" height="6" rx="1" fill="currentColor"/></svg>';
  head.appendChild(btn);
  var body = document.createElement("div"); body.className = "info-body";
  var p = document.createElement("p"); p.className = "desc"; p.textContent = text; body.appendChild(p);
  parent.appendChild(body);
  btn.addEventListener("click", function () { setInfo(btn, body, btn.getAttribute("aria-expanded") !== "true"); });
}
function setInfo(btn, body, open) {
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  body.classList.toggle("open", open);
}
function closeInfo() {
  [].forEach.call(document.querySelectorAll(".info-btn[aria-expanded=true]"), function (b) {
    setInfo(b, b.parentNode.nextSibling, false);
  });
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

// ---- Run timer: a bar and time left for every run ----
// Apps that report their own progress (Proxies, Ingest + proxies, Colour, Sound Pass, Master
// for YouTube, Selects) keep it: the first report they send stops this timer. Every other
// run gets this one: the bar moves by how long the same app + button took before (median of
// the last 5 good runs in the History), held under 95% until the run ends. With no earlier
// run there is no estimate: the bar shows elapsed time only and says it is learning.
var runTimer = null;
function pastSeconds(skillId, actionLabel) {
  var t = history.filter(function (h) { return h.ok && h.skill === skillId && (h.action || "") === (actionLabel || "") && h.ms > 0; })
    .slice(0, 5).map(function (h) { return h.ms / 1000; }).sort(function (a, b) { return a - b; });
  return t.length ? t[Math.floor(t.length / 2)] : null;
}
function clockText(sec) { sec = Math.max(0, Math.round(sec)); var m = Math.floor(sec / 60), x = sec % 60; return m + ":" + (x < 10 ? "0" : "") + x; }
function runTimerReport(event) {
  var r = runTimer; if (!r) return;
  var el = (Date.now() - r.at) / 1000, exp = r.expected;
  var over = event === "finished" || event === "cancelled";
  var frac = over ? 1 : exp ? Math.min(el / exp, 0.95) : 0;
  var left = exp ? Math.max(exp - el, 0) : null;
  var label = (r.label ? r.label + " · " : "") + clockText(el) + " elapsed" +
    (!exp ? " · first run, learning its time" : el > exp ? " · longer than usual (" + clockText(exp) + ")" : "");
  var eta = over ? { state: event === "cancelled" ? "cancelled" : "done", jobs: [] } :
    exp && el <= exp ? { state: "ok", seconds: Math.round(left), finishAt: r.at + exp * 1000, jobs: [{ label: label, fraction: frac, seconds: Math.round(left) }] } :
    { state: "estimating", jobs: [{ label: label, fraction: frac, seconds: null }] };
  showProgress({ timer: true, title: r.title, unit: "steps", total: 1, finished: over ? 1 : 0, ok: over && !r.failed ? 1 : 0, failed: r.failed ? 1 : 0,
    running: over ? 0 : 1, queued: 0, fraction: frac, percent: frac * 100, event: event, eta: eta }, findSkill(r.skill));
}
function startRunTimer(skill, action) {
  stopRunTimer(false);
  var label = skill.actions ? action.label : "";
  runTimer = { skill: skill.id, title: skill.name + (label ? " · " + label : ""), label: label, at: Date.now(), expected: pastSeconds(skill.id, label) };
  runTimer.tick = setInterval(function () { runTimerReport("tick"); }, 1000);
  runTimerReport("job-start");
}
function stopRunTimer(report) {
  if (!runTimer) return;
  clearInterval(runTimer.tick);
  if (report) runTimerReport(report);
  runTimer = null;
}
function finishRunTimer(skill, result) {
  if (!runTimer || runTimer.skill !== skill.id) return;
  runTimer.failed = !result.ok;
  clearInterval(runTimer.tick);
  runTimerReport(/cancel/i.test(result.error || "") ? "cancelled" : "finished");
  runTimer = null;
}

// ---- History: every run, newest first, kept in ~/.peny-toolkit/history.json ----
// Shows what ran, when, how long and what it said, so a run can be checked and undone in
// Premiere (Edit > Undo, or Window > History). The toolkit itself does not undo.
var HISTORY_FILE = path.join(os.homedir(), ".peny-toolkit", "history.json");
var history = [];
function loadHistory() {
  try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8")) || []; } catch (e) { history = historyFromLog(); }
  drawHistory();
}
// First start with no history file: rebuild it from the log's "Run <app> > <button> (source)"
// and "OK  / FAIL <app> > <button>: ..." lines (last 4 MB), so time-left estimates start from
// real past runs.
function historyFromLog() {
  var out = [], text = "";
  try {
    var size = fs.statSync(LOG_FILE).size, len = Math.min(size, 4 * 1024 * 1024), fd = fs.openSync(LOG_FILE, "r");
    var buf = nodeRequire("buffer").Buffer.alloc(len); fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd); text = buf.toString("utf-8");
  } catch (e) { return out; }
  var open = {}, re = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\.(\d{3}) \[panel\] (Run|OK|FAIL) +(.+)$/;
  text.split("\n").forEach(function (line) {
    if (line.indexOf("[panel] Panel open") > 0) { open = {}; return; } // nothing runs across a (re)start
    var m = re.exec(line); if (!m) return;
    var t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]).getTime(), rest = m[9];
    if (m[8] === "Run") {
      var r = /^(.+?) \(([^)]*)\) [{\[]/.exec(rest); if (r) open[r[1]] = { t: t, source: r[2] };
      return;
    }
    var c = rest.indexOf(": "), label = c >= 0 ? rest.slice(0, c) : rest, st = open[label];
    if (!st) return;
    delete open[label];
    var gt = label.indexOf(" > "), name = gt >= 0 ? label.slice(0, gt) : label, act = gt >= 0 ? label.slice(gt + 3) : "";
    var sk = skills.filter(function (x) { return x.name === name; })[0];
    if (!sk || /^(Cancel|Pause|Resume)$/.test(act)) return;
    out.unshift({ t: st.t, ms: t - st.t, skill: sk.id, app: name, action: act, ok: m[8] !== "FAIL", text: c >= 0 ? rest.slice(c + 2) : "", source: st.source });
  });
  return out.slice(0, 200);
}
function addHistory(h) {
  history.unshift(h);
  if (history.length > 200) history.length = 200;
  try { fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true }); fs.writeFileSync(HISTORY_FILE, JSON.stringify(history), "utf-8"); }
  catch (e) { log("Could not save history: " + e.message, "err"); }
  drawHistory();
  drawStates();
}
function hhmm(t) { var d = new Date(t); return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2) + ":" + ("0" + d.getSeconds()).slice(-2); }
// Time today ("08:14:03", or "08:14" short), else the date ("29 Oct").
function whenText(t, short) {
  if (new Date(t).toDateString() !== new Date().toDateString()) return new Date(t).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  return short ? hhmm(t).slice(0, 5) : hhmm(t);
}
function drawHistory() {
  var box = document.getElementById("history");
  if (!box) return;
  var h = '<div class="hnote">Every run, newest first. To undo a change in the project use Premiere: <b>Edit &gt; Undo</b> (⌘Z) or <b>Window &gt; History</b>.</div>';
  history.forEach(function (r) {
    h += '<div class="hrow' + (r.ok ? "" : " fail") + '" title="' + esc(new Date(r.t).toString()) + '"><span class="hmark">' + (r.ok ? "✓" : "✕") +
      '</span><span class="htime">' + whenText(r.t, false) +
      '</span><span class="hwhat">' + esc(r.app + (r.action ? " · " + r.action : "")) + ' <span class="hdur">' + clockText(r.ms / 1000) + "</span>" +
      (r.source && r.source !== "button" ? ' <span class="hsrc">' + esc(r.source) + "</span>" : "") +
      '</span><span class="hsum">' + esc(r.text) + "</span></div>";
  });
  box.innerHTML = h;
  document.getElementById("hist-count").textContent = history.length ? history.length : "";
}

// ---- State: header chip and each home row ----
function drawStates() {
  var chip = document.getElementById("chip");
  if (!chip) return;
  var live = Object.keys(tasks).map(function (k) { return tasks[k]; }).filter(function (p) { return p.event !== "none" && !taskOver(p); });
  var paused = live.some(function (p) { return p.paused || (p.eta && p.eta.state === "paused"); });
  var rendering = 0; live.forEach(function (p) { if (p.unit !== "steps") rendering += p.running || 0; });
  var last = history[0];
  if (running) { chip.className = "chip " + (paused ? "paused" : "run"); chip.textContent = paused ? "Paused · " + running : rendering ? "Rendering " + rendering + " · " + running : "Running · " + running; }
  else if (live.length) { chip.className = "chip " + (paused ? "paused" : "run"); chip.textContent = paused ? "Paused" : rendering ? "Rendering " + rendering : live.length + " running"; }
  else if (last && !last.ok && Date.now() - last.t < 600000) { chip.className = "chip fail"; chip.textContent = "Failed · " + last.app; }
  else { chip.className = "chip live"; chip.textContent = "Ready"; }
  chip.title = chip.textContent;
  [].forEach.call(document.querySelectorAll("#tiles .tile[data-skill]"), function (t) {
    var id = t.getAttribute("data-skill"), st = t.querySelector(".state"), p = tasks[id], r = null;
    for (var i = 0; i < history.length; i++) if (history[i].skill === id) { r = history[i]; break; }
    var txt = "", cls = "state";
    if (runningSkill === id || (p && p.event !== "none" && !taskOver(p))) {
      cls += p && p.paused ? " paused" : " run";
      txt = p && p.event !== "none" && !taskOver(p) ? (p.unit === "steps" ? Math.floor(p.percent) + "%" : p.finished + "/" + p.total) : "running";
    } else if (r) { cls += r.ok ? "" : " fail"; txt = (r.ok ? "✓ " : "✕ ") + whenText(r.t, true); t.title = t.title.split(" · ")[0] + " · last run " + new Date(r.t).toLocaleString("en-GB") + (r.ok ? "" : " (failed)"); }
    st.className = cls; st.textContent = txt;
  });
}

// ---- Layout: log / history pane at the bottom, on the side or hidden; list or icon view ----
// Remembered per Mac (localStorage). Premiere docks the whole panel; these arrange inside it.
function pref(k, v) { try { if (v === undefined) return localStorage.getItem("penytoolkit.ui." + k); localStorage.setItem("penytoolkit.ui." + k, v); } catch (e) { return null; } }
var LAYOUTS = ["bottom", "side", "hidden"];
function applyLayout() {
  var work = document.getElementById("work"), lay = pref("layout") || "bottom", aux = document.getElementById("aux");
  work.className = lay === "side" ? "side" : lay === "hidden" ? "nolog" : "";
  aux.style.height = lay === "bottom" ? (parseInt(pref("auxH"), 10) || Math.min(150, Math.round(window.innerHeight * 0.28))) + "px" : "";
  aux.style.width = lay === "side" ? (parseInt(pref("auxW"), 10) || 300) + "px" : "";
  document.getElementById("btn-layout").title = "Log and History: " + lay + " (L to change)";
  // Dashboard of tiles by default (Lee, 30 Oct 2026); G switches to list rows.
  var list = pref("tiles") === "list";
  document.getElementById("tiles").className = list ? "list" : "";
  document.getElementById("btn-view").classList.toggle("on", list);
  applyStyle();
  var tab = pref("tab") === "history" ? "history" : "log";
  document.getElementById("log").classList.toggle("hidden", tab !== "log");
  document.getElementById("history").classList.toggle("hidden", tab !== "history");
  [].forEach.call(document.querySelectorAll(".auxbar .tab"), function (b) { b.classList.toggle("on", b.getAttribute("data-tab") === tab); });
  document.getElementById("btn-history").classList.toggle("on", tab === "history" && lay !== "hidden");
  document.getElementById("aux-hint").textContent = tab === "history" ? "Undo in Premiere: ⌘Z" : "";
}
function cycleLayout() { pref("layout", LAYOUTS[(LAYOUTS.indexOf(pref("layout") || "bottom") + 1) % LAYOUTS.length]); applyLayout(); }
function toggleGrid() { pref("tiles", pref("tiles") === "list" ? "grid" : "list"); applyLayout(); }

// ---- Style: four looks (index.html), S to change, M motion on/off; remembered per Mac ----
var STYLES = [
  { id: "glass", name: "Glass", text: "The dashboard: black fading to white, frosted cards, round buttons", sw: "linear-gradient(180deg,#000 55%,#5a5a5a 85%,#bdbdbd)" },
  { id: "studio", name: "Studio", text: "Calm, like Resolve or Final Cut: charcoal, flat cards", sw: "linear-gradient(180deg,#1e1f22 60%,#4a4d52)" },
  { id: "bold", name: "Bold", text: "High-contrast black and white, big type, chunky outlines", sw: "linear-gradient(180deg,#000 65%,#d6d6d6)" },
  { id: "compact", name: "Compact", text: "Dense inspector for a small panel, no motion", sw: "#1c1d20" }];
function styleId() { var v = pref("style"); return STYLES.some(function (x) { return x.id === v; }) ? v : "studio"; } // Lee's pick, 30 Oct 2026
function applyStyle() {
  document.body.setAttribute("data-style", styleId());
  var motion = pref("motion") !== "off" && styleId() !== "compact";
  document.body.setAttribute("data-motion", motion ? "on" : "off");
  var st = STYLES.filter(function (x) { return x.id === styleId(); })[0];
  document.getElementById("btn-style").title = "Style: " + st.name + " (S to change, M motion " + (motion ? "on" : "off") + ")";
}
function setStyle(id) { pref("style", id); applyStyle(); }
function cycleStyle() { var i = STYLES.map(function (x) { return x.id; }).indexOf(styleId()); setStyle(STYLES[(i + 1) % STYLES.length].id); }
function toggleMotion() { pref("motion", pref("motion") === "off" ? "on" : "off"); applyStyle(); }
function showStyles() {
  sheet({ title: "Style", text: "", ok: "Done", cancel: "", okStyle: "primary" });
  document.getElementById("sheet-cancel").classList.add("hidden");
  var box = document.getElementById("sheet-text"), wrap = document.createElement("div"); wrap.className = "styles";
  STYLES.forEach(function (x, i) {
    var b = document.createElement("button"); b.className = x.id === styleId() ? "on" : "";
    b.innerHTML = '<span class="sw" style="background:' + x.sw + '"></span><b>' + esc(x.name) + "</b><kbd>" + (i + 1) + "</kbd><small>" + esc(x.text) + "</small>";
    b.addEventListener("click", function () { setStyle(x.id); [].forEach.call(wrap.children, function (c) { c.className = c === b ? "on" : ""; }); });
    wrap.appendChild(b);
  });
  box.innerHTML = ""; box.appendChild(wrap);
  var m = document.createElement("label"); m.className = "toggle";
  m.innerHTML = '<span class="tlabel">Motion (M)</span><span class="switch"><input type="checkbox"><span class="track"></span><span class="knob"></span></span>';
  var cb = m.querySelector("input"); cb.checked = pref("motion") !== "off";
  cb.addEventListener("change", function () { pref("motion", cb.checked ? "on" : "off"); applyStyle(); });
  box.appendChild(m);
}
function showTab(tab) {
  if (pref("layout") === "hidden") pref("layout", "bottom");
  if (!currentView) document.body.classList.add("pane-home");
  pref("tab", tab); applyLayout();
  if (tab === "log") { var l = document.getElementById("log"); l.scrollTop = l.scrollHeight; }
}
function initLayout() {
  document.getElementById("btn-layout").addEventListener("click", cycleLayout);
  document.getElementById("btn-view").addEventListener("click", toggleGrid);
  document.getElementById("btn-history").addEventListener("click", function () { showTab(pref("tab") === "history" && pref("layout") !== "hidden" ? "log" : "history"); });
  document.getElementById("btn-keys").addEventListener("click", showKeys);
  document.getElementById("btn-style").addEventListener("click", showStyles);
  [].forEach.call(document.querySelectorAll(".auxbar .tab"), function (b) { b.addEventListener("click", function () { showTab(b.getAttribute("data-tab")); }); });
  // Drag the splitter to size the pane (height at the bottom, width on the side).
  var split = document.getElementById("split");
  split.addEventListener("mousedown", function (e) {
    e.preventDefault();
    var side = pref("layout") === "side", aux = document.getElementById("aux"), start = side ? e.clientX : e.clientY, size = side ? aux.offsetWidth : aux.offsetHeight;
    split.classList.add("drag");
    function move(ev) {
      var work = document.getElementById("work"), max = (side ? work.offsetWidth : work.offsetHeight) - 80;
      var v = Math.max(60, Math.min(max, size + start - (side ? ev.clientX : ev.clientY)));
      if (side) aux.style.width = v + "px"; else aux.style.height = v + "px";
    }
    function up() {
      document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); split.classList.remove("drag");
      pref(side ? "auxW" : "auxH", String(side ? aux.offsetWidth : aux.offsetHeight));
    }
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  });
  applyLayout();
}

// ---- Keys (when the panel has focus; never while typing in a box) ----
// 1-9 open an app (or an Interviews job), Esc goes back / closes, G list or icons, L pane
// position, H History or Log, ? this list. A sheet takes Enter (OK) and Esc (Cancel).
var KEYS = [["1 – 9", "Open an app (or a job inside Interviews)"], ["Esc", "Back, or close a how-to box or question"], ["Enter", "OK in a question"],
  ["S", "Style: Glass, Studio, Bold, Compact"], ["M", "Motion on / off"], ["G", "Dashboard or list"], ["L", "Log and History: bottom, side, hidden"], ["H", "Switch Log / History"], ["?", "This list"]];
function showKeys() {
  var h = '<div class="keys">' + KEYS.map(function (k) { return "<kbd>" + esc(k[0]) + "</kbd><span>" + esc(k[1]) + "</span>"; }).join("") + "</div>";
  sheet({ title: "Keyboard shortcuts", text: "", ok: "Close", cancel: "", okStyle: "secondary" });
  document.getElementById("sheet-text").innerHTML = h + '<div>Keys work when the Toolkit panel is in front (click it once).</div>';
  document.getElementById("sheet-cancel").classList.add("hidden");
}
function onKey(e) {
  var sh = document.getElementById("sheet");
  if (sh && !sh.classList.contains("hidden")) {
    if (e.key === "Escape") { e.preventDefault(); var c = document.getElementById("sheet-cancel"); (c.classList.contains("hidden") ? document.getElementById("sheet-ok") : c).click(); }
    else if (e.key === "Enter") { e.preventDefault(); document.getElementById("sheet-ok").click(); }
    else if (/^[1-4]$/.test(e.key)) { var sb = sh.querySelectorAll(".styles button")[parseInt(e.key, 10) - 1]; if (sb) { e.preventDefault(); sb.click(); } }
    return;
  }
  var tg = e.target && e.target.tagName;
  if (tg === "INPUT" || tg === "TEXTAREA" || tg === "SELECT") { if (e.key === "Escape") e.target.blur(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "Escape") {
    if (document.querySelector(".info-btn[aria-expanded=true]")) closeInfo(); else goBack();
    e.preventDefault(); return;
  }
  var k = e.key.toLowerCase();
  if (k === "g") toggleGrid();
  else if (k === "s") cycleStyle();
  else if (k === "m") toggleMotion();
  else if (k === "l") cycleLayout();
  else if (k === "h") showTab(pref("tab") === "history" && pref("layout") !== "hidden" ? "log" : "history");
  else if (e.key === "?") showKeys();
  else if (/^[1-9]$/.test(e.key)) {
    var n = parseInt(e.key, 10) - 1;
    if (!currentView) { var t = document.querySelectorAll("#tiles .tile")[n]; if (t) t.click(); }
    else if (!currentApp) { var st = document.querySelectorAll('.app[data-skill="' + currentView + '"] .subtile')[n]; if (st) st.click(); }
    else return;
  } else return;
  e.preventDefault();
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
  // wait for the running action to finish (a control, or a queue press on the running skill, goes now)
  if (running && !(action && (action.control || (action.queue && skill.id === runningSkill)))) return;
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
    initJobsDock();
    initLayout();
    loadHistory();
    showView(null);
    drawStates();
    try { fs.mkdirSync(HOOK_INBOX, { recursive: true }); } catch (e) {}
    if (!window.PenyLoader) fs.writeFileSync(INSTANCE_FILE, INSTANCE_ID, "utf-8");
    hookTimer = setInterval(pollHook, HOOK_POLL_MS);
    updates = nodeRequire(path.join(extRoot, "core", "updater.js")).start({ log: log, isBusy: isBusy });
    document.getElementById("status").textContent = skills.filter(function (s) { return !s.hidden; }).length + " apps";
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

// Undo what this file set up in the page: the hook timer and the updater's timers; its
// click handlers sit on elements loader.js throws away.
function stop() {
  if (hookTimer) { clearInterval(hookTimer); hookTimer = null; }
  stopRunTimer(false);
  flipEnd();
  if (updates) { updates.stop(); updates = null; }
  skills = [];
}

window.PenyApp = {
  stop: stop,
  isBusy: isBusy,
  error: startError,
  skillsCount: function () { return skills.length; }
};

}());
