"""Sound Pass level meter. Reads a job on stdin, prints JSON on stdout.

  {"mode": "blocks", "ffmpeg": path, "wav": render, "out": file.npz}
      Reads a render (left channel) and saves the sample peak and mean square of every
      400 ms window, plus the momentary loudness (EBU R128 "M", 400 ms, LUFS) every 100 ms
      from ffmpeg's ebur128 filter (key "m"; m[i] covers i*0.1-0.3 .. i*0.1+0.1 s).
  {"mode": "stats", "files": {"name": file.npz, ...}, "maskFrom": "name", "gate": 20,
   "clips": [{"id", "start", "end"}]}
      Per clip and per file: speech level stats. The speech windows are chosen once, from the
      `maskFrom` file (the dry render), as windows whose RMS is within `gate` dB of that
      render's 95th-percentile window RMS, and the same windows are used for every file, so
      before / dry / final compare like with like.

  {"mode": "check", "file": final.npz, "mask": dry.npz, "ceiling": dB, "clips": [{"id", "start", "end",
   "group", "name", "note"}]}
      Spots to listen to in the finished render (see check()).

The level is what the bar top of Premiere's peak meter shows while someone talks: the sample
peak of each 400 ms window (dBFS). Calibrated 3 Oct 2026 against Lee's Assembly V1 interviews
(Tony Home IV: median window peak -6 to -9 dB, top held at -6 dB by the Hard Limiter).
"""
import json, os, subprocess, sys, tempfile
import numpy as np

SR = 48000
WIN = int(SR * 0.4)
WORD_GATE = 15  # dB under the render's 95th-percentile loudness that still counts as clear speech


