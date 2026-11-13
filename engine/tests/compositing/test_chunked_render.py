"""A final export is a row of cached ~2 s chunks (render.chunked_video). After any edit it must be the video a
full render of the project makes, frame for frame and byte for byte, and re-encode only the chunks the edit
touched."""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

import fixtures as fx
from reelengine import chunks, render, tools

W, H = 360, 640
FPS = 30


def _take(path: Path, dur: float, hdr: bool = False, rate: str = str(FPS), uneven: bool = False) -> Path:
    """A moving picture (a one-frame slip shows) with a tone that gates on and off as 'speech'. The HDR take
    is 10-bit HLG, which the render tone-maps (render.HDR_CHAIN). An uneven take drops frames on two
    incommensurate cycles, as a phone does under load."""
    path.parent.mkdir(parents=True, exist_ok=True)
    vf = f"testsrc2=s={W}x{H}:r={rate}:d={dur}"
    if uneven:
        vf += r",select='not(eq(mod(n\,7)\,3))*not(eq(mod(n\,11)\,5))'"
    af = f"sine=f=220:d={dur}:sample_rate=48000,volume='if(lt(mod(t,1.2),0.8),0.3,0.0)':eval=frame"
    # HLG's primaries, transfer and matrix as H.273 codes, written into the bitstream as a phone writes them
    color = (["-pix_fmt", "yuv420p10le", "-bsf:v", "h264_metadata=colour_primaries=9:transfer_characteristics=18:"
              "matrix_coefficients=9"] if hdr else ["-pix_fmt", "yuv420p"])
    subprocess.run([fx.FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i", vf, "-f", "lavfi", "-i", af,
                    *(["-fps_mode", "vfr"] if uneven else []), "-c:v", "libx264", "-preset", "ultrafast", "-g", "15",
                    *color, "-c:a", "aac", "-shortest", str(path)], check=True)
    return path


@pytest.fixture(scope="module")
def media(tmp_path_factory):
    d = tmp_path_factory.mktemp("chunked media")
    return {"video": _take(d / "talk.mp4", 14.0), "long": _take(d / "long.mp4", 62.0),
            "clip": fx.synth_clip(d / "clip.mp4", dur=3.0, w=640, h=360), **fx.synth_images(d / "img")}


@pytest.fixture
def root(tmp_path, media):
    lib = tmp_path / "root" / "Library"
    lib.mkdir(parents=True)
    shutil.copy2(media["clip"], lib / "clip.mp4")
    shutil.copy2(media["screenshot"], lib / "screenshot.png")
    return lib.parent


def _rate(video: Path) -> float:
    """The take's frame rate as `probe` reads it."""
    out = subprocess.run([fx.FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "stream=avg_frame_rate", "-of", "csv=p=0", str(video)], capture_output=True, text=True,
                         check=True).stdout.strip()
    num, den = out.split("/")
    return round(int(num) / int(den), 3)


def _project(pdir: Path, video: Path, keep, **extra) -> dict:
    proj = fx.make_project(pdir, video, keep=keep)
    words = json.loads((pdir / "work" / "transcript.json").read_text(encoding="utf-8"))["words"]
    proj["format"] = {"width": W, "height": H, "fps": FPS}
    proj["sources"][0].update(width=W, height=H, fps=_rate(video), **extra.pop("source", {}))
    proj.update(extra)
    (pdir / "project.json").write_text(json.dumps(proj, indent=1), encoding="utf-8")
    return proj, words


def _wid(words: list, src_t: float) -> str:
    return min(words, key=lambda w: abs(w["s"] - src_t))["id"]


def _fix_caption(pdir: Path, words: list, src_t: float, text: str) -> None:
    """The subtitle editor's fix of the one word heard nearest src_t."""
    w = min(words, key=lambda w: abs(w["s"] - src_t))
    _edit(pdir, lambda p: p["captions"].update(corrections=[{"from": w["w"], "to": text, "at": w["id"]}]))


