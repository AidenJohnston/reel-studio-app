"""A long take cut short opens a new, seeked input across each long gap of cut-away footage
(render.video_lanes), and every segment still starts on its exact source frame."""
import subprocess
import wave
from pathlib import Path

import numpy as np
import pytest

from reelengine import render, tools
from reelengine.render_ctx import RenderCtx, Segment

FPS = 30
W, H = 192, 320
BITS = 11          # frame numbers up to 2047, one bit per cell of a 4 x 3 grid
CELL_W, CELL_H = 48, 107
# Every frame 3n+1 or 3n+2 at 30 fps sits at a time no float prints exactly (31/30 = 1.0333...),
# which is where losing the half-frame margin would gain or drop a frame.
#
# Source frames [a, b) kept, in order: the first two 0.27 s apart (one input); the third and fourth
# 15.4 s and 18.4 s past the previous segment, beyond MIN_SEEK_GAP, so each gets its own input,
# seeked to 17.4 s and 37.4 s (neither exact in binary).
SPANS = [(31, 89), (97, 152), (613, 661), (1213, 1262)]
VFR_DROP = "not(eq(mod(n,7),3))*not(eq(mod(n,11),5))"      # frame durations of 1/30 and 2/30 s


def _segments(frame_spans):
    out, t = [], 0.0
    for a, b in frame_spans:
        out.append(Segment("s1", a / FPS, b / FPS, t))
        t += (b - a) / FPS
    return out, t


SDR = {"width": W, "height": H, "fps": FPS, "rotation": 0}


