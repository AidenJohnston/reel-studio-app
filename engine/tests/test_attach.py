"""`attach`: pictures, GIFs and short clips attached to a note (0.1.2 F2).

Every fixture is generated here (Pillow / ffmpeg); no binary fixture is committed."""
import importlib.util
import io
import json
import shutil
import subprocess
from pathlib import Path

import pytest
from PIL import Image

from reelengine import attach, cli, compose_util, proto

FFMPEG = compose_util.ffmpeg_bin()
has_ffmpeg = pytest.mark.skipif(shutil.which(FFMPEG) is None and not Path(FFMPEG).exists(), reason="no ffmpeg")


def run_cli(argv):
    buf = io.StringIO()
    proto.set_stream(buf)
    try:
        code = cli.main(argv)
    finally:
        proto.set_stream(None)
    return code, [json.loads(l) for l in buf.getvalue().splitlines() if l.strip()]


@pytest.fixture
def proj(tmp_path):
    d = tmp_path / "Projects" / "mój film ça"          # spaces + non-ASCII
    d.mkdir(parents=True)
    (d / "project.json").write_text(json.dumps({"schemaVersion": 1, "broll": []}), encoding="utf-8")
    return d


@pytest.fixture
def src(tmp_path):
    d = tmp_path / "from the desktop ünï"
    d.mkdir()
    return d


def _attach(proj, f, name=None):
    argv = ["attach", "--project", str(proj), str(f)] + (["--name", name] if name else [])
    code, lines = run_cli(argv)
    return code, lines[-1]


def _written(proj):
    return sorted(p.relative_to(proj).as_posix() for p in proj.rglob("*") if p.is_file() and p.name != "project.json")


def _check_record(proj, rec, kind):
    assert rec["kind"] == kind
    asset = proj / rec["asset"]
    assert rec["asset"].startswith("work/assets/attach-") and asset.is_file()
    assert rec["bytes"] == asset.stat().st_size
    thumb = proj / rec["thumb"]
    assert rec["thumb"].startswith("work/thumbs/") and thumb.is_file()
    with Image.open(thumb) as t:
        assert t.format == "JPEG" and max(t.size) <= 320
    side = json.loads((asset.parent / (asset.name + ".attach.json")).read_text(encoding="utf-8"))
    assert side == rec
    assert attach.read_sidecar(proj, rec["asset"]) == rec
    assert rec["createdAt"].endswith("Z")
    return asset


def test_png_copied_with_sidecar_and_thumb(proj, src):
    f = src / "my meme ça.png"
    Image.new("RGBA", (640, 480), (200, 10, 10, 255)).save(f)
    code, ev = _attach(proj, f)
    assert code == 0 and ev["event"] == "done"
    rec = ev["result"]
    asset = _check_record(proj, rec, "image")
    assert asset.suffix == ".png" and asset.read_bytes() == f.read_bytes()
    assert rec["name"] == "my meme ça.png" and (rec["width"], rec["height"]) == (640, 480)
    assert "-my-meme-ca" in asset.name


def test_jpg_and_original_name(proj, src):
    f = src / "tmp123.jpeg"
    Image.new("RGB", (300, 900), (10, 200, 10)).save(f, "JPEG")
    code, ev = _attach(proj, f, name="Reaction Face.JPG")
    assert code == 0
    rec = ev["result"]
    asset = _check_record(proj, rec, "image")
    assert asset.suffix == ".jpg" and rec["name"] == "Reaction Face.JPG"
    assert (rec["width"], rec["height"]) == (300, 900)


def test_still_gif_becomes_png(proj, src):
    f = src / "still.gif"
    Image.new("P", (120, 80), 3).save(f, "GIF")
    code, ev = _attach(proj, f)
    assert code == 0
    asset = _check_record(proj, ev["result"], "image")
    assert asset.suffix == ".png"
    with Image.open(asset) as im:
        assert im.format == "PNG" and im.size == (120, 80)


