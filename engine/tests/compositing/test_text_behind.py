"""Words behind the speaker (broll treatment "text-behind"): the speaker cut out over the words, through
every zoom, and an honest fallback when the cut-out can't be made.

The take is a dark frame with one light block standing in for the speaker. The segmentation model is
replaced by "light pixels are the person", so these tests measure the matte's geometry and timing,
not the model (the real model's frames are evidence on a real take, not a test here)."""
from __future__ import annotations

import http.server
import json
import os
import subprocess
import threading

import numpy as np
import pytest

import fixtures as fx
from reelengine import broll, render, segment
from reelengine.proto import EngineError

W, H, FPS = 1080, 1920, 30
# the "speaker": a light block from the shoulders down, centred
BX, BY, BW = 324, 384, 432
ZOOM = 1.25


@pytest.fixture(scope="module")
def take(tmp_path_factory):
    p = tmp_path_factory.mktemp("behind") / "block.mp4"
    subprocess.run([fx.FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i",
                    f"color=c=0x282828:s={W}x{H}:r={FPS}:d=6,drawbox=x={BX}:y={BY}:w={BW}:h={H - BY}:color=0xe0e0e0:t=fill",
                    "-f", "lavfi", "-i", "sine=f=220:d=6:sample_rate=48000",
                    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(p)],
                   check=True)
    return p


def light_is_person(bgr):
    import cv2
    grey = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    return cv2.resize((grey > 150).astype(np.float32), (segment.NET_SIZE, segment.NET_SIZE), interpolation=cv2.INTER_AREA)


def project_with_words_behind(pdir, take, zoom: bool):
    fx.make_project(pdir, take, keep=((0.5, 5.5),))
    ctx = fx.make_ctx(pdir)
    anchor = {"from": fx.word_near(ctx, 1.0), "to": fx.word_near(ctx, 3.6)}
    fx.set_project(ctx, captions={"enabled": False},
                   zooms=[{"anchor": anchor, "scale": ZOOM, "focus": [0.5, 0.5]}] if zoom else [],
                   broll=[{"id": "b1", "anchor": anchor, "leadIn": 0.0, "treatment": "text-behind", "asset": None,
                           "params": {"text": "HELLO", "color": "#FF0000", "size": 0.3}}])
    return ctx


