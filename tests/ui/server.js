// Harness server: serves the panel files and runs fs/path/os calls for the browser shim.
const http = require("http"), fs = require("fs"), path = require("path"), os = require("os");
const ROOT = process.argv[2], HOME = fs.mkdtempSync(path.join(os.tmpdir(), "peny-ui-home-")); fs.mkdirSync(path.join(HOME, "Library/Logs"), { recursive: true });
fs.mkdirSync("/tmp/peny-toolkit/inbox", { recursive: true });
const fakeOs = { homedir: () => HOME, tmpdir: () => os.tmpdir(), platform: () => "darwin", cpus: () => os.cpus().map(c => ({ model: c.model })), totalmem: () => os.totalmem(), freemem: () => os.freemem(), hostname: () => "harness", setPriority: () => {}, userInfo: () => ({ username: "harness" }), EOL: "\n", type: () => "Darwin", release: () => "24.0.0", arch: () => "arm64" };
function ser(v) {
  if (v && v.constructor && v.constructor.name === "Stats") return { __stats: 1, isDir: v.isDirectory(), isFile: v.isFile(), size: v.size, mtimeMs: v.mtimeMs, mtime: v.mtime };
  if (Buffer.isBuffer(v)) return { __buf: v.toString("utf8") };
  if (Array.isArray(v)) return v.map(x => (x && x.isDirectory && x.name) ? { __dirent: 1, name: x.name, isDir: x.isDirectory(), isFile: x.isFile() } : x);
  return v;
}
http.createServer((req, res) => {
  if (req.method === "POST") {
    let b = ""; req.on("data", d => b += d); req.on("end", () => {
      const { mod, fn, args } = JSON.parse(b); let out;
      try { const m = mod === "fs" ? fs : mod === "path" ? path : fakeOs; const v = typeof m[fn] === "function" ? m[fn].apply(m, args) : m[fn]; out = { ok: ser(v) }; }
      catch (e) { out = { err: e.message, code: e.code }; }
      res.end(JSON.stringify(out === undefined ? {} : out));
    }); return;
  }
  let p = decodeURIComponent(req.url.split("?")[0]);
  let f = p.startsWith("/__h/") ? path.join(__dirname, p.slice(5)) : (p.startsWith(ROOT) ? p : path.join(ROOT, p));
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end(); }
  let body = fs.readFileSync(f);
  if (f === path.join(ROOT, "index.html")) body = Buffer.from(body.toString().replace("<head>", '<head><script>window.__PENY_ROOT__=' + JSON.stringify(ROOT) + ';</script><script src="/__h/shim.js"></script>'));
  res.setHeader("Content-Type", f.endsWith(".html") ? "text/html" : f.endsWith(".svg") ? "image/svg+xml" : f.endsWith(".js") ? "text/javascript" : "application/octet-stream");
  res.end(body);
}).listen(+(process.env.PORT || 8765), () => console.log("up"));
