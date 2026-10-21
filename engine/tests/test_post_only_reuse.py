import os
import shutil
from pathlib import Path

import pytest

from conftest import mkwords
from reelengine import project, render, verify


def test_post_only_note_copies_final_media_and_changed_inputs_render_again(tmp_path, monkeypatch):
    live = tmp_path / "live"
    source = live / "media" / "take.mp4"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"original source")
    p = project.new_project("test")
    p["sources"] = [{"id": "s1", "path": "media/take.mp4", "duration": 1.0,
                     "fps": 30, "width": 90, "height": 160, "rotation": 0}]
    p["cut"]["keep"] = [{"from": "w0", "to": "w1"}]
    p["captions"]["enabled"] = False
    project.save(live, p)
    transcript = {"words": mkwords([(0, .3, "hello"), (.3, .7, "world")])}
    project.write_json(live / "work" / "transcript.json", transcript)
    calls = []

    def audio(ctx, segments, sources, work, warnings):
        calls.append("audio")
        target = work / "voice.wav"
        target.write_bytes(b"audio")
        return target

    def encode(command, *args, **kwargs):
        calls.append("encode")
        Path(command[-1]).write_bytes(b"encoded final")
        return ""

    class Cover:
        seconds = 0

        def __init__(self, *args):
            self.target = args[-2]
            self.target.write_bytes(b"cover")

        def result(self):
            return self.target

    monkeypatch.setattr(render, "build_audio", audio)
    monkeypatch.setattr(render, "build_video_cmd", lambda *a, **k: [str(a[-2])])
    monkeypatch.setattr(render.tools, "ffmpeg_progress", encode)
    monkeypatch.setattr(render, "CoverJob", Cover)
    monkeypatch.setattr(render, "_opt_module", lambda name: None)
    monkeypatch.setattr(verify, "check", lambda f, **k: {"file": str(f), "ok": True, "fails": [], "warns": []})
    first = render.run(live)
    published = Path(first["versionDir"])
    # Main's existing exports have no extra input proof; unchanged older dependencies still reuse.
    manifest = project.read_json(published / "render.json")
    manifest.pop("reuseInputs")
    project.write_json(published / "render.json", manifest)
    before = {f.relative_to(live): (f.read_bytes(), f.stat().st_mtime_ns)
              for f in live.rglob("*") if f.is_file()}

    stage = live / ".staging" / "post"
    staged = project.load(live)
    staged["post"]["caption"] = "Updated post"
    project.save(stage, staged)
    (stage / "work").mkdir()
    shutil.copy2(live / "work" / "transcript.json", stage / "work" / "transcript.json")
    calls.clear()
    result = render.run(live, project_file=stage / "project.json", out=stage / "version")
    out = Path(result["versionDir"])
    assert calls == []
    assert result["version"] == 2 and not result["preview"]
    for name in ("export.mp4", "cover.png"):
        assert (out / name).read_bytes() == (published / name).read_bytes()
        assert (out / name).stat().st_ino != (published / name).stat().st_ino
    assert project.load(stage)["version"] == 2
    assert project.read_json(out / "project.json")["post"]["caption"] == "Updated post"
    assert project.read_json(out / "render.json")["file"] == str(out / "export.mp4")
    assert project.read_json(out / "verify.json")["file"] == str(out / "export.mp4")
    assert {f.relative_to(live): (f.read_bytes(), f.stat().st_mtime_ns)
            for f in live.rglob("*") if f.is_file() and stage not in f.parents} == before

    class FullRenderRequired(Exception):
        pass

    def full_render(*args, **kwargs):
        raise FullRenderRequired

    monkeypatch.setattr(render, "build_audio", full_render)
    project.save(stage, staged | {"version": 1})
    source.write_bytes(b"source changed in place")
    with pytest.raises(FullRenderRequired):
        render.run(live, project_file=stage / "project.json", out=stage / "changed-source")
    source.write_bytes(before[Path("media/take.mp4")][0])
    os.utime(source, ns=(source.stat().st_atime_ns, before[Path("media/take.mp4")][1]))
    manifest = project.read_json(published / "render.json")
    manifest["draft"] = True
    project.write_json(published / "render.json", manifest)
    with pytest.raises(FullRenderRequired):
        render.run(live, project_file=stage / "project.json", out=stage / "draft-export")
