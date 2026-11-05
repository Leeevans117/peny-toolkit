"""Builds Lumetri Color effects that carry a LUT, the way Premiere 26.5 stores one Lee loaded by
hand (his "CANON LUT" effect, read from a copy of the How We Roll project on 3 Oct 2026):

- param 0 "Blob": Lumetri's state XML. The Creative Look group names the .cube path twice
  (__Preset, LUT) and an <embeddedlut> entry pairs a 16-byte hash with that path.
- param 33: the look's display name (UTF-16LE, null-terminated).
- param 122 "Embedded LUTs": hash (16 bytes) + uint32 length of the rest + "ITX3" + uint32 grid
  size + uint32 3 + uint32 0 + 6 float32 (domain min xyz, max xyz) + the .cube's RGB float32
  values in file order (red fastest). Checked byte for byte against Lee's CANON LUT.

template.xml holds Lee's CANON LUT effect (VideoFilterComponent + its 130 param objects) with the
embedded LUT left out; plain.xml holds a plain Lumetri Color as Premiere adds it.

Every value written gets a BinaryHash attribute ("<12 bytes>-...<uint32 length+12>"); without
it Premiere drops the value when it reads the file (seen 3 Oct 2026). Premiere's own 12 bytes are
not a plain MD5/SHA; MD5 is used and Premiere accepted it.

Used two ways:
  python3 lutpreset.py presets <out.prfpset> <spec.json>
      writes an effect preset file: spec {"bin", "adjustments": name of a plain Lumetri preset,
      "entries": [{"name", "lut" | "effect" | "plain"}], "paths": [.cube files or folders]}.
  python3 lutpreset.py inject <project.xml> <out.xml> <chain ObjectID> <lut> [adjustments name]
      test only: adds the LUT effect under the clip's Lumetri in an exported project and names
      them, so the result can be imported back into Premiere and rendered.
"""
import base64
import hashlib
import json
import os
import re
import struct
import sys
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
LUT_EXT = (".cube",)


class LutError(Exception):
    pass


def parse_cube(path):
    size, dmin, dmax, vals = None, [0.0, 0.0, 0.0], [1.0, 1.0, 1.0], []
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            head = s.split()[0].upper()
            if head == "LUT_3D_SIZE":
                size = int(s.split()[1])
            elif head == "LUT_1D_SIZE":
                raise LutError("1D LUT (LUT_1D_SIZE) - only 3D .cube LUTs are supported")
            elif head == "DOMAIN_MIN":
                dmin = [float(x) for x in s.split()[1:4]]
            elif head == "DOMAIN_MAX":
                dmax = [float(x) for x in s.split()[1:4]]
            elif head in ("TITLE", "LUT_3D_INPUT_RANGE", "LUT_1D_INPUT_RANGE"):
                continue
            elif re.match(r"^[-+.0-9eE]", head):
                p = s.split()
                if len(p) < 3:
                    raise LutError("bad data line: " + s[:40])
                vals.extend(float(x) for x in p[:3])
            # other keywords (e.g. vendor tags) are ignored
    if not size:
        raise LutError("no LUT_3D_SIZE line")
    if len(vals) != size ** 3 * 3:
        raise LutError("expected %d values for size %d, found %d" % (size ** 3 * 3, size, len(vals)))
    return size, dmin, dmax, vals


def lut_hash(path):
    with open(path, "rb") as f:
        return hashlib.md5(f.read()).digest()


def embedded_blob(path):
    h = lut_hash(path)
    with open(path, "rb") as f:
        head = f.read(4)
    if head == b"ITX3":
        # Premiere's own binary LUT (.itx, e.g. the SL looks in its Creative folder) is already
        # the embedded body: "ITX3", size, 3, flag, 6 f32 domain, floats (checked 13 Oct 2026).
        with open(path, "rb") as f:
            body = f.read()
        return h + struct.pack("<I", len(body)) + body, h
    size, dmin, dmax, vals = parse_cube(path)
    body = b"ITX3" + struct.pack("<III", size, 3, 0) + struct.pack("<6f", *(dmin + dmax)) + struct.pack("<%df" % len(vals), *vals)
    return h + struct.pack("<I", len(body)) + body, h


def utf16z(s):
    return (s + "\0").encode("utf-16-le")


