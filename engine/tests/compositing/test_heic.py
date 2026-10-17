"""HEIC stills open through pi-heif (the packaged app's decoder) or pillow-heif.

pi-heif is decode-only, so the sample is encoded by pillow-heif in a separate process (keeping it out
of this one, so the decode below goes through whatever open_image picks). No encoder -> skip.
"""
import importlib.util
import subprocess
import sys

import pytest

from reelengine.compose_util import open_image

needs_decoder = pytest.mark.skipif(
    importlib.util.find_spec("pi_heif") is None and importlib.util.find_spec("pillow_heif") is None,
    reason="neither pi-heif nor pillow-heif installed")

ENCODE = """
import sys
from PIL import Image
import pillow_heif
img = Image.new("RGB", (64, 48), (200, 30, 40))
pillow_heif.from_pillow(img).save(sys.argv[1], quality=90)
"""


def _make_heic(path):
    if importlib.util.find_spec("pillow_heif") is None:
        pytest.skip("no HEIC encoder (pillow-heif) to generate a sample; pi-heif only decodes")
    subprocess.run([sys.executable, "-c", ENCODE, str(path)], check=True)


@needs_decoder
def test_heic_opens(tmp_path):
    p = tmp_path / "photo.heic"
    _make_heic(p)
    im = open_image(p)
    assert im.mode == "RGBA" and im.size == (64, 48)
    r, g, b, a = im.getpixel((32, 24))
    assert abs(r - 200) < 20 and g < 60 and b < 70 and a == 255
    if importlib.util.find_spec("pi_heif") is not None:
        assert "pi_heif" in sys.modules and "pillow_heif" not in sys.modules
