"""Local, byte-for-byte KiCad project handoff (Python 3.14+)."""
import argparse
import hashlib
import json
import lzma
import ntpath
import os
import re
import secrets
import stat
import struct
import sys
import unicodedata
import zipfile
import zlib
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory, TemporaryFile

CHUNK = 1024 * 1024
MARKER = "kiziro-handoff.json"


class Invalid(ValueError):
    pass


class Conflict(Invalid):
    pass


def component(s):
    if (not s or s in {".", ".."} or s.endswith((" ", ".")) or ntpath.isreserved(s)
            or any(ord(c) < 32 or c in '<>:"/\\|?*' for c in s)
            or s.split(".")[0].rstrip().upper() in DEVICES):
        raise Invalid(f"使用できないパス名: {s!r}")


DEVICES = {"CON", "AUX", "PRN", "NUL", "CONIN$", "CONOUT$"} | {
    p + n for p in ("COM", "LPT") for n in "0123456789¹²³"}


def excluded(part):
    name = part.casefold()
    return name == ".git" or (name.startswith("~") and name.endswith((".kicad_pro.lck", ".kicad_sch.lck", ".kicad_pcb.lck")))


@dataclass
class File:
    digest: bytes
    offset: int
    size: int

    def copy(self, spool, target):
        spool.seek(self.offset)
        remaining = self.size
        while remaining:
            block = spool.read(min(CHUNK, remaining))
            if not block:
                raise OSError("一時ファイルを読み込めません")
            target.write(block)
            remaining -= len(block)


class Tree:
    def __init__(self):
        self.files = {}
        self.dirs = set()
        self.names = {}

    def register(self, name, directory):
        parts = name.split("/")
        for i, part in enumerate(parts, 1):
            component(part)
            path = "/".join(parts[:i])
            key = unicodedata.normalize("NFC", path).casefold()
            entry = (path, i < len(parts) or directory)
            if self.names.setdefault(key, entry) != entry:
                raise Invalid(f"パス衝突: {self.names[key][0]} / {path}")
            if entry[1]:
                self.dirs.add(path)

    def read(self, name, size, stream, spool):
        digest = hashlib.sha256()
        offset = spool.tell()
        while block := stream.read(CHUNK):
            digest.update(block)
            spool.write(block)
        if spool.tell() - offset != size:
            raise Invalid(f"読み込み中にサイズが変化しました: {name}")
        self.files[name] = File(digest.digest(), offset, size)

    def project(self):
        roots = [n for n in self.files if "/" not in n and n.lower().endswith(".kicad_pro")]
        if len(roots) != 1:
            raise Invalid("直下に .kicad_pro が一つ必要です")
        return roots[0]


def inspect_path(path):
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
        raise Invalid(f"リンクは使用できません: {path}")
    return info


def source(path):
    p = Path(path).absolute()
    if ".." in p.parts:
        raise Invalid(f"親参照は使用できません: {p}")
    for item in [*reversed(p.parents), p]:
        inspect_path(item)
    return p


def desktop(root, spool):
    tree = Tree()
    pending = [root]
    while pending:
        for p in pending.pop().iterdir():
            if excluded(p.name):
                continue
            info = inspect_path(p)
            name = p.relative_to(root).as_posix()
            if name.casefold() == MARKER:
                raise Invalid(f"引き渡し用の予約名が使用されています: {name}")
            directory = stat.S_ISDIR(info.st_mode)
            tree.register(name, directory)
            if directory:
                pending.append(p)
            elif stat.S_ISREG(info.st_mode):
                with p.open("rb") as stream:
                    tree.read(name, info.st_size, stream, spool)
            else:
                raise Invalid(f"通常ファイルではありません: {name}")
    return tree


def archive(path, spool):
    tree = Tree()
    seen = set()
    wrapper = None
    if not stat.S_ISREG(path.stat().st_mode):
        raise Invalid(f"ZIP の形式を確認してください: {path}")
    with zipfile.ZipFile(path) as z:
        for item in z.infolist():
            raw = item.orig_filename
            directory = raw.endswith("/")
            parts = raw.removesuffix("/").split("/")
            for s in parts:
                component(s)
            kind = stat.S_IFMT(item.external_attr >> 16)
            if (raw in seen or item.external_attr & 0x400
                    or kind not in (0, stat.S_IFDIR if directory else stat.S_IFREG)
                    or (not directory and item.external_attr & 0x10)
                    or (directory and item.file_size)):
                raise Invalid(f"重複または不正な ZIP 項目: {raw!r}")
            seen.add(raw)
            if wrapper is None:
                wrapper = parts[0]
            if wrapper != parts[0] or (len(parts) == 1 and not directory):
                raise Invalid(f"ZIP の最上位フォルダーが不正です: {raw!r}")
            if len(parts) > 1:
                if any(excluded(part) for part in parts[1:]):
                    continue
                name = "/".join(parts[1:])
                tree.register(name, directory)
                if not directory:
                    with z.open(item) as stream:
                        tree.read(name, item.file_size, stream, spool)
    return tree


