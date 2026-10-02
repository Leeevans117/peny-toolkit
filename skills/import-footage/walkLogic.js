/*
 * walkLogic.js
 * ------------------------------------------------------------------------
 * PORTABLE folder-walk / camera-format-detection / representative-file-
 * selection / wav-matching logic for Master Footage Importer.
 *
 * This module has NO dependency on 'fs', 'uxp', or 'premierepro'. Every
 * function that needs to look inside a directory takes a `listEntries`
 * function as a parameter:
 *
 *   listEntries(dirRef) -> Promise<Array<{ name: string, isDir: boolean, ref: any }>>
 *
 * `dirRef` and each returned `ref` are opaque to this module - the caller
 * decides what they actually are:
 *   - In the UXP panel (index.js), dirRef/ref are UXP `Folder`/`Entry`
 *     objects (from uxp.storage.localFileSystem), and listEntries() calls
 *     `folder.getEntries()`.
 *   - In the Node test harness (test_walk_logic.js), dirRef/ref are plain
 *     filesystem path strings, and listEntries() calls `fs.readdirSync()`.
 *
 * Because the SAME module is required by both the real panel and the test
 * harness, validating the harness against the synthetic test tree is a
 * direct validation of the exact code path the panel uses - not a
 * reimplementation that could drift out of sync.
 *
 * This module deliberately does NOT know about Premiere Pro bins/projects/
 * import calls at all - it only answers "what is at this folder, what
 * single representative file should Premiere import for each clip, and
 * what wav (if any) goes with it". The Premiere-specific side (bin
 * creation/reuse, importFiles, idempotency checks) lives in index.js.
 *
 * ------------------------------------------------------------------------
 * GENERALIZATION FROM THE RED-ONLY VERSION
 * ------------------------------------------------------------------------
 * The original version of this tool only understood RED's ".RDC" folder
 * convention: a "card" folder is any folder whose direct children include
 * one or more ".RDC" folders, and each ".RDC" folder collapses into ONE
 * clip in the bin that mirrors the folder ABOVE it (the .RDC folder never
 * gets a bin of its own).
 *
 * That "folder-per-clip wrapper collapses into the parent bin" pattern is
 * not unique to RED - ARRI's classic ARRIRAW frame-sequence format (see
 * ARRI_RAW_SEQUENCE_RULE below) uses the same shape. Other formats
 * (Sony XDCAM/XAVC, Canon XF-AVC, Canon Cinema RAW Light, Blackmagic BRAW,
 * GoPro/DJI/phone footage, standalone audio recorders) write plain flat
 * files instead, sometimes with sidecar metadata files alongside, and
 * need no wrapper-collapsing at all.
 *
 * So the model here is: a small table of WRAPPER_RULES, each describing
 * one "folder-per-clip" convention (how to recognize a folder as one of
 * these wrappers, and how to pick the single representative file Premiere
 * should be given for it). Any folder that doesn't match a wrapper rule
 * is just a plain folder: its bin mirrors it exactly, and every direct
 * video/audio file inside it is imported as its own separate item.
 * ------------------------------------------------------------------------
 */

// ==========================================================================
// Extension tables
// ==========================================================================

// Video containers/codecs treated as importable media. ".r3d" is included
// for completeness (findWrapperRule/RED_RULE handles the actual RED
// card-folder case specially; a stray loose .R3D file with no .RDC wrapper
// would still be recognized as video here).
const VIDEO_EXTS = ["mov", "mp4", "mxf", "braw", "ari", "avi", "mkv", "r3d"];

// Audio formats treated as importable media.
const AUDIO_EXTS = ["wav", "aif", "aiff", "mp3", "m4a"];

// Extensions explicitly NOT imported even if found inside a footage tree:
// stills/photos, sidecar/metadata/documentation files. This list is not
// exhaustive of every possible non-media extension - anything not in
// VIDEO_EXTS or AUDIO_EXTS is skipped by default anyway - it exists mainly
// for self-documentation of the formats we specifically expect to see and
// deliberately ignore.
const SKIP_EXTS = [
  // stills / photos
  "jpg", "jpeg", "png", "tif", "tiff", "dng", "cr2", "cr3", "arw", "raf",
  // documents / sidecars / project files / LUTs
  "xml", "cpf", "cif", "sif", "thm", "pdf", "cube", "csv", "xmp",
];

