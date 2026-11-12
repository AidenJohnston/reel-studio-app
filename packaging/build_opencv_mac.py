#!/usr/bin/env python3
"""Build opencv-python-headless for the macOS arm64 bundle from its pinned source, with FFmpeg off.

    python3 packaging/build_opencv_mac.py               # build, or reuse the cached build; prints the wheel's path
    python3 packaging/build_opencv_mac.py --check WHEEL # only run the content check on a wheel

fetch_runtime.py calls this on mac-arm64 and installs the result instead of PyPI's wheel. Needs a Mac (arm64) with
the Xcode command line tools. A first build takes tens of minutes; later runs reuse packaging/cache/opencv/.

Why: every macOS arm64 wheel PyPI has from 4.9.0.80 to 5.0.0.93 bundles FFmpeg with GPL x264 and x265 (and, in
5.0.0.93, the GPL librubberband, libvidstab and libpostproc), which fetch_runtime.py refuses in the Python runtime.
The engine does no media I/O through OpenCV: ffmpeg decodes frames and Pillow reads images
(engine/tests/test_no_cv2_media_io.py keeps it that way). So OpenCV built with -DWITH_FFMPEG=OFF loses nothing the
engine calls. Windows keeps PyPI's wheel: it has no x264/x265.

How the result is trusted (a self-built wheel has no reproducible hash to pin):
  * the source is opencv-python's sdist on PyPI, pinned by its SHA-256;
  * the build tools come from requirements-opencv-build.hashed.txt (--require-hashes) into a venv made from the same
    pinned python-build-standalone CPython 3.11 the bundle ships;
  * the build cannot see Homebrew or MacPorts (CMAKE_IGNORE_PREFIX_PATH, an empty PKG_CONFIG_LIBDIR, no
    CFLAGS/LDFLAGS from the caller), so every third-party library comes from OpenCV's own source tree;
  * check_wheel() refuses any wheel that bundles a library, contains an FFmpeg/x264/x265 file, has another version,
    has files outside cv2/ and its dist-info, carries native code other than cv2.abi3.so, or whose extension links
    anything outside /usr/lib and /System.
The cache key covers every input above and this file itself; changing one rebuilds.

Stdlib only (runs under the macOS system python3, like fetch_runtime.py).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import zipfile
from pathlib import Path

import fetch_runtime as fr

HERE = Path(__file__).resolve().parent
OUT_ROOT = fr.CACHE / "opencv"
BUILD_REQUIREMENTS = HERE / "requirements-opencv-build.hashed.txt"

PACKAGE = "opencv-python-headless"
VERSION = "5.0.0.93"  # must equal engine/requirements.txt; pin_matches_engine() stops the build otherwise
SDIST = {
    "url": "https://files.pythonhosted.org/packages/source/o/opencv-python-headless/opencv_python_headless-%s.tar.gz" % VERSION,
    "sha256": "b82f9831daab90b725c7c1ee1b36cb5732c367096ac76d119e64e14eb70d5f3c",  # PyPI's published digest
    "file": "opencv_python_headless-%s.tar.gz" % VERSION,
}
# opencv-python's own macOS arm64 release job (build_wheels_macos_m1.yml at tag 93) builds with CI_BUILD=1,
# ENABLE_HEADLESS=1, MACOSX_DEPLOYMENT_TARGET=13.0 and `setup.py bdist_wheel --py-limited-api=cp37`. We do the same
# and add only the CMake arguments below.
DEPLOYMENT_TARGET = "13.0"  # theirs; at or below the app's minimumSystemVersion (14.0, electron-builder.yml)
CMAKE_ARGS = [
    "-DWITH_FFMPEG=OFF",      # the point of this build
    "-DWITH_GSTREAMER=OFF",   # the other video back end that would pull in outside libraries
    # Third-party libraries from OpenCV's source tree, never from the build machine: Homebrew bottles target the
    # machine's own macOS version and would break the app on older ones.
    "-DCMAKE_IGNORE_PREFIX_PATH=/opt/homebrew;/usr/local;/opt/local",
    "-DBUILD_ZLIB=ON", "-DBUILD_PNG=ON", "-DBUILD_JPEG=ON", "-DBUILD_TIFF=ON", "-DBUILD_WEBP=ON",
    "-DBUILD_OPENJPEG=ON", "-DBUILD_PROTOBUF=ON",
    # PyPI's wheel gets AVIF and JPEG XL from Homebrew; OpenCV has no bundled copy, so they are off here
    # (the engine reads images with Pillow).
    "-DWITH_AVIF=OFF", "-DWITH_JPEGXL=OFF",
    "-DCMAKE_OSX_ARCHITECTURES=arm64",
    "-DCMAKE_OSX_DEPLOYMENT_TARGET=" + DEPLOYMENT_TARGET,
]
WHEEL_NAME = re.compile(r"^opencv_python_headless-(?P<ver>[^-]+)-cp37-abi3-macosx_(?P<maj>\d+)_(?P<min>\d+)_arm64\.whl$")
# FFmpeg's libraries and the GPL codecs, under any name a wheel could carry them
MEDIA_LIB = re.compile(r"^(lib)?(av(codec|format|util|filter|device)|sw(scale|resample)|postproc|x26[45]|"
                       r"opencv_videoio_ffmpeg)", re.IGNORECASE)
SYSTEM_LIB = ("/usr/lib/", "/System/Library/")
# Mach-O (32/64-bit, either byte order) and fat binaries
MACHO_MAGIC = {bytes.fromhex(h) for h in ("feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca")}


def log(msg: str) -> None:
    print("[build_opencv_mac] " + msg, flush=True)


def pin_matches_engine() -> None:
    req = (fr.REPO / "engine" / "requirements.txt").read_text(encoding="utf-8")
    m = re.search(r"^opencv-python-headless==(\S+)", req, re.M)
    if not m or m.group(1) != VERSION:
        raise SystemExit("engine/requirements.txt pins opencv-python-headless==%s but build_opencv_mac.py builds %s.\n"
                         "Update VERSION and SDIST (sha256 from PyPI) in build_opencv_mac.py to the same version."
                         % (m.group(1) if m else "?", VERSION))


def cache_key() -> str:
    python = fr.PLATFORMS["mac-arm64"]["python"]
    # this file itself stands for the recipe: any edit to how the wheel is built or checked rebuilds it
    inputs = {"sdist": SDIST["sha256"], "cmake_args": CMAKE_ARGS, "deployment_target": DEPLOYMENT_TARGET,
              "build_requirements": fr.sha256_of(BUILD_REQUIREMENTS), "python": python["sha256"],
              "recipe": fr.sha256_of(Path(__file__))}
    return hashlib.sha256(json.dumps(inputs, sort_keys=True).encode()).hexdigest()


def check_wheel(wheel: Path) -> dict:
    """Refuse a wheel that is not exactly what this recipe must produce. Returns facts for the manifest."""
    m = WHEEL_NAME.match(wheel.name)
    if not m or m.group("ver") != VERSION:
        raise SystemExit("unexpected OpenCV wheel %s: expected opencv_python_headless-%s-cp37-abi3-macosx_*_arm64.whl"
                         % (wheel.name, VERSION))
    if (int(m.group("maj")), int(m.group("min"))) > (14, 0):
        raise SystemExit("%s needs a newer macOS than the app's minimum (14.0)" % wheel.name)
    with zipfile.ZipFile(str(wheel)) as z:
        names = z.namelist()
        # nothing outside the package: a root-level .pth or sitecustomize.py would run at every interpreter start
        stray = sorted(n for n in names if not n.startswith(("cv2/", "opencv_python_headless-%s.dist-info/" % VERSION)))
        if stray:
            raise SystemExit("%s has files outside cv2/ and its dist-info: %s" % (wheel.name, ", ".join(stray)))
        media = sorted(n for n in names if MEDIA_LIB.match(n.rsplit("/", 1)[-1]))
        if media:
            raise SystemExit("%s contains FFmpeg/x264/x265 files: %s" % (wheel.name, ", ".join(media)))
        bundled = sorted(n for n in names if ".dylibs" in n.split("/"))
        if bundled:
            raise SystemExit("%s bundles libraries (a build-machine library leaked in): %s" % (wheel.name, ", ".join(bundled)))
        # the extension is the only native code the wheel may carry, whatever a file is called
        native = sorted(n for n in names if not n.endswith("/") and z.open(n).read(4) in MACHO_MAGIC)
        if native != ["cv2/cv2.abi3.so"]:
            raise SystemExit("%s: expected cv2/cv2.abi3.so as its only native file, found %s" % (wheel.name, native))
        for need in ("cv2/cv2.abi3.so", "cv2/data/__init__.py"):  # PyPI's 5.0.0.93 wheels carry no cascade XML either
            if need not in names:
                raise SystemExit("%s is missing %s" % (wheel.name, need))
        with tempfile.TemporaryDirectory() as tmp:
            so = Path(z.extract("cv2/cv2.abi3.so", tmp))
            links = otool_links(so)
    outside = [l for l in links if not l.startswith(SYSTEM_LIB)]
    if outside:
        raise SystemExit("cv2.abi3.so in %s links libraries outside the system: %s" % (wheel.name, ", ".join(outside)))
    return {"file": wheel.name, "sha256": fr.sha256_of(wheel), "size_mb": round(wheel.stat().st_size / 1e6, 1),
            "links": links}


def otool_links(binary: Path) -> list:
    out = subprocess.run(["otool", "-L", str(binary)], check=True, stdout=subprocess.PIPE, universal_newlines=True).stdout
    # first line is the file itself; each following line is "\t<path> (compatibility version ...)"
    return [line.strip().split(" (", 1)[0] for line in out.splitlines()[1:] if line.strip()]


def build_python() -> Path:
    """The pinned python-build-standalone CPython 3.11, extracted for building only (not the bundle's copy). The
    folder is named by the archive's SHA-256, so a changed pin never builds with an older interpreter."""
    root = OUT_ROOT / ("python-" + fr.PLATFORMS["mac-arm64"]["python"]["sha256"][:16])
    py = root / "python" / "bin" / "python3"
    if not py.exists():
        fr.rmtree(root)
        root.mkdir(parents=True)
        fr.extract_tar(fr.download(fr.PLATFORMS["mac-arm64"]["python"]), root)
    return py


def clean_env(extra: dict) -> dict:
    keep = ("PATH", "HOME", "TMPDIR", "USER", "LANG", "LC_ALL", "DEVELOPER_DIR", "SDKROOT")
    env = {k: v for k, v in os.environ.items() if k in keep}
    env["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"  # Xcode's clang, never a Homebrew compiler or pkg-config
    env.update(extra)
    return env


def build(out: Path) -> Path:
    t0 = time.time()
    work = OUT_ROOT / "work"
    fr.rmtree(work)
    work.mkdir(parents=True)
    venv = work / "venv"
    subprocess.run([str(build_python()), "-I", "-m", "venv", str(venv)], check=True)
    vpy = venv / "bin" / "python"
    pip_env = clean_env({"PIP_DISABLE_PIP_VERSION_CHECK": "1", "PIP_NO_INPUT": "1", "PYTHONNOUSERSITE": "1"})
    subprocess.run([str(vpy), "-I", "-m", "pip", "install", "--no-cache-dir", "--only-binary", ":all:", "--require-hashes",
                    "--no-deps", "-r", str(BUILD_REQUIREMENTS)], check=True, env=pip_env)
    log("extract %s" % SDIST["file"])
    with tarfile.open(str(fr.download(SDIST)), "r:gz") as tf:
        try:
            tf.extractall(str(work), filter="data")  # py3.12+
        except TypeError:
            tf.extractall(str(work))
    src = work / ("opencv_python_headless-%s" % VERSION)
    empty = work / "no-pkgconfig"
    empty.mkdir()
    jobs = str(os.cpu_count() or 4)
    env = clean_env({
        "CI_BUILD": "1", "ENABLE_HEADLESS": "1", "ENABLE_CONTRIB": "0", "ENABLE_JAVA": "0", "ENABLE_ROLLING": "0",
        "MACOSX_DEPLOYMENT_TARGET": DEPLOYMENT_TARGET, "CMAKE_ARGS": " ".join(CMAKE_ARGS),
        "CMAKE_BUILD_PARALLEL_LEVEL": jobs, "MAKEFLAGS": "-j" + jobs,
        "PKG_CONFIG_LIBDIR": str(empty), "PKG_CONFIG_PATH": str(empty),
        "PYTHONNOUSERSITE": "1", "OPENCV_PYTHON_SKIP_GIT_COMMANDS": "1",
    })
    env["PATH"] = str(venv / "bin") + ":" + env["PATH"]  # the pinned cmake
    dist = work / "dist"
    log("build (CMAKE_ARGS=%s), %s jobs" % (env["CMAKE_ARGS"], jobs))
    subprocess.run([str(vpy), "setup.py", "bdist_wheel", "--py-limited-api=cp37", "--dist-dir", str(dist)],
                   cwd=str(src), env=env, check=True)
    wheels = list(dist.glob("*.whl"))
    if len(wheels) != 1:
        raise SystemExit("expected one wheel in %s, found %s" % (dist, [w.name for w in wheels]))
    facts = check_wheel(wheels[0])
    fr.rmtree(out)
    out.mkdir(parents=True)
    wheel = out / wheels[0].name
    shutil.move(str(wheels[0]), str(wheel))
    record = {"key": cache_key(), "sdist": SDIST, "cmake_args": CMAKE_ARGS, "deployment_target": DEPLOYMENT_TARGET,
              "build_seconds": round(time.time() - t0), "built": time.strftime("%Y-%m-%dT%H:%M:%S"), "wheel": facts}
    (out / "build.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
    fr.rmtree(work)
    log("built %s (%.1f MB) in %d min" % (wheel.name, facts["size_mb"], record["build_seconds"] // 60))
    return wheel


def ensure_wheel() -> tuple:
    """-> (wheel path, build record). Reuses packaging/cache/opencv/<key> when its record and content still check out."""
    if sys.platform != "darwin":
        raise SystemExit("build_opencv_mac.py builds on macOS only")
    pin_matches_engine()
    key = cache_key()
    out = OUT_ROOT / key[:16]
    record_path = out / "build.json"
    if record_path.exists():
        record = json.loads(record_path.read_text(encoding="utf-8"))
        name = record["wheel"]["file"]
        if not WHEEL_NAME.match(name) or Path(name).name != name:
            raise SystemExit("%s names an unexpected wheel %r" % (record_path, name))
        wheel = out / name
        if record.get("key") == key and wheel.exists() and fr.sha256_of(wheel) == record["wheel"]["sha256"]:
            check_wheel(wheel)
            log("cached  %s" % wheel.name)
            return wheel, record
        log("cached build in %s does not match its record; rebuilding" % out)
    wheel = build(out)
    return wheel, json.loads(record_path.read_text(encoding="utf-8"))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", metavar="WHEEL", help="only run the content check on this wheel")
    args = ap.parse_args()
    if args.check:
        print(json.dumps(check_wheel(Path(args.check)), indent=2))
        return
    wheel, _record = ensure_wheel()
    print(wheel)


if __name__ == "__main__":
    main()
