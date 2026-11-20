"""Sync External Audio measure.py, Master for YouTube measure.py, Sound Pass measure.py,
Sync Interviews syncmeasure.py and Colour lutpreset.py: real ffmpeg runs on generated media."""
import json, os, subprocess, sys, unittest
import numpy as np
from qa_util import ROOT, FFMPEG, load, tmpdir, write_wav, speechy, run

PY = sys.executable
SEA = os.path.join(ROOT, "skills", "sync-external-audio", "measure.py")
LM = os.path.join(ROOT, "skills", "loudness-master", "measure.py")
needs_ffmpeg = unittest.skipUnless(FFMPEG, "ffmpeg not installed")


class SyncExternalAudioPure(unittest.TestCase):
    m = load("skills/sync-external-audio/measure.py", "sea_measure")

    def test_clock_from_names(self):
        self.assertEqual(self.m.clock("A_0062C344H260927_153021EJ.MXF"), 15 * 3600 + 30 * 60 + 21)
        self.assertEqual(self.m.clock("DJI_38_20261005_020529.WAV"), 2 * 3600 + 5 * 60 + 29)
        self.assertIsNone(self.m.clock("C0001.MP4")); self.assertIsNone(self.m.clock(""))

    def test_median(self):
        self.assertEqual(self.m.median([3, 1, 2]), 2); self.assertEqual(self.m.median([4, 1, 2, 3]), 2.5)
        with self.assertRaises(IndexError): self.m.median([])

    def test_accept_rules(self):
        a = self.m.accept
        self.assertEqual(a({0: (10.0, 3.0), 2: (10.02, 2.5)})[0], 10.0)          # two channels agree
        self.assertIsNone(a({0: (10.0, 3.0), 2: (10.2, 2.5)})[0])                # 200 ms apart
        self.assertIsNone(a({0: (10.0, 1.5), 2: (10.0, 1.9)})[0])                # weak peaks never accepted
        self.assertEqual(a({0: (10.0, 3.5)}, {0: 10.01})[0], 10.0)               # coarse + fine agree
        self.assertIsNone(a({0: (10.0, 2.5)}, {0: 10.01})[0])
        self.assertIsNone(a({0: (10.0, 3.0), 2: (10.0, 3.0)}, strict=True)[0])   # strict needs 4
        self.assertEqual(a({0: (10.0, 9.0)}, strict=True)[0], 10.0)
        self.assertIsNone(a({})[0])

    def test_gcc_finds_a_known_lag(self):
        sr = 2000; sig = speechy(60, sr, 1); clip = sig[25000:25000 + 20 * sr]
        n = 1 << int(np.ceil(np.log2(len(sig) + len(clip))))
        lag, ratio = self.m.peak_ratio(self.m.gcc_peak(np.fft.rfft(sig, n), n, clip, -len(clip) + 1, len(sig)), sr)
        self.assertEqual(lag, 25000); self.assertGreater(ratio, 5)

    def test_gcc_on_silence_and_empty_window(self):
        sr = 2000; z = np.zeros(10 * sr)
        n = 1 << 16
        lag, ratio = self.m.peak_ratio(self.m.gcc_peak(np.fft.rfft(z, n), n, z[:4000], 10, 5), sr)  # empty lag range
        self.assertIsNone(lag); self.assertEqual(ratio, 0.0)


