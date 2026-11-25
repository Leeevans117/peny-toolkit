#!/usr/bin/env python3
"""Multicam Sync engine (Peny Toolkit). Puts every camera clip and every external recording of
a sequence on ONE clock, so all cameras line up with each other and with the lav/recorder audio.

Lee, 23 Nov 2026: "timecode first, then waveform if timecode unavailable"; slow-mo clips that
can't be synced go at the end. Built from the Hardline test project (Tentacle-jammed FX6/RED,
A7s and R5 with Tentacle LTC on an audio channel, R5's own file timecode 11 h out, Rode lavs
with no timecode, RED slow-mo with a real-time .wav beside the R3D).

Order:
 1. Clocks per clip: LTC read from the camera's sound (a Tentacle box into the mic), the
    file's timecode, or a BWF wav's time reference. A camera whose clips carry LTC uses LTC
    (its file timecode is the camera's own clock: R5 03:49 vs LTC 12:08). That channel is
    never used as sound.
 2. Timecode is checked by SOUND before it is trusted: clips of two cameras that overlap by
    timecode must line up by waveform (to 1.5 frames). Cameras that agree form the master
    clock. A camera whose timecode can't be checked (no overlapping sound) is still placed by
    timecode, and said so. A camera whose sound says its timecode is wrong is re-synced by
    waveform.
 3. Waveform: recordings (wavs, a 1 h file continues into the next number) are found by
    probing them with placed camera clips; cameras with no usable clock are found inside
    placed recordings or placed camera clips. Every placement needs two agreeing channels
    or two agreeing clips (rules from Sync External Audio, measure.py, proven on Lee's data).
 4. Anything left (slow-mo with no sound and no timecode, no match) is listed for the end.
Input: JSON on stdin {ffmpeg, ffprobe, fps, units:[{id, name, kind, path, inPoint, duration,
tc, proxy}]}. Output: JSON {placed:[...], unplaced:[...], cameras:[...]}; progress on stderr.
"""
import hashlib, json, os, re, struct, subprocess, sys, time
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ltc as LTC

COARSE_SR, FINE_SR, LTC_SR = 2000, 8000, 48000
PROBE_SECONDS = 120.0
WINDOW, STEP = 600.0, 480.0
FINE_PAD = 3.0
AGREE = 0.05
MIN_SECONDS = 1.5
SILENT_RMS = 10 ** (-70 / 20.0)
SAME_MIC = 0.9
PROBE_RULES = "v2 same-mic 0.9, accept measure.py"   # change when channel choice or accept rules change: saved probe results are then redone
T0 = time.time()


def say(msg):
    sys.stderr.write("[%5.1fs] %s\n" % (time.time() - T0, msg)); sys.stderr.flush()