def _b64(data):
    return base64.b64encode(data).decode("ascii")


def _objects(xml):
    """Top-level objects of a template file: list of (tag, ObjectID, text)."""
    out = []
    for m in re.finditer(r"\t<(\w+) ObjectID=\"(\d+)\"[\s\S]*?\n\t</\1>", xml):
        out.append([m.group(1), m.group(2), m.group(0)])
    return out


def _binary_hash(data):
    """Premiere's BinaryHash attribute: 12 bytes of hash + uint32 (length + 12), shown as a GUID.
    Premiere's own 12 bytes are not a plain MD5/SHA; MD5 is used here (see docs/skills.md, Colour)."""
    h = hashlib.md5(data).hexdigest()[:24] + "%08x" % (len(data) + 12)
    return "%s-%s-%s-%s-%s" % (h[0:8], h[8:12], h[12:16], h[16:20], h[20:32])


def _set_param_value(text, data):
    """Replaces an Arb param's StartKeyframeValue with data (bytes), with a BinaryHash."""
    new = '<StartKeyframeValue Encoding="base64" BinaryHash="%s">%s\n\t\t</StartKeyframeValue>' % (_binary_hash(data), _b64(data))
    text2, n = re.subn(r"<StartKeyframeValue Encoding=\"base64\"[^>]*?(?:/>|>[^<]*</StartKeyframeValue>)", lambda m: new, text, count=1)
    if n != 1:
        raise LutError("template param has no StartKeyframeValue")
    return text2


def _component(template_file, next_id, instance_name, edit):
    """Copies a template effect with fresh ObjectIDs from next_id. edit(index, text) may change a
    param object. Returns (component id, [xml objects], next free id)."""
    with open(os.path.join(HERE, template_file), "r", encoding="utf-8") as f:  # absolute paths pass through join
        objs = _objects(f.read())
    comp = objs[0]
    params = dict((int(i), r) for i, r in re.findall(r'<Param Index="(\d+)" ObjectRef="(\d+)"/>', comp[2]))
    by_id = dict((o[1], o) for o in objs[1:])
    remap = {comp[1]: str(next_id)}
    next_id += 1
    for idx in sorted(params):
        remap[params[idx]] = str(next_id)
        next_id += 1
    out = []
    ctext = re.sub(r'ObjectID="\d+"', 'ObjectID="%s"' % remap[comp[1]], comp[2], count=1)
    ctext = re.sub(r'(<Param Index="\d+" ObjectRef=")(\d+)("/>)', lambda m: m.group(1) + remap[m.group(2)] + m.group(3), ctext)
    ctext = re.sub(r"\s*<InstanceName>[^<]*</InstanceName>", "", ctext)
    if instance_name is not None:
        ctext = ctext.replace("</DisplayName>", "</DisplayName>\n\t\t\t<InstanceName>%s</InstanceName>" % _xml_text(instance_name), 1)
    out.append(ctext)
    for idx in sorted(params):
        o = by_id[params[idx]]
        t = re.sub(r'ObjectID="\d+"', 'ObjectID="%s"' % remap[o[1]], o[2], count=1)
        out.append(edit(idx, t) if edit else t)
    return remap[comp[1]], out, next_id