def publish(staged, target):
    # Windows rename is atomic and fails even for an existing empty directory.
    if os.name == "nt":
        staged.rename(target)
    elif staged.is_file():
        os.link(staged, target)
    elif sys.platform.startswith("linux"):
        import ctypes
        libc = ctypes.CDLL(None, use_errno=True)
        rename = getattr(libc, "renameat2", None)
        if rename is None:
            raise Invalid("この環境では安全に出力できません")
        if rename(-100, os.fsencode(staged), -100, os.fsencode(target), 1):
            err = ctypes.get_errno()
            raise OSError(err, os.strerror(err), str(target))
    else:
        raise Invalid("この環境では安全に出力できません")


def destination(root, output, suffix):
    if not root.name or not root.is_dir():
        raise Invalid("専用のプロジェクトフォルダーを選んでください")
    target = Path(output).absolute() if output else root.with_name(root.name + suffix)
    component(target.name)
    if target.parent != root.parent:
        raise Invalid("出力先はプロジェクトと同じ親フォルダーにしてください")
    if output is not None and os.path.lexists(target):
        raise FileExistsError(f"出力先は既に存在します: {target}")
    return target


def publish_output(stage, target, output):
    candidate = target
    number = 1
    while True:
        try:
            publish(stage, candidate)
            return candidate
        except FileExistsError:
            if output is not None:
                raise
            number += 1
            candidate = (target.with_stem(f"{target.stem}-{number}") if stage.is_file()
                         else target.with_name(f"{target.name}-{number}"))


def snapshot(folder, output=None):
    root = source(folder)
    target = destination(root, output, "-baseline.zip")
    with TemporaryDirectory(prefix=".kiziro-work-", dir=root.parent) as tmp, TemporaryFile(dir=tmp) as spool:
        tree = desktop(root, spool)
        wrapper = Path(tree.project()).stem
        component(wrapper)
        stage = Path(tmp) / "snapshot"
        with zipfile.ZipFile(stage, "x", zipfile.ZIP_DEFLATED) as z:
            z.writestr(f"{wrapper}/{MARKER}", json.dumps({"snapshot_id": secrets.token_hex(16)}))
            for name in sorted(tree.dirs):
                z.mkdir(f"{wrapper}/{name}/")
            for name, data in sorted(tree.files.items()):
                entry = zipfile.ZipInfo(f"{wrapper}/{name}")
                entry.file_size = data.size
                entry.compress_type = zipfile.ZIP_DEFLATED
                with z.open(entry, "w") as dest:
                    data.copy(spool, dest)
        return publish_output(stage, target, output)


def snapshot_id(tree, spool, label):
    data = tree.files.pop(MARKER, None)
    if data is None:
        raise Invalid(f"{label}: {MARKER} がありません")
    if data.size <= 256:
        spool.seek(data.offset)
        try:
            obj = json.loads(spool.read(data.size).decode("utf-8"))
            if (isinstance(obj, dict) and isinstance(obj.get("snapshot_id"), str)
                    and re.fullmatch("[0-9a-f]{32}", obj["snapshot_id"])):
                return obj["snapshot_id"]
        except ValueError:
            pass
    raise Invalid(f"{label}: {MARKER} が不正です")


# Read only the schematic header. Consume complete quoted strings so nested UUIDs
# and text resembling an S-expression cannot identify the root.
SCH_TOKEN = re.compile(rb'\s+|[()]|"(?:[^"\\]|\\.)*"|[^\s()"]+', re.S)
SCH_UUID = re.compile(rb'\(uuid\s+"?([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})"?\s*\)', re.I)


def root_uuid(tree, spool):
    data = tree.files.get(Path(tree.project()).with_suffix(".kicad_sch").name)
    if not data:
        return
    spool.seek(data.offset)
    header = spool.read(min(data.size, 65536))
    start = re.match(rb'\s*\(kicad_sch\b', header)
    if not start:
        return
    pos, depth = start.end(), 1
    while depth and (token := SCH_TOKEN.match(header, pos)):
        pos = token.end()
        if token[0] == b"(":
            if depth == 1 and (uid := SCH_UUID.match(header, token.start())):
                return uid[1].lower()
            depth += 1
        elif token[0] == b")":
            depth -= 1