@needs_ffmpeg
class SyncExternalAudioEndToEnd(unittest.TestCase):
    def test_places_a_camera_clip_in_the_recorder_wav(self):
        d = tmpdir(); sr = 48000
        rec = speechy(400, sr, 7)
        wav = write_wav(os.path.join(d, "ZOOM0001 é.WAV"), rec, sr)
        start = 123.456
        cam = rec[int(start * sr):int((start + 30) * sr)] * 0.5 + np.random.default_rng(3).standard_normal(30 * sr) * 0.01
        cam2 = np.random.default_rng(4).standard_normal(30 * sr) * 0.05  # 2nd channel: unrelated room mic
        camwav = write_wav(os.path.join(d, "cam.wav"), np.stack([cam, cam2], 1), sr, 2)
        mov = os.path.join(d, "A001 clip 🎬.mov")
        r = run([FFMPEG, "-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=160x90:r=25:d=30", "-i", camwav,
                 "-filter_complex", "[1:a]channelsplit=channel_layout=stereo[l][r]", "-map", "0:v", "-map", "[l]", "-map", "[r]",
                 "-c:v", "mjpeg", "-c:a", "pcm_s16le", "-shortest", mov])
        self.assertEqual(r.returncode, 0, r.stderr)
        job = {"ffmpeg": FFMPEG, "cacheDir": d, "wavs": [{"path": wav, "duration": 400.0}],
               "clips": [{"id": "c1", "path": mov, "inPoint": 0.0, "duration": 30.0, "name": "A001 clip 🎬.mov"},
                         {"id": "c2", "path": os.path.join(d, "missing.mov"), "inPoint": 0.0, "duration": 30.0, "name": "missing.mov"},
                         {"id": "c3", "path": mov, "inPoint": 0.0, "duration": 0.5, "name": "short"}]}
        p = subprocess.run([PY, SEA], input=json.dumps(job), capture_output=True, text=True, timeout=300)
        self.assertEqual(p.returncode, 0, p.stderr[-800:])
        res = {x["id"]: x for x in json.loads(p.stdout)["results"]}
        self.assertTrue(res["c1"]["synced"], res["c1"])
        self.assertAlmostEqual(res["c1"]["wavTime"], start, delta=0.002)  # well under a frame
        self.assertFalse(res["c2"]["synced"]); self.assertIn("could be read", res["c2"]["reason"])
        self.assertFalse(res["c3"]["synced"]); self.assertEqual(res["c3"]["reason"], "clip too short to measure")

    def test_bad_job_json_fails_loudly(self):
        p = subprocess.run([PY, SEA], input="{not json", capture_output=True, text=True)
        self.assertNotEqual(p.returncode, 0)


@needs_ffmpeg
class LoudnessMeasure(unittest.TestCase):
    m = load("skills/loudness-master/measure.py", "lm_measure")

    def _measure(self, job):
        p = subprocess.run([PY, LM], input=json.dumps(job), capture_output=True, text=True, timeout=120)
        return p.returncode, json.loads(p.stdout)

    def test_ebu_reference_sine_reads_minus_23_lufs(self):
        # EBU Tech 3341 test 1: stereo 1 kHz sine at -23 dBFS must read -23.0 +- 0.1 LUFS.
        d = tmpdir(); sr = 48000; t = np.arange(20 * sr) / sr
        x = 10 ** (-23 / 20) * np.sin(2 * np.pi * 1000 * t)
        wav = write_wav(os.path.join(d, "ebu ref é.wav"), np.stack([x, x], 1), sr, 2)
        code, out = self._measure({"wav": wav, "ffmpeg": FFMPEG})
        self.assertEqual(code, 0, out)
        self.assertAlmostEqual(out["integrated"], -23.0, delta=0.1)
        self.assertAlmostEqual(out["samplePeak"], -23.0, delta=0.1)
        self.assertAlmostEqual(out["truePeak"], -23.0, delta=0.2)
        self.assertAlmostEqual(out["duration"], 20.0, delta=0.1)
        self.assertLess(out["lra"], 0.5)

    def test_silence_gives_no_peak_not_a_crash(self):
        d = tmpdir(); wav = write_wav(os.path.join(d, "silent.wav"), np.zeros(48000 * 3))
        code, out = self._measure({"wav": wav, "ffmpeg": FFMPEG})
        self.assertEqual(code, 0, out); self.assertIsNone(out["truePeak"]); self.assertLessEqual(out["integrated"], -69.9)

    def test_missing_file_and_garbage_file(self):
        d = tmpdir()
        code, out = self._measure({"wav": os.path.join(d, "nope.wav"), "ffmpeg": FFMPEG})
        self.assertEqual(code, 1); self.assertIn("no such file", out["error"])
        g = os.path.join(d, "junk.wav"); open(g, "wb").write(b"\x00garbage" * 100)
        code, out = self._measure({"wav": g, "ffmpeg": FFMPEG})
        self.assertEqual(code, 1); self.assertIn("ffmpeg exited", out["error"])

    def test_num_parser(self):
        self.assertEqual(self.m.num("  I:  -14.0 LUFS", "I", "LUFS"), -14.0)
        self.assertIsNone(self.m.num("  Peak:  -inf dBFS", "Peak", "dBFS"))
        with self.assertRaises(RuntimeError): self.m.num("nothing", "I", "LUFS")

    def test_ffmpeg_not_found_message(self):
        try:
            self.m.find_ffmpeg("/nope/ffmpeg")
        except RuntimeError as e:
            self.assertIn("ffmpeg not found", str(e))


