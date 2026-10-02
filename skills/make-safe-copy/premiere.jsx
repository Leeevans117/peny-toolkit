// Make safe copy: duplicate the active sequence as "<name> TOOLKIT COPY" and open
// the copy, so later skills work on it and never on the original.
PenyToolkit.skills["make-safe-copy"] = function (params) {
  var T = PenyToolkit;
  var seq = T.activeSequence();
  if (!seq) return T.fail("No active sequence. Open the sequence you want to copy first.");

  var r = T.duplicateSequence(seq);
  if (!r.ok) return r;

  var opened = false;
  try { opened = app.project.openSequence(r.details.copyId); } catch (e) {}
  var active = T.activeSequence();
  r.details.copyIsActive = !!(active && String(active.sequenceID) === r.details.copyId);
  r.details.openSequenceReturned = opened;
  if (!r.details.originalUnchanged) {
    r.ok = false;
    r.error = "Copy made, but the original sequence no longer matches its fingerprint. Check it before going on.";
  } else {
    r.summary += r.details.copyIsActive ? " It is now the active sequence." : " Open it before running other skills.";
  }
  return r;
};
