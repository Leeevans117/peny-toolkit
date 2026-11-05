#!/usr/bin/env python3
"""Measure where each camera clip sits inside the external-audio wavs (Peny Toolkit).

Method from the saved skill "premiere-sync-external-audio-by-waveform" (La Thuile,
5 wavs, 120 Canon clips): GCC-PHAT cross-correlation of the camera's scratch audio
against the recorder wavs.
  Every camera audio channel is tried on its own (Lee, 2 Oct 2026: the Canon has two
  inputs, so a clip one channel cannot place may sync on the other). Channels that are
  exact copies of another (Canon a:1 = a:0, a:3 = a:2) are dropped, so two "agreeing"
  channels are always two different signals.
  1. Coarse: the clip's first <=120 s (2 kHz, each channel) against every wav in
     overlapping 10-minute windows (FFTs made once, reused for every clip). Against a
     whole 1 h wav at once the true peak drowned (tested 2 Oct 2026: ratio 1.0 whole,
     27 in a 300 s window). Best peak/second-peak ratio wins.
  2. Fine: 8 kHz, a +-3 s window of that wav around the best coarse hit (then the next
     best channel's hit if that fails), every channel. Accepted only if two different
     channels agree within 50 ms (ratios >= 2), or a channel agrees with its coarse lag
     within 50 ms with ratio >= 3. A weak peak is never accepted.
  3. Clips that are too short or fail: if another clip in the same recording was synced,
     the camera filename clock (HHMMSS) predicts the lag to about +-1.3 s; a narrow
     search there is accepted only on a strict rule: two channels agree with ratio >= 4, or
     one channel alone with ratio >= 8 inside that +-3 s window (Lee's 2.9 s D072 clip: a:0 ratio
     24 at 217.912 s vs 217.891 s placed by hand; a:2 was noise).
  Camera clock: the clip's "clock" (RED: REDline "Timestamp", from the panel) or the file
  name's HHMMSS. Before step 3, a match more than 2 s from where the other clips of its
  recording put it (median of their recorder-minus-camera offsets, 3+ clips) is undone and
  retried by step 3 (Lake Placid A005 Komodo + DJI Mic, 4 Nov 2026: 17 of 21 matches
  agreed to 1.0 s, 4 weak ones were 10-306 s off).
  Wavs: a file shorter than ~1 h starts a new recording unless its name time is the previous
  file's plus its length (DJI Mic splits every ~30 min).
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
SILENT_RMS = 10 ** (-70 / 20.0)  # below -70 dBFS is hiss (Komodo 4th channel: -88 dB); real quiet mics ~-43 dB


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


def channels(ffmpeg, clip, length):
    """Camera audio channels as {stream index: 2 kHz signal}, exact copies dropped."""
    out = {}
    clip["readable"] = False
    for s in range(8):
        c = decode(ffmpeg, clip["path"], COARSE_SR, clip.get("audioIn", clip["inPoint"]), length, s)
        if c is None: break
        clip["readable"] = True
        if len(c) < MIN_SECONDS * COARSE_SR or np.abs(c).max() == 0: continue
        if np.sqrt(np.mean(c * c)) < SILENT_RMS:
            clip.setdefault("dropped", []).append(s); continue
        cn = c / (np.linalg.norm(c) or 1)
        if any(abs(float(np.dot(cn, o[1]))) > 0.999 for o in out.values() if len(o[1]) == len(cn)): continue
        out[s] = (c, cn)
    if clip.get("dropped"):
        say("  %s: near-silent channel(s) %s not searched" % (clip["name"], ", ".join("a:%d" % s for s in clip["dropped"])))
    return {k: v[0] for k, v in out.items()}


def fine(ffmpeg, wav, clip, approx, streams, sr=FINE_SR, pad=FINE_PAD):
    """Fine lag (seconds into the wav for the clip's in-point) for each channel."""
    length = min(clip["duration"], CLIP_SECONDS)
    w0 = max(0.0, approx - pad)
    wseg = decode(ffmpeg, wav["path"], sr, w0, length + 2 * pad)
    out = {}
    if wseg is None or len(wseg) < sr: return out
    for s in streams:
        c = decode(ffmpeg, clip["path"], sr, clip.get("audioIn", clip["inPoint"]), length, s)
        if c is None or len(c) < MIN_SECONDS * sr or np.abs(c).max() == 0: continue
        n = 1 << int(np.ceil(np.log2(len(wseg) + len(c))))
        # Only within +-pad of the estimate. Searching every lag of the window let a clip
        # land up to its own length away (Lake Placid A099: 10.7 s off the camera clock).
        res = gcc_peak(np.fft.rfft(wseg, n), n, c, 0, int(round((approx - w0 + pad) * sr)))
        lag, ratio = peak_ratio(res, sr)
        if lag is not None: out[s] = (w0 + lag / sr, ratio)
    return out


def clock(name):
    """Seconds of day from a file name's HHMMSS (Canon H260703_153021, DJI DJI_38_20261005_020529)."""
    m = re.search(r"(\d{6})_(\d{2})(\d{2})(\d{2})", name)  # Canon: H260703_153021
    if not m: return None
    return int(m.group(2)) * 3600 + int(m.group(3)) * 60 + int(m.group(4))


def clip_clocks(clip):
    """The clip's camera clocks by kind: "tc" (RED Abs TC) and "ts" (RED Timestamp) from the
    panel, "name" (file name HHMMSS). Each kind is checked on its own: on Lake Placid A005
    the Timestamp of A099/A100/A103/A105 was 10-306 s out while their TC agreed to 0.1 s,
    and A134-A136's TC jumped 4250 s while their Timestamp agreed."""
    d = {k: v for k, v in (clip.get("clocks") or {}).items() if v is not None}
    if clip.get("clock") is not None: d.setdefault("ts", clip["clock"])
    n = clock(clip["name"])
    if n is not None: d.setdefault("name", n)
    return d


def clip_clock(clip):
    """One clock for ordering and reporting: TC, else Timestamp, else the name's."""
    d = clip_clocks(clip)
    return next((d[k] for k in ("tc", "ts", "name") if k in d), None)


CLOCK_TOL = 2.0  # s; a measured clip this far from where the other clips' clocks put it is wrong


def accept(f, coarse=None, strict=False):
    """f: {channel: (seconds, ratio)}; coarse: {channel: seconds}."""
    ks = sorted(f, key=lambda k: -f[k][1])
    for i in range(len(ks)):
        for j in range(i + 1, len(ks)):
            a, b = f[ks[i]], f[ks[j]]
            if abs(a[0] - b[0]) <= AGREE and min(a[1], b[1]) >= (4 if strict else 2):
                return a[0], "a:%d and a:%d agree (%.0f ms apart, ratios %.1f/%.1f)" % (ks[i], ks[j], abs(a[0] - b[0]) * 1000, a[1], b[1])
    for k in ks:
        if not strict and coarse and k in coarse and abs(f[k][0] - coarse[k]) <= AGREE and f[k][1] >= 3:
            return f[k][0], "coarse and fine agree on a:%d (ratio %.1f)" % (k, f[k][1])
        if strict and f[k][1] >= 8:
            return f[k][0], "a:%d strong peak near the camera-clock estimate (ratio %.1f)" % (k, f[k][1])
    return None, "no confident match (" + ", ".join("a:%d %.3f s ratio %.1f" % (k, v[0], v[1]) for k, v in sorted(f.items())) + ")"


def median(xs):
    xs = sorted(xs)
    return xs[len(xs) // 2] if len(xs) % 2 else (xs[len(xs) // 2 - 1] + xs[len(xs) // 2]) / 2


def offsets(results, clips):
    """{(recording, clock kind): [(result, recorder time - camera clock)]} of synced clips."""
    out = {}
    for r, c in zip(results, clips):
        if not r.get("synced"): continue
        for kind, t in clip_clocks(c).items():
            out.setdefault((r["recording"], kind), []).append((r, r["recTime"] - c["inPoint"] - t))
    return out


def clock_models(results, clips, wavs):
    """Per recording: its length and, per clock kind whose clocks agree, the recorder-minus-
    camera offset (3+ synced clips within CLOCK_TOL of the median, and 2/3 of them)."""
    recs = {}
    for w in wavs:
        m = recs.setdefault(w["recording"], {"recording": w["recording"], "length": 0.0, "offsets": {}})
        m["length"] = max(m["length"], w["recStart"] + w["duration"])
    for (rec, kind), items in offsets(results, clips).items():
        os_ = [o for _, o in items]
        med = median(os_)
        good = [o for o in os_ if abs(o - med) <= CLOCK_TOL]
        if len(good) >= 3 and len(good) * 3 >= len(os_) * 2:
            recs[rec]["offsets"][kind] = round(median(good), 3)
    return sorted(recs.values(), key=lambda m: m["recording"])


def main():
    job = json.load(sys.stdin)
    ffmpeg = job["ffmpeg"]
    wavs = sorted(job["wavs"], key=lambda w: os.path.basename(w["path"]))
    # Recordings: a ~1 h file continues into the next numbered file with no gap.
    rec = 0
    for i, w in enumerate(wavs):
        # DJI Mic splits every ~30 min: a file whose name time is the previous one's plus its
        # length (to 3 s) continues it (Lake Placid, 4 Oct 2026: 020529 + 1845.9 s = 023614).
        if i:
            p, c0, c1 = wavs[i - 1], clock(os.path.basename(wavs[i - 1]["path"])), clock(os.path.basename(w["path"]))
            chained = c0 is not None and c1 is not None and abs((c1 - c0 - p["duration"] + 43200) % 86400 - 43200) <= 3
            if p["duration"] < 3590 and not chained: rec += 1
        w["recording"] = rec
        w["recStart"] = 0.0 if i == 0 or wavs[i - 1]["recording"] != rec else wavs[i - 1]["recStart"] + wavs[i - 1]["duration"]
    # The panel measures in batches (camera-clock skip): clips with "known" carry the result
    # of an earlier batch, clips with "skip" are not read at all.
    todo = [c for c in job["clips"] if not c.get("known") and not c.get("skip")]
    clipN = int(CLIP_SECONDS * COARSE_SR)
    specs = []  # (wav index, window start s, spectrum, n, window length)
    win = int(WINDOW * COARSE_SR)
    n = 1 << int(np.ceil(np.log2(win + clipN)))
    for wi, w in enumerate(wavs if todo else []):
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
    for clip in job["clips"]:
        if clip.get("known"):
            results.append(dict(clip["known"]))
            if "streams" in clip["known"]: clip["streams"] = clip["known"]["streams"]  # step 3 needn't decode them again
            continue
        r = {"id": clip["id"], "name": clip["name"], "synced": False}
        results.append(r)
        if clip.get("skip"): r.update(reason=clip["skip"], skipped=True); continue
        say("Measuring %d/%d %s" % (todo.index(clip) + 1, len(todo), clip["name"]))
        length = min(clip["duration"], CLIP_SECONDS)
        if length < MIN_SECONDS: r["reason"] = "clip too short to measure"; continue
        chans = channels(ffmpeg, clip, length)
        clip["streams"] = r["streams"] = sorted(chans)
        if clip.get("dropped"): r["dropped"] = clip["dropped"]
        if not chans:
            src = {"proxy": "its proxy", "redline": "the R3D (REDline)"}.get(clip.get("source"), "the camera file")
            r["reason"] = ("camera sound is silent in " + src) if clip["readable"] else ("no camera sound could be read from " + src + " (" + os.path.basename(clip["path"]) + ")")
            continue
        hits = []  # best coarse hit per channel: (ratio, channel, wav index, seconds)
        for ch, c in chans.items():
            best = None
            for wi, w0, spec, n, wl in specs:
                lag, ratio = peak_ratio(gcc_peak(spec, n, c, -len(c) + 1, wl), COARSE_SR)
                if lag is not None and (best is None or ratio > best[0]): best = (ratio, ch, wi, w0 + lag / COARSE_SR)
            if best: hits.append(best)
        if not hits: r["reason"] = "no match in any wav"; continue
        hits.sort(reverse=True)
        r["coarse"] = [{"channel": h[1], "wav": os.path.basename(wavs[h[2]]["path"]), "seconds": round(h[3], 4), "ratio": round(h[0], 2)} for h in hits]
        tried = []
        for ratio, ch, wi, sec in hits:
            if any(wj == wi and abs(sj - sec) < FINE_PAD for wj, sj in tried): continue
            tried.append((wi, sec))
            f = fine(ffmpeg, wavs[wi], clip, sec, clip["streams"])
            coarse = {h[1]: h[3] for h in hits if h[2] == wi}
            t, why = accept(f, coarse)
            r["why"] = why
            if t is not None:
                r.update(synced=True, wav=wavs[wi]["path"], wavTime=round(t, 4), recording=wavs[wi]["recording"],
                         recTime=wavs[wi]["recStart"] + t)
                break
    if job.get("firstPassOnly"):
        json.dump({"results": results, "recordings": clock_models(results, job["clips"], wavs)}, sys.stdout)
        return
    # Clock check: in one recording, (recorder time - camera clock) is the same for every
    # clip to about a second. A match is undone (and retried at the clock's estimate below)
    # only when EVERY clock kind it has disagrees with the other clips' (3+) by more than
    # CLOCK_TOL. One clock alone is not trusted: Lake Placid A005, the Timestamp put 4 right
    # matches (A099, A100, A103, A105; Lee synced A099 by hand at 261.04 s) 10-306 s off.
    verdicts = {}  # id(result) -> [(kind, off - median of the others)]
    for (rec, kind), items in offsets(results, job["clips"]).items():
        if len(items) < 3: continue
        for r, off in items:
            verdicts.setdefault(id(r), []).append((kind, off - median([o for x, o in items if x is not r])))
    for r in results:
        v = verdicts.get(id(r))
        if not r["synced"] or not v or any(abs(d) <= CLOCK_TOL for _, d in v): continue
        r.update(synced=False, rejected={"wav": os.path.basename(r["wav"]), "wavTime": r["wavTime"], "clockOff": {k: round(d, 2) for k, d in v}},
                 why="match at %.3f s in %s rejected: %s from where the other clips' camera clocks put it" % (r["wavTime"], os.path.basename(r["wav"]), ", ".join("%.1f s by %s" % (d, k) for k, d in v)))
        for k in ("wav", "wavTime", "recording", "recTime"): r.pop(k, None)
    # Second pass: predict failed clips from a synced clip's camera clock.
    # One estimate per clock kind (nearest synced clip by that clock), tried in turn.
    anchors = [(r, c) for r, c in zip(results, job["clips"]) if r["synced"]]
    for r, clip in zip(results, job["clips"]):
        if r["synced"] or r.get("skipped") or not anchors or clip["duration"] < MIN_SECONDS: continue
        tried, notes = [], []
        for kind, t0 in sorted(clip_clocks(clip).items()):
            ak = [a for a in anchors if kind in clip_clocks(a[1])]
            if not ak: continue
            ar, ac = min(ak, key=lambda a: abs(clip_clocks(a[1])[kind] - t0))
            rt = ar["recTime"] + (t0 - clip_clocks(ac)[kind]) + (clip["inPoint"] - ac["inPoint"])
            cands = [w for w in wavs if w["recording"] == ar["recording"] and w["recStart"] <= rt < w["recStart"] + w["duration"]]
            if not cands or any(abs(rt - x) < 1.0 for x in tried): continue
            tried.append(rt)
            w = cands[0]
            if "streams" not in clip: clip["streams"] = sorted(channels(ffmpeg, clip, min(clip["duration"], CLIP_SECONDS)))
            f = fine(ffmpeg, w, clip, rt - w["recStart"], clip["streams"], pad=FINE_PAD)
            t, why = accept(f, strict=True)
            notes.append("camera clock (%s) from %s; %s" % (kind, ac["name"], why))
            if t is not None:
                r.update(synced=True, wav=w["path"], wavTime=round(t, 4), recording=w["recording"], recTime=w["recStart"] + t)
                r.pop("reason", None)
                break
        if notes: r["why"] = (r["why"] + "; " if r.get("rejected") else "") + "; ".join(notes)
    for r, clip in zip(results, job["clips"]):
        r["clock"] = clip_clock(clip)
        if not r["synced"] and "reason" not in r: r["reason"] = r.get("why", "no confident match")
    json.dump({"results": results, "wavs": [{"path": w["path"], "duration": w["duration"], "recording": w["recording"]} for w in wavs]}, sys.stdout)


if __name__ == "__main__":
    main()
