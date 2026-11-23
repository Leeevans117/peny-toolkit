// Proxies with real ffmpeg renders (no Premiere: the Premiere side is faked with the clip
// list it would return). Needs an ffmpeg with prores_videotoolbox, so it runs on a Mac and
// is skipped elsewhere. Checks Lee's 23 Nov 2026 rule: a proxy is rendered under
// "<name>_Proxy-rendering.mov" and only gets its real name once complete and checked, so a
// cancelled render never leaves a broken file under the real name.
var test = require("node:test"), assert = require("node:assert/strict");
var fs = require("fs"), path = require("path"), cp = require("child_process");
var H = require("./helpers");

var FF = [path.join(process.env.HOME || "", "Library", "Application Support", "PenyToolkit", "bin", "ffmpeg"), "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]
  .filter(function (p) { return fs.existsSync(p); })[0];
var VT = FF && /prores_videotoolbox/.test(cp.execFileSync(FF, ["-hide_banner", "-encoders"]).toString());
var SKIP = !VT && "needs ffmpeg with prores_videotoolbox (macOS)";
// A throw-away home, so the run never touches the real ETA history or settings; the bundled
// tools (installer Macs) are linked in so the panel finds the same ffmpeg.
var REAL_BIN = path.join(process.env.HOME || "", "Library", "Application Support", "PenyToolkit", "bin");
process.env.HOME = H.tmpdir("home");
if (fs.existsSync(REAL_BIN)) { fs.mkdirSync(path.join(process.env.HOME, "Library", "Application Support", "PenyToolkit"), { recursive: true }); fs.symlinkSync(REAL_BIN, path.join(process.env.HOME, "Library", "Application Support", "PenyToolkit", "bin")); }

function clip(file, seconds) {
  cp.execFileSync(FF, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=25:d=" + seconds,
    "-f", "lavfi", "-i", "sine=f=440:d=" + seconds + ":sample_rate=48000", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", file]);
  return file;
}
function frames(file) {
  return parseInt(cp.execFileSync(path.join(path.dirname(FF), "ffprobe"), ["-v", "error", "-select_streams", "v:0", "-count_packets",
    "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", file]).toString(), 10);
}
function panel(items) {
  var api = { logs: [], evalSkill: function () { return Promise.resolve({ ok: true, details: { scope: "all", tally: {}, items: items } }); },
    jobs: require(path.join(H.ROOT, "core", "jobs.js")), log: function (m) { api.logs.push(m); }, status: function () {}, progress: function () {},
    skillAction: function () { return Promise.resolve({ ok: false }); }, setProjectTarget: function () {}, skillDir: path.join(H.ROOT, "skills", "proxy-automation") };
  var file = path.join(H.ROOT, "skills", "proxy-automation", "panel.js");
  delete require.cache[require.resolve(file)];
  return require(file)(api);
}
function list(dir) { var out = []; (function walk(d) { fs.readdirSync(d, { withFileTypes: true }).forEach(function (e) { if (e.isDirectory()) walk(path.join(d, e.name)); else out.push(path.relative(dir, path.join(d, e.name))); }); })(dir); return out.sort(); }

test("real render: proxies come out under their real names, frame-exact, with no temporary files left", { skip: SKIP, timeout: 300000 }, async function () {
  var src = H.tmpdir("footage"), dest = H.tmpdir("proxies");
  var items = ["A001 é", "A002"].map(function (n, i) { return { nodeId: "n" + i, name: n + ".mp4", mediaPath: clip(path.join(src, n + ".mp4"), 4), binPath: "Day 1" }; });
  var r = await panel(items).actions.render({ dest: dest });
  assert.equal(r.ok, true, r.summary || r.error);
  assert.deepEqual(list(dest), [path.join("Day 1", "A001 é_Proxy.mov"), path.join("Day 1", "A002_Proxy.mov")]);
  assert.equal(frames(path.join(dest, "Day 1", "A002_Proxy.mov")), frames(items[1].mediaPath));
});

test("real render: cancel halfway leaves only temporary files; rendering again finishes and renames them", { skip: SKIP, timeout: 600000 }, async function () {
  var src = H.tmpdir("footage"), dest = H.tmpdir("proxies");
  var items = ["B001", "B002"].map(function (n, i) { return { nodeId: "n" + i, name: n + ".mp4", mediaPath: clip(path.join(src, n + ".mp4"), 240), binPath: "Day 1" }; });
  var mod = panel(items), run = mod.actions.render({ dest: dest });
  var tmp = path.join(dest, "Day 1", "B001_Proxy-rendering.mov");
  for (var i = 0; i < 200 && !(fs.existsSync(tmp) && fs.statSync(tmp).size > 100000); i++) await H.sleep(50);
  await mod.actions.cancel();
  var r = await run;
  assert.equal(r.ok, false, r.summary);
  assert.deepEqual(list(dest).filter(function (f) { return /_Proxy\.mov$/.test(f); }), [], "no file may have the real proxy name after a cancel");
  assert.ok(fs.existsSync(tmp), "the half-written render is kept under its temporary name");
  assert.match(r.summary, /Unfinished renders kept under their temporary names/, r.summary);
  assert.ok(r.summary.indexOf(tmp) >= 0, r.summary);
  var again = await panel(items).actions.render({ dest: dest });
  assert.equal(again.ok, true, again.summary || again.error);
  assert.deepEqual(list(dest), [path.join("Day 1", "B001_Proxy.mov"), path.join("Day 1", "B002_Proxy.mov")]);
  assert.equal(frames(path.join(dest, "Day 1", "B001_Proxy.mov")), frames(items[0].mediaPath));
});
