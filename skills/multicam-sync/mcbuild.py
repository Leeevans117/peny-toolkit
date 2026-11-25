"""Rebuild a Premiere FCP7 XML export as a NEW synced sequence from mcsync output (test helper).
Cameras (picture + their own sound, linked) move to their synced time; RED real-time wavs follow
their R3D; every external audio file goes once on one track per recorder folder (placed = Iris,
not placed = Violet at the end); duplicate copies of the same file are left out; links renumbered."""
import sys, json, uuid, copy, os, urllib.parse, xml.etree.ElementTree as ET
src, outj, jobj, dst, name = sys.argv[1:6]
tree = ET.parse(src); r = tree.getroot(); seq = list(r.iter("sequence"))[0]
TB = int(seq.findtext("rate/timebase"))
o = json.load(open(outj)); units = json.load(open(jobj))["units"]
pl = {p["id"]: p for p in o["placed"]}
seq.find("name").text = name
for u_ in seq.iter("uuid"): u_.text = str(uuid.uuid4())
files = {}
full = {}
for f in r.iter("file"):
    if f.find("pathurl") is not None:
        files[f.get("id")] = urllib.parse.unquote(f.findtext("pathurl")).replace("file://localhost", ""); full[f.get("id")] = copy.deepcopy(f)
vid = {tuple(u["key"]): u for u in units if u["kind"] == "video"}
aud = {os.path.basename(os.path.dirname(u["path"])) + "/" + u["name"]: u for u in units if u["kind"] == "audio"}
origin = int(min(p["t"] for p in o["placed"]) * TB)
new = {}; endmax = 0
for k, u in vid.items():
    p = pl.get(u["id"])
    if p:
        new[k] = int(round(p["t"] * TB)) - origin
        endmax = max(endmax, new[k] + int(round(u["duration"] * TB)))
cur = endmax + 5 * TB
for k, u in sorted(vid.items(), key=lambda kv: kv[1]["start"]):
    if k not in new:
        new[k] = cur; cur += int(round(u["duration"] * TB)) + 5 * TB
def shift(c, ns):
    st, en = int(c.findtext("start")), int(c.findtext("end"))
    c.find("start").text = str(ns); c.find("end").text = str(ns + en - st)
vname = {k: u["name"] for k, u in vid.items()}
lavitems = {}; dropped = 0; problems = []; delta = {}
for kind in ("video", "audio"):
    media = seq.find("media/" + kind)
    for tr in list(media.findall("track")):
        for c in list(tr.findall("clipitem")):
            fid = c.find("file").get("id"); k = (fid, int(c.findtext("start")))
            p = files.get(fid, "")
            if k in new:
                delta[c.get("id")] = new[k] - k[1]; shift(c, new[k])
                u = vid.get(k); p = pl.get(u["id"]) if u else None
                colour = "Violet" if not p else (None if p.get("exact") else "Mango")
                if colour:
                    lab = c.find("labels")
                    if lab is None: lab = ET.SubElement(c, "labels")
                    if lab.find("label2") is None: ET.SubElement(lab, "label2")
                    lab.find("label2").text = colour
                continue
            lk = [delta[l.findtext("linkclipref")] for l in c.findall("link") if l.findtext("mediatype") == "video" and l.findtext("linkclipref") in delta]
            if kind == "audio" and lk:   # camera sound with its own file entry (RED R3D audio): moves with the picture it is linked to
                shift(c, k[1] + lk[0]); continue
            if kind == "audio" and p.upper().endswith(".WAV") and ".RDC/" not in p:
                key = os.path.basename(os.path.dirname(p)) + "/" + os.path.basename(p)
                if key in lavitems: dropped += 1
                else: lavitems[key] = c
                tr.remove(c); continue
            nm = c.findtext("name"); hit = sorted([vk for vk in new if vname[vk].startswith(nm + "_")], key=lambda vk: abs(vk[1] - k[1]))
            if hit and (len(hit) == 1 or abs(hit[0][1] - k[1]) < abs(hit[1][1] - k[1])):
                shift(c, k[1] + new[hit[0]] - hit[0][1])
            else: problems.append((kind, nm, k))
        if kind == "audio" and not tr.findall("clipitem") and tr.get("totalExplodedTrackCount", "1") == "1": media.remove(tr)
        items = tr.findall("clipitem")
        for c in items: tr.remove(c)
        items.sort(key=lambda c: int(c.findtext("start")))
        for i, c in enumerate(items): tr.insert(i, c)