def _edit(pdir: Path, change) -> None:
    pf = pdir / "project.json"
    proj = json.loads(pf.read_text(encoding="utf-8"))
    change(proj)
    pf.write_text(json.dumps(proj, indent=1), encoding="utf-8")


def _render(pdir: Path, root: Path, keep: Path, verify: bool = False, **kw) -> tuple:
    """(a copy of the export, the result): the next render of the same edit writes the same file."""
    res = render.run(pdir, root=root, verify=verify, cover=False, **kw)
    keep.parent.mkdir(parents=True, exist_ok=True)
    return Path(shutil.copy2(res["file"], keep)), res


def _framemd5(f: Path) -> list:
    """Every decoded picture and sound frame: stream, timestamps, duration, size and hash."""
    p = subprocess.run([fx.FFMPEG, "-v", "error", "-i", str(f), "-f", "framemd5", "-"],
                       capture_output=True, text=True, check=True)
    return [ln for ln in p.stdout.splitlines() if ln and not ln.startswith("#")]


def _same_frames(a: Path, b: Path) -> None:
    fa, fb = _framemd5(a), _framemd5(b)
    first = next((i for i, (x, y) in enumerate(zip(fa, fb)) if x != y), None)
    assert fa == fb, f"{len(fa)} vs {len(fb)} frames; first difference at line {first}: {fa[first:first + 1]} " \
                     f"vs {fb[first:first + 1]}"


def _psnr(a: Path, b: Path) -> float:
    """Mean PSNR of b's pictures against a's, in dB (inf when they are the same)."""
    p = subprocess.run([fx.FFMPEG, "-v", "info", "-i", str(a), "-i", str(b), "-lavfi", "[0:v][1:v]psnr", "-f", "null",
                        "-"], capture_output=True, text=True, check=True)
    avg = p.stderr.rsplit("average:", 1)[1].split()[0]
    return float("inf") if avg == "inf" else float(avg)


def _fresh_render(pdir: Path, root: Path, keep: Path) -> tuple:
    """The project as it is now, rendered in a new folder with nothing cached: one pass over the whole cut
    draws every chunk."""
    fresh = keep.parent / f"fresh-{keep.stem}"
    shutil.copytree(pdir, fresh, ignore=shutil.ignore_patterns("render", "layers", "audio", "versions"))
    return _render(fresh, root, keep)


def _busy_project(pdir: Path, video: Path) -> list:
    """Two cuts, neither on a chunk boundary, with a zoom, a picture card that fades in and out and a video
    card all crossing chunk boundaries, captions throughout and a mirrored take."""
    proj, words = _project(pdir, video, keep=((0.5, 6.3), (7.1, 13.0)), source={"mirror": True})

    def span(a, b):
        return {"from": _wid(words, a), "to": _wid(words, b)}
    _edit(pdir, lambda p: p.update(
        zooms=[{"anchor": span(1.6, 2.6), "scale": 1.3}],
        broll=[{"id": "b1", "anchor": span(3.4, 4.6), "leadIn": 0.13, "treatment": "split-top",
                "asset": "Library/screenshot.png", "params": {}},
               {"id": "b2", "anchor": span(8.6, 10.4), "leadIn": 0.13, "treatment": "full-frame",
                "asset": "Library/clip.mp4", "params": {}}]))
    return words


