#!/usr/bin/env python3
"""Multicam Sync Test driver (Peny Toolkit). One run:
  1. mcjob.py   : the sequence's FCP XML (exported by Premiere) -> job.json (one unit per camera
                  clip, one per external audio file; the same file twice counts once)
  2. mcsync.py  : every clip on one clock (timecode, Tentacle LTC, file dates, waveform) -> out.json
  3. mcbuild.py : the XML rebuilt as a NEW sequence with every clip at its synced time -> synced.xml
Usage: mcrun.py <sequence.xml> <work folder> <new sequence name> <ffmpeg> <ffprobe> <cache folder> [<mac root> <vm root>]
Progress on stderr, a JSON summary on stdout."""
import json, os, subprocess, sys
here = os.path.dirname(os.path.abspath(__file__))
xml, work, name, ffmpeg, ffprobe, cache = sys.argv[1:7]
mapping = sys.argv[7:9]
os.makedirs(work, exist_ok=True)
job = os.path.join(work, "job.json"); out = os.path.join(work, "out.json"); dst = os.path.join(work, "synced.xml")
def run(args, **kw):
    p = subprocess.run([sys.executable, "-u"] + args, stdout=subprocess.PIPE, **kw)
    if p.returncode != 0: sys.stderr.write("%s failed (%d)\n" % (os.path.basename(args[0]), p.returncode)); sys.exit(p.returncode)
    return p.stdout
sys.stderr.write("Reading the sequence's clips\n"); sys.stderr.flush()
r = run([os.path.join(here, "mcjob.py"), xml, job] + (mapping or ["", ""]))
sys.stderr.write(r.decode()); sys.stderr.flush()
j = json.load(open(job)); j["ffmpeg"], j["ffprobe"], j["cacheDir"] = ffmpeg, ffprobe, cache
json.dump(j, open(job, "w"), indent=1)
with open(job) as fi, open(out, "w") as fo:
    p = subprocess.run([sys.executable, "-u", os.path.join(here, "mcsync.py")], stdin=fi, stdout=fo)
if p.returncode != 0: sys.stderr.write("mcsync.py failed (%d)\n" % p.returncode); sys.exit(p.returncode)
sys.stderr.write("Building the synced sequence\n"); sys.stderr.flush()
b = run([os.path.join(here, "mcbuild.py"), xml, out, job, dst, name])
o = json.load(open(out))
print(json.dumps({"xml": dst, "build": b.decode().strip(), "placed": len(o["placed"]), "unplaced": len(o["unplaced"]),
                  "exact": sum(1 for p in o["placed"] if p.get("exact")), "notes": o["notes"], "cameras": o["cameras"],
                  "unplacedList": o["unplaced"], "seconds": o["seconds"]}))
