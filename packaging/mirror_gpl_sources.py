#!/usr/bin/env python3
"""Download the corresponding source of the GPL/LGPL programs and libraries we ship, into release/gpl-sources/.

    python packaging/mirror_gpl_sources.py            # download + verify everything
    python packaging/mirror_gpl_sources.py --check    # verify what is already in release/gpl-sources/ (no network)

WHY. The installers contain FFmpeg and FFprobe under the GPL v3 (they link x264). GPL v3 section 6(d) lets us offer
the object code on a network server (the GitHub release) and keep the corresponding source on a server next to it.
This script collects that source so the PERSON PUBLISHING A RELEASE can attach `release/gpl-sources/*` to the same
GitHub release as the installers (see THIRD_PARTY.md, "FFmpeg corresponding source"). Do that for every release, and
keep the files available for as long as that release is downloadable.

The FFmpeg in the installers is OUR build on both platforms: packaging/ffmpeg/build.sh compiles it from the tarballs
pinned in packaging/ffmpeg/sources.txt. This script reads that same file, so the mirror cannot drift from the build:
every source the build compiles is here, byte-for-byte what build.sh verified, plus the recipe itself
(reel-studio-ffmpeg-recipe-*.tar.gz: build.sh, sources.txt, pack.py, the README). Nothing else is linked.

Stdlib only. Every source is verified against the SHA-256 in sources.txt (or below); the script exits non-zero on a
mismatch or a failed download. Items marked pin=False are archives that a host generates on the fly (GitHub tag
archives); their hash is recorded in SHA256SUMS.txt, and a changed hash is a warning to compare by hand, not a failure.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import sys
import tarfile
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "release" / "gpl-sources"
RECIPE_DIR = HERE / "ffmpeg"
UA = "reel-studio-packaging/1.0"
REV = "rs2"

# (file name, url, sha256 or None, pin, what it is)
ITEMS = []
for _line in (RECIPE_DIR / "sources.txt").read_text(encoding="utf-8").splitlines():
    if not _line.strip() or _line.startswith("#"):
        continue
    _name, _file, _sha, _url, _lic, _role = _line.split("\t")
    if _role.startswith("tool"):
        continue  # build tools (GNU autotools, pkgconf, meson) are never linked; they stay pinned in sources.txt
    ITEMS.append((_file, _url, _sha, True, "%s (%s) %s" % (_name, _lic, "Windows build only" if _role == "win" else "both builds")))
ITEMS += [
    ("ffmpeg-7.1.1.tar.xz.asc", "https://ffmpeg.org/releases/ffmpeg-7.1.1.tar.xz.asc", None, True,
     "FFmpeg release signature (verify with the FFmpeg release key, https://ffmpeg.org/ffmpeg-devel.asc)"),
    ("pillow_heif-1.4.0.tar.gz", "https://github.com/bigcat88/pillow_heif/archive/refs/tags/v1.4.0.tar.gz",
     "0fe5b31902295029579e7e178fd64bef906dcb3a7c47519714638c2ff50ea4e4", False,
     "pi-heif 1.4.0 source and the build script (libheif/build_libs.py) of its bundled libraries (LGPL-3.0 obligation)"),
    ("libheif-1.23.0.tar.gz", "https://github.com/strukturag/libheif/releases/download/v1.23.0/libheif-1.23.0.tar.gz",
     "4c9182b18897617182eed12ab5eb9f9d855b3aa3a736d6bdb31abc034ec7d393", True, "libheif 1.23.0 (LGPL-3.0), inside the pi-heif wheels"),
    ("libde265-1.1.0.tar.gz", "https://github.com/strukturag/libde265/releases/download/v1.1.0/libde265-1.1.0.tar.gz",
     "afc19dd28e2fc523de5952bba5224ee1d28e286c72436d2843df126cca1181fd", True, "libde265 1.1.0 (LGPL-3.0), inside the pi-heif wheels"),
]
RECIPE_NAME = "reel-studio-ffmpeg-recipe-%s.tar.gz" % REV

README = """Reel Studio: corresponding source for the GPL programs in the installers
=========================================================================

The Reel Studio installers contain FFmpeg and FFprobe 7.1.1 (GNU GPL version 3), built by the Reel Studio project
(not downloaded from a third party) for Windows x64 and macOS arm64. This folder is the source offer for them
(GPL v3 section 6(d)). SHA256SUMS.txt lists every file here.