def _xml_text(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def lut_component(lut_path, name, next_id):
    blob, h = embedded_blob(lut_path)
    hhex = h.hex().upper()

    def edit(idx, text):
        if idx == 0:
            m = re.search(r'<StartKeyframeValue Encoding="base64"[^>]*>([^<]*)<', text)
            state = base64.b64decode(m.group(1)).decode("utf-8")
            old = re.search(r"<embeddedlut>\s*<hash>([0-9A-F]+)</hash>\s*<filename>([^<]*)</filename>", state)
            state = state.replace(old.group(2), _xml_text(lut_path)).replace(old.group(1), hhex)
            state = re.sub(r'<guid>"[^"]*"</guid>', '<guid>"%s"</guid>' % uuid.uuid1(), state, count=1)
            return _set_param_value(text, state.encode("utf-8"))
        if idx == 33:
            return _set_param_value(text, utf16z(name))
        if idx == 122:
            return _set_param_value(text, blob)
        return text
    return _component("template.xml", next_id, name, edit)


def plain_component(name, next_id):
    return _component("plain.xml", next_id, name, None)


def effect_component(effect_file, name, next_id):
    """A whole Lumetri effect saved from a project (e.g. Lee's own "CANON LUT"), copied as is."""
    return _component(effect_file, next_id, name, None)


# ---- effect preset file (.prfpset) ----
PRESET_HEAD = """<?xml version="1.0" encoding="UTF-8"?>
<PremiereData Version="3">
\t<Tree ObjectRef="1"/>
\t<Tree ObjectID="1" ClassID="177f2841-dd5b-43bd-9d9a-79e231bd47dd" Version="1">
\t\t<RootBin ObjectRef="2"/>
\t\t<Node Version="1">
\t\t</Node>
\t</Tree>
\t<BinTreeItem ObjectID="2" ClassID="5e0f46fa-384f-4c09-bc53-0b8e2b7005b5" Version="4">
\t\t<TreeItemBase Version="4">
\t\t\t<Locked>false</Locked>
\t\t\t<Node Version="1">
\t\t\t</Node>
\t\t\t<Name>Root</Name>
\t\t</TreeItemBase>
\t\t<Sorted>false</Sorted>
\t\t<Expanded>false</Expanded>
\t\t<Items Version="1">
\t\t\t<Item Index="0" ObjectRef="3"/>
\t\t</Items>
\t</BinTreeItem>
\t<BinTreeItem ObjectID="3" ClassID="5e0f46fa-384f-4c09-bc53-0b8e2b7005b5" Version="4">
\t\t<TreeItemBase Version="4">
\t\t\t<Locked>false</Locked>
\t\t\t<Node Version="1">
\t\t\t</Node>
\t\t\t<Name>%(bin)s</Name>
\t\t</TreeItemBase>
\t\t<Sorted>true</Sorted>
\t\t<Expanded>true</Expanded>
\t\t<Items Version="1">
%(items)s\t\t</Items>
\t</BinTreeItem>
"""

PRESET_ITEM = """\t<TreeItem ObjectID="%(tree)d" ClassID="025f59ac-1f29-42c0-9897-ada1059bd547" Version="3">
\t\t<TreeItemBase Version="4">
\t\t\t<Locked>false</Locked>
\t\t\t<Data ObjectRef="%(item)d"/>
\t\t\t<Node Version="1">
\t\t\t\t<Properties Version="1">
\t\t\t\t\t<MZ.EffectPresets.PresetUID>%(uid)s</MZ.EffectPresets.PresetUID>
\t\t\t\t</Properties>
\t\t\t</Node>
\t\t\t<Name>%(name)s</Name>
\t\t</TreeItemBase>
\t</TreeItem>
\t<FilterPresetItem ObjectID="%(item)d" ClassID="e56c9ba0-91cb-4f21-9174-c1b52448c6c9" Version="2">
\t\t<FilterPresets Version="1">
\t\t\t<FilterPreset Index="0" ObjectRef="%(preset)d"/>
\t\t</FilterPresets>
\t\t<EffectItem Version="1">
\t\t\t<EffectIsShorcut>false</EffectIsShorcut>
\t\t\t<EffectFlavor>5</EffectFlavor>
\t\t</EffectItem>
\t</FilterPresetItem>
\t<FilterPreset ObjectID="%(preset)d" ClassID="ee52a7d2-069e-47f7-aa30-e3e3286b65a3" Version="3">
\t\t<Node Version="1">
\t\t</Node>
\t\t<TransitionDuration>0</TransitionDuration>
\t\t<Speed>1.</Speed>
\t\t<AnchorOutPoint>16500879360000</AnchorOutPoint>
\t\t<AnchorInPoint>0</AnchorInPoint>
\t\t<MediaType>228cda18-3625-4d2d-951e-348879e4ed93</MediaType>
\t\t<Type>0</Type>
\t\t<Component ObjectRef="%(comp)s"/>
\t\t<FilterMatchName>AE.ADBE Lumetri</FilterMatchName>
\t\t<Description></Description>
\t</FilterPreset>
"""


def write_presets(out_path, bin_name, entries):
    """entries: [{"name", and one of "lut" (.cube path), "effect" (effect xml file), "plain": true}].
    Returns one result per entry."""
    next_id, items, bodies, results = 10, [], [], []
    for e in entries:
        name = e["name"]
        tree, item, preset = next_id, next_id + 1, next_id + 2
        next_id += 3
        try:
            if e.get("lut"):
                comp_id, objs, next_id = lut_component(e["lut"], name, next_id)
            elif e.get("effect"):
                comp_id, objs, next_id = effect_component(e["effect"], name, next_id)
            else:
                comp_id, objs, next_id = plain_component(name, next_id)
        except (LutError, OSError, ValueError, UnicodeDecodeError) as ex:
            results.append(dict(e, ok=False, error=str(ex)))
            continue
        items.append('\t\t\t<Item Index="%d" ObjectRef="%d"/>\n' % (len(items), tree))
        bodies.append(PRESET_ITEM % {"tree": tree, "item": item, "preset": preset, "uid": uuid.uuid4(), "name": _xml_text(name), "comp": comp_id})
        bodies.extend(o + "\n" for o in objs)
        results.append(dict(e, ok=True))
    text = PRESET_HEAD % {"bin": _xml_text(bin_name), "items": "".join(items)} + "".join(bodies) + "</PremiereData>\n"
    tmp = out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, out_path)
    return results


