/* Peny Toolkit: wait for a Media Encoder render queued by T.queueRender (core.jsx).
 * Media Encoder calls back into Premiere's ExtendScript when the job ends, which writes
 * /tmp/peny-toolkit/ame/<jobId>.json; this polls for that file (Premiere is never asked).
 * Resolves { ok, path, ms } or { ok: false, error }. */
var fs = require("fs");
var path = require("path");
var DIR = "/tmp/peny-toolkit/ame";

function wait(jobId, outPath, opts) {
  opts = opts || {};
  var started = Date.now(), timeoutMs = opts.timeoutMs || 4 * 60 * 60 * 1000;
  var note = path.join(DIR, jobId + ".json");
  return new Promise(function (resolve) {
    (function poll() {
      var r = null;
      try { r = JSON.parse(fs.readFileSync(note, "utf-8")); } catch (e) {}
      if (r) {
        try { fs.unlinkSync(note); } catch (e2) {}
        r.ms = Date.now() - started;
        if (r.ok && !fs.existsSync(outPath)) { r.ok = false; r.error = "Media Encoder said done but " + outPath + " is not there"; }
        return resolve(r);
      }
      if (Date.now() - started > timeoutMs) return resolve({ ok: false, error: "Media Encoder did not finish in " + Math.round(timeoutMs / 60000) + " min", ms: Date.now() - started });
      if (opts.onTick) try { opts.onTick(Date.now() - started); } catch (e3) {}
      setTimeout(poll, 1000);
    }());
  });
}

module.exports = { wait: wait };
