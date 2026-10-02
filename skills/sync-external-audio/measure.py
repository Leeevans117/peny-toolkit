#!/usr/bin/env python3
"""Measure where each camera clip sits inside the external-audio wavs (Peny Toolkit).

Method from the saved skill "premiere-sync-external-audio-by-waveform" (La Thuile,
5 wavs, 120 Canon clips): GCC-PHAT cross-correlation of the camera's scratch audio
against the recorder wavs.
  1. Coarse: the clip's first <=60 s (2 kHz, camera stream a:0) against every wav in
     overlapping 10-minute windows (FFTs made once, reused for every clip). Against a
     whole 1 h wav at once the true peak drowned (tested 2 Oct 2026: ratio 1.0 whole,
     27 in a 300 s window). Best peak/second-peak ratio wins.
  2. Fine: 8 kHz, a +-3 s window of that wav, camera streams a:0 and a:2.
     Accepted only if a:0 and a:2 agree within 50 ms (ratio >= 2), or a:0 agrees with
     the coarse lag within 50 ms with ratio >= 3. A weak peak is never accepted.
  3. Clips that are too short or fail: if another clip in the same recording was synced,
     the camera filename clock (HHMMSS) predicts the lag to about +-1.3 s; a narrow
     search there is accepted only on a strict rule: a:0 and a:2 agree with ratio >= 4, or
     a:0 alone with ratio >= 8 inside that +-3 s window (Lee's 2.9 s D072 clip: a:0 ratio
     24 at 217.912 s vs 217.891 s placed by hand; a:2 was noise).
Input: JSON on stdin {ffmpeg, cacheDir, clips:[{id, path, inPoint, duration, name}],
wavs:[{path, duration}]}. Output: JSON on stdout {results:[...]}. Progress lines on stderr.
"""
import json, os, re, subprocess, sys
import numpy as np

COARSE_SR, FINE_SR = 2000, 8000
CLIP_SECONDS = 120.0
WINDOW, STEP = 600.0, 480.0  # coarse windows overlap by the clip length
MIN_SECONDS = 1.5
FINE_PAD = 3.0
AGREE = 0.05


def say(msg):
    sys.stderr.write(msg + "\n"); sys.stderr.flush()


def decode(ffmpeg, path, sr, start=0.0, dur=None, stream=0):
    cmd = [ffmpeg, "-v", "error", "-nostdin"]
    if start > 0: cmd += ["-ss", "%.4f" % start]
    cmd += ["-i", path]
    if dur is not None: cmd += ["-t", "%.4f" % dur]
    cmd += ["-map", "0:a:%d" % stream, "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"]
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0: return None
    return np.frombuffer(p.stdout, dtype=np.float32).astype(np.float64)


