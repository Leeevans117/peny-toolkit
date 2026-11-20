// Shell scripts: syntax of every script, install.sh copy (macOS: needs rsync), and
// red-proxy-finish.sh (RED proxy levels + channel order) run on real ffmpeg output.
var test = require("node:test"), assert = require("node:assert/strict");
var fs = require("fs"), path = require("path"), cp = require("child_process");
var H = require("./helpers");
function has(cmd) { try { cp.execSync("command -v " + cmd, { stdio: "ignore", shell: "/bin/bash" }); return true; } catch (e) { return false; } }
var FFMPEG = has("ffmpeg") ? cp.execSync("command -v ffmpeg", { shell: "/bin/bash" }).toString().trim() : null;
var PRORES = FFMPEG && /prores_ks/.test(cp.execFileSync(FFMPEG, ["-hide_banner", "-encoders"]).toString());

test("every shell script parses (bash -n)", function () {
  var files = cp.execSync("git -c safe.directory='*' ls-files '*.sh' '*.command'", { cwd: H.ROOT }).toString().trim().split("\n").concat(["verify_fresh_install.sh"])
    .filter(function (f) { return fs.existsSync(path.join(H.ROOT, f)); });
  assert.ok(files.length >= 10);
  files.forEach(function (f) { cp.execFileSync("bash", ["-n", path.join(H.ROOT, f)]); });
});

test("install.sh copies the panel without tests/docs/tools and says NO PANEL when none is open", { skip: !has("rsync") && "rsync not installed (macOS has it)" }, function () {
  var home = H.tmpdir("home"), hook = path.join(home, "hook dir");
  var r = cp.spawnSync(path.join(H.ROOT, "install.sh"), [], { env: Object.assign({}, process.env, { HOME: home, PENY_HOOK: hook }), encoding: "utf-8" });
  assert.equal(r.status, 3, r.stdout + r.stderr); assert.match(r.stdout, /^NO PANEL/);
  var dest = path.join(home, "Library", "Application Support", "Adobe", "CEP", "extensions", "com.peny.toolkit");
  ["index.html", "main.js", "loader.js", "CSXS/manifest.xml", "core/jobs.js", "skills/proxy-automation/skill.json"].forEach(function (f) { assert.ok(fs.existsSync(path.join(dest, f)), f + " not installed"); });
  ["tests", "docs", "tools", "setup.sh", "installer", "CLAUDE.md", ".git"].forEach(function (f) { assert.equal(fs.existsSync(path.join(dest, f)), false, f + " should not be installed"); });
});

// Found on the Mac Studio (20 Nov 2026): install.sh run from a checkout on the office server
// copied 110 macOS "._" metadata files into the panel.
test("install.sh leaves macOS ._ files (network shares) out of the panel", { skip: !has("rsync") && "rsync not installed (macOS has it)" }, function () {
  var src = path.join(H.tmpdir("src"), "com.peny.toolkit"), home = H.tmpdir("home");
  cp.execSync("git -c safe.directory='*' ls-files", { cwd: H.ROOT }).toString().trim().split("\n").forEach(function (f) {
    if (!fs.existsSync(path.join(H.ROOT, f))) return;
    fs.mkdirSync(path.dirname(path.join(src, f)), { recursive: true }); fs.copyFileSync(path.join(H.ROOT, f), path.join(src, f));
  });
  fs.chmodSync(path.join(src, "install.sh"), 0o755);
  ["._main.js", "core/._jobs.js", "skills/._colour-baseline", "skills/colour-baseline/._icon.svg"].forEach(function (f) { fs.writeFileSync(path.join(src, f), "\u0000\u0005\u0016\u0007"); });
  var r = cp.spawnSync("/bin/bash", [path.join(src, "install.sh")], { env: Object.assign({}, process.env, { HOME: home, PENY_HOOK: path.join(home, "hook") }), encoding: "utf-8" });
  assert.equal(r.status, 3, r.stdout + r.stderr);
  var dest = path.join(home, "Library", "Application Support", "Adobe", "CEP", "extensions", "com.peny.toolkit"), found = [];
  (function walk(d) { fs.readdirSync(d, { withFileTypes: true }).forEach(function (e) { if (e.name.indexOf("._") === 0) found.push(path.relative(dest, path.join(d, e.name))); else if (e.isDirectory()) walk(path.join(d, e.name)); }); })(dest);
  assert.deepEqual(found, [], "._ files installed: " + found.join(", "));
  assert.ok(fs.existsSync(path.join(dest, "skills", "colour-baseline", "icon.svg")));
});