class SyncInterviewsPure(unittest.TestCase):
    m = load("skills/interview-sync/syncmeasure.py", "is_measure")

    def test_piece_spans(self):
        self.assertEqual(self.m.piece_spans(30), [(0.0, 30)])
        self.assertEqual(len(self.m.piece_spans(150)), 2); self.assertEqual(len(self.m.piece_spans(600)), 3)
        for off, ln in self.m.piece_spans(600): self.assertTrue(0 <= off and off + ln <= 600)

    def test_pick_channels_drops_copies_and_silence(self):
        sr = self.m.SR; a = speechy(10, sr, 1); b = speechy(10, sr, 2) * 0.5
        out = self.m.pick_channels({0: a, 1: a.copy(), 2: np.zeros(10 * sr), 3: b, 4: a[:100]})
        self.assertEqual([s for s, _ in out], [0, 3])

    def test_gcc_lag(self):
        sr = self.m.SR; sig = speechy(120, sr, 5); piece = sig[40000:40000 + 30 * sr]
        lag, ratio = self.m.gcc(sig, piece)
        self.assertEqual(lag, 40000); self.assertGreater(ratio, 5)


class LutPreset(unittest.TestCase):
    m = load("skills/colour-baseline/lutpreset.py", "lutpreset")

    def _cube(self, text):
        d = tmpdir(); p = os.path.join(d, "look é.cube"); open(p, "w", encoding="utf-8").write(text); return p

    def test_parse_identity_cube(self):
        rows = "\n".join("%f %f %f" % (r, g, b) for b in (0, 1) for g in (0, 1) for r in (0, 1))
        size, dmin, dmax, vals = self.m.parse_cube(self._cube('TITLE "x"\n# c\nLUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n' + rows + "\n"))
        self.assertEqual(size, 2); self.assertEqual(len(vals), 24); self.assertEqual(dmax, [1.0, 1.0, 1.0])

    def test_bad_cubes_raise_lut_error(self):
        for bad in ["LUT_1D_SIZE 4\n0 0 0\n", "0 0 0\n", "LUT_3D_SIZE 2\n0 0 0\n", "LUT_3D_SIZE 2\n0 0\n", "LUT_3D_SIZE two\n", ""]:
            with self.assertRaises(self.m.LutError, msg=bad): self.m.parse_cube(self._cube(bad))

    def test_embedded_blob_for_cube_and_itx(self):
        rows = "\n".join("0.5 0.5 0.5" for _ in range(8))
        p = self._cube("LUT_3D_SIZE 2\n" + rows)
        blob, h = self.m.embedded_blob(p)
        self.assertEqual(blob[:16], h); self.assertIn(b"ITX3", blob[:24])

    def test_main_without_arguments_explains_usage(self):
        p = run([PY, os.path.join(ROOT, "skills", "colour-baseline", "lutpreset.py")])
        self.assertNotEqual(p.returncode, 0)
        self.assertNotIn("IndexError", p.stderr, "no arguments should print the usage, not a crash")


if __name__ == "__main__":
    unittest.main()