def collect(paths, skip_dirs=()):
    """.cube files under the given files/folders, de-duplicated by content. Preset name = file name
    without extension; a clash between different files adds the parent folder: "name (folder)".
    Returns (entries, skipped)."""
    files, skipped = [], []
    for p in paths:
        if os.path.isdir(p):
            for root, dirs, names in os.walk(p):
                dirs[:] = [d for d in dirs if not d.startswith(".")]
                for n in sorted(names):
                    files.append(os.path.join(root, n))
        else:
            files.append(p)
    seen, entries, names = {}, [], {}
    for f in files:
        ext = os.path.splitext(f)[1].lower()
        if os.path.basename(f).startswith("._"):
            continue
        if ext in (".look", ".3dl", ".lut", ".csp", ".itx"):
            skipped.append({"file": f, "reason": ext + " files are not supported (only .cube)"})
            continue
        if ext != ".cube" or any(f.startswith(s) for s in skip_dirs):
            continue
        h = lut_hash(f)
        if h in seen:
            skipped.append({"file": f, "reason": "same LUT as " + seen[h]})
            continue
        seen[h] = f
        entries.append({"name": os.path.splitext(os.path.basename(f))[0], "lut": f})
    for e in entries:
        names.setdefault(e["name"], []).append(e)
    for n, group in names.items():
        if len(group) > 1:
            for e in group:
                e["name"] = "%s (%s)" % (n, os.path.basename(os.path.dirname(e["lut"])))
    return entries, skipped


# ---- test: inject into an exported project ----
def _object_text(x, oid):
    m = re.search(r'\t<(\w+) ObjectID="%s"[\s\S]*?\n\t</\1>' % oid, x)
    return m.group(0) if m else ""


def inject(project_xml, out_xml, chain_id, lut, adjustments):
    with open(project_xml, "r", encoding="utf-8") as f:
        x = f.read()
    next_id = max(int(i) for i in re.findall(r'ObjectID="(\d+)"', x)) + 1000
    chain = _object_text(x, chain_id)
    refs = re.findall(r'<Component Index="(\d+)" ObjectRef="(\d+)"/>', chain)
    plain_ref = [r for i, r in refs if "AE.ADBE Lumetri" in _object_text(x, r)][0]
    comp_text = _object_text(x, plain_ref)
    named = re.sub(r"\s*<InstanceName>[^<]*</InstanceName>", "", comp_text).replace(
        "</DisplayName>", "</DisplayName>\n\t\t\t<InstanceName>%s</InstanceName>" % _xml_text(adjustments), 1)
    x = x.replace(comp_text, named, 1)
    name = os.path.splitext(os.path.basename(lut))[0]
    comp_id, objs, next_id = lut_component(lut, name, next_id)
    last = refs[-1]
    new_chain = chain.replace('<Component Index="%s" ObjectRef="%s"/>' % last,
                              '<Component Index="%s" ObjectRef="%s"/>\n\t\t\t\t<Component Index="%d" ObjectRef="%s"/>' % (last[0], last[1], len(refs), comp_id), 1)
    x = x.replace(chain, new_chain, 1)
    x = x.replace("</PremiereData>", "\n".join(objs) + "\n</PremiereData>")
    with open(out_xml, "w", encoding="utf-8") as f:
        f.write(x)
    return {"chain": chain_id, "components": len(refs) + 1, "lut": name, "lutComponent": comp_id, "adjustmentsComponent": plain_ref}



