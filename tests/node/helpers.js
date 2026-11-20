// Shared helpers for the offline test suite (Node's built-in test runner, no packages).
var fs = require("fs"), os = require("os"), path = require("path");
var ROOT = path.join(__dirname, "..", "..");

// A fresh temp folder with spaces, unicode and an emoji in its name, so every path test
// also checks that odd characters in paths work.
function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), "peny qa " + (tag || "") + " é🎬 "));
}

// Writes a QuickTime-style file from [type, payloadBytes] atoms.
function writeAtoms(file, atoms) {
  var parts = atoms.map(function (a) {
    var body = Buffer.isBuffer(a[1]) ? a[1] : Buffer.alloc(a[1]);
    var h = Buffer.alloc(8);
    h.writeUInt32BE(body.length + 8, 0);
    h.write(a[0], 4, "latin1");
    return Buffer.concat([h, body]);
  });
  fs.writeFileSync(file, Buffer.concat(parts));
  return file;
}

// 16-bit PCM wav from an array of float samples (-1..1).
function writeWav(file, samples, sr, ch) {
  sr = sr || 16000; ch = ch || 1;
  var data = Buffer.alloc(samples.length * 2);
  for (var i = 0; i < samples.length; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
  var h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(ch, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * ch * 2, 28); h.writeUInt16LE(ch * 2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
  return file;
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

module.exports = { ROOT: ROOT, tmpdir: tmpdir, writeAtoms: writeAtoms, writeWav: writeWav, sleep: sleep };
