"""Loudness Master meter. Reads a job on stdin, prints JSON on stdout.

  {"wav": path, "ffmpeg": path (optional)}
      -> {"integrated": LUFS, "lra": LU, "truePeak": dBTP, "samplePeak": dBFS, "duration": s}
      Whole-file EBU R128 figures from ffmpeg's ebur128 filter (peak=true+sample), read from
      the Summary block it prints at the end. ffmpeg is found the same way as Sound Pass:
      the installer's bundled copy first, then Homebrew.
"""
import json, os, re, subprocess, sys

FFMPEG = [os.path.expanduser("~/Library/Application Support/PenyToolkit/bin/ffmpeg"),
          "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]


def find_ffmpeg(given):
    for p in ([given] if given else []) + FFMPEG:
        if p and os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    raise RuntimeError("ffmpeg not found (" + ", ".join(FFMPEG) + ")")


def num(text, label, unit):
    # "I:         -14.0 LUFS" / "Peak:        -1.2 dBFS"; -inf on silence
    m = re.search(r"^\s*" + re.escape(label) + r":\s+(-?inf|-?[\d.]+)\s+" + re.escape(unit), text, re.M)
    if not m:
        raise RuntimeError("ebur128 summary has no " + label)
    v = m.group(1)
    return None if v.endswith("inf") else float(v)


def measure(job):
    ffmpeg = find_ffmpeg(job.get("ffmpeg"))
    wav = job["wav"]
    if not os.path.isfile(wav):
        raise RuntimeError("no such file: " + wav)
    p = subprocess.run([ffmpeg, "-hide_banner", "-nostats", "-i", wav, "-map", "0:a:0",
                        "-af", "ebur128=peak=true+sample:framelog=quiet", "-f", "null", "-"],
                       capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError("ffmpeg exited " + str(p.returncode) + ": " + p.stderr[-400:])
    err = p.stderr
    i = err.rfind("Summary:")
    if i < 0:
        raise RuntimeError("ebur128 printed no Summary: " + err[-400:])
    s = err[i:]
    tp = s[s.find("True peak:"):] if "True peak:" in s else ""
    sp = s[s.find("Sample peak:"):] if "Sample peak:" in s else ""
    dur = None
    m = re.search(r"time=(\d+):(\d+):([\d.]+)", err)
    d = re.search(r"Duration:\s*(\d+):(\d+):([\d.]+)", err)
    for mm in (m, d):
        if mm:
            dur = int(mm.group(1)) * 3600 + int(mm.group(2)) * 60 + float(mm.group(3))
            break
    return {
        "integrated": num(s, "I", "LUFS"),
        "lra": num(s, "LRA", "LU"),
        "truePeak": num(tp, "Peak", "dBFS") if tp else None,
        "samplePeak": num(sp, "Peak", "dBFS") if sp else None,
        "duration": dur,
    }


if __name__ == "__main__":
    try:
        out = measure(json.load(sys.stdin))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
    print(json.dumps(out))
