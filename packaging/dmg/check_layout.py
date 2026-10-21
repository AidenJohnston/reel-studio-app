#!/usr/bin/env python3
"""Read a disk image's Finder layout back from its .DS_Store and fail unless it is the designed install window.

    python3 packaging/dmg/check_layout.py PATH.dmg      # mounts it read-only and hidden, checks, detaches
    python3 packaging/dmg/check_layout.py /Volumes/X    # an already mounted volume

Finder writes the layout (window size, toolbar, icon size, background picture, icon positions) only into the
volume's .DS_Store, so this reads that file directly. Format: https://metacpan.org/dist/Mac-Finder-DSStore/view/DSStoreFormat.pod
(a "buddy allocator" file holding one B-tree of records: file name, 4-letter code, typed value).
"""
import plistlib
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

# The layout make-dmg.sh asks Finder for, and electron-builder.yml's `dmg` section repeats.
WINDOW = (640, 432)
ICON_SIZE = 120
TEXT_SIZE = 12
APP_AT = (166, 214)
APPLICATIONS_AT = (474, 214)
BACKGROUND = ".background/background.tiff"


class LayoutError(Exception):
    pass


def read_records(data: bytes) -> dict:
    """{(file name, code): value} for every record in a .DS_Store."""
    if data[:8] != b"\x00\x00\x00\x01Bud1":
        raise LayoutError(".DS_Store does not start with the Bud1 header")
    body = data[4:]  # every offset in the file counts from byte 4
    root_off, root_size = struct.unpack_from(">II", body, 4)
    count, _ = struct.unpack_from(">II", body, root_off)
    addrs = struct.unpack_from(f">{count}I", body, root_off + 8)
    pos = root_off + 8 + 4 * ((count + 255) // 256 * 256)
    (ndirs,) = struct.unpack_from(">I", body, pos)
    pos += 4
    dirs = {}
    for _ in range(ndirs):
        n = body[pos]
        name = body[pos + 1:pos + 1 + n].decode("ascii")
        (dirs[name],) = struct.unpack_from(">I", body, pos + 1 + n)
        pos += 1 + n + 4
    if "DSDB" not in dirs:
        raise LayoutError(".DS_Store has no DSDB directory")

    def block(i: int) -> int:
        return addrs[i] & ~0x1F

    root_node, _levels, nrecords, _nodes, _page = struct.unpack_from(">5I", body, block(dirs["DSDB"]))
    records = {}

    def record(p: int) -> int:
        (n,) = struct.unpack_from(">I", body, p)
        name = body[p + 4:p + 4 + 2 * n].decode("utf-16-be")
        p += 4 + 2 * n
        code, kind = body[p:p + 4].decode("ascii"), body[p + 4:p + 8].decode("ascii")
        p += 8
        if kind == "bool":
            value, p = bool(body[p]), p + 1
        elif kind in ("long", "shor", "type"):
            value, p = body[p:p + 4], p + 4
        elif kind in ("comp", "dutc"):
            value, p = body[p:p + 8], p + 8
        elif kind == "blob":
            (ln,) = struct.unpack_from(">I", body, p)
            value, p = body[p + 4:p + 4 + ln], p + 4 + ln
        elif kind == "ustr":
            (ln,) = struct.unpack_from(">I", body, p)
            value, p = body[p + 4:p + 4 + 2 * ln].decode("utf-16-be"), p + 4 + 2 * ln
        else:
            raise LayoutError(f".DS_Store record {name!r} {code!r} has unknown type {kind!r}")
        records[(name, code)] = value
        return p

    def node(i: int) -> None:
        p = block(i)
        right, n = struct.unpack_from(">II", body, p)
        p += 8
        for _ in range(n):
            if right:  # internal node: each record follows the child holding the smaller keys
                (child,) = struct.unpack_from(">I", body, p)
                node(child)
                p += 4
            p = record(p)
        if right:
            node(right)

    node(root_node)
    if len(records) != nrecords:
        raise LayoutError(f".DS_Store says {nrecords} records but {len(records)} were read")
    return records


def check_volume(vol: Path) -> list[str]:
    """Every way the volume differs from the designed window (empty when it matches)."""
    ds = vol / ".DS_Store"
    if not ds.is_file():
        return [f"{ds} is missing: Finder never saved a layout"]
    rec = read_records(ds.read_bytes())
    apps = sorted(p.name for p in vol.glob("*.app"))
    if len(apps) != 1:
        return [f"expected exactly one .app on the volume, found {apps}"]
    problems = []

    def plist(code: str) -> dict:
        if (".", code) not in rec:
            problems.append(f".DS_Store has no {code!r} record for the window")
            return {}
        return plistlib.loads(rec[(".", code)])

    bwsp = plist("bwsp")
    if bwsp:
        bounds = bwsp.get("WindowBounds", "")
        size = tuple(int(float(v)) for v in bounds.replace("{", "").replace("}", "").split(",")[2:])
        if size != WINDOW:
            problems.append(f"window is {size}, expected {WINDOW} ({bounds!r})")
        if bwsp.get("ShowToolbar", True):
            problems.append("toolbar is showing")
        if bwsp.get("ShowSidebar", True):
            problems.append("sidebar is showing")
    icvp = plist("icvp")
    if icvp:
        if icvp.get("iconSize") != ICON_SIZE:
            problems.append(f"icon size is {icvp.get('iconSize')}, expected {ICON_SIZE}")
        if icvp.get("textSize") != TEXT_SIZE:
            problems.append(f"label size is {icvp.get('textSize')}, expected {TEXT_SIZE}")
        if icvp.get("backgroundType") != 2:
            problems.append(f"background type is {icvp.get('backgroundType')}, expected 2 (a picture)")
        alias = icvp.get("backgroundImageAlias", b"")
        if Path(BACKGROUND).name.encode() not in alias:
            problems.append(f"background picture does not point at {BACKGROUND}")
    bg = vol / BACKGROUND
    if not bg.is_file() or bg.read_bytes()[:4] not in (b"MM\x00*", b"II*\x00"):
        problems.append(f"{BACKGROUND} is missing or not a TIFF")
    for name, want in ((apps[0], APP_AT), ("Applications", APPLICATIONS_AT)):
        loc = rec.get((name, "Iloc"))
        got = struct.unpack_from(">II", loc) if loc else None
        if got != want:
            problems.append(f"{name} is at {got}, expected {want}")
    if not (vol / "Applications").is_symlink() or str((vol / "Applications").readlink()) != "/Applications":
        problems.append("Applications is not a link to /Applications")
    return problems


def check_dmg(dmg: Path) -> list[str]:
    with tempfile.TemporaryDirectory(prefix="rs-dmgcheck-") as mnt:
        subprocess.run(["hdiutil", "attach", "-readonly", "-nobrowse", "-noverify", "-noautoopen",
                        "-mountpoint", mnt, str(dmg)], check=True, stdout=subprocess.DEVNULL)
        try:
            return check_volume(Path(mnt))
        finally:
            subprocess.run(["hdiutil", "detach", mnt, "-quiet"], check=False)


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    target = Path(sys.argv[1])
    try:
        problems = check_dmg(target) if target.is_file() else check_volume(target)
    except (LayoutError, struct.error, plistlib.InvalidFileException, ValueError) as e:
        problems = [f"could not read the layout: {e}"]
    if problems:
        print(f"DMG layout check FAILED for {target}:", *problems, sep="\n  ", file=sys.stderr)
        return 1
    print(f"DMG layout OK: {WINDOW[0]}x{WINDOW[1]} window, icons {ICON_SIZE}, background {BACKGROUND}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
