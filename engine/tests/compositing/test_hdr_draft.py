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
from reelengine.proto import EngineError
from reelengine.render_ctx import Segment

HLG_SRC = {"id": "s1", "width": 2160, "height": 3840, "rotation": 0, "fps": 30, "hdr": True}


def _graph(tmp_path, monkeypatch, *, draft: bool, platform: str, fast: bool = True, encoder: str = "libx264",
           hdr: tuple = (True,)):
    """build_video_cmd for a 2 s segment of each take, 4K, HLG where `hdr` says so: (command, graph text)."""
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
    ids = [f"s{i}" for i in range(1, len(hdr) + 1)]
    segs = [Segment(sid, 1.0, 3.0, 2.0 * i) for i, sid in enumerate(ids)]
    cmd = render.build_video_cmd(ctx, segs, {sid: {**HLG_SRC, "id": sid, "hdr": h} for sid, h in zip(ids, hdr)},
                                 {sid: Path(f"take-{sid}.mov") for sid in ids}, {}, w, h, [], [], None,
                                 Path("voice.wav"), 0.0, 2.0 * len(hdr), 0.0, encoder, tmp_path / "out.mp4", graph,
                                 fast=fast)
    return cmd, graph.read_text(encoding="utf-8")


@pytest.mark.parametrize("platform,decoder", [("win32", "d3d11va"), ("darwin", "videotoolbox")])
def test_draft_tonemaps_after_the_scale_with_hardware_decode(tmp_path, monkeypatch, platform, decoder):
    cmd, graph = _graph(tmp_path, monkeypatch, draft=True, platform=platform)
    assert f"setpts=PTS-STARTPTS,scale=540:960:flags=fast_bilinear,{render.HDR_CHAIN},setsar=1[v0]" in graph
    # frames come back to system memory for zscale; on Windows never CUDA, which this FFmpeg can't decode with
    assert cmd[cmd.index("-hwaccel") + 1] == decoder
    assert cmd.index("-hwaccel") < cmd.index("take-s1.mov")
    assert "-hwaccel_output_format" not in cmd


def test_nvenc_never_gets_the_decoders_d3d11_device(tmp_path, monkeypatch):
    """ffmpeg hands NVENC a device it opened, CUDA before D3D11, and NVENC fails on the decoder's
    D3D11 device; so a CUDA device must be open too. Devices are global options: before the first
    input even when that input is SDR, and once each, as ffmpeg refuses a second device with a name."""
    cmd, _ = _graph(tmp_path, monkeypatch, draft=True, platform="win32", encoder="h264_nvenc",
                    hdr=(False, True, True))
    first_input = cmd.index("-i")
    assert sorted(cmd[j + 1] for j in range(first_input) if cmd[j] == "-init_hw_device") == ["cuda=enc", "d3d11va=dec"]
    assert cmd.count("-init_hw_device") == 2
    assert "-hwaccel" not in cmd[: cmd.index("take-s1.mov")]               # the SDR take: unchanged
    for take in ("take-s2.mov", "take-s3.mov"):
        i = cmd.index(take)
        h = max(j for j in range(i) if cmd[j] == "-hwaccel")
        assert cmd[h:h + 4] == ["-hwaccel", "d3d11va", "-hwaccel_device", "dec"]
        assert cmd[i - 1] == "-i" and "-i" not in cmd[h:i - 1]           # ...as options of this input


def test_retry_is_the_draft_from_before(tmp_path, monkeypatch):
    """The retry must not repeat what may have failed: hardware decode, or `scale` refusing the
    source's colour matrix before zscale sees it."""
    cmd, graph = _graph(tmp_path, monkeypatch, draft=True, platform="win32", fast=False)
    assert "-hwaccel" not in cmd
    assert (f"setpts=PTS-STARTPTS,{render.HDR_CHAIN},scale=540:960:flags=fast_bilinear,format=yuv420p,setsar=1[v0]"
            in graph)


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
    # The -color_* flags alone left the transfer out of the stream (FFmpeg 7.1.1, Windows 11), and the
    # engine decides HDR from it (probe.HDR_TRANSFERS): write it into the SPS as H.273 codes instead.
    subprocess.run([fx.FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i", vf,
                    "-f", "lavfi", "-i", f"sine=f=220:d={dur}:sample_rate=48000",
                    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p10le",
                    "-bsf:v", "h264_metadata=colour_primaries=9:transfer_characteristics=18:"
                              "matrix_coefficients=9:video_full_range_flag=0",
                    "-c:a", "aac", "-shortest", str(path)], check=True)
    return path


