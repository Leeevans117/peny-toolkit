// Proxy automation, Premiere side. Ported from the Proxy Automation panel
// (com.peny.proxyautomation hostscript.jsx). Rendering now happens in Node (see
// panel.js and core/jobs.js), so this file only reads the project and attaches or
// detaches proxies, one call per action:
//   action "list"   -> video footage items in the scope, with bin paths and proxy state
//   action "attach" -> params.pairs [{nodeId, path}]; each attach is read back
//   action "detach" -> params.nodeIds; each detach is read back
// Scope (list): params.bin = bin path from the project root ("Footage/Day 1") or a
// bin name that is unique in the project, or "ALL" for the whole project; empty = the
// bins selected in the Project panel. binPath is always the full path from the root.
// Nothing here deletes, renames or moves anything.
(function (T) {
  var P = T.proxy = T.proxy || {};
  P.items = P.items || {}; // nodeId -> ProjectItem, filled by "list"

  // Same filters as the original panel (each extension there came from a real failed job).
  var AUDIO_ONLY = ["wav", "mp3", "aac", "aif", "aiff", "m4a", "wma", "ogg", "flac", "caf"];
  var NON_VIDEO = ["png", "jpg", "jpeg", "tif", "tiff", "bmp", "gif", "psd", "ai", "eps",
    "csv", "txt", "xml", "aegraphic", "mogrt", "pdf", "doc", "docx", "xls", "xlsx"];
  function extOf(p) { var d = p.lastIndexOf("."); return d === -1 ? "" : p.substring(d + 1).toLowerCase(); }
  function inList(list, v) { for (var i = 0; i < list.length; i++) if (list[i] === v) return true; return false; }

  // hasProxy / getProxyPath are a property on some builds and a method on others
  // (original panel, historical bug 1); handle both.
  function hasProxy(item) {
    try { var hp = item.hasProxy; return typeof hp === "function" ? !!hp.call(item) : !!hp; } catch (e) { return false; }
  }
  function proxyPath(item) {
    try {
      var gp = item.getProxyPath;
      if (typeof gp === "function") { var p = gp.call(item); return (p && p !== 0) ? String(p) : null; }
      if (item.proxyPath) return String(item.proxyPath);
    } catch (e) {}
    return null;
  }
  P.hasProxy = hasProxy;
  P.proxyPath = proxyPath;

  // Finds a project item by nodeId: from the last listing if cached, else by walking the project.
  function itemById(id) {
    id = String(id);
    if (P.items[id]) return P.items[id];
    var stack = [T.proj().rootItem];
    while (stack.length) {
      var bin = stack.pop();
      for (var c = 0; c < bin.children.numItems; c++) {
        var ch = bin.children[c];
        if (String(ch.nodeId) === id) { P.items[id] = ch; return ch; }
        if (ch.type == ProjectItemType.BIN) stack.push(ch);
      }
    }
    return null;
  }

  function findBin(path) {
    var parts = String(path).split("/"), bin = T.proj().rootItem;
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === "") continue;
      var next = null;
      for (var c = 0; c < bin.children.numItems; c++) {
        var ch = bin.children[c];
        if (ch.type == ProjectItemType.BIN && ch.name === parts[i]) { next = ch; break; }
      }
      if (!next) return null;
      bin = next;
    }
    return bin;
  }

  // Full bin path from the project root ("02 FOOTAGE/Korea / Seoul/Day2/Komodo"), so the
  // proxy tree mirrors where the bin really sits, not just the selected bin's own name.
  function binFullPath(target) {
    var id = String(target.nodeId), st = [{ bin: T.proj().rootItem, path: "" }];
    while (st.length) {
      var f = st.pop();
      for (var c = 0; c < f.bin.children.numItems; c++) {
        var ch = f.bin.children[c];
        if (ch.type != ProjectItemType.BIN) continue;
        var p = f.path === "" ? ch.name : f.path + "/" + ch.name;
        if (String(ch.nodeId) === id) return p;
        st.push({ bin: ch, path: p });
      }
    }
    return String(target.name);
  }

  // Typed bin that is not a path from the root: accept it if exactly one bin has that
  // name (or that full path, which matters when a bin name itself contains "/").
  function findBinByName(text) {
    var hits = [], st = [{ bin: T.proj().rootItem, path: "" }];
    while (st.length) {
      var f = st.pop();
      for (var c = 0; c < f.bin.children.numItems; c++) {
        var ch = f.bin.children[c];
        if (ch.type != ProjectItemType.BIN) continue;
        var p = f.path === "" ? ch.name : f.path + "/" + ch.name;
        if (ch.name === text || p === text) hits.push({ bin: ch, path: p });
        st.push({ bin: ch, path: p });
      }
    }
    return hits;
  }

  function scopeRoots(params) {
    // A bin can also be given by nodeId (used by Ingest + proxies; bin names such as
    // "Korea / Seoul" contain "/" and cannot be written as a path).
    if (params.binNodeId) {
      var st = [T.proj().rootItem];
      while (st.length) {
        var pb = st.pop();
        for (var q = 0; q < pb.children.numItems; q++) {
          var qc = pb.children[q];
          if (qc.type != ProjectItemType.BIN) continue;
          if (String(qc.nodeId) === String(params.binNodeId)) return { roots: [{ bin: qc, path: binFullPath(qc) }] };
          st.push(qc);
        }
      }
      return { error: "Bin not found (nodeId " + params.binNodeId + ")." };
    }
    var b = params.bin ? String(params.bin).replace(/^\s+|\s+$/g, "") : "";
    if (b === "ALL") return { roots: [{ bin: T.proj().rootItem, path: "" }] };
    if (b !== "") {
      var bin = findBin(b);
      if (bin) return { roots: [{ bin: bin, path: binFullPath(bin) }] };
      var hits = findBinByName(b);
      if (hits.length === 1) return { roots: [hits[0]] };
      if (hits.length > 1) return { error: hits.length + " bins are called \"" + b + "\"; give the path from the project root, or select the bin instead." };
      return { error: "Bin not found: \"" + b + "\" (give the path from the project root, e.g. Footage/Day 1)." };
    }
    var sel = null;
    try { sel = app.getCurrentProjectViewSelection(); } catch (e) {}
    var roots = [];
    if (sel) for (var i = 0; i < sel.length; i++) if (sel[i].type == ProjectItemType.BIN) roots.push({ bin: sel[i], path: binFullPath(sel[i]) });
    if (!roots.length) return { error: "No bin given and no bin selected in the Project panel. Select a bin (or type its path) first." };
    return { roots: roots };
  }

  // Start-up-disk paths stored by Media Browser (/Volumes/Macintosh HD/Users/...) are
  // compared as /Users/... (prefixes sent by the panel). Lower-cased: Mac disks ignore
  // letter case, so ".mp4" in the project and ".MP4" on disk are the same file.
  function normPath(p, prefixes) {
    var s = String(p || "").replace(/\\/g, "/").toLowerCase()
      // A drive copy of the office server keeps its path as a folder named "/Volumes/" (shown
      // as ":Volumes/:ampdata" in the shell): the same file as /Volumes/ampdata/... .
      .replace(/^.*\/:volumes\/:/, "/volumes/");
    for (var i = 0; i < (prefixes || []).length; i++) {
      var pre = String(prefixes[i]).toLowerCase();
      if (s.indexOf(pre + "/") === 0) { s = s.substring(pre.length); break; }
    }
    return s;
  }

  function list(params) {
    // params.mediaPaths: only the project items using these files, wherever they are
    // (used by Ingest + proxies, so footage already in the project is covered too).
    var only = null;
    if (params.mediaPaths) {
      only = {};
      for (var mpi = 0; mpi < params.mediaPaths.length; mpi++) only[normPath(params.mediaPaths[mpi], params.bootPrefixes)] = true;
    }
    var sc = only ? { roots: [{ bin: T.proj().rootItem, path: "" }] } : scopeRoots(params);
    if (sc.error) return T.fail(sc.error);
    P.items = {};
    var out = [], tally = { bins: 0, noMediaPath: 0, audioOnly: 0, nonVideo: 0, offline: 0 };
    var stack = [];
    for (var r = 0; r < sc.roots.length; r++) stack.push({ bin: sc.roots[r].bin, path: sc.roots[r].path });
    while (stack.length) {
      var f = stack.pop();
      for (var c = 0; c < f.bin.children.numItems; c++) {
        var it = f.bin.children[c];
        if (it.type == ProjectItemType.BIN) {
          tally.bins++;
          stack.push({ bin: it, path: f.path === "" ? it.name : f.path + "/" + it.name });
          continue;
        }
        var mp = "";
        try { if (typeof it.getMediaPath === "function") mp = String(it.getMediaPath() || ""); } catch (e) {}
        if (!mp) { tally.noMediaPath++; continue; }
        if (only && !only[normPath(mp, params.bootPrefixes)]) continue;
        var ext = extOf(mp);
        if (inList(AUDIO_ONLY, ext)) { tally.audioOnly++; continue; }
        if (inList(NON_VIDEO, ext)) { tally.nonVideo++; continue; }
        var offline = false;
        try { offline = !!it.isOffline(); } catch (e2) {}
        if (offline) tally.offline++;
        var id = String(it.nodeId);
        P.items[id] = it;
        out.push({ nodeId: id, name: String(it.name), mediaPath: mp, binPath: f.path, offline: offline,
          hasProxy: hasProxy(it), proxyPath: proxyPath(it) });
      }
    }
    return T.ok(out.length + " video items in scope.", { items: out, tally: tally,
      scope: (function () { var s = []; for (var i = 0; i < sc.roots.length; i++) s.push(only ? "(" + params.mediaPaths.length + " files from the footage folder)" : (sc.roots[i].path || "(whole project)")); return s; }()) });
  }

  function attach(params) {
    var pairs = params.pairs || [], ok = [], failed = [];
    for (var i = 0; i < pairs.length; i++) {
      var p = pairs[i], it = itemById(p.nodeId);
      if (!it) { failed.push({ nodeId: p.nodeId, reason: "item not found in the project" }); continue; }
      if (!new File(p.path).exists) { failed.push({ nodeId: p.nodeId, name: String(it.name), reason: "proxy file not found: " + p.path }); continue; }
      var ret = null;
      try { ret = it.attachProxy(p.path, 0); } catch (e) { ret = "error: " + e; }
      // attachProxy returns 0 on success on this build (original panel, bug 5); read back anyway.
      var now = proxyPath(it);
      var same = !!(now && new File(now).fsName === new File(p.path).fsName);
      if (hasProxy(it) && same) ok.push({ nodeId: p.nodeId, name: String(it.name), path: p.path, returned: String(ret) });
      else failed.push({ nodeId: p.nodeId, name: String(it.name), path: p.path, returned: String(ret),
        reason: "after attachProxy, hasProxy=" + hasProxy(it) + " proxyPath=" + now });
    }
    var s = ok.length + " attached and verified, " + failed.length + " failed.";
    return failed.length ? { ok: false, error: s, summary: s, details: { attached: ok, failed: failed } } : T.ok(s, { attached: ok, failed: failed });
  }

  function detach(params) {
    var ids = params.nodeIds || [], ok = [], already = [], failed = [];
    for (var i = 0; i < ids.length; i++) {
      var it = itemById(ids[i]);
      if (!it) { failed.push({ nodeId: ids[i], reason: "item not found in the project" }); continue; }
      if (!hasProxy(it)) { already.push({ nodeId: ids[i], name: String(it.name) }); continue; }
      var was = proxyPath(it);
      try { it.detachProxy(); } catch (e) {}
      if (!hasProxy(it)) ok.push({ nodeId: ids[i], name: String(it.name), was: was });
      else failed.push({ nodeId: ids[i], name: String(it.name), reason: "still has a proxy after detachProxy (" + proxyPath(it) + ")" });
    }
    var s = ok.length + " detached and verified, " + already.length + " had no proxy, " + failed.length + " failed.";
    var d = { detached: ok, hadNone: already, failed: failed };
    return failed.length ? { ok: false, error: s, summary: s, details: d } : T.ok(s, d);
  }

  // Connect Full Res (Lee, 27 Nov 2026): params.pairs [{nodeId, path, rescale}] = the clip and
  // its full-res camera file. changeMediaPath, then read back: the item must point at that file
  // and be online. Then any proxy is detached (read back). The project item's name is kept.
  // rescale (the clip's media was a _Proxy file): changeMediaPath keeps every Motion value, so a
  // 1280x720 proxy at 300% would show the 3840x2160 file 3x too big (seen in QA 27 Nov). Scale
  // (and Scale Width) on every use of the item in every sequence, keyframes included, are
  // multiplied by oldWidth/newWidth (oldHeight/newHeight for height when the shapes differ), so
  // the picture fills exactly the same box. Position and Anchor Point are 0..1 values relative
  // to the frame and stay as they are (read back unchanged in QA).
  function frameSize(item) {
    var md = "";
    try { md = String(item.getProjectMetadata()); } catch (e) { return null; }
    var mm = /Intrinsic\.VideoInfo>([^<]*)</.exec(md);
    var m2 = mm ? /(\d+)\s*x\s*(\d+)/.exec(mm[1]) : null;
    return m2 ? { w: parseInt(m2[1], 10), h: parseInt(m2[2], 10) } : null;
  }
  function motionOf(ti) {
    try { var cs = ti.components; for (var j = 0; j < cs.numItems; j++) if (String(cs[j].matchName) === "AE.ADBE Motion") return cs[j]; } catch (e) {}
    return null;
  }
  function prop(cm, name) {
    for (var p = 0; p < cm.properties.numItems; p++) if (String(cm.properties[p].displayName) === name) return cm.properties[p];
    return null;
  }
  // Every video track item using this project item, in every sequence of the project.
  function usesOf(item) {
    var out = [], seqs = T.proj().sequences, id = String(item.nodeId);
    for (var s = 0; s < seqs.numSequences; s++) {
      var vt = seqs[s].videoTracks;
      for (var t = 0; t < vt.numTracks; t++) {
        var cl = vt[t].clips;
        for (var c = 0; c < cl.numItems; c++) {
          var pi = null; try { pi = cl[c].projectItem; } catch (e) {}
          if (pi && String(pi.nodeId) === id) out.push({ ti: cl[c], where: String(seqs[s].name) + " V" + (t + 1) + " @" + Math.round(cl[c].start.seconds * 100) / 100 + "s" });
        }
      }
    }
    return out;
  }
  // Snapshot of a property: static value or every keyframe (time + value).
  function snap(pr) {
    if (!pr) return null;
    if (pr.isTimeVarying()) {
      var ks = pr.getKeys(), keys = [];
      for (var x = 0; ks && x < ks.length; x++) keys.push({ t: ks[x], v: Number(pr.getValueAtKey(ks[x])) });
      return { keys: keys };
    }
    return { v: Number(pr.getValue()) };
  }
  function writeScaled(pr, sn, k) {
    if (sn.keys) { for (var x = 0; x < sn.keys.length; x++) pr.setValueAtKey(sn.keys[x].t, sn.keys[x].v * k, x === sn.keys.length - 1); }
    else pr.setValue(sn.v * k, true);
  }
  function checkScaled(pr, sn, k) {
    var bad = [];
    if (sn.keys) {
      var ks = pr.getKeys();
      if (!ks || ks.length !== sn.keys.length) return ["keyframe count " + (ks ? ks.length : 0) + " (was " + sn.keys.length + ")"];
      for (var x = 0; x < sn.keys.length; x++) { var got = Number(pr.getValueAtKey(ks[x])); if (Math.abs(got - sn.keys[x].v * k) > 0.01) bad.push("key " + (x + 1) + " = " + got + ", want " + sn.keys[x].v * k); }
    } else { var g = Number(pr.getValue()); if (Math.abs(g - sn.v * k) > 0.01) bad.push(g + ", want " + sn.v * k); }
    return bad;
  }

  function relink(params) {
    var pairs = params.pairs || [], ok = [], failed = [];
    for (var i = 0; i < pairs.length; i++) {
      var p = pairs[i], it = itemById(p.nodeId);
      if (!it) { failed.push({ nodeId: p.nodeId, reason: "item not found in the project" }); continue; }
      var nm = String(it.name);
      if (!new File(p.path).exists) { failed.push({ nodeId: p.nodeId, name: nm, reason: "file not found: " + p.path }); continue; }
      var can = true;
      try { if (typeof it.canChangeMediaPath === "function") can = !!it.canChangeMediaPath(); } catch (e0) {}
      if (!can) { failed.push({ nodeId: p.nodeId, name: nm, reason: "Premiere says this item's media cannot be changed" }); continue; }
      var was = "";
      try { was = String(it.getMediaPath() || ""); } catch (e1) {}
      // Before: the frame size and every use's Scale values (only needed when rescaling).
      var size0 = p.rescale ? frameSize(it) : null, uses = [];
      if (p.rescale) {
        if (!size0) { failed.push({ nodeId: p.nodeId, name: nm, reason: "could not read the proxy's frame size; nothing changed" }); continue; }
        var us = usesOf(it);
        for (var u = 0; u < us.length; u++) {
          var mo = motionOf(us[u].ti);
          if (!mo) { uses.push({ where: us[u].where, ti: us[u].ti, none: true }); continue; }
          var uni = prop(mo, "Uniform Scale");
          uses.push({ where: us[u].where, ti: us[u].ti, sc: snap(prop(mo, "Scale")), sw: snap(prop(mo, "Scale Width")),
            uniform: uni ? !!uni.getValue() : true });
        }
      }
      var same = false, now = "", off = true, ret = null;
      if (was && new File(was).fsName === new File(p.path).fsName && !it.isOffline()) same = true; // already there
      else {
        try { ret = it.changeMediaPath(p.path, true); } catch (e2) { ret = "error: " + e2; }
      }
      try { now = String(it.getMediaPath() || ""); } catch (e3) {}
      try { off = !!it.isOffline(); } catch (e4) {}
      same = !!(now && new File(now).fsName === new File(p.path).fsName);
      var rec = { nodeId: p.nodeId, name: nm, was: was, path: p.path, returned: String(ret) };
      if (!same || off) { rec.reason = "after changeMediaPath: mediaPath=" + now + " offline=" + off; failed.push(rec); continue; }
      // Framing.
      var notes = [];
      if (p.rescale) {
        var size1 = frameSize(it);
        if (!size1) notes.push("FRAMING NOT CHECKED: could not read the full-res frame size");
        else if (size1.w !== size0.w || size1.h !== size0.h) {
          var kw = size0.w / size1.w, kh = size0.h / size1.h, sameShape = Math.abs(kw - kh) <= kw * 0.005;
          rec.frame = size0.w + "x" + size0.h + " -> " + size1.w + "x" + size1.h;
          for (var v = 0; v < uses.length; v++) {
            var U = uses[v];
            if (U.none || !U.sc) { notes.push("FRAMING NOT SET at " + U.where + ": no Motion"); continue; }
            var mo2 = motionOf(U.ti), psc = prop(mo2, "Scale"), psw = prop(mo2, "Scale Width"), pun = prop(mo2, "Uniform Scale");
            var bad = [];
            if (sameShape || !psw || !pun) {
              // Uniform: Scale x kw. Non-uniform: Scale is the height, Scale Width the width.
              writeScaled(psc, U.sc, U.uniform ? kw : kh);
              bad = bad.concat(checkScaled(psc, U.sc, U.uniform ? kw : kh));
              if (!U.uniform && psw && U.sw) { writeScaled(psw, U.sw, kw); bad = bad.concat(checkScaled(psw, U.sw, kw)); }
              if (!sameShape) notes.push("CHECK FRAMING at " + U.where + ": proxy " + size0.w + "x" + size0.h + " and full res " + size1.w + "x" + size1.h + " differ in shape");
            } else {
              // Different shape (e.g. 17:9 camera file, 16:9 proxy): width and height scaled apart
              // so the picture fills the same box the proxy filled.
              var scW = U.uniform ? U.sc : U.sw;
              if (U.uniform) pun.setValue(false, true);
              writeScaled(psw, scW, kw); bad = bad.concat(checkScaled(psw, scW, kw));
              writeScaled(psc, U.sc, kh); bad = bad.concat(checkScaled(psc, U.sc, kh));
              notes.push("shape differs (" + size0.w + "x" + size0.h + " proxy, " + size1.w + "x" + size1.h + " full res): Uniform Scale off at " + U.where + ", same box as the proxy");
            }
            if (bad.length) notes.push("FRAMING FAILED at " + U.where + ": Scale " + bad.join("; "));
          }
          rec.uses = uses.length;
        } else rec.frame = "same size " + size1.w + "x" + size1.h;
      }
      // Detach the proxy (Lee: full res, no proxies).
      if (hasProxy(it)) {
        var pp = proxyPath(it);
        try { it.detachProxy(); } catch (e5) {}
        if (hasProxy(it)) notes.push("PROXY STILL ATTACHED: " + proxyPath(it)); else rec.detached = pp;
      }
      if (notes.length) rec.notes = notes;
      var hard = false;
      for (var n = 0; n < notes.length; n++) if (/FAILED|NOT SET|NOT CHECKED|STILL ATTACHED/.test(notes[n])) hard = true;
      if (hard) { rec.reason = notes.join(" | "); failed.push(rec); } else ok.push(rec);
    }
    var s = ok.length + " connected to full res and verified, " + failed.length + " failed.";
    return failed.length ? { ok: false, error: s, summary: s, details: { relinked: ok, failed: failed } } : T.ok(s, { relinked: ok, failed: failed });
  }

  T.skills["proxy-automation"] = function (params) {
    if (!T.proj()) return T.fail(T.targetPath ? "Project not open: " + T.targetPath : "No project open.");
    if (params.action === "list") return list(params);
    if (params.action === "attach") return attach(params);
    if (params.action === "detach") return detach(params);
    if (params.action === "relink") return relink(params);
    return T.fail("Unknown proxy action: " + params.action);
  };
}(PenyToolkit));