# ---- grade: add effects from a preset file to clips of an exported sequence ----
def load_presets(prfpset):
    """Lumetri presets in an effect preset file: {name: [component xml, param xml...]} with every
    value filled in (Premiere stores repeated values once, later uses carry only BinaryHash)."""
    with open(prfpset, "r", encoding="utf-8") as f:
        x = f.read()
    pool = {}
    for m in re.finditer(r'<StartKeyframeValue Encoding="base64" BinaryHash="([^"]+)">[^<]*</StartKeyframeValue>', x):
        pool.setdefault(m.group(1), m.group(0))
    objs = {}
    for m in re.finditer(r'\t<(\w+) ObjectID="(\d+)"[\s\S]*?\n\t</\1>', x):
        objs[m.group(2)] = m.group(0)
    out = {}
    for t in [o for o in objs.values() if o.startswith("\t<TreeItem ")]:
        dm, nm = re.search(r'<Data ObjectRef="(\d+)"/>', t), re.search(r"<Name>([^<]*)</Name>", t)
        if not dm or not nm:
            continue
        m = (dm.group(1), nm.group(1))
        item = objs.get(m[0], "")
        pm = re.search(r'<FilterPreset Index="0" ObjectRef="(\d+)"/>', item)
        if not pm:
            continue
        preset = objs.get(pm.group(1), "")
        if "<FilterMatchName>AE.ADBE Lumetri</FilterMatchName>" not in preset:
            continue
        cid = re.search(r'<Component ObjectRef="(\d+)"/>', preset).group(1)
        comp = objs[cid]
        parts = [comp]
        for i, r in re.findall(r'<Param Index="(\d+)" ObjectRef="(\d+)"/>', comp):
            o = objs[r]
            ref = re.search(r'<StartKeyframeValue Encoding="base64" BinaryHash="([^"]+)"/>', o)
            if ref and ref.group(1) in pool:
                o = o.replace(ref.group(0), pool[ref.group(1)])
            parts.append(o)
        name = m[1].replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
        out[name] = parts
    return out


def _copy_objects(parts, next_id, instance_name, comp_id=None):
    """Copies an effect with fresh ObjectIDs; comp_id sets the component's <ID> in its chain."""
    comp = parts[0]
    old_cid = re.search(r'ObjectID="(\d+)"', comp).group(1)
    remap = {old_cid: str(next_id)}
    next_id += 1
    for i, r in re.findall(r'<Param Index="(\d+)" ObjectRef="(\d+)"/>', comp):
        remap[r] = str(next_id)
        next_id += 1
    out = []
    c = re.sub(r'ObjectID="\d+"', 'ObjectID="%s"' % remap[old_cid], comp, count=1)
    c = re.sub(r'(<Param Index="\d+" ObjectRef=")(\d+)("/>)', lambda m: m.group(1) + remap[m.group(2)] + m.group(3), c)
    c = re.sub(r"\s*<InstanceName>[^<]*</InstanceName>", "", c)
    c = c.replace("</DisplayName>", "</DisplayName>\n\t\t\t<InstanceName>%s</InstanceName>" % _xml_text(instance_name), 1)
    if comp_id is not None:
        c = re.sub(r"<ID>\d+</ID>", "<ID>%d</ID>" % comp_id, c, count=1)
    out.append(c)
    for o in parts[1:]:
        oid = re.search(r'ObjectID="(\d+)"', o).group(1)
        out.append(re.sub(r'ObjectID="\d+"', 'ObjectID="%s"' % remap[oid], o, count=1))
    return remap[old_cid], out, next_id


def lut_label(v):
    """Effect name for a LUT choice: a preset's own name, or a LUT file's name without extension."""
    if v.startswith("file:"):
        return os.path.splitext(os.path.basename(v[5:]))[0]
    return v


