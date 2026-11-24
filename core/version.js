/* Peny Toolkit: which build this panel is, shown at the top of the panel as a plain
 * V number (V1.1, V1.2 ...) so every Mac can be checked against the others
 * (Lee, 20 + 24 Nov 2026). The number is V<major>.<commits on main since base>
 * (VERSION_BASE), so it is the same on every Mac for the same build.
 *
 * install.sh writes VERSION.json into the installed panel:
 *  - one-click installer / office-server update: the release's own
 *    {"v", "version", "build", "commit"} (tools/build-installer.sh puts it in the panel)
 *  - git checkout: {"v", "major", "base", "commit", "tree", "clean", "repo"}: tree is the
 *    git tree of the files that were installed, uncommitted changes included. Installed
 *    before committing (the usual order): once the checkout's HEAD has that same tree,
 *    the panel is HEAD and its number is counted again from git.
 * Everything is async: a dropped network volume must never freeze the panel. */

var fs = require("fs");
var path = require("path");
var childProcess = require("child_process");

var GITS = ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"];

function readJson(file, cb) {
  fs.readFile(file, "utf-8", function (err, text) {
    if (err) return cb(null);
    try { cb(JSON.parse(text)); } catch (e) { cb(null); }
  });
}

function git(repo, args, cb) {
  var bin = null;
  for (var i = 0; i < GITS.length && !bin; i++) { try { fs.accessSync(GITS[i]); bin = GITS[i]; } catch (e) {} }
  if (!bin) return cb(null);
  childProcess.execFile(bin, ["-c", "safe.directory=*", "-C", repo].concat(args), { timeout: 10000 }, function (err, out) {
    cb(err ? null : String(out).trim().split("\n"));
  });
}

// cb({v, commit, changes, source, built}) - v null when the panel has no V number yet
// (installed before 24 Nov 2026), commit null when it has no VERSION.json at all.
function read(extRoot, home, cb) {
  readJson(path.join(extRoot, "VERSION.json"), function (j) {
    if (!j || !j.commit) return cb({ v: null, commit: null, changes: false, source: "none" });
    var info = { v: j.v || null, commit: j.commit, changes: j.clean === false, source: j.repo ? "git" : "release",
      built: j.built || j.installed || null };
    if (!info.changes || !j.repo || !j.tree) return cb(info);
    git(j.repo, ["rev-parse", "HEAD^{tree}", "--short", "HEAD"], function (out) {
      if (!out || out.length !== 2 || out[0] !== j.tree) return cb(info);
      info.commit = out[1]; info.changes = false;
      if (!j.major || !j.base) return cb(info);
      git(j.repo, ["rev-list", "--count", j.base + "..HEAD"], function (n) {
        if (n && /^\d+$/.test(n[0])) info.v = "V" + j.major + "." + n[0];
        cb(info);
      });
    });
  });
}

function label(info) {
  if (!info.commit) return "V?";
  return (info.v || info.commit) + (info.changes ? " + changes" : "");
}

function tooltip(info) {
  if (!info.commit) return "This panel has no version file. Install it again to see its V number.";
  return (info.v || "No V number") + ", commit " + info.commit +
    (info.changes ? ", plus changes that are not committed yet" : "") +
    (info.source === "git" ? ". Installed from this Mac's git checkout." : ". Installed from the office server.") +
    " Every Mac showing the same V number runs the same Toolkit.";
}

module.exports = { read: read, label: label, tooltip: tooltip };
