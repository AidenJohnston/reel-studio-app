"""A long take cut short opens a new, seeked input across each long gap of cut-away footage
(render.video_lanes), and every segment still starts on its exact source frame."""
import subprocess
import wave
from pathlib import Path

import numpy as np

from reelengine import render, tools
from reelengine.render_ctx import RenderCtx, Segment

FPS = 30
W, H = 192, 320
BITS = 11          # frame numbers up to 2047, one bit per cell of a 4 x 3 grid
CELL_W, CELL_H = 48, 107


def _segments(frame_spans):
    out, t = [], 0.0
    for a, b in frame_spans:
        out.append(Segment("s1", a / FPS, b / FPS, t))
        t += (b - a) / FPS
    return out, t


# Source frames [a, b) kept, in order: the first two sit 0.2 s apart (one input), the last two are
# 15 s and 18 s past the previous segment, beyond MIN_SEEK_GAP, so each gets its own input.
SPANS = [(30, 90), (96, 150), (600, 660), (1200, 1260)]


def _cmd(tmp_path, src: Path, segs, dur):
    ctx = RenderCtx(project={}, project_dir=tmp_path, root=tmp_path, out_timeline=segs,
                    word_out_time=lambda _w: 0.0, duration=dur, fmt={"width": W, "height": H, "fps": FPS},
                    draft=False, work=tmp_path, ffmpeg=tools.ffmpeg(), ffprobe="ffprobe",
                    progress=lambda *a: None)
    audio = tmp_path / "voice.wav"
    with wave.open(str(audio), "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(48000)
        wf.writeframes(bytes(4 * int(48000 * (dur + 1))))
    meta = {"s1": {"width": W, "height": H, "fps": FPS, "rotation": 0}}
    return render.build_video_cmd(ctx, segs, meta, {"s1": src}, {}, W, H, [], [], None, audio, 0.0, dur, 0.0,
                                  "libx264", tmp_path / "out.mp4", tmp_path / "graph.txt")


def _source_seeks(cmd, src: Path):
    """The input seek (or None) of every ffmpeg input that opens `src`, in input order."""
    seeks, pending = [], None
    for i, arg in enumerate(cmd):
        if arg == "-ss":
            pending = cmd[i + 1]
        elif arg == "-i":
            if cmd[i + 1] == str(src):
                seeks.append(pending)
            pending = None
    return seeks


def test_far_segments_are_reached_by_their_own_input_seek(tmp_path):
    src = tmp_path / "take.mp4"
    segs, dur = _segments(SPANS)
    # 20 s and 40 s less SEEK_PREROLL; the first input starts at the top (1 s - preroll < 0)
    assert _source_seeks(_cmd(tmp_path, src, segs, dur), src) == [None, "17", "37"]


def test_heavy_cut_opens_at_most_max_lanes_inputs_skipping_the_largest_gaps():
    gaps = [6, 30, 7, 50, 8, 40, 9, 20]           # all longer than MIN_SEEK_GAP; room for 5 splits
    segs, t = [Segment("s1", 10.0, 11.0, 0.0)], 11.0
    for g in gaps:
        segs.append(Segment("s1", t + g, t + g + 1.0, float(len(segs))))
        t += g + 1.0
    lanes = render.video_lanes(segs)
    # MAX_VIDEO_LANES (6) inputs: the five largest gaps (50, 40, 30, 20, 9 s) start new ones
    assert [l["segs"] for l in lanes] == [[0, 1], [2, 3], [4, 5], [6], [7], [8]]
    assert [l["seek"] for l in lanes] == [7.0, 45.0, 104.0, 154.0, 164.0, 185.0]


def _numbered_source(path: Path, seconds: float) -> None:
    """Each frame shows its own number in binary, one bit per cell (white = 1)."""
    cell = f"(floor(X/{CELL_W})+4*floor(Y/{CELL_H}))"
    lum = f"if(lt({cell},{BITS}),16+219*mod(floor(N/pow(2,{cell})),2),128)"
    subprocess.run([tools.ffmpeg(), "-y", "-v", "error", "-f", "lavfi", "-i",
                    f"color=c=gray:s={W}x{H}:r={FPS}:d={seconds},format=yuv420p,geq=lum='{lum}':cb=128:cr=128",
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-g", str(FPS), "-pix_fmt", "yuv420p",
                    str(path)], check=True)


def _frame_numbers(path: Path) -> list:
    raw = subprocess.run([tools.ffmpeg(), "-v", "error", "-i", str(path), "-f", "rawvideo", "-pix_fmt", "gray", "-"],
                         capture_output=True, check=True).stdout
    frames = np.frombuffer(raw, np.uint8).reshape(-1, H, W)
    out = []
    for f in frames:
        n = 0
        for c in range(BITS):
            x, y = (c % 4) * CELL_W + CELL_W // 2, (c // 4) * CELL_H + CELL_H // 2
            n |= int(f[y - 8:y + 8, x - 8:x + 8].mean() > 128) << c
        out.append(n)
    return out


def test_each_seeked_segment_starts_on_its_exact_source_frame(tmp_path):
    src = tmp_path / "take.mp4"
    _numbered_source(src, 44)
    segs, dur = _segments(SPANS)
    cmd = _cmd(tmp_path, src, segs, dur)
    subprocess.run(cmd, cwd=tmp_path, capture_output=True, check=True)
    expected = [n for a, b in SPANS for n in range(a, b)]
    assert _frame_numbers(tmp_path / "out.mp4") == expected
