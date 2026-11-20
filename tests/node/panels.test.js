// skills/*/skill.json and panel.js: every manifest is valid, every button has code behind it,
// and every action handles a failing Premiere / bad input with a readable error (no throw,
// no hang). Child processes are stubbed so no ffmpeg/whisper/Ollama/REDline is ever started,
// and HOME is a temp folder, so this is safe on Lee's Macs.
var test = require("node:test"), assert = require("node:assert/strict");
var fs = require("fs"), path = require("path"), Module = require("module"), EventEmitter = require("events");
var H = require("./helpers");
var SK = path.join(H.ROOT, "skills");
var IDS = fs.readdirSync(SK).filter(function (d) { return fs.existsSync(path.join(SK, d, "skill.json")); }).sort();

var spawned = [];
function fakeChild() {
  var c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = { write: function () {}, end: function () {} };
  c.pid = 999999; c.kill = function () {};
  setTimeout(function () { c.emit("exit", 1, null); c.emit("close", 1, null); }, 5);
  return c;
}
var fakeCp = {
  spawn: function (cmd) { spawned.push(cmd); return fakeChild(); },
  execFile: function (cmd) { spawned.push(cmd); var cb = arguments[arguments.length - 1]; if (typeof cb === "function") setTimeout(function () { cb(Object.assign(new Error("stubbed in tests"), { code: 1 }), "", ""); }, 5); return fakeChild(); },
  exec: function (cmd) { spawned.push(cmd); var cb = arguments[arguments.length - 1]; if (typeof cb === "function") setTimeout(function () { cb(Object.assign(new Error("stubbed in tests"), { code: 1 }), "", ""); }, 5); return fakeChild(); },
  execSync: function (cmd) { spawned.push(cmd); throw new Error("stubbed in tests"); },
  execFileSync: function (cmd) { spawned.push(cmd); throw new Error("stubbed in tests"); },
  spawnSync: function (cmd) { spawned.push(cmd); return { status: 1, stdout: "", stderr: "stubbed", error: new Error("stubbed") }; }
};
var realLoad = Module._load;
function withStubs(fn) {
  Module._load = function (req) { if (req === "child_process") return fakeCp; return realLoad.apply(this, arguments); };
  try { return fn(); } finally { Module._load = realLoad; }
}
process.env.HOME = H.tmpdir("home");

function manifest(id) { return JSON.parse(fs.readFileSync(path.join(SK, id, "skill.json"), "utf-8")); }
function fakeApi(id, evalResult) {
  var api = { logs: [], statuses: [] };
  api.evalSkill = function () { return Promise.resolve(JSON.parse(JSON.stringify(evalResult))); };
  api.jobs = require(path.join(H.ROOT, "core", "jobs.js"));
  api.log = function (m) { api.logs.push(m); }; api.status = function (t) { api.statuses.push(t); };
  api.progress = function () {}; api.skillAction = function () { return Promise.resolve({ ok: false, error: "no other skills in tests" }); };
  api.setProjectTarget = function () {}; api.skillDir = path.join(SK, id);
  return api;
}
function loadPanel(id, evalResult) {
  var m = manifest(id); if (!m.panel) return null;
  var file = path.join(SK, id, m.panel);
  return withStubs(function () { delete require.cache[require.resolve(file)]; return require(file)(fakeApi(id, evalResult)); });
}

