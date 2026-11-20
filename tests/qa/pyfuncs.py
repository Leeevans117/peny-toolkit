"""Lists the Python functions (in skills/ and tools/) that the Python tests call, for
tests/qa/inventory.js.   python3 tests/qa/pyfuncs.py out.json"""
import json, os, sys, trace, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "tests", "python"))
os.chdir(os.path.join(ROOT, "tests", "python"))
t = trace.Trace(count=0, trace=0, countfuncs=1)
t.runfunc(lambda: unittest.TextTestRunner(verbosity=0).run(unittest.defaultTestLoader.discover(".")))
out = sorted(set((os.path.relpath(f[0], ROOT), f[2]) for f in t.results().calledfuncs
                 if f[0].startswith(ROOT) and "/tests/" not in f[0]))
json.dump(out, open(sys.argv[1], "w"))
print(len(out), "Python functions called")
