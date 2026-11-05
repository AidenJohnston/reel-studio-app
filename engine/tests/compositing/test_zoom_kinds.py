"""Measure named zoom framing and subpixel motion on generated media."""
import subprocess

import numpy as np
import pytest

import fixtures as fx
from reelengine import render, zoom
from reelengine.render_ctx import RenderCtx, Segment, ZoomSpan

W, H, FPS = 360, 640, 30


def context(tmp_path, project, fps=FPS):
    return RenderCtx(project, tmp_path, tmp_path, [Segment("s1", 0, 4, 0)],
                     {"w0": 0.5, "w1": 3.4}.__getitem__, {"w0", "w1"}.__contains__, 4,
                     {"width": W, "height": H, "fps": fps}, False, tmp_path,
                     fx.FFMPEG, fx.FFPROBE, lambda *args: None,
                     word_out_end={"w0": 0.8, "w1": 3.7}.__getitem__)


def encode(ctx, take, spans, name, t_shift=0, dur=4, full=False):
    graph, out = ctx.work / f"{name}.txt", ctx.work / f"{name}.mp4"
    cmd = render.build_video_cmd(ctx, ctx.out_timeline,
                                {"s1": {"width": W, "height": H, "fps": FPS}}, {"s1": take}, {},
                                W, H, [], spans, None, take, t_shift, dur, t_shift, "libx264", out, graph,
                                fast=False)
    subprocess.run(cmd, cwd=ctx.work, capture_output=True, check=True)
    raw = subprocess.run([fx.FFMPEG, "-v", "error", "-i", str(out), "-vf", "format=gray" if full else f"crop={W}:2:0:{H//2}",
                          "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True, check=True).stdout
    if full:
        return np.frombuffer(raw, np.uint8).reshape(-1, H, W)
    return np.frombuffer(raw, np.uint8).reshape(-1, 2, W)[:, 0].astype(float)


@pytest.fixture(scope="module")
def take(tmp_path_factory):
    path = tmp_path_factory.mktemp("zoom kinds") / "box.mp4"
    subprocess.run([fx.FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i",
                    f"color=c=0x404040:s={W}x{H}:r={FPS}:d=4,"
                    f"drawbox=x=108:y=200:w=144:h=240:color=0xe0e0e0:t=fill",
                    "-f", "lavfi", "-i", "sine=f=220:d=4:sample_rate=48000",
                    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac",
                    "-shortest", str(path)], check=True)
    return path


@pytest.fixture(scope="module")
def feature_take(tmp_path_factory):
    from PIL import Image

    path = tmp_path_factory.mktemp("zoom feature") / "feature.png"
    yy, xx = np.mgrid[:H, :W]
    image = 32 + 48 * ((xx // 6 + yy // 6) % 2)
    # An isolated Gaussian has a measurable subpixel centroid. Texture elsewhere
    # exercises the real encoder without contaminating that known feature.
    image[450:580, 235:345] = 32
    image[60:200, 15:125] = 32
    for x, y in ((280, 500), (80, 140)):
        image = image + 190 * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * 5 ** 2))
    Image.fromarray(np.clip(image, 0, 255).astype(np.uint8)).save(path)
    take = path.with_suffix(".mp4")
    subprocess.run([fx.FFMPEG, "-y", "-v", "error", "-loop", "1", "-framerate", str(FPS), "-i", str(path),
                    "-f", "lavfi", "-i", "sine=f=220:d=6:sample_rate=48000", "-t", "6",
                    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "8", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", str(take)], check=True)
    return take


@pytest.mark.parametrize("kind", ["drift", "ramps", "snap"])
def test_zoom_features_never_reverse(tmp_path, feature_take, kind):
    ctx = context(tmp_path, {})
    ctx.out_timeline = [Segment("s1", 0, 6, 0)]
    if kind == "drift":
        spans = [ZoomSpan(0, 6, 1.15, W / 2, H / 2, ramp_in=6 * FPS - 1)]
    elif kind == "ramps":
        spans = [ZoomSpan(.5, 2.5, 1.15, W / 2, H / 2, ramp_in=15, ramp_out=15),
                 ZoomSpan(3, 5.5, 1.2, W / 2, H / 2, ramp_in=15, ramp_out=15)]
    else:
        spans = [ZoomSpan(.5, 5.5, 1.15, W / 2, H / 2, ramp_in=7, ramp_out=9, blur=True)]
    frames = encode(ctx, feature_take, spans, "feature", dur=6, full=True)
    assert len(frames) == 6 * FPS
    # Each fixed ROI contains one feature's entire journey. Subtracting above
    # the background removes codec ringing; it does not predict the motion.
    for sign, (x0, y0, x1, y1) in ((1, (260, 480, 320, 555)), (-1, (40, 85, 100, 165))):
        weights = np.maximum(frames[:, y0:y1, x0:x1].astype(float) - 50, 0)
        yy, xx = np.mgrid[y0:y1, x0:x1]
        mass = weights.sum(axis=(1, 2))
        assert np.all(mass > 1000), "tracking feature disappeared"
        positions = np.column_stack(((weights * xx).sum(axis=(1, 2)) / mass,
                                     (weights * yy).sum(axis=(1, 2)) / mass))
        for span in spans:
            a, b = round(span.t0 * FPS), round(span.t1 * FPS)
            held = min(a + span.ramp_in, b - 1)
            assert np.all(sign * (positions[held] - positions[a]) > [5, 10]), "zoom stopped moving"
            phases = [sign * np.diff(positions[a:held + 1], axis=0)]
            if span.ramp_out:
                # Include both handoffs between a moving ramp and the hold.
                release = b - span.ramp_out
                phases += [-sign * np.diff(positions[release - 1:b], axis=0)]
            backward = np.maximum(0, -np.concatenate(phases)).max(axis=0)
            assert np.all(backward <= 0.1), f"{kind}, feature {sign}, backward x/y: {backward} px"


def widths(rows):
    return np.array([np.count_nonzero(row > (row[:30].mean() + row[160:200].mean()) / 2) for row in rows])


@pytest.mark.parametrize("kind", ["punch", "snap", "drift"])
def test_named_kinds_render(tmp_path, take, kind):
    item = {"anchor": {"from": "w0", "to": "w1"}, "scale": 1.3, "focus": [0.5, 0.5]}
    ctx = context(tmp_path, {"zooms": [dict(item, kind=kind, **({"style": "snap"} if kind != "snap" else {}))]})
    spans = zoom.build_zooms(ctx, with_broll=False)
    rows = encode(ctx, take, spans, "named")
    if kind == "drift":
        sizes = widths(rows)[round(spans[0].t0 * FPS):round(spans[0].t1 * FPS)]
        assert sizes[-1] - sizes[0] > 30, "drift rendered static instead of moving toward its target"
        assert sizes[0] == pytest.approx(144, abs=2)
        assert sizes[-1] == pytest.approx(144 * 1.3, abs=2)
        assert np.all(np.diff(sizes) >= -1), sizes
        assert sizes[25] > 144 * 1.3 - (144 * 0.3) / 2  # ease-out, not linear
        # A hard edge stays sharp while the picture moves, rather than receiving snap's shutter blur.
        row = rows[20]
        lo, hi = row[:30].mean(), row[160:200].mean()
        edge = row[:W//2]
        assert np.argmax(edge > lo + .9 * (hi - lo)) - np.argmax(edge > lo + .1 * (hi - lo)) <= 2
    else:
        legacy = dict(item, **({"style": "snap"} if kind == "snap" else {}))
        ctx.project = {"zooms": [legacy]}
        expected = encode(ctx, take, zoom.build_zooms(ctx, with_broll=False), "legacy")
        assert np.array_equal(rows, expected)


@pytest.mark.parametrize("fps", [24, 30])
def test_frame_ramps_render_and_window_keeps_progress(tmp_path, take, fps):
    ctx = context(tmp_path, {}, fps=fps)
    z = ZoomSpan(0.5, 3.5, 1.3, W/2, H/2, ramp_in=12, ramp_out=12)
    rows = encode(ctx, take, [z], "ramps")
    sizes = widths(rows)
    assert sizes[round(.5 * fps)] == pytest.approx(144, abs=2)
    assert sizes[round(1 * fps)] == pytest.approx(144 * 1.3, abs=2)
    assert sizes[round(3.5 * fps) - 1] < sizes[round(3 * fps)] - 25
    # A render window starting halfway into the entrance must not restart the ramp.
    ctx.out_timeline = [Segment("s1", .75, 1.25, 0)]
    window = encode(ctx, take, [z], "window", t_shift=.75, dur=.5)
    assert widths(window)[0] == pytest.approx(sizes[round(.75 * fps)], abs=1)


def test_multiple_ramps_keep_their_own_crop(tmp_path, take):
    ctx = context(tmp_path, {})
    spans = [ZoomSpan(.5, 1.5, 1.3, W/2, H/2, ramp_in=12),
             ZoomSpan(2, 3.5, 1.6, W/2, H/2, ramp_in=12)]
    combined = widths(encode(ctx, take, spans, "combined"))
    for i, span in enumerate(spans):
        alone = widths(encode(ctx, take, [span], f"alone{i}"))
        a, b = round(span.t0 * FPS), round(span.t1 * FPS)
        # Once the entrance ends, the zoom must hold instead of running its curve backward.
        held = combined[a + span.ramp_in:b]
        assert np.all(np.abs(held - 144 * span.scale) <= 2), held
        assert np.max(np.abs(combined[a:b] - alone[a:b])) <= 1


@pytest.mark.parametrize("style,scale", [
    ({"preset": "clean"}, 1.10), ({"preset": "hyper"}, 1.30),
    ({"preset": "punchline"}, 1.25), ({"preset": "standard"}, 1.15),
    (None, 1.15), ([], 1.15), ({"preset": []}, 1.15), ({"preset": "future"}, 1.15),
])
def test_named_zoom_defaults_read_cut_style_defensively(tmp_path, style, scale):
    ctx = context(tmp_path, {"cutStyle": style, "zooms": [
        {"kind": "drift", "anchor": {"from": "w0", "to": "w1"}, "focus": [0.5, 0.5]}]})
    [z] = zoom.build_zooms(ctx, with_broll=False)
    assert z.scale == scale
    assert z.ramp_in == round((z.t1 - z.t0) * FPS) - 1
    assert z.ramp_out == 0


def test_drift_spans_keep_ramping_when_truncated(tmp_path):
    ctx = context(tmp_path, {"zooms": [
        {"kind": "drift", "scale": 1.3, "anchor": {"from": "w0", "to": "w1"}, "focus": [0.5, 0.5]},
        {"kind": "punch", "scale": 1.2, "anchor": {"from": "w1", "to": "w1"}, "focus": [0.5, 0.5]}]})
    ctx.out_timeline.append(Segment("s1", 5, 6, 2))
    a, b = zoom.build_zooms(ctx, with_broll=False)
    assert a.t1 == b.t0
    assert a.ramp_in == round((a.t1 - a.t0) * FPS) - 1


def test_project_schema_rejects_unknown_zoom_kind():
    from reelengine import project
    p = project.new_project("zoom")
    p["zooms"] = [{"kind": "spin", "scale": 1.2, "anchor": {"from": "w0", "to": "w1"}}]
    assert any("kind" in problem for problem in project.validate(p))