// Folder names that are never treated as footage, regardless of what
// media-like files they contain - e.g. an "Exports" folder full of
// re-encoded .mov deliverables that happen to share an extension with
// camera-original media. This generalizes the RED-only version's incidental
// skipping of an "Exports" folder (which worked before only because
// nothing in it was RED media) to the general case where .mov/.mp4 files
// could plausibly be either camera-original or a rendered export.
//
// Matching is by WHOLE WORD/TOKEN, not exact-name-only or raw substring:
// real footage trees name these folders things like "NIKON_300426_Proxies"
// or "GH5 - Proxy", not just a bare "Proxies" - a plain Set-exact-match (the
// original version of this check) would silently let those through and try
// to import an entire folder of pre-rendered proxy media as if it were
// camera-original footage. Splitting the folder name on common separators
// (_, -, space, .) and checking whether "proxies"/"proxy"/etc. appears as
// one of those tokens catches the compound-name case while still avoiding
// false positives on an unrelated word that merely CONTAINS one of these as
// a substring (e.g. "Approximate" does not tokenize to "proxy").
const SKIP_FOLDER_NAME_TERMS = [
  "exports", "export",
  "renders", "render",
  "proxies", "proxy",
  "media cache", "media cache files", "cache",
  "project files", "backup", "backups", "autosave", "auto-save",
  "luts", "lut",
];

function hasExt(name, ext) {
  return new RegExp("\\." + ext + "$", "i").test(name);
}

function anyExt(name, exts) {
  return exts.some((ext) => hasExt(name, ext));
}

function isVideoFile(name) {
  return anyExt(name, VIDEO_EXTS);
}

function isAudioFile(name) {
  return anyExt(name, AUDIO_EXTS);
}

function isMediaFile(name) {
  return isVideoFile(name) || isAudioFile(name);
}

function isSkippedFolderName(name) {
  const norm = String(name).trim().toLowerCase();
  const tokens = norm.split(/[\s_\-.]+/).filter(Boolean);
  return SKIP_FOLDER_NAME_TERMS.some((term) => {
    if (term.indexOf(" ") !== -1) {
      // Multi-word terms (e.g. "media cache") match as a plain substring -
      // tokenizing both sides isn't worth the complexity for the handful
      // of these that exist.
      return norm.indexOf(term) !== -1;
    }
    return tokens.indexOf(term) !== -1;
  });
}

function baseName(name) {
  const idx = name.lastIndexOf(".");
  return idx === -1 ? name : name.substring(0, idx);
}

// Runs `fn` over `items` with at most `limit` in flight at once, preserving
// result order. Used for the per-subfolder classification listEntries()
// calls below: doing those one-at-a-time (sequential await in a for loop)
// is what made a large card folder (150-200+ .RDC subfolders) on a network
// volume feel "stuck" - each listEntries() is a real network round trip,
// and 200 of them back-to-back can take minutes with nothing to show for
// it. Running them concurrently (capped, so we don't fire e.g. 200
// simultaneous requests at an SMB share at once) turns that into a few
// seconds. This does not change WHAT gets classified, only how fast.
async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

// ==========================================================================
// Vendor "folder-per-clip wrapper" rule table
// ==========================================================================
// Each rule:
//   matches(name, children) -> boolean
//     `children` is this candidate folder's OWN direct entries (already
//     fetched by the caller), in the same {name, isDir, ref} shape as
//     listEntries() returns. Return true if this folder itself IS a
//     one-folder-equals-one-clip wrapper of this vendor's convention.
//   resolve(name, children) -> { kind, representativeFile, clipBase,
//                                  asNumberedStills } | { warning }
//     Given a folder already confirmed to match, pick the single file
//     Premiere should be given to represent the whole clip, and the
//     "clip base name" used for wav-companion matching. `asNumberedStills`
//     tells the caller whether this representative file is the first of a
//     numbered image-sequence-style set (see project.importFiles()'s
//     `asNumberedStills` parameter) rather than a normal self-contained
//     media file.

