"""`frames` without a preview: stills drawn from the project are the preview's own frames, and a render is
reused only while it still shows the project."""
from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image

import fixtures as fx
from reelengine import frames, render

FPS = 30
DRAFT_W = 540
# Words of different lengths, so lines grouped differently look different.
TEXT = "so here is the short videos everyone makes and nobody really watches until the end".split()
# Bounds in dB, proposed, not approved. On Windows with FFmpeg 7.1.1 a still and the draft's frame scored
# at least 46.7 in every region (the draft's lossy encode against the lossless still); the same still read
# without the window caption clock scored 13.8 in the caption band, and the frame after it 23.4 in the
# square's band. A missing card was not measured.
CAPTION_DB, SQUARE_DB, CARD_DB, FRAME_DB = 30.0, 30.0, 30.0, 30.0
# Proposed, not measured: one frame of a 0.5 s fade moves a card's alpha by 1/15, about 31 dB on its
# box, while a still and its draft frame scored 46.7 dB or more above. A still a frame off mid-fade fails.
FADE_DB = 38.0


def _moving_take(path: Path, dur: float = 8.0) -> Path:
    """A grey take with a white square that moves 8 px a frame (so a frame early or late shows) and a tone."""
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run([fx.FFMPEG, "-y", "-v", "error",
                        "-f", "lavfi", "-i", f"color=c=0x6a6560:s=1080x1920:r={FPS}:d={dur}",
                        "-f", "lavfi", "-i", f"color=c=white:s=120x120:r={FPS}:d={dur}",
                        "-f", "lavfi", "-i", f"sine=f=220:d={dur}:sample_rate=48000",
                        "-filter_complex", "[0][1]overlay=x='mod(t*240,840)':y=300:eval=frame,format=yuv420p[v]",
                        "-map", "[v]", "-map", "2:a", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12",
                        "-c:a", "aac", "-shortest", str(path)], check=True)
    return path


def _gray(png: str) -> np.ndarray:
    return np.asarray(Image.open(png).convert("L"), dtype=np.float64)


def _psnr(a: np.ndarray, b: np.ndarray) -> float:
    mse = float(np.mean((a - b) ** 2))
    return math.inf if mse == 0 else 10 * math.log10(255 * 255 / mse)


def _rename_words(pdir: Path) -> None:
    tfile = pdir / "work" / "transcript.json"
    words = json.loads(tfile.read_text(encoding="utf-8"))["words"]
    for i, w in enumerate(words):
        w["w"] = TEXT[i % len(TEXT)]
    tfile.write_text(json.dumps({"words": words}), encoding="utf-8")


def _asset(pdir: Path, image: Path) -> str:
    """The picture copied into the project, as fetch-image stores one (project.json refuses absolute paths)."""
    d = pdir / "work" / "assets"
    d.mkdir(parents=True, exist_ok=True)
    shutil.copy2(image, d / image.name)
    return f"work/assets/{image.name}"


def _layer_item(pdir: Path, bid: str) -> dict:
    items = json.loads((pdir / "work" / "layers" / "layers.json").read_text(encoding="utf-8"))["items"]
    return next(i for i in items if i["id"] == bid)


