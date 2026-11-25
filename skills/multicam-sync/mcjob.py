"""Premiere FCP7 XML export -> mcsync job (test helper). One unit per camera clip (unique file+start on video tracks),
one per external audio file (WAV not inside a RED .RDC folder), duplicates of the same file listed once."""
import sys, os, json, urllib.parse, xml.etree.ElementTree as ET
src, dst = sys.argv[1:3]
MAC, vmroot = (sys.argv[3:5] + ["", ""])[:2]   # test only: map Mac paths to another machine's mount
r = ET.parse(src).getroot(); seq = list(r.iter("sequence"))[0]
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mcsync import tc_seconds
files, ftc = {}, {}
for f in r.iter("file"):
    if f.find("pathurl") is not None:
        files[f.get("id")] = urllib.parse.unquote(f.findtext("pathurl")).replace("file://localhost", "")
        t = f.find("timecode")
        if t is not None and t.findtext("string"):   # Premiere's own reading of the file's timecode (ffprobe can't read R3D)
            tb_, ntsc = int(t.findtext("rate/timebase")), t.findtext("rate/ntsc") == "TRUE"
            st = t.findtext("string"); st = st[:8].replace(";", ":") + (";" if t.findtext("displayformat") == "DF" else ":") + st[9:]
            ftc[f.get("id")] = tc_seconds(st, tb_ * 1000 / 1001.0 if ntsc else tb_)
def tb(c): return int(c.findtext("rate/timebase") or seq.findtext("rate/timebase"))
units = []; seen = set(); dup = []
for ti, tr in enumerate(seq.find("media/video").findall("track")):
    for c in tr.findall("clipitem"):
        fid = c.find("file").get("id"); st = int(c.findtext("start"))
        if (fid, st) in seen: continue
        seen.add((fid, st)); t = tb(c)
        units.append(dict(id="v%d" % len(units), name=c.findtext("name"), kind="video", track=ti, path=files[fid].replace(MAC, vmroot) if MAC else files[fid],
                          inPoint=int(c.findtext("in")) / t, duration=(int(c.findtext("out")) - int(c.findtext("in"))) / t,
                          start=st / t, tc=ftc.get(fid) if files[fid].upper().endswith(".R3D") else None, proxy="", key=[fid, st]))
paths = set()
for ti, tr in enumerate(seq.find("media/audio").findall("track")):
    for c in tr.findall("clipitem"):
        p = files.get(c.find("file").get("id"), "")
        if not p.upper().endswith(".WAV") or ".RDC/" in p: continue
        if p in paths: dup.append((ti + 1, c.findtext("name"))); continue
        paths.add(p); t = tb(c)
        units.append(dict(id="a%d" % len(units), name=c.findtext("name"), kind="audio", track=ti, path=p.replace(MAC, vmroot) if MAC else p,
                          inPoint=0.0, duration=(int(c.findtext("out")) - int(c.findtext("in"))) / t, start=0, tc=None, proxy=""))
json.dump(dict(units=units, ffmpeg="ffmpeg", ffprobe="ffprobe", fps=int(seq.findtext("rate/timebase")), cacheDir="cache"), open(dst, "w"), indent=1)
print(len(units), "units:", sum(u["kind"] == "video" for u in units), "camera clips,", len(paths), "audio files; duplicates skipped:", len(dup), sorted(set(d[0] for d in dup)))
