# Builds a one-item project holding an Adjustment Layer, from a Premiere-saved skeleton
# (empty project) and a Premiere-saved project that has one. Text-level, so the file
# keeps Premiere's own formatting.
import re, sys, uuid, gzip, xml.etree.ElementTree as ET
skel, donor, out = sys.argv[1:4]
S = open(skel).read(); D = open(donor).read()
root = ET.fromstring(D)
byid = {e.get('ObjectID'): e for e in root if e.get('ObjectID')}
byuid = {e.get('ObjectUID'): e for e in root if e.get('ObjectUID')}
mcs = [e for e in root if e.tag == 'MasterClip' and e.findtext('IsAdjustmentLayer') == 'true']
cpi = [e for e in root if e.tag == 'ClipProjectItem' and e.find('MasterClip') is not None and e.find('MasterClip').get('ObjectURef') == mcs[0].get('ObjectUID')][0]
seen, stack = [], [cpi]
while stack:
    e = stack.pop()
    if any(e is s for s in seen): continue
    seen.append(e)
    for d in e.iter():
        if d.get('ObjectRef') in byid: stack.append(byid[d.get('ObjectRef')])
        if d.get('ObjectURef') in byuid: stack.append(byuid[d.get('ObjectURef')])
ids = [e.get('ObjectID') for e in seen if e.get('ObjectID')]
uids = [e.get('ObjectUID') for e in seen if e.get('ObjectUID')]
idmap = {old: str(9000 + i) for i, old in enumerate(ids)}
uidmap = {old: str(uuid.uuid4()) for old in uids}
def raw(e):  # the object's own text in the donor file
    key = 'ObjectID="%s"' % e.get('ObjectID') if e.get('ObjectID') else 'ObjectUID="%s"' % e.get('ObjectUID')
    m = re.search(r'\t<%s [^>]*%s[^>]*>.*?\n\t</%s>\n' % (e.tag, re.escape(key), e.tag), D, re.S)
    assert m, key
    return m.group(0)
blob = ''.join(raw(e) for e in seen)
blob = re.sub(r'(Object(?:ID|Ref))="(\d+)"', lambda m: '%s="%s"' % (m.group(1), idmap.get(m.group(2), m.group(2))), blob)
blob = re.sub(r'(Object(?:UID|URef))="([0-9a-f-]+)"', lambda m: '%s="%s"' % (m.group(1), uidmap.get(m.group(2), m.group(2))), blob)
assert not set(re.findall(r'ObjectRef="(\d+)"', blob)) - set(idmap.values()), "dangling ref"
assert not set(re.findall(r'ObjectURef="([0-9a-f-]+)"', blob)) - set(uidmap.values()), "dangling uref"
item = '\t\t\t<Items Version="1">\n\t\t\t\t<Item Index="0" ObjectURef="%s"/>\n\t\t\t</Items>\n' % uidmap[cpi.get('ObjectUID')]
S2 = re.sub(r'(<RootProjectItem ObjectUID[^>]*>.*?<ProjectItemContainer Version="1">\n)(\t\t</ProjectItemContainer>)', lambda m: m.group(1) + item + m.group(2), S, count=1, flags=re.S)
assert S2 != S
S2 = S2.replace('</PremiereData>', blob + '</PremiereData>')
ET.fromstring(S2)  # still well-formed
open(out + '.xml', 'w').write(S2)
with gzip.open(out, 'wb') as f: f.write(S2.encode('utf-8'))
print(len(seen), 'objects grafted;', cpi.find('ProjectItem').findtext('Name'))