// A fake REDline render: quad audio where file ch k holds a tone at 200*(k+1) Hz, picture at legal-range grey.
function fakeRedRender(file, channels) {
  var args = ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x808080:s=320x180:r=25:d=1"];
  var amix = [];
  for (var k = 0; k < channels; k++) { args.push("-f", "lavfi", "-i", "sine=f=" + (200 * (k + 1)) + ":d=1:sample_rate=48000"); amix.push("[" + (k + 1) + ":a]"); }
  if (channels) args.push("-filter_complex", amix.join("") + "join=inputs=" + channels + ":channel_layout=" + (channels === 4 ? "quad" : channels === 2 ? "stereo" : "mono") + "[a]", "-map", "0:v", "-map", "[a]", "-c:a", "pcm_s16le");
  args.push("-c:v", "prores_ks", "-profile:v", "0", "-pix_fmt", "yuv422p10le", file);
  cp.execFileSync(FFMPEG, args);
}
function dominantHz(file, stream) {
  var raw = cp.execFileSync(FFMPEG, ["-v", "error", "-i", file, "-map", "0:a:" + stream, "-ac", "1", "-ar", "8000", "-f", "s16le", "-"], { maxBuffer: 1e8 });
  var n = raw.length / 2, crossings = 0, prev = 0;
  for (var i = 0; i < n; i++) { var v = raw.readInt16LE(i * 2); if (prev < 0 && v >= 0) crossings++; prev = v; }
  return Math.round(crossings / (n / 8000) / 100) * 100;
}
test("red-proxy-finish.sh: 4 channels come out as 4 mono streams in R3D order, the render is removed", { skip: !PRORES && "ffmpeg with prores_ks needed" }, function () {
  var d = H.tmpdir("red"), inF = path.join(d, "A001_C001.redline-part.mov"), out = path.join(d, "A001_C001_Proxy é.mov");
  fakeRedRender(inF, 4);
  var r = cp.spawnSync("/bin/bash", [path.join(H.ROOT, "skills", "proxy-automation", "red-proxy-finish.sh"), FFMPEG, inF, out], { encoding: "utf-8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(inF), false, "REDline render removed on success");
  // file ch1 = R3D ch4 (800 Hz) ... so the proxy's stream 0 must be file ch2 (400 Hz).
  assert.deepEqual([0, 1, 2, 3].map(function (s) { return dominantHz(out, s); }), [400, 600, 800, 200]);
});
test("red-proxy-finish.sh: no audio and mono renders; an existing output is never overwritten", { skip: !PRORES && "ffmpeg with prores_ks needed" }, function () {
  var d = H.tmpdir("red2"), a = path.join(d, "a.mov"), b = path.join(d, "b.mov"), outA = path.join(d, "a_Proxy.mov"), outB = path.join(d, "b_Proxy.mov");
  fakeRedRender(a, 0); fakeRedRender(b, 1);
  var sh = path.join(H.ROOT, "skills", "proxy-automation", "red-proxy-finish.sh");
  assert.equal(cp.spawnSync("/bin/bash", [sh, FFMPEG, a, outA]).status, 0); assert.ok(fs.existsSync(outA));
  assert.equal(cp.spawnSync("/bin/bash", [sh, FFMPEG, b, outB]).status, 0); assert.ok(fs.existsSync(outB));
  var c = path.join(d, "c.mov"); fakeRedRender(c, 1);
  var before = fs.statSync(outB).size;
  var r = cp.spawnSync("/bin/bash", [sh, FFMPEG, c, outB]);
  assert.notEqual(r.status, 0); assert.ok(fs.existsSync(c), "render kept on failure"); assert.equal(fs.statSync(outB).size, before);
});
test("red-proxy-finish.sh: legal-range grey is expanded to full range", { skip: !PRORES && "ffmpeg with prores_ks needed" }, function () {
  var d = H.tmpdir("red3"), inF = path.join(d, "g.mov"), out = path.join(d, "g_Proxy.mov");
  cp.execFileSync(FFMPEG, ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x36:r=25:d=0.2", "-vf", "format=yuv422p10le,lutyuv=y=64", "-c:v", "prores_ks", "-profile:v", "0", inF]);
  assert.equal(cp.spawnSync("/bin/bash", [path.join(H.ROOT, "skills", "proxy-automation", "red-proxy-finish.sh"), FFMPEG, inF, out]).status, 0);
  var y = cp.execFileSync(FFMPEG, ["-v", "error", "-i", out, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "yuv422p10le", "-"]).readUInt16LE(0);
  assert.ok(y <= 8, "legal black (64) should come out as full-range black (about 0; ProRes is lossy), got " + y);
});