test("every skill.json: required fields, files it names exist, ids and number keys unique", function () {
  var ids = {}, orders = {};
  IDS.forEach(function (d) {
    var m = manifest(d);
    assert.equal(m.id, d, "folder and id differ: " + d);
    assert.ok(m.name && typeof m.name === "string", d + " has no name");
    assert.ok(!ids[m.id], "duplicate id " + m.id); ids[m.id] = true;
    ["entry", "panel", "icon"].forEach(function (k) { if (m[k]) assert.ok(fs.existsSync(path.join(SK, d, m[k])), d + ": " + k + " " + m[k] + " missing"); });
    (m.apps || []).forEach(function (a) { if (a.icon) assert.ok(fs.existsSync(path.join(SK, d, a.icon)), d + ": app icon " + a.icon + " missing"); });
    if (m.order !== undefined && !m.hidden) { assert.ok(!orders[m.order], "two tiles share order " + m.order + ": " + orders[m.order] + ", " + d); orders[m.order] = d; }
    (m.inputs || []).forEach(function (i) {
      assert.ok(i.id, d + ": input without id");
      assert.ok(!i.type || ["folder", "checkbox", "segment", "text"].indexOf(i.type) >= 0, d + ": unknown input type " + i.type);
      if (i.type === "segment") assert.ok(Array.isArray(i.options) && i.options.length, d + ": segment " + i.id + " has no options");
    });
    var aids = {};
    (m.actions || []).forEach(function (a) {
      assert.ok(a.id && a.label, d + ": action needs id and label"); assert.ok(!aids[a.id], d + ": duplicate action " + a.id); aids[a.id] = true;
      if (a.style) assert.ok(["primary", "secondary", "danger"].indexOf(a.style) >= 0, d + ": bad style " + a.style);
      if (a.skill) assert.ok(IDS.indexOf(a.skill) >= 0, d + ": action " + a.id + " runs missing skill " + a.skill);
    });
  });
});
test("every icon.svg is well-formed SVG with the Peny frame", function () {
  IDS.forEach(function (d) {
    fs.readdirSync(path.join(SK, d)).filter(function (f) { return /\.svg$/.test(f); }).forEach(function (f) {
      var s = fs.readFileSync(path.join(SK, d, f), "utf-8");
      assert.ok(/<svg[\s>]/.test(s) && /<\/svg>\s*$/.test(s), d + "/" + f + " is not a whole <svg>");
      assert.equal((s.match(/</g) || []).length, (s.match(/>/g) || []).length, d + "/" + f + ": unbalanced < >");
    });
  });
});
test("every panel.js loads and has a function for every button in skill.json", function () {
  IDS.forEach(function (d) {
    var m = manifest(d), mod = loadPanel(d, { ok: false, error: "No active sequence." });
    if (!mod) return;
    assert.ok(mod.actions && typeof mod.actions === "object", d + ": panel.js returns no actions");
    (m.actions || []).forEach(function (a) {
      if (a.skill) return;
      var target = a.queue || a.id;
      assert.equal(typeof mod.actions[a.id], "function", d + ": button " + a.id + " has no code");
      if (a.queue) assert.equal(typeof mod.actions[target], "function", d + ": queue action " + target + " missing");
    });
  });
});
IDS.forEach(function (d) {
  var m = manifest(d);
  if (!m.panel) return;
  (m.actions || []).forEach(function (a) {
    if (a.skill) return;
    [["no active sequence", { ok: false, error: "No active sequence." }], ["garbage from Premiere", { ok: false, error: "Premiere returned: EvalScript error." }]].forEach(function (c) {
      test(d + " > " + a.id + ": " + c[0] + " gives a readable error, not a crash or a hang", async function () {
        var mod = loadPanel(d, c[1]);
        var params = { folder: "/nope/does not exist é", bin: "", dest: "/nope", tracks: "", name: "" };
        // A rejected promise is turned into { ok: false, error } by main.js runAction(), as here.
        var run = Promise.resolve().then(function () { return mod.actions[a.id](params); })
          .catch(function (e) { return { ok: false, error: "Action failed: " + (e && e.message ? e.message : String(e)) }; });
        var out = await Promise.race([run,
          H.sleep(8000).then(function () { return "HUNG"; })]);
        assert.notEqual(out, "HUNG", "no answer in 8 s");
        assert.ok(out && typeof out === "object", "returned " + JSON.stringify(out));
        if (a.control) { assert.ok(out.ok === true || typeof out.error === "string", JSON.stringify(out)); return; }
        assert.equal(out.ok, false, "should fail when Premiere fails: " + JSON.stringify(out).slice(0, 300));
        assert.equal(typeof out.error, "string"); assert.ok(out.error.length > 5);
        assert.ok(!/undefined|\[object Object\]|TypeError|ReferenceError/.test(out.error), "error is not readable: " + out.error);
      });
    });
  });
});
