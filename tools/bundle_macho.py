#!/usr/bin/env python3
"""Copies Homebrew programs into a self-contained folder that runs on a Mac without
Homebrew (used by tools/build-installer.sh).

    bundle_macho.py <spec.json> <out dir>

spec.json: {"items": [{"src": path, "dest": "relative/path", "exclude": [glob, ...]}],
            "lib": "lib",
            "patch": [{"file": "relative/path", "from": "/compiled/in/path", "to": "/var/empty"}]}

Each item (a file or a folder) is copied to <out>/<dest>. Then every Mach-O file in the
copy is scanned (otool -L): each library it uses outside /System and /usr/lib is copied
into <out>/<lib> (unless it is already part of the copy) and the reference is rewritten
to an @loader_path-relative one. Absolute LC_RPATHs are removed, dylib ids are made
relative, "patch" overwrites a compiled-in C string with a shorter one (padded with NUL
bytes; e.g. ggml's Homebrew backend folder, searched before the program's own folder),
and every changed file is ad-hoc signed again (Apple Silicon refuses to run a
binary whose signature no longer matches).

The script fails if any copied Mach-O file still names /opt/homebrew or /usr/local in
its load commands.
"""
import fnmatch, json, os, shutil, subprocess, sys

SYSTEM = ("/System/", "/usr/lib/")
MAGICS = {b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca"}


def is_macho(p):
    if os.path.islink(p) or not os.path.isfile(p):
        return False
    try:
        with open(p, "rb") as f:
            return f.read(4) in MAGICS
    except OSError:
        return False


def run(*cmd):
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout


def load_commands(p):
    """-> (id or None, [dependency names], [rpaths])"""
    out = run("otool", "-l", p).splitlines()
    dylib_id, deps, rpaths = None, [], []
    i = 0
    while i < len(out):
        line = out[i].strip()
        if line.startswith("cmd "):
            cmd = line.split()[1]
            # the "name"/"path" line follows within a few lines
            for j in range(i + 1, min(i + 6, len(out))):
                t = out[j].strip()
                if t.startswith("name ") or t.startswith("path "):
                    val = t.split(None, 1)[1].rsplit(" (offset", 1)[0]
                    if cmd == "LC_ID_DYLIB":
                        dylib_id = val
                    elif cmd in ("LC_LOAD_DYLIB", "LC_LOAD_WEAK_DYLIB", "LC_REEXPORT_DYLIB", "LC_LOAD_UPWARD_DYLIB"):
                        deps.append(val)
                    elif cmd == "LC_RPATH":
                        rpaths.append(val)
                    break
        i += 1
    return dylib_id, deps, rpaths


def resolve(name, orig, rpaths):
    d = os.path.dirname(orig)
    if name.startswith("@loader_path/") or name.startswith("@executable_path/"):
        c = os.path.join(d, name.split("/", 1)[1])
        return c if os.path.exists(c) else None
    if name.startswith("@rpath/"):
        rest = name[len("@rpath/"):]
        for r in rpaths:
            r = r.replace("@loader_path", d).replace("@executable_path", d)
            c = os.path.join(r, rest)
            if os.path.exists(c):
                return c
        return None
    return name if os.path.exists(name) else None


def main():
    spec = json.load(open(sys.argv[1]))
    out = os.path.abspath(sys.argv[2])
    libdir = os.path.join(out, spec.get("lib", "lib"))
    os.makedirs(libdir, exist_ok=True)

    origin = {}   # bundle path -> original real path
    placed = {}   # original real path -> bundle path

    def excluded(rel, pats):
        return any(fnmatch.fnmatch(rel, p) or fnmatch.fnmatch(os.path.basename(rel), p) for p in pats)

    for item in spec["items"]:
        src, dest = item["src"], os.path.join(out, item["dest"])
        pats = item.get("exclude", [])
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        if os.path.isdir(src):
            for root, dirs, files in os.walk(src):
                relroot = os.path.relpath(root, src)
                dirs[:] = [x for x in dirs if not excluded(os.path.normpath(os.path.join(relroot, x)), pats)]
                for fn in files:
                    rel = os.path.normpath(os.path.join(relroot, fn))
                    if excluded(rel, pats):
                        continue
                    s, t = os.path.join(root, fn), os.path.join(dest, rel)
                    os.makedirs(os.path.dirname(t), exist_ok=True)
                    if os.path.islink(s) and not os.path.exists(s):
                        continue  # dangling (e.g. optional MLX libraries)
                    shutil.copy2(os.path.realpath(s), t)
                    origin[t] = os.path.realpath(s)
                    placed.setdefault(os.path.realpath(s), t)
        else:
            shutil.copy2(os.path.realpath(src), dest)
            origin[dest] = os.path.realpath(src)
            placed.setdefault(os.path.realpath(src), dest)

    queue = [p for p in origin if is_macho(p)]
    done, changed = set(), set()
    while queue:
        p = queue.pop()
        if p in done:
            continue
        done.add(p)
        orig = origin[p]
        dylib_id, deps, rpaths = load_commands(orig)
        args = []
        for name in deps:
            if name.startswith(SYSTEM):
                continue
            real = resolve(name, orig, rpaths)
            if not real:
                if name.startswith("@"):
                    continue  # optional, resolved at run time by the program itself
                raise SystemExit("cannot find %s (used by %s)" % (name, orig))
            real = os.path.realpath(real)
            target = placed.get(real)
            if not target:
                target = os.path.join(libdir, os.path.basename(name))
                if os.path.exists(target) and origin.get(target) != real:
                    raise SystemExit("two different libraries named %s" % os.path.basename(name))
                shutil.copy2(real, target)
                os.chmod(target, 0o755)
                origin[target] = real
                placed[real] = target
                queue.append(target)
            new = "@loader_path/" + os.path.relpath(target, os.path.dirname(p))
            if new != name:
                args += ["-change", name, new]
        if dylib_id and not dylib_id.startswith("@"):
            args += ["-id", "@loader_path/" + os.path.basename(p)]
        for r in rpaths:
            if not r.startswith("@"):
                args += ["-delete_rpath", r]
        if args:
            os.chmod(p, os.stat(p).st_mode | 0o200)
            run("install_name_tool", *args, p)
            changed.add(p)

    for pt in spec.get("patch", []):
        p = os.path.join(out, pt["file"])
        a, b = pt["from"].encode() + b"\0", pt["to"].encode()
        if len(b) >= len(a):
            raise SystemExit("patch: %r must be shorter than %r" % (pt["to"], pt["from"]))
        data = open(p, "rb").read()
        if data.count(a) < 1:
            raise SystemExit("patch: %r not found in %s" % (pt["from"], pt["file"]))
        open(p, "wb").write(data.replace(a, b + b"\0" * (len(a) - len(b))))
        changed.add(p)

    for p in sorted(changed):
        run("codesign", "--force", "--sign", "-", p)

    bad = []
    for p in origin:
        if is_macho(p):
            dylib_id, deps, rpaths = load_commands(p)
            for v in deps + rpaths + ([dylib_id] if dylib_id else []):
                if v.startswith(("/opt/homebrew", "/usr/local")):
                    bad.append("%s -> %s" % (os.path.relpath(p, out), v))
    if bad:
        raise SystemExit("still points at Homebrew:\n  " + "\n  ".join(bad))
    print("bundled %d Mach-O files (%d re-signed), %d libraries added" %
          (sum(1 for p in origin if is_macho(p)), len(changed),
           sum(1 for p in origin if p.startswith(libdir + os.sep))))


if __name__ == "__main__":
    main()
