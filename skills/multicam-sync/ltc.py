"""LTC (SMPTE linear timecode) read from an audio channel (Peny Toolkit, Multicam Sync).

Tentacle Sync boxes feed timecode into a camera's mic input when the camera has no timecode
socket (Hardline 16 Nov 2026: A7s left channel, R5 channel 1). Tentacle Sync Studio reads it
from the sound; so does this. Biphase-mark: every bit starts with a level change, a 1 has a
second change mid-bit; an 80-bit frame ends with the sync word 0011 1111 1111 1101.
"""
import numpy as np

SYNC = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1]


def _bcd(f, a, n):
    return sum(int(f[a + j]) << j for j in range(n))


def frames(x, sr):
    """[(seconds into x where the frame starts, h, m, s, f, dropframe)] for every frame found."""
    if x is None or len(x) < sr // 2: return []
    pk = np.abs(x).max()
    if pk <= 0: return []
    s = np.sign(x - np.median(x))
    s[s == 0] = 1
    idx = np.nonzero(np.diff(s))[0]
    if len(idx) < 400: return []
    iv = np.diff(idx).astype(float)
    full = np.percentile(iv, 75)
    if not (sr / 2600 <= full <= sr / 1300):  # bit = sr/(80*fps): 24..30 fps -> 1920..2400 baud
        return []
    bits, pos, i = [], [], 0
    while i < len(iv):
        if iv[i] > 0.75 * full:
            bits.append(0); pos.append(idx[i]); i += 1
        elif i + 1 < len(iv) and iv[i] + iv[i + 1] > 0.75 * full:
            bits.append(1); pos.append(idx[i]); i += 2
        else:
            i += 1
    b = np.array(bits, dtype=np.int8)
    out = []
    for k in range(64, len(b) - 15):
        if b[k] == 0 and b[k + 1] == 0 and list(b[k:k + 16]) == SYNC:
            f = b[k - 64:k]
            fr = _bcd(f, 0, 4) + 10 * _bcd(f, 8, 2)
            se = _bcd(f, 16, 4) + 10 * _bcd(f, 24, 3)
            mi = _bcd(f, 32, 4) + 10 * _bcd(f, 40, 3)
            hr = _bcd(f, 48, 4) + 10 * _bcd(f, 56, 2)
            if fr < 30 and se < 60 and mi < 60 and hr < 24:
                out.append((pos[k - 64] / float(sr), hr, mi, se, fr, int(f[10])))
    return out


def start_of(x, sr, fps_hint=None):
    """Timecode (seconds of day) at sample 0 of x, or None. Needs 10+ frames that agree to
    half a frame; the frame rate is taken from the frame numbers seen (max + 1), else the hint."""
    fs = frames(x, sr)
    if len(fs) < 10: return None
    top = max(f[4] for f in fs) + 1
    fps = top if top in (24, 25, 30) else (fps_hint or 25)
    # Reject runs that aren't counting: consecutive frames must step by one frame.
    t0s = [(h * 3600 + m * 60 + s + f / float(fps)) - t for t, h, m, s, f, _ in fs]
    t0s = np.array(t0s)
    med = np.median(t0s)
    good = np.abs(t0s - med) <= 0.5 / fps
    if good.sum() < max(10, 0.6 * len(fs)): return None
    return {"tc": float(np.mean(t0s[good])), "fps": fps, "frames": int(good.sum()), "of": len(fs),
            "spread_ms": round(float(np.ptp(t0s[good])) * 1000, 1)}
