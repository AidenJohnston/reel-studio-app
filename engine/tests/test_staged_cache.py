"""A caption-only staged edit can reuse the completed render inputs."""
import os
import shutil
from pathlib import Path
from types import SimpleNamespace

import numpy as np

from reelengine import broll, music, render
from reelengine.render_ctx import Segment


def test_render_caches_survive_staging_root_and_cloned_voice_mtime(tmp_path, monkeypatch):
    live = tmp_path / "live"
    staged = tmp_path / "different-project" / ".staging" / "note"
    for root in (live, staged):
        (root / "media").mkdir(parents=True)
        (root / "work" / "render").mkdir(parents=True)
    source = live / "media" / "take.mp4"
    source.write_bytes(b"source and b-roll input")
    shutil.copy2(source, staged / "media" / "take.mp4")
    project = {"music": {"enabled": False}}
    live_ctx = SimpleNamespace(project=project, project_dir=live, work=live / "work", root=tmp_path,
                               staged_dir=None, ffmpeg="ffmpeg", duration=1)
    stage_ctx = SimpleNamespace(project=project, project_dir=staged, work=staged / "work", root=tmp_path,
                                staged_dir=staged, ffmpeg="ffmpeg", duration=1)
    spans = [Segment("s1", 0, 1, 0)]
    voice = live / "work" / "render" / "voice.wav"

    def encode_voice(command, *args, **kwargs):
        Path(command[-1]).write_bytes(b"completed cut voice")

    monkeypatch.setattr(render.tools, "text_run", encode_voice)
    monkeypatch.setattr(render.tools, "filter_script_args", lambda p: ["-filter_complex_script", str(p)])
    render.render_voice(live_ctx, spans, {"s1": source}, voice)
    monkeypatch.setattr(music, "decode", lambda *a, **kw: np.ones((480, 2), dtype=np.float32))
    monkeypatch.setattr(music, "normalize", lambda ctx, x, work: (x, {}))
    monkeypatch.setattr(music, "true_peak_db", lambda x: -2.0)

    def write_wav(path, *args, **kwargs):
        path.write_bytes(b"completed mix")
        return path

    monkeypatch.setattr(music, "write_wav", write_wav)
    mixed = music.build_audio(live_ctx, voice)
    shutil.copytree(live / "work", staged / "work", dirs_exist_ok=True, copy_function=shutil.copy2)
    cloned_voice = staged / "work" / "render" / "voice.wav"
    # Node fs.utimes restores seconds with microsecond precision after COPYFILE_FICLONE.
    stamp = voice.stat().st_mtime_ns
    os.utime(cloned_voice, ns=(stamp, stamp // 1000 * 1000 + 1000))

    def unexpected_mix(*args, **kwargs):
        raise AssertionError("the staged render rebuilt its unchanged music mix")

    def unexpected_voice(*args, **kwargs):
        raise AssertionError("the staged render rebuilt its unchanged cut voice")

    monkeypatch.setattr(render.tools, "text_run", unexpected_voice)
    assert render.render_voice(stage_ctx, spans, {"s1": staged / "media" / "take.mp4"}, cloned_voice) == cloned_voice
    assert broll._asset_sig(source, live_ctx) == broll._asset_sig(staged / "media" / "take.mp4", stage_ctx)
    monkeypatch.setattr(music, "normalize", unexpected_mix)
    reused = music.build_audio(stage_ctx, cloned_voice)
    assert reused.name == mixed.name
    assert reused.read_bytes() == b"completed mix"
    assert reused.parent == staged / "work" / "audio"