def reconcile(baseline, folder, web, output=None):
    root = source(folder)
    target = destination(root, output, "-candidate")
    archives = [source(p) for p in (baseline, web)]
    if any(p.is_relative_to(root) for p in archives):
        raise Invalid("ZIP はプロジェクトの外に置いてください")
    with TemporaryDirectory(prefix=".kiziro-work-", dir=root.parent) as tmp, TemporaryFile(dir=tmp) as spool:
        base, local, remote = archive(archives[0], spool), desktop(root, spool), archive(archives[1], spool)
        if not base.project() == local.project() == remote.project():
            raise Invalid("直下の .kicad_pro の名前が一致しません")
        if snapshot_id(base, spool, "基準 ZIP") != snapshot_id(remote, spool, "Web ZIP"):
            raise Invalid(f"{MARKER}: 基準 ZIP と Web ZIP のスナップショット ID が一致しません")
        base_uuid, local_uuid = root_uuid(base, spool), root_uuid(local, spool)
        if base_uuid and local_uuid and base_uuid != local_uuid:
            raise Invalid("基準 ZIP とデスクトップのルート回路図 UUID が一致しません")
        spellings = {}
        for tree in (base, local, remote):
            for key, (path, _) in tree.names.items():
                if spellings.setdefault(key, path) != path:
                    raise Invalid(f"パス衝突: {spellings[key]} / {path}")
        result = local.files.copy()
        conflicts = []
        for name, data in remote.files.items():
            old, current = base.files.get(name), local.files.get(name)
            old_hash = old.digest if old else None
            current_hash = current.digest if current else None
            if data.digest in (old_hash, current_hash):
                continue
            if current_hash != old_hash:
                conflicts.append(name)
            else:
                result[name] = data
        if conflicts:
            raise Conflict("競合:\n" + "\n".join(sorted(conflicts)))
        layout = Tree()
        for name in local.dirs:
            layout.register(name, True)
        for name in result:
            layout.register(name, False)
        stage = Path(tmp) / "incomplete"
        stage.mkdir()
        for name in sorted(layout.dirs):
            (stage / name).mkdir()
        for name, data in result.items():
            with (stage / name).open("xb") as f:
                data.copy(spool, f)
        return publish_output(stage, target, output)


def dialogs():
    import tkinter as tk
    from tkinter import filedialog as fd, messagebox as mb
    root = tk.Tk()
    root.title("KiCad 引き渡し")
    choice = tk.StringVar()
    for label in ("基準 ZIP を作成", "変更を照合"):
        tk.Button(root, text=label, command=lambda value=label: choice.set(value)).pack(
            fill="x", padx=12, pady=6)
    root.protocol("WM_DELETE_WINDOW", lambda: choice.set(""))
    try:
        root.wait_variable(choice)
        if not choice.get():
            return
        root.withdraw()
        folder = fd.askdirectory(title="デスクトップのプロジェクトフォルダーを選択", mustexist=True)
        if not folder:
            return
        if choice.get() == "基準 ZIP を作成":
            out = snapshot(folder)
        else:
            args = []
            for title in ("取り込みに使った基準 ZIP", "Web の Archive Project ZIP"):
                p = fd.askopenfilename(title=title, filetypes=[("ZIP ファイル", "*.zip")])
                if not p:
                    return
                args.append(p)
            out = reconcile(args[0], folder, args[1])
        mb.showinfo("完了", f"作成しました：\n{out}")
    except ERRORS as e:
        mb.showerror("作成できませんでした", str(e))
        return 1
    finally:
        root.destroy()


ERRORS = (ValueError, OSError, zipfile.BadZipFile, RuntimeError, EOFError, zlib.error, lzma.LZMAError, struct.error, OverflowError)


def main():
    if len(sys.argv) == 1:
        return dialogs()
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest="cmd", required=True)
    for cmd, args in [("snapshot", ("folder",)), ("reconcile", ("baseline", "folder", "web"))]:
        sub = subs.add_parser(cmd)
        for arg in args:
            sub.add_argument(arg)
        sub.add_argument("-o", "--output", help="new sibling output path")
    args = vars(parser.parse_args())
    fn = snapshot if args.pop("cmd") == "snapshot" else reconcile
    try:
        print(fn(**args))
    except ERRORS as e:
        print(str(e), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