last = cur
media = seq.find("media/audio"); folders = {}
for key, c in lavitems.items(): folders.setdefault(key.split("/")[0], []).append((key, c))
for d, items in sorted(folders.items()):
    tr = ET.SubElement(media, "track"); rows = []
    for key, c in items:
        u = aud[key]; p = pl.get(u["id"]); dur = int(c.findtext("end")) - int(c.findtext("start"))
        rows.append([int(round(p["t"] * TB)) - origin if p else None, c, dur, bool(p), bool(p and p.get("exact"))])
    for row in sorted([x for x in rows if x[0] is None], key=lambda x: x[1].findtext("name")):
        row[0] = last; last += row[2] + 5 * TB
    rows.sort(key=lambda x: x[0])
    for j in range(1, len(rows)):   # one recorder, one file at a time: a file-date (+-1 s) file gives way
        pe = rows[j-1][0] + rows[j-1][2]
        if pe <= rows[j][0]: continue
        if pe - rows[j][0] <= 2 or not rows[j][4]: rows[j][0] = pe
        elif not rows[j-1][4]: rows[j-1][0] = rows[j][0] - rows[j-1][2]
        else: problems.append(("lav overlap", rows[j][1].findtext("name"), pe - rows[j][0]))
    for ns, c, dur, ok, exact in rows:
        shift(c, ns)
        for l in c.findall("link"): c.remove(l)
        lab = c.find("labels")
        if lab is None: lab = ET.SubElement(c, "labels")
        if lab.find("label2") is None: ET.SubElement(lab, "label2")
        lab.find("label2").text = ("Iris" if exact else "Mango") if ok else "Violet"
        tr.append(c)
    for t in ("enabled", "locked"):
        e = ET.SubElement(tr, t); e.text = "TRUE" if t == "enabled" else "FALSE"
# every file id: full definition at its first use, bare reference after
seen = set()
for f in r.iter("file"):
    fid = f.get("id")
    if fid not in full: continue
    if fid not in seen:
        seen.add(fid)
        if f.find("pathurl") is None:
            for ch in list(full[fid]): f.append(copy.deepcopy(ch))
    else:
        for ch in list(f): f.remove(ch)
pos = {}
for kind in ("video", "audio"):
    for ti, tr in enumerate(seq.find("media/" + kind).findall("track")):
        for ci, c in enumerate(tr.findall("clipitem")): pos[c.get("id")] = (ti + 1, ci + 1)
nl = 0
for c in seq.iter("clipitem"):
    for l in c.findall("link"):
        p = pos.get(l.findtext("linkclipref"))
        if p is None: c.remove(l); continue
        l.find("trackindex").text, l.find("clipindex").text = str(p[0]), str(p[1]); nl += 1
seq.find("duration").text = str(last)
tc = seq.find("timecode"); tc.find("frame").text = str(origin)
h, rem = divmod(origin, TB * 3600); m_, rem = divmod(rem, TB * 60); s_, f_ = divmod(rem, TB)
tc.find("string").text = "%02d:%02d:%02d:%02d" % (h, m_, s_, f_)
tree.write(dst, encoding="UTF-8", xml_declaration=True)
print("origin", tc.find("string").text, "cameras placed", sum(1 for k in vid if pl.get(vid[k]["id"])), "of", len(vid),
      "| lav files", len(lavitems), "(duplicate copies left out %d)" % dropped, "| links", nl, "| end", last, "| problems", problems[:5], len(problems))
