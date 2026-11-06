# Skills in detail

How each skill works and how it was tested. The short list is in the README's "Skills" table.

## Keeping Premiere usable while a skill runs (6 Nov 2026)

Premiere freezes only while an ExtendScript call runs, so long calls were removed:
- Renders go to Media Encoder (`T.queueRender` in core/core.jsx, waited for by core/ame.js):
  Master for YouTube and Find answers. Premiere freezes ~0.3 s to queue; Media Encoder's
  callback writes /tmp/peny-toolkit/ame/<jobId>.json when done. The job is a snapshot taken
  when it is queued (edits made after queuing are not in the file). A preset must have its
  own PresetID: with the PresetID of Media Encoder's "Waveform Audio 48kHz 16-bit" (the old
  wav-float.epr) Media Encoder writes 16-bit whatever the preset says. Tested in TEST.prproj:
  TONY INTRO 14.5 min, Media Encoder render sample-identical to exportAsMediaDirect, 21 s
  vs 24 s frozen. Sound Pass still uses exportAsMediaDirect (its wav-float.epr has the old ID).
- Small pieces: Link Step 3 ("pieceMs" in skill.json, main.js evalPieces: ~0.3 s of work per
  call, 0.3 s pause, stops if another sequence is opened), Proxies Attach (10 per call),
  Ingest import (10 files per call). Day 4 R5 Sync copy (172 clips): Link 21 s in one call ->
  pieces of 1.3-1.6 s, 90 s in all (each piece re-reads the timeline, ~1.2 s on this one).
- Not split: Cut, raise & trim (its relink and raise use the link groups read before the
  first cut, and it needs the Cut version active), Colour Apply (importSequences).
- The panel process runs at nice 10 (main.js), so ffmpeg, REDline, python, whisper and an
  ollama it starts inherit it.
- Speed switch on Proxies and Ingest + Proxies ("shared" segment input, one value in
  ~/.peny-toolkit/settings.json, read each time a render could start): Full = 4 renders at
  once; Half (keep working) = 1 REDline and at most 2 renders at once. Measured on the Mac
  mini M4 Pro (14 cores), A160 R3D clip: 1 REDline ~7.5 cores, 4 at once ~12.9; 2 at once
  ~12.0 (so not used); taskpolicy -b 12x slower; --decodeThreads does not limit CPU; ffmpeg
  4 at once ~4.8 cores. In TEST.prproj Half rendered 1 at a time (12-15 s per clip), switching
  to Full mid-run went to 4 at once. tools/pool-limits-test.js checks the limits.
  Not yet checked: playback smoothness in Half (REDline also uses the GPU).
- Undo while a job runs (6 Nov 2026, TEST): Edit > Undo takes back the newest step on
  Premiere's history, which can be the Toolkit's (it took back the last "Attach Proxies" of a
  run). A running job does not see it; its read-back covers only its own call.

## Link External Audio (app)

Three steps: 1 Make safe copy, 2 Sync external audio, 3 Link external audio. Make safe copy and Sync are hidden skills run from this app's buttons ("skill" on an action)

**Tested:** Tested 2 Oct 2026 in the TEST project on Lee's 2 Desktop Canon clips + 2 Rode wavs: both synced, D071 cut at 1:06.12, 3 pieces on A1, 3 halves/clips linked (6 items each, getLinkedItems), 2 parked wavs removed from the copy, original sequence untouched

## Sync external audio

measure.py: GCC-PHAT, every camera channel separately (exact duplicates dropped), coarse in 10-min wav windows, fine +-3 s at 8 kHz; accepts only when two channels agree or coarse+fine agree with a strong peak; camera-clock second pass for short clips. Places pieces with in/out in ticks (rounded to frames by Premiere); all pieces on the wireless track; a clip crossing two wavs is cut there (QE razor, camera halves re-linked and checked) so each half links to its own piece. Link then removes the parked whole-wav copies (only timeline instances on the TOOLKIT COPY, unlinked, over no video, whose file is linked under a clip)

**Tested:** 14 La Thuile clips vs hand sync: 9 synced, all within 18 ms, 0 wrong, 5 left for hand sync

## Make safe copy

Duplicates the active sequence as "<name> TOOLKIT COPY", checks the original is unchanged, opens the copy

**Tested:** Tested 2 Oct 2026 (TEST project)

## Link external audio

Links each camera clip to its camera audio and the external wav under it; verifies each link; refuses non-copies

**Tested:** Tested 2 Oct 2026 on 3 groups (TEST project)

