"""HDR (HLG/PQ) footage in drafts: the tonemap runs on the cropped, scaled frame, with hardware
decode where the platform has one that hands frames back to system memory. Finals keep
tonemap-then-scale and software decode, so their bytes don't change."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image

import fixtures as fx
from reelengine import probe, render, tools
from reelengine.render_ctx import Segment

HLG_SRC = {"id": "s1", "width": 2160, "height": 3840, "rotation": 0, "fps": 30, "hdr": True}


def _graph(tmp_path, monkeypatch, *, draft: bool, platform: str, use_hw: bool = True):
    """build_video_cmd for one 2 s segment of a 4K HLG take: (command, filter graph text)."""
    monkeypatch.setattr(sys, "platform", platform)
    monkeypatch.delenv("REELENGINE_HWACCEL", raising=False)
    monkeypatch.setattr(tools, "_CACHE", {"hwaccels": {"cuda", "dxva2", "qsv", "d3d11va", "videotoolbox"},
                                          "version": (7, 1)})
    # what hwaccel() picks on a machine whose NVENC works / on a Mac
    monkeypatch.setattr(tools, "hwaccel", lambda: "cuda" if platform == "win32" else "videotoolbox")
    monkeypatch.setattr(tools, "filters", lambda: {"zscale", "tonemap", "subtitles"})   # no scale_cuda, as shipped
    ctx = SimpleNamespace(ffmpeg="ffmpeg", fmt={"width": 1080, "height": 1920, "fps": 30}, draft=draft)
    w, h = (540, 960) if draft else (1080, 1920)
    graph = tmp_path / "graph.txt"
    cmd = render.build_video_cmd(ctx, [Segment("s1", 1.0, 3.0, 0.0)], {"s1": HLG_SRC}, {"s1": Path("take.mov")},
                                 {}, w, h, [], [], None, Path("voice.wav"), 0.0, 2.0, 0.0,
                                 "libx264", tmp_path / "out.mp4", graph, use_hw=use_hw)
    return cmd, graph.read_text(encoding="utf-8")


@pytest.mark.parametrize("platform,decoder", [("win32", "d3d11va"), ("darwin", "videotoolbox")])
def test_draft_tonemaps_after_the_scale_with_hardware_decode(tmp_path, monkeypatch, platform, decoder):
    cmd, graph = _graph(tmp_path, monkeypatch, draft=True, platform=platform)
    assert f"setpts=PTS-STARTPTS,scale=540:960:flags=fast_bilinear,{render.HDR_CHAIN},setsar=1[v0]" in graph
    # frames come back to system memory for zscale; on Windows never CUDA, which this FFmpeg can't decode with
    assert cmd[cmd.index("-hwaccel") + 1] == decoder
    assert cmd.index("-hwaccel") < cmd.index("take.mov")
    assert "-hwaccel_output_format" not in cmd


def test_software_retry_keeps_the_draft_order(tmp_path, monkeypatch):
    cmd, graph = _graph(tmp_path, monkeypatch, draft=True, platform="win32", use_hw=False)
    assert "-hwaccel" not in cmd
    assert f"scale=540:960:flags=fast_bilinear,{render.HDR_CHAIN},setsar=1[v0]" in graph


@pytest.mark.parametrize("platform", ["win32", "darwin"])
def test_final_tonemaps_first_and_decodes_in_software(tmp_path, monkeypatch, platform):
    cmd, graph = _graph(tmp_path, monkeypatch, draft=False, platform=platform)
    assert (f"setpts=PTS-STARTPTS,{render.HDR_CHAIN},scale=1080:1920:flags=lanczos,format=yuv420p,setsar=1[v0]"
            in graph)
    assert "-hwaccel" not in cmd


# --- a real HLG render ---------------------------------------------------------------------------

def hlg_take(path: Path, dur: float = 4.0) -> Path:
    """10-bit H.264 tagged HLG/BT.2020: red top-left, blue top-right, grey below."""
    path.parent.mkdir(parents=True, exist_ok=True)
    w, h = 1080, 1920
    vf = (f"color=c=0x808080:s={w}x{h}:r=30:d={dur},"
          f"drawbox=x=0:y=0:w={w // 2}:h={h // 2}:color=0xd02020:t=fill,"
          f"drawbox=x={w // 2}:y=0:w={w // 2}:h={h // 2}:color=0x2020d0:t=fill")
    subprocess.run([fx.FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i", vf,
                    "-f", "lavfi", "-i", f"sine=f=220:d={dur}:sample_rate=48000",
                    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p10le",
                    "-colorspace", "bt2020nc", "-color_primaries", "bt2020", "-color_trc", "arib-std-b67",
                    "-c:a", "aac", "-shortest", str(path)], check=True)
    return path


def _picture(mp4: Path, out: Path, size: tuple) -> np.ndarray:
    """The frame at 1.5 s, at `size`, top half only (the captions sit lower)."""
    subprocess.run([fx.FFMPEG, "-y", "-v", "error", "-ss", "1.5", "-i", str(mp4), "-frames:v", "1", str(out)],
                   check=True)
    im = Image.open(out).convert("RGB").resize(size, Image.BOX)
    return np.asarray(im, dtype=np.float64)[: size[1] // 2]


def test_hlg_draft_has_the_final_colors(tmp_path, monkeypatch):
    if "zscale" not in tools.filters():
        pytest.skip("this FFmpeg has no zscale, so it never tonemaps")
    take = hlg_take(tmp_path / "media" / "hlg.mp4")
    assert probe.probe(take)["hdr"]
    pdir = tmp_path / "proj"
    fx.make_project(pdir, take, keep=((0.5, 3.5),))
    p = json.loads((pdir / "project.json").read_text(encoding="utf-8"))
    p["sources"][0]["hdr"] = True
    (pdir / "project.json").write_text(json.dumps(p, indent=1), encoding="utf-8")
    # the software path, which every machine falls back to (the hardware one is checked by the harness)
    monkeypatch.setattr(tools, "hwaccel", lambda: None)
    monkeypatch.setattr(tools, "hwaccel_to_memory", lambda: None)
    draft = render.run(pdir, draft=True, root=tmp_path, verify=False, cover=False)
    final = render.run(pdir, draft=False, root=tmp_path, verify=False)
    d = _picture(Path(draft["file"]), tmp_path / "d.png", (540, 960))
    f = _picture(Path(final["file"]), tmp_path / "f.png", (540, 960))
    red, blue = d[40:440, 20:250].mean(axis=(0, 1)), d[40:440, 290:520].mean(axis=(0, 1))
    assert red[0] > red[2] and blue[2] > blue[0]                                    # a picture, not a wash
    for region in (np.s_[40:440, 20:250], np.s_[40:440, 290:520]):
        assert np.abs(d[region].mean(axis=(0, 1)) - f[region].mean(axis=(0, 1))).max() < 3.0
