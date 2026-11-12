"""The engine never reads or writes media files through OpenCV.

The macOS installer ships an OpenCV built without FFmpeg (packaging/build_opencv_mac.py): PyPI's macOS wheels bundle
GPL x264/x265. That build has no video decoding, and its image codecs differ from PyPI's (no AVIF, no JPEG XL). The
engine does not need either: ffmpeg decodes frames (compose_util.py) and Pillow reads images. This test keeps it
that way, so a cv2.VideoCapture added on Windows cannot quietly break the Mac app.
"""
import ast
from pathlib import Path

import pytest

ENGINE = Path(__file__).resolve().parents[1] / "reelengine"

FORBIDDEN = {
    # video I/O
    "VideoCapture", "VideoWriter", "VideoWriter_fourcc", "videoio_registry",
    # image file I/O
    "imread", "imreadmulti", "imreadanimation", "imdecode", "imdecodemulti", "imdecodeanimation",
    "imwrite", "imwritemulti", "imwriteanimation", "imencode", "imencodemulti", "imencodeanimation",
    "haveImageReader", "haveImageWriter", "imcount",
}
FORBIDDEN_PREFIXES = ("CAP_", "VIDEOWRITER_", "VIDEO_ACCELERATION_", "IMREAD_", "IMWRITE_")


def _forbidden(name: str) -> bool:
    return name in FORBIDDEN or name.startswith(FORBIDDEN_PREFIXES)


def _last_name(node) -> str:
    """`cv2` for `cv2`, `cv2` for `self.cv2`; '' for anything else."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return ""


def media_io_uses(source: str) -> list:
    """Lines where `source` reaches OpenCV media I/O, through `cv2`, an alias of it, or an attribute holding it."""
    tree = ast.parse(source)
    aliases = {"cv2"}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            aliases.update(a.asname for a in node.names if a.name == "cv2" and a.asname)
        elif isinstance(node, ast.Assign) and _last_name(node.value) in aliases:
            aliases.update(_last_name(t) for t in node.targets if _last_name(t))
    found = []
    for node in ast.walk(tree):
        hit = None
        if isinstance(node, ast.Attribute) and _forbidden(node.attr) and _last_name(node.value) in aliases:
            hit = node.attr
        elif isinstance(node, ast.ImportFrom) and (node.module or "").split(".")[0] == "cv2":
            hit = next((a.name for a in node.names if _forbidden(a.name) or a.name == "*"), None) or (
                node.module if _forbidden(node.module.split(".")[-1]) else None)
        elif isinstance(node, ast.Import):
            hit = next((a.name for a in node.names if a.name.startswith("cv2.") and _forbidden(a.name.split(".")[-1])), None)
        elif (isinstance(node, ast.Call) and _last_name(node.func) == "getattr" and len(node.args) >= 2
              and _last_name(node.args[0]) in aliases and isinstance(node.args[1], ast.Constant)
              and isinstance(node.args[1].value, str) and _forbidden(node.args[1].value)):
            hit = node.args[1].value
        if hit:
            found.append((node.lineno, hit))
    return found


@pytest.mark.parametrize("source", [
    "import cv2\ncap = cv2.VideoCapture('a.mp4')",
    "import cv2 as cv\ncv.imwrite('a.png', img)",
    "class D:\n    def __init__(self):\n        import cv2\n        self.cv2 = cv2\n    def f(self):\n        return self.cv2.imdecode(b, 1)",
    "from cv2 import VideoWriter",
    "from cv2 import *",
    "from cv2.videoio_registry import getBackends",
    "import cv2.videoio_registry",
    "import cv2\nn = cap.get(cv2.CAP_PROP_FRAME_COUNT)",
    "import cv2\nf = getattr(cv2, 'VideoCapture')",
])
def test_scanner_finds_media_io(source):
    assert media_io_uses(source)


@pytest.mark.parametrize("source", [
    '"""Frames come from ffmpeg (unlike cv2.VideoCapture on Windows)."""',
    "import cv2\ng = cv2.cvtColor(a, cv2.COLOR_BGR2GRAY)\nd = cv2.FaceDetectorYN.create(m, '', (w, h))",
    "from PIL import Image\nim = Image.open(p)\nimport imageio\nimageio.imread(p)",
])
def test_scanner_passes_computation_only(source):
    assert media_io_uses(source) == []


def test_engine_does_no_media_io_through_opencv():
    files = sorted(ENGINE.rglob("*.py"))
    uses_cv2 = [f.name for f in files if "cv2" in f.read_text(encoding="utf-8")]
    assert {"cover.py", "placement.py"} <= set(uses_cv2), "the scan no longer sees the engine's OpenCV code"
    found = [f"{f.relative_to(ENGINE.parent).as_posix()}:{line} {name}"
             for f in files for line, name in media_io_uses(f.read_text(encoding="utf-8"))]
    assert not found, (
        "The engine reaches OpenCV media I/O:\n  " + "\n  ".join(found) + "\n"
        "The macOS app's OpenCV is built without FFmpeg (packaging/build_opencv_mac.py) and with fewer image codecs. "
        "Decode frames with ffmpeg (compose_util.py) and read images with Pillow instead.")
