/* Peny Toolkit loader. The page itself never reloads (a CEP page reload leaves hidden
 * old pages running and makes Node's fs.promises hang, seen 2 Oct 2026); instead this
 * loader swaps the app code in place.
 *
 * - Owns the page's instance id (/tmp/peny-toolkit/instance) and a heartbeat file
 *   (/tmp/peny-toolkit/loader-alive) so install.sh can tell whether a panel is open.
 * - Loads main.js (read with fs, run as an inline script so it is always fresh).
 * - Every second checks /tmp/peny-toolkit/reload-stamp (fs.statSync). When it changes:
 *   waits while the app is busy, then stops the app, drops the toolkit's Node modules,
 *   puts back index.html's body and style, evaluates core.jsx again and loads main.js.
 *   The outcome goes to /tmp/peny-toolkit/reloaded.json.
 * Changes to this file or to CSXS/manifest.xml still need the panel closed and reopened. */

(function () {
  var req = typeof require !== "undefined" ? require : window.cep_node.require;
  var fs = req("fs");
  var path = req("path");
  var os = req("os");

  var HOOK_DIR = "/tmp/peny-toolkit";
  var INSTANCE_FILE = path.join(HOOK_DIR, "instance");
  var STAMP_FILE = path.join(HOOK_DIR, "reload-stamp");
  var RELOADED_FILE = path.join(HOOK_DIR, "reloaded.json");
  var ALIVE_FILE = path.join(HOOK_DIR, "loader-alive");
  var LOG_FILE = path.join(os.homedir(), "Library", "Logs", "PenyToolkit.log");
  var POLL_MS = 1000;

  var extRoot = decodeURI(window.__adobe_cep__.getSystemPath("extension")).replace(/^file:\/\//, "");
  var instanceId = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  var timer = null;
  var lastStamp = readStamp();
  var deferredStamp = null;

  function stamp() { return new Date().toISOString().replace("T", " ").slice(0, 23); }
  function log(msg) {
    try { fs.appendFileSync(LOG_FILE, stamp() + " [loader] " + msg + "\n"); } catch (e) {}
    var el = document.getElementById("log");
    if (el) { var line = document.createElement("div"); line.className = "warn"; line.textContent = stamp().slice(11, 19) + " " + msg; el.appendChild(line); }
  }
  function readStamp() {
    try { var st = fs.statSync(STAMP_FILE); return st.mtimeMs + ":" + fs.readFileSync(STAMP_FILE, "utf-8").trim(); }
    catch (e) { return ""; }
  }
  function stampValue(s) { return s.slice(s.indexOf(":") + 1); }
  function writeJson(file, obj) {
    var staged = file + ".staged";
    try { fs.writeFileSync(staged, JSON.stringify(obj, null, 2), "utf-8"); fs.renameSync(staged, file); }
    catch (e) { log("Could not write " + file + ": " + e.message); }
  }
  function report(st, extra) {
    var o = { stamp: stampValue(st), instance: instanceId, time: stamp() };
    for (var k in extra) if (extra.hasOwnProperty(k)) o[k] = extra[k];
    writeJson(RELOADED_FILE, o);
  }

  function clearToolkitModules() {
    try { Object.keys(req.cache).forEach(function (k) { if (k.indexOf(extRoot) === 0) delete req.cache[k]; }); } catch (e) {}
  }

  // Puts back <body> (without its scripts) and the <style> blocks from index.html.
  function restoreHtml() {
    var html = fs.readFileSync(path.join(extRoot, "index.html"), "utf-8");
    var body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
    if (!body) throw new Error("index.html has no <body>");
    document.body.innerHTML = body[1].replace(/<script[\s\S]*?<\/script>/gi, "");
    var styles = html.match(/<style[^>]*>[\s\S]*?<\/style>/gi) || [];
    var old = document.head.querySelectorAll("style");
    for (var i = 0; i < old.length; i++) old[i].parentNode.removeChild(old[i]);
    styles.forEach(function (s) {
      var el = document.createElement("style");
      el.textContent = s.replace(/^<style[^>]*>/i, "").replace(/<\/style>$/i, "");
      document.head.appendChild(el);
    });
  }

  // core.jsx keeps its state on $.global.PenyToolkit (`|| {}`), so evaluating it again
  // only replaces the functions; skills' premiere.jsx are evaluated on every run anyway.
  function reloadCore() {
    return new Promise(function (ok) {
      var core = JSON.stringify(path.join(extRoot, "core", "core.jsx"));
      window.__adobe_cep__.evalScript("(function(){try{$.evalFile(" + core + ");return 'ok';}catch(e){return 'error: '+e;}}())", ok);
    });
  }

  // Runs main.js as an inline script (synchronous, never served from a cache).
  function loadApp(st) {
    window.PenyApp = null;
    var el = document.createElement("script");
    el.textContent = fs.readFileSync(path.join(extRoot, "main.js"), "utf-8") + "\n//# sourceURL=main.js?v=" + encodeURIComponent(stampValue(st) || "start");
    document.body.appendChild(el);
    if (!window.PenyApp) throw new Error("main.js did not start (no PenyApp)");
    if (window.PenyApp.error) throw new Error("main.js start failed: " + window.PenyApp.error);
  }

  function softReload(st) {
    try {
      if (window.PenyApp) window.PenyApp.stop();
      clearToolkitModules();
      restoreHtml();
    } catch (e) {
      log("Soft reload " + stampValue(st) + " failed: " + e.message);
      report(st, { ok: false, error: e.message });
      return;
    }
    reloadCore().then(function (core) {
      if (core !== "ok") log("core.jsx: " + core);
      loadApp(st);
      var n = window.PenyApp.skillsCount();
      log("Soft reload " + stampValue(st) + " ok, " + n + " skills");
      report(st, { ok: true, skills: n, core: core });
    }).catch(function (e) {
      log("Soft reload " + stampValue(st) + " failed: " + e.message);
      report(st, { ok: false, error: e.message });
    });
  }

  function poll() {
    var current = "";
    try { current = fs.readFileSync(INSTANCE_FILE, "utf-8"); } catch (e) {}
    if (current !== instanceId) {
      clearInterval(timer);
      if (window.PenyApp) { try { window.PenyApp.stop(); } catch (e2) {} }
      log("Stale loader " + instanceId + " stopped.");
      return;
    }
    try { fs.writeFileSync(ALIVE_FILE, instanceId + " " + Date.now(), "utf-8"); } catch (e) {}
    var st = readStamp();
    if (!st || st === lastStamp) return;
    if (window.PenyApp && window.PenyApp.isBusy()) {
      if (deferredStamp !== st) {
        deferredStamp = st;
        log("Reload deferred: busy (" + window.PenyApp.isBusy() + ")");
        report(st, { ok: false, deferred: true, busy: String(window.PenyApp.isBusy()) });
      }
      return;
    }
    lastStamp = st;
    deferredStamp = null;
    softReload(st);
  }

  window.PenyLoader = { instanceId: instanceId, extRoot: extRoot };
  try { fs.mkdirSync(HOOK_DIR, { recursive: true }); } catch (e) {}
  fs.writeFileSync(INSTANCE_FILE, instanceId, "utf-8");
  try { loadApp(""); } catch (e) { log("Start failed: " + e.message); }
  timer = setInterval(poll, POLL_MS);
}());