# ---------------------------------------------------------------- media reading
class Media:
    def __init__(self, ffmpeg, ffprobe, cache=None):
        self.ffmpeg, self.ffprobe = ffmpeg, ffprobe
        self.info_cache, self.force = {}, {}
        self.cache = cache
        if cache:
            os.makedirs(cache, exist_ok=True)
            try: self.info_cache = json.load(open(os.path.join(cache, "info.json")))
            except Exception: pass

    def save(self):
        if self.cache:
            try: json.dump(self.info_cache, open(os.path.join(self.cache, "info.json"), "w"))
            except Exception: pass

    def _key(self, *a):
        p = a[0]
        try: st = os.stat(p); sig = (st.st_size, int(st.st_mtime))
        except Exception: sig = (0, 0)
        return hashlib.sha1(repr((a, sig)).encode()).hexdigest()

    def info(self, path):
        if path in self.info_cache and "created" in self.info_cache[path]: return self.info_cache[path]
        inf = {"audio": [], "fps": None, "tc": None, "duration": None, "bwf": None}
        if re.search(r"\.r3d$", path, re.I):
            self.info_cache[path] = inf; return inf
        p = subprocess.run([self.ffprobe, "-v", "error", "-print_format", "json", "-show_streams", "-show_format", path],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try: j = json.loads(p.stdout or b"{}")
        except Exception: j = {}
        ai = 0
        for s in j.get("streams", []):
            tc = (s.get("tags") or {}).get("timecode")
            if tc and not inf["tc"]: inf["tc"] = tc
            if s.get("codec_type") == "video" and not inf["fps"]:
                try:
                    a, b = s.get("r_frame_rate", "0/1").split("/"); f = float(a) / float(b)
                    if 1 < f < 121: inf["fps"] = f
                except Exception: pass
            if s.get("codec_type") == "audio":
                inf["audio"].append({"stream": ai, "channels": int(s.get("channels") or 1), "tag": s.get("codec_tag_string", ""),
                                     "codec": s.get("codec_name", "")})
                ai += 1
        fmt = j.get("format", {})
        ct = (fmt.get("tags") or {}).get("creation_time") or ""
        mm = re.search(r"T(\d+):(\d+):(\d+)", ct)
        inf["created"] = int(mm.group(1)) * 3600 + int(mm.group(2)) * 60 + int(mm.group(3)) if mm else None
        tc = (fmt.get("tags") or {}).get("timecode")
        if tc and not inf["tc"]: inf["tc"] = tc
        try: inf["duration"] = float(fmt.get("duration"))
        except Exception: pass
        if re.search(r"\.wav$", path, re.I): inf["bwf"] = bwf_start(path)
        self.info_cache[path] = inf
        return inf

    def decode(self, path, stream, ch, sr, start=0.0, dur=None, nch=1):
        """One channel as float64 at sr, or None. Cached on disk (a second run reads nothing)."""
        if self.cache:
            f = os.path.join(self.cache, self._key(path, stream, ch, sr, round(start, 4), None if dur is None else round(dur, 4), nch) + ".npy")
            if os.path.exists(f):
                try:
                    x = np.load(f)
                    return None if x.size == 1 and np.isnan(x[0]) else x.astype(np.float64)
                except Exception:
                    try: os.remove(f)
                    except Exception: pass
            x = self._decode(path, stream, ch, sr, start, dur, nch)
            try:
                tmp = f + ".part.npy"
                np.save(tmp, np.array([np.nan], np.float32) if x is None else x.astype(np.float32))
                os.replace(tmp, f)   # whole file or nothing (a killed run left a cut file)
            except Exception: pass
            return x
        return self._decode(path, stream, ch, sr, start, dur, nch)

    def _decode(self, path, stream, ch, sr, start=0.0, dur=None, nch=1):
        for force in ([None] + (["pcm_s24be", "pcm_s16be"] if self.needs_force(path, stream) else [])):
            if self.force.get((path, stream)) and force is None: continue
            cmd = [self.ffmpeg, "-v", "error", "-nostdin"]
            if start > 0: cmd += ["-ss", "%.4f" % start]
            if force: cmd += ["-c:a", force]
            cmd += ["-i", path]
            if dur is not None: cmd += ["-t", "%.4f" % dur]
            cmd += ["-map", "0:a:%d" % stream]
            if nch > 1: cmd += ["-af", "pan=mono|c0=c%d" % ch]
            else: cmd += ["-ac", "1"]
            cmd += ["-ar", str(sr), "-f", "f32le", "-"]
            p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if p.returncode == 0 and len(p.stdout) >= 4:
                if force: self.force[(path, stream)] = force
                return np.frombuffer(p.stdout, dtype=np.float32).astype(np.float64)
        return None

    def needs_force(self, path, stream):
        # Canon R5 'ipcm' sound: ffmpeg older than 6 has no decoder; it is plain big-endian PCM.
        a = self.info(path)["audio"]
        return stream < len(a) and a[stream]["tag"] == "ipcm" and a[stream]["codec"] in ("", "unknown", "none")


def bwf_start(path):
    """BWF time reference (seconds of day of the first sample), or None."""
    try:
        with open(path, "rb") as f:
            if f.read(4) != b"RIFF": return None
            f.read(8); sr = None; tr = None
            while True:
                h = f.read(8)
                if len(h) < 8: break
                cid, sz = struct.unpack("<4sI", h)
                if cid == b"fmt ":
                    d = f.read(sz); sr = struct.unpack("<I", d[4:8])[0]
                elif cid == b"bext":
                    d = f.read(sz); tr = struct.unpack("<Q", d[338:346])[0] if len(d) >= 346 else None
                elif cid == b"data": break
                else: f.seek(sz, 1)
                if sz & 1: f.seek(1, 1)
            if sr and tr: return tr / float(sr)
    except Exception: pass
    return None


def tc_seconds(tc, fps):
    """Timecode string -> real seconds. Handles 23.976/29.97/59.94 (frame count / real rate) and drop-frame (';')."""
    m = re.match(r"(\d+):(\d+):(\d+)([:;.,])(\d+)", tc or "")
    if not m: return None
    h, mi, s, sep, f = int(m.group(1)), int(m.group(2)), int(m.group(3)), m.group(4), int(m.group(5))
    fps = float(fps or 25); nominal = int(round(fps))
    frames = (h * 3600 + mi * 60 + s) * nominal + f
    if sep in ";," and nominal in (30, 60):
        drop = 2 if nominal == 30 else 4; tm = h * 60 + mi
        frames -= drop * (tm - tm // 10)
    return frames / fps


# ---------------------------------------------------------------- correlation
def lag_of(sig, clip, sr, lo, hi, spec=None, n=None):
    """Lag (samples) of clip inside sig in [lo, hi] and peak ratio (best / best outside 50 ms)."""
    if n is None: n = 1 << int(np.ceil(np.log2(len(sig) + len(clip))))
    S = spec if spec is not None else np.fft.rfft(sig, n)
    R = S * np.conj(np.fft.rfft(clip, n))
    R /= np.maximum(np.abs(R), 1e-12)
    r = np.fft.irfft(R, n)
    lags = np.arange(n); lags[lags > n // 2] -= n
    mask = (lags >= lo) & (lags <= hi)
    if not mask.any(): return None, 0.0
    idx = np.where(mask)[0]; vals = r[idx]
    b = int(np.argmax(vals))
    far = np.abs(np.arange(len(vals)) - b) > int(0.05 * sr)
    second = vals[far].max() if far.any() else 0.0
    return int(lags[idx[b]]), (float(vals[b] / second) if second > 0 else 99.0)


def rms(x): return float(np.sqrt(np.mean(x * x))) if x is not None and len(x) else 0.0


# ---------------------------------------------------------------- the job
class Job:
    def __init__(self, job):
        self.m = Media(job["ffmpeg"], job["ffprobe"], job.get("cacheDir"))
        self.fps = float(job.get("fps") or 25)
        self.units = job["units"]
        self.byid = {u["id"]: u for u in self.units}
        self.placed = {}   # id -> {"t": master seconds of the unit's first shown frame, "how", "why"}
        self.notes = []

    # ---- sound sources
    def sound(self, u):
        """(path, [(stream, ch, nch)], offset) the unit's sound is read from; offset = seconds
        into that file of the media's first frame."""
        if "_snd" in u: return u["_snd"]
        p = u.get("path") or ""
        res = (None, [], 0.0)
        if re.search(r"\.r3d$", p, re.I):
            base = re.sub(r"_\d{3}\.r3d$", "", os.path.basename(p), flags=re.I)
            w = os.path.join(os.path.dirname(p), base + ".wav")
            if os.path.exists(w): p = w   # RED writes real-time sound beside the R3D (slow-mo too)
            elif u.get("proxy") and os.path.exists(u["proxy"]): p = u["proxy"]
            else: p = None
            if p: u["soundFrom"] = os.path.basename(p)
        if p and os.path.exists(p):
            chans = []
            for a in self.m.info(p)["audio"]:
                for c in range(a["channels"]): chans.append((a["stream"], c, a["channels"]))
            res = (p, chans, 0.0)
        u["_snd"] = res
        return res

    def read(self, u, key, sr, start, dur):
        """Unit sound on channel key from media time start (seconds), dur seconds."""
        p, chans, off = self.sound(u)
        if not p: return None
        s, c, n = key
        return self.m.decode(p, s, c, sr, max(0.0, start + off), dur, n)

    def channels(self, u, sr, start, dur, maxn=2):
        """Best (loudest, distinct, not timecode) channels: [(key, signal)]."""
        p, chans, off = self.sound(u)
        out = []
        for key in chans:
            if key == u.get("ltcKey"): continue
            x = self.read(u, key, sr, start, dur)
            if x is None or len(x) < MIN_SECONDS * sr or rms(x) < SILENT_RMS: continue
            xn = x / (np.linalg.norm(x) or 1)
            # near-copies of one mic (RED wav ch0/ch1 at r~0.98) are ONE piece of evidence, not two
            if any(len(o[2]) == len(xn) and abs(float(np.dot(xn, o[2]))) > SAME_MIC for o in out): continue
            out.append((key, x, xn))
        out.sort(key=lambda o: -rms(o[1]))
        return [(k, x) for k, x, _ in out[:maxn]]

    # ---- 1. clocks
    def device(self, u):
        d = os.path.dirname(u.get("path") or "")
        if d.upper().endswith(".RDC"): d = os.path.dirname(d)
        return d + (" (audio)" if u["kind"] == "audio" else "")

    def clocks(self):
        say("Reading timecode of %d clips" % len(self.units))
        self.ltc_seen = {}
        for u in self.units:
            u["dev"] = self.device(u)
            p = u.get("path") or ""
            u["clk"] = {}
            if not p or not os.path.exists(p): u["offline"] = True; continue
            inf = self.m.info(p)
            if inf["bwf"] is not None and u["kind"] == "audio": u["clk"]["bwf"] = inf["bwf"]
            if u.get("tc") is not None: u["clk"]["meta"] = float(u["tc"])
            elif inf["tc"]: u["clk"]["meta"] = tc_seconds(inf["tc"], inf["fps"] or self.fps)
            sp, chans, off = self.sound(u)
            if sp and sp != p and re.search(r"\.wav$", sp, re.I):
                b = bwf_start(sp)
                if b is not None: u["clk"]["bwf"] = b
            if u["kind"] == "video" and sp:
                seen = self.ltc_seen.setdefault(u["dev"], {"n": 0, "keys": {}})
                if seen["n"] >= 3 and not seen["keys"]: chans = []
                elif seen["n"] >= 3: chans = [k for k in chans if k in seen["keys"]]
                seen["n"] += 1
                for key in chans:
                    x = self.read(u, key, LTC_SR, 0.0, 4.0)
                    r = LTC.start_of(x, LTC_SR, inf["fps"])
                    if r:
                        u["clk"]["ltc"] = r["tc"]; u["ltcKey"] = key; u["ltcInfo"] = r
                        seen["keys"][key] = True
                        break
        devs = {}
        for u in self.units: devs.setdefault(u["dev"], []).append(u)
        self.devs = devs
        self.devclock = {}
        for d, us in devs.items():
            n = len(us)
            ltc = sum(1 for u in us if "ltc" in u["clk"])
            meta = sum(1 for u in us if "meta" in u["clk"])
            bwf = sum(1 for u in us if "bwf" in u["clk"])
            kind = "ltc" if ltc * 2 >= n and ltc else ("bwf" if bwf * 2 >= n and bwf and all(x["kind"] == "audio" for x in us) else ("meta" if meta * 2 >= n and meta else None))
            self.devclock[d] = kind
            say("  %s: %d clip(s), clock %s (LTC %d, file TC %d, BWF %d)" % (os.path.basename(d) or "?", n, kind or "none", ltc, meta, bwf))
            for u in us:
                k = kind if kind in u["clk"] else None
                # RED slow-mo: the R3D's own timecode, else its real-time wav's BWF time.
                if k is None and "bwf" in u["clk"] and kind == "meta": k = "bwf"
                u["clock"] = (u["clk"][k] + u["inPoint"]) if k else None
                u["clockKind"] = k

    # ---- 2. check timecode by sound
    def best_key(self, u, start, dur):
        ch = self.channels(u, FINE_SR, start, dur, maxn=2)
        return ch

    def pair_offset(self, a, b):
        """Measured (b's true time - b's clock) - (a's true - a's clock): how far b's timecode is
        from a's, by sound, over their overlap. (offset s, ratio) or (None, ratio)."""
        s = max(a["clock"], b["clock"]); e = min(a["clock"] + a["duration"], b["clock"] + b["duration"])
        if e - s < 3.0: return None, 0
        mid = (s + e) / 2; L = min(40.0, e - s)
        sa = mid - L / 2 - a["clock"] + a["inPoint"]; sb = mid - L / 2 - b["clock"] + b["inPoint"]
        pad = 1.0
        A = self.channels(a, FINE_SR, max(0, sa - pad), L + 2 * pad, 1)
        B = self.channels(b, FINE_SR, sb, L, 2)
        if not A or not B: return None, 0
        x = A[0][1]; lead = min(pad, sa)
        best = None
        for _, y in B:
            lag, ratio = lag_of(x, y, FINE_SR, 0, int((lead + pad) * FINE_SR))
            if lag is None: continue
            # where b's sound sits in a's: b's true start relative to a's clock frame
            off = lag / FINE_SR - lead
            if best is None or ratio > best[1]: best = (off, ratio)
        return best if best else (None, 0)

    def check_clocks(self):
        """Timecode stands unless the sound PROVES it wrong. Clips of two cameras that overlap by
        timecode are compared by waveform: lined up to 1.5 frames = confirmed; a strong match
        (two clips agreeing) somewhere else = that camera's timecode is off by that much (moved
        by the sound); no match = can't be checked (Hardline 16 Nov 2026: the four cameras were
        spread over the hill, their own sounds never matched each other). A camera whose
        timecode doesn't overlap the rest of the shoot at all (an unjammed camera's own clock,
        e.g. R5 file TC 03:49 against 11:00-15:44) is not trusted and goes to the waveform."""
        tol = 1.5 / self.fps
        clocked = [d for d, k in self.devclock.items() if k]
        say("Checking timecode by sound across %d camera(s)/recorder(s)" % len(clocked))
        span = {}
        for d in clocked:
            ts = [(u["clock"], u["clock"] + u["duration"]) for u in self.devs[d] if u["clock"] is not None]
            span[d] = (min(t[0] for t in ts), max(t[1] for t in ts)) if ts else None
        rel, verdict = {}, {}
        for i, d in enumerate(clocked):
            for e in clocked[i + 1:]:
                pairs = []
                for a in self.devs[d]:
                    if a["clock"] is None: continue
                    for b in self.devs[e]:
                        if b["clock"] is None: continue
                        ov = min(a["clock"] + a["duration"], b["clock"] + b["duration"]) - max(a["clock"], b["clock"])
                        if ov >= 4.0: pairs.append((ov, a, b))
                if not pairs: continue
                pairs.sort(key=lambda p: -p[0])
                ms = []
                for ov, a, b in pairs[:6]:
                    off, ratio = self.pair_offset(a, b)
                    if off is not None and ratio >= 3: ms.append((off, ratio, a["name"], b["name"]))
                    if len(ms) >= 3: break
                tag = "%s vs %s" % (os.path.basename(d), os.path.basename(e))
                if not ms:
                    verdict[(d, e)] = "uncheckable"
                    say("  %s: %d overlap(s), sounds don't match (too far apart?) - timecode can't be checked" % (tag, len(pairs))); continue
                med = sorted(m[0] for m in ms)[len(ms) // 2]
                agree = [m for m in ms if abs(m[0] - med) <= 0.04]
                firm = len(agree) >= 2 or (len(agree) == 1 and agree[0][1] >= 8)
                say("  %s: %s" % (tag, "; ".join("%s/%s %+.3f s (ratio %.1f)" % (m[2], m[3], m[0], m[1]) for m in ms)))
                if not firm: verdict[(d, e)] = "uncheckable"; continue
                o = float(np.median([m[0] for m in agree]))
                rel[(d, e)] = o; rel[(e, d)] = -o
                verdict[(d, e)] = "confirmed" if abs(o) <= tol else "off"
        self.rel, self.verdict = rel, verdict
        # Outside the shoot: a camera whose timecode span touches no other camera's span.
        outside = set()
        if len(clocked) > 2:
            for d in clocked:
                if span[d] is None: continue
                if not any(span[e] and min(span[d][1], span[e][1]) > max(span[d][0], span[e][0]) for e in clocked if e != d):
                    outside.add(d)
        # Master: biggest group joined by "same clock"; a camera with no sound evidence joins on
        # its timecode (Lee: timecode first). A firm offset moves that camera by the sound.
        corr = {}
        trusted = [d for d in clocked if d not in outside]
        if trusted:
            root = max(trusted, key=lambda d: (sum(1 for (x, y), v in verdict.items() if d in (x, y) and v == "confirmed"), len(self.devs[d])))
            corr[root] = 0.0
            frontier = [root]
            while frontier:
                d = frontier.pop()
                for (x, y), o in rel.items():
                    if x == d and y in trusted and y not in corr:
                        corr[y] = corr[d] + (0.0 if abs(o) <= tol else o)
                        if abs(o) > tol: self.notes.append("%s timecode is %+.2f s from %s by sound; moved by the sound" % (os.path.basename(y), o, os.path.basename(x)))
                        frontier.append(y)
            for d in trusted:
                if d not in corr:
                    corr[d] = 0.0
                    self.notes.append("%s: placed by its timecode; its sound overlaps no other camera's, so this could not be checked" % os.path.basename(d))
        for d in outside:
            self.notes.append("%s: its timecode (%s-%s) is outside the rest of the shoot, so it looks like the camera's own clock; synced by waveform instead" % (
                os.path.basename(d), hms(span[d][0]), hms(span[d][1])))
        self.master, self.devcorr, self.outside = set(corr), corr, outside
        self.devcorr0 = dict(corr)
        for d in self.master:
            conf = any(v == "confirmed" and d in k for k, v in verdict.items())
            for u in self.devs[d]:
                if u["clock"] is not None:
                    self.placed[u["id"]] = {"t": u["clock"] + corr[d], "how": "timecode (%s)" % {"ltc": "Tentacle/LTC on the sound", "meta": "file timecode", "bwf": "wav time stamp"}.get(u["clockKind"], u["clockKind"]),
                                            "why": "confirmed by sound against another camera" if conf else ("moved %+.2f s by sound" % corr[d] if corr[d] else "not checkable by sound")}
        say("Timecode: %s; %d clip(s) placed" % (", ".join(os.path.basename(d) for d in self.master) or "none", len(self.placed)))

    # ---- 3. waveform
    def recordings(self, us):
        """Audio-only units chained into recordings: [[(unit, media time 0 in recording time)]]."""
        by = {}
        for u in us: by.setdefault(u["dev"], []).append(u)
        recs = []
        for d, lst in by.items():
            lst.sort(key=lambda u: os.path.basename(u["path"]))
            cur, t, full_prev = [], 0.0, False
            for u in lst:
                full = self.m.info(u["path"])["duration"] or u["duration"]
                if cur and not full_prev: recs.append(cur); cur, t = [], 0.0
                cur.append((u, t)); t += full; full_prev = full >= 3590
            if cur: recs.append(cur)
        return recs

    def env(self, u, key, start, dur):
        """Speech envelope at ENV_SR (log energy, 2 s trend removed): the coarse search signal."""
        x = self.read(u, key, COARSE_SR, start, dur)
        return envelope(x)

    def place_recordings(self):
        """Every camera clip with a clock is heard against every recording (all matches kept,
        not just the first two). Then one solve: each recording's start and each camera's clock
        offset, from 2+ agreeing clips. A camera whose timecode is on a different clock shows up
        as one constant offset across all its clips (Hardline 16 Nov 2026: FX6 file timecode was
        1175.64 s behind the A7s/R5 Tentacle timecode, the same to 0.04 s in 19 clips and 9 lav
        files; Tentacle Sync Studio trusted it and put the FX6 19.6 min out)."""
        allrec = [u for u in self.units if u["kind"] == "audio" and not u.get("offline") and not (self.placed.get(u["id"], {}).get("how", "").startswith("timecode"))]
        if not allrec: return
        recs = self.recordings(allrec)
        self.recs = recs
        say("Waveform: %d external recording(s) in %d file(s)" % (len(recs), len(allrec)))
        hay, where, pos = [], [], 0
        gap = int(PROBE_SECONDS * ENV_SR)
        for ri, rec in enumerate(recs):
            for u, off in rec:
                e = self.env(u, (0, 0, 1), 0.0, None)
                if e is None or len(e) < 2 * ENV_SR: continue
                where.append((pos, pos + len(e), ri, u, off)); hay.append(e); hay.append(np.zeros(gap)); pos += len(e) + gap
        if not hay: return
        H = np.concatenate(hay)
        say("  %.1f h of recordings read" % (len(H) / ENV_SR / 3600))
        n = 1 << int(np.ceil(np.log2(len(H) + gap)))
        HS = np.fft.rfft(H, n)
        CS = np.concatenate([[0.0], np.cumsum(H * H)])
        self.matches = getattr(self, "matches", [])
        self.probed = getattr(self, "probed", set())
        probes = [u for u in self.units if u["kind"] == "video" and u["id"] not in self.probed and not u.get("offline")
                  and (u.get("clock") is not None or u["id"] in self.placed)]
        probes.sort(key=lambda u: u.get("clock") or 0)
        # Probe results are saved (a run that is stopped picks up where it was; same clip + same recordings = same answer)
        hsig = hashlib.sha1(repr([[(u["path"], off) for u, off in rec] for rec in recs]).encode()).hexdigest()[:16]
        pfile = os.path.join(self.m.cache, "probes-%s.json" % hsig) if self.m.cache else None
        try: pdone = json.load(open(pfile)) if pfile else {}
        except Exception: pdone = {}
        def psave():
            if not pfile: return
            try: json.dump(pdone, open(pfile + ".part", "w")); os.replace(pfile + ".part", pfile)
            except Exception as e: say("  (could not save probe results: %s)" % e)
        for pi, pu in enumerate(probes):
            self.probed.add(pu["id"])
            L = min(pu["duration"], PROBE_SECONDS)
            if L < 4: continue
            pk = hashlib.sha1(repr((PROBE_RULES, pu["path"], round(pu["inPoint"], 4), round(L, 4))).encode()).hexdigest()
            wf = self.placed.get(pu["id"], {}).get("how") == "waveform"
            if pk in pdone:
                for ri, x, why in pdone[pk]:
                    self.matches.append({"probe": pu["id"], "name": pu["name"], "dev": "__placed__" if wf else pu["dev"], "rec": ri, "x": x, "why": why})
                continue
            got = pdone[pk] = []
            chans = self.channels(pu, COARSE_SR, pu["inPoint"], L, 2)
            if not chans: continue
            pe = envelope(chans[0][1])
            if pe is None: continue
            if pi % 20 == 0: say("  listening for clip %d/%d (%s)" % (pi + 1, len(probes), pu["name"]))
            for score, idx in top_peaks(HS, n, pe, CS, 3):
                hit = [w for w in where if w[0] <= idx < w[1]]
                if not hit: continue
                p0, p1, ri, u, off = hit[0]
                ut = (idx - p0) / float(ENV_SR)
                w0 = max(0.0, ut - 1.5)
                wseg = self.read(u, (0, 0, 1), FINE_SR, w0, L + 3.0)
                if wseg is None: continue
                f = {}
                for key, _ in chans:
                    c8 = self.read(pu, key, FINE_SR, pu["inPoint"], L)
                    if c8 is None: continue
                    lag, r8 = lag_of(wseg, c8, FINE_SR, 0, int((ut - w0 + 1.5) * FINE_SR))
                    if lag is not None: f[key] = (w0 + lag / FINE_SR, r8)
                t, why = accept(f, None, strict=len(chans) < 2)
                if t is None: continue
                got.append([int(ri), float(off + t), str(why)])
                self.matches.append({"probe": pu["id"], "name": pu["name"], "dev": "__placed__" if wf else pu["dev"], "rec": ri, "x": off + t, "why": why})
            if pi % 5 == 4: psave()
        psave()
        say("  %d confirmed clip-in-recording matches" % len(self.matches))
        self.solve()

    def solve(self):
        recs = self.recs
        M_ = [m for m in self.matches if m["dev"] not in getattr(self, "unverified", set())]   # a useless clock proves nothing
        U = self.byid
        def T(m):  # the probe's own time: its clock, or (dev "__placed__") where waveform already put it
            u = U[m["probe"]]
            if m["dev"] == "__placed__": return self.placed[m["probe"]]["t"]
            return u.get("clock")
        c = {}       # device -> clock offset (true = clock + c)
        r = {}       # recording -> start (true time of recording time 0)
        devs = set(m["dev"] for m in M_ if T(m) is not None)
        if not devs: return
        def cluster(vals):  # vals: [(value, clip)] -> (median, clips) of the biggest group within 60 ms, 2+ clips
            best = None
            for v, _ in vals:
                g = [(x, k) for x, k in vals if abs(x - v) <= 0.06]
                ks = set(k for _, k in g)
                if len(ks) >= 2 and (best is None or len(ks) > len(best[1])): best = (float(np.median([x for x, _ in g])), ks)
            return best
        # Root: the device with the most matches; every other device is related through recordings.
        cnt = {}
        for m in M_:
            if T(m) is not None: cnt[m["dev"]] = cnt.get(m["dev"], 0) + 1
        fixed = "__placed__" in cnt and getattr(self, "devoff", None) is not None
        if fixed:   # a later round: keep the frame of the first solve
            for d, o in self.devoff.items(): c[d] = o
            c["__placed__"] = 0.0
        else:
            root = max(cnt, key=lambda d: cnt[d])
            c[root] = 0.0
        for it in range(20):
            changed = False
            for ri in range(len(recs)):
                if ri in r: continue
                vals = [(T(m) + c[m["dev"]] - m["x"], m["probe"]) for m in M_ if m["rec"] == ri and m["dev"] in c and T(m) is not None]
                cl = cluster(vals)
                if cl: r[ri] = cl[0]; changed = True
            for d in devs:
                if d in c: continue
                vals = [(r[m["rec"]] + m["x"] - T(m), m["probe"]) for m in M_ if m["dev"] == d and m["rec"] in r and T(m) is not None]
                cl = cluster(vals)
                if cl: c[d] = cl[0]; changed = True
            if not changed: break
        # Reference: the biggest group of devices on the same clock (offsets within 0.1 s).
        groups = []
        for d in c:
            for g in groups:
                if abs(c[g[0]] - c[d]) <= 0.1: g.append(d); break
            else: groups.append([d])
        groups.sort(key=lambda g: (-len(g), -sum(len(self.devs.get(x, [])) for x in g)))
        ref = 0.0 if fixed else float(np.median([c[d] for d in groups[0]]))
        c.pop("__placed__", None)
        for d in c: c[d] -= ref
        for ri in r: r[ri] -= ref
        self.devoff = c
        for d, o in c.items():
            nm = os.path.basename(d)
            if abs(o) > 1.5 / self.fps:
                self.notes.append("%s: its timecode is %+.2f s from the others (proven by the lav recordings); moved by that much" % (nm, o))
                say("  %s timecode is %+.2f s off the other cameras: corrected" % (nm, o))
            else:
                say("  %s timecode agrees with the others (through the lavs, %+.3f s)" % (nm, o))
        # Apply: camera clips by clock + offset; recordings by their solved start.
        for d, o in c.items():
            for u in self.devs.get(d, []):
                if u.get("clock") is None or u["kind"] != "video": continue
                if u["id"] in self.placed and self.placed[u["id"]]["how"] == "waveform": continue
                self.placed[u["id"]] = {"t": u["clock"] + o, "how": self.placed.get(u["id"], {}).get("how", "timecode"),
                                        "why": "timecode checked by the lav recordings" + (" and moved %+.2f s" % o if abs(o) > 1.5 / self.fps else "")}
        for ri, r0 in r.items():
            sup = [m for m in M_ if m["rec"] == ri]
            for x, off in recs[ri]:
                self.placed[x["id"]] = {"t": r0 + off + x["inPoint"], "how": "waveform",
                                        "why": "%d camera clips agree (%s)" % (len(set(m["probe"] for m in sup)), ", ".join(sorted(set(m["name"] for m in sup))[:3]))}
        left = [ri for ri in range(len(recs)) if ri not in r]
        for ri in left:
            ms = [m for m in M_ if m["rec"] == ri]
            if ms: self.notes.append("%s: heard in %d clip(s) but they don't agree, not placed" % (recs[ri][0][0]["name"], len(ms)))
        say("  recordings placed: %d of %d" % (len(r), len(recs)))

    def place_cameras(self):
        """Camera clips not placed by timecode: found by waveform inside placed recordings and
        placed camera clips. Once two clips of a camera agree on its clock's offset, the rest
        of that camera are searched near that estimate first."""
        todo = [u for u in self.units if u["kind"] == "video" and u["id"] not in self.placed and not u.get("offline") and u["id"] not in getattr(self, "rejected", set())]
        # recordings no camera heard (Hardline LavKaos): searched in everything placed, 4 windows, 2 must agree
        todo += [u for u in self.units if u["kind"] == "audio" and u["id"] not in self.placed and not u.get("offline") and u["duration"] >= 60
                 and getattr(self, "late_audio", False)]
        if not todo: return
        say("Waveform: %d camera clip(s) not placed by timecode" % len(todo))
        hay, where, pos = [], [], 0
        gap = int(PROBE_SECONDS * ENV_SR)
        exactly = lambda x: x["id"] not in getattr(self, "coarse", set()) and "not checkable" not in self.placed[x["id"]]["why"]   # search only in sound placed to the frame
        for u in sorted((x for x in self.units if x["id"] in self.placed and not x.get("offline") and exactly(x)), key=lambda x: self.placed[x["id"]]["t"]):
            if u["kind"] == "audio":
                x = self.read(u, (0, 0, 1), COARSE_SR, 0.0, None); key = (0, 0, 1)
                e = envelope(x[int(u["inPoint"] * COARSE_SR):int((u["inPoint"] + u["duration"]) * COARSE_SR)]) if x is not None else None
            else:
                ch = self.channels(u, COARSE_SR, u["inPoint"], min(u["duration"], WINDOW), 1)
                if not ch: continue
                key = ch[0][0]; e = envelope(ch[0][1])
            if e is None or len(e) < 2 * ENV_SR: continue
            where.append((pos, pos + len(e), u, key)); hay.append(e); hay.append(np.zeros(gap)); pos += len(e) + gap
            if len(where) % 25 == 0: say("  reading placed sound: %d clips" % len(where))
        if not hay:
            for u in todo: u["why"] = u.get("why") or "nothing placed to search in"
            return
        H = np.concatenate(hay)
        n = 1 << int(np.ceil(np.log2(len(H) + gap)))
        HS = np.fft.rfft(H, n)
        HE = np.concatenate([[0.0], np.cumsum(H * H)])
        say("  searching %.1f h of placed sound" % (len(H) / ENV_SR / 3600))
        offs = {}
        # saved answers: same clip + same placed sound = same answer (a stopped run picks up here)
        hsig = hashlib.sha1(repr((PROBE_RULES, [(w[2]["path"], round(w[2]["inPoint"], 3), round(self.placed[w[2]["id"]]["t"], 3), w[3]) for w in where])).encode()).hexdigest()[:16]
        cfile = os.path.join(self.m.cache, "cams-%s.json" % hsig) if self.m.cache else None
        try: cdone = json.load(open(cfile)) if cfile else {}
        except Exception: cdone = {}
        def csave():
            if not cfile: return
            try: json.dump(cdone, open(cfile + ".part", "w")); os.replace(cfile + ".part", cfile)
            except Exception as e: say("  (could not save search results: %s)" % e)
        for k, u in enumerate(todo):
            if k % 5 == 4: csave()
            ck = hashlib.sha1(repr((u["path"], round(u["inPoint"], 4), round(u["duration"], 4))).encode()).hexdigest()
            if ck in cdone:
                c = cdone[ck]
                if c[0] is None: u["why"] = c[1]
                else:
                    self.placed[u["id"]] = {"t": c[0], "how": "waveform", "why": c[1]}
                    say("  %d/%d %s -> %s (saved)" % (k + 1, len(todo), u["name"], c[1]))
                continue
            if u["kind"] == "audio":
                res = self.search_recording(u, HS, n, HE, where)
            else:
                res = self.search_camera(u, HS, n, HE, where)
            if res is None: cdone[ck] = [None, u.get("why") or "no confident match in the placed sound"]; continue
            t, why, tu = res
            cdone[ck] = [float(t), "%s, in %s" % (why, tu["name"])]
            self.placed[u["id"]] = {"t": t, "how": "waveform", "why": "%s, in %s" % (why, tu["name"])}
            say("  %d/%d %s -> in %s (%s)" % (k + 1, len(todo), u["name"], tu["name"], why))
        csave()

    def search_recording(self, u, HS, n, HE, where):
        D = u["duration"]; L = min(PROBE_SECONDS, D)
        hits = []
        for frac in (0.1, 0.35, 0.6, 0.85):
            wi = u["inPoint"] + max(0.0, min(D - L, frac * D - L / 2))
            v = dict(u, inPoint=wi, duration=L)
            r = self.search_camera(v, HS, n, HE, [w for w in where if w[2]["dev"] != u["dev"]])
            if r: hits.append((r[0] - (wi - u["inPoint"]), r[1], r[2]))
        for i in range(len(hits)):
            g = [h for h in hits if abs(h[0] - hits[i][0]) <= AGREE]
            if len(g) >= 2:
                return float(np.median([h[0] for h in g])), "%d of %d windows agree (%s)" % (len(g), len(hits), hits[i][1]), hits[i][2]
        u["why"] = "no two parts of the recording agree on a place" if hits else "no confident match in the placed sound"
        return None

    def search_camera(self, u, HS, n, HE, where):
        if True:
            L = min(u["duration"], PROBE_SECONDS)
            if L < 4: u["why"] = "too short to measure (%.1f s)" % u["duration"]; return None
            chans = self.channels(u, COARSE_SR, u["inPoint"], L, 2)
            if not chans:
                u["why"] = "no camera sound" + (" (slow motion)" if re.search(r"\.r3d$", u.get("path", ""), re.I) else ""); return None
            pe = envelope(chans[0][1])
            if pe is None: u["why"] = "sound too short"; return None
            tops = top_peaks(HS, n, pe, HE, 6)
            res = None
            for score, idx in tops:
                hit = [w for w in where if w[0] <= idx < w[1]]
                if not hit: continue
                p0, p1, tu, tkey = hit[0]
                tin = tu["inPoint"] + (idx - p0) / float(ENV_SR)   # target media time
                w0 = max(0.0, tin - 1.5)
                wseg = self.read(tu, tkey, FINE_SR, w0, L + 3.0)
                if wseg is None: continue
                f = {}
                for key, _ in chans:
                    c8 = self.read(u, key, FINE_SR, u["inPoint"], L)
                    if c8 is None: continue
                    lag, r8 = lag_of(wseg, c8, FINE_SR, 0, int((tin - w0 + 1.5) * FINE_SR))
                    if lag is not None: f[key] = (w0 + lag / FINE_SR - tu["inPoint"] + self.placed[tu["id"]]["t"], r8)
                t, why = accept(f, None, strict=len(chans) < 2)
                if t is not None: res = (t, why, tu); break
            if res is None: u["why"] = "no confident match in the placed sound"
            return res

    def verified_devices(self):
        ok = set(getattr(self, "devoff", {}))
        changed = True
        while changed:   # a camera confirmed by sound against a verified camera is verified too
            changed = False
            for (x, y), v in getattr(self, "verdict", {}).items():
                if v in ("confirmed", "off") and (x in ok) != (y in ok): ok |= {x, y}; changed = True
        return ok

    def unverify(self):
        """Lee 24 Nov 2026 (X-H2S at 05:53 and a GoPro at 06:04 against a shoot at 11:12-15:44):
        a camera whose timecode no sound could check is NOT placed by it straight away. Its clips
        are searched by waveform in everything already placed; if 2+ clips agree on one offset the
        whole camera moves by it (finish_unverified)."""
        ok = self.verified_devices()
        for d in list(self.master):
            if d in ok or d.endswith(" (audio)"): continue
            n = 0
            for u in self.devs[d]:
                p = self.placed.get(u["id"])
                if p and p["how"].startswith("timecode"): self.placed.pop(u["id"]); n += 1
            if n:
                self.unverified.add(d)
                say("  %s: timecode not checked by any sound, %d clip(s) searched by waveform instead" % (os.path.basename(d), n))

    def no_overlaps(self):
        """One camera records one clip at a time: a waveform placement that overlaps another clip of
        the same camera by more than a second is a false match and is taken back (Hardline 24 Nov:
        two RED clips 37 min apart both 'found' in the same 18 s R5 clip)."""
        for d, us in self.devs.items():
            if d.endswith(" (audio)"): continue
            pl = [(self.placed[u["id"]]["t"], self.placed[u["id"]]["t"] + u["duration"], u) for u in us if u["id"] in self.placed]
            bad = set()
            for i in range(len(pl)):
                for j in range(i + 1, len(pl)):
                    a, b = pl[i], pl[j]
                    if min(a[1], b[1]) - max(a[0], b[0]) > 1.0:
                        for x in (a[2], b[2]):
                            if self.placed[x["id"]]["how"] == "waveform": bad.add(x["id"])
            for i in bad:
                self.placed.pop(i); self.byid[i]["why"] = "a sound match was found but it overlaps another clip of the same camera, so it was not trusted"
                self.probed.discard(i) if hasattr(self, "probed") else None
                self.rejected = getattr(self, "rejected", set()) | {i}
            if bad: say("  %s: %d match(es) taken back (would overlap the same camera's other clips)" % (os.path.basename(d), len(bad)))

    def clock_candidates(self, d, us):
        """Ways this camera's clips could be on one clock: its timecode; its timecode + whole hours
        (camera set to another time zone: Hardline GoPro Ronan TC 06:04 = file date 13:04 - 7 h);
        the file date as recording START (GoPro) or END (Fuji X-H2S writes it when it stops; its
        timecode was rec-run, 05:53 for a 12:27 shoot). File dates are whole seconds."""
        cands = {"timecode": ({u["id"]: u["clock"] for u in us if u.get("clock") is not None}, 0.06)}
        cr = {u["id"]: self.m.info(u["path"]).get("created") for u in us}
        cr = {k: v for k, v in cr.items() if v is not None}
        if cr:
            hrs = [round((cr[u["id"]] - u["clock"]) / 3600.0) for u in us if u["id"] in cr and u.get("clock") is not None]
            if hrs:
                hh = max(set(hrs), key=hrs.count)
                fit = [u for u in us if u["id"] in cr and u.get("clock") is not None and abs(cr[u["id"]] - (u["clock"] + hh * 3600)) <= 3]
                if hh and len(fit) >= 0.8 * len(us):
                    cands["timecode %+d h (time zone)" % hh] = ({u["id"]: u["clock"] + hh * 3600 for u in us if u.get("clock") is not None}, 0.06)
            byid = {u["id"]: u for u in us}
            cands["file date = start"] = ({k: v for k, v in cr.items()}, 1.5)
            cands["file date = end"] = ({k: v - byid[k]["duration"] for k, v in cr.items()}, 1.5)
        return cands

    def finish_unverified(self):
        span = [p["t"] for i, p in self.placed.items() if self.byid[i]["kind"] == "video" and self.byid[i]["dev"] not in self.unverified]
        lo, hi = (min(span) - 600, max(span) + 600) if span else (None, None)
        self.coarse = getattr(self, "coarse", set())
        for d in sorted(self.unverified):
            us = self.devs[d]; nm = os.path.basename(d)
            wave = [u for u in us if self.placed.get(u["id"], {}).get("how") == "waveform"]
            best = None
            for cname, (clk, tol) in self.clock_candidates(d, us).items():
                vals = [(self.placed[u["id"]]["t"] - clk[u["id"]], u["id"]) for u in wave if u["id"] in clk]
                for v, _ in vals:
                    g = [k for x, k in vals if abs(x - v) <= tol]
                    if len(g) >= 2 and (best is None or len(g) > len(best[2])):
                        best = (cname, float(np.median([x for x, k in vals if k in g])), g, clk, tol)
            left = [u for u in us if u["id"] not in self.placed and u["id"] not in getattr(self, "rejected", set())]
            if best:
                cname, o, g, clk, tol = best
                n = 0
                for u in left:
                    if u["id"] not in clk: continue
                    self.placed[u["id"]] = {"t": clk[u["id"]] + o, "how": "clock (%s)" % cname,
                                            "why": "%s %+.2f s, proven by %d clips found by sound" % (cname, o, len(g))}
                    if tol > 0.5: self.coarse.add(u["id"])
                    n += 1
                odd = len(wave) - len(g)
                self.notes.append("%s: clock = %s %+.2f s, proven by %d clips found by sound%s; %d more placed by it%s" % (
                    nm, cname, o, len(g), " (%d other sound matches disagree)" % odd if odd else "", n,
                    " (file dates are whole seconds, so these are checked by sound next)" if tol > 0.5 else ""))
                say("  %s: %d clips agree its clock is %s %+.2f s; %d more placed by it" % (nm, len(g), cname, o, n))
                continue
            # no sound evidence: timecode if it is inside the shoot, else timecode + time zone if the file dates say so
            cands = self.clock_candidates(d, us)
            pick = None
            for cname in ["timecode"] + [c for c in cands if c.startswith("timecode ")]:
                clk = cands[cname][0]
                if clk and lo is not None and sum(1 for v in clk.values() if lo <= v <= hi) >= 0.8 * len(clk): pick = (cname, clk); break
            if pick:
                for u in left:
                    if u["id"] in pick[1]:
                        self.placed[u["id"]] = {"t": pick[1][u["id"]], "how": "clock (%s)" % pick[0], "why": "not checkable by sound"}
                self.notes.append("%s: placed by %s; no sound could check it (other cameras' timecode was a few seconds out, this one may be too)" % (nm, pick[0]))
                say("  %s: no sound match; placed by %s, unchecked" % (nm, pick[0]))
            else:
                for u in left: u["why"] = "its clock is outside the shoot and its sound matched nothing placed"
                self.notes.append("%s: clock outside the shoot and no sound match, %d clip(s) go to the end" % (nm, len(left)))
                say("  %s: %d clip(s) to the end" % (nm, len(left)))
        self.refine_coarse()

    def refine_coarse(self):
        """Clips placed by a whole-second file date: look for their sound within +-2.5 s in what is placed."""
        todo = [self.byid[i] for i in sorted(getattr(self, "coarse", set()))]
        if not todo: return
        say("Fine-checking %d clip(s) placed by file date" % len(todo))
        anchors = [u for u in self.units if u["kind"] == "audio" and u["id"] in self.placed]   # the lavs: long, and they hear everyone
        rfile = os.path.join(self.m.cache, "refine.json") if self.m.cache else None
        try: rdone = json.load(open(rfile)) if rfile else {}
        except Exception: rdone = {}
        def rsave():
            if not rfile: return
            try: json.dump(rdone, open(rfile + ".part", "w")); os.replace(rfile + ".part", rfile)
            except Exception: pass
        fixed = 0
        for k_, u in enumerate(todo):
            t0 = self.placed[u["id"]]["t"]; L = min(u["duration"], PROBE_SECONDS)
            if L < 4: continue
            rk = hashlib.sha1(repr((PROBE_RULES, u["path"], round(u["inPoint"], 4), round(t0, 3), [(a["path"], round(self.placed[a["id"]]["t"], 3)) for a in anchors])).encode()).hexdigest()
            if k_ % 5 == 4: rsave()
            if rk in rdone:
                if rdone[rk]:
                    self.placed[u["id"]] = {"t": rdone[rk][0], "how": "waveform", "why": rdone[rk][1]}; self.coarse.discard(u["id"]); fixed += 1
                continue
            rdone[rk] = None
            chans = self.channels(u, FINE_SR, u["inPoint"], L, 2)
            if not chans: continue
            res = []
            for a in anchors:
                ta = self.placed[a["id"]]["t"]
                if not (ta <= t0 - 2.5 and ta + a["duration"] >= t0 + L + 2.5): continue   # anchor must hold the whole search window
                w0 = t0 - 2.5 - ta + a["inPoint"]   # anchor media time where the search starts
                if w0 < a["inPoint"] - 0.01 or w0 + L + 5 > a["inPoint"] + a["duration"] + 0.01: continue
                key = (0, 0, 1) if a["kind"] == "audio" else (self.channels(a, COARSE_SR, a["inPoint"], min(a["duration"], 60), 1) or [[None]])[0][0]
                if key is None: continue
                seg = self.read(a, key, FINE_SR, w0, L + 5.0)
                if seg is None: continue
                f = {}
                for k2, c8 in chans:
                    lag, r8 = lag_of(seg, c8, FINE_SR, 0, int(5.0 * FINE_SR))
                    if lag is not None: f[k2] = (t0 - 2.5 + lag / FINE_SR, r8)
                ks = sorted(f, key=lambda k: -f[k][1])
                ok = None
                if len(ks) >= 2 and abs(f[ks[0]][0] - f[ks[1]][0]) <= AGREE and f[ks[1]][1] >= 3: ok = (f[ks[0]][0], "a:%s and a:%s agree (ratios %.1f/%.1f)" % (ks[0][:2], ks[1][:2], f[ks[0]][1], f[ks[1]][1]))
                elif ks and f[ks[0]][1] >= 6: ok = (f[ks[0]][0], "a:%s ratio %.1f" % (ks[0][:2], f[ks[0]][1]))
                if ok: res.append((ok[0], ok[1], a["name"]))
            if res:
                t, why, an = res[0]
                self.placed[u["id"]] = {"t": t, "how": "waveform", "why": "%s, in %s (searched +-2.5 s around its file date)" % (why, an)}
                rdone[rk] = [float(t), self.placed[u["id"]]["why"]]
                self.coarse.discard(u["id"]); fixed += 1
        rsave()
        say("  %d of %d confirmed to the frame by sound; %d stay on file date (+-1 s)" % (fixed, len(todo), len(todo) - fixed))
        if len(todo) - fixed: self.notes.append("%d clip(s) placed by file date only (+-1 s, no sound to check them)" % (len(todo) - fixed))

    def resolve_after_unverified(self):
        """Clips of a camera whose own clock was useless (X-H2S) that are now placed to the frame
        are probes like any placed clip: their lav matches can place more recordings."""
        n = 0
        for m in getattr(self, "matches", []):
            u = self.byid[m["probe"]]
            if u["dev"] in self.unverified and u["id"] in self.placed and u["id"] not in self.coarse and m["dev"] != "__placed__":
                m["dev"] = "__placed__"; n += 1
        if not n: return
        before = sum(1 for i in self.placed if self.byid[i]["kind"] == "audio")
        self.solve()
        after = sum(1 for i in self.placed if self.byid[i]["kind"] == "audio")
        say("  re-solved with %d matches of newly placed clips: %d more recording file(s) placed" % (n, after - before))

    def place_recorders_by_date(self):
        """A recorder's files carry the time they were closed (file date, its own clock, whole
        seconds). When 2+ of its files are placed by sound and agree on that clock's offset (Hardline
        Rode/Wireless PRO: the date is the END of the recording), its other files are placed by date
        (+-1 s) and then checked by sound."""
        self.coarse = getattr(self, "coarse", set())
        for d, us in self.devs.items():
            if not d.endswith(" (audio)"): continue
            mt = {}
            for u in us:
                try: mt[u["id"]] = os.stat(u["path"]).st_mtime % 86400
                except Exception: pass
            pl = [u for u in us if u["id"] in self.placed and u["id"] in mt]
            left = [u for u in us if u["id"] not in self.placed and u["id"] in mt]
            if not left: continue
            full = {u["id"]: (self.m.info(u["path"])["duration"] or u["duration"]) for u in us}
            vals = [(self.placed[u["id"]]["t"] - u["inPoint"] + full[u["id"]] - mt[u["id"]], u["id"]) for u in pl]
            best = None
            for v, _ in vals:
                g = [k for x, k in vals if abs(x - v) <= 2.0]
                if len(g) >= 2 and (best is None or len(g) > len(best[1])): best = (float(np.median([x for x, k in vals if k in g])), g)
            nm = os.path.basename(d.replace(" (audio)", ""))
            if not best:
                say("  %s: file dates can't be checked (%d placed file(s) agree), %d file(s) stay at the end" % (nm, len(pl), len(left))); continue
            o, g = best
            for u in left:
                self.placed[u["id"]] = {"t": mt[u["id"]] + o - full[u["id"]] + u["inPoint"], "how": "clock (file date = end)",
                                        "why": "recorder clock %+.1f s, proven by %d of its files placed by sound" % (o, len(g))}
                self.coarse.add(u["id"])
            self.notes.append("%s: %d file(s) placed by their file date (recorder clock proven by %d files placed by sound, %d disagree)" % (nm, len(left), len(g), len(vals) - len(g)))
            say("  %s: %d file(s) placed by file date (clock proven by %d placed files)" % (nm, len(left), len(g)))

    def refine_by_partners(self):
        """Every clip still placed by a whole-second date: find an exactly placed clip that overlaps
        it by 10 s+, and line the two up by sound within +-3 s (either way round)."""
        todo = [self.byid[i] for i in sorted(self.coarse)]
        if not todo: return
        exact = [u for u in self.units if u["id"] in self.placed and u["id"] not in self.coarse and "not checkable" not in self.placed[u["id"]]["why"]]
        rfile = os.path.join(self.m.cache, "refine2.json") if self.m.cache else None
        try: rdone = json.load(open(rfile)) if rfile else {}
        except Exception: rdone = {}
        def rsave():
            if not rfile: return
            try: json.dump(rdone, open(rfile + ".part", "w")); os.replace(rfile + ".part", rfile)
            except Exception: pass
        say("Fine-checking %d date-placed clip(s) against overlapping clips" % len(todo))
        fixed = 0
        for k_, x in enumerate(todo):
            if k_ % 5 == 4: rsave()
            tx = self.placed[x["id"]]["t"]
            parts = []
            for p in exact:
                if p["dev"] == x["dev"]: continue
                tp = self.placed[p["id"]]["t"]
                s0, e0 = max(tx, tp) + 3.0, min(tx + x["duration"], tp + p["duration"]) - 3.0
                if e0 - s0 >= 8.0: parts.append((e0 - s0, p, s0, e0))
            parts.sort(key=lambda z: -z[0])
            rk = hashlib.sha1(repr((PROBE_RULES, x["path"], round(x["inPoint"], 4), round(tx, 3), [(p["path"], round(self.placed[p["id"]]["t"], 3)) for _, p, _, _ in parts[:6]])).encode()).hexdigest()
            if rk in rdone:
                if rdone[rk]: self.placed[x["id"]] = {"t": rdone[rk][0], "how": "waveform", "why": rdone[rk][1]}; self.coarse.discard(x["id"]); fixed += 1
                continue
            rdone[rk] = None
            for ov, p, s0, e0 in parts[:6]:
                L = min(60.0, e0 - s0); tp = self.placed[p["id"]]["t"]
                pch = self.channels(p, FINE_SR, s0 - tp + p["inPoint"], L, 2)          # partner sound, exact
                xs = s0 - 3.0 - tx + x["inPoint"]                                        # x media time, 3 s early
                xch = self.channels(x, FINE_SR, max(0.0, xs), L + 6.0, 1)
                if not pch or not xch: continue
                lead = min(3.0, xs + 3.0) if xs < 0 else 3.0
                f = {}
                for kk, y in pch:
                    lag, r8 = lag_of(xch[0][1], y, FINE_SR, 0, int((lead + 3.0) * FINE_SR))
                    if lag is not None: f[kk] = (lag / FINE_SR - lead, r8)   # partner sound sits this far into x's window
                ks = sorted(f, key=lambda k: -f[k][1]); ok = None
                if len(ks) >= 2 and abs(f[ks[0]][0] - f[ks[1]][0]) <= AGREE and f[ks[1]][1] >= 3: ok = (f[ks[0]][0], "a:%s and a:%s agree (ratios %.1f/%.1f)" % (ks[0][:2], ks[1][:2], f[ks[0]][1], f[ks[1]][1]))
                elif ks and f[ks[0]][1] >= 6: ok = (f[ks[0]][0], "a:%s ratio %.1f" % (ks[0][:2], f[ks[0]][1]))
                if not ok: continue
                # x's true time: the partner's sound at timeline s0 was heard at x media time xs + 3 + d  ->  x starts at s0 - (that - inPoint)
                d = ok[0]
                t = s0 - (max(0.0, xs) + lead + d - x["inPoint"])
                if abs(t - tx) > 3.0: continue
                why = "%s, against %s (searched +-3 s around its file date)" % (ok[1], p["name"])
                self.placed[x["id"]] = {"t": t, "how": "waveform", "why": why}; rdone[rk] = [float(t), why]
                self.coarse.discard(x["id"]); fixed += 1
                break
        rsave()
        say("  %d of %d confirmed to the frame by sound; %d stay on file date (+-1 s)" % (fixed, len(todo), len(todo) - fixed))
        self.notes = [n for n in self.notes if "placed by file date only" not in n]
        if len(todo) - fixed: self.notes.append("%d clip(s) placed by file date only (+-1 s, no sound to check them)" % (len(todo) - fixed))

    def run(self):
        self.clocks()
        self.m.save()
        self.check_clocks()
        self.unverified = set()
        for rnd in range(3):
            before = len(self.placed)
            self.place_recordings()
            if rnd == 0: self.unverify()
            self.place_cameras()
            self.no_overlaps()
            self.m.save()
            if len(self.placed) == before and rnd > 0: break
        self.finish_unverified()
        self.resolve_after_unverified()
        self.place_recorders_by_date()
        self.late_audio = True
        self.place_cameras()
        self.place_recorders_by_date()
        self.refine_by_partners()
        placed, unplaced = [], []
        for u in self.units:
            p = self.placed.get(u["id"])
            if p: placed.append(dict(id=u["id"], name=u["name"], kind=u["kind"], device=os.path.basename(u["dev"]), t=round(p["t"], 4), how=p["how"], why=p["why"],
                                     exact=u["id"] not in getattr(self, "coarse", set()) and "not checkable" not in p["why"]))
            else:
                reason = "media offline" if u.get("offline") else (u.get("why") or "no match")
                unplaced.append(dict(id=u["id"], name=u["name"], kind=u["kind"], device=os.path.basename(u["dev"]), reason=reason))
        cams = [dict(device=os.path.basename(d), clips=len(us), clock=self.devclock.get(d), onTimecode=d in self.master,
                     offset=round(getattr(self, "devoff", {}).get(d, 0.0), 3), checkedByLavs=d in getattr(self, "devoff", {}),
                     ltcChannel=next((list(x["ltcKey"][:2]) for x in us if x.get("ltcKey")), None)) for d, us in self.devs.items()]
        checked = set(os.path.basename(d) for d in getattr(self, "devoff", {}))
        notes = []
        for n in self.notes:
            if n in notes: continue
            if "could not be checked" in n and n.split(":")[0] in checked: continue
            notes.append(n)
        return {"placed": placed, "unplaced": unplaced, "cameras": cams, "notes": notes, "seconds": round(time.time() - T0, 1)}


ENV_SR = 100


def envelope(x):
    """10 ms log energy with its 2 s trend removed; None if too short."""
    if x is None: return None
    hop = COARSE_SR // ENV_SR
    m = len(x) // hop
    if m < 2 * ENV_SR: return None
    e = np.log(np.mean(x[:m * hop].reshape(m, hop) ** 2, axis=1) + 1e-10)
    k = 2 * ENV_SR
    tr = np.convolve(e, np.ones(k) / k, "same")
    return e - tr


def top_peaks(HS, n, pe, CS, k):
    """k best normalised correlation peaks of probe envelope pe in the haystack (CS = cumulative
    energy of the haystack, length+1): [(score, index where the probe starts)]."""
    pe = pe - pe.mean(); pn = np.linalg.norm(pe) or 1
    N = len(CS) - 1; L = len(pe)
    if N < L: return []
    r = np.fft.irfft(HS * np.conj(np.fft.rfft(pe, n)), n)[:N - L + 1]
    he = np.sqrt(np.maximum(CS[L:N + 1] - CS[0:N - L + 1], 1e-9))
    sc = r / (pn * he)
    sc[he < 1e-3] = 0
    out = []
    for _ in range(k):
        i = int(np.argmax(sc))
        if sc[i] <= 0: break
        out.append((float(sc[i]), i))
        sc[max(0, i - 3 * ENV_SR):i + 3 * ENV_SR] = -1
    return out


def hms(t):
    t = t % 86400
    return "%02d:%02d:%05.2f" % (int(t // 3600), int(t % 3600 // 60), t % 60)


def spread(lst):
    """Every 8th first, then the ones between (so early probes cover the whole day)."""
    out, seen = [], set()
    step = 8
    while step >= 1:
        for i in range(0, len(lst), step):
            if i not in seen: seen.add(i); out.append(lst[i])
        step //= 2
    return out


def accept(f, coarse=None, strict=False):
    """f: {channel: (seconds, ratio)}. Rules from measure.py (Sync External Audio)."""
    ks = sorted(f, key=lambda k: -f[k][1])
    for i in range(len(ks)):
        for j in range(i + 1, len(ks)):
            a, b = f[ks[i]], f[ks[j]]
            if abs(a[0] - b[0]) <= AGREE and min(a[1], b[1]) >= (4 if strict else 2):
                return a[0], "a:%s and a:%s agree (%.0f ms, ratios %.1f/%.1f)" % (ks[i][:2], ks[j][:2], abs(a[0] - b[0]) * 1000, a[1], b[1])
    for k in ks:
        if not strict and coarse and k in coarse and abs(f[k][0] - coarse[k]) <= AGREE and f[k][1] >= 3:
            return f[k][0], "coarse and fine agree on a:%s (ratio %.1f)" % (k[:2], f[k][1])
        if strict and f[k][1] >= 8:
            return f[k][0], "a:%s strong peak at the camera's clock estimate (ratio %.1f)" % (k[:2], f[k][1])
    return None, ", ".join("a:%s ratio %.1f" % (k[:2], v[1]) for k, v in f.items()) or "no peak"


if __name__ == "__main__":
    job = json.load(sys.stdin)
    out = Job(job).run()
    json.dump(out, sys.stdout)
