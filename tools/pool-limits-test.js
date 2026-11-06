// Self-check for the Full / Half speed limits in core/jobs.js: node tools/pool-limits-test.js
var jobs = require(require("path").join(__dirname, "..", "core", "jobs.js")), assert = require("assert");
var mode = "half", maxR = 0, maxT = 0, maxF = 0;
var pool = new jobs.JobPool({ maxConcurrent: 4, watchMs: 50, limits: function () { return mode === "half" ? { total: 2, perKind: { r3d: 1 } } : { total: 4 }; } });
for (var i = 0; i < 6; i++) pool.add({ key: "r" + i, cmd: "sleep 0.3", kind: "r3d" });
for (i = 0; i < 6; i++) pool.add({ key: "f" + i, cmd: "sleep 0.3", kind: "ffmpeg" });
var t = setInterval(function () {
  var r = 0, f = 0; Object.keys(pool.running).forEach(function (k) { if (pool.running[k].kind === "r3d") r++; else f++; });
  maxR = Math.max(maxR, r); maxF = Math.max(maxF, f); maxT = Math.max(maxT, r + f);
}, 20);
setTimeout(function () { assert(maxR <= 1 && maxT <= 2, "half broke: r3d " + maxR + " total " + maxT); console.log("half ok: r3d max", maxR, "total max", maxT); mode = "full"; maxR = maxT = 0; }, 900);
pool.start();
pool.wait().then(function (s) { clearInterval(t); console.log("full after switch: total max", maxT, "r3d max", maxR, "| done", pool.summary().ok, "of 12"); assert.strictEqual(pool.summary().ok, 12); process.exit(0); });