def _cmd(work: Path, src: Path, segs, dur, meta=SDR):
    work.mkdir(parents=True, exist_ok=True)
    ctx = RenderCtx(project={}, project_dir=work, root=work, out_timeline=segs,
                    word_out_time=lambda _w: 0.0, duration=dur, fmt={"width": W, "height": H, "fps": FPS},
                    draft=False, work=work, ffmpeg=tools.ffmpeg(), ffprobe="ffprobe",
                    progress=lambda *a: None)
    audio = work / "voice.wav"
    with wave.open(str(audio), "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(48000)
        wf.writeframes(bytes(4 * int(48000 * (dur + 1))))
    return render.build_video_cmd(ctx, segs, {"s1": meta}, {"s1": src}, {}, W, H, [], [], None, audio, 0.0, dur, 0.0,
                                  "libx264", work / "out.mp4", work / "graph.txt")


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
    # the first input starts at the top (1.03 s - SEEK_PREROLL < 0)
    assert _source_seeks(_cmd(tmp_path, src, segs, dur), src) == [None, "17.4", "37.4"]


def test_forward_cut_adds_seeks_only_at_its_largest_gaps_up_to_the_cap():
    gaps = [6, 30, 7, 50, 8, 40, 9, 20]           # all longer than MIN_SEEK_GAP; room for 2 splits
    segs, t = [Segment("s1", 10.0, 11.0, 0.0)], 11.0
    for g in gaps:
        segs.append(Segment("s1", t + g, t + g + 1.0, float(len(segs))))
        t += g + 1.0
    lanes = render.video_lanes(segs)
    # MAX_VIDEO_LANES (3) inputs: the two largest gaps (50 and 40 s) start new ones
    assert [l["segs"] for l in lanes] == [[0, 1, 2, 3], [4, 5], [6, 7, 8]]
    assert [l["seek"] for l in lanes] == [7.0, 104.0, 154.0]


def test_reordered_cut_keeps_the_inputs_it_needs_and_adds_no_seek_past_the_cap():
    # Four descending segments need four forward-only inputs, as on main; the 19 s gap on the first
    # lane (41 s -> 60 s) would earn a seek, but the cut is already past MAX_VIDEO_LANES (3).
    segs = [Segment("s1", a, a + 1.0, float(k)) for k, a in enumerate([40.0, 30.0, 20.0, 10.0, 60.0])]
    lanes = render.video_lanes(segs)
    assert [l["segs"] for l in lanes] == [[0, 4], [1], [2], [3]]
    assert [l["seek"] for l in lanes] == [37.0, 27.0, 17.0, 7.0]


def _input_args(cmd, src: Path):
    """For every ffmpeg input that opens `src`, the options given before its -i, minus -ss."""
    out, cur, i = [], [], 4               # past: ffmpeg -y -nostdin -hide_banner
    while i < len(cmd):
        if cmd[i] == "-i":
            if cmd[i + 1] == str(src):
                out.append(cur)
            cur, i = [], i + 2
        elif cmd[i] == "-ss":
            i += 2
        else:
            cur.append(cmd[i])
            i += 1
    return out


def _segment_chains(graph: Path) -> list:
    """The per-segment picture chain (after the trim, before setsar) of every video segment."""
    chains = []
    for line in graph.read_text(encoding="utf-8").split(";\n"):
        if "]trim=start=" in line:
            chains.append(line.split("setpts=PTS-STARTPTS,", 1)[1].rsplit(",setsar=1[", 1)[0])
    return chains


@pytest.mark.parametrize("meta, opts, marker", [
    ({"width": H, "height": W, "fps": FPS, "rotation": 90},                       # stored sideways
     ["-display_rotation", "0", "-noautorotate"], "transpose=clock"),
    ({"width": W, "height": H, "fps": FPS, "rotation": 0, "hdr": True}, ["-noautorotate"], "tonemap=tonemap=hable"),
], ids=["rotated", "hlg"])
def test_every_seeked_input_of_a_rotated_or_hlg_take_gets_the_same_processing(tmp_path, meta, opts, marker):
    src = tmp_path / "take.mp4"
    segs, dur = _segments(SPANS)
    cmd = _cmd(tmp_path, src, segs, dur, meta)
    args = _input_args(cmd, src)
    assert args == [opts] * 3
    chains = _segment_chains(tmp_path / "graph.txt")
    assert len(chains) == len(SPANS) and len(set(chains)) == 1 and marker in chains[0]


def _numbered_source(path: Path, seconds: float, vfr: bool = False) -> None:
    """Each frame shows its source frame number in binary, one bit per cell (white = 1). With
    `vfr`, some frames are dropped, so the rest keep their numbers at uneven intervals."""
    cell = f"(floor(X/{CELL_W})+4*floor(Y/{CELL_H}))"
    lum = f"if(lt({cell},{BITS}),16+219*mod(floor(N/pow(2,{cell})),2),128)"
    graph = f"color=c=gray:s={W}x{H}:r={FPS}:d={seconds},format=yuv420p,geq=lum='{lum}':cb=128:cr=128"
    if vfr:
        graph += f",select='{VFR_DROP}'"
    subprocess.run([tools.ffmpeg(), "-y", "-v", "error", "-f", "lavfi", "-i", graph,
                    *(["-fps_mode", "vfr"] if vfr else []),
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


def _render(work: Path, src: Path) -> tuple:
    segs, dur = _segments(SPANS)
    cmd = _cmd(work, src, segs, dur)
    subprocess.run(cmd, cwd=work, capture_output=True, check=True)
    return _frame_numbers(work / "out.mp4"), len(_source_seeks(cmd, src))


def test_each_seeked_segment_starts_on_its_exact_source_frame(tmp_path):
    src = tmp_path / "take.mp4"
    _numbered_source(src, 44)
    frames, inputs = _render(tmp_path / "out", src)
    assert inputs == 3
    assert frames == [n for a, b in SPANS for n in range(a, b)]


def test_seeked_render_of_a_vfr_take_matches_the_single_lane_render(tmp_path, monkeypatch):
    # A VFR take has no exact answer to write down (which frame a cut lands on depends on the
    # dropped ones), so the reference is the path every render used before: one input, no seeks.
    src = tmp_path / "take.mp4"
    _numbered_source(src, 44, vfr=True)
    seeked, inputs = _render(tmp_path / "seeked", src)
    monkeypatch.setattr(render, "video_lanes", render.plan_lanes)
    single, one = _render(tmp_path / "single", src)
    assert (inputs, one) == (3, 1)
    assert seeked == single