def test_still_webp_becomes_png(proj, src):
    f = src / "pic.webp"
    Image.new("RGB", (100, 60), (0, 0, 255)).save(f, "WEBP")
    code, ev = _attach(proj, f)
    assert code == 0
    assert _check_record(proj, ev["result"], "image").suffix == ".png"


@has_ffmpeg
def test_animated_gif_becomes_silent_even_mp4(proj, src):
    f = src / "the ick.gif"
    frames = [Image.new("RGB", (101, 75), c) for c in ((255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0))]
    frames[0].save(f, "GIF", save_all=True, append_images=frames[1:], duration=250, loop=0)  # 1 s loop
    code, ev = _attach(proj, f)
    assert code == 0, ev
    rec = ev["result"]
    asset = _check_record(proj, rec, "video")
    assert asset.suffix == ".mp4" and rec["hasAudio"] is False and rec["fromGif"] is True
    assert rec["width"] % 2 == 0 and rec["height"] % 2 == 0 and (rec["width"], rec["height"]) == (100, 74)
    assert rec["loops"] == 3 and abs(rec["duration"] - 3.0) < 0.1     # a 1 s loop repeats to 3 s
    info = compose_util.probe(asset)
    assert info["has_video"] and not info["has_audio"] and abs(info["duration"] - 3.0) < 0.15
    pf = subprocess.run([compose_util.ffprobe_bin(), "-v", "error", "-select_streams", "v:0", "-show_entries",
                         "stream=codec_name,pix_fmt", "-of", "json", str(asset)], capture_output=True, text=True)
    st = json.loads(pf.stdout)["streams"][0]
    assert st["codec_name"] == "h264" and st["pix_fmt"] == "yuv420p"
    assert compose_util.kind_of(asset) == "video"
    # frames change over time (it is really animated, not frame one frozen)
    a = compose_util.grab_frame(asset, 0.1)
    b = compose_util.grab_frame(asset, 0.6)
    assert abs(int(a[..., 0].mean()) - int(b[..., 0].mean())) > 50 or abs(int(a[..., 1].mean()) - int(b[..., 1].mean())) > 50


def _mp4(path, dur, audio=True, size="320x568"):
    cmd = [FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i", f"testsrc2=s={size}:r=30:d={dur}"]
    if audio:
        cmd += ["-f", "lavfi", "-i", f"sine=f=440:d={dur}", "-c:a", "aac", "-shortest"]
    cmd += ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(path)]
    subprocess.run(cmd, check=True)
    return path


@has_ffmpeg
def test_mp4_probe_and_thumb(proj, src):
    f = _mp4(src / "clip ça.mp4", 2.5)
    code, ev = _attach(proj, f)
    assert code == 0, ev
    rec = ev["result"]
    asset = _check_record(proj, rec, "video")
    assert asset.suffix == ".mp4" and asset.read_bytes() == f.read_bytes()
    assert (rec["width"], rec["height"]) == (320, 568)
    assert abs(rec["duration"] - 2.5) < 0.1 and rec["hasAudio"] is True


@has_ffmpeg
def test_silent_short_mov(proj, src):
    f = _mp4(src / "x.mov", 0.4, audio=False)
    code, ev = _attach(proj, f)
    assert code == 0, ev
    rec = ev["result"]
    assert _check_record(proj, rec, "video").suffix == ".mov" and rec["hasAudio"] is False


@has_ffmpeg
def test_too_long_clip_is_refused_and_nothing_written(proj, src):
    f = _mp4(src / "long.mp4", 61.5, audio=False, size="64x64")
    code, ev = _attach(proj, f)
    assert code == 1 and ev["code"] == "ATTACH_TOO_LONG"
    assert ev["userMessage"] == attach.MSG_CLIP_LONG and "—" not in ev["userMessage"]
    assert _written(proj) == []