def grade(project_in, project_out, plan):
    """plan: {"sequence": uid, "newSequence": uid, "newName", "oldName", "presets": prfpset path,
    "adjustments": preset name, "clips": [{"track", "index", "start" (ticks), "lut": preset or null,
    "adjustments": bool}]}. Appends [LUT, Adjustments] to each clip's chain, so Effect Controls
    reads Adjustments, LUT, then whatever the clip had (see below). Returns a report."""
    import gzip
    raw = open(project_in, "rb").read()
    x = (gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw).decode("utf-8")
    presets = load_presets(plan["presets"]) if plan.get("presets") else {}
    if plan["adjustments"] not in presets:
        with open(os.path.join(HERE, "plain.xml"), "r", encoding="utf-8") as f:
            presets[plan["adjustments"]] = [o[2] for o in _objects(f.read())]
    # A LUT given as "file:<path>" (.cube or .itx, e.g. Premiere's Creative folder) is built
    # into a Lumetri here, named after the file, instead of copied from a preset.
    for c in plan["clips"]:
        v = c.get("lut")
        if v and v.startswith("file:") and v not in presets:
            presets[v] = lut_component(v[5:], lut_label(v), 1)[1]
    need = set([plan["adjustments"]] + [c["lut"] for c in plan["clips"] if c.get("lut")])
    missing = [n for n in need if n not in presets]
    if missing:
        raise LutError("not in the preset file: " + ", ".join(sorted(missing)))
    objs = {}
    for m in re.finditer(r'\t<(\w+) Object(?:U)?ID="([^"]+)"[\s\S]*?\n\t</\1>', x):
        objs[m.group(2)] = m.group(0)
    seq = objs[plan["sequence"]]
    vgroup = None
    for r in re.findall(r'<TrackGroup Index="\d+">[\s\S]*?ObjectRef="(\d+)"', seq) + re.findall(r'ObjectRef="(\d+)"', seq):
        if objs.get(r, "").startswith("\t<VideoTrackGroup "):
            vgroup = objs[r]
            break
    if not vgroup:
        raise LutError("video track group not found")
    tracks = dict((int(i), u) for i, u in re.findall(r'<Track Index="(\d+)" ObjectURef="([^"]+)"/>', vgroup))
    next_id = max(int(i) for i in re.findall(r'ObjectID="(\d+)"', x)) + 1000
    new_objs, done, problems, seen_hash = [], 0, [], set(re.findall(r'BinaryHash="([^"]+)">', x))
    for c in plan["clips"]:
        if not c.get("lut") and not c.get("adjustments"):
            continue  # nothing to add (12 Oct 2026: such a clip next to a transition stopped the whole run)
        track = objs.get(tracks.get(c["track"], ""), "")
        items = re.findall(r'<TrackItem Index="(\d+)" ObjectRef="(\d+)"/>', track)
        # The XML lists clips per track in time order, like the DOM; check the start too.
        # Only clips: a transition starting with the clip has the same <Start> (12 Oct 2026, V4).
        items = [(i, r) for i, r in items if objs.get(r, "").startswith("\t<VideoClipTrackItem ")]
        cand = [r for i, r in items if int(re.search(r"<Start>(-?\d+)</Start>", objs[r]).group(1) if "<Start>" in objs[r].split("</TrackItem>")[0] else 0) == int(c["start"])]
        if len(cand) != 1:
            problems.append({"clip": c, "reason": "%d track items at that start" % len(cand)})
            continue
        ti = objs[cand[0]]
        chain_id = re.search(r'<Components ObjectRef="(\d+)"/>', ti).group(1)
        chain = objs[chain_id]
        refs = [r for i, r in re.findall(r'<Component Index="(\d+)" ObjectRef="(\d+)"/>', chain)]
        # Premiere renders a clip's effects from the END of the chain upwards, and Effect Controls
        # lists them in that order (top = first). trackItem.components and QE list the chain in
        # file order, i.e. upside down. Proven 3 Oct 2026 by render: B&W LUT + Adjustments with
        # Temperature +100 came out grey only with the chain written [LUT, Adjustments]. So the
        # new effects go at the end of the chain as [LUT, Adjustments]: Effect Controls shows
        # Adjustments, then the LUT, then whatever the clip already had. Each gets its own <ID>.
        # New <ID>s go above every ID in use, including the implicit Motion/Opacity ones (1 and 2):
        # a clip with no effects yet otherwise got a LUT with ID 2, the same as Opacity.
        defaults = [int(i) for i in re.findall(r"<Default(?:Motion|Opacity)ComponentID>(\d+)<", chain)]
        top = max([int(i) for r in refs for i in re.findall(r"<ID>(\d+)</ID>", objs.get(r, ""))[:1]] + defaults + [1])
        add = []
        if c.get("lut"):
            cid, o, next_id = _copy_objects(presets[c["lut"]], next_id, lut_label(c["lut"]), top + 1)
            add.append(cid); new_objs.extend(o)
        if c.get("adjustments"):
            cid, o, next_id = _copy_objects(presets[plan["adjustments"]], next_id, plan["adjustments"], top + 2)
            add.append(cid); new_objs.extend(o)
        if not add:
            continue
        refs = refs + add
        lines = "".join('\t\t\t\t<Component Index="%d" ObjectRef="%s"/>\n' % (k, r) for k, r in enumerate(refs))
        if "<Components Version=" in chain:
            new_chain = re.sub(r'(<Components Version="\d+">\n)[\s\S]*?(\t\t\t</Components>)', lambda m: m.group(1) + lines + m.group(2), chain, count=1)
        elif "<ComponentChain Version=" in chain:
            # A clip with no effects yet: <Components> goes at the END of <ComponentChain>, after
            # <Node>, as Premiere writes it. Put before <Node>, importSequences silently imported
            # nothing (13 Oct 2026, a sequence whose clips had no Lumetri).
            new_chain = re.sub(r'(\n)(\t\t</ComponentChain>)', lambda m: m.group(1) + '\t\t\t<Components Version="1">\n' + lines + '\t\t\t</Components>\n' + m.group(2), chain, count=1)
            if new_chain == chain:
                raise LutError("could not place the effects in: " + chain[:200])
        else:
            raise LutError("unexpected component chain: " + chain[:200])
        x = x.replace(chain, new_chain, 1)
        objs[chain_id] = new_chain
        done += 1
    # Store each value once: later copies of the same value only carry its BinaryHash.
    final = []
    for o in new_objs:
        def shrink(m):
            h = m.group(1)
            if h in seen_hash:
                return '<StartKeyframeValue Encoding="base64" BinaryHash="%s"/>' % h
            seen_hash.add(h)
            return m.group(0)
        final.append(re.sub(r'<StartKeyframeValue Encoding="base64" BinaryHash="([^"]+)">[^<]*</StartKeyframeValue>', shrink, o))
    x = x.replace("</PremiereData>", "\n".join(final) + "\n</PremiereData>")
    x = x.replace(plan["sequence"], plan["newSequence"])
    x = x.replace(">%s<" % _xml_text(plan["oldName"]), ">%s<" % _xml_text(plan["newName"]))
    with open(project_out, "wb") as f:
        f.write(gzip.compress(x.encode("utf-8"), 6))
    return {"clips": done, "problems": problems}