@pytest.mark.parametrize("rate", [str(FPS), "30000/1001", "60", "24"])
def test_an_edited_chunked_final_is_the_full_render_frame_for_frame(tmp_path, media, root, rate):
    """A take at the project's rate, and takes the `fps` filter re-times (29.97, 60 and 24 fps into 30)."""
    pdir = tmp_path / "p"
    video = media["video"] if rate == str(FPS) else _take(tmp_path / "media" / "take.mp4", 14.0, rate=rate)
    words = _busy_project(pdir, video)
    first, res = _render(pdir, root, tmp_path / "out" / "first.mp4")
    assert res["chunks"]["encoded"] == list(range(res["chunks"]["total"])), "a new project encodes every chunk"
    assert res["layers"] == 2 and res["zooms"] == 1 and not res["broll"], res

    # a caption fixed in the middle: its chunks are drawn alone (a window of the cut), the rest are reused
    _fix_caption(pdir, words, 8.05, "FIXED")
    edited, res = _render(pdir, root, tmp_path / "out" / "edited.mp4")
    assert 0 < len(res["chunks"]["encoded"]) < res["chunks"]["total"], res["chunks"]
    full, res = _fresh_render(pdir, root, tmp_path / "out" / "full.mp4")
    assert res["chunks"]["encoded"] == list(range(res["chunks"]["total"]))
    _same_frames(edited, full)
    assert edited.read_bytes() == full.read_bytes()


def test_no_pass_opens_more_encoders_than_the_bound_and_the_split_changes_nothing(tmp_path, media, root,
                                                                                 monkeypatch):
    """A first export encodes every chunk; FFmpeg keeps each encoder of a pass until the pass ends, so a long
    video is drawn in passes of at most ENCODERS_PER_PASS chunks, which give the bytes one pass gives."""
    one = tmp_path / "one"
    _busy_project(one, media["video"])
    whole, res = _render(one, root, tmp_path / "out" / "one-pass.mp4")
    assert len(res["chunks"]["encoded"]) == 7
    outputs = []
    run = tools.ffmpeg_progress

    def counting(cmd, *args, **kwargs):
        if kwargs.get("what") == "chunk render":
            outputs.append(sum(1 for a, b in zip(cmd, cmd[1:]) if a == "-f" and b == "mp4"))
        return run(cmd, *args, **kwargs)
    monkeypatch.setattr(chunks, "ENCODERS_PER_PASS", 3)
    monkeypatch.setattr(tools, "ffmpeg_progress", counting)
    split = tmp_path / "split"
    _busy_project(split, media["video"])
    passes, _ = _render(split, root, tmp_path / "out" / "split.mp4")
    assert outputs == [3, 3, 1]
    assert passes.read_bytes() == whole.read_bytes()


def test_the_one_pass_fallback_draws_the_same_picture(tmp_path, media, root):
    """The single pass encodes the same frames with one encoder, whose motion search may pick a different
    vector of the same cost where the picture is flat: the same picture, not always the same bits."""
    pdir = tmp_path / "p"
    _busy_project(pdir, media["video"])
    chunked, _ = _render(pdir, root, tmp_path / "out" / "chunked.mp4")
    single, res = _render(pdir, root, tmp_path / "out" / "single.mp4", chunked=False)
    assert res["chunks"] is None
    assert len(_framemd5(chunked)) == len(_framemd5(single))
    assert _psnr(single, chunked) >= 50


def test_every_chunk_starts_on_a_keyframe_and_the_join_keeps_its_clock(tmp_path, media, root):
    pdir = tmp_path / "p"
    _project(pdir, media["video"], keep=((0.5, 13.0),))
    mp4, res = _render(pdir, root, tmp_path / "out.mp4", verify=True)
    assert res["verify"]["ok"], res["verify"]
    assert Path(res["cover"]).is_file()
    rows = subprocess.run([fx.FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries",
                           "frame=pts,key_frame,pict_type", "-of", "csv=p=0", str(mp4)],
                          capture_output=True, text=True, check=True).stdout.split()
    pts = [int(r.split(",")[1]) for r in rows]
    step = pts[1] - pts[0]
    assert pts == [n * step for n in range(len(pts))], "frame timestamps run evenly through every join"
    keys = [n for n, r in enumerate(rows) if r.split(",")[0] == "1"]
    assert keys == list(range(0, len(rows), chunks.gop_frames(FPS))), "a keyframe every second, and only there"
    assert [f0 for f0, _ in chunks.plan(len(rows), FPS)] == list(range(0, len(rows), 2 * FPS))


