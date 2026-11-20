/* Peny Toolkit: which build this panel is, shown at the top of the panel so every Mac
 * can be checked against the others (Lee, 20 Nov 2026).
 *
 * install.sh writes VERSION.json into the installed panel:
 *  - one-click installer / office-server update: the release's own
 *    {"version", "build", "commit"} (tools/build-installer.sh puts it in the panel)
 *  - git checkout: {"commit", "tree", "clean", "repo"}: tree is the git tree of the files
 *    that were installed, uncommitted changes included. Installed before committing
 *    (the usual order): once the checkout's HEAD has that same tree, the panel is HEAD.
 * The release number for a commit is read from the office server's releases/version.json.
 * Everything is async: a dropped network volume must never freeze the panel. */

var fs = require("fs");
var path = require("path");
var childProcess = require("child_process");

var DEFAULT_RELEASES = "/Volumes/ampdata/Peny/Claude/PenyToolkit/releases";
var GITS = ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"];

function readJson(file, cb) {
  fs.readFile(file, "utf-8", function (err, text) {
    if (err) return cb(null);
    try { cb(JSON.parse(text)); } catch (e) { cb(null); }
  });
}

function releasesDir(home, cb) {
  fs.readFile(path.join(home, "Library", "Application Support", "PenyToolkit", "update.conf"), "utf-8", function (err, text) {
    var m = !err && /^PENY_RELEASES="(.*)"$/m.exec(text || "");
    cb(m ? m[1] : DEFAULT_RELEASES);
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

// cb({version, commit, changes, source}) - version may be null (not published yet or no
// office server), commit null when the panel has no VERSION.json.
function read(extRoot, home, cb) {
  readJson(path.join(extRoot, "VERSION.json"), function (v) {
    if (!v || !v.commit) return cb({ version: null, commit: null, changes: false, source: "none" });
    var info = { version: v.version || null, commit: v.commit, changes: v.clean === false, source: v.repo ? "git" : "release" };
    if (info.version) return cb(info);

    function release() {
      releasesDir(home, function (dir) {
        if (/^https?:/.test(dir)) return cb(info);
        readJson(path.join(dir, "version.json"), function (r) {
          if (r && r.commit === info.commit && !info.changes) info.version = r.version;
          cb(info);
        });
      });
    }
    if (!info.changes || !v.repo || !v.tree) return release();
    git(v.repo, ["rev-parse", "HEAD^{tree}", "--short", "HEAD"], function (out) {
      if (out && out.length === 2 && out[0] === v.tree) { info.commit = out[1]; info.changes = false; }
      release();
    });
  });
}

function label(info) {
  if (!info.commit) return "version unknown";
  return (info.version ? info.version + " · " : "") + info.commit + (info.changes ? " + changes" : "");
}

function tooltip(info) {
  if (!info.commit) return "This panel has no VERSION.json (installed before 20 Nov 2026). Install it again to see its version.";
  return (info.version ? "Version " + info.version + ", commit " + info.commit : "Commit " + info.commit +
    (info.changes ? "" : " (no office-server release with this commit found)")) +
    (info.changes ? ", plus changes that are not committed yet" : "") +
    (info.source === "git" ? ". Installed from this Mac's git checkout." : ". Installed from the office server.") +
    " All Macs showing the same text run the same Toolkit.";
}

module.exports = { read: read, label: label, tooltip: tooltip };