def blocks(job):
    cmd = [job["ffmpeg"], "-v", "error", "-i", job["wav"], "-af", "pan=mono|c0=c0", "-ar", str(SR), "-f", "f32le", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    peaks, ms, bands, buf = [], [], [], np.zeros(0, dtype=np.float32)
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
            bands.append(band_power(w.reshape(n * 4, WIN // 4)))
            buf = buf[n * WIN:]
    p.wait()
    if p.returncode != 0 or not peaks:
        raise SystemExit("ffmpeg failed reading " + job["wav"])
    pk = 20 * np.log10(np.maximum(np.concatenate(peaks), 1e-9))
    r = 10 * np.log10(np.maximum(np.concatenate(ms), 1e-18))
    bd = 10 * np.log10(np.maximum(np.concatenate(bands), 1e-18))
    np.savez(job["out"], pk=pk, rms=r, m=momentary(job["ffmpeg"], job["wav"]), bd=bd)
    return {"windows": int(len(pk))}


BANDS = ((20, 200), (200, 2000), (2000, 6000))  # Hz: body, voice, presence


def band_power(frames):
    """Mean power in BANDS for each 100 ms frame (rows of samples), Hann window."""
    win = np.hanning(frames.shape[1])
    spec = np.abs(np.fft.rfft(frames * win, axis=1)) ** 2 / (win ** 2).sum()
    f = np.fft.rfftfreq(frames.shape[1], 1.0 / SR)
    return np.stack([spec[:, (f >= a) & (f < b)].sum(axis=1) for a, b in BANDS], axis=1) / frames.shape[1] * 2


def momentary(ffmpeg, wav):
    """Momentary loudness (LUFS, 400 ms window) every 100 ms, left channel, from ffmpeg's ebur128."""
    fd, txt = tempfile.mkstemp(suffix=".txt")
    os.close(fd)
    try:
        subprocess.run([ffmpeg, "-v", "error", "-i", wav, "-af", "pan=mono|c0=c0,ebur128=metadata=1,ametadata=mode=print:key=lavfi.r128.M:file=" + txt,
                        "-f", "null", "-"], check=True)
        with open(txt) as f:
            v = [float(l.split("=", 1)[1]) for l in f if l.startswith("lavfi.r128.M=")]
    finally:
        try: os.remove(txt)
        except OSError: pass
    return np.array(v, dtype=np.float64)


def summary(p, r=None, lu=None):
    q = lambda v: round(float(np.percentile(p, v)), 2)
    d = {"n": int(len(p))}
    if len(p):
        d.update({"pk10": q(10), "pk25": q(25), "pk50": q(50), "pk75": q(75), "pk90": q(90), "max": round(float(p.max()), 2),
                  "in12to6": round(float(((p >= -12.5) & (p <= -5.5)).mean()), 3), "over6": round(float((p > -5.5).mean()), 3)})
        if r is not None:
            d["rms50"] = round(float(np.percentile(r, 50)), 2)
    if lu is not None and len(lu):
        # Momentary loudness of the speech (LUFS): how loud it sounds, not how high it peaks.
        d.update({"lu10": round(float(np.percentile(lu, 10)), 2), "lu50": round(float(np.percentile(lu, 50)), 2),
                  "lu90": round(float(np.percentile(lu, 90)), 2)})
    return d


def stats(job):
    """Speech windows are chosen per group (one speaker's source on one track; clips without a
    group form one group) from the `maskFrom` render, so a quieter speaker's pauses are not
    counted as speech because a louder one sets the reference."""
    data = {k: np.load(v) for k, v in job["files"].items()}
    m = data[job["maskFrom"]]
    r = m["rms"]
    gate = float(job.get("gate", 20))
    mm = m["m"] if "m" in m.files else None
    nm = len(mm) if mm is not None else 0
    masks = {}  # clip id -> (window slice, speech windows, frame slice, word frames)
    groups = {}
    for c in job["clips"]:
        groups.setdefault(c.get("group", ""), []).append(c)
    for g, clips in groups.items():
        wins = [(int(np.ceil((c["start"] + 0.05) / 0.4)), min(len(r), int(np.floor((c["end"] - 0.05) / 0.4)))) for c in clips]
        allr = np.concatenate([r[a:b] for a, b in wins if b > a] or [np.zeros(0)])
        ok = allr > -100
        ref = float(np.percentile(allr[ok], 95)) if ok.any() else -100.0
        fr = [frames(c["start"], c["end"], nm) for c in clips] if mm is not None else [(0, 0)] * len(clips)
        allm = np.concatenate([mm[a:b] for a, b in fr if b > a] or [np.zeros(0)]) if mm is not None else np.zeros(0)
        okm = allm > -70
        refm = float(np.percentile(allm[okm], 95)) if okm.any() else -70.0
        for c, (a, b), (fa, fb) in zip(clips, wins, fr):
            masks[c["id"]] = ((a, b), r[a:b] > ref - gate if b > a else np.zeros(0, bool),
                              (fa, fb), mm[fa:fb] > refm - WORD_GATE if mm is not None and fb > fa else None)
    out = {"files": {}}
    for name, d in data.items():
        pk, rms = d["pk"], d["rms"]
        lu = d["m"] if "m" in d.files else None
        res, allp, allu = {}, [], []
        for c in job["clips"]:
            (a, b), sel, (fa, fb), wsel = masks[c["id"]]
            b = min(b, len(pk))
            if b <= a:
                res[c["id"]] = {"n": 0}
                continue
            sel = sel[:b - a]
            p = pk[a:b][sel]
            u = None
            if lu is not None and wsel is not None:
                fb2 = min(fb, len(lu))
                u = lu[fa:fb2][wsel[:fb2 - fa]]
                allu.append(u)
            res[c["id"]] = summary(p, rms[a:b][sel], u)
            allp.append(p)
        out["files"][name] = {"clips": res, "all": summary(np.concatenate(allp) if allp else np.zeros(0), None,
                                                          np.concatenate(allu) if allu else None)}
    return out


def frames(start, end, n):
    """100 ms loudness frames whose 400 ms window lies inside start..end (sequence seconds)."""
    return max(0, int(np.ceil((start + 0.3) / 0.1))), max(0, min(n, int(np.floor((end - 0.1) / 0.1)) + 1))


def word_frames(mm, gate=WORD_GATE):
    """Loudness frames that are clear speech: within `gate` dB of the render's 95th percentile."""
    ok = mm > -70
    if not ok.any():
        return np.zeros(len(mm), dtype=bool)
    return mm > float(np.percentile(mm[ok], 95)) - gate


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


def level(job):
    """Even out the speech: a gain curve per clip (dB, relative to the `file` render) that
    brings every phrase to `target` momentary loudness (LUFS on the master), so quiet and
    loud phrases and different speakers all sound equally loud; the Hard Limiter then holds
    the top at the ceiling.
      phrase level = energy average of the clear-speech frames within +-`window` s
      gain = target - phrase level, kept within `lo`..`hi` dB of the clip's own gain
             (target - the clip's speech loudness), held across pauses (pauses are never
             lifted more than the speech around them), followed slowly: it moves only during
             speech, at most `rate` dB/s, ignoring differences under `dead` dB,
      then thinned to keyframes no more than `tol` dB off the curve.
    Clear speech = loudness frames within WORD_GATE dB of the 95th percentile of the clip's
    group (one speaker's source on one track). Clips with under `minSpeech` s of speech, or
    whose speech is more than `spread` dB under the group's usual level (the interviewer or
    crew off-mic), get the group's usual gain as one flat value. `keyable: false` clips (Volume
    already keyframed by someone, or the curve switched off) get their own level as one flat gain."""
    d = np.load(job["file"])
    mm = d["m"]
    n = len(mm)
    T = float(job["target"]); lo, hi = float(job["lo"]), float(job["hi"])
    W = int(round(float(job["window"]) / 0.1)); rate, dead = float(job["rate"]), float(job["dead"])
    tol = float(job["tol"]); spread = float(job["spread"])
    min_f, long_f = int(float(job["minSpeech"]) / 0.1), int(float(job["longSpeech"]) / 0.1)
    groups = {}
    for c in job["clips"]:
        groups.setdefault(c.get("group", ""), []).append(c)
    out = {}
    for g, clips in groups.items():
        spans = [frames(c["start"], c["end"], n) for c in clips]
        allm = np.concatenate([mm[a:b] for a, b in spans if b > a] or [np.zeros(0)])
        ok = allm > -70
        ref = float(np.percentile(allm[ok], 95)) if ok.any() else -70.0
        info = []
        for c, (a, b) in zip(clips, spans):
            seg = mm[a:b] if b > a else np.zeros(0)
            sp = seg > ref - WORD_GATE
            lsp = float(10 * np.log10(np.mean(10 ** (seg[sp] / 10)))) if sp.any() else None
            info.append((c, a, b, seg, sp, lsp))
        longs = [x[5] for x in info if x[5] is not None and x[4].sum() >= long_f]
        if len(longs) < 3:
            longs = [x[5] for x in info if x[5] is not None and x[4].sum() >= min_f]
        usual = float(np.median(longs)) if longs else None
        for c, a, b, seg, sp, lsp in info:
            r = {"group": g, "ref95": round(ref, 2), "speechSec": round(float(sp.sum()) * 0.1, 1),
                 "loudness": None if lsp is None else round(lsp, 2), "usual": None if usual is None else round(usual, 2)}
            nsp = int(sp.sum())
            if nsp < min_f or lsp is None:
                r.update(mode="flat", gain=round(T - usual, 2) if usual is not None else (round(T - lsp, 2) if lsp is not None else 0.0),
                         note="little speech: usual gain")
            elif usual is not None and lsp < usual - spread:
                r.update(mode="flat", gain=round(T - usual, 2),
                         note="quiet (%.1f dB under the answers): probably the interviewer or crew off-mic, given the usual gain only" % (usual - lsp))
            elif not c.get("keyable", True):
                r.update(mode="flat", gain=round(T - lsp, 2), why="one flat level for the clip")
            else:
                base = T - lsp
                e = np.where(sp, 10 ** (seg / 10), 0.0); k = np.ones(2 * W + 1)
                # "full" then centre: "same" returns len(k) points when the clip is shorter than k
                num = np.convolve(e, k, "full")[W:W + len(seg)]
                den = np.convolve(sp.astype(float), k, "full")[W:W + len(seg)]
                P = 10 * np.log10(np.maximum(num, 1e-30) / np.maximum(den, 1e-9))
                want = np.clip(T - P, base + lo, base + hi)
                # Follow `want` slowly, like a hand on the fader: move only while someone is
                # speaking (held through pauses, so the room tone never swells on its own), at
                # most `rate` dB/s, and leave differences under `dead` dB alone.
                step, cur = rate * 0.1, float(np.median(want[sp]))
                gain = np.empty(len(seg))
                for i in range(len(seg)):
                    if sp[i]:
                        dv = want[i] - cur
                        if abs(dv) > dead:
                            cur += float(np.clip(dv - np.sign(dv) * dead, -step, step))
                    gain[i] = cur
                t = (a + np.arange(len(seg))) * 0.1 - 0.1  # centre of each frame's 400 ms window
                t = np.concatenate([[c["start"]], t, [c["end"]]]); gain = np.concatenate([[gain[0]], gain, [gain[-1]]])
                kt, kg = thin(t, gain, tol)
                r.update(mode="ride", base=round(base, 2), keys=[[round(float(x), 3), round(float(y), 2)] for x, y in zip(kt, kg)],
                         gainMin=round(float(gain.min()), 2), gainMax=round(float(gain.max()), 2))
            out[c["id"]] = r
        # A short clip cut out of a longer answer takes the level of the clip it touches in the
        # same recording (its edge of the curve, or its flat level); the usual gain only when
        # it stands alone (Lee 23 Oct 2026: a 1.3 s Tahnee clip was 6 dB under its neighbour).
        for c in clips:
            r = out[c["id"]]
            if r.get("note") != "little speech: usual gain":
                continue
            edges = []
            for o in clips:
                q = out[o["id"]]
                if o is c or not (q["mode"] == "ride" or (q["mode"] == "flat" and not q.get("note"))):
                    continue
                if abs(o["end"] - c["start"]) <= 0.05:
                    edges.append((o["id"], q["keys"][-1][1] if q["mode"] == "ride" else q["gain"]))
                elif abs(o["start"] - c["end"]) <= 0.05:
                    edges.append((o["id"], q["keys"][0][1] if q["mode"] == "ride" else q["gain"]))
            if edges:
                r.update(gain=round(float(np.mean([e[1] for e in edges])), 2), usualGain=r["gain"],
                         follows=[e[0] for e in edges], note="little speech: same level as the clip next to it")
    return out


def emean(v):
    """Energy average of loudness values (dB)."""
    return float(10 * np.log10(np.mean(10 ** (np.asarray(v) / 10))))


def speech_mask(dm, clips, n):
    """Clear-speech frames of the voice clips: within WORD_GATE dB of their group's (speaker's)
    95th-percentile loudness in the dry render dm."""
    sp = np.zeros(n, dtype=bool)
    groups = {}
    for c in clips:
        groups.setdefault(c.get("group", ""), []).append(c)
    for g, cl in groups.items():
        fr = [frames(c["start"], c["end"], n) for c in cl]
        allm = np.concatenate([dm[a:b] for a, b in fr if b > a] or [np.zeros(0)])
        ok = allm > -70
        if not ok.any():
            continue
        ref = float(np.percentile(allm[ok], 95))
        for a, b in fr:
            if b > a:
                sp[a:b] = dm[a:b] > ref - WORD_GATE
    return sp


def lin(v):
    return 10 ** (np.nan_to_num(np.asarray(v, dtype=float), nan=-150.0) / 10)


def bed(job):
    """Gain curve for the music / camera sound (the bed) so Lee's voice-to-bed balance stays
    as he set it: the bed moves by Sound Pass's net voice change (final minus before voice
    render, energy average of the clear speech within +-1.5 s), held through pauses; where no
    voice plays it moves by the median change; 0.5 s ramps, within +-`cap` dB, thinned to
    `tol` dB. `prev` (bed clip id -> [[t, dB]]) is the gain an earlier run on this copy left,
    already in the before render, so it is added back. Returns {bed clip id: [[t, dB], ...]}."""
    b, f, dm = np.load(job["before"])["m"], np.load(job["file"])["m"], np.load(job["mask"])["m"]
    n = min(len(b), len(f), len(dm))
    clips = sorted(job["clips"], key=lambda c: c["start"])
    sp = speech_mask(dm, clips, n)
    k = np.ones(31)
    roll = lambda m: np.convolve(np.where(sp, lin(m[:n]), 0.0), k, "full")[15:15 + n]
    den = np.convolve(sp.astype(float), k, "full")[15:15 + n]
    ok = den >= 5
    chg = np.full(n, np.nan)
    chg[ok] = 10 * np.log10(np.maximum(roll(f)[ok], 1e-30) / np.maximum(roll(b)[ok], 1e-30))
    cap = float(job.get("cap", 12))
    mid = float(np.median(chg[sp & ok])) if (sp & ok).any() else 0.0
    inside = np.zeros(n, dtype=bool)
    for c in clips:
        a, e = int(c["start"] / 0.1), min(n, int(np.ceil(c["end"] / 0.1)))
        inside[a:e] = True
    g, cur = np.empty(n), mid
    for i in range(n):  # held through pauses; the median change where no voice plays
        if not np.isnan(chg[i]):
            cur = chg[i]
        elif not inside[i]:
            cur = mid
        g[i] = cur
    # 0.5 s ramps, like Lee's own ducking keyframes (0.35 s); a slower fader kept the balance worse
    # (5 Nov 2026: 2 dB/s gave Chris +1.5 dB, Laura -1.2 dB off his balance).
    g = np.convolve(np.pad(np.clip(g, -cap, cap), 2, mode="edge"), np.ones(5) / 5, "valid")
    t = np.arange(n) * 0.1 - 0.1  # centre of each frame's 400 ms window
    out = {}
    for c in job["bed"]:
        a, e = max(0, int(np.floor((c["start"] + 0.1) / 0.1))), min(n, int(np.ceil((c["end"] + 0.1) / 0.1)) + 1)
        if e - a < 2:
            out[c["id"]] = [[round(c["start"], 3), round(mid, 2)], [round(c["end"], 3), round(mid, 2)]]
            continue
        tt = np.concatenate([[c["start"]], np.clip(t[a:e], c["start"], c["end"]), [c["end"]]])
        gg = g[a:e].copy()
        prev = c.get("prev") or []
        if prev:
            px = np.array(prev, dtype=float)
            gg = gg + np.interp(np.clip(t[a:e], c["start"], c["end"]), px[:, 0], px[:, 1])
        gg = np.clip(gg, -cap, cap)
        gg = np.concatenate([[gg[0]], gg, [gg[-1]]])
        kt, kg = thin(tt, gg, float(job.get("tol", 1.0)))
        out[c["id"]] = [[round(float(x), 3), round(float(y), 2)] for x, y in zip(kt, kg)]
    return {"keys": out, "medianChange": round(mid, 2)}


def balance(job):
    """Voice over bed (dB) on clear-speech moments that have a bed under them, before and after
    Sound Pass, overall and per voice group, from the before / final voice renders, the mix
    render (bed = mix minus voice) and the bed gain Sound Pass applied (`bedKeys`, so the
    bed as Lee had it = bed now minus that gain). Spots where a 3 s stretch is more than
    `tol` dB off Lee's balance."""
    b, f, dm, mx = (np.load(job[k])["m"] for k in ("before", "file", "mask", "mix"))
    n = min(len(b), len(f), len(dm), len(mx))
    clips = sorted(job["clips"], key=lambda c: c["start"])
    sp = speech_mask(dm, clips, n)
    bed_now = 10 * np.log10(np.maximum(lin(mx[:n]) - lin(f[:n]), 1e-15))
    gain = np.zeros(n)
    t = np.arange(n) * 0.1 - 0.1
    for keys in (job.get("bedKeys") or {}).values():
        if len(keys) >= 2:
            px = np.array(keys, dtype=float)
            a, e = max(0, int(np.floor((px[0, 0] + 0.1) / 0.1))), min(n, int(np.ceil((px[-1, 0] + 0.1) / 0.1)))
            gain[a:e] = np.interp(t[a:e], px[:, 0], px[:, 1])  # shortcut: overlapping bed clips take the last one's gain
    bed_lee = bed_now - gain
    use = sp & (bed_now > -70) & (bed_now < f[:n] - 3)  # a bed is there and the subtraction is reliable
    em = lambda v: float(10 * np.log10(np.mean(lin(v)))) if len(v) else None
    out, groups, spots = {}, {}, []
    for c in clips:
        a, e = frames(c["start"], c["end"], n)
        sel = np.where(use[a:e])[0] + a if e > a else np.zeros(0, int)
        if len(sel) >= 5:
            groups.setdefault(c.get("group", ""), []).append((em(b[sel]) - em(bed_lee[sel]), em(f[sel]) - em(bed_now[sel])))
    rnd = lambda x: None if x is None else round(float(x), 2)
    allv = [v for g in groups.values() for v in g]
    out["all"] = {"clips": len(allv), "before": rnd(np.median([v[0] for v in allv])) if allv else None,
                  "after": rnd(np.median([v[1] for v in allv])) if allv else None}
    out["groups"] = {g: {"clips": len(v), "before": rnd(np.median([x[0] for x in v])), "after": rnd(np.median([x[1] for x in v]))} for g, v in groups.items()}
    tol = float(job.get("tol", 2.0))
    i = 0
    while i + 30 <= n:  # 3 s stretches
        sel = np.where(use[i:i + 30])[0] + i
        if len(sel) >= 10:
            d = (em(f[sel]) - em(bed_now[sel])) - (em(b[sel]) - em(bed_lee[sel]))
            if abs(d) > tol:
                spots.append({"t": round(i * 0.1, 2), "end": round((i + 30) * 0.1, 2), "kind": "balance", "clipId": None,
                              "text": "voice %.1f dB %s over the music/camera sound than you had it" % (abs(d), "further" if d > 0 else "less far")})
        i += 30
    out["spots"] = spots
    return out


def check(job):
    """Spots in the finished render that are worth a listen, so nobody has to sit through the
    whole sequence (Lee 23 Oct 2026). Clear speech = frames within WORD_GATE dB of the group's
    95th-percentile loudness in the `mask` (dry) render, as in level(); loudness is read from
    the `file` (final) render on those frames.
      clip level   a clip with >= 2 s of speech whose middle loudness is more than CLIP_DB
                   from the middle of all clips
      jump at cut  speech in the last 3 s before a cut vs the first 3 s after it (>= 1 s
                   each side, clips touching or under 1 s apart) more than CUT_DB apart
      dip / rise   inside a clip, the 3 s speech loudness more than RUN_DB from the clip's
                   middle for >= 2 s
      over ceiling any 400 ms peak more than 0.5 dB over the ceiling
      not levelled clips left at the usual level (off-mic, or little speech standing alone)
                   that ended up more than CLIP_DB from the middle (>= 0.5 s of speech)
      tone         (renders with band levels, "bd") a clip whose body (<200 Hz) or presence
                   (2-6 kHz), relative to its own level, is more than TONE_DB off the median
                   of the same speaker's clips; and a cut between two clips of the same
                   speaker whose presence differs by more than TONE_DB
      background   (with `mix`, a render of every track as heard) a voice cut where the
                   whole mix jumps more than MIX_DB within 1 s while the voice does not, or
                   where the bed (mix minus voice, in pauses, 3 s each side) changes more
                   than BED_DB
    Spots under 2 s apart are merged; at most MAX_SPOTS are returned."""
    CLIP_DB, CUT_DB, RUN_DB, MAX_SPOTS = 2.0, 3.0, 4.0, 100
    TONE_DB, MIX_DB, BED_DB = 4.0, 3.0, 4.0
    d, msk = np.load(job["file"]), np.load(job["mask"])
    fm, dm, pk = d["m"], msk["m"], d["pk"]
    n = min(len(fm), len(dm))
    ceiling = float(job["ceiling"])
    clips = sorted(job["clips"], key=lambda c: c["start"])
    sp = speech_mask(dm, clips, n)
    who = lambda c: c.get("name") or c.get("group") or "clip"
    usual = lambda c: str(c.get("note", "")).startswith("quiet") or c.get("note") == "little speech: usual gain"
    spots, lu50 = [], {}
    for c in clips:
        a, b = frames(c["start"], c["end"], n)
        sel = np.where(sp[a:b])[0] + a if b > a else np.zeros(0, int)
        if len(sel) >= (5 if usual(c) else 20):
            lu50[c["id"]] = float(np.median(fm[sel]))
    mids = [lu50[c["id"]] for c in clips if c["id"] in lu50 and not usual(c)]
    mid = float(np.median(mids)) if mids else None
    for c in clips:
        if mid is not None and c["id"] in lu50 and not usual(c):
            dv = lu50[c["id"]] - mid
            if abs(dv) > CLIP_DB:
                spots.append({"t": c["start"], "end": c["end"], "kind": "clip level", "clipId": c["id"],
                              "text": "%.1f dB %s than the other clips (%s)" % (abs(dv), "louder" if dv > 0 else "quieter", who(c))})
        # Left at the usual level: only worth a listen when it ended up away from the others.
        if usual(c) and mid is not None and c["id"] in lu50 and abs(lu50[c["id"]] - mid) > CLIP_DB:
            dv = lu50[c["id"]] - mid
            spots.append({"t": c["start"], "end": c["end"], "kind": "not levelled", "clipId": c["id"],
                          "text": "%.1f dB %s than the other clips, not levelled: %s (%s)" % (abs(dv), "louder" if dv > 0 else "quieter", c["note"], who(c))})
    # Cuts between consecutive voice clips.
    def side(t0, t1):
        a, b = frames(t0, t1, n)
        sel = np.where(sp[a:b])[0] + a if b > a else np.zeros(0, int)
        return emean(fm[sel]) if len(sel) >= 10 else None
    for x, y in zip(clips, clips[1:]):
        gap = y["start"] - x["end"]
        if not -0.05 <= gap < 1.0:
            continue
        L, R = side(max(x["start"], x["end"] - 3), x["end"]), side(y["start"], min(y["end"], y["start"] + 3))
        if L is not None and R is not None and abs(R - L) > CUT_DB:
            spots.append({"t": y["start"], "end": None, "kind": "jump at cut", "clipId": y["id"],
                          "text": "%.1f dB %s after the cut (%s to %s)" % (abs(R - L), "louder" if R > L else "quieter", who(x), who(y))})
    # Dips and rises inside a clip.
    k = np.ones(31)
    for c in clips:
        a, b = frames(c["start"], c["end"], n)
        if b - a < 40 or sp[a:b].sum() < 30 or usual(c):
            continue
        s, e = sp[a:b], np.where(sp[a:b], 10 ** (fm[a:b] / 10), 0.0)
        num, den = np.convolve(e, k, "full")[15:15 + b - a], np.convolve(s.astype(float), k, "full")[15:15 + b - a]
        roll = np.where(den >= 10, 10 * np.log10(np.maximum(num, 1e-30) / np.maximum(den, 1e-9)), np.nan)
        if np.isnan(roll).all():
            continue
        med = float(np.nanmedian(roll))
        off = np.abs(np.nan_to_num(roll, nan=med) - med) > RUN_DB
        i = 0
        while i < len(off):
            if not off[i]:
                i += 1; continue
            j = i
            while j < len(off) and off[j]:
                j += 1
            if j - i >= 20:
                dv = float(np.nanmedian(roll[i:j])) - med
                spots.append({"t": round((a + i) * 0.1 - 0.3, 2), "end": round((a + j) * 0.1 + 0.1, 2), "kind": "dip/rise", "clipId": c["id"],
                              "text": "%.1f dB %s than the rest of the clip for %.0f s (%s)" % (abs(dv), "louder" if dv > 0 else "quieter", (j - i) * 0.1, who(c))})
            i = j
    # Peaks over the ceiling, inside voice clips.
    for c in clips:
        a, b = int(np.ceil(c["start"] / 0.4)), min(len(pk), int(np.floor(c["end"] / 0.4)))
        over = np.where(pk[a:b] > ceiling + 0.5)[0] if b > a else []
        if len(over):
            spots.append({"t": round((a + over[0]) * 0.4, 2), "end": round((a + over[-1] + 1) * 0.4, 2), "kind": "over ceiling", "clipId": c["id"],
                          "text": "peaks reach %.1f dB, over the %.0f dB ceiling (%s)" % (float(pk[a:b].max()), ceiling, who(c))})
    spots += tone_spots(d, sp, clips, n, who, TONE_DB)
    if job.get("mix") and job.get("before"):
        bal = balance(dict(job, tol=2.0))
        spots += bal["spots"]
    if job.get("mix"):
        spots += mix_spots(np.load(job["mix"])["m"], fm, sp, clips, n, MIX_DB, BED_DB)
    spots.sort(key=lambda x: x["t"])
    merged = []
    for x in spots:
        last = merged[-1] if merged else None
        if last and x["t"] - last["t"] < 2:
            last["text"] += "; " + x["text"]
            last["kinds"].append(x["kind"])
            if x.get("end") is not None:
                last["end"] = max(last.get("end") or x["end"], x["end"])
        else:
            x["kinds"] = [x["kind"]]
            merged.append(x)
    for x in merged:
        x["t"] = round(float(x["t"]), 2)
        x["end"] = None if x.get("end") is None else round(float(x["end"]), 2)
        x["text"] = "Sound Pass: " + x["text"]
    kinds = {}
    for x in merged:
        for kd in x["kinds"]:
            kinds[kd] = kinds.get(kd, 0) + 1
    return {"spots": merged[:MAX_SPOTS], "total": len(merged), "capped": len(merged) > MAX_SPOTS, "kinds": kinds,
            "middle": None if mid is None else round(mid, 2),
            "balance": {k: v for k, v in bal.items() if k != "spots"} if job.get("mix") and job.get("before") else None}


def tone_bands(bd, sel):
    """Body / voice / presence of the given frames, each in dB relative to their sum."""
    e = (10 ** (bd[sel] / 10)).mean(axis=0)
    return 10 * np.log10(np.maximum(e, 1e-30) / max(e.sum(), 1e-30))


def tone_spots(d, sp, clips, n, who, tol):
    if "bd" not in d.files:
        return []
    bd = d["bd"]
    nb = min(n, len(bd))
    tone, out = {}, []
    for c in clips:
        a, b = frames(c["start"], c["end"], nb)
        sel = np.where(sp[a:b])[0] + a if b > a else np.zeros(0, int)
        if len(sel) >= 10:
            tone[c["id"]] = (tone_bands(bd, sel), len(sel))
    groups = {}
    for c in clips:
        if c["id"] in tone and tone[c["id"]][1] >= 20:
            groups.setdefault(c.get("group", ""), []).append(tone[c["id"]][0])
    ref = {g: np.median(np.array(v), axis=0) for g, v in groups.items() if len(v) >= 3}
    for c in clips:
        g = c.get("group", "")
        if c["id"] not in tone or g not in ref or tone[c["id"]][1] < 20:
            continue
        dv = tone[c["id"]][0] - ref[g]
        words = []
        if abs(dv[2]) > tol:
            words.append("%s by %.1f dB (2-6 kHz)" % ("brighter" if dv[2] > 0 else "duller", abs(dv[2])))
        if abs(dv[0]) > tol:
            words.append("%s by %.1f dB (under 200 Hz)" % ("boomier" if dv[0] > 0 else "thinner", abs(dv[0])))
        if words:
            out.append({"t": c["start"], "end": c["end"], "kind": "tone", "clipId": c["id"],
                        "text": "tone: %s than this speaker's other clips (%s)" % (", ".join(words), who(c))})
    for x, y in zip(clips, clips[1:]):
        if x.get("group") != y.get("group") or not -0.05 <= y["start"] - x["end"] < 1.0 or x["id"] not in tone or y["id"] not in tone:
            continue
        dv = tone[y["id"]][0][2] - tone[x["id"]][0][2]
        if abs(dv) > tol:
            out.append({"t": y["start"], "end": None, "kind": "tone at cut", "clipId": y["id"],
                        "text": "tone changes at the cut: %.1f dB %s after it (2-6 kHz, %s)" % (abs(dv), "brighter" if dv > 0 else "duller", who(y))})
    return out


def mix_spots(mx, fm, sp, clips, n, mix_db, bed_db):
    """Spots where the background under the voice changes at a voice cut."""
    nm = min(n, len(mx), len(fm))
    lin = lambda v: 10 ** (np.nan_to_num(v, nan=-150.0) / 10)
    out = []
    def em(arr, a, b, mask=None):
        a, b = max(0, a), min(nm, b)
        if b <= a: return None
        v = arr[a:b] if mask is None else arr[a:b][mask[a:b]]
        return None if len(v) < 5 else float(10 * np.log10(np.mean(lin(v))))
    bed = 10 * np.log10(np.maximum(lin(mx[:nm]) - lin(fm[:nm]), 1e-15))
    pause = ~sp[:nm]
    for x, y in zip(clips, clips[1:]):
        if not -0.05 <= y["start"] - x["end"] < 1.0:
            continue
        i = int(round(y["start"] / 0.1))
        words = []
        m0, m1, v0, v1 = em(mx, i - 10, i), em(mx, i + 4, i + 14), em(fm, i - 10, i), em(fm, i + 4, i + 14)
        if None not in (m0, m1, v0, v1) and abs(m1 - m0) > mix_db and abs((m1 - m0) - (v1 - v0)) > mix_db:
            words.append("the whole mix gets %.1f dB %s" % (abs(m1 - m0), "louder" if m1 > m0 else "quieter"))
        b0, b1 = em(bed, i - 30, i, pause), em(bed, i + 4, i + 34, pause)
        if b0 is not None and b1 is not None and max(b0, b1) > -60 and abs(b1 - b0) > bed_db:
            words.append("the sound under the voice stops" if b1 < -60 else "the sound under the voice starts" if b0 < -60 else
                         "the sound under the voice gets %.1f dB %s" % (abs(b1 - b0), "louder" if b1 > b0 else "quieter"))
        if words:
            out.append({"t": y["start"], "end": None, "kind": "background", "clipId": y["id"],
                        "text": "background changes here: " + ", ".join(words)})
    return out


def thin(t, g, tol):
    """Fewest points whose straight lines stay within tol dB of the curve (Douglas-Peucker)."""
    keep, stack = {0, len(t) - 1}, [(0, len(t) - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        line = g[a] + (g[b] - g[a]) * (t[a + 1:b] - t[a]) / max(t[b] - t[a], 1e-9)
        err = np.abs(g[a + 1:b] - line)
        i = int(err.argmax())
        if err[i] > tol:
            m = a + 1 + i
            keep.add(m)
            stack += [(a, m), (m, b)]
    k = sorted(keep)
    return t[k], g[k]


def main():
    job = json.load(sys.stdin)
    mode = job.get("mode")
    res = blocks(job) if mode == "blocks" else phrases(job) if mode == "phrases" else level(job) if mode == "level" else check(job) if mode == "check" else bed(job) if mode == "bed" else stats(job)
    json.dump(res, sys.stdout)


if __name__ == "__main__":
    main()