def test_a_still_without_a_draft_is_the_drafts_frame(tmp_path, monkeypatch):
    """The stills the AI looks at when no preview is up to date. Times sit mid-line, mid-word, either side of
    a cut, inside a zoom and a card, and off the frame grid."""
    monkeypatch.setenv("REELENGINE_DRAFT_ENCODER", "libx264")   # one known encoder for the preview
    monkeypatch.setenv("REELENGINE_ROOT", str(tmp_path))
    pdir = tmp_path / "p"
    # Two kept runs: output 0 to 2.7 s, then a cut to the second run.
    fx.make_project(pdir, _moving_take(tmp_path / "media" / "moving.mp4"), keep=((0.05, 2.45), (3.25, 7.05)))
    _rename_words(pdir)
    ctx = fx.make_ctx(pdir)
    card = _asset(pdir, fx.synth_images(tmp_path / "img")["screenshot"])
    fx.set_project(ctx, broll=[{"id": "b1", "anchor": {"from": fx.word_near(ctx, 3.6), "to": fx.word_near(ctx, 4.8)},
                                "leadIn": 0.13, "treatment": "card-above-head", "asset": card, "params": {}}],
                   zooms=[{"anchor": {"from": fx.word_near(ctx, 0.4), "to": fx.word_near(ctx, 1.6)}, "scale": 1.3}])
    times = [0.5, 1.23, 2.68, 2.72, 4.0, 4.6, 5.03, 6.5]

    drawn = render.stills(pdir, times, DRAFT_W)["frames"]          # before any preview exists
    draft = Path(render.run(pdir, draft=True, verify=False)["file"])
    taken = frames.from_video(draft, times, DRAFT_W)["frames"]
    assert [f["t"] for f in drawn] == [f["t"] for f in taken]

    scale = DRAFT_W / 1080
    boxes = [c["box"] for c in json.loads((pdir / "work" / "captions.json").read_text(encoding="utf-8"))["cues"]]
    cy0 = int(min(y for _, y, _, _ in boxes) * scale) - 8
    cy1 = int(max(y + h for _, y, _, h in boxes) * scale) + 8
    sy0, sy1 = int(300 * scale) - 4, int(420 * scale) + 4           # the moving square's rows outside a zoom
    b1 = _layer_item(pdir, "b1")
    bx0, by0, bx1, by1 = (int(v * scale) for v in b1["bbox"])
    assert not b1.get("skipped") and b1["t0"] <= 4.0 < b1["t1"] and b1["t0"] <= 4.6 < b1["t1"]

    rows = []
    for t, d, k in zip(times, drawn, taken):
        a, b = _gray(d["file"]), _gray(k["file"])
        assert a.shape == b.shape == (960, DRAFT_W)
        row = {"t": t, "frame": _psnr(a, b), "caption": _psnr(a[cy0:cy1], b[cy0:cy1])}
        if b1["t0"] <= t < b1["t1"]:
            row["card"] = _psnr(a[by0:by1, bx0:bx1], b[by0:by1, bx0:bx1])
        rows.append(row)
    # not vacuous: the preview has caption text in the band at most of these times
    assert sum(int((_gray(k["file"])[cy0:cy1] > 200).sum()) > 200 for k in taken) >= len(times) // 2

    # A frame late must fail the square's band, or the bound could not see a frame early or late.
    late = frames.from_video(draft, [6.5 + 1 / FPS], DRAFT_W)["frames"][0]
    on_time, off = _gray(drawn[-1]["file"]), _gray(late["file"])
    assert (on_time[sy0:sy1] > 200).sum() > 1000                     # the square is in its band at 6.5 s
    square = _psnr(on_time[sy0:sy1], _gray(taken[-1]["file"])[sy0:sy1])
    square_late = _psnr(on_time[sy0:sy1], off[sy0:sy1])
    report = json.dumps({"rows": rows, "square": square, "squareOneFrameLate": square_late}, indent=1)
    print(report)
    assert min(r["caption"] for r in rows) >= CAPTION_DB, report
    assert min(r["frame"] for r in rows) >= FRAME_DB, report
    assert min(r["card"] for r in rows if "card" in r) >= CARD_DB, report
    assert square >= SQUARE_DB > square_late, report



def test_a_still_inside_a_cards_fade_is_the_drafts_frame(tmp_path, monkeypatch):
    """A still drawn while a card fades in or out shows it as faded as the preview does. A one-frame window
    that starts inside a fade used to drop the fade-in and shorten the fade-out, so the still showed the
    card fully drawn where the preview showed it half there."""
    monkeypatch.setenv("REELENGINE_DRAFT_ENCODER", "libx264")
    monkeypatch.setenv("REELENGINE_ROOT", str(tmp_path))
    pdir = tmp_path / "p"
    fx.make_project(pdir, fx.synth_video(tmp_path / "media" / "take.mp4", dur=6.0), keep=((0.05, 5.95),))
    ctx = fx.make_ctx(pdir)
    card = _asset(pdir, fx.synth_images(tmp_path / "img")["screenshot"])
    fx.set_project(ctx, broll=[{"id": "b1", "anchor": {"from": fx.word_near(ctx, 2.0), "to": fx.word_near(ctx, 3.6)},
                                "leadIn": 0.13, "treatment": "card-above-head", "asset": card,
                                "params": {"fade": 0.5}}])
    draft = Path(render.run(pdir, draft=True, verify=False)["file"])
    b1 = _layer_item(pdir, "b1")
    assert not b1.get("skipped") and b1["t1"] - b1["t0"] > 1.5
    settled = (b1["t0"] + b1["t1"]) / 2
    times = [round(t, 3) for t in (b1["t0"] + 0.1, b1["t0"] + 0.25, settled, b1["t1"] - 0.25, b1["t1"] - 0.1)]

    drawn = render.stills(pdir, times, DRAFT_W)["frames"]
    taken = frames.from_video(draft, times, DRAFT_W)["frames"]
    assert [f["t"] for f in drawn] == [f["t"] for f in taken]
    scale = DRAFT_W / 1080
    bx0, by0, bx1, by1 = (int(v * scale) for v in b1["bbox"])

    def box(f) -> np.ndarray:
        return _gray(f["file"])[by0:by1, bx0:bx1]
    # not vacuous: in the preview the card is visibly less drawn mid-fade than once it has settled
    assert all(_psnr(box(taken[i]), box(taken[2])) < CARD_DB for i in (0, 1, 3, 4))
    scores = [round(_psnr(box(d), box(k)), 1) for d, k in zip(drawn, taken)]
    print(json.dumps({"times": times, "cardDb": scores}))
    assert min(scores) >= FADE_DB, scores