def gcc_peak(sig_spec, n, clip, lo, hi):
    """Lag (samples) of clip inside the signal whose rfft (size n) is sig_spec, searched
    in [lo, hi]; returns (lag, peak, indexes, values) for peak_ratio()."""
    C = np.fft.rfft(clip, n)
    R = sig_spec * np.conj(C)
    R /= np.maximum(np.abs(R), 1e-12)
    r = np.fft.irfft(R, n)
    lags = np.arange(n); lags[lags > n // 2] -= n
    mask = (lags >= lo) & (lags <= hi)
    if not mask.any(): return None, 0.0, None, None
    idx = np.where(mask)[0]
    vals = r[idx]
    best = int(np.argmax(vals))
    return int(lags[idx[best]]), vals[best], idx, vals


def peak_ratio(lags_idx_vals, sr):
    lag, peak, idx, vals = lags_idx_vals
    if lag is None: return None, 0.0
    guard = int(0.05 * sr)
    pos = np.arange(len(vals))
    best = int(np.argmax(vals))
    far = np.abs(pos - best) > guard
    second = vals[far].max() if far.any() else 0.0
    return lag, float(peak / second) if second > 0 else 99.0


def fine(ffmpeg, wav, clip, approx, sr=FINE_SR, pad=FINE_PAD):
    """Fine lag (seconds into the wav for the clip's in-point) for streams a:0 and a:2."""
    length = min(clip["duration"], CLIP_SECONDS)
    w0 = max(0.0, approx - pad)
    wseg = decode(ffmpeg, wav["path"], sr, w0, length + 2 * pad)
    out = {}
    if wseg is None or len(wseg) < sr: return out
    for s in (0, 2):
        c = decode(ffmpeg, clip["path"], sr, clip["inPoint"], length, s)
        if c is None or len(c) < MIN_SECONDS * sr or np.abs(c).max() == 0: continue
        n = 1 << int(np.ceil(np.log2(len(wseg) + len(c))))
        res = gcc_peak(np.fft.rfft(wseg, n), n, c, -len(c) + 1, len(wseg))
        lag, ratio = peak_ratio(res, sr)
        if lag is not None: out[s] = (w0 + lag / sr, ratio)
    return out


def clock(name):
    m = re.search(r"(\d{6})_(\d{2})(\d{2})(\d{2})", name)  # Canon: H260703_153021
    if not m: return None
    return int(m.group(2)) * 3600 + int(m.group(3)) * 60 + int(m.group(4))


def accept(f, coarse=None, strict=False):
    a0, a2 = f.get(0), f.get(2)
    if a0 and a2 and abs(a0[0] - a2[0]) <= AGREE and min(a0[1], a2[1]) >= (4 if strict else 2):
        return a0[0], "a:0 and a:2 agree (%.0f ms apart, ratios %.1f/%.1f)" % (abs(a0[0] - a2[0]) * 1000, a0[1], a2[1])
    if not strict and a0 and coarse is not None and abs(a0[0] - coarse) <= AGREE and a0[1] >= 3:
        return a0[0], "coarse and fine agree on a:0 (ratio %.1f)" % a0[1]
    if strict and a0 and a0[1] >= 8:
        return a0[0], "a:0 strong peak near the camera-clock estimate (ratio %.1f)" % a0[1]
    return None, "no confident match (" + ", ".join("a:%d %.3f s ratio %.1f" % (k, v[0], v[1]) for k, v in sorted(f.items())) + ")"


def main():
    job = json.load(sys.stdin)
    ffmpeg = job["ffmpeg"]
    wavs = sorted(job["wavs"], key=lambda w: os.path.basename(w["path"]))
    # Recordings: a ~1 h file continues into the next numbered file with no gap.
    rec = 0
    for i, w in enumerate(wavs):
        if i and wavs[i - 1]["duration"] < 3590: rec += 1
        w["recording"] = rec
        w["recStart"] = 0.0 if i == 0 or wavs[i - 1]["recording"] != rec else wavs[i - 1]["recStart"] + wavs[i - 1]["duration"]
    clipN = int(CLIP_SECONDS * COARSE_SR)
    specs = []  # (wav index, window start s, spectrum, n, window length)
    win = int(WINDOW * COARSE_SR)
    n = 1 << int(np.ceil(np.log2(win + clipN)))
    for wi, w in enumerate(wavs):
        say("Reading " + os.path.basename(w["path"]))
        sig = decode(ffmpeg, w["path"], COARSE_SR)
        if sig is None: continue
        start = 0
        while True:
            seg = sig[start:start + win]
            specs.append((wi, start / COARSE_SR, np.fft.rfft(seg, n), n, len(seg)))
            if start + win >= len(sig): break
            start += int(STEP * COARSE_SR)
        del sig
    results = []
    for k, clip in enumerate(job["clips"]):
        say("Measuring %d/%d %s" % (k + 1, len(job["clips"]), clip["name"]))
        r = {"id": clip["id"], "name": clip["name"], "synced": False}
        results.append(r)
        length = min(clip["duration"], CLIP_SECONDS)
        if length < MIN_SECONDS: r["reason"] = "clip too short to measure"; continue
        c = decode(ffmpeg, clip["path"], COARSE_SR, clip["inPoint"], length, 0)
        if c is None or len(c) < MIN_SECONDS * COARSE_SR or np.abs(c).max() == 0:
            r["reason"] = "no camera audio to measure"; continue
        best = None
        for wi, w0, spec, n, wl in specs:
            lag, ratio = peak_ratio(gcc_peak(spec, n, c, -len(c) + 1, wl), COARSE_SR)
            if lag is not None and (best is None or ratio > best[2]): best = (wi, w0 + lag / COARSE_SR, ratio)
        if best is None: r["reason"] = "no match in any wav"; continue
        wi, coarse, cratio = best
        r["coarse"] = {"wav": os.path.basename(wavs[wi]["path"]), "seconds": round(coarse, 4), "ratio": round(cratio, 2)}
        f = fine(ffmpeg, wavs[wi], clip, coarse)
        t, why = accept(f, coarse)
        r["why"] = why
        if t is not None:
            r.update(synced=True, wav=wavs[wi]["path"], wavTime=round(t, 4), recording=wavs[wi]["recording"],
                     recTime=wavs[wi]["recStart"] + t)
    # Second pass: predict failed clips from a synced clip's camera clock.
    anchors = [(r, c) for r, c in zip(results, job["clips"]) if r["synced"] and clock(c["name"]) is not None]
    for r, clip in zip(results, job["clips"]):
        if r["synced"] or clock(clip["name"]) is None or not anchors or clip["duration"] < MIN_SECONDS: continue
        ar, ac = min(anchors, key=lambda a: abs(clock(a[1]["name"]) - clock(clip["name"])))
        rt = ar["recTime"] + (clock(clip["name"]) - clock(ac["name"])) + (clip["inPoint"] - ac["inPoint"])
        cands = [w for w in wavs if w["recording"] == ar["recording"] and w["recStart"] <= rt < w["recStart"] + w["duration"]]
        if not cands: continue
        w = cands[0]
        f = fine(ffmpeg, w, clip, rt - w["recStart"], pad=FINE_PAD)
        t, why = accept(f, strict=True)
        r["why"] = "camera clock from " + ac["name"] + "; " + why
        if t is not None:
            r.update(synced=True, wav=w["path"], wavTime=round(t, 4), recording=w["recording"], recTime=w["recStart"] + t)
            r.pop("reason", None)
    for r in results:
        if not r["synced"] and "reason" not in r: r["reason"] = r.get("why", "no confident match")
    json.dump({"results": results, "wavs": [{"path": w["path"], "duration": w["duration"], "recording": w["recording"]} for w in wavs]}, sys.stdout)


if __name__ == "__main__":
    main()
