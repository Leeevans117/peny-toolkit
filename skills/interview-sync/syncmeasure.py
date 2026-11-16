#!/usr/bin/env python3
"""Sync Interviews: line every clip of an interview timeline up by waveform (Peny Toolkit).

Like Premiere's Synchronize (audio), but for every clip on the sequence in one go. The
clips on the lowest video track that has clips (camera A) are the references and stay
where they are; every other clip (camera B, C..., external recorder wavs, any audio-only
clip) is measured against them and given the start that puts its sound on theirs.

Reading (the slow part: the sound sits between the pictures, so ffmpeg reads the file's
bytes; Whistler, 29 Oct 2026: 415 GB and 26 min reading every file whole):
  - Sound source per clip: an audio file as it is; else the attached proxy if it has sound
    (for a non-RED clip only after a 10 s window of proxy and original matched to the
    sample, else the original); RED (.R3D) only from its proxy.
  - Only one side of each comparison is read whole: the side with fewer bytes per second
    (Whistler: the Canon proxies, 1.8 MB/s); the other side gives 3 pieces of 60 s (2 for
    a clip under 3 min, the whole clip under 72 s), each read with a seek. 4 reads run at
    once, and the pictures are passed through to nowhere (-c copy -f null), which makes
    ffmpeg read straight through instead of skipping about (2-3x faster on the G-SPEED).
    The biggest reads start first.
  - Each file + range is read once.

Measuring (GCC-PHAT, 2 kHz, as Sync external audio; tested on Lee's Whistler interview,
29 Oct 2026: RED A086 vs Canon C379 15.10 s, eleven 60 s windows over 44 min agreed to
14 ms with a slow clock drift of 6 ms per 20 min):
  - Every audio stream is decoded separately; exact copies and silent channels are dropped
    and the loudest remaining channel is used.
  - Each piece is looked for in the whole-read clip of the pair (a piece of the clip being
    placed in every camera A clip, or a piece of each camera A clip in the clip being
    placed). A clip is placed when 2 pieces agree within 40 ms with a peak at least 2
    times the next best, or, when the piece side has one piece only, the peak is at least
    6 times the next best and the second-loudest channel agrees within 40 ms (10 alone).
  - A clip that no reference covers (camera A was stopped) is then looked for in the clips
    already placed (second pass), so camera B can carry an external wav on its own.
  - A camera clip still unplaced (its sound is hiss, e.g. the mic not plugged in) is then
    matched by picture: movement per frame against camera A's clips (see vmatch).
Timecode is a fallback only: on Whistler the RED and Canon clocks were 3 min apart and the
RED's jumped between clips, so it never overrides the waveform. When a clip finds no
waveform match but both it and a placed clip of the other camera have timecode, the
offset between the two clocks seen on matched clips predicts it; that is used only if
at least 2 matched clips of the track agree on that offset within CLOCK_TOL (otherwise the
clip is left). A clip no camera A clip overlaps by clock anchors its own group, laid GAP s
after everything before it, and the clips around it are lined up to it by timecode.

Layout: each reference clip with everything placed against it is one group. Groups keep
their order; a group is moved later only when it would start before 0 or run into the
group before it (then it starts GAP s after it). Clips that could not be placed stay where
they are (their own group). A clip that would land on another clip on its track is left
where it is and reported.

Input (stdin JSON): {ffmpeg, fps, gap, units: [{id, name, kind: "video"|"audio", track,
start, inPoint, duration, media, proxy (paths or null; "path" alone is read as media),
tc (seconds or null), ref: bool}]}
Output (stdout JSON): {units: [{id, name, synced, newStart, shift, group, how, reason, source}],
groups, timing}. Progress lines on stderr.
"""
import json, os, signal, subprocess, sys, tempfile, threading, time
from concurrent.futures import ThreadPoolExecutor
import numpy as np

SR = 2000
PIECE = 60.0
VERIFY = 10.0
WORKERS = 4
MIN_SECONDS = 2.0
AGREE = 0.04
GAP = 5.0
AUDIO_EXT = (".wav", ".bwf", ".mp3", ".aif", ".aiff", ".m4a")
# Picture sync (11 Nov 2026, EOY IV: the RED's mic wasn't plugged in, its sound is hiss).
# Movement per frame (64x36 grey, frame-to-frame difference) of a camera clip that found no
# waveform match, against camera A's. Tested on RED A001-A004 vs FX6: 10 pieces of 120 s,
# every one within 0.04 s of the others in its clip.
VPIECE = 120.0
VAGREE = 0.065
VRATIO = 1.8
# Clock model: one offset per track to camera A's clock, learnt from matched clips; used only
# when all of a track's matched clips agree within CLOCK_TOL (catches clock jumps, Whistler).
CLOCK_TOL = 0.25
# Reference check (16 Nov 2026, EOY IV Day 3: camera A was the RED again with only hiss, and
# no reference = 6:42 of reading for nothing). Spread between loud and quiet moments of a
# clip's best channel (0.25 s windows, 90th - 10th percentile, dB): speech/room sound
# measured 50+ dB on FX6 and Rode wavs, the unplugged RED mic 8-10 dB.
SOUND_DB = 20.0
SOUND_PIECE = 20.0
MIN_OVERLAP = 2.0

_procs, _plock = set(), threading.Lock()


def say(msg):
    sys.stderr.write(msg + "\n"); sys.stderr.flush()