def test_the_same_project_gives_the_same_bytes(tmp_path, media, root):
    outs = []
    for name in ("a", "b"):
        pdir = tmp_path / name
        _busy_project(pdir, media["video"])
        outs.append(_render(pdir, root, tmp_path / "out" / f"{name}.mp4")[0])
    again, res = _render(tmp_path / "b", root, tmp_path / "out" / "b-again.mp4")
    assert res["chunks"]["encoded"] == []
    assert outs[0].read_bytes() == outs[1].read_bytes() == again.read_bytes()


def test_a_caption_change_reencodes_only_the_chunks_it_shows_in(tmp_path, media, root):
    pdir = tmp_path / "p"
    _, words = _project(pdir, media["long"], keep=((0.3, 61.5),))
    _, res = _render(pdir, root, tmp_path / "out" / "before.mp4")
    spans = chunks.plan(round(res["duration"] * FPS), FPS)
    assert len(spans) == res["chunks"]["total"] >= 30
    cues_before = json.loads((pdir / "work" / "captions.json").read_text(encoding="utf-8"))["cues"]

    _fix_caption(pdir, words, 31.0, "CHANGED")
    after, res = _render(pdir, root, tmp_path / "out" / "after.mp4")
    cues_after = json.loads((pdir / "work" / "captions.json").read_text(encoding="utf-8"))["cues"]
    changed = [c for c in cues_after if c not in cues_before]
    assert changed and max(c["e"] for c in changed) - min(c["s"] for c in changed) < 2.0
    a, b = min(c["s"] for c in changed), max(c["e"] for c in changed)
    shows = [i for i, (f0, f1) in enumerate(spans)
             if f0 / FPS < b + chunks.CAPTION_MARGIN and f1 / FPS > a - chunks.CAPTION_MARGIN]
    assert res["chunks"]["encoded"] == shows and len(shows) <= 2, (res["chunks"], a, b)

    full, _ = _fresh_render(pdir, root, tmp_path / "out" / "full.mp4")
    _same_frames(after, full)


@pytest.mark.skipif("zscale" not in tools.filters(), reason="this FFmpeg has no zscale: HDR takes are not tone-mapped")
def test_an_edited_hdr_take_is_the_full_render(tmp_path, root):
    pdir = tmp_path / "p"
    words = _project(pdir, _take(tmp_path / "media" / "hlg.mp4", 8.0, hdr=True), keep=((0.4, 7.6),),
                     source={"hdr": True})[1]
    _render(pdir, root, tmp_path / "out" / "first.mp4")
    _fix_caption(pdir, words, 4.0, "HDR")
    chunked, res = _render(pdir, root, tmp_path / "out" / "chunked.mp4")
    assert 0 < len(res["chunks"]["encoded"]) < res["chunks"]["total"]
    full, _ = _fresh_render(pdir, root, tmp_path / "out" / "full.mp4")
    _same_frames(chunked, full)


def test_a_take_with_uneven_frame_times_is_rendered_in_one_pass(tmp_path, root):
    """The single pass's frame clock on such a take depends on every frame time before it, which a chunk
    starting inside a cut can't reproduce (it differed from frame 180 on)."""
    pdir = tmp_path / "p"
    _busy_project(pdir, _take(tmp_path / "media" / "vfr.mp4", 14.0, uneven=True))
    mp4, res = _render(pdir, root, tmp_path / "out" / "final.mp4")
    assert res["chunks"] is None
    single, _ = _render(pdir, root, tmp_path / "out" / "single.mp4", chunked=False)
    assert mp4.read_bytes() == single.read_bytes()


def test_a_chunk_that_fails_falls_back_to_one_pass(tmp_path, media, root, monkeypatch):
    pdir = tmp_path / "p"
    _project(pdir, media["video"], keep=((0.5, 13.0),))

    def broken(*args, **kwargs):
        raise RuntimeError("no chunks today")
    monkeypatch.setattr(render, "chunked_video", broken)
    mp4, res = _render(pdir, root, tmp_path / "out.mp4")
    assert res["chunks"] is None
    assert len(_framemd5(mp4)) > 0