// RED: a folder is a RED clip wrapper if its name ends in ".RDC"
// (case-insensitive) - this deliberately does NOT special-case ".RDM"
// wrapper folders; a ".RDM" folder that itself directly contains ".RDC"
// folders is simply the COLLECTION folder one level up (see
// resolveDirectory()), never a wrapper itself. RED chunk files are named
// <clipname>_001.R3D, <clipname>_002.R3D, ... and the alphabetically-first
// (RED zero-pads to at least 3 digits, so plain text sort is correct)
// chunk is the one Premiere needs - RED's reader resolves the rest
// automatically. CONFIRMED / carried over unchanged from the validated
// RED-only version.
const RED_RULE = {
  id: "red",
  label: "RED (.RDC)",
  matches: (name) => /\.rdc$/i.test(name),
  resolve: (name, children) => {
    const r3ds = children
      .filter((e) => !e.isDir && hasExt(e.name, "r3d"))
      .sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1));
    if (!r3ds.length) {
      return { warning: "no .R3D files found in " + name };
    }
    const rep = r3ds[0];
    return {
      kind: "red",
      representativeFile: rep,
      clipBase: baseName(rep.name),
      asNumberedStills: false,
    };
  },
};

// ARRI ARRIRAW classic frame-sequence: ALEXA Classic/XT/SXT/LF/65 cameras
// (when recording ARRIRAW rather than MXF-wrapped ARRIRAW) write each clip
// as a folder containing many sequentially-numbered ".ari" frame files
// with no further subfolders - confirmed via ARRI's own documentation
// that for this format "every single frame is a separate file" (see
// accompanying report for the citation). There is no fixed folder-NAME
// suffix analogous to RED's ".RDC" (the folder is simply named after the
// reel/clip, which varies by camera generation) - so detection here is by
// CONTENT instead of name: a folder with two or more files, ALL of which
// are ".ari", and no subfolders. (A single lone ".ari" file with no
// siblings is just treated as a flat video file by the default rule -
// there's nothing to "collapse".) BEST-EFFORT: the exact frame-numbering
// scheme is model/firmware-dependent; this rule only relies on the file
// extension and folder shape, not a specific filename pattern, so it
// should be robust to that variation, but this has not been validated
// against real ARRI camera output - see report.
const ARRI_RAW_SEQUENCE_RULE = {
  id: "arri_raw_sequence",
  label: "ARRIRAW frame sequence (.ari)",
  matches: (name, children) => {
    const dirs = children.filter((e) => e.isDir);
    const files = children.filter((e) => !e.isDir);
    if (dirs.length > 0 || files.length < 2) return false;
    return files.every((e) => hasExt(e.name, "ari"));
  },
  resolve: (name, children) => {
    const aris = children
      .filter((e) => !e.isDir && hasExt(e.name, "ari"))
      .sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1));
    if (!aris.length) {
      return { warning: "no .ari frame files found in " + name };
    }
    return {
      kind: "arri_raw_sequence",
      representativeFile: aris[0],
      // Use the wrapper folder's own name (the reel/clip name) as the
      // wav-matching identity rather than the first frame's filename,
      // since frame filenames carry a per-frame numeric suffix.
      clipBase: name,
      // Premiere needs this to read the whole numbered frame range as one
      // clip instead of importing only the single first frame.
      asNumberedStills: true,
    };
  },
};

// Sony XDCAM/XAVC, Canon XF-AVC, Canon Cinema RAW Light (.CRM), Blackmagic
// BRAW, GoPro/DJI/phone .mp4/.mov, and standalone audio recorders all
// write plain flat files (optionally with sidecar metadata files
// alongside using extensions in SKIP_EXTS) - CONFIRMED via research (see
// report). None of these need a wrapper rule at all: they simply fall
// through to the default "plain folder" handling in resolveDirectory(),
// where every direct video/audio file becomes its own imported item.
const WRAPPER_RULES = [RED_RULE, ARRI_RAW_SEQUENCE_RULE];

// Returns the first WRAPPER_RULES entry that matches folder `name` given
// its own direct `children`, or null if this is just a plain folder.
function findWrapperRule(name, children) {
  for (const rule of WRAPPER_RULES) {
    if (rule.matches(name, children)) return rule;
  }
  return null;
}