@has_ffmpeg
def test_too_long_gif_is_refused(proj, src, monkeypatch):
    monkeypatch.setattr(attach, "CLIP_MAX_SECONDS", 0.5)
    f = src / "long.gif"
    frames = [Image.new("RGB", (20, 20), (i * 40, 0, 0)) for i in range(6)]
    frames[0].save(f, "GIF", save_all=True, append_images=frames[1:], duration=300, loop=0)
    code, ev = _attach(proj, f)
    assert code == 1 and ev["code"] == "ATTACH_TOO_LONG" and _written(proj) == []


def test_too_big_picture_is_refused_and_nothing_written(proj, src, monkeypatch):
    f = src / "huge.png"
    Image.new("RGB", (64, 64)).save(f)
    monkeypatch.setattr(attach, "PICTURE_MAX_BYTES", 10)
    code, ev = _attach(proj, f)
    assert code == 1 and ev["code"] == "ATTACH_TOO_BIG" and ev["userMessage"] == attach.MSG_PICTURE_BIG
    assert _written(proj) == []


def test_too_big_clip_sparse_file(proj, src):
    f = src / "big.mp4"
    with open(f, "wb") as fh:                    # sparse where the filesystem allows it
        fh.seek(attach.CLIP_MAX_BYTES + 10)
        fh.write(b"\0")
    code, ev = _attach(proj, f)
    assert code == 1 and ev["code"] == "ATTACH_TOO_BIG" and ev["userMessage"] == attach.MSG_CLIP_BIG
    assert _written(proj) == []


@pytest.mark.parametrize("name", ["notes.pdf", "song.mp3", "noext", "vector.svg", "clip.mkv"])
def test_unsupported_type(proj, src, name):
    f = src / name
    f.write_bytes(b"hello")
    code, ev = _attach(proj, f)
    assert code == 1 and ev["code"] == "ATTACH_TYPE" and ev["userMessage"] == attach.MSG_TYPE
    assert _written(proj) == []


def test_damaged_picture_and_clip(proj, src):
    f = src / "broken.jpg"
    f.write_bytes(b"\xff\xd8 not really a jpeg")
    code, ev = _attach(proj, f)
    assert code == 1 and ev["code"] == "ATTACH_UNREADABLE" and _written(proj) == []
    g = src / "broken.mp4"
    g.write_bytes(b"\0" * 1000)
    code, ev = _attach(proj, g)
    assert code == 1 and ev["code"] in ("ATTACH_UNREADABLE", "ATTACH_NO_VIDEO") and _written(proj) == []


def test_missing_file(proj, src):
    code, ev = _attach(proj, src / "gone.png")
    assert code == 1 and ev["code"] == "NOT_FOUND" and _written(proj) == []


def test_user_messages_have_no_em_dash():
    for k in dir(attach):
        if k.startswith("MSG_"):
            assert "—" not in getattr(attach, k)


def test_read_sidecar_refuses_non_attachments(proj):
    assert attach.read_sidecar(proj, "work/assets/other.png") is None
    assert attach.read_sidecar(proj, "work/assets/attach-x/../../project.json") is None
    assert attach.read_sidecar(proj, "media/attach-x.png") is None


HEIC_ENCODE = """
import sys
from PIL import Image
import pillow_heif
pillow_heif.from_pillow(Image.new("RGB", (64, 48), (200, 30, 40))).save(sys.argv[1], quality=90)
"""


@pytest.mark.skipif(importlib.util.find_spec("pi_heif") is None and importlib.util.find_spec("pillow_heif") is None,
                    reason="neither pi-heif nor pillow-heif installed")
def test_heic_becomes_png(proj, src):
    if importlib.util.find_spec("pillow_heif") is None:
        pytest.skip("no HEIC encoder to make a sample")
    import sys
    f = src / "IMG_0001.HEIC"
    subprocess.run([sys.executable, "-c", HEIC_ENCODE, str(f)], check=True)
    code, ev = _attach(proj, f)
    assert code == 0, ev
    asset = _check_record(proj, ev["result"], "image")
    assert asset.suffix == ".png" and (ev["result"]["width"], ev["result"]["height"]) == (64, 48)
