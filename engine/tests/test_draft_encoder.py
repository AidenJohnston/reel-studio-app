"""Draft encoder choice: which hardware H.264 encoder the binary lists AND this machine can open."""
import json
import subprocess
import sys

import pytest

from reelengine import render, tools


def _proc(rc):
    return subprocess.CompletedProcess([], rc, "", "")


@pytest.fixture
def fake(monkeypatch, tmp_path):
    """A fake ffmpeg: `listed` is what -encoders shows, `works` what really opens; `calls` logs probes."""
    exe = tmp_path / "ffmpeg.exe"
    exe.write_bytes(b"x")
    monkeypatch.setenv("REELENGINE_FFMPEG", str(exe))
    monkeypatch.setenv("REELENGINE_CACHE", str(tmp_path / "cache"))
    monkeypatch.delenv("REELENGINE_DRAFT_ENCODER", raising=False)
    monkeypatch.setattr(tools, "_CACHE", {})
    state = {"listed": set(), "works": set(), "calls": []}

    def text_run(cmd, timeout, what, check=True, **kw):
        if "-encoders" in cmd:
            lines = ["Encoders:", " ------"] + [f" V....D {n}  desc" for n in sorted(state["listed"])]
            return subprocess.CompletedProcess(cmd, 0, "\n".join(lines), "")
        enc = cmd[cmd.index("-c:v") + 1]
        state["calls"].append(enc)
        return _proc(0 if enc in state["works"] else 1)

    monkeypatch.setattr(tools, "text_run", text_run)
    return state


def fresh(monkeypatch):
    monkeypatch.setattr(tools, "_CACHE", {})


def test_picks_first_listed_encoder_that_works(fake, monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    fake["listed"] = {"libx264", "h264_nvenc", "h264_amf", "h264_qsv"}
    fake["works"] = {"h264_amf", "h264_qsv"}          # no NVIDIA GPU, AMD present
    assert tools.draft_encoder() == "h264_amf"
    assert fake["calls"] == ["h264_nvenc", "h264_amf"]  # stops at the first that opens


def test_falls_back_to_libx264_when_none_open(fake, monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    fake["listed"] = {"libx264", "h264_nvenc", "h264_amf", "h264_qsv"}
    assert tools.draft_encoder() == "libx264"
    assert fake["calls"] == ["h264_nvenc", "h264_amf", "h264_qsv"]


def test_unlisted_encoder_is_never_probed(fake, monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    fake["listed"] = {"libx264"}
    assert tools.draft_encoder() == "libx264"
    assert fake["calls"] == []


def test_macos_prefers_videotoolbox(fake, monkeypatch):
    monkeypatch.setattr(sys, "platform", "darwin")
    fake["listed"] = {"libx264", "h264_videotoolbox", "h264_nvenc"}
    fake["works"] = {"h264_videotoolbox", "h264_nvenc"}
    assert tools.draft_encoder() == "h264_videotoolbox"


def test_answer_is_cached_per_machine_on_disk(fake, monkeypatch, tmp_path):
    monkeypatch.setattr(sys, "platform", "win32")
    fake["listed"] = {"libx264", "h264_nvenc"}
    fake["works"] = {"h264_nvenc"}
    assert tools.draft_encoder() == "h264_nvenc"
    assert fake["calls"] == ["h264_nvenc"]
    saved = json.loads((tmp_path / "cache" / "encoder-probe.json").read_text())
    assert saved["h264_nvenc"]["ok"] is True
    fresh(monkeypatch)                                  # a new process
    assert tools.draft_encoder() == "h264_nvenc"
    assert fake["calls"] == ["h264_nvenc"]              # no second probe


def test_failure_is_cached_then_retried_after_expiry(fake, monkeypatch, tmp_path):
    monkeypatch.setattr(sys, "platform", "win32")
    fake["listed"] = {"libx264", "h264_nvenc"}
    assert tools.draft_encoder() == "libx264"
    fresh(monkeypatch)
    assert tools.draft_encoder() == "libx264"
    assert fake["calls"] == ["h264_nvenc"]
    f = tmp_path / "cache" / "encoder-probe.json"
    data = json.loads(f.read_text())
    data["h264_nvenc"]["at"] -= 86400 * (tools.PROBE_FAIL_DAYS + 1)
    f.write_text(json.dumps(data))
    fake["works"] = {"h264_nvenc"}                      # driver installed meanwhile
    fresh(monkeypatch)
    assert tools.draft_encoder() == "h264_nvenc"


def test_new_ffmpeg_binary_reprobes(fake, monkeypatch, tmp_path):
    monkeypatch.setattr(sys, "platform", "win32")
    fake["listed"] = {"libx264", "h264_nvenc"}
    fake["works"] = {"h264_nvenc"}
    tools.draft_encoder()
    (tmp_path / "ffmpeg.exe").write_bytes(b"a different build")
    fresh(monkeypatch)
    tools.draft_encoder()
    assert fake["calls"] == ["h264_nvenc", "h264_nvenc"]


def test_corrupt_cache_file_is_ignored(fake, monkeypatch, tmp_path):
    monkeypatch.setattr(sys, "platform", "win32")
    (tmp_path / "cache").mkdir()
    (tmp_path / "cache" / "encoder-probe.json").write_text("{not json")
    fake["listed"] = {"libx264", "h264_nvenc"}
    fake["works"] = {"h264_nvenc"}
    assert tools.draft_encoder() == "h264_nvenc"


def test_env_override(fake, monkeypatch):
    monkeypatch.setenv("REELENGINE_DRAFT_ENCODER", "libx264")
    fake["listed"] = {"libx264", "h264_nvenc"}
    fake["works"] = {"h264_nvenc"}
    assert tools.draft_encoder() == "libx264"
    assert fake["calls"] == []


def test_mark_failed_stops_the_encoder_being_chosen(fake, monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    fake["listed"] = {"libx264", "h264_nvenc", "h264_amf"}
    fake["works"] = {"h264_nvenc", "h264_amf"}
    assert tools.draft_encoder() == "h264_nvenc"
    tools.mark_encoder_failed("h264_nvenc")
    fresh(monkeypatch)
    assert tools.draft_encoder() == "h264_amf"


@pytest.mark.parametrize("enc,pix", [("h264_nvenc", "yuv420p"), ("h264_amf", "yuv420p"),
                                     ("h264_qsv", "nv12"), ("h264_videotoolbox", "yuv420p")])
def test_probe_and_render_use_the_same_options(fake, enc, pix):
    args = render.encoder_args(enc, True, 30)
    assert args[:2] == ["-c:v", enc]
    assert args[args.index("-pix_fmt") + 1] == pix
    assert all(o in args for o in tools.HW_ENCODER_OPTS[enc])


def test_software_args_unchanged():
    assert render.encoder_args("libx264", True, 30)[:6] == ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "24"]
    # finals: FINAL_PRESET (veryfast since stream wire, status/wire.md) at CRF 18
    final = render.encoder_args("libx264", False, 30)
    assert final[:6] == ["-c:v", "libx264", "-preset", render.FINAL_PRESET, "-crf", "18"]
    assert render.FINAL_PRESET == "veryfast"
