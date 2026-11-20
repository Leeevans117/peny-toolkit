"""Shared helpers for the Python tests (standard library + numpy, which the Toolkit already needs)."""
import importlib.util, os, shutil, subprocess, tempfile, wave
import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
FFMPEG = shutil.which("ffmpeg") or next((p for p in [os.path.expanduser("~/Library/Application Support/PenyToolkit/bin/ffmpeg"),
                                                      "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"] if os.path.exists(p)), None)


def load(rel, name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, rel))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def tmpdir():
    return tempfile.mkdtemp(prefix="peny qa é🎬 ")


def write_wav(path, x, sr=48000, ch=1):
    """x: float array (n,) or (n, ch) in -1..1 -> 16-bit PCM wav."""
    a = np.asarray(x, dtype=np.float64)
    if a.ndim == 1: a = a[:, None]
    pcm = (np.clip(a, -1, 1) * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(a.shape[1]); w.setsampwidth(2); w.setframerate(sr); w.writeframes(pcm.tobytes())
    return path


def speechy(seconds, sr, seed):
    """Noise bursts with pauses: enough structure for cross-correlation, like room sound + speech."""
    rng = np.random.default_rng(seed)
    n = int(seconds * sr)
    x = rng.standard_normal(n) * 0.02
    t = 0
    while t < n:
        ln = int(rng.uniform(0.2, 1.2) * sr)
        x[t:t + ln] += rng.standard_normal(min(ln, n - t)) * rng.uniform(0.1, 0.4)
        t += ln + int(rng.uniform(0.1, 0.8) * sr)
    return x


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)
