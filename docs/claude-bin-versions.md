# Claude bin versions (Lee, 11-12 Nov 2026)
ready/ = the GitHub checkout as of 494759f plus only this change (main.js = checkout + one action.params hunk; no syncmeasure.py change). This is what to merge.
src/ = what is installed on Data's Mac mini (adds the 10 Nov animation tweak in main.js and the RED picture-sync syncmeasure.py sm_v4 from other threads; do not merge those from here).
claude-bin-versions.patch = diff orig -> ready.
Behaviour: every button that makes a new sequence (Make Safe Copy, Link External Audio step 1, Sound Pass, Colour, Master for YouTube, Sync Interviews, Find answers, Trim, Remove ums) names it from the source name with only its V number bumped (Tony EOY IV_V1 -> Tony EOY IV_V2; no V -> ' V1'; taken -> next free) and files it in 'Claude bin/<Button>'. Find answers, Sound Pass and Master always make a new version. Gates use T.versionBinOf (treePath) plus old names. Selects Setup and Ingest are NOT changed (Lee: don't let it run for Selects Setup).
Tested: Premiere TEST_1 on the Mac mini 12 Nov, all buttons above except underscore names (offline only). Not committed.