What is in it
  ffmpeg-7.1.1.tar.xz (+ .asc)   FFmpeg itself, unmodified release source
  x264-*.tar.gz                  libx264 (GPL-2.0+), the library that makes the binary GPL
  freetype, fribidi, harfbuzz,   the caption renderer (subtitles filter) and its text shaping
  libass
  zimg                           the zscale filter (HDR to SDR)
  zlib                           compression
  nv-codec-headers               Windows only, header files for NVIDIA NVENC (loaded at run time from the driver)
  amf-headers                    Windows only, header files for AMD AMF (the AMD driver is loaded at run time)
  libvpl                         Windows only, Intel oneVPL dispatcher for Quick Sync (finds the Intel runtime at run time)
  reel-studio-ffmpeg-recipe-*    THE BUILD SCRIPTS: build.sh (every configure/compile command), sources.txt (every
                                 version, URL and SHA-256 above), pack.py, README. Nothing else is linked in.

To rebuild the binaries (see README.md inside the recipe archive, or packaging/ffmpeg/README.md in the repository):
  Windows  MSYS2 UCRT64 shell:  bash packaging/ffmpeg/build.sh <workdir>
  macOS    Apple silicon:       bash packaging/ffmpeg/build.sh <workdir>
The exact FFmpeg configure line of each binary is in BUILDINFO.txt inside the FFmpeg zip and is printed by
`ffmpeg -version`. The toolchain is MSYS2's GCC (Windows) and Apple clang (macOS); their versions are in BUILDINFO.txt.

Reel Studio's own source code is MIT licensed and is in the repository. You may replace the bundled FFmpeg with
your own build: Reel Studio finds it through the REELENGINE_FFMPEG / REELENGINE_FFPROBE settings.
"""


def recipe_archive() -> bytes:
    """Deterministic tar.gz of packaging/ffmpeg (sorted, fixed mtime/owner), so equal recipes give an equal hash."""
    buf = io.BytesIO()
    import gzip
    with gzip.GzipFile(fileobj=buf, mode="wb", mtime=0, compresslevel=9) as gz, tarfile.open(fileobj=gz, mode="w") as tf:
        for f in sorted(RECIPE_DIR.iterdir()):
            if not f.is_file():
                continue
            ti = tarfile.TarInfo("reel-studio-ffmpeg-recipe/" + f.name)
            data = f.read_bytes().replace(b"\r\n", b"\n")
            ti.size, ti.mtime, ti.mode, ti.uid, ti.gid, ti.uname, ti.gname = len(data), 0, 0o755 if f.suffix in (".sh", ".py") else 0o644, 0, 0, "", ""
            tf.addfile(ti, io.BytesIO(data))
    return buf.getvalue()


def sha256_of(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch(url: str, dest: Path) -> None:
    part = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r, open(part, "wb") as out:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            out.write(chunk)
    part.replace(dest)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="verify existing files only (no network)")
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    failures, sums = [], []
    if not args.check:
        (OUT / RECIPE_NAME).write_bytes(recipe_archive())
    sums.append("%s  %s" % (sha256_of(OUT / RECIPE_NAME), RECIPE_NAME)) if (OUT / RECIPE_NAME).exists() else failures.append(RECIPE_NAME + ": missing")
    for name, url, want, pin, what in ITEMS:
        dest = OUT / name
        if not args.check and not (dest.exists() and want and sha256_of(dest) == want):
            t0 = time.time()
            try:
                print("download %s" % url, flush=True)
                fetch(url, dest)
            except Exception as e:  # noqa: BLE001 - report every failure, then exit non-zero
                failures.append("%s: download failed (%s)" % (name, e))
                continue
            print("  ok %s (%.1f MB, %.0fs)" % (name, dest.stat().st_size / 1e6, time.time() - t0))
        if not dest.exists():
            failures.append("%s: missing" % name)
            continue
        got = sha256_of(dest)
        sums.append("%s  %s" % (got, name))
        if want and got != want:
            msg = "%s: sha256 %s != pinned %s" % (name, got, want)
            if pin:
                failures.append(msg)
            else:
                print("WARNING (archive generated by its host; compare contents by hand): " + msg, file=sys.stderr)
    if not args.check:
        (OUT / "README.txt").write_text(README, encoding="utf-8", newline="\n")
        (OUT / "SHA256SUMS.txt").write_text("\n".join(sorted(sums, key=lambda l: l.split("  ", 1)[1])) + "\n", encoding="utf-8", newline="\n")
    if failures:
        print("\nFAILED:\n  " + "\n  ".join(failures), file=sys.stderr)
        sys.exit(1)
    print("\n%d files in %s. Attach ALL of them (README.txt, SHA256SUMS.txt included) to the GitHub release." % (sum(1 for _ in OUT.iterdir()), OUT))


if __name__ == "__main__":
    main()