## Proxies

Renders ProRes Proxy files (ffmpeg / REDline) into a folder tree mirroring the bins, attaches/detaches them; Pause/Resume/Cancel. Never deletes or overwrites a proxy; R3D wins a name clash; same media in two bins renders once

**Tested:** Port of Proxy Automation. Tested 2 Oct 2026 on a 2-clip scratch bin (Canon + R3D) in the TEST project: render, attach, detach, pause/resume, cancel. Not yet tested at scale

## Ingest (import-footage)

Button runs the Ingest + proxies code path stopped after the import step (ingest-pipeline action "ingest"); Step 1 FOOTAGE sheet, then folder window. Imports a footage folder mirroring its tree as bins (port of Master Footage Importer CEP 2.0.0). RED clips import like Media Browser: R3D only; normal-speed clips carry their sound inside the R3D, slow-motion clips (75-240 fps) have none and their separate .wav is left out unless "Also import slow-motion RED .wav" is ticked. Skips Exports/Renders/Proxies/cache folders and files already in the project (including Media Browser imports stored as /Volumes/<start-up disk>/...). Optional linked R3D+wav sequences (off)

**Tested:** Tested 2 Oct 2026 in the TEST project on real Raptor clips: normal clip Movie 48 kHz 4 mono, slow-mo clip Video only, no wav imported, re-run and Media Browser re-import skipped

## Ingest + proxies

Overall proxy progress bar (x of y, %) from real render exits plus REDline/ffmpeg per-clip fraction. One button: asks for the footage folder, then the proxy folder, then runs Import footage -> Proxies render -> Proxies attach on the imported bin; each stage must pass before the next; Pause/Resume/Cancel

**Tested:** Tested 2 Oct 2026 in the TEST project with Canon R5 MP4, Sony FX6 MXF and RED Raptor R3D (normal + slow-mo): 4 imported, 4 proxies rendered (ProRes 1280x720, audio channels matching), 4 attached and verified; re-run did nothing

## Interviews (interview-selects)

