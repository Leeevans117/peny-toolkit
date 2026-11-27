/* Magic Nest: nests the selected clips like Premiere's Nest, but the nest's frame size (and pixel
 * aspect) come from the biggest selected source clip instead of the parent sequence. Frame rate
 * stays the parent's. Framing in the parent does not change: k = how much bigger the nest is than
 * the parent frame, every nested clip's Motion Scale/Position is multiplied up by k about the
 * centre, and the nest clip in the parent gets Scale 100/k (8K clip at 50% in a UHD sequence:
 * k = 2, the nest is 8K, the clip is at 100% inside it and the nest clip is at 50%).
 * How: Make Subsequence (createSubsequence) over the selection's time range (keeps every effect,
 * starts at 0; the parent's In/Out are put back), the unselected clips in that range are removed
 * from it, it is resized and named after the first selected clip, filed in the root bin "Nests" (made if missing), then the selected clips in the parent
 * are replaced by the nest at the same place. Sizes come from the source file (an R3D's own size,
 * never its proxy). Lee, 27 Nov 2026.
 * params.probe = true: only report what would happen, change nothing. */
PenyToolkit.skills["magic-nest"] = function (params) {
  var T = PenyToolkit;
  params = params || {};
  var seq = T.activeSequence();
  if (!seq) return T.fail("No active sequence. Open the sequence and select the clips to nest.");

  // ---- What is selected ----
  var sel = seq.getSelection(), picked = [], vids = [];
  for (var i = 0; i < sel.length; i++) {
    var it = sel[i];
    if (!it) continue;
    var kind = String(it.mediaType) === "Video" ? "video" : "audio";
    var tr = trackOf(it, kind);
    if (tr < 0) continue;
    var rec = { item: it, kind: kind, track: tr, start: parseFloat(it.start.ticks), end: parseFloat(it.end.ticks), name: String(it.name) };
    picked.push(rec);
    if (kind === "video") vids.push(rec);
  }
  if (!vids.length) return T.fail("Select the video clips to nest on the timeline first.");

  var a = picked[0].start, b = picked[0].end;
  for (i = 1; i < picked.length; i++) { a = Math.min(a, picked[i].start); b = Math.max(b, picked[i].end); }
  var vTrack = 99, aTrack = 99;
  for (i = 0; i < picked.length; i++) {
    if (picked[i].kind === "video") vTrack = Math.min(vTrack, picked[i].track);
    else aTrack = Math.min(aTrack, picked[i].track);
  }
  if (aTrack === 99) aTrack = -1;
  // The nest goes where the selection was, on the lowest selected video track (as Nest does).
  // Anything there that is not selected would be overwritten, so stop first.
  var blocker = unselectedIn(seq.videoTracks[vTrack], a, b);
  if (blocker) return T.fail("\"" + blocker + "\" on V" + (vTrack + 1) + " sits between the selected clips but is not selected. Select it too, or move it, then run Magic Nest again.");

  // ---- Sizes ----
  var ps = seq.getSettings();
  var pW = Number(ps.videoFrameWidth), pH = Number(ps.videoFrameHeight);
  var big = null, sizes = [];
  for (i = 0; i < vids.length; i++) {
    var sz = sourceSize(vids[i].item);
    sizes.push(vids[i].name + ": " + (sz ? sz.w + "x" + sz.h : "unknown"));
    if (sz && (!big || sz.w * sz.h > big.w * big.h)) { big = sz; big.rec = vids[i]; }
  }
  if (!big) return T.fail("Could not read the frame size of the selected clips.", { sizes: sizes });
  // k: how much bigger the nest is than the parent frame. The nest clip sits centred at 100/k, so
  // its frame covers the whole parent frame (like Premiere's own Nest, just at the source's
  // resolution) and nothing that was on screen can fall outside it. Tests 27 Nov: k from the
  // clip's own scale, or placing the nest over the clip, cut picture when the clip was off-centre,
  // zoomed or keyframed. An 8K clip at 50% in UHD ends up at 100% in the nest.
  var k = Math.min(big.w / pW, big.h / pH);
  var first = vids[0];
  for (i = 1; i < vids.length; i++) if (vids[i].start < first.start || (vids[i].start === first.start && vids[i].track < first.track)) first = vids[i];
  var nestName = uniqueName(first.name);

  var plan = {
    parent: String(seq.name), parentSize: pW + "x" + pH, nestSize: big.w + "x" + big.h,
    nestPar: big.par, k: round(k, 4), nestClipScale: round(100 / k, 3), nestName: nestName,
    clips: picked.length, videoClips: vids.length, sizes: sizes, startSec: T.sec(a), endSec: T.sec(b),
    videoTrack: "V" + (vTrack + 1), audioTrack: aTrack >= 0 ? "A" + (aTrack + 1) : ""
  };
  if (params.probe) return T.ok("Would nest " + picked.length + " clips as \"" + nestName + "\" at " + plan.nestSize + ".", plan);

  // ---- Build the nest: a subsequence of just the selection's time range ----
  // Lee's first real run (27 Nov, 1,241 clips) cloned the whole parent and stripped it clip by clip:
  // 48 s, and the copy being emptied was the sequence on screen, so it looked like his edit being
  // deleted. Now Premiere's own Make Subsequence copies only the range (effects kept, starting at 0),
  // the parent's In/Out are put back straight after, and only the unselected clips inside the
  // range are taken out of the new sequence. The parent is never touched until the final swap.
  var keep = {};
  for (i = 0; i < picked.length; i++) keep[picked[i].kind + "|" + picked[i].track + "|" + (picked[i].start - a) + "|" + (picked[i].end - a)] = true;
  var before = {}, list = T.sequenceList();
  for (i = 0; i < list.length; i++) before[String(list[i].sequenceID)] = true;
  var oldIn = String(seq.getInPointAsTime().ticks), oldOut = String(seq.getOutPointAsTime().ticks);
  var made = null, subErr = "";
  try {
    seq.setInPoint(String(a)); seq.setOutPoint(String(b));
    var gotIn = parseFloat(seq.getInPointAsTime().ticks), gotOut = parseFloat(seq.getOutPointAsTime().ticks);
    if (Math.abs(gotIn - a) > 2 || Math.abs(gotOut - b) > 2) subErr = "Premiere did not take the In/Out for the selection (" + T.sec(gotIn) + "-" + T.sec(gotOut) + " s).";
    else made = seq.createSubsequence(true);
  } catch (eSub) { subErr = String(eSub); }
  seq.setInPoint(oldIn); seq.setOutPoint(oldOut);
  var inBack = String(seq.getInPointAsTime().ticks) === oldIn && String(seq.getOutPointAsTime().ticks) === oldOut;
  var nest = null;
  for (var tries = 0; tries < 20 && !nest; tries++) {
    list = T.sequenceList();
    for (i = 0; i < list.length; i++) if (!before[String(list[i].sequenceID)]) { nest = list[i]; break; }
    if (!nest) $.sleep(250);
  }
  backToParent();
  if (!nest) return T.fail("Premiere did not make the nest sequence. Nothing in your sequence changed." + (subErr ? " (" + subErr + ")" : ""), { inOutRestored: inBack });
  nest.name = nestName;
  plan.inOutRestored = inBack;

  var removed = 0, kept = [];
  function strip(tracks, kind) {
    for (var t = 0; t < tracks.numTracks; t++) {
      var tc = tracks[t].clips;
      for (var c = tc.numItems - 1; c >= 0; c--) {
        var ci = tc[c], key = kind + "|" + t + "|" + parseFloat(ci.start.ticks) + "|" + parseFloat(ci.end.ticks);
        if (keep[key]) kept.push(ci);
        else { ci.remove(false, false); removed++; }
      }
    }
  }
  strip(nest.videoTracks, "video");
  strip(nest.audioTracks, "audio");
  try { var mk = nest.markers, m = mk.getFirstMarker(); while (m) { var nx = mk.getNextMarker(m); mk.deleteMarker(m); m = nx; } } catch (eM) {}
  if (kept.length !== picked.length) return failNest("The nest has " + kept.length + " of the " + picked.length + " selected clips.");

  // Resize: frame size and pixel aspect from the source, frame rate stays the parent's.
  var ns = nest.getSettings();
  ns.videoFrameWidth = big.w; ns.videoFrameHeight = big.h;
  if (big.parValue) { try { ns.videoPixelAspectRatio = big.parValue; } catch (eP) {} }
  nest.setSettings(ns);
  var chk = nest.getSettings();
  if (Number(chk.videoFrameWidth) !== big.w || Number(chk.videoFrameHeight) !== big.h)
    return failNest("Premiere did not take the nest size " + big.w + "x" + big.h + " (it is " + chk.videoFrameWidth + "x" + chk.videoFrameHeight + ").");

  var pN = [pW / 2, pH / 2]; // the nest clip stays centred in the parent
  // Scale every nested video clip up by k about the centre so it frames the same.
  var rescaled = 0, skipped = [];
  for (var v = 0; v < nest.videoTracks.numTracks; v++) {
    var vc = nest.videoTracks[v].clips;
    for (var c2 = 0; c2 < vc.numItems; c2++) {
      var why = rescale(vc[c2], k, pW, pH, big.w, big.h, pN);
      if (why) skipped.push(String(vc[c2].name) + " (" + why + ")"); else rescaled++;
    }
  }

  // ---- Swap the selection in the parent for the nest ----
  var nestItem = nest.projectItem;
  for (i = 0; i < picked.length; i++) picked[i].item.remove(false, false);
  var at = new Time(); at.ticks = String(a);
  seq.videoTracks[vTrack].overwriteClip(nestItem, at.seconds);
  var placed = null, pc = seq.videoTracks[vTrack].clips;
  for (i = 0; i < pc.numItems; i++) {
    if (Math.abs(parseFloat(pc[i].start.ticks) - a) <= 2 && pc[i].projectItem && String(pc[i].projectItem.nodeId) === String(nestItem.nodeId)) placed = pc[i];
  }
  if (!placed) return T.fail("The nest \"" + nestName + "\" was made, but Premiere did not put it on V" + (vTrack + 1) + ". The selected clips were removed: press Cmd+Z to bring them back.", plan);
  var pmo = motionOf(placed), psc = pmo ? prop(pmo, ["Scale"]) : null;
  if (psc) psc.setValue(100 / k, true);
  var ppo = pmo ? prop(pmo, ["Position"]) : null;
  if (ppo) ppo.setValue([pN[0] / pW, pN[1] / pH], true);
  var gotScale = psc ? round(Number(psc.getValue()), 3) : null;
  // Where its sound went (Premiere picks the audio track for overwriteClip).
  var aPlaced = [];
  for (var at2 = 0; at2 < seq.audioTracks.numTracks; at2++) {
    var ac = seq.audioTracks[at2].clips;
    for (var c3 = 0; c3 < ac.numItems; c3++) if (ac[c3].projectItem && String(ac[c3].projectItem.nodeId) === String(nestItem.nodeId)) aPlaced.push("A" + (at2 + 1));
  }

  plan.parentActive = backToParent();
  var bin = nestsBin();
  if (bin) nestItem.moveBin(bin);
  plan.removedFromNest = removed; plan.rescaled = rescaled; plan.skipped = skipped;
  plan.nestClipScaleSet = gotScale; plan.nestAudioOn = aPlaced; plan.bin = bin ? "Nests" : "(root, could not make Nests)";
  plan.nestId = String(nest.sequenceID);
  T.log("magic-nest: " + T.json(plan));
  return T.ok("Nested " + picked.length + " clip" + (picked.length === 1 ? "" : "s") + " as \"" + nestName + "\" at " + big.w + "x" + big.h +
    " (nest clip at " + gotScale + "%), in bin Nests." + (skipped.length ? " Check: " + skipped.join("; ") + "." : ""), plan);

  // ---- helpers ----
  // Premiere can bring a new sequence to the front; put the parent back and wait until it is.
  function backToParent() {
    for (var r = 0; r < 12; r++) {
      var act = T.activeSequence();
      if (act && String(act.sequenceID) === String(seq.sequenceID)) return true;
      try { app.project.openSequence(String(seq.sequenceID)); } catch (eO) {}
      $.sleep(250);
    }
    return false;
  }
  function failNest(msg) {
    // Only the new nest sequence exists so far; the parent is untouched. Leave it so Lee can look.
    return T.fail(msg + " The parent sequence was not changed. The half-made nest is \"" + String(nest.name) + "\".", plan);
  }
  function trackOf(item, kind) {
    var tracks = kind === "video" ? seq.videoTracks : seq.audioTracks;
    for (var t = 0; t < tracks.numTracks; t++) {
      var tc = tracks[t].clips;
      for (var c = 0; c < tc.numItems; c++) if (String(tc[c].nodeId) === String(item.nodeId)) return t;
    }
    return -1;
  }
  function unselectedIn(track, s, e) {
    var tc = track.clips;
    for (var c = 0; c < tc.numItems; c++) {
      var ci = tc[c], cs = parseFloat(ci.start.ticks), ce = parseFloat(ci.end.ticks);
      if (cs < e && ce > s && !ci.isSelected()) return String(ci.name);
    }
    return null;
  }
  // Frame size of the clip's source: a nested sequence's own size, else the file's
  // Intrinsic VideoInfo ("8192 x 4320 (1.0)"), which is the original media, not a proxy.
  function sourceSize(item) {
    var pi = item.projectItem;
    if (!pi) return null;
    try {
      if (pi.isSequence && pi.isSequence()) {
        var l = T.sequenceList();
        for (var s = 0; s < l.length; s++) if (l[s].projectItem && String(l[s].projectItem.nodeId) === String(pi.nodeId)) {
          var st = l[s].getSettings();
          return { w: Number(st.videoFrameWidth), h: Number(st.videoFrameHeight), par: "", parValue: st.videoPixelAspectRatio };
        }
      }
    } catch (eS) {}
    var md = "";
    try { md = String(pi.getProjectMetadata()); } catch (eM2) { return null; }
    var mm = /Intrinsic\.VideoInfo>([^<]*)</.exec(md);
    if (!mm) return null;
    var m2 = /(\d+)\s*x\s*(\d+)(?:\s*\(([\d.]+)\))?/.exec(mm[1]);
    if (!m2) return null;
    return { w: parseInt(m2[1], 10), h: parseInt(m2[2], 10), par: m2[3] || "1.0", parValue: m2[3] && Number(m2[3]) !== 1 ? null : "1:1" };
  }
  function motionOf(item) {
    var cs = item.components;
    for (var j = 0; j < cs.numItems; j++) if (String(cs[j].matchName) === "AE.ADBE Motion") return cs[j];
    return null;
  }
  function prop(cm, names) {
    for (var p = 0; p < cm.properties.numItems; p++) {
      var dn = String(cm.properties[p].displayName);
      for (var w = 0; w < names.length; w++) if (dn === names[w]) return cm.properties[p];
    }
    return null;
  }
  // Motion Position is in 0..1 of the sequence frame. A point p (parent pixels) belongs at
  // centre + (p - pN) * k in the nest, so the nest clip at 100/k placed at pN frames it the same.
  function rescale(item, kk, w0, h0, w1, h1, pn) {
    var mo = motionOf(item);
    if (!mo) return "no Motion";
    var sc = prop(mo, ["Scale"]), sw = prop(mo, ["Scale Width"]), po = prop(mo, ["Position"]);
    if (!sc || !po) return "Motion has no Scale/Position";
    each(sc, function (v) { return Number(v) * kk; });
    if (sw) { var uni = prop(mo, ["Uniform Scale"]); if (uni && !uni.getValue()) each(sw, function (v) { return Number(v) * kk; }); }
    each(po, function (v) {
      return [(w1 / 2 + (Number(v[0]) * w0 - pn[0]) * kk) / w1, (h1 / 2 + (Number(v[1]) * h0 - pn[1]) * kk) / h1];
    });
    return "";
  }
  function each(pr, f) {
    if (pr.isTimeVarying()) {
      var ks = pr.getKeys();
      for (var x = 0; ks && x < ks.length; x++) pr.setValueAtKey(ks[x], f(pr.getValueAtKey(ks[x])), x === ks.length - 1);
    } else pr.setValue(f(pr.getValue()), true);
  }
  function uniqueName(base) {
    var n = base;
    for (var u = 2; T.sequenceNameExists(n) && u < 100; u++) n = base + " (" + u + ")";
    return n;
  }
  function nestsBin() {
    var root = app.project.rootItem;
    for (var r = 0; r < root.children.numItems; r++) {
      var ch = root.children[r];
      if (String(ch.name) === "Nests" && ch.type === ProjectItemType.BIN) return ch;
    }
    try { return root.createBin("Nests"); } catch (eB) { return null; }
  }
  function round(x, d) { var p = Math.pow(10, d); return Math.round(x * p) / p; }
};