// ==========================================================================
// Companion-wav matching (generalized from the RED-only version's
// findCompanionWav - now usable for ANY wrapper clip's clipBase, not just
// RED's)
// ==========================================================================
// Looks for a companion .wav matching `clipBase` (case-insensitive):
//   1) directly among `wrapperChildren` (the wrapper folder's own direct
//      entries), or
//   2) inside one of the pre-listed `audioFolders` ({ entries } for each
//      "Audio"/"AUDIO"/"audio" sibling folder of the collection folder).
function findCompanionWav(wrapperChildren, audioFolders, clipBase) {
  const direct = wrapperChildren.find(
    (e) =>
      !e.isDir &&
      hasExt(e.name, "wav") &&
      baseName(e.name).toLowerCase() === clipBase.toLowerCase()
  );
  if (direct) return direct;

  for (const af of audioFolders) {
    const found = af.entries.find(
      (e) =>
        !e.isDir &&
        hasExt(e.name, "wav") &&
        baseName(e.name).toLowerCase() === clipBase.toLowerCase()
    );
    if (found) return found;
  }
  return null;
}

// ==========================================================================
// Per-directory resolution
// ==========================================================================
// Resolves ONE directory level (does not recurse). Returns:
//   {
//     items: Array<
//       | { type: "clip", kind, wrapperName, representativeFile, clipBase,
//           asNumberedStills, wav: entry|null }
//       | { type: "flat", file: entry }
//       | { type: "warning", message }
//     >,
//     recurseDirs: Array<{ entry, children }>
//   }
// `items` are things to import into the bin that mirrors `dirRef` itself
// (never a bin for a wrapper folder). `recurseDirs` are subfolders the
// caller should walk into next (with their own already-fetched `children`
// passed along, to avoid re-listing them).
async function resolveDirectory(dirRef, listEntries, preloadedEntries) {
  const rawEntries = preloadedEntries || (await listEntries(dirRef));
  // Folders matching SKIP_FOLDER_NAMES (Exports, Renders, Proxies, ...) are
  // treated as if they don't exist at all - not recursed into, and never a
  // source of items, regardless of what they contain.
  const entries = rawEntries.filter(
    (e) => !(e.isDir && isSkippedFolderName(e.name))
  );

  // Classify every direct subdirectory: is it itself a wrapper folder?
  // Run concurrently (capped) rather than one-at-a-time - see
  // mapConcurrent()'s comment for why this matters on large card folders.
  const CLASSIFY_CONCURRENCY = 12;
  const subdirEntries = entries.filter((e) => e.isDir);
  const dirInfos = await mapConcurrent(subdirEntries, CLASSIFY_CONCURRENCY, async (e) => {
    const children = await listEntries(e.ref);
    const rule = findWrapperRule(e.name, children);
    return { entry: e, children, rule };
  });

  const wrapperDirs = dirInfos.filter((d) => d.rule);
  const items = [];
  let recurseDirs;

  if (wrapperDirs.length > 0) {
    // This directory is a "collection" folder - generalizes the RED
    // card-folder concept to any vendor's folder-per-clip convention.
    // Every wrapper subfolder becomes ONE clip landing in the bin that
    // mirrors THIS folder (never a bin of its own for the wrapper).
    const audioDirInfos = dirInfos.filter(
      (d) => !d.rule && /^audio$/i.test(d.entry.name)
    );
    const otherDirInfos = dirInfos.filter(
      (d) => !d.rule && !/^audio$/i.test(d.entry.name)
    );

    // Audio sibling folders' entries were already fetched above (as part
    // of classifying them) - reuse the SAME array/objects here so the
    // "claimed" tracking below works by simple reference equality.
    const audioFolders = audioDirInfos.map((ad) => ({ entries: ad.children }));

    const claimed = new Set();

    for (const w of wrapperDirs) {
      const resolved = w.rule.resolve(w.entry.name, w.children);
      if (!resolved || resolved.warning) {
        items.push({
          type: "warning",
          message:
            (resolved && resolved.warning) ||
            "could not resolve wrapper folder " + w.entry.name,
        });
        continue;
      }
      const wav = findCompanionWav(w.children, audioFolders, resolved.clipBase);
      if (wav) claimed.add(wav);
      items.push({
        type: "clip",
        kind: resolved.kind,
        wrapperName: w.entry.name,
        representativeFile: resolved.representativeFile,
        clipBase: resolved.clipBase,
        asNumberedStills: !!resolved.asNumberedStills,
        wav: wav || null,
      });
    }

    // Plain media files sitting directly in this collection folder itself
    // (e.g. a stray standalone clip dropped alongside a RED card).
    for (const e of entries) {
      if (e.isDir) continue;
      if (isMediaFile(e.name)) {
        items.push({ type: "flat", file: e });
      }
    }

    // Orphan audio: wav/audio files in an Audio/AUDIO sibling folder that
    // were never claimed as a companion to any wrapper clip above (e.g. a
    // separate sound recordist's take with no matching camera roll). The
    // original RED-only version silently dropped these; this is the
    // generalization requested for standalone-audio support.
    for (const af of audioFolders) {
      for (const e of af.entries) {
        if (e.isDir || claimed.has(e)) continue;
        if (isAudioFile(e.name)) {
          items.push({ type: "flat", file: e });
        }
      }
    }

    recurseDirs = otherDirInfos;
  } else {
    // Plain folder: no folder-per-clip wrapper here. Every direct
    // video/audio file becomes its own imported item (mirroring THIS
    // folder's bin); stills/sidecars/anything else is skipped. Every
    // subfolder is recursed into normally - including one literally
    // named "Audio": with no camera wrapper present at this level there
    // is nothing for it to be a companion TO, so it is just an ordinary
    // folder and gets its own mirrored bin.
    for (const e of entries) {
      if (!e.isDir && isMediaFile(e.name)) {
        items.push({ type: "flat", file: e });
      }
    }
    recurseDirs = dirInfos;
  }

  return { items, recurseDirs };
}