def frame(video, t):
    raw = subprocess.run([fx.FFMPEG, "-v", "error", "-ss", f"{t:.3f}", "-i", str(video), "-frames:v", "1",
                          "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw[:W * H * 3], np.uint8).reshape(H, W, 3).astype(int)


def red(img):
    return (img[..., 0] > 170) & (img[..., 1] < 90) & (img[..., 2] < 90)


def test_the_speaker_stays_in_front_of_the_words_through_a_zoom(tmp_path, take, monkeypatch):
    """Fails if the cut-out is made where the speaker was before the zoom: the words then show
    through the band the zoom grew the speaker into."""
    monkeypatch.setattr(segment, "person_prob", light_is_person)
    pdir = tmp_path / "p"
    project_with_words_behind(pdir, take, zoom=True)
    res = render.run(pdir, draft=False, root=tmp_path, verify=False, cover=False)
    img = frame(res["file"], 2.3)                      # inside the zoom's hold
    r = red(img)
    # the block, zoomed about the centre: its left edge moves from BX to cx - (cx - BX) * ZOOM
    zl = int(round(W / 2 - (W / 2 - BX) * ZOOM))
    zt = int(round(H / 2 - (H / 2 - BY) * ZOOM))
    rows = slice(zt + 12, zt + 300)
    assert r[rows, :zl - 12].sum() > 500, "the words are not drawn beside the speaker"
    assert r[rows, zl + 12:BX - 12].sum() == 0, "the words show through where the zoom grew the speaker"
    assert r[rows, BX + 12:W - BX - 12].sum() == 0, "the words cover the speaker"


def test_without_a_cut_out_the_words_go_above_the_face_instead(tmp_path, take, monkeypatch):
    """Fails if the words land on the speaker, or the item quietly disappears, when the model can't be downloaded."""
    monkeypatch.setenv("REELENGINE_MODELS", str(tmp_path / "models"))
    monkeypatch.setenv("REELENGINE_MODEL_MIRROR", "http://127.0.0.1:9")      # nothing listens there
    monkeypatch.setenv("REELENGINE_RESUME_BACKOFF", "0")
    ctx = project_with_words_behind(tmp_path / "p", take, zoom=False)
    layers = broll.build_layers(ctx)
    assert [L.kind for L in layers] == ["image"]
    items = json.loads((tmp_path / "p" / "work" / "layers" / "layers.json").read_text(encoding="utf-8"))["items"]
    (row,) = render.read_broll_report(items)
    assert row["shownAs"] == "text-pop"
    assert "behind you" in row["fallback"]


def test_a_model_that_is_not_the_pinned_bytes_is_never_kept(tmp_path, monkeypatch):
    """Fails if a download whose SHA-256 differs from the pin is saved and later loaded."""
    wrong = os.urandom(segment.PIN["file"]["size"])

    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Length", str(len(wrong)))
            self.end_headers()
            self.wfile.write(wrong)

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        monkeypatch.setenv("REELENGINE_MODELS", str(tmp_path / "models"))
        monkeypatch.setenv("REELENGINE_MODEL_MIRROR", f"http://127.0.0.1:{srv.server_port}")
        with pytest.raises(EngineError) as e:
            segment.ensure_model()
        assert e.value.code == "DOWNLOAD_CORRUPT"
        assert not segment.model_path().exists()
        assert list(segment.model_path().parent.glob("*.part")) == []
    finally:
        srv.shutdown()


def _side_take(path):
    """The light block on the left for 3 s, then on the right."""
    subprocess.run([fx.FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i",
                    # two boxes switched by time: drawbox reads its x once, so an expression in t never moves it
                    f"color=c=0x282828:s={W}x{H}:r={FPS}:d=6,"
                    f"drawbox=x=60:y=600:w=400:h=1200:color=0xe0e0e0:t=fill:enable='lt(t,3)',"
                    f"drawbox=x={W - 460}:y=600:w=400:h=1200:color=0xe0e0e0:t=fill:enable='gte(t,3)'",
                    "-f", "lavfi", "-i", "sine=f=220:d=6:sample_rate=48000",
                    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(path)],
                   check=True)
    return path


def test_the_cut_out_switches_sides_on_the_frame_the_cut_does(tmp_path, monkeypatch):
    """Fails if the matte after a cut is made from the take before it (or from no frames at all): the
    speaker would be cut out where they no longer are."""
    monkeypatch.setattr(segment, "person_prob", light_is_person)
    pdir = tmp_path / "p"
    fx.make_project(pdir, _side_take(tmp_path / "side.mp4"), keep=((0.5, 2.0), (4.0, 5.5)))
    ctx = fx.make_ctx(pdir)
    cut = ctx.out_timeline[1].out_start
    t0 = 1.0
    clip = segment.matte_clip(ctx, t0, cut + 0.6, tmp_path, "m")
    raw = subprocess.run([fx.FFMPEG, "-v", "error", "-i", str(clip), "-vf", f"crop={W}:2:0:{H * 3 // 4}",
                          "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True, check=True).stdout
    rows = np.frombuffer(raw, np.uint8).reshape(-1, 2, W)[:, 0]
    first = int(np.ceil(t0 * FPS - 1e-6))
    for j, row in enumerate(rows):
        t = (first + j) / FPS
        left, right = row[100:400].mean(), row[W - 400:W - 100].mean()
        if t < cut - 1.5 / FPS:
            assert left > 200 and right < 50, f"frame at {t:.3f} s (before the cut at {cut:.3f} s)"
        elif t > cut + 0.5 / FPS:
            assert right > 200 and left < 50, f"frame at {t:.3f} s (after the cut at {cut:.3f} s)"


def test_an_unreadable_take_is_refused_rather_than_cut_out_as_empty(tmp_path, monkeypatch):
    """Fails if a take that can't be decoded gives an empty (black) matte: the words would then be drawn
    over the speaker instead of falling back to above the face."""
    monkeypatch.setattr(segment, "person_prob", light_is_person)
    pdir = tmp_path / "p"
    fx.make_project(pdir, _side_take(tmp_path / "side.mp4"), keep=((0.5, 2.0),))
    media = pdir / "media" / "side.mp4"
    media.unlink()                                   # the project's own link, never the shared take
    media.write_bytes(os.urandom(200_000))
    with pytest.raises(EngineError) as e:
        segment.matte_clip(fx.make_ctx(pdir), 0.2, 1.0, tmp_path, "m")
    assert e.value.code == "MATTE_DECODE"
    assert list(tmp_path.glob("m-matte-*")) == []
