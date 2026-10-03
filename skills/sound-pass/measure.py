"""Sound Pass level meter. Reads a job on stdin, prints JSON on stdout.

  {"mode": "blocks", "ffmpeg": path, "wav": render, "out": file.npz}
      Reads a render (left channel) and saves the sample peak and mean square of every
      400 ms window.
  {"mode": "stats", "files": {"name": file.npz, ...}, "maskFrom": "name", "gate": 20,
   "clips": [{"id", "start", "end"}]}
      Per clip and per file: speech level stats. The speech windows are chosen once, from the
      `maskFrom` file (the dry render), as windows whose RMS is within `gate` dB of that
      render's 95th-percentile window RMS, and the same windows are used for every file, so
      before / dry / final compare like with like.

The level is what the bar top of Premiere's peak meter shows while someone talks: the sample
peak of each 400 ms window (dBFS). Calibrated 3 Oct 2026 against Lee's Assembly V1 interviews
(Tony Home IV: median window peak -6 to -9 dB, top held at -6 dB by the Hard Limiter).
"""
import json, subprocess, sys
import numpy as np

SR = 48000
WIN = int(SR * 0.4)


def blocks(job):
    cmd = [job["ffmpeg"], "-v", "error", "-i", job["wav"], "-af", "pan=mono|c0=c0", "-ar", str(SR), "-f", "f32le", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    peaks, ms, buf = [], [], np.zeros(0, dtype=np.float32)
    while True:
        chunk = p.stdout.read(WIN * 4 * 250)
        if not chunk:
            break
        buf = np.concatenate([buf, np.frombuffer(chunk, dtype=np.float32)])
        n = len(buf) // WIN
        if n:
            w = buf[: n * WIN].reshape(n, WIN).astype(np.float64)
            peaks.append(np.abs(w).max(axis=1))
            ms.append((w ** 2).mean(axis=1))
            buf = buf[n * WIN:]
    p.wait()
    if p.returncode != 0 or not peaks:
        raise SystemExit("ffmpeg failed reading " + job["wav"])
    pk = 20 * np.log10(np.maximum(np.concatenate(peaks), 1e-9))
    r = 10 * np.log10(np.maximum(np.concatenate(ms), 1e-18))
    np.savez(job["out"], pk=pk, rms=r)
    return {"windows": int(len(pk))}


def summary(p, r=None):
    q = lambda v: round(float(np.percentile(p, v)), 2)
    d = {"n": int(len(p))}
    if len(p):
        d.update({"pk10": q(10), "pk25": q(25), "pk50": q(50), "pk75": q(75), "pk90": q(90), "max": round(float(p.max()), 2),
                  "in12to6": round(float(((p >= -12.5) & (p <= -5.5)).mean()), 3), "over6": round(float((p > -5.5).mean()), 3)})
        if r is not None:
            d["rms50"] = round(float(np.percentile(r, 50)), 2)
    return d


def stats(job):
    data = {k: np.load(v) for k, v in job["files"].items()}
    m = data[job["maskFrom"]]
    r = m["rms"]
    ok = r > -100
    ref = float(np.percentile(r[ok], 95)) if ok.any() else -100.0
    speech = r > ref - float(job.get("gate", 20))
    out = {"ref95": round(ref, 2), "files": {}}
    for name, d in data.items():
        pk, rms = d["pk"], d["rms"]
        n = min(len(pk), len(speech))
        res, allp = {}, []
        for c in job["clips"]:
            a = int(np.ceil((c["start"] + 0.05) / 0.4))
            b = min(n, int(np.floor((c["end"] - 0.05) / 0.4)))
            if b <= a:
                res[c["id"]] = {"n": 0}
                continue
            sel = speech[a:b]
            p = pk[a:b][sel]
            res[c["id"]] = summary(p, rms[a:b][sel])
            allp.append(p)
        out["files"][name] = {"clips": res, "all": summary(np.concatenate(allp) if allp else np.zeros(0))}
    return out


def phrases(job):
    """Quiet stretches of speech to lift with Volume keyframes. Speech windows (dry render) use a
    stricter gate (`rideGate`, 15 dB) so pauses and room tone are never lifted. The level of a
    window is the median peak of the speech windows within +-2 windows (about 2 s) in the
    `file` render (the levelled result). Runs of speech windows whose level is more than `under`
    dB below `target` (one other window may sit inside a run), at least minWindows long and
    inside one clip, get lift = min(maxLift, rideTo - median level of the run)."""
    d = np.load(job["file"]); m = np.load(job["mask"])
    r = m["rms"]; ok = r > -100
    ref = float(np.percentile(r[ok], 95)) if ok.any() else -100.0
    speech = r > ref - float(job.get("rideGate", 15))
    pk = d["pk"]; n = min(len(pk), len(speech))
    target, under, ride_to, max_lift, min_w = (float(job["target"]), float(job["under"]), float(job["rideTo"]),
                                               float(job["maxLift"]), int(job["minWindows"]))
    out = {}
    for c in job["clips"]:
        a = int(np.ceil((c["start"] + 0.05) / 0.4)); b = min(n, int(np.floor((c["end"] - 0.05) / 0.4)))
        res = []
        if b - a < min_w:
            out[c["id"]] = res; continue
        sp = speech[a:b]; p = pk[a:b]
        lev = np.full(b - a, np.nan)
        for k in range(b - a):
            if not sp[k]: continue
            lo, hi = max(0, k - 2), min(b - a, k + 3)
            w = p[lo:hi][sp[lo:hi]]
            lev[k] = np.median(w)
        quiet = sp & (np.nan_to_num(lev, nan=0.0) < target - under)
        k = 0
        while k < b - a:
            if not quiet[k]:
                k += 1; continue
            e, last = k, k
            while e < b - a and (quiet[e] or (e + 1 < b - a and quiet[e + 1])):
                if quiet[e]: last = e
                e += 1
            sel = quiet[k:last + 1]
            if sel.sum() >= min_w:
                level = float(np.median(lev[k:last + 1][sel]))
                res.append({"start": round((a + k) * 0.4, 3), "end": round((a + last + 1) * 0.4, 3), "level": round(level, 2),
                            "lift": round(min(max_lift, ride_to - level), 2)})
            k = e
        out[c["id"]] = res
    return out


def main():
    job = json.load(sys.stdin)
    mode = job.get("mode")
    res = blocks(job) if mode == "blocks" else phrases(job) if mode == "phrases" else stats(job)
    json.dump(res, sys.stdout)


if __name__ == "__main__":
    main()