Find answers (30 Oct 2026): Premiere renders the sequence's own sound (exportAsMediaDirect, wav-float.epr), so exactly the mic on the timeline; with the Audio track box filled, ffmpeg reads that track's files, all channels mixed. whisper.cpp transcribes ~25 s pieces cut at quiet moments, no voice detection. Who speaks: each line's level on that sound (2 groups at least 6 dB apart; the interviewer is quiet on the speaker's lav), else Ollama qwen2.5:14b (32b if 14b is missing) labels every line in two passes. Answers are the runs of the interviewee's lines, cut edges moved to silence measured per interview with 0.25 s / 0.5 s handles that stop short of other speech; one short Ollama call names them; questions come from the interviewer's lines with a "?", themes from Ollama; every job stays on the sequence it started on. Makes "<sequence> Cut version" with a Chapter marker per question, a Segmentation marker per theme, and the small topics as clip markers on the clip on the top video track (Lee, 20 Oct 2026; clip markers belong to the footage, so they show in every sequence using it). Cut, raise & trim answers runs only on a "Cut version": cuts at each question's answer, raises it one track (QE moveToTrack), extracts everything outside the topics (read back from the top clips' markers), moves markers, checks links/frames/length, then one adjustment layer per question above the footage and a row of theme layers above that. Tracks are added at the top when needed (QE addTracks with the top index; the bridge's (n,0,0,0) inserts at the bottom). TOPICS = "layer" in premiere.jsx is the tested alternative (topics on the question layers, each with its own source range on the Adjustment Layer item)

**Tested:** Tested 20 Oct 2026 in Les Gets.prproj (Lee's choice) on "TONY Les Gets Interview_Selects CHECK Cut version": 6 questions, 2 themes, 16 topics on the RED clip read back; 27 cuts, 18 pieces raised, links 3/3, nothing shifted, 15:51 -> 13:16, 6 question layers V4, 2 theme layers V5, topics follow the trim. 30 Oct 2026, Whistler, Tod (16 min, fresh copy, test hook, Lee's lav on A1): the render matches the lav channel at 0.999, Find answers 1:54 (sound 22 s, transcript 35 s, AI 53 s), all 180 of his lines and 3 of 43 interviewer lines kept against the other mics as a key, 0 of 56 edges on speech; Lee ran Cut, raise & trim by button: 18 answers, 105 cuts, 53 pieces raised, links intact, nothing shifted, 16:44 -> 14:12, 23 s. Arly offline: 0 of 86 edges on speech before the last tweak; 128/128 and 11/121 simulated on the saved transcript with the final setting. Switching sequence mid-run tested on copies for Find answers, Remove Ums and Sync (before the sound change). Not yet tested: a by-ear check of the cuts, Remove Ums on the new audio, the Audio track box fallback, a full Arly run with the final setting

## Interviews > Remove ums & uhs (unum)

fillers.js: whisper.cpp with a verbatim prompt (Find answers' -mc 0 ignores prompts) and DTW token times (-dtw large.v3.turbo, -nfa) on 10 s clips every 5 s (quiet clips skipped; whole-file passes drifted up to 2 s, VAD word times are speech-only time), then each filler heard again in two 6 s clips; cut only when both put it on the same sound (loud run round the DTW time, >= 100 ms pause each side, pad <= 40 ms and <= a third of each pause). Fillers run into a word are left in. premiere.jsx "unum": "<sequence> No ums" copy, spans snapped to frames, joined under 3 frames, skipped across or within 3 frames of an edit, extracted back to front on every track (trim's extract code, shared), markers moved, links restored, a marker per cut, fillers.csv in the work folder. ~12 min per hour

**Tested:** Audio-only test 23 Oct 2026: Tony Les Gets 41 possible / 28 cut, Rallon 93 / 35; 51 of 63 cuts identical words in a 5 s re-transcription, rest spelling or a repeated word dropped (UNVERIFIED by ear). Lee ran it 23 Oct on Episode_1_Korea "Main Assembly V8_Sub_01 Cut version" and was happy: 20 cuts, V1/V2/A3 in sync, no holes, 882.08 -> 872.44 s; 19 cuts exact, one 2 frames short (cause unknown); the jsx then stopped on Array.filter (ES3), fixed after: cut markers and final checks of that run did not happen. Links after that run not read back

## Interviews > Sync Interviews (interview-sync)

Hidden; run from the Interviews tile, which has two sections: Sync Interviews and Select Interview Process, via "sections" in skill.json; each section's how-to text, and every other app's, sits behind a small "i" button.

Premiere's Synchronize for a whole interview timeline in one go. premiere.jsx "scan": every clip as a unit (camera clip + its linked audio, or an audio clip linked to no picture), media path, attached proxy, start timecode; a clip whose in point, out point and length disagree is skipped with a reason. syncmeasure.py reads the sound with ffmpeg (bundled): an audio file as it is, else the attached proxy if it has sound (non-RED proxies only after a 10 s window matched the original to the sample), RED only from its proxy. Only one side of each comparison is read whole, the side with fewer bytes per second (Whistler: the Canon proxies); the other gives 3 pieces of 60 s via -ss seeks (MXF seeks go to the frame before and drop the extra samples: a seek between frames landed up to half a frame late). 4 reads at once, biggest first, pictures copied to null so ffmpeg reads straight through, each file+range once. Camera A = lowest video track with clips (stays unless its group must move). Matching: 2 kHz GCC-PHAT, loudest distinct channel; a piece of one side found in the whole other side; placed when 2 pieces agree within 40 ms (peak ratio >= 2), or one piece with ratio >= 6 confirmed by the second channel (>= 10 alone); a second pass matches leftovers against clips already placed; timecode only as a fallback when every matched pair gives the same clock offset to 1 frame. Groups keep their order and move later only to clear 0 or a clip on the same track (5 s gap). premiere.jsx "apply": copy "<sequence> Synced" (fingerprint must match), moves with TrackItem.move (park after the end, then into place; assigning .start trims instead), reads every unit back, links each camera clip back to its own audio plus loose audio of the same file in sync and overlapping it, then links per the After syncing choice: Cameras + audio, Cameras only, Don't link; every group read back with getLinkedItems; a group that doesn't hold puts the old links back and the run reports ok:false. Cancel also stops the ffmpeg reads. sync.csv in /tmp/peny-toolkit/interview-sync/<seq>-<time>/. Never saves, renames or deletes

**Tested:** Whistler (Lee's OK to test on copies there, 29 Oct 2026), test hook, RED Komodo X V1/A1-A4 + Canon C50 V3/A8-A11, 5+5 clips, 2:20 h. sync2 (Cameras only, on "INTERVIEWS TOOLKIT COPY Copy" with loose Canon audio): 13 of 13 synced (pieces agree within 1-6 ms) but 4 of 5 link groups: C385's picture there had in 0, out 983.84, length 979.6 (damaged by an earlier bridge move_clip test), so its audio wasn't joined and the failed group left A006 unlinked from its own audio while the run still said ok:true; fixed (such clips are skipped, loose audio joins when in sync and overlapping, failed groups are restored and reported). Reading took 26 min (every file whole: 415 GB, Canon MXFs 44-131 GB each). sync4 (Cameras + audio, fresh duplicate of "INTERVIEWS TOOLKIT COPY", page cache cleared first by reading 94 GB of other footage): ok, 5 of 5 synced, 5 link groups of 10 read back (getLinkedItems 10 for every camera A clip), 59 s end to end (proxy check 5.2 s, reading 41.7 s for 14.1 GB whole + 7.6 GB pieces, matching 5.0 s, apply 5.4 s); every new start equal to sync2's to the ms; "INTERVIEWS TOOLKIT COPY" scanned identical before and after. Offline on sync2's 18 units: all new starts within 0.0 ms of sync2. Not yet tested: Cameras only after the fixes, Don't link mode, external wavs from a real recorder, clicking by hand, a by-ear check, a forced link failure (restore path)

## Sound Pass

Levels interview voice on a safe copy like Lee's Assembly V1 (Hard Limiter on every voice clip, ceiling -6 dB on the master) but per clip: renders the voice tracks with exportAsMediaDirect (32-bit float preset wav-float.epr), measure.py takes each clip's median 400 ms speech peak; Input Boost = -6 dB minus that (within 6 dB of the source's usual boost; quieter clips = interviewer off-mic, usual boost only); the ceiling is moved by the gain measured after the clip (pan law -3 dB, track/master faders). Voice = clips playing a .wav (directly or nested) on unmuted tracks; "Voice tracks" input overrides. Clip gain is not scriptable (QE staticClipGain is read-only) so it is left as is. Mappings measured by render: Volume dB = 20log10(v)+15, Input Boost dB = (v-2/3)*150, Max Amplitude dB = (v-1)*100. "Ride quiet moments" (on by default): after levelling, stretches of clear speech (15 dB gate) whose 2 s level is more than 3 dB under -6 get Volume keyframes lifting them toward -7 dB (max +6, 150 ms ramps); off-mic/short clips and clips with existing Volume keyframes are not ridden

**Tested:** Tested 3 Oct 2026 in TEST (test hook, not by clicking): Tony Home IV, Chris_SeoulIV, Tahnee Home IV, Laura_IV_Seoul copies; all speech tops at -6.0 dB, medians -6.2 to -6.8 dB

## Master for YouTube (loudness-master)

Masters the active sequence's whole mix to a delivery target from targets.json (one button per target; YouTube now: -14 LUFS integrated +-0.5, true peak <= -1 dBTP), after Mike Russell's mix-track method but measured: makes or reuses "<sequence> MASTER YouTube TOOLKIT COPY" in the sequence's bin with the sequence nested as one clip (app.project.createNewSequenceFromClips; nothing in the source changes), puts one Hard Limiter on the nest (QE), Maximum Amplitude = target true peak - 0.5 dB, renders the master (exportAsMediaDirect, wav-float.epr), measures it (measure.py: ffmpeg ebur128 integrated/LRA/true peak, within 0.1 LU of loudnorm) and sets Input Boost from the shortfall, learning how much each dB adds; lowers Maximum Amplitude when the true peak is over; up to 4 passes. Input Boost below 0 only if Premiere reads it back, else a too-loud mix is reported. Marker "Mastered YouTube <LUFS> / <dBTP>" at 0 on the master; report.json in /tmp/peny-toolkit/loudness-master/. Never saves. jsx is ES3 (no Array.filter)

**Tested:** Lee ran it 24 Oct 2026 in Episode_1_Korea on "Main Assembly V8 Audio Test 2  TOOLKIT COPY" (42:57): -17.4 LUFS / +12.2 dBTP as found -> -14.3 LUFS / -1.1 dBTP, Input Boost +3.7 dB, Maximum Amplitude -2.6 dB, 2 passes, 27 min (about 9 min per render). Not independently re-measured (master over 20 min). Offline: harness 8/8 cases, ES3 sandbox. Not yet tested: a cut (Input Boost below 0), the TEST project, the hidden probe of the Mix track

## Colour (colour-baseline)

Detect cameras: names each clip's camera from the file (R3D: REDline --printMeta "Camera Model", one clip per reel; MP4/MXF/MOV: model string in the first 4 MB / last 2 MB, e.g. "Canon EOS R5m2", "ILCE-7SM3", "ILME-FX6V"; Nikon "niko" brand; cached in ~/.peny-toolkit/colour-baseline.json) and lists cameras with clip counts, existing Lumetri names and a LUT picker per camera: a row of folders (this Mac's own Premiere Lumetri/LUTs folders and Adobe Common LUTs folders, read at Detect: Technical, Creative, Basic first, others A-Z; then Presets = Lee's own Lumetri presets from ~/Documents/Adobe/Premiere Pro/<ver>/Profile-*/Effect Presets and Custom Items.prfpset) and an in-panel list with a filter (not a <select>: CEP cut its list off unless the panel was full screen, 23 Oct 2026). Only 3D .cube and ITX3 .itx files are listed; brand-matching preset suggested, choice remembered. Apply baseline grade: exportAsProject of the active sequence -> lutpreset.py grade adds a Lumetri "Adjustments" and the camera's LUT preset above each clip's first Lumetri (clips with a named LUT Lumetri keep theirs) -> importSequences -> "<name> GRADED TOOLKIT COPY" opened and every clip read back (same clip/time/master clip, expected stack). Make LUT presets: a folder of 3D .cube files -> one .prfpset (LUT embedded like Premiere does) for Effects panel > Import Presets. Why not scripting Lumetri directly: setValue cannot load a LUT, effects cannot be renamed, applyLumetriPreset only sees Premiere's 325 bundled presets (not user ones, even after restart); app.project.importFiles on a .prfpset blocks Premiere's scripting behind a dialog (never call it). Values written into project/preset XML need a BinaryHash attribute or Premiere drops them. Premiere renders a clip's effects from the END of its chain upwards and Effect Controls lists them that way; trackItem.components and QE list the chain in file order (upside down). So [LUT, Adjustments] are appended at the end of each chain; checked by render (B&W LUT + warm Adjustments comes out grey). Each effect also gets its own <ID>. Nested sequences used by the graded sequence come in as copies

**Tested:** Tested 3 Oct 2026 in TEST by hook: Seoul Selects (Canon R5 II 133 -> CANON LUT, Nikon ZR 121 -> RED LUT) 254/254 read back, 48 s, frames show the looks; DEVELOPMENT TEST 74/74 (Lee's own CANON/RED LUT clips kept theirs, Adjustments frames identical = neutral); generated LUT effect within 0.5/255 of ffmpeg lut3d. Lee imported "Peny LUT Presets.prfpset" (64 presets). 23 Oct 2026 LUT picker: Detect + picker run in Chromium with the Mac mini's real LUT folders and 64 presets at 260x360, 320x480, 420x700, 900x1000 (list in view, last LUT reachable, choice saved); not yet in the real panel. Not yet tested: clicking by hand, Make LUT presets button by hand

## Selects Setup (selects-sequences)

Scan footage reads the footage bin (selected or typed path). Groups: any bin in it that holds bins (a day, card or camera; RED .RDM/.RDC mag bins don't count), its bins are the blocks; bins that only hold clips are the blocks of one group named after the footage bin. Day bins (Day0_...) are titled "Day 00" and come first. In-panel choices: a name per group for the sequence names (bin name to start with, Lee 23 Oct 2026), block order, label (marker name, KX defaults to Komodo), marker colour, leave out; a clip name in two groups must be given its group. Build: per group "<Project> <group>_Selects UNCUT" (QE newSequence with Premiere's UHD (4K) 2160p 25 fps preset; clips back to back with overwriteClip, each at the frame the previous one really ended on, so Premiere's floor rule needs no maths; 10 s gaps; span marker per block; audio-only clips on a new mono track) and an empty "<Project> <group>_Selects", filed in 01 SEQUENCES/Selects(/UNCUT), every clip and marker read back and checked. Existing sequences left alone; never renames, never saves

**Tested:** Tested 23 Oct 2026 in SELECTS TEST.prproj (scratch, test hook): Day layout (R3D, 25/24 fps MP4s, duplicate C344, mono wav on A5) and Orbea layout (FX30 card > B ROLE/PITS/RIDING, 23.976 + 120 fps): all sequences, 10.00 s gaps, markers and bins checked. Offline harness 63/63 (PenyToolkit-scratch/selects-dev). Not yet tested: clicking by hand, typed group names in Premiere, hundreds of clips, VP9 sound-only clips, stereo wavs, marker colours by eye
