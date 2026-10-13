/* Peny Toolkit: updates run from inside the panel.
 *
 * macOS refuses launchd jobs that read a network volume ("Operation not permitted" on
 * /Volumes/ampdata, seen 13 Oct 2026) unless the program is given Full Disk Access, which
 * Lee does not want on every Mac. Programs started by this panel run as part of
 * Premiere, which already reads the office server, so the updates are started from here:
 *
 *  - Release updates (installer Macs): every 5 minutes, and 30 s after the panel opens,
 *    runs HOME/Library/Application Support/PenyToolkit/update.sh when the installer
 *    turned updates on (the "panel-updates" file next to it). update.sh does the rest:
 *    reads version.json on the server, copies and checks the zip, installs with --update
 *    (the panel then soft-reloads).
 *  - Build machine: every hour, runs the checkout's auto-update.sh (pull GitHub, install,
 *    publish what is not on the server yet) when HOME/.peny-toolkit/publisher names the
 *    checkout ("repo=<path>", written by tools/become-builder.sh).
 *
 * Nothing starts while an action runs (tools must not be replaced under a running job),
 * and one script at a time. Each script logs to its own file in ~/Library/Logs; a
 * failure is also logged here. Updates only happen while the panel is open. */

var childProcess = require("child_process");
var fs = require("fs");
var path = require("path");
var os = require("os");

var FIRST_MS = 30 * 1000;
var TICK_MS = 5 * 60 * 1000;
var BUILD_EVERY_MS = 60 * 60 * 1000;
var RUN_LIMIT_MS = 3 * 60 * 60 * 1000;

function exists(p) { try { fs.accessSync(p); return true; } catch (e) { return false; } }

function releaseScript(home) {
  var support = path.join(home, "Library", "Application Support", "PenyToolkit");
  var script = path.join(support, "update.sh");
  return exists(script) && exists(path.join(support, "panel-updates")) ? script : null;
}

function buildScript(home) {
  var mark = "";
  try { mark = fs.readFileSync(path.join(home, ".peny-toolkit", "publisher"), "utf-8"); } catch (e) { return null; }
  var m = /^repo=(.+)$/m.exec(mark);
  var script = m ? path.join(m[1].trim(), "auto-update.sh") : null;
  return script && exists(script) ? script : null;
}

// opts: log(msg, level), isBusy() -> reason or null
function start(opts) {
  var home = os.homedir();
  var child = null;
  var lastBuild = 0;
  var timers = [];

  function run(script, then) {
    var t0 = Date.now();
    child = childProcess.execFile("/bin/bash", [script], {
      cwd: home, timeout: RUN_LIMIT_MS, maxBuffer: 20 * 1024 * 1024,
      env: { HOME: home, USER: os.userInfo().username, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_GB.UTF-8" }
    }, function (err, stdout, stderr) {
      child = null;
      if (err) opts.log("Update script " + script + " failed after " + Math.round((Date.now() - t0) / 1000) + " s: " +
        String(stderr || err.message).trim().split("\n").slice(-3).join(" | "), "warn");
      if (then) then();
    });
  }

  function tick() {
    if (child || opts.isBusy()) return;
    var release = releaseScript(home);
    var build = Date.now() - lastBuild >= BUILD_EVERY_MS ? buildScript(home) : null;
    if (build) lastBuild = Date.now();
    if (release && build) run(release, function () { if (!opts.isBusy()) run(build); });
    else if (release) run(release);
    else if (build) run(build);
  }

  timers.push(setTimeout(tick, FIRST_MS));
  timers.push(setInterval(tick, TICK_MS));
  return {
    // A running script carries on after a soft reload; update.sh and auto-publish.sh
    // lock themselves, so the next panel's run cannot overlap it.
    stop: function () { timers.forEach(function (t) { clearTimeout(t); clearInterval(t); }); timers = []; },
    running: function () { return child ? true : false; }
  };
}

module.exports = { start: start, releaseScript: releaseScript, buildScript: buildScript };