def _stop(signum, frame):
    # Cancel: the panel kills this process; take the ffmpeg reads down with it.
    with _plock:
        for p in list(_procs):
            try: p.kill()
            except Exception: pass
    os._exit(143)


def run(cmd):
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    with _plock: _procs.add(p)
    out, err = p.communicate()
    with _plock: _procs.discard(p)
    return p.returncode, out, err


_probed, _qlock = {}, threading.Lock()


def probe(ffmpeg, path):
    """{audio: number of audio streams, video: bool, duration, size} of path (cached)."""
    with _qlock:
        if path in _probed: return _probed[path]
    ffprobe = os.path.join(os.path.dirname(ffmpeg), "ffprobe")
    code, out, _ = run([ffprobe, "-v", "error", "-show_entries", "stream=codec_type,r_frame_rate:format=duration", "-of", "json", path])
    info = {"audio": 0, "video": False, "duration": 0.0, "size": 0, "fps": 0.0}
    if code == 0:
        try:
            j = json.loads(out.decode())
            kinds = [s.get("codec_type") for s in j.get("streams", [])]
            info["audio"] = kinds.count("audio")
            info["video"] = "video" in kinds
            info["duration"] = float(j.get("format", {}).get("duration") or 0)
            for st in j.get("streams", []):
                if st.get("codec_type") == "video" and "/" in str(st.get("r_frame_rate")):
                    a, b = st["r_frame_rate"].split("/")
                    if float(b) > 0 and float(a) > 0: info["fps"] = float(a) / float(b); break
        except Exception: pass
    try: info["size"] = os.path.getsize(path)
    except OSError: pass
    with _qlock: _probed[path] = info
    return info


def decode(ffmpeg, path, start, dur, tmp):
    """{stream: signal} for every audio stream of path over [start, start+dur], 2 kHz, in
    one read (-ss before -i: a seek). An MXF seek to a time between two frames lands up to
    half a frame late (Canon C50 MXF, 29 Oct 2026: 871.392 s came back 8 ms late; MOV and
    the RED proxies were exact), so the seek goes to the frame at or before start and the
    samples before start are dropped; checked to the sample against whole reads."""
    info = probe(ffmpeg, path)
    n = min(info["audio"], 16)
    if not n: return {}
    start = round(max(start, 0.0) * SR) / SR
    seek = start
    if info["fps"] > 0: seek = np.floor(start * info["fps"] + 1e-6) / info["fps"]
    drop = int(round((start - seek) * SR))
    dur += drop / SR
    d = tempfile.mkdtemp(dir=tmp)
    cmd = [ffmpeg, "-v", "error", "-nostdin", "-y"]
    if seek > 0: cmd += ["-ss", "%.6f" % seek]
    cmd += ["-i", path]
    files = []
    for s in range(n):
        f = os.path.join(d, "a%d.f32" % s)
        files.append(f)
        cmd += ["-t", "%.4f" % dur, "-map", "0:a:%d" % s, "-ac", "1", "-ar", str(SR), "-f", "f32le", f]
    if info["video"]: cmd += ["-t", "%.4f" % dur, "-map", "0:v:0?", "-c", "copy", "-f", "null", "-"]
    run(cmd)
    out = {}
    for s, f in enumerate(files):
        if os.path.exists(f):
            out[s] = np.fromfile(f, dtype=np.float32).astype(np.float64)[drop:]
            os.remove(f)
    try: os.rmdir(d)
    except OSError: pass
    return out


def pick_channels(chans):
    """Distinct, non-silent channels, loudest first."""
    keep = []
    for s in sorted(chans):
        c = chans[s]
        if len(c) < MIN_SECONDS * SR: continue
        rms = float(np.sqrt(np.mean(c * c)))
        if rms < 1e-5: continue
        cn = c / (np.linalg.norm(c) or 1)
        if any(len(k[2]) == len(cn) and abs(float(np.dot(cn, k[2]))) > 0.999 for k in keep): continue
        keep.append((rms, s, cn, c))
    keep.sort(key=lambda k: -k[0])
    return [(k[1], k[3]) for k in keep]


_spec = {}