def test_frames_reuses_a_render_only_while_it_shows_the_project(tmp_path, monkeypatch):
    """A preview whose picture no longer matches the project (captions, the transcript, the face track, a
    preview that stopped before its last step) must not be shown as the edit; a change that no frame shows
    (music, post text) must not cost a fresh drawing."""
    monkeypatch.setenv("REELENGINE_DRAFT_ENCODER", "libx264")
    monkeypatch.setenv("REELENGINE_ROOT", str(tmp_path))
    pdir = tmp_path / "p"
    fx.make_project(pdir, fx.synth_video(tmp_path / "media" / "take.mp4", dur=4.0), keep=((0.05, 3.25),))
    ctx = fx.make_ctx(pdir)
    poster = _asset(pdir, fx.synth_images(tmp_path / "img")["portrait"])
    fx.set_project(ctx, broll=[{"id": "b1", "anchor": {"from": fx.word_near(ctx, 1.6), "to": fx.word_near(ctx, 2.0)},
                                "leadIn": 0.13, "treatment": "full-frame", "asset": poster, "params": {}}])

    def edit(fn) -> None:
        proj = json.loads((pdir / "project.json").read_text(encoding="utf-8"))
        fn(proj)
        (pdir / "project.json").write_text(json.dumps(proj, indent=1), encoding="utf-8")

    first = frames.run(pdir, [0.4])
    assert first["source"] == "edit"                                  # nothing rendered yet
    assert not (pdir / "versions" / "preview" / "draft.mp4").exists()  # and drawing made no preview
    draft = Path(render.run(pdir, draft=True, verify=False)["file"])
    reused = frames.run(pdir, [0.4])
    assert reused["source"] == "render" and reused["video"] == str(draft)

    # A time inside a full-screen card moves to its settled end, on both paths.
    full = _layer_item(pdir, "b1")
    ask = round((full["t0"] + full["t1"]) / 2, 2)
    want = [{"asked": ask, "sampled": math.floor((full["t1"] - 0.15) * 100 + 0.5) / 100, "id": "b1"}]
    assert frames.run(pdir, [ask])["animationsSampledAtEnd"] == want
    # The render's own card window, not the last drawing's: draw another edit, then go back to the rendered one.
    saved = (pdir / "project.json").read_text(encoding="utf-8")
    edit(lambda p: p["broll"][0].update(anchor={"from": fx.word_near(ctx, 0.4), "to": fx.word_near(ctx, 0.8)}))
    assert frames.run(pdir, [0.6])["source"] == "edit"              # layers.json now holds that edit's card
    (pdir / "project.json").write_text(saved, encoding="utf-8")
    back = frames.run(pdir, [ask])
    assert back["source"] == "render" and back["animationsSampledAtEnd"] == want

    edit(lambda p: p.update(post=dict(p["post"], caption="new words"),
                            music=dict(p["music"], startAt=2.0, fadeOut=3.0)))
    assert frames.run(pdir, [0.4])["source"] == "render"             # no frame shows these

    edit(lambda p: p["captions"]["style"].update(size=90))
    stale = frames.run(pdir, [0.4, ask])
    assert stale["source"] == "edit" and stale["animationsSampledAtEnd"] == want
    edit(lambda p: p["captions"]["style"].update(size=76))
    assert frames.run(pdir, [0.4])["source"] == "render"             # the same picture again

    tfile = pdir / "work" / "transcript.json"
    before = tfile.read_bytes()
    tfile.write_text(before.decode("utf-8").replace('"word0"', '"hello"'), encoding="utf-8")
    assert frames.run(pdir, [0.4])["source"] == "edit"               # the captions' words changed
    tfile.write_bytes(before)
    assert frames.run(pdir, [0.4])["source"] == "render"

    face = pdir / "work" / "face.json"                               # analyze wrote a face track
    face.write_text(json.dumps({"sources": {"s1": {"width": 1080, "height": 1920,
                                                   "median": {"x": 100, "y": 200, "w": 300, "h": 300}}}}),
                    encoding="utf-8")
    assert frames.run(pdir, [0.4])["source"] == "edit"
    face.unlink()
    assert frames.run(pdir, [0.4])["source"] == "render"

    # A preview that stopped after replacing its mp4 but before writing its manifest
    manifest = draft.parent / "render_draft.json"
    st = manifest.stat()
    os.utime(draft, ns=(st.st_atime_ns, st.st_mtime_ns + 2_000_000_000))
    assert frames.run(pdir, [0.4])["source"] == "edit"