def main(argv):
    if argv[0] == "presets":
        # presets <out.prfpset> <spec.json>: {"bin", "entries": [...], "paths": [...], "adjustments"}
        spec = json.load(open(argv[2]))
        entries = list(spec.get("entries", []))
        skipped = []
        if spec.get("adjustments"):
            entries.insert(0, {"name": spec["adjustments"], "plain": True})
        if spec.get("paths"):
            more, skipped = collect(spec["paths"], spec.get("skipDirs", []))
            taken = set(e["name"] for e in entries)
            for e in more:
                if e["name"] in taken:
                    skipped.append({"file": e["lut"], "reason": "a preset called " + e["name"] + " is already in this file"})
                else:
                    entries.append(e)
        results = write_presets(argv[1], spec.get("bin", "Peny LUTs"), entries)
        print(json.dumps({"results": results, "skipped": skipped}))
    elif argv[0] == "grade":
        print(json.dumps(grade(argv[1], argv[2], json.load(open(argv[3])))))
    elif argv[0] == "list":
        print(json.dumps(sorted(load_presets(argv[1]).keys())))
    elif argv[0] == "inject":
        print(json.dumps(inject(argv[1], argv[2], argv[3], argv[4], argv[5] if len(argv) > 5 else "Adjustments")))
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