def gcc(sig, piece, key=None):
    """Lag (samples) of piece inside sig (piece[0] at sig[lag]) and peak / next-best ratio.
    Only lags where the piece overlaps sig by at least half its length count. key: cache
    sig's spectrum under it (one whole-read clip is searched by many pieces)."""
    n = 1 << int(np.ceil(np.log2(len(sig) + len(piece))))
    S = _spec.get((key, n)) if key is not None else None
    if S is None:
        S = np.fft.rfft(sig, n)
        if key is not None: _spec[(key, n)] = S
    R = S * np.conj(np.fft.rfft(piece, n))
    R /= np.maximum(np.abs(R), 1e-12)
    r = np.fft.irfft(R, n)
    lags = np.arange(n); lags[lags > n // 2] -= n
    half = len(piece) // 2
    m = (lags >= -half) & (lags <= len(sig) - half)
    idx = np.where(m)[0]
    if not len(idx): return None, 0.0
    v = r[idx]
    b = int(np.argmax(v))
    far = np.abs(np.arange(len(v)) - b) > int(0.05 * SR)
    second = v[far].max() if far.any() else 0.0
    return int(lags[idx[b]]), float(v[b] / second) if second > 0 else 99.0


def piece_spans(L):
    """(offset, length) of the pieces of a range L s long."""
    if L <= PIECE * 1.2: return [(0.0, L)]
    n = 3 if L >= PIECE * 3 else 2
    return [(round((L - PIECE) * (k + 0.5) / n * SR) / SR, PIECE) for k in range(n)]


def match(u, cands):
    """Best agreed lag of u against the candidate units. Returns (cand, L, how) or None,
    reason. L: u's source time y sits at the candidate's source time y + L. Each pair is
    compared with the pieces of one side inside the whole-read other side."""
    votes = []  # (cand index, L, ratio, label, piece side has one piece)
    upieces = u["pieces"]
    full_c = [ci for ci, c in enumerate(cands) if c["full"] and len(c["sig"]) >= SR * MIN_SECONDS]
    if full_c:
        for k, (off, pch) in enumerate(upieces):
            best = None
            for ci in full_c:
                c = cands[ci]
                lag, ratio = gcc(c["sig"], pch[0][1], c["id"])
                if lag is None: continue
                L = (c["inPoint"] + lag / SR) - (u["inPoint"] + off)
                if best is None or ratio > best[2]: best = (ci, L, ratio, "piece %d" % (k + 1), len(upieces) == 1)
            if best: votes.append(best)
    if u["full"] and len(u["sig"]) >= SR * MIN_SECONDS:
        for ci, c in enumerate(cands):
            if ci in full_c: continue
            for k, (off, pch) in enumerate(c["pieces"]):
                lag, ratio = gcc(u["sig"], pch[0][1], u["id"])
                if lag is None: continue
                L = (c["inPoint"] + off) - (u["inPoint"] + lag / SR)
                votes.append((ci, L, ratio, "%s piece %d" % (c["name"], k + 1), len(c["pieces"]) == 1))
    if not votes: return None, "nothing to compare with"
    detail = ", ".join("%s: %s %+.3f s ratio %.1f" % (v[3], cands[v[0]]["name"], v[1], v[2]) for v in votes)
    for i in range(len(votes)):
        for j in range(i + 1, len(votes)):
            a, b = votes[i], votes[j]
            # Two separate pieces landing within 40 ms of each other in clips thousands
            # of seconds long can't happen by chance, so a modest peak (2) is enough.
            if a[0] == b[0] and abs(a[1] - b[1]) <= AGREE and min(a[2], b[2]) >= 2:
                L = a[1] if a[2] >= b[2] else b[1]
                same = [v for v in votes if v[0] == a[0]]
                return (cands[a[0]], L, "%d of %d pieces agree in %s (%.0f ms apart, ratios %.1f/%.1f)" %
                        (sum(1 for v in same if abs(v[1] - L) <= AGREE), len(same),
                         cands[a[0]]["name"], abs(a[1] - b[1]) * 1000, a[2], b[2])), detail
    singles = [v for v in votes if v[4]]
    if not singles: return None, "pieces disagree (" + detail + ")"
    v = max(singles, key=lambda x: x[2])
    c = cands[v[0]]
    if v[2] < 6: return None, "weak match (" + detail + ")"
    # One piece: confirm with the second channel of the piece side.
    if v[3].startswith("piece"):
        full, other, sign = c, (u["chans"] if u["full"] else u["pieces"][0][1]), 1
    else:
        full, other, sign = u, c["pieces"][0][1], -1
    if len(other) > 1:
        lag, ratio = gcc(full["sig"], other[1][1], full["id"])
        if lag is not None:
            L2 = (c["inPoint"] + lag / SR) - u["inPoint"] if sign > 0 else c["inPoint"] - (u["inPoint"] + lag / SR)
            if abs(L2 - v[1]) <= AGREE and ratio >= 3:
                return (c, v[1], "strong match in %s (ratio %.1f), second channel agrees (%.0f ms)" % (c["name"], v[2], abs(L2 - v[1]) * 1000)), detail
            return None, "strong match in %s but second channel disagrees (%s)" % (c["name"], detail)
    if v[2] >= 10:
        return (c, v[1], "strong match in %s (ratio %.1f, one channel)" % (c["name"], v[2])), detail
    return None, "one channel only and not strong enough (" + detail + ")"


def motion(ffmpeg, path, start, dur, fps):
    """Movement per frame of path over [start, start+dur] at fps: log of the mean absolute
    difference between one 64x36 grey frame and the one before (value k = frame k vs k-1)."""
    W, H = 64, 36
    cmd = [ffmpeg, "-v", "error", "-nostdin"]
    if start > 0: cmd += ["-ss", "%.6f" % start]
    cmd += ["-t", "%.4f" % dur, "-i", path, "-an", "-sn", "-dn", "-vf", "scale=%d:%d:flags=area,format=gray" % (W, H),
            "-r", "%.6f" % fps, "-f", "rawvideo", "-"]
    code, out, _ = run(cmd)
    n = len(out) // (W * H)
    if n < 3: return np.zeros(0)
    a = np.frombuffer(out[:n * W * H], dtype=np.uint8).reshape(n, H, W).astype(np.float32)
    d = np.abs(np.diff(a, axis=0)).mean(axis=(1, 2))
    return np.log1p(np.concatenate([[0.0], d])).astype(np.float64)


def vpiece_spans(L):
    """(offset, length) of the picture pieces of a range L s long: 3 of 120 s, or 2 halves-ish."""
    if L >= VPIECE * 3: return [(round((L - VPIECE) * (k + 0.5) / 3, 2), VPIECE) for k in range(3)]
    ln = min(VPIECE, L / 2.2)
    if ln < 20: return []
    return [(round((L - ln) * (k + 0.5) / 2, 2), ln) for k in range(2)]


def vfeat(x):
    """Movement made comparable: minus its 1 s average (lighting drifts), in robust standard
    deviations, clipped at 3 so one bump or someone walking past can't outweigh the rest.
    EOY IV test: without this, big bumps beat the true match in 1 of 3 RED clips."""
    if len(x) < 30: return x
    x = x - np.convolve(x, np.ones(25) / 25, "same")
    m = np.median(x)
    d = np.median(np.abs(x - m)) * 1.4826 or 1.0
    return np.clip((x - m) / d, -3, 3)


def vxc(sig, piece):
    """Lag (frames) of piece inside sig, its score and the best score more than 1 s away
    (cross-correlation; lags where the piece overlaps sig by at least half its length)."""
    if len(sig) < 10 or len(piece) < 10: return None, 0.0, 0.0
    p = (piece - piece.mean()) / (piece.std() or 1)
    n = 1 << int(np.ceil(np.log2(len(sig) + len(p))))
    r = np.fft.irfft(np.fft.rfft(sig, n) * np.conj(np.fft.rfft(p, n)), n) / len(p)
    lags = np.arange(n); lags[lags > n // 2] -= n
    half = len(p) // 2
    idx = np.where((lags >= -half) & (lags <= len(sig) - half))[0]
    if not len(idx): return None, 0.0, 0.0
    v = r[idx]
    b = int(np.argmax(v))
    far = np.abs(np.arange(len(v)) - b) > 25
    return int(lags[idx[b]]), float(v[b]), float(v[far].max()) if far.any() else 0.0


def picture_src(u):
    """File to read u's picture from: the proxy, else the media (not for audio clips)."""
    if u["kind"] != "video": return None
    for p in (u.get("proxy"), u.get("media")):
        if p and os.path.exists(p): return p
    return None


def vmatch(u, upieces, cands, curve, fps):
    """Picture match of u against the candidate clips: each piece of u (offset, movement) is
    looked for in the whole of every candidate. 2 pieces in the same candidate within VAGREE,
    each with a ratio of at least VRATIO. Returns (cand, L, how) or None, reason."""
    votes = []
    for k, (off, pu) in enumerate(upieces):
        hits = []
        for ci, c in enumerate(cands):
            lag, top, second = vxc(curve(c), pu)
            if lag is not None: hits.append((top, second, ci, lag))
        if not hits: continue
        # Ratio: the best peak against the next best anywhere (same clip more than 1 s away, or
        # any other camera A clip). EOY IV: true matches 2.8-4.5, wrong ones about 1.1.
        hits.sort(key=lambda h: -h[0])
        top, second, ci, lag = hits[0]
        if len(hits) > 1: second = max(second, hits[1][0])
        c = cands[ci]
        # u's source time (inPoint + off) sits at c's source time (inPoint + lag / fps).
        L = (c["inPoint"] + lag / fps) - (u["inPoint"] + off)
        votes.append((ci, L, top / second if second > 0 else 99.0, "piece %d" % (k + 1)))
    if not votes: return None, "picture: nothing to compare with"
    detail = ", ".join("%s: %s %+.2f s ratio %.2f" % (v[3], cands[v[0]]["name"], v[1], v[2]) for v in votes)
    best = None
    for i in range(len(votes)):
        for j in range(i + 1, len(votes)):
            a, b = votes[i], votes[j]
            if a[0] == b[0] and abs(a[1] - b[1]) <= VAGREE and min(a[2], b[2]) >= VRATIO:
                if best is None or a[2] + b[2] > best[0]: best = (a[2] + b[2], a)
    if not best: return None, "picture: pieces disagree (" + detail + ")"
    a = best[1]
    same = [v for v in votes if v[0] == a[0] and abs(v[1] - a[1]) <= VAGREE]
    L = float(np.median([v[1] for v in same]))
    return (cands[a[0]], L, "picture: %d of %d pieces agree in %s (%.0f ms apart, ratios %s)" %
            (len(same), len(votes), cands[a[0]]["name"], (max(v[1] for v in same) - min(v[1] for v in same)) * 1000,
             "/".join("%.1f" % v[2] for v in same))), detail


def choose_sources(ffmpeg, units, tmp, pool):
    """u["src"] and u["source"] (how) per unit; non-RED proxies checked against their original."""
    paths = set()
    for u in units:
        if u.get("media"): paths.add(u["media"])
        if u.get("proxy"): paths.add(u["proxy"])
    list(pool.map(lambda p: probe(ffmpeg, p), sorted(paths)))
    checks = {}
    for u in units:
        m, p = u.get("media"), u.get("proxy")
        if m and probe(ffmpeg, m)["audio"] == 0: m = None
        if p and probe(ffmpeg, p)["audio"] == 0: p = None
        u["_m"], u["_p"] = m, p
        if m and p and not m.lower().endswith(AUDIO_EXT) and probe(ffmpeg, m)["video"]:
            checks.setdefault((m, p), u)
    def check(key):
        m, p = key
        u = checks[key]
        at = u["inPoint"] + 0.3 * max(u["duration"] - VERIFY, 0)
        a, b = decode(ffmpeg, m, at, VERIFY, tmp), decode(ffmpeg, p, at, VERIFY, tmp)
        ch = pick_channels(a)
        if not ch or ch[0][0] not in b: return key, False, "no sound to compare"
        s = ch[0][0]
        lag, ratio = gcc(b[s], a[s][int(1 * SR):int((VERIFY - 1) * SR)])
        ok = lag is not None and abs(lag - SR) <= 2 and ratio >= 6
        return key, ok, "lag %s ms, ratio %.1f" % ("?" if lag is None else "%.1f" % ((lag - SR) * 1000.0 / SR), ratio)
    t0 = time.time()
    if checks: say("Checking %d proxy/proxies against the original" % len(checks))
    verdict = {k: (ok, why) for k, ok, why in pool.map(check, list(checks))}
    for u in units:
        m, p = u.pop("_m"), u.pop("_p")
        if m and (m.lower().endswith(AUDIO_EXT) or not probe(ffmpeg, m)["video"]):
            u["src"], u["source"] = m, "audio file"
        elif m and p:
            ok, why = verdict[(m, p)]
            u["src"], u["source"] = (p, "proxy (matches the original: %s)" % why) if ok else (m, "original (proxy doesn't match it: %s)" % why)
        elif p:
            u["src"], u["source"] = p, "proxy"
        elif m:
            u["src"], u["source"] = m, "original"
        else:
            u["src"], u["source"] = None, "no sound"
    return time.time() - t0


def sound_spread(ffmpeg, u, tmp):
    """dB between loud and quiet moments (see SOUND_DB) of u's best channel, from 3 short
    pieces; 0 when u has no sound source at all."""
    if not u.get("src"): return 0.0
    L = u["duration"]
    ln = min(SOUND_PIECE, L / 3.5)
    if ln < MIN_SECONDS: return 0.0
    best = 0.0
    for k in range(3):
        ch = decode(ffmpeg, u["src"], u["inPoint"] + (L - ln) * (k + 0.5) / 3, ln, tmp)
        for c in ch.values():
            w = int(0.25 * SR)
            n = len(c) // w
            if n < 8: continue
            r = np.sqrt(np.mean(c[:n * w].reshape(n, w) ** 2, axis=1)) + 1e-9
            db = 20 * np.log10(r)
            best = max(best, float(np.percentile(db, 90) - np.percentile(db, 10)))
    return best


def choose_reference(ffmpeg, units, tmp, pool):
    """Keep camera A as the reference when its sound is usable; otherwise make the lowest
    other track with usable sound (another camera first, then a sound-only track) the
    reference, and camera A is placed against it (picture, then timecode). Returns a note
    for the log, or raises SystemExit with a reason when no track has usable sound."""
    tracks = {}
    for u in units: tracks.setdefault((u["kind"], u["track"]), []).append(u)
    def usable(key):
        us = tracks[key]
        spreads = list(pool.map(lambda u: sound_spread(ffmpeg, u, tmp), us))
        for u, sp in zip(us, spreads): u["spread"] = round(sp, 1)
        return sum(1 for sp in spreads if sp >= SOUND_DB) * 2 > len(us), max(spreads or [0.0])
    refkey = next((k for k, us in tracks.items() if any(u.get("ref") for u in us)), None)
    if refkey is None: raise SystemExit("no reference track")
    ok, sp = usable(refkey)
    name = ("V" if refkey[0] == "video" else "A") + str(refkey[1] + 1)
    if ok: return None
    order = sorted([k for k in tracks if k != refkey], key=lambda k: (k[0] != "video", k[1]))
    for k in order:
        ok2, sp2 = usable(k)
        if not ok2: continue
        for u in units:
            if u.get("ref"):
                u["ref"], u["placed"], u["how"] = False, False, ""
                u["reason"] = "its sound is unusable (%.0f dB between loud and quiet, needs %.0f)" % (u.get("spread", 0), SOUND_DB) if u.get("src") else "no sound to read (no proxy)"
        for u in tracks[k]: u["ref"], u["placed"], u["how"] = True, True, "reference (stays): camera A has no usable sound"
        new = ("V" if k[0] == "video" else "A") + str(k[1] + 1)
        return "%s has no usable sound (best %.0f dB between loud and quiet, needs %.0f: mic not plugged in?), so %s (%.0f dB) is the reference instead" % (name, sp, SOUND_DB, new, sp2)
    raise SystemExit("No track on this sequence has usable sound (camera A %s best %.0f dB between loud and quiet, needs %.0f), so there is nothing to sync to. Nothing was read in full or changed." % (name, sp, SOUND_DB))


def bps(ffmpeg, u):
    i = probe(ffmpeg, u["src"]) if u.get("src") else None
    return i["size"] / i["duration"] if i and i["duration"] > 0 else 1e12


def main():
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    job = json.load(sys.stdin)
    ffmpeg, fps = job["ffmpeg"], float(job.get("fps") or 25)
    gap = float(job.get("gap", GAP))
    frame = 1.0 / fps
    units = job["units"]
    for u in units:
        if "media" not in u and "proxy" not in u: u["media"], u["proxy"] = u.get("path"), None
        u["placed"], u["how"], u["reason"] = bool(u.get("ref")), "camera A (stays)" if u.get("ref") else "", ""
        u["parent"], u["L"] = None, 0.0
        u["full"], u["chans"], u["sig"], u["pieces"] = False, [], np.zeros(0), []
    tmp = tempfile.mkdtemp(prefix="peny-sync-")
    T0 = time.time()
    pool = ThreadPoolExecutor(WORKERS)
    t_check = choose_sources(ffmpeg, units, tmp, pool)
    t = time.time()
    try:
        note = choose_reference(ffmpeg, units, tmp, pool)
    except SystemExit as e:
        say(str(e))
        json.dump({"error": str(e)}, sys.stdout)
        return
    say("Sound check %.1f s%s" % (time.time() - t, ": " + note if note else ""))
    refs = [u for u in units if u.get("ref")]
    others = [u for u in units if not u.get("ref")]
    # One read per file + range (loose camera audio on 4 tracks is one read), whole or as
    # pieces. Which side is read whole: the cheaper total (bytes per second x seconds).
    rate = {id(u): bps(ffmpeg, u) for u in units}
    reads = {}
    for u in units:
        if not u.get("src"): continue
        key = (u["src"], round(u["inPoint"], 3), round(u["duration"], 3))
        r = reads.setdefault(key, {"units": [], "full": False, "name": u["name"], "src": u["src"], "inPoint": u["inPoint"],
                                   "duration": u["duration"], "rate": rate[id(u)], "ref": False})
        r["units"].append(u)
        r["ref"] = r["ref"] or bool(u.get("ref"))
    def whole(rs): return sum(r["rate"] * r["duration"] for r in rs)
    def bits(rs): return sum(r["rate"] * min(r["duration"], PIECE * 3) for r in rs)
    rr = [r for r in reads.values() if r["ref"]]
    ro = [r for r in reads.values() if not r["ref"]]
    refs_full = whole(rr) + bits(ro) <= bits(rr) + whole(ro)
    cheapest_ref = min([r["rate"] for r in rr] or [1e12])
    for r in reads.values():
        r["full"] = refs_full if r["ref"] else ((not refs_full) or r["rate"] <= cheapest_ref)
    say("Proxy check %.1f s; whole reads %.1f GB, pieces %.1f GB" % (t_check,
        sum(r["rate"] * r["duration"] for r in reads.values() if r["full"]) / 1e9,
        sum(r["rate"] * min(r["duration"], PIECE * 3) for r in reads.values() if not r["full"]) / 1e9))
    # Biggest first, so the longest read isn't the last to start.
    keys = sorted(reads, key=lambda k: -reads[k]["rate"] * (reads[k]["duration"] if reads[k]["full"] else min(reads[k]["duration"], PIECE * 3)))
    done = [0]
    lock = threading.Lock()
    def read(key):
        r = reads[key]
        t = time.time()
        if r["full"]:
            r["data"] = decode(ffmpeg, r["src"], r["inPoint"], r["duration"], tmp)
            what = "whole (%.0f s)" % r["duration"]
        else:
            r["data"] = [(off, decode(ffmpeg, r["src"], r["inPoint"] + off, ln, tmp)) for off, ln in piece_spans(r["duration"])]
            what = "%d piece(s) of %.0f s" % (len(r["data"]), min(PIECE, r["duration"]))
        with lock:
            done[0] += 1
            say("Read %d/%d %s, %s, in %.1f s" % (done[0], len(keys), r["name"], what, time.time() - t))
    say("Reading %d file(s), %d at a time: %s read whole" % (len(keys), WORKERS, "camera A" if refs_full else "the other clips"))
    t1 = time.time()
    list(pool.map(read, keys))
    t_read = time.time() - t1
    t2 = time.time()
    for key in keys:
        r = reads[key]
        for u in r["units"]:
            if r["full"]:
                u["full"] = True
                u["chans"] = pick_channels(r["data"])
                u["sig"] = u["chans"][0][1] if u["chans"] else np.zeros(0)
                u["pieces"] = []
                for off, ln in piece_spans(len(u["sig"]) / SR if len(u["sig"]) else u["duration"]):
                    a = int(off * SR)
                    pch = [(s, c[a:a + int(ln * SR)]) for s, c in u["chans"]]
                    if pch: u["pieces"].append((a / SR, pch))
            else:
                u["full"] = False
                u["pieces"] = [(off, pick_channels(ch)) for off, ch in r["data"]]
                u["pieces"] = [p for p in u["pieces"] if p[1]]
                u["sig"] = u["pieces"][0][1][0][1] if u["pieces"] else np.zeros(0)
    def read_whole(u):
        # Pass 2 needs one whole side; read it now (cheaper one is chosen by the caller).
        t = time.time()
        u["chans"] = pick_channels(decode(ffmpeg, u["src"], u["inPoint"], u["duration"], tmp))
        u["sig"] = u["chans"][0][1] if u["chans"] else np.zeros(0)
        u["full"] = True
        say("Read %s whole for the second pass in %.1f s" % (u["name"], time.time() - t))
    def has_sound(u): return bool(u["pieces"]) or len(u["sig"]) > 0
    # Pass 1: every other clip against the references; pass 2: unplaced against placed others.
    measured = {}
    for pas in (1, 2):
        for u in others:
            if u["placed"]: continue
            if not has_sound(u):
                u["reason"] = "no sound to measure" if u.get("src") else "media file could not be read"
                continue
            cands = refs if pas == 1 else [c for c in others if c["placed"] and c["track"] != u["track"]]
            cands = [c for c in cands if has_sound(c)]
            if not cands:
                if pas == 1: u["reason"] = "no reference clip with sound to compare with"
                continue
            if pas == 2 and not u["full"]:
                for c in cands:
                    if not c["full"]:
                        if rate[id(u)] * u["duration"] <= rate[id(c)] * c["duration"]: read_whole(u); break
                        read_whole(c)
            # Loose camera audio on 4 tracks is one sound: measured once.
            mkey = (u.get("src"), round(u["inPoint"], 3), round(u["duration"], 3), pas, tuple(c["id"] for c in cands))
            if mkey in measured:
                got, detail = measured[mkey]
            else:
                say("Measuring %s (pass %d)" % (u["name"], pas))
                got, detail = measured[mkey] = match(u, cands)
            if got:
                c, L, how = got
                u.update(placed=True, parent=c, L=L, how=how, reason="")
            elif pas == 1 or not u["reason"]:
                u["reason"] = detail
    # Picture pass: a camera clip still unplaced (no sound, or sound that matches nothing) is
    # looked for by movement in camera A's clips, then in camera clips already placed.
    t_pic = time.time()
    need = [u for u in others if not u["placed"] and picture_src(u)]
    vrefs = [c for c in refs if picture_src(c)]
    if need and vrefs:
        curves, vp = {}, {}
        def curve_read(u):
            t = time.time()
            curves[u["id"]] = vfeat(motion(ffmpeg, picture_src(u), u["inPoint"], u["duration"], fps))
            say("Read the picture of %s whole (%.0f s) in %.1f s" % (u["name"], u["duration"], time.time() - t))
        def pieces_read(u):
            t = time.time()
            vp[u["id"]] = [(off, vfeat(m)) for off, m in ((off, motion(ffmpeg, picture_src(u), u["inPoint"] + off, ln, fps))
                                                   for off, ln in vpiece_spans(u["duration"])) if len(m) > 10]
            say("Read %d picture piece(s) of %s in %.1f s" % (len(vp[u["id"]]), u["name"], time.time() - t))
        say("Picture sync: %d camera clip(s) with no waveform match; reading the movement of camera A whole and pieces of those" % len(need))
        jobs = [(curve_read, c) for c in vrefs] + [(pieces_read, u) for u in need]
        list(pool.map(lambda j: j[0](j[1]), sorted(jobs, key=lambda j: -j[1]["duration"])))
        def curve(x):
            if x["id"] not in curves: curve_read(x)
            return curves[x["id"]]
        for pas in (1, 2):
            for u in need:
                if u["placed"] or len(vp.get(u["id"], [])) < 2: continue
                cands = vrefs if pas == 1 else [c for c in others if c["placed"] and c["kind"] == "video" and c["track"] != u["track"] and picture_src(c)]
                if not cands: continue
                say("Matching the picture of %s (pass %d)" % (u["name"], pas))
                got, detail = vmatch(u, vp[u["id"]], cands, curve, fps)
                if got:
                    c, L, how = got
                    u.update(placed=True, parent=c, L=L, how=how, reason="")
                elif pas == 1:
                    u["reason"] = (u["reason"] + "; " if u["reason"] else "") + detail
    t_pic = time.time() - t_pic
    t_match = time.time() - t2
    pool.shutdown()
    # Timecode (clock model). Each track's clock offset to camera A's clock is learnt from its
    # matched clips (chained through the clip each was matched to), and used only when at
    # least 2 of them agree within CLOCK_TOL: a clock that jumps between clips (the RED on
    # Whistler) is never used. dA[track]: camera A's clock = this clock + dA at one moment.
    # tc = timecode at the media's first frame, so a moment's clock = tc + source time.
    def tkey(u): return (u["kind"], u["track"])
    dA, nA = {}, {}
    for r in refs: dA[tkey(r)], nA[tkey(r)] = 0.0, 0
    for _ in range(4):
        samples = {}
        for u in others:
            p = u["parent"]
            if u["placed"] and p is not None and u.get("tc") is not None and p.get("tc") is not None and tkey(p) in dA and tkey(u) not in dA:
                samples.setdefault(tkey(u), []).append(p["tc"] + u["L"] - u["tc"] + dA[tkey(p)])
        new = False
        for k, s in samples.items():
            if len(s) >= 2 and max(s) - min(s) <= CLOCK_TOL:
                dA[k], nA[k], new = float(np.median(s)), len(s), True
            elif len(s) >= 2:
                say("Timecode of %s %d not used: its matched clips disagree by %.2f s" % (k[0], k[1] + 1, max(s) - min(s)))
        if not new: break
    def aclock(u): return u["tc"] + dA[tkey(u)]  # camera A clock at u's source time 0
    anchors = [u for u in refs + [o for o in others if o["placed"]] if u.get("tc") is not None and tkey(u) in dA]
    todo = [u for u in others if not u["placed"] and u.get("tc") is not None and tkey(u) in dA]
    todo.sort(key=lambda u: (u["kind"] != "video", aclock(u) + u["inPoint"]))
    for u in todo:
        a0 = aclock(u) + u["inPoint"]
        best = None
        for c in anchors:
            c0 = aclock(c) + c["inPoint"]
            ov = min(a0 + u["duration"], c0 + c["duration"]) - max(a0, c0)
            if ov >= MIN_OVERLAP and (best is None or (bool(c.get("ref")), ov) > (bool(best[0].get("ref")), best[1])): best = (c, ov)
        why = "timecode (%s %d clock %+.2f s from camera A, learnt from %d matched clips; check sync by eye)" % (
            "V" if u["kind"] == "video" else "A", u["track"] + 1, dA[tkey(u)], nA[tkey(u)])
        if best:
            c = best[0]
            u.update(placed=True, parent=c, L=aclock(u) - aclock(c), how=why, reason="")
        else:
            # Nothing of camera A was rolling: this clip anchors its own group by timecode.
            u["clockroot"] = True
            u["reason"] = "no camera A clip at this time; anchors its own group, clips around it lined up by timecode"
        anchors.append(u)
    # New starts: root of each group stays; children follow their parent.
    def root(u):
        while u["parent"] is not None: u = u["parent"]
        return u
    def root_in(u, anc):
        while u["parent"] is not None:
            u = u["parent"]
            if u is anc: return True
        return False
    def new_start(u):
        if u["parent"] is None: return u["start"]
        p = u["parent"]
        return new_start(p) + u["L"] - p["inPoint"] + u["inPoint"]
    groups = {}
    for u in units:
        r = root(u) if u["placed"] else u
        groups.setdefault(id(r), {"root": r, "members": []})["members"].append(u)
    for g in groups.values():
        for u in g["members"]:
            u["ns"] = round(new_start(u) / frame) * frame
    # Inside a group: a clip landing on another clip of its track is left out (weaker one).
    dropped = []
    for g in groups.values():
        ms = g["members"]
        bad = True
        while bad:
            bad = False
            for i in range(len(ms)):
                for j in range(i + 1, len(ms)):
                    a, b = ms[i], ms[j]
                    if a["kind"] == b["kind"] and a["track"] == b["track"] and a["ns"] < b["ns"] + b["duration"] - frame / 2 and b["ns"] < a["ns"] + a["duration"] - frame / 2:
                        drop, keep = (a, b) if b is g["root"] else (b, a)
                        # Anything placed against the dropped clip goes with it.
                        gone = [drop] + [m for m in ms if m is not drop and root_in(m, drop)]
                        for d in gone:
                            d.update(placed=False, parent=None, how="", ns=d["start"],
                                     reason="would land on %s on the same track" % keep["name"] if d is drop else "placed against %s, which was left out" % drop["name"])
                            ms.remove(d)
                            dropped.append(d)
                        bad = True
                        break
                if bad: break
    for d in dropped: groups[id(d)] = {"root": d, "members": [d]}
    # Groups in their original order. A group moves (later only) when a clip of it would start
    # before 0 or land on a clip already laid out on the same track; it then starts GAP s
    # after that clip. Clips on other tracks may overlap freely (that's the point).
    order = sorted(groups.values(), key=lambda g: (g["root"]["start"], g["root"]["track"]))
    laid = []  # (kind, track, start, end)
    for g in order:
        lo = min(u["ns"] for u in g["members"])
        shift = -lo if lo < 0 else 0.0
        if g["root"].get("clockroot") and laid:
            # A group with no camera A: straight after everything laid so far (no long hole).
            shift = max(e0 for _, _, _, e0 in laid) + gap - lo
        for _ in range(1000):
            need = shift
            for u in g["members"]:
                a, b = u["ns"] + shift, u["ns"] + shift + u["duration"]
                for k, t, s0, e0 in laid:
                    if k == u["kind"] and t == u["track"] and a < e0 - frame / 2 and s0 < b - frame / 2:
                        need = max(need, e0 + gap - u["ns"])
            if need == shift: break
            shift = need
        shift = round(shift / frame + 0.4999) * frame if shift > 0 else round(shift / frame) * frame
        for u in g["members"]:
            u["ns"] += shift
            laid.append((u["kind"], u["track"], u["ns"], u["ns"] + u["duration"]))
        g["shift"] = shift
        for u in g["members"]:
            if u.get("ref") and shift > 0:
                u["how"] = "camera A; moved %.2f s later with its group to make room (camera B or a wav starts before it, or it would land on the clip before)" % shift
    out = []
    for gi, g in enumerate(order):
        for u in g["members"]:
            out.append({"id": u["id"], "name": u["name"], "kind": u["kind"], "track": u["track"], "group": gi,
                        "ref": bool(u.get("ref")), "synced": bool(u["placed"]) and not u.get("ref"),
                        "with": u["parent"]["name"] if u["parent"] is not None else None,
                        "withId": u["parent"]["id"] if u["parent"] is not None else None,
                        "oldStart": u["start"], "newStart": round(u["ns"], 6), "shift": round(u["ns"] - u["start"], 6),
                        "how": u["how"], "reason": u["reason"], "source": u.get("source", "")})
    timing = {"check": round(t_check, 1), "read": round(t_read, 1), "match": round(t_match, 1), "picture": round(t_pic, 1), "total": round(time.time() - T0, 1),
              "files": len(keys), "wholeSide": "camera A" if refs_full else "others"}
    say("Proxy check %.1f s, reading %.1f s, matching %.1f s" % (t_check, t_read, t_match))
    json.dump({"units": out, "groups": [{"root": g["root"]["name"], "shift": g["shift"], "size": len(g["members"])} for g in order], "timing": timing}, sys.stdout)


if __name__ == "__main__":
    main()