def _picture(mp4: Path, out: Path, size: tuple) -> np.ndarray:
    """The frame at 1.5 s, at `size`, top half only (the captions sit lower)."""
    subprocess.run([fx.FFMPEG, "-y", "-v", "error", "-ss", "1.5", "-i", str(mp4), "-frames:v", "1", str(out)],
                   check=True)
    im = Image.open(out).convert("RGB").resize(size, Image.BOX)
    return np.asarray(im, dtype=np.float64)[: size[1] // 2]


@pytest.fixture(scope="module")
def take(tmp_path_factory):
    path = hlg_take(tmp_path_factory.mktemp("hlg media") / "hlg.mp4")
    assert probe.probe(path)["hdr"]
    return path


def _project(pdir: Path, take: Path) -> Path:
    fx.make_project(pdir, take, keep=((0.5, 3.5),))
    p = json.loads((pdir / "project.json").read_text(encoding="utf-8"))
    p["sources"][0]["hdr"] = True                      # as `init` records it from the probe
    (pdir / "project.json").write_text(json.dumps(p, indent=1), encoding="utf-8")
    return pdir


def test_hlg_draft_has_the_final_colors(tmp_path, monkeypatch, take):
    if "zscale" not in tools.filters():
        pytest.skip("this FFmpeg has no zscale, so it never tonemaps")
    pdir = _project(tmp_path / "proj", take)
    # the software path, which every machine falls back to (the hardware one is checked by the harness)
    monkeypatch.setattr(tools, "hwaccel", lambda: None)
    monkeypatch.setattr(tools, "hwaccel_to_memory", lambda encoder: ([], []))
    draft = render.run(pdir, draft=True, root=tmp_path, verify=False, cover=False)
    assert not any("fast preview path" in w for w in draft.get("warnings") or [])   # the new graph ran
    final = render.run(pdir, draft=False, root=tmp_path, verify=False)
    d = _picture(Path(draft["file"]), tmp_path / "d.png", (540, 960))
    f = _picture(Path(final["file"]), tmp_path / "f.png", (540, 960))
    red, blue = d[40:440, 20:250].mean(axis=(0, 1)), d[40:440, 290:520].mean(axis=(0, 1))
    assert red[0] > red[2] and blue[2] > blue[0]                                    # a picture, not a wash
    for region in (np.s_[40:440, 20:250], np.s_[40:440, 290:520]):
        assert np.abs(d[region].mean(axis=(0, 1)) - f[region].mean(axis=(0, 1))).max() < 3.0


@pytest.mark.parametrize("broken", ["decoder", "encoder", "timeout"])
def test_a_failed_hardware_decode_does_not_blame_the_gpu_encoder(tmp_path, monkeypatch, take, broken):
    """A draft that fails with hardware decode and a GPU encoder retries with software decode and the
    same encoder; only if that fails too is the encoder marked as failed (for days, tools.py). After
    a timeout it goes straight to libx264 and marks nothing, since nothing pointed at the encoder."""
    gpu = "mpeg4"                       # stands in for h264_nvenc: present in every FFmpeg build
    monkeypatch.setitem(tools.HW_ENCODER_OPTS, gpu, ["-q:v", "5"])
    monkeypatch.setattr(tools, "draft_encoder", lambda: gpu)
    monkeypatch.setattr(tools, "hwaccel", lambda: None)
    monkeypatch.setattr(tools, "hwaccel_to_memory", lambda encoder: ([], ["-hwaccel", "d3d11va"]))
    marked, hw_decode_per_attempt = [], []
    monkeypatch.setattr(tools, "mark_encoder_failed", marked.append)
    real = tools.ffmpeg_progress

    def progress(cmd, *a, **kw):
        if kw.get("what") == "video render":
            hw_decode, enc = "-hwaccel" in cmd, cmd[cmd.index("-c:v") + 1]
            hw_decode_per_attempt.append(hw_decode)
            if broken == "timeout" and hw_decode:
                raise EngineError("TIMEOUT", "simulated hang", "")
            if (broken == "decoder" and hw_decode) or (broken == "encoder" and enc == gpu):
                raise EngineError("FFMPEG_FAILED", f"simulated {broken} failure", "")
        return real(cmd, *a, **kw)

    monkeypatch.setattr(tools, "ffmpeg_progress", progress)
    res = render.run(_project(tmp_path / "proj", take), draft=True, root=tmp_path, verify=False, cover=False)
    assert hw_decode_per_attempt[0]                                  # the fast path used hardware decode
    if broken == "decoder":
        assert res["encoder"] == gpu and marked == []
    elif broken == "timeout":
        assert res["encoder"] == "libx264" and marked == []
    else:
        assert res["encoder"] == "libx264" and marked == [gpu]
