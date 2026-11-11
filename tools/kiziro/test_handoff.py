import hashlib
import os
import stat
import subprocess
import sys
import unittest
import warnings
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory, TemporaryFile
from unittest.mock import patch

import handoff as h


class Handoff(unittest.TestCase):
    def setUp(self):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.parent = Path(temp.name)
        self.root = self.parent / "desktop"
        self.root.mkdir()
        self.p = "board.kicad_pro"
        self.web = self.parent / "web.zip"
        self.base = self.parent / "base.zip"
        self.candidate = self.parent / "desktop-candidate"
        self.initial = {self.p: b"{}", "same": b"s", "edit": b"e", "del": b"d",
                        "web": b"w", "sub/blob": bytes(range(256)), "empty": b""}
        for name, data in self.initial.items():
            self.put(name, data)
        (self.root / "emptydir").mkdir()

    def put(self, name, data):
        path = self.root / name
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(data)

    def archive(self, entries, marker_from=None):
        with zipfile.ZipFile(self.web, "w") as z:
            if marker_from:
                wrapper = entries[0][0].split("/")[0]
                with zipfile.ZipFile(marker_from) as src:
                    z.writestr(wrapper + "/" + h.MARKER, src.read("board/" + h.MARKER))
            for name, data in entries:
                z.writestr(name, data)

    def cli(self, *args):
        return subprocess.run([sys.executable, h.__file__, *args], capture_output=True)

    def test_cli_and_preservation(self):
        run = self.cli("snapshot", self.root, "-o", self.base)
        self.assertEqual(run.returncode, 0, run.stderr)
        with zipfile.ZipFile(self.base) as z:
            self.assertEqual(z.read("board/sub/blob"), self.initial["sub/blob"])
        self.put("edit", b"desktop")
        self.put("new", b"local addition")
        self.put("same", b"identical")
        (self.root / "del").unlink()
        self.archive([("other/" + n, d) for n, d in
                      [(self.p, b"{}"), ("same", b"identical"), ("del", b"d"),
                       ("edit", b"e"), ("web", b"\xff\x00remote"), ("extra", b"new")]], self.base)
        originals = [p.read_bytes() for p in (self.base, self.web)]
        args = ("reconcile", self.base, self.root, self.web)
        procs = [subprocess.Popen([sys.executable, h.__file__, *args], stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE) for _ in range(2)]
        for proc in procs:
            proc.communicate(timeout=15)
        self.assertEqual(sorted(p.returncode for p in procs), [0, 0])
        expected = dict(self.initial, edit=b"desktop", same=b"identical", new=b"local addition")
        del expected["del"]
        def contents(root):
            return {p.relative_to(root).as_posix(): p.read_bytes()
                    for p in root.rglob("*") if p.is_file()}
        self.assertEqual(contents(self.root), expected)
        self.assertEqual(contents(self.candidate), dict(expected, web=b"\xff\x00remote", extra=b"new"))
        self.assertEqual(contents(self.parent / "desktop-candidate-2"), contents(self.candidate))
        self.assertTrue((self.candidate / "emptydir").is_dir())
        self.assertEqual([p.read_bytes() for p in (self.base, self.web)], originals)
        self.assertNotEqual(self.cli("snapshot", self.root, "-o", self.base).returncode, 0)

    def test_large_repeated_snapshots(self):
        large = self.root / "sample.bin"
        with large.open("wb") as f:
            f.seek(128 * 1024**2)
            f.write(b"!")
        base = h.snapshot(self.root)
        candidate = h.reconcile(base, self.root, base)
        with large.open("rb") as original, (candidate / large.name).open("rb") as copy:
            self.assertEqual(hashlib.file_digest(original, "sha256").digest(),
                             hashlib.file_digest(copy, "sha256").digest())

    def test_many_entries_and_deep_zip_paths(self):
        deep = "/".join(["nested-directory"] * 70 + ["empty"])
        with zipfile.ZipFile(self.web, "w") as z:
            for name in [self.p, deep, *(f"notes/{i}" for i in range(10_001))]:
                z.writestr("x/" + name, b"")
        with TemporaryFile() as spool:
            tree = h.archive(self.web, spool)
        self.assertEqual(len(tree.files), 10_003)
        self.assertIn(deep, tree.files)

    def test_working_folder_exclusions(self):
        ignored = [".git/config", "sub/.git", "~board.kicad_pro.lck",
                   "~board.kicad_pcb.lck", "sub/~board.kicad_sch.lck"]
        for name in ignored + ["~notes.lck", ".gitignore"]:
            self.put(name, b"local")
        base = h.snapshot(self.root)
        with zipfile.ZipFile(base) as z:
            for name in ignored + [".git/"]:
                self.assertNotIn("board/" + name, z.namelist())
        self.archive([("x/" + self.p, b"{}")] + [("x/" + n, b"web") for n in ignored], base)
        candidate = h.reconcile(base, self.root, self.web)
        for name in ignored + [".git"]:
            self.assertFalse((candidate / name).exists())
        for name in ["~notes.lck", ".gitignore"]:
            self.assertEqual((candidate / name).read_bytes(), b"local")

    def test_conflicts(self):
        h.snapshot(self.root, self.base)
        self.put("edit", b"desktop")
        self.put("new", b"desktop")
        (self.root / "del").unlink()
        self.archive([("x/" + n, b"other") for n in (self.p, "edit", "del", "new")], self.base)
        run = self.cli("reconcile", self.base, self.root, self.web)
        self.assertNotEqual(run.returncode, 0)
        for path in (b"edit", b"del", b"new"):
            self.assertIn(path, run.stderr.splitlines())
        self.assertFalse(self.candidate.exists())

    def test_snapshot_identity(self):
        h.snapshot(self.root, self.base)
        other = h.snapshot(self.root)
        entries = [("x/" + self.p, b"{}"), ("x/web", b"other board")]
        self.archive(entries, other)
        with self.assertRaisesRegex(h.Invalid, "ID"):
            h.reconcile(self.base, self.root, self.web)
        self.archive(entries)
        for baseline, web, label in [(self.base, self.web, "Web ZIP"), (self.web, self.base, "基準 ZIP")]:
            with self.assertRaisesRegex(h.Invalid, label):
                h.reconcile(baseline, self.root, web)
        self.archive(entries + [("x/" + h.MARKER, b"{}")])
        with self.assertRaisesRegex(h.Invalid, h.MARKER):
            h.reconcile(self.base, self.root, self.web)
        self.assertFalse(self.candidate.exists())

    def test_reserved_name(self):
        h.snapshot(self.root, self.base)
        name = h.MARKER.upper()
        self.put(name, b"user")
        with self.assertRaisesRegex(h.Invalid, name):
            h.snapshot(self.root, self.web)
        with self.assertRaisesRegex(h.Invalid, name):
            h.reconcile(self.base, self.root, self.base)
        self.assertEqual((self.root / name).read_bytes(), b"user")
        self.assertFalse(self.web.exists())
        self.assertFalse(self.candidate.exists())

    def test_desktop_root_uuid(self):
        name = "board.kicad_sch"
        uid = b"12345678-1234-1234-1234-123456789abc"
        sch = b'(kicad_sch (nested (uuid "' + uid + b'")) (uuid "' + uid + b'"))'
        self.put(name, sch)
        h.snapshot(self.root, self.base)
        self.put(name, sch[:-4] + b'd"))')
        with self.assertRaisesRegex(h.Invalid, "UUID"):
            h.reconcile(self.base, self.root, self.base)
        self.assertFalse(self.candidate.exists())
        edited = sch.replace(b"nested", b"edited") + b"\n"
        self.put(name, edited)
        self.assertEqual((h.reconcile(self.base, self.root, self.base) / name).read_bytes(), edited)

    def test_bad_inputs(self):
        h.snapshot(self.root, self.base)
        link = zipfile.ZipInfo("x/link")
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        for bad in (["x/../escape"], ["x/CON.txt"], ["x/a:b"], ["x/a."],
                    ["x/A/file", "x/a/other"], ["x/a", "x/a/b"], ["x/a", "x/a"],
                    ["x/other.kicad_pro"], ["y/stray"], ["x/a\\b"], [link]):
            with self.subTest(bad=bad), warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                self.archive([("x/" + self.p, b"{}")] + [(n, b"bad") for n in bad], self.base)
                if bad == ["x/a\\b"]:
                    # The Windows zip writer normalizes separators; patch the fixture.
                    self.web.write_bytes(self.web.read_bytes().replace(b"x/a/b", b"x/a\\b"))
                with self.assertRaises(h.Invalid):
                    h.reconcile(self.base, self.root, self.web)
                self.assertFalse(self.candidate.exists())
        self.archive([("x/wrong.kicad_pro", b"{}")], self.base)
        with self.assertRaises(h.Invalid):
            h.reconcile(self.base, self.root, self.web)
        with self.assertRaises(h.Invalid):
            h.snapshot(self.root, self.root / "bad.zip")

    def test_failed_publication(self):
        h.snapshot(self.root, self.base)
        self.archive([("x/" + self.p, b"{}")], self.base)
        with patch.object(h, "publish", side_effect=OSError("disk error")), self.assertRaises(OSError):
            h.reconcile(self.base, self.root, self.web)
        self.assertFalse(self.candidate.exists())
        self.assertFalse(list(self.parent.glob(".kiziro-work-*")))
        self.candidate.mkdir()
        with self.assertRaises(FileExistsError):
            h.reconcile(self.base, self.root, self.web, self.candidate)
        self.assertEqual(list(self.candidate.iterdir()), [])

    def test_desktop_link(self):
        try:
            os.symlink(self.root / "edit", self.root / "alias")
        except OSError as e:
            self.skipTest(str(e))
        with self.assertRaises(h.Invalid):
            h.snapshot(self.root, self.base)
        self.assertFalse(self.base.exists())


if __name__ == "__main__":
    unittest.main()
