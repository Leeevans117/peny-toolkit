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
Timecode is a fallback only: on Whistler the RED and Canon clocks were 3 min apart and the
RED's jumped between clips, so it never overrides the waveform. When a clip finds no
waveform match but both it and a placed clip of the other camera have timecode, the
offset between the two clocks seen on matched clips predicts it; that is used only if
every matched pair agrees on that offset to within 1 frame (otherwise the clip is left).

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
            if not cands: continue
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
    t_match = time.time() - t2
    pool.shutdown()
    # Timecode fallback: one clock offset per (camera track pair), only if all matched pairs agree.
    pairs = {}
    for u in others:
        if u["placed"] and u["parent"] is not None and u.get("tc") is not None and u["parent"].get("tc") is not None:
            # tc = timecode at the media's first frame, so a moment's tc = tc + source time.
            # Clock offset = parent's tc - u's tc at the same moment.
            off = u["parent"]["tc"] - u["tc"] + u["L"]
            pairs.setdefault((u["track"], u["parent"]["track"]), []).append(off)
    for u in others:
        if u["placed"] or u.get("tc") is None: continue
        for c in refs + [o for o in others if o["placed"]]:
            offs = pairs.get((u["track"], c["track"]))
            if c.get("tc") is None or not offs or len(offs) < 2 or max(offs) - min(offs) > frame: continue
            off = sum(offs) / len(offs)
            L = off - (c["tc"] - u["tc"])
            # Only if the clip then lies inside c (at least half of it).
            a, b = u["inPoint"] + L, u["inPoint"] + L + u["duration"]
            ov = min(b, c["inPoint"] + c["duration"]) - max(a, c["inPoint"])
            if ov >= u["duration"] / 2:
                u.update(placed=True, parent=c, L=L, how="timecode (clock offset %.2f s, from %d waveform-matched clips)" % (off, len(offs)), reason="")
                break
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
        for _ in range(1000):
            need = shift
            for u in g["members"]:
                a, b = u["ns"] + shift, u["ns"] + shift + u["duration"]
                for k, t, s0, e0 in laid:
                    if k == u["kind"] and t == u["track"] and a < e0 - frame / 2 and s0 < b - frame / 2:
                        need = max(need, e0 + gap - u["ns"])
            if need == shift: break
            shift = need
        shift = round(shift / frame + 0.4999) * frame if shift > 0 else 0.0
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
    timing = {"check": round(t_check, 1), "read": round(t_read, 1), "match": round(t_match, 1), "total": round(time.time() - T0, 1),
              "files": len(keys), "wholeSide": "camera A" if refs_full else "others"}
    say("Proxy check %.1f s, reading %.1f s, matching %.1f s" % (t_check, t_read, t_match))
    json.dump({"units": out, "groups": [{"root": g["root"]["name"], "shift": g["shift"], "size": len(g["members"])} for g in order], "timing": timing}, sys.stdout)


if __name__ == "__main__":
    main()