// ==========================================================================
// Full recursive walk
// ==========================================================================
// Walks from `rootRef` down, calling `onItem(item, pathSegments)` for
// every resolved clip/flat-media/warning item found anywhere in the tree.
// `pathSegments` is the array of on-disk folder names (exactly as they
// appear, trailing spaces and all) from the chosen root down to (and
// including) the folder the item's bin should mirror - this is exactly
// the bin path that should be created/reused in Premiere for that item.
// `hooks` (all optional) let the caller show real-time progress and act on
// a folder's results as soon as they're known, instead of only finding out
// anything happened after the ENTIRE tree finishes walking:
//   onEnterDir(pathSegments)            - called right as this folder
//                                          starts being scanned/classified
//                                          (before the possibly-slow
//                                          subfolder classification step)
//   onDirDone(pathSegments, itemCount)  - called once this folder's own
//                                          items are fully resolved (but
//                                          before recursing into children)
async function walkTree(rootRef, rootName, listEntries, onItem, hooks) {
  hooks = hooks || {};
  async function walk(dirRef, pathSegments, preloadedEntries) {
    if (hooks.onEnterDir) hooks.onEnterDir(pathSegments);
    const plan = await resolveDirectory(dirRef, listEntries, preloadedEntries);
    for (const item of plan.items) {
      await onItem(item, pathSegments);
    }
    if (hooks.onDirDone) await hooks.onDirDone(pathSegments, plan.items.length);
    for (const d of plan.recurseDirs) {
      await walk(d.entry.ref, pathSegments.concat([d.entry.name]), d.children);
    }
  }
  await walk(rootRef, [rootName]);
}

module.exports = {
  VIDEO_EXTS,
  AUDIO_EXTS,
  SKIP_EXTS,
  SKIP_FOLDER_NAME_TERMS,
  hasExt,
  baseName,
  isVideoFile,
  isAudioFile,
  isMediaFile,
  isSkippedFolderName,
  WRAPPER_RULES,
  RED_RULE,
  ARRI_RAW_SEQUENCE_RULE,
  findWrapperRule,
  findCompanionWav,
  resolveDirectory,
  walkTree,
  mapConcurrent,
};
