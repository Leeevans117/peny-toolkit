"""Load run for Sync External Audio's measure.py: a 1-hour recorder wav and 20 camera clips
(60 s each, mixed with room noise) at known places. Prints time and accuracy.
   python3 tests/stress/stress_sync.py"""
import json, os, subprocess, sys, threading, time
import numpy as np
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "python"))
from qa_util import ROOT, FFMPEG, tmpdir, write_wav, speechy

if not FFMPEG: print("SKIP no ffmpeg"); sys.exit(0)
d = tmpdir(); sr = 48000
rec = speechy(3600, sr, 11).astype(np.float32)
wav = write_wav(os.path.join(d, "ZOOM0001.WAV"), rec, sr)
rng = np.random.default_rng(5); starts = sorted(rng.uniform(10, 3500, 20)); clips = []
for i, s in enumerate(starts):
    cam = rec[int(s * sr):int((s + 60) * sr)] * 0.4 + rng.standard_normal(60 * sr).astype(np.float32) * 0.02
    p = write_wav(os.path.join(d, "C%04d.wav" % i), cam, sr)
    clips.append({"id": "c%d" % i, "path": p, "inPoint": 0.0, "duration": 60.0, "name": "C%04d.wav" % i})
del rec
job = {"ffmpeg": FFMPEG, "cacheDir": d, "wavs": [{"path": wav, "duration": 3600.0}], "clips": clips}
t0 = time.time()
proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "skills", "sync-external-audio", "measure.py")],
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
peak = [0]
def watch():  # measure.py's own memory (ps works on macOS and Linux)
    while proc.poll() is None:
        try: peak[0] = max(peak[0], int(subprocess.run(["ps", "-o", "rss=", "-p", str(proc.pid)], capture_output=True, text=True).stdout.strip() or 0) // 1024)
        except ValueError: pass
        time.sleep(0.2)
th = threading.Thread(target=watch); th.start()
out, err = proc.communicate(json.dumps(job)); th.join()
dt = time.time() - t0; peak = peak[0]
if proc.returncode: print("FAIL measure.py exited", proc.returncode, err[-500:]); sys.exit(1)
res = json.loads(out)["results"]
errs = [abs(r["wavTime"] - s) for r, s in zip(res, starts) if r["synced"]]
ok = len(errs) == 20 and max(errs) < 0.002
print("%s sync measure: 1 h wav, 20 clips | %.1f s | peak memory %.0f MB | %d/20 synced, worst error %.1f ms"
      % ("PASS" if ok else "FAIL", dt, peak, len(errs), 1000 * max(errs) if errs else -1))
sys.exit(0 if ok else 1)
