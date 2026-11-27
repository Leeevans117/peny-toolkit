(function () {
  var ROOT = window.__PENY_ROOT__;
  function rpc(mod, fn, args) {
    var x = new XMLHttpRequest(); x.open("POST", "/rpc", false); x.send(JSON.stringify({ mod: mod, fn: fn, args: args }));
    var r = JSON.parse(x.responseText); if (r.err) { var e = new Error(r.err); e.code = r.code; throw e; } return de(r.ok);
  }
  function de(v) {
    if (v && v.__stats) return { size: v.size, mtimeMs: v.mtimeMs, mtime: new Date(v.mtime), isDirectory: function () { return v.isDir; }, isFile: function () { return v.isFile; } };
    if (v && v.__buf !== undefined) return v.__buf;
    if (Array.isArray(v)) return v.map(function (d) { return d && d.__dirent ? { name: d.name, isDirectory: function () { return d.isDir; }, isFile: function () { return d.isFile; } } : d; });
    return v;
  }
  function proxy(mod) { return new Proxy({}, { get: function (t, k) {
    if (k === "promises") return new Proxy({}, { get: function (t2, k2) { return function () { var a = [].slice.call(arguments); return new Promise(function (ok, no) { try { ok(rpc(mod, k2.replace(/$/, "Sync"), a)); } catch (e) { no(e); } }); }; } });
    if (k === "sep") return "/"; if (k === "constants") return {}; if (k === "EOL") return "\n";
    return function () { var a = [].slice.call(arguments); var cb = typeof a[a.length - 1] === "function" ? a.pop() : null;
      if (cb && mod === "fs" && !/Sync$/.test(k)) { try { var v = rpc(mod, k + "Sync", a); setTimeout(function () { cb(null, v); }); } catch (e) { setTimeout(function () { cb(e); }); } return; }
      return rpc(mod, k, a); };
  } }); }
  function Emitter() { this.h = {}; } Emitter.prototype.on = function (n, f) { (this.h[n] = this.h[n] || []).push(f); return this; }; Emitter.prototype.once = Emitter.prototype.on; Emitter.prototype.kill = function () {}; Emitter.prototype.removeListener = function () { return this; };
  function fakeChild() { var c = new Emitter(); c.stdout = new Emitter(); c.stderr = new Emitter(); c.stdin = { write: function () {}, end: function () {} }; c.pid = 1; setTimeout(function () { (c.h.close || []).concat(c.h.exit || []).forEach(function (f) { f(1); }); }, 5); return c; }
  var stubs = {
    child_process: { spawn: fakeChild, execFile: function () { var cb = arguments[arguments.length - 1]; if (typeof cb === "function") setTimeout(function () { cb(new Error("harness"), "", ""); }); return fakeChild(); }, exec: function () { var cb = arguments[arguments.length - 1]; if (typeof cb === "function") setTimeout(function () { cb(new Error("harness"), "", ""); }); return fakeChild(); }, execSync: function () { return ""; }, execFileSync: function () { return ""; }, spawnSync: function () { return { status: 1, stdout: "", stderr: "" }; } },
    http: { request: function () { var r = new Emitter(); r.end = function () {}; r.write = function () {}; r.setTimeout = function () {}; r.destroy = function () {}; return r; }, get: function () { var r = new Emitter(); r.setTimeout = function () {}; r.destroy = function () {}; return r; } },
    crypto: { createHash: function () { return { update: function () { return this; }, digest: function () { return "0"; } }; }, randomBytes: function (n) { return { toString: function () { return "abcd"; } }; } },
    buffer: { Buffer: { from: function (s) { return s; } } }
  };
  var cache = {};
  function makeReq(dir) {
    var r = function (name) {
      if (name === "fs" || name === "path" || name === "os") return cache[name] || (cache[name] = proxy(name));
      if (stubs[name]) return stubs[name];
      var p = name.charAt(0) === "/" ? name : (dir + "/" + name).replace(/\/\.\//g, "/");
      if (!/\.js(on)?$/.test(p)) p += ".js";
      p = rpc("path", "resolve", [p]);
      if (cache[p]) return cache[p].exports;
      var x = new XMLHttpRequest(); x.open("GET", p, false); x.send();
      if (x.status !== 200) throw new Error("Cannot find module " + p);
      var m = { exports: {} }; cache[p] = m;
      if (/\.json$/.test(p)) { m.exports = JSON.parse(x.responseText); return m.exports; }
      new Function("module", "exports", "require", "__dirname", "__filename", "process", x.responseText + "\n//# sourceURL=" + p)(m, m.exports, makeReq(p.replace(/\/[^/]*$/, "")), p.replace(/\/[^/]*$/, ""), p, window.process);
      return m.exports;
    };
    r.cache = cache; r.resolve = function (n) { return n; };
    return r;
  }
  window.process = { env: { HOME: "", PATH: "/usr/bin" }, platform: "darwin", pid: 1, version: "v16", versions: { node: "16" }, on: function () {}, nextTick: function (f) { setTimeout(f); }, cwd: function () { return ROOT; }, hrtime: function () { return [0, 0]; } };
  window.require = makeReq(ROOT);
  window.__adobe_cep__ = { getSystemPath: function () { return "file://" + ROOT; }, evalScript: function (s, cb) { setTimeout(function () { cb && cb("{}"); }, 1); }, addEventListener: function () {}, getHostEnvironment: function () { return "{}"; } };
  window.cep = { fs: { showOpenDialog: function () { return { data: [] }; } } };
})();
